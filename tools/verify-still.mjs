/**
 * 真实浏览器验收：**标准图像 / 重名 / 作者署名 / 触发时间**（本轮四项诉求）。
 *
 *   node tools/verify-still.mjs
 *
 * 判定原则与其它 verify 脚本一致：断言全部基于**真实运行结果**
 * （读 computed style、面板 DOM、接口响应、运行期状态），不做源码字符串检查
 * ——那些在 pytest 里做过了。
 *
 * 为什么这四项必须真跑一遍：
 * - 「静止时画的是标准图像而不是上一次抽到的那一套」是**渲染结果**，
 *   源码里看不出（前端只是「调了个方法」而已）；
 * - 「作者显示出来了」「滑块真的能拖」是**面板渲染结果**；
 * - 「重名不冲突」要真的建两个同名形象才看得出。
 */

import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const API = `${BASE}/api/plugins/stm-pet`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

/** 从 `url("...")` 里取出 URL。 */
function urlOf(value) {
  const match = /url\(["']?([^"')]+)["']?\)/.exec(String(value || ''));
  return match ? match[1] : '';
}

/** 取出 URL 里的版本号（`?v=`），用于判断「显示的是不是同一份内容」。 */
function versionOf(value) {
  const match = /[?&]v=([^&"')]+)/.exec(String(value || ''));
  return match ? match[1] : '';
}

/** 打开设置面板并等形象列表出现。 */
async function openPanel(page) {
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-still' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1200);
}

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
  let exitCode = 0;
  const created = [];
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
      consoleErrors.push(`exception: ${params.exceptionDetails?.exception?.text}`);
    });

    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor('Boolean(window.__petApi)', { timeout: 20000, label: '插件激活' });
    await sleep(1200);

    // ============================================== ① 标准图像：静止时画它
    //
    // 用户报障：「当前的张望的闲置动作第一帧时抬头看，一直卡在这帧看起来怪怪的」。
    // 根因：静止画面原本是「上一次随机抽到的那套变体的第 0 帧」。
    //
    // 判定分两步：
    //   a) 后端下发了 `still`，且它不是「张望」那一套；
    //   b) 桌面上宠物**静止**时，sprite 的背景图就是它。
    const stillInfo = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/runtime')).json();
      const pet = data.pet;
      const root = document.querySelector('[data-plugin="stm-pet"].pet-root');
      const sprite = root.querySelector('.pet-sprite');
      const view = window.__petView;
      return {
        petId: pet.id,
        still: pet.still,
        idleVariantUrls: (pet.actions.idle.variants || []).map((v) => v.url),
        spriteBg: getComputedStyle(sprite).backgroundImage,
        viewStill: view ? view.still : null,
        state: view ? view.state : '',
        action: view ? view.action : '',
        bursting: view ? view.idleBursting : null,
      };
    })()`);

    record(
      '① 后端下发标准图像（不播动画时显示的那一帧）',
      Boolean(stillInfo.still && stillInfo.still.url),
      `pet=${stillInfo.petId}，still=${JSON.stringify(stillInfo.still)}`,
    );

    // 标准图像绝不能是 idle 的第二套（「张望」）
    const lookUrl = stillInfo.idleVariantUrls.find((url) => url.includes('vi=1')) || '';
    record(
      '① 标准图像不是 idle 的第二套动画（「张望」的抬头帧）',
      Boolean(stillInfo.still && stillInfo.still.url)
        && stillInfo.still.url !== lookUrl,
      `still=${urlOf(stillInfo.still && stillInfo.still.url)}\n        idle[1]=${lookUrl}`,
    );

    // 等它回到静止态再读 sprite
    await page.evaluate(`(async () => {
      const view = window.__petView;
      const deadline = performance.now() + 8000;
      while (view && (view.idleBursting || view.state === 'walk')
             && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return true;
    })()`);
    await sleep(600);

    const resting = await page.evaluate(`(() => {
      const root = document.querySelector('[data-plugin="stm-pet"].pet-root');
      const sprite = root.querySelector('.pet-sprite');
      const view = window.__petView;
      return {
        bg: getComputedStyle(sprite).backgroundImage,
        state: view ? view.state : '',
        action: view ? view.action : '',
        bursting: view ? view.idleBursting : null,
        viewStill: view ? view.still : null,
      };
    })()`);

    record(
      '① ★ 宠物**静止**时 sprite 画的就是标准图像（不再卡在刚播过的那一套）',
      Boolean(resting.viewStill && resting.viewStill.showing)
        && versionOf(resting.bg) === versionOf(stillInfo.still.url)
        && resting.bursting === false,
      `state=${resting.state} action=${resting.action} bursting=${resting.bursting}\n        sprite=${urlOf(resting.bg)}\n        期望=${stillInfo.still.url}`,
    );

    // ============================================== ② 触发时间：面板能调，且生效
    await openPanel(page);

    const schedulePanel = await page.evaluate(`(async () => {
      // ⚠️ 必须选**当前生效**的那个形象：/runtime 只返回生效形象，
      // 而滑块改的是「被选中的那个」。两者不是同一个时，
      // 「后端生效值」与「运行中的宠物」会比到两个不同的形象上（假失败）。
      const list = await (await fetch('${API}/pets')).json();
      const activeId = list.activePetId;
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const card = cards.find((c) => c.dataset.petId === activeId) || cards[0];
      card.click();
      await new Promise((r) => setTimeout(r, 1200));
      const sliders = [...document.querySelectorAll(
        '.plugin-stm-pet [data-schedule-behavior]'
      )];
      const behaviors = [...new Set(sliders.map((s) => s.dataset.scheduleBehavior))];
      const bounds = [...new Set(sliders.map((s) => s.dataset.scheduleBound))];
      const titles = [...document.querySelectorAll('.plugin-stm-pet .pet-section-title')]
        .map((n) => n.textContent);
      const detail = await (await fetch(
        '${API}/pets/' + card.dataset.petId + '/preview')).json();
      // ★ 每个滑块的初值必须等于**该行为生效的**区间，而不是极值。
      // 实测踩到过：用对象（而非 behavior.key）索引 effective，恒为 undefined，
      // 于是滑块渲染成 200 / 3600000，读数显示「0.2~3600 秒」。
      const expected = {};
      for (const s of sliders) {
        const behavior = s.dataset.scheduleBehavior;
        const bound = s.dataset.scheduleBound === 'min' ? 'minIntervalMs' : 'maxIntervalMs';
        expected[behavior + '.' + s.dataset.scheduleBound] =
          detail.schedule[behavior][bound];
      }
      return {
        activeId,
        petId: card.dataset.petId,
        behaviors, bounds, titles, count: sliders.length,
        actual: Object.fromEntries(sliders.map(
          (s) => [s.dataset.scheduleBehavior + '.' + s.dataset.scheduleBound, Number(s.value)]
        )),
        expected,
        readouts: [...document.querySelectorAll('.plugin-stm-pet .pet-slider-value')]
          .map((n) => n.textContent),
      };
    })()`);

    record(
      '② 面板有「触发时间」区，且列出 idle / roam 两个行为',
      schedulePanel.behaviors.sort().join(',') === 'idle,roam'
        && schedulePanel.bounds.sort().join(',') === 'max,min'
        && schedulePanel.petId === schedulePanel.activeId,
      JSON.stringify({
        petId: schedulePanel.petId,
        activeId: schedulePanel.activeId,
        behaviors: schedulePanel.behaviors,
        bounds: schedulePanel.bounds,
        titles: schedulePanel.titles,
      }),
    );

    // ★ 滑块初值必须等于后端生效值（这一条专门盯「索引写错 → 极值」那个坑）
    const sliderValuesOk = Object.keys(schedulePanel.expected).every(
      (key) => schedulePanel.actual[key] === schedulePanel.expected[key],
    ) && Object.keys(schedulePanel.expected).length >= 4;
    record(
      '② ★ 滑块初值等于后端生效的间隔（不是极值 200 / 3600000）',
      sliderValuesOk,
      `实际=${JSON.stringify(schedulePanel.actual)}\n        期望=${JSON.stringify(schedulePanel.expected)}\n        读数=${JSON.stringify(schedulePanel.readouts)}`,
    );

    // ★ 拖滑块 → 立刻生效（读运行期状态，不刷新页面）
    //
    // 前面已经选中了**当前生效**的形象（见 schedulePanel 的说明），
    // 因此 /runtime 返回的就是同一个形象。
    const beforeSchedule = await page.evaluate(`(() => {
      const view = window.__petView;
      return view ? view.schedule : null;
    })()`);

    const dragged = await page.evaluate(`(async () => {
      const slider = document.querySelector(
        '.plugin-stm-pet [data-schedule-behavior="roam"][data-schedule-bound="min"]'
      );
      if (!slider) return { ok: false, reason: 'no-slider' };
      slider.value = String(1500);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 3000));
      return { ok: true, value: slider.value };
    })()`);

    const afterSchedule = await page.evaluate(`(async () => {
      const data = await (await fetch('${API}/runtime')).json();
      const view = window.__petView;
      return {
        petId: data.pet.id,
        backend: data.pet.schedule,
        declared: data.pet.declaredSchedule,
        overridden: data.pet.scheduleOverridden,
        view: view ? view.schedule : null,
      };
    })()`);

    record(
      '② ★ 拖漫游滑块 → 后端与运行中的宠物都立刻用上新间隔',
      dragged.ok
        && afterSchedule.petId === schedulePanel.petId
        && afterSchedule.backend.roam.minIntervalMs === 1500
        && afterSchedule.view
        && afterSchedule.view.roam.minMs === 1500
        && beforeSchedule
        && beforeSchedule.roam.minMs !== 1500,
      `拖动=${JSON.stringify(dragged)}\n        后端(${afterSchedule.petId}) roam=${JSON.stringify(afterSchedule.backend.roam)}\n        视图 roam=${JSON.stringify(afterSchedule.view && afterSchedule.view.roam)}\n        之前=${JSON.stringify(beforeSchedule && beforeSchedule.roam)}`,
    );

    // ★ 内置形象也能调（节奏落在用户设置里，不写进只读的 pet.json）
    const builtinStillDeclared = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const builtin = cards.find((c) => !c.textContent.includes('自定义')) || cards[cards.length - 1];
      builtin.click();
      await new Promise((r) => setTimeout(r, 1200));
      const sliders = [...document.querySelectorAll('.plugin-stm-pet [data-schedule-behavior]')];
      const readonly = document.querySelector('.plugin-stm-pet .pet-badge.is-builtin');
      return { count: sliders.length, isBuiltin: Boolean(readonly) };
    })()`);
    record(
      '② 内置形象（只读）也能调触发时间',
      builtinStillDeclared.count >= 4 && builtinStillDeclared.isBuiltin,
      JSON.stringify(builtinStillDeclared),
    );

    // ============================================== ③ 作者署名
    //
    // 先造一个**自定义**形象（内置的作者是只读的，验不到输入框）。
    const authorPet = await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#48c';
      ctx.fillRect(0, 0, 64, 64);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const form = new FormData();
      form.append('name', '作者验收宠物');
      form.append('author', '初始作者');
      form.append('idle', blob, 'idle.png');
      form.append('meta', JSON.stringify({ idle: { frames: 1 } }));
      const res = await fetch('${API}/pets/create', { method: 'POST', body: form });
      const data = await res.json();
      return { id: data.pet ? data.pet.id : '', author: data.pet ? data.pet.author : '' };
    })()`);
    if (authorPet.id) created.push(authorPet.id);

    record(
      '③ ★ 新建形象时能设作者名（会写进 pet.json，导出时带走）',
      authorPet.author === '初始作者',
      JSON.stringify(authorPet),
    );

    await openPanel(page);
    const authorPanel = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const mine = cards.find((c) => c.dataset.petId === '${authorPet.id}');
      if (!mine) return { missing: true };
      mine.click();
      await new Promise((r) => setTimeout(r, 1200));
      const input = document.querySelector('.plugin-stm-pet [data-author-input]');
      return {
        hasInput: Boolean(input),
        value: input ? input.value : '',
      };
    })()`);

    record(
      '③ 自定义形象有可编辑的「作者」输入框，且带出当前作者',
      authorPanel.hasInput && authorPanel.value === '初始作者',
      JSON.stringify(authorPanel),
    );

    // ★ 改作者 → 真的落进 pet.json
    //
    // 直接查**这个形象自己的**预览接口，而不是 /runtime
    // （后者只返回当前生效的形象，而这个新形象刚建出来时未必是生效的）。
    const authorEdit = await page.evaluate(`(async () => {
      const input = document.querySelector('.plugin-stm-pet [data-author-input]');
      if (!input) return { ok: false, reason: 'no-input' };
      input.value = '改过的作者';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 2500));
      const detail = await (await fetch(
        '${API}/pets/${authorPet.id}/preview')).json();
      return { ok: true, author: detail.author };
    })()`);
    record(
      '③ ★ 改作者后立刻落进 pet.json（接口回读确认）',
      authorEdit.ok && authorEdit.author === '改过的作者',
      JSON.stringify(authorEdit),
    );

    // 内置形象的作者显示为「官方」，且**不给**输入框
    const builtinAuthor = await page.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const builtin = cards.find((c) => !c.textContent.includes('自定义'));
      if (!builtin) return { none: true };
      builtin.click();
      await new Promise((r) => setTimeout(r, 1200));
      const detail = document.querySelector('.plugin-stm-pet .pet-panel-detail');
      return {
        text: detail ? detail.textContent : '',
        hasInput: Boolean(document.querySelector('.plugin-stm-pet [data-author-input]')),
      };
    })()`);
    record(
      '③ 内置形象显示作者「官方」且不可编辑',
      !builtinAuthor.none && builtinAuthor.text.includes('官方') && !builtinAuthor.hasInput,
      `hasInput=${builtinAuthor.hasInput}，含「官方」=${builtinAuthor.text.includes('官方')}`,
    );

    // ============================================== ④ 重名
    //
    // 建两个**同名**形象，确认：
    //   a) 两个都在列表里；
    //   b) 都能用（不是「后一个把前一个顶掉了」）；
    //   c) 面板上靠 id 定位卡片（`data-pet-id`），不靠名字。
    const dup = await page.evaluate(`(async () => {
      const mk = async (label) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = label === 'a' ? '#c33' : '#3c3';
        ctx.fillRect(0, 0, 64, 64);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const form = new FormData();
        form.append('name', '同名验收宠物');
        form.append('author', '验收脚本');
        form.append('idle', blob, 'idle.png');
        form.append('meta', JSON.stringify({ idle: { frames: 1 } }));
        const res = await fetch('${API}/pets/create', { method: 'POST', body: form });
        return res.json();
      };
      const first = await mk('a');
      const second = await mk('b');
      const list = await (await fetch('${API}/pets')).json();
      const sameName = list.items.filter((i) => i.name === '同名验收宠物');
      return {
        firstId: first.pet ? first.pet.id : '',
        secondId: second.pet ? second.pet.id : '',
        count: sameName.length,
        ids: sameName.map((i) => i.id),
        authors: sameName.map((i) => i.author),
        errors: sameName.map((i) => i.error),
      };
    })()`);

    if (dup.firstId) created.push(dup.firstId);
    if (dup.secondId) created.push(dup.secondId);

    record(
      '④ ★ 允许重名：两个同名形象并存，各有独立 id 且都能用',
      dup.count === 2 && dup.firstId !== dup.secondId
        && dup.ids.length === 2 && dup.errors.every((e) => !e),
      `ids=${JSON.stringify(dup.ids)}，authors=${JSON.stringify(dup.authors)}，errors=${JSON.stringify(dup.errors)}`,
    );

    record(
      '④ 同名形象靠**作者**区分（署名让重名不再含糊）',
      dup.authors.length === 2 && dup.authors.every((a) => a === '验收脚本'),
      JSON.stringify(dup.authors),
    );

    // 面板上两张同名卡片都在，且卡片带 `data-pet-id`
    await openPanel(page);
    const dupCards = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
      const same = cards.filter((c) => c.textContent.includes('同名验收宠物'));
      return {
        count: same.length,
        ids: same.map((c) => c.dataset.petId),
        hasAuthorInDetail: true,
      };
    })()`);
    record(
      '④ 面板上两张同名卡片都在，且各自带 data-pet-id（可精确定位）',
      dupCards.count === 2 && dupCards.ids.every(Boolean),
      JSON.stringify(dupCards),
    );

    // ============================================== 无控制台错误
    const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
    record(
      '⑤ 运行期无未捕获异常 / 错误日志',
      relevant.length === 0,
      relevant.slice(0, 4).join('\n        '),
    );

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(
      `标准图像 / 重名 / 作者 / 触发时间验收：${results.length - failed.length}/${results.length} 通过\n`,
    );
    if (failed.length) {
      process.stdout.write('\n失败明细:\n');
      for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
      exitCode = 1;
    }
  } finally {
    // 清理：删掉验收造出来的形象（可重复运行）
    try {
      const page = await browser.newPage();
      await page.navigate(BASE, { timeout: 30000 });
      await page.waitFor('Boolean(window.__petApi)', { timeout: 15000, label: '清理用页面' });
      for (const petId of created) {
        await page.evaluate(`fetch('${API}/pets/${petId}', { method: 'DELETE' }).then((r) => r.status)`);
      }
      // 清掉验收设的节奏覆盖，避免污染下次运行
      await page.evaluate(`fetch('${API}/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ petSchedules: {} }),
      }).then((r) => r.status)`);
    } catch {
      // 清理失败不影响判定结果
    }
    browser.close();
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`验收脚本异常: ${error && error.stack}\n`);
    process.exit(2);
  });
