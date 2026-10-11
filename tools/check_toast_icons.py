"""实证：`api.toast` 的图标参数到底接受什么、拒绝什么、怎么拒绝的。

要回答三个具体问题（都用真实宿主代码/页面验证，不做推测）：

1. 插件自带图标路径（`frontend/assets/icon.svg`）会被接受吗？
2. **宿主自己的图标名**（非白名单内的）会被接受吗？比如 `heart`、`wand`。
3. 被拒时是**报错**还是**静默忽略**？
"""

import os
import re
import sys

#: 宿主仓库位置；换机器时用 `HOST_ROOT` 环境变量覆盖。
HOST = os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager')
if not os.path.isdir(HOST):
    raise SystemExit(f'找不到宿主仓库: {HOST}\n请设置环境变量 HOST_ROOT 指向 ST-Manager 仓库根目录。')
sys.path.insert(0, HOST)

# ---- 1. 直接读宿主源码，确认判定逻辑


def read(path):
    with open(path, encoding='utf-8') as handle:
        return handle.read()


state_src = read(HOST + r'\static\js\state.js')
layout_src = read(HOST + r'\templates\layout.html')

# 白名单
block = state_src[state_src.index('const TOAST_ICON_NAMES'):]
block = block[: block.index(']);')]
whitelist = set(re.findall(r'"([a-z0-9-]+)"', block))
sprites_block = state_src[
    state_src.index('const TOAST_ICON_SPRITES'):state_src.index('const TOAST_ICON_NAMES')
]
whitelist |= set(re.findall(r'"([a-z0-9-]+)"', sprites_block))

# 宿主图标库（190 个）
icon_map = read(HOST + r'\static\js\utils\iconMap.js')
host_count = int(re.search(r'HOST_ICON_COUNT\s*=\s*(\d+)', icon_map).group(1))
# ICON_SPRITE_MAP 的键就是全部宿主图标名
map_block = icon_map[icon_map.index('ICON_SPRITE_MAP'):]
host_names = set(re.findall(r'^\s*"([a-z0-9-]+)"\s*:', map_block, re.MULTILINE))

print('=' * 72)
print('toast 图标的判定逻辑')
print('=' * 72)
print('showToast 里的判定：')
for line in state_src.splitlines():
    if 'TOAST_ICON_NAMES.has' in line or 'toastIcon = hasIcon' in line:
        print('   ', line.strip())

print('\n渲染处（templates/layout.html）：')
for line in layout_src.splitlines():
    if 'toastIconHref' in line:
        print('   ', line.strip())

print('\n' + '=' * 72)
print('规模对比')
print('=' * 72)
print(f'宿主图标库总数 (iconMap)     : {host_count}')
print(f'解析出的宿主图标名           : {len(host_names)}')
print(f'toast 白名单条目             : {len(whitelist)}')

# 白名单里有多少本身就是宿主图标
in_library = sorted(whitelist & host_names)
print(f'白名单 ∩ 宿主图标库          : {len(in_library)} → {in_library}')

# 宿主图标里有多少被 toast 接受
print(f'宿主图标被 toast 接受的比例   : {len(in_library)}/{len(host_names)} '
      f'= {len(in_library) / max(1, len(host_names)) * 100:.1f}%')

# ---- 3. 具体举例
print('\n' + '=' * 72)
print('具体判定')
print('=' * 72)
cases = [
    ('settings-help-entry', '白名单内的宿主图标（当前插件用的）'),
    ('heart', '真实宿主图标，但不在白名单'),
    ('wand', '真实宿主图标，但不在白名单'),
    ('frontend/assets/icon.svg', '插件自带图标路径'),
    ('/api/plugins/stm-pet/assets/frontend/assets/icon.svg', '插件资产的绝对 URL'),
    ('trash', '白名单内的宿主图标'),
]
for value, note in cases:
    accepted = value in whitelist
    # 复现 showToast 的判定
    normalized = value.strip()
    has_icon = normalized in whitelist
    print(f'  {"接受" if has_icon else "丢弃"}  {value!r:<58} ({note})')

print('\n' + '=' * 72)
print('结论')
print('=' * 72)
print('· `api.toast` 的图标位**只接受 17 个写死的名字**，且渲染时硬拼 `/static/icons/` 前缀。')
print('· 插件自带图标**无法**用于 toast（路径含 `/`，永远不在 Set 里）。')
print(f'· 连宿主自己的图标也有 {len(host_names) - len(in_library)}/{len(host_names)} 个用不了。')
print('· 被拒时 `toastIcon` 被置空，**不报错、不警告** —— 静默失效。')
