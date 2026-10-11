/**
 * 宠物状态机（**纯逻辑，不碰 DOM**）。
 *
 * 状态与迁移（§4.3，README 里也要写同一份表）：
 *
 *     idle ⇄ walk（随机漫游 / 被指定移动）
 *     idle → drag → fall → land → idle
 *     idle → sleep（长时间无操作）→ idle（任何输入）
 *     任意 → happy/sad/angry（事件播报，播完回 idle）
 *
 * 两条硬要求：
 * 1. **任何状态都能被 drag 打断**——用户抓它时必须立刻响应；
 * 2. **sleep 期间收到核心事件要唤醒**——用户不会希望「因为宠物睡了所以没看到播报」。
 *
 * 非法迁移被**拒绝并记录**，而不是静默接受：状态机是后续 bug 的高发区，
 * 让它在测试里吵出来比在生产里悄悄错位要好。
 */

/** 状态枚举。 */
export const STATES = Object.freeze({
  IDLE: 'idle',
  WALK: 'walk',
  DRAG: 'drag',
  FALL: 'fall',
  LAND: 'land',
  SLEEP: 'sleep',
  /// 事件播报态：`happy` / `sad` / `angry` / `click`
  REACT: 'react',
});

/** 播报类动作（播完自动回 idle）。 */
export const REACT_ACTIONS = Object.freeze(['happy', 'sad', 'angry', 'click']);

/**
 * 合法的状态迁移表。
 *
 * 注意 `drag` 被允许从**任意**状态进入（硬要求 1），因此这里不逐个列出，
 * 而是在 `canTransition` 里特判。
 */
const TRANSITIONS = {
  [STATES.IDLE]: [STATES.WALK, STATES.DRAG, STATES.SLEEP, STATES.REACT, STATES.FALL],
  [STATES.WALK]: [STATES.IDLE, STATES.DRAG, STATES.SLEEP, STATES.REACT, STATES.FALL],
  [STATES.DRAG]: [STATES.FALL, STATES.IDLE, STATES.WALK],
  [STATES.FALL]: [STATES.LAND, STATES.IDLE, STATES.DRAG],
  [STATES.LAND]: [STATES.IDLE, STATES.WALK, STATES.DRAG],
  [STATES.SLEEP]: [STATES.IDLE, STATES.WALK, STATES.DRAG, STATES.REACT],
  [STATES.REACT]: [STATES.IDLE, STATES.WALK, STATES.SLEEP, STATES.DRAG, STATES.REACT],
};

export function canTransition(from, to) {
  const source = String(from || '');
  const target = String(to || '');
  if (!source || !target) return false;
  // 同态重入永远允许（例如连续两次播报）
  if (source === target) return true;
  // 硬要求 1：drag 可以从任何状态进入
  if (target === STATES.DRAG) return true;
  const allowed = TRANSITIONS[source];
  return Array.isArray(allowed) && allowed.includes(target);
}

/**
 * 创建状态机。
 *
 * @param {object} options
 * @param {string} options.initial 初始状态（默认 idle）
 * @param {function} options.onChange `(next, prev, meta)` 迁移钩子
 * @param {function} options.onReject `(from, to, reason)` 非法迁移钩子
 */
export function createStateMachine(options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const onReject = typeof options.onReject === 'function' ? options.onReject : null;

  let state = String(options.initial || STATES.IDLE);
  /** 当前状态是从什么时候开始的（毫秒时间戳，由调用方注入时钟）。 */
  let since = 0;
  let currentAction = 'idle';
  /** 播报类的排队：同一时刻只播一个，避免高频事件把状态切得乱七八糟。 */
  let pendingReaction = '';

  const history = [];

  function transition(to, meta = {}) {
    const target = String(to || '');
    if (!canTransition(state, target)) {
      safeHook(onReject, state, target, meta.reason || '');
      return false;
    }
    const previous = state;
    state = target;
    since = Number(meta.now) || since;
    history.push({ from: previous, to: target, at: since });
    if (history.length > 64) history.shift();
    safeHook(onChange, target, previous, meta);
    return true;
  }

  /**
   * 调用外部钩子，绝不让它的异常影响状态机。
   *
   * 实测踩过：`onChange` 里的一次 `TypeError`（插件调了一个不存在的宿主 API）
   * 顺着 `transition()` 抛回调用方，把**用户拖拽**整条路径打断——
   * `machine.beginDrag()` 抛错后，紧跟的 `physics.beginDrag()` 根本没执行，
   * 表现是「宠物拖不动」，而真正的原因在几百行之外的日志调用上。
   * 状态迁移本身是内部一致的操作，不能因为外部回调失败而中止。
   */
  function safeHook(hook, ...args) {
    if (typeof hook !== 'function') return;
    try {
      hook(...args);
    } catch (error) {
      // 用 console 而不是注入的 log：这里可能连 log 都是坏的
      try {
        // eslint-disable-next-line no-console
        console.warn('[pet] 状态机钩子抛错（已忽略）:', error);
      } catch {
        // 忽略：绝不再抛
      }
    }
  }

  return {
    get state() { return state; },
    get previous() {
      return history.length ? history[history.length - 1].from : '';
    },
    get since() { return since; },
    get action() { return currentAction; },
    get history() { return history.slice(); },
    get pendingReaction() { return pendingReaction; },

    /** 注入时钟（测试用确定性时钟，§1.4）。 */
    setNow(now) {
      since = Number(now) || 0;
      return this;
    },

    /** 当前状态持续了多久（毫秒）。 */
    elapsed(now) {
      return Math.max(0, (Number(now) || 0) - since);
    },

    /** 显式迁移（非法时返回 false 并触发 onReject）。 */
    go(to, meta) {
      return transition(to, meta);
    },

    /** 设置当前要播的动作名（与状态分离：`react` 态下动作名是 happy/sad/…）。 */
    setAction(action) {
      currentAction = String(action || 'idle');
      return this;
    },

    // ------------------------------------------------------------ 语义化入口

    /** 开始拖拽。硬要求 1：任何状态都能被打断。 */
    beginDrag(meta) {
      pendingReaction = '';
      currentAction = 'drag';
      return transition(STATES.DRAG, Object.assign({ reason: 'pointer-down' }, meta));
    },

    /** 松手 → 下落。 */
    release(meta) {
      currentAction = 'fall';
      return transition(STATES.FALL, Object.assign({ reason: 'pointer-up' }, meta));
    },

    /** 触地。 */
    land(meta) {
      currentAction = 'land';
      return transition(STATES.LAND, Object.assign({ reason: 'touch-ground' }, meta));
    },

    /** 落地动作播完 → 回 idle。 */
    settle(meta) {
      currentAction = 'idle';
      return transition(STATES.IDLE, Object.assign({ reason: 'settled' }, meta));
    },

    /** 开始水平移动。 */
    startWalk(meta) {
      currentAction = 'walk';
      return transition(STATES.WALK, Object.assign({ reason: 'walk' }, meta));
    },

    /** 停下。 */
    stopWalk(meta) {
      currentAction = 'idle';
      return transition(STATES.IDLE, Object.assign({ reason: 'stop' }, meta));
    },

    /** 入睡。 */
    sleep(meta) {
      currentAction = 'sleep';
      return transition(STATES.SLEEP, Object.assign({ reason: 'idle-timeout' }, meta));
    },

    /**
     * 唤醒。
     *
     * 硬要求 2 的另一半：sleep / 其它状态收到任何输入都要回到 idle。
     * 已经在 idle 时是幂等的（返回 true 但不产生迁移）。
     */
    wake(meta = {}) {
      if (state === STATES.SLEEP) {
        currentAction = 'idle';
        return transition(STATES.IDLE, Object.assign({ reason: 'wake' }, meta));
      }
      return true;
    },

    /**
     * 事件播报。
     *
     * 硬要求 2：**sleep 期间收到核心事件要唤醒**——因此这里先无条件唤醒，
     * 再进入播报态（播报完由调用方调 `settle()` 回 idle）。
     */
    react(action, meta = {}) {
      const name = String(action || 'happy');
      if (!REACT_ACTIONS.includes(name)) {
        if (onReject) onReject(state, STATES.REACT, `未知播报动作: ${name}`);
        return false;
      }
      // 唤醒优先于一切（哪怕当前已经在播放另一个播报）
      if (state === STATES.SLEEP) this.wake(meta);

      if (state === STATES.DRAG) {
        // 用户正抓着它——不要抢走拖拽态，记下来等松手后再播
        pendingReaction = name;
        return false;
      }
      currentAction = name;
      return transition(STATES.REACT, Object.assign({ reason: `react:${name}` }, meta));
    },

    /** 取出并清空「被拖拽推迟的播报」。 */
    takePendingReaction() {
      const value = pendingReaction;
      pendingReaction = '';
      return value;
    },

    /** 是否处于「需要持续动画」的状态（省电判定用）。 */
    get animating() {
      return state !== STATES.IDLE || currentAction !== 'idle';
    },

    /** 是否处于静止的默认态（可以停 rAF）。 */
    get dormant() {
      return state === STATES.IDLE && currentAction === 'idle';
    },
  };
}
