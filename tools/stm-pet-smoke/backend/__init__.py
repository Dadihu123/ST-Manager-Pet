"""阶段 0 冒烟插件后端：不注册任何路由，只为满足 `backend.entry` 契约。"""

import logging

logger = logging.getLogger(__name__)


def register(api):
    """冒烟插件不需要后端能力。"""
    logger.info('pet smoke plugin registered (no routes)')
