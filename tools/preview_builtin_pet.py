"""把内置形象的 spritesheet 放大拼成一张对照图，便于人眼核对各动作。

构建/核对工具，不参与运行。

用法：
    python tools/preview_builtin_pet.py                # 默认形象（小满）
    python tools/preview_builtin_pet.py xiaoka         # 指定形象
    python tools/preview_builtin_pet.py xiaoka --scale 1

单帧尺寸与帧数**从 `pet.json` 读**，不写死：内置形象里有 64×64 的程序化形象、
也有 384×576 的真人立绘，写死尺寸会把后者切错。
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PETS_ROOT = os.path.join(REPO_ROOT, 'resources', 'pets')

#: 默认预览的形象（与 `backend/core/store.py:DEFAULT_PET_ID` 一致）。
DEFAULT_PET_ID = 'xiaoman'

LABEL_H = 16
PAD = 8


def read_pack(pet_dir: str) -> dict:
    with open(os.path.join(pet_dir, 'pet.json'), 'r', encoding='utf-8') as handle:
        return json.load(handle)


def main():
    parser = argparse.ArgumentParser(description='把内置形象的各动作拼成对照图')
    parser.add_argument('pet_id', nargs='?', default=DEFAULT_PET_ID,
                        help=f'形象 id（默认 {DEFAULT_PET_ID}）')
    parser.add_argument('--scale', type=int, default=0,
                        help='放大倍数；默认自动（让单帧高度接近 240px）')
    parser.add_argument('--out', default='', help='输出路径；默认 artifacts/ 下')
    args = parser.parse_args()

    pet_dir = os.path.join(PETS_ROOT, args.pet_id)
    if not os.path.isfile(os.path.join(pet_dir, 'pet.json')):
        print(f'找不到形象：{pet_dir}')
        return 1

    manifest = read_pack(pet_dir)
    frame_w = int(manifest.get('size', {}).get('w') or 64)
    frame_h = int(manifest.get('size', {}).get('h') or 64)
    animations = manifest.get('animations') or {}

    # 自动倍数：让单帧高度落在 240px 附近，这样 64px 的小猫与 576px 的立绘
    # 都能得到可看的对照图（写死 3× 会把立绘放大到 1728px 高，纯浪费）。
    scale = args.scale or max(1, round(240 / max(1, frame_h)))
    resample = Image.NEAREST if scale > 2 else Image.LANCZOS

    tiles = []
    for action in sorted(animations):
        spec = animations[action]
        if isinstance(spec, str):
            spec = {'sheet': spec}
        sheet_name = str(spec.get('sheet') or '')
        if not sheet_name:
            continue
        path = os.path.join(pet_dir, sheet_name.replace('/', os.sep))
        if not os.path.isfile(path):
            continue
        image = Image.open(path).convert('RGBA')
        frames = max(1, image.width // frame_w)
        scaled = image.resize((image.width * scale, image.height * scale), resample)
        label = f'{action}  {sheet_name}  {frames}f'
        tiles.append((label, scaled))

    if not tiles:
        print(f'{args.pet_id} 下没有可预览的 png')
        return 1

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

    target = args.out or os.path.join(
        REPO_ROOT, 'artifacts', f'builtin-{args.pet_id}-preview.png',
    )
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    canvas.save(target)
    print(f'已写出对照图: {target}  （{len(tiles)} 个动作，{scale}× 放大）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
