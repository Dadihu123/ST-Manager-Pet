/**
 * 真实宿主里的坞入口验收。
 *
 * 断言的不是「manifest 里有这个字段」，而是**坞里真的出现了这个槽位、
 * 点下去真的打开了设置面板**：
 *
 * ① 宿主清单把 dock 入口认下来了（kind/tier/surface 都在）；
 * ② 坞槽位渲染出插件图标（mask 指向插件资产，不是占位图标）；
 * ③ 图标实际尺寸合理（不空白、不溢出槽位）；
 * ④ 点击槽位 → 设置面板打开（surface 通路真的接上了）；
 * ⑤ 与参照插件（AI 助手）的坞图标尺寸对比在容差内。
 *
 * 用法：node tools/verify-dock.mjs
 */

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

async function main() {
  const browser = await launch({ width: 1600, height: 900 });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(window.__petApi)`, { timeout: 20000, label: '插件加载' });
    await sleep(1500);

    // ---- ① 宿主清单认下了 dock 入口
    const listed = await page.evaluate(`(async () => {
      const data = await (await fetch('/api/plugins/list')).json();
      const plugin = (data.items || []).find((row) => row.id === 'stm-pet');
      if (!plugin) return { error: '清单里没有 stm-pet' };
      const entries = (plugin.entries || []).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        tier: entry.tier,
        icon: entry.icon,
        surface: entry.surface && entry.surface.id,
        label: entry.label,
      }));
      return { loaded: plugin.loaded, entries };
    })()`);
    const dock = (listed.entries || []).find((entry) => entry.kind === 'dock');
    record(
      '① 宿主清单认下 dock 入口（kind/tier/surface 齐全）',
      !listed.error && listed.loaded === true && Boolean(dock)
        && dock.surface === 'pet-settings'
        && dock.icon === 'frontend/assets/icon.svg',
      listed.error || JSON.stringify(dock || listed.entries),
    );

    // ---- ② 坞槽位渲染出插件图标（mask 指向插件资产）
    const slot = await page.evaluate(`(() => {
      const rail = document.querySelector('.entry-rail');
      if (!rail) return { error: '页面上没有坞（.entry-rail）' };
      const slots = Array.from(rail.querySelectorAll('.entry-rail__slot'));
      const hit = slots.find((node) => {
        const asset = node.querySelector('.ui-icon--asset');
        if (!asset) return false;
        const mask = getComputedStyle(asset).webkitMaskImage || '';
        return mask.includes('/api/plugins/stm-pet/assets/');
      });
      if (!hit) {
        return {
          error: '坞里没有找到用插件图标的槽位',
          slots: slots.map((node) => node.getAttribute('title') || node.dataset.entryKey || '?'),
        };
      }
      const icon = hit.querySelector('.ui-icon--asset');
      const cs = getComputedStyle(icon);
      const iconRect = icon.getBoundingClientRect();
      const slotRect = hit.getBoundingClientRect();
      return {
        title: hit.getAttribute('title') || '',
        ariaLabel: hit.getAttribute('aria-label') || '',
        mask: cs.webkitMaskImage || cs.maskImage || '',
        iconBox: [Math.round(iconRect.width), Math.round(iconRect.height)],
        slotBox: [Math.round(slotRect.width), Math.round(slotRect.height)],
        slotCount: slots.length,
      };
    })()`);
    record(
      '② 坞槽位用插件自带图标渲染（mask 指向插件资产）',
      !slot.error && String(slot.mask).includes('/api/plugins/stm-pet/assets/frontend/assets/icon.svg'),
      slot.error || `标题="${slot.title}"，图标 ${JSON.stringify(slot.iconBox)}，`
        + `槽位 ${JSON.stringify(slot.slotBox)}，坞内共 ${slot.slotCount} 槽`,
    );

    // ---- ③ 图标尺寸合理（撑满槽位内的图标位，且非空白）
    const sizeOk = !slot.error
      && slot.iconBox && slot.iconBox[0] >= 20 && slot.iconBox[0] <= 32
      && slot.slotBox && slot.iconBox[0] <= slot.slotBox[0];
    record(
      '③ 坞图标尺寸合理（撑满图标位、不溢出槽位）',
      sizeOk,
      slot.error || `图标 ${slot.iconBox[0]}×${slot.iconBox[1]}px 在 ${slot.slotBox[0]}×${slot.slotBox[1]}px 槽位内`,
    );

    // ---- ④ 点击坞槽位 → 打开设置面板
    const opened = await page.evaluate(`(async () => {
      const rail = document.querySelector('.entry-rail');
      const slots = Array.from(rail.querySelectorAll('.entry-rail__slot'));
      const hit = slots.find((node) => {
        const asset = node.querySelector('.ui-icon--asset');
        if (!asset) return false;
        const mask = getComputedStyle(asset).webkitMaskImage || '';
        return mask.includes('/api/plugins/stm-pet/assets/');
      });
      if (!hit) return { error: '找不到槽位' };
      hit.click();
      await new Promise((r) => setTimeout(r, 1600));
      return {
        panelOpen: Boolean(document.querySelector('.plugin-stm-pet.pet-panel')),
        petRootStillThere: Boolean(document.querySelector('[data-plugin="stm-pet"].pet-root')),
      };
    })()`);
    record(
      '④ 点击坞槽位 → 设置面板打开（surface 通路接上了）',
      !opened.error && opened.panelOpen === true,
      opened.error || `面板打开=${opened.panelOpen}，宠物仍在=${opened.petRootStillThere}`,
    );

    // 关掉面板，避免影响后续
    await page.evaluate(`(async () => {
      if (window.__petApi && window.__petApi.surfaces) {
        window.__petApi.surfaces.close('pet-settings');
      }
      await new Promise((r) => setTimeout(r, 600));
      return true;
    })()`);
    await sleep(600);

    // ---- ⑤ 与参照插件（AI 助手）的坞图标尺寸对比
    const compare = await page.evaluate(`(() => {
      const rail = document.querySelector('.entry-rail');
      if (!rail) return { error: '没有坞' };
      const read = (needle) => {
        const slots = Array.from(rail.querySelectorAll('.entry-rail__slot'));
        const hit = slots.find((node) => {
          const asset = node.querySelector('.ui-icon--asset');
          if (!asset) return false;
          return (getComputedStyle(asset).webkitMaskImage || '').includes(needle);
        });
        if (!hit) return null;
        const icon = hit.querySelector('.ui-icon--asset');
        const rect = icon.getBoundingClientRect();
        return { w: rect.width, h: rect.height };
      };
      return { pet: read('/api/plugins/stm-pet/assets/'), ai: read('/api/plugins/stm-ai-assistant/assets/') };
    })()`);
    if (compare.error || !compare.pet) {
      record('⑤ 与参照插件坞图标尺寸对比', false, compare.error || '读不到宠物槽位');
    } else if (!compare.ai) {
      // AI 助手没装时不算失败，只提示
      record(
        '⑤ 与参照插件坞图标尺寸对比（跳过：未安装参照插件）',
        true,
        `宠物图标 ${compare.pet.w}×${compare.pet.h}px；坞里没有 stm-ai-assistant`,
      );
    } else {
      const dh = Math.abs(compare.pet.h - compare.ai.h);
      const dw = Math.abs(compare.pet.w - compare.ai.w);
      record(
        '⑤ 与参照插件坞图标尺寸一致（容差 3px）',
        dw <= 3 && dh <= 3,
        `宠物 ${compare.pet.w}×${compare.pet.h}  vs  AI 助手 ${compare.ai.w}×${compare.ai.h}`
          + `（差 ${dw.toFixed(1)}×${dh.toFixed(1)}px）`,
      );
    }

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`坞入口验收：${results.length - failed.length}/${results.length} 通过\n`);
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
