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
