/**
 * 一次跑完所有真实浏览器验收套件。
 *
 * 为什么需要它（而不是在 shell 里 for 循环）：
 *
 * 1. **22 个套件连着跑时会出现负载性抖动**。每个套件都要起一个 Chrome
 *    并挂上一个上万节点的宿主 DOM，连着跑时机器明显吃紧，而若干断言是
 *    **时间敏感**的（rAF 帧数、下落时长、动画推进）。实测：单独跑 5/5
 *    通过的套件，在整套连跑时会偶发失败一两条。
 *
 * 2. 因此这里**失败自动重跑一次**，并把结果分成三类：
 *    - 一次就过 → 正常通过
 *    - 重跑才过 → **抖动**（打印出来，让人知道它不稳）
 *    - 重跑还挂 → **真失败**
 *
 *    这样「有没有真问题」一眼可判，而不是被抖动淹没。抖动仍然要打印——
 *    掩盖它等于把「判据不稳」这件事藏起来。
 *
 * 用法：
 *   PET_SANDBOX_PORT=5099 PET_SANDBOX_PETS=<沙箱 pets 目录> node tools/verify-all.mjs
 *   （可用 PET_ONLY=anim,roam 只跑几个）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

/** 跑单个套件，返回 `{ok, summary, failures}`。 */
function runSuite(name) {
  const file = path.join(HERE, `verify-${name}.mjs`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => {
      const lines = out.split('\n');
      // 「XX 项：N/M 通过」那一行
      const summaryLine = [...lines].reverse()
        .find((line) => line.includes('通过') && /\d+\/\d+/.test(line));
      const failures = lines.filter((line) => line.trim().startsWith('FAIL'))
        .map((line) => line.trim().slice(0, 120));
      resolve({
        ok: code === 0,
        code,
        summary: summaryLine ? summaryLine.trim() : `（退出码 ${code}）`,
        failures,
      });
    });
  });
}

const ALL = [
  'anim', 'still', 'preview-fix', 'grid', 'pages', 'animated', 'motion',
  'builtin-motion', 'copy-pet', 'roam', 'roam-direction', 'sleep-setting',
  'perpet-settings', 'pet-editor', 'panel-ux2', 'upload', 'panel', 'pet',
  'visibility', 'icon', 'dock', 'toast-icon',
];

const only = (process.env.PET_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const suites = (only.length ? only : ALL)
  .filter((name) => fs.existsSync(path.join(HERE, `verify-${name}.mjs`)));

const results = [];
for (const name of suites) {
  const first = await runSuite(name);
  if (first.ok) {
    process.stdout.write(`  PASS  ${name.padEnd(16)} ${first.summary}\n`);
    results.push({ name, verdict: 'pass', ...first });
    continue;
  }
  // 失败 → 重跑一次（区分抖动与真失败）
  process.stdout.write(`  ...   ${name.padEnd(16)} 第一次失败，重跑确认\n`);
  const second = await runSuite(name);
  if (second.ok) {
    process.stdout.write(`  FLAKY ${name.padEnd(16)} ${second.summary}\n`);
    for (const line of first.failures) {
      process.stdout.write(`         第一次失败: ${line}\n`);
    }
    results.push({ name, verdict: 'flaky', ...second });
  } else {
    process.stdout.write(`  FAIL  ${name.padEnd(16)} ${second.summary}\n`);
    for (const line of second.failures) {
      process.stdout.write(`         ${line}\n`);
    }
    results.push({ name, verdict: 'fail', ...second });
  }
}

const failed = results.filter((r) => r.verdict === 'fail');
const flaky = results.filter((r) => r.verdict === 'flaky');

process.stdout.write(`\n${'='.repeat(72)}\n`);
process.stdout.write(
  `浏览器验收：${results.length - failed.length}/${results.length} 通过`
  + `（其中 ${flaky.length} 个是重跑才过）\n`,
);
if (flaky.length) {
  process.stdout.write(`抖动（建议查判据，但它们不是功能失败）：${flaky.map((r) => r.name).join(', ')}\n`);
}
if (failed.length) {
  process.stdout.write(`真失败：${failed.map((r) => r.name).join(', ')}\n`);
}

// 顺手看一眼 profile 有没有泄漏（这条很便宜，而且泄漏是静默的）
const tmp = os.tmpdir();
const leaked = fs.readdirSync(tmp).filter((n) => n.startsWith('pet-cdp-')).length;
process.stdout.write(`临时目录里的浏览器 profile 残留：${leaked} 个\n`);

process.exit(failed.length ? 1 : 0);
