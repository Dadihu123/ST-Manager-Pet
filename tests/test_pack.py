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
    WALK_DIRECTION_ACTIONS,
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
    assert set(parsed.animations) == {
        'idle', 'walk-left', 'walk-right', 'fall', 'drag', 'land',
    }
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
    assert ACTION_FALLBACKS['drag'] == ('idle',)
    assert ACTION_FALLBACKS['fall'] == ('idle',)
    assert ACTION_FALLBACKS['land'] == ('fall', 'idle')
    assert ACTION_FALLBACKS['sleep'] == ('idle',)
    assert ACTION_FALLBACKS['click'] == ('idle',)
    for name in ('happy', 'sad', 'angry'):
        assert ACTION_FALLBACKS[name] == ('idle',)
    # ★ `look` **不在词表里**（2026-10 删除）。
    #
    # 它曾经在这里，但那个动作**够不着**：播报类动作由 `REACT_ACTIONS`
    # 白名单把关（只有 happy/sad/angry/click），其余动作名都由状态机按状态
    # 算出来——没有任何路径能进入 `look`。而「张望」这个画面本身是
    # `idle` 的第二套，因此删掉这个声明、把图按 idle 第二套留下。
    assert 'look' not in ACTION_FALLBACKS, 'look 已删除，不该再出现在词表里'
    # 唯一硬必要动作
    assert REQUIRED_ACTIONS[0] == 'idle'
    # 行走**只有方向化动作**：两侧都没有就退到 idle（不是正面 walk）
    assert ACTION_FALLBACKS['walk-left'] == ('idle',)
    assert ACTION_FALLBACKS['walk-right'] == ('idle',)
    assert WALK_DIRECTION_ACTIONS == {
        'walk-left': 'walk-right',
        'walk-right': 'walk-left',
    }


def test_frontal_walk_is_not_in_the_vocabulary():
    """★ 正面 `walk` 已从词表里删除（2026-10）。

    正面行走图看起来是「原地踏步 + 平移」，与水平移动的语义不符；
    内置形象（小满 / 小卡）都只出方向化贴图。这里把它钉成回归保护：
    谁再往词表里加回 `walk`，这条测试会拦住。
    """
    assert 'walk' not in ACTION_FALLBACKS, '行走只认 walk-left / walk-right'
    # 「行走」这项需求仍然存在（`missing_required` 里报的是代号 `walk`）
    assert 'walk' in REQUIRED_ACTIONS


# ------------------------------------------------------ 方向化行走（walk-left/right）


def _directional_pack(**anims):
    base = {'idle': {'sheet': 'idle.png'}}
    base.update(anims)
    return from_dict({'id': 'dir', 'animations': base})


def test_walk_direction_both_sides_use_their_own_sheet():
    parsed = _directional_pack(**{
        'walk-left': {'sheet': 'wl.png', 'frames': 4},
        'walk-right': {'sheet': 'wr.png', 'frames': 4},
    })
    left = parsed.resolve('walk-left')
    right = parsed.resolve('walk-right')
    assert left.source == 'walk-left'
    assert left.sheet == 'wl.png'
    assert left.mirror is False, '自己那一侧不该镜像'
    assert right.source == 'walk-right'
    assert right.sheet == 'wr.png'
    assert right.mirror is False


def test_walk_direction_missing_side_mirrors_the_other():
    """★ 只提供一侧时，另一侧镜像复用——这是「可只设置一个」的落点。"""
    parsed = _directional_pack(**{
        'walk-left': {'sheet': 'wl.png', 'frames': 4},
    })
    # 有的一侧：正常播，不镜像
    left = parsed.resolve('walk-left')
    assert left.source == 'walk-left'
    assert left.mirror is False
    # 缺的一侧：仍解析到左侧贴图，但标记需要镜像
    right = parsed.resolve('walk-right')
    assert right.source == 'walk-left'
    assert right.sheet == 'wl.png'
    assert right.mirror is True
    assert right.kind == KIND_ANIMATED
    assert right.note, '镜像复用要给出解释'


def test_walk_direction_falls_back_to_idle_when_no_walk_at_all():
    """两侧都没有行走图 → 两个方向都退到 idle（**没有正面 walk 这一层**）。"""
    parsed = _directional_pack()
    for action, opposite in (('walk-left', 'walk-right'),
                             ('walk-right', 'walk-left')):
        resolved = parsed.resolve(action)
        assert resolved.source == 'idle'
        assert resolved.mirror is False
        assert resolved.kind == KIND_ANIMATED
        # 链路记录「试过哪些」：自己 → 对侧 → idle
        assert resolved.chain == [action, opposite, 'idle']


def test_frontal_walk_sheet_is_ignored_by_walking_actions():
    """旧式形象给的正面 `walk` 图**不再被行走采纳**（动作已退役）。

    词表外的动作名仍会被解析（向前兼容），但它不在回退链上，
    因此 `walk-left` / `walk-right` 走的是 → `idle`。
    """
    parsed = _directional_pack(**{'walk': {'sheet': 'w.png', 'frames': 6}})
    for action in ('walk-left', 'walk-right'):
        resolved = parsed.resolve(action)
        assert resolved.source == 'idle', f'{action} 不该再回退到正面 walk'
        assert resolved.sheet == 'idle.png'
        assert resolved.mirror is False
    # 包自己声明的 `walk` 仍然可解析（词表外动作的向前兼容）
    assert parsed.resolve('walk').source == 'walk'


def test_directional_walk_satisfies_the_walk_requirement():
    """★ 只给侧视行走的形象不该被误报「缺少行走」。"""
    parsed = _directional_pack(**{
        'walk-left': {'sheet': 'wl.png', 'frames': 4},
        'drag': {'sheet': 'd.png'},
        'fall': {'sheet': 'f.png'},
    })
    assert 'walk' not in parsed.missing_required(), \
        '有 walk-left 就不该报缺少 walk'
    # 完全没有行走动作时仍要报
    bare = _directional_pack(**{
        'drag': {'sheet': 'd.png'},
        'fall': {'sheet': 'f.png'},
    })
    assert 'walk' in bare.missing_required()


def test_mirror_flag_is_json_safe_and_round_trips():
    parsed = _directional_pack(**{'walk-left': {'sheet': 'wl.png', 'frames': 4}})
    payload = parsed.resolve('walk-right').to_dict()
    assert payload['mirror'] is True
    assert payload['source'] == 'walk-left'
    # 必须能直接 json 序列化（要经 HTTP 给前端）
    assert json.loads(json.dumps(payload))['mirror'] is True


def test_walk_actions_never_get_mirror_flag_on_a_full_pack():
    """两侧都自己画了行走图的形象，任何动作都不该带 mirror=True。"""
    parsed = from_dict(pack())
    for action in ACTION_FALLBACKS:
        assert parsed.resolve(action).mirror is False, action


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
    for action in ('happy', 'sad', 'angry', 'sleep', 'click', 'land'):
        assert parsed.resolve(action).kind == KIND_ANIMATED


def test_missing_required_action_degrades_to_static():
    """「必要动作」缺失时**不报错**，而是退化为静态位移（只移动、不播帧）。"""
    parsed = from_dict(pack(animations={
        'idle': {'sheet': 'idle.png', 'frames': 2, 'fps': 6},
    }))
    for action in ('walk-left', 'walk-right', 'drag', 'fall'):
        resolved = parsed.resolve(action)
        assert resolved.kind == KIND_ANIMATED, '有 idle 时仍应播 idle 帧'
        assert resolved.source == 'idle'


def test_action_declared_without_sheet_is_static():
    """声明了动作但 sheet 为空 → 只位移不播帧（静态降级）。"""
    parsed = from_dict({'id': 'x', 'animations': {
        'idle': {'sheet': 'idle.png', 'frames': 2, 'fps': 6},
        'walk-left': {'sheet': '', 'frames': 1, 'fps': 6},
    }})
    resolved = parsed.resolve('walk-left')
    # walk-left 自身存在但没 sheet，回退链继续往下找到有 sheet 的 idle
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
        from_dict({'id': 'x', 'animations': {'walk-left': {'sheet': 'wl.png'}}})
    error = info.value
    assert error.code == CODE_PACK_IDLE_MISSING
    # 错误信息要说清「当前有什么」，用户才知道怎么改
    assert 'walk-left' in error.user_msg
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


# ---------------------------------------------------- 倍率 / 渲染方式（新增）


def test_scale_defaults_to_one_when_omitted():
    parsed = from_dict(minimal_pack())
    assert parsed.scale == 1.0


def test_scale_can_be_declared_by_the_pack():
    """★ 包可以声明「我这个形象适合多大」——真人立绘与像素猫的观感尺寸不同。"""
    parsed = from_dict(minimal_pack(scale=0.4))
    assert parsed.scale == 0.4
    assert parsed.to_dict()['scale'] == 0.4


def test_scale_out_of_range_is_rejected():
    with pytest.raises(PetError) as info:
        from_dict(minimal_pack(scale=99))
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'scale' in info.value.msg


def test_scale_must_be_a_number():
    with pytest.raises(PetError):
        from_dict(minimal_pack(scale='big'))


def test_pixelated_defaults_to_false():
    """★ 默认**平滑插值**：写实插画放大时硬边会出现块状锯齿。"""
    assert from_dict(minimal_pack()).pixelated is False


def test_pixelated_can_be_declared_by_the_pack():
    parsed = from_dict(minimal_pack(pixelated=True))
    assert parsed.pixelated is True
    assert parsed.to_dict()['pixelated'] is True


def test_pixelated_must_be_boolean():
    with pytest.raises(PetError) as info:
        from_dict(minimal_pack(pixelated='yes'))
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'pixelated' in info.value.msg


def test_non_square_frame_size_is_accepted():
    """★ 形象不必是正方形（真人立绘常见 2:3 / 3:4）。"""
    parsed = from_dict(minimal_pack(size={'w': 300, 'h': 450}))
    assert parsed.size == {'w': 300, 'h': 450}


def test_frame_size_limits_are_independent_per_axis():
    """宽与高**各自**判定：一个很宽但很矮的条状形象也合法。"""
    parsed = from_dict(minimal_pack(size={'w': 1024, 'h': 64}))
    assert parsed.size == {'w': 1024, 'h': 64}


def test_frame_size_beyond_limit_is_rejected():
    with pytest.raises(PetError) as info:
        from_dict(minimal_pack(size={'w': 4096, 'h': 64}))
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'w' in info.value.msg


def test_scale_and_pixelated_are_not_ignored_fields():
    """新字段必须进已知字段表，否则会被记成「忽略的未知字段」。"""
    parsed = from_dict(minimal_pack(scale=1.5, pixelated=True))
    assert 'scale' not in parsed.ignored_fields
    assert 'pixelated' not in parsed.ignored_fields
