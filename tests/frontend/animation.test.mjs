/**
 * 前端**动画与手势**纯逻辑的单测（Node 原生 test runner，零依赖）。
 *
 * 覆盖本轮 7 项优化里属于纯逻辑的部分：
 * - 非均匀帧时长（`frameMs`）的帧推进（第 6 项）
 * - 多套动画的**权重**随机选择（第 7 项）
 * - 动作时长计算（决定「播完回 idle」的时机，倍率必须与帧推进一致）
 * - idle 的**随机触发**调度（第 1 项）
 * - 点击 / 拖拽的手势判定（第 5 项）
 *
 * 这些都是纯函数或纯状态机，因此连 DOM 垫片都不需要。
 *
 * 运行：node --test "tests/frontend/*.test.mjs"
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  animationDuration,
  createBehaviorScheduler,
  createIdleScheduler,
  DEFAULT_SCHEDULE_MS,
  frameSizeOf,
  normalizeWeight,
  pickVariantIndex,
  playableVariants,
  SCHEDULE_BEHAVIORS,
  stillFrame,
} from '../../frontend/animation.js';
import { createFrameClock, MAX_FPS, normalizeFrameMs } from '../../frontend/clock.js';
import {
  createGesture,
  DEFAULT_HOLD_MS,
  DEFAULT_SLOP,
  GESTURE_DONE,
  GESTURE_DRAG,
  GESTURE_PENDING,
} from '../../frontend/gesture.js';

// ==================================================== 非均匀帧时长（第 6 项）


test('非均匀帧时长：按逐帧时长推进，而不是平均帧率', () => {
  // 4 帧，每帧停留时间不同：起手慢、中间快、收尾有个停顿。
  // 这是「非均匀帧时长让动画更自然」的核心断言。
  const clock = createFrameClock({
    frames: 4, fps: 10, loop: true, frameMs: [400, 100, 100, 600],
  });
  assert.equal(clock.uniform, false, '应识别为非均匀');
  assert.equal(clock.frameDuration, 0.4, '第 0 帧应停 0.4 秒');

  // 0.3 秒还不到第 0 帧的 0.4 秒 → 不应推进
  assert.equal(clock.advance(0.3), 0);
  assert.equal(clock.index, 0);
  // 再补 0.15 秒（累计 0.45）→ 进到第 1 帧
  assert.equal(clock.advance(0.15), 1);
  assert.equal(clock.index, 1);
  assert.equal(clock.frameDuration, 0.1, '第 1 帧应只停 0.1 秒');
});

test('非均匀帧时长：一轮总时长 = 逐帧之和（不是 帧数/fps）', () => {
  const clock = createFrameClock({
    frames: 4, fps: 10, loop: true, frameMs: [400, 100, 100, 600],
  });
  assert.equal(clock.totalDuration, 1.2, '应等于 0.4+0.1+0.1+0.6');
  // 均匀的话是 4/10 = 0.4 秒，差了三倍——这就是「节奏」的差别
});

test('非均匀帧时长：均匀推进时 frameDuration 就是 1/fps', () => {
  const clock = createFrameClock({ frames: 4, fps: 8, loop: true });
  assert.equal(clock.uniform, true);
  assert.equal(clock.frameDuration, 1 / 8);
  assert.equal(clock.totalDuration, 4 / 8);
});

test('非均匀帧时长：长度与 frames 不符时**回退**到均匀（不抛错）', () => {
  // 一个写坏的 frameMs 不该让宠物整个不动——回退比报错好
  for (const bad of [[100, 200], [100, 200, 300, 400, 500], 'x', null, undefined]) {
    const clock = createFrameClock({ frames: 4, fps: 10, loop: true, frameMs: bad });
    assert.equal(clock.uniform, true, `${JSON.stringify(bad)} 应回退到均匀`);
    assert.equal(clock.frameDuration, 0.1);
  }
});

test('非均匀帧时长：非法值（0 / 负数 / NaN）也回退到均匀', () => {
  for (const bad of [[100, 0, 100, 100], [100, -5, 100, 100], [100, NaN, 100, 100]]) {
    const clock = createFrameClock({ frames: 4, fps: 10, loop: true, frameMs: bad });
    assert.equal(clock.uniform, true, `${JSON.stringify(bad)} 应回退到均匀`);
  }
});

test('非均匀帧时长：每帧有下限（比 60fps 更短的帧在 rAF 下看不见）', () => {
  const durations = normalizeFrameMs([1, 1, 1, 1], 4);
  assert.ok(durations, '应被接受（会被夹到下限）');
  for (const value of durations) {
    assert.ok(value >= 1 / MAX_FPS - 1e-9, `帧时长 ${value} 应不小于 1/60 秒`);
  }
});

test('非均匀帧时长：不循环的动作仍在末帧停下', () => {
  const clock = createFrameClock({
    frames: 3, fps: 10, loop: false, frameMs: [100, 100, 500],
  });
  // 一轮共 0.7 秒；按 60fps 切片要 42 次才够，给足余量
  for (let index = 0; index < 80; index += 1) clock.advance(1 / 60);
  assert.equal(clock.index, 2, '应停在末帧');
  assert.equal(clock.finished, true);
});

test('非均匀帧时长：**长尾帧**不会让不循环的动作卡在中间', () => {
  // 真实踩过的坑：末帧的停顿（0.6 秒）比单次推进的时间上限还长，
  // 若拿「本步消耗的时间」当循环上界，就永远进不到末帧——
  // 表现是 `land` 的最后一帧不显示，动作像被截断。
  const clock = createFrameClock({
    frames: 3, fps: 10, loop: false, frameMs: [100, 100, 3000],
  });
  for (let index = 0; index < 200; index += 1) clock.advance(1 / 60);
  assert.equal(clock.index, 2, '末帧（3 秒停顿）也要能到达');
  assert.equal(clock.finished, true);
});

test('非均匀帧时长：巨大 dt 仍只推进一轮', () => {
  const clock = createFrameClock({
    frames: 4, fps: 10, loop: true, frameMs: [100, 100, 100, 100],
  });
  const steps = clock.advance(30);
  assert.ok(steps <= 4, `单次最多一轮，实际 ${steps}`);
});

test('非均匀帧时长：切动作会重置为非均匀/均匀（不残留上一动作的时长）', () => {
  const clock = createFrameClock({
    frames: 4, fps: 10, loop: true, frameMs: [400, 100, 100, 600],
  });
  assert.equal(clock.uniform, false);
  clock.setSpec({ frames: 2, fps: 8, loop: true });
  assert.equal(clock.uniform, true, '换到没有 frameMs 的动作后应回到均匀');
  assert.equal(clock.frameDuration, 1 / 8);
});

// ============================================== 多套动画 + 权重（第 7 项）


test('权重：按**相对比例**抽取（不是百分比）', () => {
  // 用户明确要求：数字是相对比例，新增动画时不必改动原有的数字
  const variants = [{ weight: 5 }, { weight: 2 }];
  let first = 0;
  const total = 1000;
  for (let index = 0; index < total; index += 1) {
    const picked = pickVariantIndex(variants, () => index / total);
    if (picked === 0) first += 1;
  }
  // 5/(5+2) ≈ 0.714
  assert.ok(Math.abs(first / total - 5 / 7) < 0.01, `比例应约 5/7，实际 ${first / total}`);
});

test('权重：三套 1 / 3 / 5 → 分别是 1/9、3/9、5/9', () => {
  const variants = [{ weight: 1 }, { weight: 3 }, { weight: 5 }];
  const counts = [0, 0, 0];
  const total = 900;
  for (let index = 0; index < total; index += 1) {
    counts[pickVariantIndex(variants, () => index / total)] += 1;
  }
  assert.ok(Math.abs(counts[0] / total - 1 / 9) < 0.02, `第 1 套应约 1/9，实际 ${counts[0] / total}`);
  assert.ok(Math.abs(counts[1] / total - 3 / 9) < 0.02, `第 2 套应约 3/9，实际 ${counts[1] / total}`);
  assert.ok(Math.abs(counts[2] / total - 5 / 9) < 0.02, `第 3 套应约 5/9，实际 ${counts[2] / total}`);
});

test('权重：新增一套动画**不必改动**原有数字（这是相对比例的意义）', () => {
  // 两套 5:5 → 各 50%
  assert.equal(pickVariantIndex([{ weight: 5 }, { weight: 5 }], () => 0.4), 0);
  assert.equal(pickVariantIndex([{ weight: 5 }, { weight: 5 }], () => 0.6), 1);
  // 追加一套 5 → 仍是 5:5:5，各 1/3。原有两个 5 一个字都没改
  assert.equal(pickVariantIndex([{ weight: 5 }, { weight: 5 }, { weight: 5 }], () => 0.2), 0);
  assert.equal(pickVariantIndex([{ weight: 5 }, { weight: 5 }, { weight: 5 }], () => 0.5), 1);
  assert.equal(pickVariantIndex([{ weight: 5 }, { weight: 5 }, { weight: 5 }], () => 0.9), 2);
});

test('权重：单套动画恒选中它（不做无意义的随机）', () => {
  assert.equal(pickVariantIndex([{ weight: 1 }], () => 0.99), 0);
  assert.equal(pickVariantIndex([{ weight: 0 }], () => 0.5), 0);
});

test('权重：空数组返回 -1（调用方据此判「没有可播的」）', () => {
  assert.equal(pickVariantIndex([], () => 0.5), -1);
  assert.equal(pickVariantIndex(null, () => 0.5), -1);
  assert.equal(pickVariantIndex(undefined), -1);
});

test('权重：全为 0 时退化为等概率（而不是一套都选不出来）', () => {
  // 作者写错了，但让宠物卡死比随便播一套更糟
  const variants = [{ weight: 0 }, { weight: 0 }, { weight: 0 }];
  assert.equal(pickVariantIndex(variants, () => 0), 0);
  assert.equal(pickVariantIndex(variants, () => 0.5), 1);
  assert.equal(pickVariantIndex(variants, () => 0.99), 2);
});

test('权重：0 权重的那一套不会被抽中（保留素材但停用）', () => {
  const variants = [{ weight: 0 }, { weight: 10 }];
  for (let index = 0; index < 100; index += 1) {
    assert.equal(pickVariantIndex(variants, () => index / 100), 1);
  }
});

test('权重：random 返回 1（越界）时仍落在最后一套', () => {
  const variants = [{ weight: 1 }, { weight: 1 }];
  assert.equal(pickVariantIndex(variants, () => 1), 1);
});

test('权重：非法值被规范化成默认权重', () => {
  assert.equal(normalizeWeight(undefined), 1);
  assert.equal(normalizeWeight('abc'), 1);
  assert.equal(normalizeWeight(NaN), 1);
  assert.equal(normalizeWeight(-5), 0, '负数夹到 0');
  assert.equal(normalizeWeight(99999), 1000, '超大值夹到上限');
  assert.equal(normalizeWeight(2.5), 2.5);
});

test('可播变体：优先读 variants，缺失时回退到条目自身字段', () => {
  // 前后端可能版本错配（宿主缓存 / 用户手动换插件目录），因此必须有回退
  const withVariants = playableVariants({
    url: '/main',
    frames: 4,
    variants: [
      { url: '/a', frames: 4, fps: 6, weight: 5 },
      { url: '/b', frames: 2, fps: 8, weight: 3 },
    ],
  });
  assert.equal(withVariants.length, 2);
  assert.equal(withVariants[0].url, '/a');
  assert.equal(withVariants[1].frames, 2);

  // 老后端：只有主变体字段
  const legacy = playableVariants({ url: '/main', frames: 3, fps: 12, loop: false });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].url, '/main');
  assert.equal(legacy[0].frames, 3);
  assert.equal(legacy[0].loop, false);
});

test('可播变体：跳过没有 URL 的变体（声明了图但文件缺失）', () => {
  const list = playableVariants({
    url: '/main',
    variants: [
      { url: '', frames: 4, weight: 5 },
      { url: '/b', frames: 2, weight: 3 },
    ],
  });
  assert.equal(list.length, 1, '空 URL 的那套应被跳过');
  assert.equal(list[0].url, '/b');
});

test('可播变体：完全没有图时返回空数组', () => {
  assert.deepEqual(playableVariants({ url: '', frames: 1 }), []);
  assert.deepEqual(playableVariants(null), []);
  assert.deepEqual(playableVariants({ variants: [{ url: '' }] }), []);
});

// ============================================ 每动作单帧尺寸（横 / 竖构图共存）

test('单帧尺寸：变体自带 > 动作条目 > 包级', () => {
  const base = { w: 384, h: 576 };
  // 变体自带时用它（最具体的一层）
  assert.deepEqual(
    frameSizeOf({ size: { w: 627, h: 353 } }, { size: { w: 100, h: 200 } }, base),
    { w: 627, h: 353 },
  );
  // 变体没有、动作条目有 → 用动作条目的
  assert.deepEqual(
    frameSizeOf({}, { size: { w: 100, h: 200 } }, base),
    { w: 100, h: 200 },
  );
  // 两层都没有 → 回落到包级
  assert.deepEqual(frameSizeOf({}, {}, base), { w: 384, h: 576 });
  assert.deepEqual(frameSizeOf(null, null, base), { w: 384, h: 576 });
});

test('单帧尺寸：躺姿与站立可以同时存在，互不干扰', () => {
  const base = { w: 384, h: 576 };        // 站立：竖构图
  const lying = { size: { w: 627, h: 353 } };  // 躺姿：横构图
  const standing = frameSizeOf({}, {}, base);
  const sleep = frameSizeOf(lying, {}, base);
  assert.ok(sleep.w > sleep.h, '躺姿应是横构图');
  assert.ok(standing.h > standing.w, '站立应是竖构图');
});

test('单帧尺寸：非法值被跳过而不是污染几何', () => {
  const base = { w: 384, h: 576 };
  // 0 / 负数 / NaN / 缺一个方向 —— 都不该被采纳
  assert.deepEqual(frameSizeOf({ size: { w: 0, h: 100 } }, {}, base), base);
  assert.deepEqual(frameSizeOf({ size: { w: -5, h: 100 } }, {}, base), base);
  assert.deepEqual(frameSizeOf({ size: { w: NaN, h: 100 } }, {}, base), base);
  assert.deepEqual(frameSizeOf({ size: { w: 100 } }, {}, base), base);
  assert.deepEqual(frameSizeOf({ size: 'big' }, {}, base), base);
});

test('单帧尺寸：全都没有时用默认值（不返回 0，否则会被 Math.max 拉成怪值）', () => {
  assert.deepEqual(frameSizeOf({}, {}, {}), { w: 64, h: 64 });
  assert.deepEqual(frameSizeOf(null, null, null), { w: 64, h: 64 });
});

test('单帧尺寸：非法层会继续往下找，而不是直接放弃', () => {
  const base = { w: 384, h: 576 };
  // 变体的尺寸非法 → 应继续用动作条目的，而不是跳到默认值
  assert.deepEqual(
    frameSizeOf({ size: { w: 0, h: 0 } }, { size: { w: 627, h: 353 } }, base),
    { w: 627, h: 353 },
  );
});

test('可播变体：尺寸随帧参数一起流出（否则换动作会「帧换了、尺寸没换」）', () => {
  const list = playableVariants({
    url: '/main',
    variants: [
      { url: '/a', frames: 4, size: { w: 627, h: 353 } },
      { url: '/b', frames: 2 },
    ],
  });
  assert.deepEqual(list[0].size, { w: 627, h: 353 });
  assert.equal(list[1].size, undefined, '没声明的不该被补成默认值');
});

test('可播变体：老后端只给主变体字段时，尺寸也能透出', () => {
  const legacy = playableVariants({ url: '/main', frames: 3, size: { w: 627, h: 353 } });
  assert.deepEqual(legacy[0].size, { w: 627, h: 353 });
  // 完全没给尺寸 → undefined，由 frameSizeOf 回落到包级
  const older = playableVariants({ url: '/main', frames: 3 });
  assert.equal(older[0].size, undefined);
});

test('动作时长：非均匀时长下逐帧求和', () => {
  assert.equal(animationDuration({ frames: 4, fps: 10, frameMs: [400, 100, 100, 600] }), 1200);
});

test('动作时长：均匀时是 frames / fps', () => {
  assert.equal(animationDuration({ frames: 4, fps: 8 }), 500);
  assert.equal(animationDuration({ frames: 3, fps: 12 }), 250);
});

test('动作时长：非法输入返回 0（调用方自己兜底，而不是 NaN 传播）', () => {
  assert.equal(animationDuration(null), 0);
  assert.equal(animationDuration({ frames: 0, fps: 0 }), 0);
  assert.equal(animationDuration({ frames: 4, fps: 0, frameMs: [] }), 0);
});

// ============================== 时间驱动行为的触发节奏（本轮新增）

test('节奏调度：抽出的间隔落在配置区间内', () => {
  const scheduler = createBehaviorScheduler({ random: () => 0 });
  scheduler.setSchedule({ idle: { minIntervalMs: 6000, maxIntervalMs: 18000 } });
  assert.equal(scheduler.reschedule('idle'), 6, 'random=0 → 取下界');
  const high = createBehaviorScheduler({ random: () => 0.999999 });
  high.setSchedule({ idle: { minIntervalMs: 6000, maxIntervalMs: 18000 } });
  assert.ok(high.reschedule('idle') <= 18 && high.reschedule('idle') >= 6);
});

test('节奏调度：每次都是**重新抽**（不是固定周期）', () => {
  // 固定周期看起来像节拍器；「它自己想动一下」才像活着
  let call = 0;
  const rolls = [0, 0.5, 1, 0.25];
  const scheduler = createBehaviorScheduler({ random: () => rolls[call++ % rolls.length] });
  scheduler.setSchedule({ idle: { minIntervalMs: 1000, maxIntervalMs: 2000 } });
  const first = scheduler.reschedule('idle');
  const second = scheduler.reschedule('idle');
  assert.notEqual(first, second, '两次抽出的间隔应当不同');
});

test('节奏调度：默认区间是 idle 6~18 秒、roam 3~9 秒（不烦人）', () => {
  const scheduler = createBehaviorScheduler();
  assert.equal(scheduler.get('idle').minMs, DEFAULT_SCHEDULE_MS.idle.min);
  assert.equal(scheduler.get('idle').maxMs, DEFAULT_SCHEDULE_MS.idle.max);
  assert.equal(scheduler.get('roam').minMs, DEFAULT_SCHEDULE_MS.roam.min);
  assert.equal(scheduler.get('roam').maxMs, DEFAULT_SCHEDULE_MS.roam.max);
});

test('节奏调度：★ 漫游的间隔也能配置（用户要求「调整不同动作的触发时间」）', () => {
  const scheduler = createBehaviorScheduler({ random: () => 0 });
  scheduler.setSchedule({ roam: { minIntervalMs: 1000, maxIntervalMs: 2000 } });
  assert.equal(scheduler.get('roam').minMs, 1000);
  assert.equal(scheduler.reschedule('roam'), 1);
  // 没给的行为仍然拿默认值（调用方不必判空）
  assert.equal(scheduler.get('idle').minMs, DEFAULT_SCHEDULE_MS.idle.min);
});

test('节奏调度：两个行为互相独立', () => {
  const scheduler = createBehaviorScheduler({ random: () => 0 });
  scheduler.setSchedule({
    idle: { minIntervalMs: 5000, maxIntervalMs: 6000 },
    roam: { minIntervalMs: 1000, maxIntervalMs: 2000 },
  });
  assert.equal(scheduler.reschedule('idle'), 5);
  assert.equal(scheduler.reschedule('roam'), 1);
});

test('节奏调度：采用后端下发的 schedule', () => {
  const scheduler = createBehaviorScheduler();
  scheduler.setSchedule({
    idle: { minIntervalMs: 3000, maxIntervalMs: 4000, plays: 2, mode: 'random' },
    roam: { minIntervalMs: 800, maxIntervalMs: 900 },
  });
  assert.equal(scheduler.get('idle').minMs, 3000);
  assert.equal(scheduler.get('idle').maxMs, 4000);
  assert.equal(scheduler.get('idle').plays, 2);
  assert.equal(scheduler.get('roam').minMs, 800);
});

test('节奏调度：区间写反了自动调正（不报错）', () => {
  const scheduler = createBehaviorScheduler();
  scheduler.setSchedule({ idle: { minIntervalMs: 9000, maxIntervalMs: 2000 } });
  assert.equal(scheduler.get('idle').minMs, 2000);
  assert.equal(scheduler.get('idle').maxMs, 9000);
});

test('节奏调度：缺失/非法配置回落到默认值', () => {
  const scheduler = createBehaviorScheduler();
  scheduler.setSchedule({});
  assert.equal(scheduler.get('idle').minMs, DEFAULT_SCHEDULE_MS.idle.min);
  scheduler.setSchedule(null);
  assert.equal(scheduler.get('idle').maxMs, DEFAULT_SCHEDULE_MS.idle.max);
  scheduler.setSchedule({ idle: { minIntervalMs: -5, maxIntervalMs: 'x' } });
  assert.equal(scheduler.get('idle').minMs, DEFAULT_SCHEDULE_MS.idle.min);
});

test('节奏调度：mode 只认 loop，其余一律 random', () => {
  const scheduler = createBehaviorScheduler();
  scheduler.setSchedule({ idle: { mode: 'loop' } });
  assert.equal(scheduler.get('idle').mode, 'loop');
  scheduler.setSchedule({ idle: { mode: '什么鬼' } });
  assert.equal(scheduler.get('idle').mode, 'random', '非法值必须回落到 random');
});

test('节奏调度：可设置的行为名单与后端一致（idle / roam / sleep）', () => {
  // 事件驱动的动作（click / fall / happy…）没有「多久触发一次」可言，
  // 因此名单里**不能**出现它们——前端多认一个就会让面板渲染出一个
  // 后端会拒绝的滑块。
  //
  // `sleep` 是后加的（用户要求「多长时间不管就睡觉」），它是**阈值**
  // 而不是区间——形状不同，见下面的测试。
  assert.deepEqual([...SCHEDULE_BEHAVIORS].sort(), ['idle', 'roam', 'sleep']);
});

test('节奏调度：sleep 是阈值（afterMs），不套用区间的随机语义', () => {
  const scheduler = createIdleScheduler();
  // 没设时是 null：表示「跟随宿主的全局 sleep_after」，
  // **不能**填一个默认值——那会让全局设置永远不生效。
  scheduler.setSchedule({});
  assert.equal(scheduler.get('sleep').afterMs, null, '没设时必须是 null');

  scheduler.setSchedule({ sleep: { afterMs: 45000 } });
  assert.equal(scheduler.get('sleep').afterMs, 45000);

  // 区间型的字段对 sleep 没有意义：给了也不该被当成区间读
  scheduler.setSchedule({ sleep: { minIntervalMs: 1000, maxIntervalMs: 2000 } });
  assert.equal(scheduler.get('sleep').afterMs, null, 'sleep 不认区间字段');

  // 非法值回落到 null（而不是 0 或 NaN——那会让阈值判定失效）
  scheduler.setSchedule({ sleep: { afterMs: 'abc' } });
  assert.equal(scheduler.get('sleep').afterMs, null);
  scheduler.setSchedule({ sleep: { afterMs: -5 } });
  assert.equal(scheduler.get('sleep').afterMs, null);
});

test('节奏调度：旧名 createIdleScheduler 仍可用（别名，避免验收脚本失效）', () => {
  const scheduler = createIdleScheduler();
  scheduler.setSchedule({ idle: { minIntervalMs: 1000, maxIntervalMs: 2000 } });
  assert.equal(scheduler.get('idle').minMs, 1000);
});

// ==================================== 标准图像（本轮新增，修「卡在抬头帧」）

test('标准图像：取后端算好的 url / 帧号 / 排布', () => {
  const still = stillFrame({
    still: { url: '/api/plugins/stm-pet/frame/x/still?v=1', frames: 4, frame: 2, layout: 'horizontal' },
  });
  assert.equal(still.url, '/api/plugins/stm-pet/frame/x/still?v=1');
  assert.equal(still.frames, 4);
  assert.equal(still.frame, 2);
  assert.equal(still.layout, 'horizontal');
});

test('标准图像：帧号越界时夹回范围内（脏数据不该画出框外）', () => {
  const still = stillFrame({
    still: { url: 'u', frames: 4, frame: 99 },
  });
  assert.equal(still.frame, 3, '越界要夹到末帧');
  const negative = stillFrame({ still: { url: 'u', frames: 4, frame: -3 } });
  assert.equal(negative.frame, 0);
});

test('标准图像：没有图时返回 null（调用方保持当前绘制，而不是清空）', () => {
  assert.equal(stillFrame(null), null);
  assert.equal(stillFrame({}), null);
  assert.equal(stillFrame({ still: { url: '' } }), null);
});

test('标准图像：透出 declared，让面板能提示「建议显式设一张」', () => {
  assert.equal(stillFrame({ still: { url: 'u', declared: true } }).declared, true);
  assert.equal(stillFrame({ still: { url: 'u' } }).declared, false);
});

// ================================================ 点击 / 拖拽手势（第 5 项）


test('手势：按下瞬间**不**进入拖拽（这是点击能触发的前提）', () => {
  const gesture = createGesture();
  assert.equal(gesture.begin(100, 100, 0), false, '按下不该立刻变成拖拽');
  assert.equal(gesture.phase, GESTURE_PENDING);
  assert.equal(gesture.dragging, false);
});

test('手势：短按 + 无位移 = 点击', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  const outcome = gesture.end(101, 101, 120);
  assert.equal(outcome.kind, 'click');
  assert.equal(outcome.dragged, false);
  assert.equal(gesture.phase, GESTURE_DONE);
});

test('手势：按住不动超过 0.5 秒 → 进入拖拽', () => {
  // 「不动」意味着不会收到 pointermove，因此必须靠时间推进判定
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  assert.equal(gesture.tick(200), false, '0.2 秒还不到阈值');
  assert.equal(gesture.phase, GESTURE_PENDING);
  assert.equal(gesture.tick(DEFAULT_HOLD_MS + 1), true, '超过 0.5 秒应升级');
  assert.equal(gesture.phase, GESTURE_DRAG);
  assert.equal(gesture.dragging, true);
});

test('手势：位移超过阈值 → **立刻**进入拖拽（不必等长按）', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  assert.equal(gesture.move(103, 100, 50), false, '3px 还在容差内');
  assert.equal(gesture.move(110, 100, 60), true, '10px 应立刻升级');
  assert.equal(gesture.phase, GESTURE_DRAG);
});

test('手势：位移阈值是按直线距离算的（斜着移动也算）', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  // 3-4-5 直角三角形：dx=3, dy=4 → 距离恰好 5（等于阈值，不升级）
  assert.equal(gesture.move(103, 104, 10), false);
  // dx=6, dy=8 → 距离 10，升级
  assert.equal(gesture.move(106, 108, 20), true);
});

test('手势：升级后不再退回（用户已经在拖了）', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  gesture.move(200, 100, 20); // 升级
  assert.equal(gesture.phase, GESTURE_DRAG);
  // 拖回来贴近起点也不该退回 pending
  assert.equal(gesture.move(100, 100, 30), false, '已经是拖拽，不该再"升级"');
  assert.equal(gesture.phase, GESTURE_DRAG);
});

test('手势：过程中进过拖拽 → 松手算拖拽（即使最后回到了起点）', () => {
  // 判定规则与「升级」规则必须对称，否则会出现
  // 「看着像点击、结果被当成拖拽」这类前后不一致
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  gesture.move(300, 100, 100); // 升级成拖拽
  gesture.move(100, 100, 200); // 又拖回起点
  const outcome = gesture.end(100, 100, 300);
  assert.equal(outcome.kind, 'drag');
  assert.equal(outcome.dragged, true);
});

test('手势：松手时的最终位移也参与判定（对称性）', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  // 中间没移动过（没升级），但松手位置离起点很远 → 仍是拖拽
  const outcome = gesture.end(150, 100, 100);
  assert.equal(outcome.kind, 'drag', '最终位移超阈值应算拖拽');
});

test('手势：长按后松手 = 拖拽（不是点击）', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  gesture.tick(DEFAULT_HOLD_MS + 1);
  const outcome = gesture.end(100, 100, DEFAULT_HOLD_MS + 50);
  assert.equal(outcome.kind, 'drag');
  assert.equal(outcome.dragged, true);
});

test('手势：end 回报按住时长与位移（排查用）', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 1000);
  // 位移 2px（在 5px 容差内），按住 400ms（在 500ms 阈值内）→ 点击
  const outcome = gesture.end(102, 100, 1400);
  assert.equal(outcome.heldMs, 400);
  assert.equal(outcome.travelled, 2);
  assert.equal(outcome.kind, 'click');
});

test('手势：位移只记**最大**位移（来回晃不算数）', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  gesture.move(104, 100, 10);
  gesture.move(100, 100, 20);
  const outcome = gesture.end(100, 100, 30);
  assert.equal(outcome.travelled, 4, '应记住过程中最远的那次');
});

test('手势：cancel 后回到 done，后续事件不再影响', () => {
  const gesture = createGesture();
  gesture.begin(100, 100, 0);
  gesture.cancel();
  assert.equal(gesture.phase, GESTURE_DONE);
  assert.equal(gesture.tick(99999), false, 'cancel 后不该再升级');
  assert.equal(gesture.move(500, 500, 99999), false);
});

test('手势：未按下时 end 不崩，按点击处理', () => {
  const gesture = createGesture();
  const outcome = gesture.end(10, 10, 10);
  assert.equal(outcome.kind, 'click');
});

test('手势：阈值可配置（不同形象的点击容差可能不同）', () => {
  const gesture = createGesture({ holdMs: 100, slop: 2 });
  assert.equal(gesture.holdMs, 100);
  assert.equal(gesture.slop, 2);
  gesture.begin(0, 0, 0);
  assert.equal(gesture.tick(101), true, '0.1 秒就该升级');
});

test('手势：非法阈值回落到默认（不出现"永远拖不动"）', () => {
  const gesture = createGesture({ holdMs: 0, slop: -1 });
  assert.equal(gesture.holdMs, DEFAULT_HOLD_MS);
  assert.equal(gesture.slop, DEFAULT_SLOP);
});

test('手势：默认阈值就是用户要求的 0.5 秒', () => {
  assert.equal(DEFAULT_HOLD_MS, 500, '用户明确要求「按住 0.5s 后才触发」');
});

test('手势：elapsed 在 done 状态返回 0', () => {
  const gesture = createGesture();
  assert.equal(gesture.elapsed(999), 0);
  gesture.begin(0, 0, 100);
  assert.equal(gesture.elapsed(600), 500);
  assert.equal(gesture.elapsed(50), 0, '不应为负');
});
