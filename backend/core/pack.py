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
#: - `random`（**默认**）：平时停在第一帧（静止画面），每隔一段**随机时间**
#:   播一遍，播完回到静止。这是「成熟做法」：常驻循环的待机动画会让人
#:   觉得宠物在不停抽搐，而静止 + 偶发小动作才像活着。
#: - `loop`：旧行为，待机动画一直循环。
IDLE_TRIGGER_RANDOM = 'random'
IDLE_TRIGGER_LOOP = 'loop'
IDLE_TRIGGER_MODES = (IDLE_TRIGGER_RANDOM, IDLE_TRIGGER_LOOP)

#: 随机触发的默认间隔区间（毫秒）。6~18 秒：偶尔动一下，不烦人。
DEFAULT_IDLE_MIN_MS = 6000
DEFAULT_IDLE_MAX_MS = 18000
#: 一次触发连续播几轮。
DEFAULT_IDLE_PLAYS = 1
#: 间隔与轮数的上限（拦「填错了」的极端值）。
MAX_IDLE_INTERVAL_MS = 3600 * 1000
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
        return {
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
            'frameMs': list(self.frame_ms),
            'weight': self.weight,
        }


@dataclass
class IdleTrigger:
    """idle 动作的**触发方式**（只有 idle 用得上，其余动作由状态机驱动）。

    默认 `random`：平时停在第一帧（静止画面），每隔一段**随机时间**播一遍，
    播完回到静止。这是常驻桌面宠物的成熟做法——一直循环的待机动画会让
    宠物看起来在不停抽搐，而「静止 + 偶发小动作」才像活着。
    """

    mode: str = IDLE_TRIGGER_RANDOM
    min_ms: int = DEFAULT_IDLE_MIN_MS
    max_ms: int = DEFAULT_IDLE_MAX_MS
    #: 一次触发连续播几轮。
    plays: int = DEFAULT_IDLE_PLAYS

    def to_dict(self) -> dict:
        return {
            'mode': self.mode,
            'minIntervalMs': self.min_ms,
            'maxIntervalMs': self.max_ms,
            'plays': self.plays,
        }


@dataclass
class AnimationSpec:
    """单个动作的原始声明（已经过类型与范围校验）。

    内部是**一组** `AnimationVariant`；`sheet` / `frames` / `fps` / `loop` /
    `layout` 这几个属性透传第一套（主变体），这样只写单套动画的包
    在代码里读起来仍和从前一样。
    """

    variants: list = field(default_factory=list)
    #: idle 的触发方式；非 idle 动作上是 `None`（不适用）。
    idle: IdleTrigger = None

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
        """
        payload = {}
        if self.idle is not None:
            trigger = self.idle
            payload['trigger'] = trigger.mode
            payload['intervalMs'] = [trigger.min_ms, trigger.max_ms]
            payload['plays'] = trigger.plays
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

    def to_dict(self) -> dict:
        return {
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
            'frameMs': list(self.frame_ms),
            'weight': self.weight,
        }


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
    #: idle 的触发方式（只有 idle 有；其余动作由状态机驱动）。
    idle_trigger: IdleTrigger = None

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
        if self.idle_trigger is not None:
            payload['idleTrigger'] = self.idle_trigger.to_dict()
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
                    mirror=mirrored,
                    chain=chain, note=note,
                    variants=[
                        ResolvedVariant(
                            sheet=variant.sheet, frames=variant.frames,
                            fps=variant.fps, loop=variant.loop,
                            layout=variant.layout,
                            frame_ms=list(variant.frame_ms),
                            weight=variant.weight,
                        )
                        for variant in variants
                    ],
                    # idle 的触发方式跟着**请求的动作**走，而不是命中回退链的那个：
                    # 请求 `look` 却回退到 idle 时，它仍然是「被状态机驱动的一次播报」，
                    # 不该因为落到了 idle 的图上就变成「随机小动作」。
                    idle_trigger=(
                        (spec.idle or IdleTrigger()) if action == 'idle' else None
                    ),
                )
            # 存在但没 sheet → 只位移不播帧（「必要动作」的降级语义）
            if candidate == 'idle':
                return ResolvedAction(
                    action=action, source=candidate, kind=KIND_STATIC,
                    chain=chain,
                    note='没有可用的帧图，将只移动位置、不播放动画。',
                    idle_trigger=(
                        (spec.idle or IdleTrigger()) if action == 'idle' else None
                    ),
                )

        # 连 idle 都没有：解析阶段已经报错（`from_dict` 会拒绝），
        # 这里只是防空转的兜底。
        return ResolvedAction(
            action=action, kind=KIND_NONE, chain=chain,
            note='没有找到任何可用的动作，宠物将不显示。',
        )

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


def _read_positive_int(raw: dict, key: str, default: int, *, low: int, high: int) -> int:
    value = raw.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        # 容忍 4.0 这种浮点写法，但不接受 4.5
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        else:
            raise _field_error(
                key, '应为整数',
                hint=f'把 {key} 写成整数（例如 {default}）。',
            )
    number = int(value)
    if not (low <= number <= high):
        raise _field_error(
            key, f'应在 {low} ~ {high} 之间，实际为 {value}',
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


def _parse_idle_trigger(raw_value: dict, action: str) -> IdleTrigger:
    """解析 idle 的触发方式（只有 idle 会读它；其它动作忽略这些字段）。"""
    trigger = IdleTrigger()
    raw_mode = raw_value.get('trigger', raw_value.get('idleTrigger', IDLE_TRIGGER_RANDOM))
    if raw_mode is None:
        raw_mode = IDLE_TRIGGER_RANDOM
    if not isinstance(raw_mode, str) or raw_mode.strip().lower() not in IDLE_TRIGGER_MODES:
        allowed = ' / '.join(IDLE_TRIGGER_MODES)
        raise _field_error(
            f'animations.{action}.trigger', f'应为 {allowed}',
            hint=f'trigger 写 "{IDLE_TRIGGER_RANDOM}"（平时静止、偶尔动一下）'
                 f'或 "{IDLE_TRIGGER_LOOP}"（一直循环）。',
        )
    trigger.mode = raw_mode.strip().lower()

    raw_interval = raw_value.get('intervalMs')
    if raw_interval is not None:
        if (not isinstance(raw_interval, list) or len(raw_interval) != 2):
            raise _field_error(
                f'animations.{action}.intervalMs', '应为 [最小毫秒, 最大毫秒]',
                hint='例如 [6000, 18000]：每隔 6~18 秒随机播一次。',
            )
        low = _read_positive_int(
            {'v': raw_interval[0]}, 'v', DEFAULT_IDLE_MIN_MS, low=1,
            high=MAX_IDLE_INTERVAL_MS,
        )
        high = _read_positive_int(
            {'v': raw_interval[1]}, 'v', DEFAULT_IDLE_MAX_MS, low=1,
            high=MAX_IDLE_INTERVAL_MS,
        )
        if high < low:
            # 写反了不算错误——用户意图明确，直接调正比报错友好
            low, high = high, low
        trigger.min_ms, trigger.max_ms = low, high

    raw_plays = raw_value.get('plays')
    if raw_plays is not None:
        trigger.plays = _read_positive_int(
            {'v': raw_plays}, 'v', DEFAULT_IDLE_PLAYS, low=1, high=MAX_IDLE_PLAYS,
        )
    return trigger


def _validate_sheet_path(sheet: str, *, where: str, allow_source_jpeg: bool = False) -> str:
    """校验 sheet 相对路径：不得绝对、不得 `..`、扩展名在白名单内。"""
    text = to_posix(sheet).strip()
    if not text:
        raise PetError(
            CODE_PACK_SHEET_MISSING,
            f'{where} 的 sheet 为空',
            user_msg=f'宠物包里「{where}」的图没有指定文件名。',
            hint='给该项写一个相对路径，例如 "idle.png"。',
        )
    if text.startswith('/') or (len(text) >= 2 and text[1] == ':'):
        raise _field_error(
            f'animations.{where}.sheet', '不允许绝对路径',
            hint='sheet 必须是相对于包目录的路径，例如 "idle.png"。',
        )
    segments = [seg for seg in text.split('/') if seg not in ('', '.')]
    if any(seg == '..' for seg in segments):
        raise _field_error(
            f'animations.{where}.sheet', '不允许包含 ".."',
            hint='sheet 只能指向包目录内部的文件。',
        )
    if not segments or not is_safe_relative_name(segments[-1]):
        raise _field_error(
            f'animations.{where}.sheet', '文件名不合法',
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
            f'animations.{where}.sheet',
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

    if with_weight:
        variant.weight = _read_weight(raw_value, 'weight')
    return variant


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
            key for key in ('sheet', 'frames', 'fps', 'loop', 'layout', 'frameMs')
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

    # idle 的触发方式（只有 idle 读它）
    if action == 'idle':
        spec.idle = _parse_idle_trigger(raw_value, action)
    return spec


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

    # ---- 向前兼容：记录被忽略的未知顶层字段 ----
    known = {
        'format', 'id', 'name', 'author', 'size', 'anchor', 'scale', 'pixelated',
        'physics', 'animations',
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
