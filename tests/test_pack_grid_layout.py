"""帧排布：`horizontal` / `vertical` / **`grid`**（网格）三种排布。

为什么要有 `grid`
-----------------
单行排布下，一页能装的帧数被**帧宽**卡死：内置形象单帧 384px 宽，
而单图上限是 4096px（`imports.MAX_IMAGE_DIMENSION`），于是最多 10 帧。
改成多行之后同样的图能装 10×7 = 70 帧——这是「同一张图、同样的解码成本」
下能白拿的最大一块（约 7 倍），而且不动任何管线。

核心设计：**只有一种几何**
--------------------------
`horizontal` 与 `vertical` 不是另外两套算法，而是网格的两个特例：

    horizontal → cols = frames, rows = 1
    vertical   → cols = 1,      rows = frames
    grid       → cols / rows 由作者给出（可以装不满）

三条独立分支里只要有两条不一致，就会出现「桌面上对、面板预览里错」
这种最难查的偏差。因此解析器把三种排布**全部**折算成 `(cols, rows)`
（`frame_grid`），前端只认这一对数。
"""

import pytest

from backend.core.pack import (
    LAYOUT_GRID,
    LAYOUT_HORIZONTAL,
    LAYOUT_VERTICAL,
    MAX_FRAMES,
    frame_grid,
    from_dict,
)
from backend.core.errors import CODE_PACK_FIELD_INVALID


def _pack(**anims):
    base = {'idle': 'idle.png'}
    base.update(anims)
    return from_dict({'id': 'grid', 'animations': base})


def _variant(spec):
    return _pack(idle=spec).animations['idle'].primary


# ==================================================== frame_grid（纯函数）

def test_frame_grid_horizontal_and_vertical_are_grid_special_cases():
    """两种旧排布必须能被同一个网格模型精确表达。"""
    assert frame_grid(LAYOUT_HORIZONTAL, 4) == (4, 1)
    assert frame_grid(LAYOUT_VERTICAL, 4) == (1, 4)
    assert frame_grid(LAYOUT_GRID, 4, 4, 4) == (4, 4)


def test_frame_grid_fills_the_missing_direction():
    """网格只给一个方向时，另一个按「装得下」补——补出来的是最小网格。

    补 1 是错的：那等于把 `cols: 4, rows: 1` 当成单行，作者写的「4 列」
    看起来生效了，实际 4 帧以外全丢。
    """
    assert frame_grid(LAYOUT_GRID, 10, cols=4) == (4, 3)
    assert frame_grid(LAYOUT_GRID, 8, cols=4) == (4, 2)
    assert frame_grid(LAYOUT_GRID, 8, rows=2) == (4, 2)
    # 帧数不足一行时也不会推出 0 行
    assert frame_grid(LAYOUT_GRID, 3, cols=8) == (8, 1)


def test_frame_grid_never_returns_zero_or_negative():
    for args in [
        (LAYOUT_GRID, 0, 0, 0), (LAYOUT_GRID, 1, 0, 0), (LAYOUT_HORIZONTAL, 0),
        (LAYOUT_VERTICAL, -3), ('', 0), (None, None),
    ]:
        cols, rows = frame_grid(*args)
        assert cols >= 1 and rows >= 1, f'{args} → {(cols, rows)}'
        assert isinstance(cols, int) and isinstance(rows, int)


# ==================================================== 解析：三种写法

def test_parse_grid_with_both_directions():
    variant = _variant({'sheet': 'a.png', 'frames': 13, 'cols': 4, 'rows': 4})
    assert variant.layout == LAYOUT_GRID
    assert variant.grid == (4, 4)
    # 13 帧放进 16 格是**合法**的：网格装不满，空格子透明。
    # 这正是用户明确要求的「避免没有填满的情况」。
    assert variant.capacity == 16


def test_parse_grid_layout_name_explicit():
    variant = _variant({'sheet': 'a.png', 'frames': 16, 'layout': 'grid',
                        'cols': 4, 'rows': 4})
    assert variant.layout == LAYOUT_GRID
    assert variant.grid == (4, 4)


def test_parse_grid_infers_missing_direction():
    """只写 `cols` 也要能用——那是作者最容易写出的东西。"""
    variant = _variant({'sheet': 'a.png', 'frames': 13, 'cols': 4})
    assert variant.layout == LAYOUT_GRID
    assert variant.grid == (4, 4), '4 列装 13 帧需要 4 行'

    variant = _variant({'sheet': 'a.png', 'frames': 6, 'rows': 2})
    assert variant.layout == LAYOUT_GRID
    assert variant.grid == (3, 2)


def test_parse_horizontal_and_vertical_still_work():
    """向后兼容：老写法的解析结果**完全不变**。"""
    flat = _variant({'sheet': 'a.png', 'frames': 4})
    assert flat.layout == LAYOUT_HORIZONTAL
    assert flat.grid == (4, 1)

    vert = _variant({'sheet': 'a.png', 'frames': 4, 'layout': 'vertical'})
    assert vert.layout == LAYOUT_VERTICAL
    assert vert.grid == (1, 4)


# ==================================================== 解析：错误必须可读

def test_grid_without_any_direction_is_an_error():
    """`layout: "grid"` 但不给行列：无从知道一行放几个，必须报错。

    静默按单行处理是最坏的选择——作者写了 `grid`，得到的却是单行排布，
    而包能读、宠物能跑，他只会以为是引擎的 bug。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.png', 'frames': 4, 'layout': 'grid'})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'cols' in info.value.user_msg or 'rows' in info.value.user_msg


def test_grid_too_small_for_frames_is_an_error():
    """帧放不下：作者一定算错了，不能静默丢帧。"""
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.png', 'frames': 20, 'cols': 4, 'rows': 4})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    # 错误信息要指出「需要多少行」，否则作者还得自己算
    assert '20' in info.value.user_msg
    assert '5' in info.value.hint, f'提示里应给出需要的行数: {info.value.hint}'


def test_layout_conflicting_with_cols_is_an_error():
    """`horizontal` + 矛盾的 `cols` 是真矛盾，必须报错。

    一个说单行、一个说 4 列——挑任何一个都是错的，而挑错的那个表现是
    「我明明设了 4 列，它却排成一行」。
    """
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.png', 'frames': 8, 'layout': 'horizontal', 'cols': 4})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert '冲突' in info.value.user_msg

    with pytest.raises(Exception):
        _variant({'sheet': 'a.png', 'frames': 4, 'layout': 'vertical', 'rows': 3})


def test_layout_consistent_with_cols_is_accepted():
    """★ 但**一致**的冗余写法必须收下——否则「导出再导入」会直接失败。

    `to_dict()` 的输出、工具生成的包都会长这样（`layout` 是作者意图、
    `cols`/`rows` 是几何），把冗余一律判成冲突就是自己造出来的 bug。
    """
    variant = _variant({'sheet': 'a.png', 'frames': 4, 'layout': 'horizontal',
                        'cols': 4, 'rows': 1})
    assert variant.grid == (4, 1)

    variant = _variant({'sheet': 'a.png', 'frames': 4, 'layout': 'vertical',
                        'cols': 1, 'rows': 4})
    assert variant.grid == (1, 4)


def test_unknown_layout_name_is_rejected():
    with pytest.raises(Exception) as info:
        _variant({'sheet': 'a.png', 'frames': 4, 'layout': 'diagonal'})
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert 'grid' in info.value.hint, '提示里要列出合法取值'


def test_cols_and_rows_must_be_integers_in_range():
    for bad in [{'cols': 0}, {'cols': -1}, {'cols': 1.5}, {'cols': MAX_FRAMES + 1},
                {'rows': 'x'}, {'cols': True}]:
        spec = {'sheet': 'a.png', 'frames': 4}
        spec.update(bad)
        with pytest.raises(Exception) as info:
            _variant(spec)
        assert info.value.code == CODE_PACK_FIELD_INVALID, f'{bad} 应被拒绝'


def test_variants_cannot_mix_top_level_cols():
    """写了 `variants` 之后 `cols` / `rows` 要写进每一套里（与其它字段一致）。"""
    with pytest.raises(Exception) as info:
        from_dict({
            'id': 'g',
            'animations': {'idle': {
                'cols': 4,
                'variants': [{'sheet': 'a.png', 'frames': 4, 'cols': 4, 'rows': 1}],
            }},
        })
    assert info.value.code == CODE_PACK_FIELD_INVALID
    assert '混用' in info.value.user_msg


# ==================================================== 运行期定义 / 往返

def test_to_dict_emits_grid_geometry_for_grid_layout():
    """网格排布下 `cols` / `rows` **必须**写出来——`layout: "grid"` 本身
    不携带形状信息，丢掉它们就等于丢掉「一行放几个」。"""
    dumped = _pack(idle={'sheet': 'a.png', 'frames': 13, 'cols': 4, 'rows': 4}
                   ).to_dict()['animations']['idle']
    assert dumped['layout'] == 'grid'
    assert dumped['cols'] == 4
    assert dumped['rows'] == 4


def test_to_dict_omits_grid_geometry_for_derived_layouts():
    """单行 / 单列的形状由 `layout` + 帧数唯一确定，写出来只是噪音。

    更重要的是：同时写 `layout: "horizontal"` 与 `cols`/`rows` 会让
    「导出再导入」多绕一道一致性校验——能省则省。
    """
    dumped = _pack(idle={'sheet': 'a.png', 'frames': 4}).to_dict()['animations']['idle']
    assert dumped['layout'] == 'horizontal'
    assert 'cols' not in dumped and 'rows' not in dumped


def test_grid_round_trips_through_json():
    """★ 网格排布必须能「导出再导入」——那正是用户搬运形象的方式。"""
    first = _pack(idle={'sheet': 'a.png', 'frames': 13, 'cols': 4, 'rows': 4,
                        'fps': 6, 'frameMs': [100] * 13})
    dumped = first.to_dict()
    second = from_dict({'id': dumped['id'], 'animations': dumped['animations']},
                       pack_id=dumped['id'])
    variant = second.animations['idle'].primary
    assert variant.layout == LAYOUT_GRID
    assert variant.grid == (4, 4)
    assert variant.frames == 13
    assert variant.frame_ms == [100] * 13


def test_resolved_variant_always_carries_grid_geometry():
    """★ 运行期定义**总是**下发 `cols` / `rows`（哪怕是推导出来的）。

    推导只做一次、且在后端做：让前端自己再推一遍就是「后端一套规则、
    前端一套规则」，两套不一致的表现是「桌面上对、面板预览里错」。
    """
    resolved = _pack(idle={'sheet': 'a.png', 'frames': 4}).resolve('idle')
    assert resolved.cols == 4 and resolved.rows == 1
    assert resolved.variants[0].cols == 4 and resolved.variants[0].rows == 1
    assert resolved.to_dict()['cols'] == 4
    assert resolved.to_dict()['variants'][0]['rows'] == 1


def test_resolved_grid_action_carries_grid_geometry():
    resolved = _pack(idle={'sheet': 'a.png', 'frames': 13, 'cols': 4, 'rows': 4}
                     ).resolve('idle')
    assert resolved.cols == 4 and resolved.rows == 4
    assert resolved.to_dict()['cols'] == 4


# ==================================================== 标准图像的网格

def test_still_can_use_a_grid_sheet():
    """标准图像可以从**任意一条** sheet 取一帧，包括网格排布的。"""
    pack = from_dict({
        'id': 'g',
        'animations': {'idle': {'sheet': 'a.png', 'frames': 13, 'cols': 4, 'rows': 4}},
        'still': {'sheet': 'a.png', 'frames': 13, 'frame': 6, 'cols': 4, 'rows': 4},
    })
    still = pack.resolve_still()
    assert still.frame == 6
    assert still.grid == (4, 4), '标准图像必须带上网格，否则算不出第 6 帧在哪'


def test_still_fallback_inherits_the_idle_grid():
    """★ 回落路径必须继承 idle 那条 sheet 的网格。

    用默认的单行去切一条网格排布的 sheet，取到的不是「第 0 帧」而是
    「第 0 行第 0 列」——单行时两者恰好相同，网格排布时则完全不同。
    这是本特性最容易漏的一处。
    """
    pack = from_dict({
        'id': 'g',
        'animations': {'idle': {'sheet': 'a.png', 'frames': 13, 'cols': 4, 'rows': 4}},
    })
    still = pack.resolve_still()
    assert still.declared is False
    assert still.frame == 0
    assert still.grid == (4, 4), '回落时必须继承 idle 的网格'


def test_still_grid_round_trips():
    payload = {
        'id': 'g',
        'animations': {'idle': {'sheet': 'a.png', 'frames': 13, 'cols': 4, 'rows': 4}},
        'still': {'sheet': 'a.png', 'frames': 13, 'frame': 6, 'cols': 4, 'rows': 4},
    }
    dumped = from_dict(payload).to_dict()
    again = from_dict({'id': 'g', 'animations': dumped['animations'],
                       'still': dumped['still']})
    assert again.resolve_still().grid == (4, 4)
    assert again.resolve_still().frame == 6


def test_still_layout_conflict_is_an_error():
    with pytest.raises(Exception) as info:
        from_dict({
            'id': 'g',
            'animations': {'idle': 'a.png'},
            'still': {'sheet': 'a.png', 'frames': 4, 'layout': 'horizontal', 'cols': 3},
        })
    assert info.value.code == CODE_PACK_FIELD_INVALID


# ==================================================== 内置形象

def test_builtin_xiaoka_sleep_is_vertical():
    """★ 内置「小卡」的睡觉动作是**竖排**的，用来验证网格特性。

    这个动作是横构图（单帧 627×353）——横向 4 帧要占 2508px 宽，
    而竖排只占 627px 宽、1412px 高，在 4096 的上限下能放得下更多帧，
    图本身也更好看（用户明确点名过这件事）。
    """
    import os

    from backend.core.pack import load_file

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(repo, 'resources', 'pets', 'xiaoka', 'pet.json')
    if not os.path.isfile(path):
        pytest.skip('内置形象不在仓库里')

    pack = load_file(path)
    sleep = pack.animations['sleep'].primary
    assert sleep.layout == LAYOUT_VERTICAL, '小卡的睡觉应是竖排'
    assert sleep.grid == (1, 4)
    # 单帧尺寸不变（横构图），变的只是拼接方向
    assert sleep.size == {'w': 627, 'h': 353}

    # sheet 的实际像素尺寸必须与声明一致（否则切帧会错位）
    from PIL import Image
    sheet = os.path.join(os.path.dirname(path), sleep.sheet)
    with Image.open(sheet) as image:
        assert image.size == (627, 353 * 4), (
            f'竖排 4 帧应是 627×1412，实际 {image.size}'
        )
