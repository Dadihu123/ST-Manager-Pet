/**
 * 实证：宿主修复后（commit 715d0a8）`api.toast` 的图标位行为。
 *
 * 上一版（tools/verify-toast-icon.mjs）断言的是**旧行为**（缺口存在），
 * 因此修复后它会「失败」——那是预期，说明修复生效了。
 * 本脚本改成断言**新行为**，并把插件的两条路径分开测：
 *
 * 1. 宿主图标名（含旧白名单外的）→ 走 `<use>`；
 * 2. 插件自带资源路径 → 走 CSS mask（**必须**，塞进 `<use>` 会是空图形）；
 * 3. 未知名字 → 图标位留空 + `console.warn`（把静默失效变可见）；
 * 4. 白名单里那 16 个名字行为不变（回归）。
 *
 * 用法：node tools/verify-toast-icon.mjs
 */

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

/** 触发一次 toast（可指定 pluginId）并读回渲染结果。 */
async function probe(page, icon, label, pluginId = '') {
  return page.evaluate(`(async () => {
    const store = window.Alpine && window.Alpine.store ? window.Alpine.store('global') : null;
    if (!store || typeof store.showToast !== 'function') return { error: '拿不到宿主 toast store' };

    window.__toastWarns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      window.__toastWarns.push(args.map(String).join(' '));
      return originalWarn.apply(console, args);
    };

    store.showToast(
      ${JSON.stringify(label)}, 4000, ${JSON.stringify(icon || '')},
      ${JSON.stringify(pluginId)} ? { pluginId: ${JSON.stringify(pluginId)} } : undefined,
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    console.warn = originalWarn;

    const box = document.querySelector('.toast-notification');
    if (!box) return { error: '找不到 .toast-notification' };
    const svg = box.querySelector('svg');
    const use = box.querySelector('use');
    const assetSpan = box.querySelector('.ui-icon--asset');
    const cs = assetSpan ? getComputedStyle(assetSpan) : null;
    const rect = assetSpan ? assetSpan.getBoundingClientRect() : null;

    return {
      kind: store.toastIconKind,
      icon: store.toastIcon,
      href: store.toastIconHref || '',
      mask: store.toastIconMask || '',
      hasSvg: Boolean(svg),
      useHref: use ? (use.getAttribute('href') || use.getAttribute('xlink:href') || '') : '',
      hasAssetSpan: Boolean(assetSpan),
      assetMask: cs ? (cs.webkitMaskImage || cs.maskImage || '') : '',
      assetBox: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
      warns: window.__toastWarns.filter((line) => line.includes('[toast]')),
      text: (box.textContent || '').trim().slice(0, 40),
    };
  })()`);
}

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(window.__petApi)`, { timeout: 20000, label: '插件加载' });
    await sleep(1200);

    // ---- ① 宿主图标名（旧白名单内）→ <use>，行为与修复前一致
    const known = await probe(page, 'check', '白名单内的宿主图标');
    record(
      '① 宿主图标名（旧白名单内）→ <use>，行为不变',
      !known.error && known.kind === 'host' && known.hasSvg
        && known.useHref.includes('icon-check') && !known.hasAssetSpan,
      known.error || `kind=${known.kind}，href=${known.useHref}`,
    );
    await sleep(4200);

    // ---- ② ★ 宿主图标名（**旧白名单外**）→ 现在能用了
    const unlocked = await probe(page, 'heart', '宿主自己的 heart 图标');
    record(
      '② ★ 旧白名单外的宿主图标（heart）→ 现在能渲染（缺口已修）',
      !unlocked.error && unlocked.kind === 'host' && unlocked.hasSvg
        && unlocked.useHref.includes('icon-heart') && unlocked.warns.length === 0,
      unlocked.error || `kind=${unlocked.kind}，href=${unlocked.useHref}，warn=${unlocked.warns.length}`,
    );
    await sleep(4200);

    // ---- ③ ★ 插件自带资源路径 → 走 mask（不是 <use>）
    const asset = await probe(
      page, 'frontend/assets/icon.svg', '插件自带图标',
      'stm-pet',
    );
    const assetOk = !asset.error && asset.kind === 'asset'
      && asset.hasAssetSpan && !asset.hasSvg
      && String(asset.assetMask).includes('/api/plugins/stm-pet/assets/frontend/assets/icon.svg');
    record(
      '③ ★ 插件自带图标 → 走 CSS mask（通知可品牌化）',
      assetOk,
      asset.error || `kind=${asset.kind}，有 mask span=${asset.hasAssetSpan}，`
        + `有 <use>=${asset.hasSvg}，尺寸=${JSON.stringify(asset.assetBox)}\n`
        + `        mask=${String(asset.assetMask).slice(0, 120)}`,
    );
    await sleep(4200);

    // ---- ④ 未知名字 → 留空 + warn（不再是静默失效）
    const unknown = await probe(page, 'no-such-icon-xyz', '未知图标名');
    record(
      '④ 未知名字 → 图标位留空且 console.warn（把静默失效变可见）',
      !unknown.error && unknown.kind === 'missing' && !unknown.hasSvg
        && !unknown.hasAssetSpan && unknown.warns.length >= 1
        && unknown.text.includes('未知图标名'),
      unknown.error || `kind=${unknown.kind}，warn=${unknown.warns.length} 条`
        + `（文案仍显示="${unknown.text}"）`,
    );
    await sleep(4200);

    // ---- ⑤ 插件真实播报路径端到端（走 announce → api.toast → pluginHost 透传 pluginId）
    const endToEnd = await page.evaluate(`(async () => {
      const store = window.Alpine.store('global');
      // 用插件自己的 api.toast，图标写成插件资源路径（修复前不可能生效）
      window.__petApi.toast('扫描完成：3 项', 3000, 'frontend/assets/icon.svg');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const box = document.querySelector('.toast-notification');
      const span = box ? box.querySelector('.ui-icon--asset') : null;
      const cs = span ? getComputedStyle(span) : null;
      return {
        kind: store.toastIconKind,
        hasAssetSpan: Boolean(span),
        mask: cs ? (cs.webkitMaskImage || cs.maskImage || '') : '',
        text: box ? (box.textContent || '').trim().slice(0, 30) : '',
      };
    })()`);
    record(
      '⑤ ★ 插件播报端到端：api.toast 用自带图标 → mask 生效',
      endToEnd.kind === 'asset' && endToEnd.hasAssetSpan
        && String(endToEnd.mask).includes('/api/plugins/stm-pet/assets/')
        && endToEnd.text.includes('扫描完成'),
      `kind=${endToEnd.kind}，有 mask span=${endToEnd.hasAssetSpan}，文案="${endToEnd.text}"\n`
        + `        mask=${String(endToEnd.mask).slice(0, 120)}`,
    );

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`toast 图标验收：${results.length - failed.length}/${results.length} 通过\n`);
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
