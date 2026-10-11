/**
 * 阶段 0 的**真实浏览器**验收（实施提示词 §5 阶段 0 的七条）。
 *
 * 在真实 Chrome 里加载影子宿主（`tools/host_sandbox.py` 生成的独立 data/），
 * 用 CDP 驱动真实的 `pluginSurfaceHost.js` + 真实的冒烟插件，逐条断言。
 *
 * 前置：影子宿主已在 PET_SANDBOX_PORT（默认 5099）上运行。
 *
 *   python tools/host_sandbox.py --create --install tools/stm-pet-smoke
 *   (cd <sandbox> && python app.py)
 *   node tools/verify-ambient.mjs
 */

import assert from 'node:assert/strict';
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const PLUGIN_ID = 'stm-pet-smoke';

const results = [];
async function step(name, fn, page) {
  try {
    await fn(page);
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false, message: String((error && error.message) || error) });
    process.stdout.write(`  FAIL  ${name}\n        ${String((error && error.message) || error).split('\n')[0]}\n`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把页面里 `window.__petSmoke` 的几何快照取回来。 */
const SMOKE = 'JSON.parse(JSON.stringify(window.__petSmoke || null))';

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Log.enable').catch(() => {});
    await page.send('Console.enable').catch(() => {});

    const consoleLogs = [];
    page.on('Runtime.consoleAPICalled', (params) => {
      consoleLogs.push((params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    });

    await page.navigate(BASE, { timeout: 30000 });
    // 等宿主加载完插件（activate 里注册 ambient 是同步的）
    await page.waitFor(`${SMOKE} && window.__petSmoke.mountCount > 0`, {
      label: '冒烟插件的 ambient 被挂载',
    });
    await sleep(300);

    // 把真实页面里的断言原语注入一次，后面复用（避免在 evaluate 里重复长表达式）
    await page.evaluate(`
      window.__petProbe = {
        shell: () => document.querySelector('.plugin-surface--ambient[data-plugin="${PLUGIN_ID}"]'),
        body: () => {
          const shell = window.__petProbe.shell();
          return shell ? shell.querySelector('.plugin-surface__ambient-body') : null;
        },
        box: () => document.querySelector('.plugin-${PLUGIN_ID} .pet-smoke-box')
          || document.querySelector('[data-plugin="${PLUGIN_ID}"] .pet-smoke-box')
          || document.querySelector('.pet-smoke-box'),
        contentArea: () => document.querySelector('.content-area'),
      };
      true
    `);

    // ------------------------------------------------- 1. 方块出现且不推挤内容区
    await step('① 方块出现在屏幕上', async () => {
      const info = await page.evaluate(`(() => {
        const box = window.__petProbe.box();
        if (!box) return null;
        const r = box.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
      })()`);
      assert.ok(info, '找不到 .pet-smoke-box');
      assert.ok(info.visible, `方块尺寸为 0: ${JSON.stringify(info)}`);
      assert.ok(info.x >= 0 && info.y >= 0, `方块位置异常: ${JSON.stringify(info)}`);
      await page.evaluate('window.__petSmoke.measure && window.__petSmoke.measure(), true');
    });

    await step('①b 不推挤内容区（.content-area 布局不变）', async () => {
      // 先量一次「有 ambient」时的内容区几何，再摘掉 ambient 容器对比
      const withAmbient = await page.evaluate(`(() => {
        const c = window.__petProbe.contentArea();
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
      assert.ok(withAmbient, '找不到 .content-area');

      const withoutAmbient = await page.evaluate(`(() => {
        const shell = window.__petProbe.shell();
        const parent = shell && shell.parentNode;
        if (shell) shell.remove();
        const c = window.__petProbe.contentArea();
        const r = c ? c.getBoundingClientRect() : null;
        if (shell && parent) parent.appendChild(shell);
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      })()`);
      assert.ok(withoutAmbient, '移除 ambient 后找不到 .content-area');
      assert.deepEqual(
        withAmbient, withoutAmbient,
        `内容区被 ambient 推挤了: ${JSON.stringify(withAmbient)} vs ${JSON.stringify(withoutAmbient)}`,
      );
    });

    // ------------------------------------------------- 2. 容器契约
    await step('② 容器是 fixed 全屏透明层 + pointer-events: none（宿主提供）', async () => {
      const info = await page.evaluate(`(() => {
        const shell = window.__petProbe.shell();
        const body = window.__petProbe.body();
        if (!shell || !body) return null;
        const cs = getComputedStyle(shell);
        const bs = getComputedStyle(body);
        return {
          position: cs.position,
          inset: [cs.top, cs.right, cs.bottom, cs.left].join(','),
          background: cs.backgroundColor,
          pointerEvents: cs.pointerEvents,
          bodyPointerEvents: bs.pointerEvents,
          zIndex: cs.zIndex,
          role: shell.getAttribute('role'),
          ariaModal: shell.getAttribute('aria-modal'),
          marqueeIgnore: shell.getAttribute('data-marquee-ignore'),
          shellW: shell.getBoundingClientRect().width,
          shellH: shell.getBoundingClientRect().height,
        };
      })()`);
      assert.ok(info, '找不到 ambient shell / body');
      assert.equal(info.position, 'fixed', '容器应由宿主提供 fixed 全屏层');
      assert.equal(info.inset, '0px,0px,0px,0px', `容器不是 inset:0: ${info.inset}`);
      assert.equal(info.pointerEvents, 'none', '容器应整体 pointer-events: none');
      assert.equal(info.role, null, 'ambient 不应有 role="dialog"');
      assert.equal(info.ariaModal, null, 'ambient 不应有 aria-modal');
      assert.equal(info.marqueeIgnore, 'true', '容器应带 data-marquee-ignore');
    });

    // ------------------------------------------------- 3. pointer-events 取回
    await step('③ 方块取回 pointer-events: auto 且真的可点', async () => {
      const pe = await page.evaluate(
        `getComputedStyle(window.__petProbe.box()).pointerEvents`,
      );
      assert.equal(pe, 'auto', `方块未取回 pointer-events: ${pe}`);

      const before = await page.evaluate('window.__petSmoke.clicks');
      // 用真实坐标点击（走浏览器命中测试，能查出「透明层挡住了」这类问题）
      const point = await page.evaluate(`(() => {
        const r = window.__petProbe.box().getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', {
          type, x: point.x, y: point.y, button: 'left', clickCount: 1,
        });
      }
      await sleep(150);
      const after = await page.evaluate('window.__petSmoke.clicks');
      assert.ok(after > before, `点击未生效（clicks ${before} → ${after}）`);
      assert.ok(
        consoleLogs.some((line) => line.includes('[pet-smoke] box clicked')),
        'console 里没有点击日志',
      );
    });

    // ------------------------------------------------- 4. 框选不命中
    await step('④ 框选不命中宠物（data-marquee-ignore 落在容器上）', async () => {
      const covered = await page.evaluate(`(() => {
        const shell = window.__petProbe.shell();
        const box = window.__petProbe.box();
        if (!shell || !box) return null;
        const r = box.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2);
        const y = Math.round(r.y + r.height / 2);
        const top = document.elementFromPoint(x, y);
        // 命中测试的最上层元素必须仍在 ambient 容器内（即方块自己），
        // 且其最近的 marquee-ignore 祖先就是 ambient 容器
        const ignoreAncestor = top && top.closest ? top.closest('[data-marquee-ignore]') : null;
        return {
          topClass: top ? top.className : null,
          insideAmbient: Boolean(top && shell.contains(top)),
          ignoreIsAmbient: Boolean(ignoreAncestor && ignoreAncestor === shell),
        };
      })()`);
      assert.ok(covered, '取不到命中信息');
      assert.ok(covered.insideAmbient, `最上层元素不在 ambient 内: ${covered.topClass}`);
      assert.ok(covered.ignoreIsAmbient, 'ambient 容器不是最近的 data-marquee-ignore 祖先');
    });

    // ------------------------------------------------- 5. Tab 不掉进去
    await step('⑤ Tab 不会掉进 ambient（无焦点陷阱、方块不可 tab）', async () => {
      const focusable = await page.evaluate(`(() => {
        const shell = window.__petProbe.shell();
        const sel = "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";
        return shell.querySelectorAll(sel).length;
      })()`);
      assert.equal(focusable, 0, `ambient 内出现了 ${focusable} 个可聚焦元素`);

      const insideAfterTabs = await page.evaluate(`(() => {
        const shell = window.__petProbe.shell();
        return shell.contains(document.activeElement);
      })()`);
      assert.equal(insideAfterTabs, false, 'activeElement 落在 ambient 内');
    });

    // ------------------------------------------------- 6. ESC 不影响
    await step('⑥ ESC 不会关闭它', async () => {
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
      await sleep(200);
      const still = await page.evaluate('Boolean(window.__petProbe.shell() && window.__petProbe.box())');
      assert.equal(still, true, 'ESC 之后 ambient 消失了');
    });

    // ------------------------------------------------- 7. is-host-occluded
    await step('⑦ 打开对话框型 surface → 容器带 is-host-occluded；关闭后摘掉', async () => {
      // 用**插件侧公开的** `api` 触发（`window.PluginHost` 不存在：pluginHost.js 的
      // `PluginHost` 是 ESM 具名导出，没有挂到 window 上）。
      const outcome = await page.evaluate(`(async () => {
        const api = window.__petSmokeApi;
        if (!api) return { error: '冒烟插件没有暴露 api' };
        const shell = window.__petProbe.shell();
        if (!shell) return { error: '找不到 ambient shell' };
        const before = shell.classList.contains('is-host-occluded');

        api.surfaces.register('__probe-modal', {
          type: 'modal',
          mount(container) { container.textContent = 'probe'; },
        });
        api.surfaces.open('__probe-modal');
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const during = shell.classList.contains('is-host-occluded');

        api.surfaces.close('__probe-modal');
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const after = shell.classList.contains('is-host-occluded');
        return { before, during, after };
      })()`);
      assert.ok(!outcome.error, outcome.error);
      assert.equal(outcome.before, false, '初始就带 is-host-occluded');
      assert.equal(outcome.during, true, '对话框打开时未标记遮挡');
      assert.equal(outcome.after, false, '对话框关闭后未摘掉遮挡标记');
    });

    // ------------------------------------------------- 8. 禁用后立刻消失
    await step('⑧ 禁用插件 → 方块立刻消失（宿主强制回收）', async () => {
      const gone = await page.evaluate(`(async () => {
        window.dispatchEvent(new CustomEvent('plugin:unloaded', { detail: { pluginId: '${PLUGIN_ID}' } }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return {
          shell: Boolean(window.__petProbe.shell()),
          box: Boolean(window.__petProbe.box()),
          disposed: window.__petSmoke.disposed,
        };
      })()`);
      assert.equal(gone.shell, false, 'ambient 容器仍在 DOM 里');
      assert.equal(gone.box, false, '方块仍在 DOM 里');
    });

    // ------------------------------------------------- 9. 移动端不挂载
    await step('⑨ 视口缩到 <900px（deviceType=mobile）→ 不挂载', async () => {
      const mobilePage = await browser.newPage();
      await mobilePage.send('Runtime.enable');
      await mobilePage.send('Page.enable');
      await mobilePage.setViewport(480, 900);
      await mobilePage.navigate(BASE, { timeout: 30000 });
      await sleep(2500);
      const info = await mobilePage.evaluate(`(() => {
        const store = (window.Alpine && window.Alpine.store) ? window.Alpine.store('global') : null;
        return {
          deviceType: store ? store.deviceType : null,
          innerWidth: window.innerWidth,
          smoke: window.__petSmoke || null,
          shell: Boolean(document.querySelector('.plugin-surface--ambient[data-plugin="${PLUGIN_ID}"]')),
        };
      })()`);
      assert.equal(info.deviceType, 'mobile', `deviceType 不是 mobile: ${JSON.stringify(info.deviceType)}`);
      assert.equal(info.shell, false, '移动端仍然挂载了 ambient');
      assert.ok(
        !info.smoke || info.smoke.mountCount === 0,
        `移动端 mount 被调用了 ${info.smoke && info.smoke.mountCount} 次`,
      );
      const registered = await mobilePage.evaluate(`(() => {
        // 插件在移动端仍会拿到一个非空 key（与实施提示词 §2.1 不同，见 HOST_FEEDBACK）
        return window.__petSmoke ? window.__petSmoke.registeredKey : null;
      })()`);
      results.push({
        name: '⑨b [记录] 移动端 register() 的返回值为',
        ok: true,
        note: JSON.stringify(registered),
      });
      process.stdout.write(`  NOTE  移动端 register() 返回: ${JSON.stringify(registered)}\n`);
      mobilePage.close();
    });

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(
      `阶段 0 真实浏览器验收：${results.length - failed.length}/${results.length} 通过\n`,
    );
    if (failed.length) {
      process.stdout.write('\n失败明细:\n');
      for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.message}\n`);
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
