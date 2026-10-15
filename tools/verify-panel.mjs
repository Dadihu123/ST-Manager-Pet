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
        // ★ 缩放倍数看的是**网格的列数 / 行数**，不是总帧数。
        //
        // 早先这里一律用 frames，于是在网格形象上判错：一个 2×2 的 4 帧
        // 形象，缩略图应当放大到「框宽 × 2」（列）而不是「× 4」（帧数）。
        // 几何本身是对的（data-cols / data-rows 一直在下发），
        // 是**判据**没跟上网格支持——与当初漏掉 vertical 是同一类漏洞。
        // （本段在模板字符串里，注释中不能用反引号。）
        const cols = Number(box.dataset.cols) || frames;
        const rows = Number(box.dataset.rows) || 1;
        const cellW = Number(box.dataset.cellW) || 0;
        const cellH = Number(box.dataset.cellH) || 0;
        out.push({
          id: card.dataset.petId,
          hasImage: Boolean(url),
          frames,
          cols,
          rows,
          cellW,
          cellH,
          // 排布方向：vertical 的整条 sheet 是**竖**的，几何按高度放大
          // （本段在模板字符串里，注释中不能用反引号。）
          layout: box.dataset.layout === 'vertical' ? 'vertical' : 'horizontal',
          bgSize: cs.backgroundSize,
          bgPos: cs.backgroundPosition,
          // 用 clientWidth（内容盒）：JS 里算几何用的就是它。
          // 用 getBoundingClientRect 会算上 1px 边框，差 2px（假失败）。
          boxWidth: box.clientWidth,
          boxHeight: box.clientHeight,
          // ★ 期望几何 = 把**单帧**按 cover 缩放（两个方向都取 max，
          // 于是帧在两个方向都 >= 方框，网格里也不会漏出邻格），
          // 再乘上列数 / 行数得到整条 sheet 的显示尺寸。
          //
          // 早先这里写的是「框宽 × 帧数」，只在「帧比框宽」时成立；
          // 帧是竖构图或网格时都会算错（把正确的实现判成失败）。
          expectedWidth: (() => {
            if (!(cellW > 0 && cellH > 0)) return null;
            const scale = Math.max(box.clientWidth / cellW, box.clientHeight / cellH);
            return cellW * scale * cols;
          })(),
          expectedHeight: (() => {
            if (!(cellW > 0 && cellH > 0)) return null;
            const scale = Math.max(box.clientWidth / cellW, box.clientHeight / cellH);
            return cellH * scale * rows;
          })(),
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

    // 多帧卡片的几何必须按「框尺寸 × 帧数」放大（否则只会露出最左边/最上边的透明边）。
    //
    // ⚠️ 必须**分排布方向**判断：`horizontal` 放大的是宽度、对齐是
    // 「左对齐 + 顶部对齐」（`0% 0%`）；`vertical` 放大的是高度、
    // 对齐是「水平居中 + 顶部对齐」（计算值 `50% 0%`）。
    // 早先这里只按 `0%` 开头判，把竖排形象误判成失败——是**判据**的漏洞，
    // 不是几何的错（竖排形象是合法输入，`layout` 是包级字段）。
    // 多帧卡片的几何必须与「单帧按 cover 缩放后的整条 sheet」一致。
    //
    // ⚠️ 这里必须**同时**校验两个方向：早先只按宽度判（`expectedWidth =
    // 框宽 × 帧数`），在竖构图帧与网格排布上都会算错——那是**判据**的漏洞，
    // 不是几何的错（实现用的是 `cover`，两个方向都取 max，见
    // `applyThumbGeometry` 的注释）。
    const geometryOk = thumbs.filter((item) => item.frames > 1 && item.hasImage)
      .every((item) => {
        const [width, height] = item.bgSize.split(/\s+/).map((v) => parseFloat(v));
        if (item.expectedWidth === null || item.expectedHeight === null) {
          // 拿不到单帧尺寸时只要求「两个方向都 >= 方框」（cover 的下界）
          return Number.isFinite(width) && Number.isFinite(height)
            && width >= item.boxWidth - 2 && height >= item.boxHeight - 2;
        }
        return Number.isFinite(width) && Number.isFinite(height)
          && Math.abs(width - item.expectedWidth) <= 2
          && Math.abs(height - item.expectedHeight) <= 2
          // 帧在两个方向都要盖住方框（否则网格里会漏出邻格）
          && width >= item.boxWidth * item.cols - 2
          && height >= item.boxHeight * item.rows - 2
          // 贴左上角：只露出第 0 帧。
          // ⚠️ 计算值是 `0px 0px`（不是 `0%`），别只认百分号。
          && item.bgPos.startsWith('0');
      });
    record(
      '② 多帧缩略图按「单帧 cover 放大 × 网格列/行数」铺开且贴左上角',
      geometryOk,
      thumbs.map((i) => `${i.id}(${i.layout} ${i.cols}×${i.rows}): ${i.bgSize} @ ${i.bgPos}`
        + ` (期望 ${i.expectedWidth?.toFixed(1)}×${i.expectedHeight?.toFixed(1)}, frames=${i.frames})`).join('；'),
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
        // 把「按几何算出的那一帧」画到 canvas 上，数非透明像素。
        // ⚠️ 切帧要看**网格列数 / 行数**，不是总帧数：网格形象的帧是
        // 「几列几行」铺开的，按 width/frames 切会拿到一条跨越几帧的窄带。
        // 竖排（1 列 N 行）是网格的特例，同一套算法就够。
        // （本段在模板字符串里，注释中不能用反引号。）
        const frames = Number(box.dataset.frames) || 1;
        const cols = Number(box.dataset.cols) || frames;
        const rows = Number(box.dataset.rows) || 1;
        const blob = await (await fetch(url, { cache: 'no-store' })).blob();
        const bmp = await createImageBitmap(blob);
        const frameW = Math.max(1, Math.round(bmp.width / cols));
        const frameH = Math.max(1, Math.round(bmp.height / rows));
        const canvas = document.createElement('canvas');
        canvas.width = frameW; canvas.height = frameH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
        const data = ctx.getImageData(0, 0, frameW, frameH).data;
        let ink = 0;
        for (let at = 3; at < data.length; at += 4 * 97) {
          if (data[at] > 16) ink += 1;
        }
        out.push({
          id: card.dataset.petId,
          frameW,
          frameH,
          ink,
          total: Math.ceil(data.length / (4 * 97)),
        });
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
    //
    // ⚠️ 背景图与帧位移现在都在**内层**（`.pet-preview-frame-layer`）上，
    // 不在外框 `.pet-preview-box` 上。原因见 ⑥ 的说明：按比例装入会留白，
    // 铺在外框上时留白处会露出相邻的帧。因此这里一律读内层。
    const previewPresent = await page.evaluate(`(() => {
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const layer = box ? box.querySelector('.pet-preview-frame-layer') : null;
      const picker = [...document.querySelectorAll('.plugin-stm-pet [data-preview-action]')];
      return {
        hasBox: Boolean(box),
        hasLayer: Boolean(layer),
        actions: picker.map((node) => node.dataset.previewAction),
        bg: layer ? getComputedStyle(layer).backgroundImage.slice(0, 60) : '',
      };
    })()`);
    record(
      '④ 设置页有动画预览区，且列出**全部**动作（含内置形象）',
      previewPresent.hasBox && previewPresent.hasLayer
        && previewPresent.actions.length >= 10 && previewPresent.bg.includes('/frame/'),
      `动作按钮 ${previewPresent.actions.length} 个: ${previewPresent.actions.join(',')}`,
    );

    // 预览器真的在推进帧（不是一张静止图）
    const previewFrames = await page.evaluate(`(async () => {
      const layer = () => document.querySelector(
        '.plugin-stm-pet .pet-preview-box .pet-preview-frame-layer',
      );
      const seen = new Set();
      const start = performance.now();
      while (performance.now() - start < 3000) {
        seen.add(getComputedStyle(layer()).backgroundPosition);
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
      const layer = () => document.querySelector(
        '.plugin-stm-pet .pet-preview-box .pet-preview-frame-layer',
      );
      const seen = new Set();
      const start = performance.now();
      while (performance.now() - start < 900) {
        seen.add(getComputedStyle(layer()).backgroundPosition);
        await new Promise((r) => setTimeout(r, 40));
      }
      const name = document.querySelector('.plugin-stm-pet .pet-preview-name');
      const frame = document.querySelector('.plugin-stm-pet [data-preview-frame]');
      // 一次性动作播完应当**停在末帧**，而不是无限循环
      await new Promise((r) => setTimeout(r, 700));
      const settled = getComputedStyle(layer()).backgroundPosition;
      const settledAgain = await (async () => {
        await new Promise((r) => setTimeout(r, 500));
        return getComputedStyle(layer()).backgroundPosition;
      })();
      return {
        name: name ? name.textContent : '',
        frame: frame ? frame.textContent : '',
        distinct: seen.size,
        bg: getComputedStyle(layer()).backgroundImage,
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
      const layer = () => document.querySelector(
        '.plugin-stm-pet .pet-preview-box .pet-preview-frame-layer',
      );
      const seen = new Set();
      const start = performance.now();
      while (performance.now() - start < 900) {
        seen.add(getComputedStyle(layer()).backgroundPosition);
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
        const layer = document.querySelector(
          '.plugin-stm-pet .pet-preview-box .pet-preview-frame-layer',
        );
        out.secondBg = getComputedStyle(layer).backgroundImage;
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
      const layer = box ? box.querySelector('.pet-preview-frame-layer') : null;
      const badge = document.querySelector('.plugin-stm-pet .pet-badge.is-builtin');
      const hasThumb = Boolean(target.querySelector('.pet-card-thumb'));
      return {
        petId: target.dataset.petId,
        builtinBadge: Boolean(badge),
        hasPreview: Boolean(box) && Boolean(layer),
        bg: layer ? getComputedStyle(layer).backgroundImage.slice(0, 60) : '',
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

    // ================================================== ⑥ 预览框按比例自适应
    //
    // 用户报障：「预览动画框应该根据动作的比例来自动变化……否则看起来会很奇怪
    // （点名小卡的睡觉动作）」。
    //
    // 这里直接量**真实渲染结果**：横构图的动作在正方框里必须
    // 「宽度用满、高度按比例缩短、底边贴框底」，而不是被拉满整个框。
    //
    // ⚠️ 背景铺在**内层**（`.pet-preview-frame-layer`）上，不是外框上。
    // 铺在外框上时，按比例装入留下的空白会露出**相邻的帧**（实测能看到
    // 左边缘飘着一个「z」、右边缘挂着半个人影）。内层只有一帧大小，
    // 邻帧被它自己的盒子裁住。因此这里量的是内层。
    //
    // ⚠️ 参照系必须是 `clientWidth/clientHeight`（**内边距盒**），不是
    // `getBoundingClientRect()`。预览框有 1px 边框，而 `background-position`
    // 是相对内边距盒计算的——用 rect 会比真实值多出 2px，把正确的实现判成失败。
    const aspect = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      // 小卡有横构图的睡觉动作，优先用它
      const target = cards.find((c) => c.dataset.petId === 'xiaoka') || cards[0];
      target.click();
      await new Promise((r) => setTimeout(r, 1200));
      const pick = document.querySelector('.plugin-stm-pet [data-preview-action="sleep"]');
      if (!pick) return { error: '没有睡觉动作按钮' };
      pick.click();
      await new Promise((r) => setTimeout(r, 600));
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const layer = box.querySelector('.pet-preview-frame-layer');
      if (!layer) return { error: '预览框里没有内层（背景会露出邻帧）' };
      const cs = getComputedStyle(layer);
      const size = cs.backgroundSize.split(/\\s+/).map((v) => parseFloat(v));
      // 帧数从帧读数里取（"第 1 / 4 帧" / "单帧"）——不能假设睡觉是单帧
      const readout = document.querySelector('.plugin-stm-pet [data-preview-frame]');
      const text = readout ? readout.textContent : '';
      const match = /\\/\\s*(\\d+)\\s*帧/.exec(text);
      const frames = match ? Number(match[1]) : 1;
      const layerRect = layer.getBoundingClientRect();
      // ★ 单帧尺寸要按**这张图真实的排布**算（background-size 里的
      // 「整条宽 × 整条高」除以列数 / 行数）。
      //
      // ⚠️ 不能假设横排。小卡的睡觉动作声明的是 "layout": "vertical"
      // （4 行 1 列），按「整条宽 ÷ 帧数」算会得到 41.5 而真实是 166，
      // 于是正确的实现被判成失败——这个坑踩过一次（同一段里早先漏掉
      // vertical 也是同一类）。
      //
      // 判据改成「用 background-size 反推列/行，再与内层尺寸对齐」：
      // 内层就是**单帧**的显示尺寸，因此 size[0]/frameW 与 size[1]/frameH
      // 必须都是整数（列数与行数）。
      // （本段在模板字符串里，注释中不能用反引号。）
      const colsGuess = Math.max(1, Math.round(size[0] / layerRect.width));
      const rowsGuess = Math.max(1, Math.round(size[1] / layerRect.height));
      const boxRect = box.getBoundingClientRect();
      return {
        petId: target.dataset.petId,
        readout: text,
        frames,
        boxW: box.clientWidth,
        boxH: box.clientHeight,
        // 内层的实际渲染尺寸 = 单帧的显示尺寸
        frameW: layerRect.width,
        frameH: layerRect.height,
        // 内层的底边相对外框内边距盒底部的余量
        bottomGap: boxRect.bottom - layerRect.bottom,
        sheetW: size[0],
        sheetH: size[1],
        cols: colsGuess,
        rows: rowsGuess,
        // ★ 背景图必须真的在**内层**上（而不是外框）。
        // 只量内层尺寸是不够的：把背景挪回外框时，内层尺寸照样是对的，
        // 但留白处又会露出邻帧——所以必须同时断言「谁带着背景图」。
        layerHasBg: cs.backgroundImage.includes('/frame/'),
        boxHasBg: getComputedStyle(box).backgroundImage.includes('/frame/'),
      };
    })()`);
    const sleepRatio = aspect.frameW / aspect.frameH;
    // 正方形框
    const isSquare = Math.abs(aspect.boxW - aspect.boxH) <= 1.5;
    // 内层不能比外框大（否则会被裁掉内容）
    const fitsBox = aspect.frameW <= aspect.boxW + 1.5 && aspect.frameH <= aspect.boxH + 1.5;
    // 底边贴框底（允许 1px 边框误差）
    const bottomAligned = Math.abs(aspect.bottomGap) <= 2;
    record(
      '⑥ 预览框是正方形，横构图动作按比例装进去（不压扁、底边对齐）',
      !aspect.error && isSquare && sleepRatio > 1 && fitsBox && bottomAligned,
      aspect.error || `框 ${aspect.boxW}×${aspect.boxH}，${aspect.frames} 帧，单帧 `
      + `${aspect.frameW?.toFixed(1)}×${aspect.frameH?.toFixed(1)}`
      + `（比例 ${sleepRatio?.toFixed(2)}，横构图），底边余量 ${aspect.bottomGap?.toFixed(2)}`,
    );
    record(
      '⑥ 背景铺在「一帧大小」的内层上（留白处不会露出邻帧）',
      !aspect.error
        // 内层尺寸 == 整条 sheet 按**真实排布**切出来的单帧尺寸
        // （列数 / 行数由 background-size 与内层尺寸反推，见上面的注释）
        && Math.abs((aspect.sheetW / aspect.cols) - aspect.frameW) <= 1.5
        && Math.abs((aspect.sheetH / aspect.rows) - aspect.frameH) <= 1.5
        // 切出来的格子数要能装下这些帧（不能比帧数少）
        && aspect.cols * aspect.rows >= aspect.frames
        // 背景必须在**内层**上，而不是外框上
        && aspect.layerHasBg && !aspect.boxHasBg,
      `内层 ${aspect.frameW?.toFixed(1)}×${aspect.frameH?.toFixed(1)}，`
      + `整条 ${aspect.sheetW?.toFixed(1)}×${aspect.sheetH?.toFixed(1)}`
      + `（${aspect.cols} 列 × ${aspect.rows} 行 / ${aspect.frames} 帧）；`
      + `背景在内层=${aspect.layerHasBg} 在外框=${aspect.boxHasBg}`,
    );

    // 竖构图动作必须受高度限制（用满框高），证明是按比例而不是固定拉伸
    const portrait = await page.evaluate(`(async () => {
      const pick = document.querySelector('.plugin-stm-pet [data-preview-action="idle"]');
      if (!pick) return { error: '没有待机动作按钮' };
      pick.click();
      await new Promise((r) => setTimeout(r, 600));
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      const layer = box.querySelector('.pet-preview-frame-layer');
      if (!layer) return { error: '没有内层' };
      const r = layer.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      return {
        frameW: r.width,
        frameH: r.height,
        boxW: box.clientWidth,
        boxH: box.clientHeight,
        bottomGap: boxRect.bottom - r.bottom,
      };
    })()`);
    const portraitRatio = portrait.frameW / portrait.frameH;
    record(
      '⑥ 竖构图动作用满框高（说明是按各自比例缩放，不是固定拉伸）',
      !portrait.error
        && Math.abs(portrait.frameH - portrait.boxH) <= 1.5
        && Math.abs(portrait.bottomGap) <= 2
        && portraitRatio < 1,
      portrait.error
        || `帧 ${portrait.frameW?.toFixed(1)}×${portrait.frameH?.toFixed(1)}`
        + `（比例 ${portraitRatio?.toFixed(2)}，竖构图），框 ${portrait.boxW}×${portrait.boxH}`,
    );

    // ================================================== ⑦ 左侧选中态跟随
    //
    // 用户报障：「插件页面选中某个形象时，右侧已经发生了变化，但是左侧选中态
    // 却不跟着走，始终选中的是当前使用中的形象」。
    const selection = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      if (cards.length < 2) return { error: '形象不足两个' };
      const active = cards.find((c) => c.classList.contains('is-active'));
      // 找一个**不是**当前使用中的卡片点它
      const target = cards.find((c) => !c.classList.contains('is-active'));
      target.click();
      await new Promise((r) => setTimeout(r, 1200));
      const after = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const selected = after.filter((c) => c.classList.contains('is-selected'));
      const stillActive = after.filter((c) => c.classList.contains('is-active'));
      const sel = selected[0];
      const cs = sel ? getComputedStyle(sel) : null;
      const activeCard = stillActive[0];
      const activeCs = activeCard ? getComputedStyle(activeCard) : null;
      return {
        activeId: active ? active.dataset.petId : '',
        clickedId: target.dataset.petId,
        selectedCount: selected.length,
        selectedId: sel ? sel.dataset.petId : '',
        activeStill: activeCard ? activeCard.dataset.petId : '',
        // 选中态必须真的**看得见**（不只是类名挂上了）
        selShadow: cs ? cs.boxShadow : '',
        selBorder: cs ? cs.borderTopColor : '',
        activeShadow: activeCs ? activeCs.boxShadow : '',
        // 「当前使用中」的文字标记仍在原来那张卡上
        currentMeta: (() => {
          const node = document.querySelector('.plugin-stm-pet .pet-card-meta.is-current');
          return node ? node.closest('.pet-card').dataset.petId : '';
        })(),
      };
    })()`);
    record(
      '⑦ 点左侧卡片后选中态跟着走（不再固定在"当前使用中"那张）',
      selection.selectedCount === 1
        && selection.selectedId === selection.clickedId
        && selection.clickedId !== selection.activeId,
      `点的是 ${selection.clickedId}，选中态在 ${selection.selectedId}，`
      + `使用中仍是 ${selection.activeStill}`,
    );
    record(
      '⑦ 选中态真的可见（有样式，不只是挂了个类名）',
      Boolean(selection.selShadow) && selection.selShadow !== 'none'
        && selection.selShadow !== selection.activeShadow,
      `选中态 box-shadow="${selection.selShadow}"，使用中 box-shadow="${selection.activeShadow}"`,
    );
    record(
      '⑦「当前使用中」的文字标记仍跟着 activeId（两种状态不混）',
      selection.currentMeta === selection.activeId && selection.activeId !== '',
      `标记在 ${selection.currentMeta}，activeId=${selection.activeId}`,
    );

    // ================================================== ⑧ 滑块可直接输入数字
    //
    // 用户报障：「通过拖拽有时难以精确调整，请同步支持直接选择数字部分
    // 进行输入修改，只要限制好输入数据的范围即可」。
    const numberInput = await page.evaluate(`(async () => {
      const box = document.querySelector('.plugin-stm-pet .pet-slider-number');
      if (!box) return { error: '没有数字输入框' };
      const before = { value: box.value, type: box.type, min: box.min, max: box.max };
      const slider = box.closest('.pet-slider-row')?.querySelector('.pet-slider');
      const sliderBefore = slider ? slider.value : '';
      // 直接输入一个合法值 + 回车
      box.value = '2.5';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const after = document.querySelector('.plugin-stm-pet .pet-slider-number');
      const sliderAfter = after.closest('.pet-slider-row')?.querySelector('.pet-slider');
      return {
        before, sliderBefore,
        value: after.value,
        sliderValue: sliderAfter ? sliderAfter.value : '',
        // 进度变量要跟着更新（色带靠它画）
        progress: sliderAfter ? sliderAfter.style.getPropertyValue('--pet-slider-progress') : '',
      };
    })()`);
    record(
      '⑧ 数字框能直接输入并生效（滑块跟着走）',
      !numberInput.error && numberInput.value === '2.5' && numberInput.sliderValue === '2.5',
      JSON.stringify(numberInput),
    );
    record(
      '⑧ 数字框带 min/max/step 约束（输入范围被限制住）',
      !numberInput.error && numberInput.before.type === 'number'
        && Number(numberInput.before.min) > 0 && Number(numberInput.before.max) > 0,
      `type=${numberInput.before?.type} min=${numberInput.before?.min} max=${numberInput.before?.max}`,
    );
    record(
      '⑧ 滑块色带进度变量被写入（与宿主预设编辑器同一手法）',
      Boolean(numberInput.progress) && numberInput.progress.endsWith('%'),
      `--pet-slider-progress=${numberInput.progress}`,
    );

    // 超范围输入要被夹住（用户要求「只要限制好输入数据的范围即可」）
    const clampCheck = await page.evaluate(`(async () => {
      const box = document.querySelector('.plugin-stm-pet .pet-slider-number');
      if (!box) return { error: '没有数字输入框' };
      const max = Number(box.max);
      box.value = '9999';
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const after = document.querySelector('.plugin-stm-pet .pet-slider-number');
      const slider = after.closest('.pet-slider-row')?.querySelector('.pet-slider');
      return { max, shown: after.value, sliderValue: slider ? slider.value : '' };
    })()`);
    record(
      '⑧ 超范围输入被夹到上限（显示值与实际值一致）',
      !clampCheck.error && Number(clampCheck.shown) === clampCheck.max
        && Number(clampCheck.sliderValue) === clampCheck.max,
      `上限 ${clampCheck.max}，显示 ${clampCheck.shown}，滑块 ${clampCheck.sliderValue}`,
    );

    // 触发时间的两个滑块也要有数字框
    const scheduleNumbers = await page.evaluate(`(() => {
      const sliders = [...document.querySelectorAll('.plugin-stm-pet [data-schedule-behavior]')];
      return sliders.map((s) => {
        const row = s.closest('.pet-slider-row');
        const num = row ? row.querySelector('.pet-slider-number') : null;
        return {
          behavior: s.dataset.scheduleBehavior,
          bound: s.dataset.scheduleBound,
          hasNumber: Boolean(num),
          numberValue: num ? num.value : '',
          sliderValue: s.value,
        };
      });
    })()`);
    record(
      '⑧ 触发时间的每个滑块都配了数字框（值初始一致）',
      scheduleNumbers.length >= 4
        && scheduleNumbers.every((i) => i.hasNumber && i.numberValue === i.sliderValue),
      scheduleNumbers.map((i) => `${i.behavior}.${i.bound}=${i.numberValue}`).join(' '),
    );

    // 数字框的验证会**真的改掉**倍率（那是要提交后端的），
    // 因此收尾时必须还原——验收脚本不该留下副作用。
    const restored = await page.evaluate(`(async () => {
      const box = document.querySelector('.plugin-stm-pet .pet-slider-number');
      if (!box) return { error: '没有数字输入框' };
      box.value = '1';
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const after = document.querySelector('.plugin-stm-pet .pet-slider-number');
      return { value: after.value };
    })()`);
    record(
      '⑧ 验收结束后倍率已还原（脚本不留副作用）',
      restored.value === '1',
      `倍率回到 ${restored.value}`,
    );

    // ================================================== ⑨ 动作网格的预览图
    //
    // 真实 bug（靠截图看出来的）：动作网格里每一格都**只有文字、没有图**。
    // `renderActionTile()` 写了 `data-frames` / `data-layout` / `data-has-image`，
    // 但 `applyThumbGeometry()` 只查 `.pet-card-thumb` —— 小图停在
    // `background-size: auto`，只露出整条 spritesheet 左上角的 56×56 一块
    // （在 1536×576 的 idle 上正好是空白区域）。
    const tiles = await page.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('.plugin-stm-pet .pet-action-preview')];
      return nodes.map((node) => {
        const cs = getComputedStyle(node);
        const frames = Number(node.dataset.frames) || 1;
        // ★ 单帧尺寸看的是**网格列数 / 行数**与单帧比例，不是总帧数。
        // 按帧数除会得到「跨越几帧的窄带」，把正确的实现判成失败。
        const cols = Number(node.dataset.cols) || frames;
        const rows = Number(node.dataset.rows) || 1;
        const cellW = Number(node.dataset.cellW) || 0;
        const cellH = Number(node.dataset.cellH) || 0;
        const parts = cs.backgroundSize.split(/\\s+/).map((v) => parseFloat(v));
        const boxW = node.clientWidth;
        const boxH = node.clientHeight;
        let frameW = 0;
        let frameH = 0;
        if (Number.isFinite(parts[0])) frameW = parts[0] / cols;
        if (Number.isFinite(parts[1])) frameH = parts[1] / rows;
        // cover 缩放下的期望值（与 applyThumbGeometry 同一套规则）
        let expectedW = null;
        if (cellW > 0 && cellH > 0) {
          const scale = Math.max(boxW / cellW, boxH / cellH);
          expectedW = cellW * scale;
        }
        return {
          frames,
          cols,
          rows,
          hasImage: node.dataset.hasImage === 'true',
          bgSize: cs.backgroundSize,
          width: boxW,
          height: boxH,
          // 单帧显示尺寸（整条除以列/行）
          frameWidth: frameW,
          frameHeight: frameH,
          expectedFrameW: expectedW,
        };
      });
    })()`);
    const withImage = tiles.filter((t) => t.hasImage);
    // ⚠️ 单帧与**动图容器**合法地用 `contain`（它们没有可切的格子，
    // 整张图就是那一帧）。只对**多帧**的小图要求 cover 几何。
    const multiFrame = withImage.filter((t) => t.frames > 1);
    record(
      '⑨ 动作网格每一格都真的画了图（不是只剩文字）',
      withImage.length >= 10
        && withImage.every((t) => t.bgSize !== 'auto'
          && (t.frames <= 1 ? t.bgSize === 'contain' : t.frameWidth > 0)),
      `${withImage.length} 格有图（其中多帧 ${multiFrame.length} 格）；尺寸样本 `
      + withImage.slice(0, 3).map((t) => `${t.frames}帧(${t.cols}×${t.rows})=${t.bgSize}`).join(' / '),
    );
    record(
      '⑨ 多帧小图按「单帧 cover 放大」铺开（帧盖住方框，只露第 0 帧）',
      multiFrame.length > 0 && multiFrame.every((t) => {
        // 帧必须盖住方框（两个方向都 >=），否则会露出邻格
        if (!(t.frameWidth >= t.width - 2 && t.frameHeight >= t.height - 2)) return false;
        // 有单帧尺寸时，帧宽要等于 cover 缩放的结果
        if (t.expectedFrameW !== null) {
          return Math.abs(t.frameWidth - t.expectedFrameW) <= 2;
        }
        return true;
      }),
      multiFrame.slice(0, 4)
        .map((t) => `${t.width}px 框 → 单帧 ${t.frameWidth.toFixed(1)}×${t.frameHeight.toFixed(1)}`
          + (t.expectedFrameW !== null ? `（期望宽 ${t.expectedFrameW.toFixed(1)}）` : ''))
        .join('；'),
    );
    // 源图本身有内容（这一条**不**校验几何——它直接读 spritesheet 的第 0 帧，
    // 与 `background-size` 无关。几何由上一条负责）。
    const tileInk = await page.evaluate(`(async () => {
      const node = document.querySelector('.plugin-stm-pet .pet-action-preview[data-has-image="true"]');
      if (!node) return { error: '没有带图的动作小图' };
      const cs = getComputedStyle(node);
      const url = cs.backgroundImage.replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '');
      const frames = Number(node.dataset.frames) || 1;
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
      return { frameW, ink, total: Math.ceil(data.length / (4 * 97)) };
    })()`);
    record(
      '⑨ 动作小图的源图第 0 帧确实有内容（不校验几何，几何看上一条）',
      !tileInk.error && tileInk.ink > 0,
      tileInk.error || `第 0 帧 ${tileInk.frameW}px 宽，不透明采样 ${tileInk.ink}/${tileInk.total}`,
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
