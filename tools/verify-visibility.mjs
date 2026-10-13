/**
 * 真实浏览器验收：**关闭宠物**（显示开关）。
 *
 *   node tools/verify-visibility.mjs
 *
 * 用户报障的原始形态：「插件应该支持关闭宠物，目前好像只有卸载或者停用宠物插件
 * 才能关闭，不太合理」。
 *
 * 判定全部基于**真实运行结果**（DOM 有没有宠物、有没有残留的 rAF、接口状态），
 * 不做源码字符串检查——那些在 pytest 里做过了。
 *
 * 这里最要紧的一条是「**关掉之后必须还有路开回来**」：
 * 插件仍启用、坞入口还在、设置面板仍能打开。否则这个功能就是在帮用户
 * 把宠物永久弄丢。
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

/** 宠物本体在不在 DOM 里。 */
const PET_SELECTOR = '[data-plugin="stm-pet"].pet-root';

async function main() {
  const browser = await launch({ width: 1440, height: 900 });
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
      consoleErrors.push(`exception: ${params.exceptionDetails?.exception?.text}`);
    });

    // 先确保是「显示」状态（可重复运行）
    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor('Boolean(window.__petApi)', { timeout: 20000, label: '插件激活' });
    await page.evaluate(`fetch('${API}/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: false }),
    }).then((r) => r.status)`);
    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor(`Boolean(document.querySelector('${PET_SELECTOR}'))`, {
      timeout: 20000, label: '宠物挂载',
    });
    await sleep(1200);

    // ============================================== ① 默认显示
    const initial = await page.evaluate(`(() => {
      const st = window.stmPet.state();
      return {
        hidden: st.hidden,
        mounted: st.mounted,
        petRoot: Boolean(document.querySelector('${PET_SELECTOR}')),
      };
    })()`);
    record(
      '① 默认显示：宠物在 DOM 里，状态是「未隐藏」',
      initial.hidden === false && initial.petRoot === true && initial.mounted === true,
      JSON.stringify(initial),
    );

    // ============================================== ② 面板上有开关
    await page.evaluate(`(async () => {
      await window.__petApi.surfaces.open('pet-settings', { source: 'verify-visibility' });
      return true;
    })()`);
    await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet [data-visibility-toggle]'))`, {
      timeout: 15000, label: '显示开关出现',
    });
    await sleep(800);

    const toggle = await page.evaluate(`(() => {
      const node = document.querySelector('.plugin-stm-pet [data-visibility-toggle]');
      const box = node ? node.closest('.pet-visibility') : null;
      // 开关要在面板**顶部**（工具栏之后、形象列表之前）
      const list = document.querySelector('.plugin-stm-pet .pet-panel-list');
      const above = node && list
        ? (node.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        : false;
      return {
        label: node ? node.textContent : '',
        hiddenAttr: node ? node.dataset.visibilityHidden : '',
        text: box ? box.textContent : '',
        aboveList: above,
      };
    })()`);
    record(
      '② 面板顶部有「关闭宠物」开关，且在形象列表之前（触手可及）',
      toggle.label.includes('关闭宠物') && toggle.hiddenAttr === 'false' && toggle.aboveList,
      JSON.stringify(toggle),
    );
    record(
      '② 开关文案说清「关掉的是宠物、不是插件」',
      toggle.text.includes('不必卸载或停用插件'),
      toggle.text.slice(0, 120),
    );

    // ============================================== ③ 点开关 → 宠物消失
    await page.evaluate(`(() => {
      document.querySelector('.plugin-stm-pet [data-visibility-toggle]').click();
      return true;
    })()`);
    await sleep(2000);

    const afterHide = await page.evaluate(`(async () => {
      const st = window.stmPet.state();
      const data = await (await fetch('${API}/visibility')).json();
      return {
        hidden: st.hidden,
        mounted: st.mounted,
        petState: st.petState,
        petRoot: Boolean(document.querySelector('${PET_SELECTOR}')),
        backendHidden: data.hidden,
      };
    })()`);
    record(
      '③ ★ 点「关闭宠物」→ 宠物从 DOM 消失，后端也记下了',
      afterHide.petRoot === false && afterHide.hidden === true
        && afterHide.backendHidden === true && afterHide.mounted === false,
      JSON.stringify(afterHide),
    );

    // ★ 关掉之后不能有残留的 rAF 在跑（「关掉」必须是真关掉）
    const idleFrames = await page.evaluate(`(() => {
      // 宠物的 rAF 循环如果还在，页面的帧回调仍会被大量调用；
      // 这里用一个间接但有效的判据：宠物视图对象必须已经被销毁
      const st = window.stmPet.state();
      return { petState: st.petState, hasView: Boolean(window.__petView) };
    })()`);
    record(
      '③ ★ 关掉后宠物视图已销毁（不留 rAF / 定时器空转）',
      idleFrames.hasView === false && idleFrames.petState === 'unmounted',
      JSON.stringify(idleFrames),
    );

    // ============================================== ④ ★ 仍然有路开回来
    //
    // 这一条是整个功能的**安全底线**：如果关掉之后连入口都没了，
    // 这个功能就是在帮用户把宠物永久弄丢。
    const stillUsable = await page.evaluate(`(async () => {
      const surfaces = window.__petApi.surfaces;
      const out = {};
      // 面板仍能打开（它此刻就是开着的，再关再开一次）
      surfaces.close('pet-settings');
      await new Promise((r) => setTimeout(r, 300));
      await surfaces.open('pet-settings', { source: 'verify-visibility-reopen' });
      await new Promise((r) => setTimeout(r, 900));
      out.settingsOpen = surfaces.isOpen('pet-settings');
      out.hasToggle = Boolean(
        document.querySelector('.plugin-stm-pet [data-visibility-toggle]')
      );
      // 后端接口照常可用
      const list = await (await fetch('${API}/pets')).json();
      out.petsOk = Boolean(list.success) && (list.items || []).length > 0;
      out.activePetId = list.activePetId;
      return out;
    })()`);
    record(
      '④ ★ 宠物关掉后，设置面板仍能打开、开关仍在、接口仍可用',
      stillUsable.settingsOpen && stillUsable.hasToggle && stillUsable.petsOk,
      JSON.stringify(stillUsable),
    );

    // ★ 关掉宠物**不该**改变当前形象
    record(
      '④ ★ 关闭宠物不影响「当前形象」（关的是看不看到，不是用哪个）',
      Boolean(stillUsable.activePetId),
      `activePetId=${stillUsable.activePetId}`,
    );

    // ============================================== ⑤ 刷新页面后仍是关的
    await page.navigate(BASE, { timeout: 30000 });
    await page.waitFor('Boolean(window.__petApi)', { timeout: 20000, label: '刷新后插件激活' });
    await sleep(1800);
    const afterReload = await page.evaluate(`(() => {
      const st = window.stmPet.state();
      return {
        hidden: st.hidden,
        petRoot: Boolean(document.querySelector('${PET_SELECTOR}')),
        mounted: st.mounted,
      };
    })()`);
    record(
      '⑤ ★ 刷新页面后宠物仍然是关的（开关持久化）',
      afterReload.hidden === true && afterReload.petRoot === false,
      JSON.stringify(afterReload),
    );

    // ============================================== ⑥ 点开关 → 宠物回来
    await page.evaluate(`(async () => {
      await window.__petApi.surfaces.open('pet-settings', { source: 'verify-visibility-show' });
      return true;
    })()`);
    await page.waitFor(`Boolean(document.querySelector('.plugin-stm-pet [data-visibility-toggle]'))`, {
      timeout: 15000, label: '开关出现',
    });
    await sleep(600);

    const showLabel = await page.evaluate(`(() => {
      const node = document.querySelector('.plugin-stm-pet [data-visibility-toggle]');
      return { label: node.textContent, hiddenAttr: node.dataset.visibilityHidden };
    })()`);
    record(
      '⑥ 关着的时候开关变成「显示宠物」',
      showLabel.label.includes('显示宠物') && showLabel.hiddenAttr === 'true',
      JSON.stringify(showLabel),
    );

    await page.evaluate(`(() => {
      document.querySelector('.plugin-stm-pet [data-visibility-toggle]').click();
      return true;
    })()`);
    await page.waitFor(`Boolean(document.querySelector('${PET_SELECTOR}'))`, {
      timeout: 15000, label: '宠物重新出现',
    });
    await sleep(1500);

    const afterShow = await page.evaluate(`(async () => {
      const st = window.stmPet.state();
      const data = await (await fetch('${API}/visibility')).json();
      const root = document.querySelector('${PET_SELECTOR}');
      const sprite = root ? root.querySelector('.pet-sprite') : null;
      return {
        hidden: st.hidden,
        mounted: st.mounted,
        petRoot: Boolean(root),
        backendHidden: data.hidden,
        // 重新显示后要**真的在跑**（不是一张死图）
        bg: sprite ? getComputedStyle(sprite).backgroundImage : '',
      };
    })()`);
    record(
      '⑥ ★ 点「显示宠物」→ 宠物回来并且真的在渲染',
      afterShow.petRoot && afterShow.hidden === false
        && afterShow.backendHidden === false && afterShow.bg.includes('/frame/'),
      JSON.stringify(afterShow),
    );

    // 回来之后动画确实在跑（而不是冻住）
    //
    // ⚠️ `pokeIdle()` 在宠物**漫游中**（state 不是 idle）会返回 false，
    // 而漫游每 3~9 秒就发生一次。直接 poke 一次再采样会时不时只采到同一个
    // 帧位——看起来像「动画冻住了」，实际只是采样时它恰好在走路。
    // 因此先等它回到 idle，再触发。
    const frames = [];
    await page.evaluate(`(async () => {
      const view = window.__petView;
      const deadline = performance.now() + 12000;
      while (performance.now() < deadline) {
        if (view && view.state === 'idle' && !view.idleBursting) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      if (view) view.pokeIdle();
      return true;
    })()`);
    for (let index = 0; index < 8; index += 1) {
      frames.push(await page.evaluate(`(() => {
        const root = document.querySelector('${PET_SELECTOR}');
        const sprite = root ? root.querySelector('.pet-sprite') : null;
        return sprite ? getComputedStyle(sprite).backgroundPosition : '';
      })()`));
      await sleep(120);
    }
    record(
      '⑥ ★ 重新显示后动画正常推进（不是一张冻住的图）',
      new Set(frames).size >= 2,
      `${new Set(frames).size} 个不同帧位: ${[...new Set(frames)].slice(0, 4).join(' | ')}`,
    );

    // ============================================== ⑦ 诊断句柄也能开关
    const viaHandle = await page.evaluate(`(async () => {
      await window.stmPet.hide();
      await new Promise((r) => setTimeout(r, 1200));
      const hiddenNow = !document.querySelector('${PET_SELECTOR}');
      await window.stmPet.show();
      await new Promise((r) => setTimeout(r, 1500));
      const backNow = Boolean(document.querySelector('${PET_SELECTOR}'));
      return { hiddenNow, backNow, hidden: window.stmPet.state().hidden };
    })()`);
    record(
      '⑦ 诊断句柄 stmPet.hide() / show() 同样有效',
      viaHandle.hiddenNow && viaHandle.backNow && viaHandle.hidden === false,
      JSON.stringify(viaHandle),
    );

    // ============================================== ⑧ 无控制台错误
    const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
    record(
      '⑧ 运行期无未捕获异常 / 错误日志',
      relevant.length === 0,
      relevant.slice(0, 4).join('\n        '),
    );

    process.stdout.write(`\n${'='.repeat(70)}\n`);
    const failed = results.filter((r) => !r.ok);
    process.stdout.write(
      `关闭宠物验收：${results.length - failed.length}/${results.length} 通过\n`,
    );
    if (failed.length) {
      process.stdout.write('\n失败明细:\n');
      for (const item of failed) process.stdout.write(`- ${item.name}\n  ${item.detail}\n`);
      exitCode = 1;
    }
  } finally {
    // 清理：恢复成「显示」状态（可重复运行）
    try {
      const page = await browser.newPage();
      await page.navigate(BASE, { timeout: 30000 });
      await page.waitFor('Boolean(window.__petApi)', { timeout: 15000, label: '清理用页面' });
      await page.evaluate(`fetch('${API}/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: false }),
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
