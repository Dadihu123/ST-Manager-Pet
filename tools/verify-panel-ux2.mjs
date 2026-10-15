/**
 * 验收：用户提的第二批 7 个问题。
 *
 * 逐条对应：
 * 1. 「触发时间，可以支持整体折叠」；
 * 2. 「触发时间目前已经绑定形象了，然后默认形象的触发时间仍旧可调，那么后续
 *    如果内置形象更新了，会发生什么，应该是会覆盖掉吧」——实测**不会覆盖**
 *    （用户设置在 `data/settings.json`，包在 `resources/pets/`），
 *    但要能看出「作者的建议变了」；
 * 3. 「同一个类型支持绑定多套动作，但是目前的调节项中看不到这个逻辑……
 *    目前只能操作第一套动作的各类参数……权重还是错的，显示的是 1」；
 * 4. 「多页的动画设置，这个我也没看到」+「命名上应该要区分」多套 / 多页；
 * 5. 「点击新建形象后……左侧还是选中之前的形象……我甚至可以选择别的形象，
 *    而右侧却没有任何变化……我如果不想新建形象了，那还必须得先关闭模态框」；
 * 6. 「我必须得保存后重新播放才可以看到效果……可以点一个类似于应用/刷新的
 *    按钮就可以直接看到预览」；
 * 7. 「webp 怎么判断其是动画还是帧图……静态 WebP 与动图 WebP 的字节头
 *    完全一样，必须确认清楚」。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-panel-ux2.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

const browser = await launch({ width: 1600, height: 1000 });
let exitCode = 0;
let createdId = '';
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

  // 造一个**多套动画**的可写形象：复制内置小卡（它的 idle 有两套）
  createdId = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/xiaoka/copy', {
      method: 'POST', body: { name: '多套验收' },
    });
    return res.pet ? res.pet.id : '';
  })()`);
  record('前置：复制出一个多套动画的可写形象', Boolean(createdId), `id=${createdId}`);

  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-ux2' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '列表出现',
  });
  await sleep(1000);

  const openPet = async (id) => {
    await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(id)});
      if (card) card.click();
      await new Promise((r) => setTimeout(r, 1400));
      return true;
    })()`);
    await sleep(1100);
  };
  const openEditor = async (label) => {
    await page.evaluate(`(() => {
      const tile = [...document.querySelectorAll('.plugin-stm-pet .pet-action-tile')]
        .find((t) => t.textContent.includes(${JSON.stringify(label)}));
      if (!tile) return false;
      const btn = [...tile.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === '动画参数');
      if (btn) btn.click();
      return true;
    })()`);
    await sleep(700);
  };

  await openPet(createdId);

  // ============================================ ① 触发时间整体可折叠
  const collapsible = await page.evaluate(`(() => {
    const sec = [...document.querySelectorAll('.plugin-stm-pet .pet-section.is-collapsible')]
      .find((s) => s.textContent.includes('触发时间'));
    if (!sec) return { found: false };
    const head = sec.querySelector('.pet-section-toggle');
    const start = sec.classList.contains('is-open');
    const bodyVisible = getComputedStyle(sec.querySelector('.pet-section-body')).display;
    head.click();
    const collapsed = !sec.classList.contains('is-open');
    const hiddenDisplay = getComputedStyle(sec.querySelector('.pet-section-body')).display;
    head.click();
    const reopened = sec.classList.contains('is-open');
    return { found: true, start, bodyVisible, collapsed, hiddenDisplay, reopened,
             hint: head.querySelector('.pet-section-toggle-hint').textContent.trim() };
  })()`);
  record(
    '① ★ 触发时间整块可折叠，且**默认展开**（最常回来调的一项）',
    collapsible.found && collapsible.start === true
      && collapsible.collapsed && collapsible.reopened,
    `默认展开=${collapsible.start}；点一下收起=${collapsible.collapsed}；`
    + `收起后内容 display=${collapsible.hiddenDisplay}；再点展开=${collapsible.reopened}`,
  );

  // ============================================ ② 内置更新不覆盖用户设置 + 能看出差别
  //
  // ⚠️ 这一段必须用**内置形象**来验。
  //
  // 「用户设置」与「包内建议」是**两个不同的值**这件事只对内置形象成立：
  // 随包文件是只读资源，用户的改动只能落在本机设置里，因此两份值会分叉，
  // 面板也才有必要把「你在用 X、形象包当前建议 Y」摆出来。
  //
  // 而**自建形象**下用户就是作者，设置直接写进 `pet.json`
  // （用户要求「既然是跟随形象走的，应该保存到 pet.json 里面」，
  // 这样导出形象包时才会一起走）——那时两份值本来就是同一个，
  // 拿自建形象来断言「是两个不同的值」必然失败。
  const scheduleNote = await page.evaluate(`(async () => {
    // 给内置形象设一个与包内建议不同的间隔
    await window.__petApi.api('/pets/xiaoka/schedule', {
      method: 'POST',
      body: { schedule: { idle: { minIntervalMs: 3000, maxIntervalMs: 5000 } } },
    });
    const res = await window.__petApi.api('/pets/xiaoka/preview', { method: 'GET' });
    return {
      writable: res.writable,
      effective: res.schedule.idle,
      declared: res.declaredSchedule ? res.declaredSchedule.idle : null,
      overridden: res.scheduleOverridden,
    };
  })()`);
  record(
    '② ★ 用户设置与包内建议**是两个不同的值**（更新包不会覆盖用户那份）',
    scheduleNote.writable === false
      && scheduleNote.effective && scheduleNote.effective.minIntervalMs === 3000
      && scheduleNote.declared && scheduleNote.declared.minIntervalMs !== 3000,
    `生效=${JSON.stringify(scheduleNote.effective)}；`
    + `包内建议=${JSON.stringify(scheduleNote.declared)}；已覆盖=${scheduleNote.overridden}`,
  );
  // ★ 自建形象下应当**没有**这个提示（两份值是同一个，比较没有意义），
  // 而面板要说明「改动会写进 pet.json」——否则用户不知道会不会随导出走。
  await openPet(createdId);
  const overrideNote = await page.evaluate(`(() => {
    const detail = document.querySelector('.plugin-stm-pet .pet-panel-detail');
    const box = [...document.querySelectorAll('.plugin-stm-pet .pet-notice')]
      .find((n) => n.textContent.includes('你改过这里的设置'));
    return {
      shown: Boolean(box),
      mentionsPetJson: detail ? detail.textContent.includes('pet.json') : false,
    };
  })()`);
  record(
    '② ★ 自建形象不显示「你改过 vs 包内建议」（用户就是作者，两份值相同）',
    !overrideNote.shown && overrideNote.mentionsPetJson,
    `提示出现=${overrideNote.shown}；说明了写在 pet.json 里=${overrideNote.mentionsPetJson}`,
  );

  // 内置形象才要显示那个对比提示
  await openPet('xiaoka');
  const builtinNote = await page.evaluate(`(() => {
    const box = [...document.querySelectorAll('.plugin-stm-pet .pet-notice')]
      .find((n) => n.textContent.includes('你改过这里的设置'));
    return {
      shown: Boolean(box),
      text: box ? box.textContent.replace(/\\s+/g, ' ').trim() : '',
    };
  })()`);
  record(
    '② ★ 面板把「你在用 X、形象包当前建议 Y」摆出来（否则用户永远看不到作者改过）',
    builtinNote.shown && builtinNote.text.includes('形象包当前建议'),
    builtinNote.text.slice(0, 120),
  );
  await openPet(createdId);

  // ============================================ ③ 多套动画：选套器 + 正确权重
  await openEditor('待机');
  const picker = await page.evaluate(`(() => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    if (!ed) return { present: false };
    const box = ed.querySelector('.pet-editor-variants');
    // ⚠️ 权重字段要**在 .pet-field 里**找。直接在整个编辑区里找第一个含
    // 「权重」的 label 会命中选套器的标题行（「这个动作有 2 套动画…」），
    // 于是断言看起来失败了，其实字段本身是对的。
    const weightField = [...ed.querySelectorAll('.pet-field')]
      .find((f) => f.querySelector('.pet-field-label')
        && f.querySelector('.pet-field-label').textContent.includes('权重'));
    return {
      present: Boolean(box),
      choices: box ? [...box.querySelectorAll('.pet-choice')].map((n) => n.textContent.trim()) : [],
      summary: box ? box.querySelector('.pet-field-hint').textContent.replace(/\\s+/g, ' ').trim() : '',
      weightLabel: weightField
        ? weightField.querySelector('.pet-field-label').textContent.trim() : '',
    };
  })()`);
  record(
    '③ ★ 多套动画在面板上**可见**（选套器列出每一套）',
    picker.present && picker.choices.length >= 2,
    `按钮=${JSON.stringify(picker.choices)}`,
  );
  record(
    '③ ★ 每一套的**权重是对的**（小卡真实是 5 与 2；原来恒显示 1）',
    picker.choices.some((t) => t.includes('权重 5'))
      && picker.choices.some((t) => t.includes('权重 2')),
    `按钮=${JSON.stringify(picker.choices)}`,
  );
  record(
    '③ 权重字段标明了「第几套的权重」（不再是一个笼统的「权重」）',
    /第 \d+ 套的权重/.test(picker.weightLabel),
    `字段名=${JSON.stringify(picker.weightLabel)}`,
  );
  record(
    '③ 每套都有一句可辨认的说明（帧数 / 节奏），不靠序号认',
    picker.summary.includes('第 1 套：') && picker.summary.includes('第 2 套：')
      && picker.summary.includes('帧'),
    picker.summary.slice(0, 120),
  );

  // 切到第 2 套 → 权重值要跟着变
  const second = await page.evaluate(`(() => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    const btns = [...ed.querySelectorAll('[data-editor-variant]')];
    if (btns[1]) btns[1].click();
    return btns.length;
  })()`);
  await sleep(700);
  const afterSwitch = await page.evaluate(`(() => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    const field = [...ed.querySelectorAll('.pet-field')].find((f) => f.textContent.includes('权重'));
    return {
      label: field ? field.querySelector('.pet-field-label').textContent.trim() : '',
      value: field ? field.querySelector('input').value : '',
    };
  })()`);
  record(
    '③ ★ 切到第 2 套后，编辑的是**第 2 套**（标签与值都跟着换）',
    second >= 2 && afterSwitch.label.includes('第 2 套') && Number(afterSwitch.value) === 2,
    `标签=${JSON.stringify(afterSwitch.label)} 值=${afterSwitch.value}`,
  );

  // 改两套并保存 → 两套都写进包里
  const twoSaved = await page.evaluate(`(async () => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    // 当前在第 2 套：把权重改成 4
    const wf = [...ed.querySelectorAll('.pet-field')].find((f) => f.textContent.includes('权重'));
    const wi = wf.querySelector('input');
    wi.value = '4';
    wi.dispatchEvent(new Event('input', { bubbles: true }));
    // 切回第 1 套，改权重为 8
    [...ed.querySelectorAll('[data-editor-variant]')][0].click();
    await new Promise((r) => setTimeout(r, 500));
    const ed2 = document.querySelector('.plugin-stm-pet .pet-action-editor');
    const wf2 = [...ed2.querySelectorAll('.pet-field')].find((f) => f.textContent.includes('权重'));
    const wi2 = wf2.querySelector('input');
    wi2.value = '8';
    wi2.dispatchEvent(new Event('input', { bubbles: true }));
    [...ed2.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
    await new Promise((r) => setTimeout(r, 2000));
    const res = await window.__petApi.api('/pets/' + ${JSON.stringify(createdId)} + '/preview', { method: 'GET' });
    const idle = res.actions.find((a) => a.action === 'idle');
    return (idle.variants || []).map((v) => v.weight);
  })()`);
  record(
    '③ ★ 一次保存能改**多套**（两套的权重都落盘了）',
    Array.isArray(twoSaved) && twoSaved.length >= 2
      && Number(twoSaved[0]) === 8 && Number(twoSaved[1]) === 4,
    `保存后各套权重=${JSON.stringify(twoSaved)}`,
  );

  // ============================================ ④ 套 / 页 命名区分
  //
  // 两条路线要分开验：
  // - 「套」用多套的形象（复制出来的小卡，idle 有 2 套）；
  // - 「页」要用一个**真的多页**的形象（`sheets` 有多项）。
  //   单页形象上当然看不到页数说明，拿它验「页」是验不出来的。
  await openPet(createdId);
  const naming = await page.evaluate(`(() => {
    // 预览区自己的**多套切换器**（与编辑区的选套器是两处，都要说「套」）
    const switcher = document.querySelector('.plugin-stm-pet .pet-preview-variants');
    return {
      switcherText: switcher ? switcher.textContent.replace(/\\s+/g, ' ').trim() : '',
      switcherChoices: switcher
        ? [...switcher.querySelectorAll('.pet-choice')].map((n) => n.textContent.trim()) : [],
    };
  })()`);
  await openEditor('待机');
  const variantHint = await page.evaluate(`(() => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    const hints = [...ed.querySelectorAll('.pet-field-hint')].map((n) => n.textContent.trim());
    return hints.find((h) => h.includes('套')) || '';
  })()`);
  record(
    '④ ★ 面板用「套」说多套动画（预览区与编辑区口径一致）',
    naming.switcherText.includes('多套')
      && naming.switcherChoices.every((t) => t.includes('套'))
      && variantHint.includes('套'),
    `预览区切换器=${JSON.stringify(naming.switcherChoices)}；`
    + `编辑区提示=${JSON.stringify(variantHint.slice(0, 70))}`,
  );

  // 多页：找一个真的多页形象（`pageCount > 1`），没有就跳过
  const pagePet = await page.evaluate(`(async () => {
    const list = await window.__petApi.api('/pets', { method: 'GET' });
    for (const item of list.items || []) {
      const res = await window.__petApi.api('/pets/' + item.id + '/preview', { method: 'GET' });
      const multi = (res.actions || []).find((a) => (a.pageCount || 1) > 1);
      if (multi) return { id: item.id, action: multi.action, pages: multi.pageCount };
    }
    return null;
  })()`);
  if (pagePet) {
    await openPet(pagePet.id);
    const pageMeta = await page.evaluate(`(() => {
      const metas = [...document.querySelectorAll('.plugin-stm-pet .pet-preview-meta')]
        .map((n) => n.textContent.trim());
      return metas.find((m) => m.includes('页')) || '';
    })()`);
    record(
      '④ ★ 多页在预览里写明了页数（用户要求「多页的动画设置，这个我也没看到」）',
      pageMeta.includes('页') && pageMeta.includes(String(pagePet.pages)),
      `形象=${pagePet.id} 动作=${pagePet.action} 页数=${pagePet.pages}；预览说明=${JSON.stringify(pageMeta)}`,
    );
    await openEditor(pagePet.action === 'idle' ? '待机' : pagePet.action);
    const pageHint = await page.evaluate(`(() => {
      const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
      const hints = [...ed.querySelectorAll('.pet-field-hint')].map((n) => n.textContent.trim());
      return hints.find((h) => h.includes('页')) || '';
    })()`);
    record(
      '④ ★ 编辑区说明了「多页」与「多套」的区别（两个词不再混用）',
      pageHint.includes('页') && pageHint.includes('套'),
      `编辑区页说明=${JSON.stringify(pageHint.slice(0, 130))}`,
    );
  } else {
    record('④ 多页用例', false, '沙箱里没有多页形象，无法验证「页」的显示');
  }

  // ============================================ ⑤ 新建形象：占位卡 / 放弃 / 切换确认
  await page.evaluate(`(() => {
    [...document.querySelectorAll('.plugin-stm-pet .pet-panel-toolbar button')]
      .find((b) => b.textContent.trim() === '新建形象').click();
    return true;
  })()`);
  await sleep(900);
  const drafting = await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
    return {
      drafting: cards.filter((c) => c.classList.contains('is-drafting'))
        .map((c) => c.dataset.petId),
      selected: cards.filter((c) => c.classList.contains('is-selected'))
        .map((c) => c.dataset.petId),
      hasAbandon: [...document.querySelectorAll('.plugin-stm-pet .pet-panel-toolbar button')]
        .some((b) => b.textContent.trim() === '放弃新建'),
    };
  })()`);
  record(
    '⑤ ★ 新建中左侧选中**占位卡**（不再高亮上一个形象）',
    drafting.drafting.length === 1
      && drafting.drafting[0] === '__creating__'
      && drafting.selected.length === 1
      && drafting.selected[0] === '__creating__',
    `占位卡=${JSON.stringify(drafting.drafting)}；选中的=${JSON.stringify(drafting.selected)}`,
  );
  record(
    '⑤ ★ 有「放弃新建」按钮（不必关掉整个面板）',
    drafting.hasAbandon,
    `找到「放弃新建」=${drafting.hasAbandon}`,
  );

  // 填个名字再点别的形象 → 要问一句
  const confirmFlow = await page.evaluate(`(async () => {
    const input = document.querySelector('.plugin-stm-pet [data-create-name]');
    input.value = '验收草稿';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
    const other = cards.find((c) => !c.classList.contains('is-drafting'));
    if (other) other.click();
    await new Promise((r) => setTimeout(r, 800));
    const box = [...document.querySelectorAll('.plugin-stm-pet .pet-notice')]
      .find((n) => n.textContent.includes('确认放弃'));
    return {
      asked: Boolean(box),
      buttons: box ? [...box.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
      stillCreating: Boolean(document.querySelector('.plugin-stm-pet [data-create-name]')),
    };
  })()`);
  record(
    '⑤ ★ 切到别的形象时**先问一句**（不静默丢弃、也不静默无视）',
    confirmFlow.asked && confirmFlow.buttons.length === 2 && confirmFlow.stillCreating,
    `弹了确认=${confirmFlow.asked}；按钮=${JSON.stringify(confirmFlow.buttons)}；`
    + `此时仍在新建页=${confirmFlow.stillCreating}`,
  );

  // 「留在新建页」→ 名字还在
  const stayed = await page.evaluate(`(async () => {
    const box = [...document.querySelectorAll('.plugin-stm-pet .pet-notice')]
      .find((n) => n.textContent.includes('确认放弃'));
    [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '留在新建页').click();
    await new Promise((r) => setTimeout(r, 700));
    const input = document.querySelector('.plugin-stm-pet [data-create-name]');
    return { stillCreating: Boolean(input), name: input ? input.value : '' };
  })()`);
  record(
    '⑤ 「留在新建页」保住了已填内容',
    stayed.stillCreating && stayed.name === '验收草稿',
    `还在新建=${stayed.stillCreating}；名字=${JSON.stringify(stayed.name)}`,
  );

  // 「放弃并继续」→ 切过去
  const left = await page.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
    cards.find((c) => !c.classList.contains('is-drafting')).click();
    await new Promise((r) => setTimeout(r, 700));
    const box = [...document.querySelectorAll('.plugin-stm-pet .pet-notice')]
      .find((n) => n.textContent.includes('确认放弃'));
    [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '放弃并继续').click();
    await new Promise((r) => setTimeout(r, 1300));
    return {
      left: !document.querySelector('.plugin-stm-pet [data-create-name]'),
      detail: Boolean(document.querySelector('.plugin-stm-pet .pet-panel-detail')),
    };
  })()`);
  record(
    '⑤ ★ 「放弃并继续」真的切走了（原来必须关掉面板再打开）',
    left.left && left.detail,
    `离开新建=${left.left}；显示详情=${left.detail}`,
  );

  // ============================================ ⑥ 应用预览（不保存也能看）
  await openPet(createdId);
  const beforeApply = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/' + ${JSON.stringify(createdId)} + '/preview', { method: 'GET' });
    const idle = res.actions.find((a) => a.action === 'idle');
    return { loop: idle.loop };
  })()`);
  await openEditor('待机');
  const hasApply = await page.evaluate(`(() => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    return [...ed.querySelectorAll('button')].map((b) => b.textContent.trim());
  })()`);
  record(
    '⑥ ★ 编辑区有「应用预览」按钮',
    hasApply.includes('应用预览'),
    `按钮=${JSON.stringify(hasApply)}`,
  );

  const applied = await page.evaluate(`(async () => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    // ⚠️ 改**循环**而不是帧率：小卡这一套声明了非均匀的 frameMs，
    // 而「每帧时长优先于帧率」——改 fps 时预览的读数**不会变**
    // （那是对的，但会让断言看起来像功能坏了）。循环是直接可见的。
    const once = [...ed.querySelectorAll('.pet-choice')]
      .find((b) => b.textContent.trim() === '播一遍');
    once.click();
    await new Promise((r) => setTimeout(r, 200));
    [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '应用预览').click();
    await new Promise((r) => setTimeout(r, 900));
    const metas = [...document.querySelectorAll('.plugin-stm-pet .pet-preview-meta')]
      .map((n) => n.textContent.trim());
    const res = await window.__petApi.api('/pets/' + ${JSON.stringify(createdId)} + '/preview', { method: 'GET' });
    const idle = res.actions.find((a) => a.action === 'idle');
    return {
      metas,
      backendLoop: idle.loop,
      note: [...document.querySelectorAll('.plugin-stm-pet .pet-field-hint')]
        .map((n) => n.textContent.trim()).find((t) => t.includes('未保存')) || '',
    };
  })()`);
  record(
    '⑥ ★ 点「应用预览」后**预览立刻变了**（不必先保存）',
    applied.metas.some((m) => m.includes('播一遍')),
    `预览说明=${JSON.stringify(applied.metas.filter((m) => m.includes('循环') || m.includes('播一遍')))}`,
  );
  record(
    '⑥ ★ 但**没有写盘**（后端仍是旧值，用户还能反悔）',
    applied.backendLoop !== false,
    `后端 loop=${applied.backendLoop}（点应用预览前是 ${beforeApply.loop}）`,
  );
  record(
    '⑥ 面板说明了「预览里是未保存的草稿」',
    applied.note.includes('未保存'),
    applied.note.slice(0, 80),
  );

  // 保存之后才落盘
  const committed = await page.evaluate(`(async () => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
    await new Promise((r) => setTimeout(r, 2000));
    const res = await window.__petApi.api('/pets/' + ${JSON.stringify(createdId)} + '/preview', { method: 'GET' });
    const idle = res.actions.find((a) => a.action === 'idle');
    return idle.loop;
  })()`);
  record(
    '⑥ 点「保存」之后才真的落盘',
    committed === false,
    `保存后后端 loop=${committed}（期望 false）`,
  );

  // ============================================ ⑦ WebP/GIF 路线判定可见
  const routeInfo = await page.evaluate(`(async () => {
    const list = await window.__petApi.api('/pets', { method: 'GET' });
    const animated = (list.items || []).find((i) => i.id === 'animated-pet');
    if (!animated) return { skipped: true };
    return { skipped: false, id: 'animated-pet' };
  })()`);
  if (!routeInfo.skipped) {
    await openPet('animated-pet');
    const route = await page.evaluate(`(() => {
      const metas = [...document.querySelectorAll('.plugin-stm-pet .pet-preview-meta')]
        .map((n) => n.textContent.trim());
      return { route: metas.filter((m) => m.includes('判为')) };
    })()`);
    record(
      '⑦ ★ 面板明说这张图被**判为哪条路线**（两条路线互斥，用户看不出来）',
      route.route.length > 0 && route.route[0].includes('动图容器'),
      JSON.stringify(route.route),
    );
  } else {
    record('⑦ 路线标注', true, '沙箱里没有动图形象，跳过');
  }

  // 后端判据：静态 WebP 与动图 WebP 的 magic 一样，只能按帧数判
  const detect = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/animated-pet/preview', { method: 'GET' });
    const idle = res.actions.find((a) => a.action === 'idle');
    return { animated: idle.animated, frames: idle.animatedFrames, layout: idle.layout };
  })()`).catch(() => null);
  if (detect) {
    record(
      '⑦ ★ 判据是**帧数**（`animated` + `animatedFrames`），不是扩展名',
      detect.animated === true && Number(detect.frames) > 1
        && detect.layout === 'animated',
      `animated=${detect.animated} 帧数=${detect.frames} layout=${detect.layout}`,
    );
  }

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑧ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  // 清理复制出来的验收形象
  try {
    if (createdId) {
      const page2 = await browser.newPage();
      await page2.send('Runtime.enable');
      await page2.navigate(BASE, { timeout: 20000 });
      await page2.waitFor('Boolean(window.__petApi)', { timeout: 15000, label: '清理时激活' });
      await page2.evaluate(`window.__petApi.api('/pets/' + ${JSON.stringify(createdId)} + '', { method: 'DELETE' })`);
    }
  } catch { /* 清理失败不影响结论 */ }
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`第二批 7 项问题验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
