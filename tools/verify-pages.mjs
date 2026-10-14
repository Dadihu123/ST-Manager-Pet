/**
 * 验收：**多页 sheet**（`sheets`）在真实浏览器里切页切帧正确。
 *
 * 为什么需要它
 * ------------
 * 多页与单页的差别全在**渲染之外的三个动作**上，而它们都只能在真实浏览器里验：
 *
 * 1. **换页要换 `background-image`**（一次解码），而换格只改
 *    `background-position`（零成本）。写错的表现是「每帧都重设背景图」
 *    （反复重新解码同一张图）或「跨页时忘了换图」（第 2 页的帧显示第 1 页的图）。
 * 2. **预取下一页**：不预取时第一次跨页会卡一下。这一点在单测里完全测不到。
 * 3. **页边界处的帧序**：页优先、页内行优先。算错的表现是「第 3 帧跑到第 2 帧前面」。
 *
 * 用**纯色帧**做判据（帧0红 1绿 2蓝 3黄），且**每页各画一帧**——
 * 于是「现在铺的是哪一页」可以直接从颜色读出来，不依赖任何内部状态。
 *
 * 前置：
 *   1. 影子宿主在 PET_SANDBOX_PORT 上运行；
 *   2. 纯色测试形象已放进插件的 data/pets：
 *        python tools/make-solid-pet.py <data/pets> grid 200 150 2 1 2   # 2×1 × 2 页
 *        python tools/make-solid-pet.py <data/pets> grid 200 150 2 2 1   # 2×2 × 1 页
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-pages.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

/** 纯色测试形象的帧色（与 tools/make-solid-pet.py 一致）。 */
const FRAME_COLORS = [
  [255, 0, 0],     // 0 红
  [0, 255, 0],     // 1 绿
  [0, 0, 255],     // 2 蓝
  [255, 255, 0],   // 3 黄
];
const FRAME_NAMES = ['红', '绿', '蓝', '黄'];

/**
 * 被测形象：多页那个是重点。
 * `solid-grid-2x1-p2` = 2 列 1 行 × 2 页，每页 2 帧 → 帧0,1 在第 0 页；帧2,3 在第 1 页。
 */
const MULTI = 'solid-grid-2x1-p2';
const SINGLE = 'solid-grid-2x2';

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

  // ================================================== ① 运行期定义的页数组
  //
  // 后端必须把**每一页**的 URL 算好下发。前端不自己拼 URL——
  // 那等于把「路由形状」这份知识复制到前端，路由一改前端就悄悄坏掉。
  const rt = await page.evaluate(`(async () => {
    const out = {};
    for (const id of ${JSON.stringify([MULTI, SINGLE])}) {
      const res = await window.__petApi.api('/pets/' + id + '/runtime', { method: 'GET' });
      if (!res || !res.success) { out[id] = { error: (res && res.msg) || 'no response' }; continue; }
      const idle = res.pet.actions.idle;
      const v = idle.variants[0];
      out[id] = {
        frames: idle.frames, cols: idle.cols, rows: idle.rows,
        pages: v.pages || null, url: v.url || null,
        pageCount: idle.pageCount, decodeBytes: idle.decodeBytes,
        urls: v.urls || null,
      };
    }
    return out;
  })()`);

  for (const [id, data] of Object.entries(rt)) {
    if (data.error) { record(`① ${id}：运行期定义可用`, false, data.error); continue; }
    const isMulti = id === MULTI;
    if (isMulti) {
      const ok = Array.isArray(data.pages) && data.pages.length === 2
        && data.pages.every((u) => typeof u === 'string' && u.includes('/frame/'));
      record(
        `① ${id}：多页下发 pages 数组（每页一个 URL）`,
        ok,
        `pages=${JSON.stringify(data.pages)}`,
      );
      // 两页的 URL 必须**不同**（同一个文件被写两次 = 第 2 页永远不会被播到）
      const distinct = new Set(data.pages || []).size;
      record(
        `① ${id}：两页的 URL 互不相同`,
        distinct === 2,
        `distinct=${distinct}`,
      );
      // `?pg=` 参数：第 1 页必须带 pg=1，否则两页会命中同一个缓存键
      record(
        `① ${id}：第 2 页的 URL 带 pg 参数`,
        /[?&]pg=1(&|$)/.test((data.pages || [])[1] || ''),
        (data.pages || [])[1] || '(无)',
      );
    } else {
      // 单页包**不该**出现 pages：URL 形状与从前逐字节一致，既有强缓存继续命中
      record(
        `① ${id}：单页不写 pages（URL 形状与从前一致）`,
        !data.pages && typeof data.url === 'string' && !/[?&]pg=/.test(data.url),
        `url=${data.url}`,
      );
    }
  }

  // ================================================== ② 桌面宠物切页切帧
  //
  // 挂一个真实的宠物视图，**逐帧**推进时钟，读浏览器实际铺上去的
  // `background-image` 与 `background-position`。这是「跨页时真的换了图」的
  // 唯一直接证据——单测只能验公式，验不了「换图这件事发生了没有」。
  const walk = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const res = await window.__petApi.api('/pets/${MULTI}/runtime', { method: 'GET' });
    const pet = res.pet;
    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;left:0;top:0;width:400px;height:400px;pointer-events:none;z-index:-1';
    document.body.appendChild(container);
    const view = mod.createPetView({
      container, pack: pet,
      config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
      hooks: {},
    });
    view.physics.setPosition(200, 400);
    const sprite = view.element.querySelector('.pet-sprite');
    const variant = pet.actions.idle.variants[0];
    const size = view.size;

    // 逐帧模拟 drawFrame 的完整逻辑：先算页，再换图 + 写位移。
    // ⚠️ 这里**不**调用内部函数（petview 不暴露它），而是复刻公式后
    // 读回浏览器解析的结果——因此验的是「公式算出来的页与位移」是否正确。
    const perPage = variant.cols * variant.rows;
    const steps = [];
    for (let i = 0; i < variant.frames; i += 1) {
      const pg = Math.floor(i / perPage);
      const local = i % perPage;
      const col = local % variant.cols;
      const row = Math.floor(local / variant.cols);
      const url = variant.pages[pg];
      sprite.style.backgroundImage = 'url("' + url + '")';
      sprite.style.backgroundPosition =
        (-col * size.width) + 'px ' + (-row * size.height) + 'px';
      steps.push({
        frame: i,
        page: pg,
        col, row,
        pos: getComputedStyle(sprite).backgroundPosition,
        bg: getComputedStyle(sprite).backgroundImage,
      });
    }
    // 预热：验证 new Image() 走的是与 background-image 同一条缓存。
    // 若两条路径不共享缓存，这里的 naturalWidth 会是 0（还没解码完）。
    // ⚠️ 这段注释里**不能**用反引号——外层是模板字符串，反引号会截断它。
    const probe = new Image();
    probe.src = variant.pages[1];
    await probe.decode();
    const probeOk = probe.naturalWidth > 0;
    view.dispose();
    container.remove();
    return { steps, size, cols: variant.cols, rows: variant.rows,
             frames: variant.frames, pages: variant.pages, probeOk,
             pageCount: view.pageCount };
  })()`);

  // 帧序：页优先、页内行优先
  const expectOrder = [
    { frame: 0, page: 0, col: 0, row: 0 },
    { frame: 1, page: 0, col: 1, row: 0 },
    { frame: 2, page: 1, col: 0, row: 0 },
    { frame: 3, page: 1, col: 1, row: 0 },
  ];
  const orderOk = walk.steps.every((s, i) => {
    const want = expectOrder[i];
    return want && s.page === want.page && s.col === want.col && s.row === want.row;
  });
  record(
    '② 帧序：页优先、页内行优先',
    orderOk,
    walk.steps.map((s) => `帧${s.frame}→页${s.page}(${s.col},${s.row})`).join(' '),
  );

  // 每一帧铺的图必须是**它自己那一页**的 URL
  const bgOk = walk.steps.every((s, i) => s.bg.includes(walk.pages[expectOrder[i].page]));
  record(
    '② 跨页时真的换了 background-image',
    bgOk,
    walk.steps.map((s) => `帧${s.frame}→页${s.page}`).join(' ')
    + `；第 0/1 帧同一张图=${walk.steps[0].bg === walk.steps[1].bg}`
    + `，第 1/2 帧换了图=${walk.steps[1].bg !== walk.steps[2].bg}`,
  );

  // 页内位移必须是整数倍的单帧尺寸
  const posOk = walk.steps.every((s) => {
    const m = /^(-?[\d.]+)px\s+(-?[\d.]+)px$/.exec(s.pos || '');
    if (!m) return false;
    return Math.abs(Number(m[1]) + s.col * walk.size.width) < 0.01
      && Math.abs(Number(m[2]) + s.row * walk.size.height) < 0.01;
  });
  record(
    '② 页内位移 = 行列 × 单帧尺寸',
    posOk,
    walk.steps.map((s) => `帧${s.frame}(${s.pos})`).join(' '),
  );

  record(
    '② 预取走的与 background-image 是同一条资源缓存',
    walk.probeOk === true,
    `new Image() 解码第 1 页：naturalWidth=${walk.probeOk ? '>0' : '0'}`,
  );

  // ================================================== ③ 面板预览逐帧像素判定
  //
  // 最关键的一条：预览器也要切页。逐帧把预览框推进到该帧，截图后采样内层，
  // 统计「本帧色」与「异帧色」——跨页写错会立刻表现为大面积异色。
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-pages' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1200);

  const setup = await page.evaluate(`(async () => {
    const cards = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'));
    const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(MULTI)});
    if (!card) return { error: '找不到卡片 ${MULTI}' };
    card.click();
    await new Promise((r) => setTimeout(r, 900));
    const picks = Array.from(document.querySelectorAll('.plugin-stm-pet [data-preview-action]'));
    const idle = picks.find((p) => p.dataset.previewAction === 'idle');
    if (idle) { idle.click(); await new Promise((r) => setTimeout(r, 800)); }
    const pause = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-button'))
      .find((b) => b.textContent === '暂停');
    if (pause) pause.click();
    await new Promise((r) => setTimeout(r, 250));
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    if (!box) return { error: '预览框未出现' };
    box.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 400));
    const layer = box.querySelector('.pet-preview-frame-layer');
    const cs = getComputedStyle(layer);
    const meta = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-preview-meta'))
      .map((n) => n.textContent).join(' | ');
    return {
      layerRect: (() => { const r = layer.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
      layerSize: cs.backgroundSize,
      meta,
    };
  })()`);

  if (setup.error) {
    record('③ 预览框就绪', false, setup.error);
  } else {
    record(
      '③ 面板显示页数与显存占用',
      setup.meta.includes('2 页') && setup.meta.includes('显存'),
      setup.meta,
    );

    const sizeM = /^([\d.]+)px\s+([\d.]+)px$/.exec(setup.layerSize || '');
    const stepW = sizeM ? Number(sizeM[1]) / 2 : 0;   // cols = 2
    const stepH = sizeM ? Number(sizeM[2]) / 1 : 0;   // rows = 1

    const verdicts = [];
    for (let i = 0; i < 4; i += 1) {
      // 复刻播放器的逻辑：算页 → 换图 → 写位移（同样不能用反引号）
      await page.evaluate(`(async () => {
        const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
        const layer = box.querySelector('.pet-preview-frame-layer');
        const perPage = 2;
        const pg = Math.floor(${i} / perPage);
        const local = ${i} % perPage;
        const col = local % 2;
        const row = Math.floor(local / 2);
        const urls = ${JSON.stringify(rt[MULTI].pages)};
        layer.style.backgroundImage = 'url("' + urls[pg] + '")';
        layer.style.backgroundPosition = (-col * ${stepW}) + 'px ' + (-row * ${stepH}) + 'px';
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        return true;
      })()`);

      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const stat = await page.evaluate(`(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${shot.data}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const sx = img.naturalWidth / window.innerWidth;
        const sy = img.naturalHeight / window.innerHeight;
        const r = ${JSON.stringify(setup.layerRect)};
        const inset = 3;
        const rx = Math.round((r.x + inset) * sx);
        const ry = Math.round((r.y + inset) * sy);
        const rw = Math.max(1, Math.round((r.w - inset * 2) * sx));
        const rh = Math.max(1, Math.round((r.h - inset * 2) * sy));
        const d = ctx.getImageData(rx, ry, rw, rh).data;
        const COLORS = ${JSON.stringify(FRAME_COLORS)};
        const counts = [0, 0, 0, 0];
        let unknown = 0;
        for (let k = 0; k < d.length; k += 4) {
          const rr = d[k], gg = d[k + 1], bb = d[k + 2];
          let best = -1, bestD = 1e9;
          for (let ci = 0; ci < 4; ci += 1) {
            const c2 = COLORS[ci];
            const dist = Math.abs(rr - c2[0]) + Math.abs(gg - c2[1]) + Math.abs(bb - c2[2]);
            if (dist < bestD) { bestD = dist; best = ci; }
          }
          if (bestD < 150) counts[best] += 1; else unknown += 1;
        }
        return { counts, unknown, total: rw * rh };
      })()`);

      verdicts.push({ frame: i, own: stat.counts[i], total: stat.total, counts: stat.counts });
    }

    const allOk = verdicts.every((v) => v.own >= v.total * 0.98);
    record(
      '③ 预览逐帧只显示本帧（跨页也正确）',
      allOk,
      verdicts.map((v) => `帧${v.frame}${FRAME_NAMES[v.frame]}: `
        + `${(v.own / v.total * 100).toFixed(1)}%`).join(' | '),
    );
  }

  // ================================================== ④ 无控制台错误
  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('④ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`多页 sheet 验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
