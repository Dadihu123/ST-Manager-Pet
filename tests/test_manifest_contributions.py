"""`manifest.json` 的贡献契约（v3）。

v3 把入口声明从 `frontend.entries[]` 换成 `frontend.contributions.{menus,slots,commands}`：

1. **结构**：两个菜单节点（`dock` + `settings.nav`）的根节点必须带 `placement`，
   子节点（本插件没有）不得声明；`id` 插件内唯一。
2. **容量**：dock 全局 8 槽位、单插件最多 2 个；本插件只占 1 个，留出余量。
3. **引用**：`action.surface` 的 id 必须在 `frontend/plugin.js` 里真实注册过，
   否则点击入口没有反应（宿主只会警告并忽略）。
4. **图标**：菜单节点 `icon` 用插件内相对资源路径，文件必须存在。
5. **自绘披露**：本插件注册常驻 `ambient` surface（宠物本体是自绘的），
   因此 `render_mode: "custom"` + `capabilities` 含 `ui.custom`。
6. 契约细节（未知键、落点枚举、`when` 求值等）由主程序 `stm-plugin-check` 做严格
   校验，插件仓库不再复刻宿主白名单（v2 时期的三份复刻已按设计文档附录 B 删除）。
"""

import json
import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: v1 落点清单（`core/plugins/contract.py::MENU_PLACEMENTS`）。
KNOWN_PLACEMENTS = {
    'context.folder', 'context.card', 'context.footer', 'batch.actions',
    'commandPalette', 'dock', 'settings.nav',
}
#: 宿主容量：dock 全局 8、单插件 2（`core/plugins/contract.py`）。
MAX_DOCK_PER_PLUGIN = 2
#: 菜单节点 id 正则。
NODE_ID_PATTERN = re.compile(r'^[a-z][a-z0-9-]{0,63}$')


@pytest.fixture(scope='module')
def manifest():
    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        return json.load(handle)


@pytest.fixture(scope='module')
def frontend(manifest):
    return manifest['frontend']


@pytest.fixture(scope='module')
def contributions(frontend):
    return frontend.get('contributions') or {}


@pytest.fixture(scope='module')
def menus(contributions):
    return contributions.get('menus') or []


@pytest.fixture(scope='module')
def plugin_source():
    with open(os.path.join(REPO_ROOT, 'frontend', 'plugin.js'), encoding='utf-8') as handle:
        return handle.read()


def _iter_nodes(nodes):
    """深度优先遍历菜单节点（含 children）。"""
    for node in nodes or []:
        yield node
        yield from _iter_nodes(node.get('children') or [])


# ------------------------------------------------------------------ 版本与结构


def test_manifest_is_v3(manifest):
    """v3 宿主只接受 `api_version: 3` / `manifest_version: 3`（不保留 v2 兼容）。"""
    assert manifest['api_version'] == 3
    assert manifest['manifest_version'] == 3


def test_legacy_entry_and_permission_keys_are_gone(manifest, frontend):
    """`frontend.entries[]` 与 `permissions` 在 v3 已删除且不保留别名。"""
    assert 'entries' not in frontend
    assert 'permissions' not in manifest
    for legacy in ('panels', 'settings_tab', 'detail_tab'):
        assert legacy not in frontend, legacy
    assert set(frontend) <= {
        'entry', 'styles', 'global_styles', 'render_mode', 'contributions',
    }


def test_contributions_has_only_known_children(contributions):
    assert set(contributions) <= {'menus', 'slots', 'commands'}


def test_no_global_styles(manifest, frontend):
    """本插件不注入全局样式（想改全局必须走 `global_styles` + `ui.global_styles`）。"""
    assert not (frontend.get('global_styles') or [])
    assert 'ui.global_styles' not in (manifest.get('capabilities') or [])


# ------------------------------------------------------------------ 节点结构


def test_menus_declared(menus):
    assert menus, 'frontend.contributions.menus 不能为空'


def test_menu_ids_are_unique(menus):
    ids = [node.get('id') for node in _iter_nodes(menus)]
    assert len(ids) == len(set(ids)), f'菜单节点 id 重复: {ids}'
    for node_id in ids:
        assert NODE_ID_PATTERN.match(str(node_id or '')), node_id


def test_root_placements_are_known_and_children_do_not_declare_them(menus):
    for node in menus:
        assert node.get('placement') in KNOWN_PLACEMENTS, node.get('placement')
        for child in node.get('children') or []:
            assert 'placement' not in child, (
                f'子节点 {child.get("id")} 不得声明 placement（落点由根节点决定）'
            )


def test_every_node_has_a_type_and_items_have_actions(menus):
    for node in _iter_nodes(menus):
        node_type = node.get('type')
        assert node_type in {'item', 'submenu', 'separator'}, node.get('id')
        if node_type == 'item':
            assert isinstance(node.get('action'), dict), node.get('id')
            assert node['action'].get('type') in {'surface', 'command', 'url'}
        if node_type == 'submenu':
            assert node.get('children'), f'submenu {node.get("id")} 缺少 children'


# ------------------------------------------------------------------ dock 入口


def test_has_exactly_one_dock_entry(menus):
    """必须有一个坞入口（用户要求：在坞里也能进），且不超过单插件上限。"""
    docks = [node for node in menus if node.get('placement') == 'dock']
    assert len(docks) == 1, f'应有且仅有一个 dock 入口，实际 {len(docks)} 个'
    assert len(docks) <= MAX_DOCK_PER_PLUGIN


def test_dock_entry_uses_plugin_icon(menus):
    """坞入口用插件自带图标（用户要求）。"""
    dock = next(node for node in menus if node.get('placement') == 'dock')
    icon = dock.get('icon')
    assert icon == 'frontend/assets/icon.svg', f'坞入口图标应为插件自带图标，实际 {icon!r}'
    assert os.path.isfile(os.path.join(REPO_ROOT, icon)), f'图标文件不存在: {icon}'


def test_dock_entry_icon_path_is_a_valid_plugin_asset(menus):
    """图标路径要满足宿主 `resolvePluginIcon()` 的约束（否则坞里是占位图标）。

    `utils/icons.js` 的规则：含 `/` → 资源路径；扩展名须在
    `PLUGIN_ICON_EXTENSIONS`（`.svg` / `.png` / `.webp`）；不得绝对路径、不得 `..`。
    """
    dock = next(node for node in menus if node.get('placement') == 'dock')
    value = dock['icon']
    assert '/' in value, '插件资源路径必须含 /'
    assert not value.startswith('/'), '不得是绝对路径'
    assert '..' not in value.split('/'), '不得含 ..'
    extension = value[value.rindex('.'):].lower()
    assert extension in ('.svg', '.png', '.webp'), f'扩展名 {extension} 不在图标白名单内'


def test_dock_entry_surface_matches_a_registered_surface(menus, plugin_source):
    """★ 坞入口的 `action.surface.id` 必须指向真实注册的表面，否则点了没反应。

    宿主 v3 触发链路对未注册 surface 只警告并忽略；插件侧用源码交叉验证：
    声明里的 surface id 必须出现在 `api.surfaces.register()` 调用里。
    """
    dock = next(node for node in menus if node.get('placement') == 'dock')
    action = dock.get('action') or {}
    assert action.get('type') == 'surface', '坞入口应打开插件自己的 surface'
    surface = action.get('id')
    assert surface, '坞入口必须声明 action.surface.id'

    registered = set(re.findall(r"surfaces\.register\(\s*'([^']+)'", plugin_source))
    assert registered, '解析不到 surfaces.register() 调用'
    assert surface in registered, (
        f'坞入口指向的 surface {surface!r} 未注册，实际注册了: {sorted(registered)}'
    )


def test_dock_entry_has_label_and_description(menus):
    """坞槽位只显示图标，名称靠 `label`/`description`——因此两者都是必需的可发现性来源。"""
    dock = next(node for node in menus if node.get('placement') == 'dock')
    assert dock.get('label'), '坞入口必须有 label（否则悬浮提示与无障碍名都是空的）'
    assert dock.get('description'), '坞入口应有 description（总览页展示用）'


def test_dock_entry_order_is_a_suggestion_in_range(menus):
    """order 是排序建议值；给一个合理区间，避免挤到最前或最后。"""
    dock = next(node for node in menus if node.get('placement') == 'dock')
    order = dock.get('order')
    assert isinstance(order, int), f'order 应为整数，实际 {order!r}'
    assert 1 <= order <= 99, f'order {order} 超出常见范围'


# ------------------------------------------------------------------ 设置入口


def test_settings_nav_entry_still_present(menus):
    """坞入口是**新增**，不应挤掉原有的设置入口。"""
    settings = [node for node in menus if node.get('placement') == 'settings.nav']
    assert len(settings) == 1, f'应有且仅有一个 settings.nav 入口，实际 {len(settings)} 个'
    entry = settings[0]
    assert entry.get('type') == 'item'
    assert entry.get('label')
    assert (entry.get('action') or {}).get('type') == 'surface'


def test_settings_entry_opens_the_same_pet_settings_surface(menus, plugin_source):
    """坞与设置导航都打开同一个 `pet-settings` surface（一处注册、两处入口）。"""
    settings = next(node for node in menus if node.get('placement') == 'settings.nav')
    surface = (settings.get('action') or {}).get('id')
    registered = set(re.findall(r"surfaces\.register\(\s*'([^']+)'", plugin_source))
    assert surface in registered, (
        f'设置入口指向的 surface {surface!r} 未注册，实际注册了: {sorted(registered)}'
    )


# ------------------------------------------------------------------ 自绘披露


def test_render_mode_declares_custom_ui(manifest, frontend):
    """常驻宠物是插件自绘的界面 → `render_mode: "custom"` 且披露 `ui.custom`。"""
    assert frontend.get('render_mode') == 'custom'
    capabilities = manifest.get('capabilities') or []
    assert 'ui.custom' in capabilities


def test_capability_disclosure_is_minimal(manifest):
    """本插件刻意不申请数据/运行时能力（不读卡片/世界书/标签、不联网、不起作业）。"""
    capabilities = set(manifest.get('capabilities') or [])
    assert capabilities <= {'ui.custom', 'ui.global_styles'}, sorted(capabilities)
    assert 'ui.global_styles' not in capabilities


def test_plugin_declares_no_jobs_or_hooks(manifest):
    """同理：纯前端插件，不该引入后台作业或钩子。"""
    backend = manifest.get('backend') or {}
    assert not backend.get('jobs'), '不应声明后台作业'
    assert not backend.get('hooks'), '不应声明钩子'


# ------------------------------------------------------------------ 模块引用


def test_declared_modules_exist(contributions):
    """slots/commands 的 `module` 必须是插件内相对路径且文件存在。

    v3 中菜单节点本身不引用模块（`action` 只引用 command/surface/url）；
    `command` 引用还必须在 `contributions.commands` 中声明。
    """
    command_ids = {item.get('id') for item in contributions.get('commands') or []}
    for slot in contributions.get('slots') or []:
        module = str(slot.get('module') or '')
        assert os.path.isfile(os.path.join(REPO_ROOT, module)), module
    for command in contributions.get('commands') or []:
        module = str(command.get('module') or '')
        assert os.path.isfile(os.path.join(REPO_ROOT, module)), module

    for node in _iter_nodes(contributions.get('menus') or []):
        action = node.get('action') or {}
        if action.get('type') == 'command':
            assert action.get('id') in command_ids, (
                f'菜单节点 {node.get("id")} 引用了未声明的命令: {action.get("id")}'
            )
