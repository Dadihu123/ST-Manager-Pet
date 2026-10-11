"""`manifest.json` 的入口契约。

坞入口（`kind: "dock"`）有几条**不检查就会静默失效**的规则，都在这里锁住：

1. **坞槽位有限**：`MAX_DOCK_SLOTS = 8`（全局）、`MAX_DOCK_ENTRIES_PER_PLUGIN = 2`
   （`core/plugins/entries.py:69-70`）。超了会被宿主丢掉或挤掉别人的入口。
2. **`tier` 决定默认是否进坞**：`entryRegistry.js:864`
   `isPinned()` 的默认值是 `entry.tier !== "community"` ——
   社区插件**默认进溢出菜单**，不显示在坞里。本插件在 catalog 里是 `official`，
   所以会进坞；但这条依赖 catalog，不是 manifest 能声明的。
3. **`surface` 必须指向真实注册的表面**，否则点了入口没有反应
   （`entryDock.js:274-285`：找不到 surface 就退化成派发事件，插件不监听就静默无响应）。
4. **`icon` 必须是合法的插件资源路径**，否则坞里显示占位图标。
"""

import json
import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: 宿主限制（`core/plugins/entries.py:69-70`）。
MAX_DOCK_SLOTS = 8
MAX_DOCK_ENTRIES_PER_PLUGIN = 2

#: 宿主识别的入口 kind（`core/plugins/entries.py:58-66`）。
KNOWN_KINDS = {
    'command', 'context', 'settings', 'dock', 'batch', 'status', 'nav',
}

#: 入口允许的子键（`core/plugins/entries.py:32-36`）——写错键会被严格校验拒绝。
KNOWN_ENTRY_KEYS = {
    'id', 'kind', 'label', 'description', 'icon', 'contexts',
    'requires_selection', 'surface', 'priority', 'badge', 'shortcut',
    'when', 'disabledHint',
}


@pytest.fixture(scope='module')
def manifest():
    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        return json.load(handle)


@pytest.fixture(scope='module')
def entries(manifest):
    return manifest['frontend']['entries']


def test_manifest_parses_and_has_entries(entries):
    assert entries, 'manifest 必须有至少一个前端入口'


def test_entry_keys_are_all_known(entries):
    """入口子键必须在宿主白名单内（多余键会被严格校验拒绝）。"""
    for entry in entries:
        unknown = sorted(set(entry) - KNOWN_ENTRY_KEYS)
        assert not unknown, f'入口 {entry.get("id")} 含未知子键: {unknown}'


def test_entry_kinds_are_known(entries):
    for entry in entries:
        assert entry.get('kind') in KNOWN_KINDS, (
            f'入口 {entry.get("id")} 的 kind 未知: {entry.get("kind")}'
        )


def test_entry_ids_are_unique(entries):
    ids = [entry.get('id') for entry in entries]
    assert len(ids) == len(set(ids)), f'入口 id 重复: {ids}'


# ------------------------------------------------------------------ 坞入口


def test_has_a_dock_entry(entries):
    """必须有一个坞入口（用户要求：在右侧坞里也能进）。"""
    docks = [entry for entry in entries if entry.get('kind') == 'dock']
    assert len(docks) == 1, f'应有且仅有一个 dock 入口，实际 {len(docks)} 个'


def test_dock_entry_count_within_host_limit(entries):
    """坞入口数量不得超过宿主单插件上限。"""
    docks = [entry for entry in entries if entry.get('kind') == 'dock']
    assert len(docks) <= MAX_DOCK_ENTRIES_PER_PLUGIN, (
        f'坞入口 {len(docks)} 个，超过宿主上限 {MAX_DOCK_ENTRIES_PER_PLUGIN}'
    )


def test_dock_entry_uses_plugin_icon(entries):
    """坞入口用插件自带图标（用户要求）。"""
    dock = next(entry for entry in entries if entry.get('kind') == 'dock')
    icon = dock.get('icon')
    assert icon == 'frontend/assets/icon.svg', f'坞入口图标应为插件自带图标，实际 {icon!r}'
    assert os.path.isfile(os.path.join(REPO_ROOT, icon)), f'图标文件不存在: {icon}'


def test_dock_entry_icon_path_is_a_valid_plugin_asset(entries):
    """图标路径要满足宿主 `resolvePluginIcon()` 的约束（否则坞里是占位图标）。

    `utils/icons.js` 的规则：含 `/` → 资源路径；扩展名须在
    `PLUGIN_ICON_EXTENSIONS`（`.svg` / `.png` / `.webp`）；不得绝对路径、不得 `..`。
    """
    dock = next(entry for entry in entries if entry.get('kind') == 'dock')
    value = dock['icon']
    assert '/' in value, '插件资源路径必须含 /'
    assert not value.startswith('/'), '不得是绝对路径'
    assert '..' not in value.split('/'), '不得含 ..'
    extension = value[value.rindex('.'):].lower()
    assert extension in ('.svg', '.png', '.webp'), f'扩展名 {extension} 不在图标白名单内'


def test_dock_entry_surface_matches_a_registered_surface(entries):
    """★ 坞入口的 `surface` 必须指向真实注册的表面，否则点了没反应。

    宿主 `entryDock.js:274-285` 找不到 surface 时会退化成派发事件，
    插件若不监听就**静默无响应**（不报错）。这里用源码交叉验证：
    入口声明的 surface id 必须出现在 `plugin.js` 的 `surfaces.register()` 调用里。
    """
    dock = next(entry for entry in entries if entry.get('kind') == 'dock')
    surface = (dock.get('surface') or {}).get('id')
    assert surface, '坞入口必须声明 surface.id'

    with open(os.path.join(REPO_ROOT, 'frontend', 'plugin.js'), encoding='utf-8') as handle:
        source = handle.read()
    registered = set(re.findall(r"surfaces\.register\(\s*'([^']+)'", source))
    assert registered, '解析不到 surfaces.register() 调用'
    assert surface in registered, (
        f'坞入口指向的 surface {surface!r} 未注册，实际注册了: {sorted(registered)}'
    )


def test_dock_entry_has_label_for_tooltip(entries):
    """坞槽位只显示图标，名称靠 `title`/`aria-label`——因此 label 是必需的可发现性来源。"""
    dock = next(entry for entry in entries if entry.get('kind') == 'dock')
    assert dock.get('label'), '坞入口必须有 label（否则悬浮提示与无障碍名都是空的）'
    assert dock.get('description'), '坞入口应有 description（总览页展示用）'


def test_dock_entry_priority_is_a_suggestion_in_range(entries):
    """priority 是排序建议值；给一个合理区间，避免挤到最前或最后。"""
    dock = next(entry for entry in entries if entry.get('kind') == 'dock')
    priority = dock.get('priority')
    assert isinstance(priority, int), f'priority 应为整数，实际 {priority!r}'
    assert 1 <= priority <= 99, f'priority {priority} 超出常见范围'


def test_settings_entry_still_present(entries):
    """坞入口是**新增**，不应挤掉原有的设置入口。"""
    kinds = [entry.get('kind') for entry in entries]
    assert 'settings' in kinds, '原有 settings 入口不能丢'
    assert 'dock' in kinds


def test_plugin_declares_no_permissions(manifest):
    """本插件刻意不申请权限（不读卡片/世界书/标签、不联网、不起作业）。

    坞入口不会改变这一点——若将来有人为了坞入口加了权限，这条会拦住。
    """
    permissions = manifest.get('permissions')
    assert not permissions, f'插件不应申请权限，实际: {permissions}'


def test_plugin_declares_no_jobs_or_hooks(manifest):
    """同理：坞入口是纯前端入口，不该引入后台作业或钩子。"""
    backend = manifest.get('backend') or {}
    assert not backend.get('jobs'), '不应声明后台作业'
    assert not backend.get('hooks'), '不应声明钩子'
