"""宠物插件测试共用的夹具工具（不以 `test_` 开头，pytest 不会收集）。"""

import io
import json
import os

from PIL import Image

#: 一份「完整包」的最小合法内容（所有动作齐全）。
FULL_PACK = {
    'format': 1,
    'id': 'test-pet',
    'name': '测试宠物',
    'author': 'tests',
    'size': {'w': 64, 'h': 64},
    'anchor': {'x': 0.5, 'y': 1.0},
    'physics': {
        'gravity': 1800,
        'walkSpeed': 60,
        'friction': 0.02,
        'terminalVelocity': 2400,
        'bounce': 0.15,
    },
    'animations': {
        'idle': {'sheet': 'idle.png', 'frames': 4, 'fps': 6, 'loop': True},
        'walk-left': {'sheet': 'walk-left.png', 'frames': 4, 'fps': 8, 'loop': True},
        'walk-right': {'sheet': 'walk-right.png', 'frames': 4, 'fps': 8, 'loop': True},
        'fall': {'sheet': 'fall.png', 'frames': 2, 'fps': 8, 'loop': True},
        'drag': {'sheet': 'drag.png', 'frames': 2, 'fps': 4, 'loop': True},
        'land': {'sheet': 'land.png', 'frames': 3, 'fps': 12, 'loop': False},
    },
}


def pack(**overrides) -> dict:
    """构造一份宠物包 dict，`overrides` 浅覆盖顶层字段。"""
    payload = json.loads(json.dumps(FULL_PACK))  # deep copy
    payload.update(overrides)
    return payload


def minimal_pack(**overrides) -> dict:
    """只有 `idle` 的包——「任何一张单帧图都能跑起来」这条要验的主场景。"""
    payload = {
        'format': 1,
        'id': 'single-frame',
        'name': '单帧宠物',
        'animations': {'idle': 'idle.png'},
    }
    payload.update(overrides)
    return payload


def make_image_bytes(
    *,
    size=(64, 64),
    fmt='PNG',
    color=(255, 0, 0, 255),
    mode='RGBA',
    raw: bytes = None,
) -> bytes:
    """生成一张真实可解码的图片字节（用于上传路径测试）。

    会自动把模式调整成目标格式能写的：例如 JPEG 不支持 RGBA，
    传 `fmt='JPEG'` 时应落成 RGB，否则 Pillow 会 `OSError`。
    """
    if raw is not None:
        return raw

    if fmt in ('JPEG', 'JPG', 'BMP'):
        mode = 'RGB'
        if len(color) == 4:
            color = color[:3]
    elif fmt in ('GIF', 'P') and mode == 'RGBA':
        # GIF 的调色板模式不接受 RGBA 的 alpha，转成 RGB 即可
        mode = 'RGB'
        color = color[:3]

    image = Image.new(mode, size, color)
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


def write_sheet(path, *, frames=1, frame_size=(64, 64), fmt='PNG'):
    """写一张水平排布的单帧 / 多帧 spritesheet，返回路径。"""
    width = frame_size[0] * max(1, int(frames))
    height = frame_size[1]
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    for index in range(max(1, int(frames))):
        # 每帧涂一个不同的颜色块，便于人工核对帧序
        tile = Image.new(
            'RGBA', frame_size,
            (40 + index * 30, 90, 200, 255),
        )
        image.paste(tile, (index * frame_size[0], 0))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    image.save(path, format=fmt)
    return path


def write_pack(root, pack_id='test-pet', payload=None, *, sheets=None):
    """把一份宠物包写到 `root/<pack_id>/`，返回包目录。

    `sheets` 形如 `{'idle.png': 4}`（文件名 → 帧数），会生成真实的 spritesheet，
    这样连「sheet 指向的文件是否存在」这类校验也能测到。
    """
    pack_dir = os.path.join(str(root), pack_id)
    os.makedirs(pack_dir, exist_ok=True)

    body = payload if payload is not None else pack(id=pack_id)
    body = json.loads(json.dumps(body))
    body.setdefault('id', pack_id)

    for name, frames in (sheets or {}).items():
        write_sheet(os.path.join(pack_dir, name.replace('/', os.sep)), frames=frames)

    with open(os.path.join(pack_dir, 'pet.json'), 'w', encoding='utf-8') as handle:
        json.dump(body, handle, ensure_ascii=False, indent=2)
    return pack_dir
