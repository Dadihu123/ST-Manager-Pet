"""错误码与统一异常。

纯逻辑层：不依赖 Flask，也不依赖主程序模块，便于独立单测。

设计约束（实施提示词 §1.2）：
- **不得**把 traceback 塞进 API 响应；响应是结构化的 `{success, msg, error, ...}`。
- 面向用户的错误必须可读。因此 `PetError` 同时带三样东西：
  - `msg`：一句话说清**发生了什么**（弹 toast / 显示在表单下方）；
  - `user_msg`：**用户该怎么办**的完整句子（形如「这张图 5000×5000，超过 4096×4096 上限」）；
  - `hint`：面向**包作者**的修复建议（形如「把 sheet 拆成多帧，或缩小单帧尺寸」）。

`user_msg` / `hint` 对「畸形宠物包」尤其重要——包的作者不一定是程序员，
只回一个 `parse_failed` 无法让他知道改哪里。
"""


class PetError(Exception):
    """宠物插件统一异常：错误码 + 面向用户/作者的说明。"""

    def __init__(
        self,
        code: str,
        msg: str = '',
        *,
        user_msg: str = '',
        hint: str = '',
        http_status: int = 400,
        detail=None,
    ):
        super().__init__(msg or code)
        self.code = str(code or CODE_INVALID_PAYLOAD)
        self.msg = str(msg or '')
        self.user_msg = str(user_msg or '')
        self.hint = str(hint or '')
        self.http_status = int(http_status)
        self.detail = detail if detail is not None else {}

    def to_dict(self) -> dict:
        """结构化响应体（不含堆栈）。"""
        payload = {
            'success': False,
            'msg': self.user_msg or self.msg or self.code,
            'error': self.code,
        }
        if self.hint:
            payload['hint'] = self.hint
        if self.detail:
            payload['detail'] = self.detail
        return payload


# ---- 包格式 ----
CODE_INVALID_PAYLOAD = 'invalid_payload'
CODE_PACK_UNREADABLE = 'pack_unreadable'
CODE_PACK_JSON_INVALID = 'pack_json_invalid'
CODE_PACK_FIELD_INVALID = 'pack_field_invalid'
CODE_PACK_ANIMATION_MISSING = 'pack_animation_missing'
CODE_PACK_IDLE_MISSING = 'pack_animation_idle_missing'
CODE_PACK_SHEET_MISSING = 'pack_sheet_missing'
CODE_PACK_NOT_FOUND = 'pack_not_found'

# ---- 导入安全 ----
CODE_UNSUPPORTED_FORMAT = 'unsupported_format'
CODE_IMAGE_INVALID = 'image_invalid'
CODE_IMAGE_TOO_LARGE = 'image_too_large'
CODE_FILE_TOO_LARGE = 'file_too_large'
CODE_PAYLOAD_TOO_LARGE = 'payload_too_large'
CODE_PATH_ESCAPE = 'path_escape'
CODE_ARCHIVE_INVALID = 'archive_invalid'
CODE_NO_UPLOAD = 'no_upload'

# ---- 用户数据 ----
CODE_WRITE_FAILED = 'write_failed'
CODE_DELETE_FAILED = 'delete_failed'
CODE_PET_IN_USE = 'pet_in_use'
#: 试图修改插件自带的形象（内置形象严格只读）。
CODE_BUILTIN_READONLY = 'builtin_readonly'
#: 试图导出插件自带的形象（导出只对用户自建形象开放）。
CODE_BUILTIN_NO_EXPORT = 'builtin_no_export'

ALL_CODES = frozenset({
    CODE_INVALID_PAYLOAD, CODE_PACK_UNREADABLE, CODE_PACK_JSON_INVALID,
    CODE_PACK_FIELD_INVALID, CODE_PACK_ANIMATION_MISSING, CODE_PACK_IDLE_MISSING,
    CODE_PACK_SHEET_MISSING, CODE_PACK_NOT_FOUND,
    CODE_UNSUPPORTED_FORMAT, CODE_IMAGE_INVALID, CODE_IMAGE_TOO_LARGE,
    CODE_FILE_TOO_LARGE, CODE_PAYLOAD_TOO_LARGE, CODE_PATH_ESCAPE,
    CODE_ARCHIVE_INVALID, CODE_NO_UPLOAD,
    CODE_WRITE_FAILED, CODE_DELETE_FAILED, CODE_PET_IN_USE,
    CODE_BUILTIN_READONLY, CODE_BUILTIN_NO_EXPORT,
})
