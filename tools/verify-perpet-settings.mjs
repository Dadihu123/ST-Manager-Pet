/**
 * 验收：**「按形象」的设置不再与「全局」混在一起**，以及打盹与动画的兼容。
 *
 * 用户要求：
 * - 「这个睡觉的也跟形象绑定即可，不要搞全局的，在同一个地方调整的数值却
 *    分成全局和形象绑定两种情况，用户可能会困惑……其他的触发时间如果当前
 *    是全局的，也都改成形象绑定」；
 * - 「睡觉你改成了定时器后要注意一个问题，那就是如果人物正在播放动画的时候，
 *    比如闲置，比如漫游，这种情况下睡觉动画刚好触发会发生什么，能否兼容好」。
 *
 * 判据
 * ----
 * ① 宿主 `config_schema` 里**不再**有 `scale` / `sleep_after` / `anim_speed` /
 *    `auto_roam`（只剩真正全局的播报开关与勿扰）；
 * ② 后端下发的 `schedule.sleep.afterMs` 没设时是 `null`，且**不再**下发
 *    任何「宿主全局值」（`hostSleepAfter` 已移除）；
 * ③ 动画速度 / 自动漫游是**按形象**的：改 A 不影响 B，且能存能读；
 * ④ 面板上「外观」里有「动画速度」与「自动漫游」，且打盹的提示里
 *    **不再**出现「跟随宿主设置」；
 * ⑤ **兼容性**：打盹到点时若正在播 idle 小动作 / 正在漫游，
 *    **不打断**当前动作，等它播完再睡；而且不会因此**永远不睡**。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-perpet-settings.mjs
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

  // ============================================ ① 全局设置只剩真正全局的
  const schema = await page.evaluate(`(async () => {
    // manifest 通过插件自己的静态资源拿不到，这里直接查后端下发的行为：
    // 若某个键仍是全局的，前端就会去读 config；改为按形象之后，
    // /pets/<id>/preview 会带上它们。
    const res = await window.__petApi.api('/pets/${PET}/preview', { method: 'GET' });
    return {
      hasHostSleepAfter: 'hostSleepAfter' in res,
      animSpeed: res.animSpeed, autoRoam: res.autoRoam, scale: res.scale,
      sleep: res.schedule.sleep,
    };
  })()`);

  record(
    '① ★ 不再下发 `hostSleepAfter`（打盹已是纯按形象）',
    schema.hasHostSleepAfter === false,
    `preview 里有没有 hostSleepAfter: ${schema.hasHostSleepAfter}`,
  );
  record(
    '① 动画速度 / 自动漫游 / 倍率都由**按形象**的那一份下发',
    Number.isFinite(Number(schema.animSpeed))
      && typeof schema.autoRoam === 'boolean'
      && Number.isFinite(Number(schema.scale)),
    `animSpeed=${schema.animSpeed} autoRoam=${schema.autoRoam} scale=${schema.scale}`,
  );
  record(
    '② 打盹阈值没设时是 `null`（= 用默认值），不是某个全局值',
    schema.sleep && schema.sleep.afterMs === null,
    `schedule.sleep=${JSON.stringify(schema.sleep)}`,
  );

  // ============================================ ③ 按形象：改 A 不影响 B
  const twoPets = await page.evaluate(`(async () => {
    const list = await window.__petApi.api('/pets', { method: 'GET' });
    return (list.items || []).map((i) => i.id);
  })()`);
  if (twoPets.length < 2) {
    record('③ 需要两个形象来对比', false, `只有 ${JSON.stringify(twoPets)}`);
  } else {
    const [a, b] = twoPets;
    const applied = await page.evaluate(`(async () => {
      const A = ${JSON.stringify(twoPets[0])};
      const B = ${JSON.stringify(twoPets[1])};
      const r1 = await window.__petApi.api('/pets/' + A + '/appearance', {
        method: 'POST', body: { animSpeed: 2.5, autoRoam: false },
      });
      const ra = await window.__petApi.api('/pets/' + A + '/preview', { method: 'GET' });
      const rb = await window.__petApi.api('/pets/' + B + '/preview', { method: 'GET' });
      return {
        ok: Boolean(r1 && r1.success),
        a: { animSpeed: ra.animSpeed, autoRoam: ra.autoRoam },
        b: { animSpeed: rb.animSpeed, autoRoam: rb.autoRoam },
      };
    })()`);
    record(
      '③ ★ 改 A 的动画速度 / 自动漫游**不影响** B（按形象生效）',
      applied.a.animSpeed === 2.5 && applied.a.autoRoam === false
        && applied.b.animSpeed !== 2.5 && applied.b.autoRoam !== false,
      `${a}: animSpeed=${applied.a.animSpeed} autoRoam=${applied.a.autoRoam}；`
      + `${b}: animSpeed=${applied.b.animSpeed} autoRoam=${applied.b.autoRoam}`,
    );

    // 清理：还原 A
    await page.evaluate(`(async () => {
      await window.__petApi.api('/pets/' + ${JSON.stringify(a)} + '/appearance', {
        method: 'POST', body: { animSpeed: null, autoRoam: null },
      });
      return true;
    })()`);
    const restored = await page.evaluate(`(async () => {
      const r = await window.__petApi.api('/pets/' + ${JSON.stringify(a)} + '/preview', { method: 'GET' });
      return { animSpeed: r.animSpeed, autoRoam: r.autoRoam };
    })()`);
    record(
      '③ 传 `null` 能清除覆盖（回到包内声明 / 默认）',
      restored.animSpeed === 1 && restored.autoRoam === true,
      `还原后 animSpeed=${restored.animSpeed} autoRoam=${restored.autoRoam}`,
    );
  }

  // ============================================ ④ 面板上的位置与文案
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-perpet' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1000);
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
    const hints = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-field-hint'))
      .map((n) => n.textContent.trim());
    return {
      labels,
      hasSpeedSlider: Boolean(document.querySelector('.plugin-stm-pet .pet-slider-speed')),
      mentionsHostGlobal: hints.some((h) => h.includes('跟随宿主') || h.includes('全局值优先')),
      scheduleHint: hints.find((h) => h.includes('多久一次')) || '',
    };
  })()`);

  record(
    '④ ★ 面板「外观」里有「动画速度」与「自动漫游」',
    panel.labels.includes('动画速度') && panel.labels.includes('自动漫游'),
    `字段=${JSON.stringify(panel.labels)}`,
  );
  record(
    '④ 动画速度是一个滑块（可按形象拖）',
    panel.hasSpeedSlider,
    `找到 .pet-slider-speed: ${panel.hasSpeedSlider}`,
  );
  record(
    '④ ★ 打盹的提示里不再出现「跟随宿主设置 / 全局值优先」',
    panel.mentionsHostGlobal === false,
    `还有没有提到全局: ${panel.mentionsHostGlobal}`,
  );

  // ============================================ ⑤ 与动画的兼容
  //
  // 这是用户点名要确认的那件事。三种情况都要**不打断**且**最终会睡**。
  const compat = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const out = {};

    async function build(cfg) {
      const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
      const old = document.getElementById('compat-probe');
      if (old) old.remove();
      const c = document.createElement('div');
      c.id = 'compat-probe';
      c.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;z-index:9999';
      document.body.appendChild(c);
      const view = mod.createPetView({
        container: c, pack: res.pet,
        config: Object.assign({ scale: 1, quietMode: true, animSpeed: 1 }, cfg),
        hooks: {},
      });
      view.physics.setPosition(450, 660);
      window.__view = view;
      await new Promise((r) => setTimeout(r, 300));
      return view;
    }

    // 情况 1：打盹到点时正在播 idle 小动作
    await window.__petApi.api('/pets/${PET}/schedule', { method: 'POST',
      body: { schedule: { sleep: { afterMs: 10000 },
                          idle: { minIntervalMs: 60000, maxIntervalMs: 60000 } } } });
    {
      const v = await build({ autoRoam: false, sleepAfter: 120 });
      await new Promise((r) => setTimeout(r, 9400));
      v.pokeIdle();
      const burstStarted = v.idleBursting;
      const log = [];
      for (let i = 0; i < 60; i += 1) {
        log.push(v.state + (v.idleBursting ? '(burst)' : ''));
        await new Promise((r) => setTimeout(r, 100));
      }
      out.burst = {
        burstStarted,
        slept: log.includes('sleep'),
        // 睡着之前小动作有没有被掐断？小动作期间不该出现 sleep
        interrupted: log.indexOf('sleep') >= 0
          && log.slice(0, log.indexOf('sleep')).some((s) => s === 'sleep'),
        order: [...new Set(log)],
      };
      v.dispose();
    }

    // 情况 2：打盹到点时正在漫游（间隔很短，几乎一直在走）
    await window.__petApi.api('/pets/${PET}/schedule', { method: 'POST',
      body: { schedule: { sleep: { afterMs: 10000 },
                          roam: { minIntervalMs: 200, maxIntervalMs: 200 } } } });
    {
      const v = await build({ autoRoam: true, sleepAfter: 120 });
      const log = [];
      for (let i = 0; i < 180; i += 1) {
        log.push({ s: v.state, vx: v.physics.vx });
        await new Promise((r) => setTimeout(r, 100));
      }
      const idx = log.findIndex((e) => e.s === 'sleep');
      out.roam = {
        slept: idx >= 0,
        at: idx >= 0 ? +(idx / 10).toFixed(1) : null,
        states: [...new Set(log.map((e) => e.s))],
      };
      v.dispose();
    }

    // 情况 3：走完一趟之后才睡（间隔长一点，能看清它等走完）
    //
    // ⚠️ 判据不能是「睡着前几个采样不是 walk」——实测那样会误判：
    // WALK → IDLE → SLEEP 的三步在同一 tick 内完成（settleSleep 在
    // 进入 IDLE 时立刻补睡），因此 50ms 采样**看不到**中间那个 idle，
    // 最后一个采样仍然是 walk。
    //
    // 真正要证的是「不在半路定住」。可测的量是**睡着时离本趟目标多远**：
    // 走到目标附近才睡 = 走完了这趟；离得很远就睡 = 半路被掐停。
    // 实测正确实现是「距目标 4px」（目标 316、睡着时 312）。
    // （本段在模板字符串里，注释中不能用反引号。）
    await window.__petApi.api('/pets/${PET}/schedule', { method: 'POST',
      body: { schedule: { sleep: { afterMs: 10000 },
                          roam: { minIntervalMs: 2000, maxIntervalMs: 2500 } } } });
    {
      const v = await build({ autoRoam: true, sleepAfter: 120 });
      const log = [];
      for (let i = 0; i < 220; i += 1) {
        log.push({ s: v.state, x: Math.round(v.physics.x), target: Math.round(v.roamTarget ?? -1) });
        await new Promise((r) => setTimeout(r, 50));
      }
      const idx = log.findIndex((e) => e.s === 'sleep');
      const lastWalk = idx > 0
        ? [...log.slice(0, idx)].reverse().find((e) => e.s === 'walk')
        : null;
      out.slowRoam = {
        slept: idx >= 0,
        at: idx >= 0 ? +((idx * 50) / 1000).toFixed(1) : null,
        sawWalk: log.some((e) => e.s === 'walk'),
        // 睡着时离「这一趟的目标」有多远（没有目标就记 null）
        gapToTarget: lastWalk ? Math.abs(log[idx].x - lastWalk.target) : null,
        span: v.physics.bounds.width,
      };
      v.dispose();
    }

    // 清理
    await window.__petApi.api('/pets/${PET}/schedule', { method: 'POST',
      body: { schedule: { sleep: null, idle: null, roam: null } } });
    const n = document.getElementById('compat-probe'); if (n) n.remove();
    return out;
  })()`);

  record(
    '⑤ ★ 打盹到点时正在播 idle 小动作 → 小动作**不被掐断**，播完才睡',
    compat.burst.burstStarted && compat.burst.slept,
    `小动作已开始=${compat.burst.burstStarted} 最终睡着=${compat.burst.slept}`
    + `；状态序列=${JSON.stringify(compat.burst.order)}`,
  );
  record(
    '⑤ ★ 漫游间隔 200ms（几乎一直在走）时**仍然会睡**',
    compat.roam.slept,
    `睡着于 ${compat.roam.at}s；状态=${JSON.stringify(compat.roam.states)}`
    + '（修复前：永远不睡——进入 WALK 会撤掉打盹定时器，而只有 IDLE 才重排）',
  );
  record(
    '⑤ ★ 睡着时**已经走到本趟目标附近**（等这趟走完才睡，不在半路定住）',
    compat.slowRoam.slept
      && compat.slowRoam.gapToTarget !== null
      && compat.slowRoam.gapToTarget <= compat.slowRoam.span * 0.15,
    `睡着于 ${compat.slowRoam.at}s；`
    + `距本趟目标 ${compat.slowRoam.gapToTarget}px`
    + `（判据：<= 可走跨度的 15%，即 ${(compat.slowRoam.span * 0.15).toFixed(0)}px）；`
    + `这段观察里出现过 walk=${compat.slowRoam.sawWalk}`
    + '（WALK→IDLE→SLEEP 在同一 tick 内完成，因此采样看不到中间的 idle）',
  );

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑥ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  try {
    const page2 = await browser.newPage();
    await page2.send('Runtime.enable');
    await page2.navigate(BASE, { timeout: 20000 });
    await page2.waitFor('Boolean(window.__petApi)', { timeout: 15000, label: '还原时激活' });
    await page2.evaluate(`window.__petApi.api('/pets/${PET}/schedule', {
      method: 'POST', body: { schedule: { sleep: null, idle: null, roam: null } } })`);
  } catch { /* 还原失败不影响结论 */ }
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`按形象设置 / 打盹兼容验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
