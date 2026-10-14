/**
 * T6 视觉原型：把「呼吸补间」与「原始帧循环」并排渲染成 GIF，供人眼判断。
 *
 * 为什么要有这个
 * --------------
 * T6 值不值得做，最后卡在一句话上：「**效果好不好**」。
 * 而这句话单测答不了、性能数字也答不了——只能做出来看。
 *
 * 因此这里用**真实素材**（小卡的 idle）渲染两个版本：
 *   A) 现状：4 帧循环（12fps）—— 一眼能看出是 4 张图在跳
 *   B) T6：1 帧 + CSS `@keyframes` 呼吸 —— 连续运动
 * 两者用同一个时间轴、同一套采样点，输出成 GIF 与原图。
 *
 * 关键做法：**用负 `animation-delay` + `animation-play-state: paused` 精确定位**
 * CSS 动画的某一时刻，而不是靠 `setTimeout` 去"抓"——
 * 截图耗时不可控，靠抓的话每帧的时间点都是抖的，做出来的 GIF 会自己抖，
 * 那就分不清「呼吸在抖」还是「采样在抖」。
 *
 * 用法：
 *   node tools/t6-preview.mjs <输出目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './cdp.mjs';

const OUT = process.argv[2] || 'tmp/t6-preview';
const SHEET = 'resources/pets/xiaoka/idle.png';
const FRAMES = 4;
const FRAME_W = 384;
const FRAME_H = 576;
const LOOP_MS = 2400;      // 一轮时长（两种方案一致，便于对比）
const STEPS = 48;          // 采样点数量
const SCALE = 0.5;         // 输出缩放（384x576 太大）
// 呼吸幅度（纵向缩放 ±A）。2% 是「看起来自然」的量级，但在一张 GIF 里
// 只有约 12px 的行程、不容易看清，因此这里默认放大到 4% 供人眼判断；
// 真正常用的默认值建议 2%~2.5%。
const AMPLITUDE = Number(process.env.T6_AMP || 0.04);

fs.mkdirSync(OUT, { recursive: true });

const sheetB64 = fs.readFileSync(SHEET).toString('base64');
const dataUrl = `data:image/png;base64,${sheetB64}`;

const browser = await launch({ width: 900, height: 700 });
try {
  const page = await browser.newPage();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.navigate('about:blank');
  await new Promise((r) => setTimeout(r, 300));

  await page.evaluate(`(() => {
    const style = document.createElement('style');
    // 呼吸：以脚底为原点做纵向缩放。0%/100% 回到原状，50% 最高。
    style.textContent = '@keyframes t6breathe {'
      + ' 0%,100% { transform: scaleY(' + (1 - ${AMPLITUDE}) + ') }'
      + ' 50% { transform: scaleY(' + (1 + ${AMPLITUDE}) + ') }'
      + ' }';
    document.head.appendChild(style);
    // 舞台：深色底，便于看边缘
    document.body.style.cssText = 'margin:0;background:#1b1b1f;display:flex;'
      + 'gap:24px;padding:24px;align-items:flex-end';
    const mk = (id, label) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative';
      const box = document.createElement('div');
      box.id = id;
      box.style.cssText = 'width:' + (${FRAME_W} * ${SCALE}) + 'px;height:' + (${FRAME_H} * ${SCALE})
        + 'px;background-image:url(' + ${JSON.stringify(dataUrl)} + ');'
        + 'background-repeat:no-repeat;'
        // 整条 sheet = 4 帧宽；背景尺寸按缩放
        + 'background-size:' + (${FRAME_W} * ${FRAMES} * ${SCALE}) + 'px ' + (${FRAME_H} * ${SCALE}) + 'px;'
        + 'background-position:0 0;transform-origin:bottom center';
      const tag = document.createElement('div');
      tag.textContent = label;
      tag.style.cssText = 'color:#ddd;font:12px/1.6 system-ui;text-align:center;margin-top:6px';
      wrap.appendChild(box); wrap.appendChild(tag);
      document.body.appendChild(wrap);
      return box;
    };
    window.__a = mk('stage-a', 'A) 现状：4 帧循环（12fps）');
    window.__b = mk('stage-b', 'B) T6：1 帧 + CSS 呼吸（±' + (${AMPLITUDE} * 100).toFixed(0) + '%）');
    // B 只显示第 0 帧（单帧），并挂上呼吸动画
    window.__b.style.animation = 't6breathe ${LOOP_MS}ms ease-in-out infinite';
    // 暂停 + 负 delay 用来精确定位到某一时刻
    window.__seek = (el, tMs) => {
      el.style.animationPlayState = 'paused';
      el.style.animationDelay = (-tMs) + 'ms';
    };
  })()`);

  const frames = [];
  for (let i = 0; i < STEPS; i += 1) {
    const t = (i / STEPS) * LOOP_MS;
    // A：按 12fps 走 4 帧循环（每帧 1/4 轮）
    const frameIndex = Math.floor((t / LOOP_MS) * FRAMES) % FRAMES;
    await page.evaluate(`(() => {
      window.__a.style.backgroundPosition = (-${frameIndex} * ${FRAME_W * SCALE}) + 'px 0px';
      window.__seek(window.__b, ${t});
    })()`);
    // 等一帧渲染
    await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    frames.push(Buffer.from(shot.data, 'base64'));
    if (i % 8 === 0) process.stdout.write(`  采样 ${i + 1}/${STEPS}\n`);
  }

  for (let i = 0; i < frames.length; i += 1) {
    fs.writeFileSync(path.join(OUT, `frame-${String(i).padStart(3, '0')}.png`), frames[i]);
  }
  process.stdout.write(`\n写出 ${frames.length} 张到 ${OUT}/\n`);
} finally {
  await browser.close();
}
