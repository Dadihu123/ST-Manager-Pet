"""前端对宿主 API 的调用必须都**真实存在**。

为什么这个测试值得存在：真实浏览器验收抓到了一个 pytest 与 Node 测试都漏掉的 bug ——
插件里写了 `api.log(...)`，但宿主**没有** `api.log`（真实签名是
`api.host.log(message, level)`，且参数顺序相反）。宿主在 `activate()` 中途捕获了这个
`TypeError`，表现是「插件加载失败」但宠物已经画出来了，非常难查。

因此这里把「插件用到宿主 API」这件事变成可检查的：
从 `static/js/pluginHost.js`（宿主仓库，**只读**）解析出 `api` 对象的成员名，
再扫描本插件前端里所有 `api.<member>` 用法，逐条核对。
"""

import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_ROOT = os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager')
HOST_PLUGIN_HOST = os.path.join(HOST_ROOT, 'static', 'js', 'pluginHost.js')

FRONTEND_DIR = os.path.join(REPO_ROOT, 'frontend')

#: 从 `api.host.*` 之外还能拿到的、由宿主在别的文件里挂上去的成员。
#: 这些是 host 对象内部的方法名，单独列一份（从同一文件解析）。
EXTRA_KNOWN = {
    # 由插件自己挂到 api 上的（不是宿主提供）
    'pet_store',
}

requires_host = pytest.mark.skipif(
    not os.path.isfile(HOST_PLUGIN_HOST),
    reason=f'宿主仓库不可用（找不到 {HOST_PLUGIN_HOST}）',
)


def read(path: str) -> str:
    with open(path, 'r', encoding='utf-8') as handle:
        return handle.read()


def frontend_sources() -> dict:
    result = {}
    for name in sorted(os.listdir(FRONTEND_DIR)):
        if name.endswith('.js'):
            result[name] = read(os.path.join(FRONTEND_DIR, name))
    return result


def strip_comments(source: str) -> str:
    """去掉 `/* ... */` 与 `// ...`。

    必须去掉：本插件源码的**注释里**刻意提到了 `api.log`（说明"宿主没有它"），
    不剥离的话检查会把文档当成真实调用。
    """
    without_block = re.sub(r'/\*.*?\*/', '', source, flags=re.DOTALL)
    return re.sub(r'//[^\n]*', '', without_block)


def _object_member_names(source: str, open_index: int, indent: int) -> set:
    """从 `source[open_index]` 处的 `{` 开始，解析该对象字面量的**顶层键名**。

    只按缩进匹配，不做完整 JS 解析：宿主的 `api` 对象字面量格式稳定
    （顶层键缩进恰好 `indent` 个空格），这比引一个 JS 解析器便宜得多。
    注意要同时覆盖 `name(...)` / `name: ...` / `async name(...)` 三种形态。
    """
    members = set()
    depth = 0
    pattern = re.compile(
        rf'^ {{{indent}}}(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[:(]'
    )
    for line in source[open_index:].splitlines():
        if depth == 1:
            match = pattern.match(line)
            if match:
                members.add(match.group(1))
        depth += line.count('{') - line.count('}')
        if depth <= 0 and members:
            break
    return members


def parse_host_api_members() -> set:
    """从宿主的 `const api = { ... }` 字面量解析顶层成员名。"""
    source = read(HOST_PLUGIN_HOST)
    marker = '    const api = {'
    assert marker in source, '宿主 pluginHost.js 的结构变了：找不到 `const api = {`'
    return _object_member_names(source, source.index(marker) + len(marker) - 1, 6)


def parse_host_members(sub_object: str) -> set:
    """解析 `api.<sub_object> = { ... }` 这类子对象的成员名。"""
    source = read(HOST_PLUGIN_HOST)
    marker = f'      {sub_object}: {{'
    if marker not in source:
        return set()
    return _object_member_names(source, source.index(marker) + len(marker) - 1, 8)


@requires_host
def test_host_api_members_parsed_from_source():
    """反向验证：解析器本身要能拿到已知成员，否则后面的断言是空转。"""
    members = parse_host_api_members()
    assert 'on' in members, f'解析出的成员不像 api 对象: {sorted(members)}'
    assert 'surfaces' in members
    assert 'host' in members
    assert 'toast' in members
    # `log` **不应该**在顶层（这正是我们踩过的坑）
    assert 'log' not in members, (
        '宿主现在有了顶层 api.log？如果是，本插件的 createLogger 适配层可以简化，'
        '并请更新 CHANGELOG「与实施提示词的偏差」第 3 条'
    )


@requires_host
def test_host_sub_object_members_parsed():
    host_members = parse_host_members('host')
    assert 'log' in host_members, f'api.host 的成员解析异常: {sorted(host_members)}'
    assert 'onState' in host_members
    assert 'toast' in host_members


@requires_host
def test_plugin_only_calls_existing_api_members():
    """★ 插件里出现的每个 `api.<member>` 都必须是宿主真实提供的。

    只看**去掉注释**后的代码。允许一种例外：由 `typeof api.x === 'function'`
    **守卫**过的调用——那是防御性的能力探测（适配层用它兼容宿主将来新增的方法），
    不是"假定它存在"。判定方式：在同一函数体内、该调用之前出现过对同一成员的
    `typeof` 检查。
    """
    known = parse_host_api_members() | EXTRA_KNOWN
    offenders = []
    for name, raw in frontend_sources().items():
        source = strip_comments(raw)
        for match in re.finditer(r'\bapi\.([A-Za-z_$][\w$]*)', source):
            member = match.group(1)
            if member in known:
                continue
            # 情况 1：这一处本身就是 `typeof api.x` 探测（正则也会命中探测表达式）
            if source[max(0, match.start() - 7):match.start()].endswith('typeof '):
                continue
            # 情况 2：之前 400 字符内出现过对同一成员的 typeof 守卫（被守卫的调用）
            window = source[max(0, match.start() - 400):match.start()]
            if f'typeof api.{member}' in window:
                continue
            line_no = source[: match.start()].count('\n') + 1
            offenders.append(f'{name}:{line_no} api.{member}')
    assert offenders == [], (
        '这些 api.* 成员在宿主 pluginHost.js 里不存在：\n' + '\n'.join(sorted(set(offenders)))
    )


@requires_host
def test_logger_uses_the_real_host_signature():
    """`api.host.log` 的参数顺序是 `(message, level)`，别写反。"""
    source = read(os.path.join(FRONTEND_DIR, 'plugin.js'))
    # 适配层里那一次调用必须是 (message, level)
    match = re.search(r'api\.host\.log\(([^)]*)\)', source)
    assert match, '没有找到 api.host.log 的调用（适配层应保留它）'
    args = [part.strip() for part in match.group(1).split(',')]
    assert len(args) == 2, f'api.host.log 应传两个参数: {args}'
    assert 'message' in args[0], f'第一个参数应是 message（宿主签名是 message, level）: {args}'
    assert 'level' in args[1], f'第二个参数应是 level: {args}'


def test_no_api_log_call_outside_the_adapter():
    """除了适配层那一处，代码里不该直接调 `api.log(`。"""
    source = read(os.path.join(FRONTEND_DIR, 'plugin.js'))
    outside_adapter = source[source.index('return {'):]  # 适配层之后的部分
    assert 'api.log(' not in outside_adapter, (
        '宿主没有 api.log；请用 createLogger(api) 返回的 logger'
    )


def test_deactivate_does_not_reference_closure_logger():
    """`deactivate` 是模块级的，不能引用 `activate` 闭包里的 logger。"""
    source = read(os.path.join(FRONTEND_DIR, 'plugin.js'))
    tail = source[source.index('export function deactivate'):]
    assert 'logger.info' not in tail, (
        'deactivate 里引用闭包 logger 会抛 ReferenceError（卸载路径最不该出问题）'
    )


def test_all_frontend_modules_are_valid_esm():
    """前端模块必须能被 Node 真正 import（真正的语法检查，而不是数括号）。

    `plugin.js` / `petview.js` / `panel.js` import 时只做定义、不执行副作用，
    因此可以在 Node 里安全 import——这能抓到语法错误与顶层引用错误。
    """
    import json
    import shutil
    import subprocess

    if shutil.which('node') is None:
        pytest.skip('Node.js 不可用')

    names = ['plugin.js', 'petview.js', 'panel.js', 'clock.js', 'physics.js',
             'statemachine.js', 'announce.js', 'direction.js', 'animation.js',
             'gesture.js', 'preview.js']
    script = (
        "const { pathToFileURL } = await import('node:url');\n"
        "const { join } = await import('node:path');\n"
        f"const dir = {json.dumps(FRONTEND_DIR)};\n"
        f"const names = {json.dumps(names)};\n"
        "for (const name of names) {\n"
        "  await import(pathToFileURL(join(dir, name)).href);\n"
        "}\n"
        "process.stdout.write('ok');\n"
    )
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True, text=True, encoding='utf-8', errors='replace', check=False,
    )
    assert result.returncode == 0, (
        f'前端模块无法被 Node 加载（语法错误？）:\n{result.stdout}\n{result.stderr}'
    )
    assert 'ok' in result.stdout


def test_manifest_declares_settings_entry_and_no_ambient_surface():
    """manifest 里的入口声明要符合宿主契约。"""
    import json

    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)

    entries = manifest['frontend']['entries']
    assert len(entries) >= 1
    settings = [entry for entry in entries if entry['kind'] == 'settings']
    assert settings, '需要 settings 入口来承载形象管理面板'

    # `entries[]` 是「用户可见入口」，而 ambient 注册即挂载、没有入口 ——
    # 在 manifest 里写 type: ambient 会被宿主丢弃并 warning（§2.6 / §8 陷阱 6）
    for entry in entries:
        surface = entry.get('surface') or {}
        assert surface.get('type') != 'ambient', (
            f'入口 {entry["id"]} 声明了 ambient；宿主只允许 panel/modal/page/sheet'
        )
        assert surface.get('type') in ('panel', 'modal', 'page', 'sheet')
