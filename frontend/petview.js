/**
 * 宠物视图：把纯逻辑层（时钟 / 物理 / 状态机）接到真实 DOM 上。
 *
 * 这是**唯一**碰 DOM 的模块。所有判定（该不该降频、能不能停 rAF、
 * 状态迁移是否合法）都在纯逻辑层做，这里只负责：
 * 1. 建元素、按帧写 `transform` / `background-position`；
 * 2. 把宿主事件翻译成逻辑层的调用；
 * 3. 一个 rAF 循环驱动一切（§4.2），并在该停的时候**真的停**。
 *
 * 关键约束（§2.1 / §0 判定标准）：
 * - **不自绘 `position: fixed` 浮层**——容器由宿主的 ambient surface 提供；
 * - 宠物元素用 `position: absolute` + `transform: translate3d()` 定位；
 * - 容器整体 `pointer-events: none`，宠物自己必须显式取回 `auto`。
 */

import { createFrameClock, createIdleGate, decideThrottle } from './clock.js';
import { createPhysics, estimateReleaseVelocity } from './physics.js';
import { createStateMachine, STATES } from './statemachine.js';

/** 指针采样窗口（毫秒），用于估算甩出速度。 */
const POINTER_SAMPLE_WINDOW = 120;

/** 打盹判定轮询间隔（毫秒）——低频，不需要每帧查。 */
const SLEEP_CHECK_INTERVAL = 1000;

/** 点击与拖拽的判别阈值（像素）。 */
const CLICK_SLOP = 5;

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
  }, options.config || {});

  const actions = pack.actions || {};
  const baseSize = pack.size || { w: 64, h: 64 };
  const scale = clamp(Number(config.scale) || 1, 0.5, 3);
  const width = Math.max(8, Math.round(baseSize.w * scale));
  const height = Math.max(8, Math.round(baseSize.h * scale));
  const anchorX = Number(pack.anchor?.x ?? 0.5);
  const anchorY = Number(pack.anchor?.y ?? 1);

  // ---------------------------------------------------------------- DOM

  const root = document.createElement('div');
  root.className = 'pet-root plugin-stm-pet';
  root.dataset.plugin = 'stm-pet';
  // `pointer-events` 是继承属性，容器整体是 none，必须显式取回（§8 陷阱 1）
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
  root.style.transform = 'translate3d(0px, 0px, 0)';

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
    },
  });

  const clock = createFrameClock({ frames: 1, fps: 6, loop: true });
  const gate = createIdleGate();

  let currentAction = 'idle';
  let rafId = 0;
  let running = false;
  let lastFrameAt = 0;
  let lastFrameTime = 0;
  let lastSleepCheck = 0;
  let lastInteractionAt = 0;
  let hostState = {};
  let throttle = { paused: false, rate: 1, reason: '' };
  let reducedMotion = Boolean(config.reducedMotion);
  let disposed = false;
  let facing = 1;
  let dragSamples = [];
  let pointerId = null;
  let dragStart = null;
  let walkTimer = 0;
  let walkTargetX = 0;
  /** 累积的「这段时间该走多少像素」——按帧率无关的方式推进漫游。 */
  let frameAccumulator = 0;

  // ---------------------------------------------------------------- 绘制

  /** 取某动作的解析结果（后端已算好回退链，这里只取用）。 */
  function actionSpec(name) {
    return actions[name] || null;
  }

  function applyActionForState() {
    const state = machine.state;
    let name = machine.action;
    if (state === STATES.WALK) name = 'walk';
    else if (state === STATES.DRAG) name = 'drag';
    else if (state === STATES.FALL) name = 'fall';
    else if (state === STATES.LAND) name = 'land';
    else if (state === STATES.SLEEP) name = 'sleep';
    else if (state === STATES.REACT) name = machine.action;
    else name = 'idle';
    setAction(name);
  }

  /**
   * 切换动作。
   *
   * 后端已经把回退链算完（`kind` / `sheet` / `frames` / `url`），
   * 这里只做「能不能播帧」的判定：`static` 只位移不播帧（§3.3 的降级语义）。
   */
  function setAction(name, { force = false } = {}) {
    const next = String(name || 'idle');
    if (!force && next === currentAction) return;
    const spec = actionSpec(next) || actionSpec('idle');
    currentAction = next;

    const animated = spec && spec.kind === 'animated' && spec.url && Number(spec.frames) > 1;
    root.dataset.petAction = next;

    if (spec && spec.url) {
      // spritesheet + background-position：换帧只改绘制，不走网络与解码（§2.5）
      const frameW = spec.layout === 'vertical' ? width : width * Number(spec.frames || 1);
      const frameH = spec.layout === 'vertical' ? height * Number(spec.frames || 1) : height;
      sprite.style.backgroundImage = `url("${spec.url}")`;
      sprite.style.backgroundSize = `${frameW}px ${frameH}px`;
      sprite.style.backgroundRepeat = 'no-repeat';
    } else {
      sprite.style.backgroundImage = 'none';
    }

    if (animated) {
      clock.setSpec({ frames: spec.frames, fps: spec.fps, loop: spec.loop !== false });
      drawFrame();
    } else {
      // 单帧 / 静态：停在这一帧，不推进
      clock.setSpec({ frames: 1, fps: 1, loop: true });
      drawFrame();
    }
    wake();
  }

  /** 把当前帧写进 `background-position`（只改绘制，不触发 layout）。 */
  function drawFrame() {
    const spec = actionSpec(currentAction) || actionSpec('idle');
    if (!spec || !spec.url) {
      sprite.style.backgroundPosition = '0 0';
      return;
    }
    const index = clock.frames > 1 ? clock.index : 0;
    if (spec.layout === 'vertical') {
      sprite.style.backgroundPosition = `0 ${-index * height}px`;
    } else {
      sprite.style.backgroundPosition = `${-index * width}px 0`;
    }
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

  function applyFacing() {
    sprite.style.transform = facing < 0 ? 'scaleX(-1)' : '';
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

    // 2) 状态迁移
    updateStateFromPhysics(dt, now);

    // 3) 帧推进（按 throttle 降频）
    //    `paused`（页面不可见 / reducedMotion）时循环根本不会跑，这里不必再判。
    if (dt > 0) {
      frameAccumulator += dt * throttle.rate;
      // 一帧最多推进 0.25 秒的动画时间，避免切后台回来一次跳很多帧
      const advance = Math.min(frameAccumulator, 0.25);
      frameAccumulator -= advance;
      if (clock.frames > 1) {
        const steps = clock.advance(advance);
        if (steps > 0) drawFrame();
      }
    }

    // 4) 写 DOM
    if (moved > 0.01 || dragSamples.length) drawPosition();

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
    if (physics.dragging) return true;
    if (machine.state === STATES.FALL || machine.state === STATES.WALK) return true;
    if (machine.state === STATES.REACT || machine.state === STATES.LAND) {
      // 一次性动作：播完就停
      return !clock.finished;
    }
    // idle / sleep：有多帧循环动画在播就继续——这是宠物「活着」的唯一视觉信号，
    // 停掉它就等于宠物变成一张静止贴图（sleep 的呼吸/呼噜同理）。
    // 帧率由包声明的 fps 决定（默认形象 idle 是 6fps），因此这里的开销很低。
    if (clock.frames > 1 && clock.loop) return true;
    // 单帧 / 静态形象：物理静止就**真的停掉 rAF**（省电，§4.2）
    return !physics.resting;
  }

  function updateStateFromPhysics(dt, now) {
    const state = machine.state;

    if (physics.justLanded && (state === STATES.FALL || state === STATES.DRAG)) {
      machine.land({ now });
      // 落地动作播完回 idle（一次性）
      const spec = actionSpec('land');
      const duration = spec && spec.frames > 1
        ? (spec.frames / Math.max(1, spec.fps)) * 1000
        : 180;
      clearTimeout(landTimer);
      landTimer = setTimeout(() => {
        const pending = machine.takePendingReaction();
        if (pending) {
          machine.react(pending, { now: performance.now() });
        } else {
          machine.settle({ now: performance.now() });
        }
        wake();
      }, duration);
      return;
    }

    if (state === STATES.WALK) {
      if (Math.abs(physics.x - walkTargetX) < 6) {
        physics.stopWalking();
        machine.stopWalk({ now });
      }
    }

    // 漫游调度
    if (state === STATES.IDLE && config.autoRoam && !reducedMotion) {
      walkTimer -= dt * 1000;
      if (walkTimer <= 0) scheduleWalk();
    }

    // 打盹判定（低频轮询，不必每帧算）
    if (!reducedMotion && now - lastSleepCheck > SLEEP_CHECK_INTERVAL) {
      lastSleepCheck = now;
      const idleFor = now - lastInteractionAt;
      if (idleFor > Math.max(10, Number(config.sleepAfter) || 120) * 1000
        && (state === STATES.IDLE || state === STATES.WALK)) {
        physics.stopWalking();
        machine.sleep({ now });
      }
    }
  }

  function scheduleWalk() {
    // 间隔带随机，看起来才像在"逛"而不是机械往返
    walkTimer = 3000 + Math.random() * 6000;
    const world = physics.bounds;
    walkTargetX = 40 + Math.random() * Math.max(1, world.width - 80);
    const direction = walkTargetX > physics.x ? 1 : -1;
    if (direction !== facing) {
      facing = direction;
      applyFacing();
    }
    physics.walk(direction);
    machine.startWalk({ now: performance.now() });
    wake();
  }

  let landTimer = 0;

  // ------------------------------------------------------------ 指针交互

  function toLocal(event) {
    // 容器与视口同尺寸（inset: 0），因此 client 坐标就是世界坐标
    return { x: event.clientX, y: event.clientY };
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const point = toLocal(event);
    pointerId = event.pointerId;
    dragSamples = [{ x: point.x, y: point.y, t: event.timeStamp || performance.now() }];
    dragStart = { x: point.x, y: point.y };
    lastInteractionAt = performance.now();

    machine.beginDrag({ now: lastInteractionAt });
    physics.beginDrag(point.x, point.y);
    // 运动期间才加 will-change，停下就摘（常驻会占显存，§4.1）
    root.classList.add('is-moving');
    try {
      root.setPointerCapture(pointerId);
    } catch {
      // 某些环境不支持指针捕获；不致命，继续用容器级监听
    }
    wake();
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const point = toLocal(event);
    physics.moveDrag(point.x, point.y);
    dragSamples.push({ x: point.x, y: point.y, t: event.timeStamp || performance.now() });
    if (dragSamples.length > 24) dragSamples.shift();
    lastInteractionAt = performance.now();
    drawPosition();
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
    const point = toLocal(event);
    const release = estimateReleaseVelocity(dragSamples);
    const travel = dragStart ? Math.hypot(point.x - dragStart.x, point.y - dragStart.y) : 0;

    try {
      root.releasePointerCapture(pointerId);
    } catch {
      // 没捕获成功时无需释放
    }
    pointerId = null;
    dragSamples = [];
    lastInteractionAt = performance.now();

    if (travel < CLICK_SLOP) {
      // 位移很小 → 当成点击：回 idle 并播 click 动作
      physics.endDrag(0, 0);
      machine.settle({ now: lastInteractionAt });
      if (actionSpec('click')) {
        machine.react('click', { now: lastInteractionAt });
        const spec = actionSpec('click');
        const duration = spec.frames > 1 ? (spec.frames / spec.fps) * 1000 : 200;
        clearTimeout(landTimer);
        landTimer = setTimeout(() => {
          machine.settle({ now: performance.now() });
          wake();
        }, duration);
      }
      // 点击后稍微弹一下，是有反馈感的最小代价
      physics.setVelocity(0, -260);
      machine.go(STATES.FALL, { reason: 'click-hop', now: lastInteractionAt });
    } else {
      machine.release({ now: lastInteractionAt });
      physics.endDrag(release.vx * scale, release.vy * scale);
    }
    root.classList.remove('is-moving');
    wake();
    event.preventDefault();
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
    root.classList.toggle('is-throttled', throttle.rate < 1 && !throttle.paused);
    root.classList.toggle('is-static-motion', reducedMotion);
    root.dataset.petThrottle = throttle.reason || 'none';

    if (throttle.paused) {
      // 停绘：取消所有待执行的循环与定时器，只留一帧静息图
      stopLoop();
      clearTimeout(landTimer);
      landTimer = 0;
      if (reducedMotion) {
        // reducedMotion 的语义是「关掉循环帧动画」而不是降速（§4.5 / §8 陷阱 13）：
        // 把帧定在第 0 帧，并摘掉 will-change（不再有运动）
        clock.reset();
        drawFrame();
        root.classList.remove('is-moving');
      }
      return;
    }
    if (previous.paused || previous.rate !== throttle.rate) {
      // 重新起跳：不让暂停期间的时间一次性补进物理
      lastFrameAt = 0;
      wake();
    }
  }

  /** 收到核心事件 → 播报（限流由调用方负责）。 */
  function react(action) {
    lastInteractionAt = performance.now();
    if (machine.state === STATES.SLEEP) {
      // sleep 期间收到事件要唤醒（§4.3 硬要求）
      machine.wake({ now: lastInteractionAt });
    }
    const normalized = action || 'happy';
    if (machine.react(normalized, { now: lastInteractionAt })) {
      const spec = actionSpec(normalized) || actionSpec('idle');
      const frames = Number(spec?.frames) || 1;
      const duration = frames > 1 ? (frames / Math.max(1, Number(spec?.fps) || 8)) * 1000 : 700;
      clearTimeout(landTimer);
      landTimer = setTimeout(() => {
        machine.settle({ now: performance.now() });
        wake();
      }, Math.max(300, duration));
      wake();
    }
  }

  /** 任意用户输入都算「互动」，重置打盹计时。 */
  function touch() {
    lastInteractionAt = performance.now();
    if (machine.state === STATES.SLEEP) {
      machine.wake({ now: lastInteractionAt });
      setAction('idle', { force: true });
      wake();
    }
  }

  // ---------------------------------------------------------------- 启动

  lastInteractionAt = performance.now();
  machine.setNow(lastInteractionAt);
  applyFacing();
  setAction('idle', { force: true });
  drawPosition();
  // 起始位置：站在地面
  physics.setPosition(initialBounds.width * 0.5, initialBounds.height);
  drawPosition();
  walkTimer = 2000;

  return {
    element: root,
    machine,
    physics,
    get state() { return machine.state; },
    get action() { return currentAction; },
    get running() { return running; },
    get throttleReason() { return throttle.reason; },
    get reducedMotion() { return reducedMotion; },
    setConfig(next = {}) {
      Object.assign(config, next);
      if ('scale' in next) {
        // 尺寸变化需要重建（简单起见由上层重建视图）
      }
      return this;
    },
    applyThrottle,
    react,
    touch,
    wake,
    dispose() {
      disposed = true;
      stopLoop();
      clearTimeout(landTimer);
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
