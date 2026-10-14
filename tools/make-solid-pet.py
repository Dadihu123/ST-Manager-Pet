"""建「纯色帧」测试形象，用于验收切帧是否露出邻帧。

每帧一个纯色（帧0 红 / 帧1 绿 / 帧2 蓝 / 帧3 黄）：

- 帧 1（绿）的 R、B 通道恒为 0，因此绿帧窗口里出现红/蓝 = 邻帧混入；
- 这是**与混合比例无关**的判据，连半像素混色也能测出来
  （50% 红 + 50% 绿 = (127,127,0)，R 被抬起来了）。

为什么要专门造这个：真实形象里帧与帧的图案相似，很难用像素判定
「这一块到底是本帧的还是邻帧的」；纯色帧让判定变成无歧义的事。

三种排布都支持（`horizontal` / `vertical` / `grid`）：

    python tools/make-solid-pet.py <插件 data/pets 目录> [排布] [宽] [高] [列] [行]

`grid` 时最后两个参数是列数与行数（缺省 2×2）。**帧数固定 4 帧**，
因此 `grid` 下只支持 2×2 或 4×1 / 1×4 这类装得下 4 帧的网格。
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


def build_sheet(path, layout, frame_w, frame_h, cols, rows):
    """按 `(cols, rows)` 铺一条纯色 sheet（行优先：先左到右，再上到下）。"""
    sheet_size = (frame_w * cols, frame_h * rows)
    image = Image.new('RGBA', sheet_size, (0, 0, 0, 0))
    for index in range(FRAMES):
        col = index % cols
        row = index // cols
        image.paste(
            Image.new('RGBA', (frame_w, frame_h), COLORS[index]),
            (col * frame_w, row * frame_h),
        )
    image.save(path, format='PNG')


def main():
    target = sys.argv[1]
    layout = sys.argv[2] if len(sys.argv) > 2 else 'vertical'
    frame_w = int(sys.argv[3]) if len(sys.argv) > 3 else 400
    frame_h = int(sys.argv[4]) if len(sys.argv) > 4 else 300
    if layout == 'grid':
        cols = int(sys.argv[5]) if len(sys.argv) > 5 else 2
        rows = int(sys.argv[6]) if len(sys.argv) > 6 else 2
    elif layout == 'vertical':
        cols, rows = 1, FRAMES
    else:
        cols, rows = FRAMES, 1

    if cols * rows < FRAMES:
        raise SystemExit(f'{cols}x{rows} 装不下 {FRAMES} 帧')

    pack_id = f'solid-{layout}' if layout != 'grid' else f'solid-grid-{cols}x{rows}'
    pack_dir = os.path.join(target, pack_id)
    os.makedirs(pack_dir, exist_ok=True)
    build_sheet(os.path.join(pack_dir, 'idle.png'), layout, frame_w, frame_h, cols, rows)

    animation = {'sheet': 'idle.png', 'frames': FRAMES, 'fps': 1}
    if layout == 'grid':
        # 网格排布：只写 cols / rows（`layout` 可以省略，但显式写更清楚）
        animation.update({'layout': 'grid', 'cols': cols, 'rows': rows})
    else:
        animation['layout'] = layout

    payload = {
        'id': pack_id,
        'name': f'纯色{layout}' + (f'{cols}x{rows}' if layout == 'grid' else ''),
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
    print(f'wrote {pack_dir} ({layout} {cols}x{rows}, {frame_w}x{frame_h} x {FRAMES})')


if __name__ == '__main__':
    main()

