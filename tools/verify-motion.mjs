/**
 * 验收：**程序化运动**（`motion`：呼吸 / 眨眼）在真实浏览器里的行为。
 *
 * 为什么必须用真实浏览器
 * ----------------------
 * 这个特性的全部价值就是「看起来在动」，而「在不在动」只能靠**渲染结果**判定。
 * 单测能验证「CSS 变量写对了」，但验证不了「合成器真的把那一帧渲染出来了」
 * ——那正是用户唯一能看见的东西。
 *
 * 判据用 getBoundingClientRect 而不是 canvas：动图那次实测过，
 * 无头 Chrome 里 drawImage + getImageData 不推进动画时钟，
 * 会把正常工作的特性判成失败。
 *
 * ⚠️ **本文件里的页面侧注释不能用反引号**：那些注释是外层模板字符串的内容，
 * 反引号会把外层字符串提前结束（这个坑在 verify-pages 里踩过两次）。
 *
 * 三条核心断言
 * ------------
 * ① **呼吸真的在动**：`getBoundingClientRect()`（含 transform 结果）的
 *    顶边位置必须变化；
 * ② **脚底几乎不动**：底边变化必须远小于顶边（否则就是「整只宠物在缩放」，
 *    而不是「原地呼吸」——这正是 transform-origin 写错的表现）；
 * ③ **眨眼真的跳帧**：宠物像素颜色必须短暂变化。
 *
 * 外加：镜像与呼吸共存、没声明 motion 的动作不动、面板里也在呼吸。
 *
 * 前置：
 *   1. 影子宿主在 PET_SANDBOX_PORT 上运行；
 *   2. 测试形象已放进插件的 data/pets：
 *        python tools/make-motion-pet.py <data/pets>
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-motion.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const PACK = process.env.PET_MOTION_ID || 'motion-pet';
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

  // ================================================== ① 运行期定义
  const rt = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${PACK}/runtime', { method: 'GET' });
    if (!res || !res.success) return { error: (res && res.msg) || 'no response' };
    const idle = res.pet.actions.idle;
    const walk = res.pet.actions['walk-left'];
    return {
      idleMotion: idle.motion || null,
      idleOrigin: idle.motionOrigin || '',
      walkMotion: walk.motion || null,
      walkOrigin: walk.motionOrigin || '',
      stillMotion: (res.pet.still || {}).motion || null,
      stillOrigin: (res.pet.still || {}).motionOrigin || '',
      anchor: res.pet.anchor,
    };
  })()`);

  if (rt.error) {
    record(`① ${PACK}：运行期定义可用`, false, rt.error);
    throw new Error(rt.error);
  }

  record(
    '① 运行期下发 motion（呼吸 + 眨眼）',
    Boolean(rt.idleMotion && rt.idleMotion.breathe && rt.idleMotion.blink),
    JSON.stringify(rt.idleMotion),
  );
  record(
    '① ★ transform-origin 跟着包级 anchor.y 走（不是写死底部居中）',
    rt.idleOrigin === '50% 90.0%',
    `anchor=${JSON.stringify(rt.anchor)} -> motionOrigin="${rt.idleOrigin}"（期望 "50% 90.0%"）`,
  );
  record(
    '① 没声明 motion 的动作不下发 motion（对照组）',
    !rt.walkMotion && !rt.walkOrigin,
    `walk-left: motion=${JSON.stringify(rt.walkMotion)} origin="${rt.walkOrigin}"`,
  );
  record(
    '① ★ 标准图像继承 idle 的运动（静止时也要呼吸）',
    Boolean(rt.stillMotion && rt.stillMotion.breathe) && rt.stillOrigin === '50% 90.0%',
    `still.motion=${JSON.stringify(rt.stillMotion)} origin="${rt.stillOrigin}"`,
  );

  // ================================================== ② 桌面宠物：呼吸真的在动
  //
  // 判据用 getBoundingClientRect()，不用像素：呼吸是 transform 动画，
  // 而 getBoundingClientRect() 包含 transform 的结果——既精确又不受页面底色影响。
  //
  // （最初用像素采样 + 「亮度低于 150 算背景」，结果在**真实应用页**上失败：
  // 应用页底色是浅色卡片区，整屏都算「宠物」，顶边恒为 0。
  // 判据依赖「页面是深色」这件事本身就是脆的。）
  const probe = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${PACK}/runtime', { method: 'GET' });
    const container = document.createElement('div');
    container.id = 'motion-probe';
    container.style.cssText = 'position:fixed;left:40px;top:40px;width:400px;height:600px;z-index:9999';
    document.body.appendChild(container);
    const view = mod.createPetView({
      container, pack: res.pet,
      config: { scale: 2, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
      hooks: {},
    });
    view.physics.setPosition(200, 560);
    window.__view = view;
    await new Promise((r) => setTimeout(r, 300));
    const sprite = view.element.querySelector('.pet-sprite');
    const root = view.element;
    const r = sprite.getBoundingClientRect();
    return {
      action: view.action,
      hasBreathe: root.classList.contains('has-breathe'),
      amp: sprite.style.getPropertyValue('--pet-breathe-amp'),
      period: sprite.style.getPropertyValue('--pet-breathe-period'),
      origin: sprite.style.transformOrigin,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  })()`);

  record(
    '② 桌面宠物挂上了呼吸（has-breathe + 变量 + origin）',
    probe.hasBreathe && Number(probe.amp) > 0 && probe.origin === '50% 90%',
    `has-breathe=${probe.hasBreathe} amp=${probe.amp} period=${probe.period} origin=${probe.origin}`,
  );

  /** 采样式：读 sprite 的 getBoundingClientRect()（含 transform 结果）。 */
  async function sampleRect() {
    return page.evaluate(`(() => {
      const view = window.__view;
      if (!view) return null;
      const sprite = view.element.querySelector('.pet-sprite');
      const r = sprite.getBoundingClientRect();
      return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), h: +r.height.toFixed(2) };
    })()`);
  }

  const tops = [];
  const bottoms = [];
  for (let i = 0; i < 16; i += 1) {
    const box = await sampleRect();
    if (box) { tops.push(box.top); bottoms.push(box.bottom); }
    await sleep(100);
  }
  const span = (list) => (list.length ? Math.max(...list) - Math.min(...list) : 0);
  const topSpan = span(tops);
  const bottomSpan = span(bottoms);
  // 幅度 ±6% 即全程 12%；原点在 y=90%，因此顶边走 0.9×12%×H，底边走 0.1×12%×H
  const expectedTop = probe.rect.h * 0.12 * 0.9;
  const expectedBottom = probe.rect.h * 0.12 * 0.1;

  record(
    '② ★ 呼吸真的在动（顶边位置变化）',
    topSpan > 3,
    `顶边 ${Math.min(...tops).toFixed(1)} → ${Math.max(...tops).toFixed(1)}，行程 ${topSpan.toFixed(1)}px`
    + `（幅度 ±6% × 高 ${probe.rect.h.toFixed(0)}px、原点 y=90% ≈ 期望 ${expectedTop.toFixed(1)}px）`,
  );
  record(
    '② ★ 脚底几乎不动——证明原点在 anchor 上，而不是整只在缩放',
    // 原点 y=90% 时底边仍会走 1/9 的顶边行程（不是 0，但远小于顶边）
    bottomSpan < Math.max(2, topSpan * 0.35),
    `底边行程 ${bottomSpan.toFixed(1)}px vs 顶边 ${topSpan.toFixed(1)}px`
    + `（原点 90% 时期望比 ≈ 0.11，实测 ${(bottomSpan / Math.max(0.01, topSpan)).toFixed(2)}）`
    + `；期望底边 ${expectedBottom.toFixed(1)}px`,
  );

  // ================================================== ③ 眨眼真的跳帧
  //
  // 眨眼只改 background-position（不改盒子），因此这里必须看像素。
  // 判据用**饱和度**挑出宠物像素：宠物帧是纯色（通道差很大），
  // 应用页的卡片/文字是灰的（通道差很小）——因此不受页面底色明暗影响。
  async function samplePetColor() {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    return page.evaluate(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${shot.data}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const sx = img.naturalWidth / window.innerWidth;
      const sy = img.naturalHeight / window.innerHeight;
      const r = window.__view.element.querySelector('.pet-sprite').getBoundingClientRect();
      const X0 = Math.max(0, Math.round(r.left * sx));
      const Y0 = Math.max(0, Math.round(r.top * sy));
      const W = Math.max(1, Math.round(r.width * sx));
      const H = Math.max(1, Math.round(r.height * sy));
      const d = x.getImageData(X0, Y0, W, H).data;
      let rr = 0, gg = 0, bb = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 13) {
        const a = d[i], b = d[i + 1], c2 = d[i + 2];
        // 只统计**高饱和**像素（宠物），跳过灰底
        if (Math.max(a, b, c2) - Math.min(a, b, c2) < 60) continue;
        rr += a; gg += b; bb += c2; n += 1;
      }
      return n ? [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)] : null;
    })()`);
  }

  const colors = [];
  for (let i = 0; i < 30; i += 1) {
    const c = await samplePetColor();
    if (c) colors.push(c.join(','));
    await sleep(70);
  }
  const distinctColors = new Set(colors).size;
  record(
    '③ ★ 眨眼真的跳到别的帧（宠物像素颜色短暂变化）',
    distinctColors >= 2,
    `30 次采样得到 ${distinctColors} 种颜色：${[...new Set(colors)].slice(0, 8).join(' | ')}`,
  );

  // ================================================== ④ 切换动作时呼吸跟着开关
  const mirror = await page.evaluate(`(async () => {
    const view = window.__view;
    const sprite = view.element.querySelector('.pet-sprite');
    const root = view.element;
    // 切到 happy —— 它**没有声明 motion**，而且是合法的播报动作。
    //
    // ⚠️ 为什么用 happy 而不是 walk-left：react() 只接受
    // REACT_ACTIONS（happy / sad / angry / click），拿 walk-left 去 react
    // 会被状态机**拒绝**、动作仍停在 idle——那样测的其实是
    // 「拒绝后呼吸还在」，与这条断言想验的东西无关（第一版就错在这里）。
    view.react('happy');
    await new Promise((r) => setTimeout(r, 400));
    return {
      action: view.action,
      state: view.state,
      hasBreathe: root.classList.contains('has-breathe'),
      amp: sprite.style.getPropertyValue('--pet-breathe-amp'),
      inlineTransform: sprite.style.transform,
      face: sprite.style.getPropertyValue('--pet-face'),
    };
  })()`);

  record(
    '④ ★ 切到没声明 motion 的动作后，呼吸被摘掉（不残留）',
    mirror.hasBreathe === false && !mirror.amp,
    `action=${mirror.action} state=${mirror.state} has-breathe=${mirror.hasBreathe} amp="${mirror.amp}"`,
  );
  record(
    '④ ★ 没呼吸时镜像机制切回内联 transform（--pet-face 被清掉，不残留）',
    // 契约是「**机制**随呼吸切换」：
    //   有呼吸 → 镜像走 --pet-face（内联 transform 会被动画覆盖，必须让位）
    //   没呼吸 → 镜像走内联 transform（--pet-face 清掉）
    // 因此这里查的是「--pet-face 是否被清掉」，而不是「transform 一定有值」：
    // 这个形象的 happy 恰好**不需要**翻转（它提供了方向化贴图，
    // 按既有规则连 idle 都不翻），此时内联 transform 写成空串是**正确**的
    // ——第一版把「一定有值」当判据，错在这里。
    mirror.hasBreathe === false && mirror.face === '',
    `has-breathe=${mirror.hasBreathe} --pet-face="${mirror.face}"`
    + ` inlineTransform="${mirror.inlineTransform}"（该动作不需翻转，空串是正常的）`,
  );

  // 回 idle（有 motion）：镜像必须改用 CSS 变量，否则会被动画覆盖
  const mirrorIdle = await page.evaluate(`(async () => {
    const view = window.__view;
    const sprite = view.element.querySelector('.pet-sprite');
    // 等播报结束自动回 idle（happy 是 4 帧 @4fps = 1s）
    await new Promise((r) => setTimeout(r, 1600));
    return {
      action: view.action,
      state: view.state,
      hasBreathe: view.element.classList.contains('has-breathe'),
      face: sprite.style.getPropertyValue('--pet-face'),
      inlineTransform: sprite.style.transform,
      computed: getComputedStyle(sprite).transform,
    };
  })()`);
  record(
    '④ ★ 播报结束回 idle 后呼吸恢复，且镜像走 CSS 变量（内联 transform 会被动画覆盖，因此必须让位）',
    mirrorIdle.hasBreathe && mirrorIdle.inlineTransform === '' && mirrorIdle.face !== '',
    `action=${mirrorIdle.action} state=${mirrorIdle.state} has-breathe=${mirrorIdle.hasBreathe}`
    + ` --pet-face="${mirrorIdle.face}" inlineTransform="${mirrorIdle.inlineTransform}"`
    + ` computed="${mirrorIdle.computed}"`,
  );

  // ================================================== ⑤ 清理后不再动
  await page.evaluate(`(() => { window.__view.dispose(); document.getElementById('motion-probe').remove(); })()`);
  await sleep(300);
  const afterDispose = await page.evaluate(`(() => document.getElementById('motion-probe') === null)()`);
  record('⑤ 视图销毁后探针已移除（无残留）', afterDispose === true);

  // ================================================== ⑥ 面板里也在呼吸
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-motion' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1200);
  const panel = await page.evaluate(`(async () => {
    const cards = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'));
    const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(PACK)});
    if (!card) return { error: '找不到卡片' };
    card.click();
    await new Promise((r) => setTimeout(r, 900));
    const picks = Array.from(document.querySelectorAll('.plugin-stm-pet [data-preview-action]'));
    const idle = picks.find((p) => p.dataset.previewAction === 'idle');
    if (idle) { idle.click(); await new Promise((r) => setTimeout(r, 900)); }
    const layer = document.querySelector('.plugin-stm-pet .pet-preview-frame-layer');
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    if (box) box.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 300));
    const metas = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-preview-meta'))
      .map((n) => n.textContent.trim());
    return {
      hasBreathe: layer ? layer.classList.contains('has-breathe') : false,
      amp: layer ? layer.style.getPropertyValue('--pet-breathe-amp') : '',
      origin: layer ? layer.style.transformOrigin : '',
      metas,
    };
  })()`);

  if (panel.error) {
    record('⑥ 面板就绪', false, panel.error);
  } else {
    record(
      '⑥ ★ 面板预览器也挂了呼吸（否则用户以为功能没生效）',
      panel.hasBreathe && Number(panel.amp) > 0,
      `has-breathe=${panel.hasBreathe} amp=${panel.amp} origin="${panel.origin}"`,
    );
    record(
      '⑥ 面板写明这是「程序化运动」（不占额外帧）',
      panel.metas.some((m) => /程序化运动/.test(m)),
      panel.metas.join(' | '),
    );
    // 面板里的呼吸也要真的在动。
    // 同样用 getBoundingClientRect()（含 transform），不看像素——
    // 面板底色是浅色的，亮度判据在那边同样不成立。
    const panelTops = [];
    for (let i = 0; i < 14; i += 1) {
      const rect = await page.evaluate(`(() => {
        const layer = document.querySelector('.plugin-stm-pet .pet-preview-frame-layer');
        if (!layer) return null;
        const r = layer.getBoundingClientRect();
        return { top: +r.top.toFixed(2) };
      })()`);
      if (rect) panelTops.push(rect.top);
      await sleep(100);
    }
    const pSpan = panelTops.length ? Math.max(...panelTops) - Math.min(...panelTops) : 0;
    record(
      '⑥ ★ 面板里的呼吸也真的在动',
      pSpan > 1,
      `顶边行程 ${pSpan.toFixed(1)}px（${panelTops.length} 次采样）`,
    );
  }

  // ================================================== ⑦ 无控制台错误
  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑦ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`程序化运动验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
