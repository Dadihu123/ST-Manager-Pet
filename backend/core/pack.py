"""宠物包格式与**动作回退链**（插件侧领域模型，宿主完全不解析）。

设计目标（实施提示词 §3.1）
--------------------------
1. **任何一张单帧图都能跑起来**——缺失的动作沿回退链下溯，最终一定落到 `idle`。
2. 用户能导入自己的形象，能覆盖单个动作的图。
3. 格式**向前兼容**：多出来的字段忽略而不是报错。

「必要动作」的真正含义
----------------------
`idle` / `drag` / `fall` 被标为「必要」，但**不是**「不给就报错」，
而是**「不给就退化为静态位移」**：没有行走图的包，宠物照常移动位置，
只是不播帧。因此解析器对缺动作给出的是 `kind='static'` 的**降级结果**，
只有「连 `idle` 都没有」才是错误（`pack_animation_idle_missing`）。

行走**只有方向化动作**（`walk-left` / `walk-right`），没有「正面 `walk`」：
正面视角的行走图看起来是「原地踏步 + 平移」，出戏且与水平移动的语义不符。
2026-10 已把 `walk` 从词表与内置形象里移除（见 README §3、§11）。

两个**顶层**字段不属于任何动作
------------------------------
- `still`（标准图像）：不播动画时显示的那一帧。见 `StillImage` 的说明——
  它是「idle 挂了两套动画之后，静止画面变成张望的抬头帧」这个问题的修法。
- `schedule`（时间驱动行为的节奏）：`idle` 的小动作间隔、`roam` 的漫游间隔。
  只有**由时间驱动**的行为能设它；事件驱动的动作（点击、下落、播报…）
  写它就是错误，因为那件事做不到。
"""

import json
import os
from dataclasses import dataclass, field

from .errors import (
    CODE_PACK_ANIMATION_MISSING,
    CODE_PACK_FIELD_INVALID,
    CODE_PACK_IDLE_MISSING,
    CODE_PACK_JSON_INVALID,
    CODE_PACK_SHEET_MISSING,
    CODE_PACK_UNREADABLE,
    PetError,
)
from .paths import is_safe_relative_name, to_posix

#: 当前格式版本。读取时**不**拒绝更高的版本号——向前兼容优先，
#: 未知字段忽略；只在日志/响应里回传实际读到的值供排查。
FORMAT_VERSION = 1

#: 方向化行走动作 → 对侧动作名。
#:
#: 为什么需要：宠物是**水平**移动的，而正面视角的行走图看起来是
#: 「原地踏步 + 平移」。因此行走**只认方向化贴图**（左右两套侧视图）。
#:
#: 只提供一侧时，另一侧**镜像**复用（见 `ResolvedAction.mirror`），
#: 对称的形象因此不必画两套。但**左右不对称**的形象（例如「小满」的发夹
#: 只在单侧、「小卡」的木牌只在左髋）必须自己画两套，否则镜像会把细节翻到另一边
#: ——这不是引擎能替作者决定的事。
WALK_DIRECTION_ACTIONS = {
    'walk-left': 'walk-right',
    'walk-right': 'walk-left',
}

#: 动作词表与「省略时的回退链」（§3.3，照抄为契约）。
#: `idle` 是唯一硬必要动作；其余缺失时沿链下溯，最终一定落到 `idle`。
#:
#: **没有正面 `walk`**：行走只认 `walk-left` / `walk-right`，两侧都没有就退到 `idle`
#: （只位移容器、不播帧），而不是播一张「原地踏步」的正面图。
ACTION_FALLBACKS = {
    'idle': (),
    'walk-left': ('idle',),
    'walk-right': ('idle',),
    'drag': ('idle',),
    'fall': ('idle',),
    'land': ('fall', 'idle'),
    'sleep': ('idle',),
    'click': ('idle',),
    'happy': ('idle',),
    'sad': ('idle',),
    'angry': ('idle',),
    'look': ('idle',),
}

#: 「必要动作」：缺失时**不报错**，而是退化为静态位移（见模块 docstring）。
#:
#: 行走算不算「有」，由 `missing_required()` 特判：提供**任一侧**方向化行走即算满足。
REQUIRED_ACTIONS = ('idle', 'walk', 'drag', 'fall')

#: 只播一遍的动作（其余默认循环）。未显式给 `loop` 时按此判定。
ONE_SHOT_ACTIONS = frozenset({'land', 'click'})

#: 「标准图像」用的伪动作名（**不是动作**）。
#:
#: 它不参与状态机，也不在 `ACTION_FALLBACKS` 词表里。之所以复用一个「像动作名」
#: 的标识，是因为它要复用同一套解析通路（用户覆盖 > 包内声明 > 内置包）与同一条
#: `/frame/<id>/<action>` 图片路由——否则「路径安全校验」与「覆盖优先级」这两件
#: 已经有测试钉住的事都要再写一遍，而写两遍的代价是两边迟早不一致。
#:
#: 解析器**拒绝**包里出现同名动作（见 `from_dict`），避免两套语义打架。
STILL_ACTION = 'still'

#: 解析出的实际动作种类。
KIND_ANIMATED = 'animated'   # 有 sheet，能播帧
KIND_STATIC = 'static'       # 没 sheet，只位移/不播帧
KIND_NONE = 'none'           # 该动作名本身不在词表里

#: `sheet` 允许的扩展名。
#: **不含 `.jpg` / `.jpeg`**——宿主的插件资产白名单不含它们（§2.5 / §8 陷阱 3），
#: 因此**落盘后的包**里不该出现 JPEG。
ALLOWED_SHEET_EXTENSIONS = frozenset({'.png', '.webp', '.gif', '.avif', '.svg'})

#: **导入期**额外放行的扩展名。
#:
#: 用户把自己的图打包时，几乎必然夹带 JPEG。如果解析器在导入阶段就拒绝 `.jpg`，
#: 用户拿到的是「这个包不能用」——可我们明明有能力把它转码。
#: 因此导入路径（`allow_source_jpeg=True`）放行这些扩展名，
#: 由 `store.import_zip` 负责转码成 PNG 并**改写 pet.json 的 sheet 指向**；
#: 运行期读盘走的仍是严格白名单（`allow_source_jpeg=False`）。
IMPORT_SOURCE_EXTENSIONS = frozenset({'.jpg', '.jpeg', '.bmp', '.tif', '.tiff'})

#: 字段上限（既用于解析校验，也用于导入安全 §3.4）。
#:
#: `MAX_FRAMES` 从 256 提到 1024，是为了配合**多页 sheet**：
#: 一页（4096² 上限下）能装几十到几百帧，几页就能上千。上限本身仍要存在
#: ——它拦的是「填错了位数」，不是「动画很长」。
MAX_FRAMES = 1024

#: 一个动作最多拆成几页。
#:
#: 上限的依据是**解码显存**而不是磁盘：每页 4096² 解出来是 64 MiB，
#: 8 页就是 512 MiB。前端只预取下一页，但浏览器的图片缓存是会话级的，
#: 长时间循环最终会把所有页都拉进来。因此这个上限同时是
#: 「一个动作最多吃掉多少显存」的护栏。
MAX_PAGES = 8

#: 单个变体的**解码像素**预算（宽 × 高 × 帧数）。超过就**警告**（不拒绝）。
#:
#: 为什么是警告而不是拒绝：显存是否够用取决于用户的机器，插件无法知道。
#: 而且「帧数多」本身不是错误——作者可能就是要做一段长动画。
#: 但用户有权知道「这个动作要占多少显存」，因此后端算出来、面板显示出来，
#: 由用户自己决定要不要用这个形象。
#:
#: 128 MiB ≈ 2 页 4096²（每页 64 MiB）。超过它的形象在低配机器上
#: 切页时会明显卡顿。
DECODE_BUDGET_BYTES = 128 * 1024 * 1024

DEFAULT_MAX_SHEET_PIXELS = 4096
MAX_FPS = 60
# ---------------------------------------------------------------- 帧排布
#
# 三种排布，但**只有一种几何**：帧总是落在一个 `cols × rows` 的网格里。
# `horizontal` / `vertical` 不是另外两套算法，而是网格的两个特例：
#
#     horizontal → cols = frames, rows = 1
#     vertical   → cols = 1,      rows = frames
#     grid       → cols / rows 由作者给出（可以装不满）
#
# 为什么要把它们统一：旧实现里「水平」与「垂直」是两条独立的计算分支
# （`frameW = width * frames` / `frameH = height * frames`），加第三种排布
# 意味着再写第三条分支；而三条分支里只要有两条不一致，就会出现
# 「桌面上对、面板预览里错」这种最难查的偏差。统一成一个网格之后，
# 前端只有一组公式，三种排布天然一致。
#
# 为什么值得支持 `grid`：单行排布下，一页能装的帧数被**帧宽**卡死——
# 内置形象单帧 384px 宽，4096 的上限意味着最多 10 帧。改成多行之后
# 同样的图能装 10×7 = 70 帧。这是「同一张图、同样的解码成本」下
# 能白拿的最大一块（约 7 倍），而且不动任何管线。

LAYOUT_HORIZONTAL = 'horizontal'
LAYOUT_VERTICAL = 'vertical'
LAYOUT_GRID = 'grid'
#: **动图容器**：由浏览器自行播放，插件不切帧。
#:
#: 为什么要有它：前三种排布都要求作者先把动画拼成一张（或几张）sheet。
#: 而用户手上往往已经有一个现成的 GIF / 动图 WebP——从别处下载的、
#: 用工具导出的。让这种图**直接能用**是这条「第二路线」的全部意义：
#: 零制作成本。
#:
#: 代价是**放弃控制权**（这是它与 sheet 路线的根本区别，不是文件大小）：
#:
#: - 逐帧时长（`frameMs`）无法表达——浏览器决定每帧停多久；
#: - 无法定位到「第 n 帧」——标准图像取帧、面板帧读数都做不到；
#: - 无法**分页**，因此解码占用不可控。sheet 路线可以把上千帧切成
#:   8 页、一次只预取一页；动图是**一个不可分割的解码单元**。
#:
#: 最后一条是真正「资源消耗较大」的地方。实测：480×480 的 120 帧动图
#: 解码后是 105 MiB，且没有任何办法把它切开——而同样内容的 sheet 路线
#: 可以分页把峰值压到一页（约 60 MiB）以内。
LAYOUT_ANIMATED = 'animated'
LAYOUTS = (LAYOUT_HORIZONTAL, LAYOUT_VERTICAL, LAYOUT_GRID, LAYOUT_ANIMATED)

#: 动图容器**不允许**出现的字段。
#:
#: 这些都是「切帧」相关的声明，而容器路线根本不切帧。写它们**必须报错**
#: 而不是静默忽略——静默的后果是作者以为 `frameMs` 生效了，
#: 于是反复调整数字却看不出任何变化（与 §2.5 的教训一致）。
ANIMATED_FORBIDDEN_FIELDS = ('fps', 'frameMs', 'cols', 'rows', 'loop')

#: **程序化运动**（T6）：不增加帧数的连续运动。
#:
#: 为什么要有它：帧序列把「动起来」的成本算成「帧数 × 单帧像素」，
#: 而呼吸、眨眼这类**装饰性整体运动**根本不需要那么多帧——
#: 一张图加一条曲线就能无限平滑，比手画 30 帧更自然，还不占额外显存。
#:
#: 它与帧序列**正交**，可以叠加：
#: - 呼吸 = sprite 元素上的 CSS `transform`（走合成器，不需要 rAF）；
#: - 眨眼 = `background-position` 跳到另一帧再跳回来（复用同一张 sheet）。
#:
#: ⚠️ **它做不了什么**（这一点必须说清，否则作者会以为「写了就能自动补间」）：
#: 整身仿射变换**无法 articulate 四肢**。实测把走路的两个关键姿势交叉淡入，
#: 得到的中间帧是**双重曝光**（两条腿叠在一起），不是新姿势。
#: 真正的肢体运动需要骨骼绑定或真实的中间帧。因此 `motion` 的合理范围是
#: **整体运动**（呼吸 / 摇摆 / 挤压拉伸 / 眨眼），不是「自动生成行走循环」。
MOTION_BREATHE = 'breathe'
MOTION_BLINK = 'blink'
MOTION_KINDS = (MOTION_BREATHE, MOTION_BLINK)

#: 呼吸幅度（纵向缩放 ±amplitude）的合法区间。
#:
#: 上限 8%：4% 已经很显眼，再大就是「拉伸」而不是「呼吸」，
#: 写实素材的边缘还会被拉糊。下限 0.2%：比这更小等于没动，
#: 而作者会以为功能坏了（「我明明写了」）。
BREATHE_AMPLITUDE_RANGE = (0.002, 0.08)
#: 呼吸周期（毫秒）。人类静息呼吸约 3–5 秒一次；800ms 已经偏快，
#: 20s 是一声很慢的深呼吸。超出这个区间就是填错了。
BREATHE_PERIOD_RANGE = (800, 20000)
#: 眨眼间隔（毫秒，`[最短, 最长]`）。默认 3–7 秒一次。
BLINK_INTERVAL_RANGE = (300, 60000)
#: 一次眨眼的持续时长（毫秒）。人眼一眨约 100–400ms。
BLINK_DURATION_RANGE = (40, 2000)


def frame_grid(layout: str, frames: int, cols: int = 0, rows: int = 0) -> tuple:
    """把排布声明折算成 `(cols, rows)`——**唯一的**帧几何真相。

    这是整个排布系统的收敛点：解析器、运行期定义、前端三处渲染
    （桌面宠物 / 面板预览 / 缩略图）全都只认它算出来的这一对数。

    ⚠️ 这里的 `frames` 是**一页**里排了几帧，不是整个动画的帧数。
    多页时每页的形状相同（见 `frame_page`），因此几何只需要算一次。

    `cols` / `rows` 为 0 表示「没声明，按排布推导」：

    - `horizontal` → `(frames, 1)`
    - `vertical`   → `(1, frames)`
    - `grid`       → 必须显式给出（否则无从知道一行放几个）

    Args:
        layout: 排布名（非法值按 `horizontal` 处理——宽容策略与其它字段一致）。
        frames: 帧数（至少 1）。
        cols: 声明的列数；0 = 未声明。
        rows: 声明的行数；0 = 未声明。

    Returns:
        tuple: `(cols, rows)`，两个都是 >= 1 的整数。
    """
    count = max(1, int(frames or 1))
    declared_cols = max(0, int(cols or 0))
    declared_rows = max(0, int(rows or 0))
    name = str(layout or '').strip().lower()

    if name == LAYOUT_ANIMATED:
        # 动图容器**不是**网格：整张图是「一帧」，由浏览器自己播。
        # 返回 (1, 1) 让下游公式（背景铺法 = 单帧 × 行列数）自然退化成
        # 「原样铺满」——于是三种切帧排布与容器路线共用同一套渲染代码，
        # 不需要在 `petview` / `preview` 里各加一条 `if (animated)` 分支。
        return 1, 1

    if name == LAYOUT_GRID:
        # 网格模式：两个方向都要有。缺一个时按「装得下」补另一个——
        # 补出来的是**能放下全部帧的最小网格**，而不是 1（那等于退回单行）。
        if declared_cols and declared_rows:
            return declared_cols, declared_rows
        if declared_cols:
            return declared_cols, max(1, -(-count // declared_cols))
        if declared_rows:
            return max(1, -(-count // declared_rows)), declared_rows
        # 两个都没给：退回单行（`grid` 没给网格是无意义的声明，
        # 解析期已经拦掉，这里只是防空转）
        return count, 1

    if name == LAYOUT_VERTICAL:
        return 1, count
    return count, 1


def frame_page(index: int, grid: tuple, frames: int) -> tuple:
    """把**全局帧号**折算成 `(page, local, col, row)`。

    多页 sheet 的全部坐标逻辑就是这一个函数：第 `index` 帧在哪一页、
    页内第几格、第几行第几列。前端与后端都调它，因此不可能出现
    「桌面宠物算的页与面板预览算的页不一致」。

    帧序是**页优先、页内行优先**：先把第 0 页从左到右、从上到下走完，
    再进第 1 页。这与 `grid` 排布在单页内的顺序完全一致，因此
    「单页 → 多页」是一次自然的扩展，作者不必重新理解播放顺序。

    ⚠️ **每页的形状相同**（都是 `cols × rows`）。因此最后一页可能装不满，
    末尾几格是透明的——这与 `grid` 排布允许「帧数少于网格容量」是同一条规则。
    不做「最后一页按剩余帧数变小」是因为那会引出**逐页几何**：
    前端要维护一个 `pageGrids[]`，预览与缩略图也要各处理一遍，
    而省下的只是最后一页的透明格（PNG 里几乎不占字节）。

    Args:
        index: 全局帧号（会被夹到 `[0, frames-1]`）。
        grid: `(cols, rows)`——**每页**的形状（见 `frame_grid`）。
        frames: 整个动画的帧数（跨页）。

    Returns:
        tuple: `(page, local, col, row)`，四个都是非负整数。
    """
    cols = max(1, int(grid[0] or 1))
    rows = max(1, int(grid[1] or 1))
    per_page = cols * rows
    count = max(1, int(frames or 1))
    at = min(max(0, int(index or 0)), count - 1)
    page = at // per_page
    local = at % per_page
    return page, local, local % cols, local // cols


def frame_page_count(grid: tuple, frames: int) -> int:
    """这个动画需要几页（至少 1）。"""
    cols = max(1, int(grid[0] or 1))
    rows = max(1, int(grid[1] or 1))
    count = max(1, int(frames or 1))
    return max(1, -(-count // (cols * rows)))


def page_capacity(frames: int, pages: int, cols: int = 0, rows: int = 0) -> int:
    """算出**每页的网格容量**（一页最多排几帧）。

    两条路径，顺序不能反：

    1. 作者声明了 `cols` **且** `rows` → 容量就是 `cols × rows`。
       写了 4×4 就是「每页 16 帧」——这是最该被尊重的写法。
    2. 否则按「总帧数平均分到各页」推：`ceil(frames / 页数)`。
       单页时它就等于 `frames`，因此 `layout` 的推导与从前**完全一致**。

    反过来（先用 `frames / pages` 求每页帧数、再拿它去推网格）会让作者声明的
    4×4 被改写成 4×3 之类的东西，表现是「我明明写了 4×4，它却按别的形状切图」。

    这是**唯一的**容量推导点：解析器与 `AnimationVariant.per_page` /
    `ResolvedVariant.per_page` 全都调它。三处各写一遍的话，
    「解析时报错说装不下、运行期却按另一个容量切图」这类不一致迟早出现。
    """
    declared_cols = max(0, int(cols or 0))
    declared_rows = max(0, int(rows or 0))
    if declared_cols and declared_rows:
        return declared_cols * declared_rows
    page_count = max(1, int(pages or 1))
    count = max(1, int(frames or 1))
    return max(1, -(-count // page_count))


def motion_transform_origin(anchor: dict) -> str:
    """把包级 `anchor` 换算成呼吸要用的 `transform-origin`。

    ⚠️ **这是「新增形象会不会踩坑」的关键一处。** 呼吸是「以某个点为原点做
    纵向缩放」，而那个点必须是**宠物的脚底**：

    - 写死 `bottom center` → 锚点不在底部的形象会在呼吸时**脚离地**
      （实测锚点 y=0.85 时脚飘 3.5px、y=0.5 时上下各飘 11.5px）；
    - 而 `anchor.y` 本来就已经定义了脚在哪——`drawPosition` 用的就是
      `top = physics.y - height * anchorY`，也就是说**脚就在 anchorY 处**。

    因此纵向原点直接取 `anchor.y`，两者天然一致：默认 `1.0` 得到 `100%`
    （底边），自定义锚点自动跟着走。**「新增形象」不需要额外配置。**

    ⚠️ **横向原点固定 `50%`，不取 `anchor.x`**——这一点容易搞错：

    - `scaleX(-1)`（朝向翻转）也走 `transform`，而它的原点**必须是水平中心**，
      否则翻转会把贴图整体平移（实测原点取 30% 时左移 0.4×宽度）；
    - 而且横向定位本来就不看 `anchor.x`：`drawPosition` 用的是
      `left = physics.x - width / 2`，即**恒为居中**。

    两者都指向同一个结论：横向原点只能是 50%。若哪天横向锚点真的接进定位，
    这里要跟着一起改。
    """
    try:
        y = float(anchor.get('y', DEFAULT_ANCHOR['y']))
    except (AttributeError, TypeError, ValueError):
        y = DEFAULT_ANCHOR['y']
    return f'50% {round(y * 100, 2)}%'


def decode_bytes(frames: int, width: int, height: int) -> int:
    """解码后占用的字节数（RGBA = 每像素 4 字节）。

    **这才是真正的容量瓶颈**：一张 4096² 的 sheet 解出来是 64 MiB 常驻显存，
    与它的 PNG 是 1 MB 还是 9 MB 无关。因此「能放多少帧」由像素总数决定，
    而不是文件大小。
    """
    return max(0, int(frames or 0)) * max(0, int(width or 0)) * max(0, int(height or 0)) * 4


#: 动图容器的解码占用**提醒**阈值（超过就明确警告）。
#:
#: 取 64 MiB：那正好是**一张 4096² sheet** 的解码量，也就是 sheet 路线
#: 单页的硬上限。动图超过它就意味着「比我们敢让一张 sheet 占的还多」，
#: 而这个占用还**无法分页**——值得明确告诉用户。
ANIMATED_WARN_BYTES = 64 * 1024 * 1024


def animated_warnings(*, frames: int, file_bytes: int, frame_w: int, frame_h: int) -> list:
    """给**动图容器**算出一组给用户看的提醒。

    为什么提醒是「资源消耗」而不是「文件太大」——这一点必须说准，
    因为**实测结论与直觉相反**：

    同一段动画（内置形象 12 个动作，真实素材）分别做成 spritesheet 与动图：

    | 形式 | 字节数 | 相对 sheet |
    |---|---|---|
    | spritesheet PNG | 5,617,066 | 1.00x |
    | 动图 GIF | 1,250,424 | **0.22x** |
    | 动图 WebP (q90) | 1,360,994 | **0.24x** |

    动图**更小**——因为 GIF / WebP 会做帧间压缩（没变的区域直接跳过），
    而我们的 spritesheet 是把每一帧完整并排放。

    真正的代价是**解码占用与失控**：帧数 × 宽 × 高 × 4 是一样的
    （像素总数相同），但 sheet 路线可以**分页**（最多 8 页、一次只预取
    一页，峰值被一页的 60 MiB 卡住），而动图是**一个不可分割的解码单元**
    ——浏览器必须把整个动画解出来，插件没有任何办法把它切开。

    实测：480×480 的 120 帧动图 = **105 MiB**，超过我们给单页设的上限。

    Args:
        frames: 真实帧数（从文件元数据读出来的）。
        file_bytes: 文件字节数。
        frame_w: 单帧逻辑宽（逻辑尺寸，不是源图像素）。
        frame_h: 单帧逻辑高。

    Returns:
        list: 每条是 `{'code', 'level', 'message'}`；没有提醒时返回 `[]`。
        `level` ∈ `{'info', 'warn'}`，面板据此决定是否用警告色。
    """
    count = max(1, int(frames or 1))
    width = max(0, int(frame_w or 0))
    height = max(0, int(frame_h or 0))
    decoded = decode_bytes(count, width, height)
    out = []

    if count > 1:
        out.append({
            'code': 'animated_no_frame_control',
            'level': 'info',
            'message': (
                f'动图容器（{count} 帧）：由浏览器自行播放，'
                '因此无法逐帧控制——每帧时长（frameMs）、跳到某一帧、'
                '以及从某一帧取标准图像都做不到。'
            ),
        })

    if decoded >= ANIMATED_WARN_BYTES:
        out.append({
            'code': 'animated_heavy',
            'level': 'warn',
            'message': (
                f'解码后约占 {decoded / 1048576:.0f} MB 显存'
                f'（{count} 帧 × {width}×{height}），'
                '而且动图无法像帧序列那样分页——浏览器必须一次把整个动画解出来，'
                '低配机器上可能明显卡顿。'
            ),
        })
    elif count > 1:
        out.append({
            'code': 'animated_decoded_size',
            'level': 'info',
            'message': (
                f'解码后约占 {decoded / 1048576:.0f} MB 显存'
                f'（{count} 帧 × {width}×{height}）；'
                '帧序列路线可以用分页把峰值压得更低。'
            ),
        })

    if file_bytes > 4 * 1024 * 1024:
        out.append({
            'code': 'animated_large_file',
            'level': 'info',
            'message': f'文件本身 {file_bytes / 1048576:.1f} MB，首次加载会慢一些。',
        })

    return out


#: 帧率下限。允许**小数**（0.5fps = 每帧 2 秒）。
#:
#: 为什么 fps 不再是整数：宠物形象的帧数通常只有 2~6 帧，
#: 整数 fps 的可用档位太粗——「4fps 太快、2fps 太慢」这种情况无解。
#: 实测：内置形象的走路 8fps 看起来像在快进，而它需要的正是 4fps 这种中间档；
#: 睡眠呼吸更是需要 1.5fps 这种非整数档才自然。
MIN_FPS = 0.5

#: 单套动画的最小/最大时长（毫秒），用于**非均匀帧时长** `frameMs`。
#: 下限对应 `MAX_FPS`（比 60fps 更短的帧在 rAF 下根本显示不出来），
#: 上限 10 秒是为了拦住「一帧停十秒」这种几乎必然是填错的值。
MIN_FRAME_MS = 1000.0 / MAX_FPS
MAX_FRAME_MS = 10000.0

#: 一个动作最多能挂几套动画。
#: 上限存在的意义：`runtime_pack()` 会把每套动画都算出一个 URL 发给前端，
#: 不设上限时一个动作可以挂出几百个 URL（包本身很小，代价却在前端）。
MAX_VARIANTS = 16

#: 权重（`weight`）的合法区间。语义是**相对比例**，不是百分比：
#: 两个都填 5 → 各 50%；填 1 / 3 / 5 → 分别是 1/9、3/9、5/9。
#: 因此**新增一套动画时不需要改动原有数字**（这正是用户要求的性质）。
#: 0 合法：表示「这套动画存在但永不随机选中」（保留素材、暂时停用）。
MIN_WEIGHT = 0.0
MAX_WEIGHT = 1000.0
DEFAULT_WEIGHT = 1.0

#: idle 的触发方式。
#:
#: - `random`（**默认**）：平时停在标准图像（静止画面），每隔一段**随机时间**
#:   播一遍，播完回到静止。这是「成熟做法」：常驻循环的待机动画会让人
#:   觉得宠物在不停抽搐，而静止 + 偶发小动作才像活着。
#: - `loop`：待机动画一直循环（不做「播一遍就停」）。
IDLE_TRIGGER_RANDOM = 'random'
IDLE_TRIGGER_LOOP = 'loop'
IDLE_TRIGGER_MODES = (IDLE_TRIGGER_RANDOM, IDLE_TRIGGER_LOOP)

#: 一次 idle 触发连续播几轮。
DEFAULT_IDLE_PLAYS = 1

#: **时间驱动行为**的默认节奏（毫秒区间）与上限。
#:
#: 「时间驱动」指的是**没有外部事件**、靠时间自己发生的动作。有三个：
#:
#: - `idle`：闲着的时候偶尔动一下（默认 6~18 秒一次）；
#: - `roam`：闲着的时候自己在屏幕底部走一走（默认 3~9 秒一次）；
#: - `sleep`：**多久没人理就睡着**（默认 120 秒）。
#:
#: 其余动作都是**事件驱动**的（`click` 要有人点、`fall` 要松手、
#: `happy` 要有播报…），给它们设「多久触发一次」没有意义，
#: 因此 `schedule` 里**只认这三个键**——多写的键会被明确拒绝，
#: 而不是静默忽略（作者会以为设了却没生效）。
#:
#: `sleep` 与另外两个形状不同：它是一个**阈值**（「静了多久之后发生」），
#: 不是「每隔一段随机时间发生一次」。因此它只有一个字段 `afterMs`，
#: 没有 `intervalMs` / `mode` / `plays`（写了会报错，见 `BEHAVIOR_FIELDS`）。
#: 用户要求把「睡觉」加进触发时间设置里（「多长时间不管就睡觉」）。
SCHEDULE_BEHAVIORS = ('idle', 'roam', 'sleep')

#: 每个时间驱动行为**支持哪些字段**。
#:
#: 不支持某个字段时**写它就是错误**，而不是静默忽略——
#: 「我明明设了却没生效」是最难查的一类问题（与 §2.5 的教训一致）。
#:
#: `roam` 没有 `plays` / `mode`：它的持续时长由物理决定（走到目标点就停），
#: 不是「播几轮动画」。
#:
#: `sleep` 只有 `afterMs`：它是阈值而不是区间（见 `SCHEDULE_BEHAVIORS`）。
#:
#: 间隔有两种写法，**两种都收**：
#: - `intervalMs: [最小, 最大]` —— 手写 `pet.json` 时最省事；
#: - `minIntervalMs` / `maxIntervalMs` —— 运行期定义的形状，
#:   `to_dict()` 与面板提交的都是这一种。
#: 只收其中一种的话，`to_dict()` 的输出就不再能被自己读回来
#: （round-trip 断裂），而面板提交的字段名也得另做一层映射。
BEHAVIOR_FIELDS = {
    'idle': ('mode', 'intervalMs', 'minIntervalMs', 'maxIntervalMs', 'plays'),
    'roam': ('intervalMs', 'minIntervalMs', 'maxIntervalMs'),
    'sleep': ('afterMs',),
}

#: 行为的**人类可读名**（报错信息与面板共用一份，避免两边叫法不一致）。
BEHAVIOR_LABELS = {
    'idle': '待机小动作',
    'roam': '自动漫游',
    'sleep': '打盹',
}

#: 每个时间驱动行为的默认间隔区间（毫秒）。
#:
#: `roam` 的默认值就是历史行为（`3000 + random * 6000`）——
#: 把它变成可配置项时**不改动默认观感**，否则用户会莫名其妙地觉得
#: 「宠物怎么突然走得频繁了」。
#:
#: `sleep` 的默认值与 manifest 的 `sleep_after`（120 秒）一致：
#: 那是宿主配置里的全局兜底，而按形象设置优先于它。
DEFAULT_SCHEDULE_MS = {
    'idle': (6000, 18000),
    'roam': (3000, 9000),
    'sleep': (120000, 120000),
}

#: 间隔的合法区间（毫秒）。下限 200ms 拦住「每帧都在动」，
#: 上限 1 小时拦住「填错了位数」。
MIN_SCHEDULE_MS = 200
MAX_SCHEDULE_MS = 3600 * 1000
#: 轮数上限（拦「填错了」的极端值）。
MAX_IDLE_PLAYS = 20

#: 打盹阈值（`sleep.afterMs`）的合法区间（毫秒）。
#:
#: 与 manifest 的 `sleep_after` 保持一致（10 秒 ~ 1 小时）：
#: 同一个概念在两处设置里不该有不同的边界，否则「面板上能填、
#: 宿主表单里填不了」会让人困惑。下限 10 秒是因为更短的话宠物
#: 会一直在睡醒之间闪；上限 1 小时是拦「填错了位数」。
SLEEP_AFTER_RANGE = (10 * 1000, 3600 * 1000)

#: 单帧的默认逻辑尺寸。**只是默认值**——`size.w` 与 `size.h` 完全独立，
#: 形象可以是任意长宽比（真人立绘常见 2:3、3:4），不必是正方形。
DEFAULT_SIZE = {'w': 64, 'h': 64}
DEFAULT_ANCHOR = {'x': 0.5, 'y': 1.0}

#: 形象是否按**像素风**渲染（`image-rendering: pixelated`）。
#:
#: 默认 **False**（平滑插值）。理由：像素风放大时必须硬边，否则糊；
#: 而写实插画 / 真人立绘放大时**恰恰相反**——硬边会出现块状锯齿。
#: 两者诉求互斥，所以只能由形象自己声明，用户在面板上还能覆盖。
#: 像素风形象请在 `pet.json` 里写 `"pixelated": true`。
DEFAULT_PIXELATED = False

#: 形象**自带**的大小倍率（可选字段）。语义是「作者认为这个形象适合多大」。
#:
#: 为什么包要能声明它：`size` 是单帧的**贴图**尺寸，不等于**观感**尺寸。
#: 一张 512×512 的真人立绘与一张 64×64 的像素猫，按各自的 `size` 原样显示时
#: 前者会占掉小半个屏幕。作者在包里声明 `scale` 就能表达「我这个形象该缩到多少」，
#: 而不是让每个用户自己试。
#:
#: 优先级（`store.effective_scale`）：**用户设置 > 包内声明 > 宿主表单默认值**。
DEFAULT_SCALE = 1.0

#: 形象自带的**动画速度倍率**（可选字段）。语义与面板上那个「动画速度」一致：
#: 越大越慢（2 = 播放时间翻倍）。`1.0` 表示「按包内 `fps` / `frameMs` 原速」。
#:
#: 为什么让包声明它：同一份素材在不同用途下想要的快慢不同——100 帧的平滑
#: 循环按原速播可能太赶，4 帧的像素猫按原速播又可能太慢。作者最清楚。
#: 优先级：**用户设置 > 包内声明 > 1.0**。
DEFAULT_ANIM_SPEED = 1.0

#: 动画速度倍率的合法区间。与前端 `ANIM_SPEED_MIN` / `ANIM_SPEED_MAX` 必须一致。
#:
#: 上界 4（播放时间翻四倍）已经慢到能看清每一帧；下界 0.25 是「四倍速」，
#: 再快就看不清动作了。
ANIM_SPEED_RANGE = (0.25, 4.0)

#: 这个形象是否参与**自动漫游**（可选字段，缺省 true）。
#:
#: 允许关掉的理由：不是每个形象都「会走」——坐着的猫、躺着的玩偶自己溜达
#: 起来很出戏。作者可以声明 `"autoRoam": false`。
#: 优先级：**用户设置 > 包内声明 > true**。
DEFAULT_AUTO_ROAM = True

#: 倍率的合法区间：`(最小值, 最大值)`。全闭区间。
#:
#: 定这个区间的依据是「要同时覆盖二次元小图与真人立绘，又不能把宠物放大到
#: 遮住整个屏幕」：
#: - 下界 0.25：512px 的立绘缩到 128px，仍看得清；
#: - 上界 4：64px 的小图放大到 256px，在高分屏上也够大。
#: 前端滑块、后端校验、manifest 的默认值**三处共用这一对常量**
#: （`frontend/panel.js` 里的 `SCALE_MIN` / `SCALE_MAX` 必须与此一致）。
SCALE_RANGE = (0.25, 4.0)

DEFAULT_PHYSICS = {
    'gravity': 1800.0,
    'walkSpeed': 60.0,
    #: **每秒速度保留比例**（越小刹车越快）。
    #:
    #: 实施提示词 §3.2 的示例包写的是 `0.85`，但按「每秒保留」理解，
    #: 0.85 意味着一次甩出要滑行约 12 个屏幕宽度、走停后还要滑 30 秒——
    #: 那不能算「松手有减速」，是失控。这里取 0.02（走路停下约 0.4s）。
    #: 语义已在 README 冻结，前端 `frontend/physics.js` 的默认值必须与此一致。
    'friction': 0.02,
    'terminalVelocity': 2400.0,
    'bounce': 0.15,
}

#: 物理参数的合法区间：`(最小值, 最大值)`。全闭区间。
_PHYSICS_RANGES = {
    'gravity': (0.0, 20000.0),
    'walkSpeed': (0.0, 2000.0),
    'friction': (0.0, 1.0),
    'terminalVelocity': (1.0, 20000.0),
    'bounce': (0.0, 1.0),
}

_MIN_FRAME_SIZE = 1
#: 单帧尺寸上限（宽与高**各自**判定，因此非正方形形象完全合法）。
#:
#: 放宽到 1024 是为了真人立绘这类形象：512 的上限意味着 2:3 的立绘只能做到
#: 512×768，在高分屏上放大后不够清晰。上限本身仍要存在——它是解码炸弹防线
#: 的一部分（真正的硬上限是 `imports.MAX_IMAGE_DIMENSION`）。
_MAX_FRAME_SIZE = 1024


@dataclass
class MotionSpec:
    """一个变体的**程序化运动**（见 `MOTION_BREATHE` 的说明）。

    两个字段组各自独立、可同时开启：

    - **呼吸**：以 `(anchor.x, anchor.y)` 为原点做纵向缩放（`transform-origin`
      由包级 `anchor` 推出来，**不是**写死「底部居中」——见 `motion_css` 的说明）。
    - **眨眼**：每隔一段随机时间，把 `background-position` 跳到
      `blink_frames` 里的帧、停 `blink_duration_ms`、再跳回原帧。
      帧号指向**同一张 sheet**，因此不需要第二张图、不需要定位。

    `enabled` 为假时前端完全不碰样式（不写 CSS 变量、不起定时器），
    因此「没写 motion」的包与从前逐字节等价。
    """

    #: 呼吸幅度（纵向缩放 ±amplitude）。`0` = 不呼吸。
    amplitude: float = 0.0
    #: 呼吸周期（毫秒）。`amplitude > 0` 时必定有值。
    period_ms: int = 0
    #: 眨眼用 sheet 里的哪几帧（按顺序播）。空 = 不眨眼。
    blink_frames: list = field(default_factory=list)
    #: 眨眼间隔 `[最短, 最长]`（毫秒），每次在这个区间里随机取。
    blink_every_ms: list = field(default_factory=list)
    #: 一次眨眼停多久（毫秒）。
    blink_duration_ms: int = 0

    @property
    def breathes(self) -> bool:
        return self.amplitude > 0 and self.period_ms > 0

    @property
    def blinks(self) -> bool:
        return bool(self.blink_frames) and self.blink_duration_ms > 0

    @property
    def enabled(self) -> bool:
        """有任何一项要动吗？——没有就让前端完全不动样式。"""
        return self.breathes or self.blinks

    def to_dict(self) -> dict:
        """只写出**启用**的部分（没写的东西不该出现在往返里）。"""
        payload = {}
        if self.breathes:
            payload[MOTION_BREATHE] = {
                'amplitude': self.amplitude,
                'periodMs': self.period_ms,
            }
        if self.blinks:
            payload[MOTION_BLINK] = {
                'frames': list(self.blink_frames),
                'everyMs': list(self.blink_every_ms),
                'durationMs': self.blink_duration_ms,
            }
        return payload


@dataclass
class AnimationVariant:
    """**一套**动画（一个动作可以有多套，按 `weight` 随机选一套播）。

    为什么一个动作要能有多套：这是「丰富动画数量」的最低成本做法——
    同一件事（例如「被点击」）画两三个不同的反应，随机播其中之一，
    观感立刻不像复读机。作者只要多画几张图，不必让引擎理解「语义」。
    """

    #: **一页或多页** sheet 的相对路径。
    #:
    #: 单页时长度为 1（绝大多数包）；多页时每页都是同样的 `cols × rows` 网格，
    #: 帧序是**页优先、页内行优先**（见 `frame_page`）。
    #:
    #: 为什么需要多页：单图的解码像素上限（4096² ≈ 16.8 Mpx ≈ 60 MiB 显存）
    #: 是一道硬墙，网格化只能把这道墙用满（约 7 倍），要再往上就只能加页。
    #: 而显存是**页数 × 每页大小**，因此页数必须由作者显式声明、
    #: 由 `MAX_PAGES` 与 `DECODE_BUDGET_BYTES` 约束，而不是「想加就加」。
    sheets: list = field(default_factory=list)
    frames: int = 1
    #: 帧率。**允许小数**（见 `MIN_FPS`）——帧数少时整数档太粗。
    fps: float = 8
    loop: bool = True
    layout: str = LAYOUT_HORIZONTAL
    #: 网格几何。`0` = 未声明，由 `layout` 推导（见 `frame_grid`）。
    #:
    #: 这两个字段是**冗余**的：`layout` 已经能推出 `(cols, rows)`。之所以两个都存，
    #: 是因为推导结果要被前端反复使用（每帧算一次切帧偏移），而让前端自己再推一遍
    #: 就意味着「后端一套规则、前端一套规则」——两套规则不一致的表现是
    #: 「桌面上对、面板预览里错」，属于最难查的一类偏差。
    #: 因此后端**推一次**，把结论随运行期定义一起下发。
    cols: int = 0
    rows: int = 0
    #: **非均匀帧时长**（毫秒，每帧一个）。空列表表示「按 `fps` 均匀推进」。
    #:
    #: 为什么需要它：真实动画的帧时长本来就不均匀——起手慢、中间快、
    #: 收尾有个停顿。用单一 fps 播出来是「匀速机械感」，
    #: 而 `frame_ms` 能让 4 帧的动画表达出「快速抬手 → 定住」这种节奏。
    frame_ms: list = field(default_factory=list)
    #: 权重（**相对比例**，不是百分比）。见 `DEFAULT_WEIGHT` 的说明。
    weight: float = DEFAULT_WEIGHT
    #: **这一套动画自己的单帧尺寸**（逻辑像素）；`None` 表示沿用包级 `size`。
    #:
    #: 为什么需要它：一个动作的画布比例可能和别的动作根本不同。典型例子是
    #: 「躺下睡觉」——人物横躺，画布自然是**横构图**（例如 1672×941），
    #: 而站立动作是 2:3 竖构图（1024×1536）。若强行共用一个 `size`，
    #: 前端会按 `size` 去拉伸贴图，躺姿会被压扁变形。
    #:
    #: 挂在这一层（而不是动作层）是因为「画布尺寸」是**图本身的属性**：
    #: 多套动画可以各自是不同尺寸的图，前端换套播时几何要跟着换。
    size: dict = None
    #: **程序化运动**（呼吸 / 眨眼）。`None` 或 `enabled=False` 表示不动（见 `MotionSpec`）。
    motion: 'MotionSpec' = None

    @property
    def sheet(self) -> str:
        """**第一页**的路径（单页包的全部，多页包的主页）。

        保留这个名字是因为它被大量既有代码读取（回退链、尺寸反推、
        覆盖解析…），而「第一页」正是那些地方想要的语义。
        多页相关的新代码请用 `sheets`。
        """
        return self.sheets[0] if self.sheets else ''

    @property
    def animated(self) -> bool:
        """这套动画是**动图容器**（浏览器自行播放，插件不切帧）吗？

        见 `LAYOUT_ANIMATED` 的说明：容器路线的价值是「零制作成本」，
        代价是放弃逐帧控制与分页能力。
        """
        return self.layout == LAYOUT_ANIMATED

    @property
    def total_ms(self) -> float:
        """播完一轮的毫秒数（非均匀时长下是逐帧之和）。

        ⚠️ 动图容器返回 **0**：一轮多久由文件自己的元数据决定，
        插件读不到也不该猜。调用方（例如「播完回 idle」的定时器）
        必须自己给兜底值——用一个编出来的数字会让动作被提前打断。
        """
        if self.animated:
            return 0.0
        if self.frame_ms:
            return float(sum(self.frame_ms))
        if self.fps > 0:
            return self.frames * 1000.0 / self.fps
        return 0.0

    @property
    def effective_fps(self) -> float:
        """折算出的平均帧率；动图容器返回 0（见 `AnimationVariant.effective_fps`）。"""
        total = self.total_ms
        if total <= 0:
            return float(self.fps)
        return round(self.frames * 1000.0 / total, 2)

    @property
    def per_page(self) -> int:
        """一页的**网格容量**（每页最多排几帧）。见 `page_capacity`。"""
        return page_capacity(self.frames, len(self.sheets), self.cols, self.rows)

    @property
    def grid(self) -> tuple:
        """生效的 `(cols, rows)`（**每页**的形状，见 `frame_grid`）。"""
        return frame_grid(self.layout, self.per_page, self.cols, self.rows)

    @property
    def capacity(self) -> int:
        """每页能装几帧（`cols × rows`）。

        与「实际排了几帧」的差值就是**空着的格子数**——网格允许装不满
        （例如 4×4 只放 13 帧），那些格子是透明的。
        """
        cols, rows = self.grid
        return cols * rows

    @property
    def page_count(self) -> int:
        """这个动画有几页——**就是声明了几张 sheet**。

        为什么是「声明的页数」而不是「帧数算出来的页数」：两者不一致时
        必须以前者为准，因为「磁盘上有几张图」是客观事实，而帧数是作者的意图。
        用后者会让「我给了 3 页，它只用了 2 页」变成静默发生的事——
        多出来的那一页永远不会被播到，作者却以为它在用。
        这种不一致由解析器**报错**拦下（见 `_parse_variant`），
        因此这里的两个数在合法包里总是相等。
        """
        return max(1, len(self.sheets))

    def to_dict(self) -> dict:
        # ⚠️ 这里写的是**作者意图**（`layout` / `sheet(s)`），**不**写推导出来的
        # `cols` / `rows`。
        #
        # 两种形状各司其职，不能混：
        # - `AnimationVariant.to_dict()` → `pet.json` 的形状（作者写的意图）；
        # - `ResolvedVariant.to_dict()` → 运行期定义的形状（后端算好的几何）。
        #
        # 混起来的后果是**往返断裂**：`to_dict()` 里同时写 `layout: "horizontal"`
        # 与 `cols: 4, rows: 1`，再读回来时两个字段并存——而它们表达的是同一件事，
        # 一旦校验规则认为「并存即冲突」，导出再导入就会报错。
        payload = {
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
            'frameMs': list(self.frame_ms),
            'weight': self.weight,
        }
        # ⚠️ 动图容器**不能**写 `frames` / `fps` / `loop` / `frameMs`：
        # 它们全在 `ANIMATED_FORBIDDEN_FIELDS` 里，写出来就再读不回去
        # ——`to_dict()` 的输出必须能被 `from_dict()` 原样吃下
        # （「导出再导入」正是靠它）。这里曾经写出 `loop: true` 与
        # `fps: 0`，于是**导出再导入直接报错**。
        if self.animated:
            payload = {'layout': self.layout, 'weight': self.weight}
        # 程序化运动：只在启用时写，且只写启用的那一部分
        # （`MotionSpec.to_dict` 保证「写出去 → 读回来」语义不变）。
        if self.motion is not None and self.motion.enabled:
            payload['motion'] = self.motion.to_dict()
        # 单页写 `sheet`（字符串）、多页写 `sheets`（数组）：
        # 单页是绝大多数包的形态，不该因为引擎支持多页就变啰嗦。
        if len(self.sheets) > 1:
            payload['sheets'] = list(self.sheets)
        else:
            payload['sheet'] = self.sheet
        # 只在**真的声明了**独立尺寸时才写这个字段：绝大多数包不该多出噪音
        if self.size:
            payload['size'] = dict(self.size)
        # `grid` 排布下 `cols` / `rows` 是**不可省**的：`layout: "grid"` 本身
        # 不携带形状信息，丢掉它们就等于丢掉「一行放几个」。
        # `horizontal` / `vertical` 不需要（形状由 `layout` + 帧数唯一确定）。
        if self.layout == LAYOUT_GRID:
            cols, rows = self.grid
            payload['cols'] = cols
            payload['rows'] = rows
        return payload


@dataclass
class Trigger:
    """一个**时间驱动行为**的节奏配置（`idle` 的小动作、`roam` 的漫游、
    `sleep` 的打盹阈值）。

    为什么它不再是「idle 的触发方式」：用户要求「支持调整不同动作的触发时间」，
    而真正**由时间驱动**的行为只有三个——闲着时偶尔动一下（`idle`）、
    闲着时自己走一走（`roam`）、多久没人理就睡着（`sleep`）。
    其余动作都是**事件驱动**的（`click` 要有人点、`fall` 要松手、
    `happy` 要有播报…），给它们设「多久触发一次」没有意义，
    因此解析器对它们明确报错而不是静默忽略。

    `mode` 与 `plays` 只对 `idle` 有意义：

    - `random`（默认）：平时停在标准图像，隔一段随机时间播一遍，播完回静止；
    - `loop`：一直循环待机动画（不做「播一遍就停」）。

    `roam` 的持续时长由物理决定（走到目标点就停），不是「播几轮」，
    所以它**没有** `mode` / `plays`（写了会报错，见 `BEHAVIOR_FIELDS`）。

    `sleep` 形状又不一样：它是一个**阈值**（「静了多久之后睡着」），
    不是「每隔一段随机时间发生一次」，因此只有一个 `after_ms`。
    用 `min_ms` / `max_ms` 表达它会把「随机」这个语义强加上去——
    而「多久不管就睡觉」显然不该是随机的。
    """

    mode: str = IDLE_TRIGGER_RANDOM
    min_ms: int = DEFAULT_SCHEDULE_MS['idle'][0]
    max_ms: int = DEFAULT_SCHEDULE_MS['idle'][1]
    #: 一次触发连续播几轮（只有 idle 用得上）。
    plays: int = DEFAULT_IDLE_PLAYS
    #: 打盹阈值（毫秒）——只有 `sleep` 用得上。
    #:
    #: 「静了多久之后睡着」。`None` 表示**没设**——此时应当回落到宿主的
    #: 全局 `sleep_after`，而**不是**回落成一个写死的默认值：
    #: 宿主表单里那个全局值本来就是给「形象没声明」时用的，
    #: 如果这里悄悄填上一个默认值，全局设置就永远不生效了
    #: （用户会看到「我在宿主设置里改了却没反应」）。
    after_ms: int = None
    #: 这个节奏属于哪个行为（`idle` / `roam` / `sleep`）。
    #:
    #: 序列化时按它决定**写哪些字段**：`roam` 没有 `mode` / `plays`，
    #: `sleep` 只有 `afterMs`，而 `to_dict()` 的输出必须能被
    #: `from_dict()` 原样读回来（否则 round-trip 断裂，
    #: 而「导出再导入」正是靠它）。
    behavior: str = 'idle'

    def to_dict(self) -> dict:
        fields = BEHAVIOR_FIELDS.get(self.behavior, ())
        # `sleep` 是阈值：只写 `afterMs`，不写区间（见类文档）。
        #
        # ⚠️ `afterMs` 为 `None` 时也**要写出来**（值是 null），不能省略这个键。
        # 省略的话前端分不清「这个形象没设打盹阈值」与「后端没实现这个字段」，
        # 而前者要回落到宿主全局、后者只能用一个写死的默认值。
        if self.behavior == 'sleep':
            return {'afterMs': self.after_ms}
        payload = {
            'minIntervalMs': self.min_ms,
            'maxIntervalMs': self.max_ms,
        }
        # 只写这个行为**支持**的字段（见 `BEHAVIOR_FIELDS`）。
        if 'mode' in fields:
            payload['mode'] = self.mode
        if 'plays' in fields:
            payload['plays'] = self.plays
        return payload


@dataclass
class AnimationSpec:
    """单个动作的原始声明（已经过类型与范围校验）。

    内部是**一组** `AnimationVariant`；`sheet` / `frames` / `fps` / `loop` /
    `layout` 这几个属性透传第一套（主变体），这样只写单套动画的包
    在代码里读起来仍和从前一样。
    """

    variants: list = field(default_factory=list)

    # ---- 主变体的透传属性（向后兼容的读法）----

    @property
    def primary(self) -> AnimationVariant:
        if not self.variants:
            return AnimationVariant()
        return self.variants[0]

    @property
    def sheet(self) -> str:
        return self.primary.sheet

    @property
    def frames(self) -> int:
        return self.primary.frames

    @property
    def fps(self) -> float:
        return self.primary.fps

    @property
    def loop(self) -> bool:
        return self.primary.loop

    @property
    def layout(self) -> str:
        return self.primary.layout

    @property
    def frame_ms(self) -> list:
        return self.primary.frame_ms

    @property
    def weight(self) -> float:
        return self.primary.weight

    def to_dict(self) -> dict:
        """序列化成**扁平**写法（单套）或 `variants` 写法（多套）。

        单套动画仍写成扁平形式：那是绝大多数包的形态，也是
        「最省事的写法」所承诺的样子，不该因为引擎支持多套就变啰嗦。

        注意这里**不写** `trigger` / `intervalMs` / `plays`：那些是
        **时间驱动行为的节奏**，已经上移到顶层的 `schedule` 块——
        因为 `roam`（自动漫游）根本不是动作，没法挂在 `animations` 下面。
        两处都能写同一件事的话，迟早会出现「两处不一致」的包。
        """
        payload = {}
        if len(self.variants) == 1:
            variant = self.variants[0].to_dict()
            # 单套时不写 weight（它恒为 1，写出来只是噪音）
            variant.pop('weight', None)
            payload.update(variant)
        else:
            payload['variants'] = [variant.to_dict() for variant in self.variants]
        return payload


@dataclass
class ResolvedVariant:
    """解析后的**一套**动画（图 URL 由 store 层填，这里只有帧参数）。

    `sheets` 是**多页**的路径列表（单页时长度为 1）。store 层会为每一页
    各算一个 URL，前端按「页优先、页内行优先」的帧序换页换格。
    """

    sheets: list = field(default_factory=list)
    frames: int = 1
    fps: float = 8
    loop: bool = True
    layout: str = LAYOUT_HORIZONTAL
    #: 网格几何（见 `AnimationVariant.cols` 的说明）。
    cols: int = 0
    rows: int = 0
    frame_ms: list = field(default_factory=list)
    weight: float = DEFAULT_WEIGHT
    #: 这一套动画自己的单帧尺寸；`None` 表示沿用包级 `size`（见 `AnimationVariant.size`）。
    size: dict = None
    #: 程序化运动（见 `MotionSpec`）。`None` = 不动。
    motion: 'MotionSpec' = None

    @property
    def sheet(self) -> str:
        """**第一页**的路径（见 `AnimationVariant.sheet`）。"""
        return self.sheets[0] if self.sheets else ''

    @property
    def animated(self) -> bool:
        """动图容器（见 `AnimationVariant.animated`）。"""
        return self.layout == LAYOUT_ANIMATED

    @property
    def total_ms(self) -> float:
        """播完一轮的毫秒数；动图容器返回 0（见 `AnimationVariant.total_ms`）。"""
        if self.animated:
            return 0.0
        if self.frame_ms:
            return float(sum(self.frame_ms))
        if self.fps > 0:
            return self.frames * 1000.0 / self.fps
        return 0.0

    @property
    def effective_fps(self) -> float:
        """折算出的平均帧率；动图容器返回 0（见 `AnimationVariant.effective_fps`）。"""
        total = self.total_ms
        if total <= 0:
            return float(self.fps)
        return round(self.frames * 1000.0 / total, 2)

    @property
    def per_page(self) -> int:
        """一页的网格容量（见 `page_capacity`）。"""
        return page_capacity(self.frames, len(self.sheets), self.cols, self.rows)

    @property
    def grid(self) -> tuple:
        return frame_grid(self.layout, self.per_page, self.cols, self.rows)

    @property
    def page_count(self) -> int:
        """这个动画有几页——**就是声明了几张 sheet**（见 `AnimationVariant.page_count`）。"""
        return max(1, len(self.sheets))

    def to_dict(self) -> dict:
        cols, rows = self.grid
        # ⚠️ 动图容器不能写 `frames` / `fps` / `loop` / `frameMs` / `cols` / `rows`：
        # 它们全在 `ANIMATED_FORBIDDEN_FIELDS` 里。运行期定义虽然不会被
        # 解析回领域对象，但**面板与前端会读这些字段**——写一堆假值
        # （`fps: 0`、`frames: 1`）只会让界面说出与事实不符的话。
        # 真正要表达的是 `animated`，由 store 层补进运行期定义。
        if self.animated:
            payload = {
                'layout': self.layout,
                'animated': True,
                'weight': self.weight,
            }
        else:
            payload = {
                'frames': self.frames,
                'fps': self.fps,
                'loop': self.loop,
                'layout': self.layout,
                'cols': cols,
                'rows': rows,
                'frameMs': list(self.frame_ms),
                'weight': self.weight,
            }
        # 单页写 `sheet` / 多页写 `sheets`：与 `AnimationVariant.to_dict()`
        # 同一取舍（单页不该变啰嗦）。
        if len(self.sheets) > 1:
            payload['sheets'] = list(self.sheets)
        else:
            payload['sheet'] = self.sheet
        if self.size:
            payload['size'] = dict(self.size)
        # 程序化运动：运行期定义必须带上它——前端**只读运行期定义**，
        # 读不到就不会动。而「桌面上不动、面板里动」正是最难查的一类偏差。
        if self.motion is not None and self.motion.enabled:
            payload['motion'] = self.motion.to_dict()
        return payload


@dataclass
class ResolvedAction:
    """请求某个动作时的**解析结果**（含回退信息，供 UI 解释）。"""

    action: str
    #: 最终真正使用的动作名；``''`` 表示连回退链都落空（只有 idle 全缺时可能）。
    source: str = ''
    kind: str = KIND_NONE
    #: **第一页**的路径（多页时见 `variants[].sheets`）。
    sheet: str = ''
    frames: int = 0
    fps: float = 0
    loop: bool = True
    layout: str = LAYOUT_HORIZONTAL
    #: 主变体的网格几何（见 `AnimationVariant.cols`）。
    cols: int = 0
    rows: int = 0
    #: 非均匀帧时长（毫秒）；空表示按 `fps` 均匀推进。
    frame_ms: list = field(default_factory=list)
    #: 是否要把 `sheet` **水平镜像**后再播（方向化行走只提供一侧时为 True）。
    #: 前端据此决定 `transform: scaleX(-1)`——注意这**不同于**「按朝向翻转」：
    #: 方向化贴图本身已经画好了朝向，翻转只由这个标记决定。
    mirror: bool = False
    #: 尝试过的动作序列（含起点），用于向用户解释「为什么看起来是这样」。
    chain: list = field(default_factory=list)
    #: 面向用户的一句话解释。
    note: str = ''
    #: 这个动作的**全部**可播变体（多套动画时按 `weight` 随机选一套播）。
    #: 上面那组字段是**主变体**的透传，方便只关心单套动画的调用方。
    variants: list = field(default_factory=list)
    #: 主变体自己的单帧尺寸；`None` 表示沿用包级 `size`。
    #:
    #: 与「节奏」是两件不同的事：尺寸是**图本身的属性**（躺姿是横构图），
    #: 因此留在动作层；而节奏上移到了形象级 `schedule`（`roam` 不是动作，
    #: 挂不到动作下面）。两者都在本轮里落地，互不影响。
    size: dict = None

    def to_dict(self) -> dict:
        cols, rows = frame_grid(self.layout, self.frames, self.cols, self.rows)
        payload = {
            'action': self.action,
            'source': self.source,
            'kind': self.kind,
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
            'cols': cols,
            'rows': rows,
            'frameMs': list(self.frame_ms),
            'mirror': self.mirror,
            'chain': list(self.chain),
            'note': self.note,
            'variants': [variant.to_dict() for variant in self.variants],
        }
        if self.size:
            payload['size'] = dict(self.size)
        return payload

@dataclass
class StillImage:
    """**标准图像**：不播动画时显示的那一帧。

    为什么需要它
    ------------
    `idle` 的默认触发是「平时静止 + 隔一段随机播一遍」，而「静止」原本的实现是
    **保留刚刚播过的那套变体的第 0 帧**。作者一旦给 idle 挂上第二套动画
    （内置形象的「张望」就是这样），静止画面就会变成「张望的第 0 帧」——
    那是一个**抬头看**的姿势，卡在那里很怪。

    正确语义是「不播动画时显示**一个固定的标准姿势**」，与「刚刚播过什么」无关。
    因此标准图像是独立的一份声明：

    - 包内显式声明了 `still` → 用它；
    - 没声明 → 回落到 `idle` 主变体的第 0 帧（也就是历史行为里
      「作者只给了一套 idle」时的正确结果）。
    """

    #: sheet 相对路径；空表示这个包连 idle 都没有（宠物不显示）。
    sheet: str = ''
    #: 这条 sheet 里排了几帧（用于切帧几何）。
    frames: int = 1
    #: 用这条 sheet 的第几帧当标准图像。
    frame: int = 0
    layout: str = LAYOUT_HORIZONTAL
    #: 网格几何（见 `AnimationVariant.cols`）。
    #:
    #: 标准图像也要有它：标准图像可以从**任意一条** sheet 里取一帧
    #: （包括一条网格排布的 sheet）。没有几何就算不出「第 7 帧在哪」——
    #: 那会让标准图像显示成第 0 帧，而包本身看起来完全正常。
    cols: int = 0
    rows: int = 0
    #: 这一帧是**包内显式声明**的（`False` = 回落自 idle 首帧）。
    declared: bool = False
    #: 来源动作名（`'still'` 或 `'idle'`），供 UI 解释与排查。
    source: str = 'idle'
    #: 这一帧所在 sheet 的**单帧尺寸**；`None` 表示沿用包级 `size`。
    #:
    #: 为什么标准图像也需要它：标准图像可以取自**任意一条** sheet
    #: （例如把躺姿 `sleep.png` 的某一帧当门面），而那条 sheet 的画布比例
    #: 可能与当前动作完全不同。不带尺寸的话，前端会用**当前动作**的
    #: `width` / `height` 去铺它——横构图的图被按竖构图拉伸（实测失真 62%）。
    #:
    #: 这个问题只有「标准图像」与「逐动作尺寸」两个功能**同时存在**时才出现，
    #: 因此两条分支各自都测不出来，是合并时才发现并补上的。
    size: dict = None
    #: **程序化运动**：标准图像要**继承 idle 的运动**（见下面 `resolve_still` 的说明）。
    #:
    #: 为什么标准图像也要动：默认的 idle 模式是「平时静止 + 隔一段随机播一遍」，
    #: 也就是说宠物**大部分时间显示的就是标准图像**。如果标准图像不动，
    #: 那么「呼吸」这个特性在绝大多数时间里根本看不见——宠物看起来仍是死的。
    #: 标准图像按定义就是「idle 那个姿势的定格」，因此它理应和 idle 一起呼吸。
    motion: 'MotionSpec' = None

    @property
    def grid(self) -> tuple:
        return frame_grid(self.layout, self.frames, self.cols, self.rows)

    def to_dict(self) -> dict:
        # 与 `AnimationVariant.to_dict()` 同样的取舍：这里写**作者意图**
        # （`layout`），`cols` / `rows` 只在网格排布下才写。
        # 但标准图像**额外**有一份运行期形状的需求（前端要算「第 frame 帧在哪」），
        # 那份由 `store._runtime_still()` 在 `to_dict()` 之上补 `cols` / `rows`——
        # 那条路径的输出不会被再解析回 `StillImage`，因此不会造成往返断裂。
        payload = {
            'sheet': self.sheet,
            'frames': self.frames,
            'frame': self.frame,
            'layout': self.layout,
            'declared': self.declared,
            'source': self.source,
        }
        if self.size:
            payload['size'] = dict(self.size)
        if self.layout == LAYOUT_GRID:
            cols, rows = self.grid
            payload['cols'] = cols
            payload['rows'] = rows
        return payload


@dataclass
class PetPack:
    """一份宠物包（已解析、已校验）。"""

    format: int = FORMAT_VERSION
    id: str = ''
    name: str = ''
    author: str = ''
    size: dict = field(default_factory=lambda: dict(DEFAULT_SIZE))
    anchor: dict = field(default_factory=lambda: dict(DEFAULT_ANCHOR))
    #: 形象自带的大小倍率（可选，`DEFAULT_SCALE` 表示「没声明」）。
    scale: float = DEFAULT_SCALE
    #: 是否按像素风渲染（可选，默认平滑插值，见 `DEFAULT_PIXELATED`）。
    pixelated: bool = DEFAULT_PIXELATED
    #: 形象自带的**动画速度倍率**（可选，见 `DEFAULT_ANIM_SPEED`）。
    anim_speed: float = DEFAULT_ANIM_SPEED
    #: 这个形象是否参与**自动漫游**（可选，见 `DEFAULT_AUTO_ROAM`）。
    auto_roam: bool = DEFAULT_AUTO_ROAM
    physics: dict = field(default_factory=lambda: dict(DEFAULT_PHYSICS))
    animations: dict = field(default_factory=dict)
    #: **标准图像**的原始声明（`None` = 作者没声明，回落 idle 首帧）。
    still: StillImage = None
    #: **时间驱动行为**的节奏：`{行为名: Trigger}`。
    #: 只包含作者**显式声明过**的项；缺的项由调用方用默认值补齐。
    schedules: dict = field(default_factory=dict)
    #: 解析时忽略掉的未知字段（向前兼容），仅用于排查。
    ignored_fields: list = field(default_factory=list)

    # ------------------------------------------------------------ 查询

    def has_action(self, action: str) -> bool:
        return action in self.animations

    def resolve(self, action: str) -> ResolvedAction:
        """按回退链解析动作（§3.3 的契约实现）。

        链路：`请求的动作 → 回退链 → idle`。
        命中某个有 sheet 的动作 → `kind='animated'`；
        命中的动作存在但**没有 sheet**（或链路落空）→ `kind='static'`，
        调用方应只位移容器、不播帧。

        方向化行走（`walk-left` / `walk-right`）多一层：
        自己那一侧缺失时，**镜像**对侧复用（`mirror=True`）。
        镜像之后轮到 `idle`——**没有正面 `walk` 这一层**了。
        """
        action = str(action or '').strip()
        if not action:
            action = 'idle'

        # 标准图像走**同一条**解析通路（用户覆盖 > 包内 > 内置），
        # 因此这里把它当成一个「只有一帧、不循环」的动作返回。
        #
        # 为什么不另写一条：`store.resolve_frame_path()` 已经处理了
        # 「覆盖优先」「路径安全复核」「文件存在性」这几件事，而那些都有测试钉住。
        # 复制一份的代价是两边迟早不一致——尤其路径安全那部分。
        if action == STILL_ACTION:
            return self._resolve_still_action()

        # 未知动作名：直接并入回退链（保证向前兼容：新动作名在旧包上不报错）
        chain = [action]
        # 方向化行走：先试对侧（镜像），再走常规回退链
        opposite = WALK_DIRECTION_ACTIONS.get(action)
        if opposite:
            chain.append(opposite)
        for candidate in ACTION_FALLBACKS.get(action, ('idle',)):
            if candidate not in chain:
                chain.append(candidate)
        if 'idle' not in chain:
            chain.append('idle')

        for candidate in chain:
            spec = self.animations.get(candidate)
            if spec is None:
                continue
            # 只认**真的有图**的变体：多套动画里允许某一套的 sheet 为空
            # （作者临时撤掉一张图），它不该把整个动作拖成「只位移」。
            playable = [variant for variant in spec.variants if variant.sheets]
            if playable:
                # 命中的是对侧方向化动作 → 需要镜像
                mirrored = bool(opposite) and candidate == opposite
                if candidate != action:
                    if mirrored:
                        note = (f'缺少「{action}」动作，已镜像复用'
                                f'「{candidate}」。')
                    else:
                        note = f'缺少「{action}」动作，已回退到「{candidate}」。'
                else:
                    note = ''
                # 只有**自己**的变体能整套复用；镜像复用时要翻转朝向，
                # 而「每套动画各自的朝向」无法靠一个 mirror 标记表达，
                # 因此镜像路径只取主变体（多套动画本就是「同一动作的变体」，
                # 少播几套不影响正确性，播错朝向才是错的）。
                variants = playable if not mirrored else playable[:1]
                primary = variants[0]
                primary_cols, primary_rows = primary.grid
                return ResolvedAction(
                    action=action, source=candidate, kind=KIND_ANIMATED,
                    sheet=primary.sheet, frames=primary.frames, fps=primary.fps,
                    loop=primary.loop, layout=primary.layout,
                    cols=primary_cols, rows=primary_rows,
                    frame_ms=list(primary.frame_ms),
                    size=dict(primary.size) if primary.size else None,
                    mirror=mirrored,
                    chain=chain, note=note,
                    variants=[
                        ResolvedVariant(
                            sheets=list(variant.sheets), frames=variant.frames,
                            fps=variant.fps, loop=variant.loop,
                            layout=variant.layout,
                            cols=variant.cols, rows=variant.rows,
                            frame_ms=list(variant.frame_ms),
                            weight=variant.weight,
                            # 每套动画可以各自不同尺寸（横构图 / 竖构图共存），
                            # 前端换套播时几何要跟着换，因此必须逐套透传。
                            size=dict(variant.size) if variant.size else None,
                            # 程序化运动也逐套透传：多套动画可以一套呼吸、
                            # 另一套不动（例如「清醒的 idle」与「睡着的 idle」）。
                            motion=variant.motion,
                        )
                        for variant in variants
                    ],
                )
            # 存在但没 sheet → 只位移不播帧（「必要动作」的降级语义）
            if candidate == 'idle':
                return ResolvedAction(
                    action=action, source=candidate, kind=KIND_STATIC,
                    chain=chain,
                    note='没有可用的帧图，将只移动位置、不播放动画。',
                )

        # 连 idle 都没有：解析阶段已经报错（`from_dict` 会拒绝），
        # 这里只是防空转的兜底。
        return ResolvedAction(
            action=action, kind=KIND_NONE, chain=chain,
            note='没有找到任何可用的动作，宠物将不显示。',
        )

    def _resolve_still_action(self) -> ResolvedAction:
        """把**标准图像**包装成一个「只有一帧、不循环」的动作解析结果。

        这样 `store.resolve_frame_path()` 就能原样处理它（覆盖优先、路径复核、
        文件存在性检查全都复用），前端也能用同一套切帧几何画它。
        """
        still = self.resolve_still()
        if not still.sheet:
            return ResolvedAction(
                action=STILL_ACTION, kind=KIND_NONE, chain=[STILL_ACTION],
                note='没有可用的标准图像，宠物将不显示。',
            )
        still_cols, still_rows = still.grid
        return ResolvedAction(
            action=STILL_ACTION, source=still.source, kind=KIND_ANIMATED,
            sheet=still.sheet, frames=still.frames, fps=1, loop=False,
            layout=still.layout, cols=still_cols, rows=still_rows,
            chain=[STILL_ACTION],
            # 标准图像自己的尺寸（来自它所在的 sheet）要一并透传：
            # `ResolvedAction.size` 是「主变体的尺寸」，而标准图像就是它的主变体。
            size=dict(still.size) if still.size else None,
            variants=[ResolvedVariant(
                sheets=[still.sheet], frames=still.frames, fps=1, loop=False,
                layout=still.layout, cols=still_cols, rows=still_rows,
                size=dict(still.size) if still.size else None,
                # 静止画面也要动（见 `StillImage.motion`）：默认 idle 模式下
                # 宠物大部分时间显示的就是它。
                motion=still.motion,
            )],
        )

    def resolve_still(self) -> StillImage:
        """解析**标准图像**（不播动画时显示的那一帧）。

        优先级：

        1. 包内显式声明的 `still`（`declared=True`）；
        2. 回落：`idle` 主变体的**第 0 帧**。

        为什么要「显式声明优先」而不是「永远用 idle 首帧」：`idle` 可以挂多套
        动画（内置形象的「张望」就是第二套），而「标准图像」的语义是
        **一个固定的标准姿势**——与「这次随机抽到了哪一套」无关。
        回落只保证「作者没声明时不会崩」，不保证它一定好看。

        尺寸的处理（与「逐动作尺寸」这个特性的交叉点）：

        - 标准图像自己声明了 `size` → 用它；
        - 没声明 → 尝试**从它引用的 sheet 反推**（见 `_size_for_sheet`）：
          作者写 `still: {"sheet": "sleep.png"}` 时，`sleep` 动作的尺寸
          就是这张图的尺寸，两者必然一致；
        - 反推不到 → `None`，前端回落到包级 `size`。

        为什么要反推：不推的话，作者从横构图 sheet 里挑一帧当门面时
        必须**记得**再写一遍 `size`，忘了就会被按竖构图拉伸——而那正是
        「逐动作尺寸」这个特性要解决的同一个问题。
        """
        still = self.still
        # 标准图像的**程序化运动**统一继承 `idle` 主变体——**两条分支都一样**。
        #
        # 为什么不看「这条 still 是从哪张图来的」：呼吸是「这个形象在待机时
        # 怎么动」的属性，而不是「这张图从哪来」的属性。作者声明
        # `still: {sheet: "sleep.png"}` 时，他要的是「静止时显示睡姿」，
        # 而不是「静止时不要呼吸」——而睡姿呼吸恰恰是自然的。
        #
        # 更要紧的是：默认 idle 模式下宠物**大部分时间显示标准图像**，
        # 标准图像不继承运动的话，这个特性几乎永远看不见。
        idle_motion = None
        try:
            idle_resolved = self.resolve('idle')
            if idle_resolved.kind == KIND_ANIMATED and idle_resolved.variants:
                idle_motion = idle_resolved.variants[0].motion
        except Exception:  # noqa: BLE001 - 取不到就不动，不该让标准图像解析失败
            idle_motion = None

        if still is not None and still.sheet:
            size = dict(still.size) if still.size else self._size_for_sheet(still.sheet)
            return StillImage(
                sheet=still.sheet,
                frames=max(1, int(still.frames)),
                frame=still.frame,
                layout=still.layout,
                cols=still.cols,
                rows=still.rows,
                declared=True,
                source=STILL_ACTION,
                size=size,
                motion=idle_motion,
            )

        # 回落：idle 的主变体首帧
        resolved = self.resolve('idle')
        if resolved.kind == KIND_ANIMATED and resolved.sheet:
            return StillImage(
                sheet=resolved.sheet,
                frames=max(1, int(resolved.frames)),
                frame=0,
                layout=resolved.layout,
                # ★ 回落路径必须**继承 idle 那条 sheet 的网格**：标准图像是它的第 0 帧，
                # 几何必须与 idle 一致。用默认的「单行」去切一条网格排布的 sheet，
                # 取到的就不是第 0 帧而是「第 0 行第 0 列」——单行时两者恰好相同，
                # 网格排布时则完全不同（这正是最容易漏的一处）。
                cols=resolved.cols,
                rows=resolved.rows,
                declared=False,
                source=resolved.source or 'idle',
                # ★ 回落路径必须**继承 idle 那条 sheet 的尺寸**：
                # idle 自己声明了 `size` 时（少见但合法），标准图像与它同源，
                # 几何必须一致，否则静止画面与待机动画会互相错位。
                size=dict(resolved.size) if resolved.size else None,
                motion=idle_motion,
            )
        return StillImage()

    def _size_for_sheet(self, sheet: str) -> dict:
        """从「哪条 sheet」反推单帧尺寸；找不到返回 `None`。

        只在作者**没写** `still.size` 时兜底。匹配的是 sheet 路径
        （规范化之后比较，`./idle.png` 与 `idle.png` 视为同一条），
        遍历所有动作的所有变体——标准图像完全可能取自某个变体。
        """
        target = to_posix(sheet).strip()
        if not target:
            return None
        for spec in self.animations.values():
            for variant in spec.variants:
                if not variant.size:
                    continue
                # 多页的每一页都可能是标准图像的来源，因此逐页比对
                for page in variant.sheets:
                    if page and to_posix(page).strip() == target:
                        return dict(variant.size)
        return None

    def missing_required(self) -> list:
        """缺失的「必要动作」列表（**不是错误**，但要告诉用户会怎么降级）。

        `walk` 的特例：行走**只有方向化动作**，因此提供**任一侧**
        （`walk-left` / `walk-right`）就算满足——另一侧会自动镜像。
        不这样特判的话，只给侧视图的形象会被误报「缺少行走」。
        """
        def satisfied(name: str) -> bool:
            if name in self.animations:
                return True
            if name == 'walk':
                return any(
                    candidate in self.animations
                    for candidate in WALK_DIRECTION_ACTIONS
                )
            return False

        return [name for name in REQUIRED_ACTIONS if not satisfied(name)]

    def schedule_for(self, behavior: str) -> Trigger:
        """取某行为的节奏配置（作者没声明时给该行为的默认值）。

        `mode` / `plays` 只对 `idle` 有意义：`roam` 没有这两项，
        因此给它一个 `plays=1` 是无害的占位（前端不读）。
        """
        key = str(behavior or '').strip()
        declared = self.schedules.get(key)
        if declared is not None:
            return declared
        low, high = DEFAULT_SCHEDULE_MS.get(key, DEFAULT_SCHEDULE_MS['idle'])
        return Trigger(
            mode=IDLE_TRIGGER_RANDOM, min_ms=low, max_ms=high, behavior=key,
        )

    def to_dict(self) -> dict:
        return {
            'format': self.format,
            'id': self.id,
            'name': self.name,
            'author': self.author,
            'size': dict(self.size),
            'anchor': dict(self.anchor),
            'scale': self.scale,
            'pixelated': self.pixelated,
            'animSpeed': self.anim_speed,
            'autoRoam': self.auto_roam,
            'physics': dict(self.physics),
            'animations': {key: spec.to_dict() for key, spec in self.animations.items()},
            'still': self.resolve_still().to_dict(),
            'schedule': {
                key: self.schedule_for(key).to_dict()
                for key in SCHEDULE_BEHAVIORS
            },
            'missingRequired': self.missing_required(),
            'ignoredFields': list(self.ignored_fields),
        }


# ------------------------------------------------------------------ 字段校验


def _field_error(field_name: str, reason: str, *, hint: str = '') -> PetError:
    return PetError(
        CODE_PACK_FIELD_INVALID,
        f'字段 {field_name} 非法: {reason}',
        user_msg=f'宠物包里的「{field_name}」有问题：{reason}',
        hint=hint or f'请检查 pet.json 里 {field_name} 的取值。',
    )


def _read_string(raw: dict, key: str, default: str = '') -> str:
    value = raw.get(key, default)
    if value is None:
        return default
    if not isinstance(value, str):
        raise _field_error(key, '应为字符串', hint=f'把 {key} 写成用引号包起来的文本。')
    return value.strip()


def _read_number(raw: dict, key: str, default: float, *, low: float, high: float) -> float:
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _field_error(key, '应为数字', hint=f'把 {key} 写成一个数字（不要加引号）。')
    number = float(value)
    if not (low <= number <= high):
        raise _field_error(
            key, f'应在 {low} ~ {high} 之间，实际为 {value}',
            hint=f'把 {key} 调整到 {low} ~ {high} 范围内。',
        )
    return number


def _read_positive_int(raw: dict, key: str, default: int, *, low: int, high: int,
                       where: str = '') -> int:
    """读一个整数并校验范围。

    `where` 只影响**报错信息里的字段名**：默认用 `key`，但顶层字段
    （例如标准图像的 `still.frame`）需要带上级前缀，否则作者看到的
    是裸的 `frame`，不知道改哪里。
    """
    field = where or key
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        # 容忍 4.0 这种浮点写法，但不接受 4.5
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        else:
            raise _field_error(
                field, '应为整数',
                hint=f'把 {key} 写成整数（例如 {default}）。',
            )
    number = int(value)
    if not (low <= number <= high):
        raise _field_error(
            field, f'应在 {low} ~ {high} 之间，实际为 {value}',
            hint=f'把 {key} 调整到 {low} ~ {high} 范围内。',
        )
    return number


def _read_bool(raw: dict, key: str, default: bool) -> bool:
    value = raw.get(key, default)
    if isinstance(value, bool):
        return value
    raise _field_error(
        key, '应为 true / false',
        hint=f'把 {key} 写成 true 或 false（不要加引号）。',
    )


def _read_fps(raw: dict, key: str, default: float) -> float:
    """读帧率。**接受小数**（帧数少时整数档太粗，见 `MIN_FPS`）。"""
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _field_error(
            key, '应为数字',
            hint=f'把 {key} 写成一个数字，例如 4 或 2.5（不要加引号）。',
        )
    number = float(value)
    if not (MIN_FPS <= number <= MAX_FPS):
        raise _field_error(
            key, f'应在 {MIN_FPS} ~ {MAX_FPS} 之间，实际为 {value}',
            hint=f'把 {key} 调整到 {MIN_FPS} ~ {MAX_FPS} 范围内。',
        )
    return round(number, 3)


def _read_frame_ms(raw: dict, key: str, frames: int) -> list:
    """读**非均匀帧时长**：一个每帧毫秒数的数组，长度必须等于 `frames`。

    为什么必须等长：长度不符时「第 i 帧该停多久」没有定义。
    容忍「只给一个数」的写法（等价于均匀帧率），那是作者最容易写出的东西。
    """
    value = raw.get(key)
    if value is None or value == []:
        return []
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = [value] * max(1, frames)
    if not isinstance(value, list):
        raise _field_error(
            key, '应为数字数组',
            hint=f'把 {key} 写成每帧一个毫秒数，例如 [180, 120, 120, 400]。',
        )
    if len(value) != max(1, frames):
        raise _field_error(
            key, f'长度应等于 frames（{frames}），实际 {len(value)}',
            hint=f'{key} 要一帧一个数：{frames} 帧就给 {frames} 个数。',
        )
    durations = []
    for index, item in enumerate(value):
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise _field_error(
                key, f'第 {index} 项不是数字',
                hint=f'{key} 里每一项都要是毫秒数（例如 200）。',
            )
        number = float(item)
        if not (MIN_FRAME_MS <= number <= MAX_FRAME_MS):
            raise _field_error(
                key,
                f'第 {index} 项应在 {MIN_FRAME_MS:.1f} ~ {MAX_FRAME_MS:.0f} 毫秒之间，'
                f'实际为 {item}',
                hint='一帧至少 17 毫秒（60fps），最多 10000 毫秒（10 秒）。',
            )
        durations.append(round(number, 2))
    return durations


def _read_weight(raw: dict, key: str, default: float = DEFAULT_WEIGHT) -> float:
    """读权重（**相对比例**，不是百分比）。"""
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _field_error(
            key, '应为数字',
            hint=f'把 {key} 写成一个数字（相对比例，例如 5）。',
        )
    number = float(value)
    if not (MIN_WEIGHT <= number <= MAX_WEIGHT):
        raise _field_error(
            key, f'应在 {MIN_WEIGHT} ~ {MAX_WEIGHT} 之间，实际为 {value}',
            hint=f'把 {key} 调整到 {MIN_WEIGHT} ~ {MAX_WEIGHT} 范围内。',
        )
    return round(number, 4)


def _parse_schedule(raw_value, *, where: str = 'schedule') -> dict:
    """解析顶层的 `schedule` 块：`{行为名: {intervalMs, mode, plays}}`。

    只接受 `SCHEDULE_BEHAVIORS` 里的键（`idle` / `roam`），其余一律报错。
    为什么不静默忽略未知键：作者写 `"click": {...}` 时的意图是明确的
    （「我想让点击动作按时间自己触发」），而那是**做不到**的——点击由用户
    触发。静默忽略会让他以为设好了却没生效，那比直接报错难查得多。

    同理，某个行为不支持的字段（例如 `roam.plays`）也报错，见 `BEHAVIOR_FIELDS`。
    """
    if raw_value is None:
        return {}
    if not isinstance(raw_value, dict):
        raise _field_error(
            where, '应为对象',
            hint='写成 {"idle": {"intervalMs": [6000, 18000]}} 这种形式。',
        )

    result = {}
    for raw_key, raw_spec in raw_value.items():
        behavior = str(raw_key or '').strip()
        if behavior not in SCHEDULE_BEHAVIORS:
            allowed = ' / '.join(SCHEDULE_BEHAVIORS)
            raise _field_error(
                f'{where}.{behavior}',
                f'不是可设置触发时间的行为（只能是 {allowed}）',
                hint='只有**由时间驱动**的行为能设间隔：待机小动作（idle）与'
                     '自动漫游（roam）。点击、下落、播报这类由事件触发的动作'
                     '没有「多久触发一次」可言。',
            )
        if raw_spec is None:
            continue
        if not isinstance(raw_spec, dict):
            raise _field_error(
                f'{where}.{behavior}', '应为对象',
                hint=f'写成 {{"intervalMs": [3000, 9000]}} 这种形式。',
            )

        allowed_fields = BEHAVIOR_FIELDS[behavior]
        stray = sorted(key for key in raw_spec if key not in allowed_fields)
        if stray:
            label = BEHAVIOR_LABELS.get(behavior, behavior)
            raise _field_error(
                f'{where}.{behavior}.{stray[0]}',
                f'「{label}」不支持这个字段',
                hint=f'「{label}」只能设 {"、".join(allowed_fields)}。',
            )

        result[behavior] = _parse_trigger(raw_spec, behavior, where=f'{where}.{behavior}')
    return result


def parse_schedule(raw_value) -> dict:
    """**公开**的节奏解析入口（store 层在写回 `pet.json` 前用它校验）。

    复用同一套校验的意义：面板提交的节奏与手写的 `pet.json` 走**完全一致**的
    规则。若 store 自己再写一份，两边迟早不一致——那种 bug 表现为
    「面板上设了能用，手写进包却报错」。
    """
    return _parse_schedule(raw_value)


def _parse_trigger(raw_spec: dict, behavior: str, *, where: str) -> Trigger:
    """解析**单个行为**的节奏（间隔区间 + idle 专属的 mode / plays）。"""
    low_default, high_default = DEFAULT_SCHEDULE_MS.get(
        behavior, DEFAULT_SCHEDULE_MS['idle'],
    )
    trigger = Trigger(
        mode=IDLE_TRIGGER_RANDOM, min_ms=low_default, max_ms=high_default,
        behavior=behavior,
    )

    # `sleep` 是**阈值**，不是区间：它只有 `afterMs`，走单独一条路
    # （见 `Trigger` 的类文档）。
    if behavior == 'sleep':
        if 'afterMs' not in raw_spec or raw_spec['afterMs'] is None:
            # 没写就是「没设」——回落到宿主的全局 `sleep_after`。
            return trigger
        trigger.after_ms = _read_positive_int(
            raw_spec, 'afterMs', low_default,
            low=SLEEP_AFTER_RANGE[0], high=SLEEP_AFTER_RANGE[1],
            where=f'{where}.afterMs',
        )
        return trigger

    if 'mode' in raw_spec:
        raw_mode = raw_spec.get('mode')
        if raw_mode is None:
            raw_mode = IDLE_TRIGGER_RANDOM
        if not isinstance(raw_mode, str) or raw_mode.strip().lower() not in IDLE_TRIGGER_MODES:
            allowed = ' / '.join(IDLE_TRIGGER_MODES)
            raise _field_error(
                f'{where}.mode', f'应为 {allowed}',
                hint=f'mode 写 "{IDLE_TRIGGER_RANDOM}"（平时静止、偶尔动一下）'
                     f'或 "{IDLE_TRIGGER_LOOP}"（一直循环）。',
            )
        trigger.mode = raw_mode.strip().lower()

    raw_interval = raw_spec.get('intervalMs')
    if raw_interval is not None:
        if not isinstance(raw_interval, list) or len(raw_interval) != 2:
            raise _field_error(
                f'{where}.intervalMs', '应为 [最小毫秒, 最大毫秒]',
                hint=f'例如 [{low_default}, {high_default}]：'
                     f'每隔 {low_default // 1000}~{high_default // 1000} 秒随机触发一次。',
            )
        low = _read_positive_int(
            {'v': raw_interval[0]}, 'v', low_default,
            low=MIN_SCHEDULE_MS, high=MAX_SCHEDULE_MS, where=f'{where}.intervalMs',
        )
        high = _read_positive_int(
            {'v': raw_interval[1]}, 'v', high_default,
            low=MIN_SCHEDULE_MS, high=MAX_SCHEDULE_MS, where=f'{where}.intervalMs',
        )
        if high < low:
            # 写反了不算错误——用户意图明确，直接调正比报错友好
            low, high = high, low
        trigger.min_ms, trigger.max_ms = low, high

    # 分开写的形状（`to_dict()` 与面板提交用的都是这个）。
    # 两个键都可以单独出现：面板一次只改一个滑块时只会传一个。
    for key, attr in (('minIntervalMs', 'min_ms'), ('maxIntervalMs', 'max_ms')):
        if key not in raw_spec or raw_spec[key] is None:
            continue
        default = low_default if key == 'minIntervalMs' else high_default
        setattr(trigger, attr, _read_positive_int(
            {'v': raw_spec[key]}, 'v', default,
            low=MIN_SCHEDULE_MS, high=MAX_SCHEDULE_MS, where=f'{where}.{key}',
        ))
    if trigger.max_ms < trigger.min_ms:
        trigger.min_ms, trigger.max_ms = trigger.max_ms, trigger.min_ms

    if 'plays' in raw_spec:
        raw_plays = raw_spec.get('plays')
        if raw_plays is not None:
            trigger.plays = _read_positive_int(
                {'v': raw_plays}, 'v', DEFAULT_IDLE_PLAYS,
                low=1, high=MAX_IDLE_PLAYS,
            )
    return trigger


def _parse_still(raw_value, *, allow_source_jpeg: bool = False) -> StillImage:
    """解析**标准图像**（顶层 `still`）。

    接受两种写法（与动作的 `sheet` 写法对齐，作者不必记两套规则）：

    - 字符串：`"still": "still.png"` —— 单帧；
    - 对象：`"still": {"sheet": "idle.png", "frame": 1}` —— 指定用第几帧。

    `frame` 是「用这条 sheet 的第几帧」：作者常常想拿 idle 里的某一帧当标准图像，
    但又不想为它单独切一张图，于是这个字段让「从多帧 sheet 里挑一帧」成立。
    """
    if raw_value is None:
        return None
    if isinstance(raw_value, str):
        raw_value = {'sheet': raw_value}
    if not isinstance(raw_value, dict):
        raise _field_error(
            'still', '应为对象或字符串',
            hint='写成 {"sheet": "still.png"} 或直接写 "still.png"。',
        )

    raw_sheet = raw_value.get('sheet', '')
    if raw_sheet is None:
        raw_sheet = ''
    if not isinstance(raw_sheet, str):
        raise _field_error('still.sheet', '应为字符串', hint='sheet 写文件名文本。')
    if not raw_sheet.strip():
        # 显式给了 still 却指向空：当作「没声明」，回落到 idle 首帧。
        # 这里不报错是因为「先占个位、图后面再补」是合理的编辑过程。
        return None

    sheet = _validate_sheet_path(
        raw_sheet, where='still', allow_source_jpeg=allow_source_jpeg, prefix='',
    )
    frames = _read_positive_int(
        raw_value, 'frames', 1, low=1, high=MAX_FRAMES, where='still.frames',
    )
    frame = _read_positive_int(
        raw_value, 'frame', 0, low=0, high=max(0, frames - 1), where='still.frame',
    )

    # 标准图像所在 sheet 的排布：与动作共用同一套解析（含 `grid`）。
    # 不共用的话，作者从一条网格 sheet 里挑一帧当门面时会取错帧——
    # 而那表现为「标准图像显示成第 0 帧」，包本身看起来完全正常。
    layout, cols, rows = _parse_layout(raw_value, where='still', frames=frames)
    return StillImage(
        sheet=sheet,
        frames=frames,
        frame=frame,
        layout=layout,
        cols=cols,
        rows=rows,
        declared=True,
        source=STILL_ACTION,
        # 可选：标准图像所在 sheet 的单帧尺寸。不写就是「沿用包级」。
        #
        # 为什么标准图像需要自己的尺寸：它可以取自**任意一条** sheet
        # （例如把躺姿 `sleep.png` 的某一帧当门面），而那条 sheet 的比例
        # 可能与当前动作完全不同。没有它，前端只能拿当前动作的几何去铺，
        # 横构图的图会被按竖构图拉伸。
        #
        # 复用 `_parse_variant_size`：语义与报错提示（「这是逻辑尺寸、
        # 不是源图像素尺寸」）与动作级 `size` 完全一致，作者不必记两套规则。
        size=_parse_variant_size(raw_value.get('size'), 'still'),
    )


def _validate_sheet_path(sheet: str, *, where: str, allow_source_jpeg: bool = False,
                         prefix: str = 'animations') -> str:
    """校验 sheet 相对路径：不得绝对、不得 `..`、扩展名在白名单内。

    `where` 是**报错信息**里的字段前缀（`idle` / `variants[1]` / `still`），
    `prefix` 是它的**父级**（动作在 `animations` 下，标准图像在顶层）。
    分开是因为标准图像是顶层字段（`still`），写成 `animations.still` 会误导作者。
    """
    text = to_posix(sheet).strip()
    if not text:
        raise PetError(
            CODE_PACK_SHEET_MISSING,
            f'{where} 的 sheet 为空',
            user_msg=f'宠物包里「{where}」的图没有指定文件名。',
            hint='给该项写一个相对路径，例如 "idle.png"。',
        )
    field = f'{prefix}.{where}.sheet' if prefix else f'{where}.sheet'
    if text.startswith('/') or (len(text) >= 2 and text[1] == ':'):
        raise _field_error(
            field, '不允许绝对路径',
            hint='sheet 必须是相对于包目录的路径，例如 "idle.png"。',
        )
    segments = [seg for seg in text.split('/') if seg not in ('', '.')]
    if any(seg == '..' for seg in segments):
        raise _field_error(
            field, '不允许包含 ".."',
            hint='sheet 只能指向包目录内部的文件。',
        )
    if not segments or not is_safe_relative_name(segments[-1]):
        raise _field_error(
            field, '文件名不合法',
            hint='文件名不能包含 <>:"|?* 等字符，也不能为空。',
        )
    extension = os.path.splitext(text)[1].lower()
    allowed = set(ALLOWED_SHEET_EXTENSIONS)
    if allow_source_jpeg:
        # 导入期：JPEG 等会被 store 转码成 PNG，这里放行
        allowed |= IMPORT_SOURCE_EXTENSIONS
    if extension not in allowed:
        allowed_text = '、'.join(sorted(allowed))
        raise _field_error(
            field,
            f'扩展名 {extension or "(无)"} 不受支持',
            hint=f'只支持 {allowed_text}。JPEG 请先转成 PNG 或 WebP 再放进包里。',
        )
    return text


def _parse_variant(
    action: str,
    raw_value: dict,
    *,
    where: str,
    allow_source_jpeg: bool = False,
    with_weight: bool = False,
) -> AnimationVariant:
    """解析**一套**动画的字段（`sheet` / `frames` / `fps` / `loop` / `layout`
    / `frameMs` / `weight`）。

    `where` 是报错信息里的字段前缀（`animations.idle` 或
    `animations.idle.variants[1]`），这样用户能直接知道是**哪一套**写错了。
    """
    variant = AnimationVariant()
    variant.sheets = _read_sheets(
        raw_value, where=where, action=action, allow_source_jpeg=allow_source_jpeg,
    )

    variant.frames = _read_positive_int(raw_value, 'frames', 1, low=1, high=MAX_FRAMES)

    # 排布：`horizontal` / `vertical` / `grid` / `animated`，统一折算成
    # `(cols, rows)`（见 `frame_grid` 与 `_parse_layout`）。
    #
    # ⚠️ 传给 `_parse_layout` 的是**一页的网格容量**，不是整个动画的帧数：
    # 多页时用总帧数去推 `cols` 会得到「一行 200 列」，每页的几何全错。
    #
    # 这里**不能**读 `variant.per_page`——那个属性依赖 `variant.cols` /
    # `variant.rows`，而它们正是 `_parse_layout` 的返回值。先读属性会拿到 0，
    # 于是容量退化成「总帧数 ÷ 页数」，报错时指向的字段与数字都跟着错
    # （实测：声明 8×8 两页 200 帧时，错误指向 `.rows` 并说「装不下 100 帧」）。
    # 因此复用同一个 `page_capacity`，但把**原始声明值**喂给它。
    raw_cols = raw_value.get('cols')
    raw_rows = raw_value.get('rows')
    per_page = page_capacity(
        variant.frames,
        len(variant.sheets),
        raw_cols if isinstance(raw_cols, int) and not isinstance(raw_cols, bool) else 0,
        raw_rows if isinstance(raw_rows, int) and not isinstance(raw_rows, bool) else 0,
    )

    variant.layout, variant.cols, variant.rows = _parse_layout(
        raw_value, where=where, frames=per_page,
    )

    # ⚠️ **动图容器到这就结束了**：它不切帧，因此 `fps` / `loop` / `frameMs`
    # 三个字段对它没有意义——`_parse_animated_layout` 已经确保作者没写它们。
    # 这里若继续往下读，`_read_frame_ms(raw_value, 'frameMs', 1)` 会拿默认值
    # 造出一个空的帧时长数组，而 `fps` 会变成默认的 8——两个都是**假数据**，
    # 会让下游（面板显示「8 fps」、时钟按 8fps 推进）说出与事实不符的话。
    if variant.layout == LAYOUT_ANIMATED:
        variant.fps = 0
        variant.loop = True
        variant.frame_ms = []
        variant.size = _parse_variant_size(raw_value.get('size'), where)
        # 动图容器**可以**呼吸（那是 sprite 上的 CSS 变换，与「谁在播」无关），
        # 但不能眨眼（没有可跳的帧）。
        variant.motion = _parse_motion(
            raw_value.get('motion'), where, frames=variant.frames, animated=True,
        )
        if with_weight:
            variant.weight = _read_weight(raw_value, 'weight')
        return variant

    variant.fps = _read_fps(raw_value, 'fps', 8)
    variant.loop = _read_bool(raw_value, 'loop', action not in ONE_SHOT_ACTIONS)
    variant.frame_ms = _read_frame_ms(raw_value, 'frameMs', variant.frames)
    variant.motion = _parse_motion(
        raw_value.get('motion'), where, frames=variant.frames, animated=False,
    )

    # 容量校验：网格必须真的装得下**全部**帧，否则末尾那些帧无处可放。
    #
    # 单页与多页共用这一条规则（`pages = 1` 时它退化成原来的单页校验）——
    # 分成两条写的话，多页那条很容易漏掉「单页也要查」，
    # 而漏掉的后果是**静默丢帧**：宠物只播前 16 帧，作者以为 20 帧都在。
    cols, rows = variant.grid
    per_page_capacity = cols * rows
    pages = max(1, len(variant.sheets))
    total_capacity = per_page_capacity * pages
    if total_capacity < variant.frames:
        field = f'{where}.sheets' if pages > 1 else (
            f'{where}.rows' if 'rows' in raw_value else f'{where}.cols'
        )
        scope = f'{pages} 页 × {cols}×{rows}' if pages > 1 else f'{cols}×{rows}'
        raise _field_error(
            field,
            f'{scope} 装不下 {variant.frames} 帧（只有 {total_capacity} 格）',
            hint=f'每页 {cols}×{rows} = {per_page_capacity} 格，'
                 f'{pages} 页共 {total_capacity} 格。'
                 f'需要 {-(-variant.frames // per_page_capacity)} 页，'
                 f'或把 cols / rows 调大。',
        )

    # 反过来：**每一页都要用得上**（只对多页有意义）。
    # 声明的页数超过实际需要的页数时，多出来的那几页永远不会被播到
    # ——作者却以为它在用。这属于「我明明给了 3 页，它只播了 2 页」
    # 这类最难查的问题，因此直接报错而不是静默接受。
    needed = -(-variant.frames // per_page_capacity)
    if needed < pages:
        raise _field_error(
            f'{where}.sheets',
            f'声明了 {pages} 页，但 {variant.frames} 帧只需要 {needed} 页'
            f'（每页 {per_page_capacity} 格）',
            hint=f'第 {needed + 1} 页起一帧都不会被播到。'
                 f'把 sheets 删到 {needed} 项，或把帧数提到 {needed * per_page_capacity + 1} 以上'
                 f'（最多 {total_capacity}）。',
        )

    # 这一套动画**自己的**单帧尺寸（可选）。不写就沿用包级 `size`。
    variant.size = _parse_variant_size(raw_value.get('size'), where)

    if with_weight:
        variant.weight = _read_weight(raw_value, 'weight')
    return variant


def _read_sheets(raw_value: dict, *, where: str, action: str,
                 allow_source_jpeg: bool = False) -> list:
    """读**一页或多页** sheet 路径，返回列表（长度 >= 1；没图时是 `[]`）。

    接受两种写法：

    - `"sheet": "walk.png"` —— 单页（绝大多数包）；
    - `"sheets": ["walk-0.png", "walk-1.png"]` —— 多页。

    两者**互斥**：同时写会报错，而不是挑一个。挑错的那个表现是
    「我明明给了 2 页，它只播了第 1 页」——而包能读、宠物能跑，
    作者只会以为是引擎的 bug（与 §2.5 的教训一致）。

    `sheets` 长度为 1 是合法的（等价于 `sheet`），因为工具生成时
    不必特判「只有一页」这个情况。

    空列表 / 空字符串表示「这套动画存在但只位移不播帧」——
    那是回退链的降级语义，不是错误。
    """
    has_single = 'sheet' in raw_value
    has_multi = 'sheets' in raw_value
    if has_single and has_multi:
        raise _field_error(
            f'{where}.sheets', '与 sheet 同时出现',
            hint='单页写 "sheet": "walk.png"，多页写 "sheets": ["walk-0.png", "walk-1.png"]，'
                 '两者只能选一个。',
        )

    if has_multi:
        raw_list = raw_value.get('sheets')
        if raw_list is None:
            return []
        if not isinstance(raw_list, list):
            raise _field_error(
                f'{where}.sheets', '应为数组',
                hint='写成 ["walk-0.png", "walk-1.png"]：每一页一个文件名。',
            )
        if len(raw_list) > MAX_PAGES:
            raise _field_error(
                f'{where}.sheets', f'最多 {MAX_PAGES} 页，实际 {len(raw_list)}',
                hint=f'一个动作最多拆 {MAX_PAGES} 页。每页 4096×4096 解出来是 64 MiB '
                     '显存，页数越多占得越多。',
            )
        paths = []
        for index, item in enumerate(raw_list):
            if item is None or (isinstance(item, str) and not item.strip()):
                raise _field_error(
                    f'{where}.sheets[{index}]', '不能为空',
                    hint='每一页都要有一个文件名；不想要的那一页请整项删掉。',
                )
            if not isinstance(item, str):
                raise _field_error(
                    f'{where}.sheets[{index}]', '应为字符串',
                    hint='每一页写一个文件名，例如 "walk-0.png"。',
                )
            paths.append(_validate_sheet_path(
                item, where=action, allow_source_jpeg=allow_source_jpeg,
            ))
        return paths

    raw_sheet = raw_value.get('sheet', '')
    if raw_sheet is None:
        raw_sheet = ''
    if not isinstance(raw_sheet, str):
        raise _field_error(f'{where}.sheet', '应为字符串', hint='sheet 写文件名文本。')
    if not raw_sheet.strip():
        return []
    return [_validate_sheet_path(
        raw_sheet, where=action, allow_source_jpeg=allow_source_jpeg,
    )]


def _parse_layout(raw_value: dict, *, where: str, frames: int) -> tuple:
    """解析帧排布，返回 `(layout, cols, rows)`。

    三种写法，`cols` / `rows` 是**规范形式**：

    - `"layout": "horizontal"`（默认）→ `(horizontal, frames, 1)`
    - `"layout": "vertical"` → `(vertical, 1, frames)`
    - `"cols": 4, "rows": 4` → `(grid, 4, 4)`，`layout` 可省略

    为什么 `cols` / `rows` 一出现就**自动**切到网格模式：用户的意图是明确的
    （「一行放 4 个」），让他再写一遍 `"layout": "grid"` 是纯粹的啰嗦。
    但**同时**写 `"layout": "horizontal"` 与 `cols` 是**真矛盾**（一个说单行、
    一个说多列），必须报错而不是挑一个——挑错的那个表现是「我明明设了 4 列，
    它却排成一行」，属于最难查的一类问题（与 §2.5 的教训一致）。

    `frames > cols*rows` 同样报错：帧放不下，作者一定算错了。
    反过来 `frames < cols*rows` 是**合法**的（网格装不满，空格透明）——
    那是用户明确要求的「避免没有填满的情况」。
    """
    has_grid_fields = 'cols' in raw_value or 'rows' in raw_value
    raw_layout = raw_value.get('layout')

    if raw_layout is None or (isinstance(raw_layout, str) and not raw_layout.strip()):
        name = LAYOUT_GRID if has_grid_fields else LAYOUT_HORIZONTAL
    elif not isinstance(raw_layout, str):
        raise _field_error(
            f'{where}.layout', '应为字符串',
            hint='排布写 "horizontal"（单行，默认）、"vertical"（单列）或 "grid"（网格）。',
        )
    else:
        name = raw_layout.strip().lower()
        if name not in LAYOUTS:
            allowed = ' / '.join(f'"{item}"' for item in LAYOUTS)
            raise _field_error(
                f'{where}.layout', f'应为 {allowed}',
                hint='单行排布用 "horizontal"（默认），单列用 "vertical"，'
                     '多行网格用 "grid"（或直接写 cols / rows）。',
            )

    if name == LAYOUT_ANIMATED:
        return _parse_animated_layout(raw_value, where=where, frames=frames)

    if name in (LAYOUT_HORIZONTAL, LAYOUT_VERTICAL) and has_grid_fields:
        # `layout` 与 `cols` / `rows` 同时出现时**先看是否一致**：
        # 一致就是合法的冗余写法（`to_dict()` 的输出、工具生成的包都会长这样），
        # 不一致才是真矛盾（一个说单行、一个说多列），必须报错。
        #
        # 为什么不能一律报错：`layout: "horizontal"` + `cols: 4` 在
        # 「4 帧单行」这个情形下**完全正确**，把它判成错误会让
        # 「导出再导入」直接失败——那是自己造出来的 bug。
        declared_cols = _read_positive_int(
            raw_value, 'cols', 0, low=0, high=MAX_FRAMES, where=f'{where}.cols',
        )
        declared_rows = _read_positive_int(
            raw_value, 'rows', 0, low=0, high=MAX_FRAMES, where=f'{where}.rows',
        )
        expected_cols, expected_rows = frame_grid(name, frames)
        mismatch = (
            (declared_cols and declared_cols != expected_cols)
            or (declared_rows and declared_rows != expected_rows)
        )
        if mismatch:
            actual = f'{declared_cols or expected_cols}×{declared_rows or expected_rows}'
            raise _field_error(
                f'{where}.cols',
                f'与 layout "{name}" 冲突（{name} 是 '
                f'{expected_cols}×{expected_rows}，声明的是 {actual}）',
                hint=f'"{name}" 已经决定了网格形状（'
                     + ('一帧一行' if name == LAYOUT_HORIZONTAL else '一帧一列')
                     + '），不能再写别的 cols / rows。'
                     '想自己决定行列，就把 layout 去掉（或写成 "grid"）只留 cols / rows。',
            )
        return name, expected_cols, expected_rows

    if name != LAYOUT_GRID:
        cols, rows = frame_grid(name, frames)
        return name, cols, rows

    # ---- 网格模式：两个方向都读，缺的按「装得下」补 ----
    cols = _read_positive_int(
        raw_value, 'cols', 0, low=0, high=MAX_FRAMES, where=f'{where}.cols',
    )
    rows = _read_positive_int(
        raw_value, 'rows', 0, low=0, high=MAX_FRAMES, where=f'{where}.rows',
    )
    if not cols and not rows:
        raise _field_error(
            f'{where}.cols', '网格排布至少要给出 cols 或 rows',
            hint='例如 {"layout": "grid", "cols": 4, "rows": 4}：'
                 '一行 4 帧、共 4 行。只给一个方向时另一个会按「装得下」自动补。',
        )

    grid_cols, grid_rows = frame_grid(LAYOUT_GRID, frames, cols, rows)
    capacity = grid_cols * grid_rows
    if capacity < frames:
        raise _field_error(
            f'{where}.rows',
            f'{grid_cols}×{grid_rows} 装不下 {frames} 帧（只有 {capacity} 格）',
            hint=f'{frames} 帧需要至少 {capacity} 个格子。'
                 f'把 cols / rows 调大（例如 rows: {-(-frames // grid_cols)}），'
                 f'或把 frames 改成 {capacity} 以内的值。',
        )
    return LAYOUT_GRID, grid_cols, grid_rows


def _read_motion_number(raw_value, key: str, low: float, high: float, *,
                        where: str, field: str, unit: str = '') -> float:
    """读一个带区间的运动参数，越界**报错**并说明合法范围。

    为什么不让它静默取默认值：作者写了 `amplitude: 0.5`（想「明显一点」）
    而插件悄悄按 0.08 处理，他只会看到「我调了没反应」——
    而这类问题最难查。报错并给出区间，他一眼就知道该怎么改。
    """
    if key not in raw_value:
        raise _field_error(
            f'{where}.{field}.{key}', '缺少这个参数',
            hint=f'{field} 需要 {key}（{unit or "数值"}，合法范围 {low} ~ {high}）。',
        )
    raw = raw_value.get(key)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise _field_error(
            f'{where}.{field}.{key}', f'需要数字，实际是 {type(raw).__name__}',
            hint=f'例如 {key}: {(low + high) / 2:g}。',
        )
    value = float(raw)
    if not (low <= value <= high):
        raise _field_error(
            f'{where}.{field}.{key}', f'{value:g} 超出合法范围 {low:g} ~ {high:g}',
            hint=(
                '幅度过大会变成「拉伸」而不是「呼吸」，写实素材的边缘还会被拉糊。'
                if key == 'amplitude' else
                '超出这个区间的数值几乎一定是填错了（单位是毫秒）。'
            ),
        )
    return value


def _read_motion_frames(raw_value, *, where: str, field: str, frames: int) -> list:
    """读眨眼的帧号列表，并校验**每一帧都真的存在**。

    不校验的后果：作者写了 `frames: [4, 5]` 而这条动画只有 4 帧（0..3），
    前端跳到不存在的帧 → 背景位移落到 sheet 之外 → 眨眼时宠物**凭空消失**
    一瞬间。这属于「偶发、一闪而过」的故障，最难截图复现。
    """
    raw = raw_value.get('frames')
    if raw is None:
        raise _field_error(
            f'{where}.{field}.frames', '缺少这个参数',
            hint='写这一条 sheet 里用作眨眼的帧号，例如 "frames": [2, 3]。',
        )
    if not isinstance(raw, (list, tuple)) or not raw:
        raise _field_error(
            f'{where}.{field}.frames', '需要非空的帧号数组',
            hint='例如 "frames": [2, 3]。',
        )
    out = []
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, int):
            raise _field_error(
                f'{where}.{field}.frames', f'帧号必须是整数，实际是 {item!r}',
                hint='帧号从 0 开始。',
            )
        if not (0 <= item < frames):
            raise _field_error(
                f'{where}.{field}.frames', f'第 {item} 帧不存在（这条动画只有 {frames} 帧，0..{frames - 1}）',
                hint='眨眼用的是**同一张 sheet** 里的帧，因此帧号必须在 frames 范围内。',
            )
        out.append(item)
    return out


def _parse_motion(raw_value, where: str, *, frames: int, animated: bool) -> 'MotionSpec':
    """解析 `motion` 块。缺失时返回 `None`（表示「不动」）。

    ⚠️ **未知键一律报错**。解析器对动画规格里的未知键是**静默忽略**的
    （历史行为），于是 `"amplitdue": 0.02` 这种拼写错误会静默不生效——
    作者只会看到「我写了呼吸但它不动」，而这正是本项目最想避免的一类问题。
    因此这里对 `motion` 内部的键**逐个白名单校验**。
    """
    if raw_value is None:
        return None
    if not isinstance(raw_value, dict):
        raise _field_error(
            f'{where}.motion', '需要对象',
            hint='例如 "motion": { "breathe": { "amplitude": 0.02, "periodMs": 3200 } }。',
        )

    unknown = sorted(set(raw_value) - set(MOTION_KINDS))
    if unknown:
        raise _field_error(
            f'{where}.motion.{unknown[0]}', '不认识这个运动类型',
            hint=f'目前支持 {"、".join(MOTION_KINDS)}。'
                 f'（这里对未知键报错而不是忽略——拼错了却静默不生效最难查。）',
        )

    spec = MotionSpec()

    breathe = raw_value.get(MOTION_BREATHE)
    if breathe is not None:
        if not isinstance(breathe, dict):
            raise _field_error(f'{where}.motion.breathe', '需要对象',
                               hint='例如 { "amplitude": 0.02, "periodMs": 3200 }。')
        bad = sorted(set(breathe) - {'amplitude', 'periodMs'})
        if bad:
            raise _field_error(
                f'{where}.motion.breathe.{bad[0]}', '不认识这个参数',
                hint='breathe 只接受 amplitude（幅度）与 periodMs（周期，毫秒）。',
            )
        spec.amplitude = _read_motion_number(
            breathe, 'amplitude', *BREATHE_AMPLITUDE_RANGE,
            where=where, field='motion.breathe', unit='缩放比例',
        )
        period = _read_motion_number(
            breathe, 'periodMs', *BREATHE_PERIOD_RANGE,
            where=where, field='motion.breathe', unit='毫秒',
        )
        spec.period_ms = int(round(period))

    blink = raw_value.get(MOTION_BLINK)
    if blink is not None:
        if not isinstance(blink, dict):
            raise _field_error(f'{where}.motion.blink', '需要对象',
                               hint='例如 { "frames": [2, 3], "everyMs": [3000, 7000] }。')
        bad = sorted(set(blink) - {'frames', 'everyMs', 'durationMs'})
        if bad:
            raise _field_error(
                f'{where}.motion.blink.{bad[0]}', '不认识这个参数',
                hint='blink 只接受 frames（用哪几帧）、everyMs（间隔区间）、durationMs（眨多久）。',
            )
        if animated:
            # 动图容器没有「第 n 帧」可跳——整张图是浏览器在播。
            raise _field_error(
                f'{where}.motion.blink', '动图容器不能眨眼',
                hint='动图由浏览器播放，插件无法跳到「第 n 帧」。'
                     '要眨眼请改用帧序列（spritesheet）。',
            )
        spec.blink_frames = _read_motion_frames(blink, where=where, field='motion.blink', frames=frames)
        every = blink.get('everyMs')
        if (not isinstance(every, (list, tuple)) or len(every) != 2
                or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in every)):
            raise _field_error(
                f'{where}.motion.blink.everyMs', '需要 [最短, 最长] 两个毫秒数',
                hint='例如 "everyMs": [3000, 7000]。',
            )
        low, high = float(every[0]), float(every[1])
        if low > high:
            raise _field_error(
                f'{where}.motion.blink.everyMs', f'最短间隔（{low:g}）大于最长间隔（{high:g}）',
                hint='写成 [最短, 最长]，例如 [3000, 7000]。',
            )
        for value in (low, high):
            if not (BLINK_INTERVAL_RANGE[0] <= value <= BLINK_INTERVAL_RANGE[1]):
                raise _field_error(
                    f'{where}.motion.blink.everyMs',
                    f'{value:g} 超出合法范围 {BLINK_INTERVAL_RANGE[0]} ~ {BLINK_INTERVAL_RANGE[1]}',
                    hint='间隔是毫秒；比 300ms 更密就是「抽搐」，比 60s 更疏等于不眨。',
                )
        spec.blink_every_ms = [int(round(low)), int(round(high))]
        spec.blink_duration_ms = int(round(_read_motion_number(
            blink, 'durationMs', *BLINK_DURATION_RANGE,
            where=where, field='motion.blink', unit='毫秒',
        )))

    return spec if spec.enabled else None


def _parse_animated_layout(raw_value: dict, *, where: str, frames: int) -> tuple:
    """校验**动图容器**的声明，返回 `(LAYOUT_ANIMATED, 1, 1)`。

    容器路线不切帧，因此所有「切帧」相关的字段都**没有意义**。
    写它们必须报错，而不是静默忽略——静默的后果是作者以为 `frameMs`
    生效了，于是反复调数字却看不出任何变化（最难查的一类问题）。

    规则：

    - `frames` 必须是 1（默认就是 1，所以正常写法里根本不会出现它）；
    - `fps` / `frameMs` / `cols` / `rows` / `loop` 一律不许出现。

    为什么 `loop` 也不许：动图的循环次数**写在文件自己的元数据里**
    （GIF 的 Netscape 扩展、WebP 的 ANIM 块），插件改不了它。
    接受一个做不到的声明比拒绝它更糟。
    """
    if frames != 1:
        raise _field_error(
            f'{where}.frames', f'动图容器不需要 frames（实际写了 {frames}）',
            hint='动图由浏览器自行播放，插件不切帧。把 frames 删掉即可；'
                 '想逐帧控制（每帧时长、定位某一帧、分页省显存）'
                 '请改用帧序列：把动画拼成 spritesheet，用 '
                 '"layout": "horizontal" / "vertical" / "grid"。',
        )
    written = [key for key in ANIMATED_FORBIDDEN_FIELDS if key in raw_value]
    if written:
        raise _field_error(
            f'{where}.{written[0]}', '动图容器不支持这个字段',
            hint=f'动图由浏览器自行播放，插件不切帧，因此 '
                 f'{"、".join(written)} 都没有意义。把它们删掉即可。'
                 '想逐帧控制请改用帧序列（spritesheet）。',
        )
    return LAYOUT_ANIMATED, 1, 1


def _parse_variant_size(raw, where: str) -> dict:
    """解析某一套动画自己的单帧尺寸（可选字段）。

    返回值：`None` 表示「没声明，沿用包级 `size`」；否则是 `{'w': int, 'h': int}`。

    为什么要单独写一个解析器而不是复用 `_parse_mapping`：那个函数是给**包级**
    `size` 用的，它把缺省值当默认，而这里的语义是「没写就是没有」——
    必须能区分「作者没声明」和「作者声明了和包级一样的值」，否则
    `to_dict()` 会凭空给每个包都补上一个 `size` 字段。

    ⚠️ 这里的是**逻辑显示尺寸**，不是源图的像素尺寸。既有形象的做法是
    源图 1024×1536 配逻辑 384×576（密度 8/3）。作者若直接写源图像素尺寸，
    多数情况会撞上 1024 的上限——因此上限报错里明确点出这个区别。
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise _field_error(
            f'{where}.size', '应为对象',
            hint='写成 {"w": 627, "h": 353} 这种形式。',
        )

    # 自己校验两个方向的取值，而不是复用 `_parse_mapping`：
    # 那个函数报错时用的是裸键名（`w`），看不出「这是动作级 size」，
    # 更没法附上「逻辑尺寸 vs 源图像素尺寸」这条最关键的提示。
    result = {}
    for key, default in (('w', DEFAULT_SIZE['w']), ('h', DEFAULT_SIZE['h'])):
        value = raw.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise _field_error(
                f'{where}.size.{key}', '应为数字',
                hint=f'把 {key} 写成一个数字，例如 {{"w": 627, "h": 353}}。',
            )
        number = float(value)
        if not (_MIN_FRAME_SIZE <= number <= _MAX_FRAME_SIZE):
            raise _field_error(
                f'{where}.size.{key}',
                f'应在 {_MIN_FRAME_SIZE} ~ {_MAX_FRAME_SIZE} 之间，实际为 {value}',
                hint=f'这里填的是**逻辑显示尺寸**，不是源图像素尺寸。'
                     f'既有形象的做法是源图 1024px 配逻辑 384px（密度 8/3），'
                     f'请照此换算：源 1672px 宽 → 填 {round(1672 * 3 / 8)}。'
                     f'上限为 {_MAX_FRAME_SIZE}。',
            )
        result[key] = int(round(number))
    return result


def _parse_animation(action: str, raw_value, *, allow_source_jpeg: bool = False) -> AnimationSpec:
    """解析单个动作声明。

    接受三种写法（前两种是「单帧图最省事」与「多套动画」的落点）：

    - 字符串：`"idle": "idle.png"` —— 单帧、默认帧率；
    - 对象：`"idle": {"sheet": "idle.png", "frames": 4, "fps": 6}`；
    - 多套动画：`"click": {"variants": [{"sheet": "a.png"}, {"sheet": "b.png"}]}`
      —— 每次触发按 `weight` **随机选一套**。

    多套动画里**不允许**在对象顶层再写 `sheet` 等字段：那会引出
    「顶层的是不是也算一套」这种含糊语义（实测最容易出现的误用），
    因此直接给出可读错误，而不是猜。
    """
    if isinstance(raw_value, str):
        raw_value = {'sheet': raw_value}

    if not isinstance(raw_value, dict):
        raise _field_error(
            f'animations.{action}', '应为对象或字符串',
            hint=f'写成 {{"sheet": "xxx.png", "frames": 4}} 或直接写 "xxx.png"。',
        )

    where = f'animations.{action}'
    spec = AnimationSpec()

    # 节奏字段已上移到顶层 `schedule`：老写法**显式报错**而不是静默忽略。
    #
    # 插件未发布，因此不必兼容读取；但「静默忽略」是最坏的选择——
    # 作者按 `animations.idle.intervalMs` 设了间隔，包能读、宠物也能跑，
    # 只是那个间隔永远不生效，他会一直以为是引擎的 bug。
    legacy = sorted(key for key in _LEGACY_SCHEDULE_KEYS if key in raw_value)
    if legacy:
        raise _field_error(
            f'{where}.{legacy[0]}',
            '节奏字段已移到顶层的 schedule 里',
            hint='把 "trigger" / "intervalMs" / "plays" 从动作里拿出来，'
                 '写成 {"schedule": {"idle": {"intervalMs": [6000, 18000]}}}。'
                 '这样自动漫游（roam）也能一起设。',
        )

    raw_variants = raw_value.get('variants')
    if raw_variants is None:
        # ---- 单套写法（绝大多数包）----
        spec.variants = [
            _parse_variant(
                action, raw_value, where=where,
                allow_source_jpeg=allow_source_jpeg,
            ),
        ]
    else:
        if not isinstance(raw_variants, list) or not raw_variants:
            raise _field_error(
                f'{where}.variants', '应为非空数组',
                hint='variants 里每一套动画写一个对象，例如 '
                     '[{"sheet": "a.png", "weight": 5}, {"sheet": "b.png", "weight": 3}]。',
            )
        if len(raw_variants) > MAX_VARIANTS:
            raise _field_error(
                f'{where}.variants', f'最多 {MAX_VARIANTS} 套，实际 {len(raw_variants)}',
                hint=f'一个动作最多挂 {MAX_VARIANTS} 套动画。',
            )
        # 顶层不该再混写单套字段（见 docstring）
        stray = sorted(
            key for key in (
                'sheet', 'sheets', 'frames', 'fps', 'loop', 'layout', 'cols', 'rows',
                'frameMs', 'size',
            )
            if key in raw_value
        )
        if stray:
            raise _field_error(
                f'{where}.variants',
                f'与顶层字段 {"、".join(stray)} 混用',
                hint='写了 variants 之后，sheet / frames / fps / layout 等要写进每一套里，'
                     '不要在顶层再写一份。',
            )
        parsed = []
        for index, item in enumerate(raw_variants):
            if isinstance(item, str):
                item = {'sheet': item}
            if not isinstance(item, dict):
                raise _field_error(
                    f'{where}.variants[{index}]', '应为对象或字符串',
                    hint='每一套动画写成 {"sheet": "a.png", "weight": 5}。',
                )
            parsed.append(_parse_variant(
                action, item, where=f'{where}.variants[{index}]',
                allow_source_jpeg=allow_source_jpeg, with_weight=True,
            ))
        spec.variants = parsed

    # 时间驱动的节奏**不在这里**读：它上移到顶层的 `schedule` 块了
    # （`roam` 不是动作，挂不到 `animations` 下面）。若包在动作里写了这些字段，
    # 下面的 `stray` 检查会把它当未知字段忽略——为了不让作者以为生效了，
    # `from_dict` 对动作里的这几个键**显式报错**（见 `_LEGACY_SCHEDULE_KEYS`）。
    return spec


#: 曾经写在 `animations.idle` 里的节奏字段，现在上移到顶层 `schedule`。
#:
#: 插件未发布，因此**不做兼容读取**，而是给出可读的迁移提示：
#: 静默忽略的后果是「作者按老写法设了间隔，却永远不生效」。
_LEGACY_SCHEDULE_KEYS = ('trigger', 'idleTrigger', 'intervalMs', 'plays')


def _parse_mapping(raw, key: str, defaults: dict, *, low_map, high_map) -> dict:
    """解析 `size` / `anchor` / `physics` 这类「固定键的数字对象」。"""
    if raw is None:
        return dict(defaults)
    if not isinstance(raw, dict):
        raise _field_error(key, '应为对象', hint=f'写成 {{"a": 1, "b": 2}} 这种形式。')

    result = dict(defaults)
    for name, default in defaults.items():
        result[name] = _read_number(
            raw, name, default, low=low_map[name], high=high_map[name],
        )
    # physics 的数值不需要小数（但保留浮点也无害），这里统一成数值类型
    return result


def from_dict(raw: dict, *, pack_id: str = '', allow_source_jpeg: bool = False) -> PetPack:
    """把已解析的 JSON dict 转成 `PetPack`（含完整校验）。

    Args:
        raw: 已解析的 JSON 对象。
        pack_id: 包内没有 `id` 时的回落值。
        allow_source_jpeg: 导入期放行 `.jpg`/`.jpeg` 等需要转码的扩展名。
            **运行期必须保持 False**——落盘后的包一定是宿主能直接吃的格式。

    Raises:
        PetError: 字段类型/范围错误，或连 `idle` 都没有。
    """
    if not isinstance(raw, dict):
        raise PetError(
            CODE_PACK_FIELD_INVALID,
            '宠物包根节点应为对象',
            user_msg='宠物包的根结构不对，应该是一个 JSON 对象。',
            hint='pet.json 最外层要用 { } 包起来。',
        )

    pack = PetPack()

    # ---- 格式版本（向前兼容：更高的版本号不拒绝，只记录）----
    raw_format = raw.get('format', FORMAT_VERSION)
    if isinstance(raw_format, bool) or not isinstance(raw_format, int):
        raise _field_error('format', '应为整数', hint=f'写 {FORMAT_VERSION} 即可。')
    pack.format = int(raw_format)

    pack.id = _read_string(raw, 'id', pack_id) or pack_id
    pack.name = _read_string(raw, 'name', '') or pack.id or '宠物'
    pack.author = _read_string(raw, 'author', '')

    # ---- 尺寸与锚点 ----
    pack.size = _parse_mapping(
        raw.get('size'), 'size',
        {'w': DEFAULT_SIZE['w'], 'h': DEFAULT_SIZE['h']},
        low_map={'w': _MIN_FRAME_SIZE, 'h': _MIN_FRAME_SIZE},
        high_map={'w': _MAX_FRAME_SIZE, 'h': _MAX_FRAME_SIZE},
    )
    pack.size = {'w': int(round(pack.size['w'])), 'h': int(round(pack.size['h']))}

    pack.anchor = _parse_mapping(
        raw.get('anchor'), 'anchor',
        {'x': DEFAULT_ANCHOR['x'], 'y': DEFAULT_ANCHOR['y']},
        low_map={'x': 0.0, 'y': 0.0},
        high_map={'x': 1.0, 'y': 1.0},
    )

    # ---- 形象自带的大小倍率（可选；老包没有这个字段就是 1.0）----
    pack.scale = _read_number(
        raw, 'scale', DEFAULT_SCALE,
        low=SCALE_RANGE[0], high=SCALE_RANGE[1],
    )

    # ---- 渲染方式（可选；缺省 = 平滑插值）----
    pack.pixelated = _read_bool(raw, 'pixelated', DEFAULT_PIXELATED)

    # ---- 形象建议的动画速度倍率（可选；缺省 1.0 = 按包内 fps 原速）----
    #
    # 为什么让**包**能声明它：`fps` 是「这套动画的节奏」，而倍率是
    # 「整体快慢」。同一份素材在不同用途下想要的快慢不同——100 帧的平滑
    # 循环按原速播可能太赶，4 帧的像素猫按原速播又可能太慢。
    # 作者最清楚自己的素材该多快，因此允许声明；用户在面板上还能覆盖。
    pack.anim_speed = _read_number(
        raw, 'animSpeed', DEFAULT_ANIM_SPEED,
        low=ANIM_SPEED_RANGE[0], high=ANIM_SPEED_RANGE[1],
    )

    # ---- 这个形象是否参与自动漫游（可选；缺省 true）----
    #
    # 允许关掉的理由：不是每个形象都「会走」——坐着的猫、躺着的玩偶
    # 自己溜达起来很出戏。作者可以声明 `"autoRoam": false` 表示
    # 「我这个形象不适合漫游」；用户在面板上还能按形象覆盖。
    pack.auto_roam = _read_bool(raw, 'autoRoam', DEFAULT_AUTO_ROAM)

    # ---- 物理 ----
    pack.physics = _parse_mapping(
        raw.get('physics'), 'physics', DEFAULT_PHYSICS,
        low_map={key: bounds[0] for key, bounds in _PHYSICS_RANGES.items()},
        high_map={key: bounds[1] for key, bounds in _PHYSICS_RANGES.items()},
    )

    # ---- 动作 ----
    raw_animations = raw.get('animations')
    if raw_animations is None:
        raw_animations = {}
    if not isinstance(raw_animations, dict):
        raise _field_error(
            'animations', '应为对象',
            hint='写成 {"idle": {"sheet": "idle.png", "frames": 4, "fps": 6}}。',
        )

    animations = {}
    for action, value in raw_animations.items():
        name = str(action or '').strip()
        if not name:
            continue
        if name == STILL_ACTION:
            raise _field_error(
                f'animations.{name}',
                f'「{name}」是保留名（标准图像不是动作）',
                hint='标准图像写在顶层的 "still" 字段里，'
                     '不要把它当成一个动作放进 animations。',
            )
        animations[name] = _parse_animation(
            name, value, allow_source_jpeg=allow_source_jpeg,
        )
    pack.animations = animations

    # ---- 唯一的硬错误：连 idle 都没有 ----
    if not animations:
        raise PetError(
            CODE_PACK_ANIMATION_MISSING,
            '宠物包没有声明任何动作',
            user_msg='这个宠物包里一张图都没有，无法使用。',
            hint='至少提供一个 idle 动作，例如 {"animations": {"idle": "idle.png"}}。',
        )
    if 'idle' not in animations:
        available = '、'.join(sorted(animations)) or '（无）'
        raise PetError(
            CODE_PACK_IDLE_MISSING,
            '宠物包缺少 idle 动作',
            user_msg=f'这个宠物包缺少最基本的「idle」动作（当前只有：{available}）。',
            hint='idle 是唯一必须提供的动作：其它动作缺失都会回退到它，'
                 '所以没有它就无法显示。请把其中一张图声明为 "idle"。',
        )

    # ---- 标准图像（不播动画时显示的那一帧；可选）----
    pack.still = _parse_still(raw.get('still'), allow_source_jpeg=allow_source_jpeg)

    # ---- 时间驱动行为的节奏（可选；缺的项由调用方补默认值）----
    pack.schedules = _parse_schedule(raw.get('schedule'))

    # ---- 向前兼容：记录被忽略的未知顶层字段 ----
    known = {
        'format', 'id', 'name', 'author', 'size', 'anchor', 'scale', 'pixelated',
        'physics', 'animations', 'still', 'schedule', 'animSpeed', 'autoRoam',
    }
    pack.ignored_fields = sorted(str(key) for key in raw.keys() if key not in known)

    return pack


def loads(text, *, pack_id: str = '', allow_source_jpeg: bool = False) -> PetPack:
    """从 JSON 文本解析（`json.loads` 包在 try/except 里，§3.4 第 5 条）。"""
    if isinstance(text, bytes):
        try:
            text = text.decode('utf-8-sig')
        except UnicodeDecodeError as exc:
            raise PetError(
                CODE_PACK_JSON_INVALID,
                f'宠物包不是合法的 UTF-8 文本: {exc}',
                user_msg='宠物包的文件编码不是 UTF-8，无法读取。',
                hint='pet.json 请用 UTF-8 编码保存。',
            ) from exc

    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise PetError(
            CODE_PACK_JSON_INVALID,
            f'JSON 解析失败: {exc}',
            user_msg='宠物包的 pet.json 不是合法的 JSON，无法读取。',
            hint='常见原因：多了/少了逗号、用了单引号、中文引号，或文件被截断。',
            detail={'reason': str(exc)},
        ) from exc

    return from_dict(raw, pack_id=pack_id, allow_source_jpeg=allow_source_jpeg)


def load_file(path: str, *, pack_id: str = '') -> PetPack:
    """从文件解析；读不到时给出可读错误（不暴露堆栈）。"""
    try:
        with open(path, 'rb') as handle:
            raw = handle.read()
    except FileNotFoundError as exc:
        raise PetError(
            CODE_PACK_UNREADABLE,
            f'宠物包清单不存在: {path}',
            user_msg='这个宠物包里找不到 pet.json。',
            hint='包根目录下需要有 pet.json。',
            http_status=404,
        ) from exc
    except OSError as exc:
        raise PetError(
            CODE_PACK_UNREADABLE,
            f'宠物包清单读取失败: {exc}',
            user_msg='宠物包的 pet.json 读不出来，可能没有访问权限。',
            http_status=500,
        ) from exc

    # 读成 bytes 再交给 `loads` 解码：`UnicodeDecodeError` 是 ValueError 的子类，
    # 不会被上面的 `except OSError` 接住；在这里解码能让「编码不对」也走
    # 同一条可读错误路径（真实浏览器/真实文件都踩过）。
    return loads(raw, pack_id=pack_id or os.path.basename(os.path.dirname(path)))
