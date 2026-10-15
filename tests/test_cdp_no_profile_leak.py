"""验收工具（`tools/cdp.mjs`）不能泄漏浏览器 profile。

## 为什么有这一条

`tools/cdp.mjs` 每次 `launch()` 都会 `mkdtempSync` 造一个新的 Chrome
用户数据目录（几十 MB）。原来的 `close()` 是：

    child.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

在 Windows 上 `kill()` 之后 Chrome **还没放开文件句柄**，`rmSync` 抛
EBUSY/EPERM，而 `catch {}` 把它吞了。于是**每一次**验收都留下一个目录。
反复跑 14 个套件之后，残留把 C 盘撑爆（实测 `ENOSPC: no space left on
device`，连 pytest 都写不出结果文件）。

因此这里钉住三件事：

1. `close()` **等子进程退出**再删目录，并且**带重试**；
2. 进程异常退出（抛错 / Ctrl-C / 被 kill）时由退出钩子回收；
3. 启动时**清扫**上一次的残留（按 `owner.json` 里的 pid 判断存活），
   且有一条**绝对时限**兜底，保证磁盘占用一定有界。
"""

import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _source():
    with open(os.path.join(REPO_ROOT, 'tools', 'cdp.mjs'), encoding='utf-8') as handle:
        return handle.read()


def test_close_waits_for_exit_before_removing():
    """★ `close()` 必须先**等子进程退出**，再删目录。

    直接 `kill()` + `rmSync()` 在 Windows 上必然失败（句柄还没放开），
    而那个失败会被 catch 吞掉——这就是当初每次验收都泄漏一个目录的原因。
    """
    src = _source()
    assert 'waitForExit' in src, '缺少「等子进程退出」这一步'
    close_body = src[src.index('async close()'):]
    close_body = close_body[:close_body.index('\n    },')]
    assert 'waitForExit' in close_body, 'close() 里没有等子进程退出'
    # 等待必须发生在删除**之前**
    assert close_body.index('waitForExit') < close_body.index('removeProfile'), (
        '删目录发生在等子进程退出之前——Windows 上会失败'
    )


def test_remove_profile_retries():
    """删目录要**重试**：Windows 上「文件还被占着」等一下就好。"""
    src = _source()
    assert 'function removeProfile' in src
    body = src[src.index('function removeProfile'):]
    body = body[:body.index('\n}')]
    assert 'attempts' in body and 'for (' in body, 'removeProfile 没有重试循环'
    assert 'rmSync' in body


def test_cleanup_registered_for_every_exit_path():
    """★ 异常退出也要回收（那是**最主要**的泄漏路径：断言失败就走到那里）。"""
    src = _source()
    assert 'function registerCleanup' in src
    for event in ('exit', 'uncaughtException', 'unhandledRejection'):
        assert f"process.on('{event}'" in src, f'没有挂 {event} 钩子'
    for signal in ('SIGINT', 'SIGTERM'):
        assert f"'{signal}'" in src, f'没有处理 {signal}'


def test_stale_profiles_are_swept_at_launch():
    """★ 启动时清扫上一次的残留（兜住「进程被硬杀」这类收不到钩子的情况）。"""
    src = _source()
    assert 'function sweepStaleProfiles' in src
    launch_body = src[src.index('export async function launch'):]
    assert 'sweepStaleProfiles()' in launch_body, 'launch 没有清扫残留'
    assert 'registerCleanup()' in launch_body, 'launch 没有挂退出钩子'


def test_sweep_uses_pid_liveness_not_only_time():
    """按 **pid 存活**判断残留，而不是只按时间。

    只按时间的话，同一台机器上并行跑两个验收时，会把对方正在用的
    目录删掉（表现为随机的、极难查的失败）。
    """
    src = _source()
    assert 'function isAlive' in src
    assert 'owner.json' in src, '没有记录 owner，无法按 pid 判断'
    assert 'process.kill(pid, 0)' in src, '存活判断的手法不对'
    body = src[src.index('function sweepStaleProfiles'):]
    body = body[:body.index('\n}')]
    assert 'isAlive' in body, '清扫没有用 pid 存活判断'


def test_sweep_has_an_absolute_age_cap():
    """★ 必须有一条**绝对时限**兜底。

    否则「进程活着但脚本卡住了」的目录永远不会被清（pid 是活的），
    磁盘占用就没有上界——那正是当初把 C 盘撑爆的形态。
    """
    src = _source()
    body = src[src.index('function sweepStaleProfiles'):]
    body = body[:body.index('\n}')]
    assert 'hardCutoff' in body, '缺少绝对时限兜底'
    # 6 小时的毫秒数
    assert '6 * 60 * 60 * 1000' in body, '绝对时限不是 6 小时'


def test_profile_prefix_is_named_and_reused():
    """目录前缀是一个常量（清扫靠它识别，写死两处迟早不一致）。"""
    src = _source()
    assert "const PROFILE_PREFIX = 'pet-cdp-'" in src
    assert 'mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX))' in src


def test_child_stdio_is_not_piped():
    """不要 `stdio: 'pipe'`：我们从不读那两个流，而管道会占着事件循环。

    （管道还要求调用方持续消费，否则 Chrome 写满缓冲后自己卡住。）
    """
    src = _source()
    assert "spawn(executable, args, { stdio: 'ignore' })" in src
    assert "stdio: ['ignore', 'pipe', 'pipe']" not in src


def test_every_verify_suite_closes_the_browser():
    """★ 每个验收套件都必须**保证**关掉浏览器。

    要么 `await browser.close()`，要么包在 `try/finally` 里。
    漏掉的后果不是「测试失败」而是「磁盘慢慢被吃光」——
    那种问题在写代码时完全看不见。
    """
    tools_dir = os.path.join(REPO_ROOT, 'tools')
    missing = []
    for name in sorted(os.listdir(tools_dir)):
        if not name.startswith('verify-') or not name.endswith('.mjs'):
            continue
        with open(os.path.join(tools_dir, name), encoding='utf-8') as handle:
            body = handle.read()
        if 'launch(' not in body:
            continue  # 不用浏览器的套件（纯静态断言）
        if 'browser.close()' not in body:
            missing.append(name)
            continue
        # 关掉它必须在 finally 里（否则断言失败就走不到）
        if 'finally' not in body:
            missing.append(f'{name}（close 没有包在 finally 里）')
    assert missing == [], f'这些套件没有可靠地关掉浏览器: {missing}'
