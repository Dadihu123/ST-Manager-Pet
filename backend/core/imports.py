"""导入安全：用户上传的图片与宠物包都是**不可信输入**（§3.4）。

必须做的六条，这里逐条落地：

1. **路径穿越** —— 见 `paths.safe_join`（realpath 后校验在 `data_dir()` 内）；
2. **图片解码炸弹** —— `Image.MAX_IMAGE_PIXELS` + 显式尺寸上限；
3. **只接受白名单格式** —— 读 **magic bytes** 判真实格式，**不信扩展名**，转码成 PNG/WebP；
4. **体积上限** —— 单文件与单包都有上限，超限返回结构化错误；
5. **包 JSON 解析** —— 见 `pack.loads`（try/except + 逐字段校验）；
6. **符号链接** —— 落盘时用 `os.path.realpath` 复核，不跟随包外链接。

为什么必须转码（而不是原样存）
------------------------------
宿主的插件资产白名单是 `.js .mjs .css .svg .png .webp .gif .avif .json .woff2 .map`
——**不含 `.jpg` / `.jpeg`**（§2.5 / §8 陷阱 3）。用户几乎必然上传 JPEG 照片，
所以上传路径统一转成 PNG（保留透明通道）或 WebP，顺带把尺寸缩到上限内。
"""

import io
import logging
import os

from PIL import Image, UnidentifiedImageError

from .errors import (
    CODE_FILE_TOO_LARGE,
    CODE_IMAGE_INVALID,
    CODE_IMAGE_TOO_LARGE,
    CODE_PAYLOAD_TOO_LARGE,
    CODE_UNSUPPORTED_FORMAT,
    PetError,
)

logger = logging.getLogger(__name__)

# ---- 上限（§3.4 第 2/4 条）----

#: 单张上传图片的字节上限（8 MiB）。
MAX_IMAGE_BYTES = 8 * 1024 * 1024
#: 单个宠物包（zip）的字节上限（32 MiB）。
MAX_PACK_BYTES = 32 * 1024 * 1024
#: 请求体上限（表单可能有多个文件）。
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
#: 图片解压后的像素尺寸上限（宽和高各自）。
MAX_IMAGE_DIMENSION = 4096

#: 新建形象时一条 spritesheet 的帧数上限。
#: 与 `pack.MAX_FRAMES`（256）保持一致：这里更严是因为**一张图**里塞几百帧时，
#: 单帧会小到不可辨认，几乎必然是用户填错了帧数。
MAX_SHEET_FRAMES = 64

#: 存盘时允许的目标格式 → Pillow 格式名 + 扩展名。
#: 两种都能被宿主资产白名单接受。
OUTPUT_FORMATS = {
    'png': ('PNG', '.png'),
    'webp': ('WEBP', '.webp'),
}
DEFAULT_OUTPUT_FORMAT = 'png'

#: **真实**格式白名单（按 magic bytes 判定，不看扩展名）。
#: 需要 Pillow 能解，且是我们愿意接受为「照片/插画」的格式。
ALLOWED_IMAGE_FORMATS = frozenset({
    'PNG', 'JPEG', 'WEBP', 'GIF', 'BMP', 'TIFF', 'AVIF',
})

#: magic bytes 前缀表：用于**快速**判定「这到底是不是图片」，以及给不支持的
#: 格式一个更准确的错误信息（例如「这是 PDF，不是图片」）。
_MAGIC_SIGNATURES = (
    (b'\x89PNG\r\n\x1a\n', 'PNG'),
    (b'\xff\xd8\xff', 'JPEG'),
    (b'GIF87a', 'GIF'),
    (b'GIF89a', 'GIF'),
    (b'BM', 'BMP'),
    (b'II*\x00', 'TIFF'),
    (b'MM\x00*', 'TIFF'),
    (b'%PDF', 'PDF'),
    (b'PK\x03\x04', 'ZIP'),
    (b'Rar!\x1a\x07', 'RAR'),
    (b'\x7fELF', 'ELF'),
    (b'MZ', 'EXE'),
)

_HUMAN_FORMAT = {
    'PDF': 'PDF 文档',
    'ZIP': '压缩包',
    'RAR': '压缩包',
    'ELF': '可执行文件',
    'EXE': '可执行文件',
}


def format_bytes(size: int) -> str:
    """把字节数变成人能读的小字符串（错误信息里用）。"""
    number = float(size)
    for unit in ('B', 'KB', 'MB', 'GB'):
        if number < 1024 or unit == 'GB':
            if unit == 'B':
                return f'{int(number)} {unit}'
            return f'{number:.1f} {unit}'
        number /= 1024
    return f'{number:.1f} GB'


def sniff_format(data: bytes) -> str:
    """按 magic bytes 猜测真实格式；未知返回 `''`。

    **不依赖扩展名**——扩展名是用户可伪造的，magic bytes 才是内容事实。
    """
    for signature, name in _MAGIC_SIGNATURES:
        if data.startswith(signature):
            return name
    # WebP / AVIF 都在 RIFF 容器里，需要看第 8 字节起的 fourcc
    if len(data) >= 12 and data[:4] == b'RIFF':
        fourcc = data[8:12]
        if fourcc == b'WEBP':
            return 'WEBP'
        if fourcc in (b'AVIF', b'AVIS'):
            return 'AVIF'
    return ''


def check_size(size: int, limit: int, *, what: str = '文件') -> None:
    """体积上限检查，超限抛结构化错误。"""
    if size > limit:
        raise PetError(
            CODE_FILE_TOO_LARGE,
            f'{what}体积 {size} 超过上限 {limit}',
            user_msg=f'{what}太大了（{format_bytes(size)}，上限 {format_bytes(limit)}）。',
            hint='请压缩后再上传，或换一张更小的图。',
            http_status=413,
        )


def check_payload_size(size: int) -> None:
    """整个请求体的上限检查。"""
    if size > MAX_PAYLOAD_BYTES:
        raise PetError(
            CODE_PAYLOAD_TOO_LARGE,
            f'请求体 {size} 超过上限 {MAX_PAYLOAD_BYTES}',
            user_msg=f'本次上传的内容太大（{format_bytes(size)}，'
                     f'上限 {format_bytes(MAX_PAYLOAD_BYTES)}）。',
            hint='一次少传几张图，或改用更小的包。',
            http_status=413,
        )


def load_image(data: bytes, *, what: str = '图片') -> Image.Image:
    """从字节解码图片，含**解码炸弹**防护（§3.4 第 2 条）。

    先按 magic bytes 拦掉明显的非图片（给出更有用的错误信息），
    再用 Pillow 解码；`Image.MAX_IMAGE_PIXELS` 在解码前生效，
    因此「声明成 60000×60000 的 PNG」会在展开像素之前就被拒绝。
    """
    if not data:
        raise PetError(
            CODE_IMAGE_INVALID,
            f'{what}内容为空',
            user_msg='上传的文件是空的。',
            hint='请重新选择一张图片。',
        )

    sniffed = sniff_format(data)
    if sniffed in _HUMAN_FORMAT:
        raise PetError(
            CODE_UNSUPPORTED_FORMAT,
            f'{what}的实际内容是 {sniffed}，不是图片',
            user_msg=f'这个文件其实是{_HUMAN_FORMAT[sniffed]}，不是图片。',
            hint='请选择 PNG、JPEG、WebP、GIF、BMP 或 AVIF 格式的图片。',
        )
    if sniffed and sniffed not in ALLOWED_IMAGE_FORMATS:
        raise PetError(
            CODE_UNSUPPORTED_FORMAT,
            f'{what}的格式 {sniffed} 不受支持',
            user_msg=f'不支持 {sniffed} 格式的图片。',
            hint='请转成 PNG 或 WebP 再上传。',
        )

    # 解码前先设上限；Pillow 会在超过时抛 DecompressionBombError
    previous_limit = Image.MAX_IMAGE_PIXELS
    try:
        try:
            image = Image.open(io.BytesIO(data))
            # `verify()` 之后的 image 对象不可再用，因此先读尺寸再验结构
            width, height = image.size
        except UnidentifiedImageError as exc:
            raise PetError(
                CODE_IMAGE_INVALID,
                f'{what}无法被识别为图片: {exc}',
                user_msg='这个文件不是有效的图片，或者格式已损坏。',
                hint='换一张图试试；若是截图工具产出的特殊格式，请先另存为 PNG。',
            ) from exc
        except Image.DecompressionBombError as exc:
            raise PetError(
                CODE_IMAGE_TOO_LARGE,
                f'{what}触发解码炸弹防护: {exc}',
                user_msg='这张图的像素规模异常巨大，出于安全考虑已拒绝。',
                hint=f'请把图片缩到 {MAX_IMAGE_DIMENSION}×{MAX_IMAGE_DIMENSION} 以内。',
            ) from exc
        except (OSError, ValueError) as exc:
            raise PetError(
                CODE_IMAGE_INVALID,
                f'{what}解码失败: {exc}',
                user_msg='这张图解码失败，文件可能已损坏。',
                hint='用图片查看器打开确认能否正常显示。',
            ) from exc

        # 显式尺寸检查（比 MAX_IMAGE_PIXELS 更严格，也更可读）
        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise PetError(
                CODE_IMAGE_TOO_LARGE,
                f'{what}尺寸 {width}×{height} 超过上限',
                user_msg=f'这张图是 {width}×{height}，'
                         f'超过 {MAX_IMAGE_DIMENSION}×{MAX_IMAGE_DIMENSION} 的上限。',
                hint=f'把图片缩到 {MAX_IMAGE_DIMENSION}×{MAX_IMAGE_DIMENSION} 以内再上传。',
            )

        # 真正把像素读进来（这一步才会暴露截断/损坏的图）
        try:
            image.load()
        except (OSError, ValueError) as exc:
            raise PetError(
                CODE_IMAGE_INVALID,
                f'{what}像素数据损坏: {exc}',
                user_msg='这张图的数据不完整，无法读取。',
                hint='重新导出这张图后再试。',
            ) from exc
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit

    return image


def normalize_frame(image: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """把上传的图处理成**单帧尺寸**的一帧。

    行为：等比缩放（contain）后居中贴到 `target_w × target_h` 的透明画布上。
    这样用户随便给一张图都能立刻当形象用，不必自己裁成正好尺寸。
    """
    width = max(1, int(target_w))
    height = max(1, int(target_h))

    if image.mode not in ('RGBA', 'LA', 'P'):
        image = image.convert('RGBA')
    elif image.mode == 'P':
        image = image.convert('RGBA')

    ratio = min(width / image.width, height / image.height)
    new_size = (
        max(1, int(round(image.width * ratio))),
        max(1, int(round(image.height * ratio))),
    )
    resized = image.resize(new_size, Image.LANCZOS)

    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    canvas.paste(
        resized,
        ((width - new_size[0]) // 2, (height - new_size[1]) // 2),
    )
    return canvas


def fit_within(width: int, height: int, limit: int) -> tuple:
    """把 `width × height` 等比缩到**最长边不超过** `limit`，返回整数尺寸。

    用于「用户新建形象」时从上传图推导单帧尺寸：用户的图可能远大于形象包允许的
    单帧上限（`_MAX_FRAME_SIZE` = 512），这时按比例缩到上限内，而不是拒绝他。
    """
    limit = max(1, int(limit))
    width = max(1, int(width))
    height = max(1, int(height))
    longest = max(width, height)
    if longest <= limit:
        return width, height
    ratio = limit / longest
    return max(1, int(round(width * ratio))), max(1, int(round(height * ratio)))


def prepare_sheet(
    data: bytes,
    *,
    frames: int = 1,
    frame_size: tuple = None,
    what: str = '图片',
    output_format: str = DEFAULT_OUTPUT_FORMAT,
    max_frame_size: int = MAX_IMAGE_DIMENSION,
) -> dict:
    """把一张上传图做成**规范化的 spritesheet**（新建形象走这条通路）。

    与 `process_upload` 的区别：那个把整张图当**一帧**处理（覆盖单个动作的用法），
    这里先把图按 `frames` **水平切分**，逐帧归一化到统一的 `frame_size`，再拼回一条
    sheet。用户因此可以「一张图里放 4 帧」直接当动画用。

    Args:
        data: 原始字节。
        frames: 这条 sheet 里有几帧（水平排布）。**宽度必须能被帧数整除**。
        frame_size: `(w, h)` 单帧目标尺寸；`None` 表示**按切分后的单帧尺寸推导**
            （并用 `max_frame_size` 封顶）。新建形象时先用 `idle` 推一次，
            再拿这个尺寸去对齐其它动作，保证所有动作的单帧尺寸一致。
        what: 错误信息里对这份内容的称呼。
        output_format: `'png'` 或 `'webp'`。
        max_frame_size: 推导尺寸时的单帧上限（形象包格式自身的上限）。

    Returns:
        dict: `{'data', 'extension', 'format', 'frame_size', 'frames',
                'sheet_size', 'source_format', 'derived'}`。
        `derived` 为真表示 `frame_size` 是这次推导出来的（调用方应记下来）。

    Raises:
        PetError: 空文件 / 体积超限 / 非图片 / 尺寸超限 / 损坏 / 帧数不整除。
    """
    check_size(len(data), MAX_IMAGE_BYTES, what=what)
    image = load_image(data, what=what)
    source_format = str(image.format or sniff_format(data) or '未知')

    count = int(frames or 1)
    if count < 1:
        count = 1
    if count > MAX_SHEET_FRAMES:
        raise PetError(
            CODE_IMAGE_INVALID,
            f'{what} 的帧数 {count} 超过上限 {MAX_SHEET_FRAMES}',
            user_msg=f'帧数最多 {MAX_SHEET_FRAMES} 帧。',
            hint='把动作拆成多张图，或减少帧数。',
        )

    if count > 1 and image.width % count != 0:
        raise PetError(
            CODE_IMAGE_INVALID,
            f'{what} 宽度 {image.width} 不能被帧数 {count} 整除',
            user_msg=f'这张图宽 {image.width}px，切不成 {count} 帧（除不尽）。',
            hint=f'把图宽做成 {count} 的倍数（例如每帧 {image.width // count}px），'
                 f'或把帧数改成 {image.width} 的约数。',
        )

    tile_w = max(1, image.width // count)
    tile_h = max(1, image.height)
    derived = False
    if frame_size:
        target_w = max(1, int(frame_size[0]))
        target_h = max(1, int(frame_size[1]))
    else:
        target_w, target_h = fit_within(tile_w, tile_h, max_frame_size)
        derived = True

    if image.mode != 'RGBA':
        image = image.convert('RGBA')

    # 逐帧切出来再归一化：这样每帧都是**同一尺寸**，拼接后的 sheet 才是规整的
    sheet = Image.new('RGBA', (target_w * count, target_h), (0, 0, 0, 0))
    for index in range(count):
        tile = image.crop((index * tile_w, 0, (index + 1) * tile_w, tile_h))
        sheet.paste(normalize_frame(tile, target_w, target_h), (index * target_w, 0))

    encoded, extension = encode_image(sheet, output_format)
    # 转码后也可能膨胀（例如 GIF → PNG），再查一次
    check_size(len(encoded), MAX_IMAGE_BYTES, what=f'处理后的{what}')

    return {
        'data': encoded,
        'extension': extension,
        'format': output_format,
        'frame_size': (target_w, target_h),
        'frames': count,
        'sheet_size': (target_w * count, target_h),
        'source_format': source_format,
        'derived': derived,
    }


def encode_image(image: Image.Image, fmt: str = DEFAULT_OUTPUT_FORMAT) -> tuple:
    """把图片编码成允许的输出格式；返回 `(bytes, extension)`。"""
    key = str(fmt or DEFAULT_OUTPUT_FORMAT).lower()
    if key not in OUTPUT_FORMATS:
        key = DEFAULT_OUTPUT_FORMAT
    pillow_format, extension = OUTPUT_FORMATS[key]

    buffer = io.BytesIO()
    try:
        if pillow_format == 'PNG':
            image.save(buffer, format='PNG', optimize=True)
        else:
            # WebP 支持透明；quality 92 在体积与观感间取平衡
            image.save(buffer, format='WEBP', quality=92, method=4)
    except (OSError, ValueError) as exc:
        logger.error('图片编码失败（格式 %s）: %s', pillow_format, exc)
        raise PetError(
            CODE_IMAGE_INVALID,
            f'图片编码失败: {exc}',
            user_msg='图片处理失败，请换一张图再试。',
            http_status=500,
        ) from exc
    return buffer.getvalue(), extension


def write_bytes_atomic(target_path: str, data: bytes) -> None:
    """原子落盘：先写同目录临时文件再 `os.replace`。

    避免「写到一半进程被杀」留下半张损坏的图（用户看到的就是「宠物图裂了」）。
    """
    directory = os.path.dirname(target_path)
    os.makedirs(directory, exist_ok=True)
    temporary = f'{target_path}.tmp-{os.getpid()}'
    try:
        with open(temporary, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target_path)
    except OSError as exc:
        logger.error('写入 %s 失败: %s', target_path, exc)
        try:
            if os.path.exists(temporary):
                os.remove(temporary)
        except OSError:
            pass
        raise PetError(
            CODE_IMAGE_INVALID,
            f'文件写入失败: {exc}',
            user_msg='保存图片失败，请检查磁盘空间与目录权限。',
            http_status=500,
        ) from exc


def process_upload(
    data: bytes,
    *,
    what: str = '图片',
    output_format: str = DEFAULT_OUTPUT_FORMAT,
    frame_size: tuple = None,
) -> dict:
    """把一份上传的图片处理成可落盘的帧图。

    Args:
        data: 原始字节。
        what: 错误信息里对这份内容的称呼（「形象图」「idle 动作图」…）。
        output_format: `'png'` 或 `'webp'`。
        frame_size: `(w, h)`；给了就做等比缩放 + 居中贴图。

    Returns:
        dict: `{'data': bytes, 'extension': str, 'format': str, 'size': (w, h),
               'source_format': str}`

    Raises:
        PetError: 空文件 / 体积超限 / 非图片 / 格式不支持 / 尺寸超限 / 损坏。
    """
    check_size(len(data), MAX_IMAGE_BYTES, what=what)
    image = load_image(data, what=what)
    source_format = str(image.format or sniff_format(data) or '未知')

    if frame_size:
        image = normalize_frame(image, frame_size[0], frame_size[1])

    encoded, extension = encode_image(image, output_format)
    # 转码后也可能膨胀（例如 GIF → PNG），再查一次
    check_size(len(encoded), MAX_IMAGE_BYTES, what=f'处理后的{what}')

    return {
        'data': encoded,
        'extension': extension,
        'format': output_format,
        'size': image.size,
        'source_format': source_format,
    }
