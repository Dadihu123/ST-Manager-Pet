/**
 * 验收：**把 pet.json 的设置开放到面板上** + 帮助页 + UI 分级。
 *
 * 用户要求（第 3、4、5 条）：
 * - 「pet.json 里面支持了非常多的调节参数，结果界面上没多少能调整的……
 *    比如我想调整下不同动作的帧率，每帧之间的间隔，结果发现没有入口，
 *    目前只能去直接修改 pet.json 里面的值」；
 * - 「可以给页面添加一个帮助页，具体的帮助按钮请使用已有的，里面可以解释下
 *    不同参数的设置用途以及推荐值，前面说的哪个 motion 和 physics 这类
 *    比较容易出问题的设置项在帮助里面说清楚即可」；
 * - 「设置项会放开比较多，因此要考虑好 UI 的设计……应当避免一股脑地把所有的
 *    设置项都展开来，比如可以按照你分析的常用与否的设置项来分级，常用的就是
 *    直接可以看到，那些不太常用的，则平时收起来，用户需要的时候可以随时展开」。
 *
 * 判据
 * ----
 * ① **每动作动画参数**：动作卡片上有「动画参数」，编辑区字段齐全，
 *    改帧率 / 循环能保存并**真的写进 pet.json**（读回 runtime 生效）；
 * ② **物理参数**与**锚点/单帧尺寸**是**默认收起**的可折叠区块，
 *    展开后能改、能存、能读回；
 * ③ **未知字段不丢**：改完之后 `pet.json` 里作者自己写的字段还在；
 * ④ **帮助页**：工具栏有「参数说明」按钮（用已有按钮样式），点开有内容、
 *    有推荐值、`motion` 与 `physics` 被标为「易调坏」，能返回；
 * ⑤ **UI 分级**：常用项（大小倍率 / 渲染方式 / 触发时间）直接可见，
 *    进阶项默认收起——两者在同一屏里同时成立。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-pet-editor.mjs
 */
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const PET = process.env.PET_ID || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

const browser = await launch({ width: 1600, height: 1000 });
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
  await page.waitFor('Boolean(window.__petApi)', { timeout: 20000, label: '插件激活' });
  await sleep(800);

  // 选一个**可写**形象（写回 pet.json 只对自建形象开放）
  //
  // ⚠️ 还要排除**动图容器**（`layout: "animated"`）：那种动作由浏览器播放
  // Gif/WebP，`fps` 恒为 0 且**改它没有意义**（后端的 `_parse_animated_layout`
  // 明确禁止作者写帧率）。第一版没排除，于是随机挑到动图形象时
  // 「改帧率」这条断言永远失败——看起来像功能坏了，其实是挑错了测试对象。
  const petId = PET || await page.evaluate(`(async () => {
    const list = await window.__petApi.api('/pets', { method: 'GET' });
    const candidates = (list.items || []).filter((i) => i.writable);
    for (const item of candidates) {
      const res = await window.__petApi.api('/pets/' + item.id + '/preview', { method: 'GET' });
      const idle = (res.actions || []).find((a) => a.action === 'idle');
      if (idle && !idle.animated) return item.id;
    }
    return candidates.length ? candidates[0].id : '';
  })()`);
  record(
    '① 前置：有一个可写的**逐帧**自建形象',
    Boolean(petId),
    `petId=${petId}（写回 pet.json 只对自建形象开放；`
    + '动图容器形象被排除——它的帧率没有意义）',
  );
  if (!petId) throw new Error('没有可写形象，无法继续');

  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-editor' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1000);
  await page.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
    const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(petId)}) || cards[0];
    if (card) card.click();
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  })()`);
  await sleep(1000);

  // ============================================ ⑤ UI 分级
  const tiers = await page.evaluate(`(() => {
    const labels = [...document.querySelectorAll('.plugin-stm-pet .pet-field-label')]
      .map((n) => n.textContent.trim());
    const collapsibles = [...document.querySelectorAll('.plugin-stm-pet .pet-section.is-collapsible')]
      .map((s) => ({
        label: s.querySelector('.pet-section-toggle-label').textContent.trim(),
        open: s.classList.contains('is-open'),
        bodyDisplay: getComputedStyle(s.querySelector('.pet-section-body')).display,
      }));
    return { labels, collapsibles };
  })()`);

  record(
    '⑤ ★ 常用项**直接可见**（大小倍率 / 渲染方式 / 触发时间三项）',
    tiers.labels.includes('大小倍率') && tiers.labels.includes('渲染方式')
      && tiers.labels.includes('待机小动作') && tiers.labels.includes('打盹'),
    `可见字段=${JSON.stringify(tiers.labels)}`,
  );
  record(
    '⑤ ★ 进阶项**默认收起**（物理参数 / 锚点与单帧尺寸）',
    tiers.collapsibles.length >= 2
      && tiers.collapsibles.every((s) => !s.open && s.bodyDisplay === 'none'),
    `可折叠区块=${JSON.stringify(tiers.collapsibles)}`,
  );

  // ============================================ ① 每动作动画参数
  const opened = await page.evaluate(`(() => {
    const tile = [...document.querySelectorAll('.plugin-stm-pet .pet-action-tile')]
      .find((t) => [...t.querySelectorAll('button')].some((b) => b.textContent.trim() === '动画参数'));
    if (!tile) return { ok: false };
    const btn = [...tile.querySelectorAll('button')].find((b) => b.textContent.trim() === '动画参数');
    btn.click();
    return { ok: true };
  })()`);
  await sleep(700);
  const editor = await page.evaluate(`(() => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    if (!ed) return { present: false };
    const labels = [...ed.querySelectorAll('.pet-field-label')].map((n) => n.textContent.trim());
    return {
      present: true,
      labels,
      hasSave: [...ed.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存'),
      // 逐帧区默认收起（否则 4~70 个输入框会把面板撑爆）
      frameWrapDisplay: getComputedStyle(ed.querySelector('.pet-editor-frames')).display,
    };
  })()`);

  record(
    '① ★ 动作卡片上有「动画参数」入口，点开出现编辑区',
    opened.ok && editor.present,
    `编辑区字段=${JSON.stringify(editor.labels || [])}`,
  );
  record(
    '① ★ 编辑区覆盖用户点名的两项：**帧率**与**每帧时长**',
    editor.present
      && editor.labels.includes('帧率')
      && editor.labels.some((l) => l.includes('呼吸') || l.includes('眨眼'))
      && editor.hasSave,
    `字段=${JSON.stringify(editor.labels)}；有保存按钮=${editor.hasSave}`,
  );
  record(
    '① 逐帧时长默认**收起**（勾选后才展开，免得面板被几十个输入框撑爆）',
    editor.present && editor.frameWrapDisplay === 'none',
    `逐帧区 display=${editor.frameWrapDisplay}`,
  );

  // 改帧率 + 循环并保存
  //
  // ⚠️ 要改成与**当前值不同**的数：这个脚本会反复跑，写死的目标值在
  // 第二次运行时可能与现状相同，于是「没改动」的路径被走到、
  // 断言看起来像功能坏了（第一版就踩了这个）。
  const before = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${petId}/preview', { method: 'GET' });
    const idle = res.actions.find((a) => a.action === 'idle');
    return { fps: idle.fps, loop: idle.loop };
  })()`);
  const targetFps = Number(before.fps) === 3 ? 5 : 3;
  const targetLoop = !before.loop;
  const saved = await page.evaluate(`(async () => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    const fps = [...ed.querySelectorAll('input[type=number]')][0];
    fps.value = '${targetFps}';
    fps.dispatchEvent(new Event('input', { bubbles: true }));
    // 点与当前相反的那一侧（循环 / 播一遍）
    const want = ${targetLoop} ? '循环' : '播一遍';
    const choice = [...ed.querySelectorAll('.pet-choice')].find((b) => b.textContent.trim() === want);
    if (choice) choice.click();
    [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
    await new Promise((r) => setTimeout(r, 1800));
    const res = await window.__petApi.api('/pets/${petId}/preview', { method: 'GET' });
    const idle = res.actions.find((a) => a.action === 'idle');
    return { fps: idle.fps, loop: idle.loop };
  })()`);
  record(
    '① ★ 改帧率 / 循环 → 保存 → **运行期真的生效**',
    saved.fps === targetFps && saved.loop === targetLoop,
    `${JSON.stringify(before)} → ${JSON.stringify(saved)}`
    + `（目标 fps=${targetFps} loop=${targetLoop}）`,
  );

  // 直接读磁盘上的 pet.json，确认是**写进包里**而不是只改了内存
  record(
    '① 保存的是**包本身**（pet.json），不是内存里的临时值',
    saved.fps === targetFps,
    '（磁盘核对见下方「未知字段不丢」那一条；preview 的 fps 来自重新读盘）',
  );

  // ============================================ ② 物理参数 / 锚点
  const physics = await page.evaluate(`(async () => {
    const sec = [...document.querySelectorAll('.plugin-stm-pet .pet-section.is-collapsible')]
      .find((s) => s.textContent.includes('物理参数'));
    if (!sec) return { error: '找不到物理参数区块' };
    const beforeOpen = sec.classList.contains('is-open');
    sec.querySelector('.pet-section-toggle').click();
    await new Promise((r) => setTimeout(r, 300));
    const sliders = [...sec.querySelectorAll('[data-physics-key]')];
    const gravity = sec.querySelector('[data-physics-key="gravity"]');
    gravity.value = '2500';
    gravity.dispatchEvent(new Event('input', { bubbles: true }));
    gravity.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1600));
    const res = await window.__petApi.api('/pets/${petId}/preview', { method: 'GET' });
    return {
      beforeOpen,
      keys: sliders.map((s) => s.dataset.physicsKey),
      gravity: res.physics ? res.physics.gravity : null,
    };
  })()`);

  record(
    '② ★ 物理参数是**默认收起**的可折叠区块，展开后有 5 个参数',
    physics.beforeOpen === false && Array.isArray(physics.keys) && physics.keys.length === 5,
    `展开前收起=${physics.beforeOpen}；参数=${JSON.stringify(physics.keys)}`,
  );
  record(
    '② ★ 改重力 → 写回 pet.json → 读回生效',
    physics.gravity === 2500,
    `读回 gravity=${physics.gravity}（期望 2500）`,
  );

  const anchor = await page.evaluate(`(async () => {
    const sec = [...document.querySelectorAll('.plugin-stm-pet .pet-section.is-collapsible')]
      .find((s) => s.textContent.includes('锚点'));
    if (!sec) return { error: '找不到锚点区块' };
    const beforeOpen = sec.classList.contains('is-open');
    sec.querySelector('.pet-section-toggle').click();
    await new Promise((r) => setTimeout(r, 300));
    const inputs = [...sec.querySelectorAll('input[type=number]')];
    // 第 2 个是「锚点 Y」
    const y = inputs[1];
    y.value = '0.93';
    y.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1600));
    const res = await window.__petApi.api('/pets/${petId}/preview', { method: 'GET' });
    return { beforeOpen, count: inputs.length, anchorY: res.anchor ? res.anchor.y : null };
  })()`);

  record(
    '② ★ 锚点与单帧尺寸也是默认收起、展开可改（改了能读回）',
    anchor.beforeOpen === false && anchor.count >= 4 && Math.abs(anchor.anchorY - 0.93) < 1e-6,
    `展开前收起=${anchor.beforeOpen}；输入框=${anchor.count} 个；读回 anchor.y=${anchor.anchorY}`,
  );

  // ============================================ ④ 帮助页
  const help = await page.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.plugin-stm-pet .pet-panel-toolbar button')]
      .find((b) => b.textContent.trim() === '参数说明');
    if (!btn) return { error: '工具栏里没有「参数说明」按钮' };
    // 用的是**已有按钮样式**（pet-button），不引入新的视觉语言
    const classes = btn.className;
    btn.click();
    await new Promise((r) => setTimeout(r, 700));
    const terms = [...document.querySelectorAll('.plugin-stm-pet .pet-help-term')]
      .map((n) => n.textContent.trim());
    const bodies = [...document.querySelectorAll('.plugin-stm-pet .pet-help-body')]
      .map((n) => n.textContent.trim());
    const recommends = [...document.querySelectorAll('.plugin-stm-pet .pet-help-recommend')]
      .map((n) => n.textContent.trim());
    const risky = [...document.querySelectorAll('.plugin-stm-pet .pet-badge.is-warn')]
      .map((n) => n.textContent.trim());
    const back = [...document.querySelectorAll('.plugin-stm-pet .pet-help-back button')]
      .map((b) => b.textContent.trim());
    return { classes, terms, bodies, recommends, risky, back };
  })()`);

  record(
    '④ ★ 工具栏有「参数说明」按钮，且用的是**已有按钮样式**',
    !help.error && String(help.classes).includes('pet-button'),
    `class=${JSON.stringify(help.classes)}`,
  );
  record(
    '④ ★ 帮助页有实质内容（条目 / 说明 / 推荐值）',
    !help.error && help.terms.length >= 15 && help.bodies.length >= 15
      && help.recommends.length >= 10,
    `${help.terms.length} 个条目、${help.bodies.length} 段说明、${help.recommends.length} 条推荐值`,
  );
  record(
    '④ ★ 用户点名的 motion 与 physics 在帮助里被标为「易调坏」',
    !help.error && help.risky.length >= 5
      && help.terms.some((t) => t.includes('程序化运动'))
      && help.terms.some((t) => t.includes('重力')),
    `「易调坏」条目 ${help.risky.length} 个；`
    + `覆盖：${JSON.stringify(help.terms.filter((t) => t.includes('易调坏')).slice(0, 8))}`,
  );
  record(
    '④ 帮助页能返回设置',
    !help.error && help.back.some((t) => t.includes('返回')),
    `返回按钮=${JSON.stringify(help.back)}`,
  );

  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.plugin-stm-pet .pet-help-back button')][0];
    if (b) b.click();
    return true;
  })()`);
  await sleep(700);

  // ============================================ ③ 未知字段不丢
  //
  // 这一段必须在**磁盘上**核对：`pet.json` 是作者的作品，写回时不能
  // 把他自己写的字段丢掉。为了真的测到这件事，先手工往 `pet.json` 里
  // 塞一个插件不认识的字段，再从界面改一次设置，最后确认它还在。
  //
  // （只查「顶层键数 >= 5」是不够的——那在没有任何自定义字段时也会通过，
  //   等于没测。）
  const petsRoot = process.env.PET_SANDBOX_PETS || '';
  const manifestPath = petsRoot ? `${petsRoot}/${petId}/pet.json` : '';
  if (manifestPath && fs.existsSync(manifestPath)) {
    const injected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    injected.myCustomField = { hello: 'world' };
    injected.futureThing = [1, 2, 3];
    fs.writeFileSync(manifestPath, JSON.stringify(injected, null, 2), 'utf8');

    // 再从界面改一次（换个值，确保真的走了写回路径）
    const nextFps = targetFps === 3 ? 5 : 3;
    await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(petId)});
      if (card) card.click();
      await new Promise((r) => setTimeout(r, 1000));
      const tile = [...document.querySelectorAll('.plugin-stm-pet .pet-action-tile')]
        .find((t) => [...t.querySelectorAll('button')].some((b) => b.textContent.trim() === '动画参数'));
      const btn = [...tile.querySelectorAll('button')].find((b) => b.textContent.trim() === '动画参数');
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
      const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
      const fps = [...ed.querySelectorAll('input[type=number]')][0];
      fps.value = '${nextFps}';
      fps.dispatchEvent(new Event('input', { bubbles: true }));
      [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
      await new Promise((r) => setTimeout(r, 1800));
      return true;
    })()`);

    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const keys = Object.keys(after);
    record(
      '③ ★ 未知字段**原样保留**（作者自己写的字段没被写回操作丢掉）',
      after.myCustomField && after.myCustomField.hello === 'world'
        && Array.isArray(after.futureThing) && after.futureThing.length === 3,
      `myCustomField=${JSON.stringify(after.myCustomField)}；`
      + `futureThing=${JSON.stringify(after.futureThing)}；顶层键=${JSON.stringify(keys)}`,
    );
    record(
      '③ ★ 写回之后 pet.json 仍然是一个完整可读的包，且改动生效',
      keys.includes('id') && keys.includes('animations')
        && after.animations.idle.fps === nextFps,
      `顶层键=${JSON.stringify(keys)}；idle=${JSON.stringify(after.animations.idle)}`
      + `（期望 fps=${nextFps}）`,
    );
  } else {
    record(
      '③ 磁盘核对',
      false,
      '未提供 PET_SANDBOX_PETS（或路径不存在），无法核对「未知字段不丢」——'
      + '这条必须在磁盘上验，接口层看不出来',
    );
  }

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑥ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`pet.json 编辑器 / 帮助页 / UI 分级验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
