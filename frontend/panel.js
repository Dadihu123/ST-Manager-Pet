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

export function createSettingsPanel({ api, getConfig, getOwnSettings, onConfigChanged, onPetChanged }) {
  let root = null;
  let disposed = false;
  let pets = [];
  let activeId = '';
  let selectedId = '';
  let detail = null;
  let busy = false;
  let notice = null;
  /** 缩略图几何的观察者（容器宽度变化时重算帧几何）。 */
  let resizeObserver = null;
  /** 当前是否处于「新建形象」视图（而不是形象详情）。 */
  let creating = false;
  /** 新建表单的暂存状态：`{action: {file, frames, fps}}`。 */
  let draft = {};
  /** 新建表单的标量字段。 */
  let draftName = '';
  let draftScale = 1;
  let draftPixelated = false;
  /** 面板拿到的限制（倍率区间由后端给，避免两边写死不一致）。 */
  let limits = { scaleMin: SCALE_MIN, scaleMax: SCALE_MAX };

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
   * 把「只显示第 0 帧」的几何写进缩略图。
   *
   * 关键点：帧图是**整条 spritesheet**，缩略图方框只有 40px。
   * 要让第 0 帧刚好填满方框，背景图必须按「单帧宽 × 帧数」放大，
   * 并且**左对齐**（`position 0 0`）——居中会把第 1、2 帧露进来。
   *
   * 单帧的逻辑尺寸用后端给的 `size`（CSS px，已含用户缩放的原始值），
   * 帧数用 `frames`；两者都来自 `runtime_pack()`，前端不猜。
   */
  function applyThumbGeometry() {
    if (!root || !detail || !detail.actions) return;
    const tile = (detail.actions || []).find((entry) => entry.action === 'idle');
    if (!tile) return;

    const box = root.querySelector('.pet-card-thumb');
    if (!box) return;

    const frames = Math.max(1, Number(tile.frames) || 1);
    const boxSize = box.clientWidth || 40;

    if (!tile.url || tile.kind !== 'animated') {
      box.style.backgroundSize = 'contain';
      box.style.backgroundPosition = 'center';
      return;
    }

    // 单帧按方框宽度等比放大；整条宽度 = 帧数 × 单帧宽。
    // `vertical` 排布同理，换成高度方向。
    if (tile.layout === 'vertical') {
      box.style.backgroundSize = `auto ${boxSize * frames}px`;
      box.style.backgroundPosition = 'center top';
    } else {
      box.style.backgroundSize = `${boxSize * frames}px auto`;
      box.style.backgroundPosition = 'left top';
    }
    // 图片内容变了（URL 带版本），几何不用跟着变——版本变了浏览器自然会换图
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
    if (!disposed) render();
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
   * 提交「新建形象」。
   *
   * 每个动作一个文件字段，字段名就是动作名；帧数/帧率走 `meta` 这个 JSON 字段。
   * 只提交**填了图**的动作——空字段会被后端当成「没提供」。
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

    await withBusy(async () => {
      const data = await call('/pets/create', { method: 'POST', body: form });
      if (!data) return;
      activeId = data.activePetId;
      selectedId = data.pet ? data.pet.id : '';
      creating = false;
      draft = {};
      draftName = '';
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
    // **整条水平 spritesheet**（例如 4 帧的 idle 是 256×64），
    // 把 256 宽压进 40px 的方框 → 每帧只剩 10px，看起来像一团乱码（实测）。
    // 正确做法：按「单帧宽 = 帧数 × 方框宽」放大整条，再用
    // `background-position: 0 0` 只露出第 0 帧。
    thumb.style.backgroundImage = `url("/api/plugins/stm-pet/frame/${encodeURIComponent(pet.id)}/idle")`;
    thumb.style.backgroundRepeat = 'no-repeat';
    // 几何由 `applyThumbGeometry()` 在数据到位后写入（帧数与单帧尺寸来自后端）
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

    if (detail.author) {
      header.appendChild(el('div', 'pet-field-hint', `作者：${detail.author}`));
    }
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
      '插件自带的形象现在是只读的，这些图**不会再生效**，但它们仍占着数据目录。'
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
    if (entry.url && entry.kind === 'animated') {
      preview.style.backgroundImage = `url("${entry.url}")`;
      // 单帧只显示那一帧；多帧显示第一帧（够表达了）
      preview.style.backgroundSize = 'contain';
      preview.style.backgroundPosition = 'center';
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
    nameInput.addEventListener('input', () => { draftName = nameInput.value; });
    nameField.appendChild(nameInput);
    header.appendChild(nameField);
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
      '创建后仍可在形象详情里随时调整，并且是**按形象**记住的。',
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
        resizeObserver = new ResizeObserver(() => applyThumbGeometry());
        resizeObserver.observe(root);
      }
      // 首屏加载（不阻塞挂载，失败会显示为通知条）
      withBusy(refresh);
      return () => {
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = null;
      };
    },

    /** 表面已挂载时再次从入口进入（宿主不会重新 mount）。 */
    onOpen() {
      if (!root) return;
      // 每次打开都刷新一次：形象可能被别处改过
      withBusy(refresh);
    },

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
      root = null;
    },
  };
}
