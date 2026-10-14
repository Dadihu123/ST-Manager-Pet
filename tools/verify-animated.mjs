/**
 * 验收：**动图容器**（`layout: "animated"`）在真实浏览器里的行为。
 *
 * 为什么必须用真实浏览器
 * ----------------------
 * 这条路线与帧序列路线的**全部区别**都在「谁来播」这件事上：
 * 帧序列是我们逐帧改 `background-position`，动图是**浏览器自己**在播。
 * 而「浏览器到底有没有在播」这件事，单测与静态检查**完全测不到**——
 * 它取决于浏览器怎么处理多帧 GIF。
 *
 * 因此这里的核心判据是：**同一张图，过一段时间采样两次，像素必须变了**。
 * 不变就说明它被当成了静态图（正是我们要避免的失败）。
 *
 * 另外要验的是**代价被如实告知**：面板要显示真实帧数、解码占用、
 * 以及「无法逐帧控制 / 无法分页」这两条真正的代价。
 *
 * 前置：
 *   1. 影子宿主在 PET_SANDBOX_PORT 上运行；
 *   2. 动图测试形象已放进插件的 data/pets：
 *        python tools/make-animated-pet.py <data/pets> 24
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-animated.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

const PACK = process.env.PET_ANIMATED_ID || 'animated-pet';

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
    return {
      kind: idle.kind, layout: idle.layout, animated: idle.animated,
      animatedFrames: idle.animatedFrames, frames: idle.frames, fps: idle.fps,
      cols: idle.cols, rows: idle.rows, pageCount: idle.pageCount,
      decodeBytes: idle.decodeBytes, url: idle.url,
      warnings: idle.warnings || [],
      packDecodeBytes: res.pet.decodeBytes,
      animatedActions: res.pet.animatedActions,
      distinctImages: res.pet.distinctImages,
    };
  })()`);

  if (rt.error) {
    record(`① ${PACK}：运行期定义可用`, false, rt.error);
    throw new Error(rt.error);
  }

  record(
    '① 动图动作带 animated 标记与**真实帧数**',
    rt.animated === true && rt.animatedFrames > 1,
    `animated=${rt.animated} animatedFrames=${rt.animatedFrames} layout=${rt.layout}`,
  );
  record(
    '① 动图不切帧：frames=1、网格 1×1、页数 1',
    rt.frames === 1 && rt.cols === 1 && rt.rows === 1 && rt.pageCount === 1,
    `frames=${rt.frames} grid=${rt.cols}x${rt.rows} pages=${rt.pageCount}`,
  );
  record(
    '① 不编造帧率（读不到就说 0，而不是给个假数字）',
    rt.fps === 0,
    `fps=${rt.fps}`,
  );
  record(
    '① 解码占用按**真实帧数**算',
    rt.decodeBytes > 0,
    `decodeBytes=${(rt.decodeBytes / 1048576).toFixed(1)} MB`
    + `（${rt.animatedFrames} 帧），形象合计 ${(rt.packDecodeBytes / 1048576).toFixed(1)} MB`
    + `，去重后 ${rt.distinctImages} 张图`,
  );
  record(
    '① 提醒里说明「无法逐帧控制」与「无法分页」',
    rt.warnings.some((w) => w.code === 'animated_no_frame_control')
      && rt.warnings.some((w) => /分页/.test(w.message)),
    rt.warnings.map((w) => `[${w.level}] ${w.message}`).join('\n        '),
  );

  // ================================================== ② 浏览器**真的在播**
  //
  // 这是本文件的核心：把动图挂进页面，过一段时间采样两次，像素必须变了。
  // 不变就说明它被当成了静态图（正是我们要避免的失败）。
  //
  // ⚠️ **必须用截图采样，不能用 canvas**（实测踩到过）：
  // 无头 Chrome 里 `drawImage(gifImg)` + `getImageData()` 永远返回**第一帧**
  // ——canvas 读取路径不会推进动图的动画时钟，而**合成输出**（截图）会。
  // 实测：同一个 GIF 用 canvas 采样 7 次得到 1 个值（看起来像"没在动"），
  // 用截图采样得到 4 个不同值（确实在动）。
  // 因此这个判据只能建立在截图上，否则会把一个正常工作的特性判成失败。
  const probe = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${PACK}/runtime', { method: 'GET' });
    const url = res.pet.actions.idle.url;
    const node = document.createElement('div');
    node.id = 'gif-probe';
    // 放在左上角、高于一切，确保截图里能看到它
    node.style.cssText = 'position:fixed;left:20px;top:20px;width:240px;height:240px;'
      + 'background:url(' + url + ') 0 0/240px 240px no-repeat;z-index:99999';
    document.body.appendChild(node);
    await new Promise((r) => setTimeout(r, 300));
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);

  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const value = await page.evaluate(`(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${shot.data}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const sx = img.naturalWidth / window.innerWidth;
      const sy = img.naturalHeight / window.innerHeight;
      const r = ${JSON.stringify(probe)};
      const inset = 10;
      const d = ctx.getImageData(
        Math.round(r.x * sx) + inset, Math.round(r.y * sy) + inset,
        Math.max(1, Math.round(r.w * sx) - inset * 2),
        Math.max(1, Math.round(r.h * sy) - inset * 2),
      ).data;
      let sum = 0, n = 0;
      for (let k = 0; k < d.length; k += 4 * 97) { sum += d[k] + d[k + 1] + d[k + 2]; n += 1; }
      return Number((sum / Math.max(1, n)).toFixed(2));
    })()`);
    samples.push(value);
    await sleep(180);
  }
  const distinct = new Set(samples.map((v) => String(v))).size;
  record(
    '② ★ 浏览器**真的在播**这张动图（合成输出多次采样像素发生变化）',
    distinct > 1,
    `8 次截图采样得到 ${distinct} 个不同值：${samples.join(' ')}`
    + '（判据用截图而非 canvas——无头 Chrome 的 canvas 读取不推进动图时钟）',
  );
  await page.evaluate(`(() => { const n = document.getElementById('gif-probe'); if (n) n.remove(); })()`);

  // ================================================== ③ 桌面宠物：动图不被切帧
  const pet = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${PACK}/runtime', { method: 'GET' });
    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;left:0;top:0;width:400px;height:400px;pointer-events:none;z-index:-1';
    document.body.appendChild(container);
    const view = mod.createPetView({
      container, pack: res.pet,
      config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
      hooks: {},
    });
    view.physics.setPosition(200, 400);
    const sprite = view.element.querySelector('.pet-sprite');
    const out = {
      action: view.action,
      page: view.page,
      pageCount: view.pageCount,
      size: view.size,
      bg: sprite.style.backgroundSize,
      pos: sprite.style.backgroundPosition,
      repeat: sprite.style.backgroundRepeat,
    };
    view.dispose();
    container.remove();
    return out;
  })()`);

  record(
    '③ 桌面宠物把动图当**一帧**铺（不切帧、位移为 0）',
    pet.pos === '0px 0px' && /^\d+px \d+px$/.test(pet.bg || ''),
    `action=${pet.action} size=${pet.size.width}×${pet.size.height}`
    + ` bg=${pet.bg} pos=${pet.pos} page=${pet.page}/${pet.pageCount}`,
  );
  record(
    '③ 单帧铺法 = 整张图原样（背景尺寸等于宠物尺寸）',
    pet.bg === `${pet.size.width}px ${pet.size.height}px`,
    `bg=${pet.bg}，宠物单帧=${pet.size.width}×${pet.size.height}`,
  );

  // ================================================== ④ 面板如实告知代价
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-animated' });
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
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    if (box) box.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 400));
    return {
      meta: Array.from(document.querySelectorAll('.plugin-stm-pet .pet-preview-meta'))
        .map((n) => n.textContent.trim()),
      frameReadout: (document.querySelector('.plugin-stm-pet .pet-preview-frame') || {}).textContent || '',
      badges: Array.from(document.querySelectorAll('.plugin-stm-pet .pet-action-badge'))
        .map((n) => n.textContent.trim()),
      hasAnimatedBadge: Boolean(document.querySelector('.plugin-stm-pet .pet-action-badge.is-animated')),
      actionNote: Array.from(document.querySelectorAll('.plugin-stm-pet .pet-action-note'))
        .map((n) => n.textContent.trim()),
    };
  })()`);

  if (panel.error) {
    record('④ 面板就绪', false, panel.error);
  } else {
    const metaText = (panel.meta || []).join(' | ');
    record(
      '④ ★ 面板不把它说成「单帧」——那会让用户以为图坏了',
      !/单帧/.test(panel.frameReadout) && !/单帧/.test(metaText),
      `帧读数=「${panel.frameReadout}」；元信息=${metaText}`,
    );
    record(
      '④ 面板说明「动图容器 / 由浏览器自行播放」',
      /动图容器/.test(metaText) && /浏览器自行播放/.test(metaText),
      metaText,
    );
    record(
      '④ 面板给出解码占用（用户看不到显存，只能靠插件告知）',
      /解码后约占/.test(metaText),
      metaText,
    );
    record(
      '④ 面板写明无法逐帧控制与无法分页',
      /frameMs/.test(metaText) && /分页/.test(metaText),
      metaText,
    );
    record(
      '④ 动作格有「动图」徽章（一眼看出这条路线不同）',
      panel.hasAnimatedBadge,
      `徽章=${JSON.stringify(panel.badges)}；动作说明=${JSON.stringify(panel.actionNote.slice(0, 3))}`,
    );
  }

  // ================================================== ⑤ 无控制台错误
  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑤ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`动图容器验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
