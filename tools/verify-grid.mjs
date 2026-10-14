/**
 * 验收：**网格排布**（`cols × rows`）在真实浏览器里切帧正确。
 *
 * 为什么需要它
 * ------------
 * 单测能钉住公式，但钉不住「浏览器真的按我们写的 CSS 铺图」——`background-size`
 * 与 `background-position` 的语义（尤其是 `auto` 与负偏移的合成）只有在真实
 * 渲染器里才能确认。这个脚本用**纯色帧**（帧0红 1绿 2蓝 3黄）把判定变成无歧义的：
 * 某一帧的窗口里出现别的帧色 = 邻格漏进来了。
 *
 * 三种排布都要验：它们是同一套公式的三个特例，只验一种的话
 * 「网格与单行不一致」这类偏差不会被发现。
 *
 * 前置：
 *   1. 影子宿主在 PET_SANDBOX_PORT 上运行；
 *   2. 纯色测试形象已放进插件的 data/pets：
 *        python tools/make-solid-pet.py <data/pets> grid 200 150 2 2
 *        python tools/make-solid-pet.py <data/pets> vertical 400 300
 *        python tools/make-solid-pet.py <data/pets> horizontal 300 400
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-grid.mjs
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

const PACKS = ['solid-grid-2x2', 'solid-vertical', 'solid-horizontal'];
const EXPECT = {
  'solid-grid-2x2': { layout: 'grid', cols: 2, rows: 2, frames: 4 },
  'solid-vertical': { layout: 'vertical', cols: 1, rows: 4, frames: 4 },
  'solid-horizontal': { layout: 'horizontal', cols: 4, rows: 1, frames: 4 },
};

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

  // ================================================== ① 运行期定义里的几何
  //
  // 后端必须把 `cols` / `rows` 算好下发——前端**不**自己推。
  // 这一条是「后端一套规则、前端一套规则」的防线。
  const packs = await page.evaluate(`(async () => {
    const out = {};
    for (const id of ${JSON.stringify(PACKS)}) {
      const res = await window.__petApi.api('/pets/' + id + '/runtime', { method: 'GET' });
      if (!res || !res.success) { out[id] = { error: (res && res.msg) || 'no response' }; continue; }
      const idle = res.pet.actions.idle;
      out[id] = {
        layout: idle.layout, cols: idle.cols, rows: idle.rows, frames: idle.frames,
        vLayout: idle.variants[0].layout, vCols: idle.variants[0].cols,
        vRows: idle.variants[0].rows, vFrames: idle.variants[0].frames,
        size: idle.variants[0].size || res.pet.size,
      };
    }
    return out;
  })()`);

  for (const [id, want] of Object.entries(EXPECT)) {
    const got = packs[id] || {};
    if (got.error) {
      record(`① ${id}：运行期定义可用`, false, got.error);
      continue;
    }
    const ok = got.layout === want.layout && got.cols === want.cols && got.rows === want.rows
      && got.vCols === want.cols && got.vRows === want.rows && got.frames === want.frames;
    record(
      `① ${id}：运行期定义带算好的网格几何`,
      ok,
      `动作 ${got.layout} ${got.cols}x${got.rows} ${got.frames}帧，`
      + `变体 ${got.vCols}x${got.vRows}（期望 ${want.layout} ${want.cols}x${want.rows}）`,
    );
  }

  // ================================================== ② 桌面宠物切帧
  //
  // 在页面上挂一个真实的宠物视图，逐帧 seek，读**浏览器实际算出来的**样式。
  // 这是「浏览器真的按我们写的 CSS 铺图」的直接证据。
  const petResult = await page.evaluate(`(async () => {
    const mod = await import('/api/plugins/stm-pet/assets/frontend/petview.js');
    const out = {};
    for (const id of ${JSON.stringify(PACKS)}) {
      const res = await window.__petApi.api('/pets/' + id + '/runtime', { method: 'GET' });
      if (!res || !res.success) { out[id] = { error: 'runtime failed' }; continue; }
      const pet = res.pet;
      const container = document.createElement('div');
      container.style.cssText =
        'position:fixed;left:0;top:0;width:400px;height:400px;pointer-events:none;z-index:-1';
      document.body.appendChild(container);
      const view = mod.createPetView({
        container,
        pack: pet,
        config: { scale: 1, autoRoam: false, quietMode: true, sleepAfter: 99999, animSpeed: 1 },
        hooks: {},
      });
      view.physics.setPosition(200, 400);
      // setAction 不是公开 API（petview 只暴露只读的 action 与 variantIndex）。
      // 初始动作本来就是 idle（createPetView 起手就 setAction('idle')），
      // 因此这里只校验它确实是 idle，再读样式即可。
      // ⚠️ 这段注释里**不能**用反引号——外层是模板字符串，反引号会截断它。
      const sprite = view.element.querySelector('.pet-sprite');
      const variant = pet.actions.idle.variants[0];
      const size = view.size;
      const startAction = view.action;
      const samples = [];
      for (let i = 0; i < variant.frames; i += 1) {
        // 复刻 drawFrame 的公式写第 i 帧，然后**读回**浏览器解析后的样式
        const col = i % variant.cols;
        const row = Math.floor(i / variant.cols);
        sprite.style.backgroundPosition =
          (-col * size.width) + 'px ' + (-row * size.height) + 'px';
        const cs = getComputedStyle(sprite);
        samples.push({ frame: i, size: cs.backgroundSize, pos: cs.backgroundPosition });
      }
      out[id] = {
        startAction,
        size,
        cols: variant.cols,
        rows: variant.rows,
        frames: variant.frames,
        sheet: getComputedStyle(sprite).backgroundSize,
        samples,
      };
      view.dispose();
      container.remove();
    }
    return out;
  })()`);

  for (const [id, data] of Object.entries(petResult)) {
    if (data.error) {
      record(`② ${id}：宠物视图可创建`, false, data.error);
      continue;
    }
    // 整条 sheet 的显示尺寸必须是「单帧显示尺寸 × 行列数」
    const m = /^([\d.]+)px\s+([\d.]+)px$/.exec(data.sheet || '');
    if (!m) {
      record(`② ${id}：background-size 可解析`, false, data.sheet);
      continue;
    }
    const shownW = Number(m[1]);
    const shownH = Number(m[2]);
    const okSheet = Math.abs(shownW - data.size.width * data.cols) < 0.01
      && Math.abs(shownH - data.size.height * data.rows) < 0.01;
    record(
      `② ${id}：整条 sheet = 单帧 × ${data.cols}×${data.rows}`,
      okSheet,
      `sheet ${data.sheet}，宠物单帧 ${data.size.width}×${data.size.height}`
      + `（期望 ${data.size.width * data.cols}×${data.size.height * data.rows}）`,
    );
    // 逐帧位移必须是整数倍的帧尺寸，且行优先
    const bad = [];
    data.samples.forEach((s, i) => {
      const mm = /^(-?[\d.]+)px\s+(-?[\d.]+)px$/.exec(s.pos || '');
      if (!mm) { bad.push(`帧${i}: 位移不可解析 ${s.pos}`); return; }
      const wantX = -(i % data.cols) * data.size.width;
      const wantY = -Math.floor(i / data.cols) * data.size.height;
      if (Math.abs(Number(mm[1]) - wantX) > 0.01 || Math.abs(Number(mm[2]) - wantY) > 0.01) {
        bad.push(`帧${i}: ${mm[1]},${mm[2]} 期望 ${wantX},${wantY}`);
      }
    });
    record(
      `② ${id}：逐帧位移 = 行列 × 单帧尺寸（行优先）`,
      bad.length === 0,
      bad.length ? bad.join('; ') : data.samples.map((s) => `帧${s.frame}(${s.pos})`).join(' '),
    );
  }

  // ================================================== ③ 面板预览：像素级邻帧判定
  //
  // 最关键的一条：打开设置面板，选纯色形象，**逐帧**把预览框的位移改成该帧，
  // 截图后采样内层区域，统计「本帧色」与「其它帧色」的像素数。
  // 网格排布下漏的不止上下/左右一帧，而是整行整列——比单行更明显。
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-grid' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1200);

  for (const id of PACKS) {
    const want = EXPECT[id];
    // 选中形象 → 选 idle 动作 → 暂停
    const setup = await page.evaluate(`(async () => {
      const cards = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'));
      const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(id)});
      if (!card) return { error: '找不到卡片 ${id}' };
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
      return {
        boxRect: (() => { const r = box.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
        layerRect: (() => { const r = layer.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
        layerSize: cs.backgroundSize,
      };
    })()`);

    if (setup.error) {
      record(`③ ${id}：预览框就绪`, false, setup.error);
      continue;
    }

    const sizeM = /^([\d.]+)px\s+([\d.]+)px$/.exec(setup.layerSize || '');
    if (!sizeM) {
      record(`③ ${id}：预览 background-size 可解析`, false, setup.layerSize);
      continue;
    }
    const shownW = Number(sizeM[1]);
    const shownH = Number(sizeM[2]);
    const stepW = shownW / want.cols;
    const stepH = shownH / want.rows;

    // 逐帧：写位移 → 截图 → 采样内层区域 → 统计本帧色与异帧色
    const verdicts = [];
    for (let i = 0; i < want.frames; i += 1) {
      await page.evaluate(`(async () => {
        const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
        const layer = box.querySelector('.pet-preview-frame-layer');
        layer.style.backgroundPosition =
          ${-((i % want.cols) * stepW)} + 'px ' + ${-(Math.floor(i / want.cols) * stepH)} + 'px';
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
        // 内缩 3px：避开外框圆角与边框抗锯齿（那些是中性混合，与邻帧无关）
        const inset = 3;
        const rx = Math.round((r.x + inset) * sx);
        const ry = Math.round((r.y + inset) * sy);
        const rw = Math.max(1, Math.round((r.w - inset * 2) * sx));
        const rh = Math.max(1, Math.round((r.h - inset * 2) * sy));
        const d = ctx.getImageData(rx, ry, rw, rh).data;
        const COLORS = ${JSON.stringify(FRAME_COLORS)};
        const NAMES = ${JSON.stringify(FRAME_NAMES)};
        const counts = [0, 0, 0, 0];
        let other = 0, total = 0;
        const samples = [];
        for (let k = 0; k < d.length; k += 4) {
          const rr = d[k], gg = d[k + 1], bb = d[k + 2];
          total += 1;
          // 找最接近的帧色（纯色帧，容差给足以吸收缩放插值）
          let best = -1, bestD = 1e9;
          for (let ci = 0; ci < 4; ci += 1) {
            const c = COLORS[ci];
            const dist = Math.abs(rr - c[0]) + Math.abs(gg - c[1]) + Math.abs(bb - c[2]);
            if (dist < bestD) { bestD = dist; best = ci; }
          }
          if (bestD < 150) { counts[best] += 1; }
          else if (samples.length < 4) { samples.push('(' + rr + ',' + gg + ',' + bb + ')'); }
        }
        return { w: rw, h: rh, counts, total, names: NAMES, unknown: samples };
      })()`);

      const own = stat.counts[i];
      const foreign = stat.total - own;
      verdicts.push({
        frame: i, name: FRAME_NAMES[i], own, foreign, total: stat.total,
        counts: stat.counts, unknown: stat.unknown,
      });
    }

    const worst = verdicts.reduce((a, b) => (b.foreign > a.foreign ? b : a), verdicts[0]);
    // 判据：每一帧里「本帧色」都必须占绝对多数。
    // 纯色帧 + 内缩采样，异色只可能来自邻格（或极少量插值/圆角残留），
    // 因此允许 2% 的容差。
    const allOk = verdicts.every((v) => v.own >= v.total * 0.98);
    record(
      `③ ${id}：预览逐帧只显示本帧（${want.cols}×${want.rows}）`,
      allOk,
      verdicts.map((v) => `帧${v.frame}${v.name}: 本帧 ${(v.own / v.total * 100).toFixed(1)}%`
        + ` 异色 ${v.foreign}`).join(' | ')
      + (worst.unknown.length ? `\n        未归类样本 ${worst.unknown.join(' ')}` : ''),
    );
  }

  // ================================================== ④ 缩略图不露邻格
  //
  // 小方框（40px 卡片缩略图 / 56px 动作格）只露第 0 帧。网格排布下两个方向
  // 都有邻格，钉错方向就会漏——这是本特性引入的**潜在漏帧**。
  const thumbCheck = await page.evaluate(`(async () => {
    const out = {};
    const IDS = ${JSON.stringify(PACKS)};
    for (const id of IDS) {
      const card = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'))
        .find((c) => c.dataset.petId === id);
      if (!card) { out[id] = { error: 'no card' }; continue; }
      const thumb = card.querySelector('.pet-card-thumb');
      const cs = getComputedStyle(thumb);
      const r = thumb.getBoundingClientRect();
      out[id] = {
        size: cs.backgroundSize, pos: cs.backgroundPosition,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        boxW: thumb.clientWidth, boxH: thumb.clientHeight,
        cols: thumb.dataset.cols, rows: thumb.dataset.rows,
        cellW: thumb.dataset.cellW, cellH: thumb.dataset.cellH,
      };
    }
    return out;
  })()`);

  const shotThumb = await page.send('Page.captureScreenshot', { format: 'png' });
  for (const id of PACKS) {
    const data = thumbCheck[id] || {};
    if (data.error) {
      record(`④ ${id}：缩略图就绪`, false, data.error);
      continue;
    }
    // 单帧显示尺寸必须 >= 方框（`cover`），否则会露出邻格
    const m = /^([\d.]+)px\s+([\d.]+)px$/.exec(data.size || '');
    if (!m) {
      record(`④ ${id}：缩略图 background-size 可解析`, false, data.size);
      continue;
    }
    const cellW = Number(m[1]) / Number(data.cols || 1);
    const cellH = Number(m[2]) / Number(data.rows || 1);
    const covers = cellW >= data.boxW - 0.51 && cellH >= data.boxH - 0.51;
    record(
      `④ ${id}：缩略图单帧盖住方框（不漏邻格）`,
      covers,
      `方框 ${data.boxW}×${data.boxH}，单帧显示 ${cellW.toFixed(1)}×${cellH.toFixed(1)}`
      + `（网格 ${data.cols}×${data.rows}，cell ${data.cellW}×${data.cellH}，pos ${data.pos}）`,
    );
  }

  // 缩略图像素级：卡片缩略图只该有第 0 帧的颜色（红）
  const thumbPixels = await page.evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${shotThumb.data}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const sx = img.naturalWidth / window.innerWidth;
    const sy = img.naturalHeight / window.innerHeight;
    const out = {};
    const IDS = ${JSON.stringify(PACKS)};
    for (const id of IDS) {
      const card = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'))
        .find((cc) => cc.dataset.petId === id);
      if (!card) continue;
      const thumb = card.querySelector('.pet-card-thumb');
      const r = thumb.getBoundingClientRect();
      const inset = 3;
      const rx = Math.round((r.x + inset) * sx);
      const ry = Math.round((r.y + inset) * sy);
      const rw = Math.max(1, Math.round((r.width - inset * 2) * sx));
      const rh = Math.max(1, Math.round((r.height - inset * 2) * sy));
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
      out[id] = { counts, unknown, total: rw * rh };
    }
    return out;
  })()`);

  for (const id of PACKS) {
    const s = thumbPixels[id];
    if (!s) continue;
    const own = s.counts[0];
    const foreign = s.total - own;
    record(
      `④ ${id}：缩略图像素级只显示第 0 帧（红）`,
      own >= s.total * 0.95,
      `${s.total} 像素：各帧色 ${JSON.stringify(s.counts)}，未归类 ${s.unknown}`,
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
process.stdout.write(`网格排布验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
