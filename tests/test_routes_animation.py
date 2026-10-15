"""路由层的**动画节奏**契约：`/frame` 的变体参数、`/runtime` 与 `/preview` 的字段。

这些是前后端的接口面，改动会直接影响「动画能不能播出来」，
因此每一项都要有测试钉住。
"""

import io
import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.core.store import PetStore  # noqa: E402
from fake_api import FakeApi, build_app  # noqa: E402
from pet_test_support import make_image_bytes, write_pack  # noqa: E402


def json_of(response):
    return json.loads(response.data.decode('utf-8'))


@pytest.fixture
def env(tmp_path):
    """一个带多套动画形象的 app + store。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)

    write_pack(builtin, 'anim', payload={
        'id': 'anim',
        'name': '节奏',
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
        },
    }, sheets={
        'idle-a.png': 4, 'idle-b.png': 2, 'click-a.png': 3, 'click-b.png': 2,
    })

    store = PetStore(str(data), str(builtin))
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    return app, store, app.test_client(), api


# ------------------------------------------------------------ /frame 变体


def test_frame_route_defaults_to_first_variant(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/frame/anim/idle')
    assert response.status_code == 200
    assert len(response.data) > 0
    assert 'vi=' not in (response.headers.get('X-Pet-Frame-Source') or '')


def test_frame_route_serves_a_different_image_per_variant(env):
    """★ `?vi=1` 必须拿到**另一套**动画的图。

    否则面板与桌面上的宠物都只播第一套，多套动画形同虚设。
    """
    _app, _store, client, _api = env
    first = client.get('/api/plugins/stm-pet/frame/anim/idle')
    second = client.get('/api/plugins/stm-pet/frame/anim/idle?vi=1')
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.data != second.data, '两套动画的图应当不同'


def test_frame_route_with_out_of_range_variant_is_404(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/frame/anim/idle?vi=99')
    assert response.status_code == 404
    assert json_of(response)['success'] is False


def test_frame_route_with_garbage_variant_falls_back_to_zero(env):
    """★ 非法 `vi` 按第 0 套处理，而不是 400。

    这是**图片**路由：前端拼 URL 时多一个脏参数不该让整张图取不到
    （那样宠物会直接变成空白，比播错一套糟得多）。
    """
    _app, _store, client, _api = env
    baseline = client.get('/api/plugins/stm-pet/frame/anim/idle')
    for bad in ('abc', '-5', '', '1.9'):
        response = client.get(f'/api/plugins/stm-pet/frame/anim/idle?vi={bad}')
        assert response.status_code == 200, f'vi={bad!r} 不该 404'
        # `1.9` → int() 失败 → 0；因此应与基准一致
        assert response.data == baseline.data, f'vi={bad!r} 应按第 0 套返回'


def test_frame_route_variant_does_not_break_caching_headers(env):
    """变体参数不能破坏缓存策略（带 `v` 才有长缓存）。"""
    _app, _store, client, _api = env
    versioned = client.get('/api/plugins/stm-pet/frame/anim/idle?vi=1&v=123-456')
    assert 'max-age' in versioned.headers['Cache-Control']
    plain = client.get('/api/plugins/stm-pet/frame/anim/idle?vi=1')
    assert plain.headers['Cache-Control'] == 'private, no-cache'


# ------------------------------------------------------------ /runtime


def test_runtime_exposes_frame_ms_and_variants(env):
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/runtime'))
    idle = payload['pet']['actions']['idle']
    assert idle['frameMs'] == [400, 300, 300, 600]
    assert len(idle['variants']) == 2
    assert [v['weight'] for v in idle['variants']] == [5, 3]
    # ★ 触发节奏在**形象级**的 `schedule` 里（`roam` 不是动作）
    schedule = payload['pet']['schedule']
    assert schedule['idle']['mode'] == 'random'
    assert schedule['idle']['minIntervalMs'] == 3000
    assert schedule['idle']['plays'] == 2
    assert schedule['roam']['minIntervalMs'] == 1000


def test_runtime_exposes_still(env):
    """★ 标准图像必须下发——前端在 idle 的「静止」阶段画它。

    没有它的话，宠物会卡在「上一次随机抽到的变体」的首帧上
    （内置形象的「张望」就是个抬头姿势）。
    """
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/runtime'))
    still = payload['pet']['still']
    assert still['url'], '标准图像必须有 URL'
    assert still['frames'] == 4
    assert still['frame'] == 0
    assert still['declared'] is False, '这个包没声明 still，应标明是回落的'
    # 而且这个 URL 要真的能取到图
    assert client.get(still['url']).status_code == 200


def test_runtime_variant_urls_are_reachable(env):
    """运行期给的每个变体 URL 都要真的能取到图（否则前端会显示空白）。"""
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/runtime'))
    idle = payload['pet']['actions']['idle']
    for variant in idle['variants']:
        response = client.get(variant['url'])
        assert response.status_code == 200, f'{variant["url"]} 取不到图'
        assert len(response.data) > 0


# ------------------------------------------------------------ /preview


def test_preview_exposes_variants_with_geometry(env):
    """★ 面板的动画预览器靠这些字段播帧，缺一个就播不出来。"""
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets/anim/preview'))
    idle = next(item for item in payload['actions'] if item['action'] == 'idle')
    assert len(idle['variants']) == 2
    first = idle['variants'][0]
    assert first['url'], '变体必须有 URL'
    assert first['frames'] == 4
    assert first['fps'] == 2.5
    assert first['frameMs'] == [400, 300, 300, 600]
    assert first['weight'] == 5
    assert first['layout'] == 'horizontal'
    assert first['index'] == 0
    assert idle['variants'][1]['index'] == 1


def test_preview_exposes_idle_trigger(env):
    """预览接口也要带上触发节奏与标准图像——面板的「触发时间」区靠它渲染。"""
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets/anim/preview'))
    assert payload['schedule']['idle']['mode'] == 'random'
    assert payload['schedule']['idle']['minIntervalMs'] == 3000
    assert payload['declaredSchedule']['idle']['minIntervalMs'] == 3000
    assert payload['scheduleOverridden'] is False
    assert payload['still']['url']
    # 动作条目里**不该**再有 idleTrigger（节奏已上移到形象级）
    for item in payload['actions']:
        assert 'idleTrigger' not in item, f'{item["action"]} 不该有 idleTrigger'


def test_preview_lists_actions_without_image(env):
    """没有图的动作也要出现在列表里（面板据此显示「没有可播的图」）。"""
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets/anim/preview'))
    actions = {item['action']: item for item in payload['actions']}
    # `anim` 只有 idle 与 click，其余都回退到 idle → 都有图
    for name, item in actions.items():
        assert 'variants' in item, f'{name} 缺少 variants 字段'
        if item['kind'] == 'animated':
            assert item['variants'], f'{name} 声明为 animated 却没有变体'


def test_preview_forwards_per_action_and_variant_size(tmp_path):
    """★ `/preview` 必须下发**单帧尺寸**，否则面板的预览框不知道真实比例。

    用户报障：「预览动画框应该根据动作的比例来自动变化……否则看起来会很奇怪
    （点名小卡的睡觉动作）」。

    睡觉是躺姿、横构图（小卡是 627×353）。面板拿不到尺寸就只能按包级的
    竖构图去铺，横图被压扁。尺寸在运行期包里是有的
    （`AnimationVariant.to_dict()` 会写 `size`），但 `/preview` 曾经**没有透传**
    ——数据算好了、接口没给，前端等于瞎猜。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)

    write_pack(builtin, 'shapes', payload={
        'id': 'shapes',
        'name': '比例',
        'size': {'w': 384, 'h': 576},
        'animations': {
            # 包级是 2:3 竖构图，这个动作是横构图（躺姿）
            'sleep': {'sheet': 'sleep.png', 'frames': 1, 'size': {'w': 627, 'h': 353}},
            'idle': {'sheet': 'idle.png', 'frames': 1},
        },
    }, sheets={'sleep.png': 1, 'idle.png': 1})

    store = PetStore(str(data), str(builtin))
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    payload = json_of(app.test_client().get('/api/plugins/stm-pet/pets/shapes/preview'))

    actions = {item['action']: item for item in payload['actions']}
    sleep = actions['sleep']
    # 动作级尺寸（变体缺失时的回落）
    assert sleep['size'] == {'w': 627, 'h': 353}, '动作级尺寸要透传'
    assert sleep['variants'][0]['size'] == {'w': 627, 'h': 353}, '变体级尺寸也要透传'

    # 没有声明尺寸的动作不写字段（前端回落到包级，老行为不变）
    assert actions['idle']['size'] is None, '没声明就该是 None，让前端回落到包级'

    # 包级尺寸仍在顶层，供回落使用
    assert payload['size'] == {'w': 384, 'h': 576}


def test_preview_size_matches_runtime_pack(tmp_path):
    """`/preview` 与 `/runtime` 的尺寸字段必须**同一套**（同源，不各算一份）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)

    write_pack(builtin, 'same', payload={
        'id': 'same',
        'name': '同源',
        'size': {'w': 384, 'h': 576},
        'animations': {
            'sleep': {'sheet': 'sleep.png', 'frames': 2, 'size': {'w': 500, 'h': 250}},
            'idle': {'sheet': 'idle.png', 'frames': 1},
        },
    }, sheets={'sleep.png': 2, 'idle.png': 1})

    store = PetStore(str(data), str(builtin))
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    client = app.test_client()

    preview = json_of(client.get('/api/plugins/stm-pet/pets/same/preview'))
    runtime = json_of(client.get('/api/plugins/stm-pet/pets/same/runtime'))
    # `/runtime` 把运行期包放在 `pet` 下面（`/preview` 是平铺的）
    runtime_actions = runtime['pet']['actions']

    preview_actions = {item['action']: item for item in preview['actions']}
    assert preview_actions['sleep']['size'] == runtime_actions['sleep']['size'], (
        '两个接口的尺寸必须一致——否则面板预览与桌面表现会对不上'
    )
    assert (
        preview_actions['sleep']['variants'][0]['size']
        == runtime_actions['sleep']['variants'][0]['size']
    )


def test_preview_works_for_builtin_pets(env):
    """★ 内置形象也要能预览（用户明确要求「默认的两个角色也应该支持上」）。"""
    _app, store, client, _api = env
    # 装一个内置形象（模拟随包资源）
    write_pack(store.builtin_dir, 'builtin-x', payload={
        'id': 'builtin-x',
        'name': '内置',
        'animations': {'idle': {'sheet': 'idle.png', 'frames': 4, 'fps': 2.5,
                                'frameMs': [400, 300, 300, 600]}},
    }, sheets={'idle.png': 4})
    payload = json_of(client.get('/api/plugins/stm-pet/pets/builtin-x/preview'))
    assert payload['writable'] is False, '内置形象是只读的'
    idle = next(item for item in payload['actions'] if item['action'] == 'idle')
    assert idle['url'], '只读不影响「看效果」'
    assert idle['frameMs'] == [400, 300, 300, 600]
    assert len(idle['variants']) == 1


# ------------------------------------------------------------ /pets 列表


def test_pets_list_carries_thumbnail_geometry(env):
    """★ 列表接口必须带缩略图几何（「小满没有缩略图」的根因）。"""
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets'))
    for item in payload['items']:
        thumb = item.get('thumb')
        assert isinstance(thumb, dict), f'{item["id"]} 的 thumb 不是对象'
        assert thumb.get('url'), f'{item["id"]} 缺少缩略图 URL'
        assert int(thumb.get('frames') or 0) >= 1
        assert thumb.get('layout') in ('horizontal', 'vertical')


def test_thumbnail_url_is_reachable(env):
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets'))
    for item in payload['items']:
        response = client.get(item['thumb']['url'])
        assert response.status_code == 200, f'{item["id"]} 的缩略图取不到'


# ------------------------------------------------------------ 配置项


def test_anim_speed_is_per_pet_not_global():
    """★ 「动画速度」是**按形象**的设置，**不该**出现在宿主的 config_schema 里。

    用户明确要求：「不要搞全局的，在同一个地方调整的数值却分成全局和
    形象绑定两种情况，用户可能会困惑」。同一份设置既能在宿主表单里改、
    又能在面板里按形象改，就会出现「我改了全局的却没反应」这类困惑。

    因此 `anim_speed` / `scale` / `sleep_after` / `auto_roam` 这四个
    「宠物自身的行为参数」全部**从 config_schema 移出**，只按形象存
    （`settings.json` 的 `petAnimSpeeds` / `petScales` / `petAutoRoam`
    与 `petSchedules`）。

    宿主表单里**只留**真正全局的东西：播报开关与勿扰——那些是
    「这个应用要不要弹提示」，与是哪只宠物无关。
    """
    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    schema = manifest['config_schema']['properties']
    for key in ('anim_speed', 'scale', 'sleep_after', 'auto_roam'):
        assert key not in schema, (
            f'{key} 是按形象的设置，不该再出现在宿主 config_schema 里'
            f'（那会让同一项设置有两个入口）'
        )
    # 真正全局的那几个要留着
    for key in ('quiet_mode', 'announce_cards', 'announce_jobs', 'show_toast'):
        assert key in schema, f'{key} 是真正全局的，应当保留'


def test_frontend_anim_speed_range_matches_backend():
    """前端夹取区间必须与后端 `ANIM_SPEED_RANGE` 一致。

    权威值现在在 `backend/core/pack.py`（不再是 manifest）——因为
    「动画速度」既是**用户按形象的设置**，也是**形象包能声明的字段**
    （`pet.json` 的 `animSpeed`），两处共用同一套区间。
    """
    import re
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import ANIM_SPEED_RANGE

    with open(os.path.join(REPO_ROOT, 'frontend', 'petview.js'), encoding='utf-8') as handle:
        source = handle.read()

    def declared(name):
        found = re.search(rf'{name}\s*=\s*([0-9.]+)', source)
        assert found, f'petview.js 里找不到 {name}'
        return float(found.group(1))

    assert declared('ANIM_SPEED_MIN') == ANIM_SPEED_RANGE[0], (
        '前端的 ANIM_SPEED_MIN 必须与后端 ANIM_SPEED_RANGE 一致'
    )
    assert declared('ANIM_SPEED_MAX') == ANIM_SPEED_RANGE[1], (
        '前端的 ANIM_SPEED_MAX 必须与后端 ANIM_SPEED_RANGE 一致'
    )


def test_panel_preview_speed_range_matches_backend():
    """面板预览器的速度区间也应当与后端同区间（同语义：越大越慢）。"""
    import re
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import ANIM_SPEED_RANGE

    with open(os.path.join(REPO_ROOT, 'frontend', 'panel.js'), encoding='utf-8') as handle:
        source = handle.read()

    def declared(name):
        found = re.search(rf'{name}\s*=\s*([0-9.]+)', source)
        assert found, f'panel.js 里找不到 {name}'
        return float(found.group(1))

    assert declared('SPEED_MIN') == ANIM_SPEED_RANGE[0]
    assert declared('SPEED_MAX') == ANIM_SPEED_RANGE[1]


def test_backend_and_frontend_weight_ranges_agree():
    """权重的合法区间前后端必须一致（否则会出现「后端拒了但前端认为合法」）。"""
    import re
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import MAX_WEIGHT, MIN_WEIGHT

    with open(os.path.join(REPO_ROOT, 'frontend', 'animation.js'), encoding='utf-8') as handle:
        source = handle.read()
    assert float(re.search(r'MIN_WEIGHT\s*=\s*([0-9.]+)', source).group(1)) == MIN_WEIGHT
    assert float(re.search(r'MAX_WEIGHT\s*=\s*([0-9.]+)', source).group(1)) == MAX_WEIGHT


def test_backend_and_frontend_idle_intervals_agree():
    """★ 触发节奏的默认值与行为名单前后端必须一致。

    不一致的后果很隐蔽：「没配置」时两边的间隔不同，看起来像随机 bug。
    而**行为名单**不一致更糟——前端多认一个行为，面板就会渲染出一个
    后端会拒绝的滑块。
    """
    import re
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import (
        DEFAULT_SCHEDULE_MS,
        MAX_SCHEDULE_MS,
        MIN_SCHEDULE_MS,
        SCHEDULE_BEHAVIORS,
    )

    with open(os.path.join(REPO_ROOT, 'frontend', 'animation.js'), encoding='utf-8') as handle:
        source = handle.read()

    # 行为名单
    declared = re.search(r'SCHEDULE_BEHAVIORS\s*=\s*\[([^\]]*)\]', source).group(1)
    front_behaviors = re.findall(r"'([a-z-]+)'", declared)
    assert front_behaviors == list(SCHEDULE_BEHAVIORS), (
        f'前端 {front_behaviors} 与后端 {list(SCHEDULE_BEHAVIORS)} 不一致'
    )

    # 每个行为的默认间隔
    for behavior, (low, high) in DEFAULT_SCHEDULE_MS.items():
        block = re.search(
            rf'{behavior}:\s*\{{\s*min:\s*([0-9]+),\s*max:\s*([0-9]+)\s*\}}', source,
        )
        assert block, f'前端缺少 {behavior} 的默认间隔'
        assert (int(block.group(1)), int(block.group(2))) == (low, high), (
            f'{behavior} 的默认间隔前后端不一致'
        )

    # 间隔的合法区间
    assert int(re.search(r'MIN_SCHEDULE_MS\s*=\s*([0-9]+)', source).group(1)) == MIN_SCHEDULE_MS
    assert int(
        re.search(r'MAX_SCHEDULE_MS\s*=\s*([0-9]+)\s*\*\s*1000', source).group(1),
    ) * 1000 == MAX_SCHEDULE_MS


def test_frontend_schedule_behaviors_match_panel():
    """★ 面板渲染的「触发时间」滑块必须与后端可设置的行为一致。

    面板多渲染一个（例如给 `click` 一个滑块）的后果是：用户拖了、提交了、
    后端 400——而界面上没有任何东西提示「这个动作根本不能设时间」。
    """
    import re as _re
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import SCHEDULE_BEHAVIORS

    with open(os.path.join(REPO_ROOT, 'frontend', 'panel.js'), encoding='utf-8') as handle:
        source = handle.read()
    block = source[source.index('const SCHEDULE_BEHAVIORS = ['):]
    block = block[:block.index('\n];')]
    keys = _re.findall(r"key:\s*'([a-z-]+)'", block)
    assert keys == list(SCHEDULE_BEHAVIORS), (
        f'面板 {keys} 与后端 {list(SCHEDULE_BEHAVIORS)} 不一致'
    )


def test_backend_and_frontend_gesture_threshold_agree():
    """★ 长按阈值只有一个权威值：用户要求「按住 0.5s 后才触发」。"""
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    with open(os.path.join(REPO_ROOT, 'frontend', 'gesture.js'), encoding='utf-8') as handle:
        source = handle.read()
    assert 'DEFAULT_HOLD_MS = 500' in source, '长按阈值应为 500 毫秒'
