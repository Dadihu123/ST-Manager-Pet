"""把设置**写回 `pet.json`**：每动作动画参数 / 物理 / 形象级字段。

用户要求：「pet.json 里面支持了非常多的调节参数，结果界面上没多少能调整的，
这个就不太对了，比如我想调整下不同动作的帧率，每帧之间的间隔，结果发现
没有入口，目前只能去直接修改 pet.json 里面的值，那这个插件支持这么多的
自定义不就白支持了吗」。

写回的核心约束（`_patch_manifest` 保证的三件事）：

1. **保住未知字段**——`pet.json` 是作者的作品，我们无权替他删东西；
2. **写盘前整体校验**——宁可拒绝，也不留下一个自己都读不出来的包；
3. **原子写**——中途失败不留半个文件。
"""

import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, 'tests'))

from backend.core.errors import PetError  # noqa: E402
from backend.core.pack import (  # noqa: E402
    ANIMATION_PATCH_FIELDS,
    MAX_FPS,
    MIN_FPS,
    parse_animation_patch,
    parse_physics_patch,
)
from backend.core.store import PetStore  # noqa: E402
from pet_test_support import write_pack  # noqa: E402


def _store(tmp_path, *, animations=None, **extra):
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    store = PetStore(str(data), str(builtin))
    # `idle` 是**必备**动作，因此额外给的动作要**合并**进去而不是替换掉它
    merged = {'idle': {'sheet': 'idle.png', 'frames': 4, 'fps': 4}}
    merged.update(animations or {})
    payload = {
        'id': 'mine', 'name': 'X', 'size': {'w': 96, 'h': 96},
        'animations': merged,
    }
    payload.update(extra)
    sheets = {'idle.png': 4}
    for node in merged.values():
        sheet = node if isinstance(node, str) else node.get('sheet')
        if isinstance(sheet, str):
            sheets[sheet] = 4
        for variant in (node.get('variants') or []) if isinstance(node, dict) else []:
            if isinstance(variant.get('sheet'), str):
                sheets[variant['sheet']] = 4
    write_pack(store.user_pets_dir(), 'mine', payload=payload, sheets=sheets)
    return store


def _manifest(store, pet_id='mine'):
    with open(os.path.join(store.user_pet_dir(pet_id), 'pet.json'), encoding='utf-8') as handle:
        return json.load(handle)


# ==================================================== 每动作动画参数

def test_edit_action_fps_loop_and_frame_ms(tmp_path):
    """★ 用户点名要的两项：**帧率**与**每帧之间的间隔**。"""
    store = _store(tmp_path)
    store.update_action_animation(
        'mine', 'idle', {'fps': 3, 'loop': False, 'frameMs': [400, 300, 300, 600]},
    )
    node = _manifest(store)['animations']['idle']
    assert node['fps'] == 3.0
    assert node['loop'] is False
    assert node['frameMs'] == [400.0, 300.0, 300.0, 600.0]
    # 写完之后整包必须还能读出来
    pack = store.load_pack('mine')
    assert pack.animations['idle'].primary.fps == 3.0


def test_edit_upgrades_string_form_to_object(tmp_path):
    """字符串写法（`"walk-left": "walk.png"`）要能就地升级成对象。

    否则那种写法**没地方挂参数**——面板会看起来「改上了」而包里没变。
    """
    store = _store(tmp_path, animations={'walk-left': 'walk.png'})
    store.update_action_animation('mine', 'walk-left', {'fps': 8})
    node = _manifest(store)['animations']['walk-left']
    assert node['sheet'] == 'walk.png', '升级不能丢掉原来的图'
    assert node['fps'] == 8.0


def test_edit_targets_the_requested_variant(tmp_path):
    """多套写法只改**指定的那一套**（默认第一套）。"""
    store = _store(tmp_path, animations={
        'sleep': {'variants': [
            {'sheet': 's1.png', 'weight': 1},
            {'sheet': 's2.png', 'weight': 3},
        ]},
    })
    store.update_action_animation('mine', 'sleep', {'weight': 9}, variant=1)
    variants = _manifest(store)['animations']['sleep']['variants']
    assert variants[0]['weight'] == 1, '不该动第 0 套'
    assert variants[1]['weight'] == 9.0


# ==================================================== 多套一起改（面板的选套器）
#
# 用户报障：「目前同一个类型支持绑定多套动作，但是目前的调节项中看不到这个
# 逻辑，只能换图，还有目前只能操作第一套动作的各类参数，以小卡举例，
# 上面显示的第一套权重为 5，第二套为 2，下面只能操作第一套的参数」。
#
# 面板因此加了选套器，并把**改过的几套一起提交**（`patches`）。


def _two_variant_store(tmp_path):
    return _store(tmp_path, animations={
        'sleep': {'variants': [
            {'sheet': 's1.png', 'frames': 4, 'fps': 2.5, 'weight': 5,
             'frameMs': [400, 300, 300, 600]},
            {'sheet': 's2.png', 'frames': 4, 'fps': 2.22, 'weight': 2,
             'frameMs': [500, 400, 400, 500]},
        ]},
    })


def test_patches_change_several_variants_at_once(tmp_path):
    """★ 一次调用改**多套**（面板上切着改了两套，一次保存应当一起生效）。"""
    store = _two_variant_store(tmp_path)
    store.update_action_animation('mine', 'sleep', patches=[
        {'variant': 0, 'patch': {'fps': 4, 'weight': 8}},
        {'variant': 1, 'patch': {'fps': 1.5, 'weight': 3}},
    ])
    variants = _manifest(store)['animations']['sleep']['variants']
    assert variants[0]['fps'] == 4.0 and variants[0]['weight'] == 8.0
    assert variants[1]['fps'] == 1.5 and variants[1]['weight'] == 3.0


def test_patches_are_atomic(tmp_path):
    """★ 一次保存里第 2 套写错时，第 1 套也**不该落盘**。

    否则用户看到「保存失败」却发现改了一半——那是最难解释的状态。
    """
    store = _two_variant_store(tmp_path)
    before = _manifest(store)
    with pytest.raises(PetError):
        store.update_action_animation('mine', 'sleep', patches=[
            {'variant': 0, 'patch': {'fps': 9}},      # 合法
            {'variant': 1, 'patch': {'fps': 999}},    # 越界
        ])
    assert _manifest(store) == before, '失败时不该有任何一套被改动'


def test_patches_reject_bad_shapes(tmp_path):
    """`patch` / `patches` 二选一，两个都不给或都给都要明确报错。"""
    store = _two_variant_store(tmp_path)
    with pytest.raises(PetError):
        store.update_action_animation('mine', 'sleep')
    with pytest.raises(PetError):
        store.update_action_animation(
            'mine', 'sleep', {'fps': 1},
            patches=[{'variant': 0, 'patch': {'fps': 1}}],
        )
    with pytest.raises(PetError):
        store.update_action_animation('mine', 'sleep', patches=[])
    with pytest.raises(PetError):
        store.update_action_animation('mine', 'sleep', patches=[{'variant': 0}])
    with pytest.raises(PetError):
        store.update_action_animation('mine', 'sleep', patches='nope')


def test_single_patch_shape_still_works(tmp_path):
    """反向确认：旧的 `patch` + `variant` 写法照常可用（面板两种都用）。"""
    store = _two_variant_store(tmp_path)
    store.update_action_animation('mine', 'sleep', {'fps': 3}, variant=1)
    variants = _manifest(store)['animations']['sleep']['variants']
    assert variants[0]['fps'] == 2.5, '不该动第 0 套'
    assert variants[1]['fps'] == 3.0


def test_none_deletes_the_field(tmp_path):
    """传 `None` = **删除该字段**（回落默认值），而不是写一个 null 进去。

    写 null 的话 `_read_fps` 会报「应为数字」——包直接读不出来了。
    """
    store = _store(tmp_path)
    store.update_action_animation('mine', 'idle', {'fps': None, 'loop': None})
    node = _manifest(store)['animations']['idle']
    assert 'fps' not in node and 'loop' not in node
    assert store.load_pack('mine') is not None


def test_unknown_field_is_rejected_not_ignored(tmp_path):
    """★ 未知字段**明确报错**，不静默忽略。

    静默忽略的后果：面板看起来「改上了」，而包里的值其实没变——
    那是最难查的一类问题。
    """
    store = _store(tmp_path)
    with pytest.raises(PetError) as info:
        store.update_action_animation('mine', 'idle', {'fpss': 3})
    assert 'fpss' in str(info.value)


def test_action_must_exist(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(PetError) as info:
        store.update_action_animation('mine', 'no-such-action', {'fps': 3})
    assert 'no-such-action' in str(info.value)


# ==================================================== 未知字段与格式必须保住

def test_unknown_top_level_fields_survive_edits(tmp_path):
    """★ `pet.json` 里的**未知字段必须原样保留**。

    读的是原始 dict（不是 `PetPack`），因此作者写的任何东西都还在。
    用 `to_dict()` 重写会把未知字段静默丢掉——那是替作者删东西。
    """
    store = _store(tmp_path, myCustomField={'hello': 'world'}, futureThing=[1, 2, 3])
    store.update_action_animation('mine', 'idle', {'fps': 5})
    store.update_pet_physics('mine', {'gravity': 2000})
    store.update_pet_layout('mine', {'anchor': {'y': 0.9}})
    manifest = _manifest(store)
    assert manifest['myCustomField'] == {'hello': 'world'}
    assert manifest['futureThing'] == [1, 2, 3]


def test_edit_never_writes_a_broken_pack(tmp_path):
    """写盘前必须整体校验：任何让包读不出来的改动都要被**拒绝**。

    这里用一个「帧数与 frameMs 长度不符」的补丁——字段级校验就该拦住它。
    """
    store = _store(tmp_path)
    before = _manifest(store)
    with pytest.raises(PetError):
        store.update_action_animation('mine', 'idle', {'frameMs': [100, 200]})
    assert _manifest(store) == before, '失败时不该改动文件'


def test_builtin_pets_are_read_only(tmp_path):
    """内置形象是随包资源，写回一律拒绝（先「复制为我的形象」再改）。"""
    import shutil

    store = _store(tmp_path)
    shutil.copytree(
        os.path.join(REPO_ROOT, 'resources', 'pets', 'xiaoka'),
        str(tmp_path / 'resources' / 'pets' / 'xiaoka'),
    )
    for call in (
        lambda: store.update_action_animation('xiaoka', 'idle', {'fps': 2}),
        lambda: store.update_pet_physics('xiaoka', {'gravity': 2000}),
        lambda: store.update_pet_layout('xiaoka', {'anchor': {'y': 0.9}}),
    ):
        with pytest.raises(PetError):
            call()


# ==================================================== 物理参数

def test_edit_physics(tmp_path):
    store = _store(tmp_path)
    store.update_pet_physics('mine', {'gravity': 2200, 'walkSpeed': 90})
    node = _manifest(store)['physics']
    assert node['gravity'] == 2200.0
    assert node['walkSpeed'] == 90.0


def test_physics_out_of_range_is_rejected_not_clamped(tmp_path):
    """★ 越界要**报错**而不是静默夹住。

    物理参数调坏了宠物会变得很怪（飞走 / 刹不住），而静默夹住的后果是
    用户填了 99999 却「看起来没反应」——他会以为是插件坏了。
    """
    store = _store(tmp_path)
    with pytest.raises(PetError) as info:
        store.update_pet_physics('mine', {'gravity': 999999})
    assert 'gravity' in str(info.value)
    assert '20000' in str(info.value), '报错要给出合法区间'


def test_physics_unknown_key_is_rejected(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(PetError) as info:
        store.update_pet_physics('mine', {'gravityy': 1})
    assert 'gravityy' in str(info.value)


def test_physics_none_removes_the_key(tmp_path):
    store = _store(tmp_path)
    store.update_pet_physics('mine', {'gravity': 2200})
    store.update_pet_physics('mine', {'gravity': None})
    manifest = _manifest(store)
    # 全删光了就把 physics 整个去掉，别留空对象
    assert 'physics' not in manifest or 'gravity' not in manifest['physics']


# ==================================================== 形象级字段

def test_edit_anchor_and_size(tmp_path):
    store = _store(tmp_path)
    store.update_pet_layout('mine', {'anchor': {'y': 0.95}, 'size': {'h': 128}})
    manifest = _manifest(store)
    assert manifest['anchor']['y'] == 0.95
    assert manifest['size']['h'] == 128
    assert manifest['size']['w'] == 96, '没提到的轴不该被改'


def test_anchor_must_be_zero_to_one(tmp_path):
    """锚点超出 0~1 会让宠物跑到屏幕外——必须拦住。"""
    store = _store(tmp_path)
    with pytest.raises(PetError) as info:
        store.update_pet_layout('mine', {'anchor': {'y': 1.5}})
    assert '0 ~ 1' in str(info.value)


def test_layout_rejects_unknown_keys(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(PetError) as info:
        store.update_pet_layout('mine', {'nonsense': 1})
    assert 'nonsense' in str(info.value)


# ==================================================== 纯解析层

def test_parse_animation_patch_validates_ranges():
    """字段级校验：区间、类型、互斥都在这层挡住。"""
    with pytest.raises(PetError):
        parse_animation_patch('idle', {'fps': MAX_FPS + 1}, frames_hint=4)
    with pytest.raises(PetError):
        parse_animation_patch('idle', {'fps': MIN_FPS / 2}, frames_hint=4)
    with pytest.raises(PetError):
        parse_animation_patch('idle', {'loop': 'yes'}, frames_hint=4)
    with pytest.raises(PetError):
        parse_animation_patch('idle', {'layout': 'diagonal'}, frames_hint=4)
    with pytest.raises(PetError):
        parse_animation_patch('idle', {'weight': 99999}, frames_hint=4)


def test_parse_animation_patch_needs_frame_count_for_frame_ms():
    """`frameMs` 的长度校验需要知道帧数——不知道时应当**明确报错**，
    而不是跳过校验（跳过会让长度不符的数组写进包里，而那个包读不出来）。"""
    with pytest.raises(PetError) as info:
        parse_animation_patch('idle', {'frameMs': [100, 200]})
    assert 'frameMs' in str(info.value)


def test_all_documented_patch_fields_are_accepted():
    """`ANIMATION_PATCH_FIELDS` 里列出的字段都要真的能用（别只写在文档里）。"""
    patch = {
        'frames': 4, 'fps': 6, 'loop': True,
        'frameMs': [100, 200, 300, 400],
        'layout': 'horizontal', 'cols': 4, 'rows': 1,
        'weight': 2,
        'motion': {'breathe': {'amplitude': 0.02, 'periodMs': 3200}},
    }
    assert set(patch) <= set(ANIMATION_PATCH_FIELDS), '有字段没列进白名单'
    cleaned = parse_animation_patch('idle', patch, frames_hint=4)
    assert set(cleaned) == set(patch)


def test_parse_physics_patch_validates_ranges():
    with pytest.raises(PetError):
        parse_physics_patch({'friction': 5})
    with pytest.raises(PetError):
        parse_physics_patch({'gravity': 'heavy'})
    assert parse_physics_patch({'friction': 0.5}) == {'friction': 0.5}


# ==================================================== 动图容器：无意义的字段要挡住
#
# `layout: "animated"` 的动图容器由浏览器直接播放 Gif / WebP，**不切帧**，
# 因此帧率 / 每帧时长 / 循环 / 帧数 / 排布对它全都没有意义。
#
# 为什么必须在**字段级**挡住：放任它写进 `pet.json` 之后，
# `_patch_manifest` 的整体校验（`loads_pack`）会抛一个「整包读不出来」的
# 含糊错误——用户看到的是「保存失败」而不是「帧率对动图没有意义」。
# 实测踩到过：往容器补 `layout: "grid"` 时字段级校验放行，
# 错误直到整体校验才出现。


def _container_store(tmp_path):
    return _store(tmp_path, animations={
        'idle': {'sheet': 'idle.gif', 'layout': 'animated'},
    })


def test_animated_container_rejects_frame_fields(tmp_path):
    """★ 往动图容器写帧率 / 循环 / 帧数 / 排布要**明确报错**。"""
    store = _container_store(tmp_path)
    for label, patch in (
        ('fps', {'fps': 5}),
        ('loop', {'loop': False}),
        ('frames', {'frames': 8}),
        ('frameMs', {'frameMs': [100]}),
        ('layout', {'layout': 'grid', 'cols': 2, 'rows': 2}),
    ):
        with pytest.raises(PetError) as info:
            store.update_action_animation('mine', 'idle', patch)
        assert 'animated' in str(info.value) or '没有意义' in str(info.value), (
            f'{label} 的报错没说清原因: {info.value}'
        )


def test_animated_container_still_allows_weight_and_motion(tmp_path):
    """★ 但**权重**与**呼吸**对容器是有意义的，不能一起挡掉。

    呼吸是 sprite 上的 CSS 变换，与「谁在播」无关；权重决定选哪一套容器。
    （眨眼不行——没有可跳的帧，`_parse_motion(animated=True)` 已经管住了。）
    """
    store = _container_store(tmp_path)
    store.update_action_animation('mine', 'idle', {'weight': 3})
    store.update_action_animation(
        'mine', 'idle',
        {'motion': {'breathe': {'amplitude': 0.02, 'periodMs': 3000}}},
    )
    pack = store.load_pack('mine')
    primary = pack.animations['idle'].primary
    assert primary.layout == 'animated'
    assert primary.motion.enabled, '容器应当能呼吸'


def test_animated_container_blink_is_rejected(tmp_path):
    """容器**不能**眨眼——没有可跳的帧。"""
    store = _container_store(tmp_path)
    with pytest.raises(PetError):
        store.update_action_animation('mine', 'idle', {
            'motion': {'blink': {'frames': [1], 'everyMs': [3000, 7000], 'durationMs': 160}},
        })


def test_frame_pet_still_accepts_frame_fields(tmp_path):
    """反向确认：普通逐帧形象上这些字段**照常可用**。

    （不做这条的话，「挡住容器」的改动可能被写成「谁都不让写」。）
    """
    store = _store(tmp_path)
    store.update_action_animation('mine', 'idle', {
        'fps': 3, 'loop': False, 'frames': 4, 'frameMs': [300, 300, 300, 600],
    })
    node = _manifest(store)['animations']['idle']
    assert node['fps'] == 3.0 and node['loop'] is False
    assert node['frameMs'] == [300.0, 300.0, 300.0, 600.0]


# ==================================================== 多套动画的增删

def _png(width, height, color=(200, 30, 30, 255)):
    """造一张纯色 PNG（测试用，不依赖磁盘上的素材）。"""
    import io as _io
    from PIL import Image as _Image
    buffer = _io.BytesIO()
    _Image.new('RGBA', (width, height), color).save(buffer, format='PNG')
    return buffer.getvalue()


def test_add_variant_upgrades_a_single_variant_action(tmp_path):
    """★ 用户要的入口：**给一个动作加一套动画**。

    「每个动作我可以点击换图来进行动画帧图的更新，但是只能更新啊，
    我如果像增加一套闲置动作，入口在哪里」。

    单套写法（`{"sheet": ..., "frames": ...}`）必须**就地升级**成
    `variants` 数组，而不是被覆盖掉——否则原来那一套就没了。
    """
    store = _store(tmp_path)
    payload = store.add_action_variant('mine', 'idle', _png(192, 96), frames=2, weight=3)
    assert payload['variant'] == 1

    node = _manifest(store)['animations']['idle']
    assert isinstance(node.get('variants'), list), '单套写法应当升级成 variants'
    assert len(node['variants']) == 2
    # 原来那一套还在
    assert node['variants'][0]['sheet'] == 'idle.png'
    assert node['variants'][0]['frames'] == 4
    # 新那一套带上了权重
    assert node['variants'][1]['weight'] == 3.0
    # 新图落在形象目录里（不是 overrides/——那会与第一套打架）
    new_sheet = node['variants'][1]['sheet']
    assert not new_sheet.startswith('overrides/')
    assert os.path.isfile(os.path.join(store.user_pet_dir('mine'), new_sheet))


def test_added_variant_is_playable(tmp_path):
    """加进去的那一套必须**真的能被解析出图**（否则只是写了个名字）。"""
    store = _store(tmp_path)
    store.add_action_variant('mine', 'idle', _png(192, 96), frames=2, weight=2)
    resolved = store.load_pack('mine').resolve('idle')
    assert len(resolved.variants) == 2
    path, source = store.resolve_frame_path('mine', 'idle', variant=1)
    assert path and os.path.isfile(path)
    assert source in ('pack', 'builtin')


def test_add_variant_rejects_animated_upload(tmp_path):
    """帧序列动作不接受动图（两条路线互斥，静默压成一帧是最难查的）。"""
    store = _store(tmp_path)
    import io as _io
    from PIL import Image as _Image
    buffer = _io.BytesIO()
    frames = [_Image.new('RGBA', (32, 32), (i * 60, 0, 0, 255)) for i in range(3)]
    frames[0].save(buffer, format='GIF', save_all=True, append_images=frames[1:], duration=100)
    with pytest.raises(PetError) as info:
        store.add_action_variant('mine', 'idle', buffer.getvalue(), frames=3)
    assert '动图' in str(info.value)


def test_remove_variant_keeps_at_least_one(tmp_path):
    """至少保留一套：全删掉这个动作就没有动画了。"""
    store = _store(tmp_path)
    store.add_action_variant('mine', 'idle', _png(192, 96), frames=2)
    store.remove_action_variant('mine', 'idle', 1)
    assert len(_manifest(store)['animations']['idle']['variants']) == 1
    with pytest.raises(PetError) as info:
        store.remove_action_variant('mine', 'idle', 0)
    assert '只有一套' in str(info.value)


def test_remove_variant_deletes_the_now_unused_image(tmp_path):
    """删掉一套之后，那张不再被引用的图要一并删掉（否则留下孤儿文件）。"""
    store = _store(tmp_path)
    store.add_action_variant('mine', 'idle', _png(192, 96), frames=2)
    node = _manifest(store)['animations']['idle']
    orphan = node['variants'][1]['sheet']
    store.remove_action_variant('mine', 'idle', 1)
    assert not os.path.exists(os.path.join(store.user_pet_dir('mine'), orphan))


# ==================================================== 多页（拆页 / 合并）

def _vertical_store(tmp_path, frames=4):
    """一个竖排 4 帧的形象，每帧一个颜色——用来验证帧序没被拆乱。"""
    from PIL import Image as _Image
    store = _store(
        tmp_path,
        animations={'idle': {
            'sheet': 'idle.png', 'frames': frames, 'layout': 'vertical',
        }},
    )
    colors = [(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255), (255, 255, 0, 255)]
    image = _Image.new('RGBA', (96, 96 * frames))
    for index in range(frames):
        image.paste(_Image.new('RGBA', (96, 96), colors[index]), (0, index * 96))
    image.save(os.path.join(store.user_pet_dir('mine'), 'idle.png'))
    return store, colors


def _frame_colors(store, pet_id='mine', action='idle', variant=0):
    """按**播放顺序**把每一帧的中心像素取出来（真正验帧序）。"""
    from PIL import Image as _Image
    from backend.core.pack import frame_page
    one = store.load_pack(pet_id).animations[action].variants[variant]
    grid = (one.cols, one.rows)
    out = []
    for index in range(one.frames):
        page, _local, col, row = frame_page(index, grid, one.frames)
        path, _source = store.resolve_frame_path(pet_id, action, variant=variant, page=page)
        assert path, f'第 {index} 帧没有图（拆页时丢帧了）'
        image = _Image.open(path).convert('RGBA')
        fw, fh = image.width // one.cols, image.height // one.rows
        out.append(image.getpixel((col * fw + fw // 2, row * fh + fh // 2)))
    return out


def test_split_pages_preserves_frame_order(tmp_path):
    """★ 用户问「多页的入口在哪里」——这是拆页的核心保证：**帧序不变**。

    拆页唯一的用途是降低解码峰值显存，观感必须完全一样。
    判据不看「页数对不对」，而是**按播放顺序逐帧取像素**——页数对了但
    帧序错乱是最坏的结果（动画会跳着播）。
    """
    store, colors = _vertical_store(tmp_path)
    assert _frame_colors(store) == colors

    result = store.split_action_variant_pages('mine', 'idle', 2)
    assert result['pages'] == 2 and result['perPage'] == 2
    one = store.load_pack('mine').animations['idle'].variants[0]
    assert len(one.sheets) == 2
    assert one.frames == 4, '总帧数不该变'
    assert _frame_colors(store) == colors, '拆页后帧序必须一模一样'


def test_split_pages_refuses_when_already_split(tmp_path):
    """★ 已经拆过页的套**不能**再拆（会丢帧）。

    踩过的坑：不做这层判断时，`resolve_frame_path` 只给出第 0 页那张图，
    于是拆出来的是「第 0 页的一半」，而 `sheets` 被替换成那两张——
    **其余几页的帧静默消失**，`frames` 却还写着总数。
    """
    store, _colors = _vertical_store(tmp_path)
    store.split_action_variant_pages('mine', 'idle', 2)
    with pytest.raises(PetError) as info:
        store.split_action_variant_pages('mine', 'idle', 4)
    assert '已经是 2 页' in str(info.value)
    # 而且确实没有把帧弄丢
    assert _frame_colors(store) == [(255, 0, 0, 255), (0, 255, 0, 255),
                                    (0, 0, 255, 255), (255, 255, 0, 255)]


def test_merge_pages_back_to_one(tmp_path):
    """合并回一页：帧序不变，且旧的页文件被清掉（不留孤儿）。"""
    store, colors = _vertical_store(tmp_path)
    store.split_action_variant_pages('mine', 'idle', 2)
    store.split_action_variant_pages('mine', 'idle', 1)

    one = store.load_pack('mine').animations['idle'].variants[0]
    assert len(one.sheets) == 1
    assert _frame_colors(store) == colors
    left = sorted(
        name for name in os.listdir(store.user_pet_dir('mine')) if name.endswith('.png')
    )
    assert left == ['idle.png'], f'页文件该被清掉，实际剩下 {left}'


def test_split_pages_rejects_impossible_counts(tmp_path):
    """页数超过帧数 / 帧数除不尽时明确拒绝，而不是产出一个坏包。"""
    store, _colors = _vertical_store(tmp_path)
    with pytest.raises(PetError) as info:
        store.split_action_variant_pages('mine', 'idle', 8)
    assert '拆不成' in str(info.value)


def test_split_pages_rejects_an_override_image(tmp_path):
    """「换图」上传的覆盖只作用于第一套第 0 页，拆页会与它打架 → 明确拒绝。"""
    store, _colors = _vertical_store(tmp_path)
    store.save_action_image('mine', 'idle', _png(96, 384))
    with pytest.raises(PetError) as info:
        store.split_action_variant_pages('mine', 'idle', 2)
    assert '覆盖' in str(info.value)


def test_merge_pages_keeps_images_shared_with_other_actions(tmp_path):
    """★ 合并页时**不能**删掉别的动作还在用的图。

    踩过的坑：内置形象的 12 个动作**共用同一对页文件**（`idle-0.png` /
    `idle-1.png`）。第一版合并 idle 时无条件删掉「不再被这一套引用」的旧页，
    于是 walk-left / fall 等动作还在用的 `idle-1.png` 被一起删了——
    包立刻变成坏的（`pet.json` 里还写着它，磁盘上却没有），
    而那些动作在播放时会取到空图。
    """
    store, _colors = _vertical_store(tmp_path)
    # 再造一个动作，与 idle **共用**同一张图
    store.update_action_animation('mine', 'idle', {})  # 确保 idle 已归一化
    manifest_path = os.path.join(store.user_pet_dir('mine'), 'pet.json')
    with open(manifest_path, encoding='utf-8') as handle:
        manifest = json.load(handle)
    manifest['animations']['fall'] = {
        'sheet': 'idle.png', 'frames': 4, 'layout': 'vertical',
    }
    with open(manifest_path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False)

    store.split_action_variant_pages('mine', 'idle', 2)
    # 现在 idle 用 idle-p0/p1，而 fall 仍引用 idle.png —— 它必须还在
    assert os.path.isfile(os.path.join(store.user_pet_dir('mine'), 'idle.png')), \
        'fall 还在引用 idle.png，不该被删'
    # fall 仍然解析得出图
    path, _source = store.resolve_frame_path('mine', 'fall')
    assert path and os.path.isfile(path)

    # 合并回一页时同理：idle-p0/p1 若还被别的动作引用就不能删
    manifest['animations']['fall'] = {
        'sheets': ['idle-p0.png', 'idle-p1.png'], 'frames': 4, 'layout': 'vertical',
    }
    with open(manifest_path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False)
    store.split_action_variant_pages('mine', 'idle', 1)
    for page in ('idle-p0.png', 'idle-p1.png'):
        assert os.path.isfile(os.path.join(store.user_pet_dir('mine'), page)), \
            f'fall 还在引用 {page}，不该被删'
