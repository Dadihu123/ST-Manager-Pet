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
    //
    // ⚠️ 2026-10 起 `idle` 默认是「平时静止 + 随机触发」（见 README §3.7），
    // 因此**不能**再靠采样 idle 来断言「帧动画在推进」——那会永远是同一个帧位。
    // 正确做法：主动触发一次 idle 小动作（`pokeIdle`），在它播的那一轮里采样。
    //
    // `pokeIdle()` 返回 false 也可能是**正常**的：说明采样时刚好有一次
    // 随机触发已经在播了（启动后 6~18 秒会自己触发一次，而前面的判定要跑几秒）。
    // 那种情况下帧位同样在变，因此两种情形都算通过——
    // 否则这条判定会随「脚本跑得快不快」随机失败。
    const poke = await page.evaluate(`(() => {
      const view = window.__petView;
      if (!view) return false;
      if (view.idleBursting) return true;   // 已经在播，同样能观察到帧推进
      return view.pokeIdle();
    })()`);
    const frames = [];
    for (let index = 0; index < 8; index += 1) {
      frames.push(await page.evaluate('window.__pet.framePos()'));
      await sleep(120);
    }
    const distinct = new Set(frames);
    record(
      '④ 帧动画在推进（触发一次 idle 小动作后 background-position 变化）',
      poke === true && distinct.size >= 2,
      `pokeIdle=${poke}；采样 ${frames.length} 次，观察到 ${distinct.size} 个不同帧位: ${[...distinct].slice(0, 4).join(' | ')}`,
    );

    // ④b idle 平时**静止**（这是本轮的核心行为变更）
    //
    // 触发间隔最小 6 秒，因此连续采样 3 秒应当看不到帧位变化。
    //
    // ⚠️ 必须先等 ④ 触发的那一轮播完：idle 小动作一轮约 1.6 秒，
    // 而 ④ 的采样只有约 1 秒，直接接着采样会拍到还在播的那一轮（假失败）。
    await page.evaluate(`(async () => {
      const view = window.__petView;
      const deadline = performance.now() + 5000;
      while (view && view.idleBursting && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return true;
    })()`);
    // 再等一小会儿，确保回到「静止」而不是刚播完的收尾帧
    await sleep(400);
    const idleStill = [];
    for (let index = 0; index < 10; index += 1) {
      idleStill.push(await page.evaluate('window.__pet.framePos()'));
      await sleep(300);
    }
    record(
      '④b idle 平时静止（3 秒内帧位不变，不再是时刻触发）',
      new Set(idleStill).size === 1,
      `观察到 ${new Set(idleStill).size} 个不同帧位`,
    );

    // ------------------------------------------------ ⑤ 用的是 spritesheet 而非换 src
    //
    // 不写死形象 id：默认形象由 `store.DEFAULT_PET_ID` 决定（小满），
    // 写死 id 会让「换掉内置形象」把这条断言变成假失败。
    //
    // ⚠️ 2026-10 起「静止」画的是**标准图像**（`/frame/<pet>/still`），
    // 不再是 `idle` 的首帧——因为 idle 可以挂两套动画（「张望」），
    // 沿用「上一次抽到的那一套」会卡在一个抬头姿势上（用户报的怪现象）。
    // 因此这里接受 `still` 或 `idle`（没有标准图像的老包会回落到 idle）。
    const bg = await page.evaluate('window.__pet.bgImage()');
    record(
      '⑤ 用 spritesheet + background-position（不是换 <img src>）',
      bg.includes('/frame/') && (bg.includes('/still') || bg.includes('/idle')),
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
    // 同样要主动触发（idle 平时静止，见 ④ 的说明）
    await page.evaluate(`(() => {
      const view = window.__petView;
      if (view) view.pokeIdle();
      return true;
    })()`);
    const resumedFrames = [];
    for (let index = 0; index < 8; index += 1) {
      resumedFrames.push(await page.evaluate('window.__pet.framePos()'));
      await sleep(120);
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
    // ⚠️ 2026-10 起「按下」不再立刻进拖拽态（见 README §3.8）：
    // 0.5 秒内松手且位移小 = 点击。因此这里按下 50ms 时读到的应当是 `idle`
    // （手势处于 `pending`），而不是 `drag`。
    const pendingAction = await page.evaluate(`window.__pet.root().dataset.petAction`);
    const pendingPhase = await page.evaluate(`window.__petView ? window.__petView.gesturePhase : ''`);
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
    // 位移远超阈值 → 应当**立刻**升级成拖拽（不必等满 0.5 秒）
    const dragAction = await page.evaluate(`window.__pet.root().dataset.petAction`);
    const afterDrag = await page.evaluate('window.__pet.pos()');
    record(
      '⑩ 拖拽跟手（真实指针事件驱动宠物移动）',
      dragAction === 'drag' && (afterDrag.x - beforeDrag.x) > 100,
      `按下 50ms 时 action=${pendingAction} / phase=${pendingPhase}（应为 pending）；`
      + `移动后 action=${dragAction}，dx=${(afterDrag.x - beforeDrag.x).toFixed(1)}，dy=${(afterDrag.y - beforeDrag.y).toFixed(1)}`,
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

    // ------------------------------------------------ ⑪b 空中不串其他动画
    //
    // 用户报障：「拖拽和坠落动画有时会被其他动画打断，然后在空中播放其他动画，
    // 例如左右移动，例如闲置，甚至还出现了在空中多个动画交替出现的情况」。
    //
    // 这里在下落途中**高频采样**动作名：只要出现过任何非 fall 的动作，
    // 就说明空中被别的动画抢走了。采样要够密——串动作往往只持续一两帧。
    const airSamples = await page.evaluate(`(async () => {
      const seen = [];
      const start = performance.now();
      while (performance.now() - start < 900) {
        seen.push(window.__pet.root().dataset.petAction);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { seen: [...new Set(seen)], count: seen.length };
    })()`);
    const airClean = airSamples.seen.every((name) => name === 'fall' || name === 'land' || name === 'idle');
    record(
      '⑪b 下坠途中不串其他动画（只有 fall，落地后才是 land / idle）',
      airClean && airSamples.seen.includes('fall'),
      `采样 ${airSamples.count} 次，出现的动作: ${airSamples.seen.join(',')}`,
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
    // 落地之后必须回到 idle。
    //
    // ⚠️ 用户报障的衍生现象：「如果不是以坠落动画落得地，那么就不会出现落地动画」。
    // 根因是落地判定只看「冲击够不够重」（>60px/s），轻放就永远出不了 fall——
    // 表现是**贴着地面一直播下落动画**，而且 rAF 永远停不下来（省电失效）。
    // 所以这里不能只查位置，还要查它真的收尾了。
    record(
      '⑫b 落地后回到 idle（轻放也能收尾，不会一直播下落）',
      restInfo.action === 'idle',
      `落点 bottom=${restInfo.bottom.toFixed(1)} / 视口 ${restInfo.viewportH}，action=${restInfo.action}`,
    );

    // ------------------------------------------------ ⑫c 贴地轻放也要收尾
    //
    // 这是用户报障衍生现象的**精确复现**：把宠物拖到离地面很近的地方松手。
    //
    // 旧实现的落地判定要求冲击 > 60px/s。从这么低的地方放下，落地速度不足，
    // 于是 `justLanded` 为假、状态机永远停在 `fall`——既没有落地动作，
    // rAF 也永远停不下来（`fall` 是「必须继续跑」的状态）。
    // 现在改用「离地→触地」的状态翻转（`touchedDown`）判落地。
    const lowDrop = await page.evaluate(`(async () => {
      // 先确保它站在地上
      await new Promise((r) => setTimeout(r, 300));
      const before = window.__pet.pos();
      return {
        cx: Math.round(before.x + before.w / 2),
        groundY: Math.round(before.y + before.h / 2),
      };
    })()`);
    // 用真实指针事件把它拎到贴近地面处再松手
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: lowDrop.cx,
      y: lowDrop.groundY,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sleep(60);
    // 移动到离地面只有十几像素的地方（落地冲击必然很小）
    const hoverY = Math.round(lowDrop.groundY - 14);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: lowDrop.cx + 60, y: hoverY, button: 'left', buttons: 1,
    });
    await sleep(60);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: lowDrop.cx + 60,
      y: hoverY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    // 给足时间：下坠 + 落地动作 + 收尾
    await sleep(2200);
    const lowDropResult = await page.evaluate(`(() => {
      const pos = window.__pet.pos();
      return {
        action: window.__pet.root().dataset.petAction,
        bottom: pos.y + pos.h,
        viewportH: window.innerHeight,
      };
    })()`);
    record(
      '⑫c 贴着地面轻放也能落地收尾（冲击很小也不卡在 fall）',
      lowDropResult.action === 'idle'
        && Math.abs(lowDropResult.bottom - lowDropResult.viewportH) < 30,
      `action=${lowDropResult.action}，bottom=${lowDropResult.bottom.toFixed(1)} / 视口 ${lowDropResult.viewportH}`,
    );

    // ------------------------------------------------ ⑫d 落地动作真的播了
    //
    // 用户报障：「如果不是以坠落动画落得地，那么就不会出现落地动画」
    // （他自己说这算衍生现象）。根因修掉之后，**任何**下坠结束都要播 land——
    // 而且不能只靠 `justLanded`（轻放时冲击不足，它不会置位）。
    //
    // ⚠️ 必须**重新读一次当前位置**再抓：上一段把它挪到了别处，
    // 复用旧坐标会按在空气上（按下不命中宠物 → 根本没进拖拽态），
    // 于是这条断言会莫名其妙地失败，而失败原因看起来像「落地动作没播」。
    // 这是验收脚本自身最容易踩的坑。
    const landStart = await page.evaluate(`(async () => {
      await new Promise((r) => setTimeout(r, 400));
      const pos = window.__pet.pos();
      return {
        cx: Math.round(pos.x + pos.w / 2),
        cy: Math.round(pos.y + pos.h / 2),
      };
    })()`);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: landStart.cx, y: landStart.cy, button: 'left', buttons: 1, clickCount: 1,
    });
    await sleep(60);
    // 拎到高处（保证有足够的下坠距离）
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: landStart.cx, y: Math.max(60, landStart.cy - 260), button: 'left', buttons: 1,
    });
    await sleep(60);
    // 边落边采样：land 只播约 320ms，等落地后再读往往已经回 idle 了
    const landPromise = page.evaluate(`(async () => {
      const seen = [];
      const start = performance.now();
      while (performance.now() - start < 3000) {
        const action = window.__pet.root().dataset.petAction;
        if (seen[seen.length - 1] !== action) seen.push(action);
        if (seen.includes('land')) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return seen;
    })()`);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: landStart.cx,
      y: Math.max(60, landStart.cy - 260),
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    const landSeen = await landPromise;
    record(
      '⑫d 下坠结束时播了落地动作（land 真的出现，不是直接跳 idle）',
      landSeen.includes('land'),
      `观察到的动作序列: ${landSeen.join(' → ')}`,
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
