/**
 * 把**内置形象静止时的呼吸**在几档幅度下并排渲染成 GIF，供人眼挑。
 *
 * 为什么要它：「呼吸幅度多大才自然」是纯观感问题，数字答不了。
 * 但数字能给出**参照**：实测内置形象显示尺度是 0.45，`amplitude: 0.02`
 * 让头顶在屏幕上起伏 **10px**，占宠物高度的 **3.9%**——而真人静息呼吸时
 * 头部起伏只占身高 **0.5%~1%**。也就是说 0.02 大约是真实值的 4~8 倍，
 * 观感上偏「弹跳」而不是「呼吸」。
 *
 * 因此这里并排渲染四档，让人眼定夺：
 *   A) 现状（静止，完全不动）
 *   B) 0.005（≈ 真人比例）
 *   C) 0.010（中间档）
 *   D) 0.020（当前写进 pet.json 的值）
 *
 * 渲染条件与真实一致：**0.45 显示尺度 + 标准图像 + 该形象自己的 anchor.y**。
 *
 * 用法：
 *   node tools/builtin-breathe-preview.mjs <输出目录> [形象id]
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './cdp.mjs';

const OUT = process.argv[2] || 'tmp/builtin-breathe';
const PET = process.argv[3] || 'xiaoka';
const SCALE = 0.45;          // 内置形象的真实显示倍率（pack.scale）
const PERIOD_MS = 3400;      // 与 pet.json 里声明的一致
const STEPS = 40;
const PAD = 20;
const AMPS = [0, 0.005, 0.010, 0.020];

fs.mkdirSync(OUT, { recursive: true });

const sheet = `resources/pets/${PET}/idle.png`;
const dataUrl = `data:image/png;base64,${fs.readFileSync(sheet).toString('base64')}`;

const manifest = JSON.parse(fs.readFileSync(`resources/pets/${PET}/pet.json`, 'utf8'));
const SIZE = manifest.size;
const ANCHOR_Y = (manifest.anchor && manifest.anchor.y) || 1;
const FRAME = (manifest.still && manifest.still.frame) || 0;
const FRAMES = (manifest.still && manifest.still.frames) || 1;
const W = Math.round(SIZE.w * SCALE);
const H = Math.round(SIZE.h * SCALE);

const browser = await launch({ width: 1200, height: 640 });
try {
  const page = await browser.newPage();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.navigate('about:blank');
  await new Promise((r) => setTimeout(r, 300));

  await page.evaluate(`(() => {
    const style = document.createElement('style');
    // 与 plugin.css 里那套关键帧一致（幅度走 CSS 变量、原点由 anchor 决定）
    style.textContent = '@keyframes pet-breathe {'
      + ' 0%,100% { transform: scaleY(calc(1 - var(--amp))) }'
      + ' 50% { transform: scaleY(calc(1 + var(--amp))) } }';
    document.head.appendChild(style);
    document.body.style.cssText = 'margin:0;background:#16171b;display:flex;gap:${PAD}px;'
      + 'padding:${PAD}px;align-items:flex-end;justify-content:center';
    const amps = ${JSON.stringify(AMPS)};
    // ⚠️ 页面侧的模板里**只能**用这里插进去的常量：ANCHOR_Y / SIZE 是
    // Node 侧的变量，页面里不存在（第一版就踩了这个，报 ANCHOR_Y is not defined）。
    const originPct = ${(ANCHOR_Y * 100).toFixed(2)};
    const frameH = ${SIZE.h};
    const dispH = ${H};
    window.__boxes = amps.map((amp, i) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center';
      const box = document.createElement('div');
      box.style.cssText =
        'width:${W}px;height:${H}px;'
        + 'background-image:url(' + ${JSON.stringify(dataUrl)} + ');'
        + 'background-repeat:no-repeat;'
        + 'background-size:${SIZE.w * FRAMES * SCALE}px ${SIZE.h * SCALE}px;'
        + 'background-position:${-FRAME * W}px 0px;'
        + 'transform-origin:50% ' + originPct + '%;'
        + '--amp:' + amp + ';';
      const label = i === 0 ? 'A) 现状：静止（不动）'
        : String.fromCharCode(65 + i) + ') amp ' + amp.toFixed(3)
          + '（头顶起伏 ≈ ' + (amp * (originPct / 100) * dispH * 2).toFixed(1) + 'px）';
      const tag = document.createElement('div');
      tag.textContent = label;
      tag.style.cssText = 'color:#ccc;font:12px/1.7 system-ui;margin-top:8px;white-space:nowrap';
      wrap.appendChild(box); wrap.appendChild(tag);
      document.body.appendChild(wrap);
      if (amp > 0) box.style.animation = 'pet-breathe ${PERIOD_MS}ms ease-in-out infinite';
      return box;
    });
    // 负 delay 精确定位到某一时刻（暂停后渲染的是真关键帧状态）
    window.__seek = (tMs) => {
      window.__boxes.forEach((b) => {
        if (!b.style.animation) return;
        b.style.animationPlayState = 'paused';
        b.style.animationDelay = (-tMs) + 'ms';
      });
    };
  })()`);

  for (let i = 0; i < STEPS; i += 1) {
    await page.evaluate(`window.__seek(${(i / STEPS) * PERIOD_MS})`);
    await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `f-${String(i).padStart(3, '0')}.png`), Buffer.from(shot.data, 'base64'));
  }
  process.stdout.write(`写出 ${STEPS} 张到 ${OUT}/（${PET}，尺度 ${SCALE}，单帧 ${W}x${H}）\n`);
  process.stdout.write(`并排四档：${AMPS.join(' / ')}\n`);
} finally {
  await browser.close();
}
