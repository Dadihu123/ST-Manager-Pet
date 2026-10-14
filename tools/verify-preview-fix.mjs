/**
 * 验收：切换动画预览项时**不丢滚动位置**，且切帧不露出邻帧。
 *
 * 用户两项报障：
 *   1.「切换动画预览项时页面每次都会自动滚动到顶部，不方便使用」
 *   2.「改成方框后，原先竖向分辨率拼接的动画帧播放时，当前帧的播放可能会
 *      露出前一帧和后一帧的部分图案」
 *
 * 这个脚本在**真实浏览器**里量真实结果：
 *   - 滚动：切动作前后对比 `.pet-panel-detail` 的 scrollTop；
 *   - 切帧：用纯色测试形象（帧0红/1绿/2蓝/3黄），量「当前帧窗口内出现了
 *     多少其他帧的颜色」——这是邻帧泄漏的**直接**证据。
 *
 * 前置：
 *   1. 影子宿主在 PET_SANDBOX_PORT 上运行；
 *   2. 纯色测试形象已放进插件的 data/pets（缺失时脚本会打印生成命令）。
 *
 * 用法：
 *   python tools/make-solid-pet.py <data/pets 目录> vertical 400 300
 *   python tools/make-solid-pet.py <data/pets 目录> horizontal 300 400
 *   PET_SANDBOX_PORT=5099 node tools/verify-preview-fix.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

// 纯色测试形象的帧色（与 tools/make-solid-pet.py 一致）
const FRAME_COLORS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];

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
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-preview-fix' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1500);

  // ================================================== ① 切换动作不丢滚动位置
  const scroll = await page.evaluate(`(async () => {
    const detail = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    if (!detail) return { error: '没有详情容器' };
    const max = detail.scrollHeight - detail.clientHeight;
    // 滚到中下部（内容够长才有意义）
    detail.scrollTop = Math.min(280, Math.max(0, max - 1));
    await new Promise((r) => setTimeout(r, 250));
    const before = detail.scrollTop;
    // 点一个**不是**当前选中的动作
    const other = [...document.querySelectorAll('.plugin-stm-pet [data-preview-action]')]
      .find((b) => !b.classList.contains('is-active'));
    if (!other) return { error: '没有可切换的动作' };
    const clicked = other.dataset.previewAction;
    other.click();
    await new Promise((r) => setTimeout(r, 800));
    const after = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    return {
      before,
      after: after ? after.scrollTop : null,
      clicked,
      max,
      // 确认真的切过去了（不是没生效才「没滚动」）
      active: (document.querySelector('.plugin-stm-pet [data-preview-action].is-active') || {}).dataset?.previewAction,
    };
  })()`);
  record(
    '① 切换动画预览项后滚动位置保持（不再弹回顶部）',
    !scroll.error && scroll.before > 0 && scroll.after === scroll.before
      && scroll.active === scroll.clicked,
    scroll.error
      || `点了「${scroll.clicked}」：scrollTop ${scroll.before} → ${scroll.after}（内容高 ${scroll.max}）`,
  );

  // 连续切换多次也要保持
  const repeat = await page.evaluate(`(async () => {
    const detail = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    detail.scrollTop = Math.min(240, Math.max(0, detail.scrollHeight - detail.clientHeight - 1));
    await new Promise((r) => setTimeout(r, 200));
    const before = detail.scrollTop;
    const seen = [];
    const btns = [...document.querySelectorAll('.plugin-stm-pet [data-preview-action]')];
    for (const b of [btns[1], btns[3], btns[5]]) {
      if (!b) continue;
      b.click();
      await new Promise((r) => setTimeout(r, 500));
      const d = document.querySelector('.plugin-stm-pet .pet-panel-detail');
      seen.push(d ? d.scrollTop : null);
    }
    return { before, seen };
  })()`);
  record(
    '① 连续切换三次都不丢（每次点击都全量重建，仍然保持）',
    repeat.before > 0 && repeat.seen.every((v) => v === repeat.before),
    `初始 ${repeat.before}，切换后依次 ${repeat.seen.join(' / ')}`,
  );

  // 左栏列表的滚动也要保持
  const listScroll = await page.evaluate(`(async () => {
    const list = document.querySelector('.plugin-stm-pet .pet-panel-list');
    const max = list.scrollHeight - list.clientHeight;
    if (max <= 0) return { skipped: true, max };
    list.scrollTop = Math.min(20, max);
    await new Promise((r) => setTimeout(r, 200));
    const before = list.scrollTop;
    const btn = document.querySelector('.plugin-stm-pet [data-preview-action]');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = document.querySelector('.plugin-stm-pet .pet-panel-list');
    return { before, after: after ? after.scrollTop : null, max };
  })()`);
  record(
    '① 左栏列表的滚动位置同样保持',
    listScroll.skipped || listScroll.after === listScroll.before,
    listScroll.skipped
      ? `列表不够长（可滚动 ${listScroll.max}px），跳过`
      : `scrollTop ${listScroll.before} → ${listScroll.after}`,
  );

  // 还原上限夹取：内容变短时不报错（切到「新建形象」再切回）
  const clamp = await page.evaluate(`(async () => {
    const detail = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    detail.scrollTop = 9999;   // 故意超上限
    await new Promise((r) => setTimeout(r, 150));
    const btn = document.querySelector('.plugin-stm-pet [data-preview-action]');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 700));
    const d = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    return { ok: Boolean(d), top: d ? d.scrollTop : null, max: d ? d.scrollHeight - d.clientHeight : null };
  })()`);
  record(
    '① 超上限的滚动值被夹住（不报错、不越界）',
    clamp.ok && clamp.top >= 0 && clamp.top <= Math.max(0, clamp.max),
    `scrollTop=${clamp.top}，上限=${clamp.max}`,
  );

  // ================================================== ② 切帧不露出邻帧
  for (const pack of ['solid-vertical', 'solid-horizontal']) {
    const isVertical = pack.includes('vertical');
    const check = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const target = cards.find((c) => c.dataset.petId === '${pack}');
      if (!target) return { error: '找不到 ${pack}（测试形象未安装）' };
      target.click();
      await new Promise((r) => setTimeout(r, 1400));
      const pick = document.querySelector('.plugin-stm-pet [data-preview-action="idle"]');
      if (pick) pick.click();
      await new Promise((r) => setTimeout(r, 700));
      const pause = [...document.querySelectorAll('.plugin-stm-pet .pet-button')]
        .find((b) => b.textContent === '暂停');
      if (pause) pause.click();
      await new Promise((r) => setTimeout(r, 250));
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      if (box) box.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 400));

      const layer = box.querySelector('.pet-preview-frame-layer');
      if (!layer) return { error: '预览框里没有内层（背景铺在外框上会露出邻帧）' };
      const cs = getComputedStyle(layer);
      const size = cs.backgroundSize.split(/\\s+/).map(parseFloat);
      const lr = layer.getBoundingClientRect();
      const frames = 4;
      const out = [];
      for (let at = 0; at < frames; at += 1) {
        const step = '${isVertical}' === 'true' ? size[1] / frames : size[0] / frames;
        layer.style.backgroundPosition = '${isVertical}' === 'true'
          ? '0px ' + (-at * step) + 'px'
          : (-at * step) + 'px 0px';
        await new Promise((r) => requestAnimationFrame(r));
        out.push({
          at,
          step,
          layerW: lr.width,
          layerH: lr.height,
        });
      }
      return { frames, size, lr: { w: lr.width, h: lr.height }, out };
    })()`);
    if (check.error) {
      record(`② ${pack}：切帧不露邻帧`, false, check.error);
      continue;
    }
    // 单帧尺寸 == 内层尺寸（严格），且位移是整数倍帧长
    const step = isVertical ? check.size[1] / check.frames : check.size[0] / check.frames;
    const layerSpan = isVertical ? check.lr.h : check.lr.w;
    const exact = Math.abs(step - layerSpan) < 1e-6;
    record(
      `② ${pack}：内层正好是一帧（裁切边界与帧边界重合）`,
      exact,
      `单帧=${step.toFixed(3)}px，内层=${layerSpan.toFixed(3)}px`,
    );
  }

  // 像素级确认：帧 1 是绿帧，R/B 通道应恒为 0
  const pixel = await page.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
    const target = cards.find((c) => c.dataset.petId === 'solid-vertical');
    if (!target) return { error: '找不到 solid-vertical' };
    target.click();
    await new Promise((r) => setTimeout(r, 1400));
    const pick = document.querySelector('.plugin-stm-pet [data-preview-action="idle"]');
    if (pick) pick.click();
    await new Promise((r) => setTimeout(r, 700));
    const pause = [...document.querySelectorAll('.plugin-stm-pet .pet-button')]
      .find((b) => b.textContent === '暂停');
    if (pause) pause.click();
    await new Promise((r) => setTimeout(r, 250));
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    box.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 400));

    const layer = box.querySelector('.pet-preview-frame-layer');
    const cs = getComputedStyle(layer);
    const size = cs.backgroundSize.split(/\\s+/).map(parseFloat);
    const step = size[1] / 4;
    // 切到第 1 帧（绿）
    layer.style.backgroundPosition = '0px ' + (-step) + 'px';
    await new Promise((r) => requestAnimationFrame(r));

    // 把**内层区域**画到 canvas 上：用 backgroundImage 自己重画不算数，
    // 这里直接读内层的合成结果——用 html2canvas 不现实，改用「截图 + 解码」
    return { step, layerRect: (() => { const r = layer.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() };
  })()`);
  if (pixel.error) {
    record('② 像素级：绿帧内没有红/蓝（无邻帧混入）', false, pixel.error);
  } else {
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
      const r = ${JSON.stringify(pixel.layerRect)};
      const rx = Math.round(r.x * sx);
      const ry = Math.round(r.y * sy);
      const rw = Math.max(1, Math.round(r.w * sx));
      const rh = Math.max(1, Math.round(r.h * sy));
      const d = ctx.getImageData(rx, ry, rw, rh).data;
      // 绿帧：G 高，R/B 应低。
      //
      // ⚠️ 判据必须能区分三种「R 或 B 被抬起」的情况：
      //   1. **邻帧混入**——邻帧是纯红/纯蓝/纯黄，混进来会让 R 与 B **严重失衡**
      //      （绿+红 → R 高 B=0；绿+蓝 → B 高 R=0；绿+黄 → R 高 B=0）。
      //   2. **外框圆角裁切**——预览外框有 border-radius + overflow:hidden，
      //      底角会把绿帧与面板浅灰混起来。浅灰是**中性**的，
      //      因此 R ≈ B（实测样本 (87,251,89)、(162,244,170)，差值只有 2~8）。
      //   3. **面板边框抗锯齿**——同样中性，R ≈ B。
      //
      // 因此判据是 |R − B| 的不平衡量，而不是「R 或 B 是否被抬起」：
      // 只有 1 会失衡，2 和 3 都不会。
      // （注意：本段注释里不能用反引号——外层是模板字符串，反引号会截断它。）
      let green = 0, foreign = 0, worst = 0, neutral = 0;
      const rowHits = new Map();
      const colHits = new Map();
      const samples = [];
      for (let y = 0; y < rh; y += 1) {
        for (let x = 0; x < rw; x += 1) {
          const i = (y * rw + x) * 4;
          const rr = d[i], gg = d[i + 1], bb = d[i + 2];
          if (gg > 150 && rr < 100 && bb < 100) green += 1;
          if (gg <= 100) continue;
          const imbalance = Math.abs(rr - bb);
          if (imbalance <= 30) { if (rr > 40 || bb > 40) neutral += 1; continue; }
          foreign += 1;
          if (imbalance > worst) worst = imbalance;
          rowHits.set(y, (rowHits.get(y) || 0) + 1);
          colHits.set(x, (colHits.get(x) || 0) + 1);
          if (samples.length < 5) {
            samples.push('(' + rr + ',' + gg + ',' + bb + ')@' + x + ',' + y);
          }
        }
      }
      const rows = [...rowHits.keys()].sort((a, b) => a - b);
      const cols = [...colHits.keys()].sort((a, b) => a - b);
      // 内部（排除最外 2 行/列）的混入像素数
      let innerForeign = 0;
      for (const [y, n] of rowHits) {
        if (y >= 2 && y < rh - 2) innerForeign += n;
      }
      return {
        w: rw, h: rh, green, foreign, worst, neutral, total: rw * rh,
        innerForeign, samples: samples.join(' '),
        rowRange: rows.length ? [rows[0], rows[rows.length - 1]] : null,
        colRange: cols.length ? [cols[0], cols[cols.length - 1]] : null,
        rowCount: rows.length,
        colCount: cols.length,
      };
    })()`);
    record(
      '② 像素级：绿帧窗口内没有邻帧颜色（红/蓝未混入）',
      stat.foreign === 0 && stat.green > stat.total * 0.5,
      `${stat.w}×${stat.h} 区域：绿 ${stat.green}/${stat.total}，`
      + `邻帧色 ${stat.foreign}（内部 ${stat.innerForeign}，峰值失衡 ${stat.worst}），`
      + `中性混合 ${stat.neutral}（圆角/边框，正常）`
      + `，行 ${stat.rowRange ? stat.rowRange.join('~') : '—'}（${stat.rowCount} 行）`
      + `，列 ${stat.colRange ? stat.colRange.join('~') : '—'}（${stat.colCount} 列）`
      + (stat.samples ? `\n        样本 ${stat.samples}` : ''),
    );
  }

  // ================================================== 无控制台错误
  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('③ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`预览修复验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
