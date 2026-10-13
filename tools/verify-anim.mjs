/**
 * 真实浏览器验收：本轮 7 项优化里的**行为类**判定（1 / 3 / 5 / 6 / 7）。
 *
 * 前置：影子宿主已装好 stm-pet 并在 PET_SANDBOX_PORT（默认 5099）上运行：
 *
 *   python tools/host_sandbox.py --create --install .
 *   (cd <sandbox> && python app.py)
 *   node tools/verify-anim.mjs
 *
 * 全部断言基于**真实渲染结果**（读 dataset / computed style / rAF 计数），
 * 不做源码字符串检查——那些在 pytest 里做过了。
 */

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

const HELPERS = `
  window.__p = {
    root: () => document.querySelector('[data-plugin="stm-pet"].pet-root'),
    sprite: () => {
      const root = window.__p.root();
      return root ? root.querySelector('.pet-sprite') : null;
    },
    framePos: () => {
      const sprite = window.__p.sprite();
      return sprite ? getComputedStyle(sprite).backgroundPosition : '';
    },
    bgImage: () => {
      const sprite = window.__p.sprite();
      return sprite ? getComputedStyle(sprite).backgroundImage : '';
    },
    info: () => {
      const root = window.__p.root();
      if (!root) return null;
      return {
        action: root.dataset.petAction,
        variant: root.dataset.petVariant,
        speed: root.dataset.petAnimSpeed,
        throttle: root.dataset.petThrottle,
      };
    },
    pos: () => {
      const root = window.__p.root();
      if (!root) return null;
      const r = root.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
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
    /** 采样一段时间的帧位，返回不同帧位的个数。 */
    sampleFrames: async (ms, step = 120) => {
      const seen = [];
      const rounds = Math.max(1, Math.round(ms / step));
      for (let index = 0; index < rounds; index += 1) {
        seen.push(window.__p.framePos());
        await new Promise((r) => setTimeout(r, step));
      }
      return { distinct: new Set(seen).size, samples: seen };
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
    const consoleErrors = [];
    page.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push((params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    page.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(`exception: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`);
    });

    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(document.querySelector('[data-plugin="stm-pet"].pet-root'))`, {
      timeout: 20000, label: '宠物挂载',
    });
    await sleep(800);
    await page.evaluate(HELPERS);

    // ============================================ ① idle 平时静止（随机触发）
    //
    // 用户报障：idle 动画「时刻触发，看起来有点鬼畜」。
    // 正确行为是**平时静止**，每隔一段随机时间才动一下。
    // 判定：连续采样 3 秒，帧位应当**几乎不变**（触发间隔最小 6 秒）。
    const idleSample = await page.evaluate('window.__p.sampleFrames(3000, 250)');
    record(
      '① idle 平时静止（3 秒内帧位基本不变）',
      idleSample.distinct <= 2,
      `观察到 ${idleSample.distinct} 个不同帧位: ${idleSample.samples.slice(0, 6).join(' | ')}`,
    );

    // 静止期间宠物的 rAF 循环应当**真的停了**（省电，也是「不鬼畜」的物理原因）。
    //
    // 必须读 `view.running` 而不是数 rAF 帧：`countFrames` 自己那个 rAF 循环
    // 是按显示器刷新率跑的，跟宠物的循环无关，数它只会恒得 ~120。
    const idleLoop = await page.evaluate(`(() => {
      const view = window.__petView;
      return {
        running: view ? view.running : null,
        action: view ? view.action : '',
        bursting: view ? view.idleBursting : null,
      };
    })()`);
    record(
      '① idle 静止期间宠物的 rAF 循环已停（省电）',
      idleLoop.running === false && idleLoop.bursting === false,
      JSON.stringify(idleLoop),
    );

    // ============================================ ② idle 会随机触发
    //
    // 触发间隔默认 6~18 秒，等 22 秒看它有没有自己动过一次。
    // 判定用「帧位出现过变化」而不是「现在正在动」——触发是瞬时的。
    const burst = await page.evaluate(`(async () => {
      const seen = new Set();
      let action = '';
      const start = performance.now();
      while (performance.now() - start < 22000) {
        seen.add(window.__p.framePos());
        if (window.__p.info().action === 'idle') action = 'idle';
        await new Promise((r) => setTimeout(r, 200));
      }
      return { distinct: seen.size, action };
    })()`);
    record(
      '② idle 会在随机时间后自己动一下（22 秒内）',
      burst.distinct >= 2,
      `22 秒内观察到 ${burst.distinct} 个不同帧位`,
    );

    // ============================================ ③ sleep 不受 idle 触发影响
    //
    // 把打盹等待临时改成 10 秒（宿主表单允许的最小值），等它睡着，
    // 然后确认：状态是 sleep、且**没有** idle 触发把帧位改掉。
    await page.evaluate(`(async () => {
      const api = window.__petApi;
      if (api && api.setConfig) await api.setConfig({ sleep_after: 10 });
      return true;
    })()`);
    // 通过配置变更事件让插件重新读取（等价于用户在宿主表单里改完）
    await page.evaluate(`(() => {
      window.dispatchEvent(new CustomEvent('plugin:config-changed', {
        detail: { pluginId: 'stm-pet', config: { sleep_after: 10 } },
      }));
      return true;
    })()`);
    await sleep(1000);

    // 用诊断句柄直接触发一次「长时间无互动」——比真等 10 秒更稳。
    // 状态机是真实的那一个，因此这仍然是真实路径。
    await page.evaluate(`(() => {
      const view = window.__petView;
      if (view) view.machine.sleep({ now: performance.now() });
      return true;
    })()`);
    await sleep(2500);
    const sleepInfo = await page.evaluate(`(() => {
      const root = window.__p.root();
      const view = window.__petView;
      return {
        action: root ? root.dataset.petAction : '',
        state: view ? view.state : '',
        idleBursting: view ? view.idleBursting : null,
        mode: view ? view.idleMode : '',
      };
    })()`);
    const sleepSample = await page.evaluate('window.__p.sampleFrames(3000, 250)');
    record(
      '③ 睡着后进入 sleep，且 idle 触发不干扰',
      sleepInfo.action === 'sleep' && sleepInfo.state === 'sleep' && sleepInfo.idleBursting === false,
      `action=${sleepInfo.action} state=${sleepInfo.state} idleBurst=${sleepInfo.idleBursting} mode=${sleepInfo.mode}；` +
      `sleep 期间 ${sleepSample.distinct} 个帧位（呼吸动画，允许变化）`,
    );

    // 唤醒后回到 idle，且 idle 模式仍是 random
    await page.evaluate(`(() => {
      const view = window.__petView;
      if (view) view.machine.wake({ now: performance.now() });
      return true;
    })()`);
    await sleep(1200);
    const awakeInfo = await page.evaluate('window.__p.info()');
    record(
      '③ 唤醒后回到 idle（random 模式）',
      awakeInfo.action === 'idle',
      JSON.stringify(awakeInfo),
    );

    // ============================================ ④ 点击可单独触发（不飞走）
    //
    // 用户报障：「只要点击就会触发拖拽，让宠物飞起来」。
    // 判定：一次**短促**的按下-松开（< 0.5s、无位移）之后，
    // 宠物必须还在原地，且动作是 click（或刚播完回到 idle）。
    const before = await page.evaluate('window.__p.pos()');
    const cx = Math.round(before.x + before.w / 2);
    const cy = Math.round(before.y + before.h / 2);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1,
    });
    await sleep(80);
    const midGesture = await page.evaluate(`(() => {
      const view = window.__petView;
      const root = window.__p.root();
      return {
        phase: view ? view.gesturePhase : '',
        action: root ? root.dataset.petAction : '',
      };
    })()`);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(120);
    const afterClick = await page.evaluate(`(() => {
      const root = window.__p.root();
      const pos = window.__p.pos();
      return { action: root ? root.dataset.petAction : '', pos };
    })()`);
    const moved = Math.abs(afterClick.pos.x - before.x);
    record(
      '④ 短按 = 点击：不进入拖拽态，宠物不飞走',
      midGesture.phase === 'pending' && moved < 12,
      `按下 80ms 时 phase=${midGesture.phase}（应为 pending）、action=${midGesture.action}；` +
      `松手后 action=${afterClick.action}、位移 ${moved.toFixed(1)}px`,
    );

    // 点击动画确实播出来了
    const clickAction = afterClick.action;
    record(
      '④ 点击动作被触发（click 或 click-hop 之后的 fall/land/idle）',
      ['click', 'fall', 'land', 'idle'].includes(clickAction),
      `action=${clickAction}`,
    );

    // ============================================ ⑤ 长按 0.5s 才进入拖拽
    const beforeHold = await page.evaluate('window.__p.pos()');
    const hx = Math.round(beforeHold.x + beforeHold.w / 2);
    const hy = Math.round(beforeHold.y + beforeHold.h / 2);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: hx, y: hy, button: 'left', buttons: 1, clickCount: 1,
    });
    await sleep(200);
    const earlyPhase = await page.evaluate('window.__petView ? window.__petView.gesturePhase : ""');
    await sleep(500);
    const latePhase = await page.evaluate('window.__petView ? window.__petView.gesturePhase : ""');
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: hx, y: hy, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(300);
    record(
      '⑤ 按住不动：0.2s 仍是待定，0.7s 已进入拖拽',
      earlyPhase === 'pending' && latePhase === 'drag',
      `0.2s → ${earlyPhase}（应 pending）；0.7s → ${latePhase}（应 drag）`,
    );

    // ============================================ ⑥ 明显位移立刻进入拖拽
    //
    // 用户明确在拖时不该再等 0.5 秒。
    const beforeFast = await page.evaluate('window.__p.pos()');
    const fx = Math.round(beforeFast.x + beforeFast.w / 2);
    const fy = Math.round(beforeFast.y + beforeFast.h / 2);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: fx, y: fy, button: 'left', buttons: 1, clickCount: 1,
    });
    await sleep(40);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: fx + 60, y: fy - 40, button: 'left', buttons: 1,
    });
    await sleep(80);
    const fastPhase = await page.evaluate(`(() => {
      const view = window.__petView;
      const root = window.__p.root();
      return { phase: view ? view.gesturePhase : '', action: root ? root.dataset.petAction : '' };
    })()`);
    const duringDrag = await page.evaluate('window.__p.pos()');
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: fx + 60, y: fy - 40, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(200);
    record(
      '⑥ 移动超过阈值 → 立刻进入拖拽并跟手',
      fastPhase.phase === 'drag' && fastPhase.action === 'drag'
        && (duringDrag.x - beforeFast.x) > 30,
      `phase=${fastPhase.phase} action=${fastPhase.action} dx=${(duringDrag.x - beforeFast.x).toFixed(1)}`,
    );

    // ============================================ ⑦ 动画速度倍率生效
    const speedInfo = await page.evaluate(`(() => {
      const view = window.__petView;
      const root = window.__p.root();
      return {
        view: view ? view.animSpeed : null,
        attr: root ? root.dataset.petAnimSpeed : '',
      };
    })()`);
    record(
      '⑦ 动画速度倍率已生效并暴露（animSpeed / data-pet-anim-speed）',
      Number(speedInfo.view) > 0 && speedInfo.attr !== '',
      JSON.stringify(speedInfo),
    );

    // ============================================ ⑧ 非均匀帧时长（frameMs）
    //
    // 后端把 `frameMs` 发给前端，前端按它推进。这里直接核对契约字段，
    // 并确认内置形象确实声明了非均匀时长（否则第 6 项优化等于没落地）。
    const frameMsInfo = await page.evaluate(`(async () => {
      const data = await (await fetch('/api/plugins/stm-pet/runtime')).json();
      const pet = data.pet;
      const out = {};
      for (const action of ['idle', 'sleep', 'walk-left', 'land']) {
        const entry = (pet.actions || {})[action] || {};
        out[action] = {
          frameMs: entry.frameMs || [],
          fps: entry.fps,
          frames: entry.frames,
          variants: (entry.variants || []).length,
        };
      }
      out.idleTrigger = (pet.actions.idle || {}).idleTrigger || null;
      return out;
    })()`);
    const nonUniform = Object.values(frameMsInfo)
      .filter((item) => item && Array.isArray(item.frameMs))
      .filter((item) => item.frameMs.length > 1);
    record(
      '⑧ 非均匀帧时长已下发（frameMs 每帧一个数）',
      nonUniform.length >= 2,
      JSON.stringify(frameMsInfo),
    );

    // ============================================ ⑨ 多套动画 + 权重
    const variantInfo = await page.evaluate(`(async () => {
      const data = await (await fetch('/api/plugins/stm-pet/runtime')).json();
      const idle = (data.pet.actions || {}).idle || {};
      const variants = idle.variants || [];
      return {
        count: variants.length,
        weights: variants.map((v) => v.weight),
        urls: variants.map((v) => v.url),
        trigger: idle.idleTrigger || null,
      };
    })()`);
    record(
      '⑨ idle 有两套动画、带权重、URL 各不相同',
      variantInfo.count >= 2
        && new Set(variantInfo.urls).size === variantInfo.count
        && variantInfo.weights.every((w) => Number(w) > 0),
      JSON.stringify(variantInfo),
    );

    // 权重抽样：连续触发若干次，统计抽到的变体分布。
    //
    // 关键：每次触发后必须**等这一轮播完**（`finishIdleBurst` 把
    // `idleBurst` 清掉）才能再触发一次，否则 `pokeIdle()` 会被
    // 「正在播」这条守卫直接挡掉——那样统计出来的分布是假的
    // （第一次之后全部无效，看起来像「一套动画占了 99%」）。
    //
    // ⚠️ **循环条件是「拿到 N 次有效触发」，不是「尝试 N 次」**。
    // 实测踩到过：`pokeIdle()` 在宠物**漫游中**（state 不是 idle）会返回 false，
    // 而漫游每 3~9 秒就发生一次。按尝试次数循环时，那些瞬时失败的尝试会白吃掉
    // 额度（240 次只拿到 71 次有效），于是「有效触发 ≥ 40」这条断言时不时失败
    // ——看起来像「权重随机坏了」，实际是采样方式不稳。
    // 改成「等它回到 idle 再触发」，并用**墙钟上限**兜底防止无限等。
    const distribution = await page.evaluate(`(async () => {
      const view = window.__petView;
      const root = window.__p.root();
      const counts = {};
      const wanted = 60;            // 目标有效触发次数（断言只要求 ≥40）
      // 墙钟上限：每轮有效触发要等一整轮播完（约 1.6 秒），
      // 加上等待「回到 idle」的时间，60 次约需 2~4 分钟。
      // 给到 240 秒是为了在最慢的机器上也稳超 40 次这条断言线。
      const deadline = performance.now() + 240000;
      while (performance.now() < deadline) {
        const done = Object.values(counts).reduce((sum, n) => sum + n, 0);
        if (done >= wanted) break;
        // 等它回到「idle 且不在播」——漫游 / 播报 / 落空中都不该触发
        if (view.state !== 'idle' || view.idleBursting) {
          await new Promise((r) => setTimeout(r, 60));
          continue;
        }
        if (!view.pokeIdle()) {
          await new Promise((r) => setTimeout(r, 60));
          continue;
        }
        const key = root.dataset.petVariant;
        counts[key] = (counts[key] || 0) + 1;
        // 等这一轮播完（帧数 4、总时长约 1.6 秒 @speed 1）
        const burstDeadline = performance.now() + 4000;
        while (view.idleBursting && performance.now() < burstDeadline) {
          await new Promise((r) => setTimeout(r, 40));
        }
      }
      return counts;
    })()`);
    const keys = Object.keys(distribution);
    const totalPicked = Object.values(distribution).reduce((sum, n) => sum + n, 0);
    // 权重 5:2 → 期望约 71.4% / 28.6%，给足随机波动余量
    const share0 = (distribution['0'] || 0) / Math.max(1, totalPicked);
    record(
      '⑨ 权重随机：两套动画都被选中过，比例接近 5:2',
      keys.length >= 2 && totalPicked >= 40 && share0 > 0.5 && share0 < 0.9,
      `有效触发 ${totalPicked} 次，分布: ${JSON.stringify(distribution)}（期望 5:2 ≈ 0.71）`,
    );

    // ============================================ ⑩ 无控制台错误
    const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
    record(
      '⑩ 运行期无未捕获异常 / 错误日志',
      relevant.length === 0,
      relevant.slice(0, 4).join('\n        '),
    );

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`动画优化真实浏览器验收：${results.length - failed.length}/${results.length} 通过\n`);
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
