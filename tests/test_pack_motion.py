"""程序化运动（T6）：`motion` —— 不增加帧数的连续运动。

它解决什么问题
--------------
帧序列把「动起来」的成本算成「帧数 × 单帧像素」。而呼吸、眨眼这类
**装饰性整体运动**根本不需要那么多帧：一张图 + 一条曲线就能无限平滑。

实测（小卡 idle，真实素材）：现状 4 帧循环的顶边只动 **1px**（4 张图
本来就几乎一样，看起来就是张不动的图）；而 1 帧 + CSS 呼吸能顶边动
**22px** 而脚底不动。也就是说 **1 帧比 4 帧更像活的**。

⚠️ 它**做不了**什么（这是最容易被误解的地方）
-------------------------------------------
整身仿射变换**无法 articulate 四肢**。实测把走路两个关键姿势交叉淡入，
得到的中间帧是**双重曝光**（两条腿叠在一起，RMS 差 28 而非 56 的一半）。
真正的肢体运动需要骨骼绑定或真实的中间帧。
因此 `motion` 的合理范围是**整体运动**（呼吸 / 摇摆 / 眨眼），
不是「自动生成行走循环」。

⚠️ 为什么走 CSS 动画而不是 JS 的 rAF
-----------------------------------
插件的省电契约是「宠物静止时 rAF **真的停掉**」。呼吸是常驻运动，
用 rAF 做就意味着循环永不停止。实测（18005 节点 DOM，交错 3 轮取中位数）：

    CSS @keyframes    3.2 ms/s   ← 合成器上跑，完全不碰主线程
    空 rAF 循环      28.0 ms/s   （什么都不画的地板价）
    rAF + 每帧写样式  49.9 ms/s

便宜一个数量级，而且**不需要 rAF**——省电模型一行都不用改。
"""

import io
import json
import os
import sys

import pytest
from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.core.errors import CODE_PACK_FIELD_INVALID  # noqa: E402
from backend.core.pack import (  # noqa: E402
    BLINK_DURATION_RANGE,
    BLINK_INTERVAL_RANGE,
    BREATHE_AMPLITUDE_RANGE,
    BREATHE_PERIOD_RANGE,
    motion_transform_origin,
    from_dict,
)
from backend.core.store import PetStore  # noqa: E402


def _variant(spec):
    pack = from_dict({'id': 'a', 'animations': {'idle': spec}})
    return pack.animations['idle'].primary


# ==================================================== 解析与几何

def test_breathe_only():
    motion = _variant({'sheet': 'i.png', 'frames': 4,
                       'motion': {'breathe': {'amplitude': 0.02, 'periodMs': 3200}}}).motion
    assert motion is not None
    assert motion.breathes is True
    assert motion.blinks is False
    assert motion.amplitude == 0.02
    assert motion.period_ms == 3200


def test_blink_only():
    motion = _variant({'sheet': 'i.png', 'frames': 4, 'motion': {
        'blink': {'frames': [2, 3], 'everyMs': [3000, 7000], 'durationMs': 160},
    }}).motion
    assert motion.breathes is False
    assert motion.blinks is True
    assert motion.blink_frames == [2, 3]
    assert motion.blink_every_ms == [3000, 7000]
    assert motion.blink_duration_ms == 160


def test_both_together():
    motion = _variant({'sheet': 'i.png', 'frames': 4, 'motion': {
        'breathe': {'amplitude': 0.025, 'periodMs': 3000},
        'blink': {'frames': [1], 'everyMs': [2500, 6000], 'durationMs': 140},
    }}).motion
    assert motion.breathes and motion.blinks


def test_no_motion_is_none():
    """没写 `motion` 时必须是 `None`——前端据此**完全不动样式**。"""
    assert _variant({'sheet': 'i.png', 'frames': 4}).motion is None


def test_motion_is_per_variant():
    """多套动画可以一套呼吸、另一套不动（例如清醒的 idle 与睡着的 idle）。"""
    pack = from_dict({'id': 'a', 'animations': {
        'idle': {'sheet': 'i.png', 'frames': 2},
        'sleep': {'variants': [
            {'sheet': 's.png', 'frames': 2, 'motion': {'breathe': {'amplitude': 0.03, 'periodMs': 5000}}},
            {'sheet': 's2.png', 'frames': 2},
        ]},
    }})
    variants = pack.animations['sleep'].variants
    assert variants[0].motion is not None
    assert variants[1].motion is None


def test_motion_can_apply_to_animated_container():
    """动图容器**可以**呼吸（那是 sprite 上的 CSS 变换，与「谁在播」无关）。"""
    motion = _variant({'sheet': 'a.gif', 'layout': 'animated',
                       'motion': {'breathe': {'amplitude': 0.02, 'periodMs': 3000}}}).motion
    assert motion is not None and motion.breathes


# ==================================================== 做不到的要报错

@pytest.mark.parametrize('amplitude', [0.5, 0.2, 0.001, -0.02, 0])
def test_amplitude_out_of_range_is_rejected(amplitude):
    """★ 幅度越界必须**报错**，不能悄悄夹到范围内。

    作者写 `0.5`（想「明显一点」）而插件按 0.08 处理的话，
    他只会看到「我调了没反应」——这类问题最难查。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4,
                  'motion': {'breathe': {'amplitude': amplitude, 'periodMs': 3200}}})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'amplitude' in info.value.user_msg


def test_amplitude_bounds_are_inclusive():
    low, high = BREATHE_AMPLITUDE_RANGE
    for value in (low, high):
        assert _variant({'sheet': 'i.png', 'frames': 4,
                         'motion': {'breathe': {'amplitude': value, 'periodMs': 3200}}}).motion


@pytest.mark.parametrize('period', [100, 500, 100000])
def test_period_out_of_range_is_rejected(period):
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4,
                  'motion': {'breathe': {'amplitude': 0.02, 'periodMs': period}}})
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_missing_period_is_rejected():
    """幅度与周期是**一对**：只写一个等于没写，必须报错。"""
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4, 'motion': {'breathe': {'amplitude': 0.02}}})
    assert 'periodMs' in info.value.user_msg


@pytest.mark.parametrize('spec,field', [
    ({'breathe': {'amplitdue': 0.02, 'periodMs': 3200}}, 'amplitdue'),
    ({'breath': {'amplitude': 0.02, 'periodMs': 3200}}, 'breath'),
    ({'breathe': {'amplitude': 0.02, 'periodMs': 3200, 'ease': 'in'}}, 'ease'),
    ({'blink': {'frames': [1], 'everyMs': [3000, 7000], 'durationMs': 100, 'nope': 1}}, 'nope'),
])
def test_unknown_keys_are_rejected(spec, field):
    """★ `motion` 内部的未知键必须**报错**，不能静默忽略。

    解析器对动画规格里的未知键是静默忽略的（历史行为），因此
    `"amplitdue": 0.02` 这种拼写错误会**静默不生效**——作者只会看到
    「我写了呼吸但它不动」。这正是本项目最想避免的一类问题，
    所以这里对 `motion` 内部的键逐个白名单校验。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4, 'motion': spec})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert field in info.value.user_msg


@pytest.mark.parametrize('frames_list', [[4], [4, 5], [99], [-1]])
def test_blink_frame_out_of_range_is_rejected(frames_list):
    """★ 眨眼帧号越界必须报错。

    不校验的后果：前端跳到不存在的帧 → 背景位移落到 sheet 之外 →
    宠物在眨眼时**凭空消失**一瞬。偶发、一闪而过，最难截图复现。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4, 'motion': {
            'blink': {'frames': frames_list, 'everyMs': [3000, 7000], 'durationMs': 160},
        }})
    assert 'frames' in info.value.user_msg


def test_blink_on_animated_container_is_rejected():
    """动图容器没有「第 n 帧」可跳，因此不能眨眼（但**可以**呼吸）。"""
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.gif', 'layout': 'animated', 'motion': {
            'blink': {'frames': [1], 'everyMs': [3000, 7000], 'durationMs': 160},
        }})
    assert '动图' in info.value.user_msg
    assert 'spritesheet' in info.value.hint


def test_reversed_blink_interval_is_rejected():
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4, 'motion': {
            'blink': {'frames': [1], 'everyMs': [7000, 3000], 'durationMs': 160},
        }})
    assert 'everyMs' in info.value.user_msg


@pytest.mark.parametrize('every', [[100, 200], [100000, 200000], [3000], [3000, 4000, 5000]])
def test_bad_blink_interval_is_rejected(every):
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4, 'motion': {
            'blink': {'frames': [1], 'everyMs': every, 'durationMs': 160},
        }})
    assert info.value.code == CODE_PACK_FIELD_INVALID


@pytest.mark.parametrize('duration', [10, 5000])
def test_bad_blink_duration_is_rejected(duration):
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4, 'motion': {
            'blink': {'frames': [1], 'everyMs': [3000, 7000], 'durationMs': duration},
        }})
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_motion_must_be_object():
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'i.png', 'frames': 4, 'motion': 'yes'})
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_bounds_are_sane():
    """区间本身要被钉住——写反了（low > high）会让所有值都非法。"""
    assert BREATHE_AMPLITUDE_RANGE[0] < BREATHE_AMPLITUDE_RANGE[1]
    assert BREATHE_PERIOD_RANGE[0] < BREATHE_PERIOD_RANGE[1]
    assert BLINK_INTERVAL_RANGE[0] < BLINK_INTERVAL_RANGE[1]
    assert BLINK_DURATION_RANGE[0] < BLINK_DURATION_RANGE[1]


# ==================================================== 往返

def test_motion_round_trips():
    """★ 程序化运动必须能「导出再导入」。

    `to_dict()` 的输出会被 `from_dict()` 再吃一遍（导出再导入正是靠它）。
    写出去的形状读不回来，表现就是「导出再导入后呼吸没了」。
    """
    raw = {'id': 'a', 'animations': {'idle': {'sheet': 'i.png', 'frames': 4, 'motion': {
        'breathe': {'amplitude': 0.025, 'periodMs': 3000},
        'blink': {'frames': [2, 3], 'everyMs': [2500, 6000], 'durationMs': 140},
    }}}}
    first = from_dict(raw)
    dumped = first.to_dict()
    entry = dumped['animations']['idle']
    assert 'motion' in entry
    second = from_dict({'id': dumped['id'], 'animations': dumped['animations']}, pack_id='a')
    a = first.animations['idle'].primary.motion
    b = second.animations['idle'].primary.motion
    assert (a.amplitude, a.period_ms, a.blink_frames, a.blink_every_ms, a.blink_duration_ms) == \
           (b.amplitude, b.period_ms, b.blink_frames, b.blink_every_ms, b.blink_duration_ms)


def test_no_motion_round_trips_without_the_key():
    """没声明 motion 的包，往返后也不该多出一个 `motion` 键。"""
    dumped = from_dict({'id': 'a', 'animations': {'idle': {'sheet': 'i.png', 'frames': 4}}}).to_dict()
    assert 'motion' not in dumped['animations']['idle']


def test_resolved_variant_carries_motion():
    """运行期定义要带上 motion——前端**只读运行期定义**。"""
    pack = from_dict({'id': 'a', 'animations': {'idle': {'sheet': 'i.png', 'frames': 4,
        'motion': {'breathe': {'amplitude': 0.02, 'periodMs': 3200}}}}})
    dumped = pack.resolve('idle').variants[0].to_dict()
    assert dumped['motion']['breathe']['amplitude'] == 0.02


# ==================================================== transform-origin 跟着 anchor

def test_origin_defaults_to_bottom_center():
    assert motion_transform_origin({}) == '50% 100.0%'
    assert motion_transform_origin({'x': 0.5, 'y': 1.0}) == '50% 100.0%'


def test_origin_follows_anchor_y():
    """★ 原点必须跟着 `anchor.y` 走，不能写死底边。

    呼吸是「以脚底为原点做纵向缩放」，而脚底的位置是**每个形象各自的**
    `anchor.y`（`drawPosition` 用的就是它）。写死底边时，锚点不在底边的
    形象会脚离地——实测 y=0.85 时脚飘 3.5px。
    """
    assert motion_transform_origin({'x': 0.5, 'y': 0.85}) == '50% 85.0%'
    assert motion_transform_origin({'x': 0.5, 'y': 0.9}) == '50% 90.0%'


def test_origin_x_is_always_center():
    """★ 横向原点**恒为 50%**，不取 `anchor.x`。

    因为 `scaleX(-1)`（朝向翻转）也走 `transform`，而它的原点必须是水平中心，
    否则翻转会把贴图整体平移（实测原点取 30% 时左移 0.4×宽度）。
    而且横向定位本来就不看 `anchor.x`（`drawPosition` 用的是 `width / 2`）。
    """
    assert motion_transform_origin({'x': 0.3, 'y': 1.0}) == '50% 100.0%'
    assert motion_transform_origin({'x': 0.0, 'y': 1.0}) == '50% 100.0%'


def test_origin_survives_bad_anchor():
    for bad in ({'y': 'x'}, {'y': None}, None):
        assert motion_transform_origin(bad) == '50% 100.0%'


# ==================================================== 存储层

def _motion_pet(tmp_path, *, motion=None, anchor=None):
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    pack_dir = builtin / 'mpet'
    pack_dir.mkdir(parents=True)
    sheet = Image.new('RGBA', (400, 300), (0, 0, 0, 0))
    for i in range(4):
        sheet.paste(Image.new('RGBA', (100, 300), (30 + i * 40, 90, 120, 255)), (i * 100, 0))
    sheet.save(pack_dir / 'idle.png')
    idle = {'sheet': 'idle.png', 'frames': 4, 'fps': 6}
    if motion is not None:
        idle['motion'] = motion
    manifest = {'id': 'mpet', 'name': 'M', 'size': {'w': 100, 'h': 300},
                'animations': {'idle': idle}}
    if anchor is not None:
        manifest['anchor'] = anchor
    (pack_dir / 'pet.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    return PetStore(str(user), str(builtin))


MOTION = {'breathe': {'amplitude': 0.025, 'periodMs': 3000},
          'blink': {'frames': [2, 3], 'everyMs': [2500, 6000], 'durationMs': 140}}


def test_runtime_ships_motion(tmp_path):
    store = _motion_pet(tmp_path, motion=MOTION)
    entry = store.runtime_pack('mpet')['actions']['idle']
    assert entry['motion']['breathe']['amplitude'] == 0.025
    assert entry['motion']['blink']['frames'] == [2, 3]
    assert entry['motionOrigin'] == '50% 100.0%'


def test_runtime_omits_motion_when_undeclared(tmp_path):
    """没声明的包，运行期**不该出现** `motion` 键（形状与从前一致）。"""
    store = _motion_pet(tmp_path)
    entry = store.runtime_pack('mpet')['actions']['idle']
    assert 'motion' not in entry
    assert 'motionOrigin' not in entry


def test_runtime_origin_follows_anchor(tmp_path):
    store = _motion_pet(tmp_path, motion=MOTION, anchor={'x': 0.5, 'y': 0.88})
    assert store.runtime_pack('mpet')['actions']['idle']['motionOrigin'] == '50% 88.0%'


def test_still_inherits_idle_motion(tmp_path):
    """★ 标准图像必须继承 idle 的运动。

    默认 idle 模式是「平时静止 + 隔一段随机播一遍」，也就是说宠物
    **大部分时间显示的就是标准图像**。它不动的话，呼吸在绝大多数时间里
    根本看不见——宠物看起来仍然是死的。
    """
    store = _motion_pet(tmp_path, motion=MOTION)
    still = store.runtime_pack('mpet')['still']
    assert still['motion']['breathe']['amplitude'] == 0.025
    assert still['motionOrigin'] == '50% 100.0%'


def test_still_without_motion_has_none(tmp_path):
    store = _motion_pet(tmp_path)
    assert 'motion' not in store.runtime_pack('mpet')['still']


def test_declared_still_still_inherits_motion(tmp_path):
    """显式声明的标准图像也继承 idle 的运动。

    理由：呼吸是「这个形象待机时怎么动」的属性，不是「这张图从哪来」的属性。
    作者声明 `still: {sheet: "sleep.png"}` 要的是「静止时显示睡姿」，
    而不是「静止时不要呼吸」——睡姿呼吸恰恰是自然的。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    pack_dir = builtin / 'mpet'
    pack_dir.mkdir(parents=True)
    Image.new('RGBA', (200, 300), (30, 90, 120, 255)).save(pack_dir / 'sleep.png')
    (pack_dir / 'idle.png').write_bytes((pack_dir / 'sleep.png').read_bytes())
    (pack_dir / 'pet.json').write_text(json.dumps({
        'id': 'mpet', 'name': 'M', 'size': {'w': 200, 'h': 300},
        'still': {'sheet': 'sleep.png'},
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 1,
                     'motion': {'breathe': {'amplitude': 0.03, 'periodMs': 4000}}},
            'sleep': {'sheet': 'sleep.png', 'frames': 1},
        },
    }, ensure_ascii=False), encoding='utf-8')
    store = PetStore(str(user), str(builtin))
    still = store.runtime_pack('mpet')['still']
    assert still['source'] == 'still'
    assert still['motion']['breathe']['amplitude'] == 0.03


def test_export_import_keeps_motion(tmp_path):
    """导出再导入后运动仍在。

    必须用**用户自建**形象：内置形象不允许导出（`CODE_BUILTIN_NO_EXPORT`）。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    pack_dir = user / 'pets' / 'mine'
    pack_dir.mkdir(parents=True)
    sheet = Image.new('RGBA', (400, 300), (0, 0, 0, 0))
    for i in range(4):
        sheet.paste(Image.new('RGBA', (100, 300), (30 + i * 40, 90, 120, 255)), (i * 100, 0))
    sheet.save(pack_dir / 'idle.png')
    (pack_dir / 'pet.json').write_text(json.dumps({
        'id': 'mine', 'name': 'M', 'size': {'w': 100, 'h': 300},
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4, 'fps': 6, 'motion': MOTION}},
    }, ensure_ascii=False), encoding='utf-8')
    store = PetStore(str(user), str(builtin))
    data = store.export_pet('mine')
    imported = store.import_zip(data)
    assert imported['actions']['idle']['motion']['breathe']['amplitude'] == 0.025
    assert imported['actions']['idle']['motion']['blink']['frames'] == [2, 3]


# ==================================================== 内置形象：常驻呼吸

def test_builtin_pets_breathe():
    """★ 内置形象声明了**常驻呼吸**（这是「平时看起来是活的」的落点）。

    默认 idle 模式是「平时静止 + 隔 6~18 秒随机播一遍」，也就是说宠物
    **大部分时间显示标准图像**。没有呼吸的话它在那段时间里完全是张死图
    （实测：4 帧 idle 的顶边只动 1px，几乎看不出在动）。

    ⚠️ 这条测试守的是「别把呼吸删掉」——它是**观感特性**，
    删掉不会有任何功能测试失败，只会让宠物悄悄变回死的。
    """
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    builtin = os.path.join(repo, 'resources', 'pets')
    store = PetStore(os.path.join(repo, 'data'), builtin)
    for pet_id in ('xiaoka', 'xiaoman'):
        pack = store.load_pack(pet_id)
        # ★ **两套** idle 变体都要有：否则随机抽到「张望」那一套时呼吸会消失
        # （`idle` 挂了两套动画，抽到哪套由权重决定）。
        variants = pack.animations['idle'].variants
        assert len(variants) >= 2, f'{pet_id} 的 idle 变体数变了'
        for index, variant in enumerate(variants):
            assert variant.motion is not None, f'{pet_id} idle 第 {index} 套没有 motion'
            assert variant.motion.breathes, f'{pet_id} idle 第 {index} 套没有呼吸'
            # 幅度落在「看得出在动、但不至于像弹跳」的区间里
            amp = variant.motion.amplitude
            assert 0.004 <= amp <= 0.016, (
                f'{pet_id} 呼吸幅度 {amp} 超出推荐区间 0.004~0.016——'
                f'实测内置形象显示尺度是 0.45，0.02 会让头顶在屏幕上动 10px'
                f'（占身高 3.9%），而真人静息呼吸只占 0.5%~1%'
            )
        # 标准图像必须继承到呼吸（静止时才真的在动）
        still = pack.resolve_still()
        assert still.motion is not None and still.motion.breathes, (
            f'{pet_id} 的标准图像没有继承呼吸——那样宠物静止时仍是死的'
        )


def test_builtin_breathing_origin_follows_each_anchor():
    """★ 两个内置形象的 anchor.y 不同（0.9913 / 0.9809），原点必须各按各的算。

    写死 `bottom center`（100%）会让它们呼吸时脚各飘一点点——而默认锚点
    接近 1.0，差异很小、肉眼几乎看不出来，正是那种「看不出但确实错了」的 bug。
    """
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    store = PetStore(os.path.join(repo, 'data'), os.path.join(repo, 'resources', 'pets'))
    for pet_id in ('xiaoka', 'xiaoman'):
        pack = store.load_pack(pet_id)
        entry = store._runtime_action(pet_id, pack, 'idle')
        assert entry['motionOrigin'] == f'50% {pack.anchor["y"] * 100:.2f}%', pet_id
        assert entry['motionOrigin'] != '50% 100.00%', (
            f'{pet_id} 的原点落到了写死值上——说明没读 anchor.y'
        )


# ==================================================== 形象目录的命名（真实踩过）

def _store_with(tmp_path, names):
    """建一个 store，`names` 是 `resources/pets/` 下的目录名（都放一份合法包）。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    source = tmp_path / 'source'
    source.mkdir()
    Image.new('RGBA', (96, 96), (10, 200, 10, 255)).save(source / 'idle.png')
    for name in names:
        target = builtin / name
        target.mkdir(parents=True)
        (target / 'idle.png').write_bytes((source / 'idle.png').read_bytes())
        (target / 'pet.json').write_text(json.dumps({
            'id': name if name.isascii() else 'whatever',
            'name': 'X', 'size': {'w': 96, 'h': 96},
            'animations': {'idle': {'sheet': 'idle.png', 'frames': 1}},
        }, ensure_ascii=False), encoding='utf-8')
    return PetStore(str(user), str(builtin))


def test_invalid_dir_name_is_reported_not_silently_skipped(tmp_path):
    """★ 目录名不合法时**必须留下痕迹**，不能静默跳过。

    真实踩过：用户复制内置形象做自定义版，目录命名成 `xiaoka-自定义`
    （很自然的中文命名），于是插件**一声不吭**地跳过它——
    表现为「我明明放进去了，列表里却没有」，用户只能靠猜。

    目录名**就是形象 id**（`_locate` / 帧 URL / 覆盖解析全按它），
    而合法字符集是「小写字母、数字、`.` `_` `-`，且以字母或数字开头」。
    因此这里既要跳过（不能让它进列表），也要把「哪个目录、为什么」报出来。
    """
    store = _store_with(tmp_path, ['good-one', 'xiaoka-自定义'])
    items = store.list_pets()
    assert [i['id'] for i in items] == ['good-one'], '非法目录名不该进列表'
    assert len(store._invalid_dirs) == 1, '被跳过的目录必须被记下来'
    entry = store._invalid_dirs[0]
    assert entry['name'] == 'xiaoka-自定义'
    assert 'id' in entry['hint'] and '小写字母' in entry['hint'], (
        '提示要说清合法字符集，否则用户还是不知道该改成什么'
    )


def test_uppercase_dir_name_is_also_invalid(tmp_path):
    """大写字母同样不合法（正则只允许小写）——这条最容易踩。"""
    store = _store_with(tmp_path, ['Xiaoka-Copy'])
    assert store.list_pets() == []
    assert len(store._invalid_dirs) == 1


def test_invalid_dir_without_manifest_is_not_reported(tmp_path):
    """目录名不合法但**里面没有 pet.json** 时不告警。

    那正是 `data/pets/<内置 id>/overrides/` 的形态（用户对内置形象做单动作
    覆盖时会创建它）。把它当问题报出来会刷一屏假告警。
    """
    store = _store_with(tmp_path, ['good-one'])
    stray = tmp_path / 'resources' / 'pets' / '带中文但没清单'
    (stray / 'overrides').mkdir(parents=True)
    store2 = PetStore(str(tmp_path / 'data'), str(tmp_path / 'resources' / 'pets'))
    assert [i['id'] for i in store2.list_pets()] == ['good-one']
    assert store2._invalid_dirs == [], '没有 pet.json 的目录不该被当成问题'


def test_invalid_dirs_is_recollected_each_scan(tmp_path):
    """每次列表都要**重新收集**——否则用户改名之后告警会一直挂着。"""
    store = _store_with(tmp_path, ['xiaoka-自定义'])
    assert len(store.list_pets()) == 0 and len(store._invalid_dirs) == 1
    os.rename(str(tmp_path / 'resources' / 'pets' / 'xiaoka-自定义'),
              str(tmp_path / 'resources' / 'pets' / 'xiaoka-mine'))
    store2 = PetStore(str(tmp_path / 'data'), str(tmp_path / 'resources' / 'pets'))
    assert [i['id'] for i in store2.list_pets()] == ['xiaoka-mine']
    assert store2._invalid_dirs == []


def test_manifest_id_mismatch_is_reported(tmp_path):
    """★ `pet.json` 的 `id` 与目录名不一致时要提示。

    两者是同一个东西的两个来源：**目录名**才是插件真正用的 id
    （`_locate` / 帧 URL / 覆盖解析全按它），而 `pet.json` 的 `id` 只在
    文件被单独搬运时才有意义。用户复制内置形象时很容易只改一个
    （「我改了 id，还是不行」），于是列表里的 id 与文件里写的对不上。

    这**不是错误**（包照常能用），因此只提示、不改行为。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    target = builtin / 'my-copy'
    target.mkdir(parents=True)
    Image.new('RGBA', (96, 96), (10, 200, 10, 255)).save(target / 'idle.png')
    (target / 'pet.json').write_text(json.dumps({
        'id': 'something-else', 'name': 'X', 'size': {'w': 96, 'h': 96},
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 1}},
    }), encoding='utf-8')
    store = PetStore(str(user), str(builtin))
    item = store.list_pets()[0]
    assert item['id'] == 'my-copy', '生效的 id 是**目录名**'
    assert item['idMismatch']['manifestId'] == 'something-else'
    assert item['idMismatch']['dirId'] == 'my-copy'
    assert 'my-copy' in item['idMismatch']['hint']


def test_no_mismatch_key_when_ids_agree(tmp_path):
    """一致时不该多出这个键（否则面板会对每个正常形象都提示一遍）。"""
    store = _store_with(tmp_path, ['good-one'])
    assert 'idMismatch' not in store.list_pets()[0]


def test_export_keeps_overrides_when_manifest_id_differs(tmp_path):
    """★ 目录名与 `pet.json` id 不一致时，导出**不能**丢掉覆盖图。

    `_collect_export_files` 过去用 `pack.id`（`pet.json` 里的）去解析覆盖，
    而 `resolve_frame_path` / `_locate` 全按**目录名**——两者不一致时它会去
    解析一个不存在的目录，于是覆盖图被**静默漏掉**：包能导出、能再导入，
    只是用户的自定义图没了。实测：目录 `my-copy` + id `something-else` 时
    导出包内只有 `pet.json` 与 `idle.png`。
    """
    import zipfile

    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    target = user / 'pets' / 'my-copy'
    target.mkdir(parents=True)
    Image.new('RGBA', (384, 96), (10, 200, 10, 255)).save(target / 'idle.png')
    (target / 'pet.json').write_text(json.dumps({
        'id': 'something-else', 'name': 'X', 'size': {'w': 96, 'h': 96},
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4}},
    }), encoding='utf-8')
    overrides = target / 'overrides'
    overrides.mkdir()
    Image.new('RGBA', (96, 96), (200, 10, 10, 255)).save(overrides / 'idle.png')

    store = PetStore(str(user), str(builtin))
    data = store.export_pet('my-copy')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
    assert 'overrides/idle.png' in names, (
        f'覆盖图被漏掉了——导出用的是 pet.json 的 id 而不是目录名: {names}'
    )
