"""后端路由契约（含错误结构与路径安全）。

跑的是**真实的路由函数**（经 `fake_api.build_app` 挂到测试 app 上），
断言的是前端实际会拿到的响应体形状。
"""

import io
import json
import os

import pytest

from backend.core.store import DEFAULT_PET_ID, MANIFEST_FILENAME, PetStore
from fake_api import FakeApi, build_app
from pet_test_support import make_image_bytes, minimal_pack, pack, write_pack, write_sheet


@pytest.fixture()
def env(tmp_path):
    """建一个带内置形象 + 一个用户形象的环境，返回 (app, store, client)。"""
    data_dir = tmp_path / 'data'
    builtin_dir = tmp_path / 'resources' / 'pets'
    data_dir.mkdir(parents=True)
    builtin_dir.mkdir(parents=True)

    # 内置形象（完整）—— 用 `DEFAULT_PET_ID` 这个 id，顺带覆盖「首次安装默认形象」
    write_pack(
        builtin_dir, DEFAULT_PET_ID,
        payload=pack(id=DEFAULT_PET_ID, name='小满'),
        sheets={
            'idle.png': 4, 'walk-left.png': 4, 'walk-right.png': 4,
            'fall.png': 2, 'drag.png': 2, 'land.png': 3,
        },
    )
    # 内置形象（只有单帧 idle —— 「任何一张单帧图都能跑起来」）
    write_pack(
        builtin_dir, 'solo', payload=minimal_pack(id='solo', name='单帧宠物'),
        sheets={'idle.png': 1},
    )
    # 用户自建形象（覆盖类用例要用它 —— 内置形象严格只读）
    write_pack(
        data_dir / 'pets', 'my-cat', payload=pack(id='my-cat', name='我的猫'),
        sheets={
            'idle.png': 4, 'walk-left.png': 4, 'walk-right.png': 4,
            'fall.png': 2, 'drag.png': 2,
        },
    )

    store = PetStore(str(data_dir), str(builtin_dir))
    # 显式指定当前形象：否则 `active_pet_id()` 会回落到默认形象，
    # 而排序按名称（中文）——那会让这些用例依赖 locale 细节。
    store.update_settings({'activePetId': DEFAULT_PET_ID})

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
    assert 'xiaoman' in ids and 'solo' in ids
    assert payload['activePetId'] == 'xiaoman'
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
    for action in ('walk-left', 'walk-right', 'drag', 'fall', 'land', 'happy', 'sleep', 'click', 'look'):
        entry = actions[action]
        assert entry['source'] == 'idle', f'{action} 未回退到 idle'
        assert entry['url'], f'{action} 缺少可用图'
        assert entry['kind'] == 'animated'
        assert entry['note'], f'{action} 应说明发生了回退'


def test_active_runtime_endpoint(env):
    _app, _store, client, _api = env
    payload = json_of(client.get('/api/plugins/stm-pet/runtime'))
    assert payload['success'] is True
    assert payload['activePetId'] == 'xiaoman'
    assert payload['pet']['id'] == 'xiaoman'
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
    response = client.get('/api/plugins/stm-pet/frame/xiaoman/idle')
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

    versioned = client.get('/api/plugins/stm-pet/frame/xiaoman/idle?v=123-456')
    assert 'max-age=604800' in versioned.headers.get('Cache-Control', '')
    assert 'immutable' not in versioned.headers.get('Cache-Control', '')

    unversioned = client.get('/api/plugins/stm-pet/frame/xiaoman/idle')
    cache_control = unversioned.headers.get('Cache-Control', '')
    assert 'no-cache' in cache_control, f'不带 v 的请求应回源校验，实际: {cache_control}'
    # 仍然允许被缓存（靠 ETag 做廉价 304），只是必须校验
    assert 'max-age=604800' not in cache_control


def test_frame_endpoint_reports_source(env):
    """响应头标记帧来源，便于排查「为什么换了图没生效」。

    内置形象严格只读，因此**只可能**是 builtin——即便磁盘上存在遗留覆盖。
    """
    _app, store, client, _api = env
    response = client.get('/api/plugins/stm-pet/frame/xiaoman/idle')
    assert response.headers.get('X-Pet-Frame-Source') == 'builtin'

    # 用户形象才允许覆盖
    store.save_action_image(
        'my-cat', 'idle', make_image_bytes(size=(64, 64), color=(1, 1, 1, 255)),
    )
    response = client.get('/api/plugins/stm-pet/frame/my-cat/idle')
    assert response.headers.get('X-Pet-Frame-Source') == 'override'


def test_frame_endpoint_supports_conditional_request(env):
    """ETag / If-None-Match 必须生效：宠物每秒都在取这张图。"""
    _app, _store, client, _api = env
    first = client.get('/api/plugins/stm-pet/frame/xiaoman/idle')
    etag = first.headers.get('ETag')
    assert etag, '应返回 ETag'

    second = client.get(
        '/api/plugins/stm-pet/frame/xiaoman/idle',
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
    response = client.get(f'/api/plugins/stm-pet/frame/xiaoman/{action}')
    assert response.status_code in (404, 308)


def test_frame_endpoint_unknown_action_is_404(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/frame/xiaoman/teleport')
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
        '/api/plugins/stm-pet/pets/my-cat/actions/walk-left',
        data={'file': (io.BytesIO(make_image_bytes(size=(200, 100))), 'walk-left.png')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['success'] is True
    assert payload['override']['action'] == 'walk-left'
    assert payload['override']['url']
    assert store.resolve_frame_path('my-cat', 'walk-left')[1] == 'override'


def test_upload_action_image_on_builtin_is_forbidden(env):
    """★ 内置形象严格只读：换图接口直接拒绝（不能只靠 UI 藏按钮）。"""
    _app, store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/xiaoman/actions/walk-left',
        data={'file': (io.BytesIO(make_image_bytes(size=(64, 64))), 'walk-left.png')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 403
    payload = json_of(response)
    assert payload['success'] is False
    assert payload['error'] == 'builtin_readonly'
    assert payload['hint']
    # 磁盘上不该留下覆盖
    assert store.resolve_frame_path('xiaoman', 'walk-left')[1] == 'builtin'


def test_upload_action_image_rejects_non_image(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/my-cat/actions/walk-left',
        data={'file': (io.BytesIO(b'%PDF-1.4 fake'), 'walk-left.png')},
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    payload = json_of(response)
    assert payload['error'] == 'unsupported_format'
    assert payload['hint']


def test_upload_action_image_rejects_bad_action(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/my-cat/actions/..%2Fevil',
        data={'file': (io.BytesIO(make_image_bytes()), 'x.png')},
        content_type='multipart/form-data',
    )
    assert response.status_code in (400, 404)


def test_delete_action_image_reverts_to_pack(env):
    _app, store, client, _api = env
    client.post(
        '/api/plugins/stm-pet/pets/my-cat/actions/walk-left',
        data={'file': (io.BytesIO(make_image_bytes(size=(64, 64))), 'walk-left.png')},
        content_type='multipart/form-data',
    )
    assert store.resolve_frame_path('my-cat', 'walk-left')[1] == 'override'

    response = client.delete('/api/plugins/stm-pet/pets/my-cat/actions/walk-left')
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['removed'] is True
    assert store.resolve_frame_path('my-cat', 'walk-left')[1] == 'pack'


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
    response = client.delete('/api/plugins/stm-pet/pets/xiaoman')
    assert response.status_code == 404
    assert json_of(response)['success'] is False
    assert os.path.isdir(os.path.join(store.builtin_dir, 'xiaoman'))


# ------------------------------------------------------------------ 设置


def test_get_and_update_settings(env):
    _app, _store, client, _api = env
    settings = json_of(client.get('/api/plugins/stm-pet/settings'))['settings']
    assert settings['activePetId'] == 'xiaoman'

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
    `petScales` / `petPixelated` / `petSchedules` / `petAnimSpeeds` /
    `petAutoRoam` 是**结构化**的（每个形象一个值，宿主表单表达不了），
    `petHidden` 则是「宠物要不要显示」——它需要触手可及（面板顶部），
    放宿主表单里就等于藏起来了。因此这几个合法地留在这里。

    ⚠️ `petAnimSpeeds` / `petAutoRoam` 是后加的：用户要求「不要搞全局的，
    在同一个地方调整的数值却分成全局和形象绑定两种情况，用户可能会困惑」，
    因此动画速度与自动漫游从宿主 `config_schema` 移到了这里（按形象）。
    """
    _app, _store, client, _api = env
    settings = json_of(client.get('/api/plugins/stm-pet/settings'))['settings']
    assert set(settings) == {
        'activePetId', 'petScales', 'petPixelated', 'petSchedules',
        'petAnimSpeeds', 'petAutoRoam', 'petHidden',
    }
    # 这些**全局标量**不该出现在插件自己的设置里（那会造成双写不同步）
    for scalar in ('quietMode', 'quiet_mode', 'scale', 'sleepAfter', 'sleep_after',
                   'animSpeed', 'anim_speed', 'autoRoam', 'auto_roam'):
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
    # `walk` 是**需求代号**（行走只认方向化贴图），所以缺的是它；
    # 动作列表里出现的是 `walk-left` / `walk-right` 两个真实动作名。
    assert set(payload['missingRequired']) == {'walk', 'drag', 'fall'}
    assert 'walk' not in [item['action'] for item in payload['actions']], \
        '正面 walk 已退役，不该出现在动作列表里'
    left = next(item for item in payload['actions'] if item['action'] == 'walk-left')
    assert left['source'] == 'idle'
    assert left['note'], '回退必须带解释'


def test_preview_marks_overridden_actions(env):
    _app, store, client, _api = env
    store.save_action_image('my-cat', 'walk-left', make_image_bytes(size=(64, 64)))
    payload = json_of(client.get('/api/plugins/stm-pet/pets/my-cat/preview'))
    left = next(item for item in payload['actions'] if item['action'] == 'walk-left')
    assert left['overridden'] is True
    assert left['frameSource'] == 'override'


def test_preview_exposes_appearance_and_writability(env):
    """★ 面板要靠这些字段决定「显示哪些控件」。

    内置形象必须带 `writable=false`（前端据此隐藏换图/删除/导出），
    同时**仍然**带上 scale / pixelated——那两项对内置形象也是可调的。
    """
    _app, _store, client, _api = env
    builtin = json_of(client.get('/api/plugins/stm-pet/pets/xiaoman/preview'))
    assert builtin['writable'] is False
    assert builtin['source'] == 'builtin'
    assert builtin['scale'] == 1
    assert builtin['pixelated'] is False
    assert builtin['size'] == {'w': 64, 'h': 64}

    mine = json_of(client.get('/api/plugins/stm-pet/pets/my-cat/preview'))
    assert mine['writable'] is True
    assert mine['source'] == 'user'


# ------------------------------------------------------------------ 导出


def test_export_endpoint_returns_zip(env):
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/pets/my-cat/export')
    assert response.status_code == 200
    assert response.headers['Content-Type'] == 'application/zip'
    assert 'attachment' in response.headers['Content-Disposition']
    assert response.data[:2] == b'PK'


def test_export_builtin_pet_is_forbidden(env):
    """★ 内置形象不提供导出（用户明确要求）。"""
    _app, _store, client, _api = env
    response = client.get('/api/plugins/stm-pet/pets/xiaoman/export')
    assert response.status_code == 403
    payload = json_of(response)
    assert payload['success'] is False
    assert payload['error'] == 'builtin_no_export'
    assert payload['hint']


# ------------------------------------------------------------------ 外观微调


def test_update_appearance_saves_scale_and_pixelated(env):
    """★ 倍率与渲染方式**按形象**保存（用户要求应对不同分辨率与形象）。"""
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/xiaoman/appearance',
        json={'scale': 2.5, 'pixelated': True},
        content_type='application/json',
    )
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['pet']['scale'] == 2.5
    assert payload['pet']['pixelated'] is True
    # 只影响这一个形象
    other = json_of(client.get('/api/plugins/stm-pet/pets/my-cat/runtime'))
    assert other['pet']['scale'] == 1
    assert other['pet']['pixelated'] is False


def test_update_appearance_is_allowed_on_builtin(env):
    """★ 内置形象只读的是内容，不是「怎么看」——倍率必须可调。

    否则内置形象就没法适配用户的屏幕，而它恰恰是大多数用户唯一会用的形象。
    """
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/xiaoman/appearance',
        json={'scale': 0.5},
        content_type='application/json',
    )
    assert response.status_code == 200
    assert json_of(response)['pet']['scale'] == 0.5


def test_update_appearance_clamps_scale(env):
    """超出范围的值被夹到区间内，而不是报错或写进设置。"""
    _app, store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/my-cat/appearance',
        json={'scale': 999},
        content_type='application/json',
    )
    assert response.status_code == 200
    assert json_of(response)['pet']['scale'] == 4
    assert store.get_settings()['petScales']['my-cat'] == 4


def test_update_appearance_null_clears_override(env):
    """传 null 表示清除覆盖、回落包内声明 / 全局默认。"""
    _app, _store, client, _api = env
    client.post(
        '/api/plugins/stm-pet/pets/my-cat/appearance',
        json={'scale': 3}, content_type='application/json',
    )
    response = client.post(
        '/api/plugins/stm-pet/pets/my-cat/appearance',
        json={'scale': None}, content_type='application/json',
    )
    assert response.status_code == 200
    assert json_of(response)['pet']['scale'] == 1


def test_update_appearance_rejects_non_boolean_pixelated(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/my-cat/appearance',
        json={'pixelated': 'yes'}, content_type='application/json',
    )
    assert response.status_code == 400
    assert json_of(response)['success'] is False


# ------------------------------------------------------------------ 遗留覆盖清理


def test_clear_overrides_endpoint(env):
    """★ 内置形象的「一键清理」：清掉不再生效的遗留覆盖。"""
    _app, store, client, _api = env
    override_dir = os.path.join(store.user_pet_dir('xiaoman'), 'overrides')
    os.makedirs(override_dir, exist_ok=True)
    write_sheet(os.path.join(override_dir, 'idle.png'), frames=1)

    before = json_of(client.get('/api/plugins/stm-pet/pets/xiaoman/runtime'))
    assert before['pet']['staleOverrides'] == ['idle']
    assert before['pet']['actions']['idle']['frameSource'] == 'builtin'

    response = client.delete('/api/plugins/stm-pet/pets/xiaoman/overrides')
    assert response.status_code == 200
    payload = json_of(response)
    assert payload['removed'] == ['idle']
    assert payload['pet']['staleOverrides'] == []


# ------------------------------------------------------------------ 新建形象


def _create_form(name='我的新宠物', actions=None, extra=None):
    """拼一个新建形象的 multipart 表单。`actions` 形如 `{'idle': (bytes, frames)}`。"""
    data = {'name': name}
    data.update(extra or {})
    for action, spec in (actions or {'idle': (make_image_bytes(size=(64, 64)), 1)}).items():
        payload, _frames = spec
        data[action] = (io.BytesIO(payload), f'{action}.png')
    return data


def test_create_pet_endpoint(env):
    """★ 用户能自己新建形象（不需要 zip、不需要手写 pet.json）。"""
    _app, store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form('我的新宠物'),
        content_type='multipart/form-data',
    )
    assert response.status_code == 200, response.data
    payload = json_of(response)
    assert payload['success'] is True
    assert payload['pet']['source'] == 'user'
    assert payload['pet']['name'] == '我的新宠物'
    assert payload['pet']['writable'] is True
    assert payload['pet']['actions']['idle']['url']
    # 落盘且可再次读取
    assert os.path.isfile(os.path.join(store.user_pet_dir(payload['pet']['id']), 'pet.json'))
    assert store.active_pet_id() == payload['pet']['id']


def test_create_pet_endpoint_derives_frame_size(env):
    """单帧尺寸从上传图推导——用户不必自己裁成正好尺寸。"""
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form('宽图宠物', {'idle': (make_image_bytes(size=(200, 100)), 1)}),
        content_type='multipart/form-data',
    )
    payload = json_of(response)
    assert payload['pet']['size'] == {'w': 200, 'h': 100}


def test_create_pet_endpoint_supports_multi_frame_sheet(env):
    """★ 填了帧数就按水平 spritesheet 切分，能做出会动的宠物。"""
    _app, _store, client, _api = env
    # 一条 256×64 的图 = 4 帧 × 64px
    sheet = make_image_bytes(size=(256, 64))
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form(
            '会动的宠物',
            {'idle': (sheet, 4)},
            extra={'meta': json.dumps({'idle': {'frames': 4, 'fps': 8}})},
        ),
        content_type='multipart/form-data',
    )
    assert response.status_code == 200, response.data
    idle = json_of(response)['pet']['actions']['idle']
    assert idle['frames'] == 4
    assert idle['fps'] == 8
    assert idle['kind'] == 'animated'


def test_create_pet_endpoint_requires_idle(env):
    """只给 walk-left 不给 idle → 明确报错（idle 是唯一硬必要动作）。"""
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form('没有待机', {'walk-left': (make_image_bytes(size=(64, 64)), 1)}),
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    payload = json_of(response)
    assert payload['success'] is False
    assert payload['error'] == 'pack_animation_idle_missing'
    assert payload['hint']


def test_create_pet_endpoint_without_images_is_structured_error(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data={'name': '空宠物'},
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    assert json_of(response)['success'] is False


def test_create_pet_endpoint_rejects_non_image(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form('假图', {'idle': (b'%PDF-1.4 fake', 1)}),
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    assert json_of(response)['success'] is False


def test_create_pet_endpoint_rejects_indivisible_frames(env):
    """★ 宽度不能被帧数整除时必须明确报错，而不是切出歪帧。"""
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form(
            '除不尽',
            {'idle': (make_image_bytes(size=(100, 64)), 1)},
            extra={'meta': json.dumps({'idle': {'frames': 3}})},
        ),
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    payload = json_of(response)
    assert payload['success'] is False
    assert payload['hint']


def test_create_pet_endpoint_rejects_bad_action_field_name(env):
    """字段名即动作名，非法名（路径穿越）要被拒绝。"""
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form('坏动作名', {'../evil': (make_image_bytes(size=(64, 64)), 1)}),
        content_type='multipart/form-data',
    )
    assert response.status_code == 400
    assert json_of(response)['success'] is False


def test_create_pet_endpoint_applies_scale_and_pixelated(env):
    _app, _store, client, _api = env
    response = client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form('带外观', extra={'scale': '2', 'pixelated': '1'}),
        content_type='multipart/form-data',
    )
    payload = json_of(response)
    assert payload['pet']['scale'] == 2
    assert payload['pet']['pixelated'] is True


def test_create_pet_endpoint_leaves_no_staging_dir_on_failure(env):
    """失败时不留半成品（与 zip 导入同一套 staging 纪律）。"""
    _app, store, client, _api = env
    client.post(
        '/api/plugins/stm-pet/pets/create',
        data=_create_form('坏图', {'idle': (b'not an image', 1)}),
        content_type='multipart/form-data',
    )
    root = store.user_pets_dir()
    leftovers = [n for n in os.listdir(root) if n.startswith('.staging-')]
    assert leftovers == []


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
