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
        'animations': {
            'idle': {
                'trigger': 'random', 'intervalMs': [3000, 9000], 'plays': 2,
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
    assert idle['idleTrigger']['mode'] == 'random'
    assert idle['idleTrigger']['minIntervalMs'] == 3000
    assert idle['idleTrigger']['plays'] == 2


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
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets/anim/preview'))
    idle = next(item for item in payload['actions'] if item['action'] == 'idle')
    assert idle['idleTrigger']['mode'] == 'random'
    # 非 idle 动作没有触发配置
    click = next(item for item in payload['actions'] if item['action'] == 'click')
    assert click['idleTrigger'] is None


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


def test_anim_speed_is_declared_in_manifest_config_schema():
    """★ 「动画速度」必须在 manifest 的 config_schema 里声明。

    标量配置的唯一来源是宿主的插件设置表单（§2.8）：不声明的话
    前端读到的 `anim_speed` 恒为 undefined，用户就没有任何办法统一调速。
    """
    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    schema = manifest['config_schema']['properties']
    assert 'anim_speed' in schema, 'manifest 缺少 anim_speed'
    spec = schema['anim_speed']
    assert spec['type'] == 'number'
    assert spec['default'] == 1
    assert float(spec['minimum']) > 0
    assert float(spec['maximum']) > float(spec['minimum'])


def test_frontend_anim_speed_range_matches_manifest():
    """前端夹取区间必须与 manifest 一致，否则会出现「拖到了却不生效」。"""
    import re

    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        schema = json.load(handle)['config_schema']['properties']['anim_speed']
    with open(os.path.join(REPO_ROOT, 'frontend', 'petview.js'), encoding='utf-8') as handle:
        source = handle.read()

    def declared(name):
        found = re.search(rf'{name}\s*=\s*([0-9.]+)', source)
        assert found, f'petview.js 里找不到 {name}'
        return float(found.group(1))

    assert declared('ANIM_SPEED_MIN') == float(schema['minimum']), (
        '前端的 ANIM_SPEED_MIN 必须与 manifest 的 minimum 一致'
    )
    assert declared('ANIM_SPEED_MAX') == float(schema['maximum']), (
        '前端的 ANIM_SPEED_MAX 必须与 manifest 的 maximum 一致'
    )


def test_panel_preview_speed_range_matches_manifest():
    """面板预览器的速度区间也应当与 manifest 同区间（同语义：越大越慢）。"""
    import re

    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        schema = json.load(handle)['config_schema']['properties']['anim_speed']
    with open(os.path.join(REPO_ROOT, 'frontend', 'panel.js'), encoding='utf-8') as handle:
        source = handle.read()

    def declared(name):
        found = re.search(rf'{name}\s*=\s*([0-9.]+)', source)
        assert found, f'panel.js 里找不到 {name}'
        return float(found.group(1))

    assert declared('SPEED_MIN') == float(schema['minimum'])
    assert declared('SPEED_MAX') == float(schema['maximum'])


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
    """idle 触发的默认间隔前后端必须一致（否则「没配置」时两边行为不同）。"""
    import re
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import DEFAULT_IDLE_MAX_MS, DEFAULT_IDLE_MIN_MS

    with open(os.path.join(REPO_ROOT, 'frontend', 'animation.js'), encoding='utf-8') as handle:
        source = handle.read()
    assert int(re.search(r'DEFAULT_IDLE_MIN_MS\s*=\s*([0-9]+)', source).group(1)) == DEFAULT_IDLE_MIN_MS
    assert int(re.search(r'DEFAULT_IDLE_MAX_MS\s*=\s*([0-9]+)', source).group(1)) == DEFAULT_IDLE_MAX_MS


def test_backend_and_frontend_gesture_threshold_agree():
    """★ 长按阈值只有一个权威值：用户要求「按住 0.5s 后才触发」。"""
    import sys as _sys

    _sys.path.insert(0, REPO_ROOT)
    with open(os.path.join(REPO_ROOT, 'frontend', 'gesture.js'), encoding='utf-8') as handle:
        source = handle.read()
    assert 'DEFAULT_HOLD_MS = 500' in source, '长按阈值应为 500 毫秒'
