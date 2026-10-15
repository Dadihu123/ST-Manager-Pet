/**
 * 验收：**漫游方向按位置偏置**——越靠边越倾向于往回走。
 *
 * 用户要求：「如果形象越偏向屏幕左侧，那么触发动画时有更高的概率往右走，
 * 反之亦然……这样可以避免总往一个方向走，更加符合随意走动的感觉」。
 *
 * 判据（都基于**真实走动**，不是只看一次抽样）：
 * ① 站在最左边时，目标**绝大多数在右边**；最右边反之；
 * ② 站在正中时接近 50/50（不能变成「永远回中间」——那就不随意了）；
 * ③ 长程游走时**不会贴着边缘**：待在「最左/最右 10% 区间」的时间明显
 *    低于均匀随机（实测 ~10% vs ~19%）；
 * ④ 方向会**反复翻转**（不是一路走到底）；
 * ⑤ 目标始终**够得着**（这是上一轮修过的 bug，不能被这次改动带回来）。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-roam-direction.mjs
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

  // 建一个探针视图，并把漫游关掉（我们手动 poke，避免等待随机间隔）
  const built = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
    const old = document.getElementById('dir-probe');
    if (old) old.remove();
    const c = document.createElement('div');
    c.id = 'dir-probe';
    c.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;z-index:9999';
    document.body.appendChild(c);
    const view = mod.createPetView({
      container: c, pack: res.pet,
      config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
      hooks: {},
    });
    window.__view = view;
    await new Promise((r) => setTimeout(r, 300));
    const b = view.physics.bounds;
    const s = view.physics.size;
    return { bounds: b, size: s, half: s.width / 2 };
  })()`);

  // 可走范围（与实现同一套算法：半宽 + 8px 余量）
  const low = built.half + 8;
  const high = built.bounds.width - built.half - 8;
  const mid = (low + high) / 2;
  const span = high - low;
  record(
    '① 前置：探针就绪，可走范围可用',
    span > 40,
    `世界宽 ${built.bounds.width}，宠物宽 ${built.size.width}，可走 [${low.toFixed(0)}, ${high.toFixed(0)}]（跨度 ${span.toFixed(0)}）`,
  );

  /** 在给定位置连抽 N 次「这一趟的目标」，返回右向比例与目标值。 */
  async function sampleAt(x, rounds) {
    return page.evaluate(`(async () => {
      const v = window.__view;
      const targets = [];
      for (let i = 0; i < ${rounds}; i += 1) {
        v.physics.setPosition(${x}, v.physics.bounds.height);
        v.machine.settle({ now: performance.now() });
        v.physics.stopWalking();
        v.pokeRoam();
        // 直接读「选出来的目标」——比看它往哪走准得多（走动受物理影响）
        targets.push(v.roamTarget);
        v.physics.setPosition(${x}, v.physics.bounds.height);
        v.machine.settle({ now: performance.now() });
        v.physics.stopWalking();
      }
      return targets;
    })()`);
  }

  const ROUNDS = 80;

  // ---- ① 最左边 → 绝大多数往右
  const leftTargets = await sampleAt(low + 1, ROUNDS);
  const leftRight = leftTargets.filter((t) => t > low + 1).length / leftTargets.length;
  record(
    '① ★ 站在**最左边**时绝大多数目标在右边（偏置生效）',
    leftRight >= 0.8,
    `${ROUNDS} 次里 ${(leftRight * 100).toFixed(0)}% 的目标在右侧`
    + `（理论 ≈100%，留余量是因为它在最左边时仍可能再往左挪一点点）`,
  );

  // ---- 反向：最右边 → 绝大多数往左
  const rightTargets = await sampleAt(high - 1, ROUNDS);
  const rightLeft = rightTargets.filter((t) => t < high - 1).length / rightTargets.length;
  record(
    '① ★ 站在**最右边**时绝大多数目标在左边',
    rightLeft >= 0.8,
    `${ROUNDS} 次里 ${(rightLeft * 100).toFixed(0)}% 的目标在左侧`,
  );

  // ---- ② 正中 → 接近 50/50
  const midTargets = await sampleAt(mid, ROUNDS);
  const midRight = midTargets.filter((t) => t > mid).length / midTargets.length;
  record(
    '② ★ 站在**正中**时接近 50/50（不能变成「永远回中间」——那就不随意了）',
    midRight >= 0.3 && midRight <= 0.7,
    `${ROUNDS} 次里 ${(midRight * 100).toFixed(0)}% 的目标在右侧`,
  );

  // ---- ⑤ 目标始终够得着 + 单步不会跨到对面边缘
  const allTargets = [...leftTargets, ...rightTargets, ...midTargets];
  const outOfRange = allTargets.filter((t) => t < low - 0.01 || t > high + 0.01);
  record(
    '⑤ ★ 目标始终**在可走范围内**（上一轮修过的「够不着就卡死」不能被带回来）',
    outOfRange.length === 0,
    `${allTargets.length} 个目标全部落在 [${low.toFixed(0)}, ${high.toFixed(0)}]`
    + (outOfRange.length ? `；越界 ${outOfRange.length} 个，例如 ${outOfRange[0]}` : ''),
  );
  // 从最左一步到最右会导致「边缘来回弹」（实测比均匀随机还差）
  const overshoot = leftTargets.filter((t) => t >= high - span * 0.05).length;
  record(
    '⑤ ★ 单步不会从最左直接跨到最右（否则会在两个边缘之间弹）',
    overshoot === 0,
    `${ROUNDS} 次从最左出发里，${overshoot} 次的目标落在最右 5% 区间`
    + `（跨度 ${span.toFixed(0)}px，单步上限 ${(span * 0.35).toFixed(0)}px）`,
  );

  // ---- ③④ 长程游走：边缘停留与方向翻转
  const walk = await page.evaluate(`(async () => {
    const v = window.__view;
    v.setConfig({ autoRoam: true });
    v.setSchedule({ roam: { minIntervalMs: 200, maxIntervalMs: 300 } });
    v.physics.setPosition(${mid}, v.physics.bounds.height);
    const xs = [];
    for (let i = 0; i < 400; i += 1) {
      xs.push(v.physics.x);
      await new Promise((r) => setTimeout(r, 50));
    }
    return xs;
  })()`);

  const edgeLo = low + span * 0.1;
  const edgeHi = high - span * 0.1;
  const edgeShare = walk.filter((x) => x < edgeLo || x > edgeHi).length / walk.length;
  const midShare = walk.filter((x) => Math.abs(x - mid) < span * 0.25).length / walk.length;
  record(
    '③ ★ 长程游走**不贴边**：待在「最左/最右 10% 区间」的时间明显低于均匀随机',
    edgeShare < 0.16,
    `边缘停留 ${(edgeShare * 100).toFixed(1)}%（均匀随机的对照是 ~19%）`
    + `；中间 50% 区域 ${(midShare * 100).toFixed(1)}%（对照 ~50%）`,
  );

  // 方向翻转要按**每一趟漫游**统计，不能按采样点。
  //
  // ⚠️ 按 50ms 的采样点算「相邻两点的方向变化」是错的：走动期间每帧都在
  // 朝同一方向移动，于是 400 个采样点里几乎全是同一个方向，翻转率算出来
  // 只有 1%——那是**指标写错了**，不是功能有问题（第一版就错在这里）。
  // 正确的问法是：「这一趟往左，下一趟往哪边？」——那才对应
  // 「会不会总往一个方向走」。
  const trips = await page.evaluate(`(async () => {
    const v = window.__view;
    v.setConfig({ autoRoam: true });
    v.setSchedule({ roam: { minIntervalMs: 300, maxIntervalMs: 500 } });
    v.physics.setPosition(${mid}, v.physics.bounds.height);
    const dirs = [];
    let prevState = v.state;
    let startX = v.physics.x;
    for (let i = 0; i < 600; i += 1) {
      const s = v.state;
      if (s === 'walk' && prevState !== 'walk') startX = v.physics.x;
      if (prevState === 'walk' && s !== 'walk') {
        const dx = v.physics.x - startX;
        if (Math.abs(dx) > 2) dirs.push(dx > 0 ? 1 : -1);
      }
      prevState = s;
      await new Promise((r) => setTimeout(r, 50));
    }
    return dirs;
  })()`);
  let tripFlips = 0;
  for (let i = 1; i < trips.length; i += 1) if (trips[i] !== trips[i - 1]) tripFlips += 1;
  const tripFlipRate = trips.length > 1 ? tripFlips / (trips.length - 1) : 0;
  const tripRight = trips.length ? trips.filter((d) => d === 1).length / trips.length : 0;
  record(
    '④ ★ 逐趟看方向会**反复翻转**，且左右大致均衡（不是一路走到底）',
    trips.length >= 3 && tripFlipRate >= 0.3 && tripRight >= 0.25 && tripRight <= 0.75,
    `观察到 ${trips.length} 趟：翻转率 ${(tripFlipRate * 100).toFixed(0)}%，`
    + `往右 ${(tripRight * 100).toFixed(0)}%（${trips.join('')}，1=右 -1=左）`,
  );

  // ---- ⑤ 每次 poke 都真的进入了 WALK（够得着的目标才会开始走）
  const reach = await page.evaluate(`(async () => {
    const v = window.__view;
    const out = [];
    for (let i = 0; i < 120; i += 1) {
      v.physics.setPosition(${low} + Math.random() * ${span}, v.physics.bounds.height);
      v.machine.settle({ now: performance.now() });
      v.physics.stopWalking();
      v.pokeRoam();
      out.push(v.state);
      v.physics.setPosition(${mid}, v.physics.bounds.height);
      v.machine.settle({ now: performance.now() });
      v.physics.stopWalking();
    }
    return out;
  })()`);
  record(
    '⑤ 每次触发都真的进入了 WALK',
    reach.filter((s) => s === 'walk').length >= reach.length * 0.95,
    `${reach.filter((s) => s === 'walk').length}/${reach.length} 次进入了 walk`,
  );

  await page.evaluate(`(() => {
    const v = window.__view; if (v) v.dispose();
    const n = document.getElementById('dir-probe'); if (n) n.remove();
  })()`);

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑥ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
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
process.stdout.write(`漫游方向偏置验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
