/**
 * 验收：**内置形象的「常驻呼吸 + 随机触发动画」**是否真的共存。
 *
 * 这是用户提的那个问题的直接验证：
 *   「平时常驻呼吸感，再加上原先的随机触发动画，这样可行吗」
 *
 * 默认 idle 模式（`random`）的行为是：
 *   平时显示**标准图像** → 隔 6~18 秒随机播一遍 idle → 回到标准图像。
 * 因此要验三件事：
 *
 * ① **静止时在呼吸**：显示标准图像的那段时间里，顶边必须持续变化；
 * ② **随机触发时在呼吸**：idle burst 播帧期间，顶边**也**必须变化
 *    （呼吸与帧推进正交，不能互相打断）；
 * ③ **播完回来还在呼吸**：burst 结束后回到标准图像，呼吸必须**无缝继续**
 *    （不能因为换了一次图就停掉）。
 *
 * ⚠️ 判据用 `getBoundingClientRect()`（含 transform 结果），不用像素：
 * 真实应用页底色是浅色卡片区，「亮度阈值找宠物」那套判据在这里不成立
 * （见 verify-motion.mjs 里记的那个坑）。
 *
 * 前置：
 *   1. 影子宿主在 PET_SANDBOX_PORT 上运行（已装含 motion 的内置形象）；
 *   2. 把 idle 的触发间隔临时调小（默认 6~18 秒等不起）——
 *      脚本自己用 `applyThrottle` 之外的办法做不到，因此这里**直接观察**
 *      并主动触发一次（`pokeIdle`）来覆盖 ②③。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-builtin-motion.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const PETS = ['xiaoka', 'xiaoman'];
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

  // 先把面板关掉（默认可能开着别的 surface），保证 ambient 容器干净
  await page.evaluate(`(async () => { try { await window.__petApi.surfaces.closeAll(); } catch (e) {} return true; })()`);
  await sleep(400);

  for (const PET of PETS) {
    process.stdout.write(`\n--- ${PET} ---\n`);

    // ============================================ 运行期：内置形象带上了 motion
    const rt = await page.evaluate(`(async () => {
      const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
      if (!res || !res.success) return { error: (res && res.msg) || 'no response' };
      const idle = res.pet.actions.idle;
      return {
        motion: idle.motion || null,
        origin: idle.motionOrigin || '',
        anchorY: (res.pet.anchor || {}).y,
        stillMotion: (res.pet.still || {}).motion || null,
        stillOrigin: (res.pet.still || {}).motionOrigin || '',
        variantsWithMotion: (idle.variants || []).filter((v) => v.motion).length,
        variantCount: (idle.variants || []).length,
        idleMode: res.pet.schedule && res.pet.schedule.idle ? res.pet.schedule.idle : null,
      };
    })()`);

    if (rt.error) {
      record(`① ${PET}：运行期定义可用`, false, rt.error);
      continue;
    }

    record(
      '① 内置形象的 idle 带上了呼吸',
      Boolean(rt.motion && rt.motion.breathe && rt.motion.breathe.amplitude > 0),
      `motion=${JSON.stringify(rt.motion)}`,
    );
    record(
      '① ★ 两套 idle 变体都带 motion（否则抽到「张望」那套时呼吸会消失）',
      rt.variantsWithMotion === rt.variantCount && rt.variantCount >= 2,
      `${rt.variantsWithMotion}/${rt.variantCount} 套带 motion`,
    );
    record(
      '① ★ transform-origin 用的是这个形象**自己的** anchor.y',
      rt.origin === `50% ${(rt.anchorY * 100).toFixed(2)}%`,
      `anchor.y=${rt.anchorY} -> "${rt.origin}"（写死 bottom center 会是 100%）`,
    );
    record(
      '① ★ 标准图像继承呼吸（静止时才会真的在动）',
      Boolean(rt.stillMotion && rt.stillMotion.breathe) && rt.stillOrigin === rt.origin,
      `still.motion=${JSON.stringify(rt.stillMotion)} origin="${rt.stillOrigin}"`,
    );

    // ============================================ 建宠物视图
    const built = await page.evaluate(`(async () => {
      const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
      const res = await window.__petApi.api('/pets/${PET}/runtime', { method: 'GET' });
      const container = document.createElement('div');
      container.id = 'builtin-probe';
      container.style.cssText = 'position:fixed;left:40px;top:40px;width:500px;height:700px;z-index:9999';
      document.body.appendChild(container);
      const view = mod.createPetView({
        container, pack: res.pet,
        config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
        hooks: {},
      });
      view.physics.setPosition(250, 660);
      window.__view = view;
      await new Promise((r) => setTimeout(r, 500));
      const sprite = view.element.querySelector('.pet-sprite');
      return {
        action: view.action,
        idleMode: view.idleMode,
        bursting: view.idleBursting,
        hasBreathe: view.element.classList.contains('has-breathe'),
        amp: sprite.style.getPropertyValue('--pet-breathe-amp'),
        period: sprite.style.getPropertyValue('--pet-breathe-period'),
        origin: sprite.style.transformOrigin,
      };
    })()`);

    record(
      '② 视图挂上了呼吸，且 idle 是 random 模式（平时静止）',
      built.hasBreathe && built.idleMode === 'random',
      `has-breathe=${built.hasBreathe} amp=${built.amp} period=${built.period}`
      + ` origin=${built.origin} idleMode=${built.idleMode}`,
    );

    /** 采样顶边（含 transform 结果）。 */
    async function sampleTop() {
      return page.evaluate(`(() => {
        const view = window.__view;
        if (!view) return null;
        const sprite = view.element.querySelector('.pet-sprite');
        const r = sprite.getBoundingClientRect();
        return {
          top: +r.top.toFixed(2),
          h: +r.height.toFixed(2),
          bursting: view.idleBursting,
          hasBreathe: view.element.classList.contains('has-breathe'),
        };
      })()`);
    }

    async function collect(rounds, gapMs) {
      const out = [];
      for (let i = 0; i < rounds; i += 1) {
        const s = await sampleTop();
        if (s) out.push(s);
        await sleep(gapMs);
      }
      return out;
    }

    const span = (list) => (list.length ? Math.max(...list) - Math.min(...list) : 0);

    // ---- ① 静止时在呼吸
    const resting = await collect(16, 100);
    const restingTops = resting.map((s) => s.top);
    record(
      '① ★ 静止（显示标准图像）时**持续在呼吸**',
      span(restingTops) > 1.5,
      `顶边行程 ${span(restingTops).toFixed(1)}px（${resting.length} 次采样，`
      + `${resting.filter((s) => s.bursting).length} 次处于 burst）`,
    );

    // ---- ②③ 主动触发一次 idle burst，观察 burst 期间与之后
    await page.evaluate(`(() => { window.__view.pokeIdle(); })()`);
    const during = await collect(12, 90);
    const bursting = during.filter((s) => s.bursting);
    record(
      '② 主动触发成功（进入了 idle burst）',
      bursting.length > 0,
      `${bursting.length}/${during.length} 次采样处于 burst`,
    );
    record(
      '② ★ burst 期间**仍在呼吸**（帧推进与呼吸正交，互不打断）',
      span(bursting.map((s) => s.top)) > 1.5,
      `burst 期间顶边行程 ${span(bursting.map((s) => s.top)).toFixed(1)}px`,
    );
    record(
      '② burst 期间 has-breathe 一直挂着（没被换帧摘掉）',
      bursting.every((s) => s.hasBreathe),
      `has-breathe: ${[...new Set(bursting.map((s) => s.hasBreathe))].join(',')}`,
    );

    // ---- ③ burst 结束后回到标准图像，呼吸无缝继续
    await sleep(1600);
    const after = await collect(16, 100);
    record(
      '③ burst 已结束（回到标准图像）',
      after.every((s) => !s.bursting),
      `采样中 burst 次数 ${after.filter((s) => s.bursting).length}`,
    );
    record(
      '③ ★ burst 结束后**呼吸无缝继续**（换过一次图也没停）',
      span(after.map((s) => s.top)) > 1.5 && after.every((s) => s.hasBreathe),
      `顶边行程 ${span(after.map((s) => s.top)).toFixed(1)}px；`
      + `has-breathe: ${[...new Set(after.map((s) => s.hasBreathe))].join(',')}`,
    );

    // ---- 对照：reducedMotion 必须真的关掉
    const reduced = await page.evaluate(`(async () => {
      const view = window.__view;
      view.applyThrottle({ reducedMotion: true });
      await new Promise((r) => setTimeout(r, 400));
      const sprite = view.element.querySelector('.pet-sprite');
      return {
        hasBreathe: view.element.classList.contains('has-breathe'),
        animationName: getComputedStyle(sprite).animationName,
      };
    })()`);
    record(
      '④ reducedMotion 下呼吸真的被关掉（animation: none）',
      reduced.animationName === 'none',
      `has-breathe=${reduced.hasBreathe} animation-name=${reduced.animationName}`
      + '（类还在，但 CSS 的 reduced-motion 块把动画设成 none——这是设计如此）',
    );

    await page.evaluate(`(() => { window.__view.applyThrottle({ reducedMotion: false }); })()`);
    await sleep(300);

    // ---- 清理
    await page.evaluate(`(() => { window.__view.dispose(); document.getElementById('builtin-probe').remove(); })()`);
    await sleep(300);
    record(`⑤ ${PET} 探针已清理`, await page.evaluate(`(() => document.getElementById('builtin-probe') === null)()`));
  }

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑥ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`内置形象「常驻呼吸 + 随机触发」验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
