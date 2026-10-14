"""建「纯色帧」测试形象，用于验收切帧是否露出邻帧。

每帧一个纯色（帧0 红 / 帧1 绿 / 帧2 蓝 / 帧3 黄）：

- 帧 1（绿）的 R、B 通道恒为 0，因此绿帧窗口里出现红/蓝 = 邻帧混入；
- 这是**与混合比例无关**的判据，连半像素混色也能测出来
  （50% 红 + 50% 绿 = (127,127,0)，R 被抬起来了）。

为什么要专门造这个：真实形象里帧与帧的图案相似，很难用像素判定
「这一块到底是本帧的还是邻帧的」；纯色帧让判定变成无歧义的事。

用法：
    python tools/make-solid-pet.py <插件 data/pets 目录> [vertical|horizontal] [宽] [高]
"""
import json
import os
import sys

from PIL import Image

FRAMES = 4
COLORS = [
    (255, 0, 0, 255),
    (0, 255, 0, 255),
    (0, 0, 255, 255),
    (255, 255, 0, 255),
]


def build_sheet(path, layout, frame_w, frame_h):
    if layout == 'vertical':
        sheet_size = (frame_w, frame_h * FRAMES)
    else:
        sheet_size = (frame_w * FRAMES, frame_h)
    image = Image.new('RGBA', sheet_size, (0, 0, 0, 0))
    for index in range(FRAMES):
        left = 0 if layout == 'vertical' else index * frame_w
        top = index * frame_h if layout == 'vertical' else 0
        image.paste(Image.new('RGBA', (frame_w, frame_h), COLORS[index]), (left, top))
    image.save(path, format='PNG')


def main():
    target = sys.argv[1]
    layout = sys.argv[2] if len(sys.argv) > 2 else 'vertical'
    frame_w = int(sys.argv[3]) if len(sys.argv) > 3 else 400
    frame_h = int(sys.argv[4]) if len(sys.argv) > 4 else 300
    pack_id = f'solid-{layout}'
    pack_dir = os.path.join(target, pack_id)
    os.makedirs(pack_dir, exist_ok=True)
    build_sheet(os.path.join(pack_dir, 'idle.png'), layout, frame_w, frame_h)
    animation = {'sheet': 'idle.png', 'frames': FRAMES, 'fps': 1, 'layout': layout}
    payload = {
        'id': pack_id,
        'name': f'纯色{layout}',
        'size': {'w': frame_w, 'h': frame_h},
        'scale': 1,
        'physics': {'gravity': 1800, 'walkSpeed': 52},
        'animations': {
            'idle': dict(animation),
            'walk-left': dict(animation),
            'walk-right': dict(animation),
            'drag': dict(animation),
            'fall': dict(animation),
        },
    }
    with open(os.path.join(pack_dir, 'pet.json'), 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print(f'wrote {pack_dir} ({layout}, {frame_w}x{frame_h} x {FRAMES})')


if __name__ == '__main__':
    main()
