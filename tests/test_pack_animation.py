"""宠物包格式的**动画节奏**扩展：多套动画（`variants` + `weight`）、
非均匀帧时长（`frameMs`）、idle 的随机触发（`trigger` / `intervalMs` / `plays`）。

这三项对应用户明确提出的第 6、7 项优化，以及第 1 项（idle 不再时刻触发）。

设计上的两条硬约束（都在这里钉住）：
1. **向前兼容**：老包（只有 `sheet` / `frames` / `fps` / `loop`）行为**完全不变**；
2. **写错要能读懂**：非法值给可读错误，而不是静默取默认值或崩掉。
"""

import pytest

from backend.core.pack import (
    DEFAULT_IDLE_MAX_MS,
    DEFAULT_IDLE_MIN_MS,
    DEFAULT_WEIGHT,
    MAX_VARIANTS,
    IDLE_TRIGGER_LOOP,
    IDLE_TRIGGER_RANDOM,
    from_dict,
)
from backend.core.errors import CODE_PACK_FIELD_INVALID
from pet_test_support import minimal_pack


def _pack(**anims):
    base = {'idle': 'idle.png'}
    base.update(anims)
    return from_dict({'id': 'anim', 'animations': base})


# ==================================================== 向后兼容（最重要的一条）


def test_legacy_pack_still_parses_exactly_as_before():
    """★ 老包（没有 variants / frameMs / trigger）行为必须**完全不变**。

    这是整个扩展的前提：已有用户的自建形象与第三方包不能因为这次改动而变样。
    """
    parsed = from_dict({
        'id': 'legacy',
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 4, 'fps': 6, 'loop': True},
            'land': {'sheet': 'land.png', 'frames': 3, 'fps': 12},
        },
    })
    idle = parsed.animations['idle']
    assert idle.frames == 4
    assert idle.fps == 6
    assert idle.loop is True
    assert idle.frame_ms == [], '没写 frameMs 就该是空（按 fps 均匀）'
    assert len(idle.variants) == 1, '老包解析成「一套动画」'
    assert idle.variants[0].weight == DEFAULT_WEIGHT
    assert parsed.animations['land'].loop is False, 'land 仍是默认不循环'

    # 运行期解析结果同样不变
    resolved = parsed.resolve('idle')
    assert resolved.kind == 'animated'
    assert resolved.frames == 4
    assert resolved.fps == 6
    assert resolved.frame_ms == []
    assert len(resolved.variants) == 1
    # 老包没声明 trigger → 默认是 random（新的默认行为）
    assert resolved.idle_trigger.mode == IDLE_TRIGGER_RANDOM


def test_string_shorthand_still_means_single_frame():
    parsed = from_dict(minimal_pack())
    idle = parsed.animations['idle']
    assert idle.sheet == 'idle.png'
    assert idle.frames == 1
    assert len(idle.variants) == 1


# ================================================================ 非均匀帧时长


def test_frame_ms_is_parsed():
    parsed = _pack(idle={
        'sheet': 'idle.png', 'frames': 4, 'frameMs': [400, 300, 300, 600],
    })
    idle = parsed.animations['idle']
    assert idle.frame_ms == [400, 300, 300, 600]
    assert idle.to_dict()['frameMs'] == [400, 300, 300, 600]


def test_frame_ms_length_must_match_frames():
    """长度不符时「第 i 帧停多久」没有定义，因此必须报错而不是猜。"""
    with pytest.raises(Exception) as info:
        _pack(idle={'sheet': 'idle.png', 'frames': 4, 'frameMs': [100, 200]})
    assert 'frameMs' in str(info.value)


def test_frame_ms_single_number_means_uniform():
    """只给一个数是最容易写出的东西，按「每帧都这么久」理解。"""
    parsed = _pack(idle={'sheet': 'idle.png', 'frames': 3, 'frameMs': 200})
    assert parsed.animations['idle'].frame_ms == [200, 200, 200]


def test_frame_ms_rejects_out_of_range():
    """比 60fps 更短的帧在 rAF 下显示不出来；10 秒以上的单帧几乎必然是填错。"""
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'frames': 2, 'frameMs': [1, 100]})
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'frames': 2, 'frameMs': [100, 99999]})


def test_frame_ms_rejects_non_numbers():
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'frames': 2, 'frameMs': ['a', 'b']})
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'frames': 2, 'frameMs': 'fast'})


def test_frame_ms_computes_total_and_effective_fps():
    parsed = _pack(idle={
        'sheet': 'idle.png', 'frames': 4, 'fps': 10, 'frameMs': [400, 300, 300, 600],
    })
    variant = parsed.animations['idle'].variants[0]
    assert variant.total_ms == 1600, '一轮应是逐帧之和'
    # 1600ms / 4 帧 = 平均 2.5fps，而不是声明的 10fps
    assert variant.effective_fps == 2.5


def test_fps_accepts_fractional_values():
    """★ 帧率允许小数：帧数少时整数档太粗（「4 太快、2 太慢」无解）。"""
    parsed = _pack(idle={'sheet': 'idle.png', 'frames': 4, 'fps': 2.5})
    assert parsed.animations['idle'].fps == 2.5
    assert parsed.resolve('idle').fps == 2.5


def test_fps_still_rejects_out_of_range():
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'frames': 4, 'fps': 999})
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'frames': 4, 'fps': 0.01})


def test_frame_ms_and_fps_can_coexist():
    """同时给两者是合理的：`fps` 表达「平均多快」，`frameMs` 表达「怎么分配」。"""
    parsed = _pack(idle={
        'sheet': 'idle.png', 'frames': 4, 'fps': 2.5, 'frameMs': [400, 300, 300, 600],
    })
    variant = parsed.animations['idle'].variants[0]
    assert variant.fps == 2.5
    assert variant.frame_ms == [400, 300, 300, 600]


# ============================================================== 多套动画与权重


def test_variants_are_parsed_with_weights():
    parsed = _pack(click={
        'variants': [
            {'sheet': 'a.png', 'frames': 3, 'weight': 5},
            {'sheet': 'b.png', 'frames': 4, 'weight': 3},
        ],
    })
    click = parsed.animations['click']
    assert len(click.variants) == 2
    assert click.variants[0].weight == 5
    assert click.variants[1].weight == 3
    assert click.variants[1].sheet == 'b.png'
    # 主变体透传（老读法仍然可用）
    assert click.sheet == 'a.png'
    assert click.frames == 3


def test_variants_default_weight_is_one():
    parsed = _pack(click={'variants': [{'sheet': 'a.png'}, {'sheet': 'b.png'}]})
    assert [v.weight for v in parsed.animations['click'].variants] == [1, 1]


def test_variants_weight_is_relative_not_percentage():
    """★ 用户明确要求「用数字、不用百分比」，这样新增动画时不必改动原有数字。

    这里断言的是**解析器保留原始数字**（比例由前端算）：
    两个 5 就是 50/50，再加一个 5 就是各 1/3，原有两个 5 一个字都没改。
    """
    parsed = _pack(click={'variants': [
        {'sheet': 'a.png', 'weight': 5},
        {'sheet': 'b.png', 'weight': 5},
        {'sheet': 'c.png', 'weight': 5},
    ]})
    weights = [v.weight for v in parsed.animations['click'].variants]
    assert weights == [5, 5, 5], '原始数字必须原样保留'


def test_variants_weight_zero_is_allowed():
    """权重 0 = 保留素材但永不随机选中（作者临时停用某套动画的手段）。"""
    parsed = _pack(click={'variants': [
        {'sheet': 'a.png', 'weight': 0},
        {'sheet': 'b.png', 'weight': 5},
    ]})
    assert parsed.animations['click'].variants[0].weight == 0


def test_variants_rejects_negative_weight():
    with pytest.raises(Exception):
        _pack(click={'variants': [{'sheet': 'a.png', 'weight': -1}]})


def test_variants_resolve_exposes_all_variants():
    parsed = _pack(click={'variants': [
        {'sheet': 'a.png', 'frames': 3, 'weight': 5},
        {'sheet': 'b.png', 'frames': 4, 'weight': 3},
    ]})
    resolved = parsed.resolve('click')
    assert resolved.kind == 'animated'
    assert len(resolved.variants) == 2
    assert resolved.variants[0].sheet == 'a.png'
    assert resolved.variants[1].frames == 4
    assert [v.weight for v in resolved.variants] == [5, 3]


def test_variants_mixing_top_level_sheet_is_rejected():
    """顶层再写 sheet 会引出「它算不算一套」的含糊语义，因此明确报错。"""
    with pytest.raises(Exception) as info:
        _pack(click={
            'sheet': 'a.png',
            'variants': [{'sheet': 'b.png'}],
        })
    message = str(info.value)
    assert 'variants' in message and 'sheet' in message


def test_variants_rejects_empty_list():
    with pytest.raises(Exception):
        _pack(click={'variants': []})


def test_variants_rejects_too_many():
    with pytest.raises(Exception):
        _pack(click={'variants': [{'sheet': f'{i}.png'} for i in range(MAX_VARIANTS + 1)]})


def test_variants_accept_string_shorthand():
    """每一套也支持 `"a.png"` 这种最省事的写法。"""
    parsed = _pack(click={'variants': ['a.png', 'b.png']})
    assert len(parsed.animations['click'].variants) == 2
    assert parsed.animations['click'].variants[1].sheet == 'b.png'


def test_variants_accept_per_variant_frame_ms():
    """非均匀帧时长是**每一套**自己的（两套动画的节奏可以完全不同）。"""
    parsed = _pack(click={'variants': [
        {'sheet': 'a.png', 'frames': 3, 'frameMs': [90, 110, 260]},
        {'sheet': 'b.png', 'frames': 2, 'frameMs': [500, 500]},
    ]})
    variants = parsed.animations['click'].variants
    assert variants[0].frame_ms == [90, 110, 260]
    assert variants[1].frame_ms == [500, 500]
    assert variants[0].total_ms == 460
    assert variants[1].total_ms == 1000


def test_variants_bad_sheet_path_is_rejected():
    """每一套的 sheet 都要过路径校验（不能借 variants 绕过安全规则）。"""
    with pytest.raises(Exception):
        _pack(click={'variants': [{'sheet': '../evil.png'}]})
    with pytest.raises(Exception):
        _pack(click={'variants': [{'sheet': 'a.jpg'}]})


def test_variants_missing_sheet_falls_back_to_next_playable():
    """某一套的 sheet 为空（作者临时撤图）不该把整个动作拖成「只位移」。"""
    parsed = _pack(click={'variants': [
        {'sheet': ''},
        {'sheet': 'b.png', 'frames': 4},
    ]})
    resolved = parsed.resolve('click')
    assert resolved.kind == 'animated'
    assert resolved.sheet == 'b.png', '应落到真的有图的那一套'
    assert len(resolved.variants) == 1, '没有图的变体不该出现在可播列表里'


def test_variants_to_dict_round_trips():
    payload = {
        'id': 'rt',
        'animations': {
            'idle': {
                'trigger': 'random', 'intervalMs': [3000, 9000], 'plays': 2,
                'variants': [
                    {'sheet': 'a.png', 'frames': 3, 'fps': 5, 'weight': 5,
                     'frameMs': [100, 100, 200]},
                    {'sheet': 'b.png', 'frames': 2, 'weight': 3},
                ],
            },
        },
    }
    first = from_dict(payload)
    dumped = first.to_dict()
    second = from_dict({
        'id': dumped['id'], 'animations': dumped['animations'],
    }, pack_id=dumped['id'])
    assert len(second.animations['idle'].variants) == 2
    assert second.animations['idle'].variants[0].frame_ms == [100, 100, 200]
    assert second.animations['idle'].variants[1].weight == 3
    assert second.animations['idle'].idle.plays == 2


def test_single_variant_serializes_flat_not_as_variants():
    """单套动画仍写成扁平形式：那是绝大多数包的形态，不该变啰嗦。"""
    parsed = _pack(idle={'sheet': 'idle.png', 'frames': 4, 'fps': 6})
    dumped = parsed.to_dict()['animations']['idle']
    assert 'variants' not in dumped
    assert dumped['sheet'] == 'idle.png'
    assert dumped['frames'] == 4
    assert 'weight' not in dumped, '单套时权重恒为 1，写出来只是噪音'


# ============================================================ idle 的随机触发


def test_idle_defaults_to_random_trigger():
    """★ 默认**不是**一直循环，而是「平时静止、偶尔动一下」。

    用户报障「idle 动画时刻触发看起来有点鬼畜」，这正是修法。
    """
    parsed = _pack(idle={'sheet': 'idle.png', 'frames': 4, 'fps': 6})
    trigger = parsed.animations['idle'].idle
    assert trigger.mode == IDLE_TRIGGER_RANDOM
    assert trigger.min_ms == DEFAULT_IDLE_MIN_MS
    assert trigger.max_ms == DEFAULT_IDLE_MAX_MS
    assert trigger.plays == 1


def test_idle_trigger_can_be_set_to_loop():
    """想回到旧行为的作者可以显式声明 `trigger: "loop"`。"""
    parsed = _pack(idle={
        'sheet': 'idle.png', 'frames': 4, 'trigger': IDLE_TRIGGER_LOOP,
    })
    assert parsed.animations['idle'].idle.mode == IDLE_TRIGGER_LOOP
    assert parsed.resolve('idle').idle_trigger.mode == IDLE_TRIGGER_LOOP


def test_idle_trigger_interval_and_plays_are_parsed():
    parsed = _pack(idle={
        'sheet': 'idle.png', 'frames': 4,
        'trigger': 'random', 'intervalMs': [3000, 9000], 'plays': 3,
    })
    trigger = parsed.animations['idle'].idle
    assert trigger.min_ms == 3000
    assert trigger.max_ms == 9000
    assert trigger.plays == 3


def test_idle_trigger_interval_written_backwards_is_auto_corrected():
    """区间写反了意图明确，直接调正比报错友好。"""
    parsed = _pack(idle={
        'sheet': 'idle.png', 'frames': 4, 'intervalMs': [9000, 3000],
    })
    trigger = parsed.animations['idle'].idle
    assert (trigger.min_ms, trigger.max_ms) == (3000, 9000)


def test_idle_trigger_invalid_mode_is_readable_error():
    with pytest.raises(Exception) as info:
        _pack(idle={'sheet': 'idle.png', 'trigger': 'sometimes'})
    message = str(info.value)
    assert 'trigger' in message
    assert IDLE_TRIGGER_RANDOM in message and IDLE_TRIGGER_LOOP in message, (
        '错误信息要告诉用户有哪些合法取值'
    )


def test_idle_trigger_bad_interval_shape_is_rejected():
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'intervalMs': 5000})
    with pytest.raises(Exception):
        _pack(idle={'sheet': 'idle.png', 'intervalMs': [1, 2, 3]})


def test_only_idle_gets_a_trigger():
    """其余动作由状态机驱动，不该有「随机触发」这回事。"""
    parsed = _pack(
        idle={'sheet': 'idle.png', 'trigger': 'random'},
        click={'sheet': 'click.png', 'frames': 3},
    )
    assert parsed.animations['idle'].idle is not None
    assert parsed.animations['click'].idle is None
    # 非 idle 动作的解析结果里没有 idleTrigger 字段
    assert 'idleTrigger' not in parsed.resolve('click').to_dict()
    assert 'idleTrigger' in parsed.resolve('idle').to_dict()


def test_idle_trigger_follows_the_requested_action_not_the_fallback_source():
    """★ 请求 `look` 却回退到 idle 的图时，它仍是「一次播报」，不是随机小动作。

    否则「张望」会变成随机待机动画，语义就错了。
    """
    parsed = _pack(idle={'sheet': 'idle.png', 'frames': 4, 'trigger': 'random'})
    resolved = parsed.resolve('look')
    assert resolved.source == 'idle', '确实回退到了 idle'
    assert resolved.idle_trigger is None, '但它不是 idle 请求，不该带触发配置'


# ============================================== 内置形象的节奏（防回归）


def test_builtin_pets_have_slower_non_uniform_rhythm():
    """★ 内置形象必须用**非均匀帧时长**且比原来慢。

    用户报障「很多动作默认播放速度太快」。这条把内置形象的节奏钉住，
    避免以后有人「顺手」把它们改回匀速快播。
    """
    import os
    import sys

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, repo_root)
    from backend.core.store import PetStore

    builtin = os.path.join(repo_root, 'resources', 'pets')
    store = PetStore(os.path.join(repo_root, 'data'), builtin)

    for pet_id in ('xiaoman', 'xiaoka'):
        pack = store.load_pack(pet_id)
        # idle 默认随机触发
        assert pack.animations['idle'].idle.mode == IDLE_TRIGGER_RANDOM, pet_id
        # 关键动作都要有非均匀帧时长（这才是「更自然」的落点）
        for action in ('idle', 'walk-left', 'walk-right', 'sleep', 'land', 'click'):
            variant = pack.animations[action].variants[0]
            assert variant.frame_ms, f'{pet_id}.{action} 缺少 frameMs'
            assert len(variant.frame_ms) == variant.frames, f'{pet_id}.{action} 长度不符'
        # idle 至少两套动画（丰富动作数量）
        assert len(pack.animations['idle'].variants) >= 2, f'{pet_id} 的 idle 只有一套动画'
        # 节奏确实比原来慢：原来 idle 是 4 帧 @4fps = 1000ms
        idle = pack.animations['idle'].variants[0]
        assert idle.total_ms > 1000, (
            f'{pet_id} 的 idle 一轮 {idle.total_ms}ms，应比原来的 1000ms 慢'
        )
        # 走路原来 4 帧 @8fps = 500ms
        walk = pack.animations['walk-left'].variants[0]
        assert walk.total_ms > 500, f'{pet_id} 的走路一轮 {walk.total_ms}ms，应放慢'
        # 睡眠原来 4 帧 @3fps ≈ 1333ms
        sleep = pack.animations['sleep'].variants[0]
        assert sleep.total_ms > 1333, f'{pet_id} 的睡眠一轮 {sleep.total_ms}ms，应放慢'
