"""导入安全（§3.4 的六条）。

用户能导入图片与包，这是**不可信输入**。这里的每条测试对应一条防护：
路径穿越 / 解码炸弹 / 伪造扩展名 / 体积超限 / 符号链接 / 结构化错误。
"""

import io
import os

import pytest
from PIL import Image

from backend.core.errors import (
    CODE_FILE_TOO_LARGE,
    CODE_IMAGE_INVALID,
    CODE_IMAGE_TOO_LARGE,
    CODE_PAYLOAD_TOO_LARGE,
    CODE_PATH_ESCAPE,
    CODE_UNSUPPORTED_FORMAT,
    PetError,
)
from backend.core.imports import (
    ALLOWED_IMAGE_FORMATS,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DIMENSION,
    MAX_PAYLOAD_BYTES,
    check_payload_size,
    check_size,
    encode_image,
    format_bytes,
    load_image,
    normalize_frame,
    process_upload,
    sniff_format,
    write_bytes_atomic,
)
from backend.core.paths import is_safe_relative_name, is_under_base, safe_join, to_posix
from pet_test_support import make_image_bytes


# ------------------------------------------------------------------ 路径穿越


def test_is_under_base_accepts_child(tmp_path):
    root = str(tmp_path)
    assert is_under_base(os.path.join(root, 'a', 'b.png'), root, resolve_symlinks=True)


def test_is_under_base_accepts_base_itself(tmp_path):
    assert is_under_base(str(tmp_path), str(tmp_path), resolve_symlinks=True)


def test_is_under_base_rejects_sibling_prefix(tmp_path):
    """`plugins-x` **不是** `plugins` 的子目录——用 commonpath 而不是 startswith。"""
    root = tmp_path / 'plugins'
    sibling = tmp_path / 'plugins-x'
    root.mkdir()
    sibling.mkdir()
    assert not is_under_base(str(sibling / 'a.png'), str(root), resolve_symlinks=True)


def test_is_under_base_rejects_parent(tmp_path):
    root = tmp_path / 'inner'
    root.mkdir()
    assert not is_under_base(str(tmp_path / 'a.png'), str(root), resolve_symlinks=True)


def test_is_under_base_handles_empty_input():
    assert not is_under_base('', '/tmp')
    assert not is_under_base('/tmp', '')


@pytest.mark.parametrize('name', [
    '', '.', '..', '../x', 'a/../b', 'a/../../b',
    '/abs', '\\abs', 'C:/x', 'C:\\x',
    'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b',
    'a\x00b', 'a\nb',
])
def test_is_safe_relative_name_rejects_dangerous(name):
    assert not is_safe_relative_name(name)


@pytest.mark.parametrize('name', ['idle.png', 'a-b_c.png', 'sub/dir/idle.png', '宠物.png'])
def test_is_safe_relative_name_accepts_normal(name):
    assert is_safe_relative_name(name)


def test_safe_join_allows_valid_path(tmp_path):
    target = safe_join(str(tmp_path), 'pets', 'idle.png')
    assert target.startswith(os.path.realpath(str(tmp_path)))
    assert target.endswith('idle.png')


@pytest.mark.parametrize('parts', [
    ('..', 'evil.png'),
    ('a', '..', '..', 'evil.png'),
    ('/abs',),
    ('C:\\x',),
    ('',),
])
def test_safe_join_rejects_escape(tmp_path, parts):
    with pytest.raises(PetError) as info:
        safe_join(str(tmp_path), *parts)
    assert info.value.code == CODE_PATH_ESCAPE
    assert info.value.user_msg
    assert 'Traceback' not in str(info.value.to_dict())


def test_safe_join_must_exist_flag(tmp_path):
    with pytest.raises(PetError) as info:
        safe_join(str(tmp_path), 'ghost.png', must_exist=True)
    assert info.value.http_status == 404


def test_safe_join_survives_symlink_escape(tmp_path):
    """指向目录外的符号链接必须被拦住（Windows 上没权限建链接时跳过）。"""
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.png').write_bytes(b'x')

    root = tmp_path / 'root'
    root.mkdir()
    link = root / 'link'
    try:
        os.symlink(str(outside), str(link), target_is_directory=True)
    except (OSError, NotImplementedError, AttributeError):
        pytest.skip('当前环境无法创建符号链接（Windows 需要开发者模式/管理员）')

    with pytest.raises(PetError) as info:
        safe_join(str(root), 'link', 'secret.png')
    assert info.value.code == CODE_PATH_ESCAPE


def test_to_posix_normalizes_backslashes():
    assert to_posix('a\\b\\c.png') == 'a/b/c.png'
    assert to_posix(None) == ''


# ------------------------------------------------------------------ magic bytes


@pytest.mark.parametrize('fmt,expected', [
    ('PNG', 'PNG'),
    ('JPEG', 'JPEG'),
    ('GIF', 'GIF'),
    ('BMP', 'BMP'),
    ('WEBP', 'WEBP'),
])
def test_sniff_format_detects_real_format(fmt, expected):
    data = make_image_bytes(fmt=fmt, size=(8, 8))
    assert sniff_format(data) == expected


@pytest.mark.parametrize('data,expected', [
    (b'%PDF-1.4\n...', 'PDF'),
    (b'PK\x03\x04zip', 'ZIP'),
    (b'Rar!\x1a\x07\x00', 'RAR'),
    (b'\x7fELF\x02\x01', 'ELF'),
    (b'MZ\x90\x00', 'EXE'),
])
def test_sniff_format_detects_non_image_containers(data, expected):
    assert sniff_format(data) == expected


def test_sniff_format_unknown_returns_empty():
    assert sniff_format(b'not an image at all') == ''
    assert sniff_format(b'') == ''


def test_png_can_be_sniffed_even_with_wrong_extension():
    """扩展名是用户可伪造的；判定必须看内容（这里是伪装成 .txt 的 PNG）。"""
    data = make_image_bytes(fmt='PNG')
    assert sniff_format(data) == 'PNG'


# ------------------------------------------------------- 伪造扩展名 / 非图片


def test_pdf_masquerading_as_png_is_rejected():
    """★ 伪造扩展名：内容其实是 PDF，扩展名却是 .png。"""
    fake = b'%PDF-1.7\n' + b'A' * 200
    with pytest.raises(PetError) as info:
        load_image(fake, what='形象图')
    error = info.value
    assert error.code == CODE_UNSUPPORTED_FORMAT
    assert 'PDF' in error.user_msg
    assert error.hint


def test_zip_masquerading_as_png_is_rejected():
    with pytest.raises(PetError) as info:
        load_image(b'PK\x03\x04' + b'\x00' * 100)
    assert info.value.code == CODE_UNSUPPORTED_FORMAT


def test_executable_is_rejected():
    with pytest.raises(PetError) as info:
        load_image(b'MZ\x90\x00' + b'\x00' * 500)
    assert info.value.code == CODE_UNSUPPORTED_FORMAT
    assert '可执行文件' in info.value.user_msg


def test_random_garbage_is_rejected():
    with pytest.raises(PetError) as info:
        load_image(b'\x00\x01\x02\x03' * 50)
    assert info.value.code in (CODE_IMAGE_INVALID, CODE_UNSUPPORTED_FORMAT)


def test_empty_upload_is_rejected():
    with pytest.raises(PetError) as info:
        load_image(b'')
    assert info.value.code == CODE_IMAGE_INVALID
    assert '空' in info.value.user_msg


def test_truncated_png_is_rejected_with_readable_error():
    """截断的 PNG：magic bytes 对，像素数据不全。"""
    good = make_image_bytes(fmt='PNG', size=(128, 128))
    truncated = good[: len(good) // 3]
    with pytest.raises(PetError) as info:
        load_image(truncated)
    error = info.value
    assert error.code in (CODE_IMAGE_INVALID, CODE_IMAGE_TOO_LARGE)
    assert error.user_msg


# ------------------------------------------------------------------ 解码炸弹


@pytest.mark.filterwarnings('ignore::PIL.Image.DecompressionBombWarning')
def test_decompression_bomb_is_rejected():
    """★ 解码炸弹：声明成 20000×20000 的 PNG 必须在展开像素**之前**被拒绝。

    用 `Image.MAX_IMAGE_PIXELS` 之外的显式尺寸检查兜住；这里造一张真实的
    大尺寸图来验证（Pillow 在 open 时就会依据 header 尺寸触发防护）。

    Pillow 自己会先发 `DecompressionBombWarning`（不是异常），这是预期行为：
    我们**不**依赖它——下面断言的是我们自己那条可读的 `image_too_large` 错误。
    """
    buffer = io.BytesIO()
    image = Image.new('RGB', (MAX_IMAGE_DIMENSION * 3, MAX_IMAGE_DIMENSION * 3))
    image.save(buffer, format='PNG')
    data = buffer.getvalue()

    with pytest.raises(PetError) as info:
        load_image(data)
    error = info.value
    assert error.code == CODE_IMAGE_TOO_LARGE
    assert str(MAX_IMAGE_DIMENSION) in error.user_msg
    assert error.hint


def test_decompression_bomb_error_is_structured_not_traceback():
    buffer = io.BytesIO()
    image = Image.new('RGB', (MAX_IMAGE_DIMENSION * 2, MAX_IMAGE_DIMENSION * 2))
    image.save(buffer, format='PNG')
    with pytest.raises(PetError) as info:
        load_image(buffer.getvalue())
    payload = info.value.to_dict()
    assert payload['success'] is False
    assert 'error' in payload
    assert 'Traceback' not in str(payload)


def test_image_at_exact_limit_is_accepted():
    data = make_image_bytes(size=(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION), fmt='PNG')
    image = load_image(data)
    assert image.size == (MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION)


def test_oversized_by_one_pixel_is_rejected():
    data = make_image_bytes(size=(MAX_IMAGE_DIMENSION + 1, 10), fmt='PNG')
    with pytest.raises(PetError) as info:
        load_image(data)
    assert info.value.code == CODE_IMAGE_TOO_LARGE


# ------------------------------------------------------------------ 体积上限


def test_check_size_passes_under_limit():
    check_size(100, 200, what='图片')


def test_check_size_raises_over_limit():
    with pytest.raises(PetError) as info:
        check_size(300, 200, what='图片')
    error = info.value
    assert error.code == CODE_FILE_TOO_LARGE
    assert error.http_status == 413
    assert '图片' in error.user_msg


def test_oversized_upload_is_rejected_before_decode():
    """体积超限要在**解码之前**拦掉（否则大文件先把内存吃满）。"""
    with pytest.raises(PetError) as info:
        process_upload(b'\x00' * (MAX_IMAGE_BYTES + 1), what='形象图')
    assert info.value.code == CODE_FILE_TOO_LARGE


def test_payload_limit():
    check_payload_size(MAX_PAYLOAD_BYTES)
    with pytest.raises(PetError) as info:
        check_payload_size(MAX_PAYLOAD_BYTES + 1)
    assert info.value.code == CODE_PAYLOAD_TOO_LARGE
    assert info.value.http_status == 413


def test_format_bytes_is_human_readable():
    assert format_bytes(512) == '512 B'
    assert format_bytes(2048) == '2.0 KB'
    assert 'MB' in format_bytes(5 * 1024 * 1024)


# ------------------------------------------------------------------ 转码与缩放


def test_process_upload_transcodes_jpeg_to_png():
    """★ 用户几乎必然上传 JPEG，而 `.jpg` 不在宿主资产白名单里 → 必须转码。"""
    jpeg = make_image_bytes(fmt='JPEG', size=(100, 80), mode='RGB', color=(10, 200, 30))
    result = process_upload(jpeg, what='形象图')

    assert result['extension'] == '.png'
    assert result['format'] == 'png'
    assert result['source_format'] == 'JPEG'
    # 产物必须真能被解码成 PNG
    assert sniff_format(result['data']) == 'PNG'
    decoded = Image.open(io.BytesIO(result['data']))
    assert decoded.format == 'PNG'


def test_process_upload_webp_output():
    png = make_image_bytes(fmt='PNG', size=(50, 50))
    result = process_upload(png, what='形象图', output_format='webp')
    assert result['extension'] == '.webp'
    assert sniff_format(result['data']) == 'WEBP'


def test_process_upload_resizes_to_frame_size():
    """给了 frame_size 就等比缩放进该尺寸（用户不必自己裁成正好尺寸）。"""
    wide = make_image_bytes(fmt='PNG', size=(400, 100))
    result = process_upload(wide, what='形象图', frame_size=(64, 64))
    assert result['size'] == (64, 64)
    decoded = Image.open(io.BytesIO(result['data']))
    assert decoded.size == (64, 64)


def test_normalize_frame_preserves_aspect_ratio_and_centers():
    source = Image.new('RGBA', (200, 100), (255, 0, 0, 255))
    framed = normalize_frame(source, 64, 64)
    assert framed.size == (64, 64)
    # 等比缩放后上下应留透明边（宽 64、高 32）
    assert framed.getpixel((32, 2))[3] == 0, '顶部应透明'
    assert framed.getpixel((32, 32))[3] == 255, '中间应不透明'


def test_normalize_frame_handles_tiny_source():
    source = Image.new('RGBA', (1, 1), (0, 0, 255, 255))
    framed = normalize_frame(source, 32, 32)
    assert framed.size == (32, 32)


def test_normalize_frame_converts_palette_images():
    """调色板 PNG（P 模式）要能处理，否则贴上去是花屏。"""
    source = Image.new('P', (16, 16), 3)
    framed = normalize_frame(source, 32, 32)
    assert framed.mode == 'RGBA'


def test_encode_image_rejects_unknown_format_falls_back_to_png():
    image = Image.new('RGBA', (8, 8))
    data, extension = encode_image(image, 'tiff')
    assert extension == '.png'
    assert sniff_format(data) == 'PNG'


def test_process_upload_preserves_transparency():
    """透明像素在「解码 → 缩放 → 编码」全程都要保持透明（否则宠物会贴一块白底）。"""
    transparent = make_image_bytes(size=(32, 32), color=(0, 0, 0, 0))
    result = process_upload(transparent, frame_size=(32, 32))
    decoded = Image.open(io.BytesIO(result['data'])).convert('RGBA')
    assert decoded.getpixel((16, 16))[3] == 0, '透明像素应在转码后保持透明'


def test_animated_gif_uses_first_frame():
    """GIF 也要能用（取第一帧），不能因为是多帧就报错。"""
    frames = [Image.new('RGB', (20, 20), (i * 40, 0, 0)) for i in range(3)]
    buffer = io.BytesIO()
    frames[0].save(buffer, format='GIF', save_all=True, append_images=frames[1:])
    result = process_upload(buffer.getvalue(), what='形象图', frame_size=(20, 20))
    assert result['size'] == (20, 20)
    assert result['source_format'] == 'GIF'


# ------------------------------------------------------------------ 落盘


def test_write_bytes_atomic_creates_file(tmp_path):
    target = str(tmp_path / 'a' / 'b' / 'idle.png')
    write_bytes_atomic(target, b'hello')
    with open(target, 'rb') as handle:
        assert handle.read() == b'hello'


def test_write_bytes_atomic_leaves_no_temp_files(tmp_path):
    target = str(tmp_path / 'idle.png')
    write_bytes_atomic(target, b'data')
    leftovers = [name for name in os.listdir(str(tmp_path)) if '.tmp-' in name]
    assert leftovers == []


def test_write_bytes_atomic_overwrites_existing(tmp_path):
    target = str(tmp_path / 'idle.png')
    write_bytes_atomic(target, b'first')
    write_bytes_atomic(target, b'second')
    with open(target, 'rb') as handle:
        assert handle.read() == b'second'


def test_write_bytes_atomic_reports_oserror_as_structured(tmp_path):
    """写不进去（这里是拿目录当文件）要返回结构化错误，而不是抛 OSError。"""
    directory = tmp_path / 'adir'
    directory.mkdir()
    with pytest.raises(PetError) as info:
        write_bytes_atomic(str(directory), b'data')
    assert info.value.user_msg
    assert info.value.http_status == 500


# ------------------------------------------------------------------ 错误对象


def test_error_payload_never_contains_traceback():
    with pytest.raises(PetError) as info:
        load_image(b'garbage-not-an-image')
    payload = info.value.to_dict()
    assert 'Traceback' not in str(payload)
    assert 'File "' not in str(payload)


def test_error_payload_shape_is_consistent():
    with pytest.raises(PetError) as info:
        load_image(b'')
    payload = info.value.to_dict()
    assert payload['success'] is False
    assert isinstance(payload['msg'], str) and payload['msg']
    assert isinstance(payload['error'], str) and payload['error']


def test_allowed_format_set_documented():
    """白名单要包含常见可解码格式；JPEG 在允许解码之列（转码后被接受）。"""
    assert 'JPEG' in ALLOWED_IMAGE_FORMATS
    assert 'PNG' in ALLOWED_IMAGE_FORMATS
    assert 'WEBP' in ALLOWED_IMAGE_FORMATS
