/**
 * 真实浏览器验收：形象列表缩略图 + 设置页动画预览（本轮第 2 / 4 项）。
 *
 *   node tools/verify-panel.mjs
 *
 * 全部断言基于**真实渲染结果**（读 computed style / 元素尺寸 / 播放中的帧位），
 * 不做源码字符串检查——那些在 pytest 里做过了。
 */

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
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
      await window.__petApi.surfaces.open('pet-settings', { source: 'verify-panel' });
      return true;
    })()`);
    await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
      timeout: 15000, label: '形象列表出现',
    });
    await sleep(1500);

    // ================================================== ② 每张卡片都有缩略图
    //
    // 用户报障：「小满在角色列表中没有形象展示，小卡是有的」。
    // 判定：**每一张**卡片的缩略图都要有正确的几何，
    // 并且真的把图渲染出来了（不只是「设了个 background-image」）。
    const thumbs = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const out = [];
      for (const card of cards) {
        const box = card.querySelector('.pet-card-thumb');
        if (!box) { out.push({ id: card.dataset.petId, missing: true }); continue; }
        const cs = getComputedStyle(box);
        const url = cs.backgroundImage.replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '');
        const frames = Number(box.dataset.frames) || 1;
        out.push({
          id: card.dataset.petId,
          hasImage: Boolean(url),
          frames,
          bgSize: cs.backgroundSize,
          bgPos: cs.backgroundPosition,
          // 用 clientWidth（内容盒）：JS 里算几何用的就是它。
          // 用 getBoundingClientRect 会算上 1px 边框，差 2px（假失败）。
          boxWidth: box.clientWidth,
          expectedWidth: Math.round(box.clientWidth * frames),
        });
      }
      return out;
    })()`);

    const allHaveImages = thumbs.length > 0 && thumbs.every((item) => item.hasImage);
    record(
      '② 列表里**每一张**卡片都有缩略图',
      allHaveImages,
      JSON.stringify(thumbs),
    );

    // 多帧卡片的几何必须按「框宽 × 帧数」放大（否则只会露出最左边的透明边）
    const geometryOk = thumbs.filter((item) => item.frames > 1).every((item) => {
      const width = parseFloat(item.bgSize);
      return Number.isFinite(width)
        && Math.abs(width - item.expectedWidth) <= 2
        && item.bgPos.startsWith('0%') ;
    });
    record(
      '② 多帧缩略图按「框宽 × 帧数」放大且左对齐（不再只剩透明边）',
      geometryOk,
      thumbs.map((i) => `${i.id}: ${i.bgSize} @ ${i.bgPos} (frames=${i.frames})`).join('；'),
    );

    // 真实像素：截图缩略图区域，确认**不是**整片空白
    const pixelCheck = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const out = [];
      for (const card of cards) {
        const box = card.querySelector('.pet-card-thumb');
        if (!box) continue;
        const cs = getComputedStyle(box);
        const url = cs.backgroundImage.replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '');
        if (!url) { out.push({ id: card.dataset.petId, ink: 0, error: 'no url' }); continue; }
        // 把「按几何算出的那一帧」画到 canvas 上，数非透明像素
        const frames = Number(box.dataset.frames) || 1;
        const blob = await (await fetch(url, { cache: 'no-store' })).blob();
        const bmp = await createImageBitmap(blob);
        const frameW = Math.round(bmp.width / frames);
        const canvas = document.createElement('canvas');
        canvas.width = frameW; canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0, frameW, bmp.height, 0, 0, frameW, bmp.height);
        const data = ctx.getImageData(0, 0, frameW, bmp.height).data;
        let ink = 0;
        for (let at = 3; at < data.length; at += 4 * 97) {
          if (data[at] > 16) ink += 1;
        }
        out.push({ id: card.dataset.petId, frameW, ink, total: Math.ceil(data.length / (4 * 97)) });
      }
      return out;
    })()`);
    const inkOk = pixelCheck.length > 0 && pixelCheck.every((item) => item.ink > 0);
    record(
      '② 第 0 帧真的有内容（不是透明边）',
      inkOk,
      pixelCheck.map((i) => `${i.id}: 不透明采样 ${i.ink}/${i.total}`).join('；'),
    );

    // ================================================== ④ 动画预览器
    const previewPresent = await page.evaluate(`(() => {
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const picker = [...document.querySelectorAll('.plugin-stm-pet [data-preview-action]')];
      return {
        hasBox: Boolean(box),
        actions: picker.map((node) => node.dataset.previewAction),
        bg: box ? getComputedStyle(box).backgroundImage.slice(0, 60) : '',
      };
    })()`);
    record(
      '④ 设置页有动画预览区，且列出**全部**动作（含内置形象）',
      previewPresent.hasBox && previewPresent.actions.length >= 10
        && previewPresent.bg.includes('/frame/'),
      `动作按钮 ${previewPresent.actions.length} 个: ${previewPresent.actions.join(',')}`,
    );

    // 预览器真的在推进帧（不是一张静止图）
    const previewFrames = await page.evaluate(`(async () => {
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const seen = new Set();
      const start = performance.now();
      while (performance.now() - start < 3000) {
        seen.add(getComputedStyle(box).backgroundPosition);
        await new Promise((r) => setTimeout(r, 120));
      }
      return { distinct: seen.size, samples: [...seen].slice(0, 5) };
    })()`);
    record(
      '④ 预览器在推进帧（3 秒内 background-position 变化）',
      previewFrames.distinct >= 2,
      `观察到 ${previewFrames.distinct} 个帧位: ${previewFrames.samples.join(' | ')}`,
    );

    // 点一个**平时等不到**的动作（click / land），确认能播。
    //
    // 注意 `click` 是 `loop: false`（一轮约 460ms），因此必须**点完立刻采样**：
    // 先等一会儿再采样的话它早就播完停在末帧了，会误判成「没在播」。
    const clickPlay = await page.evaluate(`(async () => {
      const node = document.querySelector('.plugin-stm-pet [data-preview-action="click"]');
      if (!node) return { error: 'no click button' };
      node.click();
      // 点击处理里是同步 render()，返回时新 DOM 已就位、播放器已开播
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const seen = new Set();
      const start = performance.now();
      while (performance.now() - start < 900) {
        seen.add(getComputedStyle(box).backgroundPosition);
        await new Promise((r) => setTimeout(r, 40));
      }
      const name = document.querySelector('.plugin-stm-pet .pet-preview-name');
      const frame = document.querySelector('.plugin-stm-pet [data-preview-frame]');
      // 一次性动作播完应当**停在末帧**，而不是无限循环
      await new Promise((r) => setTimeout(r, 700));
      const settled = getComputedStyle(
        document.querySelector('.plugin-stm-pet .pet-preview-box'),
      ).backgroundPosition;
      const settledAgain = await (async () => {
        await new Promise((r) => setTimeout(r, 500));
        return getComputedStyle(
          document.querySelector('.plugin-stm-pet .pet-preview-box'),
        ).backgroundPosition;
      })();
      return {
        name: name ? name.textContent : '',
        frame: frame ? frame.textContent : '',
        distinct: seen.size,
        bg: getComputedStyle(document.querySelector('.plugin-stm-pet .pet-preview-box')).backgroundImage,
        settled,
        settledAgain,
      };
    })()`);
    record(
      '④ 点「被点击」即可在设置页播放（click 平时几乎等不到）',
      clickPlay.name === '被点击' && clickPlay.distinct >= 2 && clickPlay.bg.includes('/click'),
      JSON.stringify(clickPlay),
    );
    record(
      '④ 一次性动作（click）播完停在末帧，不会无限循环',
      clickPlay.settled === clickPlay.settledAgain,
      `末帧位置 ${clickPlay.settled}，0.5 秒后 ${clickPlay.settledAgain}`,
    );

    // 重播：一次性动作也要能再看一遍
    const replay = await page.evaluate(`(async () => {
      const buttons = [...document.querySelectorAll('.plugin-stm-pet .pet-button')];
      const node = buttons.find((b) => b.textContent === '重播');
      if (!node) return { error: 'no replay button' };
      node.click();
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const seen = new Set();
      const start = performance.now();
      while (performance.now() - start < 900) {
        seen.add(getComputedStyle(box).backgroundPosition);
        await new Promise((r) => setTimeout(r, 40));
      }
      return { distinct: seen.size };
    })()`);
    record(
      '④ 「重播」能再播一遍一次性动作',
      replay.distinct >= 2,
      `重播后观察到 ${replay.distinct} 个帧位`,
    );

    // 变体切换：idle 有两套动画，面板上要能切
    const variantUi = await page.evaluate(`(async () => {
      const idle = document.querySelector('.plugin-stm-pet [data-preview-action="idle"]');
      if (!idle) return { error: 'no idle button' };
      idle.click();
      await new Promise((r) => setTimeout(r, 800));
      const buttons = [...document.querySelectorAll('.plugin-stm-pet [data-preview-variant]')];
      const out = { count: buttons.length, labels: buttons.map((n) => n.textContent) };
      if (buttons[1]) {
        buttons[1].click();
        await new Promise((r) => setTimeout(r, 800));
        const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
        out.secondBg = getComputedStyle(box).backgroundImage;
      }
      return out;
    })()`);
    record(
      '④ idle 的两套动画可在面板上切换',
      variantUi.count >= 2 && (variantUi.secondBg || '').includes('vi=1'),
      JSON.stringify(variantUi),
    );

    // 播放 / 暂停
    const toggle = await page.evaluate(`(async () => {
      const node = document.querySelector('.plugin-stm-pet [data-preview-toggle]');
      if (!node) return { error: 'no toggle' };
      const before = node.textContent;
      node.click();
      await new Promise((r) => setTimeout(r, 400));
      const after = document.querySelector('.plugin-stm-pet [data-preview-toggle]');
      return { before, after: after ? after.textContent : '' };
    })()`);
    record(
      '④ 播放 / 暂停按钮状态会切换',
      toggle.before !== toggle.after,
      JSON.stringify(toggle),
    );

    // 内置形象只读，但预览必须可用（这是本项的关键诉求）
    const builtinPreview = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const target = cards.find((c) => c.dataset.petId === 'xiaoman') || cards[0];
      target.click();
      await new Promise((r) => setTimeout(r, 1200));
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const badge = document.querySelector('.plugin-stm-pet .pet-badge.is-builtin');
      const hasThumb = Boolean(target.querySelector('.pet-card-thumb'));
      return {
        petId: target.dataset.petId,
        builtinBadge: Boolean(badge),
        hasPreview: Boolean(box),
        bg: box ? getComputedStyle(box).backgroundImage.slice(0, 60) : '',
        hasThumb,
      };
    })()`);
    record(
      '④ 内置形象（只读）同样能预览动画',
      builtinPreview.builtinBadge && builtinPreview.hasPreview
        && builtinPreview.bg.includes('/frame/') && builtinPreview.hasThumb,
      JSON.stringify(builtinPreview),
    );

    // ================================================== 无控制台错误
    const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
    record(
      '⑤ 运行期无未捕获异常 / 错误日志',
      relevant.length === 0,
      relevant.slice(0, 4).join('\n        '),
    );

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`面板验收：${results.length - failed.length}/${results.length} 通过\n`);
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
