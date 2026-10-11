"""列出参照插件（AI 助手）与宿主已占用的入口，供新增坞入口时对照。"""

import json
import os
import re

AI = os.environ.get(
    'AI_ASSISTANT_ROOT', r'D:\Workspace\MyOwn\ST-Manager-AI-Assistant'
)
HOST = os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager')

with open(os.path.join(AI, 'manifest.json'), encoding='utf-8') as handle:
    manifest = json.load(handle)

print('=== AI 助手的 entries ===')
for entry in manifest['frontend']['entries']:
    surface = (entry.get('surface') or {}).get('id') or '-'
    print(
        f"  {entry.get('kind',''):9} {entry.get('id',''):20}"
        f" prio={str(entry.get('priority','')):5}"
        f" shortcut={entry.get('shortcut') or '-':14}"
        f" surface={surface}"
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
for entry in mine['frontend']['entries']:
    print(f"  {entry.get('kind',''):9} {entry.get('id',''):20}"
          f" shortcut={entry.get('shortcut') or '-'}")
