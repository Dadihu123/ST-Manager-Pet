/**
 * 宠物视图：把纯逻辑层（时钟 / 物理 / 状态机 / 动画 / 手势）接到真实 DOM 上。
 *
 * 这是**唯一**碰 DOM 的模块。所有判定（该不该降频、能不能停 rAF、
 * 状态迁移是否合法、这次算点击还是拖拽、这次播哪一套动画）都在纯逻辑层做，
 * 这里只负责：
 * 1. 建元素、按帧写 `transform` / `background-position`；
 * 2. 把宿主事件翻译成逻辑层的调用；
 * 3. 一个 rAF 循环驱动一切（§4.2），并在该停的时候**真的停**。
 *
 * 关键约束（§2.1 / §0 判定标准）：
 * - **不自绘 `position: fixed` 浮层**——容器由宿主的 ambient surface 提供；
 * - 宠物元素用 `position: absolute` + `transform: translate3d()` 定位；
 * - 容器整体 `pointer-events: none`，宠物自己必须显式取回 `auto`。
 */

import {
  animationDuration,
  createBehaviorScheduler,
  frameGrid,
  framePage,
  framePageCount,
  frameSizeOf,
  motionBlinks,
  motionBreathes,
  pickBlinkDelay,
  playableVariants,
  pickVariantIndex,
  stillFrame,
} from './animation.js';
import { createFrameClock, createIdleGate, decideThrottle } from './clock.js';
import {
  mirrorForNonWalkAction,
  resolveWalkVisual,
  walkActionFor,
} from './direction.js';
import { createGesture, DEFAULT_HOLD_MS, DEFAULT_SLOP } from './gesture.js';
import { createPhysics, estimateReleaseVelocity } from './physics.js';
import { createStateMachine, STATES } from './statemachine.js';

/** 指针采样窗口（毫秒），用于估算甩出速度。 */
const POINTER_SAMPLE_WINDOW = 120;

/**
 * 漫游目标两侧留出的余量（像素）。
 *
 * 目标压在墙上时宠物会走到夹取边界就停住，而 `|x - walkTargetX| < 6`
 * 这个退出条件可能因浮点误差永远差一点点。
 */
const WALK_TARGET_MARGIN = 8;

/**
 * 判定「走不动了」的水平速度阈值（像素/秒）。
 *
 * 正常走路时 `vx` 是 `physics.walkSpeed`（默认 60），
 * 只有被侧壁拦住时物理层才会把它清零，因此这个阈值取得很小。
 */
const WALK_STALL_SPEED = 0.5;

/** 大小倍率的合法区间（与 `backend/core/pack.py:SCALE_RANGE` 必须一致）。 */
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;

/**
 * 动画速度倍率的合法区间（与 `manifest.json` 的 `anim_speed` 一致）。
 *
 * 用户反馈「很多动作默认太快、看起来很奇怪」，而「多快算合适」因人而异
 * （屏幕大小、形象风格、个人喜好都影响），因此开放成一个倍率：
 * 数值越大越**慢**（`2` = 播放时间翻倍）。
 */
const ANIM_SPEED_MIN = 0.25;
const ANIM_SPEED_MAX = 4;

/**
 * 右键菜单打开期间 / 宿主弹层打开时把动画放慢的倍率。
 *
 * 用户实测反馈：「右键打开插件菜单后背景中的动画会变慢，效果反而看起来还可以」。
 * 那其实是 `decideThrottle` 的降频（`rate 0.25`）顺带把帧推进也拖慢了。
 * 这里把它**变成有意为之的行为**：宿主忙 / 弹层打开时额外放慢，
 * 让宠物安静下来（既不抢注意力，观感也更从容）。
 */
const OCCLUDED_SPEED_FACTOR = 2;

/** 长按进入拖拽的阈值（毫秒）。用户要求「按住 0.5s 后才触发」。 */
const DRAG_HOLD_MS = DEFAULT_HOLD_MS;

/** 位移超过这么多像素就立刻算拖拽（不必等长按）。 */
const DRAG_SLOP = DEFAULT_SLOP;

/** 点击后的小弹跳初速度（像素/秒）。 */
const CLICK_HOP_VELOCITY = -260;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * 安全调用外部回调。
 *
 * 插件把 `hooks.onStateChange` 接到日志上；日志一旦抛错（实测：调了不存在的
 * 宿主 API），异常会顺着 `machine.beginDrag()` 抛回 `onPointerDown`，
 * 导致**紧跟其后的 `physics.beginDrag()` 不执行**——表现是「拖不动」，
 * 而真正的原因在别处。钩子失败只能影响钩子自己。
 */
function safeHook(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (error) {
    try {
      // eslint-disable-next-line no-console
      console.warn('[pet] 回调抛错（已忽略）:', error);
    } catch {
      // 忽略
    }
  }
}

/**
 * 创建宠物视图。
 *
 * @param {object} options
 * @param {HTMLElement} options.container ambient surface 的容器（宿主提供）
 * @param {object} options.pack 运行期形象定义（后端 `runtime_pack()` 的结果）
 * @param {object} options.config 插件配置（`quiet_mode` / `auto_roam` / `scale` …）
 * @param {object} options.hooks 回调：`onStateChange` / `onToast` / `onLog`
 */
export function createPetView(options = {}) {
  const container = options.container;
  const hooks = options.hooks || {};
  const pack = options.pack || {};
  const config = Object.assign({
    quietMode: false,
    autoRoam: true,
    scale: 1,
    sleepAfter: 120,
    reducedMotion: false,
    animSpeed: 1,
  }, options.config || {});

  const actions = pack.actions || {};
  const baseSize = pack.size || { w: 64, h: 64 };
  const scale = clamp(Number(config.scale) || 1, SCALE_MIN, SCALE_MAX);
  // 单帧的**显示**尺寸。它是 `let` 而不是 `const`：动作可以自带画布尺寸
  // （见 `frameSizeOf`），换动作时这三处几何要一起换——根节点尺寸、切帧几何、
  // 物理包围盒。留成同名变量，所有既有用法不必改。
  let width = Math.max(8, Math.round(baseSize.w * scale));
  let height = Math.max(8, Math.round(baseSize.h * scale));
  const anchorX = Number(pack.anchor?.x ?? 0.5);
  const anchorY = Number(pack.anchor?.y ?? 1);

  /** 用户设的动画速度倍率（越大越慢）。 */
  let animSpeed = clamp(Number(config.animSpeed) || 1, ANIM_SPEED_MIN, ANIM_SPEED_MAX);

  // ---------------------------------------------------------------- DOM

  const root = document.createElement('div');
  root.className = 'pet-root plugin-stm-pet';
  root.dataset.plugin = 'stm-pet';
  // `pointer-events` 是继承属性，容器整体是 none，必须显式取回（§8 陷阱 1）
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
  root.style.transform = 'translate3d(0px, 0px, 0)';

  // 渲染方式（像素风 / 平滑插值）。
  //
  // 这个属性**必须真的写上去**：`plugin.css` 里的
  // `[data-pet-pixelated="false"]` 规则靠它选择器匹配。早先这属性从未被设置，
  // 于是那条规则永不生效、`pixelated` 恒开——用户把倍率调到 2× 以上时，
  // 写实插画会出现块状边缘。
  //
  // 走 `data-` 属性而不是内联 style：样式规则归 CSS（F11 要求作用域内），
  // 属性只表达「是什么」，不表达「怎么画」。
  const pixelated0 = config.pixelated === true;
  root.dataset.petPixelated = pixelated0 ? 'true' : 'false';

  const sprite = document.createElement('div');
  sprite.className = 'pet-sprite';
  root.appendChild(sprite);
  container.appendChild(root);

  /** 无障碍：宠物是装饰性内容，不进 Tab 序（§0 判定标准）。 */
  root.setAttribute('aria-hidden', 'true');

  // ---------------------------------------------------------------- 逻辑

  const bounds = () => ({
    width: container.clientWidth || window.innerWidth || 1,
    height: container.clientHeight || window.innerHeight || 1,
  });

  const initialBounds = bounds();
  const physics = createPhysics({
    x: initialBounds.width * 0.5,
    y: initialBounds.height,
    width,
    height,
    bounds: initialBounds,
    physics: pack.physics || {},
  });

  const machine = createStateMachine({
    onChange: (next, prev, meta) => {
      safeHook(hooks.onStateChange, next, prev, meta);
      applyActionForState();
      onStateEnter(next);
    },
  });

  const clock = createFrameClock({ frames: 1, fps: 6, loop: true });
  const gate = createIdleGate();

  /**
   * **时间驱动行为**的随机间隔调度器（见 `animation.js`）。
   *
   * 管两件事：idle 的小动作（`idleWakeTimer`）与自动漫游（`roamWakeTimer`）。
   * 两者都是「平时不发生，隔一段随机时间发生一次」，只是触发后做的事不同。
   *
   * ⚠️ 两者都走 `setTimeout`，**不能**在 rAF 里倒数——rAF 在 idle 静止时
   * 是停的（省电契约），挂在它上面的倒计时永远不前进。漫游早先就栽在这里，
   * 详见 `roamWakeTimer` 的注释。
   *
   * 只在**真的处于 idle 且无其它占用**时推进，因此不会影响 sleep：
   * 睡着之后状态不是 idle，`enabled` 为假，排期被清掉；
   * 醒来时重新排期，于是「醒来立刻抽一次时间」而不是「补上睡梦中的那一次」。
   */
  const scheduler = createBehaviorScheduler();
  /** 当前 idle 触发是否要求「一直循环」（`schedule.idle.mode === 'loop'`）。 */
  let idleLoops = false;
  /** 标准图像（不播动画时显示的那一帧）；后端已算好回退结论。 */
  const still = stillFrame(pack);

  const gesture = createGesture({ holdMs: DRAG_HOLD_MS, slop: DRAG_SLOP });

  let currentAction = 'idle';
  /** 当前正在播的**变体**（多套动画里选中的那套）；`null` 表示无图。 */
  let currentVariant = null;
  /**
   * 当前**已经铺在 sprite 上**的是第几页（多页 sheet）。
   *
   * 必须记住它：切页要换 `background-image`（一次解码），而换格只改
   * `background-position`（零成本）。不知道当前在哪一页就会每帧都重设
   * 背景图，那会让浏览器反复重新解码同一张图。
   */
  let currentPage = 0;
  /**
   * 已经**预热过**的页 URL 集合。
   *
   * 为什么需要它：切页要换图，而第一次换到某一页时那张图还没解码完，
   * 表现是「动画走到第 2 页时卡一下」。因此在播放期间**提前**把下一页
   * 用 `new Image()` 拉进缓存。
   *
   * 为什么用集合而不是「只记住下一页」：同一页会被反复经过（循环动画），
   * 记下来就不会每次经过都重新 `new Image()`（那会白白建对象）。
   */
  const warmedPages = new Set();
  /** idle 的「随机触发」进行中（播完要回静止，而不是留在循环里）。 */
  let idleBurst = false;
  /**
   * 上一帧是否处于「离地」状态。
   *
   * 用来识别「刚回到地面」这个边沿：空中会撤掉 idle 排期（见
   * `updateStateFromPhysics` 的空中护栏），而点击弹跳不产生状态迁移，
   * 因此没有别的地方会把它排回来。
   */
  let wasAirborne = false;
  let rafId = 0;
  let running = false;
  let lastFrameAt = 0;
  /** 最近一次用户交互的时刻（`performance.now()`）。打盹阈值从这里起算。 */
  let lastInteractionAt = 0;
  // **程序化运动**（呼吸 / 眨眼）的状态。
  //
  // `blinkTimer` 用 `setTimeout` 而不是 rAF：宠物静止时 rAF 是停着的，
  // 眨眼必须能在那时发生（否则「宠物站着不动时眨眼」永远不会出现）。
  let blinkTimer = 0;
  //: 上一次眨到了 `blinkFrames` 的第几项（轮流用，避免每次都是同一帧）。
  let blinkFrameIndex = -1;
  //: 当前生效的眨眼声明（`null` = 不眨）。
  let currentMotion = null;
  //: 眨眼的落点几何（`{grid, frames, onStill}`）；见 `applyMotion` 的说明。
  let blinkTarget = null;
  let hostState = {};
  let throttle = { paused: false, rate: 1, reason: '' };
  let reducedMotion = Boolean(config.reducedMotion);
  let disposed = false;
  let facing = 1;
  /**
   * 当前**行走方向**（负数向左）。
   *
   * 与 `facing` 分开：`facing` 是「朝向」，会保留到停下之后（站着时仍朝那边）；
   * `walkDirection` 只在行走期间有意义，用来选 `walk-left` / `walk-right`。
   */
  let walkDirection = 1;
  let dragSamples = [];
  let pointerId = null;
  /** 最近一次指针位置（长按升级成拖拽时要用它作为拖拽起点）。 */
  let lastPointer = null;
  /**
   * 距离下一次漫游的**剩余毫秒**——**仅用于诊断/测试**，不参与调度。
   *
   * 调度本身走 `roamWakeTimer`（`setTimeout`）。留这个字段是因为
   * 「下一次还有多久」是排查这类问题时唯一有用的观测量，而
   * `setTimeout` 的句柄读不出来。它由 `scheduleRoamWake()` 写入、
   * 由 `roamCountdown()` 按当前时间折算。
   */
  let roamDeadline = 0;
  let roamIntervalMs = 0;
  let walkTargetX = 0;
  /** 累积的「这段时间该走多少像素」——按帧率无关的方式推进漫游。 */
  let frameAccumulator = 0;
  /** 一次性动作（land / click / 播报）的定时器。 */
  let actionTimer = 0;
  /**
   * idle 随机触发的定时器。
   *
   * 必须是**独立**于 `actionTimer` 的一个：`actionTimer` 管的是
   * 「当前这次动作什么时候播完」，而这个管的是「下一次什么时候开始」。
   * 共用一个的后果是「播完回 idle 时把自己的收尾定时器清掉了」——
   * 表现是 idle 动画播一遍之后再也不会触发。
   */
  let idleWakeTimer = 0;
  /**
   * 自动漫游的定时器（下一次什么时候自己走一趟）。
   *
   * ★ 它**必须**是 `setTimeout`，不能像早先那样在 rAF 里倒数。
   *
   * 早先的实现是在 `updateStateFromPhysics()` 里 `walkTimer -= dt * 1000`，
   * 而那个函数只在 rAF 循环运行时才跑；默认 idle 模式（`random`）下
   * `shouldKeepRunning()` 在「idle + 物理静止」时返回 false，**rAF 真的停掉**
   * （这是省电契约，见 README §4.5）。
   *
   * 两者合起来的后果是：**漫游倒计时永远不前进，自动漫游从不触发**。
   * 实测（把漫游间隔设成 200~300ms，12 秒每 100ms 采样一次）：
   * 状态全程停在 `idle`、水平位移 0.0px、一次都没走动。
   *
   * 为什么这个 bug 能藏那么久：idle 的小动作走 `setTimeout`
   * （`scheduleIdleWake`），所以它一切正常——「闲置的看起来正常」正好
   * 把同一条路径上的漫游问题掩盖了。用户报的「漫游调到 200-300ms
   * 结果半天触发不了」就是它。
   *
   * 与 `idleWakeTimer` 分开是必须的：两者是**两条独立的路子**
   * （`autoRoam` 与 idle 触发互不排斥），共用一个的话其中一条会把
   * 另一条的排期清掉。
   */
  let roamWakeTimer = 0;
  /**
   * 打盹判定的定时器（「静了多久之后睡着」到点了）。
   *
   * ★ 与漫游同理，它**必须**是 `setTimeout`，不能只靠 rAF 里的低频轮询。
   *
   * 早先的实现只在 `updateStateFromPhysics()` 里查一次
   * （`if (idleFor > sleepAfterMs()) machine.sleep()`），而那个函数只在
   * rAF 循环运行时才跑；默认 idle 模式（`random`）下 rAF 在 idle 静止时
   * **是停的**。于是「到点睡着」这件事实际上靠**别的原因把 rAF 唤醒**
   * 才碰巧发生——通常是 idle 小动作（每 6~18 秒一次）。
   *
   * 后果：把 idle 间隔调大（例如 1 小时）而打盹阈值很小（10 秒）时，
   * **宠物永远不睡**。实测：idle 间隔 1 小时 + 阈值 10 秒，22 秒后
   * 状态仍是 `idle`。这与漫游那个 bug 是**同一类**——
   * 「时间驱动的行为，唯一的驱动源却是 rAF」。
   *
   * 走定时器之后，「到点」不再依赖任何其它行为是否恰好发生。
   */
  let sleepWakeTimer = 0;

  // ---------------------------------------------------------------- 绘制

  /** 取某动作的解析结果（后端已算好回退链，这里只取用）。 */
  function actionSpec(name) {
    return actions[name] || null;
  }

  /**
   * 把「当前这一套动画」的几何同步到四处：根节点尺寸、物理包围盒、贴图铺法、切帧偏移。
   *
   * 这四处**必须一起改**：只改其中一部分的后果分别是
   * 「宠物框住一大片空白」「切帧错位露出邻帧」「脚底悬空/陷进地面」。
   * 返回是否真的变了，没变就不做多余的 DOM 写入。
   *
   * 尺寸取自 `animation.js:frameSizeOf`（**变体自带 > 动作条目 > 包级**）。
   */
  function applyFrameSize(variant, spec) {
    const logical = frameSizeOf(variant, spec, baseSize);
    const nextWidth = Math.max(8, Math.round(logical.w * scale));
    const nextHeight = Math.max(8, Math.round(logical.h * scale));
    if (nextWidth === width && nextHeight === height) return false;
    width = nextWidth;
    height = nextHeight;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    // 物理包围盒：`setSize` 会把 x 夹回可见区，y（脚底）不动——
    // 于是换动作时脚仍然踩在同一处地面，不会因为换了尺寸而跳一下。
    physics.setSize({ width, height });
    return true;
  }

  /** 当前生效的速度倍率（含宿主忙碌 / 弹层打开时的额外放慢）。 */
  function currentSpeed() {
    let speed = animSpeed;
    if (throttle.reason === 'busy' || throttle.reason === 'occluded') {
      speed *= OCCLUDED_SPEED_FACTOR;
    }
    return clamp(speed, ANIM_SPEED_MIN, ANIM_SPEED_MAX * OCCLUDED_SPEED_FACTOR);
  }

  function applyActionForState() {
    const state = machine.state;
    let name = machine.action;
    // 行走用**方向化**动作名：形象提供侧视左右两套时播对应那套，
    // 没提供时后端已把回退结论算好（对侧镜像 → idle）。
    if (state === STATES.WALK) name = walkActionFor(walkDirection);
    else if (state === STATES.DRAG) name = 'drag';
    else if (state === STATES.FALL) name = 'fall';
    else if (state === STATES.LAND) name = 'land';
    else if (state === STATES.SLEEP) name = 'sleep';
    else if (state === STATES.REACT) name = machine.action;
    else name = 'idle';
    setAction(name);
    // 动作换了 → 翻转结论可能也变了（正面图要按朝向翻，方向化贴图不翻）
    applyFacing();
  }

  /**
   * 状态**进入**时的收尾（在 `onChange` 里调）。
   *
   * 只做一件事：维护 idle 随机触发的排期。
   *
   * 为什么放在这里而不是散在各处调用：排期必须在「离开 idle」时清掉、
   * 在「进入 idle」时重排，而状态迁移有**十几条**路径
   * （落地播完、播报播完、漫游停下、被拖走、睡着、醒来…）。
   * 逐个路径手工维护，漏掉任何一条的表现都是「idle 动画再也不触发了」——
   * 这类漏改极难发现。集中在一个钩子里就不会漏。
   */
  function onStateEnter(next) {
    if (next === STATES.IDLE) {
      // 刚回到 idle：等一段新的随机时间再自己动一下。
      // `idleBurst` 正在播时不重排——那会在播的过程中插一个定时器进来。
      if (!idleBurst) scheduleIdleWake();
      // 漫游同理：**必须**在这里重排，不能只在初始化时排一次。
      // 状态迁移有十几条路径（落地、播报完、漫游停下、拖拽结束、睡醒…），
      // 漏掉任何一条的表现都是「走了一趟之后就再也不走了」。
      // 走完一趟回到 idle 也走这条路径，于是每趟重新抽间隔。
      scheduleRoamWake();
      // 打盹判定同理：醒着回到 idle 时重新按当前阈值排一次。
      // 睡醒之后也要排——否则它再也不会睡第二次。
      scheduleSleepWake();
    } else {
      cancelIdleWake();
      // 离开 idle 就撤掉待执行的漫游：睡着 / 被拖走 / 正在走时都不该再排。
      cancelRoamWake();
      // 睡着之后撤掉打盹判定：留着它会在睡眠期间反复触发。
      // （`sleepTriggerEnabled()` 也挡得住，但撤掉更干净。）
      cancelSleepWake();
    }
  }

  /** 切换动作。
   *
   * 后端已经把回退链算完（`kind` / `variants` / `url`），这里只做：
   * 1. 多套动画按权重**抽一套**（`pickVariantIndex`）；
   * 2. 「能不能播帧」的判定：`static` 只位移不播帧（§3.3 的降级语义）。
   */
  function setAction(name, { force = false, variantSeed = null } = {}) {
    const next = String(name || 'idle');
    if (!force && next === currentAction) return;
    const spec = actionSpec(next) || actionSpec('idle');
    currentAction = next;

    const variants = playableVariants(spec);
    const index = variantSeed === null
      ? pickVariantIndex(variants)
      : clamp(Math.floor(Number(variantSeed) || 0), 0, Math.max(0, variants.length - 1));
    const variant = index >= 0 ? variants[index] : null;
    currentVariant = variant;

    const animated = Boolean(variant) && variant.frames > 1;
    root.dataset.petAction = next;
    root.dataset.petVariant = variant ? String(index) : '';

    // 换动作可能同时换**画布尺寸**（例如躺姿的 sleep 是横构图）。
    // 必须在写 `background-size` 与 `drawPosition()` **之前**完成：
    // 下面两处都用 `width` / `height` 算铺法与位移，顺序反了会按旧尺寸铺一帧。
    // 尺寸没变时它是空操作，因此绝大多数动作切换没有额外开销。
    const sizeChanged = applyFrameSize(variant, spec);
    if (sizeChanged) {
      // 尺寸变了就**立刻**重算位移。不能只靠 rAF 里的 `drawPosition()`：
      // 那个调用受 `moved > 0.01` 门控，而静息状态（宠物站着不动、循环已停）
      // 正好不满足条件——于是换到不同尺寸的动作后，宠物会一直停在
      // 按旧尺寸算出的位移上，看起来是「换动作后瞬移了一段」。
      drawPosition();
    }

    if (variant) {
      // spritesheet + background-position：换帧只改绘制，不走网络与解码（§2.5）。
      //
      // 铺法由**网格几何**决定（`cols × rows`），不再是「水平 or 垂直」两条分支：
      // 整条 sheet 的显示尺寸 = 单帧显示尺寸 × 行列数。`horizontal` 是
      // `cols=frames, rows=1`、`vertical` 是 `cols=1, rows=frames`，
      // 三者共用这一条公式，因此不可能出现「某种排布算错」。
      //
      // ⚠️ 这里用**网格容量**（cols × rows）而不是帧数：装不满的网格
      // （例如 4×4 只放 13 帧）末行是空的，但背景图仍是完整的 4×4 张图。
      // 多页时这个公式不变——**每页的形状相同**，只是换一张图。
      //
      // 动图容器（`layout: "animated"`）的网格是 `(1, 1)`，于是这条公式
      // 自然退化成「原样铺满一帧」——**不需要**为它写一条分支。
      const grid = frameGrid(variant);
      sprite.style.backgroundSize = `${width * grid.cols}px ${height * grid.rows}px`;
      sprite.style.backgroundRepeat = 'no-repeat';
      // 换动作要从第 0 页开始：`currentPage` 是上一个动作的，必须清掉，
      // 否则新动作会沿用旧页号，而那个页号可能超出新动作的页数
      // ——表现是「换动作后第一帧显示空白」。
      currentPage = -1;
      showPage(0);
    } else {
      sprite.style.backgroundImage = 'none';
      currentPage = 0;
    }

    if (animated) {
      clock.setSpec({
        frames: variant.frames,
        fps: variant.fps,
        loop: variant.loop,
        frameMs: variant.frameMs,
      });
      drawFrame();
    } else {
      // 单帧 / 静态：停在这一帧，不推进
      clock.setSpec({ frames: 1, fps: 1, loop: true });
      drawFrame();
    }
    // **程序化运动**：与帧推进正交，因此在两条分支**之后**统一应用
    // （单帧形象也能呼吸——那正是它最大的用处）。
    applyMotion(variant);
    // `idle` 在 `random` 模式下**平时是标准图像**，不是 idle 首帧：
    // 两者在作者只给了一套 idle 时长得一样，但在挂了第二套（「张望」）时
    // 完全不同——标准图像是固定的，而「idle 首帧」会让静止画面跟着
    // 上一次随机抽到的变体变（用户报的「卡在抬头看」就是这个）。
    if (next === 'idle' && !idleLoops && !idleBurst) drawStill();
    // 动画速度倍率是**播放期**的事：这里只记录，推进时按它折算 dt。
    root.dataset.petAnimSpeed = String(currentSpeed());
    wake();
  }

  /**
   * 把**标准图像**写进 sprite（不播动画时显示的那一帧）。
   *
   * 为什么需要它：`idle` 可以挂多套动画（内置形象的「张望」就是第二套），
   * 而「静止」原本的实现是「保留刚刚播过的那套变体的第 0 帧」——
   * 于是随机播到「张望」之后，宠物就卡在**抬头看**的姿势上不动了。
   * 正确语义是「不播动画时显示一个固定的标准姿势」，与刚刚播过什么无关。
   *
   * ⚠️ **几何必须跟着标准图像自己走**，不能沿用当前动作的 `width` / `height`：
   * 标准图像可以取自任意一条 sheet（例如躺姿 `sleep.png` 的某一帧），
   * 而那条 sheet 的比例可能与当前动作完全不同。用当前动作的几何去铺它，
   * 横构图的图会被按竖构图拉伸（实测失真 62%）。
   *
   * 这也是「标准图像」与「逐动作尺寸」两个特性**合到一起**才暴露的问题：
   * 各自单独存在时都看不出——所以修在合并时。
   *
   * `still` 为 `null`（后端一张图都没给）时保持当前绘制不动，
   * 而不是清空背景——清空会让宠物凭空消失。
   */
  function drawStill() {
    if (!still) return;
    currentVariant = null;
    // 切到标准图像的几何（变体自带 > 包级）。`applyFrameSize` 会一并处理
    // 根节点尺寸与物理包围盒——与换动作走的是同一条路径，避免两处漂移。
    if (applyFrameSize({ size: still.size }, null)) {
      // 尺寸真的变了就必须立刻重算位移：`width` / `height` 同时进了
      // 「包围盒中心 → 左上角」的换算，不重算的话宠物会偏出去一段。
      drawPosition();
    }
    sprite.style.backgroundImage = `url("${still.url}")`;
    sprite.style.backgroundRepeat = 'no-repeat';
    // 与 `setAction` 同一条公式（见那里的说明）：网格几何决定铺法。
    // 标准图像可以是网格排布 sheet 里的**任意一帧**，因此这里也必须按
    // 行列算偏移——按「单行 + 第 frame 帧」算的话，网格 sheet 会取错帧。
    //
    // 标准图像**不支持多页**（它按定义就是「一帧」），因此用 `framePage`
    // 在那一页内定位就够了：`still.frames` 是那一页里的帧数。
    const grid = frameGrid(still);
    sprite.style.backgroundSize = `${width * grid.cols}px ${height * grid.rows}px`;
    const at = framePage(still.frame, grid, still.frames);
    sprite.style.backgroundPosition = `${-at.col * width}px ${-at.row * height}px`;
    // 标准图像画的不是「当前变体」，页号要跟着清掉——否则下一次 `showPage`
    // 会因为 `currentPage` 还停在旧值而跳过写背景图，宠物会一直显示标准图像。
    currentPage = -1;
    // ★ 标准图像也要**程序化运动**：默认 idle 模式下宠物大部分时间显示的
    // 就是它，不动的话「呼吸」这个特性几乎永远看不见。
    // （后端已经把 idle 的运动继承到 still 上了，这里只是应用它。）
    applyMotion(still);
  }

  /**
   * 应用**程序化运动**（呼吸 / 眨眼）。`spec` 是变体或标准图像，都可以。
   *
   * 为什么把两者放在一起：它们**共用同一份声明**，而且必须同步开关——
   * 只开一个的表现是「换动作后呼吸没了」或「眨眼还在跳但图换了」。
   *
   * 呼吸走 CSS 动画（合成器上跑，**不需要 rAF**，见 `plugin.css` 的说明）；
   * 眨眼走 `background-position` 跳帧，由 `setTimeout` 安排——因为宠物静止时
   * rAF 是**停着**的（省电契约），用 rAF 计时的话倒计时永远不前进。
   */
  function applyMotion(spec) {
    const motion = spec ? spec.motion : null;
    // ---- 呼吸
    if (motionBreathes(motion)) {
      // 三个变量：幅度 / 周期 / 朝向。
      //
      // ⚠️ 朝向（`--pet-face`）必须走变量而不是内联 `transform`：
      // CSS 动画一旦动画 `transform` 就会**覆盖**内联值，于是镜像会静默失效
      // （实测：内联 `scaleX(-1)` + 动画 → 变成 `matrix(1,0,0,1.1,0,0)`）。
      sprite.style.setProperty('--pet-breathe-amp', String(motion.amplitude));
      // 周期要按**动画速度倍率**折算：用户把倍率调慢时呼吸还按原速跑会不协调。
      sprite.style.setProperty('--pet-breathe-period', `${Math.round(motion.periodMs / currentSpeed())}ms`);
      // `transform-origin` 由**后端**按包级 `anchor.y` 算好下发。
      // 前端不自己推：推错的表现是「锚点不在底边的形象呼吸时脚离地」。
      if (spec.motionOrigin) sprite.style.transformOrigin = spec.motionOrigin;
      root.classList.add('has-breathe');
    } else {
      root.classList.remove('has-breathe');
      sprite.style.removeProperty('--pet-breathe-amp');
      sprite.style.removeProperty('--pet-breathe-period');
    }
    // 朝向变量要**无条件**设置：没有呼吸时它仍然承担镜像的职责
    // （见 `applyFacing`）。有呼吸时它与关键帧里的 `scaleX()` 配合。
    applyFacing();

    // ---- 眨眼
    clearTimeout(blinkTimer);
    blinkTimer = 0;
    blinkFrameIndex = -1;
    currentMotion = motionBlinks(motion) ? motion : null;
    // 眨眼的**落点几何**跟着「当前显示的东西」走：可能是变体，也可能是
    // 标准图像（默认 idle 模式下大部分时间显示的就是后者，而那正是
    // 「宠物站着不动时眨眼」应该发生的时候）。
    //
    // ⚠️ 必须带上**它自己的** `frames` 做边界检查：标准图像可能取自
    // 另一条 sheet（例如睡姿），而眨眼帧号是从 idle 继承来的——
    // 那条 sheet 上未必有那么多帧。越界会让宠物眨眼时**凭空消失**一瞬。
    blinkTarget = currentMotion
      ? {
        grid: frameGrid(spec),
        frames: Math.max(1, Math.floor(Number(spec.frames) || 1)),
        onStill: spec === still,
      }
      : null;
    if (currentMotion) scheduleBlink();
  }

  /**
   * 安排下一次眨眼。
   *
   * 用 `setTimeout` 而不是在 rAF 里累加——宠物静止时 rAF 是停着的，
   * 放在 rAF 里推进的话倒计时永远不会前进（这个坑在 idle 调度那里
   * 已经踩过一次，见 `animation.js` 顶部说明）。
   */
  function scheduleBlink() {
    if (!currentMotion || disposed) return;
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      blinkTimer = 0;
      runBlink();
    }, pickBlinkDelay(currentMotion));
  }

  /** 眨一次眼：跳到 `blinkFrames` 的下一帧，停一会儿，再跳回来。 */
  function runBlink() {
    if (!currentMotion || disposed || !blinkTarget) return;
    const frames = currentMotion.blinkFrames;
    blinkFrameIndex = (blinkFrameIndex + 1) % frames.length;
    const frame = frames[blinkFrameIndex];
    // 只改 `background-position`（不换图、不重解码）。
    //
    // ⚠️ 用**当前显示的那条 sheet 的网格几何**算这一帧的位置——不能用
    // 「单行 + 第 frame 帧」硬算：网格排布时「第 2 帧」在第二行第一列，
    // 硬算会取到错的格子（而单行时两者恰好相同，因此这种错只在网格包上出现）。
    //
    // ⚠️ 也要用**它自己的**帧数做边界检查（见 `blinkTarget` 的说明）：
    // 越界会让宠物眨眼时消失一瞬。
    if (frame < blinkTarget.frames) {
      const at = framePage(frame, blinkTarget.grid, blinkTarget.frames);
      // 标准图像只有一页；变体可能多页，只有当前就在那一页时才跳
      // （跨页要换图、要解码，那正是我们不想在眨眼这种小事上做的事）。
      if (blinkTarget.onStill || at.page === currentPage) {
        sprite.style.backgroundPosition = `${-at.col * width}px ${-at.row * height}px`;
      }
    }
    blinkTimer = setTimeout(() => {
      blinkTimer = 0;
      // 眨完回到**当前时钟所在的帧**（而不是硬回到第 0 帧——
      // 那样循环动画会突然跳回开头）。标准图像则重画那一帧。
      if (!disposed) {
        if (blinkTarget && blinkTarget.onStill) drawStill();
        else drawFrame();
      }
      scheduleBlink();
    }, currentMotion.blinkDurationMs);
  }

  /**
   * 把某一页的图铺到 sprite 上（**只在真的换页时**动 `background-image`）。
   *
   * 为什么要有这个函数而不是每次直接写：换 `background-image` 会触发一次
   * 解码，而换格（`background-position`）不会。循环动画每经过一次页边界
   * 都会调到这里，不做「同一页就跳过」的判断就会反复重设同一张图。
   *
   * 换页之后顺手**预热下一页**（见 `warmPage`）：等真正走到那一页时
   * 它已经在缓存里，观感上没有停顿。
   */
  function showPage(page) {
    const variant = currentVariant;
    if (!variant) return;
    const pages = variant.pages || [];
    if (!pages.length) return;
    // 页号越界 → 夹到最后一页（而不是留空）。越界通常来自「后端下发的
    // 页数比实际可播的少」（某一页的图丢了），此时宁可重复最后一页，
    // 也不要让宠物凭空消失。
    const index = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages.length - 1);
    if (index !== currentPage) {
      sprite.style.backgroundImage = `url("${pages[index]}")`;
      currentPage = index;
    }
    // 预热下一页（循环时最后一页的下一页是第 0 页）
    const next = index + 1 < pages.length ? index + 1 : 0;
    if (next !== index) warmPage(pages[next]);
  }

  /**
   * 提前把一页拉进浏览器缓存。
   *
   * 用 `new Image()` 而不是 `fetch`：前者走的是与 `background-image`
   * **同一条**资源缓存，因此预热过的页在真正切过去时是即时可用的。
   * `fetch` 只填 HTTP 缓存，解码仍要重来一遍。
   *
   * `warmedPages` 只记 URL 不记图对象：图对象本身由浏览器持有，
   * 我们不该自己攥着一堆 `Image`（那反而会阻止它们被回收）。
   */
  function warmPage(url) {
    if (!url || warmedPages.has(url)) return;
    warmedPages.add(url);
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
    } catch {
      // 预热失败不影响功能：真正切过去时浏览器会正常加载
    }
  }

  /** 把当前帧写进 `background-position`（只改绘制，不触发 layout）。 */
  function drawFrame() {
    const variant = currentVariant;
    if (!variant) {
      sprite.style.backgroundPosition = '0 0';
      return;
    }
    const index = clock.frames > 1 ? clock.index : 0;
    const at = framePage(index, frameGrid(variant), variant.frames);
    // 先保证是**正确的页**（多页时可能已经跨页），再写页内位移。
    showPage(at.page);
    sprite.style.backgroundPosition = `${-at.col * width}px ${-at.row * height}px`;
  }

  /** 按锚点把「包围盒中心 x / 脚底 y」换算成 CSS 平移量。 */
  function drawPosition() {
    const halfW = width / 2;
    const left = physics.x - halfW;
    // 锚点 y=1 表示贴图底边对齐世界坐标（脚踩地）
    const top = physics.y - height * anchorY;
    // translate3d 走合成层，不触发 layout（§4.1）
    root.style.transform = `translate3d(${left.toFixed(2)}px, ${top.toFixed(2)}px, 0)`;
  }

  /**
   * 按当前状态决定是否水平翻转贴图。
   *
   * 两种语义**不能混为一谈**（见 `direction.js` 的说明）：
   * - 行走时：翻转由「方向化贴图 + 后端 `mirror` 标记」决定。
   *   方向化贴图已经画好了朝向，再按朝向翻一次就反了。
   * - 其它动作：只有**没有**方向化贴图的形象才按朝向翻转（旧行为）。
   *   提供了方向化贴图的形象（典型：头饰不对称）连 idle 也不翻，
   *   否则发夹会随朝向左右跳。
   */
  function applyFacing() {
    const mirror = machine.state === STATES.WALK
      ? resolveWalkVisual(walkDirection, actions).mirror
      : mirrorForNonWalkAction(facing, actions);
    // ⚠️ 有呼吸时**不能**写内联 `transform`：CSS 动画会覆盖它（实测），
    // 于是镜像静默失效。改用 CSS 变量 `--pet-face`，由关键帧里的
    // `scaleX(var(--pet-face))` 消费——两者合成在同一个 transform 里。
    //
    // 没有呼吸时仍走内联 `transform`：那条路径已经被大量测试钉住，
    // 没必要为了统一而改动它。
    if (root.classList.contains('has-breathe')) {
      sprite.style.setProperty('--pet-face', mirror ? '-1' : '1');
      sprite.style.removeProperty('transform');
    } else {
      sprite.style.removeProperty('--pet-face');
      sprite.style.transform = mirror ? 'scaleX(-1)' : '';
    }
  }

  // ---------------------------------------------------------------- rAF

  /**
   * 唤醒动画循环。
   *
   * 循环会自己停（省电），因此**任何**需要动画的事情都必须调它。
   * 漏调的表现是「宠物卡住不动」——这是本模块最需要小心的地方。
   */
  function wake() {
    if (disposed || running) return;
    if (throttle.paused) return;
    running = true;
    lastFrameAt = 0;
    rafId = window.requestAnimationFrame(tick);
  }

  /** 停循环（省电）。 */
  function stopLoop() {
    running = false;
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick(timestamp) {
    if (disposed) {
      running = false;
      return;
    }
    try {
      tickOnce(timestamp);
    } catch (error) {
      // 单帧失败不能让宠物**永久**卡死：记录后继续排下一帧。
      // 否则一次异常就吞掉整个循环，表现为「宠物再也不动了」，
      // 而控制台里只有一条早先的报错，很难关联起来。
      try {
        // eslint-disable-next-line no-console
        console.warn('[pet] 单帧渲染异常（已跳过该帧）:', error);
      } catch {
        // 忽略
      }
      if (!disposed && !throttle.paused) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      running = false;
      rafId = 0;
    }
  }

  function tickOnce(timestamp) {
    const now = Number(timestamp) || 0;
    const dt = lastFrameAt ? Math.min(0.25, Math.max(0, (now - lastFrameAt) / 1000)) : 0;
    lastFrameAt = now;

    // 1) 物理（固定步长积分）
    const before = { x: physics.x, y: physics.y };
    physics.advance(dt);
    const moved = Math.abs(physics.x - before.x) + Math.abs(physics.y - before.y);

    // 2) 状态迁移（含 idle 随机触发的推进）
    updateStateFromPhysics(dt, now);

    // 2.5) 长按判定
    //
    //      「按住 0.5 秒进入拖拽」这条路径**不会**有 `pointermove` 事件
    //      （用户按着不动），因此必须由时间驱动。放在 rAF 里而不是
    //      `setTimeout` 里：`shouldKeepRunning` 已经在 `pending` 期间保持循环，
    //      两者天然同步，也不会出现「循环停了但长按定时器还在跑」的错位。
    if (gesture.phase === 'pending' && lastPointer) {
      if (gesture.tick(now)) beginDrag(lastPointer);
    }

    // 3) 帧推进
    //
    //    `paused`（页面不可见 / reducedMotion）时循环根本不会跑，这里不必再判。
    //
    //    **动画速度倍率在这里生效**：把流逝时间按倍率折算后再推进帧。
    //    之所以不在包层面改 fps：倍率是**用户偏好**，改 fps 会让
    //    「同一次动作在不同倍率下播得不一样长」，而定时器（播完回 idle）
    //    必须与实际播放时长一致。因此倍率同时作用于「帧推进」与「时长计算」
    //    （见 `actionDurationMs`），两处用的是同一个 `currentSpeed()`。
    if (dt > 0) {
      const speed = currentSpeed();
      // 非均匀帧时长下，`frameMs` 是包声明的**绝对**毫秒数，
      // 因此倍率同样按比例放大每一帧的停留时间。
      const advance = Math.min(dt / speed, 0.25);
      if (clock.frames > 1) {
        const steps = clock.advance(advance);
        if (steps > 0) {
          drawFrame();
          // idle 的随机触发是**有限次数**：播完一轮（`plays` 轮）就回静止。
          if (idleBurst && clock.finished) finishIdleBurst();
        }
      }
    }

    // 4) 写 DOM
    if (moved > 0.01 || gesture.phase !== 'done') drawPosition();

    // 5) 省电：决定要不要继续
    if (shouldKeepRunning()) {
      rafId = window.requestAnimationFrame(tick);
    } else {
      running = false;
      rafId = 0;
    }
  }

  /** 这一帧结束后还需要继续跑吗？——「省电比用户更自觉」的核心（§4.5）。 */
  function shouldKeepRunning() {
    if (disposed) return false;
    // 停绘条件（页面不可见 / reducedMotion）在这里生效：真的不再请求动画帧
    if (throttle.paused) return false;
    if (physics.dragging || gesture.phase === 'pending') return true;
    if (machine.state === STATES.FALL || machine.state === STATES.WALK) return true;
    // 空中（例如点击后的小弹跳）也必须继续跑。
    //
    // `handleClick()` 刻意**不**进 `fall` 态（否则落地动作会打断点击动画），
    // 于是弹跳期间状态是 `idle`/`react` 而 `physics.grounded` 为假。
    // 若在这里就返回 `!physics.resting`，循环会在弹到最高点时停掉——
    // 宠物**悬在半空不动**，直到下一次交互才继续下落（真实故障）。
    if (!physics.grounded) return true;
    if (machine.state === STATES.REACT || machine.state === STATES.LAND) {
      // 一次性动作：播完就停
      return !clock.finished;
    }
    if (machine.state === STATES.DRAG) return true;
    // sleep：呼吸/呼噜的循环动画是「它睡着了」的唯一视觉信号，必须继续。
    if (machine.state === STATES.SLEEP) {
      return clock.frames > 1 && clock.loop;
    }
    // idle 的一次随机小动作正在播：**必须**继续跑，否则它会冻在第 0 帧。
    // （`physics.resting` 这时通常为真，不加这一条的话循环会当场停掉。）
    if (idleBurst) return !clock.finished || clock.frames <= 1;
    // idle：
    // - `loop` 模式（作者显式要求一直循环）→ 继续跑；
    // - `random` 模式（默认）→ **平时不跑**，只等随机触发那一下。
    //   这正是「平时处于静止画面」的落点：等待期间 rAF 真的停掉，
    //   触发由 `setTimeout` 安排（见 `scheduleIdleWake`）。
    if (clock.frames > 1 && clock.loop && idleLoops) return true;
    return !physics.resting;
  }

  function updateStateFromPhysics(dt, now) {
    const state = machine.state;

    // ---- 落地判定
    //
    // 用 `touchedDown`（离地→触地的**状态翻转**）而不是 `justLanded`
    // （冲击够不够重）。两者的分工见 `physics.js` 里 `touchedDown` 的说明。
    //
    // 用 `justLanded` 的旧写法有两个真实故障：
    // 1. 从很低的地方放下 / 贴着地面松手时冲击不足 60px/s，于是永远不落地
    //    —— 宠物贴在屏幕上一直播下落动画，而且 rAF 永不停止（`fall` 属于
    //    「必须继续跑」的状态，省电直接失效）；
    // 2. 用户报的「不是以坠落动画落得地就没有落地动画」，同源。
    //
    // 允许的来源只有 `fall` 与 `drag`：
    // - `fall`：正常路径（松手 → 下坠 → 触地）；
    // - `drag`：防御性保留。物理在拖拽期间**不推进**（`step()` 直接返回），
    //   因此 `touchedDown` 理论上不会在 `drag` 态为真；留着它只是为了
    //   万一将来「拖拽中也跑物理」时不会退化成「永远不落地」。
    //   `react` **刻意排除**：点击后的小弹跳不切 `fall`（见 `handleClick()`），
    //   因此也不该被落地动作打断——那是点击反馈的一部分。
    if (physics.touchedDown && (state === STATES.FALL || state === STATES.DRAG)) {
      machine.land({ now });
      // 落地动作播完回 idle（一次性）
      const duration = actionDurationMs('land', 180);
      clearTimeout(actionTimer);
      actionTimer = setTimeout(() => {
        // ⚠️ 必须复核当前状态：这个定时器跨越了 `duration` 毫秒，
        // 期间用户完全可能又把它抓起来（`land` → `drag` 是合法迁移）。
        // 不复核的话，落地动作还没播完就被拖走，这个定时器随后仍会执行
        // `settle()`——把**正在被拖拽**的宠物从 `drag` 拽进 `idle`，
        // 于是松手时它不进入 `fall`，直接在半空中播待机动画。
        if (machine.state !== STATES.LAND) {
          wake();
          return;
        }
        const pending = machine.takePendingReaction();
        if (pending) {
          machine.react(pending, { now: performance.now() });
          scheduleReactionEnd(pending);
        } else {
          machine.settle({ now: performance.now() });
        }
        wake();
      }, duration);
      return;
    }

    // ---- 空中护栏
    //
    // 只要**离地且不在拖拽中**，就不允许推进任何「地面行为」：
    // 漫游倒计时、打盹计时、idle 随机触发。
    //
    // 用户报的「空中播放别的动画，甚至多个动画交替出现」就出在这里：
    // 这些计时器都在 rAF 里按 dt 推进，而 `fall` 期间 rAF **正好在跑**
    // （它是「必须继续跑」的状态）。于是坠落途中漫游到点 → `startWalk()`
    // （`fall` → `walk` 不在表里，会被拒绝，但倒计时已经被消耗掉），
    // 打盹到点 → `sleep()`（同样被拒绝），而 `idleBurst` 那条路径
    // 会直接改动作名，宠物就在半空中播起了待机动画。
    //
    // 从源头掐掉比逐个迁移去拒绝更稳：这些行为在物理上就要求「站在地上」。
    const airborne = !physics.grounded && !physics.dragging;
    if (airborne) {
      // 已经排好的触发都要撤掉（它们可能在起跳之前就排好了）。
      // 漫游与打盹现在走各自的定时器，不撤的话到点了照样会串动作
      // （`*TriggerEnabled()` 里也挡了一道，但撤掉更干净）。
      cancelIdleWake();
      cancelRoamWake();
      cancelSleepWake();
      wasAirborne = true;
      return;
    }
    // 刚回到地面：把空中撤掉的那次 idle 排期补回来。
    //
    // 为什么必须补：`scheduleIdleWake()` 只在**状态迁移**时重排
    // （`onStateEnter` 进入 idle、`finishIdleBurst` 收尾、降频恢复）。
    // 而「点击后的小弹跳」不产生任何状态迁移（状态一直是 idle），
    // 于是空中撤掉排期之后就再也没有人去排它——宠物从此再也不自己动一下，
    // 直到用户点它一次。这个补排就是那条路径的收尾。
    if (wasAirborne) {
      wasAirborne = false;
      if (machine.state === STATES.IDLE && !idleBurst) scheduleIdleWake();
      // 漫游同理：空中撤掉的那次排期也要补回来，否则弹跳一次之后
      // 宠物就再也不自己走动了（与上面 idle 那个 bug 是同一条路径）。
      scheduleRoamWake();
      scheduleSleepWake();
    }

    if (state === STATES.WALK) {
      if (Math.abs(physics.x - walkTargetX) < 6) {
        physics.stopWalking();
        machine.stopWalk({ now });
      } else if (Math.abs(physics.vx) < WALK_STALL_SPEED) {
        // ★ 安全网：**走不动了就结束这一趟**。
        //
        // 正常路径是「走到目标附近就停」，但宠物可能**永远走不到**：
        // 撞上侧壁时物理层把水平速度清零（`physics.js`），而目标若在
        // 夹取范围之外就再也够不着。`pickWalkTarget()` 已经按半宽收窄了
        // 目标（那是根因的修复），这里是**兜底**——屏幕尺寸变化、
        // 用户中途改大小、浮点边界等等都可能让宠物再次停住。
        //
        // 卡在 WALK 的代价很大，不只是「看起来不动了」：
        //   - `shouldKeepRunning()` 对 WALK 恒返回 true → rAF 永远跑着，
        //     省电契约被破坏（这是最要紧的一条）；
        //   - `roamTriggerEnabled()` 要求 `state === IDLE` → 漫游再也不触发。
        //
        // 速度阈值取得很小：正常走路时 `vx` 是 walkSpeed（默认 60px/s），
        // 只有真的被墙拦住才会掉到接近 0。
        physics.stopWalking();
        machine.stopWalk({ now });
      }
    }

    // 漫游调度：**不在这里倒数**（见 `roamWakeTimer` 的注释）。
    //
    // 早先这里写的是 `walkTimer -= dt * 1000; if (walkTimer <= 0) scheduleWalk();`，
    // 而这段代码只在 rAF 运行时才跑到，rAF 又在 idle 静止时停着——
    // 于是漫游**从不触发**。现在排期走 `setTimeout`（`scheduleRoamWake`），
    // 由状态迁移驱动重排。

    // 打盹判定**不在这里**做。
    //
    // 早先这里有一段低频轮询（`if (idleFor > sleepAfterMs()) machine.sleep()`），
    // 而这段代码只在 rAF 运行时才跑到，rAF 又在 idle 静止时停着——
    // 于是「到点睡着」实际靠**别的原因把 rAF 唤醒**才碰巧发生
    // （通常是 idle 小动作）。把 idle 间隔调大就会露出来：
    // 实测 idle 间隔 1 小时 + 阈值 10 秒 → 22 秒后仍然没睡。
    //
    // 现在走 `scheduleSleepWake()` 的定时器（见 `sleepWakeTimer`），
    // 「到点」不再依赖任何其它行为是否恰好发生。
  }

  /**
   * 「静了多久之后睡着」的阈值（毫秒）。
   *
   * 优先级与其它时间参数一致：**按形象的设置 > 宿主全局配置 > 默认值**。
   * 按形象的那一份来自后端的 `schedule.sleep.afterMs`（用户要求把
   * 「睡觉」加进触发时间设置里——「多长时间不管就睡觉」）。
   *
   * 宿主全局的 `sleep_after` 是**秒**（manifest 里声明的单位），
   * 而 `schedule` 里一律是**毫秒**——两处单位不同是历史原因
   * （全局配置先有，而它按秒更易读）。这里显式换算，免得差 1000 倍。
   */
  function sleepAfterMs() {
    const fromSchedule = Number(scheduler.get('sleep').afterMs);
    if (Number.isFinite(fromSchedule) && fromSchedule > 0) return fromSchedule;
    return Math.max(10, Number(config.sleepAfter) || 120) * 1000;
  }

  /**
   * 现在能让它睡吗？
   *
   * 与 `roamTriggerEnabled()` 同源（闲着、没被占用），但**允许 WALK**：
   * 走到一半到点了也该睡（与早先那条 rAF 轮询的判定保持一致，
   * 它接受 IDLE 或 WALK）。
   */
  function sleepTriggerEnabled() {
    return !reducedMotion
      && !disposed
      && !throttle.paused
      && (machine.state === STATES.IDLE || machine.state === STATES.WALK)
      && !idleBurst
      && gesture.phase === 'done'
      && !physics.dragging
      && physics.grounded;
  }

  /** 清掉待执行的打盹判定（任何交互 / 状态变化都要调）。 */
  function cancelSleepWake() {
    if (sleepWakeTimer) {
      clearTimeout(sleepWakeTimer);
      sleepWakeTimer = 0;
    }
  }

  /**
   * 排一次「到点就睡」的定时器。
   *
   * 每次都是按**当前**的 `lastInteractionAt` 重新算剩余时间，因此
   * 任何交互（`noteInteraction()`）之后调它都会正确地重新计时。
   */
  function scheduleSleepWake() {
    cancelSleepWake();
    if (!sleepTriggerEnabled()) return;
    const remaining = sleepAfterMs() - (performance.now() - lastInteractionAt);
    sleepWakeTimer = setTimeout(() => {
      sleepWakeTimer = 0;
      // 到点时再确认一次：等待期间用户可能把它拖走了 / 让它做了别的动作
      if (!sleepTriggerEnabled()) return;
      // 期间有过交互（阈值被重置了）→ 重新计时，而不是照着旧的时间睡
      if (performance.now() - lastInteractionAt < sleepAfterMs()) {
        scheduleSleepWake();
        return;
      }
      physics.stopWalking();
      // `machine.sleep()` 会触发 `onStateEnter`，排期在那里被清掉——
      // 睡着之后不该再有任何触发等着执行。
      machine.sleep({ now: performance.now() });
      wake();
    }, Math.max(250, Math.round(remaining)));
  }

  /**
   * 记一次「用户碰过它」并重新排打盹判定。
   *
   * 所有更新 `lastInteractionAt` 的地方都要走这里：漏掉任何一处，
   * 那条路径上的交互就不会把打盹计时推后——表现为「刚点完它，
   * 过一会儿它还是按原来的时间睡着了」。
   */
  function noteInteraction() {
    lastInteractionAt = performance.now();
    scheduleSleepWake();
  }

  // -------------------------------------------------------- idle 随机触发
  //
  // 用**定时器**而不是靠 rAF 计时，原因很直接：`random` 模式下平时是静止画面，
  // rAF 循环**已经停了**（这正是省电的落点）。若把倒计时放在 rAF 里推进，
  // 它永远不会前进，idle 动画就再也触发不了。
  //
  // 因此这里的分工是：
  // - 平时：无 rAF、只有一个 `setTimeout` 等着；
  // - 到点：`startIdleBurst()` 唤醒 rAF 播一遍；
  // - 播完：`finishIdleBurst()` 回到静止帧并重新排下一次。

  /**
   * 现在**允许**安排一次 idle 小动作吗？
   *
   * 条件收得很紧，任何一条不满足就不排期。这不只是「省事」——
   * 它同时保证了**不影响 sleep**：睡着之后状态不是 idle，排期自然为空。
   */
  function idleTriggerEnabled() {
    return !reducedMotion
      && !idleLoops
      && !disposed
      && !throttle.paused
      && machine.state === STATES.IDLE
      && !idleBurst
      && gesture.phase === 'done'
      && !physics.dragging
      // 必须**站在地上**才谈得上「闲着动一下」。
      //
      // 少了这一条时，点击后的小弹跳（`handleClick()` 给了一个上抛初速度，
      // 而它刻意不进 `fall` 态）会让宠物在**空中**满足「idle 且无占用」，
      // 于是排下一次小动作——弹跳只有 0.3 秒，排期是 6~18 秒，
      // 通常赶不上；但只要系统卡一下（或动画速度调到 4×）就会撞上，
      // 表现为「点一下它，它跳起来的时候突然播待机动画」。
      && physics.grounded;
  }

  /** 清掉待执行的 idle 触发（任何交互 / 状态变化都要调）。 */
  function cancelIdleWake() {
    // 调度器本身是无状态的（只负责抽随机间隔），因此要清的只有定时器。
    if (idleWakeTimer) {
      clearTimeout(idleWakeTimer);
      idleWakeTimer = 0;
    }
  }

  /**
   * 排下一次 idle 触发。
   *
   * 每次都是**重新抽**一个随机间隔（而不是固定周期），这样看起来才像
   * 「它自己想动一下」，而不是一台节拍器。
   */
  function scheduleIdleWake() {
    cancelIdleWake();
    if (!idleTriggerEnabled()) return;
    const seconds = scheduler.reschedule('idle');
    idleWakeTimer = setTimeout(() => {
      idleWakeTimer = 0;
      // 到点时再确认一次：等待期间用户可能已经把它拖走了 / 让它睡了
      if (!idleTriggerEnabled()) return;
      startIdleBurst();
    }, Math.max(250, Math.round(seconds * 1000)));
  }

  /**
   * 现在能安排一次自动漫游吗？
   *
   * 条件与 `idleTriggerEnabled()` 同源（都是「闲着、站在地上、没被占用」），
   * 但多一条 `config.autoRoam`——漫游是**用户可选**的，idle 小动作不是。
   *
   * 两条互不排斥：idle 触发正在播时**不**排漫游（`!idleBurst`），
   * 否则会出现「小动作播到一半突然开始走路」。
   */
  function roamTriggerEnabled() {
    return config.autoRoam
      && !reducedMotion
      && !disposed
      && !throttle.paused
      && machine.state === STATES.IDLE
      && !idleBurst
      && gesture.phase === 'done'
      && !physics.dragging
      && physics.grounded;
  }

  /** 清掉待执行的漫游（任何交互 / 状态变化都要调）。 */
  function cancelRoamWake() {
    if (roamWakeTimer) {
      clearTimeout(roamWakeTimer);
      roamWakeTimer = 0;
    }
    roamDeadline = 0;
  }

  /**
   * 排下一次自动漫游。
   *
   * ★ 走 `setTimeout` 而**不是**在 rAF 里倒数——理由见 `roamWakeTimer` 的注释：
   * rAF 在 idle 静止时是停的，挂在它上面的倒计时永远不前进。
   *
   * 每次重新抽一个随机间隔（与 idle 同理）：固定周期看起来像节拍器，
   * 而「它自己想走一趟」才像活着。
   */
  function scheduleRoamWake() {
    cancelRoamWake();
    if (!roamTriggerEnabled()) return;
    const seconds = scheduler.reschedule('roam');
    roamIntervalMs = Math.max(250, Math.round(seconds * 1000));
    roamDeadline = Date.now() + roamIntervalMs;
    roamWakeTimer = setTimeout(() => {
      roamWakeTimer = 0;
      roamDeadline = 0;
      // 到点时再确认一次：等待期间用户可能已经把它拖走了 / 让它睡了 /
      // 关掉了自动漫游
      if (roamTriggerEnabled()) {
        scheduleWalk();
        return;
      }
      // 没触发时**分两种情况**——这个区分很重要：
      //
      // - 还在 idle：说明只是被**瞬时**原因挡住（手势没结束、小动作正在播）。
      //   这种阻塞没有状态迁移，因此没有人会来重排——不补的话这一趟就
      //   永远丢了（早先 idle 那条路径踩过同样的坑，见 `wasAirborne`）。
      // - 已经不在 idle（睡着 / 被拖走 / 正在走）：**不排**。
      //   那些路径回到 idle 时都会走 `onStateEnter`，由它重排；
      //   在这里也排一份会让「睡着时还挂着一个定时器」白耗。
      if (machine.state === STATES.IDLE && config.autoRoam
          && !reducedMotion && !throttle.paused && !disposed) {
        scheduleRoamWake();
      }
    }, roamIntervalMs);
  }

  /** 距离下一次漫游还有多少毫秒（诊断/测试用；没排期时返回 `null`）。 */
  function roamCountdown() {
    return roamDeadline ? Math.max(0, roamDeadline - Date.now()) : null;
  }

  /** 播一次 idle 小动作（随机抽一套变体）。 */
  function startIdleBurst() {
    const spec = actionSpec('idle');
    if (!spec) return;
    // `idleBurst` 必须在 `setAction` **之前**置位：`setAction` 在 idle 上会
    // 把 sprite 画成标准图像（那是「平时」的样子），而这次是**要播动画**。
    // 顺序反了的表现是「触发之后仍然停在标准图像上」，看起来像没触发。
    idleBurst = true;
    // 换一套变体：`force` 让「同一动作重播」也能生效，
    // 否则抽到另一套时 `setAction` 会因为名字没变而直接返回。
    setAction('idle', { force: true });
    // 只播一轮：idle 的变体在包里通常声明 `loop: true`（它是待机循环），
    // 但「随机触发」的语义是「播一遍就停」，因此这里显式改成不循环，
    // 让时钟在末帧 `finished`，由 `finishIdleBurst` 收尾。
    if (currentVariant) {
      clock.setSpec({
        frames: currentVariant.frames,
        fps: currentVariant.fps,
        loop: false,
        frameMs: currentVariant.frameMs,
      });
    }
    wake();
    // 兜底：单帧变体（`frames <= 1`）的时钟永远不会 finished，
    // 那时靠这个定时器收尾，否则 `idleBurst` 会永远为真、rAF 永不停。
    const duration = actionDurationMs('idle', 600);
    clearTimeout(actionTimer);
    actionTimer = setTimeout(() => {
      if (idleBurst) finishIdleBurst();
    }, duration);
  }

  /** 结束一次 idle 小动作：回到标准图像，并排下一次。 */
  function finishIdleBurst() {
    if (!idleBurst) return;
    idleBurst = false;
    clearTimeout(actionTimer);
    actionTimer = 0;
    // 回到**标准图像**（而不是「当前变体的第 0 帧」）。
    //
    // 这一处是本轮修的核心：旧实现保留刚播过的变体，于是随机播到「张望」
    // 之后，宠物会一直卡在抬头姿势上——用户报的「一直卡在这帧看起来怪怪的」
    // 就是这个。标准图像与「这次抽到哪一套」无关，因此不会出现这种事。
    clock.setSpec({ frames: 1, fps: 1, loop: true });
    drawStill();
    scheduleIdleWake();
    // 一次 idle 小动作播完 → 回到「平时」。漫游的排期也要跟着重新开始：
    // 小动作期间 `roamTriggerEnabled()` 为假（`!idleBurst`），
    // 因此那段时间不会有漫游排期，这里不补的话就断了。
    scheduleRoamWake();
    // 打盹判定同理：小动作期间 `sleepTriggerEnabled()` 也为假。
    scheduleSleepWake();
    wake();
  }

  /**
   * 某个动作**实际会播多久**（毫秒，已含动画速度倍率）。
   *
   * 状态机用它来安排「播完回 idle」的定时器。**必须**和帧推进用同一套倍率，
   * 否则倍率大于 1 时动作会被定时器提前打断，看起来像「播到一半就切走了」。
   *
   * 对**正在播**的动作优先用 `currentVariant`：多套动画的时长可以差很多
   * （例如「被点击」有一套是短促的点头、另一套是慢慢的歪头），
   * 按 `variants[0]` 算会让后者的定时器提前把它掐掉。
   */
  function actionDurationMs(name, fallback) {
    let variant = null;
    if (name === currentAction && currentVariant) {
      variant = currentVariant;
    } else {
      const variants = playableVariants(actionSpec(name));
      variant = variants[0] || null;
    }
    const base = variant ? animationDuration(variant) : 0;
    const total = base > 0 ? base : fallback;
    return Math.max(60, total * currentSpeed());
  }

  function scheduleWalk() {
    // 间隔从**后端下发的节奏**里抽（默认 3~9 秒），不再是写死的
    // `3000 + random * 6000`——用户要求「支持调整触发时间」，
    // 而漫游正是除 idle 之外唯一由时间驱动的行为。
    //
    // 注意这里**只**负责「走这一趟」；下一趟的排期在 `stopWalk` 回到 idle
    // 时由 `onStateEnter` → `scheduleRoamWake()` 安排（那时才重新抽间隔）。
    const world = physics.bounds;
    walkTargetX = pickWalkTarget(world.width);
    const direction = walkTargetX > physics.x ? 1 : -1;
    // 先写方向，再进 WALK 态：`startWalk` 会触发 `applyActionForState`，
    // 那里要按方向选 `walk-left` / `walk-right`，顺序反了会播错一侧。
    walkDirection = direction;
    if (direction !== facing) facing = direction;
    physics.walk(direction);
    machine.startWalk({ now: performance.now() });
    wake();
  }

  /**
   * 抽一个**够得着**的漫游目标 x。
   *
   * ★ 必须按宠物的**半宽**收窄，不能直接用世界宽度。
   *
   * 早先的写法是 `40 + random * (width - 80)`，它假定宠物很窄。
   * 而物理层把 x 夹在 `[半宽, 世界宽 - 半宽]` 里（撞到侧壁时把水平速度清零），
   * 于是**目标落在夹取范围之外时宠物永远走不到**：
   *
   *   - 状态机退出 WALK 的条件是 `|x - walkTargetX| < 6`，走不到就永不退出；
   *   - `shouldKeepRunning()` 对 WALK 恒返回 true → **rAF 永远跑着**
   *     （省电契约被破坏）；
   *   - `roamTriggerEnabled()` 要求 `state === IDLE` → **漫游再也不触发**。
   *
   * 实测够不着的比例（世界宽 900，目标区间 [40, 860]）：
   *
   *   | 宠物宽度 | 半宽 | 够不着的目标 |
   *   |---|---|---|
   *   | 64px（像素猫） | 32 | 0% |
   *   | 173px（内置形象 0.45 倍） | 86.5 | **11.3%** |
   *   | 384px（1 倍） | 192 | **37.1%** |
   *   | 768px（2 倍） | 384 | **83.9%** |
   *
   * 也就是说**宠物越大越容易卡死**——而「放大宠物」正是用户最常调的一项。
   *
   * 这个 bug 一直被漫游本身的故障掩盖着：默认 idle 模式（`random`）下
   * 漫游倒计时挂在 rAF 上、永远不前进，所以漫游几乎不触发，也就很少卡。
   * 修好漫游之后它立刻暴露出来（验收里当场抓到 `state=walk` 且 `vx=0`）。
   *
   * 两侧各留一点余量（`WALK_TARGET_MARGIN`），免得目标正好压在墙上、
   * 因浮点误差在边界反复抖动。
   */
  function pickWalkTarget(worldWidth) {
    const half = Math.max(0, Number(physics.size && physics.size.width) || 0) / 2;
    const low = half + WALK_TARGET_MARGIN;
    const high = worldWidth - half - WALK_TARGET_MARGIN;
    if (!(high > low)) {
      // 宠物比屏幕还宽（或几乎一样宽）：走不动，就停在中间。
      // 不能返回一个够不着的目标——那正是上面那个卡死。
      return worldWidth / 2;
    }
    return low + Math.random() * (high - low);
  }

  // ------------------------------------------------------------ 指针交互

  function toLocal(event) {
    // 容器与视口同尺寸（inset: 0），因此 client 坐标就是世界坐标
    return { x: event.clientX, y: event.clientY };
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const point = toLocal(event);
    const now = event.timeStamp || performance.now();
    pointerId = event.pointerId;
    lastPointer = point;
    dragSamples = [{ x: point.x, y: point.y, t: now }];
    noteInteraction();
    // **不立刻进拖拽态**：先挂起，等「按住 0.5 秒」或「明显移动」再升级。
    // 这是「点击动画能单独触发」的关键（见 `gesture.js`）。
    gesture.begin(point.x, point.y, now);
    // 用户按住了：取消待执行的 idle 触发，免得它在这时候自己动一下
    cancelIdleWake();
    if (machine.state === STATES.SLEEP) machine.wake({ now: lastInteractionAt });
    try {
      root.setPointerCapture(pointerId);
    } catch {
      // 某些环境不支持指针捕获；不致命，继续用容器级监听
    }
    wake();
    event.preventDefault();
  }

  /** 把手势升级成真正的拖拽。 */
  function beginDrag(point) {
    machine.beginDrag({ now: performance.now() });
    physics.beginDrag(point.x, point.y);
    // 运动期间才加 will-change，停下就摘（常驻会占显存，§4.1）
    root.classList.add('is-moving');
    // 拎在手里时**不呼吸**：宠物被举着还在「喘气」很怪
    // （CSS 侧按这个类把 `animation-play-state` 设为 paused）。
    root.classList.add('is-held');
    wake();
  }

  function onPointerMove(event) {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const point = toLocal(event);
    const now = event.timeStamp || performance.now();
    lastPointer = point;
    dragSamples.push({ x: point.x, y: point.y, t: now });
    if (dragSamples.length > 24) dragSamples.shift();
    noteInteraction();

    if (gesture.move(point.x, point.y, now)) beginDrag(point);
    if (gesture.dragging) {
      physics.moveDrag(point.x, point.y);
      drawPosition();
    }
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
    const point = toLocal(event);
    const now = event.timeStamp || performance.now();
    const release = estimateReleaseVelocity(dragSamples);

    try {
      root.releasePointerCapture(pointerId);
    } catch {
      // 没捕获成功时无需释放
    }
    pointerId = null;
    dragSamples = [];
    noteInteraction();

    const outcome = gesture.end(point.x, point.y, now);
    lastPointer = null;
    root.classList.remove('is-moving');
    root.classList.remove('is-held');

    if (outcome.kind === 'click') {
      handleClick();
    } else {
      machine.release({ now: lastInteractionAt });
      physics.endDrag(release.vx * scale, release.vy * scale);
    }
    wake();
    event.preventDefault();
  }

  /**
   * 一次真正的「点击」。
   *
   * 旧实现里点击几乎触发不到（拖拽抢走了所有按下），现在手势层先把两者分开，
   * 这里就只管播 `click` 动作 + 一个小弹跳作为反馈。
   *
   * 顺序与旧实现一致（`settle` → `react('click')` → 给一个上抛初速度），
   * 只是多了「清掉 idle 排期」：用户刚点过它，不该马上又自己动一下。
   */
  function handleClick() {
    physics.endDrag(0, 0);
    machine.settle({ now: lastInteractionAt });
    cancelIdleWake();
    if (actionSpec('click')) {
      machine.react('click', { now: lastInteractionAt });
      scheduleReactionEnd('click', 200);
    }
    // 点击后稍微弹一下，是有反馈感的最小代价。
    //
    // 注意这里**不**切到 `fall` 态：`react` 态到 `fall` 不在迁移表里，
    // 那次 `go()` 会被拒绝（旧实现也是如此）。物理照常推进，因此
    // 「弹一下」的观感不变，而状态仍是 `react`——这样点击动画能完整播完，
    // 落回地面也不会把 `land` 插进来打断它。
    physics.setVelocity(0, CLICK_HOP_VELOCITY);
  }

  function onContextMenu(event) {
    // 右键交给插件的设置入口（宿主菜单会处理；这里只避免拖动被打断）
    event.preventDefault();
    safeHook(hooks.onContextMenu, event);
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('contextmenu', onContextMenu);

  // ------------------------------------------------------------ 尺寸变化

  let resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = window.requestAnimationFrame(() => {
      resizeRaf = 0;
      // 重算地面与边界：宠物不能跑到屏幕外（阶段 3 验收）
      physics.setBounds(bounds());
      physics.setSize({ width, height });
      drawPosition();
      // 视口变小时重新评估降频
      applyThrottle(hostState);
      wake();
    });
  }
  window.addEventListener('resize', onResize);

  // ------------------------------------------------------------ 宿主状态

  /**
   * 消费宿主状态（§2.3），驱动 §4.5 的省电表。
   *
   * `reducedMotion` 是**停**不是降速：它会让 `decideThrottle` 返回 paused，
   * 于是循环真的停下来，只留一帧静息图。
   */
  function applyThrottle(state) {
    hostState = state || {};
    const previous = throttle;
    throttle = decideThrottle(hostState, {
      viewportWidth: window.innerWidth || 0,
      narrowWidth: 900,
    });
    // 宿主的 reducedMotion 是权威来源（它会随系统设置变化立即推送）。
    // 同时也尊重构造时传入的初值（宿主状态还没到之前就得停）。
    reducedMotion = hostState.reducedMotion === true
      ? true
      : (hostState.reducedMotion === false ? false : reducedMotion);
    if (!reducedMotion) {
      // 恢复动效时清掉「停不下来」的标记（它只是排查用的线索）
      delete root.dataset.petAnimatedUnstoppable;
    }
    root.classList.toggle('is-throttled', throttle.rate < 1 && !throttle.paused);
    root.classList.toggle('is-static-motion', reducedMotion);
    root.dataset.petThrottle = throttle.reason || 'none';
    root.dataset.petAnimSpeed = String(currentSpeed());

    if (throttle.paused) {
      // 停绘：取消所有待执行的循环与定时器，只留一帧静息图
      stopLoop();
      clearTimeout(actionTimer);
      actionTimer = 0;
      cancelIdleWake();
      if (reducedMotion) {
        // reducedMotion 的语义是「关掉循环帧动画」而不是降速（§4.5 / §8 陷阱 13）：
        // 把帧定在第 0 帧，并摘掉 will-change（不再有运动）
        clock.reset();
        drawFrame();
        root.classList.remove('is-moving');
        // ⚠️ **动图容器停不下来**：`clock.reset()` 只能把我们自己的帧推进
        // 归零，而 GIF / 动图 WebP 是浏览器在播——没有 CSS 能暂停它。
        // 因此这里换成**标准图像**（一张静态图）来兑现 reducedMotion 的承诺。
        // 作者没提供静态标准图像时只能保留动图，此时把原因挂到 dataset 上
        // 供排查（而不是假装已经停住了）。
        if (currentVariant && currentVariant.animated) {
          if (still && !still.animated) {
            drawStill();
          } else {
            root.dataset.petAnimatedUnstoppable = 'true';
          }
        }
      }
      return;
    }
    if (previous.paused || previous.rate !== throttle.rate) {
      // 重新起跳：不让暂停期间的时间一次性补进物理
      lastFrameAt = 0;
      wake();
      // 从暂停里恢复时重排 idle（暂停期间排期已被清掉）
      scheduleIdleWake();
      // 漫游同理：暂停期间 `roamTriggerEnabled()` 为假，排期也已被清掉
      scheduleRoamWake();
      scheduleSleepWake();
    }
  }

  /**
   * 安排一次播报动作的结束（播完回 idle）。
   *
   * `action` 给了就按它的实际时长（含动画速度倍率），否则用 `fallback`。
   */
  function scheduleReactionEnd(action, fallback = 700) {
    const duration = actionDurationMs(action, fallback);
    clearTimeout(actionTimer);
    actionTimer = setTimeout(() => {
      const pending = machine.takePendingReaction();
      if (pending) {
        machine.react(pending, { now: performance.now() });
        scheduleReactionEnd(pending);
      } else {
        machine.settle({ now: performance.now() });
        // 播报结束、回到 idle：重新排一次随机小动作
        scheduleIdleWake();
        // 漫游同样要重排（播报期间状态不是 idle，排期已被清掉）
        scheduleRoamWake();
        // 打盹判定同理
        scheduleSleepWake();
      }
      wake();
    }, Math.max(300, duration));
  }

  /** 收到核心事件 → 播报（限流由调用方负责）。 */
  function react(action) {
    noteInteraction();
    cancelIdleWake();
    if (machine.state === STATES.SLEEP) {
      // sleep 期间收到事件要唤醒（§4.3 硬要求）
      machine.wake({ now: lastInteractionAt });
    }
    const normalized = action || 'happy';
    if (machine.react(normalized, { now: lastInteractionAt })) {
      scheduleReactionEnd(normalized);
      wake();
    }
  }

  /** 任意用户输入都算「互动」，重置打盹计时。 */
  function touch() {
    noteInteraction();
    cancelIdleWake();
    if (machine.state === STATES.SLEEP) {
      machine.wake({ now: lastInteractionAt });
      setAction('idle', { force: true });
      wake();
    }
  }

  // ---------------------------------------------------------------- 启动

  noteInteraction();
  machine.setNow(lastInteractionAt);
  applyFacing();
  // 时间驱动的节奏来自后端的 `schedule` 块（用户设置 > 包内声明 > 默认，
  // 后端已经算好）。前端不自己写一份默认值——两边不一致时表现为「设了却不生效」。
  scheduler.setSchedule(pack.schedule);
  idleLoops = scheduler.get('idle').mode === 'loop';
  setAction('idle', { force: true });
  drawPosition();
  // 起始位置：站在地面
  physics.setPosition(initialBounds.width * 0.5, initialBounds.height);
  drawPosition();
  // 起手就排一次：宠物出现后过一段随机时间自己动一下，而不是永远僵着。
  // 自动漫游（`autoRoam`）与它是两条独立的路子，因此这里不互斥。
  //
  // 漫游同样要起手排一次。注意**不能**像早先那样给一个写死的 `walkTimer = 2000`
  // ——那个倒计时挂在 rAF 上，而 rAF 在 idle 静止时是停的（见 `roamWakeTimer`）。
  scheduleIdleWake();
  scheduleRoamWake();
  // 打盹判定同样起手排一次：否则「宠物出现后一直没人碰它」这条最常见的
  // 路径上它永远不会睡（早先的判定只挂在 rAF 上，见 `sleepWakeTimer`）。
  scheduleSleepWake();

  /**
   * 触发一次随机 idle 小动作。
   *
   * 用于「让它现在就动一下」这类外部触发（诊断句柄 / 预览）；
   * 内部的定时触发走 `scheduleIdleWake`。
   */
  function pokeIdle() {
    if (machine.state !== STATES.IDLE || idleLoops || idleBurst) return false;
    startIdleBurst();
    return true;
  }

  return {
    element: root,
    machine,
    physics,
    get state() { return machine.state; },
    get action() { return currentAction; },
    get running() { return running; },
    get throttleReason() { return throttle.reason; },
    get reducedMotion() { return reducedMotion; },
    /** 当前生效的大小倍率与单帧尺寸（验收脚本与排查用）。 */
    get scale() { return scale; },
    get size() { return { width, height }; },
    get pixelated() { return root.dataset.petPixelated === 'true'; },
    /** 当前动画速度倍率（越大越慢）。 */
    get animSpeed() { return animSpeed; },
    /** 当前选中的变体下标（多套动画时有用）。 */
    get variantIndex() { return Number(root.dataset.petVariant || -1); },
    /**
     * 多页 sheet 的播放状态（验收脚本与排查用）。
     *
     * 暴露 `page` 是必要的：多页切帧的结果是**渲染结果**，
     * 源码里看不出「现在铺的是哪一页」——没有这个值就只能靠量像素去猜。
     */
    get page() { return currentPage; },
    get pageCount() {
      return currentVariant ? framePageCount(currentVariant) : 1;
    },
    /** idle 是否正在播一次随机小动作。 */
    get idleBursting() { return idleBurst; },
    /** 手势阶段（排查「点击没反应 / 一碰就飞」用）。 */
    get gesturePhase() { return gesture.phase; },
    /** 当前生效的 idle 触发模式。 */
    get idleMode() { return idleLoops ? 'loop' : 'random'; },
    /**
     * 标准图像的元信息（验收脚本与排查用）。
     *
     * 暴露它是为了能验证「不播动画时画的是标准图像，而不是上一次抽到的变体」
     * 这条判定——那是本轮修的核心问题，而它是**渲染结果**，源码里看不出来。
     */
    get still() {
      if (!still) return null;
      return {
        url: still.url,
        frames: still.frames,
        frame: still.frame,
        layout: still.layout,
        // 网格几何也暴露出来：标准图像取错帧（网格 sheet 被当成单行切）时，
        // 界面「看着有图」，只是显示的是另一帧——没有这两个值就只能靠数像素去猜。
        cols: frameGrid(still).cols,
        rows: frameGrid(still).rows,
        declared: still.declared,
        source: still.source,
        // 标准图像自己的单帧尺寸（`undefined` = 沿用包级）。
        // 暴露它是为了可诊断：几何算错时界面「看着有图」，只是显示的是
        // 被拉伸的那一张——没有这个值就只能靠量像素去猜。
        size: still.size,
        /** 当前 sprite 上的背景图是否就是标准图像。 */
        showing: sprite.style.backgroundImage.includes(still.url),
      };
    },
    /** 当前生效的**触发节奏**（idle 小动作 / 自动漫游 / 打盹阈值）。 */
    get schedule() {
      return {
        idle: scheduler.get('idle'),
        roam: scheduler.get('roam'),
        // 打盹是**阈值**（`afterMs`），形状与上面两个不同。
        // 漏掉它的后果是排查时看不到「打盹阈值到底是多少」——
        // 而这正是「它怎么不睡 / 怎么睡了」唯一的观测量。
        sleep: scheduler.get('sleep'),
      };
    },
    /**
     * 就地更新触发节奏（用户在面板上拖完滑块立即生效，不必刷新页面）。
     *
     * 与 `scale` 不同，节奏**不需要重建视图**：它只影响两个定时器的下次取值。
     * 改完之后要**重排**当前等待中的那个定时器——否则用户把间隔从 18 秒
     * 调到 2 秒，还得先等完那 18 秒才看到效果，看起来像没生效。
     *
     * 重排的方式是**按新区间重新抽一次**，而不是把定时器清零：
     * 清零会让宠物**立刻**开始走动（间隔是「随机区间」，不是「还剩多久」），
     * 那既不符合用户的预期，也把「闲置一会儿才溜达」这个观感弄没了。
     */
    setSchedule(schedule) {
      scheduler.setSchedule(schedule);
      idleLoops = scheduler.get('idle').mode === 'loop';
      if (machine.state === STATES.IDLE && !idleBurst) {
        cancelIdleWake();
        if (idleLoops) {
          // 切到 loop 模式：立刻开始循环播待机动画
          setAction('idle', { force: true });
          clock.setSpec({
            frames: currentVariant ? currentVariant.frames : 1,
            fps: currentVariant ? currentVariant.fps : 1,
            loop: true,
            frameMs: currentVariant ? currentVariant.frameMs : [],
          });
          wake();
        } else {
          // 切回 random 模式：回到标准图像，并按新间隔重排
          drawStill();
          scheduleIdleWake();
          wake();
        }
      }
      // 漫游的下一次间隔同样按新值重抽（见上面「为什么不是清零」）。
      // 必须**重排定时器**而不是只改一个倒计时变量——后者挂在 rAF 上，
      // 而 rAF 在 idle 静止时是停的。
      if (machine.state === STATES.IDLE) {
        scheduleRoamWake();
        // 打盹阈值也可能刚被改（面板上就是同一个接口），要按新值重排。
        scheduleSleepWake();
      }
      return this;
    },
    setConfig(next = {}) {
      Object.assign(config, next);
      // 渲染方式可以**就地**改：只是换一条 CSS 规则，不涉及几何，
      // 因此不必重建视图（重建会丢掉「正在被拖动」这类瞬时状态）。
      if ('pixelated' in next) {
        const flag = next.pixelated === true;
        root.dataset.petPixelated = flag ? 'true' : 'false';
      }
      // 动画速度倍率同样可以就地改：它只影响帧推进的折算。
      if ('animSpeed' in next) {
        animSpeed = clamp(
          Number(next.animSpeed) || 1, ANIM_SPEED_MIN, ANIM_SPEED_MAX,
        );
        root.dataset.petAnimSpeed = String(currentSpeed());
        wake();
      }
      // `scale` **不**在这里处理：它会改包围盒尺寸，进而影响物理与切帧几何，
      // 必须重建视图（由 `plugin.js` 的 `applyPack` 负责，并保留当前位置）。
      //
      // `autoRoam` 要就地生效：关掉时**立刻**撤掉待执行的那一趟
      // （否则用户关掉「自动漫游」之后它还会走一趟，看起来像没生效）；
      // 打开时补排一次。
      if ('autoRoam' in next) {
        if (config.autoRoam) {
          scheduleRoamWake();
        } else {
          cancelRoamWake();
        }
      }
      return this;
    },
    applyThrottle,
    react,
    touch,
    wake,
    pokeIdle,
    /** 立刻触发一次自动漫游（测试/排查用，等价于「这一趟到点了」）。 */
    pokeRoam: scheduleWalk,
    /** 距离下一次自动漫游还有多少毫秒（没排期时为 `null`）。 */
    roamCountdown,
    /** 当前漫游节奏（`{minMs, maxMs}`，来自后端下发的 `schedule`）。 */
    roamSchedule: () => scheduler.get('roam'),
    dispose() {
      disposed = true;
      stopLoop();
      clearTimeout(actionTimer);
      // 眨眼定时器必须回收：它**独立于 rAF**（静止时 rAF 是停着的，
      // 而眨眼照跑），漏掉的话视图销毁后定时器还在触发——每眨一次
      // 都会去写一个已经摘掉的 DOM 节点，并且不断自我重排。
      clearTimeout(blinkTimer);
      blinkTimer = 0;
      cancelIdleWake();
      // 漫游定时器同样要回收：它**独立于 rAF**（静止时 rAF 是停着的，
      // 而漫游照排），漏掉的话视图销毁后它还会触发一次 `scheduleWalk()`
      // ——去操作一个已经摘掉的节点。
      cancelRoamWake();
      // 打盹定时器同理：它也会在视图销毁后触发 `machine.sleep()`。
      cancelSleepWake();
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      window.removeEventListener('resize', onResize);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('pointercancel', onPointerUp);
      root.removeEventListener('contextmenu', onContextMenu);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
