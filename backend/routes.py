"""插件后端路由（前缀自动是 `/api/plugins/stm-pet`）。

设计原则
--------
- **不把 traceback 塞进响应**（§1.2）：所有 `PetError` 统一经 `_handle` 转成
  结构化 `{success, msg, error, hint?, detail?}`。
- **不做全站 CSRF 强校验的替代品**：宿主没有全站 CSRF，但用户上传是不可信输入，
  因此每个入口都做自己的输入校验（§2.7 / §9 陷阱 9）。
- 形象图走**插件自己的路由**返回（`/frame/<pet>/<action>`），因为：
  1. 用户图可能存在 `data/` 里（不在资产白名单扫描范围）；
  2. 需要按「覆盖 > 包内 > 内置」的解析结果返回**那张**图；
  3. 需要一个随内容变化的版本号做强缓存。
"""

import functools
import json
import logging
import os
import re

from flask import jsonify, request, send_file

from .core.errors import (
    CODE_IMAGE_INVALID,
    CODE_NO_UPLOAD,
    CODE_PAYLOAD_TOO_LARGE,
    PetError,
)
from .core.imports import MAX_IMAGE_BYTES, MAX_PACK_BYTES, check_payload_size
from .core.pack import (
    ACTION_FALLBACKS,
    LAYOUTS,
    MAX_FRAMES,
    MAX_IDLE_PLAYS,
    MAX_SCHEDULE_MS,
    MIN_SCHEDULE_MS,
    SCALE_RANGE,
    SCHEDULE_BEHAVIORS,
    STILL_ACTION,
)
from .core.paths import is_action_name
from .core.store import (
    CONFIG_KEYS,
    PET_ID_PATTERN,
    PetStore,
    clamp_scale,
    sanitize_pet_id,
)

logger = logging.getLogger(__name__)

#: 动作名（URL 段）的字符集。
_ACTION_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,64}$')


def _handle(func):
    """把 `PetError` 映射成结构化响应；未预期异常也绝不外泄堆栈。"""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except PetError as error:
            logger.warning('宠物插件请求失败 [%s]: %s', error.code, error.msg)
            return jsonify(error.to_dict()), error.http_status
        except Exception as exc:  # noqa: BLE001 - 兜底：任何异常都不能带出堆栈
            logger.exception('宠物插件请求出现未预期异常')
            return jsonify({
                'success': False,
                'msg': '插件内部错误，操作已取消。',
                'error': 'internal_error',
                'detail': {'type': type(exc).__name__},
            }), 500

    return wrapper


def _json_body() -> dict:
    """读取 JSON 请求体；非法时给结构化错误。"""
    payload = request.get_json(silent=True)
    if payload is None:
        # 有些调用方会把参数放在表单里
        payload = request.form.to_dict() or {}
    if not isinstance(payload, dict):
        raise PetError(
            CODE_IMAGE_INVALID,
            '请求体应为 JSON 对象',
            user_msg='请求格式不对。',
        )
    return payload


def _json_field(raw) -> dict:
    """解析表单里一个「JSON 字符串」字段；空值/非法都给空 dict（不报错）。

    做成容错的是因为它是**可选**的元数据（帧数/帧率）：用户没填就该走默认值，
    而不是让整次新建失败。
    """
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        logger.warning('表单里的 JSON 字段解析失败，按空值处理: %r', raw)
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _optional_bool(raw):
    """把表单里的三态布尔解析成 `True` / `False` / `None`（未提供）。

    必须区分「没给」与「给了 false」：前者表示「用包内声明 / 默认」，
    后者表示「用户明确要求关掉」。
    """
    if raw is None or raw == '':
        return None
    text = str(raw).strip().lower()
    if text in ('1', 'true', 'yes', 'on'):
        return True
    if text in ('0', 'false', 'no', 'off'):
        return False
    return None


def _read_upload(field: str = 'file', *, limit: int = MAX_IMAGE_BYTES) -> bytes:
    """从 multipart 表单里取一个上传文件；缺失/超限都给结构化错误。"""
    check_payload_size(request.content_length or 0)
    uploaded = request.files.get(field)
    if uploaded is None or not uploaded.filename:
        raise PetError(
            CODE_NO_UPLOAD,
            f'请求里没有文件字段 {field}',
            user_msg='没有收到文件，请重新选择。',
            hint=f'表单的文件字段名应为 "{field}"。',
        )

    # 先按声明长度粗筛，避免把超大文件整个读进内存
    uploaded.stream.seek(0, os.SEEK_END)
    declared = uploaded.stream.tell()
    uploaded.stream.seek(0)
    if declared > limit:
        check_payload_size(declared)
        raise PetError(
            'file_too_large',
            f'上传体积 {declared} 超过上限 {limit}',
            user_msg='这个文件太大了，请先压缩或换一张更小的图。',
            http_status=413,
        )

    data = uploaded.read(limit + 1)
    if len(data) > limit:
        raise PetError(
            'file_too_large',
            f'读取到的体积 {len(data)} 超过上限 {limit}',
            user_msg='这个文件太大了，请先压缩或换一张更小的图。',
            http_status=413,
        )
    return data


def register_routes(api, store: PetStore) -> None:
    """注册全部路由。"""

    def runtime(pet_id: str = '') -> dict:
        """统一的运行期定义出口（自动带上宿主的倍率默认值）。"""
        return store.runtime_pack(pet_id)

    # ---------------------------------------------------------------- 形象

    @api.http.route('/pets', ['GET'])
    @_handle
    def list_pets():
        """可用形象列表 + 当前形象 + 动作词表（前端一次性拿全）。"""
        items = store.list_pets()
        active = store.active_pet_id()
        return jsonify({
            'success': True,
            'items': items,
            'activePetId': active,
            # 扫描时因**目录名不合法**被跳过的目录。
            #
            # 为什么要回给前端：目录名就是形象 id（`_locate` 与帧 URL 全按它），
            # 而合法字符集是「小写字母/数字/. _ -」。用户把目录命名成
            # `xiaoka-自定义` 这种（很自然的中文命名）时，插件过去是**静默跳过**
            # 的——表现为「我明明放进去了，列表里却没有」，用户只能靠猜。
            'invalidDirs': list(getattr(store, '_invalid_dirs', []) or []),
            'actions': list(ACTION_FALLBACKS),
            'limits': {
                'maxImageBytes': MAX_IMAGE_BYTES,
                'maxPackBytes': MAX_PACK_BYTES,
                'scaleMin': SCALE_RANGE[0],
                'scaleMax': SCALE_RANGE[1],
                # 触发节奏的合法区间与可设置的行为（面板据此渲染滑块，
                # 不自己写死一份——两边写死必然不一致）。
                'scheduleMinMs': MIN_SCHEDULE_MS,
                'scheduleMaxMs': MAX_SCHEDULE_MS,
                'scheduleBehaviors': list(SCHEDULE_BEHAVIORS),
                'maxIdlePlays': MAX_IDLE_PLAYS,
                # 帧排布与网格上限（面板新建表单据此渲染「排布」选项，
                # 不自己写死一份——两边写死必然不一致）。
                'layouts': list(LAYOUTS),
                'maxFrames': MAX_FRAMES,
            },
        })

    @api.http.route('/pets/<pet_id>/runtime', ['GET'])
    @_handle
    def get_runtime(pet_id):
        """某形象的运行期定义：已解析好的动作 → 图 URL + 回退结论。

        前端不做回退决策——后端把结论算完，前端只按 `actions[<name>]` 播帧。
        """
        return jsonify({'success': True, 'pet': runtime(pet_id)})

    @api.http.route('/runtime', ['GET'])
    @_handle
    def get_active_runtime():
        """当前形象（含设置里的 noise 配置）——前端启动时调这一个就够。"""
        settings = store.get_settings()
        pet_id = store.active_pet_id()
        payload = {
            'success': True,
            'config': {key: settings.get(key) for key in settings},
            'activePetId': pet_id,
            'actions': list(ACTION_FALLBACKS),
        }
        if pet_id:
            payload['pet'] = runtime(pet_id)
        return jsonify(payload)

    @api.http.route('/frame/<pet_id>/<action>', ['GET'])
    @_handle
    def get_frame(pet_id, action):
        """返回某动作**某一套动画**实际生效的那张图（覆盖 > 包内 > 内置）。

        走插件自己的路由而不是宿主资产通路，原因见模块 docstring。

        `?vi=<n>` 选第几套动画（多套动画按权重随机选一套时用，默认第 0 套）；
        `?pg=<n>` 选第几**页**（多页 sheet，默认第 0 页）。
        """
        if not PET_ID_PATTERN.match(str(pet_id or '')):
            raise PetError(
                CODE_IMAGE_INVALID,
                f'形象 id 非法: {pet_id}',
                user_msg='形象标识不合法。',
                http_status=404,
            )
        if not _ACTION_PATTERN.match(str(action or '')) or not is_action_name(action):
            raise PetError(
                CODE_IMAGE_INVALID,
                f'动作名非法: {action}',
                user_msg='动作名不合法。',
                http_status=404,
            )

        try:
            variant = max(0, int(request.args.get('vi') or 0))
        except (TypeError, ValueError):
            # 非法参数按第 0 套处理，而不是 400：这是**图片**路由，
            # 前端拼 URL 时多一个脏参数不该让整张图取不到。
            variant = 0
        try:
            page = max(0, int(request.args.get('pg') or 0))
        except (TypeError, ValueError):
            page = 0

        path, source = store.resolve_frame_path(
            pet_id, action, variant=variant, page=page,
        )
        if not path or not os.path.isfile(path):
            raise PetError(
                'pack_animation_missing',
                f'动作 {action} 没有可用的图（第 {variant} 套、第 {page} 页）',
                user_msg='这个动作还没有图。',
                http_status=404,
            )

        extension = os.path.splitext(path)[1].lower()
        mime = {
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.avif': 'image/avif',
            '.svg': 'image/svg+xml',
        }.get(extension, 'application/octet-stream')

        try:
            response = send_file(path, mimetype=mime, conditional=True)
        except OSError as exc:
            logger.warning('读取形象帧失败 %s: %s', path, exc)
            raise PetError(
                CODE_IMAGE_INVALID,
                f'帧图读取失败: {exc}',
                user_msg='这张图读不出来。',
                http_status=404,
            ) from exc

        # 缓存策略取决于**调用方有没有带版本参数**：
        #
        # - 带 `?v=`（插件自己拼的 URL 就是这种，见 `store.frame_url`）：
        #   内容变了 URL 也变，因此可以给长缓存。常驻宠物每天要取这张图很多次，
        #   不缓存会让每次重绘都打后端。
        # - **不带** `?v=`：URL 与内容无关，长缓存会让「换了图却一直看到旧图」。
        #   这里退化为 `no-cache`（仍可缓存，但每次必须回源校验），
        #   靠 ETag 让未变时仍然是廉价的 304。
        #
        # 实测踩过：验收脚本直接 fetch 这个路由（不带 v），拿到的是一张
        # 7 天前诊断脚本留下的旧图，被误判成「上传没生效」。
        if request.args.get('v'):
            response.headers['Cache-Control'] = 'private, max-age=604800'
        else:
            response.headers['Cache-Control'] = 'private, no-cache'
        response.headers['X-Pet-Frame-Source'] = source
        return response

    @api.http.route('/pets/active', ['POST'])
    @_handle
    def set_active_pet():
        """切换当前形象。"""
        payload = _json_body()
        pet_id = sanitize_pet_id(payload.get('petId') or '')
        store.load_pack(pet_id)  # 不存在会抛 404
        settings = store.update_settings({'activePetId': pet_id})
        return jsonify({
            'success': True,
            'activePetId': settings['activePetId'],
            'pet': runtime(pet_id),
        })

    @api.http.route('/pets/<pet_id>', ['DELETE'])
    @_handle
    def delete_pet(pet_id):
        """删除一个**用户**形象（内置形象不可删）。"""
        removed = store.delete_pet(pet_id)
        if not removed:
            raise PetError(
                'pack_not_found',
                f'形象不可删除或不存在: {pet_id}',
                user_msg='这个形象删不掉（内置形象不能删除，或它已经不存在）。',
                http_status=404,
            )
        return jsonify({
            'success': True,
            'activePetId': store.active_pet_id(),
        })

    # ---------------------------------------------------------------- 导入

    @api.http.route('/pets/import', ['POST'])
    @_handle
    def import_pet():
        """导入一个宠物包 zip。"""
        data = _read_upload('file', limit=MAX_PACK_BYTES)
        replace = str(request.form.get('replace') or '').lower() in ('1', 'true', 'yes')
        payload = store.import_zip(data, replace=replace)
        # 导入后直接切过去：用户的意图就是「用这个形象」
        store.update_settings({'activePetId': payload['id']})
        return jsonify({
            'success': True,
            'pet': runtime(payload['id']),
            'activePetId': payload['id'],
        })

    @api.http.route('/pets/create', ['POST'])
    @_handle
    def create_pet():
        """**从零新建**一个用户形象（不需要 zip，也不需要手写 pet.json）。

        请求是 multipart：除 `name` / `author` 等标量字段外，每个动作一个文件字段，
        字段名就是动作名（`idle` / `walk-left` / …），配套的 `frames` / `fps` 走
        `meta` 这个 JSON 字段（`{"idle": {"frames": 4, "fps": 6}}`）。

        两个**结构化**字段也走 JSON 字符串：

        - `still`：标准图像。`{"data": <单独上传的文件字段名>}` 或
          `{"action": "idle", "frame": 2}`（复用某个动作的某一帧）。
          单独上传的图放在文件字段 `still` 里，这里写 `{"file": true}`。
        - `schedule`：触发节奏，`{"idle": {"intervalMs": [6000, 18000]}, ...}`。

        为什么用 multipart 而不是纯 JSON：图是二进制，base64 会让体积涨 33%
        且要自己处理解码；multipart 是浏览器原生能力（`FormData`），
        也让「一次提交多个动作的图」这件事天然成立。
        """
        payload = request.form.to_dict() or {}
        name = str(payload.get('name') or '').strip()

        # 每个动作一张图；字段名即动作名
        frames = {}
        meta = _json_field(payload.get('meta'))
        for field_name, uploaded in request.files.items():
            if not uploaded or not uploaded.filename:
                continue
            action = str(field_name or '').strip()
            if action == STILL_ACTION:
                # 标准图像走单独字段，不当作动作（见下）
                continue
            if not is_action_name(action):
                raise PetError(
                    CODE_IMAGE_INVALID,
                    f'上传字段名不是合法动作名: {action!r}',
                    user_msg='动作名不合法。',
                    hint='字段名只能是字母、数字、下划线或连字符（例如 idle）。',
                )
            spec = meta.get(action) if isinstance(meta.get(action), dict) else {}
            frames[action] = {
                'data': uploaded.read(MAX_IMAGE_BYTES + 1),
                'frames': spec.get('frames', 1),
                'fps': spec.get('fps'),
                'loop': spec.get('loop'),
            }

        if not frames:
            raise PetError(
                CODE_NO_UPLOAD,
                '新建形象的请求里没有任何图片',
                user_msg='没有收到图片，请重新选择。',
                hint='每个动作对应一个文件字段，字段名是动作名（例如 idle）。',
            )

        # ---- 标准图像
        #
        # 两种来源共用 `still` 这个字段名：`request.form` 里是 JSON 文本
        # （复用某个动作的某一帧），`request.files` 里是单独上传的图。
        # 前端按情况只填其中一个，这里把它们合并成 store 认的结构。
        still = _json_field(payload.get('still'))
        still_file = request.files.get('still')
        if still_file and still_file.filename:
            still = dict(still)
            still['data'] = still_file.read(MAX_IMAGE_BYTES + 1)
            # 单独上传的图**不能**同时带 `action`：那会让 store 走到
            # 「复用某个动作」那条路，从而把刚上传的图丢掉。
            still.pop('action', None)

        scale = payload.get('scale')
        pixelated = payload.get('pixelated')
        created = store.create_pet(
            name,
            frames,
            pet_id=payload.get('petId') or '',
            author=payload.get('author') or '',
            scale=clamp_scale(scale) if scale not in (None, '') else None,
            pixelated=_optional_bool(pixelated),
            still=still or None,
            schedule=_json_field(payload.get('schedule')) or None,
        )
        store.update_settings({'activePetId': created['id']})
        return jsonify({
            'success': True,
            'pet': runtime(created['id']),
            'activePetId': created['id'],
        })

    @api.http.route('/pets/<pet_id>/copy', ['POST'])
    @_handle
    def copy_pet(pet_id):
        """把一个形象（**含内置**）复制成可编辑的用户形象。

        为什么需要这个入口：内置形象严格只读（用户明确要求），而「在它基础上
        改速度 / 间隔 / 换几张图」是很自然的需求。此前唯一的路是手工复制
        `resources/pets/<id>/`，而那条路有两个坑（实测都绊到过用户）：

        1. **目录名就是形象 id**，只能用 `[a-z0-9._-]` 且以字母/数字开头。
           命名成 `xiaoka-自定义` 这类会被**整目录跳过**；
        2. **判定内置/自定义只看目录位置**，与 `pet.json` 写什么无关——
           复制到 `resources/pets/` 下仍然只读，改 id、改 author 都没用。

        这个入口由后端生成合法 id 并落到 `data/pets/`（= 可写）。
        """
        payload = request.get_json(silent=True) or {}
        pack = store.copy_pet(
            pet_id,
            name=str(payload.get('name') or '').strip(),
            author=str(payload.get('author') or '').strip(),
        )
        return jsonify({'success': True, 'pet': pack})

    @api.http.route('/pets/<pet_id>/meta', ['POST'])
    @_handle
    def update_pet_meta(pet_id):
        """改写**自建形象**的元信息：名字 / 作者 / 标准图像 / 触发节奏。

        与 `/appearance` 的分工：那个改的是「用户怎么看」（落在 `data/settings.json`，
        内置形象也能改）；这个改的是「形象本身」（写进 `pet.json`，只对自建形象开放）。

        传 `null` 表示**清除**该项：
        - `still: null` → 删掉标准图像声明，回落到 idle 首帧；
        - `schedule: null` → 删掉包内节奏声明，回落到默认值。
        """
        pet_id = sanitize_pet_id(pet_id)
        store.load_pack(pet_id)  # 不存在会抛 404
        payload = _json_body()

        kwargs = {}
        if 'name' in payload:
            kwargs['name'] = payload.get('name')
        if 'author' in payload:
            kwargs['author'] = payload.get('author')
        if 'still' in payload:
            still = payload.get('still')
            kwargs['still'] = {} if still in (None, '') else still
        if 'schedule' in payload:
            schedule = payload.get('schedule')
            kwargs['schedule'] = {} if schedule in (None, '') else schedule

        if not kwargs:
            return jsonify({'success': True, 'pet': runtime(pet_id)})
        pack = store.update_pet_meta(pet_id, **kwargs)
        return jsonify({'success': True, 'pet': runtime(pack['id'])})

    @api.http.route('/pets/<pet_id>/schedule', ['POST'])
    @_handle
    def update_pet_schedule(pet_id):
        """调整某形象的**触发节奏**（逐形象保存，内置形象同样可调）。

        用户要求「支持调整不同动作的触发时间」。真正由**时间驱动**的只有两个
        行为，因此这里只认它们：

        - `idle`：闲着时偶尔动一下（默认 6~18 秒一次）；
        - `roam`：闲着时自己在屏幕底部走一走（默认 3~9 秒一次）。

        其余动作由**事件**触发（`click` 要有人点、`fall` 要松手、`happy` 要有播报），
        给它们设「多久一次」没有意义——传了会得到明确错误，而不是静默忽略。

        为什么这两项落在**用户设置**而不是 `pet.json`：它们是「这台机器上怎么养」
        的偏好（有人喜欢活泼、有人嫌吵），而且**内置形象必须能调**——
        内置形象恰恰是大多数用户唯一会用的形象，而它是只读的。
        传 `null` 表示清除覆盖、回落到包内声明 / 默认值。
        """
        pet_id = sanitize_pet_id(pet_id)
        store.load_pack(pet_id)  # 不存在会抛 404
        payload = _json_body()

        if payload.get('reset'):
            store.clear_pet_schedule(pet_id)
        else:
            patch = payload.get('schedule')
            if not isinstance(patch, dict):
                raise PetError(
                    CODE_IMAGE_INVALID,
                    'schedule 应为对象',
                    user_msg='请求格式不对。',
                    hint='形如 {"idle": {"minIntervalMs": 6000, "maxIntervalMs": 18000}}。',
                )
            store.set_pet_schedule(pet_id, patch)

        return jsonify({'success': True, 'pet': runtime(pet_id)})

    @api.http.route('/pets/<pet_id>/export', ['GET'])
    @_handle
    def export_pet(pet_id):
        """导出一个形象包 zip（便于用户备份/搬运）。"""
        data = store.export_pet(pet_id)
        from flask import Response

        safe_name = sanitize_pet_id(pet_id)
        return Response(
            data,
            mimetype='application/zip',
            headers={
                'Content-Disposition': f'attachment; filename="{safe_name}.zip"',
                'Cache-Control': 'no-store',
            },
        )

    # ------------------------------------------------------------ 外观微调

    @api.http.route('/pets/<pet_id>/appearance', ['POST'])
    @_handle
    def update_appearance(pet_id):
        """调整某形象的**大小倍率 / 渲染方式 / 动画速度 / 自动漫游**（逐形象保存）。

        用户要求「大小开放给用户调节，以应对不同分辨率与不同形象」，
        因此这些都是**按形象**存的：换形象自动恢复各自的设置，不必每次重调。
        传 `null` 表示清除覆盖、回落到包内声明 / 默认值。

        内置形象**允许**调这些——它们都是「怎么看 / 怎么动」而不是「是什么」，
        改的是 `data/` 里的用户设置，从不碰随包资源。

        ⚠️ `animSpeed` 与 `autoRoam` 原本在宿主的 `config_schema` 里（全局），
        现已移到这里。理由（用户明确要求）：「不要搞全局的，在同一个地方
        调整的数值却分成全局和形象绑定两种情况，用户可能会困惑」。
        """
        pet_id = sanitize_pet_id(pet_id)
        store.load_pack(pet_id)  # 不存在会抛 404
        payload = _json_body()

        if 'scale' in payload:
            value = payload.get('scale')
            if value is None or value == '':
                store.clear_pet_scale(pet_id)
            else:
                store.set_pet_scale(pet_id, value)

        if 'pixelated' in payload:
            flag = payload.get('pixelated')
            if flag is None or flag == '':
                store.clear_pet_pixelated(pet_id)
            else:
                if not isinstance(flag, bool):
                    raise PetError(
                        CODE_IMAGE_INVALID,
                        f'pixelated 应为布尔值，实际 {type(flag).__name__}',
                        user_msg='渲染方式只能是开或关。',
                    )
                store.set_pet_pixelated(pet_id, flag)

        if 'animSpeed' in payload:
            value = payload.get('animSpeed')
            if value is None or value == '':
                store.clear_pet_anim_speed(pet_id)
            else:
                store.set_pet_anim_speed(pet_id, value)

        if 'autoRoam' in payload:
            flag = payload.get('autoRoam')
            if flag is None or flag == '':
                store.clear_pet_auto_roam(pet_id)
            else:
                if not isinstance(flag, bool):
                    raise PetError(
                        CODE_IMAGE_INVALID,
                        f'autoRoam 应为布尔值，实际 {type(flag).__name__}',
                        user_msg='自动漫游只能是开或关。',
                    )
                store.set_pet_auto_roam(pet_id, flag)

        return jsonify({'success': True, 'pet': runtime(pet_id)})

    @api.http.route('/pets/<pet_id>/actions/<action>/animation', ['POST'])
    @_handle
    def update_action_animation(pet_id, action):
        """改写某动作的**动画参数**（帧率 / 每帧时长 / 循环 / 排布 / 权重 / 运动）。

        用户要求：「pet.json 里面支持了非常多的调节参数，结果界面上没多少
        能调整的……比如我想调整下不同动作的帧率，每帧之间的间隔，
        结果发现没有入口，目前只能去直接修改 pet.json 里面的值」。

        写的是**包本身**（`pet.json`），因此只对用户自建形象开放——
        内置形象是随包发布的资源（先「复制为我的形象」再改）。

        请求体两种写法（二选一）：
        - `{"variant": 0, "patch": {"fps": 3, "loop": false, ...}}` —— 改一套；
        - `{"patches": [{"variant": 0, "patch": {...}}, ...]}` —— **多套一起改**。

        面板用后者：一个动作可以挂多套互相替代的动画（每次触发按权重随机
        选一套），用户在选套器上来回切着改了两套，一次保存应当一起生效。
        分多次请求的话中途失败会留下「改了一半」的包。

        `patch` 里某个键传 `null` 表示**删除该字段**（回落到默认值）。
        """
        payload = _json_body()
        pack = store.update_action_animation(
            pet_id, action,
            patch=payload.get('patch') if 'patch' in payload else None,
            variant=int(payload.get('variant') or 0),
            patches=payload.get('patches'),
        )
        return jsonify({'success': True, 'pet': pack})

    @api.http.route('/pets/<pet_id>/physics', ['POST'])
    @_handle
    def update_pet_physics(pet_id):
        """改写某形象的**物理参数**（重力 / 走速 / 摩擦 / 终端速度 / 弹性）。

        用户要求把这类「比较容易出问题的设置项」也开放出来，让用户自己决定，
        并在帮助页里说清风险。写的是包本身，因此只对自建形象开放。
        """
        payload = _json_body()
        patch = payload.get('patch')
        if not isinstance(patch, dict):
            raise PetError(
                CODE_WRITE_FAILED, 'patch 应为对象',
                user_msg='物理设置格式不对。',
            )
        pack = store.update_pet_physics(pet_id, patch)
        return jsonify({'success': True, 'pet': pack})

    @api.http.route('/pets/<pet_id>/layout', ['POST'])
    @_handle
    def update_pet_layout(pet_id):
        """改写某形象的**锚点 / 单帧尺寸 / 倍率 / 动画速度 / 自动漫游**等形象级字段。

        与 `/appearance` 的分工：那个改的是「用户怎么看」（落在
        `data/settings.json`，内置形象也能改）；这个改的是「形象本身」
        （写进 `pet.json`，只对自建形象开放）。

        ⚠️ `scale` / `animSpeed` / `autoRoam` 三个键**两边都能写**，
        但含义不同：`/appearance` 写的是**用户的偏好**（优先级更高），
        这里写的是**作者在包里声明的建议值**。面板据此区分
        「我调的」与「作者建议的」。
        """
        payload = _json_body()
        patch = payload.get('patch')
        if not isinstance(patch, dict):
            raise PetError(
                CODE_WRITE_FAILED, 'patch 应为对象',
                user_msg='设置格式不对。',
            )
        pack = store.update_pet_layout(pet_id, patch)
        return jsonify({'success': True, 'pet': pack})

    @api.http.route('/pets/<pet_id>/overrides', ['DELETE'])
    @_handle
    def clear_overrides(pet_id):
        """清掉某形象**全部**遗留覆盖图（内置形象的「一键清理」）。

        内置形象改为只读后，早先留下的覆盖文件不再生效。这里让用户自己决定
        什么时候清掉它们——**不静默删除用户数据**。
        """
        pet_id = sanitize_pet_id(pet_id)
        store.load_pack(pet_id)  # 不存在会抛 404
        removed = store.clear_pet_overrides(pet_id)
        return jsonify({
            'success': True,
            'removed': removed,
            'pet': runtime(pet_id),
        })

    # ------------------------------------------------------- 单动作图覆盖

    @api.http.route('/pets/<pet_id>/actions/<action>', ['POST'])
    @_handle
    def upload_action_image(pet_id, action):
        """上传/替换某个动作的图（单动作覆盖，不改包内原图）。"""
        if not _ACTION_PATTERN.match(str(action or '')) or not is_action_name(action):
            raise PetError(
                CODE_IMAGE_INVALID,
                f'动作名非法: {action}',
                user_msg='动作名不合法。',
                hint='动作名只能是字母、数字、下划线或连字符。',
            )
        data = _read_upload('file')
        output_format = str(request.form.get('format') or 'png').lower()
        if output_format not in ('png', 'webp'):
            output_format = 'png'

        payload = store.save_action_image(
            pet_id, action, data, output_format=output_format,
        )
        return jsonify({'success': True, 'override': payload})

    @api.http.route('/pets/<pet_id>/actions/<action>/variants', ['POST'])
    @_handle
    def add_action_variant(pet_id, action):
        """给某个动作**再加一套**动画（多套互相替代，按权重随机选一套）。

        用户报障：「每个动作我可以点击换图来进行动画帧图的更新，但是只能更新啊，
        我如果像增加一套闲置动作，入口在哪里」——这是那个入口。

        与「换图」的区别：换图**替换**这一套的图（写进 `overrides/`），
        这个**新增一套**（写进形象目录、成为包的一部分，随导出走）。

        表单字段：`file`（必填）、`frames`（默认 1）、`weight`（默认 1）、
        `format`（`png` / `webp`）。
        """
        if not _ACTION_PATTERN.match(str(action or '')) or not is_action_name(action):
            raise PetError(
                CODE_IMAGE_INVALID, f'动作名非法: {action}',
                user_msg='动作名不合法。',
            )
        data = _read_upload('file')
        output_format = str(request.form.get('format') or 'png').lower()
        if output_format not in ('png', 'webp'):
            output_format = 'png'
        try:
            frames = int(request.form.get('frames') or 1)
        except (TypeError, ValueError):
            frames = 1
        try:
            weight = float(request.form.get('weight') or 1)
        except (TypeError, ValueError):
            weight = 1.0

        payload = store.add_action_variant(
            pet_id, action, data,
            frames=frames, weight=weight, output_format=output_format,
        )
        return jsonify({'success': True, 'variant': payload, 'pet': runtime(pet_id)})

    @api.http.route('/pets/<pet_id>/actions/<action>/variants/<int:variant>', ['DELETE'])
    @_handle
    def delete_action_variant(pet_id, action, variant):
        """删掉某动作的**一套**动画（至少保留一套）。"""
        payload = store.remove_action_variant(pet_id, action, variant)
        return jsonify({'success': True, 'removed': payload, 'pet': runtime(pet_id)})

    @api.http.route('/pets/<pet_id>/actions/<action>/variants/<int:variant>/pages', ['POST'])
    @_handle
    def split_action_variant_pages(pet_id, action, variant):
        """把某一套动画的图**拆成 N 页**（降低解码峰值显存）。

        用户问「我如果想设置多页的动作，入口又在哪里」——这是那个入口。

        请求体：`{"pages": 2}`。拆出来的是按**行**等分的 N 张图，
        每页仍是同一个网格排布，帧序不变（页优先、页内行优先）。
        """
        payload = _json_body()
        try:
            pages = int(payload.get('pages') or 1)
        except (TypeError, ValueError):
            pages = 1
        result = store.split_action_variant_pages(
            pet_id, action, pages, variant=variant,
        )
        return jsonify({'success': True, 'split': result, 'pet': runtime(pet_id)})

    @api.http.route('/pets/<pet_id>/actions/<action>', ['DELETE'])
    @_handle
    def delete_action_image(pet_id, action):
        """删除某动作的覆盖图（回落到包内原图）。"""
        if not _ACTION_PATTERN.match(str(action or '')) or not is_action_name(action):
            raise PetError(CODE_IMAGE_INVALID, f'动作名非法: {action}', user_msg='动作名不合法。')
        removed = store.delete_action_override(pet_id, action)
        return jsonify({
            'success': True,
            'removed': removed,
            'pet': runtime(pet_id),
        })

    # ------------------------------------------------------------ 显示开关

    @api.http.route('/visibility', ['GET', 'POST'])
    @_handle
    def pet_visibility():
        """宠物是否显示（**关闭宠物**的开关）。

        用户要求：「插件应该支持关闭宠物，目前好像只有卸载或者停用宠物插件
        才能关闭，不太合理」。确实不合理——想安静一会儿却要卸载插件，
        代价完全不对等。

        语义边界（很重要）：

        - 关掉的是**宠物本身**，不是插件。插件仍然加载、设置面板仍能打开、
          坞入口仍然在——否则用户关掉之后就没有任何入口把它开回来了。
        - 不碰宿主的插件启用状态（那是宿主的东西，插件不该改）。

        `GET` 读当前状态，`POST` 写入：
        - `{"hidden": true}` 隐藏；`{"hidden": false}` 显示；
        - 不传 `hidden` 时**取反**（面板上的开关按钮就是这么用的，
          省掉一次「先读再写」的往返）。
        """
        if request.method == 'GET':
            return jsonify({'success': True, 'hidden': store.is_hidden()})

        payload = _json_body()
        if 'hidden' in payload:
            raw = payload.get('hidden')
            if not isinstance(raw, bool):
                raise PetError(
                    CODE_IMAGE_INVALID,
                    f'hidden 应为布尔值，实际 {type(raw).__name__}',
                    user_msg='开关只能是开或关。',
                )
            hidden = store.set_hidden(raw)
        else:
            hidden = store.set_hidden(not store.is_hidden())
        return jsonify({'success': True, 'hidden': hidden})

    # ---------------------------------------------------------------- 设置

    @api.http.route('/settings', ['GET'])
    @_handle
    def get_settings():
        """读取插件私有设置（标量配置在宿主的 config_schema，这里只给结构化部分）。"""
        return jsonify({
            'success': True,
            'settings': store.get_settings(),
            'configKeys': list(CONFIG_KEYS),
        })

    @api.http.route('/settings', ['POST'])
    @_handle
    def update_settings():
        """写入插件私有设置。"""
        settings = store.update_settings(_json_body())
        return jsonify({'success': True, 'settings': settings})

    # ---------------------------------------------------------------- 预览

    @api.http.route('/pets/<pet_id>/preview', ['GET'])
    @_handle
    def preview_pet(pet_id):
        """形象的**预览数据**：每个动作的来源与是否可播，供设置页解释回退。

        同时也是**动画预览器**（设置页的「播放」按钮）的数据源：
        每套动画的图 URL、帧数、帧率、非均匀帧时长与权重都在这里，
        前端因此不必自己拼 URL，也不必猜帧几何。
        """
        pack = runtime(pet_id)
        summary = []
        for action, entry in pack['actions'].items():
            variants = []
            for index, variant in enumerate(entry.get('variants') or []):
                variants.append({
                    'index': index,
                    'url': variant.get('url', ''),
                    # 多页：每一页的 URL。**必须透传**，否则面板预览器
                    # 只播得到第一页——而后端与桌面宠物都在正常切页，
                    # 表现为「桌面上对、面板预览里只播前几帧」。
                    'pages': variant.get('pages') or [],
                    'frames': variant.get('frames'),
                    'fps': variant.get('fps'),
                    'loop': variant.get('loop'),
                    'layout': variant.get('layout'),
                    # 网格几何。预览器**只**用这两个值算切帧偏移——
                    # `layout` 只是给用户看的名字，真正决定「第 n 帧在哪」的是
                    # 行列数（`horizontal` / `vertical` 都是它的特例）。
                    'cols': variant.get('cols'),
                    'rows': variant.get('rows'),
                    'frameMs': variant.get('frameMs') or [],
                    'weight': variant.get('weight'),
                    'frameSource': variant.get('frameSource'),
                    # 显存估算：面板要把它显示给用户（用户看不到显存，
                    # 因此「这个形象重不重」只能由插件告诉他）。
                    'decodeBytes': variant.get('decodeBytes') or 0,
                    'pageCount': variant.get('pageCount') or 1,
                    # 动图容器：面板要显示徽章、改帧读数、列提醒，
                    # 全都靠这三个字段（缺了就会把它当成「单帧静态」）。
                    'animated': bool(variant.get('animated')),
                    'animatedFrames': variant.get('animatedFrames') or 1,
                    'warnings': list(variant.get('warnings') or []),
                    # 程序化运动：面板预览器要一起应用它，否则会出现
                    # 「桌面上在呼吸、面板里不动」——而面板正是用户判断
                    # 效果的地方。
                    'motion': variant.get('motion') or None,
                    'motionOrigin': variant.get('motionOrigin') or '',
                    # 单帧尺寸（可能缺省 = 沿用包级）。
                    #
                    # 必须透传：面板的预览框要按**真实宽高比**把这一帧装进去，
                    # 而躺姿睡觉这类动作是横构图（例如 627×353），
                    # 不知道尺寸就只能按包级的竖构图去铺，图会被压扁。
                    # 与 `/runtime` 的 `actions` 保持同一套字段名。
                    'size': variant.get('size'),
                })
            summary.append({
                'action': action,
                'kind': entry.get('kind'),
                'source': entry.get('source'),
                'frameSource': entry.get('frameSource'),
                'frames': entry.get('frames'),
                'fps': entry.get('fps'),
                'loop': entry.get('loop'),
                'layout': entry.get('layout'),
                'cols': entry.get('cols'),
                'rows': entry.get('rows'),
                # 多页：主变体的页数组（前端不必先钻进 `variants` 才知道有几页）
                'pages': entry.get('pages') or [],
                'decodeBytes': entry.get('decodeBytes') or 0,
                'pageCount': entry.get('pageCount') or 1,
                # 动图容器（见变体层的说明）
                'animated': bool(entry.get('animated')),
                'animatedFrames': entry.get('animatedFrames') or 1,
                'warnings': list(entry.get('warnings') or []),
                'motion': entry.get('motion') or None,
                'motionOrigin': entry.get('motionOrigin') or '',
                'frameMs': entry.get('frameMs') or [],
                'url': entry.get('url'),
                'note': entry.get('note'),
                # 动作级尺寸（作者在该动作的动画声明里覆盖包级时才有）。
                # 它是变体尺寸缺失时的回落值，见 `frameSizeOf`。
                'size': entry.get('size'),
                'overridden': action in pack['overrides'],
                'variants': variants,
            })
        return jsonify({
            'success': True,
            'id': pack['id'],
            'name': pack['name'],
            'author': pack.get('author', ''),
            'source': pack.get('source', ''),
            'size': pack.get('size'),
            # 锚点与物理参数：面板的「进阶」区块要拿它们渲染编辑控件。
            # 这两项**只能写回 pet.json**（它们描述的是形象本身，
            # 不是「用户怎么看」），因此内置形象只读。
            'anchor': pack.get('anchor'),
            'physics': pack.get('physics'),
            'scale': pack.get('scale'),
            'pixelated': pack.get('pixelated'),
            'declaredScale': pack.get('declaredScale'),
            'declaredPixelated': pack.get('declaredPixelated'),
            # 动画速度与自动漫游（**按形象**）。面板要拿它们渲染滑块 /
            # 开关，并显示「作者建议 / 已覆盖」的对比。
            'animSpeed': pack.get('animSpeed'),
            'autoRoam': pack.get('autoRoam'),
            'declaredAnimSpeed': pack.get('declaredAnimSpeed'),
            'declaredAutoRoam': pack.get('declaredAutoRoam'),
            'writable': pack.get('writable', True),
            # `pet.json` 的 `id` 与**目录名**不一致（见 `store._describe`）。
            #
            # 两者是同一个东西的两个来源，而**目录名**才是生效的那个
            # （`_locate` / 帧 URL / 覆盖解析全按它）。用户复制内置形象时
            # 很容易只改 `pet.json` 的 id（「我改了 id，还是不行」），
            # 于是列表里的 id 与文件里写的对不上。这里透传给面板提示。
            'idMismatch': pack.get('idMismatch') or None,
            'overrides': pack.get('overrides', []),
            'staleOverrides': pack.get('staleOverrides', []),
            'missingRequired': pack['missingRequired'],
            # 显存预算：面板据此判断「这个动作重不重」并给出提示。
            'decodeBytes': pack.get('decodeBytes', 0),
            'decodeBudgetBytes': pack.get('decodeBudgetBytes', 0),
            # 标准图像（不播动画时显示的那一帧）。面板用它在预览区标出
            # 「静止时会显示这一张」，并让用户知道当前是作者声明的还是回落的。
            'still': pack.get('still'),
            # 触发节奏：生效值 + 包内声明值（供面板显示「已覆盖 / 作者建议」）。
            'schedule': pack.get('schedule'),
            'declaredSchedule': pack.get('declaredSchedule'),
            'scheduleOverridden': pack.get('scheduleOverridden', False),
            # ★ 不再下发 `hostSleepAfter`。
            #
            # 打盹阈值现在是**纯按形象**的（用户要求「不要搞全局的」）：
            # `schedule.sleep.afterMs` 为 `null` 表示「用默认值 120 秒」，
            # 而不是「跟随宿主全局」——宿主那个 `sleep_after` 已从
            # `config_schema` 移除。
            'actions': summary,
        })
