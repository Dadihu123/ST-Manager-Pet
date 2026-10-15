/**
 * 第三批问题验收：折叠触发时间 / 节奏落在哪 / 加一套与多页 / 固定预览。
 *
 * 用户提的四条：
 *
 * 1. 「触发时间折叠，这个的实现好像不太对啊，怎么好像整块直接消失了」；
 * 2. 「我注意到你说这个内置形象的更新在 settings 里面，是只有默认形象的
 *    在里面吗，是的话那就没问题，我理解既然是跟随形象走的，应该保存到
 *    pet.json 里面」；
 * 3. 「多套动画和多页，这两个逻辑你没发现目前交互逻辑是不同的吗，每个动作
 *    我可以点击换图来进行动画帧图的更新，但是只能更新啊，我如果像增加一套
 *    闲置动作，入口在哪里，我如果想设置多页的动作，入口又在哪里，
 *    我目前测试下来根本无法设置」；
 * 4. 「应用预览这个我希望能够优化一下……让这个预览框可以点击一下就固定到
 *    当前模态框的外面，比如右侧，滚动里面不会影响它的显示」。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 PET_SANDBOX_PETS=<沙箱 pets 目录> \
 *     node tools/verify-panel-ux3.mjs
 *
 * ⚠️ 本文件里凡是 `page.evaluate(\`...\`)` 的段落，**注释中不能用反引号**
 * ——反引号会提前结束模板字符串（这个坑踩过很多次）。
 */

import { launch } from './cdp.mjs';

const PORT = Number(process.env.PET_SANDBOX_PORT || 5099);
const BASE = `http://127.0.0.1:${PORT}`;
const PET_SELECTOR = '[data-plugin="stm-pet"].pet-root';

/**
 * 本套件专用的形象 id。
 *
 * ⚠️ 为什么不用现成的 `solid-grid-2x1-p2`：本套件会**真的**给它加一套动画、
 * 拆页、改触发时间。而 `verify-pet-editor.mjs` 是按「第一个可写的逐帧形象」
 * 自动挑目标的，于是它会挑到同一个形象——上一套件刚把它改成 `variants`
 * 写法，下一套件就找不到顶层 `fps` 了，报「期望 fps=5」这种假失败。
 *
 * 因此这里**自己复制一个**专用形象：各套件互不干扰，也都能单独重复跑。
 */
let TEST_PET = 'ux3-fixture';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`  ${mark}  ${name}\n`);
  if (detail) process.stdout.write(`          ${detail}\n`);
}

/** 打开面板并选中某个形象。 */
async function openPanel(page, petId) {
  await page.navigate(BASE, { timeout: 30000 });
  await page.waitFor('Boolean(window.__petApi)', { timeout: 20000 });
  await sleep(900);
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-ux3' });
    return true;
  })()`);
  await sleep(1800);
  await page.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
    const card = cards.find((node) => node.dataset.petId === '${petId}') || cards[0];
    if (card) card.click();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return true;
  })()`);
  await sleep(1200);
}

/**
 * 准备本套件专用的测试形象（复制一个多页形象；已经在了就复原到已知状态）。
 *
 * 用**复制**而不是新建：本套件要验的「拆页 / 合并」需要一个多页形象，
 * 而「加一套」需要可写。复制现成的 solid-grid-2x1-p2（2 页、2×1 网格）
 * 正好两个条件都满足，而且不动原始素材。
 *
 * 每次跑都先「删掉多余的套 + 合并回 1 页」，因此本套件**可以重复跑**。
 */
async function ensureFixture(page) {
  return page.evaluate(`(async () => {
    const api = window.__petApi.api;
    const list = await api('/pets', { method: 'GET' });
    // 复用上一次复制出来的那个（id 由后端生成，不能靠猜）
    const remembered = window.localStorage.getItem('ux3-fixture-id') || '';
    const existing = (list.items || []).find((i) => i.id === remembered);
    if (!existing) {
      const made = await api('/pets/solid-grid-2x1-p2/copy', {
        method: 'POST', body: { name: 'ux3 fixture' },
      });
      const id = made && made.pet ? made.pet.id : '';
      if (id) window.localStorage.setItem('ux3-fixture-id', id);
      return id;
    }
    window.__ux3Pet = remembered;
    // 已经在了：清掉上一轮留下的多余套，并合并回一页
    for (let guard = 0; guard < 8; guard += 1) {
      const pv = await api('/pets/${TEST_PET}/preview', { method: 'GET' });
      const idle = (pv.actions || []).find((a) => a.action === 'idle');
      const count = (idle.variants || []).length;
      if (count <= 1) break;
      await api('/pets/${TEST_PET}/actions/idle/variants/' + (count - 1),
        { method: 'DELETE' });
    }
    const pv2 = await api('/pets/${TEST_PET}/preview', { method: 'GET' });
    const idle2 = (pv2.actions || []).find((a) => a.action === 'idle');
    if ((idle2.pageCount || 1) > 1) {
      await api('/pets/${TEST_PET}/actions/idle/variants/0/pages',
        { method: 'POST', body: { pages: 1 } });
    }
    return remembered;
  })()`);
}

/** 点一个按钮（按可见文字）。 */
async function clickByText(page, text) {
  return page.evaluate(`(async () => {
    const button = [...document.querySelectorAll('.plugin-stm-pet button')]
      .find((node) => node.textContent.trim() === '${text}');
    if (!button) return false;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    return true;
  })()`);
}

const browser = await launch({ width: 1700, height: 1000 });
try {
  const page = await browser.newPage();
  await page.send('Runtime.enable');
  const errors = [];
  page.on('Runtime.exceptionThrown', (event) => {
    errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text);
  });

  // 先挂上面板（`ensureFixture` 要用页面里的 `window.__petApi`）
  await openPanel(page, TEST_PET);
  const fixture = await ensureFixture(page);
  if (fixture) TEST_PET = fixture;
  record(
    '① 前置：本套件专用的可写形象已就绪（不动其它套件用的素材）',
    Boolean(fixture),
    `id=${TEST_PET}`,
  );
  // 夹具准备好之后再重新选中它（复制出来的形象刚出现在列表里）
  await openPanel(page, TEST_PET);

  // ============================================ ① 折叠块真的渲染出来了
  //
  // 用户报障「怎么好像整块直接消失了」。根因：折叠块上写了
  // `overflow: hidden`，而 CSS 规范里 `min-height: auto` 只在
  // `overflow: visible` 时生效 —— flex 竖列把它压成 **2px**，内容全被裁掉。
  //
  // ⚠️ 判据必须是**真实高度**：那时 class 是 `is-open`、body 的
  // `display` 是 `block`，只查这两样完全看不出来（这正是第一版漏掉它的原因）。
  const collapsed = await page.evaluate(`(() => {
    const sections = [...document.querySelectorAll('.plugin-stm-pet .pet-section.is-collapsible')];
    return sections.map((section) => {
      const toggle = section.querySelector('.pet-section-toggle');
      const body = section.querySelector('.pet-section-body');
      return {
        label: section.querySelector('.pet-section-toggle-label').textContent.trim(),
        open: section.classList.contains('is-open'),
        sectionH: Math.round(section.getBoundingClientRect().height),
        toggleH: Math.round(toggle.getBoundingClientRect().height),
        bodyH: Math.round(body.getBoundingClientRect().height),
      };
    });
  })()`);
  record(
    '① 折叠块没有被压扁（标题行与展开内容都有真实高度）',
    collapsed.length >= 2
      && collapsed.every((item) => item.toggleH >= 20 && item.sectionH >= item.toggleH)
      && collapsed.filter((item) => item.open).every((item) => item.bodyH > 40),
    JSON.stringify(collapsed),
  );

  // 点一下真的能收起 / 展开（而不是「点了没反应」）
  const toggled = await page.evaluate(`(async () => {
    const section = [...document.querySelectorAll('.plugin-stm-pet .pet-section.is-collapsible')]
      .find((node) => node.querySelector('.pet-section-toggle-label').textContent.includes('触发时间'));
    const before = { open: section.classList.contains('is-open'),
                     h: Math.round(section.getBoundingClientRect().height) };
    section.querySelector('.pet-section-toggle').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = { open: section.classList.contains('is-open'),
                    h: Math.round(section.getBoundingClientRect().height),
                    bodyDisplay: getComputedStyle(section.querySelector('.pet-section-body')).display };
    // 再点回来
    section.querySelector('.pet-section-toggle').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const back = { open: section.classList.contains('is-open'),
                   h: Math.round(section.getBoundingClientRect().height) };
    return { before, after, back };
  })()`);
  record(
    '① 折叠 / 展开真的生效（收起后变矮、展开后回来，且标题行始终在）',
    toggled.before.open && !toggled.after.open && toggled.after.h < toggled.before.h
      && toggled.after.h >= 20 && toggled.back.open && toggled.back.h > 40,
    JSON.stringify(toggled),
  );

  // ============================================ ② 节奏落在哪（自建 → pet.json）
  const where = await page.evaluate(`(async () => {
    const api = window.__petApi.api;
    await api('/pets/${TEST_PET}/schedule', {
      method: 'POST',
      body: { schedule: { idle: { minIntervalMs: 2222, maxIntervalMs: 3333 } } },
    });
    const mine = await api('/pets/${TEST_PET}/preview', { method: 'GET' });
    await api('/pets/xiaoka/schedule', {
      method: 'POST',
      body: { schedule: { idle: { minIntervalMs: 4444, maxIntervalMs: 5555 } } },
    });
    const builtin = await api('/pets/xiaoka/preview', { method: 'GET' });
    return {
      mineWritable: mine.writable,
      mineEffective: mine.schedule.idle,
      mineDeclared: mine.declaredSchedule && mine.declaredSchedule.idle,
      builtinWritable: builtin.writable,
      builtinEffective: builtin.schedule.idle,
      builtinDeclared: builtin.declaredSchedule && builtin.declaredSchedule.idle,
    };
  })()`);
  record(
    '② 自建形象的节奏写进 pet.json（生效值 == 包内声明，导出时随包走）',
    where.mineWritable === true
      && where.mineEffective.minIntervalMs === 2222
      && where.mineDeclared
      && where.mineDeclared.minIntervalMs === 2222,
    JSON.stringify({ writable: where.mineWritable, 生效: where.mineEffective, 声明: where.mineDeclared }),
  );
  record(
    '② 内置形象仍可调，但只写本机设置（随包文件不动）',
    where.builtinWritable === false
      && where.builtinEffective.minIntervalMs === 4444
      && where.builtinDeclared
      && where.builtinDeclared.minIntervalMs === 6000,
    JSON.stringify({ writable: where.builtinWritable, 生效: where.builtinEffective, 包内: where.builtinDeclared }),
  );

  // 面板上要**说明**这件事（否则用户不知道自己的改动会不会随导出走）
  const wording = await page.evaluate(`(() => {
    const text = document.querySelector('.plugin-stm-pet .pet-panel-detail').textContent;
    return { hasPetJson: text.includes('pet.json'), hasLocal: text.includes('本机设置') };
  })()`);
  record(
    '② 面板写明了这些值存在哪里',
    wording.hasPetJson || wording.hasLocal,
    JSON.stringify(wording),
  );

  // ============================================ ③a 加一套的入口
  await clickByText(page, '动画参数');
  await sleep(900);

  const addEntry = await page.evaluate(`(() => {
    const tools = document.querySelector('.plugin-stm-pet .pet-editor-variant-tools');
    const pages = document.querySelector('.plugin-stm-pet [data-editor-pages]');
    return {
      addButton: tools
        ? [...tools.querySelectorAll('button')].map((node) => node.textContent.trim())
        : null,
      pagesInput: pages ? { value: pages.value, max: pages.max } : null,
      pagesButton: pages
        ? [...pages.closest('.pet-field').querySelectorAll('button')]
          .map((node) => node.textContent.trim())
        : null,
    };
  })()`);
  record(
    '③a 「加一套动画」的入口在编辑区里（用户说「根本无法设置」）',
    Boolean(addEntry.addButton && addEntry.addButton.some((text) => text.includes('加一套'))),
    JSON.stringify(addEntry.addButton),
  );
  record(
    '③b 「多页」的入口在编辑区里（填页数 + 重新拆）',
    Boolean(addEntry.pagesInput && addEntry.pagesButton
      && addEntry.pagesButton.some((text) => text.includes('拆'))),
    JSON.stringify({ 输入框: addEntry.pagesInput, 按钮: addEntry.pagesButton }),
  );

  // ============================================ ③ 加一套 / 删一套真的能用
  const variantFlow = await page.evaluate(`(async () => {
    const api = window.__petApi.api;
    const petId = '${TEST_PET}';
    // ⚠️ 先把多余的套删干净：本套件会真的加一套，重跑时若不清理就会
    // 越攒越多（实测第二次跑看到 4 套，断言「两套」直接失败）。
    // 验收脚本必须**可重复跑**，否则它只在第一次运行时说明问题。
    for (let guard = 0; guard < 8; guard += 1) {
      const now = await api('/pets/' + petId + '/preview', { method: 'GET' });
      const one = now.actions.find((a) => a.action === 'idle');
      const count = (one.variants || []).length;
      if (count <= 1) break;
      await api('/pets/' + petId + '/actions/idle/variants/' + (count - 1),
        { method: 'DELETE' });
    }

    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 75;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 100, 75);
    ctx.fillStyle = '#654321'; ctx.fillRect(100, 0, 75, 75);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

    const before = await api('/pets/' + petId + '/preview', { method: 'GET' });
    const beforeCount = (before.actions.find((a) => a.action === 'idle').variants || []).length;

    const form = new FormData();
    form.append('file', new File([blob], 'v2.png', { type: 'image/png' }));
    form.append('frames', '2');
    form.append('weight', '3');
    await api('/pets/' + petId + '/actions/idle/variants', { method: 'POST', body: form });

    const after = await api('/pets/' + petId + '/preview', { method: 'GET' });
    const idle = after.actions.find((a) => a.action === 'idle');
    return {
      beforeCount: beforeCount || 1,
      afterCount: (idle.variants || []).length,
      weights: (idle.variants || []).map((v) => v.weight),
    };
  })()`);
  record(
    '③ 加一套之后真的多了一套，权重按提交值落盘',
    variantFlow.afterCount === variantFlow.beforeCount + 1
      && variantFlow.weights.includes(3),
    JSON.stringify(variantFlow),
  );

  // 刷新面板后选套器里能看到两套
  //
  // ⚠️ 要**重新打开面板**再打开编辑区：上一步是直接打接口加的套，
  // 面板里的 `detail` 还是旧的（还显示一套）。而「动画参数」按钮是**切换**
  // 语义（点一下开、再点一下关），因此不能盲点一次——那会把已经打开的
  // 编辑区关掉，于是选套器一个都找不到（实测 `count: 0`）。
  await openPanel(page, TEST_PET);
  const editorOpened = await page.evaluate(`(async () => {
    const button = [...document.querySelectorAll('.plugin-stm-pet button')]
      .find((node) => node.textContent.trim() === '动画参数');
    if (!button) return false;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    return Boolean(document.querySelector('.plugin-stm-pet .pet-action-editor'));
  })()`);
  await sleep(600);
  const picker = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.plugin-stm-pet [data-editor-variant]')];
    return {
      count: nodes.length,
      labels: nodes.map((node) => node.textContent.trim()),
      hasDelete: [...document.querySelectorAll('.plugin-stm-pet .pet-editor-variant-tools button')]
        .some((node) => node.textContent.includes('删除')),
    };
  })()`);
  record(
    '③ 选套器列出了两套，并且出现了「删除第 N 套」',
    editorOpened && picker.count === 2 && picker.hasDelete,
    `编辑区打开=${editorOpened}；${JSON.stringify(picker)}`,
  );

  // ============================================ ③b 拆页真的能用且帧序不变
  const pageFlow = await page.evaluate(`(async () => {
    const api = window.__petApi.api;
    const petId = '${TEST_PET}';
    // 先把 idle 恢复成单页（之前可能已经拆过）
    const before = await api('/pets/' + petId + '/preview', { method: 'GET' });
    const idle = before.actions.find((a) => a.action === 'idle');
    const startPages = idle.pageCount || 1;
    let merged = null;
    if (startPages > 1) {
      merged = await api('/pets/' + petId + '/actions/idle/variants/0/pages',
        { method: 'POST', body: { pages: 1 } });
    }
    const split = await api('/pets/' + petId + '/actions/idle/variants/0/pages',
      { method: 'POST', body: { pages: 2 } });
    const after = await api('/pets/' + petId + '/preview', { method: 'GET' });
    const idle2 = after.actions.find((a) => a.action === 'idle');
    return {
      startPages,
      mergedSheets: merged ? merged.split.sheets : null,
      splitSheets: split.split.sheets,
      splitPerPage: split.split.perPage,
      afterPages: idle2.pageCount || 1,
      afterFrames: idle2.frames,
    };
  })()`);
  record(
    '③b 拆页 / 合并都真的改了 pet.json 与磁盘文件（页数变了、总帧数不变）',
    pageFlow.splitSheets.length === 2
      && pageFlow.splitPerPage >= 1
      && pageFlow.afterPages === 2
      && pageFlow.afterFrames === pageFlow.splitPerPage * 2,
    JSON.stringify(pageFlow),
  );

  // ============================================ ④ 固定预览
  await page.evaluate(`(async () => {
    const card = [...document.querySelectorAll('.plugin-stm-pet .pet-card')]
      .find((node) => node.dataset.petId === '${TEST_PET}');
    if (card) card.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return true;
  })()`);
  await sleep(1000);

  const floatBefore = await page.evaluate(`(() => {
    const button = document.querySelector('.plugin-stm-pet [data-preview-float]');
    const host = document.querySelector('.plugin-stm-pet [data-preview-float-host]');
    const body = document.querySelector('.plugin-stm-pet .pet-panel-body');
    return {
      hasButton: Boolean(button),
      label: button ? button.textContent.trim() : null,
      hasHost: Boolean(host),
      columns: getComputedStyle(body).gridTemplateColumns.split(' ').length,
    };
  })()`);
  record(
    '④ 预览区有「固定到右侧」的入口，默认不固定（仍是两栏）',
    floatBefore.hasButton && !floatBefore.hasHost && floatBefore.columns === 2,
    JSON.stringify(floatBefore),
  );

  // ★ 开关必须**不用滚动就能看见**。
  //
  // 用户报障：「你前面说的固定预览实现了吗，我更新了一下好像没有看到变化？」
  // —— 功能是在的，但第一版只把开关放在预览区里（第 4 个区块），
  // 实测距详情栏顶部 **1229px** 而详情栏只有 500px 高：要找到它得先滚过
  // 整个外观与触发时间。那恰好是它想解决的问题
  // （「为了不滚动，先滚动过去把它打开」），所以它实际上等于不存在。
  //
  // 因此判据不是「按钮存在」，而是**它在首屏里**。
  const aboveFold = await page.evaluate(`(() => {
    const detail = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    if (!detail) return { found: false };
    const detailTop = detail.getBoundingClientRect().top;
    const buttons = [...document.querySelectorAll('.plugin-stm-pet [data-preview-float]')];
    return {
      found: buttons.length > 0,
      count: buttons.length,
      // 详情栏没滚动时，第一个开关距顶部的距离
      距顶部: buttons.length
        ? Math.round(buttons[0].getBoundingClientRect().top - detailTop) : null,
      可视高: detail.clientHeight,
      滚动位置: detail.scrollTop,
    };
  })()`);
  record(
    '④ ★ 固定预览的开关**不用滚动就能看到**（用户报「没看到变化」的根因）',
    aboveFold.found && aboveFold.滚动位置 === 0
      && aboveFold.距顶部 !== null && aboveFold.距顶部 < aboveFold.可视高 / 2,
    `开关距详情栏顶部 ${aboveFold.距顶部}px，详情栏可视高 ${aboveFold.可视高}px`
    + `（共 ${aboveFold.count} 个开关）`,
  );

  await page.evaluate(`(() => {
    const button = document.querySelector('.plugin-stm-pet [data-preview-float]');
    if (button) button.click();
    return true;
  })()`);
  await sleep(1000);

  const floatAfter = await page.evaluate(`(() => {
    const host = document.querySelector('.plugin-stm-pet [data-preview-float-host]');
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    const body = document.querySelector('.plugin-stm-pet .pet-panel-body');
    return {
      hasHost: Boolean(host),
      boxInsideHost: host ? host.contains(box) : false,
      columns: getComputedStyle(body).gridTemplateColumns.split(' ').length,
      boxW: box ? Math.round(box.getBoundingClientRect().width) : null,
      buttonLabel: (document.querySelector('.plugin-stm-pet [data-preview-float]') || {}).textContent,
    };
  })()`);
  record(
    '④ 点一下之后预览框挪进了固定栏（真的多出一列，不是 position: fixed）',
    floatAfter.hasHost && floatAfter.boxInsideHost && floatAfter.columns === 3
      && floatAfter.boxW > 40,
    JSON.stringify(floatAfter),
  );

  // ★ 关键判据：滚动详情栏，预览框**不能动**
  const drift = await page.evaluate(`(async () => {
    const detail = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    const before = Math.round(box.getBoundingClientRect().top);
    if (detail) detail.scrollTop = 700;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = Math.round(box.getBoundingClientRect().top);
    const detailScrolled = detail ? detail.scrollTop : 0;
    return { before, after, drift: Math.abs(after - before), detailScrolled };
  })()`);
  record(
    '④ 滚动设置时预览框一动不动（用户要的就是这个）',
    drift.detailScrolled > 100 && drift.drift === 0,
    `详情栏滚到 ${drift.detailScrolled}px，预览框 top ${drift.before} → ${drift.after}（位移 ${drift.drift}px）`,
  );

  // 取消固定要能回到原位
  await page.evaluate(`(() => {
    const button = document.querySelector('.plugin-stm-pet [data-preview-float]');
    if (button) button.click();
    return true;
  })()`);
  await sleep(1000);
  const floatOff = await page.evaluate(`(() => {
    const host = document.querySelector('.plugin-stm-pet [data-preview-float-host]');
    const stage = document.querySelector('.plugin-stm-pet .pet-preview-stage');
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    const body = document.querySelector('.plugin-stm-pet .pet-panel-body');
    return {
      hasHost: Boolean(host),
      boxBackInStage: stage ? stage.contains(box) : false,
      columns: getComputedStyle(body).gridTemplateColumns.split(' ').length,
    };
  })()`);
  record(
    '④ 取消固定后预览框回到原位（第三列消失、框回到预览区）',
    !floatOff.hasHost && floatOff.boxBackInStage && floatOff.columns === 2,
    JSON.stringify(floatOff),
  );

  // 预览在固定状态下**真的在播**（不是挪过去之后变成一张死图）
  await page.evaluate(`(() => {
    const button = document.querySelector('.plugin-stm-pet [data-preview-float]');
    if (button) button.click();
    return true;
  })()`);
  await sleep(1200);
  const playing = await page.evaluate(`(async () => {
    const toggle = document.querySelector('.plugin-stm-pet [data-preview-toggle]');
    if (toggle && toggle.textContent.trim() === '播放') {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // ⚠️ 背景图与帧位移在**内层** .pet-preview-frame-layer 上，不在外框
    // .pet-preview-box 上（外框只负责「按比例装入」留白，见 verify-panel ⑥）。
    // 第一版量了外框，于是恒得「1 个帧位、background-image: none」，
    // 看起来像「固定之后预览死了」，实际是量错了元素。
    // （本段在模板字符串里，注释中不能用反引号。）
    const box = document.querySelector('.plugin-stm-pet .pet-preview-box');
    const layer = box ? box.querySelector('.pet-preview-frame-layer') : null;
    const seen = new Set();
    for (let index = 0; index < 16; index += 1) {
      if (layer) seen.add(getComputedStyle(layer).backgroundPosition);
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    return {
      distinct: seen.size,
      samples: [...seen].slice(0, 3),
      hasImage: layer ? getComputedStyle(layer).backgroundImage !== 'none' : false,
    };
  })()`);
  record(
    '④ 固定之后预览仍在正常播放（挪动没有把播放器弄死）',
    playing.distinct >= 2 && playing.hasImage,
    `${playing.distinct} 个不同帧位（有图=${playing.hasImage}）: ${playing.samples.join(' | ')}`,
  );

  record(
    '全程没有未捕获的 JS 异常',
    errors.length === 0,
    errors.length ? errors.slice(0, 2).join(' / ') : '无',
  );
} finally {
  await browser.close();
}

const passed = results.filter((item) => item.ok).length;
process.stdout.write(`\n第三批问题验收：${passed}/${results.length} 通过\n`);
process.exit(passed === results.length ? 0 : 1);
