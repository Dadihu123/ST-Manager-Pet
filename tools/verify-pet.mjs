/**
 * 真实浏览器验收：宠物插件（阶段 2–5 的判定项）。
 *
 * 前置：影子宿主已装好 stm-pet 并在 PET_SANDBOX_PORT（默认 5099）上运行：
 *
 *   python tools/host_sandbox.py --create --install .
 *   (cd <sandbox> && python app.py)
 *   node tools/verify-pet.mjs
 *
 * 全部断言基于**真实渲染结果**（读 computed style / 元素尺寸 / rAF 计数），
 * 不做源码字符串检查——那些已经在 pytest 里做过了。
 */

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

/** 注入一小段帮助函数到页面里，后续用例复用。 */
const HELPERS = `
  window.__pet = {
    root: () => document.querySelector('[data-plugin="stm-pet"].pet-root'),
    shell: () => document.querySelector('.plugin-surface--ambient[data-plugin="stm-pet"]'),
    sprite: () => {
      const root = window.__pet.root();
      return root ? root.querySelector('.pet-sprite') : null;
    },
    view: () => window.__petView || null,
    transform: () => {
      const root = window.__pet.root();
      return root ? root.style.transform : '';
    },
    pos: () => {
      const root = window.__pet.root();
      if (!root) return null;
      const r = root.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    framePos: () => {
      const sprite = window.__pet.sprite();
      return sprite ? getComputedStyle(sprite).backgroundPosition : '';
    },
    bgImage: () => {
      const sprite = window.__pet.sprite();
      return sprite ? getComputedStyle(sprite).backgroundImage : '';
    },
    /** 数一段时间内真实发生的 rAF 次数。 */
    countFrames: async (ms) => {
      let count = 0;
      const start = performance.now();
      await new Promise((resolve) => {
        const loop = (now) => {
          count += 1;
          if (now - start >= ms) resolve();
          else requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      return count;
    },
  };
  true
`;

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Log.enable').catch(() => {});
    const consoleErrors = [];
    page.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'warning') {
        const text = (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        consoleErrors.push(`${params.type}: ${text}`);
      }
    });
    page.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(`exception: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`);
    });

    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(window.__petProbeReady) || Boolean(document.querySelector('[data-plugin="stm-pet"].pet-root'))`, {
      timeout: 20000, label: '宠物挂载',
    });
    await sleep(600);
    await page.evaluate(HELPERS);

    // ------------------------------------------------ ① 出现在屏幕上
    const box = await page.evaluate('window.__pet.pos()');
    record(
      '① 宠物出现在屏幕上（桌面端）',
      Boolean(box && box.w > 0 && box.h > 0),
      box ? `位置 ${JSON.stringify(box)}` : '找不到 .pet-root',
    );

    // ------------------------------------------------ ② 容器契约
    const shell = await page.evaluate(`(() => {
      const el = window.__pet.shell();
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        position: cs.position,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        role: el.getAttribute('role'),
        parentW: el.getBoundingClientRect().width,
        viewportW: window.innerWidth,
      };
    })()`);
    record(
      '② 常驻容器由宿主提供（fixed 全屏 + pointer-events none + 无 role）',
      Boolean(shell && shell.position === 'fixed'
        && shell.pointerEvents === 'none' && shell.role === null),
      shell ? JSON.stringify(shell) : '找不到 container',
    );

    // ------------------------------------------------ ③ 插件自己不写 fixed
    const petStyle = await page.evaluate(`(() => {
      const root = window.__pet.root();
      const cs = getComputedStyle(root);
      return { position: cs.position, pointerEvents: cs.pointerEvents };
    })()`);
    record(
      '③ 宠物本体是 absolute 且取回 pointer-events: auto',
      petStyle.position === 'absolute' && petStyle.pointerEvents === 'auto',
      JSON.stringify(petStyle),
    );

    // ------------------------------------------------ ④ 帧动画推进
    const frames = [];
    for (let index = 0; index < 6; index += 1) {
      frames.push(await page.evaluate('window.__pet.framePos()'));
      await sleep(200);
    }
    const distinct = new Set(frames);
    record(
      '④ 帧动画在推进（background-position 变化）',
      distinct.size >= 2,
      `采样 ${frames.length} 次，观察到 ${distinct.size} 个不同帧位: ${[...distinct].slice(0, 4).join(' | ')}`,
    );

    // ------------------------------------------------ ⑤ 用的是 spritesheet 而非换 src
    //
    // 不写死形象 id：默认形象由 `store.DEFAULT_PET_ID` 决定（小满），
    // 写死 id 会让「换掉内置形象」把这条断言变成假失败。
    const bg = await page.evaluate('window.__pet.bgImage()');
    record(
      '⑤ 用 spritesheet + background-position（不是换 <img src>）',
      bg.includes('/frame/') && bg.includes('/idle'),
      bg.slice(0, 120),
    );

    // ------------------------------------------------ ⑥ rAF 真的在跑
    const busyFrames = await page.evaluate('window.__pet.countFrames(1000)');
    record(
      '⑥ 循环动画期间 rAF 在运行',
      busyFrames > 10,
      `1 秒内 ${busyFrames} 帧`,
    );

    // ------------------------------------------------ ⑦ reducedMotion → 停绘
    // 通过 CDP 模拟系统的 prefers-reduced-motion，宿主会经 onState 推送
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await sleep(1200);
    const reducedInfo = await page.evaluate(`(() => {
      const root = window.__pet.root();
      const sprite = window.__pet.sprite();
      return {
        throttle: root ? root.dataset.petThrottle : '',
        hasStaticClass: root ? root.classList.contains('is-static-motion') : false,
        spriteAnimation: sprite ? getComputedStyle(sprite).animationName : '',
      };
    })()`);
    // 同一个帧位持续 = 帧动画停了
    const reducedFrames = [];
    for (let index = 0; index < 4; index += 1) {
      reducedFrames.push(await page.evaluate('window.__pet.framePos()'));
      await sleep(250);
    }
    const frozen = new Set(reducedFrames).size === 1;
    record(
      '⑦ reducedMotion → 帧动画**停止**（不是降速）',
      frozen && reducedInfo.hasStaticClass,
      `帧位固定=${frozen}，class=${reducedInfo.hasStaticClass}，reason=${reducedInfo.throttle}`,
    );

    // ------------------------------------------------ ⑧ 关闭 reducedMotion 恢复
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(1200);
    const resumedFrames = [];
    for (let index = 0; index < 6; index += 1) {
      resumedFrames.push(await page.evaluate('window.__pet.framePos()'));
      await sleep(200);
    }
    record(
      '⑧ 关闭 reducedMotion 后动画恢复',
      new Set(resumedFrames).size >= 2,
      `${new Set(resumedFrames).size} 个不同帧位`,
    );

    // ------------------------------------------------ ⑨ 页面不可见 → 停 rAF
    await page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
    // 用 Page.setWebLifecycleState 模拟后台（CDP 提供的可见性切换手段）
    await page.send('Emulation.setIdleOverride', { isUserActive: false, isScreenUnlocked: false }).catch(() => {});
    await page.evaluate(`(() => {
      // 直接改 visibilityState 无法触发原生事件，因此改用宿主认识的那条路径：
      // 派发 visibilitychange 并让 document.visibilityState 返回 hidden
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    })()`);
    await sleep(1200);
    const hiddenInfo = await page.evaluate(`(() => {
      const root = window.__pet.root();
      return { throttle: root ? root.dataset.petThrottle : '', hasShellOccluded: (() => {
        const shell = window.__pet.shell();
        return shell ? shell.classList.contains('is-host-occluded') : false;
      })() };
    })()`);
    const hiddenFrames = [];
    for (let index = 0; index < 4; index += 1) {
      hiddenFrames.push(await page.evaluate('window.__pet.framePos()'));
      await sleep(250);
    }
    record(
      '⑨ 页面不可见 → 动画停止（省电）',
      new Set(hiddenFrames).size === 1 || hiddenInfo.hasShellOccluded,
      `帧位固定=${new Set(hiddenFrames).size === 1}，occluded=${hiddenInfo.hasShellOccluded}，reason=${hiddenInfo.throttle}`,
    );
    // 恢复可见
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    })()`);
    await sleep(800);

    // ------------------------------------------------ ⑩ 拖拽跟手
    //
    // 用**真实 CDP 输入事件**驱动（走浏览器的命中测试），不用 `dispatchEvent`
    // 合成事件——后者绕过命中测试，测不出「pointer-events 没取回」「透明层挡住」
    // 这类真实故障。第一版用了合成事件，失败原因与真实故障完全不同（误导）。
    const beforeDrag = await page.evaluate('window.__pet.pos()');
    const startX = Math.round(beforeDrag.x + beforeDrag.w / 2);
    const startY = Math.round(beforeDrag.y + beforeDrag.h / 2);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1,
    });
    await sleep(50);
    const dragAction = await page.evaluate(`window.__pet.root().dataset.petAction`);
    for (let step = 1; step <= 6; step += 1) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: startX + step * 40,
        y: startY - step * 18,
        button: 'left',
        buttons: 1,
      });
      await sleep(25);
    }
    const afterDrag = await page.evaluate('window.__pet.pos()');
    record(
      '⑩ 拖拽跟手（真实指针事件驱动宠物移动）',
      dragAction === 'drag' && (afterDrag.x - beforeDrag.x) > 100,
      `action=${dragAction}，dx=${(afterDrag.x - beforeDrag.x).toFixed(1)}，dy=${(afterDrag.y - beforeDrag.y).toFixed(1)}`,
    );

    // ------------------------------------------------ ⑪ 松手后下坠
    const releaseX = startX + 240;
    const releaseY = startY - 108;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: releaseX, y: releaseY, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(120);
    const fallingAction = await page.evaluate(`window.__pet.root().dataset.petAction`);
    const yAtStart = await page.evaluate('window.__pet.pos().y');
    await sleep(600);
    const midFall = await page.evaluate('window.__pet.pos().y');
    record(
      '⑪ 松手后进入下落态（fall）',
      fallingAction === 'fall',
      `action=${fallingAction}，y: ${yAtStart.toFixed(0)} → ${midFall.toFixed(0)}`,
    );

    // ------------------------------------------------ ⑫ 最终停在地面
    await sleep(2500);
    const restInfo = await page.evaluate(`(() => {
      const pos = window.__pet.pos();
      return { y: pos.y, bottom: pos.y + pos.h, viewportH: window.innerHeight, action: window.__pet.root().dataset.petAction };
    })()`);
    record(
      '⑫ 最终落在地面附近（不会飞到屏幕外）',
      Math.abs(restInfo.bottom - restInfo.viewportH) < 30,
      JSON.stringify(restInfo),
    );

    // ------------------------------------------------ ⑬ 不推挤内容区
    const contentOk = await page.evaluate(`(() => {
      const content = document.querySelector('.content-area');
      if (!content) return { skipped: true };
      const withPet = content.getBoundingClientRect();
      const shell = window.__pet.shell();
      const parent = shell.parentNode;
      shell.remove();
      const without = content.getBoundingClientRect();
      parent.appendChild(shell);
      return {
        same: withPet.x === without.x && withPet.width === without.width
          && withPet.height === without.height,
        withPet: { x: withPet.x, w: withPet.width },
        without: { x: without.x, w: without.width },
      };
    })()`);
    record(
      '⑬ 不推挤内容区布局',
      contentOk.skipped || contentOk.same,
      JSON.stringify(contentOk),
    );

    // ------------------------------------------------ ⑭ 不吃焦点 / 不进 Tab
    const focusInfo = await page.evaluate(`(() => {
      const shell = window.__pet.shell();
      const focusables = shell.querySelectorAll(
        "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      return { count: focusables.length, ariaHidden: window.__pet.root().getAttribute('aria-hidden') };
    })()`);
    record(
      '⑭ 宠物不进 Tab 序（无焦点陷阱）',
      focusInfo.count === 0 && focusInfo.ariaHidden === 'true',
      JSON.stringify(focusInfo),
    );

    // ------------------------------------------------ ⑮ ESC 不影响
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await sleep(300);
    const aliveAfterEsc = await page.evaluate('Boolean(window.__pet.root())');
    record('⑮ ESC 不会关闭宠物', aliveAfterEsc, '');

    // ------------------------------------------------ ⑯ 设置入口存在
    const settingsEntry = await page.evaluate(`(async () => {
      const data = await (await fetch('/api/plugins/stm-pet/pets')).json();
      return { ok: data.success, count: (data.items || []).length, active: data.activePetId };
    })()`);
    record(
      '⑯ 后端接口在真实宿主里可用',
      settingsEntry.ok && settingsEntry.count >= 1,
      JSON.stringify(settingsEntry),
    );

    // ------------------------------------------------ ⑰ 禁用后立刻消失
    const gone = await page.evaluate(`(async () => {
      window.dispatchEvent(new CustomEvent('plugin:unloaded', { detail: { pluginId: 'stm-pet' } }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { root: Boolean(window.__pet.root()), shell: Boolean(window.__pet.shell()) };
    })()`);
    record(
      '⑰ 禁用插件 → 宠物立刻消失且 DOM 干净',
      !gone.root && !gone.shell,
      JSON.stringify(gone),
    );

    // ------------------------------------------------ ⑱ 无控制台错误
    const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
    record(
      '⑱ 运行期无未捕获异常 / 错误日志',
      relevant.length === 0,
      relevant.slice(0, 4).join('\n        '),
    );

    // ------------------------------------------------ ⑲ 移动端不挂载
    const mobile = await browser.newPage();
    await mobile.send('Runtime.enable');
    await mobile.send('Page.enable');
    await mobile.setViewport(480, 900);
    await mobile.navigate(BASE, { timeout: 30000 });
    await sleep(3000);
    const mobileInfo = await mobile.evaluate(`(() => {
      const store = (window.Alpine && window.Alpine.store) ? window.Alpine.store('global') : null;
      return {
        deviceType: store ? store.deviceType : null,
        petRoot: Boolean(document.querySelector('[data-plugin="stm-pet"].pet-root')),
        ambientShell: Boolean(document.querySelector('.plugin-surface--ambient[data-plugin="stm-pet"]')),
      };
    })()`);
    record(
      '⑲ 移动端不挂载 ambient（宠物不出现）',
      mobileInfo.deviceType === 'mobile' && !mobileInfo.petRoot && !mobileInfo.ambientShell,
      JSON.stringify(mobileInfo),
    );
    mobile.close();

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`宠物真实浏览器验收：${results.length - failed.length}/${results.length} 通过\n`);
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
