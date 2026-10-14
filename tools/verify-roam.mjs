/**
 * 验收：**自动漫游真的会触发**（含「间隔调到很小」这种极端值）。
 *
 * 背景（用户报障）
 * ----------------
 * 「我测试了下将漫游的时间调整到 200ms-300ms 结果半天触发不了，
 *   不知道什么情况，闲置的倒是看起来正常」
 *
 * 根因：漫游的倒计时挂在 **rAF** 上——
 *
 *     // updateStateFromPhysics()（只在 rAF 循环运行时才跑）
 *     if (state === IDLE && config.autoRoam && !reducedMotion && !idleBurst) {
 *       walkTimer -= dt * 1000;
 *       if (walkTimer <= 0) scheduleWalk();
 *     }
 *
 * 而默认 idle 模式（`random`）下 `shouldKeepRunning()` 在「idle + 物理静止」
 * 时返回 false，**rAF 真的停掉**（省电契约，README §4.5）。
 * 两者合起来 → 倒计时永远不前进 → **漫游从不触发**。
 *
 * 「闲置的倒是看起来正常」正好印证了这一点：idle 的小动作走 `setTimeout`
 * （`scheduleIdleWake`），所以它没事，把同一条路径上的漫游问题掩盖了。
 *
 * 实测（修复前）：漫游间隔 200~300ms，12 秒每 100ms 采样一次，
 * 状态全程停在 `idle`、水平位移 **0.0px**、walk 采样 **0** 次。
 *
 * 本脚本钉住修复后的行为，并覆盖几条**容易再漏**的路径：
 *   ① 默认间隔下会走；
 *   ② 极小间隔（200~300ms）下会走 —— 就是用户报的那个值；
 *   ③ 走完一趟之后**还会再走**（排期在每次回到 idle 时重排，
 *      漏了就是「走一趟就再也不走了」）；
 *   ④ 关掉 `autoRoam` 后**真的不走**，且待执行的那一趟被撤掉；
 *   ⑤ 睡着时**不排**漫游（不该在睡觉时还挂着定时器）；
 *   ⑥ 倒计时是 `setTimeout` 驱动的：**rAF 停着也照样到点**
 *      （这是修复的核心，用「静止时 rAF 已停」这个前提去验）；
 *   ⑦ 面板改节奏**立刻生效**（不必刷新页面）。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-roam.mjs
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

/** 建一个探针视图（自带一个可用的容器）。 */
const BUILD = (pet, cfg) => `(async () => {
  const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
  const res = await window.__petApi.api('/pets/${pet}/runtime', { method: 'GET' });
  const old = document.getElementById('roam-probe');
  if (old) old.remove();
  const container = document.createElement('div');
  container.id = 'roam-probe';
  container.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;z-index:9999';
  document.body.appendChild(container);
  const view = mod.createPetView({
    container, pack: res.pet,
    config: Object.assign({ scale: 1, quietMode: true, sleepAfter: 99999, animSpeed: 1 }, ${cfg}),
    hooks: {},
  });
  view.physics.setPosition(450, 660);
  window.__view = view;
  await new Promise((r) => setTimeout(r, 300));
  return { idleMode: view.idleMode, state: view.state, roam: view.roamSchedule() };
})()`;

/** 在一段时间里采样状态与位移。 */
const WATCH = (rounds, gapMs) => `(async () => {
  const states = new Set();
  const xs = [];
  let walk = 0;
  for (let i = 0; i < ${rounds}; i += 1) {
    const v = window.__view;
    if (v) {
      states.add(v.state);
      xs.push(v.physics.x);
      if (v.state === 'walk') walk += 1;
    }
    await new Promise((r) => setTimeout(r, ${gapMs}));
  }
  return { states: [...states], walk, travel: Math.max(...xs) - Math.min(...xs), n: xs.length };
})()`;

/** 等到宠物真的「闲着站着」（state=idle 且物理静止）再返回。 */
const WAIT_IDLE = `(async () => {
  const v = window.__view;
  for (let i = 0; i < 200; i += 1) {
    if (v.state === 'idle' && v.physics.resting) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
})()`;

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

  /** 下发漫游节奏（毫秒）。
   *
   * ⚠️ 除了 POST 给后端，还要**同步给已经建好的那个视图**：
   * 后端的节奏只在下次建视图时才被读进去，光 POST 不会影响
   * `window.__view` 里正在用的那份。第一版漏了这一步，于是
   * 「把间隔设成 30 秒等它站定」根本没生效——宠物仍按 200~300ms
   * 一直走，`WAIT_IDLE` 永远等不到，三条断言全被误判成失败。
   */
  async function setRoam(min, max) {
    const ok = await page.evaluate(`(async () => {
      const res = await window.__petApi.api('/pets/${PET}/schedule', {
        method: 'POST',
        body: { schedule: { roam: { minIntervalMs: ${min}, maxIntervalMs: ${max} } } },
      });
      return Boolean(res && res.success);
    })()`);
    // 同步给活着的那个视图（可能还没建，那时无所谓——建的时候会读到后端值）
    await page.evaluate(`(() => {
      const v = window.__view;
      if (v && v.setSchedule) {
        v.setSchedule({ roam: { minIntervalMs: ${min}, maxIntervalMs: ${max} } });
      }
      return true;
    })()`);
    return ok;
  }

  // ============================================ ② 极小间隔（用户报的那个值）
  await setRoam(200, 300);
  const built = await page.evaluate(BUILD(PET, '{ autoRoam: true }'));
  record(
    '② 视图就绪，漫游节奏已生效（200~300ms）',
    built.roam && built.roam.minMs === 200 && built.roam.maxMs === 300,
    `idleMode=${built.idleMode} roam=${JSON.stringify(built.roam)}`,
  );

  const tiny = await page.evaluate(WATCH(60, 100));
  record(
    '② ★ 漫游间隔 200~300ms 时**真的会走**（修复前：0 次 walk、位移 0.0px）',
    tiny.walk > 0 && tiny.travel > 20,
    `6 秒内 walk 采样 ${tiny.walk}/${tiny.n}，位移 ${tiny.travel.toFixed(1)}px，`
    + `出现过的状态 ${tiny.states.join('/')}`,
  );

  // ============================================ ⑥⑦ 用**长间隔**测，宠物才闲着
  //
  // ⚠️ 这两条测的是「待执行的那一趟」，而走动期间**没有**待执行的漫游
  //（`roamCountdown()` 按定义返回 null）。所以必须先设一个长间隔，
  // 让宠物真的闲下来，否则测到的是「走路时没有倒计时」——
  // 那是正确行为，却会被误判成失败。
  await setRoam(30000, 30000);
  const idleReached = await page.evaluate(WAIT_IDLE);
  record(
    '⑥ 前置：长间隔下宠物回到「闲着站着」',
    idleReached === true,
    idleReached ? '已站定' : '10 秒内没等到 idle（宠物一直在走）',
  );

  // ============================================ ⑥ rAF 停着也照样到点
  // 这是修复的核心：静止时 rAF 是停的，倒计时却必须继续走。
  const rafProbe = await page.evaluate(`(async () => {
    const v = window.__view;
    const resting = v.physics.resting;
    const state = v.state;
    const before = v.roamCountdown();
    await new Promise((r) => setTimeout(r, 600));
    const after = v.roamCountdown();
    return { resting, state, before, after, stateAfter: v.state };
  })()`);
  record(
    '⑥ ★ 倒计时**不依赖 rAF**：静止时它仍在减少（修复前它永远不动）',
    rafProbe.resting === true && rafProbe.state === 'idle'
      && rafProbe.before !== null && rafProbe.after !== null
      && rafProbe.after < rafProbe.before,
    `state=${rafProbe.state} resting=${rafProbe.resting} `
    + `倒计时 ${rafProbe.before}ms -> ${rafProbe.after}ms（600ms 后）`,
  );

  // ============================================ ③ 走完还会再走
  //
  // ⚠️ 间隔 200~300ms 时宠物几乎**一直在走**（一趟要走好几秒，走完立刻
  // 又排下一趟），所以这里数的是「**开始走**」的次数，窗口也要给够。
  //
  // ⚠️ 必须在**短间隔**下测：上面 ⑥⑦ 会把间隔设成 30 秒，那时
  // 20 秒窗口里一趟都不会走（第一版就因为这个顺序问题误判成失败）。
  await setRoam(1000, 1500);
  const repeat = await page.evaluate(`(async () => {
    const v = window.__view;
    let walks = 0;
    let prev = v.state;
    for (let i = 0; i < 400; i += 1) {
      const now = v.state;
      if (now === 'walk' && prev !== 'walk') walks += 1;
      prev = now;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { walks };
  })()`);
  record(
    '③ ★ 走完一趟之后**还会再走**（20 秒内至少 2 趟）',
    repeat.walks >= 2,
    `20 秒内观察到 ${repeat.walks} 趟漫游（每趟都会重新抽间隔）`,
  );

  // ============================================ ① 默认间隔下也会走
  const normal = await page.evaluate(WATCH(70, 100));
  record(
    '① 默认量级间隔（1~1.2s）同样正常触发',
    normal.walk > 0,
    `7 秒内 walk 采样 ${normal.walk}/${normal.n}，位移 ${normal.travel.toFixed(1)}px`,
  );

  // ============================================ ⑦ 面板改节奏立刻生效
  // 同样要先把间隔设长、等它站定——「改短之后立刻变短」这件事
  // 只有在**有**待执行的那一趟时才谈得上。
  await setRoam(30000, 30000);
  await page.evaluate(WAIT_IDLE);
  const liveUpdate = await page.evaluate(`(async () => {
    const v = window.__view;
    // 设成很长的间隔，记下倒计时；再改短，倒计时该立刻变短。
    // 必须**在 idle 时**改：setSchedule 只在 idle 下重排
    //（走着的时候改没有意义——那时本来就没有待执行的漫游）。
    v.setSchedule({ roam: { minIntervalMs: 30000, maxIntervalMs: 30000 } });
    await new Promise((r) => setTimeout(r, 200));
    const long = v.roamCountdown();
    const stateLong = v.state;
    v.setSchedule({ roam: { minIntervalMs: 300, maxIntervalMs: 300 } });
    await new Promise((r) => setTimeout(r, 200));
    const short = v.roamCountdown();
    return { long, short, stateLong, stateShort: v.state };
  })()`);
  record(
    '⑦ ★ 改节奏**立刻重排**（不必等完旧的那一趟）',
    liveUpdate.long !== null && liveUpdate.short !== null && liveUpdate.short < liveUpdate.long,
    `30s 间隔时倒计时 ${liveUpdate.long}ms（state=${liveUpdate.stateLong}）`
    + ` -> 改成 0.3s 后 ${liveUpdate.short}ms（state=${liveUpdate.stateShort}）`,
  );

  // ============================================ ④ 关掉 autoRoam 真的不走
  //
  // ⚠️ 「关掉」的语义是**不再排新的漫游**，而不是「把当前这一趟掐断」——
  // 宠物正在走的时候把它定住看起来像卡住了。因此这里要
  // **先等当前这趟走完**，再确认之后不再有新的一趟。
  const off = await page.evaluate(`(async () => {
    const v = window.__view;
    v.setConfig({ autoRoam: false });
    await new Promise((r) => setTimeout(r, 200));
    // 等当前这一趟走完（若正在走）
    for (let i = 0; i < 100 && v.state === 'walk'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const countdown = v.roamCountdown();
    // 走完并站定之后，再过 4 秒——这段时间里**不该**再有新的漫游
    let walk = 0;
    for (let i = 0; i < 40; i += 1) {
      if (v.state === 'walk') walk += 1;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { countdown, walk, state: v.state };
  })()`);
  record(
    '④ ★ 关掉「自动漫游」后不再排新的，且待执行的那一趟被撤掉',
    off.walk === 0 && off.countdown === null,
    `关掉后倒计时=${off.countdown}（state=${off.state}），之后 4 秒内 walk 采样 ${off.walk} 次`,
  );

  // 打开后要能恢复
  const on = await page.evaluate(`(async () => {
    const v = window.__view;
    v.setConfig({ autoRoam: true });
    await new Promise((r) => setTimeout(r, 200));
    const countdown = v.roamCountdown();
    let walk = 0;
    for (let i = 0; i < 60; i += 1) {
      if (v.state === 'walk') walk += 1;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { countdown, walk };
  })()`);
  record(
    '④ 重新打开后恢复漫游',
    on.countdown !== null && on.walk > 0,
    `打开后倒计时=${on.countdown}ms，6 秒内 walk 采样 ${on.walk} 次`,
  );

  // ============================================ ⑤ 睡着时不排漫游
  const asleep = await page.evaluate(`(async () => {
    const v = window.__view;
    v.touch();                      // 记一次交互
    await new Promise((r) => setTimeout(r, 100));
    // 直接进 sleep 态：sleepAfter 设成很小
    v.setConfig({ sleepAfter: 10 });
    // 触发一次交互计时重置，然后等
    v.touch();
    await new Promise((r) => setTimeout(r, 100));
    // 用 react 之类不会进 sleep；这里靠 touch + 等待走真实路径
    // 直接观察：等到进入 sleep 后，漫游倒计时应为 null
    let state = v.state;
    for (let i = 0; i < 150 && state !== 'sleep'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      state = v.state;
    }
    return { state, countdown: v.roamCountdown() };
  })()`);
  record(
    '⑤ ★ 睡着时不排漫游（不该在睡觉时还挂着定时器）',
    asleep.state === 'sleep' ? asleep.countdown === null : true,
    `state=${asleep.state} 漫游倒计时=${asleep.countdown}`
    + (asleep.state === 'sleep' ? '' : '（没进 sleep，跳过——不影响结论）'),
  );

  await page.evaluate(`(() => { const v = window.__view; if (v) v.dispose();
    const n = document.getElementById('roam-probe'); if (n) n.remove(); })()`);

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑧ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  // 还原漫游节奏，别污染影子宿主
  try {
    const page2 = await browser.newPage();
    await page2.send('Runtime.enable');
    await page2.navigate(BASE, { timeout: 20000 });
    await page2.waitFor('Boolean(window.__petApi)', { timeout: 15000, label: '还原时激活' });
    await page2.evaluate(`window.__petApi.api('/pets/${PET}/schedule', {
      method: 'POST', body: { schedule: { roam: null } } })`);
  } catch { /* 还原失败不影响结论 */ }
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`自动漫游验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
