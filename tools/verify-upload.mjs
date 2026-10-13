/**
 * 形象管理链的真实验收：上传自己的图 → 生效 → 重启后仍在。
 *
 * 这是阶段 5 的判定标准，也是「宿主保证插件更新时保留 data/」这条契约的实测。
 *
 * 两条上传路径**都要测**（它们走的是不同代码）：
 * - 直接调 API（后台/脚本路径）；
 * - 走设置面板的**真实文件输入**（用户路径）——用 CDP 的 `DOM.setFileInputFiles`
 *   把真实文件塞进 `<input type=file>`，这样连「面板有没有把上传接对」也一起测了。
 *
 * 前置：影子宿主已装好 stm-pet 并在 PET_SANDBOX_PORT 上运行。
 *   node tools/verify-upload.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const API = `${BASE}/api/plugins/stm-pet`;

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

/** 取 URL 的版本参数（内容变了它就该变）。 */
function versionOf(url) {
  const match = /\?v=([^&"]*)/.exec(String(url || ''));
  return match ? match[1] : '';
}

/** PNG 用的 CRC32。 */
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value;
    }
  }
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[index]) & 0xff];
  }
  return crc ^ -1;
}

/**
 * 手写一张最小 PNG（64×64，橙色底 + 右上角青色方块）。
 *
 * 自己拼 PNG 而不是引图像库：仓库不新增依赖（§1.1）。
 * 用于 `DOM.setFileInputFiles` —— 那条路径需要**磁盘上的真实文件**。
 */
function writeTestPng(target) {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      const inSquare = x >= 32 && y < 32;
      // 右上角青色方块，其余橙色 —— 与内置形象（真人立绘）明显不同
      raw[offset] = inSquare ? 0 : 255;
      raw[offset + 1] = inSquare ? 200 : 120;
      raw[offset + 2] = inSquare ? 200 : 0;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(target, png);
  return target;
}

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
  const tmpPng = path.join(os.tmpdir(), 'pet-verify-custom.png');
  writeTestPng(tmpPng);
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('DOM.enable');

    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(document.querySelector('[data-plugin="stm-pet"].pet-root'))`, {
      timeout: 20000, label: '宠物挂载',
    });
    await sleep(600);

    // ---- 准备一个**可写**的目标形象
    //
    // 插件自带的形象现在是严格只读的（用户要求），所以「换图 / 恢复 / 删除覆盖」
    // 这一整条链必须在**用户自建**的形象上验。这里用新建接口造一个，
    // 它同时也就是「用户能自己新建宠物」这条诉求的实证。
    const target = await page.evaluate(`(async () => {
      // 造一条 **2 帧**的水平 sheet（128×64 = 2 × 64px）。
      //
      // 必须是多帧：单帧形象的 rAF 循环会**正确地**停下来（省电设计），
      // 那样后面 ⑮「宠物仍在活动」就无法用帧位变化来判定，
      // 会把一个正确的省电行为误报成故障。
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff7722';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#ffaa55';
      ctx.fillRect(64, 0, 64, 64);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));

      const form = new FormData();
      form.append('name', '验收目标形象');
      form.append('idle', blob, 'idle.png');
      // 字段名就是动作名。行走只有方向化动作（walk-left / walk-right），
      // 正面 walk 已退役，传它只会得到一个词表外的动作。
      // （注意：这段注释里不能用反引号，它会提前结束外层模板字符串。）
      form.append('walk-left', blob, 'walk-left.png');
      form.append('meta', JSON.stringify({
        idle: { frames: 2, fps: 8 }, 'walk-left': { frames: 2, fps: 8 },
      }));
      const response = await fetch('${API}/pets/create', { method: 'POST', body: form });
      const body = await response.json();
      if (!body.success) return { error: body.msg || '新建失败' };
      return {
        id: body.pet.id,
        writable: body.pet.writable,
        source: body.pet.source,
        idleFrames: body.pet.actions.idle.frames,
      };
    })()`);
    const TARGET = target.id || '';
    record(
      '⓪ 新建一个用户形象作为可写目标（自带形象只读）',
      Boolean(TARGET) && target.writable === true && target.source === 'user'
        && target.idleFrames === 2,
      JSON.stringify(target),
    );

    // ---- 基线
    const before = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/runtime')).json();
      const idle = data.pet.actions.idle;
      return { url: idle.url, frameSource: idle.frameSource, petId: data.activePetId };
    })()`);
    const beforeVersion = versionOf(before.url);
    record(
      '⓪b 新建后它自动成为当前形象',
      before.petId === TARGET,
      `activePetId=${before.petId}，期望 ${TARGET}`,
    );

    // ---- ① 打开设置面板
    const panelOpened = await page.evaluate(`(async () => {
      const api = window.__petApi;
      if (!api) return { error: '插件没有暴露 api（验收脚本需要它）' };
      api.surfaces.open('pet-settings', { source: 'verify-upload' });
      await new Promise((r) => setTimeout(r, 1200));
      return {
        open: Boolean(document.querySelector('.plugin-stm-pet.pet-panel')),
        tiles: document.querySelectorAll('.plugin-stm-pet .pet-action-tile').length,
      };
    })()`);
    record(
      '① 设置面板能打开并渲染动作网格',
      Boolean(panelOpened && panelOpened.open && panelOpened.tiles > 0),
      JSON.stringify(panelOpened),
    );

    // ---- ② 点「换图」→ 用 CDP 塞入真实文件（用户路径）
    //
    // ⚠️ 这里**必须**同时断言「可见性」，不能只断言「存在」。
    // 第一版只查 `Boolean(window.__capturedInput)`，于是漏掉了一个真实 bug：
    // 文件输入挂在 `document.body` 下，而 `plugin.css` 的隐藏规则是**作用域内**
    // 选择器（`.plugin-stm-pet .pet-file-input`），匹配不到 body 下的裸 input →
    // 原生「选择文件 / 未选择任何文件」控件堆在页面底部，每点一次多一条。
    // 断言「存在」时它照样 PASS，所以脚本 15/15 全绿而用户能看见它。
    const uploadInfo = await page.evaluate(`(async () => {
      const tile = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-action-tile'))
        .find((node) => (node.querySelector('.pet-action-name') || {}).textContent === '待机');
      if (!tile) return { error: '找不到 idle（待机）动作卡片' };
      const button = Array.from(tile.querySelectorAll('button'))
        .find((node) => node.textContent.includes('换图'));
      if (!button) return { error: '找不到「换图」按钮' };
      window.__capturedInput = null;
      const original = document.body.appendChild.bind(document.body);
      document.body.appendChild = (node) => {
        if (node && node.tagName === 'INPUT' && node.type === 'file') {
          window.__capturedInput = node;
        }
        return original(node);
      };
      button.click();
      await new Promise((r) => setTimeout(r, 250));
      document.body.appendChild = original;
      const input = window.__capturedInput;
      if (!input) return { found: false };
      // 可见性核对：原生控件一旦可见就会占据布局并显示文字
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      const visible = rect.width > 4 && rect.height > 4 && style.opacity !== '0'
        && style.visibility !== 'hidden' && style.display !== 'none';
      return {
        found: true,
        visible,
        rect: [Math.round(rect.width), Math.round(rect.height)],
        opacity: style.opacity,
        position: style.position,
        ariaHidden: input.getAttribute('aria-hidden'),
      };
    })()`);
    record(
      '② 点「换图」会创建文件输入，且它**不可见**（不是只「存在」）',
      Boolean(uploadInfo && uploadInfo.found && uploadInfo.visible === false),
      JSON.stringify(uploadInfo),
    );

    let filesSet = false;
    if (uploadInfo && uploadInfo.found) {
      const { root } = await page.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await page.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'body > input[type=file]',
      });
      if (nodeId) {
        await page.send('DOM.setFileInputFiles', { nodeId, files: [tmpPng] });
        filesSet = true;
        // CDP 设置文件会触发 change 事件，等面板走完上传
        await sleep(3000);
      }
    }
    record('③ CDP 把真实文件交给文件输入并触发面板上传', filesSet, '');

    // ---- ④ 覆盖生效
    const afterPanel = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/runtime')).json();
      const idle = data.pet.actions.idle;
      return { url: idle.url, frameSource: idle.frameSource, overrides: data.pet.overrides };
    })()`);
    record(
      '④ 面板上传后覆盖生效（frameSource=override，内容版本变化）',
      afterPanel.frameSource === 'override' && versionOf(afterPanel.url) !== beforeVersion,
      `source: ${before.frameSource} → ${afterPanel.frameSource}，version: ${beforeVersion} → ${versionOf(afterPanel.url)}`,
    );

    // ---- ⑤ 帧路由返回的确实是新图（采样右上角该是青色）
    //
    // 用 `<img>` + `decode()` 取像素，**不要**省掉 `decode()`——
    // 第一版忘了等解码完成就 `drawImage`，画布是空的，
    // 读出全 0（透明黑）并被误判成「上传坏了」。
    //
    // 另外要**绕过浏览器缓存**：这个路由对不带 `?v=` 的请求会回源校验，
    // 但浏览器里仍可能命中上一次的响应。加 `cache: 'no-store'` 排除干扰。
    const pixel = await page.evaluate(`(async () => {
      const response = await fetch('${API}/frame/${TARGET}/idle', { cache: 'no-store' });
      const blob = await response.blob();
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const at = (x, y) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      return {
        corner: at(48, 8),   // 上传图的右上角 → 应为青色
        other: at(8, 48),    // 左下角 → 应为橙色
        size: [img.naturalWidth, img.naturalHeight],
        alpha: at(32, 32)[3],
      };
    })()`);
    record(
      '⑤ 帧路由返回新上传的图（像素核对：右上青、左下橙）',
      pixel.corner[2] > 150 && pixel.corner[0] < 80 && pixel.other[0] > 200
        && pixel.alpha === 255,
      `右上 rgb=${JSON.stringify(pixel.corner)}，左下 rgb=${JSON.stringify(pixel.other)}，尺寸=${JSON.stringify(pixel.size)}`,
    );

    // ---- ⑥ 第二个动作（行走）也走**面板**上传
    //
    // 必须走面板而不是直接 `fetch`：面板上传会通知插件重建视图，
    // 而直接调 API 插件并不知情（那属于「后台改图」，不是用户路径）。
    // 这一步与 ⑦ 配合，验证「用户换图 → 运行中的宠物立刻用上」。
    //
    // 另外必须给**两个**最常用的动作都换图：宠物会自己漫游
    // （在 idle 与行走之间切换），只覆盖 idle 的话，
    // 采样时它可能正在走，断言就会失效。
    //
    // 行走用 `walk-left`（标签「向左走」）：正面 `walk` 已退役，
    // 面板里只有方向化的左右两项。
    const walkPanel = await page.evaluate(`(async () => {
      window.__petApi.surfaces.open('pet-settings', { source: 'verify-upload' });
      await new Promise((r) => setTimeout(r, 1200));
      const tile = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-action-tile'))
        .find((node) => (node.querySelector('.pet-action-name') || {}).textContent === '向左走');
      if (!tile) return { error: '找不到 walk-left（向左走）动作卡片' };
      const button = Array.from(tile.querySelectorAll('button'))
        .find((node) => node.textContent.includes('换图'));
      if (!button) return { error: '找不到「换图」按钮' };
      window.__capturedWalkInput = null;
      const original = document.body.appendChild.bind(document.body);
      document.body.appendChild = (node) => {
        if (node && node.tagName === 'INPUT' && node.type === 'file') {
          window.__capturedWalkInput = node;
        }
        return original(node);
      };
      button.click();
      await new Promise((r) => setTimeout(r, 250));
      document.body.appendChild = original;
      return { found: Boolean(window.__capturedWalkInput) };
    })()`);
    record(
      '⑥ 「向左走」动作也通过面板换图',
      Boolean(walkPanel && walkPanel.found),
      JSON.stringify(walkPanel),
    );

    if (walkPanel && walkPanel.found) {
      const { root: docRoot } = await page.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await page.send('DOM.querySelector', {
        nodeId: docRoot.nodeId,
        selector: 'body > input[type=file]',
      });
      if (nodeId) {
        await page.send('DOM.setFileInputFiles', { nodeId, files: [tmpPng] });
        await sleep(3000);
      }
    }

    const spriteCheck = await page.evaluate(`(async () => {
      const root = document.querySelector('[data-plugin="stm-pet"].pet-root');
      const sprite = root.querySelector('.pet-sprite');
      const action = root.dataset.petAction || 'idle';
      const data = await (await fetch('${API}/runtime')).json();
      const entry = data.pet.actions[action] || data.pet.actions.idle;
      // ⚠️ 静止时 sprite 画的是**标准图像**（data.pet.still），而不是
      // actions.idle 的图。两者在作者只给一套 idle 时是同一张，
      // 但覆盖走的路不同（标准图像回落自 idle 时会跟随 idle 的覆盖）。
      // 因此这里按「当前实际显示的是哪一份」去比对。
      const still = data.pet.still || {};
      const idleOverridden = (data.pet.overrides || []).includes('idle');
      const expected = (action === 'idle' && still.url && still.declared !== true
        && idleOverridden) ? still : entry;
      return {
        action,
        overrides: data.pet.overrides,
        stillUrl: still.url || '',
        stillSource: still.frameSource || '',
        spriteUrl: getComputedStyle(sprite).backgroundImage,
        expectedUrl: expected.url,
        expectedSource: expected.frameSource,
      };
    })()`);
    const spriteVersion = versionOf(spriteCheck.spriteUrl);
    const expectedVersion = versionOf(spriteCheck.expectedUrl);
    record(
      '⑦ 运行中的宠物立刻用上新图（sprite 版本与后端一致，且来自覆盖）',
      spriteVersion !== '' && spriteVersion === expectedVersion
        && spriteCheck.expectedSource === 'override'
        && (spriteCheck.overrides || []).length >= 2,
      `当前动作=${spriteCheck.action}，来源=${spriteCheck.expectedSource}，覆盖=${JSON.stringify(spriteCheck.overrides)}，sprite v=${spriteVersion}，后端 v=${expectedVersion}`,
    );

    // ---- ⑦ 刷新页面后仍是新形象（持久化）
    await page.evaluate(`(() => { try { window.__petApi.surfaces.close('pet-settings'); } catch (e) {} return true; })()`);
    await sleep(300);
    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(document.querySelector('[data-plugin="stm-pet"].pet-root'))`, {
      timeout: 20000, label: '刷新后宠物挂载',
    });
    await sleep(1200);
    const afterReload = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/runtime')).json();
      const root = document.querySelector('[data-plugin="stm-pet"].pet-root');
      const sprite = root.querySelector('.pet-sprite');
      const action = root.dataset.petAction || 'idle';
      const entry = data.pet.actions[action] || data.pet.actions.idle;
      // 与 ⑦ 同理：静止时显示的是**标准图像**
      const still = data.pet.still || {};
      const expected = (action === 'idle' && still.url && still.declared !== true)
        ? still : entry;
      return {
        overrides: data.pet.overrides,
        idleSource: data.pet.actions.idle.frameSource,
        walkSource: data.pet.actions['walk-left'].frameSource,
        stillSource: still.frameSource || '',
        action,
        spriteUrl: getComputedStyle(sprite).backgroundImage,
        expectedUrl: expected.url,
      };
    })()`);
    record(
      '⑧ 刷新页面后覆盖仍在（idle + walk-left 都持久化，sprite 与后端版本一致）',
      afterReload.idleSource === 'override' && afterReload.walkSource === 'override'
        && versionOf(afterReload.spriteUrl) === versionOf(afterReload.expectedUrl),
      `overrides=${JSON.stringify(afterReload.overrides)}，idle=${afterReload.idleSource}，walk-left=${afterReload.walkSource}，标准图像=${afterReload.stillSource}，版本一致=${versionOf(afterReload.spriteUrl) === versionOf(afterReload.expectedUrl)}`,
    );

    // ---- ⑨ 预览接口标出「已自定」
    const preview = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/pets/${TARGET}/preview')).json();
      const idle = data.actions.find((item) => item.action === 'idle');
      return { overridden: idle.overridden, frameSource: idle.frameSource };
    })()`);
    record(
      '⑨ 预览接口标出「已自定」',
      preview.overridden === true && preview.frameSource === 'override',
      JSON.stringify(preview),
    );

    // ---- ⑩ 删除覆盖 → 回落包内原图
    const cleared = await page.evaluate(`(async () => {
      const idle = await fetch('${API}/pets/${TARGET}/actions/idle', { method: 'DELETE' });
      const idleData = await idle.json();
      // 顺带清掉 walk-left 的覆盖，让这次验收**不留下痕迹**（可重复运行）
      const walk = await fetch('${API}/pets/${TARGET}/actions/walk-left', { method: 'DELETE' });
      const walkData = await walk.json();
      return {
        success: idleData.success,
        removed: idleData.removed,
        source: idleData.pet.actions.idle.frameSource,
        walkRemoved: walkData.removed,
      };
    })()`);
    record(
      // 目标是**用户自建**形象，因此删掉覆盖后回落到 `pack`（包内自带）。
      // `builtin` 只会出现在插件自带的形象上，而那些形象现在根本不接受覆盖。
      '⑩ 删除覆盖后回落到包内原图（两个动作都清理，验收可重复运行）',
      cleared.removed === true && cleared.source === 'pack' && cleared.walkRemoved === true,
      JSON.stringify(cleared),
    );

    // ---- ⑪ 导入非法 zip → 结构化错误
    const imported = await page.evaluate(`(async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1,2,3,4,5])], { type: 'application/zip' }), 'bad.zip');
      const response = await fetch('${API}/pets/import', { method: 'POST', body: form });
      return { status: response.status, body: await response.json() };
    })()`);
    record(
      '⑪ 导入非法 zip 返回结构化错误（不暴露堆栈）',
      imported.status === 400 && imported.body.success === false
        && !JSON.stringify(imported.body).includes('Traceback'),
      `status=${imported.status}，error=${imported.body.error}，hint=${Boolean(imported.body.hint)}`,
    );

    // ---- ⑪ 伪造扩展名
    const fake = await page.evaluate(`(async () => {
      const form = new FormData();
      form.append('file', new Blob(['%PDF-1.4 fake content'], { type: 'image/png' }), 'evil.png');
      const response = await fetch('${API}/pets/${TARGET}/actions/walk-left', {
        method: 'POST', body: form,
      });
      return { status: response.status, body: await response.json() };
    })()`);
    record(
      '⑫ 伪造扩展名（PDF 冒充 PNG）被拒绝，错误可读',
      fake.status === 400 && fake.body.error === 'unsupported_format' && Boolean(fake.body.hint),
      `error=${fake.body.error}，msg=${String(fake.body.msg).slice(0, 60)}`,
    );

    // ---- ⑫ 超大尺寸图
    const huge = await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 5000; canvas.height = 5000;
      canvas.getContext('2d').fillRect(0, 0, 5000, 5000);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const form = new FormData();
      form.append('file', blob, 'huge.png');
      const response = await fetch('${API}/pets/${TARGET}/actions/walk-left', {
        method: 'POST', body: form,
      });
      return { status: response.status, body: await response.json(), bytes: blob.size };
    })()`);
    record(
      '⑬ 超大尺寸图被拒绝（解码炸弹防护）',
      huge.status === 400 && Boolean(huge.body.error) && !JSON.stringify(huge.body).includes('Traceback'),
      `status=${huge.status}，error=${huge.body.error}，上传体积=${huge.bytes}`,
    );

    // ---- ⑬ 路径穿越（动作名）
    const traversal = await page.evaluate(`(async () => {
      const response = await fetch('${API}/pets/${TARGET}/actions/' + encodeURIComponent('../evil'), {
        method: 'DELETE',
      });
      return { status: response.status };
    })()`);
    record(
      '⑭ 动作名里的路径穿越被拒绝',
      traversal.status === 400 || traversal.status === 404,
      `status=${traversal.status}`,
    );

    // ---- ⑮ 宠物在所有这些操作后仍然活着
    //
    // ⚠️ 采样**不能只取两点**。第一版是「隔 800ms 采两次，要求不同」，
    // 这在 2 帧动画上会**碰运气**：动画周期恰好是采样间隔的整数倍时，
    // 两次落在同一帧上，于是一个完全正常的宠物被误报成「卡住不动」。
    // （实测就是这样：⑮ 时好时坏，而产品一直是对的。）
    // 改为多采几次、要求出现 ≥2 个不同帧位。
    //
    // ⚠️ 2026-10 起还要**主动触发一次**：`idle` 默认是「平时静止 + 随机触发」
    // （见 README §3.7），触发间隔 6~18 秒，而这里只采样约 1.6 秒——
    // 不触发就永远只看到一个帧位，会把正确的新行为误报成故障。
    const alive = await page.evaluate(`(async () => {
      const root = document.querySelector('[data-plugin="stm-pet"].pet-root');
      if (!root) return { alive: false };
      const view = window.__petView;
      const poked = view ? view.pokeIdle() : false;
      const samples = [];
      for (let i = 0; i < 10; i += 1) {
        samples.push(getComputedStyle(root.querySelector('.pet-sprite')).backgroundPosition);
        await new Promise((r) => setTimeout(r, 160));
      }
      return {
        alive: true,
        poked,
        distinct: new Set(samples).size,
        action: root.dataset.petAction,
        throttle: root.dataset.petThrottle || '',
      };
    })()`);
    record(
      '⑮ 历经上传/删除/非法输入后宠物仍正常活动（帧位在变化）',
      alive.alive && alive.distinct >= 2,
      `不同帧位=${alive.distinct}，pokeIdle=${alive.poked}，action=${alive.action}，throttle=${alive.throttle}`,
    );

    // ---- ⑯ 「取消」也要回收文件输入（用户报障的直接机制）
    //
    // 用户点「取消」时浏览器**只派发 `cancel`、不派发 `change`**，
    // 只监听 change 会让 input 永久留在 DOM 里 → 每点一次多一条
    // 「选择文件 / 未选择任何文件」，刷新页面才消失。
    //
    // 这条断言与 ② 的可见性断言互补：② 保证「看得见的是零」，
    // 这里保证「攒下来的也是零」。两者都缺一不可 ——
    // 旧脚本只断言「存在」，所以 15/15 全绿却漏掉了这个 bug。
    //
    // ⚠️ 计数只能数**宠物插件自己的** `input.pet-file-input`。
    // 宿主页面本身就有二十来个静态文件输入（卡片导入 / 头像 / 世界书 /
    // 美化资源 / 预设…），它们由宿主自己的非作用域 CSS 正确隐藏，与本 bug 无关。
    // 第一版断言写成 `after === 0`，于是把宿主的输入全部计入而必然失败
    // （实测 `before: 24, after: 24` —— 数量其实纹丝不动，说明并没有泄漏）。
    //
    // 同时必须记录**峰值**以证明「创建确实发生过」：只断言「最终等于基线」的话，
    // 万一 pickFile 压根没被调用（按钮改名、面板没渲染），测试会假绿。
    const leak = await page.evaluate(`(async () => {
      const panelApi = window.__petApi;
      panelApi.surfaces.open('pet-settings', { source: 'verify-upload' });
      await new Promise((r) => setTimeout(r, 1200));

      // 插件自己的（应被回收）
      const mine = () => document.querySelectorAll('body input.pet-file-input').length;
      // 全页面的（用来证明没误删宿主自己的输入）
      const all = () => document.querySelectorAll('body input[type=file]').length;

      const baselineMine = mine();
      const baselineAll = all();
      let peakMine = baselineMine;
      let sawButton = true;

      // 连点三次「导入形象包」再全部取消：走的是真实的 cancel 路径
      for (let round = 0; round < 3; round += 1) {
        const button = Array.from(
          document.querySelectorAll('.plugin-stm-pet .pet-panel-toolbar button'),
        ).find((node) => node.textContent.includes('导入形象包'));
        if (!button) { sawButton = false; break; }
        button.click();
        await new Promise((r) => setTimeout(r, 150));
        peakMine = Math.max(peakMine, mine());
        // 用户按取消：Chromium 会派发 cancel；这里同时派发以模拟真实行为，
        // 并触发 window focus 兜底（两条回收路径都覆盖到）
        for (const input of document.querySelectorAll('body input.pet-file-input')) {
          input.dispatchEvent(new Event('cancel', { bubbles: false }));
        }
        window.dispatchEvent(new Event('focus'));
        await new Promise((r) => setTimeout(r, 200));
      }

      // 再等一拍，让 focus 兜底里的 setTimeout(0) 跑完
      await new Promise((r) => setTimeout(r, 300));

      return {
        sawButton,
        baselineMine, peakMine, afterMine: mine(),
        baselineAll, afterAll: all(),
      };
    })()`);
    record(
      '⑯ 连续三次「导入 → 取消」：每次确实创建，取消后零残留（无 DOM 泄漏）',
      Boolean(
        leak && leak.sawButton
        && leak.peakMine > leak.baselineMine      // 创建真的发生了
        && leak.afterMine === leak.baselineMine   // 全部被回收
        && leak.afterAll === leak.baselineAll,    // 宿主自己的输入没被误删
      ),
      JSON.stringify(leak),
    );

    // ---- ⑰ 内置形象严格只读（后端拒绝 + 面板不渲染编辑控件）
    //
    // 用户要求「插件自带的宠物不应该允许用户修改」。这条**必须**从两个层面验：
    // ① 接口层真的拒绝（不能只靠 UI 藏按钮 —— 接口是公开的）；
    // ② 面板上确实没有「换图 / 删除 / 导出」控件（不让用户点了才发现不行）。
    const readonly = await page.evaluate(`(async () => {
      // ① 接口层：**必须**指向插件自带的形象，
      //    而不是上面新建的可写目标——只有它才该被拒绝。
      //
      // 不写死 id：内置形象由 resources/pets/ 决定（当前是小满 / 小卡），
      // 写死会让「换掉内置形象」把这条断言变成假失败。取列表里第一个内置的。
      // （注意：这段注释里不能用反引号，它会提前结束外层模板字符串。）
      const list = await (await fetch('${API}/pets')).json();
      const builtinItem = (list.items || []).find((item) => item.source === 'builtin');
      if (!builtinItem) return { error: '没有找到内置形象' };
      const BUILTIN = builtinItem.id;

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1,2,3])], { type: 'image/png' }), 'x.png');
      const upload = await fetch('${API}/pets/' + BUILTIN + '/actions/walk-left', {
        method: 'POST', body: form,
      });
      const uploadBody = await upload.json();
      const exportRes = await fetch('${API}/pets/' + BUILTIN + '/export');
      const exportBody = await exportRes.json();

      // ② 面板层：切到内置形象，看控件
      window.__petApi.surfaces.open('pet-settings', { source: 'verify-upload' });
      await new Promise((r) => setTimeout(r, 1200));
      // 用 data-pet-id 精确选中内置形象（靠文字匹配会在改名时失效）
      const builtin = document.querySelector('.plugin-stm-pet .pet-card[data-pet-id="' + BUILTIN + '"]');
      if (builtin) builtin.click();
      await new Promise((r) => setTimeout(r, 900));
      const panel = document.querySelector('.plugin-stm-pet.pet-panel');
      const text = panel ? panel.textContent : '';
      const buttons = Array.from(panel ? panel.querySelectorAll('button') : [])
        .map((node) => node.textContent.trim());
      return {
        builtinId: BUILTIN,
        uploadStatus: upload.status,
        uploadError: uploadBody.error,
        exportStatus: exportRes.status,
        exportError: exportBody.error,
        hasSwapButton: buttons.some((t) => t.includes('换图')),
        hasDeleteButton: buttons.some((t) => t === '删除'),
        hasExportButton: buttons.some((t) => t.includes('导出')),
        saysReadonly: text.includes('不可修改') || text.includes('只读') || text.includes('插件自带'),
      };
    })()`);
    record(
      '⑰ 内置形象严格只读：接口拒绝换图/导出，面板不渲染编辑控件',
      readonly.uploadStatus === 403 && readonly.uploadError === 'builtin_readonly'
        && readonly.exportStatus === 403 && readonly.exportError === 'builtin_no_export'
        && !readonly.hasSwapButton && !readonly.hasDeleteButton && !readonly.hasExportButton
        && readonly.saysReadonly,
      JSON.stringify(readonly),
    );

    // ---- ⑱ 用户能自己新建形象（不需要 zip / pet.json）
    const created = await page.evaluate(`(async () => {
      // 造一张 128×64 的图 = 2 帧 × 64px
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#22cc88';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#8844ff';
      ctx.fillRect(64, 0, 64, 64);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));

      const form = new FormData();
      form.append('name', '验收新形象');
      form.append('scale', '1.5');
      form.append('pixelated', '1');
      form.append('idle', blob, 'idle.png');
      form.append('meta', JSON.stringify({ idle: { frames: 2, fps: 6 } }));

      const response = await fetch('${API}/pets/create', { method: 'POST', body: form });
      const body = await response.json();
      return {
        status: response.status,
        ok: body.success,
        id: body.pet ? body.pet.id : '',
        name: body.pet ? body.pet.name : '',
        frames: body.pet ? body.pet.actions.idle.frames : 0,
        size: body.pet ? body.pet.size : null,
        scale: body.pet ? body.pet.scale : null,
        pixelated: body.pet ? body.pet.pixelated : null,
        writable: body.pet ? body.pet.writable : null,
        error: body.error || '',
      };
    })()`);
    record(
      '⑱ 新建形象：两帧图被正确切分，尺寸从图推导，倍率/渲染方式生效',
      created.ok && created.frames === 2 && created.size
        && created.size.w === 64 && created.size.h === 64
        && created.scale === 1.5 && created.pixelated === true
        && created.writable === true,
      JSON.stringify(created),
    );

    // ---- ⑲ 新形象立刻出现在屏幕上，且倍率改动**不必刷新页面**
    //
    // 这是用户诉求里最容易做错的一环：`petview` 的包围盒尺寸在构造时就定了，
    // 只改配置不会生效。必须重建视图并保留位置。
    //
    // 必须走**面板上的真实滑块**（`input` → `change`），而不是直接 fetch 接口：
    // 直接调接口插件并不知情，那属于「后台改设置」，测不出「用户拖滑块」这条路径。
    const liveResize = await page.evaluate(`(async () => {
      const root = () => document.querySelector('[data-plugin="stm-pet"].pet-root');

      // ① 让目标形象成为**当前形象**（屏幕上跑的就是它）
      await fetch('${API}/pets/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ petId: '${TARGET}' }),
      });
      // ② 让面板**选中**同一个形象。
      //
      // 这一步不能省：面板的滑块作用于「当前选中的形象」（selectedId），
      // 而屏幕上跑的是「当前形象」（activePetId）。两者不一致时，
      // 拖滑块改的是另一个形象——第一版就是这样，于是断言必然失败，
      // 而产品其实是对的。⑰ 点过内置形象的卡片，所以这里必须显式切回来。
      // （注意：这段注释里不能用反引号，它会提前结束外层模板字符串。）
      window.__petApi.surfaces.close('pet-settings');
      await new Promise((r) => setTimeout(r, 300));
      window.__petApi.surfaces.open('pet-settings', { source: 'verify-upload' });
      await new Promise((r) => setTimeout(r, 1500));

      const card = document.querySelector('.plugin-stm-pet .pet-card[data-pet-id="${TARGET}"]');
      if (!card) return { error: '面板里找不到目标形象的卡片' };
      card.click();
      await new Promise((r) => setTimeout(r, 1200));

      const before = root().getBoundingClientRect();

      // 拖滑块到 3×（真实用户路径：input 事件 → change 事件）
      const slider = document.querySelector('.plugin-stm-pet .pet-slider');
      if (!slider) return { error: '找不到大小倍率滑块' };
      slider.value = '3';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 2500));

      const after = root().getBoundingClientRect();
      const data = await (await fetch('${API}/runtime')).json();
      return {
        scale: data.pet.scale,
        petId: data.pet.id,
        beforeW: Math.round(before.width),
        afterW: Math.round(after.width),
        // 位置不该因为改大小而跳到别处（用户拖好的位置要留住）
        moved: Math.round(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)),
      };
    })()`);
    record(
      '⑲ 拖面板滑块改倍率 → 运行中的宠物立刻变大（不必刷新页面）',
      liveResize.scale === 3 && liveResize.petId === TARGET
        && liveResize.afterW > liveResize.beforeW,
      `宽度 ${liveResize.beforeW} → ${liveResize.afterW}，scale=${liveResize.scale}，`
      + `pet=${liveResize.petId}，位移=${liveResize.moved}px`,
    );

    // ---- ⑳ 渲染方式真的落到 DOM（像素风开关不是摆设）
    //
    // 原 bug：CSS 有 `[data-pet-pixelated="false"]` 规则，但 JS 从未设置该属性，
    // 于是像素风恒开、写实插画放大后出现块状边缘。
    // 这里走面板上的「平滑」按钮（真实用户路径）。
    const rendering = await page.evaluate(`(async () => {
      const root = () => document.querySelector('[data-plugin="stm-pet"].pet-root');
      const rendering = () => getComputedStyle(root().querySelector('.pet-sprite')).imageRendering;

      // 面板此刻已选中目标形象（见 ⑲），且它是当前形象——两边一致才能断言 DOM
      const smooth = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-choice'))
        .find((node) => node.textContent.includes('平滑'));
      if (!smooth) return { error: '找不到「平滑」渲染方式按钮' };
      smooth.click();
      await new Promise((r) => setTimeout(r, 2500));

      const off = { attr: root().dataset.petPixelated, rendering: rendering() };

      // 再切回像素风，确认开关是双向的
      const pixel = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-choice'))
        .find((node) => node.textContent.includes('像素风'));
      if (pixel) {
        pixel.click();
        await new Promise((r) => setTimeout(r, 2500));
      }
      return {
        offAttr: off.attr, offRendering: off.rendering,
        onAttr: root().dataset.petPixelated, onRendering: rendering(),
      };
    })()`);
    record(
      '⑳ 渲染方式写入 data 属性并影响 image-rendering（像素风不再恒开，可双向切换）',
      rendering.offAttr === 'false' && rendering.offRendering === 'auto'
        && rendering.onAttr === 'true' && rendering.onRendering === 'pixelated',
      JSON.stringify(rendering),
    );

    // ---- ㉑ 清理：把验收造出来的形象删掉（脚本可重复运行）
    //
    // 两个名字都要清：⓪ 建的可写目标与 ⑱ 建的多帧形象。
    // 漏掉任何一个，脚本第二次跑就会因为「同名形象越来越多」而变得难以诊断。
    const cleanup = await page.evaluate(`(async () => {
      const NAMES = ['验收目标形象', '验收新形象'];
      const data = await (await fetch('${API}/pets')).json();
      const mine = (data.items || []).filter((item) => NAMES.includes(item.name));
      const results = [];
      for (const pet of mine) {
        const response = await fetch('${API}/pets/' + pet.id, { method: 'DELETE' });
        results.push((await response.json()).success);
      }
      // 回到内置形象，让环境回到初始状态。
      // 不写死 id：取列表里第一个内置的（当前是小满 / 小卡）。
      const builtin = (data.items || []).find((item) => item.source === 'builtin');
      const wanted = builtin ? builtin.id : '';
      await fetch('${API}/pets/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ petId: wanted }),
      });
      const after = await (await fetch('${API}/pets')).json();
      return {
        deleted: results.length,
        remaining: (after.items || []).filter((i) => NAMES.includes(i.name)).length,
        active: after.activePetId,
        expected: wanted,
      };
    })()`);
    record(
      '㉑ 验收可重复运行：造出来的形象被清理，当前形象回到内置',
      cleanup.remaining === 0 && cleanup.active === cleanup.expected,
      JSON.stringify(cleanup),
    );

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`形象管理链验收：${results.length - failed.length}/${results.length} 通过\n`);
    if (failed.length) {
      process.stdout.write('\n失败明细:\n');
      for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
      exitCode = 1;
    }
  } finally {
    browser.close();
    try { fs.unlinkSync(tmpPng); } catch { /* 尽力而为 */ }
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`运行失败: ${error && error.stack ? error.stack : error}\n`);
    process.exit(2);
  });
