/**
 * stm-pet 前端入口。
 *
 * 契约：导出 `activate(api)`，可选导出 `deactivate(api)`；`activate` 的返回值
 * 被宿主记为插件级 disposer（§2.9）。
 *
 * 本插件只做三类事：
 * 1. 注册一个 `ambient` surface，在里面养一只宠物（**不自绘 fixed 浮层**）；
 * 2. 订阅核心事件与宿主状态，驱动宠物的反应与省电；
 * 3. 注册设置面板的 `modal` surface（形象管理）。
 *
 * 清理纪律（§2.9 / §8 陷阱 12）：**不依赖 `deactivate`**——ambient 的卸载由
 * 宿主强制完成（`unmount → disposer → deactivate`），所以 `cancelAnimationFrame`、
 * 全局监听、定时器、EventSource 的回收全部写在返回的 disposer 里。
 */

import { createPetView } from './petview.js';
import { createSettingsPanel } from './panel.js';
import { createAnnouncer } from './announce.js';

/**
 * 宿主轻提示的图标。
 *
 * 用**插件自带的图标**（`frontend/assets/icon.svg`），通知因此是品牌化的。
 *
 * 这依赖宿主的一次修复（`ST-Manager@715d0a8`：
 * 「toast 图标位接入统一解析，解锁宿主 176 个图标与插件自带图标」）。
 * 修复前 toast 的图标位只接受 `state.js:TOAST_ICON_NAMES` 里**写死的 16 个名字**
 * （宿主自己的 192 个图标有 176 个用不了），插件资源路径一律被**静默丢弃**——
 * 因此当时只能退化成宿主通用的 `check`。
 *
 * 现在 toast 与 `entries[].icon` / `api.ui.icon()` 走**同一套** `resolveIcon()`：
 * - 不含 `/` 与 `.` → 宿主图标名 → `<use href="/static/icons/...">`
 * - 含 `/` → 插件资源路径 → CSS mask（填充式图形不能塞进 `<use>`）
 *
 * 实测（`tools/verify-toast-icon.mjs`，5/5）：插件用这个路径弹通知时
 * `toastIconKind === 'asset'`，渲染出带 mask 的 span。
 *
 * 向后兼容：若用户跑的是**修复前**的宿主，这个值会解析成 `missing`，
 * 宿主会 `console.warn` 一次并把图标位留空 —— **文案照常显示**，功能不受影响。
 * 这是有意的降级：宁可少一个图标，也不要为了兼容旧宿主而放弃品牌化。
 */
const TOAST_ICON = 'frontend/assets/icon.svg';

/**
 * 统一的日志出口。
 *
 * ⚠️ 宿主**没有** `api.log`——真实签名是 `api.host.log(message, level)`，
 * 注意**参数顺序是反的**（message 在前）。实测踩过：写 `api.log(...)` 会在
 * `activate()` 里抛 `TypeError`，而且宿主是**在 `activate` 中途**捕获它的，
 * 表现是「插件加载失败」但宠物已经画出来了——非常难查。
 * 这里做一层适配，并兼容宿主将来可能新增的 `api.log`。
 */
function createLogger(api) {
  const write = (level, message) => {
    try {
      if (typeof api.log === 'function') {
        api.log(level, message);
        return;
      }
      if (api.host && typeof api.host.log === 'function') {
        // 宿主签名：log(message, level)
        api.host.log(String(message), String(level));
        return;
      }
      // 最后的兜底：直接写 console，至少不丢信息
      const text = `[plugin:${api.id || 'stm-pet'}] ${message}`;
      if (level === 'error') console.error(text);
      else if (level === 'warning') console.warn(text);
      else console.log(text);
    } catch {
      // 日志本身绝不能成为故障源
    }
  };
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warning: (message) => write('warning', message),
    error: (message) => write('error', message),
  };
}

export async function activate(api) {
  const logger = createLogger(api);
  const state = {
    petView: null,
    /** ambient 注册返回的 key；空串表示注册失败（参数非法）。 */
    surfaceKey: '',
    /** 真正挂载成功（移动端 `_mountAmbient` 会跳过挂载）。 */
    mounted: false,
    pack: null,
    config: {},
  };

  // ------------------------------------------------------------ 配置

  /**
   * 读取插件配置。
   *
   * 标量配置的唯一来源是宿主的 `config_schema`
   * （`GET /api/plugins/stm-pet/config` 由宿主提供，前端走 `api.api('/config')`）；
   * 结构化状态（当前形象 id）走插件自己的 `/settings`。
   */
  async function loadConfig() {
    const [hostConfig, ownSettings] = await Promise.all([
      api.api('/config'),
      api.api('/settings'),
    ]);
    const config = {};
    if (hostConfig && hostConfig.success && hostConfig.config) {
      Object.assign(config, hostConfig.config);
    }
    state.config = config;
    if (ownSettings && ownSettings.success && ownSettings.settings) {
      state.ownSettings = ownSettings.settings;
    }
    return config;
  }

  /** 把宿主 config 与插件设置折算成宠物视图要的形态（键名归一）。 */
  function viewConfig(extra = {}) {
    const config = state.config || {};
    // 倍率与渲染方式的**权威值来自后端**（它按「用户设置 > 包内声明 > 全局默认」
    // 算好了，见 `store.effective_scale`）。这里只在形象数据还没到位时
    // 用宿主表单的全局值兜底，避免启动瞬间跳一下。
    const pack = state.pack || {};
    return Object.assign({
      quietMode: config.quiet_mode === true,
      autoRoam: config.auto_roam !== false,
      scale: pack.scale !== undefined ? pack.scale : (Number(config.scale) || 1),
      pixelated: pack.pixelated === true,
      sleepAfter: Number(config.sleep_after) || 120,
      showToast: config.show_toast === true,
      reducedMotion: state.hostState ? state.hostState.reducedMotion : false,
    }, extra);
  }

  // ------------------------------------------------------------ 数据

  async function fetchRuntime() {
    const data = await api.api('/runtime');
    if (!data || !data.success) return null;
    return data.pet || null;
  }

  // ------------------------------------------------------------ 播报

  const announcer = createAnnouncer({
    toast: (message) => api.toast(message, 3000, TOAST_ICON),
    log: (level, message) => {
      const method = logger[level] || logger.info;
      method(String(message));
    },
    getQuiet: () => viewConfig().quietMode,
    getShowToast: () => {
      const config = state.config || {};
      return config.show_toast === true;
    },
    onAnnounce: (action, reason) => {
      if (!state.petView) return;
      if (state.hostState && state.hostState.scrimActive) {
        // 全屏遮罩期间不打扰（quietMode 的语义之一）
        return;
      }
      state.petView.react(action);
      logger.debug(`播报 ${action}（${reason}）`);
    },
  });

  // ------------------------------------------------------------ ambient

  /**
   * 注册常驻环境层。
   *
   * **移动端不挂载**（宿主的产品决策，不要在插件里绕过，§8 陷阱 14）。
   * 注意：`register()` 在桌面与移动端**都返回 key**（实测，见
   * docs/HOST_FEEDBACK.md 第 1 条），因此不能靠返回值判可用——
   * 用 `api.surfaces.isOpen()`：移动端 `_mountAmbient` 提前返回、不写 open 表，
   * 所以它会返回 false。
   */
  function registerAmbient() {
    state.surfaceKey = api.surfaces.register('pet', {
      type: 'ambient',
      mount(container) {
        // 挂载期先把宠物画出来（用默认形象），形象数据是异步取的，
        // 拿到后再替换——这样启动时不会有一段时间「什么都没有」。
        state.petView = createPetView({
          container,
          pack: state.pack || fallbackPack(),
          config: viewConfig(),
          hooks: {
            onStateChange: (next, previous) => {
              logger.debug(`宠物状态 ${previous} → ${next}`);
            },
            onContextMenu: () => {
              // 右键宠物 → 打开设置面板（宿主提供 header / 焦点陷阱 / ESC）
              api.surfaces.open('pet-settings', { source: 'pet-contextmenu' });
            },
          },
        });
        if (state.hostState) state.petView.applyThrottle(state.hostState);
        state.mounted = true;

        // 清理：宿主在禁用 / 卸载时强制调用（顺序是 unmount → disposer → deactivate）
        return () => {
          if (state.petView) {
            state.petView.dispose();
            state.petView = null;
          }
          state.mounted = false;
        };
      },
    });

    // `isOpen` 是判定「真的挂上了」的可靠方式（返回值恒为真，见上）
    state.mounted = Boolean(state.surfaceKey) && api.surfaces.isOpen('pet');
    if (!state.mounted) {
      // 移动端 / 不支持：降级形态。不 throw、不 toast 报错（§2.1）。
      logger.info('ambient 不可用（移动端），宠物降级为仅设置面板');
    }
  }

  /** 数据还没到位时的占位形象：一个不播帧的空壳，避免视图构造失败。 */
  function fallbackPack() {
    return {
      id: '',
      name: '',
      size: { w: 64, h: 64 },
      anchor: { x: 0.5, y: 1 },
      physics: {},
      actions: {
        idle: { action: 'idle', kind: 'static', source: 'idle', url: '', frames: 1, fps: 1, loop: true },
      },
    };
  }

  /** 把后端解析好的形象应用到正在运行的宠物上。 */
  async function applyPack(pack) {
    state.pack = pack;
    if (!state.petView) return;
    // 形象变了就重建视图（尺寸/物理/帧布局都可能不同，增量更新不值得）。
    // 用户改倍率走的也是这条路：包围盒尺寸变了，切帧几何与物理边界都要重算。
    const container = state.petView.element.parentNode;
    const bounds = state.petView.physics;
    if (!container) return;
    // 记下当前位置：重建后要放回去，否则用户拖好的位置会被重置到屏幕中央，
    // 而「改个大小」不该让宠物瞬移。
    const position = { x: bounds.x, y: bounds.y };
    state.petView.dispose();
    state.petView = createPetView({
      container,
      pack,
      config: viewConfig(),
      hooks: {
        onStateChange: (next, previous) => {
          logger.debug(`宠物状态 ${previous} → ${next}`);
        },
        onContextMenu: () => {
          api.surfaces.open('pet-settings', { source: 'pet-contextmenu' });
        },
      },
    });
    state.petView.physics.setPosition(position.x, position.y);
    if (state.hostState) state.petView.applyThrottle(state.hostState);
  }

  // ------------------------------------------------------------ 设置面板

  const panel = createSettingsPanel({
    api,
    getConfig: () => state.config,
    getOwnSettings: () => state.ownSettings || {},
    onConfigChanged: (patch) => {
      Object.assign(state.config, patch);
      if (state.petView) state.petView.setConfig(viewConfig());
    },
    onPetChanged: async (petId) => {
      const pack = await fetchRuntime();
      if (pack) await applyPack(pack);
      else if (petId === '') {
        // 形象被删光了：退回占位
        await applyPack(fallbackPack());
      }
    },
  });

  function registerSettingsSurface() {
    api.surfaces.register('pet-settings', {
      title: '桌面宠物设置',
      description: '形象管理与导入、动作覆盖、播报与勿扰',
      icon: 'frontend/assets/icon.svg',
      type: 'modal',
      size: 'lg',
      mount(container) {
        return panel.mount(container);
      },
      onOpen(ctx) {
        // 每次从入口进来都回到形象详情（而不是停在未提交的新建表单）
        if (typeof panel.resetView === 'function') panel.resetView();
        panel.onOpen(ctx);
      },
    });
  }

  // ------------------------------------------------------------ 启动

  await loadConfig();
  registerAmbient();
  registerSettingsSurface();

  // 形象数据（失败不阻断：宠物先以占位形态存在，设置面板里会显示原因）
  try {
    const pack = await fetchRuntime();
    if (pack) await applyPack(pack);
  } catch (error) {
    logger.warning(`读取宠物形象失败：${error && error.message}`);
  }

  // ------------------------------------------------------------ 宿主状态

  const offState = api.host.onState((next) => {
    state.hostState = next;
    if (state.petView) state.petView.applyThrottle(next);
  });

  // ------------------------------------------------------------ 核心事件

  /**
   * 订阅核心事件（SSE，懒连接、每插件一条流，§2.2）。
   *
   * 播报**必须限流**：`card.updated` 在批量操作时会高频触发，
   * 不限流宠物会疯狂抽搐（§4.4 / §8 陷阱 11）。限流逻辑在 `announce.js`。
   */
  const offEvents = [];
  const subscribe = (name, handler) => {
    const off = api.on(name, (payload) => {
      try {
        handler(payload || {});
      } catch (error) {
        logger.warning(`处理 ${name} 事件失败：${error && error.message}`);
      }
    });
    if (typeof off === 'function') offEvents.push(off);
  };

  subscribe('card.created', () => announcer.cardEvent('card.created'));
  subscribe('card.updated', () => announcer.cardEvent('card.updated'));
  subscribe('card.moved', () => announcer.cardEvent('card.moved'));
  subscribe('card.deleted', () => announcer.cardEvent('card.deleted'));
  subscribe('tag.applied', () => announcer.cardEvent('tag.applied'));
  subscribe('worldbook.saved', () => announcer.cardEvent('worldbook.saved'));
  // 扫描 / 索引：**没有任何 UI 动作触发**，这条通路最能体现价值（§2.2）
  subscribe('scan.completed', (payload) => announcer.jobEvent('scan.completed', payload));
  subscribe('index.job_done', (payload) => announcer.jobEvent('index.job_done', payload));

  // 设置面板打开时改配置 → 立即生效（不必等刷新）
  const offConfigChange = typeof api.onConfigChange === 'function'
    ? api.onConfigChange((config) => {
      state.config = Object.assign({}, state.config, config);
      // 宿主表单里的全局 `scale` 是倍率的**兜底值**，改了它可能改变生效倍率
      // （当该形象既没有用户覆盖、包内也没声明时）。而生效倍率是后端算的，
      // 因此这里必须重新取一次形象数据，不能只 `setConfig`。
      refreshRuntime().catch((error) => {
        logger.warning(`配置变更后刷新形象失败：${error && error.message}`);
      });
    })
    : () => {};

  /** 重新拉当前形象并应用（配置变更 / 外观调整后走这条）。 */
  async function refreshRuntime() {
    const pack = await fetchRuntime();
    if (pack) await applyPack(pack);
    else if (state.petView) state.petView.setConfig(viewConfig());
  }

  // 任意用户在宿主页面上的输入也算「互动」——避免用户在看卡片时宠物睡着
  const onAnyInput = () => {
    if (state.petView) state.petView.touch();
  };
  window.addEventListener('pointerdown', onAnyInput, { passive: true });
  window.addEventListener('keydown', onAnyInput, { passive: true });

  /**
   * 一个**刻意暴露**的诊断句柄。
   *
   * 用途（两个都是真实需求，不只是给测试用的）：
   * 1. 用户报「宠物不动了」时，让他打开控制台敲 `stmPet.state()` 就能拿到
   *    状态 / 动作 / 省电原因，比让他翻 DevTools 找元素快得多；
   * 2. 无人值守的真实浏览器验收脚本要能打开设置面板（否则只能靠点宿主的
   *    插件管理页，那条路径一旦宿主调整布局就失效）。
   *
   * 命名空间化 + 只读查询 + 一个动作，不往 window 上散落全局。 */
  globalThis.stmPet = {
    /** 当前运行状态快照（排查用）。 */
    state: () => ({
      pluginId: api.id,
      mounted: state.mounted,
      petId: state.pack ? state.pack.id : '',
      petState: state.petView ? state.petView.state : 'unmounted',
      action: state.petView ? state.petView.action : '',
      throttle: state.petView ? state.petView.throttleReason : '',
      reducedMotion: state.hostState ? Boolean(state.hostState.reducedMotion) : null,
      hostState: state.hostState || null,
      config: state.config,
      activePetId: (state.ownSettings || {}).activePetId || '',
    }),
    /** 打开设置面板（等价于用户点击入口）。 */
    openSettings: () => api.surfaces.open('pet-settings', { source: 'debug-handle' }),
    /** 关闭设置面板。 */
    closeSettings: () => api.surfaces.close('pet-settings'),
    /** 让宠物播一个动作（预览用）。 */
    react: (action = 'happy') => {
      if (state.petView) state.petView.react(action);
    },
  };
  // 验收脚本用它打开面板（见 tools/verify-upload.mjs）
  globalThis.__petApi = api;

  logger.info(`stm-pet 前端已激活（ambient ${state.mounted ? '已挂载' : '不可用'}）`);

  // ------------------------------------------------------------ disposer

  // 宿主在禁用 / 卸载 / 重载时调用本函数。**所有**资源回收都在这里（§2.9）。
  return () => {
    logger.info('stm-pet 前端开始回收');
    offState();
    offConfigChange();
    for (const off of offEvents) {
      if (typeof off === 'function') off();
    }
    window.removeEventListener('pointerdown', onAnyInput);
    window.removeEventListener('keydown', onAnyInput);
    // 诊断句柄随插件一起消失，避免禁用后还留着可调用的残留对象
    if (globalThis.stmPet) delete globalThis.stmPet;
    if (globalThis.__petApi === api) delete globalThis.__petApi;
    announcer.dispose();
    panel.dispose();
    // ambient 的 unmount 由宿主强制完成（它会调我们 mount 里返回的清理函数），
    // 这里只兜底关掉设置面板，避免面板还开着的时候插件已经卸了。
    api.surfaces.close('pet-settings');
    state.petView = null;
  };
}

export function deactivate(api) {
  // 只做日志：真正的清理在 `activate` 返回的 disposer 里（§8 陷阱 12）。
  // 注意这里没有 `logger`（它建在 activate 的闭包里），必须现取一个——
  // 直接引用会抛 ReferenceError，而且是在卸载路径上抛，最不该出问题的地方。
  createLogger(api || {}).info('stm-pet 前端已卸载');
}
