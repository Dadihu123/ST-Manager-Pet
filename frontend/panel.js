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
  walk: '行走',
  drag: '被拖动',
  fall: '下落',
  land: '落地',
  sleep: '睡觉',
  click: '被点击',
  happy: '开心',
  sad: '难过',
  angry: '生气',
  look: '张望',
};

const REQUIRED_ACTIONS = ['idle', 'walk', 'drag', 'fall'];

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
    toolbar.appendChild(button('导入形象包', 'is-primary', () => {
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

    // ---- 右栏：选中形象的详情
    body.appendChild(renderDetail());
    root.appendChild(body);

    // 缩略图几何依赖「帧数」，而帧数在 `detail` 里 —— 必须在 DOM 挂上、
    // 且 `detail` 已就绪之后再算（`clientWidth` 也只有挂上才有值）。
    applyThumbGeometry();
  }

  function renderPetCard(pet) {
    const card = el('button', 'pet-card');
    card.type = 'button';
    card.dataset.marqueeIgnore = 'true';
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
    // **整条水平 spritesheet**（默认小猫是 256×64 = 4 帧），
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
    header.appendChild(title);

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
    const isBuiltin = (pets.find((item) => item.id === selectedId) || {}).source === 'builtin';
    if (!isBuiltin) {
      actions.appendChild(button('删除', 'is-danger', () => deletePet(selectedId)));
    } else {
      actions.appendChild(el('span', 'pet-card-meta', '内置形象不可删除'));
    }
    header.appendChild(actions);
    wrap.appendChild(header);

    // ---- 动作网格
    const section = el('div', 'pet-section');
    section.appendChild(el('div', 'pet-section-title', '动作'));
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '点每个动作的「换图」可单独替换该动作（不改动形象包本身）；'
      + '「恢复」会回到包内的原图。',
    ));

    const grid = el('div', 'pet-action-grid');
    for (const entry of detail.actions || []) {
      grid.appendChild(renderActionTile(entry));
    }
    section.appendChild(grid);
    wrap.appendChild(section);

    return wrap;
  }

  function renderActionTile(entry) {
    const tile = el('div', 'pet-action-tile');
    const required = REQUIRED_ACTIONS.includes(entry.action);
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
    row.appendChild(button('换图', 'is-icon', () => {
      pickFile({ accept: 'image/*', onPicked: (file) => uploadActionImage(entry.action, file) });
    }));
    if (entry.overridden) {
      row.appendChild(button('恢复', 'is-icon', () => clearActionImage(entry.action)));
    }
    tile.appendChild(row);
    return tile;
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
