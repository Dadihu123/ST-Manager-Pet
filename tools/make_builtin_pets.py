"""生成随包默认宠物形象（`resources/pets/`）。

为什么用脚本而不是手工放图：默认形象需要**真实的多帧 spritesheet**，
而手绘 PNG 不好在版本库里维护/调整。这里用 Pillow 画一只简洁的猫，
把动作、帧数、fps 全部对齐 `pet.json` 的声明。

它是**构建期工具**，产物提交进仓库；运行时不需要 Pillow 来生成形象。

用法：
    python tools/make_builtin_pets.py            # 写到 resources/pets/
"""

import json
import os
import sys

from PIL import Image, ImageDraw

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_ROOT = os.path.join(REPO_ROOT, 'resources', 'pets')

FRAME_W, FRAME_H = 64, 64

# 版面：所有动作共用同一套基准，保证竖向偏移（呼吸/跳动/落地压扁）不会顶出画框。
# 第一版把猫画得太大，`happy` 的 -3px 抬起直接把头和耳朵切掉（对照图里能看出来）。
BASE_BOTTOM = 54      # 脚底基准线（留 10px 给落地压扁与阴影）
BODY_H = 24           # 身体高度
HEAD_GAP = 7          # 身体顶部到头心的距离

# 配色（与宿主主题无关的固定色；宠物是插画，不是 UI 元素）
FUR = (247, 168, 76, 255)
FUR_DARK = (214, 133, 44, 255)
BELLY = (255, 233, 199, 255)
INK = (58, 42, 32, 255)
EYE = (38, 30, 26, 255)
NOSE = (232, 118, 130, 255)
PINK = (255, 190, 200, 255)
ZZZ = (150, 160, 190, 255)
WHISKER = (120, 96, 78, 255)


def _draw_cat(
    draw: ImageDraw.ImageDraw,
    ox: int,
    oy: int,
    *,
    body_dy: int = 0,
    squash: float = 1.0,
    eyes: str = 'open',
    tail: float = 0.0,
    ear_dy: int = 0,
    lying: bool = False,
) -> None:
    """在 (ox, oy) 处的 64×64 格子里画一只猫。

    参数化出各动作的差异，避免每个动作写一遍绘制代码（也保证风格一致）。

    版面按「脚底基准线 + 身体 + 头」自下而上推算，所有竖直偏移都留了余量，
    因此 `body_dy=-3`（跳跃抬起）或落地压扁都不会把耳朵切出画框。
    """
    cx = ox + FRAME_W // 2

    if lying:
        # 睡姿：横躺的椭圆 + 收起的尾巴
        draw.ellipse([ox + 8, oy + 40, ox + 52, oy + 54],
                     fill=FUR, outline=FUR_DARK, width=2)
        # 尾巴绕到身前
        draw.arc([ox + 34, oy + 38, ox + 56, oy + 54], start=300, end=90,
                 fill=FUR_DARK, width=4)
        head_center = (ox + 20, oy + 40)
        tail_x = ox + 52
    else:
        body_h = max(6, int(BODY_H * squash))
        body_bottom = oy + BASE_BOTTOM + body_dy
        body_top = body_bottom - body_h

        # 尾巴（在身体后面，从臀部往右上甩）
        tail_x = cx + 12
        tail_tip_y = body_top - 4 - int(tail * 10)
        draw.line([(tail_x, body_bottom - 6), (tail_x + 5, tail_tip_y)],
                  fill=FUR_DARK, width=4)
        draw.ellipse([tail_x + 1, tail_tip_y - 3, tail_x + 8, tail_tip_y + 4],
                     fill=FUR, outline=FUR_DARK, width=1)

        # 身体
        draw.ellipse([cx - 13, body_top, cx + 13, body_bottom],
                     fill=FUR, outline=FUR_DARK, width=2)
        draw.ellipse([cx - 8, body_top + 5, cx + 8, body_bottom - 3], fill=BELLY)

        head_center = (cx, body_top - HEAD_GAP)

    hx, hy = head_center
    ear_lift = ear_dy
    ear_tip_y = hy - 15 + ear_lift
    if ear_tip_y < oy + 1:
        # 保险：耳朵不许顶出画框（这里悄悄上移的只是耳朵，不会暴露到画外）
        ear_lift += (oy + 1) - ear_tip_y

    # 耳朵
    for sign in (-1, 1):
        ex = hx + sign * 9
        draw.polygon(
            [(ex - 5, hy - 4 + ear_lift), (ex + 5, hy - 4 + ear_lift),
             (ex, hy - 14 + ear_lift)],
            fill=FUR, outline=FUR_DARK,
        )
        draw.polygon(
            [(ex - 2, hy - 6 + ear_lift), (ex + 2, hy - 6 + ear_lift),
             (ex, hy - 11 + ear_lift)],
            fill=PINK,
        )

    # 头
    draw.ellipse([hx - 12, hy - 11, hx + 12, hy + 11], fill=FUR, outline=FUR_DARK, width=2)
    draw.ellipse([hx - 8, hy - 3, hx + 8, hy + 9], fill=BELLY)

    # 眼睛
    if lying or eyes == 'closed':
        for sign in (-1, 1):
            ex = hx + sign * 5
            draw.arc([ex - 3, hy - 5, ex + 3, hy + 1], start=200, end=340, fill=EYE, width=2)
    elif eyes == 'happy':
        for sign in (-1, 1):
            ex = hx + sign * 5
            draw.arc([ex - 3, hy - 6, ex + 3, hy], start=200, end=340, fill=EYE, width=2)
    elif eyes == 'wide':
        for sign in (-1, 1):
            ex = hx + sign * 5
            draw.ellipse([ex - 3, hy - 5, ex + 3, hy + 1], fill=EYE)
            draw.ellipse([ex - 1, hy - 4, ex + 1, hy - 2], fill=(255, 255, 255, 255))
    else:
        for sign in (-1, 1):
            ex = hx + sign * 5
            draw.ellipse([ex - 2, hy - 4, ex + 2, hy], fill=EYE)
            draw.ellipse([ex - 1, hy - 3, ex + 1, hy - 1], fill=(255, 255, 255, 255))

    # 鼻子与嘴
    draw.polygon([(hx - 2, hy + 3), (hx + 2, hy + 3), (hx, hy + 5)], fill=NOSE)
    draw.arc([hx - 4, hy + 4, hx, hy + 8], start=0, end=140, fill=INK, width=1)
    draw.arc([hx, hy + 4, hx + 4, hy + 8], start=40, end=180, fill=INK, width=1)

    # 胡须（用比描边浅一点的颜色，免得抢眼睛）
    for sign in (-1, 1):
        for offset in (-2, 2):
            draw.line(
                [(hx + sign * 9, hy + 4 + offset),
                 (hx + sign * 16, hy + 3 + offset * 1.6)],
                fill=WHISKER, width=1,
            )

    # 前爪
    if lying:
        draw.ellipse([ox + 28, oy + 46, ox + 38, oy + 54],
                     fill=BELLY, outline=FUR_DARK, width=1)
    else:
        paw_y = oy + BASE_BOTTOM + body_dy
        for sign in (-1, 1):
            px = cx + sign * 7
            draw.ellipse([px - 4, paw_y - 5, px + 4, paw_y + 1],
                         fill=BELLY, outline=FUR_DARK, width=1)


def _sheet(frames: int, renderer) -> Image.Image:
    """把 `renderer(index)` 画出的每一帧拼成水平 spritesheet。"""
    image = Image.new('RGBA', (FRAME_W * frames, FRAME_H), (0, 0, 0, 0))
    for index in range(frames):
        tile = Image.new('RGBA', (FRAME_W, FRAME_H), (0, 0, 0, 0))
        renderer(ImageDraw.Draw(tile), index)
        image.paste(tile, (index * FRAME_W, 0), tile)
    return image


def build_idle(frames=4):
    def render(draw, index):
        # 呼吸：身体轻微上下 + 耳朵抖动错相
        body_dy = (0, -1, 0, 1)[index % 4]
        _draw_cat(draw, 0, 0, body_dy=body_dy, tail=(0, 0.4, 0.8, 0.4)[index % 4])

    return _sheet(frames, render)


def build_walk(frames=6):
    def render(draw, index):
        # 走动：整体上下起伏 + 尾巴摆动
        _draw_cat(draw, 0, 0, body_dy=(-1 if index % 3 == 1 else 0),
                  squash=1.0 + (0.03 if index % 3 == 0 else 0),
                  tail=(index / frames))

    return _sheet(frames, render)


def build_fall(frames=2):
    def render(draw, index):
        # 下落：耳朵向后、眼睛睁大、尾巴上扬
        _draw_cat(draw, 0, 0, body_dy=0, eyes='wide',
                  ear_dy=-1 if index == 0 else 0, tail=1.0)

    return _sheet(frames, render)


def build_drag(frames=2):
    def render(draw, index):
        # 被拎起来：眼睛睁大、身体轻微摆动
        _draw_cat(draw, 0, 0, body_dy=-1 if index == 0 else 0, eyes='wide', tail=0.8)

    return _sheet(frames, render)


def build_land(frames=3):
    def render(draw, index):
        # 落地：先压扁再回弹
        squash = (0.82, 1.06, 1.0)[index]
        _draw_cat(draw, 0, 0, squash=squash, body_dy=(2, -1, 0)[index], tail=0.2)

    return _sheet(frames, render)


def build_sleep(frames=4):
    def render(draw, index):
        _draw_cat(draw, 0, 0, lying=True, eyes='closed')
        # 呼噜的 Z：随帧上浮并变淡（放在右上角空处，不压到猫身上）
        step = index % 4
        if step < 3:
            size = 4 + step
            alpha = 255 - step * 60
            top = 30 - step * 5
            left = 44
            color = ZZZ[:3] + (alpha,)
            draw.line([(left, top), (left + size, top)], fill=color, width=1)
            draw.line([(left + size, top), (left, top + size)], fill=color, width=1)
            draw.line([(left, top + size), (left + size, top + size)], fill=color, width=1)

    return _sheet(frames, render)


def build_happy(frames=4):
    def render(draw, index):
        # 开心：跳一下 + 眯眼
        _draw_cat(draw, 0, 0, body_dy=(-3, -1, 1, 0)[index % 4],
                  eyes='happy', tail=0.6, ear_dy=-1)

    return _sheet(frames, render)


def build_sad(frames=3):
    def render(draw, index):
        _draw_cat(draw, 0, 0, body_dy=(1, 2, 1)[index], eyes='closed', tail=0.0)

    return _sheet(frames, render)


#: 默认形象定义：动作名 → (生成函数, 帧数, fps, loop)
BUILDERS = {
    'idle': (build_idle, 4, 6, True),
    'walk': (build_walk, 6, 10, True),
    'fall': (build_fall, 2, 8, True),
    'drag': (build_drag, 2, 4, True),
    'land': (build_land, 3, 12, False),
    'sleep': (build_sleep, 4, 3, True),
    'happy': (build_happy, 4, 8, False),
    'sad': (build_sad, 3, 5, True),
    'look': (build_idle, 4, 6, True),
}

PET_ID = 'default-cat'
PET_NAME = '默认小猫'


def build_pet(pet_id=PET_ID, name=PET_NAME):
    """生成一个完整的内置形象包，返回包目录。"""
    pack_dir = os.path.join(OUTPUT_ROOT, pet_id)
    os.makedirs(pack_dir, exist_ok=True)

    animations = {}
    for action, (builder, frames, fps, loop) in BUILDERS.items():
        sheet = builder(frames)
        filename = f'{action}.png'
        sheet.save(os.path.join(pack_dir, filename), format='PNG', optimize=True)
        animations[action] = {'sheet': filename, 'frames': frames, 'fps': fps, 'loop': loop}

    manifest = {
        'format': 1,
        'id': pet_id,
        'name': name,
        'author': 'ST-Manager',
        'size': {'w': FRAME_W, 'h': FRAME_H},
        'anchor': {'x': 0.5, 'y': 1.0},
        'physics': {
            'gravity': 1800,
            'walkSpeed': 60,
            'friction': 0.02,
            'terminalVelocity': 2400,
            'bounce': 0.15,
        },
        'animations': animations,
    }

    manifest_path = os.path.join(pack_dir, 'pet.json')
    with open(manifest_path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write('\n')

    return pack_dir, manifest


def main():
    pack_dir, manifest = build_pet()
    print(f'已生成内置形象: {pack_dir}')
    for action, spec in manifest['animations'].items():
        path = os.path.join(pack_dir, spec['sheet'])
        size = os.path.getsize(path)
        print(f'  {action:<6} {spec["frames"]} 帧 @ {spec["fps"]}fps  '
              f'{spec["sheet"]}  {size // 1024} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
