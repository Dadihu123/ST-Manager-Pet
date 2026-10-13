/**
 * 形象管理面板（`settings` 入口 + `modal` surface）。
 *
 * 为什么自带 UI 而不是用宿主的通用设置表单（§0.1 / §2.8）：
 * 形象管理需要**预览图、动作齐全性校验、单动作覆盖、导入与删除**，
 * 而宿主的 `config_schema` 只支持标量（`string`/`integer`/`number`/`boolean`/`enum`），
 * 渲染不了列表与图片。标量开关仍走宿主表单（单一来源，避免双写不同步）。
 *
 * 面板只做**展示与调用后端**；回退链的判定在后端（`runtime_pack`），
 * 因此这里拿到的每个动作都已经是「最终结论 + 一句解释」。
 */

import { DEFAULT_SCHEDULE_MS } from './animation.js';
import { createAnimationPlayer, totalDuration } from './preview.js';

const ACTION_LABELS = {
  idle: '待机',
  'walk-left': '向左走',
  'walk-right': '向右走',
  drag: '被拖动',
  fall: '下落',
  land: '落地',
  sleep: '睡觉',
  click: '被点击',
  happy: '开心',
  sad: '难过',
  angry: '生气',
  look: '张望',
  // `walk` **不是动作**，而是「行走」这条必要项的**代号**：
  // 行走只有方向化动作（`walk-left` / `walk-right`），提供任一侧即算满足。
  // 这里留着它只是为了把后端的 `missingRequired: ['walk']` 翻译成人话。
  walk: '行走',
};

/**
 * 与后端 `pack.REQUIRED_ACTIONS` 一致的「必要动作」名单。
 *
 * `walk` 是**需求代号**而不是动作名（见上）。判断某个**真实动作**算不算必要
 * 必须走 `isRequiredAction()`：`walk-left` / `walk-right` 都算必要，
 * 因为它们共同承载「行走」这一项需求（提供任一侧即满足）。
 */
const REQUIRED_ACTIONS = ['idle', 'walk', 'drag', 'fall'];

/**
 * **可设置触发时间**的行为（与后端 `pack.SCHEDULE_BEHAVIORS` 必须一致）。
 *
 * 用户要求「支持调整不同动作的触发时间」，而真正**由时间驱动**的只有这两个：
 *
 * - `idle`：闲着的时候偶尔动一下；
 * - `roam`：闲着的时候自己在屏幕底部走一走。
 *
 * 其余动作由**事件**触发（`click` 要有人点、`fall` 要松手、`happy` 要有播报），
 * 给它们设「多久一次」没有意义——后端会明确拒绝，因此面板也不渲染它们的滑块。
 */
const SCHEDULE_BEHAVIORS = [
  {
    key: 'idle',
    label: '待机小动作',
    hint: '闲着的时候偶尔动一下。数值越小越活泼，越大越安静。',
  },
  {
    key: 'roam',
    label: '自动漫游',
    hint: '闲着的时候自己在屏幕底部走一走。关掉「自动漫游」开关后这项不生效。',
  },
];

/**
 * 触发节奏的**兜底**区间（毫秒）。权威值由后端 `/pets` 的 `limits` 给，
 * 这里只是「接口还没回来」时的初值，避免滑块渲染成 NaN。
 */
const SCHEDULE_FALLBACK_MIN_MS = 200;
const SCHEDULE_FALLBACK_MAX_MS = 3600 * 1000;

/**
 * 新建形象时可上传的动作（按重要性排序，`idle` 必须给）。
 *
 * 行走只列**方向化**的两项：宠物是水平移动的，正面行走图看起来像原地踏步。
 * 只给一侧也行——另一侧会自动镜像；但**左右不对称**的形象
 * （例如头饰只在一侧）应当两套都给，否则镜像会把细节翻边。
 */
const CREATABLE_ACTIONS = [
  { action: 'idle', required: true },
  { action: 'walk-left', required: false },
  { action: 'walk-right', required: false },
  { action: 'drag', required: false },
  { action: 'fall', required: false },
  { action: 'land', required: false },
  { action: 'sleep', required: false },
  { action: 'click', required: false },
  { action: 'happy', required: false },
  { action: 'sad', required: false },
  { action: 'angry', required: false },
  { action: 'look', required: false },
];

/** 大小倍率的区间（与 `backend/core/pack.py:SCALE_RANGE` 必须一致）。 */
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;

/** 倍率滑块的步长：0.05 足够细，又不至于让用户拖不到整数值。 */
const SCALE_STEP = 0.05;

/**
 * 预览速度倍率的区间（与桌面宠物的 `anim_speed` 同区间、同语义：越大越慢）。
 *
 * 这里刻意**不复用**宿主的 `anim_speed`：那个是「全局生效」的设置，
 * 在预览器里顺手改它会让用户以为自己只是试了一下，桌面上的宠物却真的变慢了。
 * 预览的速度只影响预览。
 */
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

export function createSettingsPanel({
  api, getConfig, getOwnSettings, onConfigChanged, onPetChanged,
  getHidden, onHiddenChange,
}) {
  let root = null;
  let disposed = false;
  let pets = [];
  let activeId = '';
  let selectedId = '';
  let detail = null;
  let busy = false;
  let notice = null;
  /**
   * 宠物是否被用户关闭了（隐藏）。
   *
   * 权威值在 `plugin.js`（它管着宠物视图的生与死），这里只是它的一份镜像。
   * 初值从 `getHidden()` 取——面板可能在宠物已被关闭的情况下才第一次打开。
   */
  let hiddenState = typeof getHidden === 'function' ? Boolean(getHidden()) : false;
  /** 缩略图几何的观察者（容器宽度变化时重算帧几何）。 */
  let resizeObserver = null;
  /** 当前是否处于「新建形象」视图（而不是形象详情）。 */
  let creating = false;
  /** 新建表单的暂存状态：`{action: {file, frames, fps}}`。 */
  let draft = {};
  /** 新建表单的标量字段。 */
  let draftName = '';
  /** 新建表单的**作者署名**（用户要求：自定义宠物应能设作者名，便于发布）。 */
  let draftAuthor = '';
  let draftScale = 1;
  let draftPixelated = false;
  /**
   * 新建表单的**标准图像**声明。
   *
   * 三种状态：
   * - `null`：不声明 → 后端回落到 idle 首帧；
   * - `{action, frame}`：复用某个已上传动作的某一帧（面板上最常见的选择）；
   * - `{file, frames, frame}`：单独上传一张。
   *
   * 为什么不总是强制用户设一张：它**不是必填**。强制会让「我就想用 idle
   * 第一帧」这个最常见的情况变得啰嗦，而回落值在只给一套 idle 时本来就是对的。
   */
  let draftStill = null;
  /**
   * 新建表单的**触发节奏**（毫秒区间）。
   *
   * `{idle: {min, max}, roam: {min, max}}`；`null` 表示「用默认值」，
   * 提交时不写进 `pet.json`（后端与前端都用同一套默认值）。
   */
  let draftSchedule = null;
  /** 面板拿到的限制（倍率区间由后端给，避免两边写死不一致）。 */
  let limits = { scaleMin: SCALE_MIN, scaleMax: SCALE_MAX };
  /**
   * 动画预览器（设置页里「播放」具体动作）。
   *
   * 用户在**插件管理页里看不到动画效果**，调形象时只能切过去等它真的触发一次
   * ——而 `click` / `land` 这类动作几乎等不到。因此面板自带一个播放器。
   */
  let player = null;
  /** 预览器当前选的动作名与变体下标。 */
  let previewAction = 'idle';
  let previewVariant = 0;
  /** 预览器的速度倍率（越大越慢），与桌面宠物用的是同一个语义。 */
  let previewSpeed = 1;
  /**
   * 预览器是否处于「播放」状态。
   *
   * 必须**独立记录**，不能在渲染时读 `player.playing`：`render()` 一开始就把
   * 旧播放器 dispose 掉了，而 `renderPreview()` 是在新播放器创建**之前**跑的，
   * 那时 `player` 还是 null —— 读它会让按钮永远显示「播放」，
   * 用户点一下看起来毫无反应（实测就是这么发现的）。
   */
  let previewPlaying = true;
  /**
   * 播放/暂停按钮的引用（就地更新它的文字）。
   *
   * **不能**用 `render()` 来刷新按钮状态：`render()` 会重建整个面板，
   * 而重建又会重新 `load()` 播放器（从头播）。对 `loop: false` 的动作
   * （`click` / `land` / `happy`）来说，「播完 → onEnd → render → 重新 load →
   * 又播一遍」是一个**无限循环**——实测就是这个症状：点一下「被点击」，
   * 它会永远循环播下去，而按钮文字还停在「播放」。
   */
  let previewToggle = null;

  /** 就地同步播放/暂停按钮的文字（不重建面板）。 */
  function syncPreviewToggle() {
    if (previewToggle) previewToggle.textContent = previewPlaying ? '暂停' : '播放';
  }
  /**
   * 待挂载的预览器信息。
   *
   * `render()` 只造节点、不插进文档，而帧几何依赖预览框的**真实宽度**
   * （`clientWidth` 只有挂上才有值）。因此渲染时先把「要播什么」记在这里，
   * 由 `render()` 末尾的 `mountPreviewPlayer()` 真正挂载。
   */
  let pendingPreview = null;

  const config = getConfig || (() => ({}));
  const ownSettings = getOwnSettings || (() => ({}));

  // ---------------------------------------------------------------- 工具

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const node = el('button', `pet-button ${className || ''}`.trim(), label);
    node.type = 'button';
    node.dataset.marqueeIgnore = 'true';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function setNotice(kind, message) {
    notice = message ? { kind, message } : null;
    render();
  }

  /**
   * **显示开关**：把宠物关掉 / 打开。
   *
   * 用户报障的原始形态是：「目前好像只有卸载或者停用宠物插件才能关闭宠物，
   * 不太合理」。确实不合理——想安静一会儿却要卸载插件，代价完全不对等。
   *
   * 语义边界（面板上也要说清，否则用户会以为「关闭」=「停用」）：
   * 关掉的是**宠物**，不是插件。面板、坞入口、所有设置都还在；
   * 想让它回来，再点一下这个开关就行。
   */
  function renderVisibility() {
    const hidden = Boolean(hiddenState);
    const box = el(
      'div',
      `pet-visibility ${hidden ? 'is-hidden' : ''}`.trim(),
    );

    const copy = el('div', 'pet-visibility-copy');
    const title = el('div', 'pet-visibility-title');
    title.appendChild(el('span', null, hidden ? '宠物已关闭' : '宠物显示中'));
    title.appendChild(el(
      'span',
      `pet-badge ${hidden ? 'is-builtin' : ''}`.trim(),
      hidden ? '已隐藏' : '运行中',
    ));
    copy.appendChild(title);
    copy.appendChild(el(
      'div',
      'pet-field-hint',
      hidden
        ? '屏幕上不会显示宠物，也不会占用任何动画资源。'
          + '插件仍然启用——想让它回来，点右边的「显示宠物」即可。'
        : '不想看到它时可以在右边把它关掉，不必卸载或停用插件。',
    ));
    box.appendChild(copy);

    const actions = el('div', 'pet-panel-toolbar');
    const toggle = button(
      hidden ? '显示宠物' : '关闭宠物',
      hidden ? 'is-primary' : '',
      () => toggleVisibility(!hidden),
    );
    toggle.dataset.visibilityToggle = 'true';
    // 让验收脚本与用户都能一眼看出当前状态（也便于 CSS 分别着色）
    toggle.dataset.visibilityHidden = hidden ? 'true' : 'false';
    actions.appendChild(toggle);
    box.appendChild(actions);
    return box;
  }

  /**
   * 切换显示状态。
   *
   * 回调失败时**不吞掉**：`onHiddenChange` 内部已经做了回滚，
   * 这里只需把错误呈现出来。
   */
  async function toggleVisibility(hidden) {
    if (!onHiddenChange) return;
    await withBusy(async () => {
      try {
        await onHiddenChange(hidden);
        setNotice('ok', hidden ? '已关闭宠物' : '已显示宠物');
      } catch (error) {
        setNotice('error', `切换失败：${(error && error.message) || error}`);
      }
    });
  }

  /**
   * 由 `plugin.js` 在开关变化后回灌状态。
   *
   * 为什么需要它：`plugin.js` 才是显示状态的权威来源（它管着宠物视图的
   * 生与死），面板只是它的一个视图。后台改状态（诊断句柄 `stmPet.hide()`）
   * 也要让面板跟上。
   */
  function setHiddenState(next) {
    hiddenState = Boolean(next);
    if (root) render();
  }

  /**
   * 把「只显示第 0 帧」的几何写进**每一张**形象卡片的缩略图。
   *
   * 关键点：帧图是**整条 spritesheet**，缩略图方框只有 40px。
   * 要让第 0 帧刚好填满方框，背景图必须按「单帧宽 × 帧数」放大，
   * 并且**左对齐**（`position 0 0`）——居中会把第 1、2 帧露进来。
   *
   * ⚠️ **必须逐卡片算，且用每张卡片自己的帧数。** 真实踩过的 bug：
   * 老实现用 `root.querySelector('.pet-card-thumb')` 只取**第一张**卡片，
   * 再用 `detail`（**当前选中**那个形象）的帧数去设它的几何。
   * 两个后果叠加：
   *
   * 1. 只有列表里第一张卡片被设了几何，其余卡片停在 CSS 默认值
   *    （`background-size: auto`）——整条 4 帧的 spritesheet 按原尺寸铺开，
   *    40px 的方框里只看到**最左边一条透明边**，看起来就是「没有形象展示」；
   * 2. 第一张卡片用的是**选中形象**的帧数，与它自己的图无关。
   *
   * 实测症状正是用户报的那个：小卡（列表第一张）有图，小满没有。
   * 现在帧数从**列表接口**拿（`list_pets()` 已经把每个形象的帧信息带回来了），
   * 因此每张卡片都能独立算对，也不依赖「当前选中了谁」。
   */
  function applyThumbGeometry() {
    if (!root) return;
    const boxes = root.querySelectorAll('.pet-card-thumb');
    for (const box of boxes) {
      const frames = Math.max(1, Number(box.dataset.frames) || 1);
      const layout = box.dataset.layout === 'vertical' ? 'vertical' : 'horizontal';
      const boxWidth = box.clientWidth || 40;
      const boxHeight = box.clientHeight || 40;

      if (!box.dataset.hasImage || frames <= 1) {
        // 单帧：整张图就是那一帧，`contain` 是对的
        box.style.backgroundSize = 'contain';
        box.style.backgroundPosition = 'center';
        continue;
      }

      // 多帧：单帧按方框尺寸等比放大；整条宽度 = 帧数 × 单帧宽。
      // `vertical` 排布同理，换成高度方向。
      if (layout === 'vertical') {
        box.style.backgroundSize = `auto ${boxHeight * frames}px`;
        box.style.backgroundPosition = 'center top';
      } else {
        box.style.backgroundSize = `${boxWidth * frames}px auto`;
        box.style.backgroundPosition = 'left top';
      }
      // 图片内容变了（URL 带版本），几何不用跟着变——版本变了浏览器自然会换图
    }
  }

  /** 统一的后端调用 + 错误呈现（错误信息由后端给出可读文案）。 */
  async function call(path, options) {
    const data = await api.api(path, options);
    if (!data || !data.success) {
      const message = (data && (data.msg || data.error)) || '请求失败';
      const hint = (data && data.hint) || '';
      setNotice('error', hint ? `${message}（${hint}）` : message);
      return null;
    }
    return data;
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      return await fn();
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  // ---------------------------------------------------------------- 数据

  async function refresh() {
    const data = await call('/pets');
    if (!data) return;
    pets = data.items || [];
    activeId = data.activePetId || '';
    if (data.limits) {
      limits = {
        scaleMin: Number(data.limits.scaleMin) || SCALE_MIN,
        scaleMax: Number(data.limits.scaleMax) || SCALE_MAX,
        scheduleMinMs: Number(data.limits.scheduleMinMs) || SCHEDULE_FALLBACK_MIN_MS,
        scheduleMaxMs: Number(data.limits.scheduleMaxMs) || SCHEDULE_FALLBACK_MAX_MS,
      };
    }
    if (!selectedId || !pets.some((item) => item.id === selectedId)) {
      selectedId = activeId || (pets[0] ? pets[0].id : '');
    }
    await loadDetail(selectedId);
  }

  async function loadDetail(petId) {
    if (!petId) {
      detail = null;
      render();
      return;
    }
    const data = await call(`/pets/${encodeURIComponent(petId)}/preview`);
    detail = data || null;
    // 换形象时把预览器切回「待机」：停在别的形象的动作上会让人以为没切成功
    previewAction = 'idle';
    previewVariant = 0;
    previewPlaying = true;
    if (!disposed) render();
  }

  /** 当前预览的动作条目（从 `detail.actions` 里取）。 */
  function previewEntry() {
    const list = (detail && detail.actions) || [];
    return list.find((item) => item.action === previewAction) || null;
  }

  /** 当前预览的变体（多套动画时按 `previewVariant` 选）。 */
  function previewSpec() {
    const entry = previewEntry();
    if (!entry) return null;
    const variants = entry.variants || [];
    if (variants.length) {
      return variants[Math.min(Math.max(0, previewVariant), variants.length - 1)];
    }
    if (!entry.url) return null;
    // 老版本后端只给主变体字段，这里兜底构一个
    return {
      url: entry.url,
      frames: entry.frames,
      fps: entry.fps,
      loop: entry.loop,
      layout: entry.layout,
      frameMs: entry.frameMs || [],
    };
  }

  // ---------------------------------------------------------------- 操作

  async function activatePet(petId) {
    await withBusy(async () => {
      const data = await call('/pets/active', { method: 'POST', body: { petId } });
      if (!data) return;
      activeId = data.activePetId;
      setNotice('ok', '已切换形象');
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function deletePet(petId) {
    await withBusy(async () => {
      const data = await call(`/pets/${encodeURIComponent(petId)}`, { method: 'DELETE' });
      if (!data) return;
      setNotice('ok', '已删除');
      if (selectedId === petId) selectedId = '';
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function importPack(file, { replace = false } = {}) {
    const form = new FormData();
    form.append('file', file);
    if (replace) form.append('replace', '1');
    await withBusy(async () => {
      const data = await call('/pets/import', { method: 'POST', body: form });
      if (!data) return;
      activeId = data.activePetId;
      selectedId = data.pet ? data.pet.id : '';
      setNotice('ok', `已导入「${data.pet ? data.pet.name : ''}」并设为当前形象`);
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function uploadActionImage(action, file) {
    const form = new FormData();
    form.append('file', file);
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/actions/${encodeURIComponent(action)}`,
        { method: 'POST', body: form },
      );
      if (!data) return;
      setNotice('ok', `「${ACTION_LABELS[action] || action}」已更新`);
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function clearActionImage(action) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/actions/${encodeURIComponent(action)}`,
        { method: 'DELETE' },
      );
      if (!data) return;
      setNotice('ok', '已恢复包内原图');
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  /**
   * 导出形象包（一键下载 zip）。
   *
   * 走**浏览器的原生下载**而不是 `api.api()`：后者会把响应体当 JSON 解析，
   * 而这里是二进制 zip。用 `<a download>` 触发，让浏览器自己处理
   * `Content-Disposition` —— 这样进度、取消、保存位置都由浏览器负责。
   *
   * 内置形象后端会直接 403，面板也不会显示这个按钮（双保险）。
   */
  function exportPet(petId) {
    const url = `/api/plugins/stm-pet/pets/${encodeURIComponent(petId)}/export`;
    const link = el('a', 'pet-download-link');
    link.href = url;
    link.download = `${petId}.zip`;
    // 必须内联隐藏：它挂在 body 下，作用域 CSS 匹配不到（与 pickFile 同一个坑）
    link.style.position = 'absolute';
    link.style.left = '-9999px';
    link.style.top = '0';
    link.style.opacity = '0';
    link.style.pointerEvents = 'none';
    link.setAttribute('aria-hidden', 'true');
    document.body.appendChild(link);
    try {
      link.click();
      setNotice('ok', '已开始下载形象包');
    } finally {
      // 立刻回收：下载已经在浏览器的队列里，节点不需要留着
      if (link.parentNode) link.parentNode.removeChild(link);
    }
  }

  /** 调整大小倍率 / 渲染方式（按形象保存，立即生效）。 */
  async function updateAppearance(patch, { silent = false } = {}) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/appearance`,
        { method: 'POST', body: patch },
      );
      if (!data) return;
      if (!silent) setNotice('ok', '外观已更新');
      // 让运行中的宠物立刻用上新尺寸（不必刷新页面）
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /** 清理内置形象的遗留覆盖（那些文件已不再生效）。 */
  async function clearLegacyOverrides() {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/overrides`,
        { method: 'DELETE' },
      );
      if (!data) return;
      const removed = (data.removed || []).length;
      setNotice('ok', removed ? `已清理 ${removed} 个遗留覆盖` : '没有需要清理的覆盖');
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  /**
   * 调整某行为的**触发时间**（逐形象保存，内置形象同样可调）。
   *
   * 这两项（`idle` 小动作 / 自动漫游）是唯一由时间驱动的行为，
   * 因此也是唯一能设「多久一次」的。落点是 `data/settings.json` 而不是
   * `pet.json`——它属于「这台机器上怎么养」的偏好，而且**内置形象必须能调**
   * （内置形象是只读的，而它恰恰是大多数用户唯一会用的形象）。
   */
  async function updateSchedule(behavior, patch) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/schedule`,
        { method: 'POST', body: { schedule: { [behavior]: patch } } },
      );
      if (!data) return;
      // 让运行中的宠物立刻用上新节奏（不必刷新页面）
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /** 清掉某形象的**全部**节奏覆盖（回落到包内声明 / 默认值）。 */
  async function resetSchedule() {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/schedule`,
        { method: 'POST', body: { reset: true } },
      );
      if (!data) return;
      setNotice('ok', '已恢复默认触发时间');
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /**
   * 改写**自建形象**的元信息：名字 / 作者 / 标准图像。
   *
   * 与 `/appearance`（大小、渲染方式）的分工：那个改的是「用户怎么看」，
   * 落在 `data/settings.json`，内置形象也能改；这个改的是**形象本身**
   * （写进 `pet.json`），因此只对自建形象开放。
   */
  async function updateMeta(patch, { message = '已更新' } = {}) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/meta`,
        { method: 'POST', body: patch },
      );
      if (!data) return;
      setNotice('ok', message);
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /**
   * 提交「新建形象」。
   *
   * 每个动作一个文件字段，字段名就是动作名；帧数/帧率走 `meta` 这个 JSON 字段。
   * 只提交**填了图**的动作——空字段会被后端当成「没提供」。
   *
   * 标准图像有两种提交形态（见 `draftStill`）：复用某个动作的某一帧走 JSON，
   * 单独上传一张走文件字段 `still`。后端两种都认。
   */
  async function submitCreate() {
    const name = draftName.trim();
    if (!name) {
      setNotice('error', '请先给形象起个名字');
      return;
    }
    if (!draft.idle || !draft.idle.file) {
      setNotice('error', '至少要给「待机」上传一张图');
      return;
    }

    const form = new FormData();
    form.append('name', name);
    // 作者署名：**总是提交**（哪怕是空串），让用户看到「署名」这件事存在。
    form.append('author', draftAuthor.trim());
    form.append('scale', String(draftScale));
    form.append('pixelated', draftPixelated ? '1' : '0');
    const meta = {};
    for (const [action, entry] of Object.entries(draft)) {
      if (!entry || !entry.file) continue;
      form.append(action, entry.file);
      meta[action] = { frames: Math.max(1, Number(entry.frames) || 1) };
      if (entry.fps) meta[action].fps = Number(entry.fps);
    }
    form.append('meta', JSON.stringify(meta));

    // ---- 标准图像
    //
    // 两种形态共用 `still` 这个字段名，但**一个是文件、一个是 JSON 文本**：
    // Flask 会把它们分别放进 `request.files` 与 `request.form`，因此能共存。
    // 这样后端只需要认一个字段名，不必为两种来源各写一条通路。
    if (draftStill && draftStill.file) {
      form.append('still', JSON.stringify({
        frames: Math.max(1, Number(draftStill.frames) || 1),
      }));
      form.append('still', draftStill.file);
    } else if (draftStill && draftStill.action) {
      form.append('still', JSON.stringify({
        action: draftStill.action,
        frame: Math.max(0, Number(draftStill.frame) || 0),
      }));
    }

    // ---- 触发节奏（只在用户真的改过时才写进 pet.json）
    if (draftSchedule) {
      form.append('schedule', JSON.stringify(draftSchedule));
    }

    await withBusy(async () => {
      const data = await call('/pets/create', { method: 'POST', body: form });
      if (!data) return;
      activeId = data.activePetId;
      selectedId = data.pet ? data.pet.id : '';
      creating = false;
      draft = {};
      draftName = '';
      draftAuthor = '';
      draftStill = null;
      draftSchedule = null;
      setNotice('ok', `已创建「${data.pet ? data.pet.name : name}」并设为当前形象`);
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  /**
   * 打开系统文件选择器（导入形象包 / 逐动作换图共用）。
   *
   * ⚠️ 两个**必须**遵守的点，都是实测踩出来的：
   *
   * 1. **隐藏必须内联写死，不能只靠 `.pet-file-input` 那个类。**
   *    这个 `<input>` 挂在 `document.body` 上（面板在 modal 里，祖先带
   *    `overflow` / `transform` 时原生选择器行为不稳定，且不该进宿主的焦点陷阱），
   *    而 `plugin.css` 里的 `.plugin-stm-pet .pet-file-input` 是**作用域内**选择器
   *    （F11 强制要求每条顶层规则以插件作用域为根），匹配不到 body 下的裸 input ——
   *    结果是原生「选择文件 / 未选择任何文件」控件直接排在页面底部，
   *    **每点一次多一条，刷新页面才消失**。
   *
   *    注意**不能**用「给 CSS 加一条裸 `.pet-file-input` 规则」来修：那会让
   *    `installer.scan_css_scope()` 判定整份样式违规并拒绝加载（症状变成「面板
   *    完全没样式」）。内联 style 是唯一既过作用域检查、又能真正隐藏的写法。
   *
   * 2. **取消也必须回收元素。** 用户点「取消」时浏览器只派发 `cancel`
   *    （Safari / 旧 Firefox 连 `cancel` 都不派发），**不派发 `change`** ——
   *    只监听 `change` 会让这个 input 永久留在 DOM 里。
   *    因此 `change` / `cancel` / 「窗口重新获得焦点后仍无文件」三条路都要收。
   */
  function pickFile({ accept, onPicked }) {
    const input = el('input', 'pet-file-input');
    input.type = 'file';
    if (accept) input.accept = accept;
    // 内联的视觉隐藏（不依赖作用域选择器，见上面第 1 点）
    input.style.position = 'absolute';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      cleanup();
      if (file) onPicked(file);
    });
    // 用户点了「取消」：Chromium 派发 cancel，Safari / 旧 Firefox 不派发
    input.addEventListener('cancel', cleanup);
    // 兜底：对话框关闭后窗口重获焦点；再等一拍仍没有文件就回收
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (!input.files || !input.files.length) cleanup();
      }, 0);
    };
    window.addEventListener('focus', onWindowFocus);

    document.body.appendChild(input);
    input.click();
  }

  // ---------------------------------------------------------------- 渲染

  function render() {
    if (!root || disposed) return;
    // 重渲染会把预览框的 DOM 换掉，旧播放器必须停掉（否则它还在给已摘除的
    // 节点写 style，并留下一个永远跑着的定时器）
    if (player) {
      player.dispose();
      player = null;
    }
    pendingPreview = null;
    root.textContent = '';

    const toolbar = el('div', 'pet-panel-toolbar');
    toolbar.appendChild(button('新建形象', 'is-primary', () => {
      creating = true;
      notice = null;
      render();
    }));
    toolbar.appendChild(button('导入形象包', '', () => {
      pickFile({ accept: '.zip,application/zip', onPicked: (file) => importPack(file) });
    }));
    toolbar.appendChild(button('刷新', '', () => withBusy(refresh)));
    toolbar.appendChild(el('div', 'pet-panel-toolbar-spacer'));
    const count = el('span', 'pet-card-meta', `${pets.length} 个形象`);
    toolbar.appendChild(count);
    root.appendChild(toolbar);

    // ---- 显示开关（放在最显眼的位置）
    //
    // 用户要求「插件应该支持关闭宠物」。这个开关必须**触手可及**：
    // 藏进「设置 → 插件」两层里就等于没有——想安静一会儿还要翻半天，
    // 用户会继续用「卸载插件」那个笨办法。
    root.appendChild(renderVisibility());

    if (notice) {
      const box = el(
        'div',
        `pet-notice ${notice.kind === 'error' ? 'is-error' : ''}`.trim(),
        notice.message,
      );
      root.appendChild(box);
    }

    const body = el('div', 'pet-panel-body');

    // ---- 左栏：形象列表
    const list = el('div', 'pet-panel-list');
    if (!pets.length) {
      list.appendChild(el('div', 'pet-empty', '还没有形象。点击「导入形象包」上传一个 .zip。'));
    }
    for (const pet of pets) {
      list.appendChild(renderPetCard(pet));
    }
    body.appendChild(list);

    // ---- 右栏：选中形象的详情（或新建表单）
    body.appendChild(creating ? renderCreate() : renderDetail());
    root.appendChild(body);

    // 缩略图几何依赖「帧数」，而帧数在 `detail` 里 —— 必须在 DOM 挂上、
    // 且 `detail` 已就绪之后再算（`clientWidth` 也只有挂上才有值）。
    applyThumbGeometry();
    // 动画预览器同理：要在 DOM 挂上之后才知道预览框的真实宽度
    if (!creating) mountPreviewPlayer();
  }

  function renderPetCard(pet) {
    const card = el('button', 'pet-card');
    card.type = 'button';
    card.dataset.marqueeIgnore = 'true';
    // 带上 id：验收脚本要能精确点到某一张卡（靠名字匹配会在多语言/改名时失效）
    card.dataset.petId = pet.id;
    if (pet.id === activeId) card.classList.add('is-active');
    if (pet.id === selectedId) card.classList.add('is-selected');
    if (pet.error) card.classList.add('is-broken');
    card.addEventListener('click', () => {
      selectedId = pet.id;
      loadDetail(pet.id);
    });

    const thumb = el('div', 'pet-card-thumb');
    // 缩略图只显示 **idle 的第一帧**。
    //
    // ⚠️ 不能用 `background-size: contain`：`/frame/<id>/idle` 返回的是
    // **整条水平 spritesheet**（例如 4 帧的 idle 是 1536×576），
    // 把整条压进 40px 的方框 → 每帧只剩 10px，看起来像一团乱码（实测）。
    // 正确做法：按「单帧宽 = 帧数 × 方框宽」放大整条，再用
    // `background-position: 0 0` 只露出第 0 帧。
    //
    // 几何所需的帧数来自**列表接口**（`pet.thumb`），而不是「当前选中形象的
    // 详情」——后者只在详情请求回来之后才有，且与本卡片无关。
    // 帧数写在 `data-` 上，由 `applyThumbGeometry()` 统一算（DOM 挂上后
    // 才知道方框的真实宽度）。
    const thumbSpec = pet.thumb || {};
    if (thumbSpec.url) {
      thumb.style.backgroundImage = `url("${thumbSpec.url}")`;
      thumb.style.backgroundRepeat = 'no-repeat';
      thumb.dataset.petId = pet.id;
      thumb.dataset.frames = String(Math.max(1, Number(thumbSpec.frames) || 1));
      thumb.dataset.layout = thumbSpec.layout === 'vertical' ? 'vertical' : 'horizontal';
      thumb.dataset.hasImage = 'true';
    } else {
      // 没有可用的图：留一个空框（面板上仍能看到这个形象存在，而不是破图）
      thumb.dataset.frames = '1';
    }
    card.appendChild(thumb);

    const copy = el('div', 'pet-card-copy');
    copy.appendChild(el('div', 'pet-card-name', pet.name || pet.id));
    const meta = pet.error
      ? '读取失败'
      : `${pet.source === 'user' ? '自定义' : '内置'} · ${pet.animations ? pet.animations.length : 0} 个动作`;
    copy.appendChild(el('div', 'pet-card-meta', meta));
    if (pet.id === activeId) {
      copy.appendChild(el('div', 'pet-card-meta', '当前使用中'));
    }
    card.appendChild(copy);
    return card;
  }

  function renderDetail() {
    const wrap = el('div', 'pet-panel-detail');

    if (!selectedId || !detail) {
      wrap.appendChild(el('div', 'pet-empty', '从左侧选择一个形象查看详情。'));
      return wrap;
    }

    const header = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, detail.name || detail.id));
    // 来源徽章：内置 / 自定义。用户一眼要能分清「这个能不能改」。
    title.appendChild(el(
      'span',
      detail.writable ? 'pet-badge' : 'pet-badge is-builtin',
      detail.writable ? '自定义' : '插件自带',
    ));
    header.appendChild(title);

    // ---- 作者署名
    //
    // 用户要求「自定义宠物应该支持设置作者名，方便其他人制作宠物发布」。
    // 因此这里对**自建**形象给一个可编辑的输入框；对内置形象只显示
    // （内置形象是随插件发布的，作者固定为「官方」）。
    header.appendChild(renderAuthorRow());
    if (detail.size) {
      header.appendChild(el(
        'div',
        'pet-field-hint',
        `单帧尺寸 ${detail.size.w} × ${detail.size.h}px（不必是正方形）`,
      ));
    }

    // 缺失必要动作要说清「缺什么、会怎么回退」（阶段 5 的明确要求，
    // 不是只置灰——用户得知道会发生什么）
    if (detail.missingRequired && detail.missingRequired.length) {
      const names = detail.missingRequired
        .map((name) => `${ACTION_LABELS[name] || name}（${name}）`)
        .join('、');
      const box = el('div', 'pet-notice is-warn');
      box.appendChild(el('div', null, `缺少必要动作：${names}`));
      box.appendChild(el(
        'div',
        'pet-field-hint',
        '这些动作会退化为「只移动位置、不播放动画」，宠物仍然可用；'
        + '想让它在这些状态下也有动作，可以单独给对应动作上传一张图。',
      ));
      header.appendChild(box);
    } else {
      header.appendChild(el('div', 'pet-field-hint', '所有必要动作齐全。'));
    }

    const actions = el('div', 'pet-panel-toolbar');
    if (selectedId !== activeId) {
      actions.appendChild(button('设为当前形象', 'is-primary', () => activatePet(selectedId)));
    }
    if (detail.writable) {
      // 导出只对**用户自建**形象开放（内置的随插件发布，导出没有意义）
      actions.appendChild(button('导出形象包', '', () => exportPet(selectedId)));
      actions.appendChild(button('删除', 'is-danger', () => deletePet(selectedId)));
    } else {
      actions.appendChild(el('span', 'pet-card-meta', '插件自带，形象内容不可修改'));
    }
    header.appendChild(actions);
    wrap.appendChild(header);

    wrap.appendChild(renderAppearance());

    // ---- 触发时间（唯一由时间驱动的两个行为：idle 小动作 / 自动漫游）
    wrap.appendChild(renderSchedule());

    // ---- 动画预览（可以直接播具体动作，内置形象同样支持）
    wrap.appendChild(renderPreview());

    // ---- 遗留覆盖提示（内置形象专属）
    if (detail.staleOverrides && detail.staleOverrides.length) {
      wrap.appendChild(renderLegacyOverrides());
    }

    // ---- 动作网格
    const section = el('div', 'pet-section');
    section.appendChild(el('div', 'pet-section-title', '动作'));
    if (detail.writable) {
      section.appendChild(el(
        'div',
        'pet-field-hint',
        '点每个动作的「换图」可单独替换该动作（不改动形象包本身）；'
        + '「恢复」会回到包内的原图。',
      ));
    } else {
      section.appendChild(el(
        'div',
        'pet-field-hint',
        '插件自带形象的内容是只读的，因此不提供换图；'
        + '想要自己的版本，可以用「新建形象」做一个。',
      ));
    }

    const grid = el('div', 'pet-action-grid');
    for (const entry of detail.actions || []) {
      grid.appendChild(renderActionTile(entry));
    }
    section.appendChild(grid);
    wrap.appendChild(section);

    return wrap;
  }

  /**
   * 外观区：大小倍率 + 渲染方式。
   *
   * 这两项**对内置形象也可调**：它们改的是「怎么看」（落在 `data/` 里的用户偏好），
   * 不是「是什么」（随包资源）。用户的屏幕分辨率与形象风格各不相同——
   * 二次元小图与真人立绘需要的倍率差很多，所以这一项必须开放给用户。
   */
  function renderAppearance() {
    const section = el('div', 'pet-section');
    section.appendChild(el('div', 'pet-section-title', '外观'));

    const min = limits.scaleMin || SCALE_MIN;
    const max = limits.scaleMax || SCALE_MAX;
    const current = Number(detail.scale) || 1;
    const declared = Number(detail.declaredScale) || 1;

    // ---- 大小倍率
    const field = el('div', 'pet-field');
    const labelRow = el('div', 'pet-slider-head');
    labelRow.appendChild(el('span', 'pet-field-label', '大小倍率'));
    const readout = el('span', 'pet-slider-value', formatScale(current));
    labelRow.appendChild(readout);
    field.appendChild(labelRow);

    const slider = el('input', 'pet-slider');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(SCALE_STEP);
    slider.value = String(current);
    slider.setAttribute('aria-label', '宠物大小倍率');
    // 拖动时只更新读数（不请求），松手才提交 —— 否则一次拖动会打出几十个请求
    slider.addEventListener('input', () => {
      readout.textContent = formatScale(Number(slider.value));
    });
    slider.addEventListener('change', () => {
      updateAppearance({ scale: Number(slider.value) });
    });
    field.appendChild(slider);

    // 实际像素高度比倍率更直观（用户真正在意的是「屏幕上多大」）
    const base = detail.size || {};
    const pixels = base.h ? Math.round(base.h * current) : 0;
    field.appendChild(el(
      'div',
      'pet-field-hint',
      `范围 ${min}× ~ ${max}×；当前约 ${pixels}px 高。`
      + (declared !== 1 ? `形象包建议 ${formatScale(declared)}。` : ''),
    ));

    const resetRow = el('div', 'pet-panel-toolbar');
    resetRow.appendChild(button('恢复默认大小', 'is-icon', () => {
      updateAppearance({ scale: null });
    }));
    field.appendChild(resetRow);
    section.appendChild(field);

    // ---- 渲染方式
    const renderField = el('div', 'pet-field');
    renderField.appendChild(el('div', 'pet-field-label', '渲染方式'));
    const choice = el('div', 'pet-choice-row');

    const modes = [
      {
        value: false,
        label: '平滑（插画 / 真人）',
        hint: '放大时做插值，边缘柔和',
      },
      {
        value: true,
        label: '像素风（硬边）',
        hint: '放大时保持硬边，不糊',
      },
    ];
    for (const mode of modes) {
      const isActive = Boolean(detail.pixelated) === mode.value;
      const node = el(
        'button',
        `pet-choice ${isActive ? 'is-active' : ''}`.trim(),
        mode.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.title = mode.hint;
      node.addEventListener('click', () => updateAppearance({ pixelated: mode.value }));
      choice.appendChild(node);
    }
    renderField.appendChild(choice);
    renderField.appendChild(el(
      'div',
      'pet-field-hint',
      '写实插画与真人形象建议用「平滑」——硬边放大时会出现块状锯齿；'
      + '像素风形象用「硬边」才不会糊。'
      + (detail.declaredPixelated ? '（形象包声明为像素风）' : ''),
    ));
    section.appendChild(renderField);

    return section;
  }

  /**
   * **作者署名**一行。
   *
   * 用户要求「自定义宠物应该支持设置作者名，方便其他人制作宠物发布」——
   * 有了署名，别人拿到一个宠物包就知道是谁做的，也才可能去找作者确认。
   * 内置形象的作者固定为「官方」，只读显示。
   */
  function renderAuthorRow() {
    const field = el('div', 'pet-field');
    const head = el('div', 'pet-slider-head');
    head.appendChild(el('span', 'pet-field-label', '作者'));
    field.appendChild(head);

    if (!detail.writable) {
      // 内置形象：只显示，不给编辑（它的 pet.json 是随包资源）
      const badge = el('div', 'pet-choice-row');
      badge.appendChild(el(
        'span',
        'pet-badge is-builtin',
        detail.author || '官方',
      ));
      field.appendChild(badge);
      field.appendChild(el(
        'div',
        'pet-field-hint',
        '插件自带的形象，作者由随包资源固定。',
      ));
      return field;
    }

    const input = el('input', 'pet-input');
    input.type = 'text';
    input.value = detail.author || '';
    input.placeholder = '例如：你的昵称';
    input.maxLength = 60;
    input.dataset.authorInput = 'true';
    input.setAttribute('aria-label', '形象作者');
    // 失焦或回车才提交：逐字符提交会打出一串请求
    const commit = () => {
      const next = input.value.trim();
      if (next === (detail.author || '')) return;
      updateMeta({ author: next }, {
        message: next ? `作者已设为「${next}」` : '已清空作者',
      });
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
    field.appendChild(input);
    field.appendChild(el(
      'div',
      'pet-field-hint',
      '会写进形象的 pet.json，导出形象包时一起带走——'
      + '别人拿到这个包就能看到是谁做的。',
    ));
    return field;
  }

  /**
   * **触发时间**区：调整「多久自己动一次」。
   *
   * 只列出真正**由时间驱动**的两个行为（`idle` 小动作 / 自动漫游）。
   * 其余动作由事件触发——`click` 要有人点、`fall` 要松手、`happy` 要有播报，
   * 给它们设「多久一次」没有意义，后端也会拒绝，因此这里不渲染它们的滑块。
   *
   * 这两项**对内置形象同样开放**：它们落在 `data/settings.json`（用户偏好），
   * 不是随包资源。内置形象恰恰是大多数用户唯一会用的形象。
   */
  function renderSchedule() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '触发时间'));
    title.appendChild(el('span', 'pet-badge', '可调节'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '只有「由时间自己发生」的行为能设间隔。点击、下落、播报这些由事件触发，'
      + '没有「多久一次」可言。这两项是按形象记住的。',
    ));

    const effective = detail.schedule || {};
    const declared = detail.declaredSchedule || {};

    for (const behavior of SCHEDULE_BEHAVIORS) {
      // ⚠️ 必须用 `behavior.key` 取值，不能用 `behavior` 本身：
      // 后者是 `{key, label, hint}` 对象，`effective[对象]` 恒为 `undefined`，
      // 于是滑块会渲染成**极值**（下限/上限），而用户看到的是「0.2~3600 秒」。
      // 实测踩到过：滑块看着在、也能拖，但初值是错的——比报错难查得多。
      const preset = DEFAULT_SCHEDULE_MS[behavior.key] || { min: 6000, max: 18000 };
      const current = effective[behavior.key] || preset;
      const suggested = declared[behavior.key] || preset;
      const minMs = clampScheduleMs(current.minIntervalMs, preset.min);
      const maxMs = clampScheduleMs(current.maxIntervalMs, preset.max);

      const field = el('div', 'pet-field');
      const head = el('div', 'pet-slider-head');
      head.appendChild(el('span', 'pet-field-label', behavior.label));
      const readout = el(
        'span',
        'pet-slider-value',
        formatInterval(minMs, maxMs),
      );
      head.appendChild(readout);
      field.appendChild(head);

      // 两个滑块（下界 / 上界）。用两个而不是一个「区间滑块」：
      // 原生 `<input type="range">` 不支持双柄，而自己造一个双柄滑块
      // 要处理键盘可达性、指针捕获与边界交叉——为一个次要设置不值得。
      const row = el('div', 'pet-schedule-row');
      for (const bound of ['min', 'max']) {
        const slider = el('input', 'pet-slider');
        slider.type = 'range';
        slider.min = String(limits.scheduleMinMs);
        slider.max = String(limits.scheduleMaxMs);
        // 用**秒**做步长（100ms）而不是 1ms：设置面板上没人会去调 1 毫秒，
        // 而 1ms 的步长会让滑块几乎不可用（3.6e6 个位置）。
        slider.step = '100';
        slider.value = String(bound === 'min' ? minMs : maxMs);
        slider.dataset.scheduleBehavior = behavior.key;
        slider.dataset.scheduleBound = bound;
        slider.setAttribute(
          'aria-label', `${behavior.label}的${bound === 'min' ? '最短' : '最长'}间隔`,
        );
        const live = () => {
          // 读数按**这个行为自己的**区间夹，而不是全局的 200~3600000：
          // 用全局区间的话，拖动时读数会跳到「0.2~3600 秒」这种没意义的值。
          const low = clampScheduleMs(
            Number(row.querySelector('[data-schedule-bound="min"]').value),
            preset.min,
          );
          const high = clampScheduleMs(
            Number(row.querySelector('[data-schedule-bound="max"]').value),
            preset.max,
          );
          readout.textContent = formatInterval(low, high);
        };
        slider.addEventListener('input', live);
        // 松手才提交 —— 否则一次拖动会打出几十个请求
        slider.addEventListener('change', () => {
          const low = Number(row.querySelector('[data-schedule-bound="min"]').value);
          const high = Number(row.querySelector('[data-schedule-bound="max"]').value);
          updateSchedule(behavior.key, {
            minIntervalMs: low,
            maxIntervalMs: high,
          });
        });
        row.appendChild(slider);
      }
      field.appendChild(row);
      field.appendChild(el(
        'div',
        'pet-field-hint',
        `${behavior.hint}`
        + (suggested.minIntervalMs
          ? `形象包建议 ${formatInterval(suggested.minIntervalMs, suggested.maxIntervalMs)}。`
          : ''),
      ));
      section.appendChild(field);
    }

    const row = el('div', 'pet-panel-toolbar');
    if (detail.scheduleOverridden) {
      row.appendChild(button('恢复默认触发时间', 'is-icon', () => resetSchedule()));
    }
    row.appendChild(el(
      'span',
      'pet-card-meta',
      detail.scheduleOverridden ? '已自定义' : '正在用默认 / 形象包的设置',
    ));
    section.appendChild(row);
    return section;
  }

  /**
   * 动画预览区：直接在这里播具体动作，不必切过去等它真的触发。
   *
   * 用户报障「插件管理里看不到动画效果」，这一区就是答案。
   * 对**内置形象同样开放**——只读限制的是「改图」，不是「看效果」。
   *
   * 播放规则与桌面上的宠物**完全一致**（帧数 / 帧率 / 非均匀帧时长 /
   * 排布都按后端的运行期定义走），因此「预览里看到的」就是「桌面上会看到的」。
   */
  function renderPreview() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '动画预览'));
    title.appendChild(el('span', 'pet-badge', '可播放'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '点任意动作即可在这里播放，用来核对动作效果与节奏。'
      + '播放规则与桌面上的宠物一致（含每帧时长），因此所见即所得。',
    ));

    const spec = previewSpec();
    const entry = previewEntry();

    const stage = el('div', 'pet-preview-stage');
    const box = el('div', 'pet-preview-box');
    box.dataset.previewBox = 'true';
    // 单帧 / 无图时也要有内容，因此图由 `player.load()` 写进 style
    stage.appendChild(box);

    const side = el('div', 'pet-preview-side');
    side.appendChild(el('div', 'pet-preview-name', ACTION_LABELS[previewAction] || previewAction));

    // ---- 元信息：帧数 / 节奏 / 变体
    if (spec) {
      const frames = Math.max(1, Number(spec.frames) || 1);
      const total = totalDuration(spec);
      const uniform = !(Array.isArray(spec.frameMs) && spec.frameMs.length === frames);
      const pace = uniform
        ? `${formatNumber(spec.fps)} fps`
        : `${Math.round(total)}ms / 轮（逐帧不同）`;
      side.appendChild(el(
        'div',
        'pet-preview-meta',
        `${frames} 帧 · ${pace} · ${spec.loop === false ? '播一遍' : '循环'}`,
      ));
      if (entry && entry.kind !== 'animated') {
        side.appendChild(el('div', 'pet-preview-meta', entry.note || '这个动作没有图'));
      }
      if (entry && entry.note && entry.kind === 'animated') {
        side.appendChild(el('div', 'pet-preview-meta', entry.note));
      }
    } else {
      side.appendChild(el('div', 'pet-preview-meta', '这个动作没有可播的图。'));
    }

    // ---- 变体切换（多套动画）
    const variants = (entry && entry.variants) || [];
    if (variants.length > 1) {
      const row = el('div', 'pet-preview-variants');
      row.appendChild(el('span', 'pet-field-hint', '这一动作有多套动画，按权重随机播：'));
      variants.forEach((variant, at) => {
        const node = el(
          'button',
          `pet-choice ${at === previewVariant ? 'is-active' : ''}`.trim(),
          `第 ${at + 1} 套（权重 ${formatNumber(variant.weight)}）`,
        );
        node.type = 'button';
        node.dataset.marqueeIgnore = 'true';
        node.dataset.previewVariant = String(at);
        node.addEventListener('click', () => {
          previewVariant = at;
          previewPlaying = true;
          render();
        });
        row.appendChild(node);
      });
      side.appendChild(row);
    }

    // ---- 播放控制
    const controls = el('div', 'pet-panel-toolbar');
    controls.appendChild(button('重播', 'is-primary', () => {
      previewPlaying = true;
      if (player) player.play();
      syncPreviewToggle();
    }));
    const toggle = button(previewPlaying ? '暂停' : '播放', '', () => {
      previewPlaying = !previewPlaying;
      if (player) {
        if (previewPlaying) player.play();
        else player.stop();
      }
      syncPreviewToggle();
    });
    toggle.dataset.previewToggle = 'true';
    previewToggle = toggle;
    controls.appendChild(toggle);
    controls.appendChild(button('第 1 帧', 'is-icon', () => {
      previewPlaying = false;
      if (player) player.reset();
      syncPreviewToggle();
    }));
    side.appendChild(controls);

    // ---- 速度倍率（预览用，只影响预览；桌面宠物走宿主表单的「动画速度」）
    const speedRow = el('div', 'pet-slider-head');
    speedRow.appendChild(el('span', 'pet-field-label', '预览速度'));
    speedRow.appendChild(el('span', 'pet-slider-value', `${formatNumber(previewSpeed)}×`));
    side.appendChild(speedRow);
    const slider = el('input', 'pet-slider');
    slider.type = 'range';
    slider.min = String(SPEED_MIN);
    slider.max = String(SPEED_MAX);
    slider.step = '0.05';
    slider.value = String(previewSpeed);
    slider.setAttribute('aria-label', '动画预览速度');
    slider.dataset.previewSpeed = 'true';
    slider.addEventListener('input', () => {
      previewSpeed = Number(slider.value) || 1;
      if (player) player.setSpeed(previewSpeed);
      const readout = side.querySelector('.pet-slider-value');
      if (readout) readout.textContent = `${formatNumber(previewSpeed)}×`;
    });
    side.appendChild(slider);
    side.appendChild(el(
      'div',
      'pet-field-hint',
      '数值越大越慢。桌面上的宠物请用「设置 → 插件」里的「动画速度」统一调。',
    ));

    // ---- 帧读数
    const readout = el('div', 'pet-preview-frame');
    readout.dataset.previewFrame = 'true';
    side.appendChild(readout);

    stage.appendChild(side);
    section.appendChild(stage);

    // ---- 动作选择：点一下就能播
    const picker = el('div', 'pet-preview-picker');
    for (const item of (detail && detail.actions) || []) {
      const node = el(
        'button',
        `pet-choice ${item.action === previewAction ? 'is-active' : ''}`
          + `${item.kind !== 'animated' ? ' is-muted' : ''}`.trim(),
        ACTION_LABELS[item.action] || item.action,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.dataset.previewAction = item.action;
      node.title = item.kind === 'animated'
        ? `播放「${ACTION_LABELS[item.action] || item.action}」`
        : `${ACTION_LABELS[item.action] || item.action}：没有可播的图`;
      node.addEventListener('click', () => {
        previewAction = item.action;
        previewVariant = 0;
        previewPlaying = true;
        render();
      });
      picker.appendChild(node);
    }
    section.appendChild(picker);

    // 播放器在 DOM 挂上之后才能算帧几何（`clientWidth` 只有挂上才有值），
    // 因此这里只登记意图，真正 `load()` 由 `mountPreviewPlayer()` 在渲染收尾时做。
    pendingPreview = { box, spec, readout };
    return section;
  }

  /**
   * 渲染收尾时挂载预览器。
   *
   * 必须**在 DOM 挂上之后**：帧几何依赖预览框的真实宽度，
   * 而 `render()` 只负责造节点，还没插进文档。
   */
  function mountPreviewPlayer() {
    if (player) {
      player.dispose();
      player = null;
    }
    const pending = pendingPreview;
    pendingPreview = null;
    if (!pending || !pending.box) return;
    player = createAnimationPlayer({
      box: pending.box,
      speed: previewSpeed,
      onFrame: (index, frames) => {
        const node = pending.readout;
        if (node) node.textContent = frames > 1 ? `第 ${index + 1} / ${frames} 帧` : '单帧';
      },
      onEnd: () => {
        // 一次性动作播完：**只更新按钮文字**，绝不 `render()`。
        //
        // `render()` 会重建面板并重新 `load()` 播放器（从头播），于是
        // 「播完 → onEnd → render → 又播」形成无限循环（实测：点一下「被点击」
        // 就永远停不下来）。这里改成就地同步状态。
        previewPlaying = false;
        syncPreviewToggle();
      },
    });
    // 尊重「暂停」状态：暂停时只画第 0 帧，不自动播
    if (pending.spec) player.load(pending.spec, { autoplay: previewPlaying });
  }

  /** 倍率的短格式（去掉多余的 0）。 */
  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return String(Math.round(number * 100) / 100);
  }

  /** 内置形象的遗留覆盖提示 + 一键清理。 */
  function renderLegacyOverrides() {
    const box = el('div', 'pet-notice is-warn');
    const names = (detail.staleOverrides || [])
      .map((name) => ACTION_LABELS[name] || name)
      .join('、');
    box.appendChild(el('div', null, `检测到 ${detail.staleOverrides.length} 个遗留的自定义图：${names}`));
    box.appendChild(el(
      'div',
      'pet-field-hint',
      '插件自带的形象现在是只读的，这些图不会再生效，但它们仍占着数据目录。'
      + '清理只删除你自己上传的覆盖文件，不会动插件自带的图。',
    ));
    const row = el('div', 'pet-panel-toolbar');
    row.appendChild(button('清理这些文件', 'is-danger', () => clearLegacyOverrides()));
    box.appendChild(row);
    return box;
  }

  /** 把倍率格式化成短字符串（去掉多余的 0）。 */
  function formatScale(value) {
    const number = Number(value) || 1;
    return `${Math.round(number * 100) / 100}×`;
  }

  /**
   * 把一个毫秒间隔夹到合法区间内。
   *
   * 与后端的 `clamp_schedule_ms` 同一套语义：夹住而不是抛错——
   * 这个值会被渲染进滑块的 `value`，而 `NaN` 会让滑块直接失效。
   */
  function clampScheduleMs(value, fallbackLow) {
    const low = Number(limits.scheduleMinMs) || SCHEDULE_FALLBACK_MIN_MS;
    const high = Number(limits.scheduleMaxMs) || SCHEDULE_FALLBACK_MAX_MS;
    const number = Number(value);
    const base = Number.isFinite(number) && number > 0
      ? number
      : (Number(fallbackLow) || low);
    return Math.round(Math.min(Math.max(base, low), high));
  }

  /**
   * 把「最小~最大」毫秒区间格式化成**秒**（面板上没人按毫秒思考）。
   *
   * 小于 1 秒时保留一位小数：`0.2~0.5 秒` 比 `0~1 秒` 有用得多。
   */
  function formatInterval(minMs, maxMs) {
    const low = Number(minMs) || 0;
    const high = Number(maxMs) || 0;
    const format = (value) => {
      const seconds = value / 1000;
      if (seconds >= 10) return String(Math.round(seconds));
      return String(Math.round(seconds * 10) / 10);
    };
    return `${format(low)}~${format(high)} 秒`;
  }

  /**
   * 这个动作算不算「必要」。
   *
   * `walk-left` / `walk-right` 也算：行走是必要动作，而它**只认方向化贴图**
   * ——提供任一侧即满足需求（`REQUIRED_ACTIONS` 里的 `walk` 就是这个需求的代号）。
   * 若只按 `REQUIRED_ACTIONS.includes(action)` 判断，两个侧视动作会被标成「可选」，
   * 与 §3 的动作表不符。
   */
  function isRequiredAction(action) {
    if (REQUIRED_ACTIONS.includes(action)) return true;
    return action === 'walk-left' || action === 'walk-right';
  }

  function renderActionTile(entry) {
    const tile = el('div', 'pet-action-tile');
    const required = isRequiredAction(entry.action);
    const isFallback = entry.kind === 'animated' && entry.source !== entry.action;
    if (isFallback) tile.classList.add('is-fallback');
    if (entry.kind !== 'animated') tile.classList.add('is-missing');

    const preview = el('div', 'pet-action-preview');
    const previewUrl = entry.url;
    const frames = Math.max(1, Number(entry.frames) || 1);
    if (previewUrl && entry.kind === 'animated') {
      preview.style.backgroundImage = `url("${previewUrl}")`;
      preview.style.backgroundRepeat = 'no-repeat';
      // 与卡片缩略图同一个坑：这里拿到的是**整条** spritesheet。
      // 用 `contain` 会把整条压进 56px 的小方框，每帧只剩十几像素。
      // 因此同样是「按帧数放大 + 左对齐」，只露出第 0 帧。
      preview.dataset.frames = String(frames);
      preview.dataset.layout = entry.layout === 'vertical' ? 'vertical' : 'horizontal';
      preview.dataset.hasImage = 'true';
    }
    tile.appendChild(preview);

    if (entry.overridden) {
      tile.appendChild(el('span', 'pet-action-badge', '自定'));
    } else if (isFallback) {
      tile.appendChild(el('span', 'pet-action-badge is-warn', '回退'));
    }

    tile.appendChild(el('div', 'pet-action-name', ACTION_LABELS[entry.action] || entry.action));
    tile.appendChild(el(
      'div',
      'pet-action-note',
      describeEntry(entry, required, isFallback),
    ));

    const row = el('div', 'pet-panel-toolbar');
    // 内置形象严格只读：**不渲染**换图/恢复按钮。
    // 后端也会拒绝（403），这里只是不让用户点了才发现不行。
    if (detail.writable) {
      row.appendChild(button('换图', 'is-icon', () => {
        pickFile({ accept: 'image/*', onPicked: (file) => uploadActionImage(entry.action, file) });
      }));
      if (entry.overridden) {
        row.appendChild(button('恢复', 'is-icon', () => clearActionImage(entry.action)));
      }
    } else {
      row.appendChild(el('span', 'pet-card-meta', '只读'));
    }
    tile.appendChild(row);
    return tile;
  }

  /**
   * 「新建形象」表单。
   *
   * 设计取舍：**不做**自由拖拽上传区，也不做多帧预览器——
   * 每个动作一行「选图 + 帧数」，够用且不易出错。帧数填了就按水平 spritesheet
   * 切分（后端校验宽度能否整除，除不尽会给出可读错误）。
   */
  function renderCreate() {
    const wrap = el('div', 'pet-panel-detail');

    const header = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '新建形象'));
    header.appendChild(title);
    header.appendChild(el(
      'div',
      'pet-field-hint',
      '给每个动作上传一张图即可。单帧尺寸从「待机」推导，其它动作会自动对齐，'
      + '所以不必自己裁成统一尺寸；形象也不要求是正方形。',
    ));

    const nameField = el('div', 'pet-field');
    nameField.appendChild(el('div', 'pet-field-label', '形象名字'));
    const nameInput = el('input', 'pet-input');
    nameInput.type = 'text';
    nameInput.value = draftName;
    nameInput.placeholder = '例如：我的猫娘';
    nameInput.maxLength = 60;
    nameInput.dataset.createName = 'true';
    nameInput.addEventListener('input', () => { draftName = nameInput.value; });
    nameField.appendChild(nameInput);
    header.appendChild(nameField);

    // ---- 作者署名（用户要求：自定义宠物应能设作者名，便于发布）
    const authorField = el('div', 'pet-field');
    authorField.appendChild(el('div', 'pet-field-label', '作者'));
    const authorInput = el('input', 'pet-input');
    authorInput.type = 'text';
    authorInput.value = draftAuthor;
    authorInput.placeholder = '例如：你的昵称（可留空）';
    authorInput.maxLength = 60;
    authorInput.dataset.createAuthor = 'true';
    authorInput.addEventListener('input', () => { draftAuthor = authorInput.value; });
    authorField.appendChild(authorInput);
    authorField.appendChild(el(
      'div',
      'pet-field-hint',
      '会写进形象的 pet.json，导出形象包时一起带走。'
      + '想让别人知道这个宠物是谁做的，就填上。',
    ));
    header.appendChild(authorField);
    wrap.appendChild(header);

    // ---- 动作列表
    const section = el('div', 'pet-section');
    section.appendChild(el('div', 'pet-section-title', '动作图'));
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '「待机」是唯一必须的：其它动作缺失时会自动回退到它。'
      + '若一张图里横向排了多帧动画，把帧数填上即可。',
    ));

    for (const item of CREATABLE_ACTIONS) {
      section.appendChild(renderCreateRow(item));
    }
    wrap.appendChild(section);

    // ---- 标准图像（不播动画时显示的那一帧）
    wrap.appendChild(renderCreateStill());

    // ---- 触发时间（初始值；创建后仍可在形象详情里改）
    wrap.appendChild(renderCreateSchedule());

    // ---- 外观初值
    const look = el('div', 'pet-section');
    look.appendChild(el('div', 'pet-section-title', '初始外观'));
    const scaleField = el('div', 'pet-field');
    const scaleHead = el('div', 'pet-slider-head');
    scaleHead.appendChild(el('span', 'pet-field-label', '大小倍率'));
    const scaleReadout = el('span', 'pet-slider-value', formatScale(draftScale));
    scaleHead.appendChild(scaleReadout);
    scaleField.appendChild(scaleHead);

    const scaleSlider = el('input', 'pet-slider');
    scaleSlider.type = 'range';
    scaleSlider.min = String(limits.scaleMin || SCALE_MIN);
    scaleSlider.max = String(limits.scaleMax || SCALE_MAX);
    scaleSlider.step = String(SCALE_STEP);
    scaleSlider.value = String(draftScale);
    scaleSlider.setAttribute('aria-label', '新形象的大小倍率');
    scaleSlider.addEventListener('input', () => {
      draftScale = Number(scaleSlider.value);
      scaleReadout.textContent = formatScale(draftScale);
    });
    scaleField.appendChild(scaleSlider);
    scaleField.appendChild(el(
      'div',
      'pet-field-hint',
      '创建后仍可在形象详情里随时调整，并且是按形象记住的。',
    ));
    look.appendChild(scaleField);

    const pixField = el('div', 'pet-field');
    pixField.appendChild(el('div', 'pet-field-label', '渲染方式'));
    const pixChoice = el('div', 'pet-choice-row');
    for (const mode of [
      { value: false, label: '平滑（插画 / 真人）' },
      { value: true, label: '像素风（硬边）' },
    ]) {
      const node = el(
        'button',
        `pet-choice ${draftPixelated === mode.value ? 'is-active' : ''}`.trim(),
        mode.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.addEventListener('click', () => {
        draftPixelated = mode.value;
        render();
      });
      pixChoice.appendChild(node);
    }
    pixField.appendChild(pixChoice);
    look.appendChild(pixField);
    wrap.appendChild(look);

    // ---- 操作
    const actions = el('div', 'pet-panel-toolbar');
    actions.appendChild(button('创建', 'is-primary', () => submitCreate()));
    actions.appendChild(button('取消', '', () => {
      creating = false;
      draft = {};
      draftName = '';
      draftAuthor = '';
      draftStill = null;
      draftSchedule = null;
      notice = null;
      render();
    }));
    actions.appendChild(el(
      'span',
      'pet-card-meta',
      draft.idle && draft.idle.file ? '已选择待机图' : '还需要一张「待机」图',
    ));
    wrap.appendChild(actions);

    return wrap;
  }

  /**
   * 新建表单的**标准图像**区。
   *
   * 这是本轮修「宠物一直卡在抬头看的那一帧」的入口。不设也能用（回落到
   * idle 首帧），但作者一旦给 idle 挂了第二套动画（例如「张望」），
   * 回落值就可能是个怪姿势，所以这里明确地把这件事摆出来让作者决定。
   *
   * 三种选择：
   * - 不设（默认，回落 idle 首帧）；
   * - 复用某个已上传动作的某一帧（最常见的「idle 第 3 帧就是我要的姿势」）；
   * - 单独上传一张。
   */
  function renderCreateStill() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '标准图像'));
    title.appendChild(el('span', 'pet-badge', '可选'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '不播放动画时显示的那一帧（也就是平时静止的姿势）。'
      + '不设就回落到「待机」的第一帧——若待机挂了两套动画，'
      + '那个回落值可能是个怪姿势，因此建议显式选一张。',
    ));

    const row = el('div', 'pet-choice-row');
    const modes = [
      { key: 'none', label: '不设（用待机首帧）' },
      { key: 'action', label: '复用某个动作的一帧' },
      { key: 'file', label: '单独上传一张' },
    ];
    const currentKey = !draftStill ? 'none' : (draftStill.file ? 'file' : 'action');
    for (const mode of modes) {
      const node = el(
        'button',
        `pet-choice ${currentKey === mode.key ? 'is-active' : ''}`.trim(),
        mode.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.dataset.stillMode = mode.key;
      node.addEventListener('click', () => {
        if (mode.key === 'none') draftStill = null;
        else if (mode.key === 'action') draftStill = { action: 'idle', frame: 0 };
        else draftStill = { file: null, frames: 1 };
        render();
      });
      row.appendChild(node);
    }
    section.appendChild(row);

    if (currentKey === 'action') {
      const pick = el('div', 'pet-field');
      const select = el('select', 'pet-input');
      select.dataset.stillAction = 'true';
      for (const [action, entry] of Object.entries(draft)) {
        if (!entry || !entry.file) continue;
        const option = el('option', null, ACTION_LABELS[action] || action);
        option.value = action;
        select.appendChild(option);
      }
      select.value = draftStill.action || 'idle';
      select.addEventListener('change', () => {
        draftStill = { action: select.value, frame: 0 };
        render();
      });
      pick.appendChild(el('div', 'pet-field-label', '用哪个动作的图'));
      pick.appendChild(select);

      const frames = Math.max(1, Number((draft[select.value] || {}).frames) || 1);
      const frameInput = el('input', 'pet-input is-num');
      frameInput.type = 'number';
      frameInput.min = '1';
      frameInput.max = String(frames);
      frameInput.value = String(Math.min(Number(draftStill.frame) || 0, frames - 1) + 1);
      frameInput.dataset.stillFrame = 'true';
      frameInput.addEventListener('change', () => {
        const value = Math.max(1, Math.min(frames, Number(frameInput.value) || 1));
        frameInput.value = String(value);
        draftStill = { action: select.value, frame: value - 1 };
      });
      pick.appendChild(el('div', 'pet-field-label', `用第几帧（这个动作共 ${frames} 帧）`));
      pick.appendChild(frameInput);
      section.appendChild(pick);
    } else if (currentKey === 'file') {
      const pick = el('div', 'pet-field');
      const cell = el('div', 'pet-create-file');
      cell.appendChild(button(
        draftStill.file ? '重新选择' : '选择图片',
        'is-icon',
        () => pickFile({
          accept: 'image/*',
          onPicked: (file) => {
            draftStill = Object.assign({ frames: 1 }, draftStill, { file });
            render();
          },
        }),
      ));
      if (draftStill.file) {
        cell.appendChild(el('span', 'pet-card-meta', truncateName(draftStill.file.name)));
      }
      pick.appendChild(cell);
      pick.appendChild(el(
        'div',
        'pet-field-hint',
        '会按形象的单帧尺寸自动缩放居中，不必自己裁。',
      ));
      section.appendChild(pick);
    }

    return section;
  }

  /**
   * 新建表单的**触发时间**区。
   *
   * 默认「用默认值」——大多数作者不该被这个困扰。想调的作者可以在这里
   * 给出形象自己的节奏，它会写进 `pet.json` 成为这个形象的「作者建议值」。
   */
  function renderCreateSchedule() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '触发时间'));
    title.appendChild(el('span', 'pet-badge', '可选'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '闲着的时候多久自己动一次。不填就用默认值'
      + '（待机小动作 6~18 秒、自动漫游 3~9 秒），大多数形象不需要改。',
    ));

    for (const behavior of SCHEDULE_BEHAVIORS) {
      const preset = DEFAULT_SCHEDULE_MS[behavior.key]
        || { min: 6000, max: 18000 };
      const current = (draftSchedule && draftSchedule[behavior.key]) || preset;
      const minMs = clampScheduleMs(current.min ?? current.minIntervalMs, preset.min);
      const maxMs = clampScheduleMs(current.max ?? current.maxIntervalMs, preset.max);

      const field = el('div', 'pet-field');
      const head = el('div', 'pet-slider-head');
      head.appendChild(el('span', 'pet-field-label', behavior.label));
      const readout = el('span', 'pet-slider-value', formatInterval(minMs, maxMs));
      head.appendChild(readout);
      field.appendChild(head);

      const row = el('div', 'pet-schedule-row');
      for (const bound of ['min', 'max']) {
        const slider = el('input', 'pet-slider');
        slider.type = 'range';
        slider.min = String(limits.scheduleMinMs);
        slider.max = String(limits.scheduleMaxMs);
        slider.step = '100';
        slider.value = String(bound === 'min' ? minMs : maxMs);
        slider.dataset.createSchedule = behavior.key;
        slider.dataset.createScheduleBound = bound;
        slider.setAttribute(
          'aria-label', `新形象的${behavior.label}${bound === 'min' ? '最短' : '最长'}间隔`,
        );
        slider.addEventListener('input', () => {
          const low = Number(row.querySelector('[data-create-schedule-bound="min"]').value);
          const high = Number(row.querySelector('[data-create-schedule-bound="max"]').value);
          readout.textContent = formatInterval(low, high);
          draftSchedule = Object.assign({}, draftSchedule, {
            [behavior.key]: {
              min: clampScheduleMs(low, preset.min),
              max: clampScheduleMs(high, preset.max),
            },
          });
        });
        row.appendChild(slider);
      }
      field.appendChild(row);
      section.appendChild(field);
    }
    return section;
  }

  /** 新建表单里的单个动作行：选图 + 帧数 + 帧率。 */
  function renderCreateRow({ action, required }) {
    const entry = draft[action] || null;
    const row = el('div', 'pet-create-row');

    const label = el('div', 'pet-create-label');
    label.appendChild(el('span', 'pet-field-label', ACTION_LABELS[action] || action));
    label.appendChild(el(
      'span',
      required ? 'pet-badge is-required' : 'pet-card-meta',
      required ? '必需' : '可选',
    ));
    row.appendChild(label);

    const fileCell = el('div', 'pet-create-file');
    fileCell.appendChild(button(entry && entry.file ? '重新选择' : '选择图片', 'is-icon', () => {
      pickFile({
        accept: 'image/*',
        onPicked: (file) => {
          draft[action] = Object.assign({ frames: 1, fps: 0 }, draft[action], { file });
          render();
        },
      });
    }));
    if (entry && entry.file) {
      fileCell.appendChild(el('span', 'pet-card-meta', truncateName(entry.file.name)));
    }
    row.appendChild(fileCell);

    const framesCell = el('div', 'pet-create-num');
    framesCell.appendChild(el('span', 'pet-card-meta', '帧数'));
    const framesInput = el('input', 'pet-input is-num');
    framesInput.type = 'number';
    framesInput.min = '1';
    framesInput.max = '64';
    framesInput.value = String(entry && entry.frames ? entry.frames : 1);
    framesInput.disabled = !entry || !entry.file;
    framesInput.addEventListener('change', () => {
      const value = Math.max(1, Math.min(64, Number(framesInput.value) || 1));
      framesInput.value = String(value);
      draft[action] = Object.assign({}, draft[action], { frames: value });
    });
    framesCell.appendChild(framesInput);
    row.appendChild(framesCell);

    const fpsCell = el('div', 'pet-create-num');
    fpsCell.appendChild(el('span', 'pet-card-meta', 'fps'));
    const fpsInput = el('input', 'pet-input is-num');
    fpsInput.type = 'number';
    fpsInput.min = '1';
    fpsInput.max = '60';
    fpsInput.placeholder = '默认';
    fpsInput.value = entry && entry.fps ? String(entry.fps) : '';
    fpsInput.disabled = !entry || !entry.file;
    fpsInput.addEventListener('change', () => {
      const raw = Number(fpsInput.value);
      const value = raw > 0 ? Math.max(1, Math.min(60, raw)) : 0;
      fpsInput.value = value ? String(value) : '';
      draft[action] = Object.assign({}, draft[action], { fps: value });
    });
    fpsCell.appendChild(fpsInput);
    row.appendChild(fpsCell);

    if (entry && entry.file) {
      row.appendChild(button('移除', 'is-icon', () => {
        delete draft[action];
        render();
      }));
    }

    return row;
  }

  /** 文件名过长时中间截断（面板很窄，完整名字会撑破布局）。 */
  function truncateName(name) {
    const text = String(name || '');
    if (text.length <= 18) return text;
    return `${text.slice(0, 8)}…${text.slice(-6)}`;
  }

  function describeEntry(entry, required, isFallback) {
    if (entry.kind !== 'animated') {
      return entry.note || '没有可用的图，只移动位置';
    }
    if (isFallback) {
      return `未提供，回退到「${ACTION_LABELS[entry.source] || entry.source}」`;
    }
    const frames = Number(entry.frames) || 1;
    if (frames <= 1) return '单帧（静态显示）';
    const suffix = required ? '' : '（可选）';
    return `${frames} 帧 @ ${entry.fps}fps${suffix}`;
  }

  // ---------------------------------------------------------------- 生命周期

  return {
    /** 由表面的 `mount(container)` 调用。返回清理函数。 */
    mount(container) {
      root = el('div', 'pet-panel plugin-stm-pet');
      root.dataset.plugin = 'stm-pet';
      container.appendChild(root);
      render();
      // 缩略图方框宽度可能随容器变化（`clientWidth` 变化后帧几何要重算），
      // 因此挂上后补一次；ResizeObserver 不可用时跳过（只是缩略图略偏，不影响功能）
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
          applyThumbGeometry();
          // 预览框的尺寸也可能变（右栏宽度变化），帧几何要跟着重算
          if (player) player.seek(player.frame);
        });
        resizeObserver.observe(root);
      }
      // 首屏加载（不阻塞挂载，失败会显示为通知条）
      withBusy(refresh);
      return () => {
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        // 预览器的定时器必须停掉：面板关掉之后它还在跑就是泄漏
        if (player) {
          player.dispose();
          player = null;
        }
        pendingPreview = null;
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = null;
      };
    },

    /** 表面已挂载时再次从入口进入（宿主不会重新 mount）。 */
    onOpen() {
      if (!root) return;
      // 每次打开都同步一次显示状态：宠物可能被别处（诊断句柄 / 别的入口）关掉了
      if (typeof getHidden === 'function') hiddenState = Boolean(getHidden());
      // 每次打开都刷新一次：形象可能被别处改过
      withBusy(refresh);
    },

    /** 由 `plugin.js` 回灌显示状态（后台改状态时让面板跟上）。 */
    setHiddenState,

    /**
     * 打开面板时回到形象详情（而不是停在新建表单）。
     *
     * 用户从入口进来通常是想**管理**已有形象；上次没提交完的草稿留在内存里，
     * 下次点「新建形象」还能接着填。
     */
    resetView() {
      creating = false;
      if (root) render();
    },

    /** 宿主配置变更（标量开关走宿主表单）→ 反映到面板上的只读提示。 */
    refreshConfig() {
      if (root) render();
    },

    dispose() {
      disposed = true;
      if (player) {
        player.dispose();
        player = null;
      }
      pendingPreview = null;
      root = null;
    },
  };
}
