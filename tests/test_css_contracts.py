"""CSS 契约测试：把 §0 判定标准里与样式有关的几条钉死在 CI 里。

最关键的一条是 **`position: fixed` 零出现**——实施提示词把它定为
「这条不过，整个任务就没做对」。它必须是一条会失败的测试，而不是一次性人工检查。

用法上这些检查故意做成**对源码文本的静态检查**（不做完整 CSS 解析），
因为宿主自己的检查器（`core/plugins/installer.py:scan_css_scope`）也是这么做的，
而且能直接跑在本仓库里、不依赖宿主。
"""

import os
import re

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_CSS = os.path.join(REPO_ROOT, 'frontend', 'plugin.css')
PLUGIN_JS = os.path.join(REPO_ROOT, 'frontend', 'plugin.js')
PLUGIN_ID = 'stm-pet'


def read(path):
    with open(path, 'r', encoding='utf-8') as handle:
        return handle.read()


def strip_comments(source: str) -> str:
    """去掉 `/* ... */` 注释。

    必须去掉：本文件的注释里**故意**提到了 `position: fixed` 来说明"不要写它"，
    不剥离注释的话检查会把文档当成违规。
    """
    return re.sub(r'/\*.*?\*/', '', source, flags=re.DOTALL)


@pytest.fixture(scope='module')
def css():
    return read(PLUGIN_CSS)


@pytest.fixture(scope='module')
def css_body(css):
    return strip_comments(css)


# ------------------------------------------------------------ 核心判定标准


def test_no_position_fixed_anywhere(css_body):
    """★ §0 判定标准：插件 CSS 里零个 `position: fixed`。

    常驻容器由宿主的 ambient surface 提供（它自己就是 `position: fixed; inset: 0`）；
    插件在容器内只需要 `position: absolute`。写了 fixed 就说明用法错了。
    """
    offenders = [
        line.strip()
        for line in css_body.splitlines()
        if re.search(r'position\s*:\s*fixed', line, re.IGNORECASE)
    ]
    assert offenders == [], (
        '插件 CSS 里不允许出现 position: fixed（常驻容器由宿主提供）:\n'
        + '\n'.join(offenders)
    )


def test_no_position_sticky_on_ambient_content(css_body):
    """ambient 里也不该用 sticky：那是文档流内的概念，容器是全屏浮层。"""
    assert not re.search(r'position\s*:\s*sticky', css_body, re.IGNORECASE)


def test_no_z_index_declarations(css_body):
    """不得自己设 z-index：层级由宿主容器决定（`--z-ambient` = 55）。"""
    offenders = [
        line.strip()
        for line in css_body.splitlines()
        if re.search(r'(^|[;\s])z-index\s*:', line)
    ]
    assert offenders == [], (
        '不要自己设 z-index，层级由宿主的 ambient 容器决定:\n' + '\n'.join(offenders)
    )


def test_every_top_level_rule_is_scoped(css):
    """每条顶层规则都必须以插件作用域为根（F11，不过则整份样式被拒绝加载）。

    这是宿主 `installer.scan_css_scope()` 的等价实现——本仓库不 import 宿主模块，
    所以在这里独立跑一遍，让「作用域写错了」在提交前就失败。
    """
    violations = scan_scope(css, PLUGIN_ID)
    assert violations == [], f'未加作用域的顶层选择器: {violations}'


def test_scope_checker_actually_detects_violations():
    """反向验证：检查器本身要能抓到违规，否则上面的断言是空转。"""
    bad = '.pet-body { pointer-events: auto; }\n'
    assert scan_scope(bad, PLUGIN_ID) == ['.pet-body']
    good = f'[{PLUGIN_ID_ATTR}] .pet-body {{ color: red; }}\n'
    assert scan_scope(good, PLUGIN_ID) == []


PLUGIN_ID_ATTR = f'data-plugin="{PLUGIN_ID}"'


def scan_scope(source: str, plugin_id: str) -> list:
    """找出顶层未加作用域的选择器（与宿主 `scan_css_scope` 同规则）。

    `@media` / `@supports` / `@layer` / `@container` 内部的选择器同样要带作用域；
    `@keyframes` / `@font-face` 内部豁免。
    """
    scope_tokens = (
        f'.plugin-{plugin_id}',
        f'[data-plugin="{plugin_id}"]',
        f"[data-plugin='{plugin_id}']",
    )
    skip_blocks = 0
    stack = []
    buffer = []
    violations = []
    index = 0
    length = len(source)
    group_at_rules = ('@media', '@supports', '@layer', '@container')
    exempt_at_rules = ('@keyframes', '@font-face')

    while index < length:
        char = source[index]

        if char == '/' and index + 1 < length and source[index + 1] == '*':
            end = source.find('*/', index + 2)
            index = length if end == -1 else end + 2
            continue

        if char == '{':
            selector = ''.join(buffer).strip()
            buffer = []
            head = selector.split(None, 1)[0].lower() if selector else ''
            if head.startswith('@'):
                if head in group_at_rules or head in exempt_at_rules:
                    skip_blocks += 1
                stack.append(head)
            else:
                if skip_blocks == 0 and selector and not any(
                    token in selector for token in scope_tokens
                ):
                    if not _is_keyframe_step(selector):
                        violations.append(selector)
                stack.append('')
            index += 1
            continue

        if char == '}':
            if stack:
                head = stack.pop()
                if head.startswith('@') and (
                    head in group_at_rules or head in exempt_at_rules
                ):
                    skip_blocks = max(0, skip_blocks - 1)
            buffer = []
            index += 1
            continue

        buffer.append(char)
        index += 1

    return violations


def _is_keyframe_step(selector: str) -> bool:
    first = selector.split(',', 1)[0].strip().lower()
    return first in ('from', 'to') or bool(re.match(r'^\d+(\.\d+)?%$', first))


# ------------------------------------------------------------ 声明层检查


def test_no_hardcoded_sprite_urls(css_body):
    """不得硬编码 sprite（F13）：用 `api.ui.icon(name)` 而不是 `url(...#icon-x)`。"""
    assert 'ui.svg#' not in css_body
    assert 'sidebar.svg#' not in css_body
    assert not re.search(r"url\(['\"]?/static/icons", css_body)


def test_var_usage_always_has_fallback(css_body):
    """引用 CSS 变量必须写回退值（F13）：`var(--x, #fff)`。

    没有回退值时，一旦宿主改名令牌，插件会静默失去样式（最难查的一类问题）。
    """
    offenders = []
    for match in re.finditer(r'var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])', css_body):
        token, terminator = match.group(1), match.group(2)
        if terminator == ')':
            line_no = css_body[: match.start()].count('\n') + 1
            offenders.append(f'line {line_no}: {token}')
    assert offenders == [], (
        'var() 必须带回退值，例如 var(--content-primary, #1f2937):\n'
        + '\n'.join(offenders)
    )


def test_no_important_on_unscoped_selectors(css_body):
    """非作用域选择器上不要用 `!important`（F15 warning）。"""
    # 找出所有含 !important 的规则块，检查其选择器是否带作用域
    for match in re.finditer(r'([^{}]+)\{([^}]*)\}', css_body):
        selector, body = match.group(1).strip(), match.group(2)
        if '!important' not in body:
            continue
        assert (
            f'.plugin-{PLUGIN_ID}' in selector or f'[data-plugin="{PLUGIN_ID}"]' in selector
        ), f'!important 用在未作用域的选择器上: {selector}'


def test_respects_prefers_reduced_motion(css):
    """**必须**遵守 `prefers-reduced-motion`（§4.5）。"""
    assert '@media (prefers-reduced-motion: reduce)' in css
    reduced_block = css[css.index('@media (prefers-reduced-motion: reduce)'):]
    # 该块里要真的关掉动画，而不是只改颜色
    assert re.search(r'animation\s*:\s*none', reduced_block), (
        'prefers-reduced-motion 块里必须真正关闭 animation'
    )


def test_no_keyframes_animate_frame_stepping(css_body):
    """★ 没有任何 `@keyframes` 可以动画 `background-position`（= 换帧）。

    这条规则原来写的是「`animation:` 只应出现在 reduced-motion 的关闭声明里」，
    理由是「本插件不用 CSS 动画驱动宠物（帧推进走 JS 的 rAF）」。
    加了「程序化运动」（呼吸）之后，这个理由需要**说得更准**：

    - 它真正要禁的是「**用 CSS 动画换帧**」——那会绕过时钟、`frameMs`、
      动画速度倍率，而且「帧推进走 rAF」这条设计会被撕成两半；
    - 而呼吸是**装饰性整体运动**，跑在合成器上、不需要 rAF，
      实测比 JS 循环便宜一个数量级（3.2 vs 62.3 ms/s），
      正是它让「宠物静止时 rAF 真的停掉」这条省电契约得以保持。

    因此规则改成**更精确、可检查**的形式：禁止的是关键帧里出现
    `background-position`，而不是禁止 `animation:` 本身。

    ⚠️ 检查必须落在**关键帧块内部**：`animation:` 简写只写动画名，
    不写被动画的属性——所以查简写是查不出东西的（这里最初就写错了）。
    """
    blocks = re.findall(r'@keyframes\s+([A-Za-z0-9_-]+)\s*\{', css_body)
    assert blocks, '插件里应当有 @keyframes（至少 pet-breathe）'
    for name in blocks:
        block = _keyframe_block(css_body, name)
        assert 'background-position' not in block, (
            f'@keyframes {name} 动画了 background-position —— 那是换帧的机制，'
            f'会绕过时钟与帧时长。换帧只能走 JS 的 rAF。'
        )


def _keyframe_block(source: str, name: str) -> str:
    """取出某个 `@keyframes` 的完整块（按花括号配对）。"""
    match = re.search(rf'@keyframes\s+{re.escape(name)}\s*\{{', source)
    assert match, f'找不到 @keyframes {name}'
    start = match.end() - 1
    depth = 0
    for index in range(start, len(source)):
        if source[index] == '{':
            depth += 1
        elif source[index] == '}':
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f'@keyframes {name} 的块没有闭合')


def test_motion_css_animates_transform_only(css_body):
    """反向钉死：`pet-breathe` 关键帧里只许出现 `transform`。"""
    block = _keyframe_block(css_body, 'pet-breathe')
    assert 'transform' in block, '呼吸关键帧必须用 transform'
    assert 'background' not in block, '呼吸关键帧不得碰 background'


def test_breathe_animation_is_opt_in_by_class(css_body):
    """★ 呼吸动画必须**挂在 `.has-breathe` 类下**，不能无条件挂在 `.pet-sprite` 上。

    无条件挂的后果：没声明 motion 的形象也会跑一个 amp=0 的动画——
    视觉上看不出来，但会**常驻一个合成层**，而且让「静止时零成本」
    这条契约对所有形象失效（§4.1 明确要求避免常驻 will-change/层）。
    """
    found = re.findall(r'([^{}]+)\{([^}]*animation\s*:\s*pet-breathe[^}]*)\}', css_body)
    assert found, '找不到应用 pet-breathe 的规则'
    for selector, _body in found:
        assert 'has-breathe' in selector, (
            f'呼吸动画必须由 .has-breathe 类开关，否则未声明的形象也会常驻合成层: {selector.strip()}'
        )


def test_breathe_origin_is_not_hardcoded(css_body):
    """★ 呼吸的 `transform-origin` 不能写死在 CSS 里。

    呼吸是「以脚底为原点做纵向缩放」，而脚底的位置是**每个形象各自的**
    `anchor.y`。写死 `bottom center` 时，锚点不在底边的形象会脚离地
    （实测锚点 y=0.85 时脚飘 3.5px）。因此原点必须由 JS 按 anchor 写入内联 style。
    """
    for match in re.finditer(r'([^{}]*has-breathe[^{}]*)\{([^}]*)\}', css_body):
        assert 'transform-origin' not in match.group(2), (
            '呼吸规则的 transform-origin 不能写死——必须由 JS 按包级 anchor.y 写入'
        )


def test_js_sets_the_breathe_origin_from_anchor():
    """★ JS 必须真的把 anchor 换算成 transform-origin 写下去。

    只写 CSS 不写 JS 的话，那条规则形同虚设——而这正是「CSS 里有一条
    永不生效的规则」这个曾经真实踩过的坑（见 `data-pet-pixelated` 那条）。
    """
    source = read(os.path.join(REPO_ROOT, 'frontend', 'petview.js'))
    assert 'motionOrigin' in source, (
        'petview.js 必须读取运行期下发的 motionOrigin 并写入 sprite.style.transformOrigin'
    )
    assert 'transformOrigin' in source
    assert 'has-breathe' in source, 'petview.js 必须按声明开关 has-breathe 类'


def test_pointer_events_auto_is_taken_back(css_body):
    """★ 必须有显式取回 `pointer-events: auto`。

    ambient 容器整体是 `pointer-events: none`，且该属性**可继承**——
    不取回的表现是「拖不动 / 点了没反应」（§8 陷阱 1）。
    """
    assert re.search(r'pointer-events\s*:\s*auto', css_body), (
        '宠物根元素必须显式取回 pointer-events: auto'
    )


def test_uses_both_scope_roots(css_body):
    """作用域根要**两种都写**。

    实测：宿主的 ambient shell 只带 `data-plugin` 属性、**不带** `plugin-<id>` 类
    （`plugin-<id>` 是 `api.createRoot()` 加的，落点在 plugin-host-root）。
    只写 `.plugin-stm-pet ...` 会整份样式静默匹配不到，
    症状恰好是「拖不动 / 点了没反应」（论证见 CHANGELOG「与实施提示词的偏差」第 2 条）。
    """
    assert f'[data-plugin="{PLUGIN_ID}"]' in css_body, (
        '必须用 [data-plugin="stm-pet"] —— 它才是 ambient 容器上真实存在的标记'
    )
    assert f'.plugin-{PLUGIN_ID}' in css_body, (
        '同时保留 .plugin-stm-pet：插件自绘元素会带上它，且这是宿主检查器的规范根'
    )


def test_ambient_content_uses_absolute_positioning(css_body):
    """宠物本体用 `position: absolute` 在容器内定位（而不是 fixed）。"""
    assert re.search(r'position\s*:\s*absolute', css_body)


# ------------------------------------------------------- 渲染方式（真实踩过）


def test_sprite_defaults_to_smooth_rendering(css_body):
    """★ `.pet-sprite` 的**默认**必须是平滑插值，不能恒开像素风。

    真实踩过的坑：这里原本写死 `image-rendering: pixelated`，而 JS 从未设置过
    `data-pet-pixelated` —— 于是那条 `="false"` 的规则**永不生效**，像素风恒开。
    用户把倍率调到 2× 以上时，写实插画 / 真人立绘会出现块状边缘。

    默认值必须反过来（auto），由 JS 按「包内声明 / 用户设置」显式打开硬边。
    """
    match = re.search(
        r'\[data-plugin="stm-pet"\] \.pet-sprite\s*,\s*'
        r'\.plugin-stm-pet \.pet-sprite\s*\{([^}]*)\}',
        css_body,
    )
    assert match, '找不到 .pet-sprite 的基础规则'
    body = match.group(1)
    assert 'image-rendering: auto' in body, (
        '.pet-sprite 默认应为 image-rendering: auto（写实插画放大时不该有硬边）'
    )
    assert 'pixelated' not in body, (
        '.pet-sprite 上不得写死 pixelated —— 那会让写实插画出现块状边缘'
    )


def test_pixelated_is_opt_in_via_data_attribute(css_body):
    """像素风由 `data-pet-pixelated="true"` 选择器打开（而不是恒开）。"""
    assert 'data-pet-pixelated="true"' in css_body, (
        '必须有 [data-pet-pixelated="true"] .pet-sprite { image-rendering: pixelated }'
    )
    match = re.search(
        r'\[data-plugin="stm-pet"\]\[data-pet-pixelated="true"\] \.pet-sprite[^{]*\{([^}]*)\}',
        css_body,
    )
    assert match and 'pixelated' in match.group(1)


def test_js_sets_the_pixelated_data_attribute():
    """★ JS 必须**真的**写这个属性，否则上面的 CSS 规则永不生效。

    这正是原来的 bug：CSS 里有 `="false"` 规则，但没有任何代码设置该属性。
    """
    source = read(os.path.join(REPO_ROOT, 'frontend', 'petview.js'))
    assert 'dataset.petPixelated' in source, (
        'petview.js 必须设置 root.dataset.petPixelated，否则渲染方式规则永不生效'
    )
    assert "'true'" in source and "'false'" in source


def test_frontend_scale_range_matches_backend():
    """★ 前端滑块的区间必须与后端校验区间一致，否则会出现「拖到了却存不下」。

    后端权威定义在 `backend/core/pack.py:SCALE_RANGE`。
    比较用**数值**而不是字符串：JS 里写 `4`、Python 里写 `4.0`，两者等价。
    """
    import json as _json

    backend = read(os.path.join(REPO_ROOT, 'backend', 'core', 'pack.py'))
    match = re.search(r'SCALE_RANGE\s*=\s*\(([^)]*)\)', backend)
    assert match, '找不到 SCALE_RANGE'
    low, high = [float(part.strip()) for part in match.group(1).split(',')]

    def declared(source: str, name: str) -> float:
        found = re.search(rf'{name}\s*=\s*([0-9.]+)', source)
        assert found, f'找不到 {name}'
        return float(found.group(1))

    for filename in ('panel.js', 'petview.js'):
        source = read(os.path.join(REPO_ROOT, 'frontend', filename))
        assert declared(source, 'SCALE_MIN') == low, f'{filename} 的 SCALE_MIN 应为 {low}'
        assert declared(source, 'SCALE_MAX') == high, f'{filename} 的 SCALE_MAX 应为 {high}'

    # ★ 权威区间**只**在 `pack.py` 里，不再要求 manifest 声明一份。
    #
    # 用户要求「不要搞全局的」：`scale` 已从宿主 config_schema 移出，
    # 改成纯按形象设置（`settings.json` 的 `petScales`）。
    # 同一份区间声明在三个地方（pack / manifest / 前端）时，改一处就会
    # 出现「滑块能拖但后端拒绝」；现在只剩 pack 与前端两处，且由这条测试钉住。
    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        schema = _json.load(handle)['config_schema']['properties']
    assert 'scale' not in schema, (
        'scale 是按形象的设置，不该再出现在宿主 config_schema 里'
    )


def test_frontend_blink_ranges_match_backend():
    """★ 面板上「眨眼间隔 / 眨眼时长」的区间必须与后端校验区间一致。

    与上一条（`scale`）同一个理由：后端在 `_parse_motion` 里对越界值**报错**，
    因此两边写死不同数字时，用户能在界面上填出一个保存必定失败的值——
    那看起来像一次「保存失败」，其实是一次「界面允许了它不该允许的输入」。

    单位不同（面板用秒、后端用毫秒），因此这里按数值换算后比较：
    0.3 秒 ↔ 300 毫秒、60 秒 ↔ 60000 毫秒。
    """
    backend = read(os.path.join(REPO_ROOT, 'backend', 'core', 'pack.py'))

    def backend_range(name: str):
        match = re.search(rf'{name}\s*=\s*\(([^)]*)\)', backend)
        assert match, f'找不到 {name}'
        return [float(part.strip()) for part in match.group(1).split(',')]

    panel = read(os.path.join(REPO_ROOT, 'frontend', 'panel.js'))

    def declared(name: str) -> float:
        found = re.search(rf'const {name}\s*=\s*([0-9.]+)', panel)
        assert found, f'panel.js 里找不到 {name}'
        return float(found.group(1))

    interval_low, interval_high = backend_range('BLINK_INTERVAL_RANGE')
    assert declared('BLINK_INTERVAL_MIN_S') * 1000 == interval_low, (
        f'BLINK_INTERVAL_MIN_S 应为 {interval_low / 1000} 秒'
    )
    assert declared('BLINK_INTERVAL_MAX_S') * 1000 == interval_high, (
        f'BLINK_INTERVAL_MAX_S 应为 {interval_high / 1000} 秒'
    )
    duration_low, duration_high = backend_range('BLINK_DURATION_RANGE')
    assert declared('BLINK_DURATION_MIN_MS') == duration_low
    assert declared('BLINK_DURATION_MAX_MS') == duration_high


def test_panel_never_renders_edit_controls_for_readonly_pets():
    """★ 内置形象（只读）不得渲染「换图 / 恢复 / 删除 / 导出」控件。

    后端也会拒绝（403），但 UI 上就不该出现——否则用户点了才发现不行。
    """
    source = strip_comments(read(os.path.join(REPO_ROOT, 'frontend', 'panel.js')))
    assert 'detail.writable' in source, 'panel.js 必须按 detail.writable 决定是否渲染编辑控件'

    export_index = source.index("button('导出形象包'")
    assert source.rindex('detail.writable', 0, export_index) != -1, (
        '「导出形象包」必须包在 detail.writable 判断里'
    )
    delete_index = source.index("button('删除'")
    assert source.rindex('detail.writable', 0, delete_index) != -1, (
        '「删除」必须包在 detail.writable 判断里'
    )


def test_download_link_is_hidden_inline():
    """★ 导出用的 `<a download>` 也必须**内联**隐藏。

    它与 `.pet-file-input` 是同一个坑：节点挂在 `document.body` 下，
    而作用域 CSS 选择器匹配不到 body 下的裸节点。
    """
    source = read(os.path.join(REPO_ROOT, 'frontend', 'panel.js'))
    start = source.index('function exportPet')
    section = source[start:source.index('\n  }\n', start)]
    assert "style.position = 'absolute'" in section
    assert "style.left = '-9999px'" in section
    assert "style.opacity = '0'" in section
    assert 'removeChild(link)' in section or 'link.remove()' in section, (
        '触发下载后要回收节点，否则每导出一次多一个 <a>'
    )


def test_panel_has_create_form():
    """用户能自己新建形象（本次的核心诉求之一）。"""
    source = read(os.path.join(REPO_ROOT, 'frontend', 'panel.js'))
    assert 'function renderCreate' in source, 'panel.js 必须有新建形象表单'
    assert "call('/pets/create'" in source, '必须调用新建接口'
    assert "'新建形象'" in source, '工具栏要有「新建形象」入口'


# ------------------------------------------- 动作词表前后端一致性（踩过的坑）


def test_frontend_creatable_actions_match_backend_vocabulary():
    """★ 前端「新建形象」的可上传动作必须与后端词表一致。

    真实踩过：正面 `walk` 已从后端词表删除、内置形象也不再出图，
    但 `panel.js` 的 `CREATABLE_ACTIONS` 里还留着 `walk` 槽位
    ——用户能选一张图传上去，得到一个永远播不到的词表外动作。
    这条把两边的词表钉在一起。
    """
    import json as _json
    import sys

    sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import ACTION_FALLBACKS, WALK_DIRECTION_ACTIONS

    source = read(os.path.join(REPO_ROOT, 'frontend', 'panel.js'))
    block = source[source.index('const CREATABLE_ACTIONS = ['):]
    block = block[:block.index('];')]
    actions = re.findall(r"action:\s*'([^']+)'", block)
    assert actions, '解析不出 CREATABLE_ACTIONS'

    assert actions[0] == 'idle', 'idle 必须排第一（唯一硬必要动作）'
    for name in actions:
        assert name in ACTION_FALLBACKS, (
            f'CREATABLE_ACTIONS 里的 {name} 不在后端词表里——传上去也播不到'
        )
    # 词表里的动作（除 `walk` 这个需求代号）都要能在新建表单里上传
    for name in ACTION_FALLBACKS:
        assert name in actions, f'后端词表里的 {name} 在新建表单里没有槽位'
    # 方向化行走必须两个方向都在
    for name in WALK_DIRECTION_ACTIONS:
        assert name in actions, f'缺少 {name} 的上传槽位'
    assert 'walk' not in actions, '正面 walk 已退役，不该再有上传槽位'


def test_frontend_action_labels_cover_backend_vocabulary():
    """面板的动作标签表必须覆盖后端词表 + `walk` 这个需求代号。

    漏一个的后果：面板上那个动作直接显示英文 id，用户不知道那是什么。
    """
    import sys

    sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import ACTION_FALLBACKS, REQUIRED_ACTIONS

    source = read(os.path.join(REPO_ROOT, 'frontend', 'panel.js'))
    block = source[source.index('const ACTION_LABELS = {'):]
    block = block[:block.index('};')]
    labels = re.findall(r"^\s*'?([A-Za-z-]+)'?:\s*'", block, flags=re.MULTILINE)

    for name in list(ACTION_FALLBACKS) + list(REQUIRED_ACTIONS):
        assert name in labels, f'ACTION_LABELS 缺少 {name} 的中文标签'


def test_frontend_required_actions_match_backend():
    """前端「必要动作」名单必须与后端一致（否则徽标/提示会对不上）。"""
    import sys

    sys.path.insert(0, REPO_ROOT)
    from backend.core.pack import REQUIRED_ACTIONS

    source = read(os.path.join(REPO_ROOT, 'frontend', 'panel.js'))
    match = re.search(r'const REQUIRED_ACTIONS = \[([^\]]*)\]', source)
    assert match, '找不到 REQUIRED_ACTIONS'
    declared = re.findall(r"'([^']+)'", match.group(1))
    assert declared == list(REQUIRED_ACTIONS), (
        f'前端 {declared} 与后端 {list(REQUIRED_ACTIONS)} 不一致'
    )


def test_builtin_pets_directory_holds_only_the_shipped_faces():
    """随包内置形象目录里只应有 `xiaoman` / `xiaoka` / `xiaoying`。

    `default-cat` 已随生成脚本一起移除；这条防止它被误加回来
    （它没有对应的生成脚本了，加回来就是一份没人维护的孤儿资源）。
    同理，往这个目录里塞实验性素材也要**显式**改这条断言——内置形象是
    随包发布的只读资源，多一个就多一份要长期维护的东西。
    """
    import sys

    sys.path.insert(0, REPO_ROOT)
    from backend.core.store import DEFAULT_PET_ID

    pets_dir = os.path.join(REPO_ROOT, 'resources', 'pets')
    names = sorted(
        name for name in os.listdir(pets_dir)
        if os.path.isdir(os.path.join(pets_dir, name))
    )
    assert names == ['xiaoka', 'xiaoman', 'xiaoying'], f'内置形象目录异常: {names}'
    # 默认形象必须是内置的之一，否则首次安装会落到「列表第一个」
    assert DEFAULT_PET_ID in names, f'DEFAULT_PET_ID={DEFAULT_PET_ID} 不在内置形象里'


# ------------------------------------------------------- 文件输入（真实踩过）


def _pick_file_section() -> str:
    """取出 `panel.js` 里 `pickFile()` 的函数体（含前置注释）。"""
    source = read(os.path.join(REPO_ROOT, 'frontend', 'panel.js'))
    start = source.index('function pickFile')
    # 往前带上紧邻的文档注释，这样注释里写的约束也被覆盖到
    head = source.rfind('/**', 0, start)
    if head != -1 and source[head:start].rstrip().endswith('*/'):
        start = head
    return source[start:source.index('\n  }\n', start)]


def test_file_input_is_hidden_inline_not_only_by_scoped_css():
    """★ 真实踩过的 bug：文件输入只加类名 → 作用域 CSS 匹配不到它。

    `pickFile()` 把 `<input type=file>` 挂在 `document.body` 下，而
    `plugin.css` 里的 `.plugin-stm-pet .pet-file-input` 是**作用域内**选择器
    （F11 强制每条顶层规则以插件作用域为根），body 上既没有 `plugin-stm-pet`
    类也没有 `data-plugin` 属性 —— 那条隐藏规则根本匹配不到。

    症状：原生「选择文件 / 未选择任何文件」控件按文档流排在页面最底部，
    **每点一次多一条，刷新页面才消失**（用户截图报障）。

    修法只能是**内联** style（不能给 CSS 加裸选择器：那会让
    `installer.scan_css_scope()` 判定整份样式违规、拒绝加载）。
    """
    section = _pick_file_section()

    assert "style.position = 'absolute'" in section, (
        '文件输入必须内联隐藏 —— 只靠作用域 CSS 类名匹配不到 body 下的它'
    )
    assert "style.left = '-9999px'" in section, '必须内联移出视口'
    assert "style.opacity = '0'" in section, '必须内联透明'
    assert 'aria-hidden' in section, '隐藏元素要从无障碍树里摘掉'


def test_file_input_is_cleaned_up_on_change_and_cancel():
    """★ 同一 bug 的另一半：**取消也要回收**。

    用户点「取消」时浏览器只派发 `cancel`、**不派发 `change`**
    （Safari / 旧 Firefox 连 `cancel` 都不派发），只监听 `change`
    会让 input 永久留在 DOM 里 —— 这正是「点一次多一条」的直接原因。
    """
    section = _pick_file_section()

    assert "addEventListener('change'" in section, '必须有 change 路径'
    assert "addEventListener('cancel'" in section, (
        '必须有 cancel 路径 —— 用户取消时不会派发 change'
    )
    assert 'removeChild(input)' in section or 'input.remove()' in section, (
        '必须真正把节点从 DOM 里摘掉'
    )
    assert "removeEventListener('focus'" in section, (
        '回收时要摘掉 window focus 监听，否则监听器泄漏'
    )


def test_file_input_css_rule_stays_scoped():
    """反向钉死：**不能**为了隐藏文件输入而写一条裸 `.pet-file-input` 规则。

    那会让宿主的 `scan_css_scope()` 判定整份样式违规并拒绝加载，
    症状从「多出几条选择文件」变成「面板完全没样式」——更难查。
    """
    css = read(PLUGIN_CSS)
    for match in re.finditer(r'(?m)^\s*([^{}\n]*\.pet-file-input[^{}\n]*)\{', css):
        selector = match.group(1).strip()
        assert (
            f'.plugin-{PLUGIN_ID}' in selector or f'[data-plugin="{PLUGIN_ID}"]' in selector
        ), f'.pet-file-input 的规则必须带作用域根，否则整份样式被拒绝加载: {selector}'


# ------------------------------------------------------------ JS 静态契约


def test_js_never_sets_fixed_position():
    """JS 里也不得设置 `position: fixed`（判定标准同样适用）。"""
    source = read(PLUGIN_JS)
    assert 'position: fixed' not in source
    assert "position = 'fixed'" not in source
    assert 'position = "fixed"' not in source


@pytest.mark.parametrize('name', ['plugin.js', 'petview.js', 'panel.js', 'announce.js'])
def test_frontend_modules_do_not_read_alpine_store(name):
    """不得偷读 `window.Alpine.store` —— 那是 Provisional 耦合（§1.2）。

    需要宿主状态必须用 `api.host.onState()`；否则宿主改字段名就会静默失效。
    """
    source = read(os.path.join(REPO_ROOT, 'frontend', name))
    body = strip_comments(source)
    assert 'Alpine.store' not in body, f'{name} 直接读了 Alpine store'
    assert 'window.Alpine' not in body, f'{name} 直接读了 window.Alpine'


@pytest.mark.parametrize('name', [
    'petview.js', 'panel.js', 'clock.js', 'physics.js', 'statemachine.js',
    'direction.js', 'animation.js', 'gesture.js', 'preview.js',
])
def test_modules_have_no_bare_window_event_listeners_for_core_events(name):
    """核心事件必须走 `api.on()`，不用 window 事件（§2.2）。"""
    source = read(os.path.join(REPO_ROOT, 'frontend', name))
    for legacy in ('card-updated', 'refresh-card-list', 'card-saved'):
        assert legacy not in source, f'{name} 使用了 UI 本地信号 {legacy}'


def test_petview_is_the_only_module_touching_dom():
    """纯逻辑层必须保持"不碰 DOM"，否则那部分逻辑就没法在 Node 里测。

    `preview.js` 是**有意**的例外：它是设置面板里的播放器，本质就是画帧，
    因此允许碰 DOM（它的纯计算部分 `frameDurations` / `totalDuration` /
    `applyFrameGeometry` 都已导出，可以单独测）。`panel.js` 同理。
    """
    for name in ('clock.js', 'physics.js', 'statemachine.js', 'announce.js',
                 'animation.js', 'gesture.js', 'direction.js'):
        source = strip_comments(read(os.path.join(REPO_ROOT, 'frontend', name)))
        for api_name in ('document.', 'window.', 'requestAnimationFrame'):
            assert api_name not in source, (
                f'{name} 里出现了 {api_name}——纯逻辑层不应触碰 DOM/宿主 API'
            )


def test_animation_and_gesture_modules_have_no_timers():
    """★ 纯逻辑层也不该自己起定时器。

    `animation.js` 刻意只负责「抽一个随机间隔」，计时由调用方做——
    因为 `random` 模式下 rAF 是**停着的**，倒计时若放在这里推进就永远不会前进，
    idle 动画再也触发不了（真实踩过：用 `tick(dt)` 接口时的失败模式）。
    """
    for name in ('animation.js', 'gesture.js', 'clock.js'):
        source = strip_comments(read(os.path.join(REPO_ROOT, 'frontend', name)))
        for api_name in ('setTimeout', 'setInterval', 'clearTimeout'):
            assert api_name not in source, (
                f'{name} 里出现了 {api_name}——计时应由调用方（petview）负责'
            )


def test_entry_exports_activate():
    """契约：导出 `activate(api)`。"""
    source = read(PLUGIN_JS)
    assert re.search(r'export\s+async\s+function\s+activate\s*\(\s*api\s*\)', source)


def test_entry_returns_a_disposer():
    """`activate` 的返回值必须能被宿主记成 disposer（§2.9）。"""
    source = read(PLUGIN_JS)
    assert re.search(r'return\s+\(\)\s*=>\s*\{', source), 'activate 必须返回清理函数'
    # 清理里必须摘掉全局监听与订阅
    assert 'removeEventListener' in source
    assert 'offState()' in source or 'offState' in source


def test_cancel_animation_frame_is_called():
    """disposer 里必须 `cancelAnimationFrame`（否则残留 rAF，§2.9）。"""
    source = read(os.path.join(REPO_ROOT, 'frontend', 'petview.js'))
    assert 'cancelAnimationFrame' in source
    assert 'requestAnimationFrame' in source


def test_css_is_declared_in_manifest():
    """manifest 必须声明 styles，否则宿主不会加载（也就不会被作用域检查）。"""
    import json

    with open(os.path.join(REPO_ROOT, 'manifest.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    assert manifest['frontend']['styles'] == ['frontend/plugin.css']
    assert manifest['frontend']['entry'] == 'frontend/plugin.js'
