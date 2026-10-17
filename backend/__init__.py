"""stm-pet 插件后端入口。

`register(api)` 由 manifest 的 `backend.register` 指定：宿主在 `create_app()` 阶段
构造 `PluginAPI` 并调用它；`api.http.route()` 收集的路由规则会在 `register()` 返回后
由宿主的 `finalize()` 统一注册（`finalize` 是宿主内部机制，插件不调用）。

宿主契约以**域命名空间**组织（`api.cards.*` / `api.private.*` / `api.http.*` …），
本插件用到的成员全部来自 `ST-Manager/docs/plugin-api.md`，不得回退到已删除的扁平名
（`api.route()` / `api.data_dir()` / `api.log(level, msg)` …）。

装配：读插件配置 → 建存储层 → 注册路由。
"""

import logging
import os

logger = logging.getLogger(__name__)

__all__ = ['register']

#: 随包默认形象目录（相对插件根）。**不放 `data/`**——那里的同名文件在插件更新时
#: 会被宿主改名为 `<name>.plugin-default`（§2.4 / §8 陷阱 5）。
BUILTIN_PETS_DIRNAME = os.path.join('resources', 'pets')


def _plugin_root() -> str:
    """插件根目录（`backend/` 的上一级）。"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _plugin_config(api) -> dict:
    """读插件当前配置（`api.config.get()`）。

    单一来源：默认值只写在 manifest 的 `config_schema` 里，插件不重复声明一遍，
    避免「两处默认值不一致」这种最难查的 bug。`api.config.get()` 已经把
    `config_schema` 的默认值与用户保存值合并好了，插件侧不必自己解析 schema。
    """
    config = api.config.get()
    return config if isinstance(config, dict) else {}


def register(api):
    """插件注册入口（由宿主调用）。"""
    from .core.store import PetStore
    from .routes import register_routes

    data_dir = api.private.dir()
    builtin_dir = os.path.join(_plugin_root(), BUILTIN_PETS_DIRNAME)

    store = PetStore(data_dir, builtin_dir)
    api.log.info(f'stm-pet 装配：数据目录 {data_dir}')
    if not os.path.isdir(builtin_dir):
        api.log.warn(f'随包形象目录缺失，仅用户形象可用: {builtin_dir}')

    try:
        api.log.info(f'stm-pet 配置: {_plugin_config(api)}')
    except Exception:  # noqa: BLE001 - 配置读取失败不该阻断插件加载
        logger.warning('读取插件配置失败', exc_info=True)

    register_routes(api, store)

    # 让前端与 CLI 能拿到同一个 store（`api` 是每插件的实例，挂属性是既有做法）
    api.pet_store = store

    available = [item['id'] for item in store.list_pets()]
    api.log.info(f'stm-pet 就绪：{len(available)} 个形象 {available}')
