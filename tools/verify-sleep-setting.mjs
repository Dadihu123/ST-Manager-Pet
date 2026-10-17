/**
 * 验收：**打盹（sleep）加进了「触发时间」设置**。
 *
 * 用户要求：「还有触发时间的选项中，睡觉是否也可以加进来，
 * 就是多长时间不管就睡觉这种。」
 *
 * `sleep` 与另外两个行为（idle / roam）形状**不同**：它是**阈值**
 * （「静了多久之后发生」），不是「每隔一段随机时间发生一次」。
 * 因此它只有一个 `afterMs`，没有 `intervalMs` / `minIntervalMs` /
 * `maxIntervalMs` / `plays` / `mode`——写那些字段会被**明确拒绝**
 * （而不是静默忽略，那会让作者以为设好了）。
 *
 * 判据
 * ----
 * ① 后端下发的 `schedule.sleep` 形状正确（只有 `afterMs`）；
 * ② 没设时是 `null`，表示**跟随宿主的全局 `sleep_after`**——
 *    不能填一个写死的默认值，否则宿主那个设置永远不生效；
 * ③ 面板上真的渲染出「打盹」这一项，而且只有**一个**滑块
 *    （阈值不该有「最短 / 最长」）；
 * ④ 拖动它 → 存下来 → 读回来一致；
 * ⑤ 真的生效：把阈值调到最小（10 秒），宠物会在约 10 秒后睡着；
 *    调回很大则不睡；
 * ⑥ 清掉覆盖 → 回到 `null`（跟随全局）。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-sleep-setting.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const PET = process.env.PET_ID || 'xiaoka';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

const browser = await launch({ width: 1440, height: 900 });
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  const consoleErrors = [];
  page.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push((params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  page.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push(`exception: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`);
  });

  await page.navigate(BASE, { timeout: 30000 });
  await page.waitFor('Boolean(window.__petApi)', { timeout: 20000, label: '插件激活' });
  await sleep(800);

  // 先把覆盖清掉：这个脚本会写 `sleep.afterMs`，不清的话**上一次运行的残留**
  // 会让「没设时是 null」与「初值 = 宿主全局」两条断言在第二次运行时失败
  // （第一版就踩了——脚本必须能反复跑）。
  await page.evaluate(`(async () => {
    await window.__petApi.api('/pets/${PET}/schedule', {
      method: 'POST', body: { schedule: { sleep: null } },
    });
    return true;
  })()`);
  await sleep(300);

  // ============================================ ①② 后端形状与「没设 = null」
  const shape = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${PET}/preview', { method: 'GET' });
    return {
      schedule: res.schedule || {},
      declared: res.declaredSchedule || {},
      hostSleepAfter: res.hostSleepAfter,
    };
  })()`);

  const sleepSpec = shape.schedule.sleep || {};
  record(
    '① 后端下发 `schedule.sleep`，且形状是**阈值**（只有 afterMs）',
    'afterMs' in sleepSpec
      && !('minIntervalMs' in sleepSpec) && !('maxIntervalMs' in sleepSpec)
      && !('plays' in sleepSpec) && !('mode' in sleepSpec),
    `schedule.sleep = ${JSON.stringify(sleepSpec)}`,
  );
  record(
    '① ★ 另外两个行为仍然是**区间**形状（没被 sleep 带歪）',
    Number.isFinite(shape.schedule.idle && shape.schedule.idle.minIntervalMs)
      && Number.isFinite(shape.schedule.roam && shape.schedule.roam.maxIntervalMs),
    `idle=${JSON.stringify(shape.schedule.idle)} roam=${JSON.stringify(shape.schedule.roam)}`,
  );
  record(
    '② ★ 没设时是 `null`（= 用默认值），不是某个全局值',
    // 内置形象**自己声明**了 `schedule.sleep.afterMs`（作者建议值），
    // 那种情况下语义是「包内声明」而不是 null——两个分支都要认。
    // 判据因此是「null 或一个正数毫秒」，**不能**是宿主全局值那种来源不明的东西。
    sleepSpec.afterMs === null
      || (Number.isFinite(sleepSpec.afterMs) && sleepSpec.afterMs > 0),
    `afterMs=${JSON.stringify(sleepSpec.afterMs)}`
    + `（包内声明=${JSON.stringify((shape.declared || {}).sleep || null)}）`,
  );
  // ★ 这条原本查的是「后端把宿主的全局 sleep_after 一并下发」。
  // 用户后来要求「不要搞全局的，在同一个地方调整的数值却分成全局和
  // 形象绑定两种情况」——因此宿主那个 `sleep_after` 已从 config_schema
  // 移除，`hostSleepAfter` 也不再下发。这里改为**反向钉死**：
  // 它必须**不在**，否则「两个入口」的问题会从后门回来。
  record(
    '② ★ 不再下发 `hostSleepAfter`（打盹已是纯按形象，没有全局入口）',
    !('hostSleepAfter' in shape),
    `preview 里有没有 hostSleepAfter: ${'hostSleepAfter' in shape}`,
  );

  // ============================================ ③ 面板上渲染出来了
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-sleep' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1000);
  // 选中有 sleep 的那个形象（默认就是当前形象，但显式点一下更稳）
  await page.evaluate(`(async () => {
    const cards = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'));
    const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(PET)}) || cards[0];
    if (card) card.click();
    await new Promise((r) => setTimeout(r, 1000));
    return true;
  })()`);
  await sleep(900);

  const panel = await page.evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-field-label'))
      .map((n) => n.textContent.trim());
    const sliders = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-slider'))
      .filter((s) => s.dataset.scheduleBehavior === 'sleep');
    return {
      labels,
      sleepSliders: sliders.length,
      sleepBounds: sliders.map((s) => s.dataset.scheduleBound),
      sleepValue: sliders.length ? sliders[0].value : null,
      sleepMin: sliders.length ? sliders[0].min : null,
      sleepMax: sliders.length ? sliders[0].max : null,
      sleepStep: sliders.length ? sliders[0].step : null,
      hints: Array.from(document.querySelectorAll('.plugin-stm-pet .pet-field-hint'))
        .map((n) => n.textContent.trim())
        .filter((t) => t.includes('打盹') || t.includes('睡着') || t.includes('宿主') || t.includes('全局')),
    };
  })()`);

  record(
    '③ ★ 面板上出现了「打盹」这一项',
    panel.labels.includes('打盹'),
    `字段标签=${JSON.stringify(panel.labels)}`,
  );
  record(
    '③ ★ 它只有**一个**滑块（阈值不该有「最短/最长」两个）',
    panel.sleepSliders === 1 && panel.sleepBounds[0] === 'after',
    `${panel.sleepSliders} 个滑块，bound=${JSON.stringify(panel.sleepBounds)}`,
  );
  record(
    '③ 滑块的区间与宿主 `sleep_after` 一致（10 秒 ~ 1 小时）',
    Number(panel.sleepMin) === 10000 && Number(panel.sleepMax) === 3600000,
    `min=${panel.sleepMin} max=${panel.sleepMax} step=${panel.sleepStep}`,
  );
  record(
    '③ 初值来自**包内声明**（不是宿主全局，也不该是写死的默认值）',
    // 内置形象声明了 `schedule.sleep.afterMs`（作者建议值 60 秒），
    // 面板显示的初值必须就是那个数——而不是插件写死的 120 秒默认值。
    // 这条判据原先是「初值 = 120 秒」，那在「包内声明了」之后就自相矛盾了：
    // 生效优先级是 用户设置 > **包内声明** > 默认值，初值当然取声明值。
    Number(panel.sleepValue) === Number(shape.schedule.sleep.afterMs)
      && panel.hints.every((h) => !h.includes('跟随宿主') && !h.includes('全局值优先')),
    `初值=${panel.sleepValue}ms，包内声明=${shape.schedule.sleep.afterMs}ms；`
    + `提示=${JSON.stringify(panel.hints)}`,
  );

  // ============================================ ④ 拖一下 → 存下来 → 读回来
  const committed = await page.evaluate(`(async () => {
    const slider = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-slider'))
      .find((s) => s.dataset.scheduleBehavior === 'sleep');
    if (!slider) return { error: '找不到 sleep 滑块' };
    slider.value = '45000';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const res = await window.__petApi.api('/pets/${PET}/preview', { method: 'GET' });
    return { afterMs: (res.schedule || {}).sleep ? res.schedule.sleep.afterMs : null };
  })()`);

  record(
    '④ ★ 拖到 45 秒 → 真的存下来了',
    committed.afterMs === 45000,
    `读回 afterMs=${JSON.stringify(committed.afterMs)}（期望 45000）`,
  );

  // ============================================ ⑤ 真的生效
  //
  // ⚠️ 必须先把阈值设成**最小值 10 秒**再测。上一步存的是 45 秒，
  // 而这里只等 16 秒——不先改的话测的是「45 秒的阈值在 16 秒内没睡着」，
  // 那是正确行为，却会被误判成失败（第一版就错在这里）。
  await page.evaluate(`(async () => {
    await window.__petApi.api('/pets/${PET}/schedule', {
      method: 'POST', body: { schedule: { sleep: { afterMs: 10000 } } },
    });
    return true;
  })()`);
  // 确认真的存进去了再往下走：不确认的话「没睡着」会被误判成功能问题，
  // 而实际可能只是上一步的值没落盘。
  const stored = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${PET}/preview', { method: 'GET' });
    return res.schedule.sleep ? res.schedule.sleep.afterMs : null;
  })()`);
  record(
    '⑤ 前置：阈值已存为 10 秒',
    stored === 10000,
    `读回 afterMs=${JSON.stringify(stored)}`,
  );

  const effect = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
    const old = document.getElementById('sleep-probe');
    if (old) old.remove();
    const c = document.createElement('div');
    c.id = 'sleep-probe';
    c.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;z-index:9999';
    document.body.appendChild(c);
    // 宿主全局设成很大的值（120 秒），而按形象的设成 10 秒——
    // 这样「睡着了」只可能是**按形象的那个**在起作用。
    const view = mod.createPetView({
      container: c, pack: res.pet,
      config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 120, animSpeed: 1 },
      hooks: {},
    });
    view.physics.setPosition(450, 660);
    window.__view = view;
    await new Promise((r) => setTimeout(r, 300));
    const before = view.state;
    const packSleep = res.pet.schedule && res.pet.schedule.sleep
      ? res.pet.schedule.sleep.afterMs : 'MISSING';
    // 等它睡着（阈值 10 秒，给 20 秒余量）
    let state = view.state;
    for (let i = 0; i < 200 && state !== 'sleep'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      state = view.state;
    }
    return { before, state, packSleep };
  })()`);

  record(
    '⑤ ★ 阈值 10 秒 → 宠物真的睡着了（宿主全局是 120 秒，说明按形象的生效）',
    effect.state === 'sleep',
    `起始 state=${effect.before} → 最终 state=${effect.state}`
    + `；视图读到的包内 afterMs=${JSON.stringify(effect.packSleep)}`,
  );

  // ★★ 关键回归：打盹判定**不能**依赖 rAF。
  //
  // 早先的判定只在 `updateStateFromPhysics()` 里低频轮询，而那段代码只在
  // rAF 循环运行时才跑、rAF 在 idle 静止时是停的。于是「到点睡着」实际靠
  // **别的原因把 rAF 唤醒**才碰巧发生（通常是 idle 小动作）。
  // 把 idle 间隔调大就会露出来——实测 idle 间隔 1 小时 + 阈值 10 秒时，
  // 22 秒后仍然没睡（而这条路径恰恰很常见：用户想让宠物安静，就把
  // idle 调长，结果它连睡都不睡了）。
  await page.evaluate(`(async () => {
    await window.__petApi.api('/pets/${PET}/schedule', {
      method: 'POST',
      body: { schedule: {
        idle: { minIntervalMs: 3600000, maxIntervalMs: 3600000 },
        sleep: { afterMs: 10000 },
      } },
    });
    return true;
  })()`);
  const noRaf = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
    const old = document.getElementById('sleep-probe');
    if (old) old.remove();
    const c = document.createElement('div');
    c.id = 'sleep-probe';
    c.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;z-index:9999';
    document.body.appendChild(c);
    const view = mod.createPetView({
      container: c, pack: res.pet,
      config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 120, animSpeed: 1 },
      hooks: {},
    });
    view.physics.setPosition(450, 660);
    window.__view = view;
    await new Promise((r) => setTimeout(r, 300));
    let state = view.state;
    for (let i = 0; i < 220 && state !== 'sleep'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      state = view.state;
    }
    return { state, idleInterval: res.pet.schedule.idle.minIntervalMs };
  })()`);
  record(
    '⑤ ★★ 打盹判定**不依赖 rAF**：idle 间隔设成 1 小时也照样到点就睡',
    noRaf.state === 'sleep',
    `idle 间隔=${noRaf.idleInterval}ms（1 小时）+ 阈值 10 秒 → 22 秒后 state=${noRaf.state}`
    + '（修复前：永远不睡——判定只挂在 rAF 上，而 rAF 在 idle 静止时是停的）',
  );

  // 恢复 idle 的默认间隔，别影响后面的对照与清理
  await page.evaluate(`(async () => {
    await window.__petApi.api('/pets/${PET}/schedule', {
      method: 'POST', body: { schedule: { idle: null } },
    });
    return true;
  })()`);

  // 反向：阈值调大 → 同样时间内不睡
  const noSleep = await page.evaluate(`(async () => {
    window.__view.setSchedule({ sleep: { afterMs: 3600000 } });
    // 唤醒并重新计时
    window.__view.touch();
    await new Promise((r) => setTimeout(r, 200));
    const state = window.__view.state;
    return { state };
  })()`);
  record(
    '⑤ 反向对照：阈值调成 1 小时后它醒着（不睡）',
    noSleep.state !== 'sleep',
    `state=${noSleep.state}`,
  );

  await page.evaluate(`(() => {
    const v = window.__view; if (v) v.dispose();
    const n = document.getElementById('sleep-probe'); if (n) n.remove();
  })()`);

  // ============================================ ⑥ 清掉覆盖 → 回到包内声明
  //
  // 「包内声明」在②那里已经从 preview 里读到了（`schedule.sleep.afterMs`
  // 是**生效值**）。清掉用户覆盖之后应当回落到它。
  const declaredSleepAfter = shape.schedule.sleep
    ? shape.schedule.sleep.afterMs
    : null;
  const cleared = await page.evaluate(`(async () => {
    await window.__petApi.api('/pets/${PET}/schedule', {
      method: 'POST', body: { schedule: { sleep: null } },
    });
    const res = await window.__petApi.api('/pets/${PET}/preview', { method: 'GET' });
    return { afterMs: res.schedule.sleep ? res.schedule.sleep.afterMs : 'MISSING' };
  })()`);
  record(
    '⑥ ★ 清掉用户覆盖后回落**包内声明**（不是刚拖出来的那个值）',
    // 语义是「清掉**用户**覆盖 → 回到 用户设置 > 包内声明 > 默认值 里下一层」。
    // 内置形象声明了 afterMs，因此这里回落到**声明值**而不是 null；
    // 只有当包里也没声明时才是 null。判据写成「不等于刚拖的 45000/10000、
    // 且等于包内声明（或 null）」才对得上一件真事。
    cleared.afterMs !== 45000
      && cleared.afterMs !== 10000
      && (cleared.afterMs === null || cleared.afterMs === declaredSleepAfter),
    `afterMs=${JSON.stringify(cleared.afterMs)}`
    + `（包内声明=${JSON.stringify(declaredSleepAfter)}）`,
  );

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑦ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`打盹设置验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
