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
    CODE_DELETE_FAILED,
    CODE_FILE_TOO_LARGE,
    CODE_IMAGE_INVALID,
    CODE_PACK_NOT_FOUND,
    CODE_WRITE_FAILED,
    PetError,
)
from .imports import (
    ALLOWED_IMAGE_FORMATS,
    MAX_PACK_BYTES,
    check_size,
    load_image,
    process_upload,
    sniff_format,
    write_bytes_atomic,
)
from .pack import (
    ACTION_FALLBACKS,
    ALLOWED_SHEET_EXTENSIONS,
    IMPORT_SOURCE_EXTENSIONS,
    KIND_ANIMATED,
    PetPack,
    loads as loads_pack,
)
from .paths import is_action_name, is_safe_relative_name, safe_join, to_posix

logger = logging.getLogger(__name__)

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
    # 标量开关（勿扰、播报、大小倍率…）声明在 manifest 的 `config_schema` 里，
    # 由宿主的插件设置表单渲染、由 `api.get_config()/set_config()` 读写。
    # 两边都存一份会造成「改了宿主表单但插件不生效」这类双写不同步的 bug，
    # 所以这里只留宿主表单表达不了的东西：当前形象 id 与包列表。
    'activePetId': '',
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
)

#: 图片在包里的扩展名（与 `pack.ALLOWED_SHEET_EXTENSIONS` 同源）。
#: 这是**落盘后**的严格集合，用于扫描 `overrides/` 之类「一定是最终格式」的目录。
_IMAGE_EXTENSIONS = tuple(sorted(ALLOWED_SHEET_EXTENSIONS))

#: 导入 zip 时额外接受的扩展名（会被 `_store_sheet` 转码成 PNG）。
#: 用户打包自己的图时几乎必然夹带 `.jpg`；直接跳过会让包「少图」却看不出原因。
_IMPORT_EXTENSIONS = tuple(sorted(ALLOWED_SHEET_EXTENSIONS | IMPORT_SOURCE_EXTENSIONS))


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


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

    # ------------------------------------------------------------ 设置

    def get_settings(self) -> dict:
        """读插件自己的设置；文件缺失/损坏时回落到默认值（不抛错）。"""
        settings = dict(DEFAULT_SETTINGS)
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
        return settings

    def update_settings(self, patch: dict) -> dict:
        """浅合并写入设置（未知键忽略；写入失败抛结构化错误）。"""
        if not isinstance(patch, dict):
            raise PetError(CODE_WRITE_FAILED, '设置补丁应为对象', user_msg='设置格式不对。')

        with self._lock:
            settings = self.get_settings()
            for key, value in patch.items():
                if key in DEFAULT_SETTINGS:
                    settings[key] = value
            self._write_json(self.settings_path(), settings)
            return settings

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
            'error': '',
        }
        try:
            pack = self.load_pack(pet_id)
        except PetError as exc:
            base['error'] = exc.user_msg or exc.msg
            return base

        base.update({
            'name': pack.name,
            'author': pack.author,
            'size': dict(pack.size),
            'animations': sorted(pack.animations),
            'missingRequired': pack.missing_required(),
        })
        return base

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
        """当前生效的形象 id：设置里指定的那个；不可用时回落到第一个可用形象。"""
        settings = self.get_settings()
        wanted = sanitize_pet_id(settings.get('activePetId') or '')
        if wanted:
            try:
                self._locate(wanted)
                return wanted
            except PetError:
                logger.info('设置里的形象 %s 已不可用，回落到默认形象', wanted)
        for item in self.list_pets():
            if not item.get('error'):
                return item['id']
        return ''

    # ---------------------------------------------------- 覆盖与帧解析

    def resolve_frame_path(self, pet_id: str, action: str) -> tuple:
        """按两层覆盖解析某动作实际该用哪张图。

        Returns:
            `(absolute_path, source)`；`source` ∈ `{'override', 'pack', 'builtin'}`。
            该动作没有可用图时返回 `('', 'none')`。

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

        user_dir = self.user_pet_dir(pet_id)
        # 1) 单动作覆盖
        override_dir = os.path.join(user_dir, OVERRIDES_DIRNAME)
        for extension in _IMAGE_EXTENSIONS:
            candidate = os.path.join(override_dir, f'{action}{extension}')
            if os.path.isfile(candidate):
                return candidate, 'override'

        # 2)/3) 包内自带：用户包优先，然后内置包
        pack = None
        try:
            pack = self.load_pack(pet_id)
        except PetError:
            return '', 'none'

        resolved = pack.resolve(action)
        if resolved.kind != KIND_ANIMATED or not resolved.sheet:
            return '', 'none'

        relative = to_posix(resolved.sheet)
        for root, source in ((user_dir, 'pack'), (self.builtin_pet_dir(pet_id), 'builtin')):
            candidate = os.path.join(root, relative.replace('/', os.sep))
            real = os.path.realpath(candidate)
            # sheet 已在解析期校验过；这里再用 realpath 复核一次（防符号链接逃逸）
            if not real.startswith(os.path.realpath(root) + os.sep):
                continue
            if os.path.isfile(real):
                return real, source
        return '', 'none'

    def runtime_pack(self, pet_id: str = '') -> dict:
        """给前端的**运行期形象**：已解析好的 URL + 回退结论。

        前端不做回退决策——回退链是后端领域模型（§3.3 是契约），
        前端只按 `actions[<name>]` 里给的结论播帧。
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
        # 为什么：前端按名字取动作（`actions['walk']`、`actions['land']`…）。
        # 只输出包里声明的那些，会让「只有一张单帧图」的包在前端缺键，
        # 回退链就白实现了（§3.3 要求「缺失 → 沿链下溯 → 最终一定落到 idle」）。
        # 在这里把回退结论算完，前端只负责播——回退链是后端领域模型。
        actions = {}
        for action in ACTION_FALLBACKS:
            resolved = pack.resolve(action)
            entry = resolved.to_dict()
            if resolved.kind == KIND_ANIMATED:
                path, frame_source = self.resolve_frame_path(pet_id, action)
                entry['url'] = self.frame_url(pet_id, action, path) if path else ''
                entry['frameSource'] = frame_source
                if not entry['url']:
                    # 声明了 sheet 但文件缺失 → 退化为静态，并说明原因
                    entry['kind'] = 'static'
                    entry['note'] = '这张图在形象包里找不到，将只移动位置、不播放动画。'
            else:
                entry['url'] = ''
                entry['frameSource'] = 'none'
            # 词表外的动作（包自己声明的扩展动作）也一并输出
            actions[action] = entry

        for action in pack.animations:
            if action in actions:
                continue
            resolved = pack.resolve(action)
            entry = resolved.to_dict()
            path, frame_source = self.resolve_frame_path(pet_id, action)
            entry['url'] = self.frame_url(pet_id, action, path) if path else ''
            entry['frameSource'] = frame_source
            if entry['kind'] == KIND_ANIMATED and not entry['url']:
                entry['kind'] = 'static'
                entry['note'] = '这张图在形象包里找不到，将只移动位置、不播放动画。'
            actions[action] = entry

        return {
            'id': pet_id,
            'source': source,
            'name': pack.name,
            'author': pack.author,
            'size': dict(pack.size),
            'anchor': dict(pack.anchor),
            'physics': dict(pack.physics),
            'actions': actions,
            'missingRequired': pack.missing_required(),
            'overrides': self._overridden_actions(pet_id),
            'directory': to_posix(os.path.relpath(directory, self.data_dir))
            if source == 'user' else '',
        }

    def frame_url(self, pet_id: str, action: str, path: str = '') -> str:
        """给某动作的图拼一个**带版本**的 URL（内容变了就换 URL，便于强缓存）。"""
        pet_id = sanitize_pet_id(pet_id)
        action = str(action or '').strip()
        version = ''
        if path and os.path.isfile(path):
            try:
                stat = os.stat(path)
                version = f'{int(stat.st_mtime)}-{stat.st_size}'
            except OSError:
                version = ''
        query = f'?v={version}' if version else ''
        return f'/api/plugins/stm-pet/frame/{pet_id}/{action}{query}'

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

        `renames` 形如 `{'idle.jpg': 'idle.png'}`。支持字符串简写与对象两种写法。
        """
        animations = manifest.get('animations')
        if not isinstance(animations, dict):
            return
        for action, spec in animations.items():
            if isinstance(spec, str):
                if to_posix(spec) in renames:
                    animations[action] = renames[to_posix(spec)]
            elif isinstance(spec, dict):
                sheet = spec.get('sheet')
                if isinstance(sheet, str) and to_posix(sheet) in renames:
                    spec['sheet'] = renames[to_posix(sheet)]

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

        这是「用户能覆盖单个动作的图」的实现（§3.2）：包内原图保留，
        覆盖文件放在 `pets/<id>/overrides/<action>.png`，解析期优先级最高。
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
        """删除某动作的覆盖图（回落到包内原图）。返回是否真的删掉了东西。"""
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
            if sanitize_pet_id(settings.get('activePetId') or '') == pet_id:
                settings['activePetId'] = ''
                self._write_json(self.settings_path(), settings)

        logger.info('已删除用户形象 %s', pet_id)
        return True

    # ------------------------------------------------------------ 导出

    def export_pet(self, pet_id: str) -> bytes:
        """把一个形象打包成 zip（便于用户在设备间搬运自己的形象）。"""
        pet_id = sanitize_pet_id(pet_id)
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
            resolved = pack.resolve(action)
            if resolved.sheet:
                names.add(to_posix(resolved.sheet))
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
