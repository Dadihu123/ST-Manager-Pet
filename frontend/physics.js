/**
 * 宠物物理（**纯逻辑，不碰 DOM**）。
 *
 * 为什么用固定步长而不是可变 `dt`：
 * 直接 `x += v * dt` 会让表现依赖帧率——同样按住方向键，
 * 144Hz 的机器和 30Hz 的机器会走出不同的轨迹（摩擦与重力是非线性的，
 * 误差不会互相抵消，只会累积）。固定步长 + 累加器保证物理表现与帧率无关。
 *
 * 世界坐标就是**视口像素**（ambient 容器 `inset: 0`，§2.1），
 * 原点在左上角，y 向下为正。
 */

/** 固定物理步长（秒）。1/120 ≈ 8.3ms，比任何常见刷新率都细。 */
export const FIXED_STEP = 1 / 120;

/** 单次 `step()` 里最多补算的物理步数。 */
//: 掉帧/切后台回来时 `dt` 可能很大。不限步数会让一次调用补算上百步
//: （既卡顿又可能出现穿墙）。60 步 = 0.5 秒的物理时间，足够追上。
export const MAX_STEPS_PER_FRAME = 60;

/** 默认物理参数（与 `backend/core/pack.py` 的 `DEFAULT_PHYSICS` 必须一致）。 */
export const DEFAULT_PHYSICS = {
  gravity: 1800,
  walkSpeed: 60,
  //: **每秒速度保留比例**。越小「刹车」越快。
  //:
  //: 实施提示词 §3.2 的示例包写的是 `0.85`，但按「每秒保留」理解，
  //: 0.85 意味着一次甩出（约 2000px/s）要滑行 ~12 个屏幕宽度、
  //: 走停后还要滑 30 秒才归零——那不能算「松手有减速」，是失控。
  //: 因此这里取 0.02：走路停下约 0.4s，甩出后在 2s 内滑行约 500px。
  //: 语义已在 README 冻结。
  friction: 0.02,
  terminalVelocity: 2400,
  bounce: 0.15,
};

/**
 * 速度归零阈值。
 *
 * 按 `walkSpeed` 缩放：包可以声明任意 `walkSpeed`，用固定的 0.5px/s
 * 会让「慢速宠物」永远停不下来（指数衰减只是逼近 0，不会到达 0）。
 */
function velocityEpsilon(walkSpeed) {
  return Math.max(0.5, Number(walkSpeed) * 0.05);
}

/**
 * 创建一个宠物物理体。
 *
 * @param {object} options
 * @param {number} options.width  宠物包围盒宽（CSS px，已含缩放）
 * @param {number} options.height 宠物包围盒高
 * @param {object} options.bounds `{width, height}` 世界尺寸（视口）
 * @param {object} options.physics 物理参数（缺项用默认值）
 */
export function createPhysics(options = {}) {
  const bounds = {
    width: Math.max(1, Number(options.bounds?.width) || 1),
    height: Math.max(1, Number(options.bounds?.height) || 1),
  };
  const size = {
    width: Math.max(1, Number(options.width) || 64),
    height: Math.max(1, Number(options.height) || 64),
  };
  const params = Object.assign({}, DEFAULT_PHYSICS, options.physics || {});

  // 位置是**包围盒中心**的 x 与**脚底**的 y。
  // 脚底比中心好用：地面就是 y = bounds.height，不用再减半个身高。
  let x = Number(options.x) || 0;
  let y = Number(options.y) || 0;
  let vx = 0;
  let vy = 0;

  let accumulator = 0;
  let grounded = false;
  let dragging = false;
  let inputActive = false;
  /** 本步内是否发生过「刚触地」（用于触发 land 动作，一次性）。 */
  let justLanded = false;

  const halfWidth = () => size.width / 2;

  /** 把位置夹回世界内。宠物**不能跑到屏幕外**（阶段 3 验收项）。 */
  function clampX(value) {
    const half = halfWidth();
    // 视口比宠物还窄时，退化为「居中」而不是来回抖
    if (bounds.width <= size.width) return bounds.width / 2;
    return Math.min(Math.max(value, half), bounds.width - half);
  }

  function clampY(value) {
    return Math.min(Math.max(value, 0), bounds.height);
  }

  function step(dt) {
    if (dragging) {
      // 拖拽期间由指针事件直接写位置，物理不参与（否则会跟手失败）
      return;
    }
    justLanded = false;

    // 重力
    vy += params.gravity * dt;
    if (vy > params.terminalVelocity) vy = params.terminalVelocity;

    // 水平摩擦：只在**没有输入**时衰减。
    // 用「每步乘一个系数」而不是「每秒乘一次」保证与步长无关：
    // 每秒保留 friction ⇒ 每步保留 friction^dt。
    if (!inputActive) {
      const perStep = Math.pow(Math.max(0, Math.min(1, params.friction)), dt);
      vx *= perStep;
      // 指数衰减只会逼近 0，永远不会到达 0——必须显式归零，
      // 否则 `resting` 永远为假、rAF 永远停不下来（省电直接失效）。
      if (Math.abs(vx) < velocityEpsilon(params.walkSpeed)) vx = 0;
    }

    const wasGrounded = grounded;
    x = clampX(x + vx * dt);
    y = clampY(y + vy * dt);

    // ---- 触地处理 ----
    if (y >= bounds.height) {
      y = bounds.height;
      const impact = vy;
      if (impact > 0) {
        const bounceVy = params.bounce > 0 ? -impact * params.bounce : 0;
        // 只有「快得值得反弹」的一次性冲击才反弹；否则直接停下，
        // 不然宠物会在地上做无穷小的抖动（看起来像在发抖）
        if (Math.abs(bounceVy) > 60) {
          vy = bounceVy;
          grounded = false;
        } else {
          vy = 0;
          grounded = true;
        }
      } else {
        // 已经在地面上（vy <= 0），保持贴地
        vy = 0;
        grounded = true;
      }
      if (!wasGrounded && impactOccurred(impact)) justLanded = true;
    } else {
      grounded = false;
    }

    // 撞到侧壁就把水平速度吃掉（否则会贴着墙一直"跑"）
    if (x <= halfWidth() || x >= bounds.width - halfWidth()) {
      vx = 0;
    }
  }

  /** 只有真正有速度的落地才算「刚触地」，轻轻贴上去不算。 */
  function impactOccurred(impact) {
    return Number(impact) > 60;
  }

  return {
    get x() { return x; },
    get y() { return y; },
    get vx() { return vx; },
    get vy() { return vy; },
    get grounded() { return grounded; },
    get dragging() { return dragging; },
    get justLanded() { return justLanded; },
    get bounds() { return { width: bounds.width, height: bounds.height }; },
    get size() { return { width: size.width, height: size.height }; },
    get params() { return Object.assign({}, params); },

    /** 设置位置（立刻生效，用于初始化 / resize 后夹回）。 */
    setPosition(nextX, nextY) {
      x = clampX(nextX);
      y = clampY(nextY);
      return this;
    },

    /** 设置速度。 */
    setVelocity(nextVx, nextVy) {
      vx = Number(nextVx) || 0;
      vy = Number(nextVy) || 0;
      return this;
    },

    /** 世界尺寸变化（resize）。宠物被夹回可见区（阶段 3 验收项）。 */
    setBounds(next) {
      bounds.width = Math.max(1, Number(next?.width) || bounds.width);
      bounds.height = Math.max(1, Number(next?.height) || bounds.height);
      x = clampX(x);
      y = clampY(y);
      return this;
    },

    /** 宠物大小变化（用户改了 scale）。 */
    setSize(next) {
      size.width = Math.max(1, Number(next?.width) || size.width);
      size.height = Math.max(1, Number(next?.height) || size.height);
      x = clampX(x);
      return this;
    },

    /**
     * 开始拖拽。
     *
     * 任何状态都能被 drag 打断（§4.3 的硬要求）：这里顺手清掉速度，
     * 否则松手后会把拖拽前的惯性一起甩出去，手感很怪。
     */
    beginDrag(pointerX, pointerY) {
      dragging = true;
      inputActive = false;
      vx = 0;
      vy = 0;
      x = clampX(pointerX);
      y = clampY(pointerY);
      return this;
    },

    /** 拖拽中跟手（直接写位置，不走物理）。 */
    moveDrag(pointerX, pointerY) {
      if (!dragging) return this;
      x = clampX(pointerX);
      y = clampY(pointerY);
      return this;
    },

    /**
     * 结束拖拽并交回物理。
     *
     * `releaseVx/vy` 是「甩出去」的初速度（由调用方按最近的指针位移估算），
     * 让宠物有被扔出去的手感（§4.1）。
     */
    endDrag(releaseVx = 0, releaseVy = 0) {
      dragging = false;
      vx = Number(releaseVx) || 0;
      vy = Number(releaseVy) || 0;
      grounded = false;
      return this;
    },

    /** 主动给一个水平速度（漫游行走用）。 */
    walk(direction) {
      const sign = direction < 0 ? -1 : 1;
      vx = sign * params.walkSpeed;
      inputActive = true;
      return this;
    },

    /** 停止水平输入（摩擦会接手减速）。 */
    stopWalking() {
      inputActive = false;
      return this;
    },

    get walking() { return inputActive; },

    /**
     * 推进物理。用**累加器 + 固定步长**：无论 `dt` 多大或多小，
     * 走的都是同样大小的物理步，因此表现与帧率无关（§4.1 / §8 陷阱 10）。
     *
     * @returns {{steps: number, dx: number, dy: number}} 本帧实际走了几步与位移
     */
    advance(dt) {
      if (dragging) {
        accumulator = 0;
        return { steps: 0, dx: 0, dy: 0 };
      }
      const before = { x, y };
      const seconds = Number(dt);
      if (!(seconds > 0)) return { steps: 0, dx: 0, dy: 0 };

      // 单帧最多积累 MAX_STEPS_PER_FRAME 步的物理时间，多余的丢掉
      // （切后台回来的巨大 dt 不该让宠物瞬移）
      accumulator = Math.min(
        accumulator + seconds,
        FIXED_STEP * MAX_STEPS_PER_FRAME,
      );

      let steps = 0;
      while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
        step(FIXED_STEP);
        accumulator -= FIXED_STEP;
        steps += 1;
      }
      return { steps, dx: x - before.x, dy: y - before.y };
    },

    /** 是否已经完全静止（用于判定能不能停下 rAF）。 */
    get resting() {
      return grounded
        && !dragging
        && vx === 0
        && vy === 0
        && Math.abs(y - bounds.height) < 0.5;
    },
  };
}

/**
 * 从最近若干个指针采样估算「甩出去」的初速度。
 *
 * 只用最后 `windowMs` 毫秒内的位移：太老的采样会让「慢慢拖了很久然后松手」
 * 也变成一次大力抛出。
 */
export function estimateReleaseVelocity(samples, options = {}) {
  const windowMs = Number(options.windowMs) || 90;
  const maxSpeed = Number(options.maxSpeed) || 3000;
  const list = Array.isArray(samples) ? samples : [];
  if (list.length < 2) return { vx: 0, vy: 0 };

  const last = list[list.length - 1];
  // 找到窗口内最早的那个采样
  let first = list[0];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (last.t - list[index].t <= windowMs) first = list[index];
    else break;
  }

  const dt = (last.t - first.t) / 1000;
  if (!(dt > 0)) return { vx: 0, vy: 0 };

  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;

  // 夹到上限：一次猛甩不该让宠物以离谱的速度飞出去
  const speed = Math.hypot(vx, vy);
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    vx *= scale;
    vy *= scale;
  }
  return { vx, vy };
}
