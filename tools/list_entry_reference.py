"""列出参照插件（AI 助手）与宿主已占用的入口，供新增坞入口时对照。

v3 契约：入口来自 `frontend.contributions.menus`（扁平根节点 + `children` 递归），
宿主位置由根节点的 `placement` 决定；命令处理器在 `contributions.commands`。
本脚本只读 manifest，不依赖主程序仓库。
"""

import json
import os
import re

AI = os.environ.get(
    'AI_ASSISTANT_ROOT', r'D:\Workspace\MyOwn\ST-Manager-AI-Assistant'
)
HOST = os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager')


def iter_menu_nodes(nodes, depth=0, placement=''):
    """深度优先遍历菜单节点，携带根节点的 placement 与缩进深度。"""
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        current = placement or str(node.get('placement') or '')
        yield depth, current, node
        yield from iter_menu_nodes(node.get('children') or [], depth + 1, current)


def contributions(manifest):
    return (manifest.get('frontend') or {}).get('contributions') or {}


with open(os.path.join(AI, 'manifest.json'), encoding='utf-8') as handle:
    manifest = json.load(handle)

print('=== AI 助手的菜单节点（v3 contributions.menus） ===')
for depth, placement, node in iter_menu_nodes(contributions(manifest).get('menus')):
    action = node.get('action') or {}
    action_text = '-'
    if action:
        action_text = f"{action.get('type')}:{action.get('id') or action.get('url')}"
    indent = '  ' * depth
    print(
        f"  {indent}{node.get('id', ''):20}"
        f" placement={placement:18}"
        f" type={node.get('type', ''):9}"
        f" order={str(node.get('order', '')):4}"
        f" action={action_text}"
    )

print('\n=== AI 助手的命令（v3 contributions.commands） ===')
for command in contributions(manifest).get('commands') or []:
    print(
        f"  {command.get('id', ''):20}"
        f" shortcut={command.get('shortcut') or '-':14}"
        f" title={command.get('title', '')}"
    )

print('\n=== 宿主 / 插件里出现过的快捷键 ===')
pattern = re.compile(r'Ctrl\+Shift\+([A-Za-z])')
found = {}
for root, dirs, files in os.walk(HOST):
    dirs[:] = [
        d for d in dirs
        if d not in {'__pycache__', 'node_modules', '.git', 'data', 'tmp', 'artifacts'}
    ]
    for name in files:
        if not name.endswith(('.js', '.py', '.json', '.html', '.md')):
            continue
        path = os.path.join(root, name)
        try:
            with open(path, encoding='utf-8', errors='ignore') as handle:
                text = handle.read()
        except OSError:
            continue
        for match in pattern.finditer(text):
            key = f'Ctrl+Shift+{match.group(1).upper()}'
            found.setdefault(key, set()).add(os.path.relpath(path, HOST))

for key in sorted(found):
    places = sorted(found[key])[:3]
    print(f'  {key:16} → {", ".join(places)}')

print('\n=== 我方插件当前占用的 ===')
with open(
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'manifest.json'),
    encoding='utf-8',
) as handle:
    mine = json.load(handle)

for depth, placement, node in iter_menu_nodes(contributions(mine).get('menus')):
    indent = '  ' * depth
    print(f"  {indent}{node.get('id', ''):20} placement={placement:18} type={node.get('type', '')}")
for command in contributions(mine).get('commands') or []:
    print(f"  {command.get('id', ''):20} shortcut={command.get('shortcut') or '-'}")
