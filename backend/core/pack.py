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
MAX_FRAMES = 256
DEFAULT_MAX_SHEET_PIXELS = 4096
MAX_FPS = 60

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
#: 「时间驱动」指的是**没有外部事件**、靠时间自己发生的动作。只有两个：
#:
#: - `idle`：闲着的时候偶尔动一下（默认 6~18 秒一次）；
#: - `roam`：闲着的时候自己在屏幕底部走一走（默认 3~9 秒一次）。
#:
#: 其余动作都是**事件驱动**的（`click` 要有人点、`fall` 要松手、
#: `happy` 要有播报…），给它们设「多久触发一次」没有意义，
#: 因此 `schedule` 里**只认这两个键**——多写的键会被明确拒绝，
#: 而不是静默忽略（作者会以为设了却没生效）。
SCHEDULE_BEHAVIORS = ('idle', 'roam')

#: 每个时间驱动行为**支持哪些字段**。
#:
#: 不支持某个字段时**写它就是错误**，而不是静默忽略——
#: 「我明明设了却没生效」是最难查的一类问题（与 §2.5 的教训一致）。
#:
#: `roam` 没有 `plays` / `mode`：它的持续时长由物理决定（走到目标点就停），
#: 不是「播几轮动画」。
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
}

#: 行为的**人类可读名**（报错信息与面板共用一份，避免两边叫法不一致）。
BEHAVIOR_LABELS = {
    'idle': '待机小动作',
    'roam': '自动漫游',
}

#: 每个时间驱动行为的默认间隔区间（毫秒）。
#:
#: `roam` 的默认值就是历史行为（`3000 + random * 6000`）——
#: 把它变成可配置项时**不改动默认观感**，否则用户会莫名其妙地觉得
#: 「宠物怎么突然走得频繁了」。
DEFAULT_SCHEDULE_MS = {
    'idle': (6000, 18000),
    'roam': (3000, 9000),
}

#: 间隔的合法区间（毫秒）。下限 200ms 拦住「每帧都在动」，
#: 上限 1 小时拦住「填错了位数」。
MIN_SCHEDULE_MS = 200
MAX_SCHEDULE_MS = 3600 * 1000
#: 轮数上限（拦「填错了」的极端值）。
MAX_IDLE_PLAYS = 20

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
class AnimationVariant:
    """**一套**动画（一个动作可以有多套，按 `weight` 随机选一套播）。

    为什么一个动作要能有多套：这是「丰富动画数量」的最低成本做法——
    同一件事（例如「被点击」）画两三个不同的反应，随机播其中之一，
    观感立刻不像复读机。作者只要多画几张图，不必让引擎理解「语义」。
    """

    sheet: str = ''
    frames: int = 1
    #: 帧率。**允许小数**（见 `MIN_FPS`）——帧数少时整数档太粗。
    fps: float = 8
    loop: bool = True
    layout: str = 'horizontal'
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

    @property
    def total_ms(self) -> float:
        """播完一轮的毫秒数（非均匀时长下是逐帧之和）。"""
        if self.frame_ms:
            return float(sum(self.frame_ms))
        if self.fps > 0:
            return self.frames * 1000.0 / self.fps
        return 0.0

    @property
    def effective_fps(self) -> float:
        """折算出的平均帧率（供 UI 显示「相当于多少 fps」）。"""
        total = self.total_ms
        if total <= 0:
            return float(self.fps)
        return round(self.frames * 1000.0 / total, 2)

    def to_dict(self) -> dict:
        payload = {
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
            'frameMs': list(self.frame_ms),
            'weight': self.weight,
        }
        # 只在**真的声明了**独立尺寸时才写这个字段：绝大多数包不该多出噪音
        if self.size:
            payload['size'] = dict(self.size)
        return payload


@dataclass
class Trigger:
    """一个**时间驱动行为**的节奏配置（`idle` 的小动作、`roam` 的漫游）。

    为什么它不再是「idle 的触发方式」：用户要求「支持调整不同动作的触发时间」，
    而真正**由时间驱动**的行为只有两个——闲着时偶尔动一下（`idle`）、
    闲着时自己走一走（`roam`）。其余动作都是**事件驱动**的
    （`click` 要有人点、`fall` 要松手、`happy` 要有播报…），
    给它们设「多久触发一次」没有意义，因此解析器对它们明确报错而不是静默忽略。

    `mode` 与 `plays` 只对 `idle` 有意义：

    - `random`（默认）：平时停在标准图像，隔一段随机时间播一遍，播完回静止；
    - `loop`：一直循环待机动画（不做「播一遍就停」）。

    `roam` 的持续时长由物理决定（走到目标点就停），不是「播几轮」，
    所以它**没有** `mode` / `plays`（写了会报错，见 `BEHAVIOR_FIELDS`）。
    """

    mode: str = IDLE_TRIGGER_RANDOM
    min_ms: int = DEFAULT_SCHEDULE_MS['idle'][0]
    max_ms: int = DEFAULT_SCHEDULE_MS['idle'][1]
    #: 一次触发连续播几轮（只有 idle 用得上）。
    plays: int = DEFAULT_IDLE_PLAYS
    #: 这个节奏属于哪个行为（`idle` / `roam`）。
    #:
    #: 序列化时按它决定**写哪些字段**：`roam` 没有 `mode` / `plays`，
    #: 而 `to_dict()` 的输出必须能被 `from_dict()` 原样读回来
    #: （否则 round-trip 断裂，而「导出再导入」正是靠它）。
    behavior: str = 'idle'

    def to_dict(self) -> dict:
        payload = {
            'minIntervalMs': self.min_ms,
            'maxIntervalMs': self.max_ms,
        }
        # 只写这个行为**支持**的字段（见 `BEHAVIOR_FIELDS`）。
        if 'mode' in BEHAVIOR_FIELDS.get(self.behavior, ()):
            payload['mode'] = self.mode
        if 'plays' in BEHAVIOR_FIELDS.get(self.behavior, ()):
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
    """解析后的**一套**动画（图 URL 由 store 层填，这里只有帧参数）。"""

    sheet: str = ''
    frames: int = 1
    fps: float = 8
    loop: bool = True
    layout: str = 'horizontal'
    frame_ms: list = field(default_factory=list)
    weight: float = DEFAULT_WEIGHT
    #: 这一套动画自己的单帧尺寸；`None` 表示沿用包级 `size`（见 `AnimationVariant.size`）。
    size: dict = None

    def to_dict(self) -> dict:
        payload = {
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
            'frameMs': list(self.frame_ms),
            'weight': self.weight,
        }
        if self.size:
            payload['size'] = dict(self.size)
        return payload


@dataclass
class ResolvedAction:
    """请求某个动作时的**解析结果**（含回退信息，供 UI 解释）。"""

    action: str
    #: 最终真正使用的动作名；``''`` 表示连回退链都落空（只有 idle 全缺时可能）。
    source: str = ''
    kind: str = KIND_NONE
    sheet: str = ''
    frames: int = 0
    fps: float = 0
    loop: bool = True
    layout: str = 'horizontal'
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
        payload = {
            'action': self.action,
            'source': self.source,
            'kind': self.kind,
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
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
    layout: str = 'horizontal'
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

    def to_dict(self) -> dict:
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
            playable = [variant for variant in spec.variants if variant.sheet]
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
                return ResolvedAction(
                    action=action, source=candidate, kind=KIND_ANIMATED,
                    sheet=primary.sheet, frames=primary.frames, fps=primary.fps,
                    loop=primary.loop, layout=primary.layout,
                    frame_ms=list(primary.frame_ms),
                    size=dict(primary.size) if primary.size else None,
                    mirror=mirrored,
                    chain=chain, note=note,
                    variants=[
                        ResolvedVariant(
                            sheet=variant.sheet, frames=variant.frames,
                            fps=variant.fps, loop=variant.loop,
                            layout=variant.layout,
                            frame_ms=list(variant.frame_ms),
                            weight=variant.weight,
                            # 每套动画可以各自不同尺寸（横构图 / 竖构图共存），
                            # 前端换套播时几何要跟着换，因此必须逐套透传。
                            size=dict(variant.size) if variant.size else None,
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
        return ResolvedAction(
            action=STILL_ACTION, source=still.source, kind=KIND_ANIMATED,
            sheet=still.sheet, frames=still.frames, fps=1, loop=False,
            layout=still.layout, chain=[STILL_ACTION],
            # 标准图像自己的尺寸（来自它所在的 sheet）要一并透传：
            # `ResolvedAction.size` 是「主变体的尺寸」，而标准图像就是它的主变体。
            size=dict(still.size) if still.size else None,
            variants=[ResolvedVariant(
                sheet=still.sheet, frames=still.frames, fps=1, loop=False,
                layout=still.layout,
                size=dict(still.size) if still.size else None,
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
        if still is not None and still.sheet:
            size = dict(still.size) if still.size else self._size_for_sheet(still.sheet)
            return StillImage(
                sheet=still.sheet,
                frames=max(1, int(still.frames)),
                frame=still.frame,
                layout=still.layout,
                declared=True,
                source=STILL_ACTION,
                size=size,
            )

        # 回落：idle 的主变体首帧
        resolved = self.resolve('idle')
        if resolved.kind == KIND_ANIMATED and resolved.sheet:
            return StillImage(
                sheet=resolved.sheet,
                frames=max(1, int(resolved.frames)),
                frame=0,
                layout=resolved.layout,
                declared=False,
                source=resolved.source or 'idle',
                # ★ 回落路径必须**继承 idle 那条 sheet 的尺寸**：
                # idle 自己声明了 `size` 时（少见但合法），标准图像与它同源，
                # 几何必须一致，否则静止画面与待机动画会互相错位。
                size=dict(resolved.size) if resolved.size else None,
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
                if not variant.sheet or not variant.size:
                    continue
                if to_posix(variant.sheet).strip() == target:
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

    layout = raw_value.get('layout', 'horizontal')
    if not isinstance(layout, str) or layout.strip().lower() not in ('horizontal', 'vertical'):
        raise _field_error(
            'still.layout', '应为 "horizontal" 或 "vertical"',
            hint='水平排布用 "horizontal"（默认），垂直排布用 "vertical"。',
        )
    return StillImage(
        sheet=sheet,
        frames=frames,
        frame=frame,
        layout=layout.strip().lower(),
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

    raw_sheet = raw_value.get('sheet', '')
    if raw_sheet is None:
        raw_sheet = ''
    if not isinstance(raw_sheet, str):
        raise _field_error(f'{where}.sheet', '应为字符串', hint='sheet 写文件名文本。')
    # sheet 可以为空：表示「这套动画存在但只位移不播帧」（回退链的降级语义）
    variant.sheet = (
        _validate_sheet_path(raw_sheet, where=action, allow_source_jpeg=allow_source_jpeg)
        if raw_sheet.strip() else ''
    )

    variant.frames = _read_positive_int(raw_value, 'frames', 1, low=1, high=MAX_FRAMES)
    variant.fps = _read_fps(raw_value, 'fps', 8)
    variant.loop = _read_bool(raw_value, 'loop', action not in ONE_SHOT_ACTIONS)
    variant.frame_ms = _read_frame_ms(raw_value, 'frameMs', variant.frames)

    layout = raw_value.get('layout', 'horizontal')
    if not isinstance(layout, str) or layout.strip().lower() not in ('horizontal', 'vertical'):
        raise _field_error(
            f'{where}.layout', '应为 "horizontal" 或 "vertical"',
            hint='水平排布用 "horizontal"（默认），垂直排布用 "vertical"。',
        )
    variant.layout = layout.strip().lower()

    # 这一套动画**自己的**单帧尺寸（可选）。不写就沿用包级 `size`。
    variant.size = _parse_variant_size(raw_value.get('size'), where)

    if with_weight:
        variant.weight = _read_weight(raw_value, 'weight')
    return variant


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
            key for key in ('sheet', 'frames', 'fps', 'loop', 'layout', 'frameMs', 'size')
            if key in raw_value
        )
        if stray:
            raise _field_error(
                f'{where}.variants',
                f'与顶层字段 {"、".join(stray)} 混用',
                hint='写了 variants 之后，sheet / frames / fps 等要写进每一套里，'
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
        'physics', 'animations', 'still', 'schedule',
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
