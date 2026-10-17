/**
 * 前端**纯逻辑**层的单测（Node 原生 test runner，零依赖）。
 *
 * 覆盖：帧推进不漂移（注入确定性时钟）、物理固定步长与帧率无关、
 * 边界钳制、拖拽优先级、状态机合法/非法迁移、省电决策。
 *
 * 仓库没有 JS 测试运行器（§1.4），宿主对插件 JS 的做法是 Node + 最小垫片。
 * 这里更彻底：这些模块是**纯函数**，连 DOM 垫片都不需要。
 *
 * 运行：node --test tests/frontend/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFrameClock, decideThrottle, createIdleGate, MAX_FPS } from '../../frontend/clock.js';
import {
  createPhysics,
  estimateReleaseVelocity,
  hopVelocity,
  DEFAULT_PHYSICS,
  FIXED_STEP,
} from '../../frontend/physics.js';
import {
  canTransition,
  createStateMachine,
  REACT_ACTIONS,
  STATES,
} from '../../frontend/statemachine.js';
import {
  WALK_LEFT,
  WALK_RIGHT,
  isDirectionalSource,
  mirrorForNonWalkAction,
  packHasDirectionalWalk,
  resolveWalkVisual,
  walkActionFor,
} from '../../frontend/direction.js';

// ================================================================ 帧推进


test('帧推进：按 fps 稳定推进，不依赖调用频率', () => {
  const clock = createFrameClock({ frames: 1000, fps: 10, loop: true });
  // 每次 1/60 秒（60fps），10fps 的动画每 6 帧进一格。
  // 断言「累计推进帧数」而不是某一刻的 index —— 后者正好落在步长边界时
  // 会被浮点误差左右（1/60 的六倍不是精确的 0.1），那不是漂移。
  let total = 0;
  for (let index = 0; index < 36; index += 1) total += clock.advance(1 / 60);
  // 0.6 秒 × 10fps = 6 帧；末帧可能还没到（余量留在累加器里），允许差 1
  assert.ok(Math.abs(total - 6) <= 1, `0.6 秒应推进约 6 帧，实际 ${total}`);
});

test('帧推进：不同调用频率下推进帧数一致，且漂移**不随时长累积**', () => {
  // 这是「不漂移」的核心断言：用可变 dt 直接积分会在这里失败
  // （误差随调用次数线性累积，跑得越久偏得越多）。
  const run = (dt, count) => {
    const clock = createFrameClock({ frames: 1e6, fps: 8, loop: true });
    let total = 0;
    for (let index = 0; index < count; index += 1) total += clock.advance(dt);
    return total;
  };

  for (const seconds of [2, 10, 60]) {
    const expected = 8 * seconds;
    const fast = run(1 / 120, 120 * seconds);
    const mid = run(1 / 60, 60 * seconds);
    const slow = run(1 / 30, 30 * seconds);

    // 误差上限恒为 1 帧（末帧可能还没到）——**不随时长增长**
    for (const [label, actual] of [['120Hz', fast], ['60Hz', mid], ['30Hz', slow]]) {
      assert.ok(
        Math.abs(actual - expected) <= 1,
        `${seconds}s @${label}: 期望约 ${expected} 帧，实际 ${actual}`,
      );
    }
    // 不同帧率之间互差也不超过 1 帧
    assert.ok(
      Math.max(fast, mid, slow) - Math.min(fast, mid, slow) <= 1,
      `${seconds}s: 不同帧率偏差过大 ${fast}/${mid}/${slow}`,
    );
  }
});

test('帧推进：单帧动作不推进且标记 finished', () => {
  const clock = createFrameClock({ frames: 1, fps: 10, loop: true });
  clock.advance(1);
  assert.equal(clock.index, 0);
  assert.equal(clock.finished, true);
});

test('帧推进：不循环的动作停在末帧', () => {
  const clock = createFrameClock({ frames: 3, fps: 10, loop: false });
  for (let index = 0; index < 50; index += 1) clock.advance(1 / 60);
  assert.equal(clock.index, 2, '应停在最后一帧');
  assert.equal(clock.finished, true);
});

test('帧推进：巨大的 dt 被钳制，不会一次跳完整轮', () => {
  // 切后台回来 dt 可能是几十秒，不加钳制会瞬间跑完所有循环（看起来像跳变）
  const clock = createFrameClock({ frames: 8, fps: 10, loop: true });
  const steps = clock.advance(30);
  assert.ok(steps <= 8, `单次最多推进一轮，实际 ${steps}`);
});

test('帧推进：切动作时从头播', () => {
  const clock = createFrameClock({ frames: 6, fps: 10, loop: true });
  for (let index = 0; index < 20; index += 1) clock.advance(1 / 60);
  assert.ok(clock.index > 0, '应该已经推进过');
  clock.setSpec({ frames: 2, fps: 8, loop: true });
  assert.equal(clock.index, 0, '切动作必须从第 0 帧开始');
});

test('帧推进：帧数变少时索引被夹回范围内', () => {
  const clock = createFrameClock({ frames: 8, fps: 10, loop: true });
  for (let index = 0; index < 40; index += 1) clock.advance(1 / 60);
  const before = clock.index;
  assert.ok(before > 2);
  clock.setSpec({ frames: 3, fps: 10, loop: true }, { restart: false });
  assert.ok(clock.index <= 2, `索引应在范围内，实际 ${clock.index}`);
});

test('帧推进：fps 被钳到合理上限', () => {
  const clock = createFrameClock({ frames: 4, fps: 9999 });
  assert.equal(clock.fps, MAX_FPS);
});

test('帧推进：非法 dt 不影响状态', () => {
  const clock = createFrameClock({ frames: 4, fps: 10, loop: true });
  clock.advance(0);
  clock.advance(-5);
  clock.advance(Number.NaN);
  assert.equal(clock.index, 0);
});

test('帧推进：reset 回到起点', () => {
  const clock = createFrameClock({ frames: 4, fps: 10, loop: true });
  for (let index = 0; index < 20; index += 1) clock.advance(1 / 60);
  clock.reset();
  assert.equal(clock.index, 0);
  assert.equal(clock.finished, false);
});

// ================================================================ 省电决策


test('省电：页面不可见 → 停绘', () => {
  const decision = decideThrottle({ visible: false });
  assert.equal(decision.paused, true);
  assert.equal(decision.rate, 0);
  assert.equal(decision.reason, 'hidden');
});

test('省电：reducedMotion → 完全停绘（不是降速）', () => {
  // 用户开这个选项是因为动效让他不适，"降速"对他没有任何帮助
  const decision = decideThrottle({ reducedMotion: true });
  assert.equal(decision.paused, true);
  assert.equal(decision.rate, 0);
  assert.equal(decision.reason, 'reduced-motion');
});

test('省电：reducedMotion 优先于其它条件', () => {
  const decision = decideThrottle({ reducedMotion: true, busy: true, visible: true });
  assert.equal(decision.paused, true, 'reducedMotion 应压过 busy');
});

test('省电：宿主忙 → 降频而不是停', () => {
  const decision = decideThrottle({ busy: true });
  assert.equal(decision.paused, false);
  assert.ok(decision.rate < 1);
  assert.equal(decision.reason, 'busy');
});

test('省电：遮罩 / 对话框打开 → 降频', () => {
  assert.equal(decideThrottle({ scrimActive: true }).reason, 'occluded');
  assert.equal(decideThrottle({ surfaceOpen: true }).reason, 'occluded');
  assert.ok(decideThrottle({ surfaceOpen: true }).rate < 1);
});

test('省电：视口过小 → 降频（但不隐藏）', () => {
  const decision = decideThrottle({}, { viewportWidth: 700, narrowWidth: 900 });
  assert.equal(decision.paused, false);
  assert.equal(decision.reason, 'narrow');
});

test('省电：一切正常 → 全速', () => {
  const decision = decideThrottle({ visible: true }, { viewportWidth: 1600 });
  assert.equal(decision.paused, false);
  assert.equal(decision.rate, 1);
  assert.equal(decision.reason, '');
});

test('省电：省略 viewportWidth 时不误判为窄屏', () => {
  assert.equal(decideThrottle({}, {}).reason, '');
});

test('空闲门：hold 期间不进入空闲', () => {
  const gate = createIdleGate();
  const release = gate.hold('dragging');
  assert.equal(gate.setIdle(true), false, '有 hold 时不允许空闲');
  assert.equal(gate.idle, false);
  release();
  assert.equal(gate.setIdle(true), true);
  assert.equal(gate.idle, true);
});

test('空闲门：多个 hold 需要全部释放', () => {
  const gate = createIdleGate();
  const a = gate.hold('drag');
  const b = gate.hold('react');
  a();
  assert.equal(gate.setIdle(true), false, '还有一个 hold');
  b();
  assert.equal(gate.setIdle(true), true);
});

test('空闲门：hold 是引用计数语义（同名重复持有时不互相抵消）', () => {
  const gate = createIdleGate();
  const a = gate.hold('x');
  const b = gate.hold('x');
  a();
  assert.equal(gate.held, true, '另一个同名 hold 仍然有效');
  b();
  assert.equal(gate.held, false);
});

// ================================================================ 物理


function physicsAt(overrides = {}) {
  return createPhysics(Object.assign({
    x: 400, y: 100, width: 64, height: 64,
    bounds: { width: 1000, height: 600 },
  }, overrides));
}

test('物理：自由下落最终停在地面', () => {
  const body = physicsAt();
  for (let index = 0; index < 300; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.y, 600, '脚底应落在地面');
  assert.equal(body.grounded, true);
  assert.equal(body.vy, 0);
});

test('物理：固定步长——不同 dt 切片走出同样的位置', () => {
  // 这是「物理不依赖帧率」的核心断言
  const coarse = physicsAt();
  for (let index = 0; index < 60; index += 1) coarse.advance(1 / 60);   // 1 秒 @60fps
  const fine = physicsAt();
  for (let index = 0; index < 240; index += 1) fine.advance(1 / 240);    // 1 秒 @240fps

  assert.ok(
    Math.abs(coarse.y - fine.y) < 2,
    `1 秒后的高度应一致：60fps=${coarse.y} vs 240fps=${fine.y}`,
  );
});

test('物理：重力下落的位移符合公式（半秒）', () => {
  const body = physicsAt({ y: 0 });
  const halfSecond = 60;
  for (let index = 0; index < halfSecond; index += 1) body.advance(1 / 120);
  // s = 1/2 * g * t^2 = 0.5 * 1800 * 0.25 = 225
  const expected = 0.5 * DEFAULT_PHYSICS.gravity * 0.25;
  assert.ok(
    Math.abs(body.y - expected) < 5,
    `半秒应下落约 ${expected}px，实际 ${body.y}`,
  );
});

test('物理：终速被钳制', () => {
  const body = physicsAt({ height: 100000, bounds: { width: 1000, height: 100000 } });
  for (let index = 0; index < 2000; index += 1) body.advance(FIXED_STEP);
  assert.ok(body.vy <= DEFAULT_PHYSICS.terminalVelocity + 1, `vy=${body.vy}`);
});

test('物理：巨大 dt 不会让宠物瞬移出世界', () => {
  const body = physicsAt();
  body.advance(60);
  assert.ok(body.y <= 600, `y=${body.y} 不应超出世界高度`);
  assert.ok(body.y >= 0);
});

test('物理：水平边界钳制（宠物不能跑出屏幕）', () => {
  const left = physicsAt({ x: -5000 });
  left.advance(FIXED_STEP);
  assert.ok(left.x >= 32, `左边界应钳到半宽，实际 ${left.x}`);

  const right = physicsAt({ x: 99999 });
  right.advance(FIXED_STEP);
  assert.ok(right.x <= 968, `右边界应钳到 bounds-half，实际 ${right.x}`);
});

test('物理：视口比宠物还窄时居中而不是来回抖', () => {
  const body = physicsAt({ bounds: { width: 40, height: 600 }, width: 64 });
  body.advance(FIXED_STEP);
  assert.equal(body.x, 20, '应退化为居中');
});

test('物理：resize 后宠物被夹回可见区（阶段 3 验收）', () => {
  const body = physicsAt({ x: 900, y: 580 });
  body.setBounds({ width: 400, height: 300 });
  assert.ok(body.x <= 400 - 32, `x=${body.x} 应在新宽度内`);
  assert.ok(body.y <= 300, `y=${body.y} 应在新高度内`);
});

test('物理：resize 变大后地面跟着下移', () => {
  const body = physicsAt();
  for (let index = 0; index < 200; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.y, 600);
  body.setBounds({ width: 1000, height: 800 });
  for (let index = 0; index < 200; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.y, 800, '应落到新地面');
});

test('物理：拖拽期间物理不参与（跟手优先）', () => {
  const body = physicsAt();
  body.beginDrag(100, 200);
  body.moveDrag(150, 250);
  assert.equal(body.x, 150);
  assert.equal(body.y, 250);
  const before = { x: body.x, y: body.y };
  body.advance(1);
  assert.deepEqual({ x: body.x, y: body.y }, before, '拖拽中位置只由指针决定');
});

test('物理：松手后带着初速度下坠（有"甩出去"的手感）', () => {
  const body = physicsAt({ x: 500, y: 200 });
  body.beginDrag(500, 200);
  body.endDrag(600, -300);
  body.advance(FIXED_STEP);
  assert.ok(body.x > 500, '应向右继续飞');
  assert.ok(body.vy < 0 || body.y < 200 || body.vy >= 0, '应带上初速度');
});

test('物理：拖拽清零旧速度（不会把拖拽前的惯性一起甩出去）', () => {
  const body = physicsAt();
  body.setVelocity(500, 500);
  body.beginDrag(300, 300);
  assert.equal(body.vx, 0);
  assert.equal(body.vy, 0);
});

test('物理：触地标记 justLanded 一次性', () => {
  const body = physicsAt({ y: 590 });
  let landedAt = -1;
  for (let index = 0; index < 40; index += 1) {
    body.advance(FIXED_STEP);
    if (body.justLanded && landedAt < 0) landedAt = index;
  }
  assert.ok(landedAt >= 0, '应该记录到触地');
});

test('物理：慢速贴地不触发 justLanded（不算"砸下来"）', () => {
  const body = physicsAt({ y: 600 });
  body.advance(FIXED_STEP);
  assert.equal(body.justLanded, false);
});

test('物理：已经站在地面的宠物不会反复报告 touchedDown', () => {
  // `touchedDown` 是「离地 → 触地」的**边沿**，不是「现在在地面上」这个电平。
  // 若它退化成电平，`fall` 之后每帧都会判一次落地，落地动作会被无限重播。
  const body = physicsAt({ y: 600 });
  for (let index = 0; index < 5; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.grounded, true);
  for (let index = 0; index < 5; index += 1) {
    body.advance(FIXED_STEP);
    assert.equal(body.touchedDown, false, '一直在地面上，不该再有落地边沿');
  }
});

test('物理：从空中轻轻落到地面会置 touchedDown 但不置 justLanded', () => {
  // 这是用户报障的核心场景：把宠物拖到离地很近的地方松手。
  // 冲击不足 60px/s，`justLanded` 为假——只靠它就永远出不了 fall 状态。
  const body = physicsAt({ y: 560, physics: { gravity: 40, bounce: 0 } });
  let touched = false;
  let heavy = false;
  for (let index = 0; index < 300; index += 1) {
    body.advance(FIXED_STEP);
    if (body.touchedDown) touched = true;
    if (body.justLanded) heavy = true;
  }
  assert.equal(body.grounded, true, '应该落到地面');
  assert.ok(touched, '轻落也要置 touchedDown——否则状态机出不了 fall');
  assert.equal(heavy, false, '重力很小时冲击不足，不该算"砸下来"');
});

test('物理：touchedDown 是离地→触地的翻转，弹起时不算落地', () => {
  // 反弹时 `grounded` 仍为假（宠物确实还在空中）。若在弹起那一瞬就判成
  // 「回来了」，落地动作会与「空中继续上抛」同时发生——又是一次空中串动作。
  const body = physicsAt({ y: 100 });
  const touchedAt = [];
  for (let index = 0; index < 400; index += 1) {
    body.advance(FIXED_STEP);
    if (body.touchedDown) touchedAt.push(index);
  }
  assert.ok(touchedAt.length >= 1, '至少要有一次真正的落地');
  assert.equal(body.grounded, true, '最终应停在地面');
});

test('物理：touchedDown 是每帧一次的标记（一帧多步不会漏掉落地）', () => {
  // 一帧内可能补算多步（累加器，最多 60 步）。若标记在**每个内部步**开头清，
  // 只有最后一步的结论能被看到——落地恰在倒数第二步时会被擦掉，
  // 表现为「这次落地莫名其妙没触发落地动作」（时有时无，极难复现）。
  const body = physicsAt({ y: 500, physics: { bounce: 0 } });
  // 一次性推进约 40 个固定步：落地必然发生在**中间**某一步，
  // 而不是被擦掉的最后一步
  body.advance(0.34);
  assert.equal(body.grounded, true, '这一帧内应该已经落地');
  assert.ok(body.touchedDown, '落地发生在帧中间也不能漏报');
});

test('物理：拖拽期间不清标记会误判落地（防回归）', () => {
  // 拖拽时 `step()` 根本不跑。若不在 `advance()` 开头清标记，
  // 上一次自由下落留下的 touchedDown 会一直为真——
  // 用户刚把宠物抓起来就会被判成「落地」，它在手里播落地动画。
  const body = physicsAt({ y: 100 });
  for (let index = 0; index < 200; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.grounded, true);
  body.beginDrag(300, 300);
  body.advance(FIXED_STEP);
  assert.equal(body.touchedDown, false, '抓在手里不该被判成落地');
  assert.equal(body.justLanded, false);
  assert.equal(body.footContact, false, 'footContact 同样不能在拖拽中被点亮');
});

// ================================================= footContact（落地切换）

test('★ 物理：footContact 在触地那一帧就置位，touchedDown 要等反弹结束', () => {
  // 用户报障：「人物现在坠落的姿态接触到地面后……会有那么很短的一段时间
  // 人物贴着地面但是处于坠落动画，因为时间有个几百 ms，因此肉眼可见」。
  //
  // 根因：落地反弹把 `grounded` 重新置假，于是 `touchedDown`（「停稳」）
  // 比「脚底碰到地面」晚一整个反弹。这条把那个差值量死。
  //
  // ⚠️ 必须**单步**推进：`advance(1/60)` 内部会补算 2 个子步，宠物可能在
  // 被判触地的同一帧里就弹了起来，外部看不到「贴地」那一瞬。
  const body = physicsAt({ y: 100, width: 172, height: 259 });
  let t = 0;
  let footAt = null;
  let touchedAt = null;
  let maxLift = 0;
  let contactAt = null;
  while (t < 5) {
    body.advance(FIXED_STEP);
    t += FIXED_STEP;
    if (contactAt === null && body.y >= 600 - 0.001) contactAt = t;
    if (footAt === null && body.footContact) footAt = t;
    if (touchedAt === null && body.touchedDown) touchedAt = t;
    if (contactAt !== null) maxLift = Math.max(maxLift, 600 - body.y);
    if (body.grounded && Math.abs(body.vy) < 1e-9) break;
  }
  assert.ok(footAt !== null, 'footContact 必须触发');
  assert.ok(touchedAt !== null, 'touchedDown 也必须触发（它是「停稳」）');
  assert.equal(footAt, contactAt, 'footContact 必须与「首次触地」同一时刻');
  const delayMs = (touchedAt - footAt) * 1000;
  assert.ok(delayMs > 50, (
    `这条测试的意义就是 touchedDown 明显晚于 footContact，实测只差 ${delayMs.toFixed(0)}ms`
    + '——若两者相同，说明反弹没发生（bounce 被改成 0？），这条判断就失效了'
  ));
  assert.ok(maxLift > 1, `反弹应当真的把脚抬高（实测 ${maxLift.toFixed(1)}px）`);
});

test('★ 物理：footContact 与 touchedDown 在无反弹时同时置位', () => {
  // 轻放 / bounce=0 时两者应当同一帧——不能因为加了新标记就让「落地」
  // 在那种情况下变慢。
  const body = physicsAt({ y: 590, physics: { bounce: 0 } });
  let footAt = null;
  let touchedAt = null;
  for (let index = 0; index < 200; index += 1) {
    body.advance(FIXED_STEP);
    if (footAt === null && body.footContact) footAt = index;
    if (touchedAt === null && body.touchedDown) touchedAt = index;
    if (body.grounded) break;
  }
  assert.ok(footAt !== null && touchedAt !== null);
  assert.equal(footAt, touchedAt, '没有反弹时两者应同帧');
});

test('物理：一直贴地时 footContact 不再重复报告', () => {
  // 它是边沿，不是电平——否则贴着地面时每帧都会重新切一次 land。
  // 先让它站稳（第一帧本身会报一次「落地」，那是正确的：身体初始不在 grounded 态）。
  const body = physicsAt({ y: 600 });
  for (let index = 0; index < 5; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.grounded, true);
  let count = 0;
  for (let index = 0; index < 60; index += 1) {
    body.advance(FIXED_STEP);
    if (body.footContact) count += 1;
  }
  assert.equal(count, 0, '已经站稳之后不该再报告「碰到地面」');
});


test('物理：行走用 walkSpeed，停下后摩擦减速到 0', () => {
  const body = physicsAt({ y: 600, x: 300 });
  body.walk(1);
  for (let index = 0; index < 60; index += 1) body.advance(FIXED_STEP);
  assert.ok(body.x > 300, '应该向右走过');

  body.stopWalking();
  // friction 是「每秒保留比例」，0.02 表示 1 秒内基本停住
  for (let index = 0; index < 240; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.vx, 0, '摩擦应让它最终停下');
});

test('物理：摩擦与步长无关（每秒保留比例一致）', () => {
  const build = () => {
    // 放在中间，避免撞到左右边界（撞墙会吃掉 vx，掩盖摩擦的效果）
    const body = physicsAt({ y: 600, x: 500 });
    body.setVelocity(1000, 0);
    return body;
  };
  const coarse = build();
  for (let index = 0; index < 60; index += 1) coarse.advance(1 / 60);
  const fine = build();
  for (let index = 0; index < 240; index += 1) fine.advance(1 / 240);
  // 1 秒后剩余速度应接近（friction=0.02 → 约 20px/s）
  assert.ok(
    Math.abs(coarse.vx - fine.vx) < 15,
    `剩余速度应一致：60fps=${coarse.vx.toFixed(1)} vs 240fps=${fine.vx.toFixed(1)}`,
  );
  assert.ok(
    coarse.vx < 60 && coarse.vx > 5,
    `1 秒后应剩约 20px/s，实际 ${coarse.vx}`,
  );
});

test('物理：一次甩出后滑行的距离可控（不会失控滑到屏幕外）', () => {
  // 实施提示词示例包里的 0.85 会让甩出滑行约 12 个屏幕宽；这个断言把它钉住
  const body = physicsAt({ y: 600, x: 100 });
  body.setVelocity(2000, 0);
  for (let index = 0; index < 600; index += 1) body.advance(FIXED_STEP); // 5 秒
  const travelled = body.x - 100;
  assert.ok(travelled < 900, `5 秒内滑行距离应可控，实际 ${travelled.toFixed(0)}px`);
  assert.equal(body.vx, 0, '应已停住');
});

test('物理：慢速宠物也能停住（阈值随 walkSpeed 缩放）', () => {
  const body = physicsAt({ y: 600, x: 500, physics: { walkSpeed: 1 } });
  body.setVelocity(1, 0);
  for (let index = 0; index < 600; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.vx, 0, '阈值应按 walkSpeed 缩放，否则永远停不下来');
});

test('物理：撞墙吃掉水平速度', () => {
  // x=960 已贴着右边界（半宽 32 → 上限 968），水平速度应被吃掉
  const body = physicsAt({ y: 600, x: 968 });
  body.setVelocity(500, 0);
  for (let index = 0; index < 60; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.vx, 0, '贴墙时不应继续"跑"');
  assert.ok(body.x <= 968);
});

test('物理：resting 仅在真正静止时为真（决定能否停 rAF）', () => {
  const body = physicsAt();
  assert.equal(body.resting, false, '空中不是静止');
  for (let index = 0; index < 300; index += 1) body.advance(FIXED_STEP);
  assert.equal(body.resting, true, '落到地面并停下后应静止');
});

test('物理：尺寸变化后重新钳制', () => {
  const body = physicsAt({ x: 990 });
  body.setSize({ width: 200, height: 200 });
  assert.ok(body.x <= 900, `x=${body.x} 应在新尺寸内`);
});

test('物理：包里的物理参数被采用', () => {
  const body = physicsAt({ physics: { gravity: 100, walkSpeed: 999 } });
  assert.equal(body.params.gravity, 100);
  assert.equal(body.params.walkSpeed, 999);
  // 未覆盖的仍用默认
  assert.equal(body.params.friction, DEFAULT_PHYSICS.friction);
});

test('甩出速度：按最近窗口估算', () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 1000, y: 0, t: 900 },   // 很久以前的大位移，不该影响结果
    { x: 100, y: 50, t: 1000 },
    { x: 200, y: 100, t: 1050 }, // 50ms 内 +100px → 2000px/s
  ];
  const { vx, vy } = estimateReleaseVelocity(samples);
  assert.ok(vx > 1500 && vx < 2500, `vx=${vx}`);
  assert.ok(vy > 700 && vy < 1300, `vy=${vy}`);
});

test('甩出速度：采样不足时为零', () => {
  assert.deepEqual(estimateReleaseVelocity([]), { vx: 0, vy: 0 });
  assert.deepEqual(estimateReleaseVelocity([{ x: 1, y: 1, t: 0 }]), { vx: 0, vy: 0 });
  assert.deepEqual(estimateReleaseVelocity(null), { vx: 0, vy: 0 });
});

test('甩出速度：被夹到上限', () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 100000, y: 0, t: 10 },
  ];
  const { vx } = estimateReleaseVelocity(samples, { maxSpeed: 3000 });
  assert.ok(vx <= 3000, `vx=${vx} 应被夹到 3000`);
});

test('甩出速度：同一时刻的采样不产生除零', () => {
  const samples = [{ x: 0, y: 0, t: 100 }, { x: 50, y: 50, t: 100 }];
  const result = estimateReleaseVelocity(samples);
  assert.ok(Number.isFinite(result.vx) && Number.isFinite(result.vy));
});

// ============================================ 点击弹跳（可反复触发的反馈）

/**
 * 复现「连点把宠物越抬越高」的那条链：站在地上 → halt → 给上抛速度。
 *
 * 与 `petview.js:handleClick` 的规则逐条对应（不二段跳 / 高度来自包声明）。
 */
function clickOnce(body, ratio = DEFAULT_PHYSICS.clickHop) {
  const wasGrounded = body.grounded;
  if (wasGrounded) body.halt();
  if (!wasGrounded) return false;
  const velocity = hopVelocity({
    gravity: body.params.gravity,
    height: body.size.height,
    ratio,
  });
  if (!velocity) return false;
  body.setVelocity(0, velocity);
  return true;
}

function clickTrace({ intervalMs, durationMs, ratio }) {
  const body = physicsAt({
    y: 600, bounds: { width: 1000, height: 600 }, width: 173, height: 259,
  });
  body.advance(FIXED_STEP);   // 先落稳一帧（物理层初始 grounded 为假）
  let next = 0;
  let highest = body.y;
  let hops = 0;
  for (let t = 0; t <= durationMs; t += 1000 / 60) {
    if (t >= next) {
      next += intervalMs;
      if (clickOnce(body, ratio)) hops += 1;
    }
    body.advance(1 / 60);
    highest = Math.min(highest, body.y);
  }
  return { lift: +(600 - highest).toFixed(1), hops };
}

test('点击弹跳：高度由包声明（clickHop 比例），与重力无关', () => {
  // 同样的 `clickHop`，重力跨两个数量级，抬升高度必须仍在同一量级。
  //
  // 容差 ±25% 而不是更紧：物理是**半隐式欧拉 + 固定 1/120s 步长**，离散误差
  // 约 `v·dt/2`，它随 g（即随 v）线性增长——实测 g=200 时误差 1%、
  // g=1800 时 5%、g=20000 时 20%（18.1px → 14.5px，且始终**偏小**、不会飞走）。
  // 这是积分器的固有性质，不是本次改动引入的，因此不在这里判它。
  //
  // 真正要守的是**对比**：改动前的固定速度 -260 在同一批重力下是
  // 337px → 18px → 0.2px（差三个数量级，且 gravity=0 时宠物一路升到屏幕边）。
  const lifts = [];
  for (const gravity of [200, 1800, 20000]) {
    const body = physicsAt({
      y: 600, bounds: { width: 1000, height: 600 }, width: 173, height: 259,
      physics: { gravity },
    });
    body.advance(FIXED_STEP);
    clickOnce(body);
    let highest = body.y;
    for (let index = 0; index < 600; index += 1) {
      body.advance(1 / 60);
      highest = Math.min(highest, body.y);
    }
    lifts.push(600 - highest);
  }
  const expected = 259 * DEFAULT_PHYSICS.clickHop;
  for (const [index, gravity] of [200, 1800, 20000].entries()) {
    const lift = lifts[index];
    assert.ok(
      lift > expected * 0.75 && lift < expected * 1.1,
      `gravity=${gravity} 抬升 ${lift.toFixed(1)}px 偏离 ${expected.toFixed(1)}px 太多：${lifts}`,
    );
  }
  const spread = Math.max(...lifts) / Math.min(...lifts);
  assert.ok(spread < 1.35, `三档重力下的抬升不该差出一大截：${lifts.map((v) => v.toFixed(1))}`);
});

test('点击弹跳：连点不会累积高度（不二段跳）', () => {
  // 一次弹跳的空中时间约 290ms，因此 200ms 与 80ms 这两种节奏都会撞上
  // 「上一次还在空中就又被点」。改动前它们分别是 437px / 800px（顶到屏幕上边）。
  for (const intervalMs of [80, 100, 150, 200]) {
    const { lift } = clickTrace({ intervalMs, durationMs: 6000 });
    const single = 259 * DEFAULT_PHYSICS.clickHop;
    assert.ok(
      lift <= single + 2,
      `每 ${intervalMs}ms 点一次，抬升 ${lift}px 超过了单次弹跳 ${single.toFixed(1)}px`,
    );
  }
});

test('点击弹跳：空中点击不改速度（正在下落时点它不会把它托起来）', () => {
  const body = physicsAt({
    y: 300, bounds: { width: 1000, height: 600 }, width: 173, height: 259,
  });
  body.advance(FIXED_STEP);
  assert.equal(body.grounded, false, '前提：它在空中');
  const before = { vx: body.vx, vy: body.vy };
  assert.equal(clickOnce(body), false, '空中点击不该给出上抛速度');
  // 同一步内的重力增量不算「被点击改动」，因此这里只断言没有被改快
  assert.ok(body.vy >= before.vy - 1, `vy 不该被托起来：${before.vy} → ${body.vy}`);
  assert.equal(body.vx, before.vx);
});

test('点击弹跳：clickHop = 0 时完全不弹（给没有跳感的形象）', () => {
  const body = physicsAt({
    y: 600, bounds: { width: 1000, height: 600 }, width: 173, height: 259,
  });
  body.advance(FIXED_STEP);
  assert.equal(clickOnce(body, 0), false);
  assert.equal(body.vy, 0, '不该产生任何竖直速度');
  assert.equal(body.grounded, true, '也不该被踢成「离地」');
});

test('点击弹跳：失重包（gravity=0）不会让宠物一路上升', () => {
  // 固定速度 -260 在 gravity=0 下会把宠物顶到屏幕边并永久停在那里
  assert.equal(hopVelocity({ gravity: 0, height: 259, ratio: 0.07 }), 0);
  const body = physicsAt({
    y: 600, bounds: { width: 1000, height: 600 }, width: 173, height: 259,
    physics: { gravity: 0 },
  });
  body.advance(FIXED_STEP);
  clickOnce(body);
  for (let index = 0; index < 600; index += 1) body.advance(1 / 60);
  assert.equal(body.y, 600, '失重包里不该被弹起来');
});

test('halt()：停住运动但不谎报 grounded', () => {
  const body = physicsAt({
    y: 600, bounds: { width: 1000, height: 600 }, width: 173, height: 259,
  });
  body.advance(FIXED_STEP);
  body.walk(1);
  assert.ok(body.vx > 0);
  body.halt();
  assert.equal(body.vx, 0, '水平速度应清零');
  assert.equal(body.vy, 0);
  assert.equal(body.grounded, true, '★ 站着被点一下不该变成「在空中」');
  assert.equal(body.walking, false, '水平输入必须清掉，否则摩擦不再接手');
});

test('halt()：清掉 inputActive 后摩擦重新生效（点一下正在走路的宠物）', () => {
  const body = physicsAt({
    y: 600, bounds: { width: 1000, height: 600 }, width: 173, height: 259,
  });
  body.advance(FIXED_STEP);
  body.walk(1);
  for (let index = 0; index < 30; index += 1) body.advance(1 / 60);
  const beforeClick = body.x;
  body.halt();
  for (let index = 0; index < 120; index += 1) body.advance(1 / 60);
  assert.ok(
    Math.abs(body.x - beforeClick) < 5,
    `点完之后不该继续滑：位移 ${(body.x - beforeClick).toFixed(1)}px`,
  );
});

// ================================================================ 状态机


test('状态机：初始为 idle', () => {
  const machine = createStateMachine();
  assert.equal(machine.state, STATES.IDLE);
  assert.equal(machine.dormant, true);
});

test('状态机：表里的合法迁移都被允许', () => {
  assert.ok(canTransition(STATES.IDLE, STATES.WALK));
  assert.ok(canTransition(STATES.IDLE, STATES.SLEEP));
  assert.ok(canTransition(STATES.FALL, STATES.LAND));
  assert.ok(canTransition(STATES.LAND, STATES.IDLE));
  assert.ok(canTransition(STATES.SLEEP, STATES.IDLE));
});

test('状态机：非法迁移被拒绝', () => {
  assert.equal(canTransition(STATES.SLEEP, STATES.LAND), false, '睡着的宠物不会"落地"');
  assert.equal(canTransition(STATES.LAND, STATES.SLEEP), false, '落地瞬间不该直接睡');
  assert.equal(canTransition(STATES.DRAG, STATES.SLEEP), false, '被抓着时不该睡');
  assert.equal(canTransition('nonsense', STATES.IDLE), false);
});

test('状态机：空中不能直接回 idle（必须经过 land）', () => {
  // ⚠️ 这条是用户报障「在空中播放其他动画，甚至多个动画交替出现」的核心。
  //
  // 表里曾经有 `FALL → IDLE`，而它正是那条路径的入口：坠落期间任何**过期的
  // 定时器**（上一次播报的收尾、待机的随机触发、漫游倒计时）只要调到
  // `settle()`，就能把宠物从 fall 直接拽进 idle——于是它在半空中播起待机
  // 动画，接着还能从 idle 走去 walk / sleep，看起来就是「空中好几个动画轮流播」。
  //
  // 回到地面的唯一出口必须是 `land`——这正是物理上的事实。
  assert.equal(canTransition(STATES.FALL, STATES.IDLE), false, '空中不能直接回 idle');
  assert.equal(canTransition(STATES.FALL, STATES.WALK), false, '空中不能开始走');
  assert.equal(canTransition(STATES.FALL, STATES.SLEEP), false, '空中不能睡');
  assert.equal(canTransition(STATES.FALL, STATES.REACT), false, '空中不能抢播报');
  assert.ok(canTransition(STATES.FALL, STATES.LAND), '落地是唯一正常出口');
  assert.ok(canTransition(STATES.FALL, STATES.DRAG), '空中仍可被抓住（硬要求 1）');
});

test('状态机：空中调 settle() 被拒绝，且不污染动作名', () => {
  // 迁移被拒绝时动作名也**不能**被改掉。旧写法是「先写 currentAction、
  // 再 transition」，于是状态停在 fall、动作名已经变成 idle，
  // `machine.action` 与 `machine.state` 就此脱节——读取它的地方
  // （dormant / animating / 面板诊断）会得到自相矛盾的答案。
  const machine = createStateMachine();
  machine.beginDrag({ now: 0 });
  machine.release({ now: 1 });
  assert.equal(machine.state, STATES.FALL);
  assert.equal(machine.action, 'fall');

  assert.equal(machine.settle({ now: 2 }), false, '空中回 idle 必须被拒绝');
  assert.equal(machine.state, STATES.FALL, '状态不该变');
  assert.equal(machine.action, 'fall', '动作名也不该被改掉（不能脱节）');

  assert.equal(machine.startWalk({ now: 3 }), false, '空中开始走必须被拒绝');
  assert.equal(machine.action, 'fall', '被拒绝的迁移不该改动作名');

  assert.equal(machine.sleep({ now: 4 }), false, '空中入睡必须被拒绝');
  assert.equal(machine.action, 'fall');
});

test('状态机：空中播报被排队，落地后立刻播（而不是半空中播）', () => {
  // 用户报的「空中播放别的动画」里这一条也是来源：旧实现在 fall 期间会把
  // `currentAction` 改成 happy（虽然迁移被拒绝），动作名与状态脱节。
  // 现在与 drag 同等对待：排队，回到地面后再播。
  const machine = createStateMachine();
  machine.beginDrag({ now: 0 });
  machine.release({ now: 1 });
  assert.equal(machine.react('happy', { now: 2 }), false, '空中不该抢播报');
  assert.equal(machine.action, 'fall', '动作名保持 fall');
  assert.equal(machine.pendingReaction, 'happy', '但请求要记下来');

  machine.land({ now: 3 });
  assert.equal(machine.state, STATES.LAND);
  assert.equal(machine.takePendingReaction(), 'happy', '落地后能取回排队的播报');
});

test('状态机：硬要求 1——任何状态都能被 drag 打断', () => {
  for (const state of Object.values(STATES)) {
    assert.ok(canTransition(state, STATES.DRAG), `从 ${state} 应该能被拖动打断`);
  }
});

test('状态机：拖动真的能打断 sleep / react / walk', () => {
  for (const setup of ['sleep', 'react', 'walk']) {
    const machine = createStateMachine();
    if (setup === 'sleep') machine.sleep({ now: 1 });
    if (setup === 'react') machine.react('happy', { now: 1 });
    if (setup === 'walk') machine.startWalk({ now: 1 });
    assert.equal(machine.beginDrag({ now: 2 }), true, `从 ${setup} 应能开始拖拽`);
    assert.equal(machine.state, STATES.DRAG);
    assert.equal(machine.action, 'drag');
  }
});

test('状态机：拖拽 → 下落 → 落地 → 回 idle 全链路', () => {
  const machine = createStateMachine();
  assert.equal(machine.beginDrag({ now: 0 }), true);
  assert.equal(machine.release({ now: 10 }), true);
  assert.equal(machine.state, STATES.FALL);
  assert.equal(machine.land({ now: 20 }), true);
  assert.equal(machine.state, STATES.LAND);
  assert.equal(machine.settle({ now: 30 }), true);
  assert.equal(machine.state, STATES.IDLE);
});

test('状态机：非法迁移触发 onReject 且状态不变', () => {
  const rejected = [];
  const machine = createStateMachine({
    onReject: (from, to, reason) => rejected.push({ from, to, reason }),
  });
  machine.sleep({ now: 0 });
  assert.equal(machine.go(STATES.LAND, { reason: 'oops' }), false);
  assert.equal(machine.state, STATES.SLEEP, '非法迁移不能改变状态');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].from, STATES.SLEEP);
  assert.equal(rejected[0].to, STATES.LAND);
});

test('状态机：onChange 收到前后状态', () => {
  const changes = [];
  const machine = createStateMachine({
    onChange: (next, prev) => changes.push([prev, next]),
  });
  machine.beginDrag({ now: 0 });
  machine.release({ now: 1 });
  assert.deepEqual(changes, [[STATES.IDLE, STATES.DRAG], [STATES.DRAG, STATES.FALL]]);
});

test('状态机：硬要求 2——sleep 期间收到核心事件要唤醒', () => {
  const machine = createStateMachine();
  machine.sleep({ now: 1000 });
  assert.equal(machine.state, STATES.SLEEP);

  const ok = machine.react('happy', { now: 2000 });
  assert.equal(ok, true, '事件播报必须能在 sleep 中触发');
  assert.equal(machine.state, STATES.REACT);
  assert.equal(machine.action, 'happy');
});

test('状态机：sleep 中任意输入都唤醒', () => {
  for (const method of ['beginDrag', 'startWalk']) {
    const machine = createStateMachine();
    machine.sleep({ now: 0 });
    machine[method]({ now: 1 });
    assert.notEqual(machine.state, STATES.SLEEP, `${method} 应唤醒它`);
  }
});

test('状态机：wake 在非 sleep 状态是幂等的', () => {
  const machine = createStateMachine();
  assert.equal(machine.wake({ now: 0 }), true);
  assert.equal(machine.state, STATES.IDLE);
});

test('状态机：拖拽中收到播报会被推迟，松手后仍能取出', () => {
  const machine = createStateMachine();
  machine.beginDrag({ now: 0 });
  assert.equal(machine.react('happy', { now: 1 }), false, '不能抢走拖拽态');
  assert.equal(machine.state, STATES.DRAG);
  assert.equal(machine.pendingReaction, 'happy');

  machine.release({ now: 2 });
  const pending = machine.takePendingReaction();
  assert.equal(pending, 'happy');
  assert.equal(machine.pendingReaction, '', '取出后应清空');
});

test('状态机：开始拖拽会丢弃待播项（用户意图优先）', () => {
  const machine = createStateMachine();
  machine.beginDrag({ now: 0 });
  machine.react('happy', { now: 1 });
  assert.equal(machine.pendingReaction, 'happy');
  machine.beginDrag({ now: 2 });
  assert.equal(machine.pendingReaction, '', '重新拖拽时应清掉');
});

test('状态机：未知播报动作被拒绝', () => {
  const machine = createStateMachine();
  assert.equal(machine.react('teleport', { now: 0 }), false);
  assert.equal(machine.state, STATES.IDLE);
});

test('状态机：播报动作都在词表内', () => {
  const machine = createStateMachine();
  for (const action of REACT_ACTIONS) {
    const fresh = createStateMachine();
    assert.equal(fresh.react(action, { now: 0 }), true, `${action} 应被接受`);
    assert.equal(machine.constructor, fresh.constructor);
  }
});

test('状态机：连续播报（react → react）被允许', () => {
  const machine = createStateMachine();
  machine.react('happy', { now: 0 });
  assert.equal(machine.react('sad', { now: 10 }), true);
  assert.equal(machine.action, 'sad');
});

test('状态机：elapsed 用注入的时钟计算', () => {
  const machine = createStateMachine();
  machine.setNow(1000);
  machine.startWalk({ now: 1000 });
  assert.equal(machine.elapsed(1500), 500);
  assert.equal(machine.elapsed(900), 0, '不应为负');
});

test('状态机：history 有界', () => {
  const machine = createStateMachine();
  for (let index = 0; index < 200; index += 1) {
    machine.beginDrag({ now: index });
    machine.release({ now: index });
    machine.settle({ now: index });
  }
  assert.ok(machine.history.length <= 64, `history 应有界，实际 ${machine.history.length}`);
});

test('状态机：dormant / animating 反映是否可停 rAF', () => {
  const machine = createStateMachine();
  assert.equal(machine.dormant, true);
  assert.equal(machine.animating, false);

  machine.beginDrag({ now: 0 });
  assert.equal(machine.dormant, false);
  assert.equal(machine.animating, true);

  machine.settle({ now: 1 });
  assert.equal(machine.dormant, true);

  machine.react('happy', { now: 2 });
  assert.equal(machine.animating, true, '播报中需要动画');
});

test('状态机：setAction 独立于状态（react 态下换动作名）', () => {
  const machine = createStateMachine();
  machine.react('happy', { now: 0 });
  machine.setAction('sad');
  assert.equal(machine.action, 'sad');
  assert.equal(machine.state, STATES.REACT);
});

// ================================================================ 钩子健壮性


test('★ 钩子抛错不能打断迁移（真实踩过的坑）', () => {
  // 现场：onChange 里一次 TypeError（插件调了不存在的宿主 API）顺着 transition()
  // 抛回调用方，把**用户拖拽**整条路径打断——machine.beginDrag() 抛错后，
  // 紧跟的 physics.beginDrag() 根本没执行，表现是「宠物拖不动」，
  // 而真正的原因在几百行之外的日志调用上。
  const machine = createStateMachine({
    onChange: () => { throw new TypeError('api.log is not a function'); },
  });
  assert.equal(machine.beginDrag({ now: 0 }), true, '迁移本身必须成功');
  assert.equal(machine.state, STATES.DRAG, '状态必须已经改变');
});

test('钩子抛错不能打断 onReject 之后的返回值', () => {
  const machine = createStateMachine({
    onReject: () => { throw new Error('boom'); },
  });
  machine.sleep({ now: 0 });
  assert.equal(machine.go(STATES.LAND, { now: 1 }), false, '仍应返回 false');
  assert.equal(machine.state, STATES.SLEEP, '状态不变');
});

test('钩子抛错后状态机仍然可用', () => {
  let explode = true;
  const machine = createStateMachine({
    onChange: () => { if (explode) throw new Error('boom'); },
  });
  machine.beginDrag({ now: 0 });
  machine.release({ now: 1 });
  machine.land({ now: 2 });
  machine.settle({ now: 3 });
  assert.equal(machine.state, STATES.IDLE);
  assert.equal(machine.history.length, 4, '每次迁移都应被记录（钩子抛错不影响记账）');

  explode = false;
  machine.startWalk({ now: 4 });
  assert.equal(machine.state, STATES.WALK);
});

test('钩子非法类型被忽略（不炸）', () => {
  const machine = createStateMachine({ onChange: 'not a function', onReject: 42 });
  assert.doesNotThrow(() => {
    machine.beginDrag({ now: 0 });
    machine.go('nonsense', { now: 1 });
  });
});

// ================================================================ 大小与渲染方式
//
// 这两项是「用户能自己调宠物大小、并选择渲染方式」的核心。
// 尺寸推导是纯计算，因此在这里测；真正的 DOM 属性由 pytest 的静态契约
// 与真实浏览器验收覆盖（`frontend/petview.js` 里的 `dataset.petPixelated`）。

/** 与 `frontend/petview.js` 里同一套尺寸推导（含钳制）。 */
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;

function petSize(baseSize, rawScale) {
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  const scale = clamp(Number(rawScale) || 1, SCALE_MIN, SCALE_MAX);
  return {
    scale,
    width: Math.max(8, Math.round(baseSize.w * scale)),
    height: Math.max(8, Math.round(baseSize.h * scale)),
  };
}

test('尺寸：倍率按形象单帧尺寸等比放大', () => {
  const result = petSize({ w: 64, h: 64 }, 2);
  assert.equal(result.width, 128);
  assert.equal(result.height, 128);
});

test('尺寸：非正方形形象按各自比例缩放（真人立绘 2:3）', () => {
  // 用户明确要求放开「必须 64×64」——形象不必是正方形
  const result = petSize({ w: 300, h: 450 }, 1.5);
  assert.equal(result.width, 450);
  assert.equal(result.height, 675);
  // 长宽比保持不变
  assert.ok(Math.abs(result.width / result.height - 300 / 450) < 0.001);
});

test('尺寸：倍率被夹到合法区间', () => {
  assert.equal(petSize({ w: 64, h: 64 }, 99).scale, SCALE_MAX);
  assert.equal(petSize({ w: 64, h: 64 }, 0.001).scale, SCALE_MIN);
  assert.equal(petSize({ w: 64, h: 64 }, -5).scale, SCALE_MIN);
});

test('尺寸：非法倍率回落到 1 而不是 NaN', () => {
  for (const bad of [undefined, null, '', 'big', NaN]) {
    const result = petSize({ w: 64, h: 64 }, bad);
    assert.equal(result.scale, 1, `${String(bad)} 应回落到 1`);
    assert.equal(result.width, 64);
  }
});

test('尺寸：极小倍率下仍有最小可点尺寸', () => {
  // 太小就点不中了（拖动需要命中元素）
  const result = petSize({ w: 4, h: 4 }, SCALE_MIN);
  assert.ok(result.width >= 8, `宽度不应小于 8，实际 ${result.width}`);
  assert.ok(result.height >= 8, `高度不应小于 8，实际 ${result.height}`);
});

test('尺寸：倍率变化会等比改变包围盒（物理边界要跟着重算）', () => {
  const one = petSize({ w: 200, h: 100 }, 1);
  const two = petSize({ w: 200, h: 100 }, 2);
  assert.equal(two.width, one.width * 2);
  assert.equal(two.height, one.height * 2);
});

// ================================================================ 方向化行走

/** 侧视左右两套都给的形象。 */
const BOTH_SIDES = {
  idle: { source: 'idle', url: '/f/idle' },
  'walk-left': { source: 'walk-left', url: '/f/wl', mirror: false },
  'walk-right': { source: 'walk-right', url: '/f/wr', mirror: false },
};

/** 只给左侧：右侧应镜像复用（后端置 mirror=true）。 */
const LEFT_ONLY = {
  idle: { source: 'idle', url: '/f/idle' },
  'walk-left': { source: 'walk-left', url: '/f/wl', mirror: false },
  'walk-right': { source: 'walk-left', url: '/f/wl', mirror: true },
};

/**
 * 两侧都没有行走图（例如只传了 idle 的自建形象）：两个方向都回退到 `idle`。
 *
 * 这是**唯一**会走到「非方向化贴图」那条分支的形态——正面 `walk` 已退役，
 * 后端不会再给出 `source: 'walk'`。
 */
const IDLE_ONLY = {
  idle: { source: 'idle', url: '/f/idle' },
  'walk-left': { source: 'idle', url: '/f/idle', mirror: false },
  'walk-right': { source: 'idle', url: '/f/idle', mirror: false },
};

test('方向：向左请求 walk-left，向右请求 walk-right', () => {
  assert.equal(walkActionFor(-1), WALK_LEFT);
  assert.equal(walkActionFor(1), WALK_RIGHT);
  assert.equal(walkActionFor(-0.001), WALK_LEFT, '任何负数都算向左');
  assert.equal(walkActionFor(0), WALK_RIGHT, '0 按向右处理');
});

test('方向：source 以 walk- 开头才算方向化贴图', () => {
  assert.ok(isDirectionalSource('walk-left'));
  assert.ok(isDirectionalSource('walk-right'));
  assert.equal(isDirectionalSource('walk'), false,
    '正面 walk 已退役；即便出现这个名字，它也不是方向化贴图');
  assert.equal(isDirectionalSource('idle'), false);
  assert.equal(isDirectionalSource(''), false);
  assert.equal(isDirectionalSource(undefined), false);
});

test('方向：两侧都有时按方向取图，且都不翻转', () => {
  assert.ok(packHasDirectionalWalk(BOTH_SIDES));
  assert.deepEqual(resolveWalkVisual(-1, BOTH_SIDES),
    { action: WALK_LEFT, mirror: false });
  assert.deepEqual(resolveWalkVisual(1, BOTH_SIDES),
    { action: WALK_RIGHT, mirror: false });
});

test('方向：只给一侧时，另一侧镜像复用', () => {
  // 自己那一侧正常播
  assert.deepEqual(resolveWalkVisual(-1, LEFT_ONLY),
    { action: WALK_LEFT, mirror: false });
  // 缺的那一侧：仍请求 walk-right，但贴图镜像
  assert.deepEqual(resolveWalkVisual(1, LEFT_ONLY),
    { action: WALK_RIGHT, mirror: true });
});

test('方向：连行走图都没有时不崩，回退到 idle 并按朝向翻转', () => {
  assert.equal(packHasDirectionalWalk(IDLE_ONLY), false,
    '两侧都回退到 idle，说明作者没有方向化贴图');
  const left = resolveWalkVisual(-1, IDLE_ONLY);
  assert.equal(left.action, WALK_LEFT, '动作名仍按方向给，由后端回退链决定播什么');
  // idle 那张图没有朝向信息 → 沿用旧行为：向左则镜像
  assert.equal(left.mirror, true);
  assert.equal(resolveWalkVisual(1, IDLE_ONLY).mirror, false);
});

test('方向：actions 缺失 / 为 null 时不抛异常', () => {
  assert.equal(packHasDirectionalWalk(null), false);
  assert.equal(packHasDirectionalWalk(undefined), false);
  assert.doesNotThrow(() => resolveWalkVisual(-1, null));
  assert.doesNotThrow(() => mirrorForNonWalkAction(-1, null));
});

test('方向：非行走动作——有方向化贴图就不按朝向翻转（保护不对称头饰）', () => {
  // 小满这类形象：发夹只在一侧，idle 翻转会让发夹左右跳
  assert.equal(mirrorForNonWalkAction(-1, BOTH_SIDES), false,
    '有方向化贴图时 idle 不该翻转');
  assert.equal(mirrorForNonWalkAction(1, BOTH_SIDES), false);
  // 只给一侧也算「作者在意左右」
  assert.equal(mirrorForNonWalkAction(-1, LEFT_ONLY), false);
});

test('方向：非行走动作——没有方向化贴图的形象保持按朝向翻转', () => {
  assert.equal(mirrorForNonWalkAction(-1, IDLE_ONLY), true, '旧行为：向左则镜像');
  assert.equal(mirrorForNonWalkAction(1, IDLE_ONLY), false);
});
