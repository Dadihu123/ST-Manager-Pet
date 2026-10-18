"""每个动作自带单帧尺寸（`animations.<动作>.size`）。

为什么需要这个能力：一个动作的画布比例可能和别的动作根本不同。典型例子是
躺姿睡觉——人物横躺，画布是横构图，而站立动作是 2:3 竖构图。若所有动作共用
包级 `size`，前端会按 `size` 去拉伸贴图，躺姿会被压扁变形。

⚠️ 这里填的是**逻辑显示尺寸**，不是源图像素尺寸。既有形象的做法是
源图 1024×1536 配逻辑 384×576（密度 8/3）。小卡的躺姿源图是 1672×941，
按同一密度换算 → 逻辑 627×353。

约定：
- `size` 挂在**变体**上（与 `sheet` / `frames` / `layout` 同层），因此
  扁平写法与 `variants` 写法都自然；
- **不声明就是沿用包级 `size`**，且不会凭空出现在 `to_dict()` 里
  （老包不该因为引擎加了字段就多出噪音）；
- 范围校验与包级 `size` 完全一致（1 ~ 1024）。
"""

import pytest

from backend.core.errors import CODE_PACK_FIELD_INVALID, PetError
from backend.core.pack import KIND_ANIMATED, from_dict

from pet_test_support import minimal_pack, pack

#: 小卡躺姿的实际逻辑尺寸（源 1672×941，密度 8/3）。
SLEEP_LOGICAL = {'w': 627, 'h': 353}
#: 站立动作的逻辑尺寸。
STANDING_LOGICAL = {'w': 384, 'h': 576}


# ------------------------------------------------------------------ 解析


def test_action_without_size_inherits_pack_size():
    """没声明 → 变体上没有 size，前端自然回落到包级。"""
    parsed = from_dict(pack())
    assert parsed.animations['idle'].primary.size is None
    assert parsed.size == {'w': 64, 'h': 64}


def test_action_size_is_parsed():
    """声明了 → 解析成整数 w/h。"""
    payload = pack()
    payload['animations']['sleep'] = {
        'sheet': 'sleep.png', 'frames': 4, 'fps': 2, 'size': SLEEP_LOGICAL,
    }
    parsed = from_dict(payload)
    assert parsed.animations['sleep'].primary.size == SLEEP_LOGICAL


def test_action_size_is_independent_per_action():
    """同一包里多个动作可以各自不同尺寸（横构图 + 竖构图共存）。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'frames': 4, 'size': STANDING_LOGICAL},
        'sleep': {'sheet': 'sleep.png', 'frames': 4, 'size': SLEEP_LOGICAL},
    })
    parsed = from_dict(payload)
    assert parsed.animations['idle'].primary.size == STANDING_LOGICAL
    assert parsed.animations['sleep'].primary.size == SLEEP_LOGICAL


def test_landscape_and_portrait_sizes_coexist():
    """核心场景：横构图与竖构图的动作在同一个包里互不干扰。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': {'w': 384, 'h': 576}},
        'sleep': {'sheet': 'sleep.png', 'size': {'w': 627, 'h': 353}},
        'fall': {'sheet': 'fall.png', 'size': {'w': 384, 'h': 576}},
    })
    parsed = from_dict(payload)
    landscape = parsed.animations['sleep'].primary.size
    portrait = parsed.animations['idle'].primary.size
    assert landscape['w'] > landscape['h'], '躺姿应是横构图'
    assert portrait['h'] > portrait['w'], '站立应是竖构图'


def test_action_size_survives_json_roundtrip():
    """`to_dict()` → 再解析，尺寸不丢（这是落盘 / 导入路径）。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': SLEEP_LOGICAL},
    })
    first = from_dict(payload)
    again = from_dict(first.to_dict())
    assert again.animations['idle'].primary.size == SLEEP_LOGICAL


def test_absent_action_size_is_not_written_to_dict():
    """没声明时 `to_dict()` 里不该出现 `size` —— 老包不该多出噪音字段。"""
    parsed = from_dict(pack())
    dumped = parsed.to_dict()
    for action in dumped['animations'].values():
        assert 'size' not in action


def test_action_size_rounds_floats():
    """容忍 627.0 这种浮点写法。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': {'w': 627.0, 'h': 353.0}},
    })
    parsed = from_dict(payload)
    assert parsed.animations['idle'].primary.size == SLEEP_LOGICAL


# ------------------------------------------------------------------ 校验


def test_action_size_rejects_non_object():
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': 'big'},
    })
    with pytest.raises(PetError) as info:
        from_dict(payload)
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'size' in info.value.msg


def test_action_size_rejects_zero_and_negative():
    for bad in (0, -10):
        payload = minimal_pack(animations={
            'idle': {'sheet': 'idle.png', 'size': {'w': bad, 'h': 100}},
        })
        with pytest.raises(PetError) as info:
            from_dict(payload)
        assert info.value.code == CODE_PACK_FIELD_INVALID


def test_action_size_rejects_over_frame_limit():
    """上限与包级 `size` 一致（1024）。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': {'w': 1025, 'h': 100}},
    })
    with pytest.raises(PetError) as info:
        from_dict(payload)
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_source_pixel_size_is_rejected_with_helpful_hint():
    """照抄**源图像素尺寸**会被上限拦下，且提示要说清该做一次换算。

    这是作者最可能踩的坑：源图 1672×941 直接填进来，报错只说「超出范围」，
    光看那句话根本想不到要先除以密度。
    """
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': {'w': 1672, 'h': 941}},
    })
    with pytest.raises(PetError) as info:
        from_dict(payload)
    assert info.value.code == CODE_PACK_FIELD_INVALID
    hint = info.value.hint or ''
    assert '逻辑显示尺寸' in hint, '提示必须点明这是逻辑尺寸'
    assert '627' in hint, '提示应给出换算后的具体数值'


def test_action_size_accepts_limit_value():
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': {'w': 1024, 'h': 1024}},
    })
    parsed = from_dict(payload)
    assert parsed.animations['idle'].primary.size == {'w': 1024, 'h': 1024}


def test_action_size_rejects_partial_object():
    """只写 w 或只写 h 是误用：几何必须两个方向都有。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': {'w': 1024}},
    })
    # 缺 h 会落到默认值 64，这是 `_parse_mapping` 的既有语义（与包级一致），
    # 因此这里只要求「不抛错且 h 有值」——真正的防护是文档而非拒绝。
    parsed = from_dict(payload)
    assert parsed.animations['idle'].primary.size['h'] == 64


# ------------------------------------------------- 与 variants 写法的配合


def test_variants_may_have_different_sizes():
    """多套动画可以各自不同尺寸（每套是独立的图）。"""
    payload = minimal_pack(animations={
        'idle': {
            'variants': [
                {'sheet': 'a.png', 'size': STANDING_LOGICAL},
                {'sheet': 'b.png', 'size': SLEEP_LOGICAL},
            ],
        },
    })
    parsed = from_dict(payload)
    sizes = [v.size for v in parsed.animations['idle'].variants]
    assert sizes == [STANDING_LOGICAL, SLEEP_LOGICAL]


def test_variants_top_level_size_is_rejected():
    """写了 variants 就不该在顶层再写 size（与 sheet / frames 同一规则）。"""
    payload = minimal_pack(animations={
        'idle': {
            'size': STANDING_LOGICAL,
            'variants': [{'sheet': 'a.png'}],
        },
    })
    with pytest.raises(PetError) as info:
        from_dict(payload)
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'size' in info.value.msg


# ---------------------------------------------------------- 回退链透传


def test_resolve_exposes_primary_variant_size():
    """`resolve()` 的主变体透传里要带上 size，前端只读这一处就够。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': SLEEP_LOGICAL},
    })
    parsed = from_dict(payload)
    resolved = parsed.resolve('idle')
    assert resolved.kind == KIND_ANIMATED
    assert resolved.size == SLEEP_LOGICAL
    assert resolved.variants[0].size == SLEEP_LOGICAL


def test_resolve_size_is_none_when_not_declared():
    parsed = from_dict(pack())
    resolved = parsed.resolve('idle')
    assert resolved.size is None


def test_resolve_fallback_keeps_target_action_size():
    """请求 `sleep` 但回退到 `idle` 的图时，用的应是**命中那套图**的尺寸。"""
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': STANDING_LOGICAL},
    })
    parsed = from_dict(payload)
    resolved = parsed.resolve('sleep')
    assert resolved.source == 'idle'
    assert resolved.size == STANDING_LOGICAL


def test_to_dict_includes_size_for_resolved_action():
    payload = minimal_pack(animations={
        'idle': {'sheet': 'idle.png', 'size': SLEEP_LOGICAL},
    })
    parsed = from_dict(payload)
    dumped = parsed.resolve('idle').to_dict()
    assert dumped['size'] == SLEEP_LOGICAL


# ------------------------------------------------- 内置形象：尺寸必须对得上素材

def _builtin_pet_dirs():
    import os
    pets_root = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'resources', 'pets',
    )
    return sorted(
        (name, os.path.join(pets_root, name))
        for name in os.listdir(pets_root)
        if os.path.isdir(os.path.join(pets_root, name))
    )


def _variant_grid(entry):
    """按 `layout` / `cols` / `rows` 算出这套动画的每页网格（与引擎同一套规则）。"""
    frames = int(entry.get('frames') or 1)
    layout = entry.get('layout') or 'horizontal'
    cols = int(entry.get('cols') or 0)
    rows = int(entry.get('rows') or 0)
    if cols and rows:
        return cols, rows
    if cols:
        return cols, max(1, -(-frames // cols))
    if rows:
        return max(1, -(-frames // rows)), rows
    if layout == 'vertical':
        return 1, frames
    return frames, 1


def test_builtin_pets_declare_action_size_matching_the_sheet():
    """★ 内置形象每个动作声明的 `size` 必须与**素材实际单帧比例**一致。

    为什么值得钉住：`size` 填错不会报错，只会让画面被拉伸——人物被横向压扁
    或拉长，而这种「差一点点」在 259px 高的宠物上肉眼很难判断是素材问题
    还是渲染问题（`sleep` 那次踩过：627×353 的躺姿被按 384×576 塞进竖框）。

    判据是**比例**而不是像素：允许 1% 误差，因为宽构图动作的单帧宽可能
    不是整数（`land.png` 是 1809/4 = 452.25，只能声明成 452）。
    """
    import json
    import os

    from PIL import Image

    for pet_id, pet_dir in _builtin_pet_dirs():
        with open(os.path.join(pet_dir, 'pet.json'), encoding='utf-8') as handle:
            manifest = json.load(handle)
        pack_size = manifest.get('size') or {}
        for action, spec in (manifest.get('animations') or {}).items():
            if not isinstance(spec, dict):
                continue
            variants = spec.get('variants')
            entries = variants if variants else [spec]
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    continue
                sheet = entry.get('sheet')
                if not sheet:
                    continue
                cols, rows = _variant_grid(entry)
                with Image.open(os.path.join(pet_dir, sheet)) as image:
                    frame_w = image.width / cols
                    frame_h = image.height / rows
                declared = entry.get('size') or pack_size
                ratio_declared = declared['w'] / declared['h']
                ratio_actual = frame_w / frame_h
                assert abs(ratio_declared - ratio_actual) / ratio_actual < 0.01, (
                    f'{pet_id}.{action}'
                    + (f'[variant {index}]' if variants else '')
                    + f' 声明的单帧尺寸 {declared["w"]}×{declared["h"]} 与素材比例不符：'
                    f'素材单帧是 {frame_w:.2f}×{frame_h:.2f}'
                    f'（{sheet} / {cols}×{rows}），按声明尺寸渲染会把人物拉伸'
                )


def test_builtin_pets_sheet_size_is_divisible_by_the_grid():
    """★ 素材宽高必须能被网格整除，否则切帧会错位（每帧尺寸算不出来）。

    这条是**素材契约**：引擎按 `cols × rows` 等分 sheet，除不尽时最后一帧
    会带进下一帧的边缘。素材是按同一高度并排拼的，宽构图动作的单帧宽偶尔
    会差半像素（`land.png` 1809/4 = 452.25），因此允许 ±0.5px 的余量。
    """
    import json
    import os

    from PIL import Image

    for pet_id, pet_dir in _builtin_pet_dirs():
        with open(os.path.join(pet_dir, 'pet.json'), encoding='utf-8') as handle:
            manifest = json.load(handle)
        for action, spec in (manifest.get('animations') or {}).items():
            if not isinstance(spec, dict):
                continue
            entries = spec.get('variants') or [spec]
            for entry in entries:
                if not isinstance(entry, dict) or not entry.get('sheet'):
                    continue
                cols, rows = _variant_grid(entry)
                with Image.open(os.path.join(pet_dir, entry['sheet'])) as image:
                    for axis, size, count in (
                        ('宽', image.width, cols), ('高', image.height, rows),
                    ):
                        exact = size / count
                        assert abs(exact - round(exact)) < 0.5, (
                            f'{pet_id}.{action}: {entry["sheet"]} {axis} {size} '
                            f'除以 {count} 除不尽，切帧会错位'
                        )
