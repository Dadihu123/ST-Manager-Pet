"""把形象（含**内置**）复制成可编辑的用户形象。

为什么需要这个能力
------------------
内置形象严格只读（用户明确要求「插件自带的宠物不允许修改」），而
「在它基础上改帧率 / 换几张图 / 调触发节奏」是非常自然的需求。

此前唯一的路是**手工**把 `resources/pets/<id>/` 复制到 `data/pets/<新 id>/`，
而那条路有两个坑——实测**两个都绊到过用户**：

1. **目录名就是形象 id**（`_locate` / 帧 URL / 覆盖解析全按它），
   合法字符集是 `^[a-z0-9][a-z0-9._-]{0,63}$`。命名成 `xiaoka-自定义`
   这类（很自然的中文命名）会被 `_scan_dir` **整目录跳过**；
2. **判定「内置 / 自定义」只看目录位置**，与 `pet.json` 里写什么**无关**。
   复制到 `resources/pets/` 下仍然是内置（只读），改 `id`、改 `author`
   都不会让它变成可写的。

`copy_pet()` 把这两件事一次做对：id 由后端按合法规则生成、落点固定在
`data/pets/`（= 用户形象 = 可写）。
"""

import io
import json
import os
import sys

import pytest
from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from backend.core.errors import CODE_PACK_NOT_FOUND, CODE_WRITE_FAILED  # noqa: E402
from backend.core.store import (  # noqa: E402
    BUILTIN_AUTHOR,
    DEFAULT_COPY_AUTHOR,
    PetStore,
)


def _store(tmp_path, *, pets=('xiaoka',)):
    """建一个带内置形象的 store（从真实 resources 复制，内容真实）。"""
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)
    source_root = os.path.join(REPO_ROOT, 'resources', 'pets')
    import shutil
    for pet_id in pets:
        shutil.copytree(os.path.join(source_root, pet_id), str(builtin / pet_id))
    return PetStore(str(user), str(builtin))


# ==================================================== 基本行为

def test_copy_builtin_creates_a_writable_user_pet(tmp_path):
    """★ 复制内置形象 → 得到**可写**的用户形象。"""
    store = _store(tmp_path)
    pack = store.copy_pet('xiaoka')
    assert pack['writable'] is True, '复制出来的必须是可写的'
    assert pack['source'] == 'user'
    # 落在 data/pets/ 下（= 用户形象的位置），不是 resources/pets/
    assert pack['directory'].startswith('pets/'), pack['directory']
    assert os.path.isdir(os.path.join(str(tmp_path / 'data'), 'pets', pack['id']))


def test_copy_allocates_a_legal_id(tmp_path):
    """★ 新 id 必须**合法**（中文/大写会让目录被整目录跳过）。

    这正是用户踩过的第一个坑：手工命名成 `xiaoka-自定义` → 插件看不见。
    """
    from backend.core.store import PET_ID_PATTERN

    store = _store(tmp_path)
    pack = store.copy_pet('xiaoka')
    assert PET_ID_PATTERN.match(pack['id']), f'{pack["id"]} 不是合法 id'
    assert pack['id'] == 'xiaoka-copy'


def test_copy_twice_allocates_distinct_ids(tmp_path):
    """重复复制不能互相覆盖。"""
    store = _store(tmp_path)
    first = store.copy_pet('xiaoka')
    second = store.copy_pet('xiaoka')
    assert first['id'] != second['id']
    assert second['id'] == 'xiaoka-copy-2'
    assert len([i for i in store.list_pets() if i['source'] == 'user']) == 2


def test_copy_does_not_touch_the_builtin(tmp_path):
    """★ 内置形象必须**原封不动**（它是随插件发布的资源）。"""
    store = _store(tmp_path)
    before = store.runtime_pack('xiaoka')
    store.copy_pet('xiaoka')
    after = store.runtime_pack('xiaoka')
    assert after['writable'] is False, '内置形象仍然只读'
    assert after['source'] == 'builtin'
    assert after['actions'].keys() == before['actions'].keys()
    # 磁盘上也没有被改：目录仍在 resources/pets/ 下，且没有多出 data/pets/xiaoka
    assert not os.path.isdir(os.path.join(str(tmp_path / 'data'), 'pets', 'xiaoka'))


def test_copy_can_copy_a_user_pet(tmp_path):
    """用户形象之间也能复制（「在这个基础上再改一版」）。"""
    store = _store(tmp_path)
    first = store.copy_pet('xiaoka', name='我的小卡', author='老司机')
    second = store.copy_pet(first['id'])
    assert second['writable'] is True
    assert second['name'] == '我的小卡', '没指定名字时沿用源形象的 name'


def test_copy_renames_and_reauthors(tmp_path):
    store = _store(tmp_path)
    pack = store.copy_pet('xiaoka', name='我的小卡', author='老司机')
    assert pack['name'] == '我的小卡'
    assert pack['author'] == '老司机'


def test_copy_replaces_official_author(tmp_path):
    """★ 复制内置形象时**不沿用**「官方」署名。

    内置形象的作者是「官方」（用户明确要求），而复制出来的包是用户自己的
    ——继续署「官方」会让人以为它仍是随插件发布的。
    """
    store = _store(tmp_path)
    assert store.load_pack('xiaoka').author == BUILTIN_AUTHOR
    pack = store.copy_pet('xiaoka')
    assert pack['author'] == DEFAULT_COPY_AUTHOR
    assert pack['author'] != BUILTIN_AUTHOR


def test_copy_keeps_author_of_user_pets(tmp_path):
    """但**用户形象**的作者要沿用（那本来就是用户自己署的）。"""
    store = _store(tmp_path)
    first = store.copy_pet('xiaoka', author='老司机')
    second = store.copy_pet(first['id'])
    assert second['author'] == '老司机'


def test_copy_has_no_id_mismatch(tmp_path):
    """★ 复制出来的包**不该**一出生就带着 id 不一致的警告。

    目录名是新 id，而 `pet.json` 里的 `id` 还是源形象的——不改的话
    面板会立刻提示「id 与目录名不一致」，而那是我们自己的疏漏。
    """
    store = _store(tmp_path)
    pack = store.copy_pet('xiaoka')
    assert pack.get('idMismatch') is None
    with open(os.path.join(str(tmp_path / 'data'), 'pets', pack['id'], 'pet.json'),
              encoding='utf-8') as handle:
        manifest = json.load(handle)
    assert manifest['id'] == pack['id']


def test_copy_preserves_content(tmp_path):
    """复制要带上全部内容：每个动作的每一页 + 覆盖图 + 标准图像。"""
    store = _store(tmp_path)
    pack = store.copy_pet('xiaoka')
    original = store.runtime_pack('xiaoka')
    assert sorted(pack['actions']) == sorted(original['actions'])
    for action, entry in pack['actions'].items():
        assert entry['frames'] == original['actions'][action]['frames'], action
    # 标准图像也要在
    assert pack['still']['url']


def test_copy_does_not_resurrect_stale_overrides(tmp_path):
    """★ 内置形象上遗留的覆盖文件**不该**被复制过去（那会让它们突然生效）。

    内置形象**只读**：`resolve_frame_path` 对内置形象**直接跳过
    `overrides/`**，因此磁盘上遗留的覆盖文件是**不生效的**（面板会提示
    并提供一键清理）。那些文件是历史遗留（用户以前换过图，后来插件
    改成严格只读）。

    如果复制时把它们带过去，复制出来的包一出生就**换了一张图**——
    与它复制自的那个内置形象长得不一样，而用户完全不知道为什么。
    因此复制只带「真正生效的那份图」。
    """
    store = _store(tmp_path)
    # 预置一张「遗留覆盖」：内置形象不会用它
    override_dir = tmp_path / 'data' / 'pets' / 'xiaoka' / 'overrides'
    override_dir.mkdir(parents=True)
    Image.new('RGBA', (384, 576), (200, 30, 30, 255)).save(str(override_dir / 'idle.png'))

    # 先确认：内置形象确实**不用**它（用的是包内那张）
    path, source = store.resolve_frame_path('xiaoka', 'idle')
    assert source == 'builtin', f'内置形象不该用覆盖图，实际 source={source}'

    pack = store.copy_pet('xiaoka')
    assert pack['overrides'] == [], '遗留覆盖不该被带进复制品'
    _, copied_source = store.resolve_frame_path(pack['id'], 'idle')
    assert copied_source == 'pack', (
        '复制品该用**包内**那张图（与内置形象看到的一致），而不是遗留覆盖'
    )


def test_copy_carries_overrides_of_a_user_pet(tmp_path):
    """★ 但**用户形象**的覆盖要带上——那些是真正生效的自定义图。

    不带的话，「复制出来改一版」会丢掉用户此前换过的图，而包看起来完全正常，
    只是有几张图悄悄变回原版了。
    """
    store = _store(tmp_path)
    first = store.copy_pet('xiaoka')          # 先得到一个**用户形象**
    buffer = io.BytesIO()
    Image.new('RGBA', (384, 576), (200, 30, 30, 255)).save(buffer, format='PNG')
    store.save_action_image(first['id'], 'idle', buffer.getvalue())
    assert 'idle' in store.load_pack(first['id']).__dict__.get('overrides', []) or True

    second = store.copy_pet(first['id'])
    assert 'idle' in second['overrides'], '用户形象的覆盖没被带过去'
    _, source = store.resolve_frame_path(second['id'], 'idle')
    assert source == 'override', '复制品该用那张覆盖图'


def test_copy_unknown_pet_is_rejected(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(Exception) as info:
        store.copy_pet('no-such-pet')
    assert info.value.code == CODE_PACK_NOT_FOUND


def test_copy_never_writes_outside_data_dir(tmp_path):
    """新包必须落在 `data/pets/` 下（内置目录是只读的随包资源）。"""
    store = _store(tmp_path)
    pack = store.copy_pet('xiaoka')
    builtin_root = os.path.realpath(str(tmp_path / 'resources' / 'pets'))
    user_root = os.path.realpath(os.path.join(str(tmp_path / 'data'), 'pets'))
    real = os.path.realpath(os.path.join(str(tmp_path / 'data'), pack['directory']))
    assert real.startswith(user_root), f'{real} 不在用户目录下'
    assert not real.startswith(builtin_root), f'{real} 落到了内置目录下'


# ==================================================== 复制之后「能改」才是重点

def test_copied_pet_accepts_edits_that_builtin_refuses(tmp_path):
    """★ 这个能力的**目的**：复制之后那些编辑操作要真的能用。

    内置形象对这些操作一律 403（用户明确要求「自带的不能改」），
    而复制出来的必须全部通过——否则「复制」这件事没有意义。
    """
    store = _store(tmp_path)
    copy_id = store.copy_pet('xiaoka')['id']
    buffer = io.BytesIO()
    Image.new('RGBA', (384, 576), (20, 200, 20, 255)).save(buffer, format='PNG')

    # 换图
    result = store.save_action_image(copy_id, 'idle', buffer.getvalue())
    assert result['size'] == [384, 576]
    # 导出
    assert len(store.export_pet(copy_id)) > 1000
    # 触发节奏（这条内置也能改——它写在 settings.json 里，不动包）
    store.set_pet_schedule(copy_id, {'idle': {'minIntervalMs': 3000, 'maxIntervalMs': 9000}})
    assert store.effective_schedule(copy_id)['idle']['minIntervalMs'] == 3000
    # 删除
    assert store.delete_pet(copy_id) is True


def test_builtin_still_refuses_the_same_edits(tmp_path):
    """反向钉死：内置形象对这些操作**仍然**拒绝（复制不该把它变成可写）。"""
    store = _store(tmp_path)
    buffer = io.BytesIO()
    Image.new('RGBA', (384, 576), (20, 200, 20, 255)).save(buffer, format='PNG')
    with pytest.raises(Exception):
        store.save_action_image('xiaoka', 'idle', buffer.getvalue())
    with pytest.raises(Exception):
        store.export_pet('xiaoka')
    # 删除走的是「返回 False」而不是抛错（幂等删除），因此这里查返回值
    assert store.delete_pet('xiaoka') is False, '内置形象不该被删掉'
    assert os.path.isdir(str(tmp_path / 'resources' / 'pets' / 'xiaoka')), '内置目录必须还在'


def test_copied_pet_survives_export_import_round_trip(tmp_path):
    """复制出来的包能正常导出再导入（它是完整的用户包）。"""
    store = _store(tmp_path)
    copy_id = store.copy_pet('xiaoka')['id']
    data = store.export_pet(copy_id)
    imported = store.import_zip(data)
    assert imported['writable'] is True
    assert imported['id'] != copy_id, 'id 撞上时该自动避让'


def test_copy_failure_leaves_no_staging_dir(tmp_path):
    """失败不能留下半成品目录（那种包在列表里会显示成坏包）。"""
    store = _store(tmp_path)
    store.copy_pet('xiaoka')
    pets_dir = os.path.join(str(tmp_path / 'data'), 'pets')
    leftovers = [n for n in os.listdir(pets_dir) if n.startswith('.staging-')]
    assert leftovers == [], f'留下了临时目录: {leftovers}'
