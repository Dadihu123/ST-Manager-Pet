"""动图容器（`layout: "animated"`）：让现成的 GIF / 动图 WebP 直接能用。

这是**第二路线**，与帧序列（spritesheet）路线并列
------------------------------------------------
- **帧序列**：作者先把动画拼成一张（或几张）sheet。换来的是完全的控制权
  ——逐帧时长、定位某一帧、分页把显存峰值卡住。
- **动图容器**：作者手上已经有一个现成的 GIF / 动图 WebP（下载的、
  工具导出的），丢进来就能用。**零制作成本**，代价是放弃控制权。

为什么值得有这条路线
--------------------
不是所有人都愿意（或能）把动画拼成 sheet。而「我已经有一个动图了」
是最常见的起点。拒绝它等于把这类用户挡在门外。

⚠️ 资源消耗的**真实情况与直觉相反**
-----------------------------------
直觉是「动图文件大、占资源」，但**实测不是**。同一段动画（内置形象
12 个动作的真实素材）分别做成两种形式：

| 形式 | 字节数 | 相对 sheet |
|---|---|---|
| spritesheet PNG | 5,617,066 | 1.00x |
| 动图 GIF | 1,250,424 | **0.22x** |
| 动图 WebP (q90) | 1,360,994 | **0.24x** |

动图**更小**——因为 GIF / WebP 会做帧间压缩（没变的区域直接跳过），
而 spritesheet 是把每一帧完整并排放。因此提醒里**不能**说「文件大」，
那是错的。

真正的代价是**解码占用不可控**：
- 解码量 = 帧数 × 宽 × 高 × 4，两种路线**一样**（像素总数相同）；
- 但 sheet 路线能**分页**（最多 8 页、一次只预取一页，峰值被一页卡住），
  动图是**一个不可分割的解码单元**——浏览器必须把整个动画解出来。
- 实测：480×480 的 120 帧动图 = **105 MiB**，超过我们给单页设的上限。

其次的代价是**色彩**：GIF 只有 256 色。实测小卡（照片写实）的可见像素
PSNR 是 40.2 dB，而 WebP 无损是完美、WebP q95 是 46.2 dB。
"""

import io
import json
import os
import sys

import pytest
from PIL import Image, ImageSequence

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.core.errors import CODE_PACK_FIELD_INVALID  # noqa: E402
from backend.core.pack import (  # noqa: E402
    ANIMATED_FORBIDDEN_FIELDS,
    ANIMATED_WARN_BYTES,
    LAYOUT_ANIMATED,
    animated_warnings,
    decode_bytes,
    from_dict,
)
from backend.core.store import PetStore  # noqa: E402


def _pack(**anims):
    base = {'idle': {'sheet': 'a.png', 'frames': 2}}
    base.update(anims)
    return from_dict({'id': 'anim', 'animations': base})


def _variant(spec):
    return from_dict({'id': 'a', 'animations': {'idle': spec}}).animations['idle'].primary


# ==================================================== 声明与几何

def test_animated_is_not_a_grid():
    """动图容器是 `(1, 1)`——整张图是「一帧」。

    这样下游公式（背景铺法 = 单帧 × 行列数）自然退化成「原样铺满」，
    于是三条切帧排布与容器路线**共用同一套渲染代码**，不必在
    `petview` / `preview` / `panel` 里各加一条 `if (animated)` 分支。
    """
    variant = _variant({'sheet': 'a.gif', 'layout': 'animated'})
    assert variant.layout == LAYOUT_ANIMATED
    assert variant.animated is True
    assert variant.frames == 1
    assert variant.grid == (1, 1)
    assert variant.capacity == 1
    assert variant.page_count == 1


def test_animated_has_no_duration():
    """★ 动图的一轮时长**读不到**（写在文件元数据里），因此返回 0。

    编一个数字出来是最坏的选择：调用方（「播完回 idle」的定时器）
    会按那个假时长去掐，于是动作被提前打断——而作者完全不知道为什么。
    返回 0 让调用方走自己的兜底值。
    """
    variant = _variant({'sheet': 'a.gif', 'layout': 'animated'})
    assert variant.total_ms == 0.0
    assert variant.effective_fps == 0.0


def test_animated_keeps_size():
    """单帧尺寸仍然要能声明：GIF 的逻辑尺寸与它的像素尺寸未必一致。"""
    variant = _variant({'sheet': 'a.gif', 'layout': 'animated',
                        'size': {'w': 320, 'h': 480}})
    assert variant.size == {'w': 320, 'h': 480}


def test_animated_within_variants():
    """动图可以是多套动画里的一套（与帧序列并存，按权重随机抽）。"""
    pack = from_dict({'id': 'a', 'animations': {
        'idle': {'sheet': 'i.png', 'frames': 2},
        'click': {'variants': [
            {'sheet': 'c.gif', 'layout': 'animated', 'weight': 3},
            {'sheet': 'c.png', 'frames': 3, 'fps': 8, 'weight': 1},
        ]},
    }})
    animated, sheet = pack.animations['click'].variants
    assert animated.animated is True
    assert sheet.animated is False
    assert sheet.frames == 3


# ==================================================== 做不到的事要明说

def test_frames_is_rejected():
    """★ 动图不切帧，因此 `frames` 必须报错。

    静默忽略的后果是作者以为「写了 frames 就能控制帧数」，
    于是反复调整却看不出任何变化。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.gif', 'layout': 'animated', 'frames': 4})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'frames' in info.value.user_msg
    # 提示要给出可执行的出路
    assert 'spritesheet' in info.value.hint


@pytest.mark.parametrize('field,value', [
    ('fps', 8), ('frameMs', [100, 100]), ('cols', 2), ('rows', 2), ('loop', False),
])
def test_forbidden_fields_are_rejected(field, value):
    """★ 所有「切帧」相关字段都必须**报错**，而不是静默忽略。

    它们全是做不到的事：动图由浏览器播放，每帧停多久、循环几次
    都写在文件自己的元数据里，插件改不了。
    接受一个做不到的声明比拒绝它更糟——作者会以为它生效了。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.gif', 'layout': 'animated', field: value})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert field in info.value.user_msg


def test_forbidden_field_list_is_complete():
    """字段清单本身要被钉住——漏一个就等于放行一个做不到的声明。"""
    assert set(ANIMATED_FORBIDDEN_FIELDS) == {'fps', 'frameMs', 'cols', 'rows', 'loop'}


def test_every_forbidden_field_actually_errors():
    """★ 逐个验证清单里的每个字段**真的**会报错。

    上一条只检查清单内容，这一条检查行为——两者缺一不可：
    清单对了但校验漏了某个字段，上一条测试照样通过。
    """
    for field in ANIMATED_FORBIDDEN_FIELDS:
        probe = {'sheet': 'a.gif', 'layout': 'animated'}
        probe[field] = {'fps': 8, 'frameMs': [100], 'cols': 2, 'rows': 2, 'loop': True}[field]
        with pytest.raises(Exception) as info:
            _variant(probe)
        assert info.value.code == CODE_PACK_FIELD_INVALID, f'{field} 未报错'


# ==================================================== 往返

def test_animated_round_trips():
    """★ 动图必须能「导出再导入」。

    `to_dict()` 曾经把 `fps: 0` 与 `loop: true` 一起写出来——而它们都在
    禁用清单里，于是**导出再导入直接报错**。这是本次改动自己引入的
    （测试当场抓到），因此这条测试专门钉住它。
    """
    first = _pack(idle={'sheet': 'a.gif', 'layout': 'animated'})
    dumped = first.to_dict()
    entry = dumped['animations']['idle']
    assert entry['layout'] == 'animated'
    # 禁用字段一个都不能出现
    for field in ANIMATED_FORBIDDEN_FIELDS:
        assert field not in entry, f'to_dict 写出了禁用字段 {field}'
    assert 'frames' not in entry, 'to_dict 写出了禁用字段 frames'
    # 真的能读回来
    second = from_dict({'id': dumped['id'], 'animations': dumped['animations']},
                       pack_id=dumped['id'])
    assert second.animations['idle'].primary.animated is True


def test_resolved_variant_omits_forbidden_fields():
    """运行期定义也不该写假值（`fps: 0`、`frames: 1`）——前端会读它们。"""
    resolved = _pack(idle={'sheet': 'a.gif', 'layout': 'animated'}).resolve('idle')
    dumped = resolved.variants[0].to_dict()
    assert dumped['layout'] == 'animated'
    assert dumped['animated'] is True
    for field in ANIMATED_FORBIDDEN_FIELDS:
        assert field not in dumped, f'运行期定义写出了禁用字段 {field}'
    assert 'frames' not in dumped


def test_mixed_variants_round_trip():
    pack = from_dict({'id': 'a', 'animations': {
        'idle': {'sheet': 'i.png', 'frames': 2},
        'click': {'variants': [
            {'sheet': 'c.gif', 'layout': 'animated', 'weight': 3},
            {'sheet': 'c.png', 'frames': 3, 'fps': 8, 'weight': 1},
        ]},
    }})
    dumped = pack.to_dict()
    again = from_dict({'id': 'a', 'animations': dumped['animations']}, pack_id='a')
    flags = [v.animated for v in again.animations['click'].variants]
    assert flags == [True, False]


# ==================================================== 提醒文案

def test_warnings_never_claim_the_file_is_big():
    """★ 提醒里**不能**说「文件大」——实测动图比 sheet 更小。

    同一段动画：spritesheet 5.6 MB vs 动图 GIF 1.25 MB（0.22x）。
    说「动图文件大」是一句与事实相反的话，而用户会因此放弃一条
    其实更省流量的路线。
    """
    warnings = animated_warnings(frames=12, file_bytes=360_144,
                                frame_w=384, frame_h=576)
    text = ' '.join(w['message'] for w in warnings)
    assert '10 MB' in text or '10.1 MB' in text, f'应给出解码占用: {text}'
    # 「文件大」的说法只能在文件**真的**很大时出现（>4 MiB）
    assert '文件本身' not in text, f'360 KB 的文件不该被说成大文件: {text}'


def test_warnings_mention_the_real_cost():
    """真正的代价是「解码占用 + 无法分页」，提醒必须说到这一条。"""
    warnings = animated_warnings(frames=12, file_bytes=360_144,
                                frame_w=384, frame_h=576)
    codes = {w['code'] for w in warnings}
    assert 'animated_no_frame_control' in codes, '应说明失去了逐帧控制'
    text = ' '.join(w['message'] for w in warnings)
    assert '分页' in text, f'应说明动图无法分页（sheet 可以）: {text}'


def test_heavy_warning_above_budget():
    """超过 64 MiB（一张 4096² sheet 的解码量）要升级成 warn。"""
    # 480x480 × 120 帧 = 105 MiB
    warnings = animated_warnings(frames=120, file_bytes=505_491,
                                frame_w=480, frame_h=480)
    heavy = [w for w in warnings if w['code'] == 'animated_heavy']
    assert heavy, f'105 MiB 应触发警告: {warnings}'
    assert heavy[0]['level'] == 'warn'
    assert '105' in heavy[0]['message'] or '104' in heavy[0]['message']
    # 而且要说清「无法分页」这个真正的区别
    assert '分页' in heavy[0]['message']


def test_light_warning_below_budget():
    """低于阈值仍然是 info（不该把所有动图都标成危险）。"""
    warnings = animated_warnings(frames=12, file_bytes=360_144,
                                frame_w=384, frame_h=576)
    assert all(w['level'] == 'info' for w in warnings)
    assert decode_bytes(12, 384, 576) < ANIMATED_WARN_BYTES


def test_static_image_gets_no_animated_warnings():
    """静态图（1 帧）不该出现「动图」相关的提醒。"""
    warnings = animated_warnings(frames=1, file_bytes=1000, frame_w=64, frame_h=64)
    codes = {w['code'] for w in warnings}
    assert 'animated_no_frame_control' not in codes
    assert 'animated_heavy' not in codes


def test_large_file_warning():
    warnings = animated_warnings(frames=60, file_bytes=6 * 1024 * 1024,
                                frame_w=200, frame_h=200)
    codes = {w['code'] for w in warnings}
    assert 'animated_large_file' in codes


# ==================================================== 存储层：真实动图

def _gif_bytes(frames=12, size=(96, 96), duration=80):
    """造一张真实的多帧 GIF。"""
    out = []
    for i in range(frames):
        im = Image.new('RGBA', size, (0, 0, 0, 0))
        px = im.load()
        cx = int(size[0] * (0.2 + 0.6 * i / max(1, frames - 1)))
        for y in range(size[1]):
            for x in range(size[0]):
                if abs(x - cx) < size[0] // 6:
                    px[x, y] = ((x * 7) % 256, (y * 11) % 256, (i * 20) % 256, 255)
        out.append(im)
    buf = io.BytesIO()
    out[0].save(buf, format='GIF', save_all=True, append_images=out[1:],
                duration=duration, loop=0)
    return buf.getvalue()


def _animated_pet(tmp_path, *, frames=12):
    """建一个含动图动作的形象库，返回 `(store, gif_bytes)`。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    pack_dir = builtin / 'gifpet'
    pack_dir.mkdir(parents=True)

    gif = _gif_bytes(frames=frames)
    (pack_dir / 'idle.gif').write_bytes(gif)
    # 一张静态图给 walk-left（两种路线并存）
    Image.new('RGBA', (96, 96), (200, 30, 30, 255)).save(pack_dir / 'walk.png')
    (pack_dir / 'pet.json').write_text(json.dumps({
        'id': 'gifpet', 'name': '动图测试', 'size': {'w': 96, 'h': 96},
        'animations': {
            'idle': {'sheet': 'idle.gif', 'layout': 'animated'},
            'walk-left': {'sheet': 'walk.png', 'frames': 1},
        },
    }, ensure_ascii=False), encoding='utf-8')
    return PetStore(str(user), str(builtin)), gif


def test_runtime_reports_real_frame_count(tmp_path):
    """★ 帧数必须从**文件元数据**读出来（pet.json 里没有这个信息）。

    没有它，插件只能对用户说一句含糊的「资源消耗较大」——
    而那对「我该不该用这个形象」这个决定毫无帮助。
    """
    store, _ = _animated_pet(tmp_path, frames=12)
    entry = store.runtime_pack('gifpet')['actions']['idle']
    assert entry['animated'] is True
    assert entry['animatedFrames'] == 12
    assert entry['layout'] == 'animated'
    assert entry['frames'] == 1
    assert entry['fps'] == 0


def test_runtime_decode_bytes_uses_real_frame_count(tmp_path):
    """解码占用要按**真实帧数**算。

    退化成「按 1 帧算」会把 105 MiB 的动图报成 0.9 MiB——
    那正是用户最需要被提醒的时候。
    """
    store, _ = _animated_pet(tmp_path, frames=12)
    entry = store.runtime_pack('gifpet')['actions']['idle']
    assert entry['decodeBytes'] == decode_bytes(12, 96, 96)
    assert entry['decodeBytes'] > decode_bytes(1, 96, 96)


def test_runtime_carries_warnings(tmp_path):
    store, _ = _animated_pet(tmp_path)
    entry = store.runtime_pack('gifpet')['actions']['idle']
    codes = {w['code'] for w in entry['warnings']}
    assert 'animated_no_frame_control' in codes


def test_static_action_has_no_animated_flag(tmp_path):
    """静态动作不该被误标成动图（那会让面板显示错误的徽章）。"""
    store, _ = _animated_pet(tmp_path)
    entry = store.runtime_pack('gifpet')['actions']['walk-left']
    assert entry['animated'] is False
    assert entry['warnings'] == []


def test_shared_image_counted_once(tmp_path):
    """★ 同一个文件被多个动作共享时，显存**只算一次**。

    `runtime_pack` 输出**整个动作词表**（缺失的动作沿回退链落到 `idle`），
    因此十几个动作常常指向同一个文件。逐动作求和会把同一份解码内存
    数十几遍——实测 12 个动作都回退到同一个 12 帧动图时报出 108 MB，
    而真实占用只有 10.6 MB（差 10 倍）。浏览器按**资源**缓存解码结果，
    因此「按文件去重」才是它的真实语义。
    """
    store, _ = _animated_pet(tmp_path, frames=12)
    pack = store.runtime_pack('gifpet')
    one = decode_bytes(12, 96, 96)
    # idle 是动图（96x96 12 帧），walk-left 是 1 帧静态图
    assert pack['decodeBytes'] == one + decode_bytes(1, 96, 96), (
        f'应只算两个不同的文件，实际 {pack["decodeBytes"]}'
    )
    assert pack['distinctImages'] == 2


def test_animated_actions_listed(tmp_path):
    store, _ = _animated_pet(tmp_path)
    pack = store.runtime_pack('gifpet')
    # idle 是动图；其余动作沿回退链落到 idle，因此它们**也是**动图
    assert 'idle' in pack['animatedActions']
    assert 'walk-left' not in pack['animatedActions']


def test_no_internal_path_leaks(tmp_path):
    """去重用的内部字段不能被发到前端（服务器路径是内部信息）。"""
    store, _ = _animated_pet(tmp_path)
    blob = json.dumps(store.runtime_pack('gifpet'))
    assert '__resolvedPath' not in blob
    assert str(tmp_path).replace('\\', '\\\\') not in blob


def test_animated_frame_count_is_cached(tmp_path):
    """帧数读取要带缓存——它要遍历帧头（实测 120 帧约 10 ms），
    而 `runtime_pack` 每次打开面板都会跑一遍。"""
    store, _ = _animated_pet(tmp_path)
    assert store._animated_cache == {}
    store.runtime_pack('gifpet')
    assert store._animated_cache, '第一次应写入缓存'
    before = dict(store._animated_cache)
    store.runtime_pack('gifpet')
    assert store._animated_cache == before, '第二次不该重算'


# ==================================================== 上传路径

def test_action_override_preserves_animated_gif(tmp_path):
    """★ 给**动图动作**换图时，动图必须原样落盘。

    `process_upload` 会 `load_image`（只取第一帧）再编码成 PNG——
    动图被**静默压成一帧**。而用户上传动图的意图显然是「换成我这个动图」。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    (builtin).mkdir(parents=True)
    (user / 'pets' / 'mine').mkdir(parents=True)
    gif = _gif_bytes(frames=8)
    (user / 'pets' / 'mine' / 'pet.json').write_text(json.dumps({
        'id': 'mine', 'name': 'x', 'size': {'w': 96, 'h': 96},
        'animations': {'idle': {'sheet': 'a.gif', 'layout': 'animated'}},
    }), encoding='utf-8')
    (user / 'pets' / 'mine' / 'a.gif').write_bytes(gif)
    store = PetStore(str(user), str(builtin))

    result = store.save_action_image('mine', 'idle', gif)
    assert result['animated'] is True
    assert result['animatedFrames'] == 8

    path, source = store.resolve_frame_path('mine', 'idle')
    assert source == 'override'
    assert path.endswith('.gif'), f'动图不该被转成 PNG: {path}'
    # 字节完全一致（没有重编码）
    with open(path, 'rb') as handle:
        assert handle.read() == gif, '动图覆盖被重编码了'


def test_static_action_rejects_animated_upload(tmp_path):
    """★ 给**帧序列动作**上传动图 → 报错，而不是静默压成第一帧。

    静默的后果是最难查的一类：用户上传了动图，看到的却是一张不动的图，
    而界面没有任何提示——他会以为插件坏了。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    (builtin).mkdir(parents=True)
    (user / 'pets' / 'mine').mkdir(parents=True)
    (user / 'pets' / 'mine' / 'pet.json').write_text(json.dumps({
        'id': 'mine', 'name': 'x', 'size': {'w': 96, 'h': 96},
        'animations': {'idle': {'sheet': 'a.png', 'frames': 4}},
    }), encoding='utf-8')
    Image.new('RGBA', (384, 96), (10, 20, 30, 255)).save(user / 'pets' / 'mine' / 'a.png')
    store = PetStore(str(user), str(builtin))

    with pytest.raises(Exception) as info:
        store.save_action_image('mine', 'idle', _gif_bytes(frames=6))
    assert '动图' in info.value.user_msg
    # 提示必须给出两条出路
    assert 'animated' in info.value.hint
    assert 'spritesheet' in info.value.hint


def test_static_image_accepted_for_animated_action(tmp_path):
    """反向也允许：给动图动作换一张静态图（作者可能想临时换掉）。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    (builtin).mkdir(parents=True)
    (user / 'pets' / 'mine').mkdir(parents=True)
    (user / 'pets' / 'mine' / 'pet.json').write_text(json.dumps({
        'id': 'mine', 'name': 'x', 'size': {'w': 96, 'h': 96},
        'animations': {'idle': {'sheet': 'a.gif', 'layout': 'animated'}},
    }), encoding='utf-8')
    (user / 'pets' / 'mine' / 'a.gif').write_bytes(_gif_bytes(frames=4))
    store = PetStore(str(user), str(builtin))

    buf = io.BytesIO()
    Image.new('RGBA', (96, 96), (5, 5, 5, 255)).save(buf, format='PNG')
    result = store.save_action_image('mine', 'idle', buf.getvalue())
    assert result['animated'] is False
    assert result['size'] == [96, 96]


def test_create_pet_rejects_animated_upload(tmp_path):
    """★「新建形象」是帧序列通路，收到动图必须**明确拒绝**。

    `prepare_sheet` 会按**宽度**切分上传的图——而一张 GIF 的宽度与
    「几帧」无关，结果是切出一堆错位的小条。产出一个坏掉的形象
    比直接报错糟得多。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    store = PetStore(str(user), str(builtin))

    with pytest.raises(Exception) as info:
        store.create_pet('动图', {'idle': {'data': _gif_bytes(frames=5), 'frames': 1}})
    assert '动图' in info.value.user_msg
    assert '导入形象包' in info.value.hint


def test_import_zip_keeps_animated_gif(tmp_path):
    """导入 zip 时动图必须**原样保留**（`_store_sheet` 对白名单格式不转码）。"""
    import zipfile

    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    store = PetStore(str(user), str(builtin))

    gif = _gif_bytes(frames=10)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('pet.json', json.dumps({
            'id': 'zipped', 'name': 'z', 'size': {'w': 96, 'h': 96},
            'animations': {'idle': {'sheet': 'a.gif', 'layout': 'animated'}},
        }, ensure_ascii=False))
        archive.writestr('a.gif', gif)

    result = store.import_zip(buffer.getvalue())
    entry = result['actions']['idle']
    assert entry['animated'] is True
    assert entry['animatedFrames'] == 10
    path, _ = store.resolve_frame_path('zipped', 'idle')
    with open(path, 'rb') as handle:
        assert handle.read() == gif, '导入时动图被重编码了'


def test_export_import_round_trip_keeps_animated(tmp_path):
    """导出再导入后动图仍然是动图。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    (user / 'pets' / 'mine').mkdir(parents=True)
    gif = _gif_bytes(frames=7)
    (user / 'pets' / 'mine' / 'pet.json').write_text(json.dumps({
        'id': 'mine', 'name': 'x', 'size': {'w': 96, 'h': 96},
        'animations': {'idle': {'sheet': 'a.gif', 'layout': 'animated'}},
    }), encoding='utf-8')
    (user / 'pets' / 'mine' / 'a.gif').write_bytes(gif)
    store = PetStore(str(user), str(builtin))

    data = store.export_pet('mine')
    imported = store.import_zip(data)
    entry = imported['actions']['idle']
    assert entry['animated'] is True
    assert entry['animatedFrames'] == 7
