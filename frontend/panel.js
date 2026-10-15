/**
 * 形象管理面板（`settings` 入口 + `modal` surface）。
 *
 * 为什么自带 UI 而不是用宿主的通用设置表单（§0.1 / §2.8）：
 * 形象管理需要**预览图、动作齐全性校验、单动作覆盖、导入与删除**，
 * 而宿主的 `config_schema` 只支持标量（`string`/`integer`/`number`/`boolean`/`enum`），
 * 渲染不了列表与图片。标量开关仍走宿主表单（单一来源，避免双写不同步）。
 *
 * 面板只做**展示与调用后端**；回退链的判定在后端（`runtime_pack`），
 * 因此这里拿到的每个动作都已经是「最终结论 + 一句解释」。
 */

import {
  DEFAULT_SCHEDULE_MS,
  frameGrid,
  frameSizeOf,
  motionBlinks,
  motionBreathes,
  normalizeMotion,
  SLEEP_AFTER_MAX_MS,
  SLEEP_AFTER_MIN_MS,
} from './animation.js';
import { createAnimationPlayer, totalDuration } from './preview.js';

const ACTION_LABELS = {
  idle: '待机',
  'walk-left': '向左走',
  'walk-right': '向右走',
  drag: '被拖动',
  fall: '下落',
  land: '落地',
  sleep: '睡觉',
  click: '被点击',
  happy: '开心',
  sad: '难过',
  angry: '生气',
  look: '张望',
  // `walk` **不是动作**，而是「行走」这条必要项的**代号**：
  // 行走只有方向化动作（`walk-left` / `walk-right`），提供任一侧即算满足。
  // 这里留着它只是为了把后端的 `missingRequired: ['walk']` 翻译成人话。
  walk: '行走',
};

/**
 * 与后端 `pack.REQUIRED_ACTIONS` 一致的「必要动作」名单。
 *
 * `walk` 是**需求代号**而不是动作名（见上）。判断某个**真实动作**算不算必要
 * 必须走 `isRequiredAction()`：`walk-left` / `walk-right` 都算必要，
 * 因为它们共同承载「行走」这一项需求（提供任一侧即满足）。
 */
const REQUIRED_ACTIONS = ['idle', 'walk', 'drag', 'fall'];

/**
 * **可设置触发时间**的行为（与后端 `pack.SCHEDULE_BEHAVIORS` 必须一致）。
 *
 * 用户要求「支持调整不同动作的触发时间」，而真正**由时间驱动**的只有这三个：
 *
 * - `idle`：闲着的时候偶尔动一下；
 * - `roam`：闲着的时候自己在屏幕底部走一走；
 * - `sleep`：**多久没人理就睡着**（用户要求把「睡觉」也加进来）。
 *
 * 其余动作由**事件**触发（`click` 要有人点、`fall` 要松手、`happy` 要有播报），
 * 给它们设「多久一次」没有意义——后端会明确拒绝，因此面板也不渲染它们的滑块。
 *
 * ⚠️ `sleep` 的形状与另外两个**不同**：它是**阈值**（「静了多久之后发生」），
 * 不是「每隔一段随机时间发生一次」。因此 `isThreshold: true`，
 * 面板只渲染一个「多久」而不是「最短 / 最长」两个滑块——
 * 「多久不管就睡觉」显然不该是随机的。
 */
const SCHEDULE_BEHAVIORS = [
  {
    key: 'idle',
    label: '待机小动作',
    hint: '闲着的时候偶尔动一下。数值越小越活泼，越大越安静。',
  },
  {
    key: 'roam',
    label: '自动漫游',
    hint: '闲着的时候自己在屏幕底部走一走。关掉上面「外观」里的「自动漫游」后这项不生效。',
  },
  {
    key: 'sleep',
    label: '打盹',
    isThreshold: true,
    hint: '多久没人理它就睡着（睡着后任何操作都会把它唤醒）。'
      + '睡着动画会在当前动作播完之后才开始，不会打断它。',
  },
];

/**
 * 触发节奏的**兜底**区间（毫秒）。权威值由后端 `/pets` 的 `limits` 给，
 * 这里只是「接口还没回来」时的初值，避免滑块渲染成 NaN。
 */
const SCHEDULE_FALLBACK_MIN_MS = 200;
const SCHEDULE_FALLBACK_MAX_MS = 3600 * 1000;

/**
 * 新建形象时可上传的动作（按重要性排序，`idle` 必须给）。
 *
 * 行走只列**方向化**的两项：宠物是水平移动的，正面行走图看起来像原地踏步。
 * 只给一侧也行——另一侧会自动镜像；但**左右不对称**的形象
 * （例如头饰只在一侧）应当两套都给，否则镜像会把细节翻边。
 */
const CREATABLE_ACTIONS = [
  { action: 'idle', required: true },
  { action: 'walk-left', required: false },
  { action: 'walk-right', required: false },
  { action: 'drag', required: false },
  { action: 'fall', required: false },
  { action: 'land', required: false },
  { action: 'sleep', required: false },
  { action: 'click', required: false },
  { action: 'happy', required: false },
  { action: 'sad', required: false },
  { action: 'angry', required: false },
  { action: 'look', required: false },
];

/** 大小倍率的区间（与 `backend/core/pack.py:SCALE_RANGE` 必须一致）。 */
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;

/** 倍率滑块的步长：0.05 足够细，又不至于让用户拖不到整数值。 */
const SCALE_STEP = 0.05;

/**
 * 动画速度倍率的区间（越大越慢）。
 *
 * 与后端 `pack.ANIM_SPEED_RANGE` **必须一致**——它同时是「按形象的设置」
 * 与「形象包能声明的字段」的合法区间。
 *
 * 这里同时用于两处：
 * - **按形象的动画速度**（`detail.animSpeed`，落在 `settings.json`）；
 * - **预览器的播放速度**（只影响预览，不写盘）。
 *
 * 预览速度刻意与按形象的那个**分开存**：在预览器里顺手拖一下，
 * 不应该把桌面上的宠物真的改慢——用户会以为那只是「试了一下」。
 */
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;
/** 滑块步长：0.05 已经够细（0.25~4 之间共 75 档），再细拖起来反而难对准。 */
const SPEED_STEP = 0.05;

/** 把速度倍率夹到合法区间（与后端 `clamp_anim_speed` 同一套语义）。 */
function clampSpeed(value) {
  const number = Number(value);
  const base = Number.isFinite(number) && number > 0 ? number : 1;
  return Math.min(Math.max(base, SPEED_MIN), SPEED_MAX);
}

/** 速度读数的显示格式：`1×` / `1.5×`（去掉多余的小数位）。 */
function formatSpeed(value) {
  const number = clampSpeed(value);
  // ⚠️ 这里**不能**用 `formatNumber`：它定义在 `createSettingsPanel` 内部，
  // 模块级的这个函数看不到它（踩过：面板整片渲染失败，报
  // `ReferenceError: formatNumber is not defined`）。
  const text = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${text}×`;
}

/**
 * 速度那一行的说明文字。
 *
 * 说清「越大越慢」并给出实际时长——倍率是个抽象数字，
 * 「一次待机动画大约播多久」才是用户真正在意的。
 */
function buildSpeedHint(value, declared) {
  const base = '越大越慢：1× 按形象包声明的帧率播放，2× 表示播放时间翻倍。';
  const tail = declared !== 1 ? `形象包建议 ${formatSpeed(declared)}。` : '';
  return base + tail;
}

/**
 * **帮助页的内容**。
 *
 * 用户要求：「因为当前的设置项之类的比较多，所以可以给页面添加一个帮助页，
 * 具体的帮助按钮请使用已有的，里面可以解释下不同参数的设置用途以及推荐值，
 * 前面说的哪个 motion 和 physics 这类比较容易出问题的设置项在帮助里面说清楚即可」。
 *
 * 写法上刻意做成**数据**而不是一堆 DOM 代码：内容会随设置项增加而变长，
 * 数据表改起来不会漏掉结构（每项都是「名称 / 说明 / 推荐值」三段）。
 *
 * `risky: true` 的那几项会额外用醒目颜色标出「容易调坏」的提醒——
 * 它们正是用户点名要讲清楚的两类（`motion` 与 `physics`）。
 */
const HELP_SECTIONS = [
  {
    title: '形象与外观',
    entries: [
      {
        term: '大小倍率',
        body: '把整个宠物放大或缩小。0.25× ~ 4×，按形象分别记住。',
        recommend: '真人立绘一般 0.3~0.6×；像素风小图 1~3×。'
          + '提示行里会实时显示「当前约多少像素高」，按那个数判断更直观。',
      },
      {
        term: '渲染方式',
        body: '放大时怎么插值。平滑 = 边缘柔和；像素风 = 保持硬边。',
        recommend: '写实插画与真人形象用「平滑」（硬边会出现块状锯齿）；'
          + '像素风形象用「硬边」才不会糊。形象包可以自己声明，这里是覆盖它。',
      },
      {
        term: '动画速度',
        body: '统一放慢或加快这个形象的所有动作。1× 按包内声明的帧率播放，'
          + '2× 表示播放时间翻倍（更慢）。',
        recommend: '觉得「动作太快看不清」就调大（1.5~2×）；'
          + '觉得「半天不动一下」就调小（0.6~0.8×）。'
          + '它只做整体缩放，不改包里的帧率——因此非均匀帧时长的节奏仍然保留。',
      },
      {
        term: '自动漫游',
        body: '闲着的时候这个形象会不会自己在屏幕底部走一走。',
        recommend: '会走的形象开着；坐着的猫、躺着的玩偶建议关掉——'
          + '原地不动更自然。走动的间隔在下面「触发时间」里调。',
      },
      {
        term: '单帧尺寸（进阶）',
        body: '一张贴图里单帧的像素尺寸，不是整张 spritesheet 的大小。',
        recommend: '一般不用改：新建形象时会自动按你上传的图算出来。'
          + '只有手写 pet.json 或图片被替换过之后才需要动它。',
        risky: true,
      },
      {
        term: '锚点（进阶）',
        body: '「脚底」在单帧里的相对位置，0 = 最上/最左，1 = 最下/最右。'
          + '宠物站立、呼吸、缩放都以此为原点。',
        recommend: 'y 一般取 0.95~1.0（脚底贴着图的下沿）。'
          + '调错的后果是「宠物悬空」或「陷进地面」，而且一眼就能看出来，'
          + '所以放心试。',
        risky: true,
      },
    ],
  },
  {
    title: '触发时间',
    entries: [
      {
        term: '待机小动作',
        body: '闲着的时候偶尔动一下。默认每 6~18 秒随机播一遍，播完回到静止。',
        recommend: '想更活泼就调小（3~8 秒），想更安静就调大（20~60 秒）。'
          + '不建议小于 2 秒——那看起来像在抽搐。',
      },
      {
        term: '自动漫游',
        body: '闲着的时候自己走一走。默认每 3~9 秒一趟。',
        recommend: '3~15 秒比较自然。调得很小时宠物会几乎一直在走'
          + '（它走得比间隔慢），看起来像在来回踱步。',
      },
      {
        term: '打盹',
        body: '多久没人理它就睡着。睡着之后任何操作都会把它唤醒。',
        recommend: '60~300 秒。它不会打断当前动作——'
          + '如果到点那一刻它正在走或在播小动作，会等它做完再睡。',
      },
    ],
  },
  {
    title: '每个动作的动画（进阶）',
    entries: [
      {
        term: '帧率 / 每帧时长',
        body: '帧率是「每秒播几帧」；每帧时长可以给每一帧单独设一个毫秒数，'
          + '用来做「停顿一下再动」这类不均匀节奏。两者同时存在时每帧时长优先。',
        recommend: '均匀节奏用帧率就够了（2~8 fps 适合待机）。'
          + '非均匀节奏的例子：`[400, 300, 300, 600]` —— 第一帧多停一会，'
          + '最后一帧停久一点再循环，看起来比匀速自然得多。',
      },
      {
        term: '循环',
        body: '播完最后一帧之后回到第一帧，还是停在最后一帧。',
        recommend: '待机、走路、睡觉这类持续状态要开；'
          + '点击、落地这类一次性动作关掉。包通常已经设好了，一般不用改。',
      },
      {
        term: '排布 / 列数 / 行数',
        body: '一张图里帧怎么摆：横排一行、竖排一列，或者网格（多行多列）。'
          + '网格要同时给列数与行数。',
        recommend: '帧数多时用网格：4×4 的网格一张图能放 16 帧，'
          + '而横排一行只能放到图片宽度允许为止。',
      },
      {
        term: '权重（多套动画）',
        body: '一个动作可以挂好几套动画，每次触发按权重随机选一套。'
          + '权重是相对比例：两套都填 5 就是各一半；填 1 / 3 就是 25% 与 75%。',
        recommend: '想「大部分时候用 A、偶尔来一下 B」就填 5 / 1。'
          + '这比堆很多帧更省显存，也更像「它自己有小情绪」。',
      },
      {
        term: '程序化运动（呼吸 / 眨眼）',
        body: '不用额外画帧，靠合成器驱动的整体运动：'
          + '呼吸 = 以脚底为原点做轻微的纵向缩放；眨眼 = 在指定的几帧之间快速跳一下。',
        recommend: '呼吸幅度 0.005~0.02（0.02 已经很明显了），周期 2~5 秒。'
          + '它不会让宠物长出新的姿势——整身缩放无法 articulate 四肢，'
          + '所以做不出「走路循环」；它适合让静止的待机图看起来是活的。'
          + '眨眼需要你有一条真的有闭眼帧的图，否则会把睁眼帧当成眨眼。',
        risky: true,
      },
    ],
  },
  {
    title: '物理参数（进阶）',
    entries: [
      {
        term: '重力 gravity',
        body: '下落的加速度（像素/秒²）。',
        recommend: '默认 1800。调大 = 掉得更急、更「重」；'
          + '调小 = 飘（小于 400 就明显像在月球上）。',
        risky: true,
      },
      {
        term: '走速 walkSpeed',
        body: '自动漫游时的水平速度（像素/秒）。',
        recommend: '默认 60。小宠物（64px）用 30~50，'
          + '大立绘用 80~150，否则它看起来像在「滑」。',
        risky: true,
      },
      {
        term: '摩擦 friction',
        body: '每秒保留多少水平速度（越小刹车越快）。',
        recommend: '默认 0.02（走停约 0.4 秒）。'
          + '调到 0.5 以上会「刹不住」，甩一下能滑出屏幕；'
          + '调到 0 会立刻停住，看起来像撞墙。',
        risky: true,
      },
      {
        term: '终端速度 terminalVelocity',
        body: '下落速度的上限（像素/秒），防止一帧掉太远。',
        recommend: '默认 2400。除非屏幕特别高，否则不用改。',
        risky: true,
      },
      {
        term: '弹性 bounce',
        body: '落地时弹回多少速度（0 = 不弹，1 = 原速弹回）。',
        recommend: '默认 0.15（轻轻一顿）。0.4 以上会像皮球，'
          + '0 则「啪」地贴在地上。',
        risky: true,
      },
    ],
  },
  {
    title: '其它',
    entries: [
      {
        term: '标准图像',
        body: '不播动画时显示的那一帧（「平时」的样子）。',
        recommend: '建议显式设一张。不设时会回落到 idle 的第一帧，'
          + '而 idle 挂了两套动画时那可能是个怪姿势（比如抬着头）。',
      },
      {
        term: '每动作换图（覆盖）',
        body: '单独替换某个动作的图，不改形象包本身。内置形象也能用。',
        recommend: '只想换个待机图时用它，比复制整个形象轻。'
          + '内置形象上遗留的覆盖不会生效（插件会提示并让你一键清理）。',
      },
      {
        term: '勿扰与播报开关',
        body: '在「设置 → 插件 → 桌面宠物」里，是全局的：'
          + '控制要不要弹提示，与是哪只宠物无关。',
        recommend: '宠物自己的行为参数（大小、速度、触发时间…）都在这个面板里'
          + '按形象设置，两处不会互相打架。',
      },
    ],
  },
];

export function createSettingsPanel({
  api, getConfig, getOwnSettings, onConfigChanged, onPetChanged,
  getHidden, onHiddenChange,
}) {
  let root = null;
  let disposed = false;
  let pets = [];
  let activeId = '';
  let selectedId = '';
  let detail = null;
  //: 扫描时因**目录名不合法**被跳过的目录（见 `refresh()` 里的说明）。
  let invalidDirs = [];
  let busy = false;
  let notice = null;
  /**
   * 宠物是否被用户关闭了（隐藏）。
   *
   * 权威值在 `plugin.js`（它管着宠物视图的生与死），这里只是它的一份镜像。
   * 初值从 `getHidden()` 取——面板可能在宠物已被关闭的情况下才第一次打开。
   */
  let hiddenState = typeof getHidden === 'function' ? Boolean(getHidden()) : false;
  /** 缩略图几何的观察者（容器宽度变化时重算帧几何）。 */
  let resizeObserver = null;
  /** 当前是否处于「新建形象」视图（而不是形象详情）。 */
  let creating = false;
  /** 新建表单的暂存状态：`{action: {file, frames, fps}}`。 */
  let draft = {};
  /** 新建表单的标量字段。 */
  let draftName = '';
  /** 新建表单的**作者署名**（用户要求：自定义宠物应能设作者名，便于发布）。 */
  let draftAuthor = '';
  let draftScale = 1;
  let draftPixelated = false;
  /**
   * 新建表单的**标准图像**声明。
   *
   * 三种状态：
   * - `null`：不声明 → 后端回落到 idle 首帧；
   * - `{action, frame}`：复用某个已上传动作的某一帧（面板上最常见的选择）；
   * - `{file, frames, frame}`：单独上传一张。
   *
   * 为什么不总是强制用户设一张：它**不是必填**。强制会让「我就想用 idle
   * 第一帧」这个最常见的情况变得啰嗦，而回落值在只给一套 idle 时本来就是对的。
   */
  let draftStill = null;
  /**
   * 新建表单的**触发节奏**（毫秒区间）。
   *
   * `{idle: {min, max}, roam: {min, max}}`；`null` 表示「用默认值」，
   * 提交时不写进 `pet.json`（后端与前端都用同一套默认值）。
   */
  let draftSchedule = null;
  /** 面板拿到的限制（倍率区间由后端给，避免两边写死不一致）。 */
  let limits = { scaleMin: SCALE_MIN, scaleMax: SCALE_MAX };
  /**
   * 动画预览器（设置页里「播放」具体动作）。
   *
   * 用户在**插件管理页里看不到动画效果**，调形象时只能切过去等它真的触发一次
   * ——而 `click` / `land` 这类动作几乎等不到。因此面板自带一个播放器。
   */
  let player = null;
  /** 预览器当前选的动作名与变体下标。 */
  let previewAction = 'idle';
  let previewVariant = 0;
  /** 预览器的速度倍率（越大越慢），与桌面宠物用的是同一个语义。 */
  let previewSpeed = 1;
  /**
   * **进阶区块的折叠状态**（`键 → 是否展开`）。
   *
   * 为什么放在模块级而不是 `createSettingsPanel` 里：它要**跨重渲染**保留。
   * 面板每次改设置都会整片重渲染（`render()`），不记住的话用户展开
   * 「物理参数」之后一拖滑块它就又收起来了——那比一开始就不展开更烦人。
   *
   * 也不用 `localStorage`：那是「记住用户偏好」的语义，而这个只是
   * 「这一屏的临时展开状态」，关掉面板再打开应当回到默认（收起）。
   */
  const expandedSections = new Map();
  /** 右栏是否正在显示**帮助页**（替换掉形象详情）。 */
  let showingHelp = false;
  /**
   * 正在编辑**动画参数**的动作名（`''` = 没在编辑）。
   *
   * 为什么用「就地展开一个编辑区」而不是弹窗：宿主的面板已经是 modal 了，
   * 再套一层在窄屏上会挤成一条缝；而且用户往往要**对照着动作网格里的
   * 预览**调参数（「帧率改大一点看看」），弹窗会挡住它。
   */
  let editingAction = '';
  /**
   * 动画参数编辑区的**草稿值**（`{字段名: 值}`）。
   *
   * 为什么要草稿：这些字段有联动（改了 `frames` 之后 `frameMs` 的长度
   * 就得跟着变），逐字段即时提交会让中间状态写进包里。因此编辑区先攒在
   * 草稿里，用户点「保存」才一次性提交。
   */
  let actionDraft = null;
  /**
   * 预览器是否处于「播放」状态。
   *
   * 必须**独立记录**，不能在渲染时读 `player.playing`：`render()` 一开始就把
   * 旧播放器 dispose 掉了，而 `renderPreview()` 是在新播放器创建**之前**跑的，
   * 那时 `player` 还是 null —— 读它会让按钮永远显示「播放」，
   * 用户点一下看起来毫无反应（实测就是这么发现的）。
   */
  let previewPlaying = true;
  /**
   * 播放/暂停按钮的引用（就地更新它的文字）。
   *
   * **不能**用 `render()` 来刷新按钮状态：`render()` 会重建整个面板，
   * 而重建又会重新 `load()` 播放器（从头播）。对 `loop: false` 的动作
   * （`click` / `land` / `happy`）来说，「播完 → onEnd → render → 重新 load →
   * 又播一遍」是一个**无限循环**——实测就是这个症状：点一下「被点击」，
   * 它会永远循环播下去，而按钮文字还停在「播放」。
   */
  let previewToggle = null;

  /** 就地同步播放/暂停按钮的文字（不重建面板）。 */
  function syncPreviewToggle() {
    if (previewToggle) previewToggle.textContent = previewPlaying ? '暂停' : '播放';
  }
  /**
   * 待挂载的预览器信息。
   *
   * `render()` 只造节点、不插进文档，而帧几何依赖预览框的**真实宽度**
   * （`clientWidth` 只有挂上才有值）。因此渲染时先把「要播什么」记在这里，
   * 由 `render()` 末尾的 `mountPreviewPlayer()` 真正挂载。
   */
  let pendingPreview = null;

  const config = getConfig || (() => ({}));
  const ownSettings = getOwnSettings || (() => ({}));

  // ---------------------------------------------------------------- 工具

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * 一个**可折叠**的设置区块（默认收起）。
   *
   * 为什么要它：用户要求「设置项会放开比较多，因此要考虑好 UI 的设计……
   * 应当避免一股脑地把所有的设置项都展开来，比如可以按照你分析的常用与否的
   * 设置项来分级，常用的就是直接可以看到，那些不太常用的，则平时收起来，
   * 用户需要的时候可以随时展开」。
   *
   * 因此分两档：
   * - **常用**：直接平铺（大小倍率、渲染方式、触发时间、动画预览）；
   * - **进阶**：收进这里（物理参数、锚点、每动作动画参数…）。
   *
   * 折叠状态**按区块名记住**（模块级 `expandedSections`）：重渲染时不会
   * 自己弹回去——面板每次改设置都会整体重渲染，不记住的话用户展开之后
   * 一拖滑块它就又收起来了。
   *
   * @param {string} title 区块标题。
   * @param {object} options
   * @param {string} options.key 折叠状态的键（默认用标题）。
   * @param {string} options.hint 标题下方的一行说明（收起时也显示）。
   * @param {string} options.badge 标题右侧的徽章文字。
   * @param {boolean} options.defaultOpen 首次渲染时是否展开。
   */
  function renderCollapsible(title, options = {}) {
    const key = options.key || title;
    const open = expandedSections.has(key)
      ? expandedSections.get(key)
      : Boolean(options.defaultOpen);

    const section = el('div', 'pet-section is-collapsible');
    if (open) section.classList.add('is-open');

    const head = el('button', 'pet-section-toggle');
    head.type = 'button';
    head.dataset.marqueeIgnore = 'true';
    head.dataset.sectionKey = key;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    // 三角指示器：收起时朝右、展开时朝下。用 CSS 画，不引入图标资源。
    head.appendChild(el('span', 'pet-section-caret'));
    head.appendChild(el('span', 'pet-section-toggle-label', title));
    if (options.badge) {
      head.appendChild(el('span', 'pet-badge', options.badge));
    }
    head.appendChild(el('span', 'pet-section-toggle-hint', open ? '收起' : '展开'));
    head.addEventListener('click', () => {
      // 就地切换，**不整片重渲染**：重渲染会丢掉正在编辑的输入框内容，
      // 而用户可能只是展开看一眼再继续填。
      const next = !section.classList.contains('is-open');
      section.classList.toggle('is-open', next);
      head.setAttribute('aria-expanded', next ? 'true' : 'false');
      const hint = head.querySelector('.pet-section-toggle-hint');
      if (hint) hint.textContent = next ? '收起' : '展开';
      expandedSections.set(key, next);
    });
    section.appendChild(head);

    if (options.hint) {
      section.appendChild(el('div', 'pet-field-hint', options.hint));
    }
    const body = el('div', 'pet-section-body');
    section.appendChild(body);
    // 调用方往 `body` 里塞内容
    section.body = body;
    return section;
  }

  function button(label, className, onClick) {
    const node = el('button', `pet-button ${className || ''}`.trim(), label);
    node.type = 'button';
    node.dataset.marqueeIgnore = 'true';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  /**
   * 把滑块的**已选进度**写进 CSS 变量（`plugin.css` 用它画色带）。
   *
   * 宿主预设编辑器用的是同一个手法（`--preset-editor-range-progress`）：
   * 原生 `input[type=range]` 没有「已选比例」这个可样式化的部分，
   * 只能由 JS 算出来交给 `linear-gradient`。
   *
   * 每次 `input` 都要调（拖动的每一帧），因此这里刻意写得极简：
   * 一次 `Number`、一次夹取、一次字符串写入，不建对象、不查 DOM。
   */
  function syncSliderProgress(slider) {
    if (!slider) return;
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || 0;
    const value = Number(slider.value);
    const span = max - min;
    // 区间非法（max <= min）时给 0 而不是 NaN：NaN% 会让整条渐变失效，
    // 表现是滑块变成一片透明（看起来像「坏了」）
    const percent = span > 0 && Number.isFinite(value)
      ? Math.round(Math.min(100, Math.max(0, ((value - min) / span) * 100)) * 100) / 100
      : 0;
    slider.style.setProperty('--pet-slider-progress', `${percent}%`);
  }

  /**
   * 给一个**已存在的**滑块配一个可直接输入的数字框。
   *
   * 为什么单独拆出来而不是全走 `createSliderRow`：触发时间那两个滑块是
   * 「一个读数、两个滑块」（下界 / 上界），不符合「一滑块一数值」的形状；
   * 而且它们的接线方式被 `tests/test_frontend_wiring.py` 的
   * 「松手才提交」契约钉住（`input` 只更新读数、`change` 才发请求），
   * 那条契约必须原样保留。这里只补上「数字可输入」这一项能力。
   *
   * 夹取范围交给调用方（`clamp`），因为两个滑块的合法区间是**行为自己的**
   * 默认区间，而不是全局的 200~3600000。
   *
   * @param {HTMLElement} slider 已接好线的 range
   * @param {object} options
   * @param {string} options.label 无障碍标签
   * @param {function} options.clamp `(raw) => number` 夹取 + 按步长对齐
   * @param {function} options.onInput `(value)` 实时回调（只更新读数）
   * @param {function} options.onCommit `(value)` 确认回调（提交后端 / 写草稿）
   * @param {function} [options.format] `(value) => string`
   * @returns {{input: HTMLElement, push: function}} 数字框本身，以及
   *   「夹取 → 同步两边 → 通知调用方」这个动作。
   *
   *   为什么要把 `push` 交出去：**滑块自己也要用它**。
   *   重构时很容易只给数字框接上回调，而把滑块的 `input` / `change` 忘掉
   *   ——表现是「拖滑块完全没反应、数字框却好用」（真实发生过，
   *   被 `tools/verify-upload.mjs` 的 ⑲ 抓出来）。两边共用同一份逻辑，
   *   就不会出现「只有一边能用」。
   */
  function attachNumberBox(slider, options) {
    const clamp = options.clamp;
    const format = typeof options.format === 'function'
      ? options.format
      : (value) => String(value);

    const number = el('input', 'pet-slider-number');
    number.type = 'number';
    number.min = slider.min;
    number.max = slider.max;
    number.step = slider.step;
    number.value = format(clamp(slider.value));
    number.setAttribute('aria-label', `${options.label}（可直接输入）`);
    number.dataset.marqueeIgnore = 'true';

    /** 把某个值同步到滑块 + 数字框 + 进度条，并按需通知调用方。 */
    const push = (raw, commit) => {
      const value = clamp(raw);
      slider.value = String(value);
      number.value = format(value);
      syncSliderProgress(slider);
      if (options.onInput) options.onInput(value);
      if (commit && options.onCommit) options.onCommit(value);
      return value;
    };

    // 输入中只做**视觉回显**，不夹取数字框自己的显示值。
    // 每次按键都夹取的话，用户想输 `10000` 时打完 `1` 就被夹成下限，
    // 后面几位根本输不进去（真实踩过的输入框体验问题）。
    number.addEventListener('input', () => {
      const value = Number(number.value);
      if (!Number.isFinite(value)) return;
      const min = Number(slider.min);
      const max = Number(slider.max);
      const bounded = Math.min(Math.max(value, min), max);
      slider.value = String(bounded);
      syncSliderProgress(slider);
      if (options.onInput) options.onInput(bounded);
    });
    // 失焦 / 回车才夹取并提交，同时把显示值规整成真正生效的那个数——
    // 否则用户输入 999（超上限）会看到「显示 999、实际 3600000」这种错位
    number.addEventListener('change', () => push(number.value, true));
    number.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        push(number.value, true);
        number.blur();
      }
    });
    return { input: number, push };
  }

  /**
   * 造一个「滑块 + 可直接输入的数字框」。
   *
   * 用户要求：「目前的数字调节不够方便，通过拖拽有时难以精确调整，
   * 请同步支持直接选择数字部分进行输入修改，只要限制好输入数据的范围即可」。
   *
   * 设计要点：数字框与滑块共享**同一个夹取逻辑**（按步长对齐 + 夹到区间），
   * 因此从哪边改都得到同一个合法值。两边各写一份夹取必然会在某次改动后不一致。
   *
   * @param {object} options
   * @param {number} options.min 下限
   * @param {number} options.max 上限
   * @param {number} options.step 步长
   * @param {number} options.value 初值
   * @param {string} options.label 无障碍标签
   * @param {string} [options.className] 给滑块的额外类
   * @param {function} options.onInput `(value)` 实时回调（只更新读数）
   * @param {function} [options.onCommit] `(value)` 确认回调（提交后端）
   * @param {function} [options.format] `(value) => string`
   * @returns {{slider: HTMLElement, number: HTMLElement, row: HTMLElement, set: function}}
   */
  function createSliderRow(options) {
    const min = Number(options.min);
    const max = Number(options.max);
    const step = Number(options.step) || 1;

    /**
     * 夹到区间内并按步长对齐。
     *
     * 对齐不能省：数字框允许任意输入（`step` 只约束原生 spinner 与校验），
     * 不对齐就会出现 `1.2300000000000002` 这种值，而后端会把它原样存下来。
     */
    const clamp = (raw) => {
      const number = Number(raw);
      const base = Number.isFinite(number) ? number : min;
      const bounded = Math.min(Math.max(base, min), max);
      const snapped = Math.round(bounded / step) * step;
      // 浮点乘法会留尾巴（0.05 × 23 = 1.1500000000000001），
      // 按步长的小数位数取整后再夹一次
      const digits = (String(step).split('.')[1] || '').length;
      const rounded = Number(snapped.toFixed(digits));
      return Math.min(Math.max(rounded, min), max);
    };

    const slider = el('input', `pet-slider ${options.className || ''}`.trim());
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(clamp(options.value));
    slider.setAttribute('aria-label', options.label);

    const box = attachNumberBox(slider, {
      label: options.label,
      clamp,
      format: options.format,
      onInput: options.onInput,
      onCommit: options.onCommit,
    });

    // ⚠️ 滑块**自己**的回调也要接上。
    //
    // 只给数字框接线、把滑块的 `input`/`change` 忘掉，表现是
    // 「拖滑块完全没反应，数字框却好用」——两边共用 `box.push`，
    // 就不会出现只有一边能用的情况。
    // 拖动时只回显（`push(..., false)`），松手才提交（`push(..., true)`），
    // 否则一次拖动会打出几十个请求。
    slider.addEventListener('input', () => box.push(slider.value, false));
    slider.addEventListener('change', () => box.push(slider.value, true));

    const row = el('div', 'pet-slider-row');
    row.appendChild(slider);
    row.appendChild(box.input);
    syncSliderProgress(slider);

    return {
      slider,
      number: box.input,
      row,
      /** 外部改了值（例如「恢复默认」）时就地刷新，不重建面板。 */
      set(value) {
        const next = clamp(value);
        slider.value = String(next);
        box.input.value = (options.format || String)(next);
        syncSliderProgress(slider);
      },
    };
  }

  function setNotice(kind, message) {
    notice = message ? { kind, message } : null;
    render();
  }

  /**
   * **显示开关**：把宠物关掉 / 打开。
   *
   * 用户报障的原始形态是：「目前好像只有卸载或者停用宠物插件才能关闭宠物，
   * 不太合理」。确实不合理——想安静一会儿却要卸载插件，代价完全不对等。
   *
   * 语义边界（面板上也要说清，否则用户会以为「关闭」=「停用」）：
   * 关掉的是**宠物**，不是插件。面板、坞入口、所有设置都还在；
   * 想让它回来，再点一下这个开关就行。
   */
  function renderVisibility() {
    const hidden = Boolean(hiddenState);
    const box = el(
      'div',
      `pet-visibility ${hidden ? 'is-hidden' : ''}`.trim(),
    );

    const copy = el('div', 'pet-visibility-copy');
    const title = el('div', 'pet-visibility-title');
    title.appendChild(el('span', null, hidden ? '宠物已关闭' : '宠物显示中'));
    title.appendChild(el(
      'span',
      `pet-badge ${hidden ? 'is-builtin' : ''}`.trim(),
      hidden ? '已隐藏' : '运行中',
    ));
    copy.appendChild(title);
    copy.appendChild(el(
      'div',
      'pet-field-hint',
      hidden
        ? '屏幕上不会显示宠物，也不会占用任何动画资源。'
          + '插件仍然启用——想让它回来，点右边的「显示宠物」即可。'
        : '不想看到它时可以在右边把它关掉，不必卸载或停用插件。',
    ));
    box.appendChild(copy);

    const actions = el('div', 'pet-panel-toolbar');
    const toggle = button(
      hidden ? '显示宠物' : '关闭宠物',
      hidden ? 'is-primary' : '',
      () => toggleVisibility(!hidden),
    );
    toggle.dataset.visibilityToggle = 'true';
    // 让验收脚本与用户都能一眼看出当前状态（也便于 CSS 分别着色）
    toggle.dataset.visibilityHidden = hidden ? 'true' : 'false';
    actions.appendChild(toggle);
    box.appendChild(actions);
    return box;
  }

  /**
   * 切换显示状态。
   *
   * 回调失败时**不吞掉**：`onHiddenChange` 内部已经做了回滚，
   * 这里只需把错误呈现出来。
   */
  async function toggleVisibility(hidden) {
    if (!onHiddenChange) return;
    await withBusy(async () => {
      try {
        await onHiddenChange(hidden);
        setNotice('ok', hidden ? '已关闭宠物' : '已显示宠物');
      } catch (error) {
        setNotice('error', `切换失败：${(error && error.message) || error}`);
      }
    });
  }

  /**
   * 由 `plugin.js` 在开关变化后回灌状态。
   *
   * 为什么需要它：`plugin.js` 才是显示状态的权威来源（它管着宠物视图的
   * 生与死），面板只是它的一个视图。后台改状态（诊断句柄 `stmPet.hide()`）
   * 也要让面板跟上。
   */
  function setHiddenState(next) {
    hiddenState = Boolean(next);
    if (root) render();
  }

  /**
   * 把「只显示第 0 帧」的几何写进**每一个**小预览框
   * （形象卡片的缩略图 **与** 动作网格的小图）。
   *
   * 关键点：帧图是**整条 spritesheet**，方框只有 40 / 56px。
   * 要让第 0 帧刚好填满方框，背景图必须按「单帧宽 × 帧数」放大，
   * 并且**左对齐**（`position 0 0`）——居中会把第 1、2 帧露进来。
   *
   * ⚠️ **必须逐个框算，且用每个框自己的帧数。** 真实踩过的 bug：
   * 老实现用 `root.querySelector('.pet-card-thumb')` 只取**第一张**卡片，
   * 再用 `detail`（**当前选中**那个形象）的帧数去设它的几何。
   * 两个后果叠加：
   *
   * 1. 只有列表里第一张卡片被设了几何，其余卡片停在 CSS 默认值
   *    （`background-size: auto`）——整条 4 帧的 spritesheet 按原尺寸铺开，
   *    40px 的方框里只看到**最左边一条透明边**，看起来就是「没有形象展示」；
   * 2. 第一张卡片用的是**选中形象**的帧数，与它自己的图无关。
   *
   * 实测症状正是用户报的那个：小卡（列表第一张）有图，小满没有。
   * 现在帧数从**列表接口**拿（`list_pets()` 已经把每个形象的帧信息带回来了），
   * 因此每张卡片都能独立算对，也不依赖「当前选中了谁」。
   *
   * ⚠️ 动作网格的小图**也必须在这里一起处理**。原实现只查
   * `.pet-card-thumb`，而 `renderActionTile()` 同样写了 `data-frames` /
   * `data-layout` / `data-has-image`（注释还写着「按帧数放大 + 左对齐」），
   * 却**没有任何人**去读它们——于是动作网格里的小图停在
   * `background-size: auto`，只露出整条 spritesheet 左上角那 56×56 的一块
   * （在 1536×576 的 idle 上正好落在**空白区域**），
   * 表现为「动作网格里所有预览图都是空白的」（整片格子只有文字）。
   * 这与上面那个卡片 bug 是**同一个成因**：加了一处预览框，忘了加进选择器。
   *
   * 因此这里改成**按 `data-` 契约选择**：任何写了 `data-frames` 的小框都会被
   * 覆盖，将来再加一处也不会重蹈覆辙。没有 `data-has-image` 的框
   * （例如「没有可用的图」那张卡）会被跳过，仍走单帧分支。
   *
   * ⚠️ **网格排布**（`data-cols` / `data-rows`）也要处理：小框里要露出的
   * 是「第 0 帧」，而第 0 帧在网格里就是**左上角那一格**——铺法与单行一致
   * （左对齐 + 顶对齐），但整条 sheet 的尺寸要按**行列数**放大，而不是按帧数。
   * 按帧数算的话，2×2 的 4 帧网格会被铺成「一行 4 帧」，小框里露出的是
   * 第 0 帧 + 一部分第 1 帧，看起来像图被切了一半。
   */
  function applyThumbGeometry() {
    if (!root) return;
    const boxes = root.querySelectorAll('.pet-card-thumb, .pet-action-preview');
    for (const box of boxes) {
      const frames = Math.max(1, Number(box.dataset.frames) || 1);
      const grid = frameGrid({
        frames,
        layout: box.dataset.layout,
        cols: box.dataset.cols,
        rows: box.dataset.rows,
      });
      const boxWidth = box.clientWidth || 40;
      const boxHeight = box.clientHeight || 40;

      if (!box.dataset.hasImage || frames <= 1) {
        // 单帧：整张图就是那一帧，`contain` 是对的
        box.style.backgroundSize = 'contain';
        box.style.backgroundPosition = 'center';
        continue;
      }

      // 多帧：把**单帧**放大到至少盖住方框（`cover` 语义），再只露左上角那一格。
      //
      // 为什么是 `cover`（两个方向都取 `max`）而不是「钉住某一个方向」：
      // 钉宽或钉高**只在单行 / 单列时安全**——
      // - 单行（`rows === 1`）钉宽 → 帧宽正好等于框宽，横向不漏；纵向没有邻行；
      // - 单列（`cols === 1`）钉高 → 帧高正好等于框高，纵向不漏；横向没有邻列。
      //
      // 但**网格**两个方向都有邻格，钉错方向就会漏：竖构图的帧（例如 384×576）
      // 在网格里若钉高，帧宽只有框宽的 2/3 —— 方框右侧就露出**右边那一列**
      // 的一部分，看起来像缩略图被切了一半。
      //
      // `cover` 让帧在两个方向都 >= 方框，于是无论排布如何都不可能漏。
      // 而且它在既有素材上与改动前的行为**完全一致**：
      // 竖构图（384×576）的 `cover` 等于钉宽、横构图（627×353）等于钉高。
      const cellW = Number(box.dataset.cellW) || 0;
      const cellH = Number(box.dataset.cellH) || 0;
      if (cellW > 0 && cellH > 0) {
        const scale = Math.max(boxWidth / cellW, boxHeight / cellH);
        box.style.backgroundSize =
          `${cellW * scale * grid.cols}px ${cellH * scale * grid.rows}px`;
      } else if (grid.cols === 1) {
        // 不知道单帧比例：退回「钉高」（旧行为，单列排布下是对的）
        box.style.backgroundSize = `auto ${boxHeight * grid.rows}px`;
      } else {
        // 退回「钉宽」（旧行为，单行排布下是对的）
        box.style.backgroundSize = `${boxWidth * grid.cols}px auto`;
      }
      box.style.backgroundPosition = '0 0';
      // 图片内容变了（URL 带版本），几何不用跟着变——版本变了浏览器自然会换图
    }
  }

  /** 统一的后端调用 + 错误呈现（错误信息由后端给出可读文案）。 */
  async function call(path, options) {
    const data = await api.api(path, options);
    if (!data || !data.success) {
      const message = (data && (data.msg || data.error)) || '请求失败';
      const hint = (data && data.hint) || '';
      setNotice('error', hint ? `${message}（${hint}）` : message);
      return null;
    }
    return data;
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      return await fn();
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  // ---------------------------------------------------------------- 数据

  async function refresh() {
    const data = await call('/pets');
    if (!data) return;
    pets = data.items || [];
    activeId = data.activePetId || '';
    // 因**目录名不合法**被跳过的目录（后端 `_scan_dir` 收集）。
    //
    // 为什么要显示：目录名**就是形象 id**，而合法字符集是
    // 「小写字母、数字、`.` `_` `-`，且以字母或数字开头」。
    // 用户把目录命名成 `xiaoka-自定义` 这种（很自然的中文命名）时，
    // 插件过去是**静默跳过**的——表现为「我明明放进去了，列表里却没有」。
    invalidDirs = Array.isArray(data.invalidDirs) ? data.invalidDirs : [];
    if (data.limits) {
      limits = {
        scaleMin: Number(data.limits.scaleMin) || SCALE_MIN,
        scaleMax: Number(data.limits.scaleMax) || SCALE_MAX,
        scheduleMinMs: Number(data.limits.scheduleMinMs) || SCHEDULE_FALLBACK_MIN_MS,
        scheduleMaxMs: Number(data.limits.scheduleMaxMs) || SCHEDULE_FALLBACK_MAX_MS,
      };
    }
    if (!selectedId || !pets.some((item) => item.id === selectedId)) {
      selectedId = activeId || (pets[0] ? pets[0].id : '');
    }
    await loadDetail(selectedId);
  }

  async function loadDetail(petId) {
    if (!petId) {
      detail = null;
      render();
      return;
    }
    const data = await call(`/pets/${encodeURIComponent(petId)}/preview`);
    detail = data || null;
    // 换形象时把预览器切回「待机」：停在别的形象的动作上会让人以为没切成功
    previewAction = 'idle';
    previewVariant = 0;
    previewPlaying = true;
    if (!disposed) render();
  }

  /** 当前预览的动作条目（从 `detail.actions` 里取）。 */
  function previewEntry() {
    const list = (detail && detail.actions) || [];
    return list.find((item) => item.action === previewAction) || null;
  }

  /**
   * 当前预览的变体（多套动画时按 `previewVariant` 选）。
   *
   * 返回值里**必须带上单帧尺寸**：预览框要按真实宽高比把这一帧装进去，
   * 而躺姿睡觉这类动作是横构图，不知道尺寸就会被压扁（用户报的那个）。
   * 优先级与桌面宠物完全一致（`animation.js:frameSizeOf`）：
   * **变体自带 > 动作条目 > 包级**。
   */
  function previewSpec() {
    const entry = previewEntry();
    if (!entry) return null;
    const variants = entry.variants || [];
    const pick = variants.length
      ? variants[Math.min(Math.max(0, previewVariant), variants.length - 1)]
      : null;
    if (!pick && !entry.url) return null;
    // 老版本后端只给主变体字段，这里兜底构一个
    const base = pick || {
      url: entry.url,
      pages: entry.pages,
      frames: entry.frames,
      fps: entry.fps,
      loop: entry.loop,
      layout: entry.layout,
      cols: entry.cols,
      rows: entry.rows,
      frameMs: entry.frameMs || [],
      // 程序化运动也要兜底带上：漏了的表现是「桌面在呼吸、面板里不动」
      // ——而面板正是用户判断效果的地方。
      motion: entry.motion,
      motionOrigin: entry.motionOrigin,
    };
    return Object.assign({}, base, {
      size: frameSizeOf(base, entry, detail && detail.size),
      // 网格几何一并带上（`preview.js` 的播放器只认 `cols` / `rows`）。
      // 缺失时由 `frameGrid` 按 `layout` + 帧数推——那条路径服务的是
      // 「老后端不下发网格」，此时行为与从前完全一致。
      cols: frameGrid(base).cols,
      rows: frameGrid(base).rows,
      // 多页：`pages` 是每一页的图 URL。单页时后端只给 `url`，
      // 这里补成长度 1 的数组——播放器因此只有一种形状要处理
      // （「有时是数组、有时是字符串」是最容易漏判的那种差异）。
      pages: (Array.isArray(base.pages) && base.pages.length
        ? base.pages
        : [base.url]).filter(Boolean),
    });
  }

  // ---------------------------------------------------------------- 操作

  async function activatePet(petId) {
    await withBusy(async () => {
      const data = await call('/pets/active', { method: 'POST', body: { petId } });
      if (!data) return;
      activeId = data.activePetId;
      setNotice('ok', '已切换形象');
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function deletePet(petId) {
    await withBusy(async () => {
      const data = await call(`/pets/${encodeURIComponent(petId)}`, { method: 'DELETE' });
      if (!data) return;
      setNotice('ok', '已删除');
      if (selectedId === petId) selectedId = '';
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function importPack(file, { replace = false } = {}) {
    const form = new FormData();
    form.append('file', file);
    if (replace) form.append('replace', '1');
    await withBusy(async () => {
      const data = await call('/pets/import', { method: 'POST', body: form });
      if (!data) return;
      activeId = data.activePetId;
      selectedId = data.pet ? data.pet.id : '';
      setNotice('ok', `已导入「${data.pet ? data.pet.name : ''}」并设为当前形象`);
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function uploadActionImage(action, file) {
    const form = new FormData();
    form.append('file', file);
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/actions/${encodeURIComponent(action)}`,
        { method: 'POST', body: form },
      );
      if (!data) return;
      setNotice('ok', `「${ACTION_LABELS[action] || action}」已更新`);
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  async function clearActionImage(action) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/actions/${encodeURIComponent(action)}`,
        { method: 'DELETE' },
      );
      if (!data) return;
      setNotice('ok', '已恢复包内原图');
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  /**
   * 导出形象包（一键下载 zip）。
   *
   * 走**浏览器的原生下载**而不是 `api.api()`：后者会把响应体当 JSON 解析，
   * 而这里是二进制 zip。用 `<a download>` 触发，让浏览器自己处理
   * `Content-Disposition` —— 这样进度、取消、保存位置都由浏览器负责。
   *
   * 内置形象后端会直接 403，面板也不会显示这个按钮（双保险）。
   */
  function exportPet(petId) {
    const url = `/api/plugins/stm-pet/pets/${encodeURIComponent(petId)}/export`;
    const link = el('a', 'pet-download-link');
    link.href = url;
    link.download = `${petId}.zip`;
    // 必须内联隐藏：它挂在 body 下，作用域 CSS 匹配不到（与 pickFile 同一个坑）
    link.style.position = 'absolute';
    link.style.left = '-9999px';
    link.style.top = '0';
    link.style.opacity = '0';
    link.style.pointerEvents = 'none';
    link.setAttribute('aria-hidden', 'true');
    document.body.appendChild(link);
    try {
      link.click();
      setNotice('ok', '已开始下载形象包');
    } finally {
      // 立刻回收：下载已经在浏览器的队列里，节点不需要留着
      if (link.parentNode) link.parentNode.removeChild(link);
    }
  }

  /**
   * 把内置形象**复制成用户形象**（复制出来的可改：帧率、图片、触发节奏…）。
   *
   * 为什么不引导用户自己复制目录：那条路有两个坑（实测都绊到过用户）——
   * 目录名就是 id（只能用 `[a-z0-9._-]`，中文会被整目录跳过），
   * 以及「内置 / 自定义」只看目录位置（放到 `resources/pets/` 下仍是只读，
   * 改 id、改 author 都没用）。这里由后端一次做对。
   *
   * 复制完**自动切过去**：用户的意图就是「我要改这个」，切过去才谈得上改。
   */
  async function copyPet(petId) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(petId)}/copy`,
        { method: 'POST', body: {} },
      );
      if (!data) return;
      const newId = data.pet && data.pet.id;
      setNotice('ok', `已复制为「${newId}」，现在可以改帧率 / 换图 / 调触发时间了`);
      if (newId) {
        // 切到新形象并选中它，省得用户再去列表里找
        const activated = await call('/pets/active', { method: 'POST', body: { petId: newId } });
        if (activated) activeId = activated.activePetId || newId;
        selectedId = newId;
      }
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /** 调整大小倍率 / 渲染方式（按形象保存，立即生效）。 */
  async function updateAppearance(patch, { silent = false } = {}) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/appearance`,
        { method: 'POST', body: patch },
      );
      if (!data) return;
      if (!silent) setNotice('ok', '外观已更新');
      // 让运行中的宠物立刻用上新尺寸（不必刷新页面）
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /** 清理内置形象的遗留覆盖（那些文件已不再生效）。 */
  async function clearLegacyOverrides() {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/overrides`,
        { method: 'DELETE' },
      );
      if (!data) return;
      const removed = (data.removed || []).length;
      setNotice('ok', removed ? `已清理 ${removed} 个遗留覆盖` : '没有需要清理的覆盖');
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  /**
   * 调整某行为的**触发时间**（逐形象保存，内置形象同样可调）。
   *
   * 这两项（`idle` 小动作 / 自动漫游）是唯一由时间驱动的行为，
   * 因此也是唯一能设「多久一次」的。落点是 `data/settings.json` 而不是
   * `pet.json`——它属于「这台机器上怎么养」的偏好，而且**内置形象必须能调**
   * （内置形象是只读的，而它恰恰是大多数用户唯一会用的形象）。
   */
  async function updateSchedule(behavior, patch) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/schedule`,
        { method: 'POST', body: { schedule: { [behavior]: patch } } },
      );
      if (!data) return;
      // 让运行中的宠物立刻用上新节奏（不必刷新页面）
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /** 清掉某形象的**全部**节奏覆盖（回落到包内声明 / 默认值）。 */
  async function resetSchedule() {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/schedule`,
        { method: 'POST', body: { reset: true } },
      );
      if (!data) return;
      setNotice('ok', '已恢复默认触发时间');
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /**
   * 改写**自建形象**的元信息：名字 / 作者 / 标准图像。
   *
   * 与 `/appearance`（大小、渲染方式）的分工：那个改的是「用户怎么看」，
   * 落在 `data/settings.json`，内置形象也能改；这个改的是**形象本身**
   * （写进 `pet.json`），因此只对自建形象开放。
   */
  async function updateMeta(patch, { message = '已更新' } = {}) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/meta`,
        { method: 'POST', body: patch },
      );
      if (!data) return;
      setNotice('ok', message);
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /**
   * 提交「新建形象」。
   *
   * 每个动作一个文件字段，字段名就是动作名；帧数/帧率走 `meta` 这个 JSON 字段。
   * 只提交**填了图**的动作——空字段会被后端当成「没提供」。
   *
   * 标准图像有两种提交形态（见 `draftStill`）：复用某个动作的某一帧走 JSON，
   * 单独上传一张走文件字段 `still`。后端两种都认。
   */
  async function submitCreate() {
    const name = draftName.trim();
    if (!name) {
      setNotice('error', '请先给形象起个名字');
      return;
    }
    if (!draft.idle || !draft.idle.file) {
      setNotice('error', '至少要给「待机」上传一张图');
      return;
    }

    const form = new FormData();
    form.append('name', name);
    // 作者署名：**总是提交**（哪怕是空串），让用户看到「署名」这件事存在。
    form.append('author', draftAuthor.trim());
    form.append('scale', String(draftScale));
    form.append('pixelated', draftPixelated ? '1' : '0');
    const meta = {};
    for (const [action, entry] of Object.entries(draft)) {
      if (!entry || !entry.file) continue;
      form.append(action, entry.file);
      meta[action] = { frames: Math.max(1, Number(entry.frames) || 1) };
      if (entry.fps) meta[action].fps = Number(entry.fps);
    }
    form.append('meta', JSON.stringify(meta));

    // ---- 标准图像
    //
    // 两种形态共用 `still` 这个字段名，但**一个是文件、一个是 JSON 文本**：
    // Flask 会把它们分别放进 `request.files` 与 `request.form`，因此能共存。
    // 这样后端只需要认一个字段名，不必为两种来源各写一条通路。
    if (draftStill && draftStill.file) {
      form.append('still', JSON.stringify({
        frames: Math.max(1, Number(draftStill.frames) || 1),
      }));
      form.append('still', draftStill.file);
    } else if (draftStill && draftStill.action) {
      form.append('still', JSON.stringify({
        action: draftStill.action,
        frame: Math.max(0, Number(draftStill.frame) || 0),
      }));
    }

    // ---- 触发节奏（只在用户真的改过时才写进 pet.json）
    if (draftSchedule) {
      form.append('schedule', JSON.stringify(draftSchedule));
    }

    await withBusy(async () => {
      const data = await call('/pets/create', { method: 'POST', body: form });
      if (!data) return;
      activeId = data.activePetId;
      selectedId = data.pet ? data.pet.id : '';
      creating = false;
      draft = {};
      draftName = '';
      draftAuthor = '';
      draftStill = null;
      draftSchedule = null;
      setNotice('ok', `已创建「${data.pet ? data.pet.name : name}」并设为当前形象`);
      await refresh();
      if (onPetChanged) await onPetChanged(activeId);
    });
  }

  /**
   * 打开系统文件选择器（导入形象包 / 逐动作换图共用）。
   *
   * ⚠️ 两个**必须**遵守的点，都是实测踩出来的：
   *
   * 1. **隐藏必须内联写死，不能只靠 `.pet-file-input` 那个类。**
   *    这个 `<input>` 挂在 `document.body` 上（面板在 modal 里，祖先带
   *    `overflow` / `transform` 时原生选择器行为不稳定，且不该进宿主的焦点陷阱），
   *    而 `plugin.css` 里的 `.plugin-stm-pet .pet-file-input` 是**作用域内**选择器
   *    （F11 强制要求每条顶层规则以插件作用域为根），匹配不到 body 下的裸 input ——
   *    结果是原生「选择文件 / 未选择任何文件」控件直接排在页面底部，
   *    **每点一次多一条，刷新页面才消失**。
   *
   *    注意**不能**用「给 CSS 加一条裸 `.pet-file-input` 规则」来修：那会让
   *    `installer.scan_css_scope()` 判定整份样式违规并拒绝加载（症状变成「面板
   *    完全没样式」）。内联 style 是唯一既过作用域检查、又能真正隐藏的写法。
   *
   * 2. **取消也必须回收元素。** 用户点「取消」时浏览器只派发 `cancel`
   *    （Safari / 旧 Firefox 连 `cancel` 都不派发），**不派发 `change`** ——
   *    只监听 `change` 会让这个 input 永久留在 DOM 里。
   *    因此 `change` / `cancel` / 「窗口重新获得焦点后仍无文件」三条路都要收。
   */
  function pickFile({ accept, onPicked }) {
    const input = el('input', 'pet-file-input');
    input.type = 'file';
    if (accept) input.accept = accept;
    // 内联的视觉隐藏（不依赖作用域选择器，见上面第 1 点）
    input.style.position = 'absolute';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      cleanup();
      if (file) onPicked(file);
    });
    // 用户点了「取消」：Chromium 派发 cancel，Safari / 旧 Firefox 不派发
    input.addEventListener('cancel', cleanup);
    // 兜底：对话框关闭后窗口重获焦点；再等一拍仍没有文件就回收
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (!input.files || !input.files.length) cleanup();
      }, 0);
    };
    window.addEventListener('focus', onWindowFocus);

    document.body.appendChild(input);
    input.click();
  }

  // ---------------------------------------------------------------- 渲染

  /**
   * 记住 / 还原两个滚动容器的位置。
   *
   * 为什么需要：`render()` 是**全量重建**（`root.textContent = ''`），
   * 于是两个滚动容器（左栏列表 `.pet-panel-list`、右栏详情
   * `.pet-panel-detail`）都是**新节点**，`scrollTop` 自然从 0 开始。
   *
   * 用户报障：「切换动画预览项时页面每次都会自动滚动到顶部，不方便使用」。
   * 预览项一点就 `render()`，于是右栏每次都被弹回顶部——想接着看下面的
   * 「预览速度」「动作网格」就得重新往下滚，改一个参数要滚一次。
   *
   * 为什么不能改成「只重渲染变化的部分」：面板里几乎所有交互（换图、改倍率、
   * 改触发时间、切选中形象）都会改变右栏的结构，做增量更新要维护一整套
   * diff 逻辑，而这块代码的复杂度已经很高了。**保留滚动位置**能用极小代价
   * 拿到用户真正在意的那部分体验。
   *
   * ⚠️ 还原必须**在 DOM 挂上之后**（`scrollTop` 对游离节点无效），
   * 而且要**夹到新的上限**——重建后内容高度可能变矮（例如从「新建表单」
   * 切回详情），直接把旧值写回去会被浏览器夹掉，但显式夹一下更清楚。
   */
  function captureScroll() {
    if (!root) return null;
    const list = root.querySelector('.pet-panel-list');
    const detail = root.querySelector('.pet-panel-detail');
    if (!list && !detail) return null;
    return {
      list: list ? list.scrollTop : 0,
      detail: detail ? detail.scrollTop : 0,
    };
  }

  function restoreScroll(saved) {
    if (!root || !saved) return;
    const apply = (selector, value) => {
      const node = root.querySelector(selector);
      if (!node) return;
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.min(Math.max(0, Number(value) || 0), max);
    };
    apply('.pet-panel-list', saved.list);
    apply('.pet-panel-detail', saved.detail);
  }

  function render() {
    if (!root || disposed) return;
    // 重建之前先记下滚动位置，收尾时还原（见 `captureScroll` 的说明）
    const savedScroll = captureScroll();
    // 重渲染会把预览框的 DOM 换掉，旧播放器必须停掉（否则它还在给已摘除的
    // 节点写 style，并留下一个永远跑着的定时器）
    if (player) {
      player.dispose();
      player = null;
    }
    pendingPreview = null;
    root.textContent = '';

    const toolbar = el('div', 'pet-panel-toolbar');
    toolbar.appendChild(button('新建形象', 'is-primary', () => {
      creating = true;
      notice = null;
      render();
    }));
    toolbar.appendChild(button('导入形象包', '', () => {
      pickFile({ accept: '.zip,application/zip', onPicked: (file) => importPack(file) });
    }));
    toolbar.appendChild(button('刷新', '', () => withBusy(refresh)));
    // 帮助按钮：用**已有的按钮样式**（`pet-button`），不引入新的视觉语言。
    // 用户要求「具体的帮助按钮请使用已有的」。
    toolbar.appendChild(button('参数说明', 'is-help', () => {
      showingHelp = !showingHelp;
      creating = false;
      notice = null;
      render();
    }));
    toolbar.appendChild(el('div', 'pet-panel-toolbar-spacer'));
    const count = el('span', 'pet-card-meta', `${pets.length} 个形象`);
    toolbar.appendChild(count);
    root.appendChild(toolbar);

    // ---- 显示开关（放在最显眼的位置）
    //
    // 用户要求「插件应该支持关闭宠物」。这个开关必须**触手可及**：
    // 藏进「设置 → 插件」两层里就等于没有——想安静一会儿还要翻半天，
    // 用户会继续用「卸载插件」那个笨办法。
    root.appendChild(renderVisibility());

    if (notice) {
      const box = el(
        'div',
        `pet-notice ${notice.kind === 'error' ? 'is-error' : ''}`.trim(),
        notice.message,
      );
      root.appendChild(box);
    }

    const body = el('div', 'pet-panel-body');

    // ---- 左栏：形象列表
    const list = el('div', 'pet-panel-list');
    // 被跳过的目录**放在最上面**：这是「我明明放进去了却没有」的唯一解释，
    // 埋在列表底部等于没说。
    for (const skipped of invalidDirs) {
      const box = el('div', 'pet-notice is-warn');
      box.appendChild(el('div', 'pet-notice-title', `目录「${skipped.name}」被跳过`));
      box.appendChild(el('div', 'pet-notice-body', skipped.hint || skipped.reason || ''));
      list.appendChild(box);
    }
    if (!pets.length) {
      list.appendChild(el('div', 'pet-empty', '还没有形象。点击「导入形象包」上传一个 .zip。'));
    }
    for (const pet of pets) {
      list.appendChild(renderPetCard(pet));
    }
    body.appendChild(list);

    // ---- 右栏：选中形象的详情（或新建表单）
    body.appendChild(creating ? renderCreate() : (showingHelp ? renderHelp() : renderDetail()));
    root.appendChild(body);

    // 缩略图几何依赖「帧数」，而帧数在 `detail` 里 —— 必须在 DOM 挂上、
    // 且 `detail` 已就绪之后再算（`clientWidth` 也只有挂上才有值）。
    applyThumbGeometry();
    // 动画预览器同理：要在 DOM 挂上之后才知道预览框的真实宽度
    if (!creating) mountPreviewPlayer();
    // 最后还原滚动位置：必须在 DOM 挂上之后（游离节点的 scrollTop 无效）
    restoreScroll(savedScroll);
  }

  function renderPetCard(pet) {
    const card = el('button', 'pet-card');
    card.type = 'button';
    card.dataset.marqueeIgnore = 'true';
    // 带上 id：验收脚本要能精确点到某一张卡（靠名字匹配会在多语言/改名时失效）
    card.dataset.petId = pet.id;
    if (pet.id === activeId) card.classList.add('is-active');
    if (pet.id === selectedId) card.classList.add('is-selected');
    if (pet.error) card.classList.add('is-broken');
    card.addEventListener('click', () => {
      selectedId = pet.id;
      loadDetail(pet.id);
    });

    const thumb = el('div', 'pet-card-thumb');
    // 缩略图只显示 **idle 的第一帧**。
    //
    // ⚠️ 不能用 `background-size: contain`：`/frame/<id>/idle` 返回的是
    // **整条水平 spritesheet**（例如 4 帧的 idle 是 1536×576），
    // 把整条压进 40px 的方框 → 每帧只剩 10px，看起来像一团乱码（实测）。
    // 正确做法：按「单帧宽 = 帧数 × 方框宽」放大整条，再用
    // `background-position: 0 0` 只露出第 0 帧。
    //
    // 几何所需的帧数来自**列表接口**（`pet.thumb`），而不是「当前选中形象的
    // 详情」——后者只在详情请求回来之后才有，且与本卡片无关。
    // 帧数写在 `data-` 上，由 `applyThumbGeometry()` 统一算（DOM 挂上后
    // 才知道方框的真实宽度）。
    const thumbSpec = pet.thumb || {};
    if (thumbSpec.url) {
      thumb.style.backgroundImage = `url("${thumbSpec.url}")`;
      thumb.style.backgroundRepeat = 'no-repeat';
      thumb.dataset.petId = pet.id;
      thumb.dataset.frames = String(Math.max(1, Number(thumbSpec.frames) || 1));
      thumb.dataset.layout = thumbSpec.layout === 'vertical' ? 'vertical' : 'horizontal';
      // 网格几何：缩略图要按**行列数**放大整条 sheet，而不是按帧数。
      // 2×2 的 4 帧网格按帧数算会被铺成「一行 4 帧」，小框里只露出第 0 帧
      // 加一部分第 1 帧——看起来像图被切了一半。
      thumb.dataset.cols = String(Math.max(1, Number(thumbSpec.cols) || 1));
      thumb.dataset.rows = String(Math.max(1, Number(thumbSpec.rows) || 1));
      // 单帧尺寸：小方框要按它把单帧放大到「盖住方框」，否则网格排布下
      // 会从方框里露出邻格（网格两个方向都有邻居，钉错方向就漏）。
      const thumbSize = thumbSpec.size || pet.size || null;
      if (thumbSize) {
        thumb.dataset.cellW = String(Math.max(1, Number(thumbSize.w) || 1));
        thumb.dataset.cellH = String(Math.max(1, Number(thumbSize.h) || 1));
      }
      thumb.dataset.hasImage = 'true';
    } else {
      // 没有可用的图：留一个空框（面板上仍能看到这个形象存在，而不是破图）
      thumb.dataset.frames = '1';
    }
    card.appendChild(thumb);

    const copy = el('div', 'pet-card-copy');
    copy.appendChild(el('div', 'pet-card-name', pet.name || pet.id));
    const meta = pet.error
      ? '读取失败'
      : `${pet.source === 'user' ? '自定义' : '内置'} · ${pet.animations ? pet.animations.length : 0} 个动作`;
    copy.appendChild(el('div', 'pet-card-meta', meta));
    if (pet.id === activeId) {
      // 用 `is-current` 上强调色：卡片上「正在用」与「正在看」是两个不同的
      // 事实，用户报障时正是把两者看混了（详见 plugin.css 里 `.pet-card`
      // 两种高亮的说明）。这行文字是最直白的那个信号，得让它显眼。
      copy.appendChild(el('div', 'pet-card-meta is-current', '当前使用中'));
    }
    card.appendChild(copy);
    return card;
  }

  /**
   * **帮助页**：把 `HELP_SECTIONS` 渲染成一屏可滚动的说明。
   *
   * 用户要求：「可以给页面添加一个帮助页，具体的帮助按钮请使用已有的，
   * 里面可以解释下不同参数的设置用途以及推荐值」。
   *
   * 它替换掉右栏的**详情**（而不是弹一个新的 modal）：宿主的面板本身已经
   * 是一个 modal 了，再套一层 modal 在窄屏上会挤成一条缝；而且用户读说明时
   * 往往想对照着左边的形象看。
   *
   * `risky: true` 的条目额外用醒目色标出——那正是用户点名要讲清楚的
   * 「比较容易出问题的设置项」（程序化运动与物理参数）。
   */
  function renderHelp() {
    const wrap = el('div', 'pet-panel-detail');

    const bar = el('div', 'pet-help-back');
    bar.appendChild(button('← 返回设置', '', () => {
      showingHelp = false;
      render();
    }));
    bar.appendChild(el('span', 'pet-card-meta', '参数说明与推荐值'));
    wrap.appendChild(bar);

    for (const group of HELP_SECTIONS) {
      const section = el('div', 'pet-section');
      section.appendChild(el('div', 'pet-section-title', group.title));
      for (const entry of group.entries) {
        const row = el('div', 'pet-help-entry');
        const term = el('div', 'pet-help-term');
        term.appendChild(el('span', null, entry.term));
        if (entry.risky) {
          term.appendChild(el('span', 'pet-badge is-warn', '易调坏'));
        }
        row.appendChild(term);
        row.appendChild(el('div', 'pet-help-body', entry.body));
        if (entry.recommend) {
          row.appendChild(el('div', 'pet-help-recommend', `推荐：${entry.recommend}`));
        }
        section.appendChild(row);
      }
      wrap.appendChild(section);
    }
    return wrap;
  }

  function renderDetail() {
    const wrap = el('div', 'pet-panel-detail');

    if (!selectedId || !detail) {
      wrap.appendChild(el('div', 'pet-empty', '从左侧选择一个形象查看详情。'));
      return wrap;
    }

    const header = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, detail.name || detail.id));
    // 来源徽章：内置 / 自定义。用户一眼要能分清「这个能不能改」。
    title.appendChild(el(
      'span',
      detail.writable ? 'pet-badge' : 'pet-badge is-builtin',
      detail.writable ? '自定义' : '插件自带',
    ));
    header.appendChild(title);

    // ---- 作者署名
    //
    // 用户要求「自定义宠物应该支持设置作者名，方便其他人制作宠物发布」。
    // 因此这里对**自建**形象给一个可编辑的输入框；对内置形象只显示
    // （内置形象是随插件发布的，作者固定为「官方」）。
    header.appendChild(renderAuthorRow());
    // `pet.json` 的 `id` 与目录名不一致：**只提示、不拦**。
    //
    // 两者是同一个东西的两个来源，而**目录名**才是生效的那个
    // （`_locate` / 帧 URL / 覆盖解析全按它）。用户复制内置形象时很容易
    // 只改 `pet.json` 的 id（「我改了 id，还是不行」），于是列表里的 id
    // 与文件里写的对不上，排查时极其困惑。
    if (detail.idMismatch) {
      const box = el('div', 'pet-notice is-warn');
      box.appendChild(el('div', 'pet-notice-title', 'pet.json 里的 id 与目录名不一致'));
      box.appendChild(el('div', 'pet-notice-body', detail.idMismatch.hint));
      header.appendChild(box);
    }
    if (detail.size) {
      header.appendChild(el(
        'div',
        'pet-field-hint',
        `单帧尺寸 ${detail.size.w} × ${detail.size.h}px（不必是正方形）`,
      ));
    }

    // 缺失必要动作要说清「缺什么、会怎么回退」（阶段 5 的明确要求，
    // 不是只置灰——用户得知道会发生什么）
    if (detail.missingRequired && detail.missingRequired.length) {
      const names = detail.missingRequired
        .map((name) => `${ACTION_LABELS[name] || name}（${name}）`)
        .join('、');
      const box = el('div', 'pet-notice is-warn');
      box.appendChild(el('div', null, `缺少必要动作：${names}`));
      box.appendChild(el(
        'div',
        'pet-field-hint',
        '这些动作会退化为「只移动位置、不播放动画」，宠物仍然可用；'
        + '想让它在这些状态下也有动作，可以单独给对应动作上传一张图。',
      ));
      header.appendChild(box);
    } else {
      header.appendChild(el('div', 'pet-field-hint', '所有必要动作齐全。'));
    }

    const actions = el('div', 'pet-panel-toolbar');
    if (selectedId !== activeId) {
      actions.appendChild(button('设为当前形象', 'is-primary', () => activatePet(selectedId)));
    }
    if (detail.writable) {
      // 导出只对**用户自建**形象开放（内置的随插件发布，导出没有意义）
      actions.appendChild(button('导出形象包', '', () => exportPet(selectedId)));
      actions.appendChild(button('删除', 'is-danger', () => deletePet(selectedId)));
    } else {
      // ★ 内置形象：给出「复制成我自己的」这条路。
      //
      // 内置形象严格只读（用户明确要求），但「在它基础上改帧率 / 换几张图」
      // 是很自然的需求。此前唯一的路是**手工**把 `resources/pets/<id>/`
      // 复制到 `data/pets/<新 id>/`，而那条路有两个坑（实测都绊到过用户）：
      //   1. 目录名**就是形象 id**，只能用 `[a-z0-9._-]`——命名成
      //      `xiaoka-自定义` 这类会被**整目录跳过**；
      //   2. 判定「内置 / 自定义」**只看目录位置**，与 pet.json 写什么无关
      //      ——复制到 `resources/pets/` 下仍然只读，改 id、改 author 都没用。
      // 这个按钮由后端生成合法 id 并落到 `data/pets/`，一次做对。
      actions.appendChild(button('复制为我的形象', 'is-primary', () => copyPet(selectedId)));
      actions.appendChild(el('span', 'pet-card-meta', '插件自带，形象内容不可修改'));
    }
    header.appendChild(actions);
    wrap.appendChild(header);

    wrap.appendChild(renderAppearance());

    // ---- 触发时间（唯一由时间驱动的两个行为：idle 小动作 / 自动漫游）
    wrap.appendChild(renderSchedule());

    // ---- 动画预览（可以直接播具体动作，内置形象同样支持）
    wrap.appendChild(renderPreview());

    // ---- 进阶：物理参数 / 锚点与单帧尺寸（**默认收起**）
    //
    // 用户要求：「应当避免一股脑地把所有的设置项都展开来……常用的就是直接
    // 可以看到，那些不太常用的，则平时收起来，用户需要的时候可以随时展开」。
    // 物理参数调坏了宠物会变得很怪，因此它属于「不常用但要能调」那一档。
    if (detail.writable) {
      wrap.appendChild(renderPhysicsEditor());
      wrap.appendChild(renderAnchorEditor());
    }

    // ---- 遗留覆盖提示（内置形象专属）
    if (detail.staleOverrides && detail.staleOverrides.length) {
      wrap.appendChild(renderLegacyOverrides());
    }

    // ---- 动作网格
    const section = el('div', 'pet-section');
    section.appendChild(el('div', 'pet-section-title', '动作'));
    if (detail.writable) {
      section.appendChild(el(
        'div',
        'pet-field-hint',
        '点每个动作的「换图」可单独替换该动作（不改动形象包本身）；'
        + '「恢复」会回到包内的原图。',
      ));
    } else {
      section.appendChild(el(
        'div',
        'pet-field-hint',
        '插件自带形象的内容是只读的，因此不提供换图；'
        + '想要自己的版本，可以用「新建形象」做一个。',
      ));
    }

    const grid = el('div', 'pet-action-grid');
    for (const entry of detail.actions || []) {
      grid.appendChild(renderActionTile(entry));
    }
    section.appendChild(grid);

    // ★ 动画参数编辑区**放在网格外面**（而不是卡片里面）。
    //
    // 网格的列宽只有 96px，编辑区塞进去会被挤成一条缝（实测截图里
    // 「帧率」输入框只剩十几个像素宽，标签被截成「长（排布与节奏）」）。
    // 它是**整块表单**，需要整行宽度，因此挂在网格之后、占满整行。
    const editing = (detail.actions || []).find((entry) => entry.action === editingAction);
    if (editing && actionDraft) {
      const panel = el('div', 'pet-action-editor-wrap');
      panel.appendChild(el(
        'div',
        'pet-section-title',
        `「${ACTION_LABELS[editing.action] || editing.action}」的动画参数`,
      ));
      panel.appendChild(renderActionEditor(editing));
      section.appendChild(panel);
    }
    wrap.appendChild(section);

    return wrap;
  }

  /**
   * 外观区：大小倍率 + 渲染方式。
   *
   * 这两项**对内置形象也可调**：它们改的是「怎么看」（落在 `data/` 里的用户偏好），
   * 不是「是什么」（随包资源）。用户的屏幕分辨率与形象风格各不相同——
   * 二次元小图与真人立绘需要的倍率差很多，所以这一项必须开放给用户。
   */
  function renderAppearance() {
    const section = el('div', 'pet-section');
    section.appendChild(el('div', 'pet-section-title', '外观'));

    const min = limits.scaleMin || SCALE_MIN;
    const max = limits.scaleMax || SCALE_MAX;
    const current = Number(detail.scale) || 1;
    const declared = Number(detail.declaredScale) || 1;

    // ---- 大小倍率
    //
    // 用 `createSliderRow`：滑块 + 可直接输入的数字框。
    // 数字框的显示带 `×`（`formatScale`），与读数一致，用户一眼知道单位。
    // 提交仍然只在 `change`（松手 / 失焦 / 回车）发生——一次拖动打几十个请求
    // 是不可接受的，而且 `tools/verify-upload.mjs` 依赖这个时序。
    const field = el('div', 'pet-field');
    const labelRow = el('div', 'pet-slider-head');
    labelRow.appendChild(el('span', 'pet-field-label', '大小倍率'));
    const readout = el('span', 'pet-slider-value', formatScale(current));
    labelRow.appendChild(readout);
    field.appendChild(labelRow);

    // 实际像素高度比倍率更直观（用户真正在意的是「屏幕上多大」）
    const base = detail.size || {};
    const buildScaleHint = (value) => {
      const pixels = base.h ? Math.round(base.h * value) : 0;
      return `范围 ${min}× ~ ${max}×；当前约 ${pixels}px 高。`
        + (declared !== 1 ? `形象包建议 ${formatScale(declared)}。` : '');
    };
    const hint = el('div', 'pet-field-hint', buildScaleHint(current));

    const scaleRow = createSliderRow({
      min,
      max,
      step: SCALE_STEP,
      value: current,
      label: '宠物大小倍率',
      format: (value) => String(value),
      onInput: (value) => {
        readout.textContent = formatScale(value);
        // 像素高度跟着实时更新（拖动时就能看到「屏幕上多大」）
        hint.textContent = buildScaleHint(value);
      },
      onCommit: (value) => updateAppearance({ scale: value }),
    });
    // 保持「面板里第一个 .pet-slider 就是大小倍率」这个既有约定：
    // `tools/verify-upload.mjs` 用它做缩放验证。
    scaleRow.slider.classList.add('pet-slider-scale');
    field.appendChild(scaleRow.row);
    field.appendChild(hint);

    // 区间两端提示（与宿主预设编辑器一致：最小 / 当前 / 最大）
    const rangeRow = el('div', 'pet-slider-range');
    rangeRow.appendChild(el('span', null, `${min}×`));
    rangeRow.appendChild(el('span', null, `${max}×`));
    field.appendChild(rangeRow);

    const resetRow = el('div', 'pet-panel-toolbar');
    resetRow.appendChild(button('恢复默认大小', 'is-icon', () => {
      updateAppearance({ scale: null });
    }));
    field.appendChild(resetRow);
    section.appendChild(field);

    // ---- 渲染方式
    const renderField = el('div', 'pet-field');
    renderField.appendChild(el('div', 'pet-field-label', '渲染方式'));
    const choice = el('div', 'pet-choice-row');

    const modes = [
      {
        value: false,
        label: '平滑（插画 / 真人）',
        hint: '放大时做插值，边缘柔和',
      },
      {
        value: true,
        label: '像素风（硬边）',
        hint: '放大时保持硬边，不糊',
      },
    ];
    for (const mode of modes) {
      const isActive = Boolean(detail.pixelated) === mode.value;
      const node = el(
        'button',
        `pet-choice ${isActive ? 'is-active' : ''}`.trim(),
        mode.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.title = mode.hint;
      node.addEventListener('click', () => updateAppearance({ pixelated: mode.value }));
      choice.appendChild(node);
    }
    renderField.appendChild(choice);
    renderField.appendChild(el(
      'div',
      'pet-field-hint',
      '写实插画与真人形象建议用「平滑」——硬边放大时会出现块状锯齿；'
      + '像素风形象用「硬边」才不会糊。'
      + (detail.declaredPixelated ? '（形象包声明为像素风）' : ''),
    ));
    section.appendChild(renderField);

    // ---- 动画速度（**按形象**）
    //
    // 用户要求「不要搞全局的，在同一个地方调整的数值却分成全局和
    // 形象绑定两种情况」。它原本在宿主表单里（全局 `anim_speed`），
    // 现在移到这里，与大小倍率 / 渲染方式同一套「按形象记住」。
    //
    // 为什么值得按形象：同一份素材在不同用途下想要的快慢不同——
    // 100 帧的平滑循环按原速播可能太赶，4 帧的像素猫按原速播又可能太慢。
    const speedCurrent = clampSpeed(Number(detail.animSpeed) || 1);
    const speedDeclared = clampSpeed(Number(detail.declaredAnimSpeed) || 1);
    const speedField = el('div', 'pet-field');
    const speedHead = el('div', 'pet-slider-head');
    speedHead.appendChild(el('span', 'pet-field-label', '动画速度'));
    const speedReadout = el('span', 'pet-slider-value', formatSpeed(speedCurrent));
    speedHead.appendChild(speedReadout);
    speedField.appendChild(speedHead);
    const speedHint = el('div', 'pet-field-hint', buildSpeedHint(speedCurrent, speedDeclared));
    const speedRow = createSliderRow({
      min: SPEED_MIN,
      max: SPEED_MAX,
      step: SPEED_STEP,
      value: speedCurrent,
      label: '动画速度',
      format: (value) => String(value),
      onInput: (value) => {
        speedReadout.textContent = formatSpeed(value);
        speedHint.textContent = buildSpeedHint(value, speedDeclared);
      },
      onCommit: (value) => updateAppearance({ animSpeed: value }),
    });
    speedRow.slider.classList.add('pet-slider-speed');
    speedField.appendChild(speedRow.row);
    speedField.appendChild(speedHint);
    const speedRange = el('div', 'pet-slider-range');
    speedRange.appendChild(el('span', null, formatSpeed(SPEED_MIN)));
    speedRange.appendChild(el('span', null, formatSpeed(SPEED_MAX)));
    speedField.appendChild(speedRange);
    speedField.appendChild(button('恢复默认速度', 'is-icon', () => {
      updateAppearance({ animSpeed: null });
    }));
    section.appendChild(speedField);

    // ---- 自动漫游（**按形象**）
    //
    // 同样是「按形象」的：不是每个形象都「会走」——坐着的猫、躺着的玩偶
    // 自己溜达起来很出戏。作者能在包里声明，用户也能在这里覆盖。
    const roamField = el('div', 'pet-field');
    roamField.appendChild(el('div', 'pet-field-label', '自动漫游'));
    const roamChoice = el('div', 'pet-choice-row');
    for (const option of [
      { value: true, label: '允许走动', hint: '闲着时会在屏幕底部走一走' },
      { value: false, label: '原地不动', hint: '不参与自动漫游，只做待机小动作' },
    ]) {
      const isActive = (detail.autoRoam !== false) === option.value;
      const node = el(
        'button',
        `pet-choice ${isActive ? 'is-active' : ''}`.trim(),
        option.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.title = option.hint;
      node.addEventListener('click', () => updateAppearance({ autoRoam: option.value }));
      roamChoice.appendChild(node);
    }
    roamField.appendChild(roamChoice);
    roamField.appendChild(el(
      'div',
      'pet-field-hint',
      '关掉之后这个形象不会自己走动（走动的间隔仍在下面「触发时间」里调）。'
      + (detail.declaredAutoRoam === false ? '（形象包声明为不漫游）' : ''),
    ));
    section.appendChild(roamField);

    return section;
  }

  /**
   * **作者署名**一行。
   *
   * 用户要求「自定义宠物应该支持设置作者名，方便其他人制作宠物发布」——
   * 有了署名，别人拿到一个宠物包就知道是谁做的，也才可能去找作者确认。
   * 内置形象的作者固定为「官方」，只读显示。
   */
  function renderAuthorRow() {
    const field = el('div', 'pet-field');
    const head = el('div', 'pet-slider-head');
    head.appendChild(el('span', 'pet-field-label', '作者'));
    field.appendChild(head);

    if (!detail.writable) {
      // 内置形象：只显示，不给编辑（它的 pet.json 是随包资源）
      const badge = el('div', 'pet-choice-row');
      badge.appendChild(el(
        'span',
        'pet-badge is-builtin',
        detail.author || '官方',
      ));
      field.appendChild(badge);
      field.appendChild(el(
        'div',
        'pet-field-hint',
        '插件自带的形象，作者由随包资源固定。',
      ));
      return field;
    }

    const input = el('input', 'pet-input');
    input.type = 'text';
    input.value = detail.author || '';
    input.placeholder = '例如：你的昵称';
    input.maxLength = 60;
    input.dataset.authorInput = 'true';
    input.setAttribute('aria-label', '形象作者');
    // 失焦或回车才提交：逐字符提交会打出一串请求
    const commit = () => {
      const next = input.value.trim();
      if (next === (detail.author || '')) return;
      updateMeta({ author: next }, {
        message: next ? `作者已设为「${next}」` : '已清空作者',
      });
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
    field.appendChild(input);
    field.appendChild(el(
      'div',
      'pet-field-hint',
      '会写进形象的 pet.json，导出形象包时一起带走——'
      + '别人拿到这个包就能看到是谁做的。',
    ));
    return field;
  }

  /**
   * **触发时间**区：调整「多久自己动一次」。
   *
   * 只列出真正**由时间驱动**的两个行为（`idle` 小动作 / 自动漫游）。
   * 其余动作由事件触发——`click` 要有人点、`fall` 要松手、`happy` 要有播报，
   * 给它们设「多久一次」没有意义，后端也会拒绝，因此这里不渲染它们的滑块。
   *
   * 这两项**对内置形象同样开放**：它们落在 `data/settings.json`（用户偏好），
   * 不是随包资源。内置形象恰恰是大多数用户唯一会用的形象。
   */
  /**
   * 渲染一个**阈值型**行为（目前只有 `sleep`）：一个「多久」而不是区间。
   *
   * 为什么单独一条路：`sleep` 的语义是「静了多久之后睡着」，是一个**阈值**，
   * 不是「每隔一段随机时间发生一次」。套用「最短 / 最长」两个滑块会把
   * 「随机」这个语义强加上去——而「多久不管就睡觉」显然不该是随机的。
   *
   * 提交时用 `afterMs`（毫秒），区间与 manifest 的 `sleep_after` 一致
   * （10 秒 ~ 1 小时），免得同一个概念在两处设置里有不同的边界。
   */
  function renderThresholdField(behavior, current, suggested) {
    const fallback = (DEFAULT_SCHEDULE_MS[behavior.key] || {}).min || 120000;
    const low = SLEEP_AFTER_MIN_MS;
    const high = SLEEP_AFTER_MAX_MS;
    const clamp = (raw) => {
      const number = Number(raw);
      const base = Number.isFinite(number) && number > 0 ? number : fallback;
      return Math.round(Math.min(Math.max(base, low), high) / 1000) * 1000;
    };
    // 打盹阈值是**纯按形象**的（用户要求不要搞全局的），因此没设时
    // 显示的是**默认值**，而不是某个宿主全局值。
    const declared = Number(current.afterMs);
    const usesDefault = !(Number.isFinite(declared) && declared > 0);
    const afterMs = usesDefault ? fallback : clamp(declared);

    const field = el('div', 'pet-field');
    const head = el('div', 'pet-slider-head');
    head.appendChild(el('span', 'pet-field-label', behavior.label));
    const readout = el('span', 'pet-slider-value', formatMs(afterMs));
    head.appendChild(readout);
    field.appendChild(head);

    const row = el('div', 'pet-schedule-row');
    const slider = el('input', 'pet-slider');
    slider.type = 'range';
    slider.min = String(low);
    slider.max = String(high);
    // 按秒做步长：设置面板上没人会去调 1 毫秒
    slider.step = '1000';
    slider.value = String(afterMs);
    slider.dataset.scheduleBehavior = behavior.key;
    // 面板上「阈值」型行为的提交字段与区间型不同，用一个显式的标记，
    // 免得提交处再去判断一次「这个行为是哪种形状」。
    slider.dataset.scheduleBound = 'after';
    slider.setAttribute('aria-label', `${behavior.label}的等待时间`);

    const commit = () => {
      const value = Number(row.querySelector('[data-schedule-bound="after"]').value);
      updateSchedule(behavior.key, { afterMs: value });
    };
    const live = () => {
      readout.textContent = formatMs(clamp(
        Number(row.querySelector('[data-schedule-bound="after"]').value),
      ));
    };
    slider.addEventListener('input', live);
    slider.addEventListener('change', commit);

    const box = attachNumberBox(slider, {
      label: `${behavior.label}的等待时间（毫秒）`,
      clamp,
      onInput: live,
      onCommit: commit,
    });
    const boundRow = el('div', 'pet-slider-row');
    boundRow.appendChild(slider);
    boundRow.appendChild(box.input);
    row.appendChild(boundRow);
    field.appendChild(row);

    const rangeRow = el('div', 'pet-slider-range');
    rangeRow.appendChild(el('span', null, formatMs(low)));
    rangeRow.appendChild(el('span', null, formatMs(high)));
    field.appendChild(rangeRow);
    field.appendChild(el(
      'div',
      'pet-field-hint',
      behavior.hint
      + (Number(suggested.afterMs) > 0
        ? `形象包建议 ${formatMs(suggested.afterMs)}。`
        : ''),
    ));
    return field;
  }

  /**
   * **物理参数**编辑区（默认收起）。
   *
   * 用户要求把这类「比较容易出问题」的设置项也开放出来，让用户自己决定，
   * 并在帮助页里说清楚。每一项都给了推荐值区间——物理参数没有「绝对正确」，
   * 只有「看起来像不像在正常走动」。
   *
   * 提交时**逐项**发（不像动画参数那样攒草稿）：这些字段互相独立，
   * 拖完松手就生效最符合直觉，而且即时看到效果正是调物理的乐趣所在。
   */
  function renderPhysicsEditor() {
    const section = renderCollapsible('物理参数', {
      key: 'physics',
      badge: '进阶',
      hint: '重力、走速、摩擦、终端速度、弹性。调坏了宠物会变得很怪，'
        + '但改动是立刻看得见的，所以放心试——点「恢复默认」随时能回来。',
    });

    const current = detail.physics || {};
    const specs = [
      {
        key: 'gravity',
        label: '重力',
        unit: '像素/秒²',
        min: 0,
        max: 20000,
        step: 50,
        fallback: 1800,
        hint: '默认 1800。调大 = 掉得更急；小于 400 会明显像在月球上。',
      },
      {
        key: 'walkSpeed',
        label: '走速',
        unit: '像素/秒',
        min: 0,
        max: 2000,
        step: 5,
        fallback: 60,
        hint: '默认 60。小宠物（64px）用 30~50，大立绘用 80~150。',
      },
      {
        key: 'friction',
        label: '摩擦',
        unit: '每秒保留比例',
        min: 0,
        max: 1,
        step: 0.01,
        fallback: 0.02,
        hint: '默认 0.02（走停约 0.4 秒）。越小刹车越快；'
          + '0.5 以上会「刹不住」。',
      },
      {
        key: 'terminalVelocity',
        label: '终端速度',
        unit: '像素/秒',
        min: 1,
        max: 20000,
        step: 50,
        fallback: 2400,
        hint: '默认 2400。下落速度的上限，防止一帧掉太远。',
      },
      {
        key: 'bounce',
        label: '弹性',
        unit: '0~1',
        min: 0,
        max: 1,
        step: 0.01,
        fallback: 0.15,
        hint: '默认 0.15（轻轻一顿）。0.4 以上会像皮球，0 则「啪」地贴地。',
      },
    ];

    for (const spec of specs) {
      const value = Number(current[spec.key]);
      const fallback = Number.isFinite(value) ? value : spec.fallback;
      const field = el('div', 'pet-field');
      const head = el('div', 'pet-slider-head');
      head.appendChild(el('span', 'pet-field-label', `${spec.label}（${spec.unit}）`));
      const readout = el('span', 'pet-slider-value', formatNumber(fallback));
      head.appendChild(readout);
      field.appendChild(head);

      const row = createSliderRow({
        min: spec.min,
        max: spec.max,
        step: spec.step,
        value: fallback,
        label: spec.label,
        format: (v) => String(v),
        onInput: (v) => { readout.textContent = formatNumber(v); },
        onCommit: (v) => updatePhysics({ [spec.key]: v }),
      });
      row.slider.dataset.physicsKey = spec.key;
      field.appendChild(row.row);
      const rangeRow = el('div', 'pet-slider-range');
      rangeRow.appendChild(el('span', null, formatNumber(spec.min)));
      rangeRow.appendChild(el('span', null, formatNumber(spec.max)));
      field.appendChild(rangeRow);
      field.appendChild(el('div', 'pet-field-hint', spec.hint));
      section.body.appendChild(field);
    }

    const bar = el('div', 'pet-panel-toolbar');
    bar.appendChild(button('恢复默认物理参数', 'is-icon', () => {
      const patch = {};
      for (const spec of specs) patch[spec.key] = null;
      updatePhysics(patch);
    }));
    section.body.appendChild(bar);
    section.body.appendChild(el(
      'div',
      'pet-field-hint',
      '这些值写在这个形象包里，只影响它自己。',
    ));
    return section;
  }

  /**
   * **锚点 / 单帧尺寸**编辑区（默认收起）。
   *
   * 这两项都「一调就看得出来」——锚点错了宠物会悬空或陷进地面，
   * 单帧尺寸错了会露出邻帧或框住一片空白。因此它们属于「进阶但安全」：
   * 开放出来让用户自己试，比藏着更实用。
   */
  function renderAnchorEditor() {
    const section = renderCollapsible('锚点与单帧尺寸', {
      key: 'anchor',
      badge: '进阶',
      hint: '锚点是「脚底」在单帧里的相对位置（0 = 最上/最左，1 = 最下/最右）。'
        + '宠物站立、呼吸、缩放都以此为原点。调错的后果一眼就能看出来。',
    });

    const anchor = detail.anchor || {};
    const size = detail.size || {};

    const anchorRow = el('div', 'pet-editor-row');
    anchorRow.appendChild(editorNumber({
      label: '锚点 X',
      hint: '0 = 最左，1 = 最右；一般 0.5',
      value: Number.isFinite(Number(anchor.x)) ? Number(anchor.x) : 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      onInput: (value) => updateLayout({ anchor: { x: value } }),
    }));
    anchorRow.appendChild(editorNumber({
      label: '锚点 Y',
      hint: '0 = 最上，1 = 最下；脚底一般 0.95~1',
      value: Number.isFinite(Number(anchor.y)) ? Number(anchor.y) : 1,
      min: 0,
      max: 1,
      step: 0.01,
      onInput: (value) => updateLayout({ anchor: { y: value } }),
    }));
    section.body.appendChild(anchorRow);

    const sizeRow = el('div', 'pet-editor-row');
    sizeRow.appendChild(editorNumber({
      label: '单帧宽',
      hint: '像素',
      value: Number(size.w) || 64,
      min: 1,
      max: 1024,
      step: 1,
      onInput: (value) => updateLayout({ size: { w: Math.round(value) } }),
    }));
    sizeRow.appendChild(editorNumber({
      label: '单帧高',
      hint: '像素',
      value: Number(size.h) || 64,
      min: 1,
      max: 1024,
      step: 1,
      onInput: (value) => updateLayout({ size: { h: Math.round(value) } }),
    }));
    section.body.appendChild(sizeRow);

    section.body.appendChild(el(
      'div',
      'pet-field-hint',
      '单帧尺寸是一张贴图里单帧的大小，不是整张 spritesheet 的大小。',
    ));
    const bar = el('div', 'pet-panel-toolbar');
    bar.appendChild(button('恢复默认锚点', 'is-icon', () => {
      updateLayout({ anchor: null });
    }));
    section.body.appendChild(bar);
    return section;
  }

  /** 提交物理参数（写回 `pet.json`）。 */
  async function updatePhysics(patch) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/physics`,
        { method: 'POST', body: { patch } },
      );
      if (!data) return;
      setNotice('ok', '物理参数已更新');
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /** 提交锚点 / 单帧尺寸（写回 `pet.json`）。 */
  async function updateLayout(patch) {
    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/layout`,
        { method: 'POST', body: { patch } },
      );
      if (!data) return;
      setNotice('ok', '已更新');
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  function renderSchedule() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '触发时间'));
    title.appendChild(el('span', 'pet-badge', '可调节'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '只有「由时间自己发生」的行为能设间隔。点击、下落、播报这些由事件触发，'
      + '没有「多久一次」可言。这三项都是按形象记住的，换形象会自动切回它自己的设置。',
    ));

    const effective = detail.schedule || {};
    const declared = detail.declaredSchedule || {};

    for (const behavior of SCHEDULE_BEHAVIORS) {
      // ⚠️ 必须用 `behavior.key` 取值，不能用 `behavior` 本身：
      // 后者是 `{key, label, hint}` 对象，`effective[对象]` 恒为 `undefined`，
      // 于是滑块会渲染成**极值**（下限/上限），而用户看到的是「0.2~3600 秒」。
      // 实测踩到过：滑块看着在、也能拖，但初值是错的——比报错难查得多。
      const preset = DEFAULT_SCHEDULE_MS[behavior.key] || { min: 6000, max: 18000 };
      const current = effective[behavior.key] || preset;
      const suggested = declared[behavior.key] || preset;

      // ---- 阈值型行为（`sleep`）：只有一个「多久」，不是区间
      //
      // 「多久没人理就睡着」显然不该是随机的，所以这里**不**渲染两个滑块。
      // 用 `afterMs`（毫秒），区间与 manifest 的 `sleep_after` 一致。
      if (behavior.isThreshold) {
        section.appendChild(renderThresholdField(behavior, current, suggested));
        continue;
      }

      const minMs = clampScheduleMs(current.minIntervalMs, preset.min);
      const maxMs = clampScheduleMs(current.maxIntervalMs, preset.max);

      const field = el('div', 'pet-field');
      const head = el('div', 'pet-slider-head');
      head.appendChild(el('span', 'pet-field-label', behavior.label));
      const readout = el(
        'span',
        'pet-slider-value',
        formatInterval(minMs, maxMs),
      );
      head.appendChild(readout);
      field.appendChild(head);

      // 两个滑块（下界 / 上界）。用两个而不是一个「区间滑块」：
      // 原生 `<input type="range">` 不支持双柄，而自己造一个双柄滑块
      // 要处理键盘可达性、指针捕获与边界交叉——为一个次要设置不值得。
      //
      // 每个滑块各自配一个**可直接输入的数字框**（用户要求「通过拖拽有时难以
      // 精确调整，请同步支持直接选择数字部分进行输入修改」）。数字框与滑块
      // 一起包进 `.pet-slider-row`，于是窄屏下换行的是「一条」而不是零散控件；
      // `row.querySelector('[data-schedule-bound=...]')` 照样能找到滑块（后代选择）。
      const row = el('div', 'pet-schedule-row');
      for (const bound of ['min', 'max']) {
        const slider = el('input', 'pet-slider');
        slider.type = 'range';
        slider.min = String(limits.scheduleMinMs);
        slider.max = String(limits.scheduleMaxMs);
        // 用**秒**做步长（100ms）而不是 1ms：设置面板上没人会去调 1 毫秒，
        // 而 1ms 的步长会让滑块几乎不可用（3.6e6 个位置）。
        slider.step = '100';
        slider.value = String(bound === 'min' ? minMs : maxMs);
        slider.dataset.scheduleBehavior = behavior.key;
        slider.dataset.scheduleBound = bound;
        slider.setAttribute(
          'aria-label', `${behavior.label}的${bound === 'min' ? '最短' : '最长'}间隔`,
        );
        const live = () => {
          // 读数按**这个行为自己的**区间夹，而不是全局的 200~3600000：
          // 用全局区间的话，拖动时读数会跳到「0.2~3600 秒」这种没意义的值。
          const low = clampScheduleMs(
            Number(row.querySelector('[data-schedule-bound="min"]').value),
            preset.min,
          );
          const high = clampScheduleMs(
            Number(row.querySelector('[data-schedule-bound="max"]').value),
            preset.max,
          );
          readout.textContent = formatInterval(low, high);
        };
        slider.addEventListener('input', live);
        // 松手才提交 —— 否则一次拖动会打出几十个请求
        const commit = () => {
          const low = Number(row.querySelector('[data-schedule-bound="min"]').value);
          const high = Number(row.querySelector('[data-schedule-bound="max"]').value);
          updateSchedule(behavior.key, {
            minIntervalMs: low,
            maxIntervalMs: high,
          });
        };
        slider.addEventListener('change', commit);

        // 数字框的夹取范围与滑块**完全一致**（全局区间 + 100ms 步长对齐），
        // 否则「拖出来的值」与「手输的值」会落在不同的格子上。
        const low = Number(limits.scheduleMinMs) || SCHEDULE_FALLBACK_MIN_MS;
        const high = Number(limits.scheduleMaxMs) || SCHEDULE_FALLBACK_MAX_MS;
        const box = attachNumberBox(slider, {
          label: `${behavior.label}的${bound === 'min' ? '最短' : '最长'}间隔（毫秒）`,
          clamp: (raw) => {
            const number = Number(raw);
            const base = Number.isFinite(number) ? number : low;
            const bounded = Math.min(Math.max(base, low), high);
            return Math.round(bounded / 100) * 100;
          },
          // 输入过程中只更新读数（与滑块一致：绝不在这里发请求）
          onInput: live,
          onCommit: commit,
        });
        const boundRow = el('div', 'pet-slider-row');
        boundRow.appendChild(slider);
        boundRow.appendChild(box.input);
        row.appendChild(boundRow);
      }
      field.appendChild(row);
      // 区间两端提示（与宿主预设编辑器一致：最小 / 当前 / 最大）
      const rangeRow = el('div', 'pet-slider-range');
      rangeRow.appendChild(el('span', null, formatMs(limits.scheduleMinMs)));
      rangeRow.appendChild(el('span', null, formatMs(limits.scheduleMaxMs)));
      field.appendChild(rangeRow);
      field.appendChild(el(
        'div',
        'pet-field-hint',
        `${behavior.hint}`
        + (suggested.minIntervalMs
          ? `形象包建议 ${formatInterval(suggested.minIntervalMs, suggested.maxIntervalMs)}。`
          : ''),
      ));
      section.appendChild(field);
    }

    const row = el('div', 'pet-panel-toolbar');
    if (detail.scheduleOverridden) {
      row.appendChild(button('恢复默认触发时间', 'is-icon', () => resetSchedule()));
    }
    row.appendChild(el(
      'span',
      'pet-card-meta',
      detail.scheduleOverridden ? '已自定义' : '正在用默认 / 形象包的设置',
    ));
    section.appendChild(row);
    return section;
  }

  /**
   * 动画预览区：直接在这里播具体动作，不必切过去等它真的触发。
   *
   * 用户报障「插件管理里看不到动画效果」，这一区就是答案。
   * 对**内置形象同样开放**——只读限制的是「改图」，不是「看效果」。
   *
   * 播放规则与桌面上的宠物**完全一致**（帧数 / 帧率 / 非均匀帧时长 /
   * 排布都按后端的运行期定义走），因此「预览里看到的」就是「桌面上会看到的」。
   */
  function renderPreview() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '动画预览'));
    title.appendChild(el('span', 'pet-badge', '可播放'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '点任意动作即可在这里播放，用来核对动作效果与节奏。'
      + '播放规则与桌面上的宠物一致（含每帧时长），因此所见即所得。',
    ));

    const spec = previewSpec();
    const entry = previewEntry();

    const stage = el('div', 'pet-preview-stage');
    const box = el('div', 'pet-preview-box');
    box.dataset.previewBox = 'true';
    // 单帧 / 无图时也要有内容，因此图由 `player.load()` 写进 style
    stage.appendChild(box);

    const side = el('div', 'pet-preview-side');
    side.appendChild(el('div', 'pet-preview-name', ACTION_LABELS[previewAction] || previewAction));

    // ---- 元信息：帧数 / 节奏 / 变体
    if (spec) {
      const frames = Math.max(1, Number(spec.frames) || 1);
      const total = totalDuration(spec);
      const uniform = !(Array.isArray(spec.frameMs) && spec.frameMs.length === frames);
      const pace = uniform
        ? `${formatNumber(spec.fps)} fps`
        : `${Math.round(total)}ms / 轮（逐帧不同）`;
      // 网格排布时把形状写出来：作者要能一眼看出「帧数 vs 网格容量」是否对得上
      // （4×4 只放 13 帧是合法的，但那 3 个空格子值得知道）。
      const shape = frameGrid(spec);
      const layoutNote = shape.cols > 1 && shape.rows > 1
        ? ` · ${shape.cols}×${shape.rows} 网格`
        : (shape.cols === 1 ? ' · 竖排' : '');
      // 多页时把页数写出来：**显存**是真正的容量瓶颈（一张 4096² 的 sheet
      // 解出来是 64 MiB，与 PNG 是 1 MB 还是 9 MB 无关），而用户看不到显存。
      const pages = Array.isArray(spec.pages) ? spec.pages.length : 1;
      const pageNote = pages > 1 ? ` · ${pages} 页` : '';
      // 动图容器：帧数来自**文件元数据**（后端读出来的），节奏由浏览器决定
      // ——因此不能按 `fps` 说「几 fps」，那会是一句假话。
      if (spec.animated) {
        const count = Number(spec.animatedFrames) || 1;
        side.appendChild(el(
          'div',
          'pet-preview-meta',
          `动图容器 · ${count} 帧 · 由浏览器自行播放`
          + (spec.loop === false ? '' : '（循环次数写在文件里）'),
        ));
      } else {
        side.appendChild(el(
          'div',
          'pet-preview-meta',
          `${frames} 帧${layoutNote}${pageNote} · ${pace} · ${spec.loop === false ? '播一遍' : '循环'}`,
        ));
      }
      // 显存占用：超过预算就**显眼提示**，但不禁用——够不够用取决于用户的机器，
      // 插件无法知道，因此把事实摆出来由用户自己决定。
      const decode = Number(entry && entry.decodeBytes) || 0;
      if (decode > 0) {
        const budget = Number(detail && detail.decodeBudgetBytes) || 0;
        const heavy = budget > 0 && decode > budget;
        side.appendChild(el(
          'div',
          heavy ? 'pet-preview-meta is-warn' : 'pet-preview-meta',
          `解码后约占 ${formatBytes(decode)} 显存`
          + (heavy ? '（较大，低配机器可能卡顿）' : ''),
        ));
      }
      // 后端算出的提醒（动图容器的代价、大文件…）。逐条显示而不是拼成一句：
      // 它们各自是一个独立的事实，合并成一段长文字会让用户跳过去。
      for (const warning of (entry && entry.warnings) || []) {
        side.appendChild(el(
          'div',
          warning.level === 'warn' ? 'pet-preview-meta is-warn' : 'pet-preview-meta',
          warning.message,
        ));
      }
      // 程序化运动：说明这个动作为什么「一直在动」。
      //
      // 不说的话用户会以为「帧数写错了」——它明明是 1 帧却在动。
      // ⚠️ 必须用**规范化后**的形状（见 `describeEntry` 的同一条说明）：
      // `spec.motion` 是原始形状，直接读 `.amplitude` 恒为 undefined。
      const motion = normalizeMotion(spec);
      if (motionBreathes(motion) || motionBlinks(motion)) {
        const bits = [];
        if (motionBreathes(motion)) {
          bits.push(`呼吸 ±${(motion.amplitude * 100).toFixed(1)}% / ${(motion.periodMs / 1000).toFixed(1)}s`);
        }
        if (motionBlinks(motion)) {
          bits.push(`眨眼（第 ${motion.blinkFrames.join('、')} 帧，每 `
            + `${(motion.blinkEveryMs[0] / 1000).toFixed(1)}–${(motion.blinkEveryMs[1] / 1000).toFixed(1)}s 一次）`);
        }
        side.appendChild(el(
          'div',
          'pet-preview-meta is-motion',
          `程序化运动：${bits.join('；')}（不占额外帧，由合成器驱动）`,
        ));
      }
      if (entry && entry.kind !== 'animated') {
        side.appendChild(el('div', 'pet-preview-meta', entry.note || '这个动作没有图'));
      }
      if (entry && entry.note && entry.kind === 'animated') {
        side.appendChild(el('div', 'pet-preview-meta', entry.note));
      }
    } else {
      side.appendChild(el('div', 'pet-preview-meta', '这个动作没有可播的图。'));
    }

    // ---- 变体切换（多套动画）
    const variants = (entry && entry.variants) || [];
    if (variants.length > 1) {
      const row = el('div', 'pet-preview-variants');
      row.appendChild(el('span', 'pet-field-hint', '这一动作有多套动画，按权重随机播：'));
      variants.forEach((variant, at) => {
        const node = el(
          'button',
          `pet-choice ${at === previewVariant ? 'is-active' : ''}`.trim(),
          `第 ${at + 1} 套（权重 ${formatNumber(variant.weight)}）`,
        );
        node.type = 'button';
        node.dataset.marqueeIgnore = 'true';
        node.dataset.previewVariant = String(at);
        node.addEventListener('click', () => {
          previewVariant = at;
          previewPlaying = true;
          render();
        });
        row.appendChild(node);
      });
      side.appendChild(row);
    }

    // ---- 播放控制
    const controls = el('div', 'pet-panel-toolbar');
    controls.appendChild(button('重播', 'is-primary', () => {
      previewPlaying = true;
      if (player) player.play();
      syncPreviewToggle();
    }));
    const toggle = button(previewPlaying ? '暂停' : '播放', '', () => {
      previewPlaying = !previewPlaying;
      if (player) {
        if (previewPlaying) player.play();
        else player.stop();
      }
      syncPreviewToggle();
    });
    toggle.dataset.previewToggle = 'true';
    previewToggle = toggle;
    controls.appendChild(toggle);
    controls.appendChild(button('第 1 帧', 'is-icon', () => {
      previewPlaying = false;
      if (player) player.reset();
      syncPreviewToggle();
    }));
    side.appendChild(controls);

    // ---- 速度倍率（预览用，只影响预览；桌面宠物走宿主表单的「动画速度」）
    const speedRow = el('div', 'pet-slider-head');
    speedRow.appendChild(el('span', 'pet-field-label', '预览速度'));
    const speedReadout = el('span', 'pet-slider-value', `${formatNumber(previewSpeed)}×`);
    speedRow.appendChild(speedReadout);
    side.appendChild(speedRow);

    // 预览速度是**纯本地**状态（不落盘），所以这里没有 `onCommit`：
    // 拖动即生效，数字框回车 / 失焦也走同一个 `onInput`。
    const speed = createSliderRow({
      min: SPEED_MIN,
      max: SPEED_MAX,
      step: 0.05,
      value: previewSpeed,
      label: '动画预览速度',
      format: (value) => String(value),
      onInput: (value) => {
        previewSpeed = value || 1;
        if (player) player.setSpeed(previewSpeed);
        speedReadout.textContent = `${formatNumber(previewSpeed)}×`;
      },
    });
    // 既有约定：预览速度滑块带 `data-preview-speed`（`tools/verify-still.mjs` 用它）
    speed.slider.dataset.previewSpeed = 'true';
    side.appendChild(speed.row);
    // 区间两端提示（与宿主预设编辑器一致：最小 / 当前 / 最大）
    const speedRange = el('div', 'pet-slider-range');
    speedRange.appendChild(el('span', null, `${SPEED_MIN}×`));
    speedRange.appendChild(el('span', null, `${SPEED_MAX}×`));
    side.appendChild(speedRange);
    side.appendChild(el(
      'div',
      'pet-field-hint',
      '数值越大越慢。这里只影响预览；桌面上的宠物请在「外观 → 动画速度」里按形象调。',
    ));

    // ---- 帧读数
    const readout = el('div', 'pet-preview-frame');
    readout.dataset.previewFrame = 'true';
    side.appendChild(readout);

    stage.appendChild(side);
    section.appendChild(stage);

    // ---- 动作选择：点一下就能播
    const picker = el('div', 'pet-preview-picker');
    for (const item of (detail && detail.actions) || []) {
      const node = el(
        'button',
        `pet-choice ${item.action === previewAction ? 'is-active' : ''}`
          + `${item.kind !== 'animated' ? ' is-muted' : ''}`.trim(),
        ACTION_LABELS[item.action] || item.action,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.dataset.previewAction = item.action;
      node.title = item.kind === 'animated'
        ? `播放「${ACTION_LABELS[item.action] || item.action}」`
        : `${ACTION_LABELS[item.action] || item.action}：没有可播的图`;
      node.addEventListener('click', () => {
        previewAction = item.action;
        previewVariant = 0;
        previewPlaying = true;
        render();
      });
      picker.appendChild(node);
    }
    section.appendChild(picker);

    // 播放器在 DOM 挂上之后才能算帧几何（`clientWidth` 只有挂上才有值），
    // 因此这里只登记意图，真正 `load()` 由 `mountPreviewPlayer()` 在渲染收尾时做。
    pendingPreview = {
      box,
      spec,
      readout,
      animated: Boolean(spec && spec.animated),
      animatedFrames: Number(spec && spec.animatedFrames) || 1,
    };
    return section;
  }

  /**
   * 渲染收尾时挂载预览器。
   *
   * 必须**在 DOM 挂上之后**：帧几何依赖预览框的真实宽度，
   * 而 `render()` 只负责造节点，还没插进文档。
   */
  function mountPreviewPlayer() {
    if (player) {
      player.dispose();
      player = null;
    }
    const pending = pendingPreview;
    pendingPreview = null;
    if (!pending || !pending.box) return;
    player = createAnimationPlayer({
      box: pending.box,
      speed: previewSpeed,
      onFrame: (index, frames) => {
        const node = pending.readout;
        if (!node) return;
        // 动图容器：帧不是我们在推，所以**不能说「单帧」**——
        // 它明明在动，说成单帧会让用户以为图坏了。
        if (pending.animated) {
          const count = pending.animatedFrames > 1 ? `${pending.animatedFrames} 帧` : '';
          node.textContent = `动图${count ? `（${count}）` : ''}· 浏览器自行播放`;
          return;
        }
        node.textContent = frames > 1 ? `第 ${index + 1} / ${frames} 帧` : '单帧';
      },
      onEnd: () => {
        // 一次性动作播完：**只更新按钮文字**，绝不 `render()`。
        //
        // `render()` 会重建面板并重新 `load()` 播放器（从头播），于是
        // 「播完 → onEnd → render → 又播」形成无限循环（实测：点一下「被点击」
        // 就永远停不下来）。这里改成就地同步状态。
        previewPlaying = false;
        syncPreviewToggle();
      },
    });
    // 尊重「暂停」状态：暂停时只画第 0 帧，不自动播
    if (pending.spec) player.load(pending.spec, { autoplay: previewPlaying });
  }

  /** 倍率的短格式（去掉多余的 0）。 */
  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return String(Math.round(number * 100) / 100);
  }

  /**
   * 字节数的人读格式（显存提示用）。
   *
   * 用 1024 进制（与后端 `imports.format_bytes` 一致）：同一个数字在
   * 后端报错信息与面板提示里必须显示成同一个值，否则用户会以为
   * 「提示说的 128 MB」和「面板说的 128 MB」是两回事。
   */
  function formatBytes(value) {
    let number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '0 B';
    for (const unit of ['B', 'KB', 'MB', 'GB']) {
      if (number < 1024 || unit === 'GB') {
        return unit === 'B' ? `${Math.round(number)} B` : `${number.toFixed(1)} ${unit}`;
      }
      number /= 1024;
    }
    return `${number.toFixed(1)} GB`;
  }

  /** 内置形象的遗留覆盖提示 + 一键清理。 */
  function renderLegacyOverrides() {
    const box = el('div', 'pet-notice is-warn');
    const names = (detail.staleOverrides || [])
      .map((name) => ACTION_LABELS[name] || name)
      .join('、');
    box.appendChild(el('div', null, `检测到 ${detail.staleOverrides.length} 个遗留的自定义图：${names}`));
    box.appendChild(el(
      'div',
      'pet-field-hint',
      '插件自带的形象现在是只读的，这些图不会再生效，但它们仍占着数据目录。'
      + '清理只删除你自己上传的覆盖文件，不会动插件自带的图。',
    ));
    const row = el('div', 'pet-panel-toolbar');
    row.appendChild(button('清理这些文件', 'is-danger', () => clearLegacyOverrides()));
    box.appendChild(row);
    return box;
  }

  /** 把倍率格式化成短字符串（去掉多余的 0）。 */
  function formatScale(value) {
    const number = Number(value) || 1;
    return `${Math.round(number * 100) / 100}×`;
  }

  /**
   * 把单个毫秒值格式化成给人看的时间（区间提示行用）。
   *
   * 与 `formatInterval` 的区别：那个渲染的是「最小~最大」一整段，
   * 这个只渲染端点。逻辑共用同一套取整规则，免得同一份数据在两处
   * 显示成「1 秒」和「1.0 秒」两种样子。
   */
  function formatMs(value) {
    const seconds = (Number(value) || 0) / 1000;
    if (seconds >= 10) return `${Math.round(seconds)} 秒`;
    if (seconds >= 1) return `${Math.round(seconds * 10) / 10} 秒`;
    return `${Math.round(seconds * 1000)} 毫秒`;
  }

  /**
   * 把一个毫秒间隔夹到合法区间内。
   *
   * 与后端的 `clamp_schedule_ms` 同一套语义：夹住而不是抛错——
   * 这个值会被渲染进滑块的 `value`，而 `NaN` 会让滑块直接失效。
   */
  function clampScheduleMs(value, fallbackLow) {
    const low = Number(limits.scheduleMinMs) || SCHEDULE_FALLBACK_MIN_MS;
    const high = Number(limits.scheduleMaxMs) || SCHEDULE_FALLBACK_MAX_MS;
    const number = Number(value);
    const base = Number.isFinite(number) && number > 0
      ? number
      : (Number(fallbackLow) || low);
    return Math.round(Math.min(Math.max(base, low), high));
  }

  /**
   * 把「最小~最大」毫秒区间格式化成**秒**（面板上没人按毫秒思考）。
   *
   * 小于 1 秒时保留一位小数：`0.2~0.5 秒` 比 `0~1 秒` 有用得多。
   */
  function formatInterval(minMs, maxMs) {
    const low = Number(minMs) || 0;
    const high = Number(maxMs) || 0;
    const format = (value) => {
      const seconds = value / 1000;
      if (seconds >= 10) return String(Math.round(seconds));
      return String(Math.round(seconds * 10) / 10);
    };
    return `${format(low)}~${format(high)} 秒`;
  }

  /**
   * 这个动作算不算「必要」。
   *
   * `walk-left` / `walk-right` 也算：行走是必要动作，而它**只认方向化贴图**
   * ——提供任一侧即满足需求（`REQUIRED_ACTIONS` 里的 `walk` 就是这个需求的代号）。
   * 若只按 `REQUIRED_ACTIONS.includes(action)` 判断，两个侧视动作会被标成「可选」，
   * 与 §3 的动作表不符。
   */
  function isRequiredAction(action) {
    if (REQUIRED_ACTIONS.includes(action)) return true;
    return action === 'walk-left' || action === 'walk-right';
  }

  function renderActionTile(entry) {
    const tile = el('div', 'pet-action-tile');
    const required = isRequiredAction(entry.action);
    const isFallback = entry.kind === 'animated' && entry.source !== entry.action;
    if (isFallback) tile.classList.add('is-fallback');
    if (entry.kind !== 'animated') tile.classList.add('is-missing');

    const preview = el('div', 'pet-action-preview');
    const previewUrl = entry.url;
    const frames = Math.max(1, Number(entry.frames) || 1);
    if (previewUrl && entry.kind === 'animated') {
      preview.style.backgroundImage = `url("${previewUrl}")`;
      preview.style.backgroundRepeat = 'no-repeat';
      // 与卡片缩略图同一个坑：这里拿到的是**整条** spritesheet。
      // 用 `contain` 会把整条压进 56px 的小方框，每帧只剩十几像素。
      // 因此同样是「按行列数放大 + 左上对齐」，只露出第 0 帧。
      const tileGrid = frameGrid({
        frames,
        layout: entry.layout,
        cols: entry.cols,
        rows: entry.rows,
      });
      preview.dataset.frames = String(frames);
      preview.dataset.layout = entry.layout === 'vertical' ? 'vertical' : 'horizontal';
      preview.dataset.cols = String(tileGrid.cols);
      preview.dataset.rows = String(tileGrid.rows);
      // 单帧尺寸：与卡片缩略图同一个理由（网格排布下要 `cover` 才不漏邻格）。
      // 优先级与桌面宠物一致：变体自带 > 动作条目 > 包级。
      const tileSize = frameSizeOf(entry, entry, detail && detail.size);
      preview.dataset.cellW = String(Math.max(1, Number(tileSize.w) || 1));
      preview.dataset.cellH = String(Math.max(1, Number(tileSize.h) || 1));
      preview.dataset.hasImage = 'true';
    }
    tile.appendChild(preview);

    if (entry.overridden) {
      tile.appendChild(el('span', 'pet-action-badge', '自定'));
    } else if (isFallback) {
      tile.appendChild(el('span', 'pet-action-badge is-warn', '回退'));
    }
    // 动图容器的徽章：它是一条**不同的技术路线**（不切帧、不能分页），
    // 用户有权一眼看出「这个动作是动图」，而不是从「怎么不按我设的帧率播」
    // 去反推。
    if (entry.animated) {
      tile.appendChild(el('span', 'pet-action-badge is-animated', '动图'));
    }

    tile.appendChild(el('div', 'pet-action-name', ACTION_LABELS[entry.action] || entry.action));
    tile.appendChild(el(
      'div',
      'pet-action-note',
      describeEntry(entry, required, isFallback),
    ));

    const row = el('div', 'pet-panel-toolbar');
    // 内置形象严格只读：**不渲染**换图/恢复按钮。
    // 后端也会拒绝（403），这里只是不让用户点了才发现不行。
    if (detail.writable) {
      row.appendChild(button('换图', 'is-icon', () => {
        pickFile({ accept: 'image/*', onPicked: (file) => uploadActionImage(entry.action, file) });
      }));
      // 「动画参数」：帧率 / 每帧时长 / 循环 / 排布 / 权重 / 程序化运动。
      //
      // 用户要求：「比如我想调整下不同动作的帧率，每帧之间的间隔，
      // 结果发现没有入口，目前只能去直接修改 pet.json 里面的值」。
      // 这个按钮就是那个入口——**只对自建形象开放**（内置形象先复制）。
      row.appendChild(button('动画参数', 'is-icon', () => {
        editingAction = editingAction === entry.action ? '' : entry.action;
        actionDraft = editingAction ? buildActionDraft(entry) : null;
        render();
      }));
      if (entry.overridden) {
        row.appendChild(button('恢复', 'is-icon', () => clearActionImage(entry.action)));
      }
    } else {
      row.appendChild(el('span', 'pet-card-meta', '只读'));
    }
    tile.appendChild(row);
    return tile;
  }

  /**
   * 从动作条目里取一份**可编辑的草稿**（动画参数的初值）。
   *
   * 取值来源是后端下发的 `entry`（它已经把回退链算完），因此对**回退**
   * 动作也能编辑——但那种情况下保存会写进**这个动作自己**的声明，
   * 从而把它从「回退」变成「自带」，这是符合直觉的。
   */
  function buildActionDraft(entry) {
    const grid = frameGrid({
      frames: entry.frames,
      layout: entry.layout,
      cols: entry.cols,
      rows: entry.rows,
    });
    const motion = normalizeMotion(entry);
    return {
      frames: Math.max(1, Number(entry.frames) || 1),
      fps: Number(entry.fps) || 8,
      loop: entry.loop !== false,
      // 非均匀帧时长：包没声明时给一个「按帧率均匀」的初值，
      // 用户改起来有个起点（而不是一片空白）
      frameMs: Array.isArray(entry.frameMs) && entry.frameMs.length
        ? entry.frameMs.slice()
        : [],
      useFrameMs: Array.isArray(entry.frameMs) && entry.frameMs.length > 0,
      layout: grid.cols > 1 && grid.rows > 1 ? 'grid'
        : (grid.rows > 1 ? 'vertical' : 'horizontal'),
      cols: grid.cols,
      rows: grid.rows,
      weight: Number(entry.weight) || 1,
      breatheAmp: motionBreathes(motion) ? motion.amplitude : 0,
      breathePeriod: motionBreathes(motion) ? motion.periodMs : 3200,
      blinkFrames: motionBlinks(motion) ? motion.blinkFrames.slice() : [],
      blinkEvery: motionBlinks(motion) ? motion.blinkEveryMs.slice() : [3000, 7000],
      blinkDuration: motionBlinks(motion) ? motion.blinkDurationMs : 160,
    };
  }

  /**
   * **动画参数编辑区**（就地展开在动作卡片下方）。
   *
   * 用户要求：「pet.json 里面支持了非常多的调节参数，结果界面上没多少能
   * 调整的……比如我想调整下不同动作的帧率，每帧之间的间隔」。
   *
   * 设计取舍：
   * - 先攒草稿、点「保存」才提交——这些字段有联动（`frames` 决定
   *   `frameMs` 的长度），逐字段即时提交会把中间状态写进包里；
   * - 非均匀帧时长默认收起（勾选后才展开逐帧输入框）：绝大多数动作是
   *   均匀的，一上来就铺 4~70 个输入框会把面板撑爆；
   * - 每个字段都带一句「推荐值」，与帮助页同一套口径。
   */
  function renderActionEditor(entry) {
    const box = el('div', 'pet-action-editor');
    const draft = actionDraft;

    // ---- 帧率 / 循环
    const row1 = el('div', 'pet-editor-row');
    row1.appendChild(editorNumber({
      label: '帧率',
      hint: '每秒播几帧',
      value: draft.fps,
      min: 0.5,
      max: 60,
      step: 0.5,
      onInput: (value) => { draft.fps = value; },
    }));
    const loopField = el('div', 'pet-field');
    loopField.appendChild(el('div', 'pet-field-label', '循环'));
    const loopChoice = el('div', 'pet-choice-row');
    for (const option of [
      { value: true, label: '循环' },
      { value: false, label: '播一遍' },
    ]) {
      const node = el(
        'button',
        `pet-choice ${draft.loop === option.value ? 'is-active' : ''}`.trim(),
        option.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.addEventListener('click', () => {
        draft.loop = option.value;
        for (const sibling of loopChoice.children) {
          sibling.classList.toggle('is-active', sibling === node);
        }
      });
      loopChoice.appendChild(node);
    }
    loopField.appendChild(loopChoice);
    row1.appendChild(loopField);
    box.appendChild(row1);

    // ---- 每帧时长（非均匀节奏）
    const frameMsToggle = el('label', 'pet-editor-check');
    const frameMsBox = el('input');
    frameMsBox.type = 'checkbox';
    frameMsBox.checked = draft.useFrameMs;
    frameMsBox.dataset.marqueeIgnore = 'true';
    frameMsToggle.appendChild(frameMsBox);
    frameMsToggle.appendChild(el('span', null, '自定义每帧时长（非均匀节奏）'));
    box.appendChild(frameMsToggle);

    const frameMsWrap = el('div', 'pet-editor-frames');
    frameMsWrap.style.display = draft.useFrameMs ? '' : 'none';
    const rebuildFrameMs = () => {
      frameMsWrap.textContent = '';
      const count = Math.max(1, Number(draft.frames) || 1);
      // 数量对不上时按帧率铺一个均匀的初值——比留空或截断友好
      if (!Array.isArray(draft.frameMs) || draft.frameMs.length !== count) {
        const each = Math.round(1000 / (Number(draft.fps) || 8));
        draft.frameMs = Array.from({ length: count }, () => each);
      }
      for (let index = 0; index < count; index += 1) {
        const cell = el('div', 'pet-editor-frame-cell');
        cell.appendChild(el('div', 'pet-editor-frame-label', `第 ${index + 1} 帧`));
        const input = el('input', 'pet-input pet-editor-frame-input');
        input.type = 'number';
        input.min = '17';
        input.max = '10000';
        input.step = '10';
        input.value = String(draft.frameMs[index] ?? 100);
        input.dataset.marqueeIgnore = 'true';
        input.addEventListener('input', () => {
          draft.frameMs[index] = Number(input.value) || 100;
        });
        cell.appendChild(input);
        frameMsWrap.appendChild(cell);
      }
    };
    rebuildFrameMs();
    frameMsBox.addEventListener('change', () => {
      draft.useFrameMs = frameMsBox.checked;
      frameMsWrap.style.display = draft.useFrameMs ? '' : 'none';
      if (draft.useFrameMs) rebuildFrameMs();
    });
    box.appendChild(frameMsWrap);
    box.appendChild(el(
      'div',
      'pet-field-hint',
      '单位毫秒。开启后每帧单独设停顿时间（帧率会被忽略）——'
      + '例如 400 / 300 / 300 / 600，最后一帧多停一会再循环，看起来比匀速自然。',
    ));

    // ---- 帧数与排布
    const row2 = el('div', 'pet-editor-row');
    row2.appendChild(editorNumber({
      label: '帧数',
      hint: '一张图里有多少帧',
      value: draft.frames,
      min: 1,
      max: 1024,
      step: 1,
      onInput: (value) => {
        draft.frames = Math.max(1, Math.round(value));
        if (draft.useFrameMs) rebuildFrameMs();
      },
    }));
    const layoutField = el('div', 'pet-field');
    layoutField.appendChild(el('div', 'pet-field-label', '排布'));
    const layoutSelect = el('select', 'pet-input');
    layoutSelect.dataset.marqueeIgnore = 'true';
    for (const option of [
      { value: 'horizontal', label: '横排一行' },
      { value: 'vertical', label: '竖排一列' },
      { value: 'grid', label: '网格' },
    ]) {
      const node = el('option', null, option.label);
      node.value = option.value;
      layoutSelect.appendChild(node);
    }
    layoutSelect.value = draft.layout;
    layoutField.appendChild(layoutSelect);
    row2.appendChild(layoutField);
    box.appendChild(row2);

    const gridRow = el('div', 'pet-editor-row');
    const colsField = editorNumber({
      label: '列数',
      hint: '网格的列',
      value: draft.cols,
      min: 1,
      max: 1024,
      step: 1,
      onInput: (value) => { draft.cols = Math.max(1, Math.round(value)); },
    });
    const rowsField = editorNumber({
      label: '行数',
      hint: '网格的行',
      value: draft.rows,
      min: 1,
      max: 1024,
      step: 1,
      onInput: (value) => { draft.rows = Math.max(1, Math.round(value)); },
    });
    gridRow.appendChild(colsField);
    gridRow.appendChild(rowsField);
    const syncGridVisibility = () => {
      const show = draft.layout === 'grid';
      colsField.style.display = show ? '' : 'none';
      rowsField.style.display = show ? '' : 'none';
    };
    syncGridVisibility();
    layoutSelect.addEventListener('change', () => {
      draft.layout = layoutSelect.value;
      syncGridVisibility();
    });
    box.appendChild(gridRow);

    // ---- 权重（多套动画时才有意义）
    const row3 = el('div', 'pet-editor-row');
    row3.appendChild(editorNumber({
      label: '权重',
      hint: '多套动画时的相对比例',
      value: draft.weight,
      min: 0,
      max: 1000,
      step: 0.5,
      onInput: (value) => { draft.weight = value; },
    }));
    box.appendChild(row3);

    // ---- 程序化运动（呼吸 / 眨眼）
    //
    // 这是用户点名「容易出问题」的一项，因此编辑区里也把边界说清楚。
    box.appendChild(el('div', 'pet-editor-divider'));
    box.appendChild(el('div', 'pet-field-label', '程序化运动（不占额外帧）'));
    const row4 = el('div', 'pet-editor-row');
    row4.appendChild(editorNumber({
      label: '呼吸幅度',
      hint: '0.02 已很明显；0 = 关闭',
      value: draft.breatheAmp,
      min: 0,
      max: 0.08,
      step: 0.002,
      onInput: (value) => { draft.breatheAmp = value; },
    }));
    row4.appendChild(editorNumber({
      label: '呼吸周期（秒）',
      hint: '一次呼吸多久',
      value: draft.breathePeriod / 1000,
      min: 0.8,
      max: 20,
      step: 0.2,
      onInput: (value) => { draft.breathePeriod = value * 1000; },
    }));
    box.appendChild(row4);

    const blinkField = el('div', 'pet-field');
    blinkField.appendChild(el('div', 'pet-field-label', '眨眼帧'));
    const blinkInput = el('input', 'pet-input');
    blinkInput.type = 'text';
    blinkInput.placeholder = '例如 2,3（留空 = 不眨眼）';
    blinkInput.value = draft.blinkFrames.join(',');
    blinkInput.dataset.marqueeIgnore = 'true';
    blinkInput.addEventListener('input', () => {
      draft.blinkFrames = blinkInput.value
        .split(/[,，\s]+/)
        .map((part) => Number(part))
        .filter((number) => Number.isInteger(number) && number >= 0);
    });
    blinkField.appendChild(blinkInput);
    blinkField.appendChild(el(
      'div',
      'pet-field-hint',
      '要填真的有闭眼的那几帧（从 0 开始数），否则会把睁眼帧当成眨眼。',
    ));
    box.appendChild(blinkField);

    // ---- 操作
    const actions = el('div', 'pet-panel-toolbar');
    actions.appendChild(button('保存', 'is-primary', () => saveActionAnimation(entry.action)));
    actions.appendChild(button('取消', '', () => {
      editingAction = '';
      actionDraft = null;
      render();
    }));
    if (entry.kind === 'animated') {
      actions.appendChild(el(
        'span',
        'pet-card-meta',
        '这个动作是动图容器（浏览器播放），帧率与帧时长对它无效',
      ));
    }
    box.appendChild(actions);
    return box;
  }

  /**
   * 一个「标签 + 数字框」的小组件（编辑区里用）。
   *
   * 比滑块更适合这里：这些值要么需要精确输入（帧率 2.5、幅度 0.012），
   * 要么范围很窄（帧数 1~1024），滑块的精度不够。
   */
  function editorNumber(options) {
    const field = el('div', 'pet-field');
    field.appendChild(el('div', 'pet-field-label', options.label));
    const input = el('input', 'pet-input');
    input.type = 'number';
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value);
    input.dataset.marqueeIgnore = 'true';
    input.addEventListener('input', () => {
      const number = Number(input.value);
      if (!Number.isFinite(number)) return;
      const clamped = Math.min(Math.max(number, options.min), options.max);
      options.onInput(clamped);
    });
    field.appendChild(input);
    if (options.hint) {
      field.appendChild(el('div', 'pet-field-hint', options.hint));
    }
    return field;
  }

  /**
   * 把编辑区的草稿**一次性**提交给后端（写回 `pet.json`）。
   *
   * 只提交**真的改过**的字段：全量提交会让「本来没声明的字段」被写成
   * 显式值，`pet.json` 会越来越臃肿，而作者原本的「没意见」语义也丢了。
   */
  async function saveActionAnimation(action) {
    const draft = actionDraft;
    if (!draft) return;
    const entry = (detail.actions || []).find((item) => item.action === action) || {};
    const patch = {};

    if (Number(entry.fps) !== Number(draft.fps)) patch.fps = draft.fps;
    if ((entry.loop !== false) !== Boolean(draft.loop)) patch.loop = Boolean(draft.loop);
    if (Number(entry.frames) !== Number(draft.frames)) patch.frames = draft.frames;

    const hadFrameMs = Array.isArray(entry.frameMs) && entry.frameMs.length > 0;
    if (draft.useFrameMs) {
      const same = hadFrameMs
        && entry.frameMs.length === draft.frameMs.length
        && entry.frameMs.every((value, index) => Number(value) === Number(draft.frameMs[index]));
      if (!same) patch.frameMs = draft.frameMs.map((value) => Number(value) || 100);
    } else if (hadFrameMs) {
      // 关掉 = 删除该字段（回落到按帧率的均匀节奏）
      patch.frameMs = null;
    }

    const grid = frameGrid({
      frames: entry.frames, layout: entry.layout, cols: entry.cols, rows: entry.rows,
    });
    const currentLayout = grid.cols > 1 && grid.rows > 1 ? 'grid'
      : (grid.rows > 1 ? 'vertical' : 'horizontal');
    if (currentLayout !== draft.layout) patch.layout = draft.layout;
    if (draft.layout === 'grid') {
      if (grid.cols !== draft.cols) patch.cols = draft.cols;
      if (grid.rows !== draft.rows) patch.rows = draft.rows;
    }
    if (Number(entry.weight) !== Number(draft.weight)) patch.weight = draft.weight;

    // 程序化运动：把草稿拼成一个完整的 motion 对象（或 null = 删除）
    const motion = normalizeMotion(entry);
    const hadBreathe = motionBreathes(motion);
    const hadBlink = motionBlinks(motion);
    const wantBreathe = Number(draft.breatheAmp) > 0;
    const wantBlink = draft.blinkFrames.length > 0;
    const breatheSame = hadBreathe === wantBreathe
      && (!wantBreathe || (Number(motion.amplitude) === Number(draft.breatheAmp)
        && Number(motion.periodMs) === Number(draft.breathePeriod)));
    const blinkSame = hadBlink === wantBlink
      && (!wantBlink || (motion.blinkFrames.join(',') === draft.blinkFrames.join(',')
        && Number(motion.blinkDurationMs) === Number(draft.blinkDuration)));
    if (!breatheSame || !blinkSame) {
      if (!wantBreathe && !wantBlink) {
        patch.motion = null;
      } else {
        const next = {};
        if (wantBreathe) {
          next.breathe = {
            amplitude: Number(draft.breatheAmp),
            periodMs: Math.round(Number(draft.breathePeriod)),
          };
        }
        if (wantBlink) {
          next.blink = {
            frames: draft.blinkFrames.slice(),
            everyMs: [Number(draft.blinkEvery[0]), Number(draft.blinkEvery[1])],
            durationMs: Math.round(Number(draft.blinkDuration)),
          };
        }
        patch.motion = next;
      }
    }

    if (!Object.keys(patch).length) {
      setNotice('ok', '没有改动');
      editingAction = '';
      actionDraft = null;
      render();
      return;
    }

    await withBusy(async () => {
      const data = await call(
        `/pets/${encodeURIComponent(selectedId)}/actions/${encodeURIComponent(action)}/animation`,
        { method: 'POST', body: { patch } },
      );
      if (!data) return;
      setNotice('ok', `「${ACTION_LABELS[action] || action}」的动画参数已保存`);
      editingAction = '';
      actionDraft = null;
      // 让运行中的宠物立刻用上新参数
      if (onPetChanged) await onPetChanged(activeId);
      await refresh();
    });
  }

  /**
   * 「新建形象」表单。
   *
   * 设计取舍：**不做**自由拖拽上传区，也不做多帧预览器——
   * 每个动作一行「选图 + 帧数」，够用且不易出错。帧数填了就按水平 spritesheet
   * 切分（后端校验宽度能否整除，除不尽会给出可读错误）。
   */
  function renderCreate() {
    const wrap = el('div', 'pet-panel-detail');

    const header = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '新建形象'));
    header.appendChild(title);
    header.appendChild(el(
      'div',
      'pet-field-hint',
      '给每个动作上传一张图即可。单帧尺寸从「待机」推导，其它动作会自动对齐，'
      + '所以不必自己裁成统一尺寸；形象也不要求是正方形。',
    ));

    const nameField = el('div', 'pet-field');
    nameField.appendChild(el('div', 'pet-field-label', '形象名字'));
    const nameInput = el('input', 'pet-input');
    nameInput.type = 'text';
    nameInput.value = draftName;
    nameInput.placeholder = '例如：我的猫娘';
    nameInput.maxLength = 60;
    nameInput.dataset.createName = 'true';
    nameInput.addEventListener('input', () => { draftName = nameInput.value; });
    nameField.appendChild(nameInput);
    header.appendChild(nameField);

    // ---- 作者署名（用户要求：自定义宠物应能设作者名，便于发布）
    const authorField = el('div', 'pet-field');
    authorField.appendChild(el('div', 'pet-field-label', '作者'));
    const authorInput = el('input', 'pet-input');
    authorInput.type = 'text';
    authorInput.value = draftAuthor;
    authorInput.placeholder = '例如：你的昵称（可留空）';
    authorInput.maxLength = 60;
    authorInput.dataset.createAuthor = 'true';
    authorInput.addEventListener('input', () => { draftAuthor = authorInput.value; });
    authorField.appendChild(authorInput);
    authorField.appendChild(el(
      'div',
      'pet-field-hint',
      '会写进形象的 pet.json，导出形象包时一起带走。'
      + '想让别人知道这个宠物是谁做的，就填上。',
    ));
    header.appendChild(authorField);
    wrap.appendChild(header);

    // ---- 动作列表
    const section = el('div', 'pet-section');
    section.appendChild(el('div', 'pet-section-title', '动作图'));
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '「待机」是唯一必须的：其它动作缺失时会自动回退到它。'
      + '若一张图里横向排了多帧动画，把帧数填上即可。',
    ));

    for (const item of CREATABLE_ACTIONS) {
      section.appendChild(renderCreateRow(item));
    }
    wrap.appendChild(section);

    // ---- 标准图像（不播动画时显示的那一帧）
    wrap.appendChild(renderCreateStill());

    // ---- 触发时间（初始值；创建后仍可在形象详情里改）
    wrap.appendChild(renderCreateSchedule());

    // ---- 外观初值
    const look = el('div', 'pet-section');
    look.appendChild(el('div', 'pet-section-title', '初始外观'));
    const scaleField = el('div', 'pet-field');
    const scaleHead = el('div', 'pet-slider-head');
    scaleHead.appendChild(el('span', 'pet-field-label', '大小倍率'));
    const scaleReadout = el('span', 'pet-slider-value', formatScale(draftScale));
    scaleHead.appendChild(scaleReadout);
    scaleField.appendChild(scaleHead);

    // 草稿值是**纯本地**的（创建时才随表单提交），因此没有 `onCommit`。
    const scale = createSliderRow({
      min: limits.scaleMin || SCALE_MIN,
      max: limits.scaleMax || SCALE_MAX,
      step: SCALE_STEP,
      value: draftScale,
      label: '新形象的大小倍率',
      format: (value) => String(value),
      onInput: (value) => {
        draftScale = value;
        scaleReadout.textContent = formatScale(draftScale);
      },
    });
    scaleField.appendChild(scale.row);
    scaleField.appendChild(el(
      'div',
      'pet-field-hint',
      '创建后仍可在形象详情里随时调整，并且是按形象记住的。',
    ));
    look.appendChild(scaleField);

    const pixField = el('div', 'pet-field');
    pixField.appendChild(el('div', 'pet-field-label', '渲染方式'));
    const pixChoice = el('div', 'pet-choice-row');
    for (const mode of [
      { value: false, label: '平滑（插画 / 真人）' },
      { value: true, label: '像素风（硬边）' },
    ]) {
      const node = el(
        'button',
        `pet-choice ${draftPixelated === mode.value ? 'is-active' : ''}`.trim(),
        mode.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.addEventListener('click', () => {
        draftPixelated = mode.value;
        render();
      });
      pixChoice.appendChild(node);
    }
    pixField.appendChild(pixChoice);
    look.appendChild(pixField);
    wrap.appendChild(look);

    // ---- 操作
    const actions = el('div', 'pet-panel-toolbar');
    actions.appendChild(button('创建', 'is-primary', () => submitCreate()));
    actions.appendChild(button('取消', '', () => {
      creating = false;
      draft = {};
      draftName = '';
      draftAuthor = '';
      draftStill = null;
      draftSchedule = null;
      notice = null;
      render();
    }));
    actions.appendChild(el(
      'span',
      'pet-card-meta',
      draft.idle && draft.idle.file ? '已选择待机图' : '还需要一张「待机」图',
    ));
    wrap.appendChild(actions);

    return wrap;
  }

  /**
   * 新建表单的**标准图像**区。
   *
   * 这是本轮修「宠物一直卡在抬头看的那一帧」的入口。不设也能用（回落到
   * idle 首帧），但作者一旦给 idle 挂了第二套动画（例如「张望」），
   * 回落值就可能是个怪姿势，所以这里明确地把这件事摆出来让作者决定。
   *
   * 三种选择：
   * - 不设（默认，回落 idle 首帧）；
   * - 复用某个已上传动作的某一帧（最常见的「idle 第 3 帧就是我要的姿势」）；
   * - 单独上传一张。
   */
  function renderCreateStill() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '标准图像'));
    title.appendChild(el('span', 'pet-badge', '可选'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '不播放动画时显示的那一帧（也就是平时静止的姿势）。'
      + '不设就回落到「待机」的第一帧——若待机挂了两套动画，'
      + '那个回落值可能是个怪姿势，因此建议显式选一张。',
    ));

    const row = el('div', 'pet-choice-row');
    const modes = [
      { key: 'none', label: '不设（用待机首帧）' },
      { key: 'action', label: '复用某个动作的一帧' },
      { key: 'file', label: '单独上传一张' },
    ];
    const currentKey = !draftStill ? 'none' : (draftStill.file ? 'file' : 'action');
    for (const mode of modes) {
      const node = el(
        'button',
        `pet-choice ${currentKey === mode.key ? 'is-active' : ''}`.trim(),
        mode.label,
      );
      node.type = 'button';
      node.dataset.marqueeIgnore = 'true';
      node.dataset.stillMode = mode.key;
      node.addEventListener('click', () => {
        if (mode.key === 'none') draftStill = null;
        else if (mode.key === 'action') draftStill = { action: 'idle', frame: 0 };
        else draftStill = { file: null, frames: 1 };
        render();
      });
      row.appendChild(node);
    }
    section.appendChild(row);

    if (currentKey === 'action') {
      const pick = el('div', 'pet-field');
      const select = el('select', 'pet-input');
      select.dataset.stillAction = 'true';
      for (const [action, entry] of Object.entries(draft)) {
        if (!entry || !entry.file) continue;
        const option = el('option', null, ACTION_LABELS[action] || action);
        option.value = action;
        select.appendChild(option);
      }
      select.value = draftStill.action || 'idle';
      select.addEventListener('change', () => {
        draftStill = { action: select.value, frame: 0 };
        render();
      });
      pick.appendChild(el('div', 'pet-field-label', '用哪个动作的图'));
      pick.appendChild(select);

      const frames = Math.max(1, Number((draft[select.value] || {}).frames) || 1);
      const frameInput = el('input', 'pet-input is-num');
      frameInput.type = 'number';
      frameInput.min = '1';
      frameInput.max = String(frames);
      frameInput.value = String(Math.min(Number(draftStill.frame) || 0, frames - 1) + 1);
      frameInput.dataset.stillFrame = 'true';
      frameInput.addEventListener('change', () => {
        const value = Math.max(1, Math.min(frames, Number(frameInput.value) || 1));
        frameInput.value = String(value);
        draftStill = { action: select.value, frame: value - 1 };
      });
      pick.appendChild(el('div', 'pet-field-label', `用第几帧（这个动作共 ${frames} 帧）`));
      pick.appendChild(frameInput);
      section.appendChild(pick);
    } else if (currentKey === 'file') {
      const pick = el('div', 'pet-field');
      const cell = el('div', 'pet-create-file');
      cell.appendChild(button(
        draftStill.file ? '重新选择' : '选择图片',
        'is-icon',
        () => pickFile({
          accept: 'image/*',
          onPicked: (file) => {
            draftStill = Object.assign({ frames: 1 }, draftStill, { file });
            render();
          },
        }),
      ));
      if (draftStill.file) {
        cell.appendChild(el('span', 'pet-card-meta', truncateName(draftStill.file.name)));
      }
      pick.appendChild(cell);
      pick.appendChild(el(
        'div',
        'pet-field-hint',
        '会按形象的单帧尺寸自动缩放居中，不必自己裁。',
      ));
      section.appendChild(pick);
    }

    return section;
  }

  /**
   * 新建表单的**触发时间**区。
   *
   * 默认「用默认值」——大多数作者不该被这个困扰。想调的作者可以在这里
   * 给出形象自己的节奏，它会写进 `pet.json` 成为这个形象的「作者建议值」。
   */
  function renderCreateSchedule() {
    const section = el('div', 'pet-section');
    const title = el('div', 'pet-section-title');
    title.appendChild(el('span', null, '触发时间'));
    title.appendChild(el('span', 'pet-badge', '可选'));
    section.appendChild(title);
    section.appendChild(el(
      'div',
      'pet-field-hint',
      '闲着的时候多久自己动一次。不填就用默认值'
      + '（待机小动作 6~18 秒、自动漫游 3~9 秒），大多数形象不需要改。',
    ));

    for (const behavior of SCHEDULE_BEHAVIORS) {
      const preset = DEFAULT_SCHEDULE_MS[behavior.key]
        || { min: 6000, max: 18000 };
      const current = (draftSchedule && draftSchedule[behavior.key]) || preset;
      const minMs = clampScheduleMs(current.min ?? current.minIntervalMs, preset.min);
      const maxMs = clampScheduleMs(current.max ?? current.maxIntervalMs, preset.max);

      const field = el('div', 'pet-field');
      const head = el('div', 'pet-slider-head');
      head.appendChild(el('span', 'pet-field-label', behavior.label));
      const readout = el('span', 'pet-slider-value', formatInterval(minMs, maxMs));
      head.appendChild(readout);
      field.appendChild(head);

      const row = el('div', 'pet-schedule-row');
      for (const bound of ['min', 'max']) {
        const slider = el('input', 'pet-slider');
        slider.type = 'range';
        slider.min = String(limits.scheduleMinMs);
        slider.max = String(limits.scheduleMaxMs);
        slider.step = '100';
        slider.value = String(bound === 'min' ? minMs : maxMs);
        slider.dataset.createSchedule = behavior.key;
        slider.dataset.createScheduleBound = bound;
        slider.setAttribute(
          'aria-label', `新形象的${behavior.label}${bound === 'min' ? '最短' : '最长'}间隔`,
        );
        // 草稿是纯本地状态（提交表单时才落盘），因此这里**没有**「松手才提交」
        // 的顾虑：`input` 里直接更新草稿与读数即可，一个请求都不会发。
        const sync = () => {
          const low = Number(row.querySelector('[data-create-schedule-bound="min"]').value);
          const high = Number(row.querySelector('[data-create-schedule-bound="max"]').value);
          readout.textContent = formatInterval(low, high);
          draftSchedule = Object.assign({}, draftSchedule, {
            [behavior.key]: {
              min: clampScheduleMs(low, preset.min),
              max: clampScheduleMs(high, preset.max),
            },
          });
        };
        slider.addEventListener('input', sync);

        // 与形象详情里的两个滑块一样，配一个可直接输入的数字框
        const lowLimit = Number(limits.scheduleMinMs) || SCHEDULE_FALLBACK_MIN_MS;
        const highLimit = Number(limits.scheduleMaxMs) || SCHEDULE_FALLBACK_MAX_MS;
        const box = attachNumberBox(slider, {
          label: `新形象的${behavior.label}${bound === 'min' ? '最短' : '最长'}间隔（毫秒）`,
          clamp: (raw) => {
            const number = Number(raw);
            const base = Number.isFinite(number) ? number : lowLimit;
            const bounded = Math.min(Math.max(base, lowLimit), highLimit);
            return Math.round(bounded / 100) * 100;
          },
          onInput: sync,
          onCommit: sync,
        });
        const boundRow = el('div', 'pet-slider-row');
        boundRow.appendChild(slider);
        boundRow.appendChild(box.input);
        row.appendChild(boundRow);
      }
      field.appendChild(row);
      // 区间两端提示（与宿主预设编辑器一致：最小 / 当前 / 最大）
      const rangeRow = el('div', 'pet-slider-range');
      rangeRow.appendChild(el('span', null, formatMs(limits.scheduleMinMs)));
      rangeRow.appendChild(el('span', null, formatMs(limits.scheduleMaxMs)));
      field.appendChild(rangeRow);
      section.appendChild(field);
    }
    return section;
  }

  /** 新建表单里的单个动作行：选图 + 帧数 + 帧率。 */
  function renderCreateRow({ action, required }) {
    const entry = draft[action] || null;
    const row = el('div', 'pet-create-row');

    const label = el('div', 'pet-create-label');
    label.appendChild(el('span', 'pet-field-label', ACTION_LABELS[action] || action));
    label.appendChild(el(
      'span',
      required ? 'pet-badge is-required' : 'pet-card-meta',
      required ? '必需' : '可选',
    ));
    row.appendChild(label);

    const fileCell = el('div', 'pet-create-file');
    fileCell.appendChild(button(entry && entry.file ? '重新选择' : '选择图片', 'is-icon', () => {
      pickFile({
        accept: 'image/*',
        onPicked: (file) => {
          draft[action] = Object.assign({ frames: 1, fps: 0 }, draft[action], { file });
          render();
        },
      });
    }));
    if (entry && entry.file) {
      fileCell.appendChild(el('span', 'pet-card-meta', truncateName(entry.file.name)));
    }
    row.appendChild(fileCell);

    const framesCell = el('div', 'pet-create-num');
    framesCell.appendChild(el('span', 'pet-card-meta', '帧数'));
    const framesInput = el('input', 'pet-input is-num');
    framesInput.type = 'number';
    framesInput.min = '1';
    framesInput.max = '64';
    framesInput.value = String(entry && entry.frames ? entry.frames : 1);
    framesInput.disabled = !entry || !entry.file;
    framesInput.addEventListener('change', () => {
      const value = Math.max(1, Math.min(64, Number(framesInput.value) || 1));
      framesInput.value = String(value);
      draft[action] = Object.assign({}, draft[action], { frames: value });
    });
    framesCell.appendChild(framesInput);
    row.appendChild(framesCell);

    const fpsCell = el('div', 'pet-create-num');
    fpsCell.appendChild(el('span', 'pet-card-meta', 'fps'));
    const fpsInput = el('input', 'pet-input is-num');
    fpsInput.type = 'number';
    fpsInput.min = '1';
    fpsInput.max = '60';
    fpsInput.placeholder = '默认';
    fpsInput.value = entry && entry.fps ? String(entry.fps) : '';
    fpsInput.disabled = !entry || !entry.file;
    fpsInput.addEventListener('change', () => {
      const raw = Number(fpsInput.value);
      const value = raw > 0 ? Math.max(1, Math.min(60, raw)) : 0;
      fpsInput.value = value ? String(value) : '';
      draft[action] = Object.assign({}, draft[action], { fps: value });
    });
    fpsCell.appendChild(fpsInput);
    row.appendChild(fpsCell);

    if (entry && entry.file) {
      row.appendChild(button('移除', 'is-icon', () => {
        delete draft[action];
        render();
      }));
    }

    return row;
  }

  /** 文件名过长时中间截断（面板很窄，完整名字会撑破布局）。 */
  function truncateName(name) {
    const text = String(name || '');
    if (text.length <= 18) return text;
    return `${text.slice(0, 8)}…${text.slice(-6)}`;
  }

  function describeEntry(entry, required, isFallback) {
    if (entry.kind !== 'animated') {
      return entry.note || '没有可用的图，只移动位置';
    }
    if (isFallback) {
      return `未提供，回退到「${ACTION_LABELS[entry.source] || entry.source}」`;
    }
    // 动图容器：说「单帧（静态显示）」是**假话**——它明明在动，
    // 而用户看到这个标签会以为自己的图坏了。
    if (entry.animated) {
      const count = Number(entry.animatedFrames) || 1;
      return count > 1 ? `动图容器 · ${count} 帧 · 浏览器播放` : '动图容器';
    }
    const frames = Number(entry.frames) || 1;
    // 有程序化运动时**不能**说「单帧（静态显示）」——它明明在动，
    // 而「1 帧却在动」正是最容易让人以为包坏了的地方。
    // ⚠️ 必须用**规范化后**的形状：`entry.motion` 是后端下发的原始形状
    // （`{breathe: {amplitude, periodMs}}`），直接读 `.amplitude` 恒为 undefined。
    const motion = normalizeMotion(entry);
    const moving = motionBreathes(motion) || motionBlinks(motion);
    if (frames <= 1 && moving) {
      return '1 帧 + 程序化运动（呼吸/眨眼）';
    }
    if (frames <= 1) return '单帧（静态显示）';
    const suffix = required ? '' : '（可选）';
    // 网格排布时把形状写出来：`frames` 与网格容量不一致是合法的
    // （4×4 只放 13 帧），但那正是作者最容易填错的地方，值得显示。
    const shape = frameGrid({ frames, layout: entry.layout, cols: entry.cols, rows: entry.rows });
    const where = shape.cols > 1 && shape.rows > 1
      ? `${shape.cols}×${shape.rows} `
      : '';
    return `${where}${frames} 帧 @ ${entry.fps}fps${suffix}`;
  }

  // ---------------------------------------------------------------- 生命周期

  return {
    /** 由表面的 `mount(container)` 调用。返回清理函数。 */
    mount(container) {
      root = el('div', 'pet-panel plugin-stm-pet');
      root.dataset.plugin = 'stm-pet';
      container.appendChild(root);
      render();
      // 缩略图方框宽度可能随容器变化（`clientWidth` 变化后帧几何要重算），
      // 因此挂上后补一次；ResizeObserver 不可用时跳过（只是缩略图略偏，不影响功能）
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
          applyThumbGeometry();
          // 预览框的尺寸也可能变（右栏宽度变化），帧几何要跟着重算
          if (player) player.seek(player.frame);
        });
        resizeObserver.observe(root);
      }
      // 首屏加载（不阻塞挂载，失败会显示为通知条）
      withBusy(refresh);
      return () => {
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        // 预览器的定时器必须停掉：面板关掉之后它还在跑就是泄漏
        if (player) {
          player.dispose();
          player = null;
        }
        pendingPreview = null;
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = null;
      };
    },

    /** 表面已挂载时再次从入口进入（宿主不会重新 mount）。 */
    onOpen() {
      if (!root) return;
      // 每次打开都同步一次显示状态：宠物可能被别处（诊断句柄 / 别的入口）关掉了
      if (typeof getHidden === 'function') hiddenState = Boolean(getHidden());
      // 每次打开都刷新一次：形象可能被别处改过
      withBusy(refresh);
    },

    /** 由 `plugin.js` 回灌显示状态（后台改状态时让面板跟上）。 */
    setHiddenState,

    /**
     * 打开面板时回到形象详情（而不是停在新建表单）。
     *
     * 用户从入口进来通常是想**管理**已有形象；上次没提交完的草稿留在内存里，
     * 下次点「新建形象」还能接着填。
     */
    resetView() {
      creating = false;
      if (root) render();
    },

    /** 宿主配置变更（标量开关走宿主表单）→ 反映到面板上的只读提示。 */
    refreshConfig() {
      if (root) render();
    },

    dispose() {
      disposed = true;
      if (player) {
        player.dispose();
        player = null;
      }
      pendingPreview = null;
      root = null;
    },
  };
}
