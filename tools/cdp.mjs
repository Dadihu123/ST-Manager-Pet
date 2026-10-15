/**
 * 极简 CDP（Chrome DevTools Protocol）客户端。
 *
 * 用途：在**真实浏览器**里验证宿主容器的契约（阶段 0 的七条），
 * 而不是只做源码字符串断言。做法对标宿主仓库的 Node + DOM 垫片路线：
 * **不引入 playwright / puppeteer**（宿主仓库也没装）。
 *
 * 依赖面：Node 22+ 内置的全局 `fetch` 与 `WebSocket`（Node 25 实测可用），
 * 以及系统已安装的 Chrome / Edge —— 都不需要新装任何包。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 我们创建的 profile 目录前缀（用于启动时清扫上一次的残留）。 */
const PROFILE_PREFIX = 'pet-cdp-';

/**
 * **所有活着的浏览器实例**，供进程退出时统一回收。
 *
 * 为什么必须有这个：`close()` 只在脚本正常走到那一步时才被调用。
 * 验收脚本一旦在中途抛错（断言失败、超时、`page.evaluate` 里的异常），
 * 后面的 `b.close()` 就不会执行，那个 profile 目录（含整个 Chrome
 * 用户数据，几十 MB）就永远留在临时目录里。
 *
 * 实测后果：反复跑 14 个验收套件时，残留目录把 **C 盘撑爆**
 * （`ENOSPC: no space left on device`），连 pytest 都写不出结果文件。
 */
const liveSessions = new Set();
let cleanupRegistered = false;

/** 把「进程无论怎么退出都回收 profile」挂上（只挂一次）。 */
function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const sweep = () => {
    for (const session of liveSessions) session.killNow();
    liveSessions.clear();
  };

  // 正常退出
  process.on('exit', sweep);
  // Ctrl-C / 被 kill
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => {
      sweep();
      process.exit(1);
    });
  }
  // ★ 抛错退出——这是**最主要**的泄漏路径（断言失败就走到这里）
  process.on('uncaughtException', (error) => {
    sweep();
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    sweep();
    process.stderr.write(`${reason && reason.stack ? reason.stack : reason}\n`);
    process.exit(1);
  });
}

/**
 * 进程是否还活着（用来判断某个 profile 是不是残留）。
 *
 * `process.kill(pid, 0)` 不发信号，只做权限/存在性检查——
 * 这是判断 pid 存活的标准手法，Windows 上也管用。
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于我们（仍然算活着）
    return error && error.code === 'EPERM';
  }
}

/**
 * 读某个 profile 目录里记录的 owner pid（读不出来就抛）。
 *
 * ⚠️ 要去掉 UTF-8 BOM：Windows 上手工创建的文本文件常带 BOM，
 * 而 `JSON.parse` 遇到 BOM 会直接抛——于是「有 owner 但读不出来」被
 * 当成「没有 owner」，退化成按时间判断（要等 2 小时才清）。
 * 实测踩到过：造一个假残留验证清扫时，因为 BOM 而没被清掉。
 */
function readOwnerPid(dir) {
  const raw = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8');
  const owner = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const pid = Number(owner && owner.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`owner.json 里的 pid 不合法: ${owner && owner.pid}`);
  }
  return pid;
}

/**
 * 清扫**上一次**运行留下的 profile 目录。
 *
 * 三条判据，任一条成立就删：
 *
 * 1. `owner.json` 里的 pid **已经不在了** —— 正常退出、抛错退出、
 *    被 Ctrl-C 都走这条（最可靠的一条）；
 * 2. 没有 `owner.json`（老版本留下的）且目录**超过 2 小时**没动过；
 * 3. 目录**超过 6 小时**没动过 —— 兜底。
 *
 * 第 3 条是为了「进程还活着但脚本卡住了」这种情况：那时 pid 是活的，
 * 前两条都不成立，但目录其实已经没人用了。有这条上限，
 * 磁盘占用就**一定有界**，不会再出现把 C 盘撑爆那种事。
 *
 * 判据用 pid 而不是「按时间猜」是因为同一台机器上可能同时跑着两个验收
 * （不同的 pid），按时间清扫会把别人正在用的目录删掉。
 */
function sweepStaleProfiles() {
  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return; // 临时目录读不了就算了，不该因此让验收失败
  }
  const staleCutoff = Date.now() - 2 * 60 * 60 * 1000;
  const hardCutoff = Date.now() - 6 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROFILE_PREFIX)) continue;
    const dir = path.join(tmp, entry.name);
    let age = Infinity;
    try {
      age = fs.statSync(dir).mtimeMs;
    } catch {
      continue; // 刚被别的进程删掉了
    }
    let stale = age < hardCutoff;
    if (!stale) {
      try {
        stale = !isAlive(readOwnerPid(dir));
      } catch {
        // 没有 owner.json（老版本留下的）或内容坏了 → 按时间判断
        stale = age < staleCutoff;
      }
    }
    if (!stale) continue;
    // Windows 上删不掉通常是 Chrome 还没退干净；重试几次再放弃
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
        break;
      } catch {
        // 同步重试之间不能 await，用忙等换时间（这里只发生在清扫残留时）
        const until = Date.now() + 150;
        while (Date.now() < until) { /* 等 Chrome 放开文件句柄 */ }
      }
    }
  }
  if (removed) {
    process.stderr.write(`[cdp] 清扫了 ${removed} 个上次残留的浏览器 profile\n`);
  }
}

/** 在常见安装位置里找浏览器可执行文件。 */
export function findBrowser() {
  const candidates = [
    process.env.PET_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 忽略：候选路径探测失败不影响其它候选
    }
  }
  throw new Error('找不到 Chrome / Edge；可用 PET_BROWSER 环境变量指定浏览器路径');
}

/**
 * 启动一个无头浏览器并连上它的 CDP 端点。
 *
 * `width/height` 决定视口大小——宿主用 `window.innerWidth < 900` 判定移动端，
 * 因此这是验证「移动端不挂载」的开关。
 */
export async function launch({ width = 1440, height = 900, headless = true, extraArgs = [] } = {}) {
  registerCleanup();
  sweepStaleProfiles();

  const executable = findBrowser();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  // 记下 owner：下次启动时靠它判断这个目录是不是残留（见 `sweepStaleProfiles`）
  try {
    fs.writeFileSync(
      path.join(userDataDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8',
    );
  } catch {
    // 写不进去不影响本次运行（只是下次清扫时退化成按时间判断）
  }
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,BackForwardCache',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    ...(headless ? ['--headless=new', '--hide-scrollbars', '--mute-audio'] : []),
    ...extraArgs,
    'about:blank',
  ];

  // ★ `stdio: 'ignore'` 而不是 `'pipe'`：我们**从不读**这两个流，
  // 而管道会占着 Node 的事件循环、还要额外缓冲 Chrome 的输出。
  const child = spawn(executable, args, { stdio: 'ignore' });
  // DevTools 端口写在 user-data-dir 的 DevToolsActivePort 里（第一行是端口）
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 100; i += 1) {
    if (fs.existsSync(portFile)) {
      try {
        const [first] = fs.readFileSync(portFile, 'utf8').split('\n');
        const parsed = Number(first.trim());
        if (parsed > 0) { port = parsed; break; }
      } catch {
        // 文件可能只写了一半，下一轮重试
      }
    }
    await sleep(100);
  }
  if (!port) {
    child.kill();
    removeProfile(userDataDir);
    throw new Error('浏览器未在 10 秒内暴露 DevTools 端口');
  }

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = new CdpSession(version.webSocketDebuggerUrl);

  let closed = false;
  const session = {
    port,
    child,
    browser,
    userDataDir,
    /**
     * **同步**杀掉浏览器进程，并尽力回收目录（供进程退出钩子用）。
     *
     * 为什么是「尽力」：退出钩子里删目录在 Windows 上经常失败——
     * `child.kill()` 之后 Chrome 还没来得及放开文件句柄，`rmSync` 抛
     * EBUSY/EPERM。这时**不能等**（钩子里没有异步的余地，也不能把
     * 退出拖住几秒），因此删不掉就放弃，留给下次启动的
     * `sweepStaleProfiles()` 按 pid 清扫——那时 Chrome 肯定退干净了。
     *
     * 为什么不干脆不删：`killNow` 之后立刻删其实**经常成功**
     * （进程已经收到终止信号），试一下的成本只有一次 `rmSync`。
     */
    killNow() {
      if (closed) return;
      closed = true;
      try { browser.close(); } catch { /* 已经断了 */ }
      try { child.kill(); } catch { /* 已经退出 */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 交给下次清扫 */ }
    },
    async newPage() {
      const target = await browser.send('Target.createTarget', { url: 'about:blank' });
      const page = new CdpSession(
        `ws://127.0.0.1:${port}/devtools/page/${target.targetId}`,
      );
      return page;
    },
    /**
     * 关掉浏览器并**回收 profile 目录**。
     *
     * ★ 这里必须**等子进程真的退出**再删目录。
     *
     * 原来的写法是 `child.kill()` 之后**立刻** `rmSync()`——在 Windows 上
     * 那一刻 Chrome 还握着目录里的文件句柄，`rmSync` 抛 EBUSY/EPERM，
     * 而 `catch {}` 把它吞了。于是**每一次**验收都留下一个几十 MB 的
     * profile，反复跑就把 C 盘撑爆（实测 `ENOSPC`）。
     *
     * 现在：等 `exit` 事件（最多 5 秒）→ 再删，并带重试。
     */
    async close() {
      if (closed) return;
      closed = true;
      liveSessions.delete(session);
      try { browser.close(); } catch { /* 已经断了 */ }
      await waitForExit(child, 5000);
      try { child.kill(); } catch { /* 已经退出 */ }
      removeProfile(userDataDir);
    },
  };
  liveSessions.add(session);
  return session;
}

/** 等子进程退出（最多 `timeoutMs`），已退出则立即返回。 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener('exit', done);
      resolve();
    }, timeoutMs);
    child.once('exit', done);
  });
}

/**
 * 删掉 profile 目录，**带重试**。
 *
 * Windows 上删目录失败几乎总是「文件还被占着」，等一下就好——
 * 因此重试而不是一次放弃。全部失败时给出提示（而不是静默吞掉），
 * 这样再出现膨胀时能立刻看到原因。
 */
function removeProfile(dir, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      const until = Date.now() + 120 * (attempt + 1);
      while (Date.now() < until) { /* 同步重试之间用忙等换时间 */ }
    }
  }
  process.stderr.write(
    `[cdp] 无法删除浏览器 profile: ${dir}\n`
    + '      下次启动时会自动清扫（按 owner.json 里的 pid 判断）\n',
  );
  return false;
}

/** 一条 CDP 连接（浏览器级或页面级）。 */
export class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.opened = new Promise((resolve, reject) => {
      this.socket = new WebSocket(url);
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', (event) => {
        // ⚠️ 关连接时也会走到这里。若那时 `opened` 已经没人 await 了，
        // 这个 reject 就变成**未处理的拒绝**，直接把进程打挂
        // （实测：`b.close()` 之后报「CDP 连接失败: ws://...」并退出）。
        //
        // 关掉之后 socket 出错是**预期**的，因此那时不 reject——
        // 只把 opened 结掉，让任何还在 await 的调用方拿到一个明确的错误。
        if (this.closed) {
          resolve();
          return;
        }
        reject(new Error(`CDP 连接失败: ${event.message || url}`));
      });
      this.socket.addEventListener('message', (event) => this._onMessage(String(event.data)));
    });
    // 给 `opened` 挂一个空的 catch：即使没人 await，也不让它变成
    // 未处理拒绝（真正的错误仍会通过 `send()` 的 await 抛给调用方）。
    this.opened.catch(() => {});
  }

  _onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) || []) handler(message.params);
    }
  }

  async send(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  /** 在页面里求值一段表达式，返回按值传递的结果。 */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: false,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || '未知求值异常';
      throw new Error(text);
    }
    return result.result.value;
  }

  /** 轮询直到表达式返回真值（真实页面加载是异步的）。 */
  async waitFor(expression, { timeout = 15000, interval = 150, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (error) {
        if (error.message.includes('Cannot find context')
          || error.message.includes('Execution context was destroyed')) {
          await sleep(interval);
          continue;
        }
        last = `求值失败: ${error.message}`;
      }
      await sleep(interval);
    }
    throw new Error(`等待超时: ${label}（最后一次结果: ${JSON.stringify(last)}）`);
  }

  async navigate(url, { waitUntil = 'load', timeout = 30000 } = {}) {
    await this.send('Page.enable');
    const loaded = new Promise((resolve) => {
      const off = (params) => resolve(params);
      this.on('Page.loadEventFired', off);
    });
    await this.send('Page.navigate', { url });
    if (waitUntil === 'load') {
      await Promise.race([loaded, sleep(timeout)]);
    }
    return true;
  }

  /** 设置视口尺寸。宿主用 `window.innerWidth` 判 deviceType，改这里即可切换。 */
  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  close() {
    // 先置位再关：`closed` 让 error 处理器知道「这是关连接引起的」，
    // 于是不会把错误当成连接失败抛出去（见构造函数里的说明）。
    this.closed = true;
    try { this.socket.close(); } catch { /* 已经关了 */ }
  }
}
