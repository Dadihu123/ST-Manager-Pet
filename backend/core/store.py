"""宠物形象的存储层：内置包 + 用户导入包 + 单动作覆盖。

目录布局
--------
随包资源（**只读**，放 `resources/` 而不是 `data/`，见 §2.4）：

    resources/pets/<pet-id>/pet.json + *.png

用户数据（`api.data_dir()`，宿主保证插件更新时保留）：

    data/
    ├─ settings.json                    # 当前形象、动作覆盖记录
    └─ pets/
       └─ <pet-id>/                     # 用户导入 / 自建的包
          ├─ pet.json
          ├─ idle.png
          └─ overrides/<action>.png     # 单动作覆盖（优先级最高）

两层覆盖（§3.2）
----------------
解析某动作该用哪张图时按此优先级取第一个命中的：

    1. `pets/<id>/overrides/<action>.<ext>`   用户对这个动作的单独替换
    2. `pets/<id>/<sheet>`                    用户包内自带
    3. `resources/pets/<id>/<sheet>`          随包默认

内置包**永远不被写入**：用户对内置宠物做覆盖时，只在 `data/` 里落覆盖文件，
这样更新插件不会丢用户改动，也不会污染随包资源。

为什么设置项存在自己的 `settings.json` 而不是宿主 `config_schema`
-----------------------------------------------------------------
`config_schema` 只支持标量（`string`/`integer`/`number`/`boolean`/`enum`，
§2.8），而「当前形象 id + 每个动作的覆盖来源 + 自定义包列表」是结构化数据，
必须自带 UI 与自带存储（§0.1 已明确不做宿主表单支持）。
"""

import io
import json
import logging
import os
import re
import shutil
import threading
import zipfile
from datetime import datetime, timezone

from .errors import (
    CODE_ARCHIVE_INVALID,
    CODE_BUILTIN_NO_EXPORT,
    CODE_BUILTIN_READONLY,
    CODE_DELETE_FAILED,
    CODE_FILE_TOO_LARGE,
    CODE_IMAGE_INVALID,
    CODE_PACK_ANIMATION_MISSING,
    CODE_PACK_IDLE_MISSING,
    CODE_PACK_NOT_FOUND,
    CODE_WRITE_FAILED,
    PetError,
)
from .imports import (
    ALLOWED_IMAGE_FORMATS,
    MAX_PACK_BYTES,
    check_size,
    load_image,
    prepare_sheet,
    process_upload,
    sniff_format,
    write_bytes_atomic,
)
from .pack import (
    ACTION_FALLBACKS,
    ALLOWED_SHEET_EXTENSIONS,
    DEFAULT_SCALE,
    IMPORT_SOURCE_EXTENSIONS,
    KIND_ANIMATED,
    ONE_SHOT_ACTIONS,
    PetPack,
    SCALE_RANGE,
    loads as loads_pack,
)
from .paths import is_action_name, is_safe_relative_name, safe_join, to_posix

logger = logging.getLogger(__name__)

#: 首次安装（设置里还没有 `activePetId`）时默认启用的形象 id。
#:
#: 为什么是「小满」：随包内置的两个真人形象里，小满是**半写实插画**、
#: 小卡是**照片写实**。照片写实是更窄的偏好（有人喜欢、有人觉得桌面站个真人不适），
#: 而插画风是更安全的默认脸；想要照片级的用户到面板里切一下即可。
#: 该形象不存在时（例如被裁掉的定制包）继续回落到列表里第一个可用形象。
DEFAULT_PET_ID = 'xiaoman'

#: 用户包 id 的字符集：小写字母/数字开头，允许 `-` `_` `.`。
PET_ID_PATTERN = re.compile(r'^[a-z0-9][a-z0-9._-]{0,63}$')

SETTINGS_FILENAME = 'settings.json'
PETS_DIRNAME = 'pets'
OVERRIDES_DIRNAME = 'overrides'
MANIFEST_FILENAME = 'pet.json'

#: zip 解压后的总大小上限（防 zip 炸弹；压缩比可以很高）。
MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
#: zip 内条目数量上限。
MAX_ARCHIVE_ENTRIES = 2048

DEFAULT_SETTINGS = {
    # 只放**插件私有**的结构化状态。
    #
    # 标量开关（勿扰、播报…）声明在 manifest 的 `config_schema` 里，
    # 由宿主的插件设置表单渲染、由 `api.get_config()/set_config()` 读写。
    # 两边都存一份会造成「改了宿主表单但插件不生效」这类双写不同步的 bug，
    # 所以这里只留宿主表单表达不了的东西：当前形象 id、逐形象倍率与渲染方式。

    #: 当前形象 id。**空串表示「用户还没选过」**，此时 `active_pet_id()` 会用
    #: `DEFAULT_PET_ID`（首次安装的默认形象）——见该方法。
    'activePetId': '',
    #: 逐形象的**大小倍率**覆盖：`{pet_id: float}`。
    #:
    #: 为什么不能只靠 manifest 里的全局 `scale`：用户明确要求「二次元形象和真人
    #: 形象所需的大小不同」——一个全局倍率意味着换形象就得重调。宿主表单表达不了
    #: 「每个形象一个值」（`config_schema` 只支持标量），所以落在这里。
    #: 优先级见 `effective_scale()`：用户设置 > 包内声明 > 宿主表单默认值。
    'petScales': {},
    #: 逐形象的**像素风渲染**覆盖：`{pet_id: bool}`。
    #:
    #: 与 `petScales` 同样的道理：像素风与写实插画对放大方式的要求**互斥**
    #: （前者要硬边、后者要平滑），包能声明默认值，用户还能按自己屏幕覆盖。
    'petPixelated': {},
}

#: manifest `config_schema` 里的标量键 → 前端运行期配置的键名。
#: 「默认值」在 manifest 里声明一次，这里不重复写死默认值，只做取用。
CONFIG_KEYS = (
    'quiet_mode',
    'announce_cards',
    'announce_jobs',
    'show_toast',
    'auto_roam',
    'scale',
    'sleep_after',
    'anim_speed',
)

#: 倍率区间的**兜底**（权威定义在 `pack.SCALE_RANGE`，这里只是取用）。
SCALE_MIN, SCALE_MAX = SCALE_RANGE

#: 图片在包里的扩展名（与 `pack.ALLOWED_SHEET_EXTENSIONS` 同源）。
#: 这是**落盘后**的严格集合，用于扫描 `overrides/` 之类「一定是最终格式」的目录。
_IMAGE_EXTENSIONS = tuple(sorted(ALLOWED_SHEET_EXTENSIONS))

#: 导入 zip 时额外接受的扩展名（会被 `_store_sheet` 转码成 PNG）。
#: 用户打包自己的图时几乎必然夹带 `.jpg`；直接跳过会让包「少图」却看不出原因。
_IMPORT_EXTENSIONS = tuple(sorted(ALLOWED_SHEET_EXTENSIONS | IMPORT_SOURCE_EXTENSIONS))


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def clamp_scale(value) -> float:
    """把一个倍率夹到合法区间内。

    非法输入（`None` / 字符串 / `NaN`）回落到 `DEFAULT_SCALE`，而不是抛错：
    这个值会被**每个请求**读到（运行期定义里要带上它），为它抛错会让
    「设置文件里有个脏值」变成「整个形象列表打不开」。
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_SCALE
    if number != number:  # NaN
        return DEFAULT_SCALE
    return round(min(max(number, SCALE_MIN), SCALE_MAX), 3)


def sanitize_pet_id(raw, *, fallback: str = 'pet') -> str:
    """把任意字符串整理成一个合法的宠物 id。

    非法字符替换为 `-`；仍不合法时回落到 `fallback`。**不**信任调用方传入的 id ——
    它会被拼进文件路径，所以这里先归一化，再由 `safe_join` 复查。

    关键点：`..` 会被**单独抹掉**（不是替换成 `-`），否则 `'a/../b'` 这种输入会
    变成 `'a-..-b'`——虽然不再是路径穿越（`/` 已经没了），但把 `..` 留在文件名里
    是没必要的隐患，也容易让人误判。这里直接去掉所有 `.` 段。
    """
    text = str(raw or '').strip().lower()
    # 去掉扩展名（用户可能传 "my-cat.zip" / "my-cat.json"）
    for extension in ('.zip', '.json'):
        if text.endswith(extension):
            text = text[: -len(extension)]
    # 先按路径分隔符切开，丢掉空段与 `.` / `..` 段——这样 `../evil` → `evil`，
    # 而不是留下带点的残渣
    segments = [
        segment for segment in text.replace('\\', '/').split('/')
        if segment not in ('', '.', '..')
    ]
    text = '-'.join(segments)
    text = re.sub(r'[^a-z0-9._-]+', '-', text)
    # 清理连续的 `.`（`..`、`...` 都不是合法的 id 片段）
    text = re.sub(r'\.{2,}', '.', text)
    text = re.sub(r'-{2,}', '-', text).strip('-._')
    text = text[:64].strip('-._')
    if not text or not PET_ID_PATTERN.match(text):
        return fallback
    return text


class PetStore:
    """宠物形象的读写入口。

    Args:
        data_dir: `api.data_dir()`（用户数据，插件更新时保留）。
        builtin_dir: 随包资源目录（`resources/pets`），**只读**。
    """

    def __init__(self, data_dir: str, builtin_dir: str):
        self.data_dir = os.path.realpath(str(data_dir))
        self.builtin_dir = os.path.realpath(str(builtin_dir))
        # 导入/删除是「读-改-写」，并发请求会互相踩；一把进程内锁足够
        # （宿主是单进程 Flask，且 data_dir 有跨进程独占锁保护）。
        self._lock = threading.RLock()

    # ------------------------------------------------------------ 路径

    def user_pets_dir(self) -> str:
        return os.path.join(self.data_dir, PETS_DIRNAME)

    def settings_path(self) -> str:
        return os.path.join(self.data_dir, SETTINGS_FILENAME)

    def user_pet_dir(self, pet_id: str) -> str:
        """用户包目录（可能不存在）。"""
        return safe_join(self.data_dir, PETS_DIRNAME, pet_id)

    def builtin_pet_dir(self, pet_id: str) -> str:
        """内置包目录（可能不存在）。"""
        return safe_join(self.builtin_dir, pet_id)

    def _is_user_pet(self, pet_id: str) -> bool:
        """是否存在**用户导入的**包（判定依据是有自己的 pet.json）。

        ⚠️ 不能只判断目录是否存在：用户对**内置**形象做单动作覆盖时，
        会在 `data/pets/<内置 id>/overrides/` 下建文件，那个目录是存在的。
        若按「目录存在」判定，内置形象会被误判成用户包——后果是
        ① 列表里显示「自定义」并给出「删除」按钮（点了也不该删掉内置形象）；
        ② 更糟：它会**遮蔽**同名内置包（`_locate` 用户优先），
           而那个目录里没有 pet.json，等于把一个能用的内置形象变成「不存在」。
        实测在真实浏览器里看到过这个错误（面板显示「自定义 · 删除」）。
        """
        return os.path.isfile(os.path.join(self.user_pet_dir(pet_id), MANIFEST_FILENAME))

    def _is_builtin_pet(self, pet_id: str) -> bool:
        return os.path.isfile(os.path.join(self.builtin_pet_dir(pet_id), MANIFEST_FILENAME))

    def _is_builtin_only(self, pet_id: str) -> bool:
        """这个 id 是否**只能**由内置包提供（即用户没有同 id 的自建包）。

        用户要求「插件自带的宠物不允许修改」。判定必须用「有没有自己的 pet.json」
        而不是「id 在不在内置目录里」——用户完全可能自建一个与内置同 id 的形象
        （`import_zip` 会主动避让内置 id，但手放目录仍可能撞上），
        那种情况下用户那份是**可改**的。

        注意与 `_is_user_pet` 的区别：那个只回答「有没有用户包」，
        在用户包缺失时返回 False，因此不能直接取反（内置形象也返回 False）。
        """
        return self._is_builtin_pet(pet_id) and not self._is_user_pet(pet_id)

    def assert_writable(self, pet_id: str) -> str:
        """确认某形象**可写**；内置形象抛结构化错误。

        所有「改形象」的入口都先过这一关，而不是只在 UI 上藏按钮——
        接口是公开的，UI 藏了不代表改不了。
        """
        pet_id = sanitize_pet_id(pet_id)
        if self._is_builtin_only(pet_id):
            raise PetError(
                CODE_BUILTIN_READONLY,
                f'内置形象不可修改: {pet_id}',
                user_msg='这是插件自带的形象，不能修改。',
                hint='想改的话，先「另存为自建形象」或直接新建一个自己的形象。',
                http_status=403,
            )
        return pet_id

    # ------------------------------------------------------------ 设置

    def get_settings(self) -> dict:
        """读插件自己的设置；文件缺失/损坏时回落到默认值（不抛错）。"""
        settings = dict(DEFAULT_SETTINGS)
        settings['petScales'] = {}
        settings['petPixelated'] = {}
        path = self.settings_path()
        if not os.path.isfile(path):
            return settings
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                stored = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning('读取宠物设置失败，使用默认值: %s', exc)
            return settings
        if isinstance(stored, dict):
            for key, value in stored.items():
                if key in DEFAULT_SETTINGS:
                    settings[key] = value
        # 两个结构化项必须逐条清洗：
        # 手工编辑过 / 旧版本写坏的值不能让整个设置读不出来。
        settings['petScales'] = self._clean_scale_map(settings.get('petScales'))
        settings['petPixelated'] = self._clean_bool_map(settings.get('petPixelated'))
        return settings

    @staticmethod
    def _clean_bool_map(raw) -> dict:
        """把 `{pet_id: bool}` 清洗成「合法 id → 布尔值」。"""
        if not isinstance(raw, dict):
            return {}
        cleaned = {}
        for key, value in raw.items():
            pet_id = sanitize_pet_id(key, fallback='')
            if not pet_id or not isinstance(value, bool):
                continue
            cleaned[pet_id] = value
        return cleaned

    @staticmethod
    def _clean_scale_map(raw) -> dict:
        """把 `{pet_id: 倍率}` 清洗成「合法 id → 夹过的倍率」。"""
        if not isinstance(raw, dict):
            return {}
        cleaned = {}
        for key, value in raw.items():
            pet_id = sanitize_pet_id(key, fallback='')
            if not pet_id:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if number != number:  # NaN
                continue
            cleaned[pet_id] = clamp_scale(number)
        return cleaned

    def update_settings(self, patch: dict) -> dict:
        """浅合并写入设置（未知键忽略；写入失败抛结构化错误）。"""
        if not isinstance(patch, dict):
            raise PetError(CODE_WRITE_FAILED, '设置补丁应为对象', user_msg='设置格式不对。')

        with self._lock:
            settings = self.get_settings()
            for key, value in patch.items():
                if key not in DEFAULT_SETTINGS:
                    continue
                if key == 'petScales':
                    settings[key] = self._clean_scale_map(value)
                elif key == 'petPixelated':
                    settings[key] = self._clean_bool_map(value)
                else:
                    settings[key] = value
            self._write_json(self.settings_path(), settings)
            return settings

    # ------------------------------------------------------------ 倍率

    def effective_scale(self, pet_id: str, *, host_default: float = None) -> float:
        """算出某形象**实际生效**的大小倍率。

        优先级（用户明确要求「不同形象需要的大小不同」）：
        1. **用户设置** `settings.petScales[<id>]` —— 用户在面板上拖的滑块；
        2. **包内声明** `pet.json` 的 `scale` —— 作者认为这个形象适合多大；
        3. **宿主表单默认值** `host_default`（manifest 的 `scale`）—— 全局兜底。

        Args:
            pet_id: 形象 id。
            host_default: 宿主 `config_schema` 里的 `scale` 值；`None` 时用
                `DEFAULT_SCALE`。**由调用方传入**是因为标量配置的唯一来源是宿主，
                store 不该自己去读（它没有 api）。

        Returns:
            float: 夹在 `SCALE_RANGE` 内的倍率。
        """
        pet_id = sanitize_pet_id(pet_id)
        stored = self.get_settings().get('petScales') or {}
        if pet_id in stored:
            return clamp_scale(stored[pet_id])
        try:
            pack = self.load_pack(pet_id)
            declared = float(pack.scale)
            # 包内声明了非 1.0 的值就用它；1.0 视为「没意见」，继续往全局兜底
            if declared != DEFAULT_SCALE:
                return clamp_scale(declared)
        except PetError:
            pass
        return clamp_scale(host_default if host_default is not None else DEFAULT_SCALE)

    def set_pet_scale(self, pet_id: str, value) -> float:
        """写入某形象的倍率覆盖（不校验形象是否存在——由调用方决定）。"""
        pet_id = sanitize_pet_id(pet_id)
        scale = clamp_scale(value)
        with self._lock:
            settings = self.get_settings()
            scales = dict(settings.get('petScales') or {})
            scales[pet_id] = scale
            settings['petScales'] = scales
            self._write_json(self.settings_path(), settings)
        return scale

    def clear_pet_scale(self, pet_id: str) -> bool:
        """删掉某形象的倍率覆盖（回落到包内声明 / 全局默认）。"""
        pet_id = sanitize_pet_id(pet_id)
        with self._lock:
            settings = self.get_settings()
            scales = dict(settings.get('petScales') or {})
            if pet_id not in scales:
                return False
            del scales[pet_id]
            settings['petScales'] = scales
            self._write_json(self.settings_path(), settings)
        return True

    def effective_pixelated(self, pet_id: str) -> bool:
        """算出某形象**实际生效**的渲染方式（像素风 or 平滑插值）。

        优先级与倍率一致：用户设置 > 包内声明 > 默认（平滑）。
        """
        pet_id = sanitize_pet_id(pet_id)
        stored = self.get_settings().get('petPixelated') or {}
        if pet_id in stored:
            return bool(stored[pet_id])
        try:
            return bool(self.load_pack(pet_id).pixelated)
        except PetError:
            return DEFAULT_PIXELATED

    def set_pet_pixelated(self, pet_id: str, value) -> bool:
        """写入某形象的渲染方式覆盖。"""
        pet_id = sanitize_pet_id(pet_id)
        flag = bool(value)
        with self._lock:
            settings = self.get_settings()
            flags = dict(settings.get('petPixelated') or {})
            flags[pet_id] = flag
            settings['petPixelated'] = flags
            self._write_json(self.settings_path(), settings)
        return flag

    def clear_pet_pixelated(self, pet_id: str) -> bool:
        """删掉某形象的渲染方式覆盖（回落到包内声明 / 默认）。"""
        pet_id = sanitize_pet_id(pet_id)
        with self._lock:
            settings = self.get_settings()
            flags = dict(settings.get('petPixelated') or {})
            if pet_id not in flags:
                return False
            del flags[pet_id]
            settings['petPixelated'] = flags
            self._write_json(self.settings_path(), settings)
        return True

    def _write_json(self, path: str, payload: dict) -> None:
        """UTF-8（`ensure_ascii=False`）+ 原子落盘。"""
        try:
            text = json.dumps(payload, ensure_ascii=False, indent=2)
        except (TypeError, ValueError) as exc:
            raise PetError(
                CODE_WRITE_FAILED,
                f'设置序列化失败: {exc}',
                user_msg='设置内容无法保存。',
                http_status=500,
            ) from exc
        try:
            write_bytes_atomic(path, text.encode('utf-8'))
        except PetError:
            raise
        except OSError as exc:
            raise PetError(
                CODE_WRITE_FAILED,
                f'写入 {path} 失败: {exc}',
                user_msg='保存失败，请检查磁盘空间与目录权限。',
                http_status=500,
            ) from exc

    # ------------------------------------------------------------ 列表

    def list_pets(self) -> list:
        """列出全部可用形象：内置 + 用户导入，按「用户优先」排序。

        单个包损坏不影响其它包（记 `error` 字段而不是整表失败）——
        用户导入的包可能有各种问题，不该让整个形象列表打不开。
        """
        result = []
        seen = set()

        for pet_id in self._scan_dir(self.user_pets_dir()):
            if pet_id in seen:
                continue
            seen.add(pet_id)
            result.append(self._describe(pet_id, 'user'))

        for pet_id in self._scan_dir(self.builtin_dir):
            if pet_id in seen:
                continue
            seen.add(pet_id)
            result.append(self._describe(pet_id, 'builtin'))

        result.sort(key=lambda item: (item['source'] != 'user', item.get('name') or item['id']))
        return result

    def _scan_dir(self, root: str) -> list:
        """列出 `root` 下**真的是形象包**的子目录（含 pet.json）。

        只判断「目录存在」是不够的：用户对内置形象做单动作覆盖时会创建
        `data/pets/<内置 id>/overrides/`，那会让 `data/pets/<内置 id>/` 存在但
        没有任何 pet.json。把它当成一个包会导致内置形象被「用户包」遮蔽
        （`_locate` 用户优先），等于把一个能用的内置形象变成「不存在」。
        """
        if not os.path.isdir(root):
            return []
        found = []
        try:
            names = sorted(os.listdir(root))
        except OSError as exc:
            logger.warning('读取形象目录失败 %s: %s', root, exc)
            return []
        for name in names:
            if not PET_ID_PATTERN.match(name):
                continue
            directory = os.path.join(root, name)
            if not os.path.isdir(directory):
                continue
            if not os.path.isfile(os.path.join(directory, MANIFEST_FILENAME)):
                continue
            found.append(name)
        return found

    def _overridden_actions(self, pet_id: str) -> list:
        directory = os.path.join(self.user_pet_dir(pet_id), OVERRIDES_DIRNAME)
        if not os.path.isdir(directory):
            return []
        actions = []
        try:
            for name in sorted(os.listdir(directory)):
                stem, extension = os.path.splitext(name)
                if extension.lower() in _IMAGE_EXTENSIONS and is_safe_relative_name(stem):
                    actions.append(stem)
        except OSError as exc:
            logger.warning('读取动作覆盖目录失败 %s: %s', directory, exc)
        return actions

    def _describe(self, pet_id: str, source: str) -> dict:
        """包的摘要信息（列表用）。解析失败时带 `error`，不让整表挂掉。"""
        base = {
            'id': pet_id,
            'source': source,
            'name': pet_id,
            'author': '',
            'size': None,
            'animations': [],
            'missingRequired': [],
            'overrides': self._overridden_actions(pet_id),
            'staleOverrides': [],
            'error': '',
            # 缩略图几何：面板要为**每一张**卡片算出「只显示第 0 帧」的
            # `background-size`，而那需要该形象自己的帧数与排布。
            # 放在列表接口里，是因为列表渲染时详情还没请求回来——
            # 早先的实现只好借「当前选中形象」的帧数去算，
            # 结果是除第一张之外的所有卡片都算错（小满因此没有缩略图）。
            #
            # 类型在**成功与失败两条路径上必须一致**（都是 dict）：
            # 解析失败时给一个空几何，面板照常渲染占位框。
            # 一处是 `None`、另一处是 dict 的话，前端要么得写两种判空，
            # 要么会在坏包上抛错——而「一个坏包不该让整个列表打不开」正是
            # 这个方法存在的意义。
            'thumb': {'url': '', 'frames': 1, 'layout': 'horizontal'},
        }
        try:
            pack = self.load_pack(pet_id)
        except PetError as exc:
            base['error'] = exc.user_msg or exc.msg
            return base

        builtin_only = self._is_builtin_only(pet_id)
        base.update({
            'name': pack.name,
            'author': pack.author,
            'size': dict(pack.size),
            'animations': sorted(pack.animations),
            'missingRequired': pack.missing_required(),
            # 列表也要带上生效值，否则面板切形象时得等详情接口回来才知道大小
            'scale': self.effective_scale(pet_id),
            'pixelated': self.effective_pixelated(pet_id),
            'declaredScale': clamp_scale(pack.scale),
            'declaredPixelated': bool(pack.pixelated),
            'writable': not builtin_only,
            'staleOverrides': base['overrides'] if builtin_only else [],
            'thumb': self.thumbnail_spec(pet_id, pack),
        })
        return base

    def thumbnail_spec(self, pet_id: str, pack: PetPack = None) -> dict:
        """列表缩略图要的几何：`{url, frames, layout}`（取 `idle` 的主变体）。

        `frames <= 1` 时前端用 `contain` 居中显示；多帧时按帧数横向放大、
        左对齐，只露出第 0 帧（见 `panel.js:applyThumbGeometry`）。

        取不到图时返回 `{'url': ''}`，面板据此显示占位而不是一张破图。
        """
        try:
            pack = pack if pack is not None else self.load_pack(pet_id)
        except PetError:
            return {'url': '', 'frames': 1, 'layout': 'horizontal'}
        resolved = pack.resolve('idle')
        variants = resolved.variants or []
        if resolved.kind != KIND_ANIMATED or not variants:
            return {'url': '', 'frames': 1, 'layout': 'horizontal'}
        path, _source = self.resolve_frame_path(pet_id, 'idle', variant=0)
        if not path:
            return {'url': '', 'frames': 1, 'layout': 'horizontal'}
        primary = variants[0]
        return {
            'url': self.frame_url(pet_id, 'idle', path),
            'frames': int(primary.frames) or 1,
            'layout': primary.layout or 'horizontal',
        }

    # ------------------------------------------------------------ 读取

    def _locate(self, pet_id: str) -> tuple:
        """返回 `(pack_dir, source)`；用户包优先于内置包。"""
        pet_id = sanitize_pet_id(pet_id)
        if self._is_user_pet(pet_id):
            return self.user_pet_dir(pet_id), 'user'
        if self._is_builtin_pet(pet_id):
            return self.builtin_pet_dir(pet_id), 'builtin'
        raise PetError(
            CODE_PACK_NOT_FOUND,
            f'形象不存在: {pet_id}',
            user_msg='找不到这个宠物形象，可能已被删除。',
            http_status=404,
        )

    def load_pack(self, pet_id: str) -> PetPack:
        """解析一个形象包（含回退链所需的全部动作信息）。"""
        directory, _source = self._locate(pet_id)
        path = os.path.join(directory, MANIFEST_FILENAME)
        try:
            with open(path, 'rb') as handle:
                raw = handle.read()
        except FileNotFoundError as exc:
            raise PetError(
                CODE_PACK_NOT_FOUND,
                f'形象清单不存在: {path}',
                user_msg='这个形象包里缺少 pet.json。',
                http_status=404,
            ) from exc
        except OSError as exc:
            raise PetError(
                CODE_PACK_NOT_FOUND,
                f'形象清单读取失败: {exc}',
                user_msg='形象包读不出来，可能没有访问权限。',
                http_status=500,
            ) from exc
        return loads_pack(raw, pack_id=sanitize_pet_id(pet_id))

    def active_pet_id(self) -> str:
        """当前生效的形象 id：设置里指定的那个；不可用时回落到默认形象。

        回落顺序：**默认形象**（`DEFAULT_PET_ID`，首次安装走这条）→
        列表里第一个可用形象。两条都不可用才返回空串。
        """
        settings = self.get_settings()
        wanted = sanitize_pet_id(settings.get('activePetId') or '')
        if wanted:
            try:
                self._locate(wanted)
                return wanted
            except PetError:
                logger.info('设置里的形象 %s 已不可用，回落到默认形象', wanted)
        try:
            self._locate(DEFAULT_PET_ID)
            return DEFAULT_PET_ID
        except PetError:
            pass
        for item in self.list_pets():
            if not item.get('error'):
                return item['id']
        return ''

    # ---------------------------------------------------- 覆盖与帧解析

    def resolve_frame_path(self, pet_id: str, action: str, *, variant: int = 0) -> tuple:
        """按两层覆盖解析某动作实际该用哪张图。

        Args:
            pet_id: 形象 id。
            action: 动作名。
            variant: 第几套动画（多套动画按权重随机选一套时用；默认第一套）。

        Returns:
            `(absolute_path, source)`；`source` ∈ `{'override', 'pack', 'builtin'}`。
            该动作（或该套动画）没有可用图时返回 `('', 'none')`。

        **内置形象只读**（用户要求「插件自带的宠物不应该允许用户修改」）：
        内置形象的解析**直接跳过 `overrides/`**，因此磁盘上遗留的覆盖文件
        不会生效（面板会提示并提供一键清理，见 `list_pet_overrides`）。

        单动作覆盖（`overrides/<action>.<ext>`）**只作用于第一套动画**：
        覆盖的语义是「这个动作换成我的图」，而不是「这个动作的第 N 套换成我的图」。
        多套动画的其余几套只能由包自己提供——这样规则简单，也不会出现
        「上传一张图后另外两套动画静默消失」这种怪事。

        Raises:
            PetError: 路径非法。
        """
        pet_id = sanitize_pet_id(pet_id)
        action = str(action or '').strip()
        if not is_action_name(action):
            raise PetError(
                CODE_IMAGE_INVALID,
                f'动作名非法: {action!r}',
                user_msg='动作名不合法。',
                hint='动作名只能是字母、数字、下划线或连字符。',
            )
        try:
            index = max(0, int(variant))
        except (TypeError, ValueError):
            index = 0

        user_dir = self.user_pet_dir(pet_id)
        # 1) 单动作覆盖 —— 只对**用户形象**、且只对**第一套**动画生效。
        #    内置形象不读覆盖目录，否则「不可修改」就只是 UI 层面的假象。
        if index == 0 and not self._is_builtin_only(pet_id):
            override_dir = os.path.join(user_dir, OVERRIDES_DIRNAME)
            for extension in _IMAGE_EXTENSIONS:
                candidate = os.path.join(override_dir, f'{action}{extension}')
                if os.path.isfile(candidate):
                    return candidate, 'override'

        # 2)/3) 包内自带：用户包优先，然后内置包
        try:
            pack = self.load_pack(pet_id)
        except PetError:
            return '', 'none'

        resolved = pack.resolve(action)
        if resolved.kind != KIND_ANIMATED or not resolved.sheet:
            return '', 'none'
        variants = resolved.variants or []
        if not (0 <= index < len(variants)):
            return '', 'none'
        relative = to_posix(variants[index].sheet)
        if not relative:
            return '', 'none'
        for root, source in ((user_dir, 'pack'), (self.builtin_pet_dir(pet_id), 'builtin')):
            candidate = os.path.join(root, relative.replace('/', os.sep))
            real = os.path.realpath(candidate)
            # sheet 已在解析期校验过；这里再用 realpath 复核一次（防符号链接逃逸）
            if not real.startswith(os.path.realpath(root) + os.sep):
                continue
            if os.path.isfile(real):
                return real, source
        return '', 'none'

    def runtime_pack(self, pet_id: str = '', *, host_default_scale: float = None) -> dict:
        """给前端的**运行期形象**：已解析好的 URL + 回退结论。

        前端不做回退决策——回退链是后端领域模型（§3.3 是契约），
        前端只按 `actions[<name>]` 里给的结论播帧。

        Args:
            pet_id: 形象 id；空串表示用当前形象。
            host_default_scale: 宿主 `config_schema` 里 `scale` 的值，作为
                倍率的全局兜底。标量配置的唯一来源是宿主，store 不自己读，
                因此由路由层传进来。
        """
        pet_id = sanitize_pet_id(pet_id) if pet_id else self.active_pet_id()
        if not pet_id:
            raise PetError(
                CODE_PACK_NOT_FOUND,
                '没有任何可用的形象包',
                user_msg='没有找到可用的宠物形象。',
                hint='把宠物包放到 resources/pets/，或在设置里导入一个形象。',
                http_status=404,
            )

        pack = self.load_pack(pet_id)
        directory, source = self._locate(pet_id)

        # 输出**整个动作词表**，而不是只输出包里声明过的动作。
        #
        # 为什么：前端按名字取动作（`actions['walk-left']`、`actions['land']`…）。
        # 只输出包里声明的那些，会让「只有一张单帧图」的包在前端缺键，
        # 回退链就白实现了（§3.3 要求「缺失 → 沿链下溯 → 最终一定落到 idle」）。
        # 在这里把回退结论算完，前端只负责播——回退链是后端领域模型。
        actions = {}
        for action in ACTION_FALLBACKS:
            actions[action] = self._runtime_action(pet_id, pack, action)
        # 词表外的动作（包自己声明的扩展动作）也一并输出
        for action in pack.animations:
            if action in actions:
                continue
            actions[action] = self._runtime_action(pet_id, pack, action)

        # 「遗留覆盖」：内置形象磁盘上有覆盖文件、但按只读规则**不生效**。
        # 必须显式报出来，否则用户看到的是「我明明换过图，怎么没变」——
        # 静默忽略比报错更难查。面板据此给出「一键清理」。
        stale_overrides = []
        if self._is_builtin_only(pet_id):
            stale_overrides = self._overridden_actions(pet_id)

        return {
            'id': pet_id,
            'source': source,
            'name': pack.name,
            'author': pack.author,
            'size': dict(pack.size),
            'anchor': dict(pack.anchor),
            'physics': dict(pack.physics),
            # 生效值（已按「用户设置 > 包内声明 > 默认」算好）——前端直接用，
            # 不再自己判断优先级，避免两边规则不一致。
            'scale': self.effective_scale(pet_id, host_default=host_default_scale),
            'pixelated': self.effective_pixelated(pet_id),
            # 包内声明值，供面板显示「作者建议 / 已覆盖」的对比
            'declaredScale': clamp_scale(pack.scale),
            'declaredPixelated': bool(pack.pixelated),
            'writable': not self._is_builtin_only(pet_id),
            'actions': actions,
            'missingRequired': pack.missing_required(),
            'overrides': self._overridden_actions(pet_id),
            'staleOverrides': stale_overrides,
            'directory': to_posix(os.path.relpath(directory, self.data_dir))
            if source == 'user' else '',
        }

    def _runtime_action(self, pet_id: str, pack: PetPack, action: str) -> dict:
        """把一个动作解析成前端直接可播的运行期条目。

        条目形如::

            {
              "action": "click", "source": "click", "kind": "animated",
              "frames": 4, "fps": 6, "loop": false, "layout": "horizontal",
              "frameMs": [], "mirror": false, "chain": [...], "note": "",
              "url": "...",                    # 主变体的图（兼容旧前端）
              "frameSource": "builtin",
              "variants": [ {...}, {...} ],    # 每套动画各自的图与帧参数
              "idleTrigger": {...},            # 只有 idle 有
            }

        `url` / `frames` / `fps` 这一组是**主变体**的透传：老前端只认它们，
        新前端优先读 `variants`。两套并存是有意的——运行期定义是前后端之间的
        契约，加字段安全、改字段危险。
        """
        resolved = pack.resolve(action)
        entry = resolved.to_dict()

        if resolved.kind != KIND_ANIMATED:
            entry['url'] = ''
            entry['frameSource'] = 'none'
            entry['variants'] = []
            return entry

        variants = []
        for index, variant in enumerate(resolved.variants):
            path, frame_source = self.resolve_frame_path(pet_id, action, variant=index)
            item = variant.to_dict()
            # `variant=index` **必须传**：不传的话每套动画都会拼出同一个 URL
            # （`?v=` 只跟文件内容有关，而 `idle` 的两套动画是两个不同的文件、
            # 版本号不同，看起来「恰好」是对的——但只要两套指向同一个文件
            # （例如作者让两套共用一张图、只改帧时长），URL 就会撞在一起，
            # 前端按 `vi` 区分变体的逻辑随即失效）。
            item['url'] = (
                self.frame_url(pet_id, action, path, variant=index) if path else ''
            )
            item['frameSource'] = frame_source
            variants.append(item)

        # 只保留**真的有图**的变体：声明了 sheet 但文件缺失的那套留着，
        # 前端会拿到一个空 URL 并跳过它（按权重抽取时不能选中空图）。
        playable = [item for item in variants if item['url']]
        entry['variants'] = playable
        if playable:
            primary = playable[0]
            entry['url'] = primary['url']
            entry['frameSource'] = primary['frameSource']
            # 主变体透传：老前端只读这些字段，因此它们必须与 `variants[0]` 一致
            entry['frames'] = primary['frames']
            entry['fps'] = primary['fps']
            entry['loop'] = primary['loop']
            entry['layout'] = primary['layout']
            entry['frameMs'] = list(primary['frameMs'])
        else:
            # 声明了 sheet 但一张图都找不到 → 退化为静态，并说明原因
            entry['kind'] = 'static'
            entry['url'] = ''
            entry['frameSource'] = 'none'
            entry['note'] = '这张图在形象包里找不到，将只移动位置、不播放动画。'
        return entry

    def frame_url(self, pet_id: str, action: str, path: str = '', *, variant: int = 0) -> str:
        """给某动作（某套动画）的图拼一个**带版本**的 URL。

        内容变了就换 URL，便于强缓存。`variant` 只影响路径（`?vi=`），
        版本号仍取自实际文件——两套动画指向同一个文件时 URL 不同，
        但各自的缓存键都是内容相关的。
        """
        pet_id = sanitize_pet_id(pet_id)
        action = str(action or '').strip()
        try:
            index = max(0, int(variant))
        except (TypeError, ValueError):
            index = 0
        version = ''
        if path and os.path.isfile(path):
            try:
                stat = os.stat(path)
                version = f'{int(stat.st_mtime)}-{stat.st_size}'
            except OSError:
                version = ''
        query = []
        if index > 0:
            query.append(f'vi={index}')
        if version:
            query.append(f'v={version}')
        suffix = f'?{"&".join(query)}' if query else ''
        return f'/api/plugins/stm-pet/frame/{pet_id}/{action}{suffix}'

    # ------------------------------------------------------------ 导入

    def import_zip(self, data: bytes, *, replace: bool = False) -> dict:
        """导入一个宠物包 zip。

        Args:
            data: zip 字节。
            replace: id 已存在时是否覆盖（False 则自动分配一个不冲突的 id）。

        Returns:
            dict: `runtime_pack()` 的结果（导入后可直接切过去）。
        """
        check_size(len(data), MAX_PACK_BYTES, what='宠物包')
        files = self._read_archive(data)
        manifest_name = self._find_manifest(files)

        raw_manifest = files[manifest_name]
        prefix = manifest_name[: -len(MANIFEST_FILENAME)]
        # 导入期放行 JPEG 等：由 `_store_sheet` 转码并改写 sheet 指向。
        # 运行期读盘仍走严格白名单（`load_pack` 不带这个开关）。
        pack = loads_pack(raw_manifest, pack_id='', allow_source_jpeg=True)

        with self._lock:
            pet_id = sanitize_pet_id(pack.id or prefix or 'pet')
            if self._is_builtin_pet(pet_id) or (self._is_user_pet(pet_id) and not replace):
                pet_id = self._allocate_pet_id(pet_id)
            directory = self.user_pet_dir(pet_id)

            # 先写到一个临时目录再替换：中途失败不会留下半成品包
            staging = safe_join(self.data_dir, PETS_DIRNAME, f'.staging-{pet_id}')
            shutil.rmtree(staging, ignore_errors=True)
            written = 0
            # 转码会改扩展名（例如包内的 .jpg → .png），必须把 pet.json 里
            # 对应的 sheet 一起改掉，否则包会指向一个不存在的文件
            renames = {}
            try:
                os.makedirs(staging, exist_ok=True)
                for name, payload in files.items():
                    if name == manifest_name:
                        continue
                    relative = name[len(prefix):] if prefix and name.startswith(prefix) else name
                    relative = relative.lstrip('/')
                    if not relative:
                        continue
                    extension = os.path.splitext(relative)[1].lower()
                    if extension not in _IMPORT_EXTENSIONS:
                        # 包里的非图片文件（readme、psd 源文件等）直接跳过，不报错
                        continue
                    directory_parts = [
                        part for part in to_posix(relative).split('/') if part not in ('', '.')
                    ]
                    target = safe_join(staging, *directory_parts)
                    final = self._store_sheet(payload, target, what=f'包内图片 {relative}')
                    written += 1
                    final_relative = to_posix(os.path.relpath(final, staging))
                    if final_relative != to_posix(relative):
                        renames[to_posix(relative)] = final_relative

                # 写 pet.json（归一化 id，并把转码后的 sheet 指向改到实际文件名）
                manifest = json.loads(raw_manifest.decode('utf-8-sig'))
                manifest['id'] = pet_id
                if renames:
                    self._apply_sheet_renames(manifest, renames)
                self._write_json(os.path.join(staging, MANIFEST_FILENAME), manifest)

                shutil.rmtree(directory, ignore_errors=True)
                os.replace(staging, directory)
            except PetError:
                shutil.rmtree(staging, ignore_errors=True)
                raise
            except OSError as exc:
                shutil.rmtree(staging, ignore_errors=True)
                logger.error('导入形象包失败: %s', exc)
                raise PetError(
                    CODE_WRITE_FAILED,
                    f'导入失败: {exc}',
                    user_msg='保存形象包失败，请检查磁盘空间与目录权限。',
                    http_status=500,
                ) from exc

        logger.info('导入形象包 %s（%d 张图）', pet_id, written)
        return self.runtime_pack(pet_id)

    # ------------------------------------------------------------ 新建形象

    def create_pet(
        self,
        name: str,
        frames: dict,
        *,
        pet_id: str = '',
        author: str = '',
        scale=None,
        pixelated=None,
        anchor: dict = None,
        physics: dict = None,
    ) -> dict:
        """**从零新建**一个用户形象（不需要用户手写 pet.json 或打 zip）。

        这是「用户能自己新建宠物」的实现。用户只需要给每个动作一张图，
        尺寸由第一张图（通常是 idle）推导，其余动作自动对齐到同一单帧尺寸——
        否则前端按同一 `width`/`height` 切帧，尺寸不一致的 sheet 会错位。

        Args:
            name: 形象显示名。
            frames: `{动作名: {'data': bytes, 'frames': int, 'fps': int,
                'loop': bool}}`。至少要有 `idle`。
            pet_id: 想要的 id；空串则从 `name` 推导。与现有形象冲突时自动改名。
            author: 作者署名（可选）。
            scale: 自带倍率（可选）。
            pixelated: 是否像素风（可选）。
            anchor: 锚点（可选）。
            physics: 物理参数（可选）。

        Returns:
            dict: `runtime_pack()` 的结果（新建后可直接切过去）。

        Raises:
            PetError: 没有 idle / 图非法 / 尺寸推导失败 / 落盘失败。
        """
        if not isinstance(frames, dict) or not frames:
            raise PetError(
                CODE_PACK_ANIMATION_MISSING,
                '新建形象时没有提供任何动作',
                user_msg='至少要给「待机」动作上传一张图。',
                hint='待机（idle）是唯一必须的动作，其它动作缺失时会回退到它。',
            )

        # 动作名先全部校验：任何一个非法就整体拒绝，不落半成品
        cleaned = {}
        for action, spec in frames.items():
            action_name = str(action or '').strip()
            if not is_action_name(action_name):
                raise PetError(
                    CODE_IMAGE_INVALID,
                    f'动作名非法: {action_name!r}',
                    user_msg='动作名不合法。',
                    hint='动作名只能是字母、数字、下划线或连字符。',
                )
            if not isinstance(spec, dict) or not spec.get('data'):
                continue
            cleaned[action_name] = spec

        if not cleaned:
            raise PetError(
                CODE_PACK_ANIMATION_MISSING,
                '新建形象时没有提供任何图片',
                user_msg='至少要给「待机」动作上传一张图。',
                hint='待机（idle）是唯一必须的动作。',
            )
        if 'idle' not in cleaned:
            available = '、'.join(sorted(cleaned)) or '（无）'
            raise PetError(
                CODE_PACK_IDLE_MISSING,
                '新建形象缺少 idle 动作',
                user_msg=f'缺少最基本的「待机」动作（当前只给了：{available}）。',
                hint='「待机」是唯一必须的动作：其它动作缺失都会回退到它。',
            )

        # 先用 idle 推导单帧尺寸，其余动作统一对齐到它。
        # 顺序很重要：如果每个动作各自推导，混排的图会得到不同的单帧尺寸。
        processed = {}
        frame_size = None
        for action, spec in cleaned.items():
            try:
                count = int(spec.get('frames') or 1)
            except (TypeError, ValueError):
                count = 1
            outcome = prepare_sheet(
                spec['data'],
                frames=count,
                frame_size=frame_size,
                what=f'「{action}」动作的图',
            )
            if frame_size is None:
                frame_size = outcome['frame_size']
            processed[action] = outcome

        # ---- 组装 pet.json ----
        manifest = {
            'format': 1,
            'id': '',  # 下面分配
            'name': str(name or '').strip() or '我的宠物',
            'size': {'w': int(frame_size[0]), 'h': int(frame_size[1])},
            'animations': {},
        }
        if author:
            manifest['author'] = str(author).strip()
        if anchor is not None:
            manifest['anchor'] = anchor
        if physics is not None:
            manifest['physics'] = physics
        if scale is not None:
            manifest['scale'] = clamp_scale(scale)
        if pixelated is not None:
            manifest['pixelated'] = bool(pixelated)

        for action, outcome in processed.items():
            spec = cleaned[action]
            extension = outcome['extension']
            sheet_name = f'{action}{extension}'
            try:
                fps = int(spec.get('fps') or 0)
            except (TypeError, ValueError):
                fps = 0
            entry = {'sheet': sheet_name, 'frames': outcome['frames']}
            if fps > 0:
                entry['fps'] = fps
            if action in ONE_SHOT_ACTIONS:
                # 一次性动作不循环（与包格式的默认值一致）
                entry['loop'] = False
            elif spec.get('loop') is not None:
                entry['loop'] = bool(spec['loop'])
            manifest['animations'][action] = entry

        # 先整体校验一遍（复用包格式的规则，避免写出一份自己都读不了的包）
        loads_pack(
            json.dumps(manifest, ensure_ascii=False).encode('utf-8'),
            pack_id=sanitize_pet_id(pet_id or name or 'pet'),
        )

        with self._lock:
            base = sanitize_pet_id(pet_id or name or 'pet')
            final_id = self._allocate_pet_id(base)
            manifest['id'] = final_id
            directory = self.user_pet_dir(final_id)
            staging = safe_join(self.data_dir, PETS_DIRNAME, f'.staging-{final_id}')
            shutil.rmtree(staging, ignore_errors=True)
            try:
                os.makedirs(staging, exist_ok=True)
                for action, outcome in processed.items():
                    target = os.path.join(staging, f'{action}{outcome["extension"]}')
                    write_bytes_atomic(target, outcome['data'])
                self._write_json(os.path.join(staging, MANIFEST_FILENAME), manifest)
                shutil.rmtree(directory, ignore_errors=True)
                os.replace(staging, directory)
            except PetError:
                shutil.rmtree(staging, ignore_errors=True)
                raise
            except OSError as exc:
                shutil.rmtree(staging, ignore_errors=True)
                logger.error('新建形象失败: %s', exc)
                raise PetError(
                    CODE_WRITE_FAILED,
                    f'新建形象失败: {exc}',
                    user_msg='保存形象失败，请检查磁盘空间与目录权限。',
                    http_status=500,
                ) from exc

        logger.info(
            '新建形象 %s（%d 个动作，单帧 %dx%d）',
            final_id, len(processed), frame_size[0], frame_size[1],
        )
        return self.runtime_pack(final_id)

    # ------------------------------------------------------- 遗留覆盖清理

    def list_pet_overrides(self, pet_id: str) -> list:
        """列出某形象磁盘上的覆盖动作（**不看是否生效**）。

        用于内置形象的「遗留覆盖」提示：那些文件是内置形象还可写时留下的，
        现在按只读规则不生效，但确实占着 `data/`。
        """
        return self._overridden_actions(sanitize_pet_id(pet_id))

    def clear_pet_overrides(self, pet_id: str) -> list:
        """删掉某形象**全部**覆盖图，返回被删掉的动作名列表。

        这是内置形象「一键清理」的实现（用户要求）。它**只删 `data/` 下的覆盖**，
        从不碰 `resources/` 里的随包资源。
        """
        pet_id = sanitize_pet_id(pet_id)
        removed = []
        for action in self.list_pet_overrides(pet_id):
            if self.delete_action_override(pet_id, action):
                removed.append(action)
        if removed:
            logger.info('已清理形象 %s 的遗留覆盖: %s', pet_id, removed)
        return removed

    def _allocate_pet_id(self, base: str) -> str:
        """找一个不与现有形象冲突的 id（`base-2`、`base-3`…）。"""
        for index in range(1, 1000):
            candidate = base if index == 1 else f'{base}-{index}'
            if not self._is_builtin_pet(candidate) and not self._is_user_pet(candidate):
                return candidate
        raise PetError(
            CODE_WRITE_FAILED,
            f'无法为 {base} 分配未占用的 id',
            user_msg='同名形象太多了，请换一个名字。',
            http_status=409,
        )

    def _read_archive(self, data: bytes) -> dict:
        """安全地读 zip 内容：防 zip slip / zip 炸弹 / 条目数爆炸。"""
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except (zipfile.BadZipFile, OSError, ValueError) as exc:
            raise PetError(
                CODE_ARCHIVE_INVALID,
                f'不是有效的 zip: {exc}',
                user_msg='这个文件不是有效的宠物包（zip）格式。',
                hint='把形象包文件夹压缩成 .zip 再上传；不要用 .rar / .7z。',
            ) from exc

        try:
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_ENTRIES:
                raise PetError(
                    CODE_ARCHIVE_INVALID,
                    f'包内条目过多: {len(infos)}',
                    user_msg=f'这个包里文件太多了（{len(infos)} 个）。',
                    hint='宠物包只需要 pet.json 与若干张图。',
                )

            total = sum(max(0, info.file_size) for info in infos)
            if total > MAX_UNCOMPRESSED_BYTES:
                raise PetError(
                    CODE_FILE_TOO_LARGE,
                    f'解压后体积 {total} 超过上限 {MAX_UNCOMPRESSED_BYTES}',
                    user_msg='这个包解压后太大了，可能不是宠物包。',
                    hint='宠物包通常只有几百 KB。',
                    http_status=413,
                )

            files = {}
            for info in infos:
                name = to_posix(info.filename)
                if info.is_dir():
                    continue
                # ---- zip slip 防护：绝对路径 / 盘符 / `..` 一律拒绝 ----
                if name.startswith('/') or (len(name) >= 2 and name[1] == ':'):
                    raise PetError(
                        CODE_ARCHIVE_INVALID,
                        f'包内出现绝对路径: {name}',
                        user_msg='宠物包内的文件路径不合法。',
                        hint='包内不能有绝对路径。',
                    )
                segments = [part for part in name.split('/') if part not in ('', '.')]
                if any(part == '..' for part in segments):
                    raise PetError(
                        CODE_ARCHIVE_INVALID,
                        f'包内出现路径穿越: {name}',
                        user_msg='宠物包内的文件路径不合法（包含 ".."）。',
                        hint='重新压缩时不要包含上级目录路径。',
                    )
                # macOS 压缩产物里的元数据，跳过
                if '__MACOSX' in segments or any(part.startswith('._') for part in segments):
                    continue
                try:
                    files[name] = archive.read(info)
                except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
                    raise PetError(
                        CODE_ARCHIVE_INVALID,
                        f'读取包内 {name} 失败: {exc}',
                        user_msg=f'宠物包里的 {name} 读不出来，包可能已损坏。',
                    ) from exc
            return files
        finally:
            archive.close()

    @staticmethod
    def _apply_sheet_renames(manifest: dict, renames: dict) -> None:
        """把 `sheet` 里被转码改名过的路径改写成实际落盘的文件名。

        `renames` 形如 `{'idle.jpg': 'idle.png'}`。支持字符串简写、对象、
        以及 `variants`（多套动画）三种写法——**三处都要改**，
        漏掉 `variants` 的后果是「导入后那套动画的图找不到」，
        而包本身看起来完全正常（最难查的一类问题）。
        """
        def rewrite(value):
            if isinstance(value, str):
                return renames.get(to_posix(value), value)
            return value

        animations = manifest.get('animations')
        if not isinstance(animations, dict):
            return
        for _action, spec in animations.items():
            if isinstance(spec, str):
                animations[_action] = rewrite(spec)
                continue
            if not isinstance(spec, dict):
                continue
            sheet = spec.get('sheet')
            if isinstance(sheet, str) and to_posix(sheet) in renames:
                spec['sheet'] = renames[to_posix(sheet)]
            variants = spec.get('variants')
            if isinstance(variants, list):
                for variant in variants:
                    if not isinstance(variant, dict):
                        continue
                    nested = variant.get('sheet')
                    if isinstance(nested, str) and to_posix(nested) in renames:
                        variant['sheet'] = renames[to_posix(nested)]

    @staticmethod
    def _find_manifest(files: dict) -> str:
        """找到 pet.json：优先根目录，其次唯一的顶层子目录。"""
        if not files:
            raise PetError(
                CODE_ARCHIVE_INVALID,
                '包内没有文件',
                user_msg='这个宠物包是空的。',
                hint='包内至少要有 pet.json 和一张图。',
            )
        if MANIFEST_FILENAME in files:
            return MANIFEST_FILENAME

        candidates = [
            name for name in files
            if name.endswith(f'/{MANIFEST_FILENAME}') and name.count('/') == 1
        ]
        if len(candidates) == 1:
            return candidates[0]

        deeper = [name for name in files if name.endswith(MANIFEST_FILENAME)]
        if len(deeper) == 1:
            return deeper[0]

        if len(deeper) > 1:
            raise PetError(
                CODE_ARCHIVE_INVALID,
                f'包内有多个 {MANIFEST_FILENAME}',
                user_msg='一个宠物包里只能有一个 pet.json。',
                hint='每个形象单独打一个包。',
            )

        raise PetError(
            CODE_ARCHIVE_INVALID,
            f'包内找不到 {MANIFEST_FILENAME}',
            user_msg='这个宠物包里没有 pet.json。',
            hint='包根目录（或唯一的子目录）里需要有 pet.json。',
        )

    def _store_sheet(self, payload: bytes, target: str, *, what: str) -> str:
        """把包内的一张图落盘：校验真实格式与尺寸，必要时转码。

        返回**最终落盘的绝对路径**——转码会改扩展名，调用方需要据此修正
        `pet.json` 里的 `sheet` 指向（否则包会指向一个不存在的文件）。

        策略：
        - 已是白名单格式（PNG/WebP/GIF/AVIF）→ **原样保存**，保住 spritesheet 的
          帧布局与像素（转码会重采样，可能把像素风糊掉）。
        - SVG → 校验确实是 SVG 文本后原样保存（Pillow 解不了矢量图）。
        - JPEG/BMP/TIFF 等 → 转成 PNG（宿主资产白名单不含 jpg，§2.8 / §8 陷阱 3）。
        """
        extension = os.path.splitext(target)[1].lower()

        if extension == '.svg':
            self._store_svg(payload, target, what=what)
            return target

        image = load_image(payload, what=what)  # 含解码炸弹与尺寸防护
        real_format = str(image.format or sniff_format(payload) or '')

        keep_as_is = real_format in ('PNG', 'WEBP', 'GIF', 'AVIF')
        if keep_as_is:
            write_bytes_atomic(target, payload)
            return target

        # 需要转码：目标扩展名跟着换成新的（通常是 .png）
        converted = process_upload(payload, what=what)
        final_target = os.path.splitext(target)[0] + converted['extension']
        write_bytes_atomic(final_target, converted['data'])
        return final_target

    @staticmethod
    def _store_svg(payload: bytes, target: str, *, what: str) -> None:
        """SVG 走一条独立通路：Pillow 解不了矢量图，只做内容与体积校验。

        SVG 可以带脚本，但宿主把插件资产当**图片**用（`<img>` /
        `background-image`），那条路径上脚本不会执行（§7 的资产 CSP 说明）。
        这里仍然只接受「看起来确实是 SVG」的文本，避免把任意文件当图片存进来。
        """
        if len(payload) > 1024 * 1024:
            raise PetError(
                CODE_FILE_TOO_LARGE,
                f'{what} 的 SVG 超过 1 MB',
                user_msg='这张 SVG 太大了（上限 1 MB）。',
                hint='简化矢量路径，或改用 PNG。',
                http_status=413,
            )
        head = payload[:1024].lstrip()
        if not (head.startswith(b'<svg') or head.startswith(b'<?xml') or head.startswith(b'<!--')):
            raise PetError(
                CODE_IMAGE_INVALID,
                f'{what} 的扩展名是 .svg，但内容不是 SVG',
                user_msg='这个 .svg 文件的内容不是 SVG。',
                hint='请上传真正的 SVG，或改名为 .png 后放一张位图。',
            )

    # -------------------------------------------------- 单动作 / 形象图覆盖

    def save_action_image(
        self,
        pet_id: str,
        action: str,
        data: bytes,
        *,
        frame_size: tuple = None,
        output_format: str = 'png',
    ) -> dict:
        """把一张图存成某个动作的**覆盖**（不改动包内原图）。

        只对**用户自建形象**开放：内置形象严格只读（`assert_writable`）。
        覆盖文件放在 `pets/<id>/overrides/<action>.png`，解析期优先级最高。
        """
        pet_id = self.assert_writable(pet_id)
        action = str(action or '').strip()
        if not is_action_name(action):
            raise PetError(
                CODE_IMAGE_INVALID,
                f'动作名非法: {action!r}',
                user_msg='动作名不合法。',
                hint='动作名只能是字母、数字、下划线或连字符。',
            )
        # 确认形象存在（否则会凭空建出一个只有覆盖的目录）
        self.load_pack(pet_id)

        if frame_size is None:
            try:
                frame_size = (int(self.load_pack(pet_id).size['w']), int(self.load_pack(pet_id).size['h']))
            except (KeyError, TypeError, ValueError):
                frame_size = None

        processed = process_upload(
            data, what=f'「{action}」动作的图', output_format=output_format,
            frame_size=frame_size,
        )

        with self._lock:
            override_dir = safe_join(self.data_dir, PETS_DIRNAME, pet_id, OVERRIDES_DIRNAME)
            os.makedirs(override_dir, exist_ok=True)
            # 同一动作只能有一张覆盖图：换格式时先清掉旧的
            for extension in _IMAGE_EXTENSIONS:
                stale = os.path.join(override_dir, f'{action}{extension}')
                if os.path.isfile(stale):
                    try:
                        os.remove(stale)
                    except OSError as exc:
                        logger.warning('清理旧动作覆盖失败 %s: %s', stale, exc)
            target = os.path.join(override_dir, f'{action}{processed["extension"]}')
            write_bytes_atomic(target, processed['data'])

        logger.info('形象 %s 的动作 %s 已更新覆盖图（%s）', pet_id, action, processed['source_format'])
        return {
            'petId': pet_id,
            'action': action,
            'sourceFormat': processed['source_format'],
            'size': list(processed['size']),
            'url': self.frame_url(pet_id, action, target),
        }

    def delete_action_override(self, pet_id: str, action: str) -> bool:
        """删除某动作的覆盖图（回落到包内原图）。返回是否真的删掉了东西。

        对内置形象**允许删除**：这是清理遗留覆盖的唯一手段（用户要求
        「严格只读 + 一键清理」），删的是 `data/` 里的覆盖文件，
        从不碰 `resources/` 下的随包资源。
        """
        pet_id = sanitize_pet_id(pet_id)
        action = str(action or '').strip()
        if not is_action_name(action):
            raise PetError(CODE_IMAGE_INVALID, f'动作名非法: {action!r}', user_msg='动作名不合法。')

        removed = False
        with self._lock:
            override_dir = safe_join(self.data_dir, PETS_DIRNAME, pet_id, OVERRIDES_DIRNAME)
            for extension in _IMAGE_EXTENSIONS:
                target = os.path.join(override_dir, f'{action}{extension}')
                if os.path.isfile(target):
                    try:
                        os.remove(target)
                        removed = True
                    except OSError as exc:
                        raise PetError(
                            CODE_DELETE_FAILED,
                            f'删除失败: {exc}',
                            user_msg='删除这张图失败，请检查文件是否被占用。',
                            http_status=500,
                        ) from exc
            # 覆盖目录空了就顺手删掉，别在 data/ 里攒一堆空目录
            # （也避免它们看起来像「用户包」——见 `_scan_dir` 的说明）
            self._prune_empty_dir(override_dir)
        return removed

    @staticmethod
    def _prune_empty_dir(directory: str) -> None:
        """目录为空时删除它；非空或删除失败都静默跳过。"""
        try:
            if os.path.isdir(directory) and not os.listdir(directory):
                os.rmdir(directory)
        except OSError as exc:
            logger.debug('清理空目录失败 %s: %s', directory, exc)

    # ------------------------------------------------------------ 删除

    def delete_pet(self, pet_id: str) -> bool:
        """删除一个**用户**形象包。内置形象不可删除（返回 False）。

        同时清理设置里指向它的 `activePetId`，避免下次读设置时指向不存在的形象。
        """
        pet_id = sanitize_pet_id(pet_id)
        if self._is_builtin_pet(pet_id) and not self._is_user_pet(pet_id):
            return False
        directory = self.user_pet_dir(pet_id)
        if not os.path.isdir(directory):
            return False

        with self._lock:
            try:
                shutil.rmtree(directory)
            except OSError as exc:
                logger.error('删除形象 %s 失败: %s', pet_id, exc)
                raise PetError(
                    CODE_DELETE_FAILED,
                    f'删除失败: {exc}',
                    user_msg='删除形象失败，可能有文件被占用。',
                    http_status=500,
                ) from exc
            settings = self.get_settings()
            changed = False
            if sanitize_pet_id(settings.get('activePetId') or '') == pet_id:
                settings['activePetId'] = ''
                changed = True
            # 顺手清掉这个形象的逐形象偏好（倍率 / 渲染方式）。
            #
            # 不清的后果是**设置文件无限增长**，而且更隐蔽：id 会被重新分配
            # （`_allocate_pet_id` 复用 `pet`、`pet-2`…），于是新建的形象会
            # 莫名其妙地继承一个早已删除的形象的大小设置。
            # 实测就是这样：验收脚本删掉 `pet` 后重建同名 id，新形象一出生就是 3×。
            for key in ('petScales', 'petPixelated'):
                stored = dict(settings.get(key) or {})
                if pet_id in stored:
                    del stored[pet_id]
                    settings[key] = stored
                    changed = True
            if changed:
                self._write_json(self.settings_path(), settings)

        logger.info('已删除用户形象 %s', pet_id)
        return True

    # ------------------------------------------------------------ 导出

    def export_pet(self, pet_id: str) -> bytes:
        """把一个**用户自建**形象打包成 zip（便于用户在设备间搬运自己的形象）。

        内置形象**不允许导出**（用户明确要求）：它是随插件发布的资源，
        导出它没有意义，反而会让用户以为自己「拥有」了它。
        """
        pet_id = sanitize_pet_id(pet_id)
        if self._is_builtin_only(pet_id):
            raise PetError(
                CODE_BUILTIN_NO_EXPORT,
                f'内置形象不可导出: {pet_id}',
                user_msg='这是插件自带的形象，不需要导出。',
                hint='导出只用于备份自己新建或导入的形象。',
                http_status=403,
            )
        pack = self.load_pack(pet_id)
        directory, _source = self._locate(pet_id)

        buffer = io.BytesIO()
        try:
            with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
                for name, payload in self._collect_export_files(directory, pack).items():
                    archive.writestr(name, payload)
        except OSError as exc:
            raise PetError(
                CODE_WRITE_FAILED,
                f'导出失败: {exc}',
                user_msg='导出形象包失败。',
                http_status=500,
            ) from exc
        return buffer.getvalue()

    def _collect_export_files(self, directory: str, pack: PetPack) -> dict:
        """收集需要打进 zip 的文件：manifest + 各动作实际用到的图 + 覆盖图。"""
        result = {}
        manifest = os.path.join(directory, MANIFEST_FILENAME)
        if os.path.isfile(manifest):
            with open(manifest, 'rb') as handle:
                result[MANIFEST_FILENAME] = handle.read()

        names = set()
        for action in pack.animations:
            # **每一套**动画的图都要带上：只导出主变体的话，
            # 「导出再导入」会静默丢掉其余几套（用户会以为是自己弄丢的）。
            for variant in pack.animations[action].variants:
                if variant.sheet:
                    names.add(to_posix(variant.sheet))
            # 覆盖图也要带上，否则导出再导入会丢用户改动
            path, source = self.resolve_frame_path(pack.id, action)
            if path and source == 'override':
                names.add(f'{OVERRIDES_DIRNAME}/{action}{os.path.splitext(path)[1]}')

        for relative in sorted(names):
            if not is_safe_relative_name(relative.split('/')[-1]):
                continue
            parts = [part for part in relative.split('/') if part not in ('', '.')]
            if any(part == '..' for part in parts):
                continue
            candidate = os.path.join(directory, *parts)
            if os.path.isfile(candidate):
                with open(candidate, 'rb') as handle:
                    result[relative] = handle.read()
        return result
