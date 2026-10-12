/**
 * 指针手势判定（**纯逻辑，不碰 DOM**）：这一次到底是「点击」还是「拖拽」。
 *
 * 为什么需要它
 * ------------
 * 旧实现只看「松手时的位移」：位移小于 5px 算点击，否则算拖拽。
 * 问题是**按下的一瞬间就已经进了拖拽态**——宠物立刻变成「被抓起来」的样子，
 * 于是：
 *
 * - 用户想点一下（看它的反应），看到的是它被拎起来；
 * - 手稍微抖一下，松手时就变成一次「甩出去」，宠物飞了；
 * - `click` 动作几乎触发不到（除非用户点得极准且极稳）。
 *
 * 成熟做法是**按下后先观察一小段时间**（这里 0.5 秒）：
 *
 * - 在这段时间内松手，且位移很小 → **点击**；
 * - 按住超过这段时间 → **进入拖拽**；
 * - 无论多久，只要位移超过阈值 → 立刻进入拖拽
 *   （用户明确在拖了，不该再等 0.5 秒）。
 *
 * 因此「点击」和「拖拽」在**时间**与**距离**两个维度上被分开，
 * 而不是让拖拽抢走所有点击。
 *
 * 这个模块只做判定，不含计时器与 DOM：调用方（`petview.js`）按
 * `phase` 决定要不要真的开始拖，并在 `pointerup` 时读 `resolution`。
 */

/** 默认的长按阈值（毫秒）：按住这么久才算「要拖」。 */
export const DEFAULT_HOLD_MS = 500;

/** 默认的位移阈值（像素）：超过它就算拖，不必等长按。 */
export const DEFAULT_SLOP = 5;

/** 手势阶段。 */
export const GESTURE_PENDING = 'pending';
export const GESTURE_DRAG = 'drag';
export const GESTURE_DONE = 'done';

/**
 * 创建一个手势判定器。
 *
 * @param {object} [options]
 * @param {number} [options.holdMs] 长按阈值（毫秒）
 * @param {number} [options.slop] 位移阈值（像素）
 */
export function createGesture(options = {}) {
  const holdMs = Number(options.holdMs) > 0 ? Number(options.holdMs) : DEFAULT_HOLD_MS;
  const slop = Number(options.slop) > 0 ? Number(options.slop) : DEFAULT_SLOP;

  let phase = GESTURE_DONE;
  let startedAt = 0;
  let originX = 0;
  let originY = 0;
  let lastX = 0;
  let lastY = 0;
  let travelled = 0;
  /** 已经进入拖拽后就不再退回：用户已经在拖了，中途停手也只是「停着拖」。 */
  let committed = false;

  function reset() {
    phase = GESTURE_DONE;
    committed = false;
    travelled = 0;
  }

  return {
    get phase() { return phase; },
    get holdMs() { return holdMs; },
    get slop() { return slop; },
    /** 从按下到现在的最大位移（像素）。 */
    get travelled() { return travelled; },
    /** 是否已经真的进入拖拽态。 */
    get dragging() { return committed; },
    /** 按下后已经过了多久（毫秒）。 */
    elapsed(now) {
      if (phase === GESTURE_DONE) return 0;
      return Math.max(0, (Number(now) || 0) - startedAt);
    },

    /**
     * 按下。
     *
     * @param {number} x
     * @param {number} y
     * @param {number} now 时间戳（毫秒）
     * @returns {boolean} 是否**立刻**进入拖拽（本实现恒为 false——
     *   按下瞬间永远是「待定」，这正是「点击能单独触发」的前提）
     */
    begin(x, y, now) {
      phase = GESTURE_PENDING;
      committed = false;
      startedAt = Number(now) || 0;
      originX = Number(x) || 0;
      originY = Number(y) || 0;
      lastX = originX;
      lastY = originY;
      travelled = 0;
      return false;
    },

    /**
     * 移动。返回**本次是否刚刚**升级成拖拽（调用方据此开始拖）。
     *
     * 两种升级路径：
     * - 位移超过 `slop` → 立刻升级（用户明确在拖）；
     * - 已经按住超过 `holdMs` → 升级（长按即拖，不必真的移动）。
     *
     * @param {number} x
     * @param {number} y
     * @param {number} now
     * @returns {boolean}
     */
    move(x, y, now) {
      if (phase !== GESTURE_PENDING) return false;
      lastX = Number(x) || 0;
      lastY = Number(y) || 0;
      travelled = Math.max(travelled, Math.hypot(lastX - originX, lastY - originY));
      if (travelled > slop) return promote();
      if (this.elapsed(now) >= holdMs) return promote();
      return false;
    },

    /**
     * 时间推进（**没有指针移动**时也要调）。
     *
     * 为什么必须单独有这个入口：用户按住不动 0.5 秒就该进入拖拽，
     * 而「不动」意味着不会收到 `pointermove`。只靠移动事件判定的话，
     * 「按住不动」永远进不了拖拽态。
     *
     * @param {number} now
     * @returns {boolean} 是否刚刚升级成拖拽
     */
    tick(now) {
      if (phase !== GESTURE_PENDING) return false;
      if (this.elapsed(now) >= holdMs) return promote();
      return false;
    },

    /**
     * 松手。
     *
     * @param {number} x
     * @param {number} y
     * @returns {{kind: string, dragged: boolean, travelled: number, heldMs: number}}
     *   `kind` ∈ `{'click', 'drag'}`；`dragged` 表示**过程中**是否已经进过拖拽态。
     */
    end(x, y, now) {
      if (phase === GESTURE_DONE) {
        return { kind: 'click', dragged: false, travelled: 0, heldMs: 0 };
      }
      const px = Number(x);
      const py = Number(y);
      if (Number.isFinite(px) && Number.isFinite(py)) {
        lastX = px;
        lastY = py;
        travelled = Math.max(travelled, Math.hypot(lastX - originX, lastY - originY));
      }
      const heldMs = this.elapsed(now);
      const wasDragging = committed;
      // 判定规则与「升级」规则必须**对称**，否则会出现
      // 「看着像点击、结果被当成拖拽」这类前后不一致：
      // 只要过程中进过拖拽态，或最终位移超阈值，就是拖拽。
      const kind = (wasDragging || travelled > slop) ? 'drag' : 'click';
      // ⚠️ `travelled` 必须在 `reset()` **之前**取出来。
      // `reset()` 会把它清零，而在 `return` 的对象字面量里读闭包变量是在
      // `reset()` 之后求值的——那样回报的位移恒为 0（实测踩到过）。
      const distance = travelled;
      reset();
      return { kind, dragged: wasDragging, travelled: distance, heldMs };
    },

    /** 取消（`pointercancel` / 插件卸载）。 */
    cancel() {
      reset();
      return this;
    },
  };

  /** 升级为拖拽；已经是拖拽时返回 false（「刚刚」的语义）。 */
  function promote() {
    if (committed) return false;
    committed = true;
    phase = GESTURE_DRAG;
    return true;
  }
}
