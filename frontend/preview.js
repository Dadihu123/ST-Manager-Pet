/**
 * 设置页的**动画播放器**（唯一碰 DOM 的地方之一是 panel，这是它的辅助模块）。
 *
 * 为什么需要它
 * ------------
 * 用户报障：「插件管理里看不到动画的效果，调角色时很不方便」。
 * 在这之前，面板里的动作格只有一张静态首帧图——想知道「这个动作动起来什么样」，
 * 只能切过去等它在桌面上真的触发一次（而 `click` / `land` 这类动作极难等到）。
 *
 * 因此这里做一个**真正的播放器**：按后端的帧参数（帧数 / 帧率 / 非均匀帧时长 /
 * 排布）逐帧推进 `background-position`，与桌面上宠物用的是**同一套规则**
 * （帧几何与 `petview.js` 一致），所以「预览里看到的」就是「桌面上会看到的」。
 *
 * 三条设计约束：
 *
 * 1. **内置形象也要能播**。只读限制的是「改图」，不是「看效果」——
 *    预览器对所有形象一视同仁。
 * 2. **不进宿主的焦点陷阱**。播放器只是几个按钮，没有 `<input>`；
 *    modal 的焦点循环因此不受影响。
 * 3. **必须能停**。面板关闭 / 切换形象 / 卸载时都要 `stop()`，
 *    否则会留下一个仍在跑 rAF 的定时器（§2.9 的清理纪律）。
 */

/** 播放器的帧推进上限（与 `clock.js:MAX_FPS` 一致）。 */
const MAX_FPS = 60;

/** 单帧停留时间的下限（毫秒），与 `clock.js:MIN_FRAME_MS` 一致。 */
const MIN_FRAME_MS = 1000 / MAX_FPS;

/**
 * 从后端给的变体信息里算出**每帧的毫秒数**。
 *
 * 优先用非均匀时长 `frameMs`（它才是作者真正想要的节奏），
 * 缺失或长度不符时退回均匀的 `1000 / fps`。
 *
 * @param {object} variant `{frames, fps, frameMs}`
 * @returns {number[]} 每帧毫秒数；至少一项
 */
export function frameDurations(variant) {
  const source = variant || {};
  const frames = Math.max(1, Math.floor(Number(source.frames) || 1));
  const raw = Array.isArray(source.frameMs) ? source.frameMs : null;
  if (raw && raw.length === frames) {
    const durations = [];
    let valid = true;
    for (const item of raw) {
      const value = Number(item);
      if (!Number.isFinite(value) || value <= 0) { valid = false; break; }
      durations.push(Math.max(MIN_FRAME_MS, value));
    }
    if (valid) return durations;
  }
  const fps = Math.min(MAX_FPS, Math.max(1, Number(source.fps) || 8));
  return new Array(frames).fill(1000 / fps);
}

/** 一轮播放的总时长（毫秒）。 */
export function totalDuration(variant) {
  return frameDurations(variant).reduce((sum, value) => sum + value, 0);
}

/**
 * 把「只显示某一帧」的几何写进预览框。
 *
 * 三条规则，缺一不可：
 *
 * 1. **按单帧的真实宽高比等比缩放**（`contain` 语义），绝不拉伸。
 * 2. **底边对齐**、水平居中。
 * 3. 画面**只能露出一帧**——邻帧不能从留白里漏出来（见下面 `layer` 的说明）。
 *
 * 为什么必须这样（用户报障「看起来会很奇怪，点名小卡的睡觉动作」）：
 * 旧实现把「单帧宽 = 框宽 × 帧数」写死，也就是**强行把一帧拉到框宽**。
 * 站立动作是 2:3 竖构图，恰好与旧框（112×168）同比例，所以看不出问题；
 * 而小卡的睡觉是躺姿、横构图（627×353），被强行拉进竖框之后人物被压扁，
 * 看起来像被踩过——这正是用户看到的那一幕。
 *
 * 底边对齐而不是垂直居中：宠物站在地面上，「脚底」是所有动作共有的参照线。
 * 垂直居中会让横躺的睡觉动作浮在半空、与站立的动作对不齐，
 * 切换动作时画面上下跳。用户明确要求「预览动画底部和预览框对齐」。
 *
 * ⚠️ **为什么需要 `layer`（内层元素）**：
 * 按比例装入之后必然有留白（横构图左右留、竖构图上下留），而
 * `background-image` 是**按整条 spritesheet 铺**的——留白处露出来的正是
 * **相邻的帧**。实测能看到：睡觉的预览框左边缘飘着一个「z」、右边缘
 * 挂着半个人影（都是隔壁帧的内容）。这比原来的「压扁」更怪。
 *
 * 单个元素解决不了：`background-clip` 裁不了「背景里的某一块」，
 * 而 `mask` / `clip-path` 会连**边框**一起裁掉（框就残缺了）。
 * 因此结构改成「外框 + 内层」：内层就是**一帧的大小**，
 * 背景被它自己的盒子裁住，邻帧物理上不可能漏出来。
 *
 * @param {HTMLElement} box 外框（固定正方形，负责边框与留白）
 * @param {number} frames 帧数
 * @param {string} layout `horizontal` / `vertical`
 * @param {number} index 要显示的帧号
 * @param {object} [size] 单帧原始尺寸 `{w, h}`；缺省时退回「按框的形状铺满」
 *   （老后端不下发尺寸，此时行为与从前一致，不会更差）
 * @param {HTMLElement} [layer] 真正承载背景图的内层元素。**强烈建议传**：
 *   不传就退回「在 `box` 上直接铺」，那样留白处会露出邻帧。
 */
export function applyFrameGeometry(box, frames, layout, index, size, layer) {
  if (!box) return;
  const target = layer || box;
  const count = Math.max(1, Math.floor(Number(frames) || 1));
  const at = Math.min(Math.max(0, Math.floor(Number(index) || 0)), count - 1);
  const boxWidth = box.clientWidth || 64;
  const boxHeight = box.clientHeight || 64;

  const frameWidth = Number(size && size.w) || 0;
  const frameHeight = Number(size && size.h) || 0;
  const known = frameWidth > 0 && frameHeight > 0;

  // 等比缩放到框内（`contain`）。尺寸未知时退回「按框铺满」，
  // 即旧的 1:1 映射——宁可不知道比例，也不要把图缩成一个点。
  const fit = known
    ? Math.min(boxWidth / frameWidth, boxHeight / frameHeight)
    : 1;
  const shownWidth = known ? frameWidth * fit : boxWidth;
  const shownHeight = known ? frameHeight * fit : boxHeight;

  // 一整条 spritesheet 的显示尺寸
  const sheetWidth = layout === 'vertical' ? shownWidth : shownWidth * count;
  const sheetHeight = layout === 'vertical' ? shownHeight * count : shownHeight;

  if (target !== box) {
    // 内层 = **一帧**的大小。背景铺的是整条 sheet，但只在这个盒子里可见，
    // 因此留白处是外框自己的底色，邻帧漏不出来。
    target.style.width = `${shownWidth}px`;
    target.style.height = `${shownHeight}px`;
    // 在框内摆位：水平居中 + 底边对齐
    target.style.left = `${(boxWidth - shownWidth) / 2}px`;
    target.style.top = `${boxHeight - shownHeight}px`;
  }

  target.style.backgroundSize = `${sheetWidth}px ${sheetHeight}px`;

  // 在内层（一帧的窗口）里把第 `at` 帧挪到窗口位置。
  // 这里**不需要**再加居中/贴底的偏移——那是外框摆内层的事，
  // 混在一起会让两个方向的偏移互相污染。
  target.style.backgroundPosition = layout === 'vertical'
    ? `0px ${-at * shownHeight}px`
    : `${-at * shownWidth}px 0px`;
}

/**
 * 创建一个播放器。
 *
 * @param {object} options
 * @param {HTMLElement} options.box 预览框（固定正方形，负责边框与留白）
 * @param {number} [options.speed] 速度倍率（越大越慢），与桌面宠物的语义一致
 * @param {function} [options.onFrame] `(index, frames)` 每帧回调（显示「第 n / N 帧」）
 * @param {function} [options.onEnd] 非循环动画播完时回调
 */
export function createAnimationPlayer(options = {}) {
  const box = options.box;
  // 内层：真正承载背景图的那一层（见 `applyFrameGeometry` 里对邻帧泄漏的说明）。
  // 由播放器自己创建，调用方不必知道这个结构——它只是「让一帧被裁住」的手段。
  const layer = box ? document.createElement('div') : null;
  if (layer) {
    layer.className = 'pet-preview-frame-layer';
    box.appendChild(layer);
  }
  let speed = Number(options.speed) > 0 ? Number(options.speed) : 1;
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
  const onEnd = typeof options.onEnd === 'function' ? options.onEnd : null;

  let variant = null;
  let durations = [];
  let frames = 1;
  let index = 0;
  let loop = true;
  let timer = 0;
  let playing = false;

  function emit() {
    if (onFrame) onFrame(index, frames);
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  /** 排下一帧。用 `setTimeout`（每帧的时长可以不同，`setInterval` 表达不了）。 */
  function schedule() {
    clearTimer();
    if (!playing) return;
    const wait = Math.max(16, Math.round(durations[index] / speed));
    timer = setTimeout(() => {
      timer = 0;
      if (!playing) return;
      if (index + 1 >= frames) {
        if (loop) {
          index = 0;
        } else {
          playing = false;
          draw();
          emit();
          if (onEnd) onEnd();
          return;
        }
      } else {
        index += 1;
      }
      draw();
      emit();
      schedule();
    }, wait);
  }

  function draw() {
    applyFrameGeometry(
      box,
      frames,
      variant ? variant.layout : 'horizontal',
      index,
      variant ? variant.size : null,
      layer,
    );
  }

  return {
    /** 当前显示的帧号与总帧数。 */
    get frame() { return index; },
    get frames() { return frames; },
    get playing() { return playing; },
    get speed() { return speed; },

    setSpeed(next) {
      const value = Number(next);
      speed = Number.isFinite(value) && value > 0 ? value : 1;
      // 正在播就按新速度重排下一帧（否则要等当前这帧走完才生效）
      if (playing) schedule();
      return this;
    },

    /**
     * 载入一套动画。
     *
     * @param {object} spec `{url, frames, fps, loop, layout, frameMs}`
     * @param {object} [opts] `{autoplay, restart}`
     */
    load(spec, opts = {}) {
      const source = spec || {};
      this.stop();
      variant = source;
      frames = Math.max(1, Math.floor(Number(source.frames) || 1));
      durations = frameDurations(source);
      loop = source.loop !== false;
      index = 0;
      if (layer) {
        // 背景图挂在**内层**（外框只负责边框与留白）
        layer.style.backgroundImage = source.url ? `url("${source.url}")` : 'none';
        layer.style.backgroundRepeat = 'no-repeat';
      } else if (box) {
        box.style.backgroundImage = source.url ? `url("${source.url}")` : 'none';
        box.style.backgroundRepeat = 'no-repeat';
      }
      draw();
      emit();
      if (opts.autoplay !== false) this.play();
      return this;
    },

    /** 从头播。 */
    play() {
      if (!variant || frames <= 1) {
        // 单帧：没有可播的，直接算「播完」
        draw();
        emit();
        if (onEnd) onEnd();
        return this;
      }
      playing = true;
      index = 0;
      draw();
      emit();
      schedule();
      return this;
    },

    /** 停（保留当前帧）。 */
    stop() {
      playing = false;
      clearTimer();
      return this;
    },

    /** 回到第 0 帧并停。 */
    reset() {
      this.stop();
      index = 0;
      draw();
      emit();
      return this;
    },

    /** 只显示某一帧（拖动帧滑块时用）。 */
    seek(at) {
      this.stop();
      index = Math.min(Math.max(0, Math.floor(Number(at) || 0)), frames - 1);
      draw();
      emit();
      return this;
    },

    dispose() {
      this.stop();
      variant = null;
      // 内层是自己造的，得自己摘掉——否则每次重渲染都会在框里堆一层
      // （面板 `render()` 会重建 DOM，但 `dispose()` 也可能被单独调用）
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      return this;
    },
  };
}
