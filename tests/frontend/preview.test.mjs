/**
 * 设置页**动画预览器**的纯计算部分单测。
 *
 * `preview.js` 的播放循环需要 DOM，但它真正容易算错的是**帧时长**与
 * **帧几何**——那两件事都是纯函数，因此在这里测（DOM 部分由
 * `tools/verify-panel.mjs` 在真实浏览器里验）。
 *
 * 运行：node --test "tests/frontend/*.test.mjs"
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frameDurations, totalDuration } from '../../frontend/preview.js';

// ============================================================ 帧时长


test('预览帧时长：优先用非均匀的 frameMs（那才是作者要的节奏）', () => {
  const durations = frameDurations({
    frames: 4, fps: 10, frameMs: [400, 300, 300, 600],
  });
  assert.deepEqual(durations, [400, 300, 300, 600]);
});

test('预览帧时长：没有 frameMs 时用 1000/fps', () => {
  assert.deepEqual(frameDurations({ frames: 3, fps: 8 }), [125, 125, 125]);
  assert.deepEqual(frameDurations({ frames: 2, fps: 2.5 }), [400, 400]);
});

test('预览帧时长：长度与帧数不符时回退到均匀（不抛错）', () => {
  for (const bad of [[100, 200], [1, 2, 3, 4, 5], 'x', null]) {
    const durations = frameDurations({ frames: 4, fps: 10, frameMs: bad });
    assert.equal(durations.length, 4, `${JSON.stringify(bad)} 应回退到均匀`);
    assert.ok(durations.every((value) => value === 100), '应全是 1/fps');
  }
});

test('预览帧时长：非法值回退到均匀', () => {
  for (const bad of [[0, 0, 0, 0], [-1, 100, 100, 100], [NaN, 100, 100, 100]]) {
    const durations = frameDurations({ frames: 4, fps: 10, frameMs: bad });
    assert.ok(durations.every((value) => value === 100), `${JSON.stringify(bad)} 应回退`);
  }
});

test('预览帧时长：单帧动作也返回一项（调用方不必判空）', () => {
  assert.equal(frameDurations({ frames: 1, fps: 6 }).length, 1);
  assert.equal(frameDurations({}).length, 1, '空对象也要有一项');
  assert.equal(frameDurations(null).length, 1);
});

test('预览帧时长：每帧有下限（与 clock.js 的 MAX_FPS 一致）', () => {
  const durations = frameDurations({ frames: 2, fps: 9999 });
  for (const value of durations) {
    assert.ok(value >= 1000 / 60 - 1e-9, `帧时长 ${value} 应不小于 1/60 秒`);
  }
});

test('预览总时长：非均匀时是逐帧之和', () => {
  assert.equal(totalDuration({ frames: 4, fps: 10, frameMs: [400, 300, 300, 600] }), 1600);
});

test('预览总时长：均匀时是 帧数 / fps', () => {
  assert.equal(totalDuration({ frames: 4, fps: 8 }), 500);
  assert.equal(totalDuration({ frames: 3, fps: 12 }), 250);
});

test('预览总时长：与后端的 total_ms 语义一致（同一份数据算出同一个数）', () => {
  // 后端 `AnimationVariant.total_ms` = 逐帧之和；两边的数字必须能对上，
  // 否则「面板显示的一轮时长」与「桌面上真正播的时长」会不一致。
  const variant = { frames: 4, fps: 2.5, frameMs: [400, 300, 300, 600] };
  assert.equal(totalDuration(variant), 1600);
  // 均匀时后端是 frames * 1000 / fps
  assert.equal(totalDuration({ frames: 4, fps: 2.5 }), 1600);
});
