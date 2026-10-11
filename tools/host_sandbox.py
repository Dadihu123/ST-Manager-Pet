"""创建一份「影子宿主」运行目录：复用宿主代码，但用独立的 `data/`。

为什么需要它
------------
阶段 0 的七条验收必须在**真实浏览器 + 真实宿主**里跑。但直接启动宿主会用
`ST-Manager/data/` —— 那是用户的数据目录（卡片、世界书、ui_data.json），
在里面装冒烟插件、改插件启用状态、让后台扫描器扫一遍，都可能污染用户数据。

做法
----
`core/config.py` 用 `os.path.dirname(os.path.dirname(os.path.abspath(__file__)))`
推导 `BASE_DIR`，再用 `BASE_DIR/data` 作为数据目录。`os.path.abspath` **不解析**
junction/symlink，因此：

    影子目录/
    ├─ core      -> 宿主/core        （junction，只读复用代码）
    ├─ static    -> 宿主/static
    ├─ templates -> 宿主/templates
    ├─ app.py    （复制宿主的入口，见下）
    └─ data/     （真实目录，完全独立）

从这里启动时 `BASE_DIR` 就是影子目录，`DATA_DIR` 是独立的 `data/`，
**宿主仓库一个字节都不写**；而跑的是宿主真实代码。

`app.py` 是复制的而不是 junction：它里面只有 `webbrowser.open` 与
`os.system('pause')` 这类交互副作用，复制一份可以去掉自动开浏览器与暂停
（CI / 无人值守下会卡住）。复制内容为原文件逐字副本，源文件哈希记在
`SANDBOX_INFO.json` 里以便追溯。

用法
----
    python tools/host_sandbox.py --create          # 建影子目录并打印路径
    python tools/host_sandbox.py --create --install <插件目录>   # 顺便装插件
    python tools/host_sandbox.py --remove          # 删掉影子目录
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys

logger = logging.getLogger(__name__)

DEFAULT_HOST_ROOT = r'D:\Workspace\MyOwn\ST-Manager'
DEFAULT_SANDBOX_ROOT = os.path.join(
    os.environ.get('TEMP') or os.environ.get('TMP') or '.', 'st-manager-pet-sandbox',
)
#: 只复用这些目录/文件；`data/` **绝不**链接过来。
LINK_DIRS = ('core', 'static', 'templates')
COPY_FILES = ('app.py',)
#: `app.py` 里这两处交互副作用在无人值守下会卡住或抢焦点，复制后剔除。
INTERACTIVE_MARKERS = (
    ("threading.Timer(0.5, lambda: webbrowser.open(f\"http://{open_host}:{server_port}\")).start()",
     "pass  # [pet-sandbox] 已移除自动开浏览器"),
)


def _is_junction_or_link(path: str) -> bool:
    """判断路径是否已是链接/junction（避免重复创建）。"""
    if not os.path.islink(path):
        # Windows 的 junction 不是 symlink，用 reparse point 属性判断
        try:
            return bool(os.lstat(path).st_reparse_tag)  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            return False
    return True


def _link_dir(source: str, target: str) -> str:
    """把 target 做成指向 source 的目录链接（Windows 用 junction，无需管理员）。"""
    if os.path.exists(target) or _is_junction_or_link(target):
        return 'kept'
    if os.name == 'nt':
        result = subprocess.run(
            ['cmd', '/c', 'mklink', '/J', target, source],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            raise OSError(f'mklink /J 失败: {result.stdout}{result.stderr}')
        return 'junction'
    os.symlink(source, target, target_is_directory=True)
    return 'symlink'


def _write_sandbox_app(host_root: str, sandbox_root: str) -> str:
    """复制宿主的 `app.py`，并剔除会自动开浏览器 / 暂停的交互副作用。"""
    source = os.path.join(host_root, 'app.py')
    with open(source, 'r', encoding='utf-8') as handle:
        text = handle.read()

    applied = []
    for original, replacement in INTERACTIVE_MARKERS:
        if original in text:
            text = text.replace(original, replacement)
            applied.append(original)

    header = (
        '"""[pet-sandbox] 由 ST-Manager-Pet/tools/host_sandbox.py 生成，请勿手改。\n\n'
        f'源文件: {source}\n'
        f'已剔除的交互副作用: {len(applied)} 处\n'
        '"""\n'
    )
    target = os.path.join(sandbox_root, 'app.py')
    with open(target, 'w', encoding='utf-8') as handle:
        handle.write(header + text)
    return target


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def create(host_root: str, sandbox_root: str, install: list) -> dict:
    """建影子目录（幂等），返回描述信息的 dict。"""
    if not os.path.isdir(os.path.join(host_root, 'core')):
        raise SystemExit(f'宿主仓库不可用（缺少 core/）: {host_root}')

    os.makedirs(sandbox_root, exist_ok=True)
    links = {}
    for name in LINK_DIRS:
        source = os.path.join(host_root, name)
        if not os.path.isdir(source):
            continue
        links[name] = _link_dir(source, os.path.join(sandbox_root, name))
    for name in COPY_FILES:
        source = os.path.join(host_root, name)
        if os.path.isfile(source):
            shutil.copy2(source, os.path.join(sandbox_root, name))
            links[name] = 'copied'

    _write_sandbox_app(host_root, sandbox_root)

    data_dir = os.path.join(sandbox_root, 'data')
    os.makedirs(data_dir, exist_ok=True)
    # 插件库目录由宿主自己建；这里只保证 data/ 存在
    plugins_dir = os.path.join(data_dir, 'plugins')
    os.makedirs(plugins_dir, exist_ok=True)

    # 影子 config.json：与宿主同构，但换端口，避免撞上用户的实例
    config_target = os.path.join(sandbox_root, 'config.json')
    host_config = os.path.join(host_root, 'config.json')
    if not os.path.exists(config_target):
        config = {}
        if os.path.isfile(host_config):
            try:
                with open(host_config, 'r', encoding='utf-8') as handle:
                    config = json.load(handle)
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning('读取宿主 config.json 失败，将使用空配置: %s', exc)
        config['port'] = int(os.environ.get('PET_SANDBOX_PORT', '5099'))
        config['host'] = '127.0.0.1'
        # 影子环境里没有用户的卡片库；关掉自动扫描，别让后台线程空转
        config['enable_auto_scan'] = False
        config['enable_startup_scan'] = False
        with open(config_target, 'w', encoding='utf-8') as handle:
            json.dump(config, handle, ensure_ascii=False, indent=2)

    installed = []
    for source in install or []:
        resolved = os.path.abspath(source)
        if not os.path.isdir(resolved):
            raise SystemExit(f'--install 传入的不是目录: {source}')
        # 插件目录名必须等于 manifest 里的 id（宿主会校验），
        # 因此用 manifest 的 id 而不是源目录名——`--install .` 的目录名是
        # 仓库名（ST-Manager-Pet），与 id（stm-pet）不一致，直接拷会被宿主拒绝。
        name = _plugin_dir_name(resolved)
        target = os.path.join(plugins_dir, name)
        if os.path.exists(target):
            shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(
            resolved, target,
            ignore=shutil.ignore_patterns(
                '__pycache__', '*.pyc', '.git', '.pytest_cache', 'node_modules',
                'artifacts', 'data',
            ),
        )
        installed.append(name)

    info = {
        'host_root': host_root,
        'sandbox_root': sandbox_root,
        'links': links,
        'data_dir': data_dir,
        'plugins_dir': plugins_dir,
        'config': config_target,
        'port': int(os.environ.get('PET_SANDBOX_PORT', '5099')),
        'installed': installed,
        'app_py_sha256_of_source': _sha256(os.path.join(host_root, 'app.py')),
        'python': sys.executable,
    }
    with open(os.path.join(sandbox_root, 'SANDBOX_INFO.json'), 'w', encoding='utf-8') as handle:
        json.dump(info, handle, ensure_ascii=False, indent=2)
    return info


def _plugin_dir_name(plugin_dir: str) -> str:
    """按插件 manifest 的 `id` 决定安装目录名（宿主强制目录名 == id）。"""
    manifest_path = os.path.join(plugin_dir, 'manifest.json')
    try:
        with open(manifest_path, 'r', encoding='utf-8') as handle:
            manifest = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f'读取 {manifest_path} 失败: {exc}')
    plugin_id = str(manifest.get('id') or '').strip()
    if not plugin_id:
        raise SystemExit(f'{manifest_path} 里没有 id')
    return plugin_id


def remove(sandbox_root: str) -> bool:
    """删除影子目录（先摘 junction，避免 rmtree 顺藤摸瓜删宿主文件）。"""
    if not os.path.isdir(sandbox_root):
        return False
    for name in LINK_DIRS:
        target = os.path.join(sandbox_root, name)
        if _is_junction_or_link(target):
            try:
                if os.name == 'nt':
                    os.rmdir(target)
                else:
                    os.unlink(target)
            except OSError as exc:
                logger.warning('摘除链接 %s 失败: %s', target, exc)
    shutil.rmtree(sandbox_root, ignore_errors=True)
    return True


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    parser = argparse.ArgumentParser(description='创建 / 删除用于真实浏览器验收的影子宿主目录')
    parser.add_argument('--host-root', default=DEFAULT_HOST_ROOT)
    parser.add_argument('--sandbox-root', default=DEFAULT_SANDBOX_ROOT)
    parser.add_argument('--create', action='store_true')
    parser.add_argument('--remove', action='store_true')
    parser.add_argument('--install', action='append', default=[],
                        help='要装进影子插件库的插件目录（可重复）')
    args = parser.parse_args(argv)

    if args.remove:
        removed = remove(args.sandbox_root)
        print('已删除' if removed else '影子目录不存在')
        return 0

    if not args.create:
        parser.print_help()
        return 2

    info = create(args.host_root, args.sandbox_root, args.install)
    # 注意：Windows 终端可能是 GBK，这里写 UTF-8 文件而不是靠 stdout（§8 陷阱 8）
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
