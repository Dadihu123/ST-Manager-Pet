"""宠物包格式与**动作回退链**（插件侧领域模型，宿主完全不解析）。

设计目标（实施提示词 §3.1）
--------------------------
1. **任何一张单帧图都能跑起来**——缺失的动作沿回退链下溯，最终一定落到 `idle`。
2. 用户能导入自己的形象，能覆盖单个动作的图。
3. 格式**向前兼容**：多出来的字段忽略而不是报错。

「必要动作」的真正含义
----------------------
`idle` / `walk` / `drag` / `fall` 被标为「必要」，但**不是**「不给就报错」，
而是**「不给就退化为静态位移」**：没有 `walk` 的 sheet 时，宠物照常移动位置，
只是不播帧。因此解析器对缺动作给出的是 `kind='static'` 的**降级结果**，
只有「连 `idle` 都没有」才是错误（`pack_animation_idle_missing`）。
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
#: 「原地踏步 + 平移」。因此允许形象提供左右两套侧视行走图。
#:
#: 只提供一侧时，另一侧**镜像**复用（见 `ResolvedAction.mirror`），
#: 对称的形象（例如默认小猫）因此不必画两套。
#: 但**左右不对称**的形象（例如「小满」的发夹只在单侧）必须自己画两套，
#: 否则镜像会把发夹翻到另一边——这不是引擎能替作者决定的事。
WALK_DIRECTION_ACTIONS = {
    'walk-left': 'walk-right',
    'walk-right': 'walk-left',
}

#: 动作词表与「省略时的回退链」（§3.3，照抄为契约）。
#: `idle` 是唯一硬必要动作；其余缺失时沿链下溯，最终一定落到 `idle`。
ACTION_FALLBACKS = {
    'idle': (),
    'walk': ('idle',),
    'walk-left': ('walk', 'idle'),
    'walk-right': ('walk', 'idle'),
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
class AnimationSpec:
    """单个动作的原始声明（已经过类型与范围校验）。"""

    sheet: str = ''
    frames: int = 1
    fps: int = 8
    loop: bool = True
    layout: str = 'horizontal'

    def to_dict(self) -> dict:
        return {
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
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
    fps: int = 0
    loop: bool = True
    layout: str = 'horizontal'
    #: 是否要把 `sheet` **水平镜像**后再播（方向化行走只提供一侧时为 True）。
    #: 前端据此决定 `transform: scaleX(-1)`——注意这**不同于**「按朝向翻转」：
    #: 方向化贴图本身已经画好了朝向，翻转只由这个标记决定。
    mirror: bool = False
    #: 尝试过的动作序列（含起点），用于向用户解释「为什么看起来是这样」。
    chain: list = field(default_factory=list)
    #: 面向用户的一句话解释。
    note: str = ''

    def to_dict(self) -> dict:
        return {
            'action': self.action,
            'source': self.source,
            'kind': self.kind,
            'sheet': self.sheet,
            'frames': self.frames,
            'fps': self.fps,
            'loop': self.loop,
            'layout': self.layout,
            'mirror': self.mirror,
            'chain': list(self.chain),
            'note': self.note,
        }


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
        镜像之后才轮到正面 `walk`，最后是 `idle`。
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
            if spec.sheet:
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
                return ResolvedAction(
                    action=action, source=candidate, kind=KIND_ANIMATED,
                    sheet=spec.sheet, frames=spec.frames, fps=spec.fps,
                    loop=spec.loop, layout=spec.layout,
                    mirror=mirrored,
                    chain=chain, note=note,
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

    def missing_required(self) -> list:
        """缺失的「必要动作」列表（**不是错误**，但要告诉用户会怎么降级）。

        `walk` 的特例：提供了**任一侧**方向化行走（`walk-left` / `walk-right`）
        就算满足——另一侧会自动镜像，正面 `walk` 已不再是必需。
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


def _parse_animation(action: str, raw_value, *, allow_source_jpeg: bool = False) -> AnimationSpec:
    """解析单个动作声明。

    接受两种写法（都能让「单帧图」用起来最省事）：
    - 字符串：`"idle": "idle.png"` —— 单帧、默认 fps；
    - 对象：`"idle": {"sheet": "idle.png", "frames": 4, "fps": 6}`。
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

    raw_sheet = raw_value.get('sheet', '')
    if raw_sheet is None:
        raw_sheet = ''
    if not isinstance(raw_sheet, str):
        raise _field_error(f'{where}.sheet', '应为字符串', hint='sheet 写文件名文本。')
    # sheet 可以为空：表示「该动作存在但只位移不播帧」（回退链的降级语义）
    spec.sheet = (
        _validate_sheet_path(raw_sheet, where=action, allow_source_jpeg=allow_source_jpeg)
        if raw_sheet.strip() else ''
    )

    default_frames = 1 if not spec.sheet else 1
    spec.frames = _read_positive_int(raw_value, 'frames', default_frames, low=1, high=MAX_FRAMES)
    spec.fps = _read_positive_int(raw_value, 'fps', 8, low=1, high=MAX_FPS)
    spec.loop = _read_bool(raw_value, 'loop', action not in ONE_SHOT_ACTIONS)

    layout = raw_value.get('layout', 'horizontal')
    if not isinstance(layout, str) or layout.strip().lower() not in ('horizontal', 'vertical'):
        raise _field_error(
            f'{where}.layout', '应为 "horizontal" 或 "vertical"',
            hint='水平排布用 "horizontal"（默认），垂直排布用 "vertical"。',
        )
    spec.layout = layout.strip().lower()
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
