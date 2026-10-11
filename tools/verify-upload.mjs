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
      // 右上角青色方块，其余橙色 —— 与内置小猫（橙色描边+白肚）明显不同
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

    // ---- 基线
    const before = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/runtime')).json();
      const idle = data.pet.actions.idle;
      return { url: idle.url, frameSource: idle.frameSource, petId: data.activePetId };
    })()`);
    const beforeVersion = versionOf(before.url);

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
      return { found: Boolean(window.__capturedInput) };
    })()`);
    record(
      '② 点「换图」会创建文件输入',
      Boolean(uploadInfo && uploadInfo.found),
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
      const response = await fetch('${API}/frame/default-cat/idle', { cache: 'no-store' });
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
    // （在 idle 与 walk 之间切换），只覆盖 idle 的话，
    // 采样时它可能正在 walk，断言就会失效。
    const walkPanel = await page.evaluate(`(async () => {
      window.__petApi.surfaces.open('pet-settings', { source: 'verify-upload' });
      await new Promise((r) => setTimeout(r, 1200));
      const tile = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-action-tile'))
        .find((node) => (node.querySelector('.pet-action-name') || {}).textContent === '行走');
      if (!tile) return { error: '找不到 walk（行走）动作卡片' };
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
      '⑥ 「行走」动作也通过面板换图',
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
      return {
        action,
        overrides: data.pet.overrides,
        spriteUrl: getComputedStyle(sprite).backgroundImage,
        expectedUrl: entry.url,
        expectedSource: entry.frameSource,
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
      return {
        overrides: data.pet.overrides,
        idleSource: data.pet.actions.idle.frameSource,
        walkSource: data.pet.actions.walk.frameSource,
        action,
        spriteUrl: getComputedStyle(sprite).backgroundImage,
        expectedUrl: entry.url,
      };
    })()`);
    record(
      '⑧ 刷新页面后覆盖仍在（idle + walk 都持久化，sprite 与后端版本一致）',
      afterReload.idleSource === 'override' && afterReload.walkSource === 'override'
        && versionOf(afterReload.spriteUrl) === versionOf(afterReload.expectedUrl),
      `overrides=${JSON.stringify(afterReload.overrides)}，idle=${afterReload.idleSource}，walk=${afterReload.walkSource}，版本一致=${versionOf(afterReload.spriteUrl) === versionOf(afterReload.expectedUrl)}`,
    );

    // ---- ⑨ 预览接口标出「已自定」
    const preview = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/pets/default-cat/preview')).json();
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
      const idle = await fetch('${API}/pets/default-cat/actions/idle', { method: 'DELETE' });
      const idleData = await idle.json();
      // 顺带清掉 walk 的覆盖，让这次验收**不留下痕迹**（可重复运行）
      const walk = await fetch('${API}/pets/default-cat/actions/walk', { method: 'DELETE' });
      const walkData = await walk.json();
      return {
        success: idleData.success,
        removed: idleData.removed,
        source: idleData.pet.actions.idle.frameSource,
        walkRemoved: walkData.removed,
      };
    })()`);
    record(
      '⑩ 删除覆盖后回落到包内原图（两个动作都清理，验收可重复运行）',
      cleared.removed === true && cleared.source === 'builtin' && cleared.walkRemoved === true,
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
      const response = await fetch('${API}/pets/default-cat/actions/walk', {
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
      const response = await fetch('${API}/pets/default-cat/actions/walk', {
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
      const response = await fetch('${API}/pets/default-cat/actions/' + encodeURIComponent('../evil'), {
        method: 'DELETE',
      });
      return { status: response.status };
    })()`);
    record(
      '⑭ 动作名里的路径穿越被拒绝',
      traversal.status === 400 || traversal.status === 404,
      `status=${traversal.status}`,
    );

    // ---- ⑭ 宠物在所有这些操作后仍然活着
    const alive = await page.evaluate(`(async () => {
      const root = document.querySelector('[data-plugin="stm-pet"].pet-root');
      const pos1 = getComputedStyle(root.querySelector('.pet-sprite')).backgroundPosition;
      await new Promise((r) => setTimeout(r, 800));
      const pos2 = getComputedStyle(root.querySelector('.pet-sprite')).backgroundPosition;
      return { alive: Boolean(root), animating: pos1 !== pos2, action: root.dataset.petAction };
    })()`);
    record(
      '⑮ 历经上传/删除/非法输入后宠物仍正常活动',
      alive.alive && alive.animating,
      JSON.stringify(alive),
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
