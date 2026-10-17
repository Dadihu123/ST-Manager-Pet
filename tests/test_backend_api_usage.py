"""本插件后端只能调用宿主**新契约**（域命名空间）里的成员。

为什么这个测试值得存在
----------------------
宿主在 `docs/2026-10-12-plugin-api-expansion.md` 里把 `PluginAPI` 从「扁平白名单」
改成了**域命名空间**，并且**删掉了**旧名（插件系统未发布，没有兼容层）：

| 旧（已删除） | 新 |
|---|---|
| `route(...)` | `http.route(...)` |
| `data_dir()` | `private.dir()` |
| `log('info', msg)` | `log.info(msg)` |
| `get_config()` / `set_config(p)` | `config.get()` / `config.set(p)` |
| `db()` / `suppress_fs_events()` / `notify(...)` | 删除（`private.query` 只读 / `jobs.items` / `log.*`） |

留着旧名的后果不是「报个错」，而是**插件加载期就崩**：宿主的 `PluginAPI` 上已经
没有 `route`，`@api.route(...)` 在 `register()` 里立刻 `AttributeError`，
宿主只留一句「插件加载失败」，宠物不会出现。

因此这里做三件事：
1. **黑名单**：插件源码里不得再出现任何旧名调用（纯静态，无需宿主）。
2. **白名单**：插件用到的每个成员都要在宿主生成的 `docs/plugin-api.md` 里出现
   （宿主仓库可用时；不可用则跳过，与 `test_host_api_usage.py` 的处置一致）。
3. **装配钉子**：用只实现域形状的替身跑一遍 `register(api)`，端到端验证。
"""

import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_ROOT = os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager')
HOST_API_DOC = os.path.join(HOST_ROOT, 'docs', 'plugin-api.md')

BACKEND_DIR = os.path.join(REPO_ROOT, 'backend')

#: 方案 §3.3 里被**删除**或**改名**的扁平成员。插件源码里一律不得再调用。
LEGACY_FLAT_NAMES = (
    # 改名
    'route', 'blueprint', 'data_dir', 'get_config', 'set_config',
    'get_secret', 'set_secret', 'list_secrets',
    'register_job', 'submit_job', 'get_job', 'cancel_job', 'retry_job',
    'pause_job', 'resume_job', 'register_cli',
    'table_prefix', 'migrate',
    'ui_data_read', 'ui_data_update',
    'read_card', 'read_cards', 'write_card_fields', 'apply_tags',
    'read_tag_library', 'read_worldbook', 'write_worldbook',
    'snapshot_card',
    # 删除（能力已由域方法覆盖，或机制内部化）
    'db', 'suppress_fs_events', 'notify',
)

#: 不属宿主契约、但插件合法使用的 `api.*` 成员：
#: 身份属性（`plugin_id` / `manifest` / `app_version`）与插件自己挂上去的 `pet_store`。
NON_CONTRACT_ATTRIBUTES = {'pet_store'}

requires_host = pytest.mark.skipif(
    not os.path.isfile(HOST_API_DOC),
    reason=f'宿主文档不可用（找不到 {HOST_API_DOC}）',
)


def read(path: str) -> str:
    with open(path, 'r', encoding='utf-8') as handle:
        return handle.read()


def backend_sources() -> dict:
    """插件后端全部 Python 源文件（`backend/**/*.py`）。"""
    sources = {}
    for root, _dirs, files in os.walk(BACKEND_DIR):
        for name in sorted(files):
            if not name.endswith('.py'):
                continue
            path = os.path.join(root, name)
            sources[os.path.relpath(path, REPO_ROOT)] = read(path)
    return sources


def code_only(source: str) -> str:
    """去掉注释与**文档字符串**，只留可执行代码。

    必须去掉：本插件的模块文档字符串里刻意写着「旧名已删除、不要再调用」
    （`route()` / `data_dir()` / `log(level, msg)`），不剥离的话检查会把说明文字
    当成真实调用——这正是 `test_host_api_usage.py` 踩过的同一个坑。
    """
    without_docstrings = re.sub(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'', '', source)
    return re.sub(r'#[^\n]*', '', without_docstrings)


def api_member_references() -> list:
    """收集后端代码里出现的 `api.<a>` / `api.<a>.<b>` 引用。

    Returns:
        `[(文件, 行号, 成员路径)]`，成员路径形如 `private.dir` / `log.info`。
    """
    found = []
    pattern = re.compile(r'\bapi\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)')
    for name, raw in backend_sources().items():
        source = code_only(raw)
        for match in pattern.finditer(source):
            line_no = source[: match.start()].count('\n') + 1
            found.append((name, line_no, match.group(1)))
    return found


def test_parser_sees_the_real_calls():
    """反向验证：剥离注释后仍能看到真实调用，否则后面的断言是空转。"""
    members = {member for _name, _line, member in api_member_references()}
    assert 'http.route' in members, sorted(members)
    assert 'private.dir' in members, sorted(members)
    assert 'log.info' in members, sorted(members)
    # 文档字符串里的旧名必须被剥离掉，不能变成 offender
    assert 'route' not in members, '文档字符串没被剥离，黑名单会误报'
    assert 'data_dir' not in members, '文档字符串没被剥离，黑名单会误报'


def test_no_legacy_flat_api_names():
    """★ 插件后端不得再调用已删除的扁平名（宿主会直接 AttributeError）。"""
    offenders = []
    for name, line_no, member in api_member_references():
        head = member.split('.')[0]
        if head in LEGACY_FLAT_NAMES:
            offenders.append(f'{name}:{line_no} api.{member}')
    assert offenders == [], (
        '这些调用用的是宿主已删除的扁平名（改名为域命名空间，见 '
        'ST-Manager/docs/2026-10-12-plugin-api-expansion.md §3.3）：\n'
        + '\n'.join(sorted(set(offenders)))
    )


def test_no_api_log_with_string_level():
    """`api.log` 现在是域对象：`api.log('info', msg)` 会 `TypeError`。

    只允许 `api.log.info/warn/debug/error(...)` 这种具名 level 形态。
    """
    offenders = []
    for name, line_no, member in api_member_references():
        if member == 'log':
            offenders.append(f'{name}:{line_no} api.log(…)')
    assert offenders == [], (
        'api.log 已是域对象（api.log.info/warn/debug/error），'
        '不能再传字符串 level：\n' + '\n'.join(sorted(set(offenders)))
    )


def parse_documented_backend_members(doc: str):
    """从宿主生成的 API 文档里解析出后端契约成员。

    Returns:
        `(top_level, domain_methods, attributes)`：
        `top_level` 是 `{'on', 'emit', 'estimate_tokens'}`；
        `domain_methods` 是 `{'private.dir', 'log.info', …}`；
        `attributes` 是 `{'cards', 'tags', 'plugin_id', …}`（域属性与身份属性）。
    """
    top_level = set(re.findall(r'\| `([A-Za-z_]+)\(\)` \|', doc))
    domain_methods = set(
        f'{domain}.{method}'
        for domain, method in re.findall(r'`api\.([A-Za-z_]+)\.([A-Za-z_]+)\(\)`', doc)
    )
    # 域属性表格行：| `cards` | `CardDomain` | Stable | … |
    attributes = set(re.findall(r'\| `([A-Za-z_]+)` \| `[A-Za-z]+Domain` \|', doc))
    attributes |= set(re.findall(r'\| `(plugin_id|manifest|app_version)` \|', doc))
    return top_level, domain_methods, attributes


@requires_host
def test_documented_contract_parses():
    """反向验证：解析器本身要能拿到已知成员，否则后面的断言是空转。"""
    top_level, domain_methods, attributes = parse_documented_backend_members(read(HOST_API_DOC))
    assert {'on', 'emit', 'estimate_tokens'} <= top_level, sorted(top_level)
    assert 'private.dir' in domain_methods, sorted(domain_methods)[:20]
    assert 'log.info' in domain_methods
    assert 'http.route' in domain_methods
    assert 'cards' in attributes, sorted(attributes)
    # 扁平旧名**不应该**出现在文档里（文档是生成物，直接反映代码）
    assert 'data_dir' not in top_level
    assert 'route' not in top_level


@requires_host
def test_plugin_only_uses_documented_members():
    """★ 插件用到的每个 `api.*` 都在宿主的 API 文档里登记过。"""
    top_level, domain_methods, attributes = parse_documented_backend_members(read(HOST_API_DOC))
    known = top_level | attributes | NON_CONTRACT_ATTRIBUTES

    offenders = []
    for name, line_no, member in api_member_references():
        if member in known:
            continue
        # 两级成员必须是文档里的域方法（`private.dir`），域对象本身不算成员
        if '.' in member and member in domain_methods:
            continue
        offenders.append(f'{name}:{line_no} api.{member}')
    assert offenders == [], (
        '这些 api.* 成员在宿主 docs/plugin-api.md 里不存在：\n'
        + '\n'.join(sorted(set(offenders)))
    )


def test_register_works_against_domain_only_api(tmp_path):
    """★ 端到端钉子：`register(api)` 在**只有域形状**的 api 上必须装配成功。

    替身（`tests/fake_api.py`）刻意不实现任何扁平旧名，因此这条测试同时验证了
    「插件确实只用新契约」——回退到 `route()` / `data_dir()` / `log(level, msg)`
    会立刻在 `register()` 里失败。
    """
    import sys

    from flask import Flask

    for path in (REPO_ROOT, os.path.join(REPO_ROOT, 'tests')):
        if path not in sys.path:
            sys.path.insert(0, path)

    from fake_api import FakeApi  # noqa: E402  (测试替身就在 tests/ 下)

    import backend  # noqa: E402  (插件仓库自身)

    data_dir = tmp_path / 'data'
    api = FakeApi(data_dir=str(data_dir))
    backend.register(api)

    # ① 私有目录被真的用上了（`api.private.dir()`）：store 被建在那个目录下，
    #    且它自己写过的文件确实落在里面（`list_pets()` 期间会落盘）
    assert data_dir.is_dir()
    assert api.pet_store.data_dir == os.path.realpath(str(data_dir)), (
        f'PetStore 的数据目录应来自 api.private.dir(): {api.pet_store.data_dir}'
    )

    # ② 路由真的进了蓝图，并能被 Flask 注册、正常响应
    #    （`api.http.route()` 的装饰器链与 `register_routes()` 都跑通了）
    app = Flask(__name__)
    app.register_blueprint(api._blueprint, url_prefix='/api/plugins/stm-pet')
    rules = {rule.rule for rule in app.url_map.iter_rules()}
    assert '/api/plugins/stm-pet/pets' in rules, sorted(rules)
    assert '/api/plugins/stm-pet/runtime' in rules, sorted(rules)

    response = app.test_client().get('/api/plugins/stm-pet/pets')
    assert response.status_code == 200, response.status_code
    assert response.get_json()['success'] is True

    # ③ 日志走具名 level（`api.log.info/warn`），且带上了装配信息
    levels = {level for level, _message in api.logs}
    assert levels <= {'debug', 'info', 'warn', 'error'}, f'出现了非具名 level: {levels}'
    assert 'info' in levels, f'装配过程应当留下 info 日志: {api.logs}'
    assert any('就绪' in message for _level, message in api.logs), api.logs

    # ④ 配置走 `api.config.get()`（替身里就是构造时给的那份）
    assert api.config.get() == {}

    # ⑤ store 被挂到 api 上（前端 / CLI 共用的既有做法）
    assert api.pet_store is not None
