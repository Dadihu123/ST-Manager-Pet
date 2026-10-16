/**
 * 验收：面板里的**眨眼**三个参数（帧号 / 间隔 / 时长）能改、能存、真的生效。
 *
 * 为什么需要它
 * ------------
 * 单测（`test_frontend_wiring.py`）只能验「源码里接了线」。而这里要命的一条是
 * **只改间隔**：`buildVariantPatch` 的「没改过」判断过去只比 `frames` 与
 * `durationMs`，于是单改间隔时它仍然判为「没改过」→ 不写补丁 → 面板显示
 * 保存成功，文件里却还是旧值。那是纯运行期行为，静态检查看不出来。
 *
 * 四条断言
 * --------
 * ① 编辑区出现「眨眼帧 / 眨眼最短间隔 / 眨眼最长间隔 / 眨眼时长」四个字段；
 * ② 只改**间隔** → 保存 → 运行期 `everyMs` 真的变了（这条钉住上面那个漏判）；
 * ③ 把区间填成反的（最短 > 最长）→ 保存成功且写成有序区间，不是一次报错；
 * ④ 清空帧号 → 保存 → blink 整条被删掉（留空 = 不眨眼）。
 *
 * ⚠️ 本文件里的页面侧注释不能用反引号。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-blink-panel.mjs
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

  // 用一个**可写**的专用形象。
  //
  // ⚠️ 不能像 verify-pet-editor 那样「从第一个可写形象再复制一份」：全新沙箱里
  // 只有内置形象（`writable: false`），那个循环一次都不会进，直接判成
  // 「没有可写形象」而中止（实测踩到）。内置形象**可以**被复制成用户形象
  // （`/copy` 对 builtin 是允许的），因此这里直接从内置复制一份当夹具。
  const petId = await page.evaluate(`(async () => {
    const api = window.__petApi.api;
    const list = await api('/pets', { method: 'GET' });
    const mine = (list.items || []).find((i) => i.name === 'blink fixture');
    if (mine) return mine.id;
    const source = (list.items || [])[0];
    if (!source) return '';
    const made = await api('/pets/' + source.id + '/copy', {
      method: 'POST', body: { name: 'blink fixture' },
    });
    return made && made.pet ? made.pet.id : '';
  })()`);
  record('① 前置：有一个可写的逐帧自建形象（副本）', Boolean(petId), `petId=${petId}`);
  if (!petId) throw new Error('没有可写形象');

  // idle.png 的第 2 帧是闭眼帧（小满）；副本继承自它，因此这里不会越界。
  // 但为了不依赖具体素材，帧号用 1（任何 4 帧动画都有第 1 帧）。
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-blink-panel' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(800);
  await page.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.plugin-stm-pet .pet-card')];
    const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(petId)}) || cards[0];
    if (card) card.click();
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  })()`);
  await sleep(800);

  /** 打开 idle 动作的动画参数编辑区（已开则不动）。 */
  const openEditor = `(async () => {
    const tiles = [...document.querySelectorAll('.plugin-stm-pet .pet-action-tile')];
    const tile = tiles.find((t) => t.dataset.action === 'idle')
      || tiles.find((t) => [...t.querySelectorAll('button')].some((b) => b.textContent.trim() === '动画参数'));
    if (!tile) return { ok: false };
    const btn = [...tile.querySelectorAll('button')].find((b) => b.textContent.trim() === '动画参数');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 700));
    return { ok: Boolean(document.querySelector('.plugin-stm-pet .pet-action-editor')) };
  })()`;

  const opened = await page.evaluate(openEditor);
  record('① 打开了 idle 的动画参数编辑区', Boolean(opened.ok), `ok=${opened.ok}`);

  const fields = await page.evaluate(`(() => {
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    if (!ed) return { present: false };
    const labels = [...ed.querySelectorAll('.pet-field-label')].map((n) => n.textContent.trim());
    return { present: true, labels };
  })()`);
  record(
    '① ★ 编辑区里有眨眼帧 / 最短间隔 / 最长间隔 / 时长四个字段',
    fields.present
      && fields.labels.includes('眨眼帧')
      && fields.labels.some((l) => l.includes('眨眼最短间隔'))
      && fields.labels.some((l) => l.includes('眨眼最长间隔'))
      && fields.labels.some((l) => l.includes('眨眼时长')),
    `字段=${JSON.stringify(fields.labels)}`,
  );

  /** 读运行期 idle 第一套的 motion.blink（来自重新读盘）。 */
  const readBlink = `(async () => {
    const res = await window.__petApi.api('/pets/${petId}/runtime', { method: 'GET' });
    const idle = (res.pet.actions || {}).idle || {};
    const variants = idle.variants || [];
    const v = variants[0] || idle;
    return (v.motion && v.motion.blink) || null;
  })()`;

  /**
   * 页面侧的「确保 idle 的编辑区开着」。
   *
   * ⚠️ 每次保存之后面板会重绘，编辑区**被关掉**（`editingAction` 被清）——
   * 因此每一步都得先确保它开着。第一版只在开头开了一次，于是第二步
   * 拿到的是 `null`，报的是「Cannot read properties of null」这种与真实
   * 问题无关的错（看起来像功能坏了）。
   */
  const ensureEditor = `(async () => {
    if (document.querySelector('.plugin-stm-pet .pet-action-editor')) return true;
    const tiles = [...document.querySelectorAll('.plugin-stm-pet .pet-action-tile')];
    const tile = tiles.find((t) => t.dataset.action === 'idle') || tiles[0];
    if (!tile) return false;
    const btn = [...tile.querySelectorAll('button')].find((b) => b.textContent.trim() === '动画参数');
    if (!btn) return false;
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    return Boolean(document.querySelector('.plugin-stm-pet .pet-action-editor'));
  })()`;

  const byLabelHelper = `
    const byLabel = (text) => {
      const field = [...document.querySelectorAll('.plugin-stm-pet .pet-field')]
        .find((f) => {
          const l = f.querySelector('.pet-field-label');
          return l && l.textContent.trim().includes(text);
        });
      return field ? field.querySelector('input') : null;
    };`;

  // ============================================ ② 只改间隔
  const intervalOnly = await page.evaluate(`(async () => {
    await (${ensureEditor});
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    ${byLabelHelper}
    const min = byLabel('眨眼最短间隔');
    const max = byLabel('眨眼最长间隔');
    const dur = byLabel('眨眼时长');
    if (!ed || !min || !max || !dur) return { error: 'editor/missing fields', hasEd: Boolean(ed) };
    // 先把帧号填上（副本可能本来没有 blink），保存一次建立基线
    const framesInput = ed.querySelector('.pet-field input.pet-input:not([type=number])');
    framesInput.value = '1';
    framesInput.dispatchEvent(new Event('input', { bubbles: true }));
    min.value = '2';
    min.dispatchEvent(new Event('input', { bubbles: true }));
    max.value = '2';
    max.dispatchEvent(new Event('input', { bubbles: true }));
    dur.value = '150';
    dur.dispatchEvent(new Event('input', { bubbles: true }));
    [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
    await new Promise((r) => setTimeout(r, 1800));
    const baseline = await (${readBlink});
    return {
      numberBoxes: [...ed.querySelectorAll('input[type=number]')].length,
      baseline,
    };
  })()`);
  record(
    '② 建立基线：三个字段一起填 → 保存生效',
    Boolean(intervalOnly.baseline)
      && intervalOnly.baseline.frames.join(',') === '1'
      && intervalOnly.baseline.everyMs.join(',') === '2000,2000',
    `blink=${JSON.stringify(intervalOnly.baseline)}（数字框共 ${intervalOnly.numberBoxes} 个）`,
  );

  // ★ 现在**只改间隔**，帧号与时长原样不动 —— 这一条钉住「少比 everyMs」的漏判
  const onlyInterval = await page.evaluate(`(async () => {
    await (${ensureEditor});
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    ${byLabelHelper}
    const min = byLabel('眨眼最短间隔');
    const max = byLabel('眨眼最长间隔');
    if (!ed || !min || !max) return { error: 'editor missing' };
    min.value = '6';
    min.dispatchEvent(new Event('input', { bubbles: true }));
    max.value = '9';
    max.dispatchEvent(new Event('input', { bubbles: true }));
    [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
    await new Promise((r) => setTimeout(r, 1800));
    return { after: await (${readBlink}) };
  })()`);
  record(
    '② ★ 只改**间隔** → 保存 → 运行期 everyMs 真的变了',
    Boolean(onlyInterval.after)
      && onlyInterval.after.everyMs.join(',') === '6000,9000'
      && onlyInterval.after.frames.join(',') === '1'
      && onlyInterval.after.durationMs === 150,
    `blink=${JSON.stringify(onlyInterval.after)}（期望 everyMs=[6000,9000]，帧号与时长不变）`,
  );

  // ============================================ ③ 区间填成反的
  const reversed = await page.evaluate(`(async () => {
    await (${ensureEditor});
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    ${byLabelHelper}
    const min = byLabel('眨眼最短间隔');
    const max = byLabel('眨眼最长间隔');
    if (!ed || !min || !max) return { error: 'editor missing' };
    // 最短 > 最长：后端会**明确拒绝**这个组合，因此面板必须把它写有序
    min.value = '10';
    min.dispatchEvent(new Event('input', { bubbles: true }));
    max.value = '4';
    max.dispatchEvent(new Event('input', { bubbles: true }));
    [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
    await new Promise((r) => setTimeout(r, 1800));
    return { after: await (${readBlink}) };
  })()`);
  record(
    '③ ★ 区间填反（最短 10s > 最长 4s）→ 保存成功且写成有序区间',
    Boolean(reversed.after) && reversed.after.everyMs.join(',') === '4000,10000',
    `blink=${JSON.stringify(reversed.after)}（期望 everyMs=[4000,10000]，而不是一次保存失败）`,
  );

  // ============================================ ④ 清空帧号
  const cleared = await page.evaluate(`(async () => {
    await (${ensureEditor});
    const ed = document.querySelector('.plugin-stm-pet .pet-action-editor');
    if (!ed) return { error: 'editor missing' };
    const framesInput = ed.querySelector('.pet-field input.pet-input:not([type=number])');
    framesInput.value = '';
    framesInput.dispatchEvent(new Event('input', { bubbles: true }));
    [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click();
    await new Promise((r) => setTimeout(r, 1800));
    const blink = await (${readBlink});
    // 呼吸必须**还在**（清掉眨眼不该顺手清掉呼吸——它们是两个独立字段）
    const res = await window.__petApi.api('/pets/${petId}/runtime', { method: 'GET' });
    const idle = (res.pet.actions || {}).idle || {};
    const v = (idle.variants || [])[0] || idle;
    return { blink, breathe: (v.motion && v.motion.breathe) || null };
  })()`);
  record(
    '④ ★ 清空帧号 → 保存 → blink 整条被删掉（留空 = 不眨眼）',
    cleared.blink === null,
    `blink=${JSON.stringify(cleared.blink)}`,
  );
  record(
    '④ 清掉眨眼**没有**连带清掉呼吸（两个独立字段）',
    Boolean(cleared.breathe),
    `breathe=${JSON.stringify(cleared.breathe)}`,
  );

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑤ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
  if (failed.length) exitCode = 1;
}
process.exit(exitCode);
