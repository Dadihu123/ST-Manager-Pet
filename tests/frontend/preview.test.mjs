/**
 * 设置页**动画预览器**的纯计算部分单测。
 *
 * `preview.js` 的播放循环需要 DOM，但它真正容易算错的是**帧时长**与
 * **帧几何**——那两件事都是纯函数，因此在这里测（DOM 部分由
 * `tools/verify-panel.mjs` 在真实浏览器里验）。
 *
 * 运行：node --test "tests/frontend/*.test.mjs"
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frameGrid, framePage, framePageCount } from '../../frontend/animation.js';
import { animationDuration } from '../../frontend/animation.js';
import {
  normalizeMotion, motionBreathes, motionBlinks, pickBlinkDelay, playableVariants, stillFrame,
} from '../../frontend/animation.js';
import {
  frameDurations, totalDuration, applyFrameGeometry, motionStyle,
} from '../../frontend/preview.js';

/**
 * 造一个最小的假预览框 + 内层。
 *
 * `applyFrameGeometry` 只用到 `style` 与 `clientWidth/clientHeight`，
 * 因此不必真的建 DOM（`preview.js` 是纯计算层，不该引入 jsdom 依赖）。
 */
function fakeBox(width = 168, height = 168) {
  const style = {};
  return {
    clientWidth: width,
    clientHeight: height,
    style,
    /** 解析 `backgroundPosition` 里的两个像素值 */
    get offset() {
      const match = /^(-?[\d.]+)px\s+(-?[\d.]+)px$/.exec(style.backgroundPosition || '');
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
    },
    get size() {
      const match = /^([\d.]+)px\s+([\d.]+)px$/.exec(style.backgroundSize || '');
      return match ? { w: Number(match[1]), h: Number(match[2]) } : null;
    },
  };
}

/**
 * 造一个内层（`applyFrameGeometry` 的最后一个参数）。
 *
 * 内层就是「一帧的窗口」：它自己的宽高 + 在框内的 left/top，
 * 再加上背景的铺法与帧位移。邻帧被它的盒子裁住，漏不出来。
 */
function fakeLayer() {
  const style = {};
  const num = (key) => {
    const value = Number.parseFloat(style[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    style,
    /** 内层在框内的位置与大小 */
    get rect() {
      return { left: num('left'), top: num('top'), w: num('width'), h: num('height') };
    },
    /** 整条 spritesheet 的显示尺寸 */
    get size() {
      const match = /^([\d.]+)px\s+([\d.]+)px$/.exec(style.backgroundSize || '');
      return match ? { w: Number(match[1]), h: Number(match[2]) } : null;
    },
    get offset() {
      const match = /^(-?[\d.]+)px\s+(-?[\d.]+)px$/.exec(style.backgroundPosition || '');
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
    },
  };
}

// ============================================================ 帧时长


test('预览帧时长：优先用非均匀的 frameMs（那才是作者要的节奏）', () => {
  const durations = frameDurations({
    frames: 4, fps: 10, frameMs: [400, 300, 300, 600],
  });
  assert.deepEqual(durations, [400, 300, 300, 600]);
});

test('预览帧时长：没有 frameMs 时用 1000/fps', () => {
  assert.deepEqual(frameDurations({ frames: 3, fps: 8 }), [125, 125, 125]);
  assert.deepEqual(frameDurations({ frames: 2, fps: 2.5 }), [400, 400]);
});

test('预览帧时长：长度与帧数不符时回退到均匀（不抛错）', () => {
  for (const bad of [[100, 200], [1, 2, 3, 4, 5], 'x', null]) {
    const durations = frameDurations({ frames: 4, fps: 10, frameMs: bad });
    assert.equal(durations.length, 4, `${JSON.stringify(bad)} 应回退到均匀`);
    assert.ok(durations.every((value) => value === 100), '应全是 1/fps');
  }
});

test('预览帧时长：非法值回退到均匀', () => {
  for (const bad of [[0, 0, 0, 0], [-1, 100, 100, 100], [NaN, 100, 100, 100]]) {
    const durations = frameDurations({ frames: 4, fps: 10, frameMs: bad });
    assert.ok(durations.every((value) => value === 100), `${JSON.stringify(bad)} 应回退`);
  }
});

test('预览帧时长：单帧动作也返回一项（调用方不必判空）', () => {
  assert.equal(frameDurations({ frames: 1, fps: 6 }).length, 1);
  assert.equal(frameDurations({}).length, 1, '空对象也要有一项');
  assert.equal(frameDurations(null).length, 1);
});

test('预览帧时长：每帧有下限（与 clock.js 的 MAX_FPS 一致）', () => {
  const durations = frameDurations({ frames: 2, fps: 9999 });
  for (const value of durations) {
    assert.ok(value >= 1000 / 60 - 1e-9, `帧时长 ${value} 应不小于 1/60 秒`);
  }
});

test('预览总时长：非均匀时是逐帧之和', () => {
  assert.equal(totalDuration({ frames: 4, fps: 10, frameMs: [400, 300, 300, 600] }), 1600);
});

test('预览总时长：均匀时是 帧数 / fps', () => {
  assert.equal(totalDuration({ frames: 4, fps: 8 }), 500);
  assert.equal(totalDuration({ frames: 3, fps: 12 }), 250);
});

test('预览总时长：与后端的 total_ms 语义一致（同一份数据算出同一个数）', () => {
  // 后端 `AnimationVariant.total_ms` = 逐帧之和；两边的数字必须能对上，
  // 否则「面板显示的一轮时长」与「桌面上真正播的时长」会不一致。
  const variant = { frames: 4, fps: 2.5, frameMs: [400, 300, 300, 600] };
  assert.equal(totalDuration(variant), 1600);
  // 均匀时后端是 frames * 1000 / fps
  assert.equal(totalDuration({ frames: 4, fps: 2.5 }), 1600);
});

// ============================================================ 帧几何
//
// 用户报障：「预览动画框应该根据动作的比例来自动变化……否则看起来会很奇怪
// （点名小卡的睡觉动作）」。
//
// 根因是旧实现**强行把一帧拉到框宽**（`单帧宽 = 框宽 × 帧数`）。
// 站立动作是 2:3 竖构图，恰好与旧框同比例，所以看不出问题；
// 而小卡的睡觉是躺姿、横构图（627×353），被拉进竖框就压扁了。
//
// 几何写在**内层**（`layer`）上，不是外框上：按比例装入必然留白，
// 而背景是按整条 spritesheet 铺的——铺在外框上时留白处会露出**邻帧**
// （实测：睡觉的预览框左边缘飘着一个「z」、右边缘挂着半个人影）。
// 内层只有一帧大小，邻帧被它自己的盒子裁住。


/** 便于断言：跑一次几何，返回 { box, layer, frame }。 */
function geom(boxSize, frames, layout, at, frameSize, dpr) {
  const box = fakeBox(boxSize, boxSize);
  const layer = fakeLayer();
  // `layout` 参数保留字符串形态（`'horizontal'` / `'vertical'`），
  // 也接受 `{cols, rows}` 对象——几何函数两者都认（见 `applyFrameGeometry`）。
  const grid = typeof layout === 'string'
    ? frameGrid({ layout, frames })
    : frameGrid(Object.assign({ frames }, layout));
  applyFrameGeometry(box, grid, frames, at, frameSize, layer, dpr);
  const sheet = layer.size;
  return {
    box,
    layer,
    grid,
    // 单帧的显示尺寸 = 整条 / 行列数
    frame: { w: sheet.w / grid.cols, h: sheet.h / grid.rows },
  };
}

test('预览几何：竖构图动作等比缩放到框内，不变形', () => {
  // 384×576 的站立单帧（小卡的包级尺寸），2:3
  const { frame, box } = geom(168, 4, 'horizontal', 0, { w: 384, h: 576 });
  assert.ok(
    Math.abs((frame.w / frame.h) - (384 / 576)) < 1e-6,
    `宽高比应保持 2:3，实际 ${frame.w}×${frame.h}`,
  );
  assert.ok(frame.h <= 168 + 1e-6, '不能超出框高');
  assert.ok(frame.w <= 168 + 1e-6, '不能超出框宽');
  // 2:3 竖构图在正方框里应受**高度**限制
  assert.ok(Math.abs(frame.h - 168) < 1e-6, '竖构图应该用满框高');
  assert.equal(box.style.backgroundSize, undefined, '外框不该再被写几何');
});

test('预览几何：横构图动作（小卡睡觉）等比缩放而不是被压扁', () => {
  // 这是用户点名的那个场景：627×353 的躺姿单帧
  const { frame } = geom(168, 1, 'horizontal', 0, { w: 627, h: 353 });
  // ⚠️ 允许半个设备像素以内的比例偏差：几何会**对齐到整数设备像素**，
  // 否则帧边界跨在半个像素上、最外一行会混入邻帧（见下面那条 ★ 测试）。
  const rel = Math.abs((frame.w / frame.h) - (627 / 353)) / (627 / 353);
  assert.ok(rel < 0.01, `宽高比应接近 627:353，实际偏差 ${(rel * 100).toFixed(2)}%`);
  // 横图受宽度限制：应该用满框宽
  assert.ok(Math.abs(frame.w - 168) < 1e-6, '横构图应该用满框宽');
  assert.ok(frame.h < 168, '高度按比例缩短，不能被拉满');
});

test('★ 预览几何：尺寸对齐到整数设备像素（去掉内层边缘的半像素细缝）', () => {
  // 帧的显示尺寸常常是小数（400×300 装进 166px 方框 → 高正好 124.5px）。
  // 这时内层边缘落在**半个设备像素**上，那一行会被画成「本帧颜色 + 外框底色」
  // 各一半的混合——看起来是帧底部一条半透明的细缝。
  //
  // 实测（纯色测试形象，帧 1 纯绿，面板底色浅灰）：
  // 不对齐 → 内层边缘 208 个混合像素；对齐后 → 42 个（只剩外框圆角那一块）。
  //
  // ⚠️ 这条混合**不是**邻帧：邻帧泄漏由「外框 + 一帧大小的内层」解决
  // （见下面 ★ 那条）。实测按 |R−B| 失衡判定邻帧色时，两种实现都是 0。
  //
  // 判据：内层尺寸、整条 sheet、背景位移在设备像素上**全是整数**。
  const DPRS = [1, 1.25, 1.5, 2, 3];
  const CASES = [
    { frames: 4, layout: 'vertical', size: { w: 400, h: 300 } },
    { frames: 4, layout: 'horizontal', size: { w: 300, h: 400 } },
    { frames: 4, layout: 'vertical', size: { w: 384, h: 576 } },
    { frames: 1, layout: 'horizontal', size: { w: 627, h: 353 } },
    { frames: 3, layout: 'vertical', size: { w: 333, h: 211 } },
  ];
  for (const dpr of DPRS) {
    for (const item of CASES) {
      // 用第 3 帧（不是第 0 帧）：位移非 0 才能验出累积误差
      const at = Math.min(2, item.frames - 1);
      const { layer } = geom(168, item.frames, item.layout, at, item.size, dpr);
      const rect = layer.rect;
      const sheet = layer.size;
      const offset = layer.offset;
      const tag = `dpr=${dpr} ${item.layout} ${item.frames}帧 ${item.size.w}x${item.size.h}`;
      const isInt = (v) => Math.abs(v - Math.round(v)) < 1e-6;

      assert.ok(isInt(rect.w * dpr), `${tag}: 内层宽应为整数设备像素，实际 ${rect.w * dpr}`);
      assert.ok(isInt(rect.h * dpr), `${tag}: 内层高应为整数设备像素，实际 ${rect.h * dpr}`);
      assert.ok(
        isInt((item.layout === 'vertical' ? sheet.h : sheet.w) * dpr),
        `${tag}: 整条 sheet 应为整数设备像素`,
      );
      const shift = (item.layout === 'vertical' ? -offset.y : -offset.x) * dpr;
      assert.ok(isInt(shift), `${tag}: 背景位移应为整数设备像素，实际 ${shift}`);
    }
  }
});

test('预览几何：对齐带来的比例偏差极小（视觉不可辨）', () => {
  // 对齐是「用半个设备像素的比例偏差换掉一条半像素细缝」，因此偏差必须很小，
  // 否则就是拿一个明显的问题换另一个。
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    for (const size of [{ w: 400, h: 300 }, { w: 627, h: 353 }, { w: 384, h: 576 }]) {
      const { frame } = geom(168, 1, 'vertical', 0, size, dpr);
      const rel = Math.abs((frame.w / frame.h) - (size.w / size.h)) / (size.w / size.h);
      assert.ok(
        rel < 0.01,
        `dpr=${dpr} ${size.w}x${size.h}: 比例偏差应 < 1%，实际 ${(rel * 100).toFixed(3)}%`,
      );
    }
  }
});

test('预览几何：对齐不会把帧缩成 0（极小框也要看得见）', () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const { frame } = geom(1, 4, 'vertical', 0, { w: 400, h: 300 }, dpr);
    assert.ok(frame.w > 0 && frame.h > 0, `dpr=${dpr}: 帧尺寸必须为正`);
    assert.ok(frame.h * dpr >= 1 - 1e-6, `dpr=${dpr}: 至少要有 1 个设备像素高`);
  }
});

test('★ 预览几何：内层尺寸与帧位移同源（邻帧漏不出来）', () => {
  // 用户报障：「改成方框后，原先竖向分辨率拼接的动画帧播放时，当前帧的播放
  // 可能会露出前一帧和后一帧的部分图案」。
  //
  // 根因：背景图是**整条** spritesheet。铺在外框上时，`background-position`
  // 只把当前帧挪到「居中 + 贴底」——外框里除了当前帧，**上方/下方空出来的
  // 地方露出的正是上一帧/下一帧**。竖排 sheet 尤其明显。
  //
  // 修法是「外框 + 一帧大小的内层」：内层尺寸与帧位移必须用**同一个**
  // `shownSize`，这样裁切边界与帧边界严格重合，邻帧漏不出来。
  //
  // 实测（同页 A/B，竖排 4 帧纯色图，看第 1 帧）：
  // 铺在外框上 → 帧窗口内红色（上一帧）占 **25%**；铺在内层上 → 红 **0%**。
  const CASES = [
    { frames: 4, layout: 'vertical', size: { w: 400, h: 300 } },
    { frames: 4, layout: 'horizontal', size: { w: 300, h: 400 } },
  ];
  for (const item of CASES) {
    const at = 1;
    const { layer, frame } = geom(168, item.frames, item.layout, at, item.size);
    const rect = layer.rect;
    const offset = layer.offset;
    const tag = `${item.layout} ${item.size.w}x${item.size.h}`;
    assert.ok(
      Math.abs(rect.w - frame.w) < 1e-9 && Math.abs(rect.h - frame.h) < 1e-9,
      `${tag}: 内层应正好是一帧，实际 ${rect.w}×${rect.h} vs ${frame.w}×${frame.h}`,
    );
    const step = item.layout === 'vertical' ? frame.h : frame.w;
    const shifted = item.layout === 'vertical' ? -offset.y : -offset.x;
    assert.ok(
      Math.abs(shifted - at * step) < 1e-9,
      `${tag}: 位移应是 ${at} 倍帧长，实际 ${shifted}`,
    );
    assert.ok(rect.w <= 168 + 1e-6 && rect.h <= 168 + 1e-6, `${tag}: 内层不该超出外框`);
  }
});

test('预览几何：底边对齐（横躺动作不能浮在半空）', () => {
  // 用户明确要求「预览动画底部和预览框对齐」。垂直居中会让横躺的睡觉
  // 浮在半空、与站立的动作对不齐，切换动作时画面上下跳。
  // 允许 1 个设备像素以内的偏差（尺寸对齐到整数设备像素的代价）。
  const { layer } = geom(168, 1, 'horizontal', 0, { w: 627, h: 353 });
  const rect = layer.rect;
  assert.ok(
    Math.abs((rect.top + rect.h) - 168) <= 1,
    `底边应贴着框底：top=${rect.top} + h=${rect.h} 应约等于 168`,
  );
});

test('预览几何：水平居中', () => {
  const { layer } = geom(168, 1, 'horizontal', 0, { w: 627, h: 353 });
  const rect = layer.rect;
  const left = rect.left;
  const right = 168 - (rect.left + rect.w);
  // 允许 1 个设备像素以内的偏差（宽高各自对齐，可能差一格）
  assert.ok(Math.abs(left - right) <= 1, `左右留白应基本相等：${left} vs ${right}`);
});

test('★ 预览几何：内层只有一帧大小（邻帧漏不出来）', () => {
  // 这是「按比例装入」必然带来的问题：留白处露出的是**相邻的帧**。
  // 内层的宽高必须正好是一帧，背景才能被它裁住。
  const { layer, frame } = geom(168, 4, 'horizontal', 0, { w: 384, h: 576 });
  const rect = layer.rect;
  assert.ok(
    Math.abs(rect.w - frame.w) < 1e-6 && Math.abs(rect.h - frame.h) < 1e-6,
    `内层应正好是一帧：内层 ${rect.w}×${rect.h} vs 帧 ${frame.w}×${frame.h}`,
  );
  // 而且内层不能比外框大（否则会溢出被裁）
  assert.ok(rect.w <= 168 + 1e-6 && rect.h <= 168 + 1e-6, '内层不该超出外框');
});

test('预览几何：水平 spritesheet 按帧位移，一帧不漏', () => {
  const size = { w: 100, h: 200 };
  const first = geom(168, 4, 'horizontal', 0, size);
  const third = geom(168, 4, 'horizontal', 2, size);
  // 第 2 帧应比第 0 帧左移「两帧的显示宽度」
  assert.ok(
    Math.abs((first.layer.offset.x - third.layer.offset.x) - first.frame.w * 2) < 1e-6,
    '每前进一帧应正好位移一个显示帧宽',
  );
  assert.equal(third.layer.offset.y, first.layer.offset.y, '水平排布不该改变纵向位移');
  // 内层在框里的位置不随帧号变（变的是背景位移）
  assert.deepEqual(third.layer.rect, first.layer.rect, '换帧不该挪动内层');
});

test('预览几何：垂直 spritesheet 按帧位移', () => {
  const size = { w: 200, h: 100 };
  const first = geom(168, 3, 'vertical', 0, size);
  const second = geom(168, 3, 'vertical', 1, size);
  assert.ok(
    Math.abs((first.layer.offset.y - second.layer.offset.y) - first.frame.h) < 1e-6,
    '垂直排布每帧应上移一个显示帧高',
  );
  assert.equal(second.layer.offset.x, first.layer.offset.x, '垂直排布不该改变横向位移');
});

// ============================================================ 网格排布（grid）
//
// `grid` 是新增的第三种排布：帧落在一个 `cols × rows` 的网格里，行优先
// （先从左到右，再从上到下）。`horizontal` / `vertical` 不是另外两套算法，
// 而是它的两个特例（`cols=N, rows=1` / `cols=1, rows=N`）。
//
// 为什么要统一：三条独立分支里只要有两条不一致，就会出现「桌面上对、
// 面板预览里错」这种最难查的偏差。统一之后只有一组公式。


test('★ 预览几何：网格排布按行列定位（行优先）', () => {
  // 3×3 网格里放 9 帧。逐帧验证「第 n 帧在哪一格」——
  // 这是网格排布的核心语义，也是唯一能把「行优先 / 列优先」区分开的地方。
  const size = { w: 100, h: 100 };
  const grid = { cols: 3, rows: 3 };
  const cases = [
    { at: 0, col: 0, row: 0 },
    { at: 1, col: 1, row: 0 },
    { at: 2, col: 2, row: 0 },
    { at: 3, col: 0, row: 1 },   // ★ 第 3 帧换行：列优先实现会给出 col=0,row=... 之外的答案
    { at: 4, col: 1, row: 1 },
    { at: 8, col: 2, row: 2 },
  ];
  const first = geom(168, 9, grid, 0, size);
  const stepX = first.frame.w;
  const stepY = first.frame.h;
  for (const item of cases) {
    const { layer } = geom(168, 9, grid, item.at, size);
    assert.ok(
      Math.abs(layer.offset.x - (-item.col * stepX)) < 1e-6,
      `第 ${item.at} 帧的横向位移应是第 ${item.col} 列，实际 ${layer.offset.x}`,
    );
    assert.ok(
      Math.abs(layer.offset.y - (-item.row * stepY)) < 1e-6,
      `第 ${item.at} 帧的纵向位移应是第 ${item.row} 行，实际 ${layer.offset.y}`,
    );
  }
});

test('★ 预览几何：网格装不满时仍按**网格容量**铺（不是按帧数）', () => {
  // 4×4 的网格只放 13 帧（用户明确要求「避免没有填满的情况」）。
  // 背景图仍然是完整的 4×4 张图，因此整条 sheet 必须按 4×4 算。
  // 按 `frames`（13）算会把它压扁——表现为「帧位置整体错位、越到后面越偏」。
  const size = { w: 100, h: 100 };
  const partial = geom(168, 13, { cols: 4, rows: 4 }, 0, size);
  const full = geom(168, 16, { cols: 4, rows: 4 }, 0, size);
  assert.ok(
    Math.abs(partial.layer.size.w - full.layer.size.w) < 1e-9
    && Math.abs(partial.layer.size.h - full.layer.size.h) < 1e-9,
    `装不满时整条尺寸应与装满时一致，实际 ${JSON.stringify(partial.layer.size)}`
    + ` vs ${JSON.stringify(full.layer.size)}`,
  );
  assert.ok(
    Math.abs(partial.frame.w - full.frame.w) < 1e-9
    && Math.abs(partial.frame.h - full.frame.h) < 1e-9,
    '单帧尺寸应与装满时一致',
  );
});

test('★ 预览几何：网格里最后一帧不会越界到空格子里', () => {
  // 13 帧放在 4×4 里：第 12 帧是最后一帧，落在第 3 行第 0 列。
  // 越界会让画面停在透明空格上（宠物凭空消失一帧）。
  const size = { w: 100, h: 100 };
  const last = geom(168, 13, { cols: 4, rows: 4 }, 12, size);
  assert.ok(Math.abs(last.layer.offset.x - 0) < 1e-6, '第 12 帧应在第 0 列');
  assert.ok(
    Math.abs(last.layer.offset.y - (-3 * last.frame.h)) < 1e-6,
    `第 12 帧应在第 3 行，实际 ${last.layer.offset.y}`,
  );
  // 越界的帧号被夹到最后一帧（而不是落到空格子上）
  const over = geom(168, 13, { cols: 4, rows: 4 }, 99, size);
  assert.equal(over.layer.offset.y, last.layer.offset.y, '超上限应夹到最后一帧');
});

test('★ 预览几何：内层恒为一帧（网格排布下邻帧同样漏不出来）', () => {
  // 这是上一轮修的核心保证，网格排布**必须**继续满足它：
  // 内层尺寸与背景位移必须同源，否则裁切边界与帧边界错开、邻帧漏出来。
  // 网格排布下漏的就不止上下/左右一帧，而是整行整列——比单行更明显。
  const size = { w: 120, h: 90 };
  const grid = { cols: 3, rows: 3 };
  const { layer, frame } = geom(168, 9, grid, 4, size);
  const rect = layer.rect;
  assert.ok(
    Math.abs(rect.w - frame.w) < 1e-9 && Math.abs(rect.h - frame.h) < 1e-9,
    `内层应正好是一帧：内层 ${rect.w}×${rect.h} vs 帧 ${frame.w}×${frame.h}`,
  );
  assert.ok(rect.w <= 168 + 1e-6 && rect.h <= 168 + 1e-6, '内层不该超出外框');
  // 位移必须是**整数倍**的帧尺寸（错开就会露邻帧）
  assert.ok(
    Math.abs(layer.offset.x % frame.w) < 1e-6 || Math.abs((layer.offset.x % frame.w) + frame.w) < 1e-6,
    '横向位移应是帧宽的整数倍',
  );
  assert.ok(
    Math.abs(layer.offset.y % frame.h) < 1e-6 || Math.abs((layer.offset.y % frame.h) + frame.h) < 1e-6,
    '纵向位移应是帧高的整数倍',
  );
});

test('预览几何：网格排布也按比例 contain + 底边对齐', () => {
  // 横构图的帧放进正方框：用满宽度、底边贴框底。这与排布方式无关——
  // 排布只决定「整条图怎么铺」，单帧的装入方式对所有排布都一样。
  const { frame, layer } = geom(168, 6, { cols: 3, rows: 2 }, 0, { w: 627, h: 353 });
  const rel = Math.abs((frame.w / frame.h) - (627 / 353)) / (627 / 353);
  assert.ok(rel < 0.01, `宽高比应接近 627:353，实际偏差 ${(rel * 100).toFixed(2)}%`);
  assert.ok(Math.abs(frame.w - 168) < 1e-6, '横构图应该用满框宽');
  assert.ok(
    Math.abs((layer.rect.top + layer.rect.h) - 168) <= 1,
    '底边应贴着框底',
  );
});

test('预览几何：网格与等价的单行/单列排布结果一致（三种排布同一套公式）', () => {
  // `horizontal` 就是 `cols=N, rows=1`、`vertical` 就是 `cols=1, rows=N`。
  // 这条测试钉住「它们确实是特例」——如果哪天有人把某个排布单独优化坏了，
  // 这里会立刻暴露。
  const size = { w: 100, h: 140 };
  for (const at of [0, 1, 2, 3]) {
    const byLayout = geom(168, 4, 'horizontal', at, size);
    const byGrid = geom(168, 4, { cols: 4, rows: 1 }, at, size);
    assert.equal(byGrid.layer.offset.x, byLayout.layer.offset.x, `水平 第 ${at} 帧横移`);
    assert.equal(byGrid.layer.offset.y, byLayout.layer.offset.y, `水平 第 ${at} 帧纵移`);

    const vLayout = geom(168, 4, 'vertical', at, size);
    const vGrid = geom(168, 4, { cols: 1, rows: 4 }, at, size);
    assert.equal(vGrid.layer.offset.x, vLayout.layer.offset.x, `垂直 第 ${at} 帧横移`);
    assert.equal(vGrid.layer.offset.y, vLayout.layer.offset.y, `垂直 第 ${at} 帧纵移`);
  }
});

test('预览几何：显式 cols/rows 优先于 layout（后端算好的几何不被前端覆盖）', () => {
  // 运行期定义里 `layout` 与 `cols`/`rows` 同时存在（前者是作者意图，
  // 后者是后端算好的结论）。前端必须信**算好的**那个，否则两边各推一次，
  // 不一致时没人知道该信谁。
  const grid = frameGrid({ frames: 4, layout: 'horizontal', cols: 2, rows: 2 });
  assert.deepEqual(grid, { cols: 2, rows: 2 }, '显式 cols/rows 应优先');
});

test('★ 预览几何：网格排布的整数设备像素对齐（每个方向都要对齐）', () => {
  // 单行/单列只涉及一个方向的位移，网格**两个方向**都要对齐。
  // 漏掉任何一个方向都会在那一侧的帧边界出现半像素细缝。
  const DPRS = [1, 1.25, 1.5, 2, 3];
  const CASES = [
    { frames: 9, grid: { cols: 3, rows: 3 }, size: { w: 100, h: 140 } },
    { frames: 13, grid: { cols: 4, rows: 4 }, size: { w: 333, h: 211 } },
    { frames: 6, grid: { cols: 3, rows: 2 }, size: { w: 627, h: 353 } },
  ];
  for (const dpr of DPRS) {
    for (const item of CASES) {
      const at = Math.min(5, item.frames - 1);
      const { layer } = geom(168, item.frames, item.grid, at, item.size, dpr);
      const isInt = (v) => Math.abs(v - Math.round(v)) < 1e-6;
      const tag = `dpr=${dpr} ${item.grid.cols}x${item.grid.rows} ${item.frames}帧`;
      assert.ok(isInt(layer.size.w * dpr), `${tag}: 整条宽应为整数设备像素`);
      assert.ok(isInt(layer.size.h * dpr), `${tag}: 整条高应为整数设备像素`);
      assert.ok(isInt(layer.rect.w * dpr) && isInt(layer.rect.h * dpr), `${tag}: 内层应为整数设备像素`);
      assert.ok(isInt(-layer.offset.x * dpr), `${tag}: 横向位移应为整数设备像素`);
      assert.ok(isInt(-layer.offset.y * dpr), `${tag}: 纵向位移应为整数设备像素`);
    }
  }
});

// ============================================================ 帧几何辅助函数


test('frameGrid：horizontal / vertical 是网格的特例', () => {
  assert.deepEqual(frameGrid({ frames: 4, layout: 'horizontal' }), { cols: 4, rows: 1 });
  assert.deepEqual(frameGrid({ frames: 4, layout: 'vertical' }), { cols: 1, rows: 4 });
  // 缺省（老后端不下发 layout）等价于 horizontal
  assert.deepEqual(frameGrid({ frames: 3 }), { cols: 3, rows: 1 });
  assert.deepEqual(frameGrid(null), { cols: 1, rows: 1 });
});

// ============================================================ 程序化运动（T6）
//
// `motion`：不增加帧数的连续运动。呼吸走 CSS `@keyframes`（合成器上跑，
// **不需要 rAF**），眨眼走 `background-position` 跳帧 + `setTimeout`
// （因为宠物静止时 rAF 是停着的，用 rAF 计时倒计时永远不前进）。
//
// 实测收益：现状 4 帧 idle 循环的顶边只动 1px（4 张图几乎一样），
// 而 1 帧 + 呼吸能顶边动 22px 且脚底不动 —— **1 帧比 4 帧更像活的**。


test('★ normalizeMotion：没声明时返回 null（前端据此完全不动样式）', () => {
  assert.equal(normalizeMotion({}), null);
  assert.equal(normalizeMotion({ motion: null }), null);
  assert.equal(normalizeMotion({ motion: {} }), null);
  assert.equal(normalizeMotion(null), null);
  // 有键但值非法 → 当作没声明（宁可不动，也不要写一个坏值进 CSS）
  assert.equal(normalizeMotion({ motion: { breathe: { amplitude: 0, periodMs: 3200 } } }), null);
  assert.equal(normalizeMotion({ motion: { breathe: { amplitude: 0.02 } } }), null);
  assert.equal(normalizeMotion({ motion: { breathe: { amplitude: 'x', periodMs: 'y' } } }), null);
});

test('normalizeMotion：呼吸', () => {
  const m = normalizeMotion({ motion: { breathe: { amplitude: 0.02, periodMs: 3200 } } });
  assert.equal(m.amplitude, 0.02);
  assert.equal(m.periodMs, 3200);
  assert.equal(m.blinkFrames.length, 0);
  assert.equal(motionBreathes(m), true);
  assert.equal(motionBlinks(m), false);
});

test('normalizeMotion：眨眼', () => {
  const m = normalizeMotion({
    motion: { blink: { frames: [2, 3], everyMs: [3000, 7000], durationMs: 160 } },
  });
  assert.deepEqual(m.blinkFrames, [2, 3]);
  assert.deepEqual(m.blinkEveryMs, [3000, 7000]);
  assert.equal(m.blinkDurationMs, 160);
  assert.equal(motionBreathes(m), false);
  assert.equal(motionBlinks(m), true);
});

test('normalizeMotion：两者可同时开启', () => {
  const m = normalizeMotion({
    motion: {
      breathe: { amplitude: 0.025, periodMs: 3000 },
      blink: { frames: [1], everyMs: [2500, 6000], durationMs: 140 },
    },
  });
  assert.equal(motionBreathes(m), true);
  assert.equal(motionBlinks(m), true);
});

test('★ normalizeMotion：眨眼的 everyMs 顺序被规范化（后端也做，前端再兜一层）', () => {
  const m = normalizeMotion({
    motion: { blink: { frames: [1], everyMs: [7000, 3000], durationMs: 160 } },
  });
  assert.deepEqual(m.blinkEveryMs, [3000, 7000]);
});

test('normalizeMotion：眨眼参数不全就整条丢掉（不要半残的配置）', () => {
  // 缺 durationMs
  assert.equal(normalizeMotion({ motion: { blink: { frames: [1], everyMs: [3000, 7000] } } }), null);
  // everyMs 不是两项
  assert.equal(normalizeMotion({
    motion: { blink: { frames: [1], everyMs: [3000], durationMs: 160 } },
  }), null);
  // frames 为空
  assert.equal(normalizeMotion({
    motion: { blink: { frames: [], everyMs: [3000, 7000], durationMs: 160 } },
  }), null);
});

test('★ pickBlinkDelay：只抽数、不管计时', () => {
  // 抽数（不推进倒计时）——计时必须由调用方做：宠物静止时 rAF 是停着的，
  // 把倒计时放在这里推进就永远不会前进（idle 调度那里踩过一次）。
  const m = normalizeMotion({
    motion: { blink: { frames: [1], everyMs: [3000, 7000], durationMs: 160 } },
  });
  assert.equal(pickBlinkDelay(m, () => 0), 3000);
  assert.equal(pickBlinkDelay(m, () => 1), 7000);
  assert.equal(pickBlinkDelay(m, () => 0.5), 5000);
  // 区间退化成一个值时也安全
  const flat = normalizeMotion({
    motion: { blink: { frames: [1], everyMs: [4000, 4000], durationMs: 160 } },
  });
  assert.equal(pickBlinkDelay(flat, () => 0.7), 4000);
  // 不眨眼时返回 0（调用方据此不排定时器）
  assert.equal(pickBlinkDelay(null), 0);
  assert.equal(pickBlinkDelay({ blinkFrames: [], blinkDurationMs: 0 }), 0);
});

test('★ playableVariants 带上 motion 与 motionOrigin', () => {
  const [v] = playableVariants({
    url: '/f', frames: 4, fps: 6,
    motion: { breathe: { amplitude: 0.02, periodMs: 3200 } },
    motionOrigin: '50% 88%',
  });
  assert.equal(v.motion.amplitude, 0.02);
  assert.equal(v.motionOrigin, '50% 88%');
  // 没声明时是 null / ''（前端据此完全不动样式）
  const [plain] = playableVariants({ url: '/f', frames: 4 });
  assert.equal(plain.motion, null);
  assert.equal(plain.motionOrigin, '');
});

test('★ stillFrame 带上 motion（标准图像要跟着 idle 一起呼吸）', () => {
  // 默认 idle 模式下宠物**大部分时间显示的就是标准图像**；
  // 它不动的话，呼吸在绝大多数时间里根本看不见。
  //
  // ⚠️ motion 挂在**运行期的 `still` 载荷上**（后端把 idle 的运动继承过来），
  // 不是挂在包顶层——写错位置的表现就是「标准图像不呼吸」。
  const still = stillFrame({
    still: {
      url: '/frame/mine/still', sheet: 'idle.png', frames: 4, frame: 0, source: 'idle',
      motion: { breathe: { amplitude: 0.03, periodMs: 3000 } },
      motionOrigin: '50% 100%',
    },
    animations: { idle: { sheet: 'idle.png', frames: 4, fps: 6 } },
  });
  assert.equal(still.motion.amplitude, 0.03);
  assert.equal(still.motionOrigin, '50% 100%');
});

test('★ motionStyle：算出预览层要用的呼吸样式（纯函数）', () => {
  // 与 petview 共用同一套 @keyframes 与同样的 CSS 变量，
  // 因此两处的行为不可能不一致（关键帧只写一次）。
  const style = motionStyle({
    motion: { breathe: { amplitude: 0.03, periodMs: 2500 } },
    motionOrigin: '50% 90%',
  });
  assert.equal(style.amplitude, '0.03');
  assert.equal(style.period, '2500ms');
  assert.equal(style.origin, '50% 90%');
});

test('★ motionStyle：周期按动画速度倍率折算', () => {
  // 用户把倍率调慢时呼吸还按原速跑会不协调。
  const spec = { motion: { breathe: { amplitude: 0.02, periodMs: 3000 } } };
  assert.equal(motionStyle(spec, 1).period, '3000ms');
  assert.equal(motionStyle(spec, 2).period, '1500ms');
  assert.equal(motionStyle(spec, 0.5).period, '6000ms');
  // 倍率非法时退回 1（不要算出 NaN 或 Infinity 写进 CSS）
  assert.equal(motionStyle(spec, 0).period, '3000ms');
  assert.equal(motionStyle(spec, -1).period, '3000ms');
  assert.equal(motionStyle(spec, NaN).period, '3000ms');
});

test('★ motionStyle：只眨眼 / 没声明时返回 null（不挂呼吸动画）', () => {
  // 只眨眼不该挂呼吸：会常驻一个合成层，而且「静止时零成本」的契约
  // 会为这个形象白白失效。
  assert.equal(motionStyle({ motion: { blink: { frames: [1], everyMs: [3000, 7000], durationMs: 100 } } }), null);
  assert.equal(motionStyle({}), null);
  assert.equal(motionStyle(null), null);
});

test('★ motionStyle：没下发 motionOrigin 时 origin 是空串（而不是编一个）', () => {
  // 编一个「底部居中」会在锚点不在底边的形象上让脚离地。
  const style = motionStyle({ motion: { breathe: { amplitude: 0.02, periodMs: 3000 } } });
  assert.equal(style.origin, '');
});

test('★ 预览播放器不眨眼（它的本分是让用户看清每一帧）', () => {
  // 隔一会儿自己跳一帧会让人以为「帧序错了」。
  // 这里用纯函数验证：只眨眼的声明**不会**产生呼吸样式。
  const style = motionStyle({
    motion: { blink: { frames: [2], everyMs: [100, 100], durationMs: 60 } },
  });
  assert.equal(style, null);
});

// ============================================================ 动图容器
//
// `layout: "animated"`：由浏览器自行播放，插件不切帧。
// 它的网格是 `(1, 1)`，于是「背景铺法 = 单帧 × 行列数」这条公式自然退化成
// 「原样铺满一帧」——**三条切帧排布与容器路线共用同一套渲染代码**，
// 不必在 petview / preview / panel 里各加一条 `if (animated)` 分支。
//
// 这是「第二路线」：作者手上已有现成的 GIF / 动图 WebP 时零成本可用，
// 代价是放弃逐帧控制与分页能力（见 README §3.11）。


test('★ frameGrid：动图容器是 (1,1)，不是网格', () => {
  assert.deepEqual(frameGrid({ frames: 1, layout: 'animated' }), { cols: 1, rows: 1 });
  // 即使带了（本不该有的）cols/rows 也不该被当成网格
  assert.deepEqual(
    frameGrid({ frames: 1, layout: 'animated', cols: 8, rows: 8 }),
    { cols: 1, rows: 1 },
    '动图不切帧，声明网格没有意义',
  );
});

test('★ 预览几何：动图容器原样铺满一帧（不切帧）', () => {
  // 网格是 (1,1) → 整条 sheet = 单帧 × 1，位移恒为 (0,0)。
  // 因此「动图」与「单帧静态图」在**几何上**是同一条路径——
  // 区别只在浏览器会不会让那张图自己动起来。
  const box = fakeBox(168, 168);
  const layer = fakeLayer();
  const at = applyFrameGeometry(box, { cols: 1, rows: 1 }, 1, 0,
                                { w: 96, h: 96 }, layer);
  assert.equal(at.page, 0);
  assert.equal(at.col, 0);
  assert.equal(at.row, 0);
  const sheet = layer.size;
  // 整条就是那一帧：按框等比 contain
  assert.ok(Math.abs(sheet.w - sheet.h) < 1e-6, '正方形帧在正方框里应等比');
  assert.ok(Math.abs(sheet.w - 168) < 1e-6, '应铺满框宽');
  assert.deepEqual({ x: layer.offset.x, y: layer.offset.y }, { x: 0, y: 0 });
});

test('预览几何：动图容器的帧号被忽略（只有一帧可定位）', () => {
  const box = fakeBox(168, 168);
  const layer = fakeLayer();
  // 即使传了一个越界的帧号，也不该算出非零位移
  const at = applyFrameGeometry(box, { cols: 1, rows: 1 }, 1, 99,
                                { w: 100, h: 100 }, layer);
  assert.equal(at.col, 0);
  assert.equal(at.row, 0);
});

test('★ 动图容器的时长算不出来，因此返回 0（让调用方走兜底）', () => {
  // 一轮多久写在**文件自己的元数据**里（GIF 的 Netscape 扩展、
  // WebP 的 ANIM 块），插件读不到。编一个数字出来会让
  // 「播完回 idle」的定时器按假时长把动作提前打断。
  assert.equal(animationDuration({ animated: true, frames: 1 }), 0);
  assert.equal(animationDuration({ layout: 'animated', frames: 1 }), 0);
  // 普通单帧仍然返回 0（没有可播的帧），而多帧照常算
  assert.equal(animationDuration({ frames: 4, fps: 8 }), 500);
});

test('预览帧时长：动图容器只有一项（调用方不必判空）', () => {
  assert.equal(frameDurations({ animated: true, frames: 1 }).length, 1);
});

test('framePageCount：动图容器恒为 1 页（不能分页）', () => {
  assert.equal(framePageCount({ animated: true, pages: undefined }), 1);
  assert.equal(framePageCount({ animated: true, url: 'a.gif' }), 1);
});

test('frameGrid：只给一个方向时另一个按「装得下」补', () => {
  assert.deepEqual(frameGrid({ frames: 10, cols: 4 }), { cols: 4, rows: 3 });
  assert.deepEqual(frameGrid({ frames: 8, cols: 4 }), { cols: 4, rows: 2 });
  assert.deepEqual(frameGrid({ frames: 8, rows: 2 }), { cols: 4, rows: 2 });
  // 帧数少于一行时也不会推出 0 行
  assert.deepEqual(frameGrid({ frames: 3, cols: 8 }), { cols: 8, rows: 1 });
});

test('frameGrid：非法输入不产生 0 或 NaN', () => {
  for (const bad of [
    { frames: 4, cols: 0, rows: 0 }, { frames: 4, cols: -2 }, { frames: 4, rows: NaN },
    { frames: 0 }, { frames: -1 }, {},
  ]) {
    const grid = frameGrid(bad);
    assert.ok(grid.cols >= 1 && grid.rows >= 1, `${JSON.stringify(bad)} → ${JSON.stringify(grid)}`);
    assert.ok(Number.isInteger(grid.cols) && Number.isInteger(grid.rows));
  }
});

test('framePage：行优先定位（单页语义与从前一致）', () => {
  const grid = { cols: 4, rows: 4 };
  const pos = (i, frames) => {
    const at = framePage(i, grid, frames);
    return { col: at.col, row: at.row };
  };
  assert.deepEqual(pos(0, 13), { col: 0, row: 0 });
  assert.deepEqual(pos(3, 13), { col: 3, row: 0 });
  assert.deepEqual(pos(4, 13), { col: 0, row: 1 });
  assert.deepEqual(pos(12, 13), { col: 0, row: 3 });
  // 越界夹到最后一帧（不是落到空格子上）
  assert.deepEqual(pos(99, 13), { col: 0, row: 3 });
  assert.deepEqual(pos(-5, 13), { col: 0, row: 0 });
});

// ============================================================ 多页（pages）
//
// 多页与单页的差别全在**换页**上：换页要换 `background-image`（一次解码），
// 而换格只改 `background-position`（零成本）。因此坐标要分成两件事：
// 「在哪一页」（决定用哪张图）与「页里哪一格」（决定背景位移）。
//
// 帧序是**页优先、页内行优先**：先把第 0 页走完，再进第 1 页。
// 这与单页内 `grid` 的顺序完全一致，因此是自然扩展。


test('★ framePage：页优先、页内行优先', () => {
  // 2×2 网格，每页 4 帧，共 8 帧
  const grid = { cols: 2, rows: 2 };
  const expected = [
    { page: 0, local: 0, col: 0, row: 0 },
    { page: 0, local: 1, col: 1, row: 0 },
    { page: 0, local: 2, col: 0, row: 1 },
    { page: 0, local: 3, col: 1, row: 1 },
    { page: 1, local: 0, col: 0, row: 0 },   // ★ 第 4 帧换页，回到左上角
    { page: 1, local: 1, col: 1, row: 0 },
    { page: 1, local: 2, col: 0, row: 1 },
    { page: 1, local: 3, col: 1, row: 1 },
  ];
  for (const [index, want] of expected.entries()) {
    assert.deepEqual(framePage(index, grid, 8), want, `第 ${index} 帧`);
  }
});

test('★ framePage：单页时与单页定位完全一致（多页是自然扩展）', () => {
  // 单页包（绝大多数）的坐标必须与从前**逐值一致**，否则多页特性会
  // 悄悄改变所有既有形象的播放。
  const cases = [
    { grid: { cols: 4, rows: 1 }, frames: 4 },
    { grid: { cols: 1, rows: 4 }, frames: 4 },
    { grid: { cols: 4, rows: 4 }, frames: 13 },
  ];
  for (const item of cases) {
    for (let i = 0; i < item.frames; i += 1) {
      const at = framePage(i, item.grid, item.frames);
      assert.equal(at.page, 0, '单页时永远在第 0 页');
      assert.equal(at.local, i, '页内帧号就是全局帧号');
      assert.equal(at.col, i % item.grid.cols);
      assert.equal(at.row, Math.floor(i / item.grid.cols));
    }
  }
});

test('framePage：越界夹到最后一帧，不落到空格子上', () => {
  const grid = { cols: 2, rows: 2 };
  assert.deepEqual(framePage(99, grid, 6), framePage(5, grid, 6));
  assert.deepEqual(framePage(-3, grid, 6), { page: 0, local: 0, col: 0, row: 0 });
});

test('framePage：退化输入不产生 NaN 或负值', () => {
  for (const bad of [
    { cols: 0, rows: 0 }, { cols: -2, rows: 1 }, { cols: NaN, rows: NaN },
    null, undefined, {},
  ]) {
    const at = framePage(0, bad, 1);
    for (const key of ['page', 'local', 'col', 'row']) {
      assert.ok(Number.isInteger(at[key]) && at[key] >= 0,
        `${JSON.stringify(bad)} → ${key}=${at[key]}`);
    }
  }
});

test('framePageCount：页数由后端下发的 pages 决定（磁盘事实）', () => {
  assert.equal(framePageCount({ pages: ['a', 'b'] }), 2);
  assert.equal(framePageCount({ pages: ['a'] }), 1);
  // 单页包没有 pages → 1
  assert.equal(framePageCount({ url: 'a' }), 1);
  assert.equal(framePageCount({}), 1);
  assert.equal(framePageCount(null), 1);
  // 空数组视为「没给」
  assert.equal(framePageCount({ pages: [] }), 1);
});

test('★ 预览几何：多页时返回正确的页号（播放器靠它换图）', () => {
  // `applyFrameGeometry` 不碰 `background-image`（只有播放器知道 URL 列表），
  // 但它算出的 `page` 是播放器换页的**唯一依据**——算错就会铺错图。
  const box = fakeBox(168, 168);
  const layer = fakeLayer();
  const grid = { cols: 2, rows: 2 };
  for (const [index, wantPage] of [[0, 0], [3, 0], [4, 1], [7, 1]]) {
    const at = applyFrameGeometry(box, grid, 8, index, { w: 100, h: 100 }, layer);
    assert.equal(at.page, wantPage, `第 ${index} 帧应在第 ${wantPage} 页`);
  }
});

test('★ 预览几何：跨页时页内位移回到左上角（不是累加）', () => {
  // 第 4 帧是第 1 页的第 0 格，位移必须是 (0,0)——累加的话它会跑到
  // 第 1 页的右下角，看起来像「每过一页就偏一格」。
  const box = fakeBox(168, 168);
  const layer = fakeLayer();
  const grid = { cols: 2, rows: 2 };
  const first = applyFrameGeometry(box, grid, 8, 0, { w: 100, h: 100 }, layer);
  const offset0 = { x: layer.offset.x, y: layer.offset.y };
  const crossed = applyFrameGeometry(box, grid, 8, 4, { w: 100, h: 100 }, layer);
  assert.equal(crossed.page, 1);
  assert.equal(crossed.local, 0);
  assert.deepEqual(
    { x: layer.offset.x, y: layer.offset.y },
    offset0,
    '换页后的第 0 格位移应与第 0 页的第 0 格相同',
  );
});

test('预览几何：多页时整条 sheet 仍按**每页**的行列数铺', () => {
  // 每页形状相同，因此 sheet 尺寸公式不变——变的只是「铺哪一张图」。
  const box = fakeBox(168, 168);
  const layer = fakeLayer();
  applyFrameGeometry(box, { cols: 3, rows: 2 }, 12, 0, { w: 100, h: 100 }, layer);
  const perPage = layer.size;
  // 6 格/页 × 2 页 = 12 帧，但整条尺寸只反映**一页**（3×2），不是 12 格
  const cellW = perFrameWidth(perPage, 3);
  assert.ok(cellW > 0);
  const onePage = geom(168, 6, { cols: 3, rows: 2 }, 0, { w: 100, h: 100 });
  assert.deepEqual(perPage, onePage.layer.size, '整条尺寸应与同网格的单页一致');
});

/** 从整条尺寸与列数反推单帧宽（便于断言）。 */
function perFrameWidth(sheet, cols) {
  return sheet ? sheet.w / cols : 0;
}

test('预览几何：帧号越界被夹到合法范围', () => {
  const over = geom(168, 4, 'horizontal', 99, { w: 64, h: 64 });
  const last = geom(168, 4, 'horizontal', 3, { w: 64, h: 64 });
  assert.equal(over.layer.offset.x, last.layer.offset.x, '超上限应夹到最后一帧');
  assert.ok(Number.isFinite(over.frame.w));
});

test('预览几何：尺寸未知时退回按框铺满（老后端不下发尺寸）', () => {
  // 兼容性：不知道单帧比例时宁可铺满，也不能把图缩成一个点或算出 NaN。
  const { frame, layer } = geom(168, 1, 'horizontal', 0, null);
  assert.ok(Number.isFinite(frame.w) && Number.isFinite(frame.h));
  assert.ok(Math.abs(frame.w - 168) < 1e-6, '未知尺寸时按框宽铺满');
  assert.ok(Math.abs(frame.h - 168) < 1e-6, '未知尺寸时按框高铺满');
  assert.ok(layer.offset, '位移必须是有限数值，不能是 NaN');
});

test('预览几何：非法尺寸（0 / 负数 / NaN）不产生 NaN', () => {
  for (const bad of [{ w: 0, h: 0 }, { w: -10, h: 20 }, { w: NaN, h: NaN }, { w: 'x' }]) {
    const { frame, layer } = geom(168, 2, 'horizontal', 0, bad);
    assert.ok(
      Number.isFinite(frame.w) && Number.isFinite(frame.h),
      `${JSON.stringify(bad)} 尺寸应是有限值`,
    );
    const rect = layer.rect;
    assert.ok(
      Number.isFinite(rect.w) && Number.isFinite(rect.h)
      && Number.isFinite(rect.left) && Number.isFinite(rect.top),
      `${JSON.stringify(bad)} 内层几何应是有限值`,
    );
  }
});

test('预览几何：框没有尺寸时不崩（面板尚未挂载）', () => {
  const box = fakeBox(0, 0);
  const layer = fakeLayer();
  applyFrameGeometry(box, 1, 'horizontal', 0, { w: 100, h: 100 }, layer);
  assert.ok(layer.size, '应给出可用的回退值');
  assert.ok(layer.offset, '不应抛错');
  // 外框传 null 也不能抛
  applyFrameGeometry(null, 1, 'horizontal', 0, { w: 100, h: 100 }, layer);
});

test('预览几何：超大单帧被缩到框内（不会溢出）', () => {
  const { frame } = geom(168, 1, 'horizontal', 0, { w: 4000, h: 4000 });
  assert.ok(frame.w <= 168 + 1e-6 && frame.h <= 168 + 1e-6, '大图必须缩进来');
});

test('预览几何：不传内层时退回旧的单层行为（向后兼容）', () => {
  // 内层是推荐路径，但函数签名不能因为少了它就把几何全丢掉——
  // 那样一旦有调用方忘了传，预览会变成一片空白（比留白露邻帧更难查）。
  const box = fakeBox(168, 168);
  applyFrameGeometry(box, 1, 'horizontal', 0, { w: 627, h: 353 });
  const size = box.size;
  assert.ok(size, '不传内层时几何应写在外框上');
  assert.ok(Math.abs(size.w - 168) < 1e-6, '横构图用满框宽');
  assert.ok(box.offset, '位移应写在框上');
});

