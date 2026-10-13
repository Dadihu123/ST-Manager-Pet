"""**关闭宠物**（显示开关）的契约。

用户要求的原始形态：「插件应该支持关闭宠物，目前好像只有卸载或者停用宠物插件
才能关闭，不太合理」。确实不合理——想安静一会儿却要卸载插件，代价完全不对等。

这个功能的正确性有两条容易被做错的边界，都在这里钉住：

1. 关掉的必须是**宠物**，不是插件。插件仍然加载、设置面板仍能打开、
   坞入口仍然在——否则用户关掉之后就没有任何入口把它开回来了。
2. 开关必须**持久化**（刷新页面后仍然是关的），而且要能被**读回来**
   （否则重新打开宿主时宠物会莫名其妙地冒出来）。
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
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'solo', payload={
        'id': 'solo',
        'name': '独苗',
        'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    store = PetStore(str(data), str(builtin))
    api = FakeApi(data_dir=str(data))
    app = build_app(api, store)
    return app, store, app.test_client(), api


# ============================================================ 默认与读写


def test_pet_is_visible_by_default(env):
    """默认**显示**——这是既有的行为，不能让升级把大家的宠物变没。"""
    _app, store, _client, _api = env
    assert store.is_hidden() is False
    assert store.get_settings()['petHidden'] is False


def test_visibility_route_reads_and_writes(env):
    _app, _store, client, _api = env
    assert json_of(client.get('/api/plugins/stm-pet/visibility'))['hidden'] is False

    set_hidden = client.post('/api/plugins/stm-pet/visibility', json={'hidden': True})
    assert set_hidden.status_code == 200
    assert json_of(set_hidden)['hidden'] is True
    assert json_of(client.get('/api/plugins/stm-pet/visibility'))['hidden'] is True

    set_visible = client.post('/api/plugins/stm-pet/visibility', json={'hidden': False})
    assert json_of(set_visible)['hidden'] is False


def test_visibility_route_toggles_when_no_value_given(env):
    """不带 `hidden` 时**取反**——面板上的开关按钮就是这个用法。"""
    _app, _store, client, _api = env
    first = client.post('/api/plugins/stm-pet/visibility', json={})
    assert json_of(first)['hidden'] is True
    second = client.post('/api/plugins/stm-pet/visibility', json={})
    assert json_of(second)['hidden'] is False


def test_visibility_route_rejects_non_boolean(env):
    """`"false"`（字符串）不是 `False`——静默接受会让宠物莫名其妙消失。"""
    _app, _store, client, _api = env
    for bad in ('false', '0', 1, [], {}):
        response = client.post(
            '/api/plugins/stm-pet/visibility', json={'hidden': bad},
        )
        assert response.status_code == 400, f'{bad!r} 应被拒绝'
        assert json_of(response)['success'] is False


def test_visibility_survives_a_restart(env):
    """★ 开关必须**持久化**：刷新页面 / 重启宿主后仍然是关的。"""
    _app, store, client, _api = env
    client.post('/api/plugins/stm-pet/visibility', json={'hidden': True})

    # 用一个全新的 store 模拟「重启」
    again = PetStore(store.data_dir, store.builtin_dir)
    assert again.is_hidden() is True


def test_visibility_is_exposed_on_runtime(env):
    """`/runtime` 要带上它——前端启动时只调这一个接口就知道了。"""
    _app, _store, client, _api = env
    client.post('/api/plugins/stm-pet/visibility', json={'hidden': True})
    payload = json_of(client.get('/api/plugins/stm-pet/runtime'))
    assert payload['config']['petHidden'] is True


def test_settings_endpoint_carries_the_flag(env):
    """`/settings` 也要带上（前端启动时用它读初值）。"""
    _app, _store, client, _api = env
    client.post('/api/plugins/stm-pet/visibility', json={'hidden': True})
    settings = json_of(client.get('/api/plugins/stm-pet/settings'))['settings']
    assert settings['petHidden'] is True


# ==================================================== 与「停用插件」的边界


def test_hiding_does_not_touch_pets_or_active_pet(env):
    """★ 关掉宠物**不能**影响形象本身。

    关的是「现在看不看到它」，不是「用哪个形象」。做成「关掉就把
    activePetId 清空」的话，用户重新打开时会发现形象被换了。
    """
    _app, store, client, _api = env
    before = store.active_pet_id()
    client.post('/api/plugins/stm-pet/visibility', json={'hidden': True})
    after = store.active_pet_id()

    assert after == before == 'solo'
    # 形象列表与运行期定义照常可取（面板要用它们）
    assert len(store.list_pets()) == 1
    assert store.runtime_pack('solo')['id'] == 'solo'


def test_hiding_does_not_block_the_settings_panel(env):
    """★ 关掉宠物后，**所有接口都必须照常可用**。

    这是「关掉的是宠物、不是插件」这条边界的可执行版本：面板要在宠物
    被关掉的状态下正常打开，用户才能把它开回来。
    """
    _app, _store, client, _api = env
    client.post('/api/plugins/stm-pet/visibility', json={'hidden': True})

    for path in (
        '/api/plugins/stm-pet/pets',
        '/api/plugins/stm-pet/runtime',
        '/api/plugins/stm-pet/settings',
        '/api/plugins/stm-pet/pets/solo/preview',
        '/api/plugins/stm-pet/frame/solo/idle',
    ):
        response = client.get(path)
        assert response.status_code == 200, f'{path} 在宠物关闭时不该失败'


def test_hiding_is_independent_of_the_pet_list(env):
    """关掉宠物不影响形象管理（导入 / 新建 / 删除都能照常做）。"""
    _app, store, client, _api = env
    client.post('/api/plugins/stm-pet/visibility', json={'hidden': True})

    created = client.post('/api/plugins/stm-pet/pets/create', data={
        'name': '关着也能建',
        'idle': (io.BytesIO(make_image_bytes(size=(64, 64))), 'idle.png'),
    }, content_type='multipart/form-data')
    assert created.status_code == 200
    assert store.is_hidden() is True, '建形象不该顺手把宠物打开'


# ============================================================ 脏值清洗


def test_petHidden_must_be_a_real_boolean(tmp_path):
    """★ 设置文件里写了 `"false"`（字符串）时必须当成**未隐藏**。

    `bool("false")` 是 `True`——不做类型清洗的话，手工编辑过设置文件的用户
    会发现宠物**莫名其妙不见了**，而且找不到原因（界面上开关显示「显示中」）。
    """
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'solo', payload={
        'id': 'solo', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    store = PetStore(str(data), str(builtin))
    with open(store.settings_path(), 'w', encoding='utf-8') as handle:
        json.dump({'petHidden': 'false'}, handle, ensure_ascii=False)

    assert store.is_hidden() is False, '字符串 "false" 不该被当成 True'

    for truthy in (1, 'true', [], {}):
        with open(store.settings_path(), 'w', encoding='utf-8') as handle:
            json.dump({'petHidden': truthy}, handle, ensure_ascii=False)
        assert store.is_hidden() is False, f'{truthy!r} 不是布尔 True'


def test_settings_file_corruption_does_not_hide_the_pet(tmp_path):
    """设置文件整个坏掉时，宠物应当**照常显示**（回落到默认值）。"""
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    write_pack(builtin, 'solo', payload={
        'id': 'solo', 'animations': {'idle': 'idle.png'},
    }, sheets={'idle.png': 1})

    store = PetStore(str(data), str(builtin))
    with open(store.settings_path(), 'w', encoding='utf-8') as handle:
        handle.write('{ not json')
    assert store.is_hidden() is False
