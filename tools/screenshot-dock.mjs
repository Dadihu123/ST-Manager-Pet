/**
 * 给坞入口拍截图（含悬停提示），便于肉眼核对。
 *
 * 用法：node tools/screenshot-dock.mjs [输出目录]
 */

import { mkdirSync } from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const OUT = process.argv[2] || 'artifacts/screenshots-dock';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch({ width: 1600, height: 900 });
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(window.__petApi)`, { timeout: 20000, label: '插件加载' });
    await sleep(1600);

    // 坞默认是**折叠**的（右边缘一枚带计数的箭头，`.entry-rail.is-collapsed`）。
    // 要看到槽位必须先展开 —— 否则截图里只有那个箭头（踩过一次）。
    const expanded = await page.evaluate(`(async () => {
      const rail = document.querySelector('.entry-rail');
      if (!rail) return { error: '页面上没有坞' };
      const before = rail.className;
      if (rail.classList.contains('is-collapsed')) {
        const toggle = rail.querySelector('.entry-rail__toggle');
        if (!toggle) return { error: '折叠态但找不到展开按钮' };
        toggle.click();
        await new Promise((r) => setTimeout(r, 900));
      }
      return { before, after: rail.className };
    })()`);
    if (expanded.error) throw new Error(expanded.error);
    process.stdout.write(`  坞状态: ${expanded.before} → ${expanded.after}\n`);
    await sleep(500);

    /** 只截坞所在的右侧竖条（含一点留白）。 */
    const railBox = await page.evaluate(`(() => {
      const rail = document.querySelector('.entry-rail');
      if (!rail) return null;
      const rect = rail.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);

    const shot = async (name, clip) => {
      const result = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clip, scale: 2 },
      });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${OUT}/${name}`, Buffer.from(result.data, 'base64'));
      process.stdout.write(`  ${OUT}/${name}\n`);
    };

    // 全页（看宠物与坞的相对位置）
    await shot('01-overview.png', {
      x: 0, y: 0, width: 1600, height: 900,
    });

    // 坞局部放大
    if (railBox) {
      await shot('02-dock-rail.png', {
        x: Math.max(0, railBox.x - 24),
        y: Math.max(0, railBox.y - 24),
        width: railBox.width + 48,
        height: railBox.height + 48,
      });
    }

    // 悬停宠物槽位 → tooltip
    await page.evaluate(`(() => {
      const rail = document.querySelector('.entry-rail');
      const slots = Array.from(rail.querySelectorAll('.entry-rail__slot'));
      const hit = slots.find((node) => {
        const asset = node.querySelector('.ui-icon--asset');
        if (!asset) return false;
        return (getComputedStyle(asset).webkitMaskImage || '').includes('/api/plugins/stm-pet/assets/');
      });
      if (hit) {
        const rect = hit.getBoundingClientRect();
        hit.dispatchEvent(new MouseEvent('mouseover', {
          bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
        }));
        hit.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      }
      return true;
    })()`);
    await sleep(1200);
    if (railBox) {
      await shot('03-dock-hover.png', {
        x: Math.max(0, railBox.x - 200),
        y: Math.max(0, railBox.y - 24),
        width: railBox.width + 224,
        height: railBox.height + 48,
      });
    }

    // 打开设置面板
    await page.evaluate(`(async () => {
      window.__petApi.surfaces.open('pet-settings', { source: 'screenshot' });
      await new Promise((r) => setTimeout(r, 1600));
      return true;
    })()`);
    await sleep(900);
    await shot('04-panel-from-dock.png', {
      x: 0, y: 0, width: 1600, height: 900,
    });

    process.stdout.write('截图完成\n');
  } finally {
    browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`失败: ${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
