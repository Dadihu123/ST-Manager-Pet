/**
 * 事件播报（含**限流**与**勿扰**）。
 *
 * 为什么必须限流（§4.4 / §8 陷阱 11）：
 * `card.updated` 在批量操作时会高频触发——用户选 500 张卡改标签，宿主会推 500 次。
 * 不限流的话宠物会疯狂抽搐，用户会以为插件坏了。
 *
 * 勿扰模式（`quietMode`）是**插件自实现**的（宿主侧未做，§0.1）：
 * 开启后只换动作、不弹 toast，且不在全屏遮罩 / 对话框期间打扰。
 */

/** 默认限流窗口（毫秒）：同一「簇」事件在这个窗口内只播一次。 */
export const DEFAULT_COOLDOWN = 3000;

/** 扫描/索引这类「完成」事件之间的最小间隔（毫秒）。 */
export const JOB_COOLDOWN = 1000;

/** toast 文案的长度上限意识：宿主轻提示不适合长文本（§4.4）。 */
const MAX_TOAST_CHARS = 60;

/**
 * 创建播报器。
 *
 * @param {object} options
 * @param {function} options.onAnnounce `(action, reason, payload)` 真正触发宠物反应
 * @param {function} options.toast `(message)` 弹宿主轻提示
 * @param {function} options.getQuiet `() => boolean` 是否勿扰
 * @param {function} options.getShowToast `() => boolean` 是否弹提示
 * @param {function} options.log `(level, message)` 日志
 * @param {function} options.now `() => number` 注入时钟（测试用确定性时钟）
 */
export function createAnnouncer(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cooldown = Number(options.cooldown) || DEFAULT_COOLDOWN;
  const jobCooldown = Number(options.jobCooldown) || JOB_COOLDOWN;

  const onAnnounce = typeof options.onAnnounce === 'function' ? options.onAnnounce : () => {};
  const toast = typeof options.toast === 'function' ? options.toast : () => {};
  const getQuiet = typeof options.getQuiet === 'function' ? options.getQuiet : () => false;
  const getShowToast = typeof options.getShowToast === 'function' ? options.getShowToast : () => false;
  const log = typeof options.log === 'function' ? options.log : () => {};

  /** 上一次播报的时间戳，按「通道」分开计时。 */
  const lastAt = { cards: -Infinity, jobs: -Infinity };
  /** 本窗口内被限流掉的次数（用于日志与调试）。 */
  let suppressed = 0;
  /** 延迟执行的「尾随播报」定时器（见下）。 */
  let trailingTimer = 0;

  function clearTrailing() {
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      trailingTimer = 0;
    }
  }

  /**
   * 安全地调用外部回调。
   *
   * `onAnnounce` / `toast` 可能抛错（例如视图已被销毁、宿主的 toast store 不存在）。
   * 不接住的话，尾随补播路径上的异常会成为 `setTimeout` 里的**未捕获异常**，
   * 那既刷控制台又可能中断后续播报。这里降级为一条警告日志。
   */
  function safeCall(fn, ...args) {
    try {
      fn(...args);
    } catch (error) {
      try {
        log('warning', `播报回调失败：${error && error.message}`);
      } catch {
        // 连日志都失败就只能放弃了（绝不再抛）
      }
    }
  }

  /**
   * 限流判定。
   *
   * 用**前导 + 尾随**（leading + trailing）而不是纯丢弃：
   * 批量操作的第一张卡立刻让宠物反应（用户马上看到「它注意到了」），
   * 之后 3 秒内的都被吞掉——但**最后**那一次会在窗口结束时补播一次，
   * 这样批量操作结束时宠物会再动一下，而不是"开头动一下就彻底没反应"。
   */
  function throttle(channel, gap, fire) {
    const stamp = now();
    const elapsed = stamp - lastAt[channel];
    if (elapsed >= gap) {
      lastAt[channel] = stamp;
      fire();
      return true;
    }

    suppressed += 1;
    const remaining = gap - elapsed;
    // 尾随补播：只保留最后一次（重复调用会重置定时器）
    clearTrailing();
    trailingTimer = setTimeout(() => {
      trailingTimer = 0;
      lastAt[channel] = now();
      fire();
    }, remaining);
    return false;
  }

  function trim(message) {
    const text = String(message || '').trim();
    if (text.length <= MAX_TOAST_CHARS) return text;
    return `${text.slice(0, MAX_TOAST_CHARS - 1)}…`;
  }

  /** 是否应该完全静默（勿扰 + 遮罩期间）。 */
  function shouldStayQuiet() {
    return getQuiet() === true;
  }

  return {
    /** 卡片类事件（高频，必须限流）。 */
    cardEvent(name) {
      const action = name === 'card.deleted' ? 'sad' : 'happy';
      const fired = throttle('cards', cooldown, () => {
        safeCall(onAnnounce, action, name, {});
      });
      if (!fired) log('debug', `${name} 触发限流（窗口 ${cooldown}ms 内）`);
      return fired;
    },

    /**
     * 扫描 / 索引完成。
     *
     * 这两个事件**没有任何 UI 动作触发**，是后端通路价值的直接体现（§2.2），
     * 因此即使勿扰也**换动作**——只是不弹 toast。
     */
    jobEvent(name, payload = {}) {
      const action = 'happy';
      const described = this.describe(name, payload);
      const fired = throttle('jobs', jobCooldown, () => {
        safeCall(onAnnounce, action, name, payload);
        if (!shouldStayQuiet() && getShowToast()) {
          safeCall(toast, trim(described));
        }
      });
      if (!fired) log('debug', `${name} 触发限流`);
      return fired;
    },

    /** 生成播报文案（短，适合宿主轻提示）。 */
    describe(name, payload = {}) {
      if (name === 'scan.completed') {
        const count = Number(payload.count ?? payload.total ?? payload.scanned);
        return Number.isFinite(count) && count > 0
          ? `扫描完成：${count} 项`
          : '扫描完成';
      }
      if (name === 'index.job_done') {
        return '索引构建完成';
      }
      if (name === 'card.updated') return '卡片已更新';
      if (name === 'card.created') return '新建卡片';
      if (name === 'card.deleted') return '卡片已删除';
      if (name === 'card.moved') return '卡片已移动';
      if (name === 'tag.applied') return '标签已应用';
      if (name === 'worldbook.saved') return '世界书已保存';
      return name;
    },

    /** 主动播报一个动作（供外部/设置面板"预览"用）。 */
    announce(action, reason = 'manual') {
      safeCall(onAnnounce, action, reason, {});
    },

    /** 统计信息（测试与排查用）。 */
    get stats() {
      return { suppressed, lastAt: Object.assign({}, lastAt) };
    },

    /** 重置限流窗口（配置变更 / 测试用）。 */
    reset() {
      clearTrailing();
      lastAt.cards = -Infinity;
      lastAt.jobs = -Infinity;
      suppressed = 0;
    },

    dispose() {
      clearTrailing();
    },
  };
}
