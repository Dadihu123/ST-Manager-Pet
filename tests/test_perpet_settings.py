"""**按形象**的行为参数（动画速度 / 自动漫游）。

用户要求：「这个睡觉的也跟形象绑定即可，不要搞全局的，在同一个地方调整的
数值却分成全局和形象绑定两种情况，用户可能会困惑，如果后续有全局设置的
需求，应该单独搞个设置页来做，按照优先级来覆盖，其他的触发时间如果当前是
全局的，也都改成形象绑定」。

因此 `scale` / `sleep_after` / `anim_speed` / `auto_roam` 四个
「宠物自身的行为参数」**全部从宿主 `config_schema` 移出**，
只按形象存（`settings.json`），优先级一律是
**用户设置 > 包内声明 > 默认值**。

宿主表单里只留真正全局的东西：勿扰与三个播报开关——那些是
「这个应用要不要弹提示」，与是哪只宠物无关。
"""

import json
import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, 'tests'))

from backend.core.pack import (  # noqa: E402
    ANIM_SPEED_RANGE,
    DEFAULT_ANIM_SPEED,
    DEFAULT_AUTO_ROAM,
    SCALE_RANGE,
)
from backend.core.store import PetStore  # noqa: E402
from pet_test_support import write_pack  # noqa: E402


def _store(tmp_path):
    builtin = tmp_path / 'resources' / 'pets'
    data = tmp_path / 'data'
    builtin.mkdir(parents=True)
    data.mkdir(parents=True)
    return PetStore(str(data), str(builtin))


def _pack(store, pet_id, **extra):
    payload = {'id': pet_id, 'animations': {'idle': 'idle.png'}}
    payload.update(extra)
    write_pack(store.user_pets_dir(), pet_id, payload=payload, sheets={'idle.png': 1})


# ==================================================== 宿主表单只剩真正全局的

def test_manifest_keeps_only_truly_global_settings():
    """★ 宿主 `config_schema` 里只留真正全局的键。

    留着 `scale` / `sleep_after` / `anim_speed` / `auto_roam` 的后果是
    **同一项设置有两个入口**（宿主表单 + 面板按形象），用户改了全局的
    却发现面板上的值没变——这正是用户抱怨的那种困惑。
    """
    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        schema = json.load(handle)['config_schema']['properties']
    for key in ('scale', 'sleep_after', 'anim_speed', 'auto_roam'):
        assert key not in schema, (
            f'{key} 应当按形象，不该再出现在宿主 config_schema 里'
        )
    for key in ('quiet_mode', 'announce_cards', 'announce_jobs', 'show_toast'):
        assert key in schema, f'{key} 是真正全局的，应当保留'


def test_settings_hold_the_per_pet_maps():
    """插件自己的设置里要留下按形象的那几张表。"""
    from backend.core.store import DEFAULT_SETTINGS

    for key in ('petScales', 'petPixelated', 'petSchedules',
                'petAnimSpeeds', 'petAutoRoam'):
        assert key in DEFAULT_SETTINGS, f'缺少 {key}'


# ==================================================== 动画速度

def test_anim_speed_defaults_to_one(tmp_path):
    store = _store(tmp_path)
    _pack(store, 'mine')
    assert store.effective_anim_speed('mine') == DEFAULT_ANIM_SPEED


def test_anim_speed_declared_by_the_pack_wins_over_default(tmp_path):
    """包可以建议一个速度（`pet.json` 的 `animSpeed`）——作者最清楚素材该多快。"""
    store = _store(tmp_path)
    _pack(store, 'mine', animSpeed=1.8)
    assert store.effective_anim_speed('mine') == 1.8


def test_user_anim_speed_beats_pack_declaration(tmp_path):
    """优先级：**用户设置 > 包内声明 > 默认值**。"""
    store = _store(tmp_path)
    _pack(store, 'mine', animSpeed=1.8)
    store.set_pet_anim_speed('mine', 0.5)
    assert store.effective_anim_speed('mine') == 0.5
    store.clear_pet_anim_speed('mine')
    assert store.effective_anim_speed('mine') == 1.8, '清掉覆盖要回到包内声明'


def test_anim_speed_is_clamped_not_rejected(tmp_path):
    """越界**夹住**而不是抛错（与倍率同一套取舍）。

    值来自设置文件或包，一个脏值不该让「打开设置面板」整件事失败。
    """
    store = _store(tmp_path)
    _pack(store, 'mine')
    assert store.set_pet_anim_speed('mine', 99) == ANIM_SPEED_RANGE[1]
    assert store.set_pet_anim_speed('mine', 0) == ANIM_SPEED_RANGE[0]
    assert store.set_pet_anim_speed('mine', 'abc') == DEFAULT_ANIM_SPEED


def test_anim_speed_is_per_pet(tmp_path):
    """★ 改 A 不影响 B（这就是「按形象」的意义）。"""
    store = _store(tmp_path)
    _pack(store, 'a')
    _pack(store, 'b')
    store.set_pet_anim_speed('a', 2.5)
    assert store.effective_anim_speed('a') == 2.5
    assert store.effective_anim_speed('b') == DEFAULT_ANIM_SPEED


def test_pack_rejects_out_of_range_anim_speed(tmp_path):
    """包里写越界的 `animSpeed` 要**报错**（而不是静默夹住）。

    包是作者手写的，写错就该明确告诉他——静默夹住会让他以为设上了。
    """
    store = _store(tmp_path)
    _pack(store, 'bad', animSpeed=99)
    with pytest.raises(Exception) as info:
        store.load_pack('bad')
    assert 'animSpeed' in str(info.value)


# ==================================================== 自动漫游

def test_auto_roam_defaults_to_true(tmp_path):
    store = _store(tmp_path)
    _pack(store, 'mine')
    assert store.effective_auto_roam('mine') is DEFAULT_AUTO_ROAM


def test_auto_roam_can_be_declared_by_the_pack(tmp_path):
    """不是每个形象都「会走」——坐着的猫自己溜达起来很出戏。"""
    store = _store(tmp_path)
    _pack(store, 'mine', autoRoam=False)
    assert store.effective_auto_roam('mine') is False


def test_user_auto_roam_beats_pack_declaration(tmp_path):
    store = _store(tmp_path)
    _pack(store, 'mine', autoRoam=False)
    store.set_pet_auto_roam('mine', True)
    assert store.effective_auto_roam('mine') is True
    store.clear_pet_auto_roam('mine')
    assert store.effective_auto_roam('mine') is False


def test_auto_roam_is_per_pet(tmp_path):
    store = _store(tmp_path)
    _pack(store, 'a')
    _pack(store, 'b')
    store.set_pet_auto_roam('a', False)
    assert store.effective_auto_roam('a') is False
    assert store.effective_auto_roam('b') is True


# ==================================================== 倍率不再有全局兜底

def test_scale_ignores_host_default(tmp_path):
    """★ 倍率不再有「宿主全局兜底」那一层。

    `host_default` 参数只为兼容旧调用方保留，传了也**不生效**——
    否则「同一项设置两个入口」的问题会从后门回来。
    """
    store = _store(tmp_path)
    _pack(store, 'mine')
    assert store.effective_scale('mine') == 1.0
    assert store.effective_scale('mine', host_default=3.0) == 1.0, (
        'host_default 已废弃，不该再影响结果'
    )
    # 包内声明仍然生效（那是「作者建议」，不是「全局」）
    _pack(store, 'other', scale=0.5)
    assert store.effective_scale('other') == 0.5


# ==================================================== 运行期下发

def test_runtime_pack_carries_per_pet_behavior_settings(tmp_path):
    """运行期定义要带上生效值 + 包内声明值（面板要显示「作者建议 / 已覆盖」）。"""
    store = _store(tmp_path)
    _pack(store, 'mine', animSpeed=1.5, autoRoam=False, scale=0.5)
    pack = store.runtime_pack('mine')
    assert pack['animSpeed'] == 1.5
    assert pack['autoRoam'] is False
    assert pack['scale'] == 0.5
    assert pack['declaredAnimSpeed'] == 1.5
    assert pack['declaredAutoRoam'] is False
    assert pack['declaredScale'] == 0.5


def test_describe_carries_per_pet_behavior_settings(tmp_path):
    """列表接口也要带上（面板切形象时不必等详情回来）。"""
    store = _store(tmp_path)
    _pack(store, 'mine')
    item = [i for i in store.list_pets() if i['id'] == 'mine'][0]
    assert item['animSpeed'] == DEFAULT_ANIM_SPEED
    assert item['autoRoam'] is DEFAULT_AUTO_ROAM
    assert 'declaredAnimSpeed' in item and 'declaredAutoRoam' in item


def test_dirty_settings_values_are_cleaned(tmp_path):
    """设置文件里写坏的值要被清洗掉，而不是让整个设置读不出来。"""
    store = _store(tmp_path)
    _pack(store, 'mine')
    settings = store.get_settings()
    settings['petAnimSpeeds'] = {'mine': 'oops', 'bad id!': 2.0, 'ok': 3.0}
    settings['petAutoRoam'] = {'mine': 'yes', 'ok': False}
    store.update_settings(settings)
    cleaned = store.get_settings()
    # 非数值的动画速度被丢掉（回落到默认）
    assert 'mine' not in cleaned['petAnimSpeeds']
    assert cleaned['petAnimSpeeds'].get('ok') == 3.0
    # 字符串 'yes' 不是布尔值 → 丢掉（否则 bool('yes') 是 True，很危险）
    assert 'mine' not in cleaned['petAutoRoam']
    assert cleaned['petAutoRoam'].get('ok') is False
