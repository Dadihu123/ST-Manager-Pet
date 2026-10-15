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
export const SCHEDULE_BEHAVIORS = ['idle', 'roam', 'sleep'];

/** 各行为的默认间隔（毫秒），与后端 `DEFAULT_SCHEDULE_MS` 一致。
 *
 * `sleep` 是**阈值**（静了多久之后睡着）而不是区间，因此 min 与 max 相同
 * ——它只用到 `min`。 */
export const DEFAULT_SCHEDULE_MS = {
  idle: { min: 6000, max: 18000 },
  roam: { min: 3000, max: 9000 },
  sleep: { min: 120000, max: 120000 },
};

/** 打盹阈值的合法区间（毫秒），与后端 `SLEEP_AFTER_RANGE` 一致。
 *
 * 与 manifest 的 `sleep_after`（10 秒 ~ 1 小时）保持一致：
 * 同一个概念在两处设置里不该有不同的边界。 */
export const SLEEP_AFTER_MIN_MS = 10 * 1000;
export const SLEEP_AFTER_MAX_MS = 3600 * 1000;

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
  // 动图容器：一轮多久由**文件自己的元数据**决定，插件读不到也不该猜。
  // 返回 0 让调用方走它自己的兜底值——编一个数字出来会让动作被提前打断
  // （「播完回 idle」的定时器按一个假时长来掐）。
  if (source.animated === true || source.layout === 'animated') return 0;
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

/** 单帧尺寸的兜底值（与后端 `DEFAULT_SIZE` 一致）。 */
export const DEFAULT_FRAME_SIZE = { w: 64, h: 64 };

/**
 * 把任意排布声明折算成 `{cols, rows}`——**前端唯一的帧几何真相**。
 *
 * 与后端 `pack.frame_grid` 是同一套规则的两份实现，**必须保持一致**。
 * 之所以两边各写一份而不是让前端只读后端算好的值：运行期定义里已经有
 * `cols` / `rows`（后端算好的），但前端还有几条**自己造** spec 的路径
 * （编辑区草稿、预览覆盖、单帧兜底、测试夹具），那些地方没有后端结论可用。
 *
 * 归一化的价值在于「只有一个几何模型」：`horizontal` 与 `vertical` 不是
 * 另外两套算法，而是 `cols=N, rows=1` 与 `cols=1, rows=N` 两个特例。
 * 三条分支各自实现的表现是「桌面上对、面板预览里错」——最难查的一类偏差。
 *
 * 优先级：**显式的 `cols` / `rows` > `layout` > 帧数推单行**。
 * 显式值优先，是因为后端已经推过一次并写进了运行期定义；
 * 前端再按 `layout` 推一遍等于把同一件事做两次，而两次不一致时
 * 没人知道该信谁。
 *
 * @param {object} source 形如 `{frames, layout, cols, rows}`
 * @returns {{cols: number, rows: number}} 两个都是 >= 1 的整数
 */
export function frameGrid(source) {
  const spec = source || {};
  const frames = Math.max(1, Math.floor(Number(spec.frames) || 1));
  // 动图容器：**不是**网格。整张图是「一帧」，由浏览器自己播。
  // 返回 (1, 1) 让下游公式（背景铺法 = 单帧 × 行列数）自然退化成「原样铺满」
  // ——于是三条切帧排布与容器路线共用同一套渲染代码，不必在
  // `petview` / `preview` / `panel` 里各加一条 `if (animated)` 分支。
  if (spec.layout === 'animated') return { cols: 1, rows: 1 };
  const declaredCols = Math.max(0, Math.floor(Number(spec.cols) || 0));
  const declaredRows = Math.max(0, Math.floor(Number(spec.rows) || 0));

  if (declaredCols > 0 && declaredRows > 0) {
    return { cols: declaredCols, rows: declaredRows };
  }
  // 只给了一个方向：另一个按「装得下」补（与后端 `frame_grid` 一致）
  if (declaredCols > 0) {
    return { cols: declaredCols, rows: Math.max(1, Math.ceil(frames / declaredCols)) };
  }
  if (declaredRows > 0) {
    return { cols: Math.max(1, Math.ceil(frames / declaredRows)), rows: declaredRows };
  }
  if (spec.layout === 'vertical') return { cols: 1, rows: frames };
  return { cols: frames, rows: 1 };
}

/**
 * 一套动画有几页（至少 1）。
 *
 * 页数的**权威来源是后端下发的 `pages` 数组长度**——「磁盘上有几张图」
 * 是客观事实。这里只在后端没给 `pages` 时退回 1（单页包）。
 *
 * @param {object} source 形如 `{pages: [url, ...]}`
 * @returns {number} >= 1 的整数
 */
export function framePageCount(source) {
  const list = source && Array.isArray(source.pages) ? source.pages : null;
  if (!list || !list.length) return 1;
  return list.length;
}

/**
 * 把**全局帧号**折算成 `{page, local, col, row}`——多页切帧的全部坐标逻辑。
 *
 * 帧序是**页优先、页内行优先**：先把第 0 页从左到右、从上到下走完，
 * 再进第 1 页。这与单页内 `grid` 排布的顺序完全一致，因此
 * 「单页 → 多页」是一次自然的扩展，作者不必重新理解播放顺序。
 *
 * 与后端 `pack.frame_page` 是同一套规则的两份实现，**必须保持一致**。
 * 之所以两边各写一份：运行期定义里已经有算好的 `cols` / `rows`，
 * 但前端还有几条**自己造** spec 的路径（编辑区草稿、单帧兜底、
 * 测试夹具），那些地方没有后端结论可用。
 *
 * @param {number} index 全局帧号（会被夹到 `[0, frames-1]`）
 * @param {object} grid 每页的网格 `{cols, rows}`
 * @param {number} frames 整个动画的帧数（跨页）
 * @returns {{page: number, local: number, col: number, row: number}}
 */
export function framePage(index, grid, frames) {
  const cols = Math.max(1, Math.floor(Number(grid && grid.cols) || 1));
  const rows = Math.max(1, Math.floor(Number(grid && grid.rows) || 1));
  const perPage = cols * rows;
  const count = Math.max(1, Math.floor(Number(frames) || 1));
  const at = Math.min(Math.max(0, Math.floor(Number(index) || 0)), count - 1);
  const page = Math.floor(at / perPage);
  const local = at % perPage;
  return { page, local, col: local % cols, row: Math.floor(local / cols) };
}

/**
 * 取某套动画的单帧**逻辑**尺寸（未乘倍率）。
 *
 * 优先级：**变体自带 > 动作条目 > 包级**。
 *
 * 为什么动作能自带尺寸：一个动作的画布比例可能和别的动作根本不同。
 * 典型例子是躺姿睡觉——人物横躺，画布是横构图（1672×941），
 * 而站立动作是 2:3 竖构图（1024×1536）。若所有动作共用包级 `size`，
 * 前端会按 `size` 去拉伸贴图，躺姿会被压扁变形。
 *
 * 逐级回落而不是只看变体，是因为**编辑区草稿**这类前端自造的 spec
 * 只带节奏与几何、不带图，变体级那一层可能是空的；回落到动作条目、
 * 再回落到包级，就能保证「任何一条路径都能算出一个尺寸」。
 *
 * @param {object} variant 一套动画（可含 `size`）
 * @param {object} [spec] 动作条目（可含 `size`）
 * @param {object} [base] 包级 `size`
 * @returns {{w: number, h: number}} 两个方向都是有限正数
 */
export function frameSizeOf(variant, spec, base) {
  const candidates = [
    variant && variant.size,
    spec && spec.size,
    base,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const w = Number(candidate.w);
    const h = Number(candidate.h);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { w, h };
    }
  }
  return { w: DEFAULT_FRAME_SIZE.w, h: DEFAULT_FRAME_SIZE.h };
}

/**
 * 把运行期下发的 `motion` 规范化成前端好用的形状；没声明时返回 `null`。
 *
 * **程序化运动**（T6）：不增加帧数的连续运动，与帧序列正交、可叠加。
 *
 * - 呼吸走 CSS `@keyframes`（合成器上跑，**不需要 rAF**，见 `plugin.css`）；
 * - 眨眼走 `background-position` 跳到另一帧再跳回（复用同一张 sheet）。
 *
 * ⚠️ 它**做不了**肢体运动：整身仿射变换无法 articulate 四肢，
 * 实测把走路两个关键姿势交叉淡入得到的是**双重曝光**（两条腿叠一起）。
 * 因此这里只处理「整体运动」。
 */
export function normalizeMotion(source) {
  const raw = source && source.motion;
  if (!raw || typeof raw !== 'object') return null;
  const out = { amplitude: 0, periodMs: 0, blinkFrames: [], blinkEveryMs: [], blinkDurationMs: 0 };

  const breathe = raw.breathe;
  if (breathe && typeof breathe === 'object') {
    const amplitude = Number(breathe.amplitude);
    const periodMs = Number(breathe.periodMs);
    if (Number.isFinite(amplitude) && amplitude > 0 && Number.isFinite(periodMs) && periodMs > 0) {
      out.amplitude = amplitude;
      out.periodMs = periodMs;
    }
  }

  const blink = raw.blink;
  if (blink && typeof blink === 'object') {
    const frames = Array.isArray(blink.frames)
      ? blink.frames.map((v) => Math.floor(Number(v))).filter((v) => Number.isFinite(v) && v >= 0)
      : [];
    const every = Array.isArray(blink.everyMs) ? blink.everyMs.map(Number) : [];
    const duration = Number(blink.durationMs);
    if (frames.length && every.length === 2 && every.every(Number.isFinite)
        && Number.isFinite(duration) && duration > 0) {
      out.blinkFrames = frames;
      out.blinkEveryMs = [Math.min(every[0], every[1]), Math.max(every[0], every[1])];
      out.blinkDurationMs = duration;
    }
  }

  if (out.amplitude <= 0 && !out.blinkFrames.length) return null;
  return out;
}

/** 这条 motion 会呼吸吗？（决定要不要挂 CSS 动画类） */
export function motionBreathes(motion) {
  return Boolean(motion && motion.amplitude > 0 && motion.periodMs > 0);
}

/** 这条 motion 会眨眼吗？（决定要不要起定时器） */
export function motionBlinks(motion) {
  return Boolean(motion && motion.blinkFrames.length && motion.blinkDurationMs > 0);
}

/**
 * 从 `[最短, 最长]` 里抽一个间隔（毫秒）。
 *
 * 与 `pickIdleDelay` 同一套约定：**只抽数、不管计时**——计时必须由
 * 调用方做，因为宠物静止时 rAF 是停着的，把倒计时放在这里推进就永远不前进
 * （这个坑在 idle 调度那里已经踩过一次，见 `animation.js` 顶部说明）。
 */
export function pickBlinkDelay(motion, random = Math.random) {
  if (!motionBlinks(motion)) return 0;
  const [low, high] = motion.blinkEveryMs;
  if (!(high > low)) return Math.max(0, low || 0);
  return low + (high - low) * random();
}

/**
 * 把「运行期动作条目」规范化成一组可播的变体。
 *
 * 只读 `variants` —— 后端**总是**下发它（见 `store._action_entry`：
 * 单套动作也会包成长度为 1 的数组），因此前端不需要为「没有 variants」
 * 准备第二条路。
 *
 * `size` 一并带上（可能为 `undefined`，表示沿用包级）：几何必须和帧参数
 * 一起流到播放处，否则换动作时会出现「帧参数换了、尺寸没换」的错位。
 *
 * @param {object} entry 运行期动作条目
 * @returns {Array} 至少一项；完全没有图时返回 `[]`
 */
export function playableVariants(entry) {
  const source = entry || {};
  const list = Array.isArray(source.variants) ? source.variants : [];
  return list
    .filter((item) => item && item.url)
    .map((item) => normalizeVariant(item));
}

/**
 * 把运行期定义里的一个变体规范化成前端可播的形状。
 *
 * 关键点是**多页**：`pages` 是每一页的图 URL 数组。单页时后端只给 `url`
 * （没有 `pages`），这里补成长度为 1 的数组，于是下游只有一种形状要处理
 * ——「有时是数组、有时是字符串」是最容易漏判的那种差异。
 *
 * @param {object} item 后端下发的变体
 * @returns {object} 规范化后的变体
 */
function normalizeVariant(item) {
  const source = item || {};
  const url = String(source.url || '');
  // `pages` 是后端下发的每一页 URL 数组（单页时长度为 1）。
  // 过滤掉空 URL：某一页的图缺失时后端会给空串，留着它会让
  // 「第 3 页丢了」表现为「切到第 3 页时画面变空白」——不如在这里就丢掉，
  // 让 `pageCount` 反映真实可播的页数。
  const rawPages = Array.isArray(source.pages) ? source.pages : null;
  const pages = (rawPages && rawPages.length ? rawPages : [url])
    .map((page) => String(page || ''))
    .filter(Boolean);
  return {
    url,
    pages,
    frames: Math.max(1, Math.floor(Number(source.frames) || 1)),
    fps: Number(source.fps) || 0,
    loop: source.loop !== false,
    layout: source.layout === 'vertical' ? 'vertical' : 'horizontal',
    // **动图容器**：由浏览器自行播放，插件不切帧。
    // 下游（petview / preview / panel）据此避开「单帧」这个说法——
    // 它明明在动，说成「单帧（静态显示）」会让用户以为图坏了。
    animated: source.layout === 'animated' || source.animated === true,
    // 动图的**真实帧数**（后端从文件元数据读出来的）；静态图是 1。
    animatedFrames: Math.max(1, Math.floor(Number(source.animatedFrames) || 1)),
    // **程序化运动**（呼吸 / 眨眼）：与帧序列正交，可叠加。
    // 没声明时是 `null`——调用方据此完全不动样式（不挂动画类、不起定时器）。
    motion: normalizeMotion(source),
    // 呼吸的 `transform-origin`：由后端按包级 `anchor.y` 算好。
    // 前端**不自己推**——推错的表现是「锚点不在底边的形象呼吸时脚离地」。
    motionOrigin: typeof source.motionOrigin === 'string' ? source.motionOrigin : '',
    // 网格几何：**原样带上**后端算好的值（缺失时 `frameGrid` 会按 layout 推）。
    cols: Math.max(0, Math.floor(Number(source.cols) || 0)),
    rows: Math.max(0, Math.floor(Number(source.rows) || 0)),
    frameMs: Array.isArray(source.frameMs) ? source.frameMs.slice() : [],
    weight: normalizeWeight(source.weight),
    size: source.size || undefined,
  };
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
    // 标准图像**不该**是动图容器：它的语义是「不播动画时显示的那一帧」，
    // 而一个会自己动的图与「静止画面」是矛盾的。
    // 但作者可能只提供了一个动图（例如 idle 就是 GIF），此时回落出来的
    // 标准图像只能是它——这时 `animated` 为真，前端据此知道
    // 「静止状态下它也会动」，而不是以为自己漏画了什么。
    animated: still.layout === 'animated' || still.animated === true,
    // 网格几何（标准图像可以从任意一条 sheet 取一帧，包括网格排布的）。
    // 没有它就算不出「第 7 帧在哪一格」——那会显示成第 0 帧，
    // 而包本身看起来完全正常。
    cols: Math.max(0, Math.floor(Number(still.cols) || 0)),
    rows: Math.max(0, Math.floor(Number(still.rows) || 0)),
    // 是否由作者显式声明（`false` = 回落自 idle 首帧）。面板据此提示。
    declared: still.declared === true,
    source: String(still.source || 'idle'),
    // 这一帧所在 sheet 的单帧尺寸；`undefined` = 沿用包级。
    //
    // 为什么标准图像也要带尺寸：它可以取自**任意一条** sheet（例如把躺姿
    // `sleep.png` 的某一帧当门面），而那条 sheet 的画布比例可能与当前动作
    // 完全不同。不带的话，`drawStill()` 只能用**当前动作**的 `width` / `height`
    // 去铺它——横构图的图会被按竖构图拉伸（实测失真 62%）。
    //
    // 这个问题只有「标准图像」与「逐动作尺寸」同时存在时才出现，
    // 因此是两条分支合并时才补上的。
    size: still.size || undefined,
    // **程序化运动**：标准图像要跟着 idle 一起呼吸。
    //
    // 为什么：默认 idle 模式是「平时静止 + 隔一段随机播一遍」，也就是说
    // 宠物**大部分时间显示的就是标准图像**。标准图像不动的话，呼吸在
    // 绝大多数时间里根本看不见——宠物看起来仍然是死的。
    // （后端已经把 idle 的运动继承过来了，这里只是原样带上。）
    motion: normalizeMotion(still),
    motionOrigin: typeof still.motionOrigin === 'string' ? still.motionOrigin : '',
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
    // `sleep` 是**阈值**（静了多久之后睡着），不是区间：它只有一个值。
    // 走单独一条路，免得把「随机」这个语义强加上去——
    // 「多久不管就睡觉」显然不该是随机的。
    //
    // ⚠️ `afterMs` 为 `null` / 缺失时要**保留 null**，不能填一个默认值。
    // 那表示「这个形象没设打盹阈值」，此时应当回落到**宿主的全局
    // `sleep_after`**——而宿主表单里那个值正是给这种情况用的。
    // 在这里填 120 秒的话，全局设置就永远不生效了
    //（用户会看到「我在宿主设置里改了却没反应」）。
    if (name === 'sleep') {
      const after = Number(source.afterMs);
      const value = Number.isFinite(after) && after > 0 ? after : null;
      return {
        minMs: value === null ? base.minMs : value,
        maxMs: value === null ? base.maxMs : value,
        plays: 1,
        mode: 'random',
        afterMs: value,
      };
    }
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
 * 别名：`createIdleScheduler` 是它更早的名字。
 *
 * 保留一个别名而不是让所有调用点改名：这个名字出现在测试与验收脚本里，
 * 而它现在管的不止 idle（还有 roam）。新代码请用 `createBehaviorScheduler`。
 */
export const createIdleScheduler = createBehaviorScheduler;
