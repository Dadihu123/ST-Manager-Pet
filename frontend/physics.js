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
  /** 本步内是否发生过「砸下来」（**重**触地，一次性）。 */
  let justLanded = false;
  /**
   * 本步内是否发生过「离地 → 触地**并停稳**」的状态翻转（一次性）。
   *
   * 三个标记回答三个不同的问题（见 `footContact` 的说明）：
   *
   * - `justLanded` 回答「砸得够不够重」——**动画选择**的依据，
   *   轻贴地面不该播「落地」那一套（会像在发抖）。
   * - `touchedDown` 回答「它回到地面**并待住了**吗」。
   * - `footContact` 回答「脚底什么时候**第一次**碰到地面」——**状态迁移**的依据。
   *
   * ⚠️ 别拿 `touchedDown` 判落地：反弹会把 `grounded` 重新置假，它要等到
   * 弹完停稳才置位，实测晚 108~225ms，那段时间宠物贴着地面却还在播坠落动画。
   * 也别拿 `justLanded`：轻放时冲击不足 60px/s 永远为假，状态机会卡在 `fall`。
   */
  let touchedDown = false;
  /**
   * 本步内脚底是否**第一次碰到地面**（一次性，含随后还要反弹的那一下）。
   *
   * 第三个标记，因为它回答第三个问题：**动画什么时候该换成「落地」**。
   *
   * `touchedDown` 回答不了它：那个语义是「回到地面**并待住了**」，而落地反弹
   * 会把 `grounded` 重新置假，于是它要等到**弹完停稳**才置位。实测默认
   * `bounce: 0.12` 下这段延迟是 **108~225ms**（落差越大越久），
   * 而这段时间宠物已经贴着地面（离地最多 10.7px）却还在播 `fall`——
   * 用户报的就是这个：「人物现在坠落的姿态接触到地面后……会有那么很短
   * 的一段时间人物贴着地面但是处于坠落动画，因为时间有个几百 ms，
   * 因此肉眼可见」。
   *
   * 因此状态迁移改用这个标记：脚底碰到地面**那一刻**就切 `land`，
   * 后续的反弹让它在播落地动画的过程中自己弹完（那点余震正好被
   * 「屈膝缓冲」那一帧吃掉，比悬在半空播坠落要自然得多）。
   *
   * ⚠️ 不能拿 `justLanded` 顶替：那个要求冲击 > 60px/s（它是「砸得重不重」），
   * 从很低的地方放下时永远为假——那样状态机会卡在 `fall` 里出不来
   * （`touchedDown` 就是为修这个才出现的）。
   */
  let footContact = false;

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
      // ★ 脚底**碰到地面那一刻**就置位——在决定反不反弹**之前**。
      //
      // 顺序很要紧：反弹会把 `grounded` 重新置假，若放在判断之后
      // （像 `touchedDown` 那样），就要等到弹完停稳才为真，
      // 于是宠物贴在地面上空 10px 播 200ms 坠落动画（见 `footContact` 的说明）。
      if (!wasGrounded) footContact = true;
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
      // 只在**真的落到地面**（而不是弹回去的那一下）时置位。
      //
      // 反弹时 `grounded` 仍为假——宠物确实还在空中，因此不算「回来了」。
      // 若在这里无条件置位，宠物会在弹起的那一瞬间被判成落地，
      // 于是「落地动作 + 空中继续上抛」同时发生，看起来又是一次空中串动作。
      if (!wasGrounded && grounded) touchedDown = true;
      // 「砸得够不够重」是**动画选择**的依据（轻贴地面不播落地那套）
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
    /**
     * 本步内是否刚从**空中回到地面**（一次性，含轻贴地面）。
     *
     * 与 `justLanded` 的区别见文件内 `touchedDown` 的说明：
     * 这个是**状态迁移**的依据（`fall` → `land`），那个是**动画选择**的依据。
     */
    get touchedDown() { return touchedDown; },
    /**
     * 本步内脚底是否**第一次碰到地面**（一次性，含随后还要反弹的那一下）。
     *
     * 它是**状态迁移**（`fall` → `land`）的依据——比 `touchedDown` 更早，
     * 因为落地反弹会让 `touchedDown` 等到弹完停稳。三个标记的分工见文件内
     * `footContact` / `touchedDown` / `justLanded` 的说明。
     */
    get footContact() { return footContact; },
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
     * 一次性标记（`justLanded` / `touchedDown` / `footContact`）在**每次
     * `advance()` 开头**清掉，而不是在每个内部 `step()` 开头清。
     *
     * 为什么：一帧内可能补算**多步**（累加器，最多 `MAX_STEPS_PER_FRAME` 步）。
     * 放在 `step()` 里清的话，只有**最后一步**的结论能被调用方看到——
     * 落地恰好发生在倒数第二步时，标记会被最后一步擦掉，
     * 表现为「这次落地莫名其妙没触发落地动作」（时有时无，极难复现）。
     *
     * @returns {{steps: number, dx: number, dy: number}} 本帧实际走了几步与位移
     */
    advance(dt) {
      // 本帧的一次性标记先清空，再让内部各步去置位（见上）。
      //
      // ⚠️ 必须在 `dragging` 分支**之前**清：拖拽期间 `step()` 根本不会跑，
      // 若这时不清，上一次自由下落留下的 `touchedDown` 会一直为真——
      // 于是用户刚把宠物抓起来（`drag` 态）就会被判成「落地」，
      // 它在手里播起了落地动画。
      justLanded = false;
      touchedDown = false;
      footContact = false;

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
