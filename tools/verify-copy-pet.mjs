/**
 * 验收：**「复制为我的形象」**——把内置形象一次变成可编辑的用户形象。
 *
 * 为什么需要它（用户报障的根因）
 * ------------------------------
 * 用户想在内置形象基础上改参数，于是**手工**复制了 `resources/pets/xiaoka/`
 * 到 `resources/pets/xiaoka-自定义/`，结果：
 *   1. 目录名带中文 → 不匹配 `PET_ID_PATTERN` → 被**整目录跳过**（看不见）；
 *   2. 改成合法名字后能看见了，但仍是「插件自带」（只读）——因为
 *      **判定内置/自定义只看目录位置**，与 `pet.json` 写什么无关。
 *      他改 `id`、改 `author` 都没用。
 *
 * 这个入口把两件事一次做对：合法 id 由后端生成、落点固定在 `data/pets/`。
 *
 * 判据
 * ----
 * ① 复制前内置形象是**只读**（面板显示「插件自带」、无「换图/导出/删除」）；
 * ② 点「复制为我的形象」后出现新形象，且它是**可写的**（writable=true）；
 * ③ 新形象**内容与内置一致**（帧数、动作、标准图像）；
 * ④ 复制后**能真的改**：换图 / 改触发节奏 / 导出都能成功；
 * ⑤ 内置形象**原封不动**（仍只读、内容没变、目录没被动）。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 node tools/verify-copy-pet.mjs
 */
import { launch } from './cdp.mjs';

const BASE = process.env.PET_HOST_URL || `http://127.0.0.1:${process.env.PET_SANDBOX_PORT || 5099}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}\n`);
}

const browser = await launch({ width: 1440, height: 900 });
let exitCode = 0;
let created = '';
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

  // ============================================ ① 内置形象是只读的
  const before = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/xiaoka/preview', { method: 'GET' });
    return {
      id: res.id, writable: res.writable, source: res.source, author: res.author,
      frames: (res.actions.find((a) => a.action === 'idle') || {}).frames,
      actions: res.actions.map((a) => a.action).sort(),
      still: res.still && res.still.url ? true : false,
      decodeBytes: res.decodeBytes,
    };
  })()`);

  record(
    '① 内置形象是只读的（writable=false / source=builtin）',
    before.writable === false && before.source === 'builtin',
    `id=${before.id} writable=${before.writable} source=${before.source} author=${before.author}`,
  );

  // ============================================ ② 复制
  const copied = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/xiaoka/copy', { method: 'POST', body: {} });
    if (!res || !res.success) return { error: (res && res.msg) || 'no response' };
    return { id: res.pet.id, writable: res.pet.writable, source: res.pet.source,
             author: res.pet.author, name: res.pet.name, directory: res.pet.directory };
  })()`);

  if (copied.error) {
    record('② 复制接口可用', false, copied.error);
    throw new Error(copied.error);
  }
  created = copied.id;

  record(
    '② ★ 复制出来的形象**可写**（writable=true / source=user）',
    copied.writable === true && copied.source === 'user',
    `id=${copied.id} writable=${copied.writable} source=${copied.source}`
    + ` author=${copied.author} directory=${copied.directory}`,
  );
  record(
    '② ★ 新 id 是**合法**的（中文/大写会让目录被整目录跳过——用户就栽在这里）',
    /^[a-z0-9][a-z0-9._-]*$/.test(copied.id),
    `id="${copied.id}"（正则 ^[a-z0-9][a-z0-9._-]{0,63}$）`,
  );
  record(
    '② 落在 data/pets/ 下（用户形象的位置），不是 resources/pets/',
    copied.directory.startsWith('pets/'),
    `directory="${copied.directory}"`,
  );
  record(
    '② 不沿用「官方」署名（复制品是用户自己的，不是随插件发布的）',
    copied.author !== '官方',
    `author="${copied.author}"`,
  );

  // ============================================ ③ 内容一致
  const after = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/${created}/preview', { method: 'GET' });
    return {
      frames: (res.actions.find((a) => a.action === 'idle') || {}).frames,
      actions: res.actions.map((a) => a.action).sort(),
      still: res.still && res.still.url ? true : false,
      decodeBytes: res.decodeBytes,
      idMismatch: res.idMismatch || null,
    };
  })()`);

  record(
    '③ 复制品内容与内置一致（动作集合 / 帧数 / 标准图像）',
    JSON.stringify(after.actions) === JSON.stringify(before.actions)
      && after.frames === before.frames && after.still === before.still,
    `动作 ${after.actions.length} 个（内置 ${before.actions.length}）；`
    + `idle 帧数 ${after.frames}（内置 ${before.frames}）；still=${after.still}`,
  );
  record(
    '③ ★ 复制品没有 id 不一致的警告（否则一出生就提示，那是我们自己的疏漏）',
    !after.idMismatch,
    `idMismatch=${JSON.stringify(after.idMismatch)}`,
  );

  // ============================================ ④ 复制之后「能改」
  const edits = await page.evaluate(`(async () => {
    const out = {};
    // 改触发节奏（内置也能改这条，但复制品必须同样能）
    const s = await window.__petApi.api('/pets/${created}/schedule', {
      method: 'POST', body: { schedule: { idle: { minIntervalMs: 3000, maxIntervalMs: 9000 } } },
    });
    out.schedule = Boolean(s && s.success);

    // 导出（内置被拒，复制品必须能）
    let exported = false;
    try {
      const r = await fetch('/api/plugins/stm-pet/pets/${created}/export');
      exported = r.ok;
    } catch (e) { exported = false; }
    out.export = exported;

    // 换图（内置被拒 403，复制品必须能）
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 576;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2f8'; ctx.fillRect(0, 0, 384, 576);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const form = new FormData();
    form.append('file', blob, 'idle.png');
    const up = await fetch('/api/plugins/stm-pet/pets/${created}/actions/idle', {
      method: 'POST', body: form,
    });
    out.upload = up.ok;
    if (!up.ok) out.uploadStatus = up.status;
    return out;
  })()`);

  record('④ ★ 复制品能改触发节奏', edits.schedule === true, `schedule=${edits.schedule}`);
  record('④ ★ 复制品能导出（内置被拒）', edits.export === true, `export=${edits.export}`);
  record(
    '④ ★ 复制品能换图（内置被拒 403）',
    edits.upload === true,
    `upload=${edits.upload}${edits.uploadStatus ? ` status=${edits.uploadStatus}` : ''}`,
  );

  // 内置仍然被拒（对照）
  const builtinRefused = await page.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 576;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 384, 576);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const form = new FormData();
    form.append('file', blob, 'idle.png');
    const up = await fetch('/api/plugins/stm-pet/pets/xiaoka/actions/idle', { method: 'POST', body: form });
    return { status: up.status, ok: up.ok };
  })()`);
  record(
    '④ 对照：内置形象换图**仍然被拒**（403）',
    builtinRefused.ok === false && builtinRefused.status === 403,
    `status=${builtinRefused.status}`,
  );

  // ============================================ ⑤ 内置原封不动
  const untouched = await page.evaluate(`(async () => {
    const res = await window.__petApi.api('/pets/xiaoka/preview', { method: 'GET' });
    return { writable: res.writable, source: res.source, author: res.author,
             frames: (res.actions.find((a) => a.action === 'idle') || {}).frames,
             actions: res.actions.map((a) => a.action).sort() };
  })()`);
  record(
    '⑤ ★ 内置形象原封不动（仍只读、内容没变）',
    untouched.writable === false && untouched.source === 'builtin'
      && JSON.stringify(untouched.actions) === JSON.stringify(before.actions)
      && untouched.frames === before.frames && untouched.author === before.author,
    `writable=${untouched.writable} source=${untouched.source} author=${untouched.author}`
    + ` 动作 ${untouched.actions.length} 个 idle ${untouched.frames} 帧`,
  );

  // ============================================ ⑥ 面板上的按钮
  await page.evaluate(`(async () => {
    await window.__petApi.surfaces.open('pet-settings', { source: 'verify-copy' });
    return true;
  })()`);
  await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet .pet-card'))`, {
    timeout: 15000, label: '形象列表出现',
  });
  await sleep(1200);
  const panel = await page.evaluate(`(async () => {
    const cards = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'));
    const card = cards.find((c) => c.dataset.petId === 'xiaoka');
    if (!card) return { error: '找不到 xiaoka 卡片' };
    card.click();
    await new Promise((r) => setTimeout(r, 900));
    const buttons = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-panel-toolbar button'))
      .map((b) => b.textContent.trim());
    const badges = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-badge'))
      .map((b) => b.textContent.trim());
    const metas = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card-meta'))
      .map((m) => m.textContent.trim());
    return { buttons, badges, metas };
  })()`);

  if (panel.error) {
    record('⑥ 面板就绪', false, panel.error);
  } else {
    record(
      '⑥ ★ 内置形象的详情页有「复制为我的形象」按钮',
      panel.buttons.includes('复制为我的形象'),
      `按钮=${JSON.stringify(panel.buttons)}`,
    );
    record(
      '⑥ 内置形象不显示「导出形象包 / 删除」（只读）',
      !panel.buttons.includes('导出形象包') && !panel.buttons.includes('删除'),
      `按钮=${JSON.stringify(panel.buttons)}`,
    );
    record(
      '⑥ 徽章写「插件自带」',
      panel.badges.includes('插件自带'),
      `徽章=${JSON.stringify(panel.badges)}`,
    );
  }

  // ============================================ ⑦ 复制品在面板里是可编辑的
  const copyPanel = await page.evaluate(`(async () => {
    const cards = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card'));
    const card = cards.find((c) => c.dataset.petId === ${JSON.stringify(created)});
    if (!card) return { error: '列表里找不到复制出来的形象' };
    card.click();
    await new Promise((r) => setTimeout(r, 900));
    const buttons = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-panel-toolbar button'))
      .map((b) => b.textContent.trim());
    const badges = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-badge'))
      .map((b) => b.textContent.trim());
    const metas = Array.from(document.querySelectorAll('.plugin-stm-pet .pet-card-meta'))
      .map((m) => m.textContent.trim());
    return { buttons, badges, metas };
  })()`);

  if (copyPanel.error) {
    record('⑦ 复制品出现在面板列表里', false, copyPanel.error);
  } else {
    record(
      '⑦ ★ 复制品在面板里是「自定义」且有导出 / 删除按钮',
      copyPanel.badges.includes('自定义')
        && copyPanel.buttons.includes('导出形象包')
        && copyPanel.buttons.includes('删除'),
      `徽章=${JSON.stringify(copyPanel.badges)} 按钮=${JSON.stringify(copyPanel.buttons)}`,
    );
  }

  const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
  record('⑧ 运行期无未捕获异常 / 错误日志', relevant.length === 0, relevant.slice(0, 4).join('\n        '));
} finally {
  // 清理：把复制出来的形象删掉，别污染影子宿主
  try {
    if (created) {
      const page2 = await browser.newPage();
      await page2.send('Runtime.enable');
      await page2.navigate(BASE, { timeout: 20000 });
      await page2.waitFor('Boolean(window.__petApi)', { timeout: 15000, label: '清理时激活' });
      await page2.evaluate(`window.__petApi.api('/pets/${created}', { method: 'DELETE' })`);
    }
  } catch { /* 清理失败不影响验收结论 */ }
  await browser.close();
}

process.stdout.write(`\n${'='.repeat(70)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`「复制为我的形象」验收：${results.length - failed.length}/${results.length} 通过\n`);
if (failed.length) {
  process.stdout.write('\n失败明细:\n');
  for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
  exitCode = 1;
}
process.exit(exitCode);
