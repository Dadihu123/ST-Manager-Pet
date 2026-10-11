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
  const executable = findBrowser();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-cdp-'));
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

  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    throw new Error('浏览器未在 10 秒内暴露 DevTools 端口');
  }

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = new CdpSession(version.webSocketDebuggerUrl);

  return {
    port,
    child,
    browser,
    async newPage() {
      const target = await browser.send('Target.createTarget', { url: 'about:blank' });
      const page = new CdpSession(
        `ws://127.0.0.1:${port}/devtools/page/${target.targetId}`,
      );
      return page;
    },
    close() {
      try { browser.close(); } catch { /* 已经断了 */ }
      try { child.kill(); } catch { /* 已经退出 */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    },
  };
}

/** 一条 CDP 连接（浏览器级或页面级）。 */
export class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket = new WebSocket(url);
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', (event) => reject(new Error(`CDP 连接失败: ${event.message || url}`)));
      this.socket.addEventListener('message', (event) => this._onMessage(String(event.data)));
    });
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
    try { this.socket.close(); } catch { /* 已经关了 */ }
  }
}
