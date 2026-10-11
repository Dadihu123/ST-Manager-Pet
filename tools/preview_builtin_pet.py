"""把内置形象的 spritesheet 放大拼成一张对照图，便于人眼核对各动作。

构建/核对工具，不参与运行。
"""

import os
import sys

from PIL import Image, ImageDraw

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PET_DIR = os.path.join(REPO_ROOT, 'resources', 'pets', 'default-cat')
SCALE = 3
LABEL_H = 16
PAD = 8


def main():
    names = sorted(
        name for name in os.listdir(PET_DIR) if name.endswith('.png')
    )
    if not names:
        print('没有找到 png——先运行 tools/make_builtin_pets.py')
        return 1

    tiles = []
    for name in names:
        image = Image.open(os.path.join(PET_DIR, name)).convert('RGBA')
        frames = image.width // 64
        scaled = image.resize((image.width * SCALE, image.height * SCALE), Image.NEAREST)
        tiles.append((f'{name}  {frames}f', scaled))

    width = max(tile.width for _label, tile in tiles) + PAD * 2
    height = sum(tile.height + LABEL_H + PAD for _label, tile in tiles) + PAD
    canvas = Image.new('RGBA', (width, height), (250, 248, 245, 255))
    draw = ImageDraw.Draw(canvas)

    y = PAD
    for label, tile in tiles:
        draw.text((PAD, y), label, fill=(60, 50, 45, 255))
        y += LABEL_H
        canvas.paste(tile, (PAD, y), tile)
        y += tile.height + PAD

    target = os.path.join(REPO_ROOT, 'artifacts', 'builtin-pet-preview.png')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    canvas.save(target)
    print(f'已写出对照图: {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
