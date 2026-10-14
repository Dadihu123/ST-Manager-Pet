"""运行期定义里的**多页 sheet**（`sheets`）契约。

为什么单独一个文件：多页引入的失败模式**全在存储层与前端之间**，
而它们有一个共同特点——包能读、单测里的纯函数全对，但用户看到的是
「只播了前几帧」或「整个形象打不开」。因此这里逐条钉住运行期定义的形状。

实测踩到过的两个真实问题（都已修）：
1. `item['url']` 在多页变体上 **KeyError** → 后端 500，整个形象打不开；
2. 多页变体的 `url` 为空 → 前端 `frameSizeOf` 的回落链与面板的
   「有没有图」判定都把多页动作当成「没有图」。
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
    """一个含**多页动作**的形象库。

    包放在 `builtin`（内置）：多数用例只读运行期定义，与「可写」无关。
    需要写操作的用例自己再建一个用户包（见 `writable_store`）。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)

    from pet_test_support import write_pack

    write_pack(builtin, 'paged', payload=_paged_manifest('paged'), sheets=_PAGED_SHEETS)
    return PetStore(str(user), str(builtin))


@pytest.fixture
def writable_store(tmp_path):
    """同上，但包是**用户包**（可写：覆盖 / 导出）。

    ⚠️ 用户包必须落在 `data/pets/<id>/`（`write_pack` 的 `root` 是
    「形象目录的父目录」，不是 `data/` 本身）。放错位置的表现是
    「形象不存在」——`_locate` 找不到它。
    """
    builtin = tmp_path / 'resources' / 'pets'
    user = tmp_path / 'data'
    builtin.mkdir(parents=True)
    user.mkdir(parents=True)

    from pet_test_support import write_pack

    write_pack(user / 'pets', 'paged', payload=_paged_manifest('paged'),
               sheets=_PAGED_SHEETS)
    return PetStore(str(user), str(builtin))


def _paged_manifest(pack_id):
    return {
        'id': pack_id,
        'name': '多页测试',
        'size': {'w': 64, 'h': 64},
        'animations': {
            # 2×1 网格 × 2 页，每页 2 帧 → 共 4 帧
            'idle': {'sheets': ['idle-0.png', 'idle-1.png'],
                     'cols': 2, 'rows': 1, 'frames': 4, 'fps': 4},
            # 单页动作与多页并存（两种形状必须能同时工作）
            'walk-left': {'sheet': 'walk.png', 'frames': 4, 'fps': 4},
            # 多页 + 多套动画：形状最容易出错的地方
            'click': {'variants': [
                {'sheets': ['c0.png', 'c1.png'], 'cols': 2, 'rows': 1, 'frames': 4},
                {'sheet': 'c-single.png', 'frames': 2},
            ]},
        },
    }


_PAGED_SHEETS = {
    'idle-0.png': 2, 'idle-1.png': 2,
    'walk.png': 4,
    'c0.png': 2, 'c1.png': 2, 'c-single.png': 2,
}


# ------------------------------------------------------------ 运行期定义


def test_multi_page_action_does_not_break_runtime(store):
    """★ 多页动作必须能取到运行期定义。

    早先 `_runtime_action` 用 `item['url']` 过滤可播变体，而多页变体
    写的是 `pages`、**没有 `url` 键** → `KeyError` → 后端 500。
    表现是「整个形象打不开」，而根因在多页这个新特性上——
    单页包的测试完全测不到。
    """
    pack = store.runtime_pack('paged')
    entry = pack['actions']['idle']
    assert entry['kind'] == 'animated'
    assert entry['frames'] == 4


def test_multi_page_action_exposes_pages(store):
    """每一页各一个 URL，且**互不相同**（相同 = 第 2 页永远不会被播到）。"""
    entry = store.runtime_pack('paged')['actions']['idle']
    pages = entry['pages']
    assert isinstance(pages, list) and len(pages) == 2
    assert all('/frame/paged/idle' in url for url in pages)
    assert len(set(pages)) == 2, '两页的 URL 必须不同'
    # 第 2 页必须带 pg 参数，否则两页会命中同一个缓存键
    assert 'pg=1' in pages[1]


def test_multi_page_action_still_exposes_url(store):
    """★ 多页动作也要有 `url`（= 第一页）。

    `url` 是「这个动作有没有图」的通用判据（前端 `frameSizeOf` 的回落链、
    面板的 `previewEntry`、若干验收脚本都读它）。留空会让多页动作
    看起来像「没有图」——而它明明有 4 帧。
    """
    entry = store.runtime_pack('paged')['actions']['idle']
    assert entry['url'], '多页动作也要有 url（第一页）'
    assert entry['url'] == entry['pages'][0]


def test_multi_page_variant_carries_pages(store):
    """变体层也要带 `pages`——前端按变体播帧，它读的是变体。"""
    variant = store.runtime_pack('paged')['actions']['idle']['variants'][0]
    assert len(variant['pages']) == 2
    assert variant['pageCount'] == 2


def test_single_page_action_has_no_pages(store):
    """单页动作**不该**出现 `pages`：URL 形状与从前一致，既有强缓存继续命中。"""
    entry = store.runtime_pack('paged')['actions']['walk-left']
    assert entry.get('pages') in (None, []), '单页不该有 pages'
    assert entry['url']
    assert 'pg=' not in entry['url']


def test_single_page_variant_has_no_pages(store):
    variant = store.runtime_pack('paged')['actions']['walk-left']['variants'][0]
    assert 'pages' not in variant
    assert variant['url']
    assert variant['pageCount'] == 1


def test_mixed_variants_page_and_single(store):
    """★ 同一个动作里「多页变体」与「单页变体」并存。

    这是形状最容易出错的地方：按权重随机抽到哪一套，前端就要能处理
    那一种形状。两套都必须带 `url`（可播判据）与正确的 `pageCount`。
    """
    entry = store.runtime_pack('paged')['actions']['click']
    assert len(entry['variants']) == 2, '两套都该在'
    paged, single = entry['variants']
    assert paged['pageCount'] == 2 and len(paged['pages']) == 2
    assert single['pageCount'] == 1 and 'pages' not in single
    for variant in entry['variants']:
        assert variant['url'], '每套都要有 url（可播判据）'


def test_pages_are_resolvable_images(store):
    """每一页的 URL 必须真的能解析到文件——否则前端会拿到 404。"""
    entry = store.runtime_pack('paged')['actions']['idle']
    for index in range(2):
        path, source = store.resolve_frame_path('paged', 'idle', page=index)
        assert path, f'第 {index} 页没有解析到文件'
        assert os.path.isfile(path)
        assert source in ('pack', 'builtin', 'override')


def test_out_of_range_page_returns_no_image(store):
    """页号越界 → 没有图，**不是**回落到第 0 页。

    回落会让「第 3 页丢了」表现为「第 3 页显示的是第 1 页」——
    属于最难查的一类问题。
    """
    path, source = store.resolve_frame_path('paged', 'idle', page=99)
    assert path == '' and source == 'none'


# ------------------------------------------------------------ 显存估算


def test_decode_bytes_is_reported(store):
    """显存估算要下发到前端——用户看不到显存，只能靠插件告诉他。"""
    entry = store.runtime_pack('paged')['actions']['idle']
    # 4 帧 × 64×64 × 4 字节 = 65536
    assert entry['decodeBytes'] == 4 * 64 * 64 * 4
    assert entry['variants'][0]['decodeBytes'] == entry['decodeBytes']


def test_pack_level_decode_budget(store):
    """形象级：解码量之和 + 预算（面板据此判断「重不重」）。"""
    pack = store.runtime_pack('paged')
    assert pack['decodeBytes'] > 0
    assert pack['decodeBudgetBytes'] > 0
    # 预算是 128 MiB（约两页 4096²）
    assert pack['decodeBudgetBytes'] == 128 * 1024 * 1024


# ------------------------------------------------------------ 覆盖语义


def test_override_only_applies_to_first_page(writable_store, tmp_path):
    """单动作覆盖**只作用于第一套动画的第 0 页**。

    规则简单才不会出现「上传一张图后其余几页静默消失」这种怪事。
    """
    from pet_test_support import make_image_bytes

    store = writable_store
    store.save_action_image('paged', 'idle', make_image_bytes(size=(64, 64)))
    first, source_first = store.resolve_frame_path('paged', 'idle', page=0)
    second, source_second = store.resolve_frame_path('paged', 'idle', page=1)
    assert source_first == 'override', '第 0 页应命中覆盖'
    assert source_second == 'pack', '第 1 页不该被覆盖影响'
    assert first != second


# ------------------------------------------------------------ 导出


def test_export_includes_every_page(writable_store):
    """★ 导出必须带上**每一页**。

    只导出第一页的话，「导出再导入」会静默丢掉后面几页——
    而包能读、宠物能跑，只是那个动作少了一半帧。
    """
    import io
    import zipfile

    data = writable_store.export_pet('paged')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = set(archive.namelist())
    for expected in ('idle-0.png', 'idle-1.png', 'c0.png', 'c1.png'):
        assert expected in names, f'导出缺少 {expected}（多页动作的后续页被丢了）'


def test_export_import_round_trip_keeps_pages(writable_store):
    """导出再导入后，多页动作仍然是多页。"""
    store = writable_store
    data = store.export_pet('paged')
    imported = store.import_zip(data)
    entry = imported['actions']['idle']
    assert len(entry['pages']) == 2
    assert entry['frames'] == 4
    # 两页都要能解析到文件
    for index in range(2):
        path, _ = store.resolve_frame_path(imported['id'], 'idle', page=index)
        assert path and os.path.isfile(path)


# ------------------------------------------------------------ 列表缩略图


def test_list_thumb_survives_multi_page(store):
    """多页形象也要能在列表里显示缩略图（否则列表里那张卡是空的）。"""
    items = store.list_pets()
    paged = next(item for item in items if item['id'] == 'paged')
    assert not paged.get('error'), paged.get('error')
    thumb = paged['thumb']
    assert thumb['url'], '缩略图应有 URL'
    assert thumb['cols'] >= 1 and thumb['rows'] >= 1
    assert isinstance(thumb.get('size'), dict)
