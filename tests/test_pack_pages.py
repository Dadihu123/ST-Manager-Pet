"""多页 sheet（`sheets`）：一个动作拆成多张图，帧序**页优先、页内行优先**。

为什么需要多页
--------------
单图的**解码像素**上限（4096×4096 ≈ 16.8 Mpx ≈ 60 MiB 显存）是一道硬墙。
网格化（`cols` × `rows`）只能把这道墙用满（约 7 倍），要再往上就只能加页：
显存占用是**页数 × 每页大小**，因此这是唯一能线性扩展的维度。

真正的瓶颈是显存，不是磁盘
--------------------------
一张 4096² 的 sheet 解出来是 64 MiB 常驻显存，与它的 PNG 是 1 MB 还是
9 MB **无关**。因此「能放多少帧」由像素总数决定。多页的代价也在这里：
每多一页就多一份解码量，所以页数必须有上限（`MAX_PAGES`），
而且要把占用**显示给用户**（`decodeBytes`）——用户看不到显存。

每页形状相同
------------
所有页都是同样的 `cols × rows`。不做「最后一页按剩余帧数变小」是因为那会
引出**逐页几何**：前端要维护 `pageGrids[]`，预览与缩略图也要各处理一遍，
而省下的只是最后一页的透明格（PNG 里几乎不占字节）。
"""

import pytest

from backend.core.pack import (
    DECODE_BUDGET_BYTES,
    MAX_FRAMES,
    MAX_PAGES,
    decode_bytes,
    frame_page,
    frame_page_count,
    from_dict,
    page_capacity,
)
from backend.core.errors import CODE_PACK_FIELD_INVALID


def _pack(**anims):
    base = {'idle': 'idle.png'}
    base.update(anims)
    return from_dict({'id': 'pages', 'animations': base})


def _variant(spec):
    return _pack(idle=spec).animations['idle'].primary


# ==================================================== 纯函数

def test_frame_page_is_page_major_then_row_major():
    """帧序：先把第 0 页走完（行优先），再进第 1 页。

    这与单页内 `grid` 的顺序完全一致，因此「单页 → 多页」是自然扩展，
    作者不必重新理解播放顺序。
    """
    grid = (2, 2)   # 每页 4 帧
    expected = [
        (0, 0, 0, 0), (0, 1, 1, 0), (0, 2, 0, 1), (0, 3, 1, 1),
        (1, 0, 0, 0), (1, 1, 1, 0), (1, 2, 0, 1), (1, 3, 1, 1),
    ]
    for index, want in enumerate(expected):
        assert frame_page(index, grid, 8) == want, f'第 {index} 帧'


def test_frame_page_clamps_out_of_range():
    """越界夹到最后一帧，而不是落到空格子上（那会让宠物凭空消失一帧）。"""
    assert frame_page(99, (2, 2), 6) == frame_page(5, (2, 2), 6)
    assert frame_page(-3, (2, 2), 6) == (0, 0, 0, 0)


def test_frame_page_handles_degenerate_grids():
    for grid in [(0, 0), (1, 1), (None, None)]:
        page, local, col, row = frame_page(0, grid, 1)
        assert page == 0 and local == 0 and col == 0 and row == 0


def test_frame_page_count():
    assert frame_page_count((2, 2), 4) == 1
    assert frame_page_count((2, 2), 5) == 2
    assert frame_page_count((2, 2), 8) == 2
    assert frame_page_count((8, 8), 100) == 2
    assert frame_page_count((8, 8), 0) == 1


def test_page_capacity_prefers_declared_grid():
    """★ 声明了 `cols` × `rows` 时容量就是它——不能被「帧数 ÷ 页数」改写。

    反过来会让作者写的 4×4 变成 4×3 之类的东西，表现是
    「我明明写了 4×4，它却按别的形状切图」。
    """
    assert page_capacity(20, 2, 4, 4) == 16
    assert page_capacity(100, 2, 8, 8) == 64
    # 没声明（或只声明一个方向）→ 按平均分页推
    assert page_capacity(20, 2, 0, 0) == 10
    assert page_capacity(20, 2, 4, 0) == 10
    # 单页时退化成「帧数」，因此旧包行为完全不变
    assert page_capacity(4, 1, 0, 0) == 4


def test_decode_bytes():
    """解码量 = 帧数 × 宽 × 高 × 4（RGBA）。

    这才是容量瓶颈：与文件大小无关，只与像素总数有关。
    """
    assert decode_bytes(1, 384, 576) == 384 * 576 * 4
    assert decode_bytes(100, 384, 576) == 100 * 384 * 576 * 4
    assert decode_bytes(0, 384, 576) == 0
    # 一张 4096² 是 64 MiB —— 这是单页的硬上限
    assert decode_bytes(1, 4096, 4096) == 64 * 1024 * 1024
    # 预算约等于 2 页
    assert DECODE_BUDGET_BYTES == 128 * 1024 * 1024


# ==================================================== 解析

def test_single_page_unchanged():
    """向后兼容：单页包的解析结果与从前**逐字段一致**。"""
    variant = _variant({'sheet': 'a.png', 'frames': 4})
    assert variant.sheets == ['a.png']
    assert variant.sheet == 'a.png'
    assert variant.grid == (4, 1)
    assert variant.page_count == 1


def test_sheets_with_one_entry_is_allowed():
    """长度为 1 的 `sheets` 合法（等价于 `sheet`）——工具生成时不必特判。"""
    variant = _variant({'sheets': ['a.png'], 'frames': 4})
    assert variant.sheets == ['a.png']
    assert variant.page_count == 1


def test_multi_page_parses():
    variant = _variant({'sheets': ['a.png', 'b.png'], 'frames': 20, 'cols': 4, 'rows': 4})
    assert variant.sheets == ['a.png', 'b.png']
    assert variant.page_count == 2
    # 网格定义容量：4×4 = 16/页，20 帧占 2 页
    assert variant.grid == (4, 4)
    assert variant.capacity == 16


def test_multi_page_without_grid_splits_evenly():
    """没声明网格时按「总帧数平均分到各页」推——单行是自然结果。"""
    variant = _variant({'sheets': ['a.png', 'b.png'], 'frames': 20})
    assert variant.grid == (10, 1), '20 帧 / 2 页 = 每页 10 帧，单行'


def test_sheet_and_sheets_are_mutually_exclusive():
    """同时写 `sheet` 与 `sheets` 是真矛盾，必须报错。

    挑一个的后果是「我明明给了 2 页，它只播了第 1 页」——而包能读、
    宠物能跑，作者只会以为是引擎的 bug。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.png', 'sheets': ['b.png'], 'frames': 4})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'sheet' in info.value.user_msg


def test_too_many_pages_is_an_error():
    """页数上限是**显存**护栏，不是磁盘护栏（每页 64 MiB）。"""
    with pytest.raises(Exception) as info:
        _variant({
            'sheets': [f'p{i}.png' for i in range(MAX_PAGES + 1)],
            'frames': 4,
            'cols': 1, 'rows': 1,
        })
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert str(MAX_PAGES) in info.value.user_msg


def test_frames_must_fit_across_all_pages():
    """装不下就报错，并指出**需要几页**——静默丢帧是最坏的后果。"""
    with pytest.raises(Exception) as info:
        _variant({'sheets': ['a.png', 'b.png'], 'frames': 200, 'cols': 8, 'rows': 8})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert '200' in info.value.user_msg
    assert '128' in info.value.user_msg, '应说明两页共 128 格'
    assert '4 页' in info.value.hint, f'提示里应给出需要的页数: {info.value.hint}'


def test_unused_pages_are_an_error():
    """★ 声明的页数超过实际需要的页数 → 报错。

    多出来的那几页**永远不会被播到**，而作者以为它在用。
    这属于「我明明给了 3 页，它只播了 2 页」这类最难查的问题，
    因此直接报错而不是静默接受。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheets': ['a.png', 'b.png', 'c.png'], 'frames': 100,
                  'cols': 8, 'rows': 8})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert '3 页' in info.value.user_msg and '2 页' in info.value.user_msg
    # 提示要给出两种修法
    assert 'sheets' in info.value.hint
    assert '129' in info.value.hint, f'应给出「帧数提到多少」: {info.value.hint}'


def test_empty_sheet_entry_is_an_error():
    """多页里某一项为空 → 报错（而不是静默跳过，那会让页号整体前移）。"""
    for bad in (['a.png', ''], ['a.png', None]):
        with pytest.raises(Exception) as info:
            _variant({'sheets': bad, 'frames': 8, 'cols': 2, 'rows': 2})
        assert info.value.code == CODE_PACK_FIELD_INVALID


def test_sheets_must_be_an_array():
    with pytest.raises(Exception) as info:
        _variant({'sheets': 'a.png', 'frames': 4})
    assert info.value.code == CODE_PACK_FIELD_INVALID


def test_sheet_paths_are_validated_in_every_page():
    """路径安全校验要覆盖**每一页**——只查第一页会让后面几页绕过检查。"""
    for bad in (['a.png', '../evil.png'], ['a.png', '/abs.png'], ['a.png', 'x.exe']):
        with pytest.raises(Exception):
            _variant({'sheets': bad, 'frames': 8, 'cols': 2, 'rows': 2})


def test_max_frames_allows_large_animations():
    """`MAX_FRAMES` 提到 1024 是为了配合多页（一页几十到几百帧）。

    单页 4096² 上限下单帧 128×192 能装 672 帧，因此 1024 帧确实需要多页——
    这正是提上限的意义。
    """
    assert MAX_FRAMES == 1024
    # 每页 32×32 = 1024 格，1024 帧需要 2 页
    variant = _variant({'sheets': ['a.png', 'b.png'], 'frames': 1024,
                        'cols': 24, 'rows': 24})
    assert variant.frames == 1024
    assert variant.capacity == 576
    assert variant.page_count == 2


def test_frame_count_at_the_max_is_accepted():
    """正好用满上限：单页 1024 帧（例如 32×32 的网格）。"""
    variant = _variant({'sheet': 'a.png', 'frames': MAX_FRAMES,
                        'cols': 32, 'rows': 32})
    assert variant.frames == 1024
    assert variant.capacity == 1024
    assert variant.page_count == 1


# ==================================================== 往返 / 运行期定义

def test_multi_page_to_dict_writes_sheets():
    """多页写 `sheets` 数组、单页写 `sheet` 字符串——单页不该变啰嗦。"""
    multi = _pack(idle={'sheets': ['a.png', 'b.png'], 'frames': 20,
                        'cols': 4, 'rows': 4}).to_dict()['animations']['idle']
    assert multi['sheets'] == ['a.png', 'b.png']
    assert 'sheet' not in multi

    single = _pack(idle={'sheet': 'a.png', 'frames': 4}).to_dict()['animations']['idle']
    assert single['sheet'] == 'a.png'
    assert 'sheets' not in single


def test_multi_page_round_trips():
    """★ 多页必须能「导出再导入」——那正是用户搬运形象的方式。"""
    first = _pack(idle={'sheets': ['a.png', 'b.png'], 'frames': 20,
                        'cols': 4, 'rows': 4, 'fps': 12})
    dumped = first.to_dict()
    second = from_dict({'id': dumped['id'], 'animations': dumped['animations']},
                       pack_id=dumped['id'])
    variant = second.animations['idle'].primary
    assert variant.sheets == ['a.png', 'b.png']
    assert variant.frames == 20
    assert variant.grid == (4, 4)
    assert variant.page_count == 2


def test_resolved_variant_carries_sheets_and_geometry():
    resolved = _pack(idle={'sheets': ['a.png', 'b.png'], 'frames': 20,
                           'cols': 4, 'rows': 4}).resolve('idle')
    assert resolved.sheet == 'a.png', '第一页'
    variant = resolved.variants[0]
    assert variant.sheets == ['a.png', 'b.png']
    assert variant.grid == (4, 4)
    assert variant.page_count == 2
    dumped = variant.to_dict()
    assert dumped['sheets'] == ['a.png', 'b.png']
    assert dumped['cols'] == 4 and dumped['rows'] == 4
    # URL **不**在这一层：`pack` 只回答「用哪个文件」，URL 由 store 层按
    # 「覆盖 > 包内 > 内置」解析之后才拼得出来（见 `test_store_pages.py`）。
    assert 'url' not in dumped
    assert 'pages' not in dumped


def test_resolved_variant_writes_sheet_for_single_page():
    dumped = _pack(idle={'sheet': 'a.png', 'frames': 4}).resolve('idle').variants[0].to_dict()
    assert dumped['sheet'] == 'a.png'
    assert 'sheets' not in dumped
    assert 'url' not in dumped


def test_variants_cannot_mix_top_level_sheets():
    with pytest.raises(Exception) as info:
        from_dict({
            'id': 'p',
            'animations': {'idle': {
                'sheets': ['a.png'],
                'variants': [{'sheet': 'a.png', 'frames': 4}],
            }},
        })
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert '混用' in info.value.user_msg
