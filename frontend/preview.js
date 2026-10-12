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
 * 把「只显示某一帧」的几何写进一个预览框。
 *
 * 与 `panel.js:applyThumbGeometry` 是同一套规则，但**必须**按单帧的
 * 原始宽高比来放大：预览框是固定尺寸的方框，而 spritesheet 是
 * `帧数 × 单帧`，所以「整条宽度 = 方框宽 × 帧数」只有在单帧与方框同宽高比时
 * 才刚好填满。这里统一用 `background-size: (框宽 × 帧数) auto` 并左对齐，
 * 高度方向可能略有余量（方框会 `contain` 住），视觉上仍然只看到一帧。
 *
 * @param {HTMLElement} box 预览框
 * @param {number} frames 帧数
 * @param {string} layout `horizontal` / `vertical`
 * @param {number} index 要显示的帧号
 */
export function applyFrameGeometry(box, frames, layout, index) {
  if (!box) return;
  const count = Math.max(1, Math.floor(Number(frames) || 1));
  const at = Math.min(Math.max(0, Math.floor(Number(index) || 0)), count - 1);
  const width = box.clientWidth || 64;
  const height = box.clientHeight || 64;
  if (count <= 1) {
    box.style.backgroundSize = 'contain';
    box.style.backgroundPosition = 'center';
    return;
  }
  if (layout === 'vertical') {
    box.style.backgroundSize = `auto ${height * count}px`;
    box.style.backgroundPosition = `center ${-at * height}px`;
  } else {
    box.style.backgroundSize = `${width * count}px auto`;
    box.style.backgroundPosition = `${-at * width}px top`;
  }
}

/**
 * 创建一个播放器。
 *
 * @param {object} options
 * @param {HTMLElement} options.box 预览框（背景图 + 帧位移都在它身上）
 * @param {number} [options.speed] 速度倍率（越大越慢），与桌面宠物的语义一致
 * @param {function} [options.onFrame] `(index, frames)` 每帧回调（显示「第 n / N 帧」）
 * @param {function} [options.onEnd] 非循环动画播完时回调
 */
export function createAnimationPlayer(options = {}) {
  const box = options.box;
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
    applyFrameGeometry(box, frames, variant ? variant.layout : 'horizontal', index);
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
      if (box) {
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
      return this;
    },
  };
}
