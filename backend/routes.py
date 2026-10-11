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
from .core.pack import ACTION_FALLBACKS
from .core.paths import is_action_name
from .core.store import CONFIG_KEYS, PET_ID_PATTERN, PetStore, sanitize_pet_id

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

    # ---------------------------------------------------------------- 形象

    @api.route('/pets', ['GET'])
    @_handle
    def list_pets():
        """可用形象列表 + 当前形象 + 动作词表（前端一次性拿全）。"""
        items = store.list_pets()
        active = store.active_pet_id()
        return jsonify({
            'success': True,
            'items': items,
            'activePetId': active,
            'actions': list(ACTION_FALLBACKS),
            'limits': {
                'maxImageBytes': MAX_IMAGE_BYTES,
                'maxPackBytes': MAX_PACK_BYTES,
            },
        })

    @api.route('/pets/<pet_id>/runtime', ['GET'])
    @_handle
    def get_runtime(pet_id):
        """某形象的运行期定义：已解析好的动作 → 图 URL + 回退结论。

        前端不做回退决策——后端把结论算完，前端只按 `actions[<name>]` 播帧。
        """
        return jsonify({'success': True, 'pet': store.runtime_pack(pet_id)})

    @api.route('/runtime', ['GET'])
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
            payload['pet'] = store.runtime_pack(pet_id)
        return jsonify(payload)

    @api.route('/frame/<pet_id>/<action>', ['GET'])
    @_handle
    def get_frame(pet_id, action):
        """返回某动作实际生效的那张图（覆盖 > 包内 > 内置）。

        走插件自己的路由而不是宿主资产通路，原因见模块 docstring。
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

        path, source = store.resolve_frame_path(pet_id, action)
        if not path or not os.path.isfile(path):
            raise PetError(
                'pack_animation_missing',
                f'动作 {action} 没有可用的图',
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

    @api.route('/pets/active', ['POST'])
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
            'pet': store.runtime_pack(pet_id),
        })

    @api.route('/pets/<pet_id>', ['DELETE'])
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

    @api.route('/pets/import', ['POST'])
    @_handle
    def import_pet():
        """导入一个宠物包 zip。"""
        data = _read_upload('file', limit=MAX_PACK_BYTES)
        replace = str(request.form.get('replace') or '').lower() in ('1', 'true', 'yes')
        payload = store.import_zip(data, replace=replace)
        # 导入后直接切过去：用户的意图就是「用这个形象」
        store.update_settings({'activePetId': payload['id']})
        return jsonify({'success': True, 'pet': payload, 'activePetId': payload['id']})

    @api.route('/pets/<pet_id>/export', ['GET'])
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

    # ------------------------------------------------------- 单动作图覆盖

    @api.route('/pets/<pet_id>/actions/<action>', ['POST'])
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

    @api.route('/pets/<pet_id>/actions/<action>', ['DELETE'])
    @_handle
    def delete_action_image(pet_id, action):
        """删除某动作的覆盖图（回落到包内原图）。"""
        if not _ACTION_PATTERN.match(str(action or '')) or not is_action_name(action):
            raise PetError(CODE_IMAGE_INVALID, f'动作名非法: {action}', user_msg='动作名不合法。')
        removed = store.delete_action_override(pet_id, action)
        return jsonify({
            'success': True,
            'removed': removed,
            'pet': store.runtime_pack(pet_id),
        })

    # ---------------------------------------------------------------- 设置

    @api.route('/settings', ['GET'])
    @_handle
    def get_settings():
        """读取插件私有设置（标量配置在宿主的 config_schema，这里只给结构化部分）。"""
        return jsonify({
            'success': True,
            'settings': store.get_settings(),
            'configKeys': list(CONFIG_KEYS),
        })

    @api.route('/settings', ['POST'])
    @_handle
    def update_settings():
        """写入插件私有设置。"""
        settings = store.update_settings(_json_body())
        return jsonify({'success': True, 'settings': settings})

    # ---------------------------------------------------------------- 预览

    @api.route('/pets/<pet_id>/preview', ['GET'])
    @_handle
    def preview_pet(pet_id):
        """形象的**预览数据**：每个动作的来源与是否可播，供设置页解释回退。"""
        runtime = store.runtime_pack(pet_id)
        summary = []
        for action, entry in runtime['actions'].items():
            summary.append({
                'action': action,
                'kind': entry.get('kind'),
                'source': entry.get('source'),
                'frameSource': entry.get('frameSource'),
                'frames': entry.get('frames'),
                'fps': entry.get('fps'),
                'url': entry.get('url'),
                'note': entry.get('note'),
                'overridden': action in runtime['overrides'],
            })
        return jsonify({
            'success': True,
            'id': runtime['id'],
            'name': runtime['name'],
            'missingRequired': runtime['missingRequired'],
            'actions': summary,
        })
