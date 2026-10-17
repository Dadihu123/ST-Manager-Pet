"""一个最小的 `api` 替身，用于在**不启动宿主**的情况下测插件后端路由。

宿主真实的 `PluginAPI` 需要 Flask app + manifest + registry 一整条链，
在插件仓库里搭起来成本过高（而且会耦合宿主的内部结构）。这里只实现路由层
**实际用到**的那几个成员，形状与宿主**逐字对齐**（`ST-Manager/docs/plugin-api.md`）：

- `api.http.route(rule, methods)` —— 装饰器，把视图函数收进本插件的蓝图；
- `api.private.dir()` —— 插件私有数据目录；
- `api.config.get()` / `api.config.set(patch)` —— `config_schema` 的当前值；
- `api.log.info/warn/debug/error(message, **extra)` —— 具名 level 日志。

**只实现域形状，不提供扁平别名**：插件系统从未发布，宿主已按方案 §3.2 删掉
`api.route()` / `api.data_dir()` / `api.log(level, msg)` 等旧名。替身若保留旧名，
测试就再也拦不住插件回退到旧契约——所以这里刻意让旧名**不存在**。

注册完调用 `finalize(app)` 把蓝图挂到测试用的 Flask app 上
（对应宿主在 `register()` 返回后自己做的 `finalize()`，那是宿主内部机制，
插件不调用它），这样测的就是**真实的路由函数**，而不是重新拼一遍逻辑。
"""

import logging
import os
import tempfile

from flask import Blueprint, Flask, jsonify

logger = logging.getLogger(__name__)

#: 宿主 `api.log.*` 的四个具名 level → Python logging 的方法名。
_LOG_LEVELS = {
    'debug': 'debug',
    'info': 'info',
    'warn': 'warning',
    'error': 'error',
}


class _FakeConfig:
    """`api.config.*`：与宿主一致，`get()` 已经合并了默认值与用户保存值。"""

    def __init__(self, api):
        self._api = api

    def get(self) -> dict:
        """读插件配置（替身里就是构造时给的那份快照）。"""
        return dict(self._api.config_snapshot)

    def set(self, patch: dict) -> bool:
        self._api.config_snapshot.update(patch or {})
        return True


class _FakePrivate:
    """`api.private.*`：替身只需要私有目录。"""

    def __init__(self, api):
        self._api = api

    def dir(self) -> str:
        """插件私有数据目录（宿主是 `data/plugins/<id>/data/`）。"""
        os.makedirs(self._api._data_dir, exist_ok=True)
        return self._api._data_dir


class _FakeHttp:
    """`api.http.*`：把路由规则收进蓝图。"""

    def __init__(self, api):
        self._api = api

    def route(self, rule, methods=None):
        def decorator(func):
            self._api._blueprint.add_url_rule(
                rule, endpoint=func.__name__, view_func=func,
                methods=list(methods or ('GET',)),
            )
            return func

        return decorator

    def blueprint(self, bp) -> bool:
        self._api.blueprints.append(bp)
        return True


class _FakeLog:
    """`api.log.*`：具名 level，记录到 `api.logs` 便于断言。"""

    def __init__(self, api):
        self._api = api

    def _write(self, level, message, **extra):
        self._api.logs.append((level, str(message)))
        getattr(logger, _LOG_LEVELS[level])(
            '[plugin:%s] %s', self._api.plugin_id, message,
        )

    def debug(self, message, **extra) -> None:
        self._write('debug', message, **extra)

    def info(self, message, **extra) -> None:
        self._write('info', message, **extra)

    def warn(self, message, **extra) -> None:
        self._write('warn', message, **extra)

    def error(self, message, **extra) -> None:
        self._write('error', message, **extra)


class FakeApi:
    """`PluginAPI` 的最小替身（域形状，无扁平别名）。"""

    def __init__(self, plugin_id='stm-pet', data_dir=None, root=None, config=None):
        self.plugin_id = plugin_id
        self.app_version = '0.0.0-fake'
        self._data_dir = data_dir or tempfile.mkdtemp(prefix='pet-api-')
        self._root = root
        self._blueprint = Blueprint(
            f'plugin_{plugin_id.replace("-", "_")}', __name__,
        )
        self.blueprints = []
        self.logs = []
        #: 宿主下发给插件的 manifest 只读快照（dict，不是对象）。
        self.manifest = None
        #: 宿主 `config_schema` 的当前值。真实宿主一定有 `api.config.get()`
        #: （路由层用它取全局兜底倍率），因此替身也必须实现——
        #: 缺了它会让「所有取运行期定义的接口」一起 500/404，
        #: 而失败原因看起来像是包坏了。
        self.config_snapshot = dict(config or {})

        # 域对象是实例属性（宿主 §3.5：不能用 @property）
        self.config = _FakeConfig(self)
        self.private = _FakePrivate(self)
        self.http = _FakeHttp(self)
        self.log = _FakeLog(self)

    # ---- 其它宿主契约（插件当前未用，留着便于扩测）----

    def emit(self, event, payload):  # pragma: no cover - 宠物不改宿主数据
        self.logs.append(('emit', f'{event}:{payload}'))

    # ---- 装配 ----

    def finalize(self, app: Flask) -> None:
        """把收集到的路由挂到测试 app 上（宿主侧叫 `finalize()`，插件不调用）。"""
        app.register_blueprint(self._blueprint, url_prefix=f'/api/plugins/{self.plugin_id}')


def build_app(api: FakeApi, store) -> Flask:
    """按生产装配顺序建一个可测试的 Flask app。"""
    from backend.routes import register_routes

    app = Flask(__name__)
    app.config['TESTING'] = True
    register_routes(api, store)
    api.finalize(app)

    @app.errorhandler(404)
    def _not_found(_error):
        return jsonify({'success': False, 'msg': '没有这个接口', 'error': 'not_found'}), 404

    return app
