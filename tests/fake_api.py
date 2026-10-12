"""一个最小的 `api` 替身，用于在**不启动宿主**的情况下测插件后端路由。

宿主真实的 `PluginAPI` 需要 Flask app + manifest + registry 一整条链，
在插件仓库里搭起来成本过高（而且会耦合宿主的内部结构）。这里只实现路由层
**实际用到**的那几个方法，行为对齐宿主 API（`ST-Manager/docs/plugin-api.md`）：

- `api.route(rule, methods)` —— 装饰器，把视图函数收进一个蓝图；
- `api.data_dir()` —— 插件私有数据目录；
- `api.log(level, message)` —— 写日志。

注册完调用 `finalize(app)` 把蓝图挂到测试用的 Flask app 上，
这样测的就是**真实的路由函数**，而不是重新拼一遍逻辑。
"""

import logging
import os
import tempfile

from flask import Blueprint, Flask, jsonify

logger = logging.getLogger(__name__)


class FakeApi:
    """`PluginAPI` 的最小替身。"""

    def __init__(self, plugin_id='stm-pet', data_dir=None, root=None):
        self.plugin_id = plugin_id
        self._data_dir = data_dir or tempfile.mkdtemp(prefix='pet-api-')
        self._root = root
        self._blueprint = Blueprint(
            f'plugin_{plugin_id.replace("-", "_")}', __name__,
        )
        self.logs = []
        self.manifest = None

    # ---- 宿主契约 ----

    def route(self, rule, methods=None):
        def decorator(func):
            self._blueprint.add_url_rule(
                rule, endpoint=func.__name__, view_func=func,
                methods=list(methods or ('GET',)),
            )
            return func

        return decorator

    def data_dir(self) -> str:
        os.makedirs(self._data_dir, exist_ok=True)
        return self._data_dir

    def log(self, level, message, **extra):
        self.logs.append((str(level), str(message)))
        getattr(logger, str(level) if str(level) in
                ('debug', 'info', 'warning', 'error') else 'info')(
            '[plugin:%s] %s', self.plugin_id, message,
        )

    def emit(self, event, payload):  # pragma: no cover - 宠物不改宿主数据
        self.logs.append(('emit', f'{event}:{payload}'))

    # ---- 装配 ----

    def finalize(self, app: Flask) -> None:
        """把收集到的路由挂到测试 app 上（对应宿主的 `api.finalize()`）。"""
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
