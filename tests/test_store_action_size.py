"""运行期定义里的**每动作单帧尺寸**契约。

背景：一个动作的画布比例可能和别的动作根本不同。小卡的躺姿（sleep）是横构图
1672×941，而站立动作是 2:3 竖构图 1024×1536。若所有动作共用包级 `size`，
前端会按 `size` 拉伸贴图，躺姿被压扁。

这些字段是**前后端契约**：前端只读 `variant.size`（缺省回落到 `pack.size`），
不做任何推导。因此每一项都要有测试——否则「后端加了字段但没透传」这类问题
只会在用户看到变形的躺姿时才暴露。
"""

import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.core.store import PetStore  # noqa: E402

#: 站立动作的逻辑尺寸（源 1024×1536，密度 8/3）。
STANDING = {'w': 384, 'h': 576}
#: 躺姿的逻辑尺寸（源 1672×941，密度 8/3）。
LYING = {'w': 627, 'h': 353}


@pytest.fixture
def store(tmp_path):
    """一个「站立动作 + 横构图躺姿动作」共存的形象库。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)

    from pet_test_support import write_pack

    write_pack(builtin, 'mixed-shape', payload={
        'id': 'mixed-shape',
        'name': '横竖构图混合',
        'size': STANDING,
        'animations': {
            'idle': {'sheet': 'idle.png', 'frames': 4, 'size': STANDING},
            'sleep': {'sheet': 'sleep.png', 'frames': 4, 'size': LYING},
            'fall': {'sheet': 'fall.png', 'frames': 2},  # 不声明 → 沿用包级
        },
    }, sheets={'idle.png': 4, 'sleep.png': 4, 'fall.png': 2})
    return PetStore(str(user), str(builtin))


def test_action_size_reaches_frontend(store):
    """★ 动作级尺寸必须下发到 `actions[<名>]`（前端只读这一处）。"""
    actions = store.runtime_pack('mixed-shape')['actions']
    assert actions['sleep']['size'] == LYING
    assert actions['idle']['size'] == STANDING


def test_action_size_reaches_each_variant(store):
    """多套动画时逐套透传：换套播时几何要跟着换。"""
    actions = store.runtime_pack('mixed-shape')['actions']
    assert actions['sleep']['variants'][0]['size'] == LYING


def test_action_without_size_omits_the_field(store):
    """没声明的动作**不带** `size` 字段，前端自然回落到包级。

    不能下发一个等于包级的值：那会让「作者是否声明过」这个信息丢失，
    面板就无法区分「这个动作特意用了竖构图」和「它没声明」。
    """
    actions = store.runtime_pack('mixed-shape')['actions']
    assert 'size' not in actions['fall']
    assert 'size' not in actions['fall']['variants'][0]


def test_pack_level_size_still_present(store):
    """包级 `size` 仍是默认值，照旧下发（老前端只读它）。"""
    payload = store.runtime_pack('mixed-shape')
    assert payload['size'] == STANDING


def test_landscape_and_portrait_coexist_in_one_pack(store):
    """核心场景：同一形象里横构图与竖构图动作互不干扰。"""
    actions = store.runtime_pack('mixed-shape')['actions']
    lying = actions['sleep']['size']
    standing = actions['idle']['size']
    assert lying['w'] > lying['h'], '躺姿应是横构图'
    assert standing['h'] > standing['w'], '站立应是竖构图'


def test_fallback_action_carries_the_size_of_the_image_actually_used(store):
    """请求缺失动作、回退到别的图时，带的应是**命中那张图**的尺寸。

    否则前端会按错误的比例去铺帧，回退路径上就会出现变形。
    """
    actions = store.runtime_pack('mixed-shape')['actions']
    # `walk-left` 没声明 → 回退链最终落到 idle 的图 → 应带 idle 的尺寸
    assert actions['walk-left']['size'] == STANDING
    assert actions['walk-left']['source'] == 'idle'
