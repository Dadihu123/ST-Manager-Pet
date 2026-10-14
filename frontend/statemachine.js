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
 *
 * ⚠️ `fall` 的出口只有 `land` 与 `drag`，**没有** `idle`。
 *
 * 这里曾经写着 `[LAND, IDLE, DRAG]`，而那个 `IDLE` 正是用户报的
 * 「在空中播放别的动画」的入口：坠落期间任何**过期的定时器**
 * （上一次播报的收尾、待机的随机触发、漫游倒计时）只要调到 `settle()`，
 * 就能把宠物从 `fall` 直接拽进 `idle`——于是它在半空中播起了待机动画，
 * 接着还能从 `idle` 走去 `walk` / `sleep`，看起来就是「空中好几个动画轮流播」。
 *
 * 移除它之后，那条路径变成一次**被拒绝并记录**的非法迁移（`onReject`），
 * 而回到地面的唯一出口是 `land`——这正是物理上的事实。
 */
const TRANSITIONS = {
  [STATES.IDLE]: [STATES.WALK, STATES.DRAG, STATES.SLEEP, STATES.REACT, STATES.FALL],
  [STATES.WALK]: [STATES.IDLE, STATES.DRAG, STATES.SLEEP, STATES.REACT, STATES.FALL],
  [STATES.DRAG]: [STATES.FALL, STATES.IDLE, STATES.WALK],
  [STATES.FALL]: [STATES.LAND, STATES.DRAG],
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
   * 语义化入口的公共实现：**先确认迁移合法，再写动作名**。
   *
   * @param {string} target 目标状态
   * @param {string} action 目标状态下要播的动作名
   * @param {string} reason 记进 `onReject` / `onChange` 的原因
   * @param {object} meta 调用方给的附加信息（含 `now`）
   * @returns {boolean} 迁移是否真的发生
   */
  function enter(target, action, reason, meta) {
    // 同态重入（`canTransition` 对 from === to 恒为真）同样要更新动作名：
    // `react` 态下连续两次播报就是靠它换的动作。
    if (!canTransition(state, target)) {
      safeHook(onReject, state, target, reason);
      return false;
    }
    currentAction = action;
    return transition(target, Object.assign({ reason }, meta));
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

    // 下面这些入口都走 `enter()`：**先确认迁移合法，再写动作名**。
    //
    // 为什么不用「先写 currentAction、再 transition」那种顺序（旧写法）：
    // 迁移被拒绝时动作名照样被改掉了，于是 `machine.state` 与
    // `machine.action` 脱节——状态还停在 `fall`，动作名已经是 `idle`。
    // 读取 `machine.action` 的地方（`dormant` / `animating` / 面板诊断）
    // 就会得到一份自相矛盾的答案，而症状离原因非常远。
    // 用户报的「空中播放别的动画」里就有一条是这个脱节造成的。

    /** 开始拖拽。硬要求 1：任何状态都能被打断。 */
    beginDrag(meta) {
      pendingReaction = '';
      return enter(STATES.DRAG, 'drag', 'pointer-down', meta);
    },

    /** 松手 → 下落。 */
    release(meta) {
      return enter(STATES.FALL, 'fall', 'pointer-up', meta);
    },

    /** 触地。 */
    land(meta) {
      return enter(STATES.LAND, 'land', 'touch-ground', meta);
    },

    /** 落地动作播完 → 回 idle。 */
    settle(meta) {
      return enter(STATES.IDLE, 'idle', 'settled', meta);
    },

    /** 开始水平移动。 */
    startWalk(meta) {
      return enter(STATES.WALK, 'walk', 'walk', meta);
    },

    /** 停下。 */
    stopWalk(meta) {
      return enter(STATES.IDLE, 'idle', 'stop', meta);
    },

    /** 入睡。 */
    sleep(meta) {
      return enter(STATES.SLEEP, 'sleep', 'idle-timeout', meta);
    },

    /**
     * 唤醒。
     *
     * 硬要求 2 的另一半：sleep / 其它状态收到任何输入都要回到 idle。
     * 已经在 idle 时是幂等的（返回 true 但不产生迁移）。
     */
    wake(meta = {}) {
      if (state === STATES.SLEEP) {
        return enter(STATES.IDLE, 'idle', 'wake', meta);
      }
      return true;
    },

    /**
     * 事件播报。
     *
     * 硬要求 2：**sleep 期间收到核心事件要唤醒**——因此这里先无条件唤醒，
     * 再进入播报态（播报完由调用方调 `settle()` 回 idle）。
     *
     * 两个「不能抢」的状态：
     *
     * - `drag`：用户正抓着它，记下来等松手后再播；
     * - `fall`：它还在空中。用户报的「空中播放别的动画」里，这一条也是来源之一
     *   ——旧实现在 `fall` 期间会把 `currentAction` 改成 `happy`，虽然迁移被
     *   拒绝（状态仍是 `fall`），但**动作名已经变了**，`machine.action`
     *   与 `machine.state` 就此脱节。等它落地时，`applyActionForState()`
     *   会看到一份自相矛盾的状态，播出来的东西不可预测。
     *   现在与 `drag` 同等对待：排队，落地之后立刻播。
     */
    react(action, meta = {}) {
      const name = String(action || 'happy');
      if (!REACT_ACTIONS.includes(name)) {
        if (onReject) onReject(state, STATES.REACT, `未知播报动作: ${name}`);
        return false;
      }
      // 唤醒优先于一切（哪怕当前已经在播放另一个播报）
      if (state === STATES.SLEEP) this.wake(meta);

      if (state === STATES.DRAG || state === STATES.FALL) {
        // 不要抢走拖拽 / 下落的态，记下来等它回到地面之后再播
        pendingReaction = name;
        return false;
      }
      // 先确认迁移合法，**再**写动作名。
      //
      // 顺序反了（旧写法）会让 `currentAction` 在迁移被拒绝时也照样被改写，
      // 于是「状态没变、动作名变了」——这种脱节在 `land` / `sleep` 这类
      // 依赖 `machine.action` 的地方会表现出完全无关的症状。
      if (!canTransition(state, STATES.REACT)) {
        safeHook(onReject, state, STATES.REACT, `react:${name}`);
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
