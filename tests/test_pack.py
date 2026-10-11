"""宠物包格式解析 + 动作回退链（§3.2 / §3.3）。

这一层是纯逻辑，测试直接喂 dict / JSON 文本，不需要 DOM 也不需要宿主。
"""

import json
import os

import pytest

from backend.core.errors import (
    CODE_PACK_ANIMATION_MISSING,
    CODE_PACK_FIELD_INVALID,
    CODE_PACK_IDLE_MISSING,
    CODE_PACK_JSON_INVALID,
    CODE_PACK_SHEET_MISSING,
    CODE_PACK_UNREADABLE,
    PetError,
)
from backend.core.pack import (
    ACTION_FALLBACKS,
    KIND_ANIMATED,
    KIND_STATIC,
    REQUIRED_ACTIONS,
    PetPack,
    from_dict,
    load_file,
    loads,
)
from pet_test_support import FULL_PACK, minimal_pack, pack, write_pack


# ------------------------------------------------------------------ 完整包


def test_full_pack_parses_all_fields():
    parsed = from_dict(pack())
    assert parsed.id == 'test-pet'
    assert parsed.name == '测试宠物'
    assert parsed.author == 'tests'
    assert parsed.size == {'w': 64, 'h': 64}
    assert parsed.anchor == {'x': 0.5, 'y': 1.0}
    assert parsed.physics['gravity'] == 1800
    assert parsed.physics['friction'] == 0.02
    assert set(parsed.animations) == {'idle', 'walk', 'fall', 'drag', 'land'}
    assert parsed.missing_required() == []


def test_full_pack_animation_fields():
    parsed = from_dict(pack())
    idle = parsed.animations['idle']
    assert idle.sheet == 'idle.png'
    assert idle.frames == 4
    assert idle.fps == 6
    assert idle.loop is True
    assert idle.layout == 'horizontal'
    # land 声明了 loop: false
    assert parsed.animations['land'].loop is False


def test_defaults_filled_when_omitted():
    """省略 size / anchor / physics 时用默认值，而不是报错。"""
    parsed = from_dict({'id': 'x', 'animations': {'idle': 'idle.png'}})
    assert parsed.size == {'w': 64, 'h': 64}
    assert parsed.anchor == {'x': 0.5, 'y': 1.0}
    assert parsed.physics['gravity'] == 1800
    assert parsed.physics['terminalVelocity'] == 2400


# ------------------------------------------------------------ 回退链（契约）


def test_fallback_table_matches_contract():
    """§3.3 的动作词表与回退链是**契约**，逐条固定下来。"""
    assert ACTION_FALLBACKS['idle'] == ()
    assert ACTION_FALLBACKS['walk'] == ('idle',)
    assert ACTION_FALLBACKS['drag'] == ('idle',)
    assert ACTION_FALLBACKS['fall'] == ('idle',)
    assert ACTION_FALLBACKS['land'] == ('fall', 'idle')
    assert ACTION_FALLBACKS['sleep'] == ('idle',)
    assert ACTION_FALLBACKS['click'] == ('idle',)
    for name in ('happy', 'sad', 'angry', 'look'):
        assert ACTION_FALLBACKS[name] == ('idle',)
    # 唯一硬必要动作
    assert REQUIRED_ACTIONS[0] == 'idle'


def test_single_frame_pack_resolves_every_action_to_idle():
    """只有 idle 的包：**所有**动作都能解析，且都落到 idle。"""
    parsed = from_dict(minimal_pack())
    for action in ACTION_FALLBACKS:
        resolved = parsed.resolve(action)
        assert resolved.source == 'idle', f'{action} 未回退到 idle'
        assert resolved.kind == KIND_ANIMATED
        assert resolved.sheet == 'idle.png'
        # 若非 idle 本身，应给出解释性 note
        if action != 'idle':
            assert resolved.note, f'{action} 缺少回退说明'


def test_land_falls_back_to_fall_then_idle():
    """`land` 的回退链是 fall → idle：有 fall 时用 fall，不直接跳 idle。"""
    parsed = from_dict(pack(animations={
        'idle': {'sheet': 'idle.png', 'frames': 2, 'fps': 6},
        'fall': {'sheet': 'fall.png', 'frames': 3, 'fps': 8},
    }))
    resolved = parsed.resolve('land')
    assert resolved.source == 'fall'
    assert resolved.sheet == 'fall.png'
    assert resolved.chain == ['land', 'fall', 'idle']


def test_missing_optional_action_uses_idle_not_error():
    """缺可选动作 → 回退，不是错误。"""
    parsed = from_dict(pack(animations={
        'idle': {'sheet': 'idle.png', 'frames': 2, 'fps': 6},
    }))
    for action in ('happy', 'sad', 'angry', 'sleep', 'click', 'look', 'land'):
        assert parsed.resolve(action).kind == KIND_ANIMATED


def test_missing_required_action_degrades_to_static():
    """「必要动作」缺失时**不报错**，而是退化为静态位移（只移动、不播帧）。"""
    parsed = from_dict(pack(animations={
        'idle': {'sheet': 'idle.png', 'frames': 2, 'fps': 6},
    }))
    for action in ('walk', 'drag', 'fall'):
        resolved = parsed.resolve(action)
        assert resolved.kind == KIND_ANIMATED, '有 idle 时仍应播 idle 帧'
        assert resolved.source == 'idle'


def test_action_declared_without_sheet_is_static():
    """声明了动作但 sheet 为空 → 只位移不播帧（静态降级）。"""
    parsed = from_dict({'id': 'x', 'animations': {
        'idle': {'sheet': 'idle.png', 'frames': 2, 'fps': 6},
        'walk': {'sheet': '', 'frames': 1, 'fps': 6},
    }})
    resolved = parsed.resolve('walk')
    # walk 自身存在但没 sheet，回退链继续往下找到有 sheet 的 idle
    assert resolved.source == 'idle'
    assert resolved.kind == KIND_ANIMATED


def test_idle_without_sheet_is_static():
    """连 idle 都没有 sheet → static（连帧都不播，但仍可显示占位）。"""
    parsed = from_dict({'id': 'x', 'animations': {'idle': {'sheet': ''}}})
    resolved = parsed.resolve('idle')
    assert resolved.kind == KIND_STATIC
    assert resolved.note


def test_unknown_action_name_falls_back_to_idle_without_error():
    """向前兼容：包里有新动作名、或调用方请求新动作名，都不报错。"""
    parsed = from_dict(minimal_pack())
    resolved = parsed.resolve('teleport')
    assert resolved.source == 'idle'
    assert resolved.kind == KIND_ANIMATED


def test_pack_can_declare_unknown_actions():
    """包声明了词表外的动作 → 保留但不报错（向前兼容）。"""
    parsed = from_dict({'id': 'x', 'animations': {
        'idle': 'idle.png',
        'backflip': {'sheet': 'backflip.png', 'frames': 8, 'fps': 20},
    }})
    assert 'backflip' in parsed.animations
    assert parsed.resolve('backflip').source == 'backflip'


# ------------------------------------------------------------ 连 idle 都没有


def test_no_animations_at_all_is_readable_error():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {}})
    error = info.value
    assert error.code == CODE_PACK_ANIMATION_MISSING
    assert error.user_msg, '必须给出面向用户的说明'
    assert error.hint, '必须给出面向包作者的建议'


def test_missing_idle_is_readable_error_and_names_what_exists():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {'walk': {'sheet': 'walk.png'}}})
    error = info.value
    assert error.code == CODE_PACK_IDLE_MISSING
    # 错误信息要说清「当前有什么」，用户才知道怎么改
    assert 'walk' in error.user_msg
    assert 'idle' in error.hint


# ------------------------------------------------------------------ 畸形输入


def test_malformed_json_raises_structured_error():
    with pytest.raises(PetError) as info:
        loads('{"id": "x", "animations": {"idle": "a.png",}}')  # 尾逗号
    error = info.value
    assert error.code == CODE_PACK_JSON_INVALID
    assert error.user_msg
    assert error.hint
    assert 'Traceback' not in json.dumps(error.to_dict())


def test_non_object_root_is_rejected():
    with pytest.raises(PetError) as info:
        loads('[1, 2, 3]')
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_bytes_with_bad_encoding_is_rejected():
    with pytest.raises(PetError) as info:
        loads(b'\xff\xfe\x00\x00 not utf8')
    assert info.value.code == CODE_PACK_JSON_INVALID
    assert info.value.hint


@pytest.mark.parametrize('value', [64, 'abc', [], True])
def test_size_must_be_object_of_numbers(value):
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'size': value, 'animations': {'idle': 'a.png'}})
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_size_null_is_treated_as_absent():
    """`size: null` 与省略同义（JSON 里「没有值」的常见写法）。"""
    parsed = from_dict({'id': 'x', 'size': None, 'animations': {'idle': 'a.png'}})
    assert parsed.size == {'w': 64, 'h': 64}


def test_frames_must_be_positive_int():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {
            'idle': {'sheet': 'a.png', 'frames': 0},
        }})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'frames' in info.value.msg


def test_frames_rejects_fractional_value():
    with pytest.raises(PetError):
        from_dict({'id': 'x', 'animations': {
            'idle': {'sheet': 'a.png', 'frames': 2.5},
        }})


def test_frames_rejects_absurd_value():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {
            'idle': {'sheet': 'a.png', 'frames': 100000},
        }})
    assert 'frames' in info.value.msg


def test_fps_must_be_in_range():
    with pytest.raises(PetError):
        from_dict({'id': 'x', 'animations': {'idle': {'sheet': 'a.png', 'fps': 999}}})


def test_loop_must_be_boolean():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {
            'idle': {'sheet': 'a.png', 'loop': 'yes'},
        }})
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_physics_out_of_range_is_rejected():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'physics': {'friction': 5}, 'animations': {'idle': 'a.png'}})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'friction' in info.value.msg


def test_physics_must_be_number_not_string():
    with pytest.raises(PetError):
        from_dict({'id': 'x', 'physics': {'gravity': 'fast'}, 'animations': {'idle': 'a.png'}})


def test_animations_must_be_object():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': ['idle.png']})
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_name_must_be_string():
    with pytest.raises(PetError):
        from_dict({'id': 'x', 'name': 123, 'animations': {'idle': 'a.png'}})


# ------------------------------------------------------------------ sheet 安全


@pytest.mark.parametrize('sheet', [
    '../../../etc/passwd.png',
    '..\\..\\windows\\system32\\a.png',
    'sub/../../escape.png',
])
def test_sheet_path_traversal_is_rejected(sheet):
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {'idle': sheet}})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert '..' in info.value.msg or '..' in info.value.hint


@pytest.mark.parametrize('sheet', ['/abs/path.png', 'C:/windows/a.png', 'C:\\a.png'])
def test_sheet_absolute_path_is_rejected(sheet):
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {'idle': sheet}})
    assert info.value.code == CODE_PACK_FIELD_INVALID


@pytest.mark.parametrize('sheet', ['idle.jpg', 'idle.jpeg', 'idle.bmp', 'idle.exe', 'idle'])
def test_sheet_extension_must_be_supported(sheet):
    """`.jpg`/`.jpeg` **不在宿主资产白名单**里，包内也不该出现（§2.5 / §8 陷阱 3）。"""
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {'idle': sheet}})
    error = info.value
    assert error.code == CODE_PACK_FIELD_INVALID
    # 错误信息必须**指名**是哪个扩展名不被接受，用户才知道改哪里
    extension = sheet.rsplit('.', 1)[1] if '.' in sheet else ''
    haystack = f'{error.msg} {error.user_msg} {error.hint}'.lower()
    assert (extension and extension.lower() in haystack) or '扩展名' in haystack
    assert 'png' in haystack or 'webp' in haystack, '应告诉用户换成什么格式'


@pytest.mark.parametrize('sheet', ['idle.png', 'a/b/idle.webp', 'idle.gif', 'idle.avif', 'idle.svg'])
def test_sheet_allowed_extensions_accepted(sheet):
    parsed = from_dict({'id': 'x', 'animations': {'idle': sheet}})
    assert parsed.animations['idle'].sheet == sheet


def test_empty_sheet_is_allowed_as_static():
    """sheet 为空是「显式声明只位移不播帧」，不是错误。"""
    parsed = from_dict({'id': 'x', 'animations': {'idle': {'sheet': ''}}})
    assert parsed.animations['idle'].sheet == ''


def test_non_string_sheet_is_rejected():
    with pytest.raises(PetError):
        from_dict({'id': 'x', 'animations': {'idle': {'sheet': 42}}})


# ------------------------------------------------------------------ 向前兼容


def test_unknown_fields_are_ignored_not_rejected():
    """向前兼容：多出来的字段忽略而不是报错。"""
    payload = pack()
    payload['futureFeature'] = {'nested': [1, 2, 3]}
    payload['anotherOne'] = 'whatever'
    parsed = from_dict(payload)
    assert parsed.id == 'test-pet'
    assert 'anotherOne' in parsed.ignored_fields
    assert 'futureFeature' in parsed.ignored_fields


def test_unknown_animation_fields_are_ignored():
    parsed = from_dict({'id': 'x', 'animations': {
        'idle': {'sheet': 'a.png', 'frames': 2, 'fps': 6, 'glow': True, 'shader3d': 'x'},
    }})
    assert parsed.animations['idle'].frames == 2


def test_higher_format_version_is_accepted():
    """更高的 format 版本号不拒绝（向前兼容优先），但要能读到实际值。"""
    parsed = from_dict(pack(format=99))
    assert parsed.format == 99


def test_format_must_be_integer():
    with pytest.raises(PetError):
        from_dict(pack(format='one'))


# ------------------------------------------------------------------ 便捷写法


def test_string_shorthand_means_single_frame():
    """`"idle": "idle.png"` 这种简写要能用——单帧图最省事的写法。"""
    parsed = from_dict(minimal_pack())
    idle = parsed.animations['idle']
    assert idle.sheet == 'idle.png'
    assert idle.frames == 1
    assert idle.loop is True


def test_one_shot_actions_default_to_non_looping():
    """`land` / `click` 没写 loop 时默认不循环。"""
    parsed = from_dict({'id': 'x', 'animations': {
        'idle': 'a.png',
        'land': {'sheet': 'land.png', 'frames': 3, 'fps': 12},
        'click': {'sheet': 'click.png', 'frames': 2, 'fps': 8},
    }})
    assert parsed.animations['land'].loop is False
    assert parsed.animations['click'].loop is False


def test_layout_vertical_accepted():
    parsed = from_dict({'id': 'x', 'animations': {
        'idle': {'sheet': 'a.png', 'frames': 4, 'layout': 'vertical'},
    }})
    assert parsed.animations['idle'].layout == 'vertical'


def test_layout_invalid_value_rejected():
    with pytest.raises(PetError) as info:
        from_dict({'id': 'x', 'animations': {
            'idle': {'sheet': 'a.png', 'layout': 'diagonal'},
        }})
    assert 'layout' in info.value.msg


# ------------------------------------------------------------------ 文件读取


def test_load_file_reads_real_pack(tmp_path):
    pack_dir = write_pack(tmp_path, 'demo-pet', sheets={'idle.png': 4, 'walk.png': 6})
    parsed = load_file(os.path.join(pack_dir, 'pet.json'))
    assert parsed.id == 'demo-pet'
    assert parsed.animations['idle'].frames == 4


def test_load_file_missing_manifest_is_readable(tmp_path):
    missing = str(tmp_path / 'nope' / 'pet.json')
    with pytest.raises(PetError) as info:
        load_file(missing)
    assert info.value.code == CODE_PACK_UNREADABLE
    assert info.value.http_status == 404
    assert info.value.user_msg


def test_load_file_invalid_utf8_is_readable(tmp_path):
    target = tmp_path / 'pet.json'
    target.write_bytes(b'\xff\xfe\x00garbage')
    with pytest.raises(PetError) as info:
        load_file(str(target))
    assert info.value.code == CODE_PACK_JSON_INVALID
    assert info.value.hint


def test_load_file_utf8_bom_is_accepted(tmp_path):
    """带 BOM 的 UTF-8（Windows 记事本另存为）必须能读——否则用户第一步就卡住。"""
    target = tmp_path / 'pet.json'
    body = json.dumps(minimal_pack(), ensure_ascii=False)
    target.write_bytes(b'\xef\xbb\xbf' + body.encode('utf-8'))
    parsed = load_file(str(target))
    assert parsed.id == 'single-frame'


# ------------------------------------------------------------------ 序列化


def test_to_dict_round_trips_through_json():
    parsed = from_dict(pack())
    dumped = parsed.to_dict()
    assert json.loads(json.dumps(dumped, ensure_ascii=False))['id'] == 'test-pet'
    assert dumped['missingRequired'] == []
    # 再次解析自己导出的结构应等价
    reparsed = from_dict({
        'id': dumped['id'],
        'name': dumped['name'],
        'size': dumped['size'],
        'anchor': dumped['anchor'],
        'physics': dumped['physics'],
        'animations': dumped['animations'],
    }, pack_id=dumped['id'])
    assert reparsed.animations['idle'].frames == parsed.animations['idle'].frames


def test_resolved_action_to_dict_is_json_safe():
    parsed = from_dict(pack(animations={'idle': 'idle.png'}))
    payload = parsed.resolve('land').to_dict()
    assert json.loads(json.dumps(payload, ensure_ascii=False))['source'] == 'idle'


def test_pet_pack_defaults_are_independent_instances():
    """dataclass 的 mutable default 不能共享——否则一个包的修改会污染另一个。"""
    first = PetPack()
    second = PetPack()
    first.physics['gravity'] = 1
    first.animations['idle'] = 'x'
    assert second.physics['gravity'] != 1
    assert second.animations == {}
