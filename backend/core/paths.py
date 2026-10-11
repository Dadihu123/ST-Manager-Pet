"""路径安全（**自己实现一份，不 import 宿主模块**）。

为什么复制而不是复用
--------------------
宿主有 `core/utils/paths.py:is_under_base()`，但实施提示词 §8 陷阱 15 明确要求
插件仓库**不要** import 宿主模块：宿主在打包态（PyInstaller `_MEIPASS`）下代码
可能不可达，插件不能假设 `core.*` 一定 import 得到。

因此这里是一份等价语义 + 带单测的独立实现。语义与宿主保持一致的点：
- `resolve_symlinks=True` 时用 `realpath`（用户可控路径的读写必须开启，防链接逃逸）；
- 用 `os.path.commonpath` 比较，**不用** `str.startswith`（后者会把
  `/data/plugins-x` 误判为在 `/data/plugins` 内）；
- 跨盘符（Windows）与非法路径一律判 False。
"""

import os
import re

from .errors import CODE_PACK_NOT_FOUND, CODE_PATH_ESCAPE, PetError


def is_under_base(path, base, *, resolve_symlinks: bool = False) -> bool:
    """判断 `path` 是否位于 `base` 目录内（含 `base` 自身）。

    Args:
        path: 待检查的路径。
        base: 允许的根目录。
        resolve_symlinks: 是否先用 `realpath` 解析符号链接与短路径。
            面向「用户可控路径的读写」时必须开启，防止链接逃逸。

    Returns:
        bool: 归一化后 `path` 等于 `base` 或位于其下时返回 True；
            空值、跨盘符或非法路径返回 False。
    """
    if not path or not base:
        return False

    resolver = os.path.realpath if resolve_symlinks else os.path.abspath
    try:
        target = os.path.normcase(os.path.normpath(resolver(os.fspath(path))))
        root = os.path.normcase(os.path.normpath(resolver(os.fspath(base))))
    except (TypeError, ValueError, OSError):
        return False

    try:
        return os.path.commonpath([target, root]) == root
    except (TypeError, ValueError, OSError):
        # 跨盘符时 commonpath 抛 ValueError
        return False


def is_safe_relative_name(name) -> bool:
    """`name` 是否是「单个安全的相对文件名/目录名」。

    拒绝：空、绝对路径、盘符、任何形式的 `..` 段、控制字符、Windows 保留字符。
    用于「用户提交的 id / 文件名」这类拼进路径的片段——**在拼路径之前**拦掉，
    而不是拼完再靠 `is_under_base` 兜底。
    """
    text = str(name or '').strip()
    if not text or text in ('.', '..'):
        return False
    # 盘符（C:\ / C:/）与 UNC（\\server）
    if text.startswith(('\\\\', '//', '\\', '/')):
        return False
    if len(text) >= 2 and text[1] == ':':
        return False
    if '..' in text.replace('\\', '/').split('/'):
        return False
    # Windows 保留字符 + 控制字符
    if any(char in text for char in '<>:"|?*'):
        return False
    if any(ord(char) < 32 for char in text):
        return False
    return True


def is_action_name(name) -> bool:
    """`name` 是否是合法的**动作名**（单个路径段，不含分隔符）。

    与 `is_safe_relative_name` 的区别：动作名会被当作**单个文件名主干**拼进路径
    （`overrides/<action>.png`）与 URL 段（`/frame/<id>/<action>`），
    因此不允许出现 `/`、`\\`。`is_safe_relative_name('a/b')` 是为 sheet
    相对路径准备的（允许多段），不能拿来校验动作名。
    """
    text = str(name or '').strip()
    if not is_safe_relative_name(text):
        return False
    if '/' in text or '\\' in text:
        return False
    # 动作名用于 URL 段，限制为安全的标识符字符集
    return bool(re.match(r'^[A-Za-z0-9_-]+$', text))


def safe_join(base: str, *parts, must_exist: bool = False) -> str:
    """把若干片段安全地拼到 `base` 下；任何逃逸都抛 `PetError`。

    Args:
        base: 允许的根目录。
        *parts: 相对片段（不含 `..`、不以 `/` 开头）。
        must_exist: True 时要求目标已存在（普通文件或目录均可）。

    Returns:
        str: 解析（realpath）后的绝对路径，一定位于 `base` 内。

    Raises:
        PetError: 片段非法、或解析后逃出 `base`。
    """
    for part in parts:
        if not is_safe_relative_name(part):
            raise PetError(
                CODE_PATH_ESCAPE,
                f'非法的路径片段: {part!r}',
                user_msg='路径不合法，操作已取消。',
                hint='路径片段不能为空、不能是绝对路径、也不能包含 ".."。',
                http_status=400,
            )

    base_real = os.path.realpath(str(base))
    target = os.path.join(base_real, *(str(part) for part in parts))
    target_real = os.path.realpath(target)

    if not is_under_base(target_real, base_real, resolve_symlinks=True):
        raise PetError(
            CODE_PATH_ESCAPE,
            f'路径逃逸: {target_real} 不在 {base_real} 内',
            user_msg='路径不安全，操作已取消。',
            hint='目标路径必须位于宠物数据目录内。',
            http_status=400,
        )

    if must_exist and not os.path.exists(target_real):
        raise PetError(
            CODE_PACK_NOT_FOUND,
            f'路径不存在: {target_real}',
            user_msg='找不到该文件，可能已被删除。',
            http_status=404,
        )

    return target_real


def to_posix(relative_path) -> str:
    """把存储用的相对路径归一成正斜杠形式（跨平台一致）。"""
    return str(relative_path or '').replace('\\', '/')
