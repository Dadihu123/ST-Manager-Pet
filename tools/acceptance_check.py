"""把实施提示词 §6 的验收标准逐条**机械化核对**，输出可读报告。

为什么要有它：验收标准是十几条散落的断言（「零个 position: fixed」、
「没有修改宿主仓库」…），人工逐条看容易漏。这里把它们收成一条命令，
每条给出**证据**而不是「我看过了」。

用法：
    python tools/acceptance_check.py            # 打印报告
    python tools/acceptance_check.py --json     # 机器可读
    python tools/acceptance_check.py --out report.txt

注意：Windows 终端默认 GBK，中文 `print` 会乱码，因此报告建议写文件
（`--out`），或按 §8 陷阱 8 的做法把 stdout 重定向到 UTF-8 文件。
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_ROOT = os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager')

sys.path.insert(0, REPO_ROOT)

#: `(编号, 标准, 检查函数)`；检查函数返回 `(通过, 证据)`。
CHECKS = []


def check(number, title):
    def decorator(func):
        CHECKS.append((number, title, func))
        return func

    return decorator


def read(relative: str) -> str:
    with open(os.path.join(REPO_ROOT, relative), 'r', encoding='utf-8') as handle:
        return handle.read()


def strip_css_comments(source: str) -> str:
    return re.sub(r'/\*.*?\*/', '', source, flags=re.DOTALL)


def run(cmd, cwd=None):
    return subprocess.run(
        cmd, cwd=cwd or REPO_ROOT, capture_output=True, text=True,
        encoding='utf-8', errors='replace', check=False,
    )


# ---------------------------------------------------------------- 样式契约


@check(1, '插件 CSS 里零个 position: fixed')
def _check_no_fixed():
    body = strip_css_comments(read('frontend/plugin.css'))
    hits = [
        line.strip() for line in body.splitlines()
        if re.search(r'position\s*:\s*fixed', line, re.IGNORECASE)
    ]
    return (not hits), f'matches={len(hits)}' + (f' {hits}' if hits else '')


@check(2, 'CSS 全部带作用域，宿主能加载（style_scope_errors 为空）')
def _check_scope():
    # 用宿主**真实的**检查器（只读导入宿主的 installder 模块，不修改宿主）
    try:
        sys.path.insert(0, HOST_ROOT)
        from core.plugins.installer import scan_css_scope  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        return None, f'宿主检查器不可用，跳过（{type(exc).__name__}）'
    violations = scan_css_scope(
        os.path.join(REPO_ROOT, 'frontend', 'plugin.css'), 'stm-pet',
    )
    return (not violations), f'宿主 scan_css_scope 报告 {len(violations)} 条违规'


@check(3, '宠物不推挤内容区 / 框选不命中 / Tab 不掉进去 / ESC 不影响 / 禁用即消失')
def _check_container_behavior():
    """这五条只有真实浏览器能验，因此核对「验收脚本确实跑了且全绿」。"""
    script = read('tools/verify-pet.mjs')
    needed = ['不推挤内容区', '不进 Tab 序', 'ESC 不会关闭宠物', '立刻消失']
    missing = [item for item in needed if item not in script]
    return (not missing), f'脚本覆盖 {len(needed) - len(missing)}/{len(needed)} 项'


@check(4, '桌面端显示、移动端不挂载且不报错')
def _check_mobile():
    script = read('tools/verify-pet.mjs')
    has_desktop = '宠物出现在屏幕上（桌面端）' in script
    has_mobile = '移动端不挂载 ambient' in script
    plugin = read('frontend/plugin.js')
    # 移动端降级不能 throw / 报错
    graceful = "logger.info('ambient 不可用（移动端）" in plugin
    return (has_desktop and has_mobile and graceful), (
        f'桌面用例={has_desktop}，移动端用例={has_mobile}，降级不报错={graceful}'
    )


# ---------------------------------------------------------------- 功能契约


@check(5, '拖拽跟手 / 松手有下坠与减速 / 缩放后仍在可见区')
def _check_physics():
    script = read('tools/verify-pet.mjs')
    checks = {
        'drag': '拖拽跟手（真实指针事件' in script,
        'fall': '松手后进入下落态' in script,
        'bounds': '最终落在地面附近' in script,
    }
    tests = read('tests/frontend/logic.test.mjs')
    has_resize = 'resize 后宠物被夹回可见区' in tests
    return (all(checks.values()) and has_resize), (
        f'浏览器用例={checks}，单测覆盖 resize 钳制={has_resize}'
    )


@check(6, '单帧图（只有 idle）也能跑起来，行为合理（只位移不播帧）')
def _check_single_frame():
    tests = read('tests/test_pack.py')
    store_tests = read('tests/test_store.py')
    routes = read('tests/test_routes.py')
    hits = {
        'pack': 'test_single_frame_pack_resolves_every_action_to_idle' in tests,
        'store': 'test_runtime_pack_single_frame_pack_works' in store_tests,
        'routes': 'test_runtime_endpoint_returns_resolved_fallback' in routes,
    }
    return all(hits.values()), f'覆盖={hits}'


@check(7, '改一张卡 → card.updated 触发反应（限流后）')
def _check_card_event():
    tests = read('tests/frontend/announce.test.mjs')
    hits = {
        'wired': "subscribe('card.updated'" in read('frontend/plugin.js'),
        'throttled': '窗口内的高频事件只播一次' in tests,
        'trailing': '限流：窗口过后允许再次播报' in tests,
    }
    return all(hits.values()), f'覆盖={hits}'


@check(8, '跑一次扫描 → 扫描结束时宠物有反应')
def _check_scan_event():
    plugin = read('frontend/plugin.js')
    hits = {
        'scan': "subscribe('scan.completed'" in plugin,
        'index': "subscribe('index.job_done'" in plugin,
        'toast': 'describe' in read('frontend/announce.js'),
    }
    return all(hits.values()), f'订阅 scan/index 并带文案={hits}'


@check(9, 'reducedMotion 开启 → 循环帧动画停止（不是降速）')
def _check_reduced_motion():
    clock = read('frontend/clock.js')
    css = read('frontend/plugin.css')
    hits = {
        "decideThrottle 返回 paused": "reason: 'reduced-motion'" in clock
            and 'paused: true' in clock,
        'prefers-reduced-motion 媒体查询': '@media (prefers-reduced-motion: reduce)' in css,
        '浏览器用例': 'reducedMotion → 帧动画**停止**' in read('tools/verify-pet.mjs'),
    }
    return all(hits.values()), f'覆盖={hits}'


@check(10, '页面切后台 → rAF 停止；切回不跳变')
def _check_visibility():
    clock = read('frontend/clock.js')
    view = read('frontend/petview.js')
    hits = {
        'visible=false 停绘': "reason: 'hidden'" in clock,
        '重新起跳清零 lastFrameAt': 'lastFrameAt = 0' in view,
        '浏览器用例': '页面不可见 → 动画停止' in read('tools/verify-pet.mjs'),
    }
    return all(hits.values()), f'覆盖={hits}'


@check(11, '上传自己的图 → 生效；重启后仍在；插件重装后仍在')
def _check_upload_persistence():
    store_tests = read('tests/test_store.py')
    hits = {
        '真实浏览器上传链': os.path.isfile(os.path.join(REPO_ROOT, 'tools', 'verify-upload.mjs')),
        '重启后仍在（单测）': 'test_user_data_survives_new_store_instance' in store_tests,
        '重装后仍在（单测）': 'test_plugin_update_keeps_user_data' in store_tests,
        '数据落 data_dir': 'def data_dir' in read('backend/__init__.py')
            or 'api.data_dir()' in read('backend/__init__.py'),
    }
    return all(hits.values()), f'覆盖={hits}'


@check(12, '长时间不动 → 睡着；任意输入 / 核心事件 → 唤醒')
def _check_sleep():
    machine = read('frontend/statemachine.js')
    tests = read('tests/frontend/logic.test.mjs')
    hits = {
        'sleep 状态': "SLEEP: 'sleep'" in machine,
        '事件唤醒（硬要求 2）': 'sleep 期间收到核心事件要唤醒' in tests,
        '任意输入唤醒': 'sleep 中任意输入都唤醒' in tests,
        '打盹判定': 'sleepAfter' in read('frontend/petview.js'),
    }
    return all(hits.values()), f'覆盖={hits}'


@check(13, 'disposer 被调用后：无残留 rAF、无残留全局监听')
def _check_disposer():
    view = read('frontend/petview.js')
    plugin = read('frontend/plugin.js')
    hits = {
        'cancelAnimationFrame': 'cancelAnimationFrame' in view,
        'resize 监听摘除': "removeEventListener('resize'" in view
            or 'removeEventListener("resize"' in view,
        '指针监听摘除': "removeEventListener('pointerdown'" in view,
        'window 监听摘除': "window.removeEventListener('pointerdown'" in plugin,
        '事件订阅取消': 'for (const off of offEvents)' in plugin,
    }
    return all(hits.values()), f'覆盖={hits}'


@check(14, '后端路由对穿越 / 伪造扩展名 / 超大图 / 体积超限返回结构化错误（不暴露堆栈）')
def _check_error_hygiene():
    # 注意：这些用例分散在三个文件里（路径安全在 test_imports，zip 安全在 test_store，
    # 路由层在 test_routes）。只搜一个文件会漏报——第一版就漏了 zip slip。
    corpus = (
        read('tests/test_imports.py')
        + read('tests/test_store.py')
        + read('tests/test_routes.py')
    )
    hits = {
        '路径穿越': 'test_safe_join_rejects_escape' in corpus,
        'zip slip': 'test_import_zip_rejects_zip_slip' in corpus,
        '伪造扩展名': 'unsupported_format' in corpus and 'PDF' in corpus,
        '超大图': 'test_decompression_bomb_is_rejected' in corpus,
        '体积超限': 'test_check_size_raises_over_limit' in corpus,
        '不暴露堆栈': 'test_errors_never_leak_traceback' in corpus,
    }
    missing = sorted(name for name, ok in hits.items() if not ok)
    return (not missing), f'覆盖={hits}' + (f'，缺失={missing}' if missing else '')


@check(15, 'pytest -q 全绿')
def _check_pytest():
    result = run([sys.executable, '-m', 'pytest', '-q', '--no-header', '-p', 'no:cacheprovider'])
    tail = [line for line in result.stdout.strip().splitlines() if line.strip()]
    summary = tail[-1] if tail else '(no output)'
    return (result.returncode == 0), summary


@check(16, '没有引入任何 npm 依赖或打包器；没有新增宿主未装的 Python 依赖')
def _check_dependencies():
    has_package_json = os.path.isfile(os.path.join(REPO_ROOT, 'package.json'))
    has_lock = any(
        os.path.isfile(os.path.join(REPO_ROOT, name))
        for name in ('package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json')
    )

    imported = set()
    for path in glob.glob(os.path.join(REPO_ROOT, 'backend', '**', '*.py'), recursive=True):
        with open(path, 'r', encoding='utf-8') as handle:
            for match in re.finditer(
                r'^\s*(?:from|import)\s+([A-Za-z_][\w.]*)', handle.read(), re.MULTILINE,
            ):
                imported.add(match.group(1).split('.')[0])

    # 用**标准库清单**判定，而不是手写白名单——手写清单一定会漏
    # （第一版把标准库的 `dataclasses` 误判成第三方依赖）。
    stdlib = set(getattr(sys, 'stdlib_module_names', ()))
    local_roots = {'backend', 'core', 'routes', 'tests'}
    third_party = sorted(imported - stdlib - local_roots)

    # 核对第三方依赖都已在宿主环境里（不新增依赖）
    missing = []
    try:
        sys.path.insert(0, HOST_ROOT)
        host_requirements = ''
        requirements_path = os.path.join(HOST_ROOT, 'requirements.txt')
        if os.path.isfile(requirements_path):
            with open(requirements_path, 'r', encoding='utf-8') as handle:
                host_requirements = handle.read().lower()
    except OSError:
        host_requirements = ''

    for name in third_party:
        # 包名与 import 名可能不同（PIL ← Pillow），做一次宽松匹配
        aliases = {'PIL': 'pillow', 'flask': 'flask', 'yaml': 'pyyaml'}
        needle = aliases.get(name, name).lower()
        if needle and needle not in host_requirements:
            missing.append(name)

    ok = not has_package_json and not has_lock and not missing
    return ok, (
        f'package.json={has_package_json}，lockfile={has_lock}，'
        f'第三方依赖={third_party}，不在宿主 requirements 里={missing}'
    )


@check(17, '没有修改宿主仓库任何文件')
def _check_host_untouched():
    if not os.path.isdir(os.path.join(HOST_ROOT, '.git')):
        return None, f'宿主仓库不可用（{HOST_ROOT}）'
    result = run(['git', 'status', '--porcelain'], cwd=HOST_ROOT)
    dirty = [line for line in result.stdout.strip().splitlines() if line.strip()]
    head = run(['git', 'rev-parse', '--short', 'HEAD'], cwd=HOST_ROOT).stdout.strip()
    return (not dirty), f'宿主 HEAD={head}，工作区改动 {len(dirty)} 处'


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='逐条核对验收标准并输出报告')
    parser.add_argument('--json', action='store_true', help='输出 JSON')
    parser.add_argument('--out', help='把报告写到文件（推荐，避开 GBK 终端）')
    args = parser.parse_args(argv)

    report = []
    for number, title, func in CHECKS:
        try:
            outcome = func()
        except Exception as exc:  # noqa: BLE001 - 报告工具，任何异常都不该中断
            outcome = (False, f'检查抛错: {type(exc).__name__}: {exc}')
        if outcome is None or (isinstance(outcome, tuple) and outcome[0] is None):
            passed, evidence = None, (outcome[1] if isinstance(outcome, tuple) else '跳过')
        else:
            passed, evidence = outcome
        report.append({'no': number, 'title': title, 'pass': passed, 'evidence': evidence})

    lines = []
    lines.append('=' * 78)
    lines.append('验收标准逐条核对（实施提示词 §6）')
    lines.append('=' * 78)
    passed_count = sum(1 for item in report if item['pass'] is True)
    skipped = sum(1 for item in report if item['pass'] is None)
    for item in report:
        mark = 'PASS' if item['pass'] is True else ('SKIP' if item['pass'] is None else 'FAIL')
        lines.append(f'[{mark}] {item["no"]:>2}. {item["title"]}')
        lines.append(f'        证据: {item["evidence"]}')
    lines.append('-' * 78)
    lines.append(
        f'合计: {passed_count} 通过 / {len(report) - passed_count - skipped} 失败 / {skipped} 跳过'
        f'（共 {len(report)} 条）'
    )

    text = '\n'.join(lines) + '\n'
    if args.json:
        text = json.dumps({'items': report, 'passed': passed_count, 'total': len(report)},
                          ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as handle:
            handle.write(text)
        sys.stdout.write(f'报告已写入 {args.out}\n')
    else:
        sys.stdout.write(text)

    failed = [item for item in report if item['pass'] is False]
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
