/**
 * 验收：**三个小优化**在真实浏览器里的行为。
 *
 * ① 落地切换：脚底一沾地就切 `land`，不再等反弹结束
 *    （否则贴地面上播几百 ms 坠落动画）。
 * ② 入睡衔接：走完 → 站住约 420ms → 躺下，不再是「滑一下就睡」。
 * ③ 惊醒帧时长：小满 sleep-v2 第 1 帧（惊醒）明显长于其它帧。
 *
 * ⚠️ 本文件里的页面侧注释不能用反引号（外层是模板字符串）。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-landing-sleep.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const PET = process.env.PET_ID || 'xiaoman';
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
  await page.evaluate(`(async () => { try { await window.__petApi.surfaces.closeAll(); } catch (e) {} return true; })()`);
  await sleep(400);

  // ============================================ ③ 先看素材：惊醒帧时长
  const pack = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${PET}/preview', { method: 'GET' });
    const sleepAction = (res.actions || []).find((a) => a.action === 'sleep');
    const variants = (sleepAction && sleepAction.variants) || [];
    return {
      count: variants.length,
      sheets: variants.map((v) => v.url),
      frameMs: variants.map((v) => v.frameMs || null),
      fps: variants.map((v) => v.fps),
      weights: variants.map((v) => v.weight),
    };
  })()`);
  record(
    `③ ${PET} 的 sleep 有 ${pack.count} 套（前置）`,
    pack.count === 2,
    `weights=${JSON.stringify(pack.weights)}`,
  );
  const v2 = pack.frameMs[1];
  const v2Longest = Array.isArray(v2) ? v2.indexOf(Math.max(...v2)) : -1;
  record(
    '③ ★ 第二套的**第 1 帧（惊醒）**时长最长',
    Array.isArray(v2) && v2Longest === 1,
    `frameMs=${JSON.stringify(v2)}，最长在第 ${v2Longest} 帧，`
    + `占一轮 ${Array.isArray(v2) ? (Math.max(...v2) / v2.reduce((a, b) => a + b, 0) * 100).toFixed(0) : '?'}%`,
  );
  record(
    '③ 惊醒帧明显长于其余帧（不是只差一点）',
    Array.isArray(v2) && Math.max(...v2) >= Math.min(...v2) * 2,
    `最长 ${Array.isArray(v2) ? Math.max(...v2) : '?'}ms vs 最短 ${Array.isArray(v2) ? Math.min(...v2) : '?'}ms`,
  );

  // ============================================ 建探针视图
  const built = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
    const container = document.createElement('div');
    container.id = 'ls-probe';
    container.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99999;pointer-events:none';
    document.body.appendChild(container);
    const view = mod.createPetView({
      container, pack: res.pet,
      config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
      hooks: {},
    });
    window.__lsView = view;
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, bounds: view.physics.bounds };
  })()`);
  record('① 探针视图已建好', Boolean(built.ok), `bounds=${JSON.stringify(built.bounds)}`);

  // ============================================ ① 落地：贴地时间
  //
  // 做法：把宠物抬到高处 → 让它自由落体 → 高频采样 state 与「脚底离地高度」。
  // 判据：一旦 `y` 到达地面（贴地），state 必须**很快**变成 land；
  // 旧实现的窗口是「反弹全程」（实测 108~225ms）。
  //
  // ⚠️ 采样必须在**页面内**做（rAF 里），不能用 CDP evaluate 轮询：
  // 每次 evaluate 往返几十毫秒，反弹早就结束了，第一版就这么量出了 null。
  await page.evaluate(`(async () => {
    const view = window.__lsView;
    const ground = view.physics.bounds.height;
    view.physics.setPosition(700, 40);
    view.physics.setVelocity(0, 0);
    view.machine.release({ now: performance.now() });
    window.__lsSamples = [];
    window.__lsStop = false;
    const tick = () => {
      if (window.__lsStop) return;
      window.__lsSamples.push({
        t: performance.now(),
        // ⚠️ **不要**用 lift <= 0 判「贴地」：rAF 采样点与物理步不对齐，
        // 反弹可能落在两次采样之间，于是「lift 到 0 且 state 仍是 fall」
        // 这一对条件在同一帧里永不成立（第一版就这么量出 null）。
        // 判据要用物理自己的**边沿标记**，它在一整帧内都保持为真。
        foot: view.physics.footContact,
        grounded: view.physics.grounded,
        lift: +Math.max(0, ground - view.physics.y).toFixed(2),
        state: view.state,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 2500));
    window.__lsStop = true;
  })()`);

  const landing = await page.evaluate(`(() => {
    const samples = window.__lsSamples || [];
    const contact = samples.find((s) => s.foot);
    const land = contact ? samples.find((s) => s.t >= contact.t && s.state === 'land') : null;
    // 「贴地之后脚底最高离地」——证明反弹还在，只是动画切得早
    let maxLiftAfter = 0;
    if (contact) {
      for (const s of samples) {
        if (s.t >= contact.t) maxLiftAfter = Math.max(maxLiftAfter, s.lift);
      }
    }
    return {
      contactAt: contact ? contact.t : null,
      contactState: contact ? contact.state : null,
      landAt: land ? land.t : null,
      maxLiftAfter: +maxLiftAfter.toFixed(1),
      states: [...new Set(samples.map((s) => s.state))],
      n: samples.length,
    };
  })()`);
  const lagMs = (landing.contactAt !== null && landing.landAt !== null)
    ? Math.round(landing.landAt - landing.contactAt)
    : null;
  record(
    '① ★ 脚底一沾地就切 land（不再等反弹结束）',
    lagMs !== null && lagMs <= 40,
    `footContact 那一帧（state=${landing.contactState}）→ land 滞后 ${lagMs}ms`
    + `（旧实现要等反弹结束，实测 108~225ms）；`
    + `${landing.n} 个 rAF 采样，states=${JSON.stringify(landing.states)}`,
  );
  record(
    '① 反弹仍在（物理手感没变，只是动画切得早）',
    landing.maxLiftAfter > 1,
    `贴地之后脚底最高离地 ${landing.maxLiftAfter}px`,
  );

  // ============================================ ② 入睡衔接
  //
  // 做法：让它进入 walk（触发一次漫游）→ 把打盹阈值压到最短
  // → 走完停下后必须**先站一会儿**再躺下。采样同样在页面内做。
  const handoff = await page.evaluate(`(async () => {
    const view = window.__lsView;
    view.setSchedule({ sleep: { afterMs: 10 } });
    view.pokeRoam();
    window.__lsTrace = [];
    window.__lsStop2 = false;
    const started = performance.now();
    const tick = () => {
      if (window.__lsStop2) return;
      window.__lsTrace.push({ t: performance.now() - started, state: view.state });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 12000));
    window.__lsStop2 = true;
    const trace = window.__lsTrace;
    const walkIdx = trace.findIndex((s) => s.state === 'walk');
    const idleIdx = walkIdx >= 0
      ? trace.findIndex((s, i) => i > walkIdx && s.state === 'idle')
      : -1;
    const sleepIdx = idleIdx >= 0
      ? trace.findIndex((s, i) => i > idleIdx && s.state === 'sleep')
      : -1;
    return {
      walkSeen: walkIdx >= 0,
      idleAt: idleIdx >= 0 ? Math.round(trace[idleIdx].t) : null,
      sleepAt: sleepIdx >= 0 ? Math.round(trace[sleepIdx].t) : null,
      states: [...new Set(trace.map((s) => s.state))],
      settling: view.sleepBlockers ? view.sleepBlockers.settling : null,
    };
  })()`);
  const gapMs = (handoff.idleAt !== null && handoff.sleepAt !== null)
    ? handoff.sleepAt - handoff.idleAt
    : null;
  record(
    '② 走完一趟之后**先站住**再躺下（中间有停顿）',
    gapMs !== null && gapMs >= 300,
    `走完停下 ${handoff.idleAt}ms → 入睡 ${handoff.sleepAt}ms，间隔 ${gapMs}ms`
    + `（旧实现是同一 tick，间隔 0）；states=${JSON.stringify(handoff.states)}`,
  );
  record(
    '② 停顿不过长（不会显得它忘了睡）',
    gapMs !== null && gapMs <= 1200,
    `间隔 ${gapMs}ms（设计值 420ms）`,
  );

  // ---- 清理
  await page.evaluate(`(() => {
    try { window.__lsView.dispose(); } catch (e) {}
    const host = document.getElementById('ls-probe');
    if (host) host.remove();
  })()`);
  await sleep(300);
  record('④ 探针已清理', await page.evaluate(`(() => document.getElementById('ls-probe') === null)()`));

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑤ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
  if (failed.length) exitCode = 1;
}
process.exit(exitCode);
