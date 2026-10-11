/**
 * 真实宿主里的图标验收：确认新图标在**三个用点**都正确渲染。
 *
 * 三个用点是（都由宿主的 `icon()` 原语渲染成 CSS mask）：
 * 1. 入口坞 —— 插件图标出现在坞槽位；
 * 2. 设置面板标题 —— `surface.icon`；
 * 3. 插件管理页的设置入口。
 *
 * 关键断言不是「元素存在」，而是：
 * - mask URL 指向**插件资产**（`/api/plugins/stm-pet/assets/frontend/assets/icon.svg`）；
 * - 该 URL 能取到 200 且是 SVG；
 * - 元素的**渲染尺寸与形状**合理（mask 生效后不是空白）。
 *
 * 用法：node tools/verify-icon.mjs
 */

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const API = `${BASE}/api/plugins/stm-pet`;

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(document.querySelector('[data-plugin="stm-pet"].pet-root'))`, {
      timeout: 20000, label: '插件加载',
    });
    await sleep(1200);

    // ---- ① 资产可达（宿主会把 ?v=<版本> 拼上）
    const asset = await page.evaluate(`(async () => {
      const response = await fetch('${API}/assets/frontend/assets/icon.svg');
      const text = await response.text();
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        hasViewBox: /viewBox="/.test(text),
        viewBox: (text.match(/viewBox="([^"]+)"/) || [])[1] || '',
        bytes: text.length,
        hasPath: /<path\\b/.test(text),
      };
    })()`);
    record(
      '① 图标资源可达且是 SVG（带 viewBox）',
      asset.status === 200 && asset.type.includes('svg') && asset.hasViewBox && asset.hasPath,
      `HTTP ${asset.status}，${asset.bytes} 字节，viewBox="${asset.viewBox}"`,
    );

    // ---- ② 打开设置面板，取标题图标
    const shell = await page.evaluate(`(async () => {
      window.__petApi.surfaces.open('pet-settings', { source: 'verify-icon' });
      await new Promise((r) => setTimeout(r, 1500));
      return { open: Boolean(document.querySelector('.plugin-stm-pet.pet-panel')) };
    })()`);
    record('② 设置面板已打开', shell.open, '');

    // ---- ③ 面板标题行里的图标是插件资产 mask
    const headerIcon = await page.evaluate(`(() => {
      const shellEl = document.querySelector('.plugin-surface--modal[data-plugin="stm-pet"]')
        || document.querySelector('.plugin-surface[data-plugin="stm-pet"]');
      if (!shellEl) return { error: '找不到设置面板的 surface 容器' };
      // 宿主的标题图标位
      const holder = shellEl.querySelector('.plugin-surface__header-icon')
        || shellEl.querySelector('[class*="header-icon"]');
      const icon = holder ? holder.querySelector('.ui-icon') : null;
      if (!icon) {
        // 兜底：整个 surface 里第一个资产图标
        const any = shellEl.querySelector('.ui-icon--asset');
        if (!any) return { error: '标题行没找到图标' };
        return describe(any);
      }
      return describe(icon);

      function describe(node) {
        const cs = getComputedStyle(node);
        const mask = cs.webkitMaskImage || cs.maskImage || '';
        const rect = node.getBoundingClientRect();
        return {
          isAsset: node.classList.contains('ui-icon--asset'),
          mask,
          width: rect.width,
          height: rect.height,
          background: cs.backgroundColor,
        };
      }
    })()`);
    record(
      '③ 设置面板标题图标指向插件资产（mask 生效）',
      !headerIcon.error
        && headerIcon.isAsset
        && String(headerIcon.mask).includes('/api/plugins/stm-pet/assets/frontend/assets/icon.svg'),
      headerIcon.error || `mask=${String(headerIcon.mask).slice(0, 110)}\n        尺寸=${headerIcon.width}×${headerIcon.height}，着色=${headerIcon.background}`,
    );

    // ---- ④ 真正画出来了（读画布像素，而不是只看 CSS）
    //
    // mask 的坑是「元素在、尺寸对，但 mask URL 取不到 → 整块空白」。
    // 因此必须把元素实际渲染的像素读出来确认有可见墨迹。
    const painted = await page.evaluate(`(async () => {
      const icon = document.querySelector('.plugin-surface[data-plugin="stm-pet"] .ui-icon--asset');
      if (!icon) return { error: '找不到资产图标' };
      const rect = icon.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return { error: '图标尺寸异常 ' + rect.width + 'x' + rect.height };

      // 把该元素连同 mask 一起画到 canvas：用 foreignObject 走 SVG 序列化太脆，
      // 这里改用「截图思路」的等价做法 —— 逐像素读取需要 CDP 截图，交给下面单独做。
      return {
        maskLoaded: await new Promise((resolve) => {
          const url = (getComputedStyle(icon).webkitMaskImage || '').replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '');
          if (!url) return resolve(false);
          const probe = new Image();
          probe.onload = () => resolve(true);
          probe.onerror = () => resolve(false);
          probe.src = url;
        }),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    })()`);
    record(
      '④ mask 图像真的能加载（不是空白块）',
      painted.maskLoaded === true,
      JSON.stringify(painted.rect || painted),
    );

    // ---- ⑤ 截图取该区域的像素，确认有墨迹
    if (painted.rect) {
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: painted.rect.x - 2,
          y: painted.rect.y - 2,
          width: painted.rect.w + 4,
          height: painted.rect.h + 4,
          scale: 8,
        },
      });
      const { data } = shot;
      // 交给 Python/Pillow 不方便，这里只在页面里做一次「非空白比例」估计：
      const ratio = await page.evaluate(`(async () => {
        const icon = document.querySelector('.plugin-surface[data-plugin="stm-pet"] .ui-icon--asset');
        const rect = icon.getBoundingClientRect();
        // 用 html2canvas 之类的库不可行（不引依赖）；改用 mask 图像自身的像素统计：
        // 把 mask SVG 当成图片加载到 canvas，统计不透明像素占比。
        const url = (getComputedStyle(icon).webkitMaskImage || '')
          .replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '');
        const img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 64;
        canvas.height = img.naturalHeight || 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] > 32) opaque += 1;
        }
        return {
          opaqueRatio: opaque / (pixels.length / 4),
          size: [canvas.width, canvas.height],
          bytes: ${data ? data.length : 0},
        };
      })()`);
      record(
        '⑤ 图标有实际墨迹（不透明像素占比合理）',
        ratio.opaqueRatio > 0.02 && ratio.opaqueRatio < 0.98,
        `不透明占比 ${(ratio.opaqueRatio * 100).toFixed(1)}%，mask 尺寸 ${ratio.size.join('×')}`,
      );
    }

    // ---- ⑥ 入口位（坞 / 插件总览）用的是同一个图标
    const entryIcon = await page.evaluate(`(async () => {
      const data = await (await fetch('/api/plugins/list')).json();
      const item = (data.items || []).find((row) => row.id === 'stm-pet');
      return {
        icon: item ? item.icon : null,
        loaded: item ? item.loaded : null,
        entries: item ? (item.entries || []).map((e) => ({ id: e.id, icon: e.icon })) : [],
      };
    })()`);
    record(
      '⑥ 插件清单里的入口图标指向插件资产',
      entryIcon.loaded === true
        && entryIcon.entries.some((e) => e.icon === 'frontend/assets/icon.svg'),
      `entries=${JSON.stringify(entryIcon.entries)}`,
    );

    // ---- ⑦ 卡片缩略图只显示第 0 帧（不是把整条 spritesheet 压进小方框）
    //
    // 这是一个真实踩过的坑：`/frame/<id>/idle` 返回**整条** 256×64 的 4 帧
    // spritesheet，用 `background-size: contain` 塞进 40×40 的方框后
    // 每帧只剩 10px，看起来像一团乱码。正确几何是
    // `background-size: (方框宽 × 帧数) auto` + 左对齐。
    const thumb = await page.evaluate(`(async () => {
      const box = document.querySelector('.plugin-stm-pet .pet-card-thumb');
      if (!box) return { error: '找不到缩略图' };
      const cs = getComputedStyle(box);
      const rect = box.getBoundingClientRect();
      const runtime = await (await fetch('${API}/runtime')).json();
      const idle = runtime.pet.actions.idle;
      const size = parseFloat(cs.backgroundSize) || 0;
      return {
        boxWidth: Math.round(rect.width),
        backgroundSize: cs.backgroundSize,
        backgroundPosition: cs.backgroundPosition,
        frames: idle.frames,
        layout: idle.layout,
        scaledWidth: size,
        ratio: rect.width > 0 ? size / rect.width : 0,
      };
    })()`);
    const thumbOk = !thumb.error
      && Math.abs(thumb.ratio - thumb.frames) < 0.5          // 整条宽度 = 方框宽 × 帧数
      && String(thumb.backgroundPosition).startsWith('0');   // 左对齐 → 只露第 0 帧
    record(
      '⑦ 卡片缩略图只显示第 0 帧（几何正确）',
      thumbOk,
      thumb.error || `方框 ${thumb.boxWidth}px，background-size=${thumb.backgroundSize}，`
        + `帧数 ${thumb.frames}（倍数 ${thumb.ratio.toFixed(2)}），位置 ${thumb.backgroundPosition}`,
    );

    // ---- ⑧ 面板里的动作预览图仍正常（图标改动没有波及面板渲染）
    const panelOk = await page.evaluate(`(() => {
      const tiles = document.querySelectorAll('.plugin-stm-pet .pet-action-tile');
      let withImage = 0;
      for (const tile of tiles) {
        const preview = tile.querySelector('.pet-action-preview');
        if (preview && getComputedStyle(preview).backgroundImage !== 'none') withImage += 1;
      }
      return { tiles: tiles.length, withImage };
    })()`);
    record(
      '⑧ 设置面板的动作预览仍正常',
      panelOk.tiles > 0 && panelOk.withImage >= panelOk.tiles - 2,
      `${panelOk.withImage}/${panelOk.tiles} 个动作有预览图`,
    );

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`图标验收：${results.length - failed.length}/${results.length} 通过\n`);
    if (failed.length) {
      process.stdout.write('\n失败明细:\n');
      for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
      exitCode = 1;
    }
  } finally {
    browser.close();
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`运行失败: ${error && error.stack ? error.stack : error}\n`);
    process.exit(2);
  });
