/**
 * 给宠物拍一张真实截图（人工核对观感用，不是自动验收）。
 *
 * 用法：node tools/screenshot-pet.mjs [输出路径]
 *
 * 会在下列时机各截一张：
 * 1. 正常 idle 状态；
 * 2. 设置面板打开（形象管理 UI）；
 * 3. 拖拽中（宠物被抓起来）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const outDir = process.argv[2] || path.join('artifacts', 'screenshots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shoot(page, name) {
  const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(outDir, `${name}.png`);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  process.stdout.write(`  ${target}\n`);
  return target;
}

const browser = await launch({ width: 1440, height: 900 });
try {
  fs.mkdirSync(outDir, { recursive: true });
  const page = await browser.newPage();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.navigate(BASE, { timeout: 30000 });
  await page.waitFor('Boolean(document.querySelector(\'[data-plugin="stm-pet"].pet-root\'))', {
    timeout: 20000, label: '宠物挂载',
  });
  await sleep(1500);

  // 1) 正常状态
  await shoot(page, '01-pet-idle');

  // 2) 拖到屏幕中间再截图（看得更清楚）
  const box = await page.evaluate(`(() => {
    const r = document.querySelector('[data-plugin="stm-pet"].pet-root').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1,
  });
  for (let step = 1; step <= 8; step += 1) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(box.x - step * 30),
      y: Math.round(box.y - step * 40),
      button: 'left',
      buttons: 1,
    });
    await sleep(20);
  }
  await sleep(150);
  await shoot(page, '02-pet-dragging');
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x - 240, y: box.y - 320, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(1200);

  // 3) 设置面板
  await page.evaluate(`(async () => {
    window.__petApi.surfaces.open('pet-settings', { source: 'screenshot' });
    return true;
  })()`);
  await sleep(2500);
  await shoot(page, '03-settings-panel');

  process.stdout.write('截图完成\n');
} finally {
  browser.close();
}
