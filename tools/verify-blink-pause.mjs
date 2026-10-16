/**
 * 验收：**停绘时眨眼必须真的停**，恢复后必须自己回来。
 *
 * 为什么需要它
 * ------------
 * 眨眼是**唯一**不靠 rAF 的动画（`setTimeout` + `background-position` 跳帧），
 * 而「减少动效 / 页面不可见」的停绘分支原本只停 rAF 与 CSS 动画（呼吸）。
 * 于是用户打开「减少动效」之后，呼吸停了、帧也不推进了，**眼睛却还在眨**
 * ——恰好是那个设置要关掉的东西。
 *
 * 单测只能验「判定函数写对了」（`blinkAllowed`），验不了**定时器真的被清掉**
 * 与**画面真的被恢复**——那两件事是运行期行为，只能在真实浏览器里看像素。
 *
 * 四条断言
 * --------
 * ① 正常情况下**真的会眨**（否则后面几条都是假通过）；
 * ② 停绘期间**不再眨**（背景位移不再变化）；
 * ③ 停在闭眼帧上时暂停 → **画面被恢复成原帧**（不能永远闭着眼）；
 * ④ 恢复之后**又眨起来**（不是「停掉就再也不眨」）。
 *
 * ⚠️ 本文件里的页面侧注释不能用反引号：那些注释是外层模板字符串的内容。
 *
 * 前置：
 *   1. 影子宿主在 PET_SANDBOX_PORT 上运行，且已装本插件（`--install .`）；
 *   2. 探针形象带 blink（内置 `xiaoman` 的 idle 第一套就带）。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-blink-pause.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const PET = process.env.PET_BLINK_ID || 'xiaoman';
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

  // ============================================ 运行期：确认这条 motion 带 blink
  const rt = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
    if (!res || !res.success) return { error: (res && res.msg) || 'no response' };
    const still = res.pet.still || {};
    return {
      stillMotion: still.motion || null,
      stillFrames: still.frames,
      idleMotion: (res.pet.actions.idle || {}).motion || null,
    };
  })()`);
  if (rt.error) {
    record(`① ${PET}：运行期定义可用`, false, rt.error);
    throw new Error(rt.error);
  }
  record(
    `① ${PET} 的 idle 与标准图像都带上了 blink（前置）`,
    Boolean(rt.idleMotion && rt.idleMotion.blink && rt.stillMotion && rt.stillMotion.blink),
    `still.motion=${JSON.stringify(rt.stillMotion)}（still.frames=${rt.stillFrames}）`,
  );

  // ============================================ 建探针视图
  //
  // 眨眼间隔是 2.5~5 秒，等起来太慢。这里在**页面侧**把下发的 motion 改短：
  // 探针是独立视图，改它拿到的 pack 不影响宿主里那只宠物的定义。
  const built = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
    const pack = res.pet;
    // 把眨眼间隔压到最短（0.4~0.4 秒），否则一轮采样只能看到 0~1 次眨眼。
    // 后端允许的区间下限是 300ms，这里取 400ms。
    const patch = (spec) => {
      if (spec && spec.motion && spec.motion.blink) {
        spec.motion.blink.everyMs = [400, 400];
      }
    };
    patch(pack.still);
    Object.keys(pack.actions || {}).forEach((k) => patch(pack.actions[k]));
    const container = document.createElement('div');
    container.id = 'blink-probe';
    container.style.cssText = 'position:fixed;left:40px;top:40px;width:500px;height:700px;z-index:9999';
    document.body.appendChild(container);
    const view = mod.createPetView({
      container, pack,
      config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
      hooks: {},
    });
    view.physics.setPosition(250, 660);
    window.__blinkView = view;
    await new Promise((r) => setTimeout(r, 500));
    return {
      frames: pack.still ? pack.still.frames : 0,
      every: pack.still.motion.blink.everyMs,
      duration: pack.still.motion.blink.durationMs,
    };
  })()`);
  record(
    '① 探针视图已建好（间隔压到 0.4 秒以便观察）',
    built.frames >= 3 && built.every[0] === 400,
    `still.frames=${built.frames} everyMs=${JSON.stringify(built.every)} durationMs=${built.duration}`,
  );

  /** 读 sprite 的当前背景位移（眨眼的唯一外部可见痕迹）。 */
  async function samplePosition() {
    return page.evaluate(
      `window.__blinkView.element.querySelector('.pet-sprite').style.backgroundPosition`,
    );
  }

  /** 连采若干次，返回出现过的位移集合与次数。 */
  async function collect(times, gapMs) {
    const seen = [];
    for (let i = 0; i < times; i += 1) {
      seen.push(await samplePosition());
      await sleep(gapMs);
    }
    return { positions: new Set(seen), count: seen.length, list: seen };
  }

  // ================================================== ① 正常情况下真的会眨
  const before = await collect(30, 100);
  record(
    '② ★ 正常情况下眨眼真的跳帧（背景位移变化）',
    before.positions.size >= 2,
    `${before.count} 次采样得到 ${before.positions.size} 种位移：${[...before.positions].join(' | ')}`,
  );

  // ================================================== ② 停绘期间不再眨
  await page.evaluate(`(() => { window.__blinkView.applyThrottle({ reducedMotion: true }); })()`);
  await sleep(300);
  const paused = await collect(24, 100);
  record(
    '③ ★ reducedMotion 期间**不再眨眼**（位移一直不变）',
    paused.positions.size === 1,
    `${paused.count} 次采样得到 ${paused.positions.size} 种位移：${[...paused.positions].join(' | ')}`,
  );

  // ================================================== ③ 恢复之后自己回来
  await page.evaluate(`(() => { window.__blinkView.applyThrottle({ reducedMotion: false }); })()`);
  await sleep(300);
  const resumed = await collect(30, 100);
  record(
    '④ ★ 恢复之后眨眼自己回来（不是「停掉就再也不眨」）',
    resumed.positions.size >= 2,
    `${resumed.count} 次采样得到 ${resumed.positions.size} 种位移：${[...resumed.positions].join(' | ')}`,
  );

  // ================================================== ④ 停在闭眼帧上时暂停
  //
  // 最难的一条：暂停恰好落在「已经跳到闭眼帧、还没跳回来」的那 140ms 里。
  // 只清定时器会让宠物**永远闭着眼**，因此暂停时必须把画面恢复回来。
  const midBlink = await page.evaluate(`(async () => {
    const view = window.__blinkView;
    const sprite = view.element.querySelector('.pet-sprite');
    const position = () => sprite.style.backgroundPosition;
    const home = position();
    // 等一次眨眼真正发生（位移变了），然后**立刻**暂停
    let hit = null;
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const now = position();
      if (now !== home) { hit = now; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    view.applyThrottle({ reducedMotion: true });
    await new Promise((r) => setTimeout(r, 500));
    return { hit, afterPause: position(), home };
  })()`);
  record(
    '⑤ ★ 在闭眼帧上被暂停时，画面被恢复回来（不会永远闭着眼）',
    Boolean(midBlink.hit) && midBlink.afterPause === midBlink.home,
    `命中闭眼帧 "${midBlink.hit}"，暂停后回到 "${midBlink.afterPause}"（原帧 "${midBlink.home}"）`,
  );

  // 暂停状态必须**稳定**：恢复绘制不能把定时器又排回来
  const settled = await collect(20, 100);
  record(
    '⑤ 暂停后持续稳定不眨（恢复绘制没有把定时器排回来）',
    settled.positions.size === 1,
    `${settled.count} 次采样得到 ${settled.positions.size} 种位移`,
  );

  // ---- 清理
  await page.evaluate(`(() => {
    try { window.__blinkView.dispose(); } catch (e) {}
    const host = document.getElementById('blink-probe');
    if (host) host.remove();
  })()`);
  await sleep(300);
  record('⑥ 探针已清理', await page.evaluate(`(() => document.getElementById('blink-probe') === null)()`));

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑦ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
  if (failed.length) exitCode = 1;
}
process.exit(exitCode);
