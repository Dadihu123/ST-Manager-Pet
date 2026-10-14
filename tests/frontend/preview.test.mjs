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

import { frameDurations, totalDuration, applyFrameGeometry } from '../../frontend/preview.js';

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
function geom(boxSize, frames, layout, at, frameSize) {
  const box = fakeBox(boxSize, boxSize);
  const layer = fakeLayer();
  applyFrameGeometry(box, frames, layout, at, frameSize, layer);
  const sheet = layer.size;
  return {
    box,
    layer,
    // 单帧的显示尺寸 = 整条 / 帧数
    frame: layout === 'vertical'
      ? { w: sheet.w, h: sheet.h / frames }
      : { w: sheet.w / frames, h: sheet.h },
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
  assert.ok(
    Math.abs((frame.w / frame.h) - (627 / 353)) < 1e-6,
    `宽高比必须保持 627:353，实际 ${frame.w}×${frame.h}`,
  );
  // 横图受宽度限制：应该用满框宽
  assert.ok(Math.abs(frame.w - 168) < 1e-6, '横构图应该用满框宽');
  assert.ok(frame.h < 168, '高度按比例缩短，不能被拉满');
});

test('预览几何：底边对齐（横躺动作不能浮在半空）', () => {
  // 用户明确要求「预览动画底部和预览框对齐」。垂直居中会让横躺的睡觉
  // 浮在半空、与站立的动作对不齐，切换动作时画面上下跳。
  const { layer } = geom(168, 1, 'horizontal', 0, { w: 627, h: 353 });
  const rect = layer.rect;
  assert.ok(
    Math.abs((rect.top + rect.h) - 168) < 1e-6,
    `底边应贴着框底：top=${rect.top} + h=${rect.h} 应等于 168`,
  );
});

test('预览几何：水平居中', () => {
  const { layer } = geom(168, 1, 'horizontal', 0, { w: 627, h: 353 });
  const rect = layer.rect;
  const left = rect.left;
  const right = 168 - (rect.left + rect.w);
  assert.ok(Math.abs(left - right) < 1e-6, `左右留白应相等：${left} vs ${right}`);
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

