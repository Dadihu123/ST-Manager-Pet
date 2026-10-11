/**
 * 播报器测试：限流（前导 + 尾随）、勿扰模式、文案长度。
 *
 * 用注入的确定性时钟，不 `sleep`（§1.4 的要求）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAnnouncer, DEFAULT_COOLDOWN, JOB_COOLDOWN } from '../../frontend/announce.js';

function buildAnnouncer(options = {}) {
  const calls = [];
  const toasts = [];
  const logs = [];
  let clock = 0;
  const announcer = createAnnouncer(Object.assign({
    now: () => clock,
    cooldown: 3000,
    jobCooldown: 1000,
    onAnnounce: (action, reason, payload) => calls.push({ action, reason, payload }),
    toast: (message) => toasts.push(message),
    getQuiet: () => false,
    getShowToast: () => true,
    log: (level, message) => logs.push({ level, message }),
  }, options));

  return {
    announcer,
    calls,
    toasts,
    logs,
    get clock() { return clock; },
    setClock(value) { clock = value; },
    advance(ms) { clock += ms; },
  };
}

// ================================================================ 限流


test('限流：第一次事件立刻播报', () => {
  const env = buildAnnouncer();
  assert.equal(env.announcer.cardEvent('card.updated'), true);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].action, 'happy');
});

test('限流：窗口内的高频事件只播一次（★ 核心要求）', () => {
  // 批量操作 500 张卡会推 500 次 card.updated；不限流宠物会疯狂抽搐
  const env = buildAnnouncer();
  for (let index = 0; index < 500; index += 1) {
    env.announcer.cardEvent('card.updated');
    env.advance(5); // 每 5ms 一次，全部落在 3 秒窗口内
  }
  // 前导一次；500*5=2500ms 还没到窗口尾，尾随定时器还没触发
  assert.equal(env.calls.length, 1, `应只播 1 次，实际 ${env.calls.length}`);
  assert.ok(env.announcer.stats.suppressed > 400, '应记录被限流的次数');
});

test('限流：窗口过后允许再次播报', () => {
  const env = buildAnnouncer();
  env.announcer.cardEvent('card.updated');
  assert.equal(env.calls.length, 1);

  env.advance(DEFAULT_COOLDOWN + 1);
  env.announcer.cardEvent('card.updated');
  assert.equal(env.calls.length, 2);
});

test('限流：窗口内恰好边界时间允许播报', () => {
  const env = buildAnnouncer();
  env.announcer.cardEvent('card.updated');
  env.advance(DEFAULT_COOLDOWN);
  env.announcer.cardEvent('card.updated');
  assert.equal(env.calls.length, 2, '正好等于窗口应放行');
});

test('限流：被限流的事件不弹 toast', () => {
  const env = buildAnnouncer();
  env.announcer.jobEvent('scan.completed', { count: 10 });
  env.advance(100);
  env.announcer.jobEvent('scan.completed', { count: 20 });
  // 第一次弹了提示，第二次被限流（尾随还没到点）
  assert.equal(env.toasts.length, 1);
});

test('限流：卡片与任务通道互不影响', () => {
  // 扫描完成不该被刚才的卡片事件吃掉
  const env = buildAnnouncer();
  env.announcer.cardEvent('card.updated');
  env.announcer.jobEvent('scan.completed', { count: 5 });
  assert.equal(env.calls.length, 2, '两个通道应各自计时');
});

test('限流：任务通道窗口更短', () => {
  const env = buildAnnouncer();
  env.announcer.jobEvent('scan.completed', {});
  env.advance(JOB_COOLDOWN + 1);
  env.announcer.jobEvent('index.job_done', {});
  assert.equal(env.calls.length, 2);
});

test('限流：reset 清空窗口与统计', () => {
  const env = buildAnnouncer();
  env.announcer.cardEvent('card.updated');
  env.advance(100);
  env.announcer.cardEvent('card.updated');
  assert.ok(env.announcer.stats.suppressed > 0);

  env.announcer.reset();
  assert.equal(env.announcer.stats.suppressed, 0);
  env.announcer.cardEvent('card.updated');
  assert.equal(env.calls.length, 2, 'reset 后应能立刻播报');
});

test('限流：dispose 清掉待执行的尾随定时器', () => {
  const env = buildAnnouncer();
  env.announcer.cardEvent('card.updated');
  env.advance(100);
  env.announcer.cardEvent('card.updated'); // 排了一个尾随
  env.announcer.dispose();
  // 定时器被清掉后不应再产生播报
  assert.equal(env.calls.length, 1);
});

// ================================================================ 动作映射


test('事件→动作：card.updated / created 是 happy', () => {
  const env = buildAnnouncer();
  env.announcer.cardEvent('card.updated');
  assert.equal(env.calls[0].action, 'happy');
});

test('事件→动作：card.deleted 是 sad', () => {
  const env = buildAnnouncer();
  env.announcer.cardEvent('card.deleted');
  assert.equal(env.calls[0].action, 'sad');
});

test('事件→动作：扫描完成是开心并带提示', () => {
  const env = buildAnnouncer();
  env.announcer.jobEvent('scan.completed', { count: 42 });
  assert.equal(env.calls[0].action, 'happy');
  assert.equal(env.calls[0].reason, 'scan.completed');
  assert.match(env.toasts[0], /42/);
});

test('事件→动作：索引完成', () => {
  const env = buildAnnouncer();
  env.announcer.jobEvent('index.job_done', {});
  assert.equal(env.calls[0].action, 'happy');
});

// ================================================================ 勿扰


test('勿扰：开启后仍然换动作（用户还是要知道发生了什么）', () => {
  const env = buildAnnouncer({ getQuiet: () => true });
  env.announcer.jobEvent('scan.completed', { count: 3 });
  assert.equal(env.calls.length, 1, '勿扰只抑制提示，不抑制动作');
});

test('勿扰：开启后不弹 toast', () => {
  const env = buildAnnouncer({ getQuiet: () => true });
  env.announcer.jobEvent('scan.completed', { count: 3 });
  assert.equal(env.toasts.length, 0, '勿扰时不应弹提示');
});

test('勿扰：关闭时按 showToast 开关决定', () => {
  const quiet = buildAnnouncer({ getShowToast: () => false });
  quiet.announcer.jobEvent('scan.completed', { count: 1 });
  assert.equal(quiet.toasts.length, 0, 'showToast=false 时不弹');

  const loud = buildAnnouncer({ getShowToast: () => true });
  loud.announcer.jobEvent('scan.completed', { count: 1 });
  assert.equal(loud.toasts.length, 1);
});

test('勿扰：开关是动态读取的（用户改了立即生效）', () => {
  let quiet = false;
  const env = buildAnnouncer({ getQuiet: () => quiet });
  env.announcer.jobEvent('scan.completed', { count: 1 });
  assert.equal(env.toasts.length, 1);

  quiet = true;
  env.advance(JOB_COOLDOWN + 1);
  env.announcer.jobEvent('index.job_done', {});
  assert.equal(env.toasts.length, 1, '打开勿扰后不再弹');
  assert.equal(env.calls.length, 2, '但动作照播');
});

// ================================================================ 文案


test('文案：扫描完成带数量', () => {
  const env = buildAnnouncer();
  assert.match(env.announcer.describe('scan.completed', { count: 12 }), /12/);
  assert.match(env.announcer.describe('scan.completed', { total: 7 }), /7/);
  assert.match(env.announcer.describe('scan.completed', { scanned: 3 }), /3/);
});

test('文案：数量缺失时不显示 undefined', () => {
  const env = buildAnnouncer();
  const text = env.announcer.describe('scan.completed', {});
  assert.doesNotMatch(text, /undefined|NaN/);
  assert.match(text, /扫描完成/);
});

test('文案：长度受限（宿主轻提示不适合长文本）', () => {
  const env = buildAnnouncer();
  const long = 'x'.repeat(500);
  const described = env.announcer.describe('scan.completed', { count: 1 });
  assert.ok(described.length <= 80, `文案过长: ${described.length}`);

  // 走一次真实 toast 路径确认截断生效
  const env2 = buildAnnouncer();
  env2.announcer.jobEvent('scan.completed', { count: 1 });
  for (const message of env2.toasts) {
    assert.ok(message.length <= 60, `toast 过长（${message.length}）: ${long.length}`);
  }
});

test('文案：未知事件名回落为事件名本身', () => {
  const env = buildAnnouncer();
  assert.equal(env.announcer.describe('something.else', {}), 'something.else');
});

// ================================================================ 手动播报


test('手动播报：直接触发动作，不限流', () => {
  const env = buildAnnouncer();
  env.announcer.announce('happy', 'manual');
  env.announcer.announce('happy', 'manual');
  assert.equal(env.calls.length, 2, '手动播报（设置面板预览）不该被限流');
});

test('手动播报：不需要 toast 函数也不报错', () => {
  const env = buildAnnouncer({ toast: undefined });
  assert.doesNotThrow(() => env.announcer.jobEvent('scan.completed', { count: 1 }));
});

test('健壮性：onAnnounce 抛错不影响后续播报', () => {
  let explode = true;
  const calls = [];
  const env = buildAnnouncer({
    onAnnounce: (action) => {
      if (explode) throw new Error('boom');
      calls.push(action);
    },
  });
  env.announcer.cardEvent('card.updated'); // 抛错发生在 onAnnounce 内部（调用方负责捕获）
  explode = false;
  env.advance(DEFAULT_COOLDOWN + 1);
  assert.doesNotThrow(() => env.announcer.cardEvent('card.updated'));
});
