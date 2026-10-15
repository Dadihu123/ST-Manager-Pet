"""运行期定义与预览接口的**动画节奏**契约（多套动画 / 非均匀帧时长 / idle 触发）。

这些是前后端之间的**契约**：前端只按这里给的结论播帧，不做回退或节奏决策。
因此每一项都要有测试，否则「后端改了字段名、前端静默播不出动画」这类问题
只会在用户那里暴露。
"""

import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.core.store import PetStore  # noqa: E402


@pytest.fixture
def store(tmp_path):
    """一个带**多套动画 + 非均匀帧时长**形象的空形象库。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)

    from pet_test_support import write_pack

    write_pack(builtin, 'anim-pet', payload={
        'id': 'anim-pet',
        'name': '节奏测试',
        'size': {'w': 64, 'h': 64},
        # 触发节奏在**顶层** `schedule`（`roam` 不是动作，挂不到动作下面）
        'schedule': {
            'idle': {'intervalMs': [3000, 9000], 'plays': 2},
            'roam': {'intervalMs': [1000, 2000]},
        },
        'animations': {
            'idle': {
                'variants': [
                    {'sheet': 'idle-a.png', 'frames': 4, 'fps': 2.5,
                     'frameMs': [400, 300, 300, 600], 'weight': 5},
                    {'sheet': 'idle-b.png', 'frames': 2, 'weight': 3},
                ],
            },
            'click': {
                'variants': [
                    {'sheet': 'click-a.png', 'frames': 3, 'frameMs': [90, 110, 260]},
                    {'sheet': 'click-b.png', 'frames': 2, 'frameMs': [500, 500]},
                ],
            },
            'walk-left': {'sheet': 'walk-left.png', 'frames': 4, 'fps': 4,
                          'frameMs': [280, 220, 280, 220]},
        },
    }, sheets={
        'idle-a.png': 4, 'idle-b.png': 2,
        'click-a.png': 3, 'click-b.png': 2,
        'walk-left.png': 4,
    })
    return PetStore(str(user), str(builtin))


# ------------------------------------------------------------ 运行期定义


def test_runtime_action_exposes_frame_ms(store):
    """★ 非均匀帧时长必须下发到前端（否则第 6 项优化等于没落地）。"""
    entry = store.runtime_pack('anim-pet')['actions']['idle']
    assert entry['frameMs'] == [400, 300, 300, 600]
    assert entry['variants'][0]['frameMs'] == [400, 300, 300, 600]


def test_runtime_action_exposes_all_variants_with_weights(store):
    entry = store.runtime_pack('anim-pet')['actions']['idle']
    variants = entry['variants']
    assert len(variants) == 2
    assert [v['weight'] for v in variants] == [5, 3]
    # 每套都要有自己的 URL（前端按 URL 换图）
    assert variants[0]['url'] and variants[1]['url']
    assert variants[0]['url'] != variants[1]['url']


def test_runtime_primary_fields_match_first_variant(store):
    """主变体透传字段必须与 `variants[0]` 一致（缩略图/小图读这些）。"""
    entry = store.runtime_pack('anim-pet')['actions']['idle']
    primary = entry['variants'][0]
    assert entry['url'] == primary['url']
    assert entry['frames'] == primary['frames']
    assert entry['fps'] == primary['fps']
    assert entry['frameMs'] == primary['frameMs']


def test_variant_urls_differ_even_for_the_same_sheet(store):
    """★ 两套动画指向**同一个文件**时 URL 也必须不同。

    否则前端按 `vi` 区分变体的逻辑会失效（缓存键撞在一起）。
    `?v=` 只跟文件内容有关，因此必须额外带 `vi=`。
    """
    from pet_test_support import write_pack

    write_pack(store.builtin_dir, 'shared', payload={
        'id': 'shared',
        'animations': {
            'idle': 'idle.png',
            'click': {'variants': [
                {'sheet': 'idle.png', 'frames': 4, 'weight': 5},
                {'sheet': 'idle.png', 'frames': 4, 'weight': 3,
                 'frameMs': [100, 100, 100, 100]},
            ]},
        },
    }, sheets={'idle.png': 4})
    entry = store.runtime_pack('shared')['actions']['click']
    urls = [v['url'] for v in entry['variants']]
    assert len(urls) == 2
    assert urls[0] != urls[1], '同一张图的两套动画也必须有不同 URL'
    assert 'vi=1' in urls[1], '第二套要带 vi=1'
    assert 'vi=' not in urls[0], '第一套不需要 vi 参数（保持 URL 干净）'


def test_runtime_action_exposes_idle_trigger(store):
    """★ 触发节奏在**形象级**的 `schedule` 里，不在动作里。

    为什么上移：`roam`（自动漫游）不是动作——它没有自己的图，挂不到
    `animations` 下面。两处都能写同一件事的话，迟早会出现不一致的包。
    """
    schedule = store.runtime_pack('anim-pet')['schedule']
    assert schedule['idle'] == {
        'mode': 'random', 'minIntervalMs': 3000, 'maxIntervalMs': 9000, 'plays': 2,
    }
    # ★ 漫游的间隔也要下发（用户要求「调整不同动作的触发时间」）
    assert schedule['roam']['minIntervalMs'] == 1000
    assert schedule['roam']['maxIntervalMs'] == 2000


def test_runtime_schedule_covers_every_behavior(store):
    """两个行为都要有结论——前端不自己写默认值（否则两边会不一致）。"""
    from backend.core.pack import SCHEDULE_BEHAVIORS

    schedule = store.runtime_pack('anim-pet')['schedule']
    assert set(schedule) == set(SCHEDULE_BEHAVIORS)


def test_actions_have_no_schedule_field(store):
    """动作条目里**不该**再有 `idleTrigger`（节奏已上移）。"""
    actions = store.runtime_pack('anim-pet')['actions']
    for name in ('idle', 'click', 'walk-left', 'fall', 'land', 'sleep'):
        assert 'idleTrigger' not in actions[name], f'{name} 不该有 idleTrigger'


def test_every_vocabulary_action_still_present(store):
    """回退链的输出完整性不能被这次扩展破坏（每个词表动作都要有结论）。"""
    from backend.core.pack import ACTION_FALLBACKS

    actions = store.runtime_pack('anim-pet')['actions']
    for name in ACTION_FALLBACKS:
        assert name in actions, f'缺少动作 {name}'
        assert 'variants' in actions[name]


def test_fallback_action_inherits_all_variants(store):
    """回退到 idle 的动作**继承它的全部变体**（视觉上也有多样性）。

    这是有意的设计：`fall` 没有自己的图时播的就是 idle 的动画，
    而 idle 有两套，那么「这次播哪一套」自然也该随机——
    否则同一个回退动作永远长一个样，看起来比有图的动作更呆板。

    注意与**镜像复用**的区别：那条路径只取主变体，因为翻转朝向这件事
    没法用单个 `mirror` 标记表达（见 `pack.resolve` 的注释）。
    """
    entry = store.runtime_pack('anim-pet')['actions']['fall']
    assert entry['source'] == 'idle'
    assert len(entry['variants']) == 2
    # 主变体透传字段仍然与第一套一致（缩略图/小图读它们）
    assert entry['frames'] == entry['variants'][0]['frames']
    # 但**触发配置**不跟着来：它不是「随机待机」，而是「下落」
    assert 'idleTrigger' not in entry

def test_mirrored_walk_uses_only_the_primary_variant(store):
    """★ 镜像复用只取主变体（翻转朝向无法用单个 mirror 标记表达多套）。

    否则会出现「这一侧播的图朝向是反的」——那比少播几套变体糟得多。
    """
    from pet_test_support import write_pack

    write_pack(store.builtin_dir, 'one-side', payload={
        'id': 'one-side',
        'animations': {
            'idle': 'idle.png',
            # 只提供左侧，且左侧有两套动画
            'walk-left': {'variants': [
                {'sheet': 'wl-a.png', 'frames': 4, 'weight': 5},
                {'sheet': 'wl-b.png', 'frames': 2, 'weight': 3},
            ]},
        },
    }, sheets={'idle.png': 1, 'wl-a.png': 4, 'wl-b.png': 2})

    actions = store.runtime_pack('one-side')['actions']
    assert len(actions['walk-left']['variants']) == 2, '自己那一侧保留全部变体'
    right = actions['walk-right']
    assert right['mirror'] is True, '右侧应是镜像复用'
    assert len(right['variants']) == 1, '镜像路径只取主变体'


# ------------------------------------------------------------ 缩略图几何


def test_thumbnail_spec_for_every_pet(store):
    """★ 列表接口必须为每个形象带缩略图几何（「小满没有缩略图」的根因）。

    缩略图取的是**标准图像**（不播动画时显示的那一帧），而不是 idle 的主变体——
    后者在作者挂了两套 idle 动画时会显示「作者未必想当门面」的那一套。
    """
    item = next(i for i in store.list_pets() if i['id'] == 'anim-pet')
    thumb = item['thumb']
    assert thumb['url'].startswith('/api/plugins/stm-pet/frame/anim-pet/still')
    assert thumb['frames'] == 4
    assert thumb['frame'] == 0
    assert thumb['layout'] == 'horizontal'


def test_thumbnail_spec_of_broken_pack_is_empty_not_missing(tmp_path):
    """损坏的包也要有 `thumb` 字段（面板据此显示占位，而不是崩掉）。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    broken = builtin / 'broken'
    broken.mkdir(parents=True)
    (broken / 'pet.json').write_text('{ not json', encoding='utf-8')

    store = PetStore(str(user), str(builtin))
    item = next(i for i in store.list_pets() if i['id'] == 'broken')
    assert item['error'], '损坏的包应带 error'
    # 几何字段的类型在**成功与失败两条路径上必须一致**（都是 dict，
    # 且都有 cols / rows / size）——面板照常渲染占位框，不必写两种判空。
    assert item['thumb'] == {
        'url': '', 'frames': 1, 'frame': 0, 'layout': 'horizontal',
        'cols': 1, 'rows': 1, 'size': None,
    }


def test_thumbnail_uses_declared_still(tmp_path):
    """★ 作者显式声明标准图像时，缩略图必须用它，而不是 idle 主变体。

    这是本轮修的核心：内置形象的 idle 挂了「张望」当第二套动画，
    而「张望」的首帧是个**抬头看**的姿势——卡在那一帧上很怪。
    """
    from pet_test_support import write_pack

    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    write_pack(builtin, 'posed', payload={
        'id': 'posed',
        'still': {'sheet': 'calm.png', 'frames': 2, 'frame': 1},
        'animations': {
            'idle': {'variants': [
                {'sheet': 'idle.png', 'frames': 4, 'weight': 5},
                {'sheet': 'idle-v2.png', 'frames': 4, 'weight': 2},
            ]},
        },
    }, sheets={'idle.png': 4, 'idle-v2.png': 4, 'calm.png': 2})

    store = PetStore(str(user), str(builtin))
    item = next(i for i in store.list_pets() if i['id'] == 'posed')
    # URL 是**不透明**的（`/frame/<pet>/<action>`），因此要验的是它背后解析到的文件
    path, source = store.resolve_frame_path('posed', 'still')
    assert path.endswith('calm.png'), f'应指向声明的标准图像，实际 {path}'
    assert source == 'builtin'
    assert 'still' in item['thumb']['url']
    assert item['thumb']['frames'] == 2
    assert item['thumb']['frame'] == 1
    # 列表也要带上「作者有没有声明」——面板据此提示
    assert item['stillDeclared'] is True


# ------------------------------------------------------------ 单动作覆盖


def test_override_only_applies_to_first_variant(store):
    """★ 单动作覆盖只作用于**第一套**动画。

    覆盖的语义是「这个动作换成我的图」，不是「第 N 套换成我的图」。
    这样规则简单，也不会出现「上传一张图后另外几套动画静默消失」。
    """
    from pet_test_support import make_image_bytes, write_pack

    # 先造一个**用户**形象（覆盖只对用户形象生效）
    write_pack(store.user_pets_dir(), 'mine', payload={
        'id': 'mine',
        'animations': {
            'idle': 'idle.png',
            'click': {'variants': [
                {'sheet': 'click-a.png', 'frames': 2, 'weight': 5},
                {'sheet': 'click-b.png', 'frames': 2, 'weight': 3},
            ]},
        },
    }, sheets={'idle.png': 2, 'click-a.png': 2, 'click-b.png': 2})

    store.save_action_image('mine', 'click', make_image_bytes(size=(64, 64), color=(1, 2, 3, 255)))

    # 第一套被覆盖
    path0, source0 = store.resolve_frame_path('mine', 'click', variant=0)
    assert source0 == 'override'
    # 第二套仍是包内的图
    path1, source1 = store.resolve_frame_path('mine', 'click', variant=1)
    assert source1 == 'pack', f'第二套不该被覆盖，实际 {source1}'
    assert path1 != path0

    # 运行期定义里两套的 URL 都还在（用户不会「丢动画」）
    entry = store.runtime_pack('mine')['actions']['click']
    assert len(entry['variants']) == 2


def test_resolve_frame_path_out_of_range_variant_returns_none(store):
    assert store.resolve_frame_path('anim-pet', 'idle', variant=99) == ('', 'none')
    assert store.resolve_frame_path('anim-pet', 'idle', variant=-1)[1] != 'none'

# ------------------------------------------------------------ 导出完整性


def test_export_includes_every_variant_sheet(store):
    """★ 导出必须带上**每一套**动画的图。

    只导出主变体的话，「导出再导入」会静默丢掉其余几套——
    用户会以为是自己弄丢的（这类问题最难查）。
    """
    import io
    import zipfile

    from pet_test_support import write_pack

    write_pack(store.user_pets_dir(), 'porter', payload={
        'id': 'porter',
        'animations': {
            'idle': 'idle.png',
            'click': {'variants': [
                {'sheet': 'click-a.png', 'frames': 2, 'weight': 5},
                {'sheet': 'click-b.png', 'frames': 2, 'weight': 3},
            ]},
        },
    }, sheets={'idle.png': 2, 'click-a.png': 2, 'click-b.png': 2})

    data = store.export_pet('porter')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = set(archive.namelist())
    assert 'click-a.png' in names, '主变体的图要在'
    assert 'click-b.png' in names, '第二套的图也要在（否则导出即丢失）'


# ------------------------------------------------------------ 导入转码


def test_import_rewrites_sheets_inside_variants(store):
    """★ 导入时 JPEG 会被转码改名，`variants` 里的 sheet 也要一起改写。

    漏掉 `variants` 的后果是「导入后那套动画的图找不到」，
    而包本身看起来完全正常——最难查的一类问题。
    """
    import io
    import zipfile

    from pet_test_support import make_image_bytes

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('pet.json', json.dumps({
            'id': 'jpeg-variants',
            'animations': {
                'idle': 'idle.png',
                'click': {'variants': [
                    {'sheet': 'click-a.jpg', 'frames': 1, 'weight': 5},
                    {'sheet': 'click-b.jpg', 'frames': 1, 'weight': 3},
                ]},
            },
        }, ensure_ascii=False))
        archive.writestr('idle.png', make_image_bytes(size=(64, 64)))
        archive.writestr('click-a.jpg', make_image_bytes(size=(64, 64), fmt='JPEG'))
        archive.writestr('click-b.jpg', make_image_bytes(size=(64, 64), fmt='JPEG'))

    store.import_zip(buffer.getvalue())

    pack_dir = store.user_pet_dir('jpeg-variants')
    with open(os.path.join(pack_dir, 'pet.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    sheets = [v['sheet'] for v in manifest['animations']['click']['variants']]
    assert sheets == ['click-a.png', 'click-b.png'], f'variants 的 sheet 未被改写: {sheets}'
    # 而且真的能解析出图（不是指向不存在的文件）
    entry = store.runtime_pack('jpeg-variants')['actions']['click']
    assert len(entry['variants']) == 2
    assert all(v['url'] for v in entry['variants'])
