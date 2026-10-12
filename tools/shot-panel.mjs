/** 给设置面板拍截图（人眼核对缩略图与动画预览区）。 */

import { launch } from './cdp.mjs';
import fs from 'node:fs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor('Boolean(window.__petApi)', { timeout: 20000, label: '插件激活' });
    await sleep(800);
    await page.evaluate(`(async () => {
      await window.__petApi.surfaces.open('pet-settings', { source: 'shot' });
      return true;
    })()`);
    await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
      timeout: 15000, label: '形象列表',
    });
    await sleep(2000);

    fs.mkdirSync('artifacts/anim-review', { recursive: true });

    // 整面板
    const whole = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('artifacts/anim-review/panel-full.png', Buffer.from(whole.data, 'base64'));

    // 列表区（缩略图）
    const listClip = await page.evaluate(`(() => {
      const list = document.querySelector('.plugin-stm-pet .pet-panel-list');
      if (!list) return null;
      const r = list.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 240), scale: 2 };
    })()`);
    if (listClip) {
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png', clip: listClip, captureBeyondViewport: true,
      });
      fs.writeFileSync('artifacts/anim-review/panel-list.png', Buffer.from(shot.data, 'base64'));
    }

    // 动画预览区：先滚到那里
    await page.evaluate(`(() => {
      const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
      if (box) box.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(1200);
    const previewClip = await page.evaluate(`(() => {
      const stage = document.querySelector('.plugin-stm-pet .pet-preview-stage');
      const picker = document.querySelector('.plugin-stm-pet .pet-preview-picker');
      if (!stage) return null;
      const a = stage.getBoundingClientRect();
      const b = picker ? picker.getBoundingClientRect() : a;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return {
        x: Math.max(0, x - 10),
        y: Math.max(0, y - 10),
        width: Math.min(window.innerWidth - x, Math.max(a.width, b.width) + 20),
        height: Math.min(window.innerHeight - y, (b.bottom - y) + 20),
        scale: 2,
      };
    })()`);
    if (previewClip) {
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png', clip: previewClip, captureBeyondViewport: true,
      });
      fs.writeFileSync('artifacts/anim-review/panel-preview.png', Buffer.from(shot.data, 'base64'));
    }
    process.stdout.write('截图完成: panel-full.png / panel-list.png / panel-preview.png\n');
  } finally {
    browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`运行失败: ${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
