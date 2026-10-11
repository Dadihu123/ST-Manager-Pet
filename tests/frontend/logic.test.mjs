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

/** 旧式形象：只有正面 walk，左右都回退到它，没有 mirror 标记。 */
const LEGACY = {
  idle: { source: 'idle', url: '/f/idle' },
  'walk-left': { source: 'walk', url: '/f/w', mirror: false },
  'walk-right': { source: 'walk', url: '/f/w', mirror: false },
};

/** 连行走图都没有：全部回退到 idle。 */
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
  assert.equal(isDirectionalSource('walk'), false, '正面图不是方向化贴图');
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

test('方向：旧式正面形象——两侧都按朝向翻转（旧行为不变）', () => {
  assert.equal(packHasDirectionalWalk(LEGACY), false,
    '只有正面 walk 不算方向化');
  // 向左走：正面图镜像，看起来像朝左
  assert.deepEqual(resolveWalkVisual(-1, LEGACY),
    { action: WALK_LEFT, mirror: true });
  // 向右走：正面图不翻
  assert.deepEqual(resolveWalkVisual(1, LEGACY),
    { action: WALK_RIGHT, mirror: false });
});

test('方向：连行走图都没有时不崩，回退到 idle', () => {
  assert.equal(packHasDirectionalWalk(IDLE_ONLY), false);
  const left = resolveWalkVisual(-1, IDLE_ONLY);
  assert.equal(left.action, WALK_LEFT, '动作名仍按方向给，由后端回退链决定播什么');
  assert.equal(left.mirror, true);
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

test('方向：非行走动作——旧式形象保持按朝向翻转', () => {
  assert.equal(mirrorForNonWalkAction(-1, LEGACY), true, '旧行为：向左则镜像');
  assert.equal(mirrorForNonWalkAction(1, LEGACY), false);
  assert.equal(mirrorForNonWalkAction(-1, IDLE_ONLY), true);
});
