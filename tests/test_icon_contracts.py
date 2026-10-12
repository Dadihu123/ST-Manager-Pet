"""插件图标契约（`frontend/assets/icon.svg`）。

为什么这些断言值得存在
----------------------
宿主把插件图标当 **CSS mask** 渲染（`static/css/modules/icons.css:42`）：

    .ui-icon.ui-icon--asset {
      background-color: currentColor;
      -webkit-mask: var(--ui-icon-mask) center / contain no-repeat;
    }

两个直接后果，都是「不检查就会静默出错」的类型：

1. **`contain` 按 SVG 自身比例缩放**，而原设计稿的画布是 1792×2400、
   内容只占中间一块（x 93–1699, y 603–1916）。**不裁剪 viewBox** 的话，
   图标位里只剩很小一团——16px 下几乎看不清。所以「必须裁剪」是硬要求。
2. **mask 只看 alpha、颜色统一由 `currentColor` 决定**，所以图标必须是
   **单色剪影**。多色 / 渐变设计在这里会被抹平成一块色。
"""

import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_PATH = os.path.join(REPO_ROOT, 'frontend', 'assets', 'icon.svg')

#: 原始设计稿的画布与内容范围（由 `tools/analyze_icon.py` 解析得到）。
SOURCE_CANVAS = (1792, 2400)
CONTENT_BBOX = (93, 603, 1699, 1916)

#: 宿主图标位的实际尺寸档（`icons.css`）：xs/sm 是坞与菜单里最常见的两个。
ICON_SIZES = (16, 20, 24)


@pytest.fixture(scope='module')
def icon_source():
    with open(ICON_PATH, 'r', encoding='utf-8') as handle:
        return handle.read()


def parse_view_box(source: str):
    match = re.search(r'viewBox="([^"]+)"', source)
    assert match, 'icon.svg 必须有 viewBox（否则 mask 缩放不可控）'
    return [float(value) for value in match.group(1).split()]


# ------------------------------------------------------------------ 结构


def test_icon_file_exists_and_is_svg(icon_source):
    assert icon_source.lstrip().startswith('<svg')
    assert 'xmlns="http://www.w3.org/2000/svg"' in icon_source


def test_icon_has_view_box(icon_source):
    assert re.search(r'viewBox="\s*-?[\d.]+ +\S*', icon_source)


def test_icon_has_no_xml_declaration(icon_source):
    """内联进 HTML / 被 mask 引用时，XML 声明是多余的（也不该出现）。"""
    assert not icon_source.lstrip().startswith('<?xml')


def test_icon_paths_present(icon_source):
    """设计稿有 4 条 path（外框 + 眼 ×2 + 鼻嘴），一条都不能丢。"""
    assert len(re.findall(r'<path\b', icon_source)) == 4


# ------------------------------------------------------------------ 裁剪（核心）


def test_view_box_is_cropped_to_content(icon_source):
    """★ viewBox 必须紧贴内容，而不是沿用原画布。

    这是本文件最重要的一条：宿主用 `contain` 缩放，
    沿用 1792×2400 的原始比例会让图形在图标位里缩成一小团。
    """
    x, y, width, height = parse_view_box(icon_source)
    content_x0, content_y0, content_x1, content_y1 = CONTENT_BBOX
    content_w = content_x1 - content_x0
    content_h = content_y1 - content_y0

    # 允许四周留一点内边距，但不能超过内容的 10%
    assert width <= content_w * 1.10, f'viewBox 宽 {width} 明显大于内容 {content_w}（没裁剪？）'
    assert height <= content_h * 1.10, f'viewBox 高 {height} 明显大于内容 {content_h}（没裁剪？）'
    # 也不能裁得比内容还小（会切掉图形）
    assert width >= content_w, 'viewBox 比内容还窄，会切掉图形'
    assert height >= content_h, 'viewBox 比内容还高，会切掉图形'
    # 内容应该在 viewBox 内居中（左右上下留白接近）
    left_gap = content_x0 - x
    right_gap = (x + width) - content_x1
    assert abs(left_gap - right_gap) < 2, f'内容未水平居中：左 {left_gap} 右 {right_gap}'


def test_view_box_dropped_the_original_canvas_padding(icon_source):
    """反向验证：viewBox 不应等于原画布（否则就是没裁剪）。"""
    x, y, width, height = parse_view_box(icon_source)
    assert not (x == 0 and y == 0 and width == SOURCE_CANVAS[0] and height == SOURCE_CANVAS[1]), (
        'viewBox 仍是原始画布 —— 说明裁剪没生效'
    )
    # 原始画布高达 2400，裁剪后应明显矮得多
    assert height < SOURCE_CANVAS[1] * 0.7, f'高度 {height} 仍接近原画布 {SOURCE_CANVAS[1]}'


def test_aspect_ratio_matches_content(icon_source):
    """viewBox 的宽高比要等于内容宽高比，否则 mask 里图形会被拉伸。"""
    _x, _y, width, height = parse_view_box(icon_source)
    content_w = CONTENT_BBOX[2] - CONTENT_BBOX[0]
    content_h = CONTENT_BBOX[3] - CONTENT_BBOX[1]
    assert abs((width / height) - (content_w / content_h)) < 0.02


def test_intrinsic_size_matches_view_box_ratio(icon_source):
    """width/height 的比例应与 viewBox 一致，避免固有比例的歧义。

    两者同时存在时，SVG 的固有宽高比取自 `width`/`height`。
    写成 24×24 而 viewBox 是 1.18:1，多出来的部分要靠
    `preserveAspectRatio` 内补——多数浏览器结果一样，
    但没必要给不同实现留差异空间。
    """
    match = re.search(r'width="([\d.]+)"\s+height="([\d.]+)"', icon_source)
    assert match, 'icon.svg 应显式给出 width/height'
    out_w, out_h = float(match.group(1)), float(match.group(2))
    _x, _y, box_w, box_h = parse_view_box(icon_source)
    assert abs((out_w / out_h) - (box_w / box_h)) < 0.02, (
        f'固有比例 {out_w}:{out_h} 与 viewBox 比例 {box_w}:{box_h} 不一致'
    )
    # 名义尺寸放在图标档位附近，既不巨大也不为 0
    assert 16 <= out_w <= 64, f'名义宽 {out_w} 不合理'


# ------------------------------------------------------------------ mask 渲染


def test_icon_is_monochrome(icon_source):
    """★ mask 只看 alpha，颜色由 `currentColor` 决定 —— 多色会被抹平。

    因此图标只能是单色剪影。同时不允许渐变 / 滤镜（mask 下不会如预期呈现）。
    """
    fills = set(re.findall(r'fill="([^"]*)"', icon_source))
    # 允许：单一实色（含 currentColor）、或 none
    assert len(fills) <= 1, f'图标出现多种 fill（mask 下会被抹平成单色，设计意图会丢失）: {fills}'
    for banned in ('<linearGradient', '<radialGradient', '<filter', 'filter='):
        assert banned not in icon_source, f'mask 渲染不支持 {banned}，不要用'


def test_icon_uses_no_stroke_styling(icon_source):
    """宿主给图标 `<svg>` 的默认样式是 `fill:none; stroke:currentColor`。

    但插件图标走的是 mask（抠形状），因此设计必须是**填充式闭合路径**。
    这里断言路径自带 fill（`crop_icon.py` 会补），不依赖宿主的 stroke 默认值。
    """
    for tag in re.findall(r'<path[^>]*>', icon_source):
        assert 'fill=' in tag, f'path 缺少 fill（mask 下会变成不可见）: {tag[:80]}'


def test_icon_has_no_hardcoded_absolute_size(icon_source):
    """不得写死像素尺寸，否则图标位无法按档位缩放。"""
    for value in re.findall(r'(?:^|\s)(?:width|height)="(\d+)px"', icon_source):
        pytest.fail(f'图标不应写死 px 尺寸: {value}px')


# ------------------------------------------------------------------ 接入点


def test_manifest_entry_references_the_icon():
    """`entries[].icon` 必须是插件内资源路径（宿主会解析成 /api/plugins/<id>/assets/…）。"""
    import json

    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    icons = [entry.get('icon') for entry in manifest['frontend']['entries']]
    assert any(icon == 'frontend/assets/icon.svg' for icon in icons), (
        f'设置入口没有引用插件图标: {icons}'
    )


def test_surface_registration_references_the_icon():
    """设置面板的标题图标也应使用插件图标（与入口一致，辨识度统一）。"""
    source = os.path.join(REPO_ROOT, 'frontend', 'plugin.js')
    with open(source, 'r', encoding='utf-8') as handle:
        body = handle.read()
    assert "icon: 'frontend/assets/icon.svg'" in body


def test_toast_icon_uses_the_plugin_asset():
    """toast 图标用插件自带图标（通知品牌化）。

    这依赖宿主 `ST-Manager@715d0a8` 的修复：「toast 图标位接入统一解析，
    解锁宿主 176 个图标与插件自带图标」。

    修复前 toast 只接受 `state.js:TOAST_ICON_NAMES` 里写死的 16 个名字，
    插件资源路径一律被**静默丢弃**（`tools/check_toast_icons.py` 有当时的实证），
    因此当时只能退化成宿主通用的 `check`。
    """
    with open(os.path.join(REPO_ROOT, 'frontend', 'plugin.js'), encoding='utf-8') as handle:
        plugin = handle.read()
    assert "const TOAST_ICON = 'frontend/assets/icon.svg'" in plugin, (
        'toast 应使用插件自带图标（宿主已支持资源路径）'
    )


def test_toast_icon_documents_the_host_fix_and_fallback():
    """源码里要写明「依赖哪次宿主修复」以及「旧宿主上怎么降级」。

    这段注释的价值：下一个人看到「宿主图标位只接受白名单」的旧资料时，
    不会误以为这里写错了；同时知道旧宿主上会发生什么（图标空、文案在）。
    """
    with open(os.path.join(REPO_ROOT, 'frontend', 'plugin.js'), encoding='utf-8') as handle:
        plugin = handle.read()
    section = plugin[: plugin.index('const TOAST_ICON')]
    assert '715d0a8' in section, '应注明依赖的宿主修复 commit'
    assert 'resolveIcon' in section, '应说明现在与 entries[].icon 走同一套解析'
    assert 'missing' in section or '降级' in section, '应说明旧宿主上的降级行为'
    assert '文案' in section, '应说明降级时文案仍显示（功能不受影响）'


def test_plugin_asset_is_a_valid_toast_icon_path():
    """插件资源路径必须满足 `resolvePluginIcon()` 的约束，否则会被判 missing。

    `utils/icons.js` 的规则：含 `/` → 资源路径；扩展名必须在
    `PLUGIN_ICON_EXTENSIONS`（`.svg` / `.png` / `.webp`）内；
    不得是绝对路径、不得含 `..`。
    """
    with open(os.path.join(REPO_ROOT, 'frontend', 'plugin.js'), encoding='utf-8') as handle:
        plugin = handle.read()
    value = re.search(r"const TOAST_ICON = '([^']+)'", plugin).group(1)

    assert '/' in value, '插件资源路径必须含 /（否则会被当成宿主图标名）'
    assert not value.startswith('/'), '不得是绝对路径'
    assert '..' not in value.split('/'), '不得含 ..'
    extension = value[value.rindex('.'):].lower()
    assert extension in ('.svg', '.png', '.webp'), f'扩展名 {extension} 不在图标白名单内'
    # 真的指向存在的文件
    assert os.path.isfile(os.path.join(REPO_ROOT, value)), f'图标文件不存在: {value}'


def test_icon_url_is_reachable_from_manifest_path():
    """manifest 里的相对路径要真的指向文件（写错名字宿主只会显示占位图标）。"""
    import json

    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    for entry in manifest['frontend']['entries']:
        icon = entry.get('icon')
        if not icon:
            continue
        assert os.path.isfile(os.path.join(REPO_ROOT, icon)), f'manifest 里的图标不存在: {icon}'


# ------------------------------------------------- 缩略图几何（踩过的坑）


def test_card_thumbnail_shows_only_first_frame():
    """★ 形象卡片的缩略图必须只显示第 0 帧。

    真实踩过：`/frame/<id>/idle` 返回的是**整条** spritesheet
    （例如 4 帧的 idle 是 256×64），而缩略图方框只有 40×40。
    用 `background-size: contain` 会把整条压进去 → 每帧只剩 10px，
    看起来像一团乱码（截图上非常明显，但不是报错，所以不会自己冒出来）。

    正确做法：`background-size: (方框宽 × 帧数) auto` + 左对齐。
    """
    with open(os.path.join(REPO_ROOT, 'frontend', 'panel.js'), encoding='utf-8') as handle:
        source = handle.read()

    assert 'applyThumbGeometry' in source, '缺少缩略图几何计算函数'
    # 必须按帧数放大
    assert 'boxSize * frames' in source, '缩略图宽度没有乘以帧数'
    # 必须左对齐（居中会露出第 1、2 帧）
    assert "'left top'" in source, '缩略图应左对齐，否则会露出后续帧'
    # 不能再对 spritesheet 用 contain
    thumb_section = source[source.index('const thumb = el('):]
    thumb_section = thumb_section[:thumb_section.index('applyThumbGeometry')]
    assert "backgroundSize = 'contain'" not in thumb_section, (
        '缩略图不要用 contain —— 那是把整条 spritesheet 压进小方框的错法'
    )


def test_thumbnail_geometry_uses_backend_frame_count():
    """帧数必须来自后端（`detail.actions`），前端不猜。"""
    with open(os.path.join(REPO_ROOT, 'frontend', 'panel.js'), encoding='utf-8') as handle:
        source = handle.read()
    section = source[source.index('function applyThumbGeometry'):]
    section = section[:section.index('\n  }\n')]
    assert 'detail.actions' in section, '缩略图几何应从 detail 里取帧信息'
    assert 'Number(tile.frames)' in section, '帧数应取自后端给的 frames'


def test_thumbnail_geometry_handles_vertical_layout():
    """垂直排布的包也要处理（否则第二帧会被露出来）。"""
    with open(os.path.join(REPO_ROOT, 'frontend', 'panel.js'), encoding='utf-8') as handle:
        source = handle.read()
    section = source[source.index('function applyThumbGeometry'):]
    section = section[:section.index('\n  }\n')]
    assert "'vertical'" in section, '未处理 vertical 排布'
