/**
 * 动画**选套**与**节奏**的纯逻辑（不碰 DOM，可在 Node 里直接单测）。
 *
 * 这个模块回答三个问题：
 *
 * 1. **一个动作有多套动画时，这次播哪一套？**
 *    按 `weight`（**相对比例**，不是百分比）加权随机。
 *    比例语义的关键好处是「新增一套动画不用改动原先的数字」：
 *    两套各 5 → 各 50%；再加一套 5 → 各 1/3，前两个数字一个都不用动。
 *
 * 2. **这次播多久？**
 *    非均匀帧时长下逐帧求和，否则 `frames / fps`。
 *    状态机与 `petview` 都要用它来安排「播完回 idle」的定时器——
 *    算错的表现是「动作被截断」或「动作播完了还僵在那」。
 *
 * 3. **时间驱动的行为什么时候发生？**
 *    见 `createBehaviorScheduler`：`idle` 的小动作与 `roam` 的漫游
 *    都是「平时不发生，隔一段随机时间发生一次」。
 */

/** 权重区间（与 `backend/core/pack.py` 的 `MIN_WEIGHT` / `MAX_WEIGHT` 一致）。 */
export const MIN_WEIGHT = 0;
export const MAX_WEIGHT = 1000;

/** 默认权重（与后端 `DEFAULT_WEIGHT` 一致）。 */
export const DEFAULT_WEIGHT = 1;

/** 可设置触发时间的**行为**（与后端 `SCHEDULE_BEHAVIORS` 必须一致）。 */
export const SCHEDULE_BEHAVIORS = ['idle', 'roam'];

/** 各行为的默认间隔（毫秒），与后端 `DEFAULT_SCHEDULE_MS` 一致。 */
export const DEFAULT_SCHEDULE_MS = {
  idle: { min: 6000, max: 18000 },
  roam: { min: 3000, max: 9000 },
};

/** 默认的连续播几轮（与后端 `DEFAULT_IDLE_PLAYS` 一致）。 */
export const DEFAULT_IDLE_PLAYS = 1;

/** 间隔的合法区间（毫秒），与后端 `MIN_SCHEDULE_MS` / `MAX_SCHEDULE_MS` 一致。 */
export const MIN_SCHEDULE_MS = 200;
export const MAX_SCHEDULE_MS = 3600 * 1000;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** 把任意值规范化成一个合法权重。 */
export function normalizeWeight(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_WEIGHT;
  return clamp(value, MIN_WEIGHT, MAX_WEIGHT);
}

/**
 * 一套动画的**实际播放时长**（毫秒）。
 *
 * @param {object} spec `{ frames, fps, frameMs }`
 * @returns {number} 毫秒；无法计算时返回 0（调用方自己兜底）
 */
export function animationDuration(spec) {
  const source = spec || {};
  const frames = Math.max(1, Math.floor(Number(source.frames) || 1));
  const durations = Array.isArray(source.frameMs) ? source.frameMs : null;
  if (durations && durations.length === frames) {
    let total = 0;
    let valid = true;
    for (const item of durations) {
      const value = Number(item);
      if (!Number.isFinite(value) || value <= 0) { valid = false; break; }
      total += value;
    }
    if (valid && total > 0) return total;
  }
  const fps = Number(source.fps);
  if (Number.isFinite(fps) && fps > 0) return (frames * 1000) / fps;
  return 0;
}

/**
 * 从若干套动画里按权重随机选一套。
 *
 * 全部权重为 0（或权重都非法）时**退化为等概率**，而不是「一套都选不出来」——
 * 那是作者明显写错了，但让宠物卡死比随便播一套更糟。
 *
 * @param {Array} variants 每套形如 `{ weight, ... }`
 * @param {function} [random] 注入的随机源（测试用确定性随机）
 * @returns {number} 选中那套的下标；`variants` 为空时返回 `-1`
 */
export function pickVariantIndex(variants, random = Math.random) {
  const list = Array.isArray(variants) ? variants : [];
  if (!list.length) return -1;
  if (list.length === 1) return 0;

  const weights = list.map((item) => normalizeWeight(item && item.weight));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    // 权重全为 0：等概率兜底（见 docstring）
    const roll = Number(random());
    const index = Math.floor((Number.isFinite(roll) ? clamp(roll, 0, 1) : 0) * list.length);
    return clamp(index, 0, list.length - 1);
  }

  let roll = Number(random());
  if (!Number.isFinite(roll)) roll = 0;
  // `random()` 约定返回 [0, 1)；夹一下以防注入的随机源越界
  let target = clamp(roll, 0, 1) * total;
  for (let index = 0; index < list.length; index += 1) {
    // **权重为 0 的那一套必须跳过**，不能只看 `target <= 0`：
    // `roll` 恰好为 0（`Math.random()` 在真实运行里会给出 0）时 `target` 也是 0，
    // 而排在首位、权重为 0 的那一套会「减 0 之后仍然 <= 0」从而被选中——
    // 那正好违背了「权重 0 = 保留素材但永不选中」的语义。
    if (weights[index] <= 0) continue;
    target -= weights[index];
    // `<= 0` 让「target 恰好落在边界上」归给当前这一套，
    // 避免浮点误差把它推到下一套（视觉上看不出，但测试要能钉住）
    if (target <= 0) return index;
  }
  // 浮点误差兜底：走到这里说明累加没吃满，给**最后一个有权重**的那套
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (weights[index] > 0) return index;
  }
  return list.length - 1;
}

/**
 * 把「运行期动作条目」规范化成一组可播的变体。
 *
 * 优先读 `variants`（后端多套动画的输出），缺失时回退到条目本身的
 * `url` / `frames` / `fps` —— 老版本后端只给这些字段，而前后端是**可以
 * 各自升级**的（宿主缓存、用户手动替换插件目录都会造成版本错配）。
 *
 * @param {object} entry 运行期动作条目
 * @returns {Array} 至少一项；完全没有图时返回 `[]`
 */
export function playableVariants(entry) {
  const source = entry || {};
  const list = Array.isArray(source.variants) ? source.variants : [];
  const playable = list.filter((item) => item && item.url);
  if (playable.length) {
    return playable.map((item) => ({
      url: String(item.url),
      frames: Math.max(1, Math.floor(Number(item.frames) || 1)),
      fps: Number(item.fps) || 0,
      loop: item.loop !== false,
      layout: item.layout === 'vertical' ? 'vertical' : 'horizontal',
      frameMs: Array.isArray(item.frameMs) ? item.frameMs.slice() : [],
      weight: normalizeWeight(item.weight),
    }));
  }
  if (!source.url) return [];
  return [{
    url: String(source.url),
    frames: Math.max(1, Math.floor(Number(source.frames) || 1)),
    fps: Number(source.fps) || 0,
    loop: source.loop !== false,
    layout: source.layout === 'vertical' ? 'vertical' : 'horizontal',
    frameMs: Array.isArray(source.frameMs) ? source.frameMs.slice() : [],
    weight: DEFAULT_WEIGHT,
  }];
}

/**
 * 把运行期形象里的**标准图像**规范化成一套可直接画的帧参数。
 *
 * 标准图像是「不播动画时显示的那一帧」。后端已经算好了它是哪张 sheet 的
 * 第几帧（`still` 块），前端只做一次规范化——**不做回退决策**：
 * 回退（包内声明 → idle 首帧）也是后端算好的，前端自己再算一遍
 * 会出现「两边结论不一致」这种最难查的问题。
 *
 * @param {object} pack 运行期形象定义（后端 `runtime_pack()` 的结果）
 * @returns {object|null} `{url, frames, frame, layout}`；没有可用图时返回 `null`
 */
export function stillFrame(pack) {
  const still = (pack && pack.still) || null;
  if (!still || !still.url) return null;
  const frames = Math.max(1, Math.floor(Number(still.frames) || 1));
  const frame = clamp(Math.floor(Number(still.frame) || 0), 0, frames - 1);
  return {
    url: String(still.url),
    frames,
    frame,
    layout: still.layout === 'vertical' ? 'vertical' : 'horizontal',
    // 是否由作者显式声明（`false` = 回落自 idle 首帧）。面板据此提示。
    declared: still.declared === true,
    source: String(still.source || 'idle'),
  };
}

/**
 * **时间驱动行为**的随机间隔调度器。
 *
 * 哪些行为归它管：`idle`（闲着时偶尔动一下）与 `roam`（闲着时自己走一走）。
 * 两者都是「平时不发生，隔一段随机时间发生一次」，因此共用同一套调度逻辑。
 * 其余动作由**事件**触发（`click` 要有人点、`fall` 要松手），不在这里。
 *
 * 为什么不是「一直循环待机动画」：常驻桌面的宠物一直循环看起来像在抽搐。
 * 成熟做法是**平时静止**，每隔一段随机时间播一遍小动作，播完回到静止。
 *
 * 这个对象只负责「抽一个随机间隔」与「记住配置」——**计时由调用方做**，
 * 而且是 `setTimeout` 而不是 rAF：`random` 模式下平时 rAF 是**停着的**
 * （那正是省电的落点），倒计时若放在 rAF 里推进就永远不会前进，
 * 小动作再也触发不了。
 *
 * 因此这里刻意**不**提供 `tick(dt)`：那种接口会诱导调用方把它接进 rAF。
 */
export function createBehaviorScheduler(options = {}) {
  const random = typeof options.random === 'function' ? options.random : Math.random;
  /** `{行为名: {minMs, maxMs, plays, mode}}`。 */
  const behaviors = {};

  function defaultsFor(name) {
    const preset = DEFAULT_SCHEDULE_MS[name] || DEFAULT_SCHEDULE_MS.idle;
    return { minMs: preset.min, maxMs: preset.max, plays: DEFAULT_IDLE_PLAYS, mode: 'random' };
  }

  function normalize(name, raw) {
    const base = defaultsFor(name);
    const source = raw || {};
    const nextMin = Number(source.minIntervalMs);
    const nextMax = Number(source.maxIntervalMs);
    let minMs = Number.isFinite(nextMin) && nextMin > 0 ? nextMin : base.minMs;
    let maxMs = Number.isFinite(nextMax) && nextMax > 0 ? nextMax : base.maxMs;
    if (maxMs < minMs) [minMs, maxMs] = [maxMs, minMs];
    const plays = Math.max(1, Math.floor(Number(source.plays) || base.plays));
    const mode = source.mode === 'loop' ? 'loop' : 'random';
    return { minMs, maxMs, plays, mode };
  }

  // 先把全部行为的默认值铺上：调用方不必自己判空，
  // 「后端没给这个键」与「后端给了默认值」在行为上完全一致。
  for (const name of SCHEDULE_BEHAVIORS) behaviors[name] = defaultsFor(name);

  return {
    /** 取某行为的生效配置（未知行为返回 idle 的默认值）。 */
    get(name) {
      return Object.assign({}, behaviors[name] || defaultsFor(name));
    },
    /** 取某行为的间隔区间（毫秒）。 */
    get minMs() { return this.get('idle').minMs; },
    get maxMs() { return this.get('idle').maxMs; },
    get plays() { return this.get('idle').plays; },

    /** 应用后端的 `schedule` 块（缺失的键用默认值）。 */
    setSchedule(schedule) {
      const source = schedule && typeof schedule === 'object' ? schedule : {};
      for (const name of SCHEDULE_BEHAVIORS) {
        behaviors[name] = normalize(name, source[name]);
      }
      return this;
    },

    /**
     * 抽某行为的下一个随机间隔并返回它（**秒**）。
     *
     * 每次触发后都重新抽，而不是用一个固定周期——固定周期看起来像节拍器，
     * 而「它自己想动一下」才像活着。
     */
    reschedule(name = 'idle') {
      const config = behaviors[name] || defaultsFor(name);
      const roll = Number(random());
      const value = Number.isFinite(roll) ? clamp(roll, 0, 1) : 0;
      return (config.minMs + (config.maxMs - config.minMs) * value) / 1000;
    },
  };
}

/**
 * 兼容别名：旧代码按 `createIdleScheduler` 找它。
 *
 * 保留一个别名而不是让所有调用点改名的理由：这个名字出现在测试与验收脚本里，
 * 而它现在管的不止 idle（还有 roam）。新代码请用 `createBehaviorScheduler`。
 */
export const createIdleScheduler = createBehaviorScheduler;
