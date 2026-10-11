"""后端路由契约（含错误结构与路径安全）。

跑的是**真实的路由函数**（经 `fake_api.build_app` 挂到测试 app 上），
断言的是前端实际会拿到的响应体形状。
"""

import io
import json
import os

import pytest

from backend.core.store import MANIFEST_FILENAME, PetStore
from fake_api import FakeApi, build_app
from pet_test_support import make_image_bytes, minimal_pack, pack, write_pack


@pytest.fixture()
def env(tmp_path):
    """建一个带内置形象 + 一个用户形象的环境，返回 (app, store, client)。"""
    data_dir = tmp_path / 'data'
    builtin_dir = tmp_path / 'resources' / 'pets'
    data_dir.mkdir(parents=True)
    builtin_dir.mkdir(parents=True)

    # 内置形象（完整）
    write_pack(
        builtin_dir, 'default-cat', payload=pack(id='default-cat', name='默认小猫'),
        sheets={'idle.png': 4, 'walk.png': 6, 'fall.png': 2, 'drag.png': 2, 'land.png': 3},
    )
    # 内置形象（只有单帧 idle —— 「任何一张单帧图都能跑起来」）
    write_pack(
        builtin_dir, 'solo', payload=minimal_pack(id='solo', name='单帧宠物'),
        sheets={'idle.png': 1},
    )

    store = PetStore(str(data_dir), str(builtin_dir))
    # 显式指定当前形象：否则 `active_pet_id()` 会回落到列表里第一个可用形象，
    # 而排序按名称（中文）——那会让这些用例依赖 locale 细节。
    store.update_settings({'activePetId': 'default-cat'})

    api = FakeApi(data_dir=str(data_dir))
    app = build_app(api, store)
    client = app.test_client()
    return app, store, client, api


def json_of(response):
    return json.loads(response.data.decode('utf-8'))


# ------------------------------------------------------------------ 形象列表


def test_list_pets_shape(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/pets')
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['success'] is True
    ids = [item['id'] for item in payload['items']]
    assert 'default-cat' in ids and 'solo' in ids
    assert payload['activePetId'] == 'default-cat'
    assert 'idle' in payload['actions'] and 'land' in payload['actions']
    assert payload['limits']['maxImageBytes'] > 0


def test_list_pets_marks_degraded_pack(env):
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets'))
    solo = next(item for item in payload['items'] if item['id'] == 'solo')
    assert set(solo['missingRequired']) == {'walk', 'drag', 'fall'}


# ------------------------------------------------------------------ 运行期定义


def test_runtime_endpoint_returns_resolved_fallback(env):
    """★ 只有单帧 idle 的包：所有动作都要有结论，且都回退到 idle。"""
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets/solo/runtime'))
    assert payload['success'] is True
    actions = payload['pet']['actions']
    for action in ('walk', 'drag', 'fall', 'land', 'happy', 'sleep', 'click', 'look'):
        entry = actions[action]
        assert entry['source'] == 'idle', f'{action} 未回退到 idle'
        assert entry['url'], f'{action} 缺少可用图'
        assert entry['kind'] == 'animated'
        assert entry['note'], f'{action} 应说明发生了回退'


def test_active_runtime_endpoint(env):
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/runtime'))
    assert payload['success'] is True
    assert payload['activePetId'] == 'default-cat'
    assert payload['pet']['id'] == 'default-cat'
    assert 'actions' in payload


def test_runtime_endpoint_unknown_pet_is_structured_404(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/runtime/ghost')
    assert response.status_code == 404
    payload = json_of(response)
    assert payload['success'] is False
    assert payload['msg']
    assert 'Traceback' not in json.dumps(payload, ensure_ascii=False)


# ------------------------------------------------------------------ 帧图路由


def test_frame_endpoint_serves_image(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/frame/default-cat/idle')
    assert response.status_code == 200
    assert response.headers['Content-Type'].startswith('image/')
    assert response.data.startswith(b'\x89PNG')


def test_frame_endpoint_cache_depends_on_version_param(env):
    """★ 缓存策略取决于调用方带没带 `?v=`。

    带 `?v=`（插件自己拼的 URL）→ 可以长缓存，因为内容变了 URL 也变。
    不带 `?v=`（手工请求 / 旧客户端）→ 必须回源校验，否则「换了图却一直看到旧图」。
    实测踩过：验收脚本不带 v 请求，拿到 7 天前的旧图，被误判成「上传没生效」。
    """
    _app, _store, client, _api = env

    versioned = client.get('/api/plugins/stm-pet/frame/default-cat/idle?v=123-456')
    assert 'max-age=604800' in versioned.headers.get('Cache-Control', '')
    assert 'immutable' not in versioned.headers.get('Cache-Control', '')

    unversioned = client.get('/api/plugins/stm-pet/frame/default-cat/idle')
    cache_control = unversioned.headers.get('Cache-Control', '')
    assert 'no-cache' in cache_control, f'不带 v 的请求应回源校验，实际: {cache_control}'
    # 仍然允许被缓存（靠 ETag 做廉价 304），只是必须校验
    assert 'max-age=604800' not in cache_control


def test_frame_endpoint_reports_source(env):
    """响应头标记帧来源，便于排查「为什么换了图没生效」。"""
    _app, store, client, _api = env
    response = client.get('/api/plugins/stm-pet/frame/default-cat/idle')
    assert response.headers.get('X-Pet-Frame-Source') == 'builtin'

    store.save_action_image(
        'default-cat', 'idle', make_image_bytes(size=(64, 64), color=(1, 1, 1, 255)),
    )
    response = client.get('/api/plugins/stm-pet/frame/default-cat/idle')
    assert response.headers.get('X-Pet-Frame-Source') == 'override'


def test_frame_endpoint_supports_conditional_request(env):
    """ETag / If-None-Match 必须生效：宠物每秒都在取这张图。"""
    _app, _store, client, _api = env
    first = client.get('/api/plugins/stm-pet/frame/default-cat/idle')
    etag = first.headers.get('ETag')
    assert etag, '应返回 ETag'

    second = client.get(
        '/api/plugins/stm-pet/frame/default-cat/idle',
        headers={'If-None-Match': etag},
    )
    assert second.status_code == 304


@pytest.mark.parametrize('pet_id', ['..', '../..', 'a/b', 'C:', 'ghost'])
def test_frame_endpoint_rejects_bad_pet_id(env, pet_id):
    _app, _store, client, _api = env
    response = client.get(f'/api/plugins/stm-pet/frame/{pet_id}/idle')
    assert response.status_code in (404, 308), response.status_code
    if response.status_code == 404:
        assert json_of(response)['success'] is False


@pytest.mark.parametrize('action', ['../idle', 'a/b', 'idle.png', '', '..'])
def test_frame_endpoint_rejects_bad_action(env, action):
    _app, _store, client, _api = env
    response = client.get(f'/api/plugins/stm-pet/frame/default-cat/{action}')
    assert response.status_code in (404, 308)


def test_frame_endpoint_unknown_action_is_404(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/frame/default-cat/teleport')
    # 未知动作名会回退到 idle（向前兼容），因此这里是 200 而不是 404
    assert response.status_code == 200


# ------------------------------------------------------------------ 切换形象


def test_set_active_pet(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/active',
        json={'petId': 'solo'},
        content_type='application/json',
    )
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['success'] is True
    assert payload['activePetId'] == 'solo'
    assert payload['pet']['id'] == 'solo'

    # 持久化到设置里
    assert json_of(client.get('/api/plugins/stm-pet/runtime'))['activePetId'] == 'solo'


def test_set_active_pet_unknown_is_404(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/active',
        json={'petId': 'ghost'},
        content_type='application/json',
    )
    assert response.status_code == 404
    assert json_of(response)['success'] is False


def test_set_active_pet_sanitizes_id(env):
    """提交带路径分隔符的 id 时要归一化，绝不允许穿越。"""
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/active',
        json={'petId': '../../solo'},
        content_type='application/json',
    )
    # `../../solo` 归一化成 `solo`，因此会成功切过去
    assert response.status_code == 200
    assert json_of(response)['activePetId'] == 'solo'


# ------------------------------------------------------------------ 导入 zip


def _zip_bytes(pet_id='my-pet'):
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as handle:
        handle.writestr(
            MANIFEST_FILENAME,
            json.dumps(minimal_pack(id=pet_id, name='我的宠物'), ensure_ascii=False),
        )
        handle.writestr('idle.png', make_image_bytes(size=(64, 64)))
    return buffer.getvalue()


def test_import_pet_endpoint(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/import',
        data={'file': (io.BytesIO(_zip_bytes()), 'my-pet.zip')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['success'] is True
    assert payload['activePetId'] == 'my-pet'
    assert payload['pet']['actions']['idle']['url']


def test_import_pet_without_file_is_structured_error(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/import',
        data={},
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    payload = json_of(response)
    assert payload['success'] is False
    assert payload['error'] == 'no_upload'


def test_import_pet_rejects_garbage(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/import',
        data={'file': (io.BytesIO(b'not a zip at all'), 'bad.zip')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    payload = json_of(response)
    assert payload['success'] is False
    assert payload['error'] == 'archive_invalid'
    assert payload['hint']


def test_import_pet_rejects_fake_zip_extension(env):
    """伪造扩展名：文件名是 .zip，内容是 PDF。"""
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/import',
        data={'file': (io.BytesIO(b'%PDF-1.4\n' + b'A' * 100), 'evil.zip')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    assert json_of(response)['success'] is False


# ------------------------------------------------------------------ 单动作覆盖


def test_upload_action_image(env):
    _app, store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/default-cat/actions/walk',
        data={'file': (io.BytesIO(make_image_bytes(size=(200, 100))), 'walk.png')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['success'] is True
    assert payload['override']['action'] == 'walk'
    assert payload['override']['url']
    assert store.resolve_frame_path('default-cat', 'walk')[1] == 'override'


def test_upload_action_image_rejects_non_image(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/default-cat/actions/walk',
        data={'file': (io.BytesIO(b'%PDF-1.4 fake'), 'walk.png')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    payload = json_of(response)
    assert payload['error'] == 'unsupported_format'
    assert payload['hint']


def test_upload_action_image_rejects_bad_action(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/default-cat/actions/..%2Fevil',
        data={'file': (io.BytesIO(make_image_bytes()), 'x.png')},
        content_type='multipart/form-data',
    )
    assert response.status_code in (400, 404)


def test_delete_action_image_reverts_to_pack(env):
    _app, store, client, _api = env
    client.post(
        '/api/plugins/stm-pet/pets/default-cat/actions/walk',
        data={'file': (io.BytesIO(make_image_bytes(size=(64, 64))), 'walk.png')},
        content_type='multipart/form-data',
    )
    assert store.resolve_frame_path('default-cat', 'walk')[1] == 'override'

    response = client.delete('/api/plugins/stm-pet/pets/default-cat/actions/walk')
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['removed'] is True
    assert store.resolve_frame_path('default-cat', 'walk')[1] == 'builtin'


# ------------------------------------------------------------------ 删除形象


def test_delete_user_pet_endpoint(env):
    _app, _store, client, _api = env
    client.post(
        '/api/plugins/stm-pet/pets/import',
        data={'file': (io.BytesIO(_zip_bytes('gone')), 'gone.zip')},
        content_type='multipart/form-data',
    )
    response = client.delete('/api/plugins/stm-pet/pets/gone')
    assert response.status_code == 200
    assert json_of(response)['success'] is True


def test_delete_builtin_pet_is_refused(env):
    """内置形象不能通过接口删掉。"""
    _app, store, client, _api = env
    response = client.delete('/api/plugins/stm-pet/pets/default-cat')
    assert response.status_code == 404
    assert json_of(response)['success'] is False
    assert os.path.isdir(os.path.join(store.builtin_dir, 'default-cat'))


# ------------------------------------------------------------------ 设置


def test_get_and_update_settings(env):
    _app, _store, client, _api = env
    settings = json_of(client.get('/api/plugins/stm-pet/settings'))['settings']
    assert settings['activePetId'] == 'default-cat'

    response = client.post(
        '/api/plugins/stm-pet/settings',
        json={'activePetId': 'solo'},
        content_type='application/json',
    )
    assert response.status_code == 200
    assert json_of(response)['settings']['activePetId'] == 'solo'


def test_settings_only_expose_structured_keys(env):
    """标量配置归宿主的 `config_schema`，插件设置里不该出现第二份。

    两边都存会引出「宿主的设置表单改了、插件却不生效」这类双写不同步的 bug。
    """
    _app, _store, client, _api = env
    settings = json_of(client.get('/api/plugins/stm-pet/settings'))['settings']
    assert set(settings) == {'activePetId'}
    for scalar in ('quietMode', 'quiet_mode', 'scale', 'sleepAfter', 'sleep_after'):
        assert scalar not in settings


def test_update_settings_rejects_non_object(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/settings',
        data='[1,2,3]',
        content_type='application/json',
    )
    assert response.status_code == 400
    assert json_of(response)['success'] is False


# ------------------------------------------------------------------ 预览


def test_preview_endpoint_explains_fallbacks(env):
    """设置页要能说清「缺什么、会怎么回退」（阶段 5 要求）。"""
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/pets/solo/preview'))
    assert payload['success'] is True
    assert set(payload['missingRequired']) == {'walk', 'drag', 'fall'}
    walk = next(item for item in payload['actions'] if item['action'] == 'walk')
    assert walk['source'] == 'idle'
    assert walk['note'], '回退必须带解释'


def test_preview_marks_overridden_actions(env):
    _app, store, client, _api = env
    store.save_action_image('default-cat', 'walk', make_image_bytes(size=(64, 64)))
    payload = json_of(client.get('/api/plugins/stm-pet/pets/default-cat/preview'))
    walk = next(item for item in payload['actions'] if item['action'] == 'walk')
    assert walk['overridden'] is True
    assert walk['frameSource'] == 'override'


# ------------------------------------------------------------------ 导出


def test_export_endpoint_returns_zip(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/pets/default-cat/export')
    assert response.status_code == 200
    assert response.headers['Content-Type'] == 'application/zip'
    assert 'attachment' in response.headers['Content-Disposition']
    assert response.data[:2] == b'PK'


# ------------------------------------------------------------------ 错误卫生


def test_errors_never_leak_traceback(env):
    _app, _store, client, _api = env
    for path in [
        '/api/plugins/stm-pet/runtime/ghost',
        '/api/plugins/stm-pet/frame/ghost/idle',
        '/api/plugins/stm-pet/pets/ghost/preview',
    ]:
        response = client.get(path)
        body = response.data.decode('utf-8')
        assert 'Traceback' not in body
        assert 'File "' not in body


def test_unknown_route_returns_json(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/nope')
    assert response.status_code == 404
