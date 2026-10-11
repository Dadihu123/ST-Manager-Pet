/**
 * 确定性的帧推进器（**纯逻辑，不碰 DOM**）。
 *
 * 为什么不直接写 `setInterval` / 直接累加 `dt`：
 * - `setInterval` 在掉帧时会累积漂移（回调被推迟但计数照加）；
 * - 用可变 `dt` 直接推进帧号会让「同一个动作在快机与慢机上播得不一样」。
 *
 * 这里的做法是**时间累加 + 固定步长**：
 * 把流逝的时间累进 `accumulator`，只要够一帧的时长就推进一帧，
 * 不足的部分留到下次——因此掉帧时帧序不会漂移，只会跳帧（这是正确行为）。
 *
 * 时钟由调用方注入（`now` 参数），因此测试可以用确定性时钟断言，
 * 不必 `sleep` 后赌 `monotonic` 的精度（§1.4 的明确要求）。
 */

/** 单帧推进器的默认帧率上限（超过没有意义，只是白烧 CPU）。 */
export const MAX_FPS = 60;

/**
 * 帧推进状态机。
 *
 * `spec` 形如 `{ frames, fps, loop }`；`frames <= 1` 表示单帧（不推进）。
 */
export function createFrameClock(spec = {}) {
  let frames = Math.max(1, Math.floor(Number(spec.frames) || 1));
  let fps = Math.min(MAX_FPS, Math.max(1, Number(spec.fps) || 8));
  let loop = spec.loop !== false;

  let accumulator = 0;
  let index = 0;
  let finished = frames <= 1;

  return {
    get frames() { return frames; },
    get fps() { return fps; },
    get loop() { return loop; },
    get index() { return index; },
    get finished() { return finished; },
    /** 单帧时长（秒）。 */
    get frameDuration() { return 1 / fps; },

    /**
     * 换一个动作。
     *
     * `restart` 为真时从头播（切动作必须从头，否则「落地」会从上一动作的
     * 残帧开始，看起来很怪）；为假时保留当前进度（同一动作改 fps 时用）。
     */
    setSpec(next = {}, { restart = true } = {}) {
      const nextFrames = Math.max(1, Math.floor(Number(next.frames) || 1));
      const nextFps = Math.min(MAX_FPS, Math.max(1, Number(next.fps) || 8));
      const nextLoop = next.loop !== false;

      const changedAction = nextFrames !== frames || nextLoop !== loop;
      frames = nextFrames;
      fps = nextFps;
      loop = nextLoop;

      if (restart || changedAction) {
        accumulator = 0;
        index = 0;
        finished = frames <= 1;
      } else {
        // 帧数变少时把索引夹回范围内，避免指向不存在的帧
        if (index >= frames) index = frames - 1;
      }
      return this;
    },

    /**
     * 推进一步。返回本步**推进的帧数**（0 表示这一帧没到时间）。
     *
     * @param {number} dt 流逝秒数（调用方保证 >= 0）。
     */
    advance(dt) {
      if (frames <= 1) {
        accumulator = 0;
        finished = true;
        return 0;
      }
      if (!(dt > 0)) return 0;
      // 单次调用的 dt 上限：切后台回来时 dt 可能是几十秒，
      // 不能让它一次推进几百帧（那会瞬间跑完所有循环并看起来像"跳变"）。
      const clamped = Math.min(dt, 1);
      const duration = 1 / fps;
      accumulator += clamped;

      let steps = 0;
      while (accumulator >= duration) {
        accumulator -= duration;
        steps += 1;
        if (index + 1 >= frames) {
          if (loop) {
            index = 0;
          } else {
            index = frames - 1;
            finished = true;
            // 不循环的动作播完就把累积清零，避免下次 advance 反复触发
            accumulator = 0;
            break;
          }
        } else {
          index += 1;
        }
        // 一次调用最多推进一整轮，防止极端 dt 下的长循环
        if (steps >= frames) {
          accumulator = 0;
          break;
        }
      }
      return steps;
    },

    /** 显式复位（重新开始播当前动作）。 */
    reset() {
      accumulator = 0;
      index = 0;
      finished = frames <= 1;
      return this;
    },
  };
}

/**
 * 「何时真的需要画」的判定器。
 *
 * 一个 rAF 循环跑着不代表要一直干活：宠物完全静止、单帧、且没有待处理物理时，
 * 继续请求动画帧只是白烧电。这个判定器决定 rAF 循环**是否可以停下**。
 *
 * 注意：停下来之后必须有人**唤醒**它（`wake()`），否则宠物会永远卡住。
 * 唤醒源包括：指针交互、核心事件、宿主状态变化、resize。
 */
export function createIdleGate() {
  let idle = false;
  // 用计数而不是 Set：同名 hold 可能被多处同时持有（例如两个播报同时进行），
  // 用 Set 会让先释放的那个把另一个也一起取消掉。
  const reasons = new Map();

  return {
    get idle() { return idle; },
    /** 请求「保持运行」；返回取消函数（引用计数语义）。 */
    hold(reason) {
      const key = String(reason || 'anonymous');
      reasons.set(key, (reasons.get(key) || 0) + 1);
      idle = false;
      let released = false;
      return () => {
        // 幂等：重复调用同一个取消函数不该把计数压成负数
        if (released) return;
        released = true;
        const next = (reasons.get(key) || 0) - 1;
        if (next > 0) reasons.set(key, next);
        else reasons.delete(key);
      };
    },
    /** 当前是否有任何理由需要保持运行。 */
    get held() { return reasons.size > 0; },
    /** 由调用方在每帧末尾根据业务状态设置。 */
    setIdle(next) {
      // 有 hold 时不允许进入空闲（交互优先）
      idle = reasons.size > 0 ? false : Boolean(next);
      return idle;
    },
  };
}

/**
 * 把「省电条件」折算成一个**帧率倍率 / 是否停绘**的决策。
 *
 * 输入是宿主的 `onState()` 快照（§2.3）加上插件自己的判断（视口过小）。
 * 输出是一个结构化决策，便于单测（决策是纯函数，没有副作用）。
 *
 * 规则（§4.5 的表格，逐条落地）：
 * - `visible === false`（页面不可见）→ 停绘
 * - `reducedMotion === true` → **停绘**（不是降速——用户开这个是因为动效让他不适）
 * - `busy`（批处理/索引/扫描）→ 降频（1/4）
 * - `scrimActive` / `surfaceOpen`（遮罩 / 对话框）→ 降频（1/4）
 * - 视口过小 → 降频（1/2），但不隐藏（宠物仍在，只是安静）
 */
export function decideThrottle(state = {}, options = {}) {
  const narrowWidth = Number(options.narrowWidth) || 900;
  const viewportWidth = Number(options.viewportWidth) || 0;
  const narrow = viewportWidth > 0 && viewportWidth < narrowWidth;

  if (state.visible === false) {
    return { paused: true, rate: 0, reason: 'hidden' };
  }
  if (state.reducedMotion === true) {
    // 完全停止帧动画，只保留静态显示（§4.5 的硬要求）
    return { paused: true, rate: 0, reason: 'reduced-motion' };
  }
  if (state.busy === true) {
    return { paused: false, rate: 0.25, reason: 'busy' };
  }
  if (state.scrimActive === true || state.surfaceOpen === true) {
    return { paused: false, rate: 0.25, reason: 'occluded' };
  }
  if (narrow) {
    return { paused: false, rate: 0.5, reason: 'narrow' };
  }
  return { paused: false, rate: 1, reason: '' };
}
