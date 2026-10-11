/**
 * 方向化行走的**纯逻辑**（不碰 DOM，可在 Node 里直接单测）。
 *
 * 为什么需要这个模块
 * ------------------
 * 宠物的移动是**水平**的，而正面视角的行走图看起来是「原地踏步 + 平移」。
 * 因此形象可以给左右两套侧视行走图（`walk-left` / `walk-right`）。
 *
 * 三件事必须在这里判定清楚，否则会出现「左右颠倒」或「发夹翻边」：
 *
 * 1. **该请求哪个动作**：向左走 → `walk-left`，向右走 → `walk-right`。
 * 2. **要不要再翻转贴图**：
 *    - 方向化贴图（后端 `source` 是 `walk-*`）**已经画好了朝向**，
 *      再按朝向翻一次就反了；翻转与否只看后端的 `mirror` 标记
 *      （后端在「只提供一侧」时会置 `mirror=true`）。
 *    - 回退到**正面** `walk` 的旧式形象（例如默认小猫）没有朝向信息，
 *      只能沿用旧行为：按朝向翻转。
 * 3. **非行走动作要不要按朝向翻转**：
 *    提供了方向化贴图的形象，说明作者在意左右差异（典型：头饰不对称），
 *    此时连 `idle` 也不该按朝向翻转——否则发夹会左右跳。
 *    没有方向化贴图的形象保持旧行为不变。
 *
 * 这些规则全是纯函数，`petview.js` 只负责把结果写进 `style.transform`。
 */

/** 向左行走的动作名。 */
export const WALK_LEFT = 'walk-left';

/** 向右行走的动作名。 */
export const WALK_RIGHT = 'walk-right';

/** 方向化动作名的前缀（用于判定后端 `source` 是不是方向化贴图）。 */
const DIRECTIONAL_PREFIX = 'walk-';

/**
 * 方向 → 应该请求的动作名。
 *
 * @param {number} direction 负数向左，其余向右（与 `physics.walk` 的约定一致）
 * @returns {string} `walk-left` 或 `walk-right`
 */
export function walkActionFor(direction) {
  return Number(direction) < 0 ? WALK_LEFT : WALK_RIGHT;
}

/**
 * 后端给的 `source` 是不是**方向化**贴图（已经画好了朝向）。
 *
 * @param {string} source 后端 `pack.resolve()` 的 `source` 字段
 */
export function isDirectionalSource(source) {
  return typeof source === 'string' && source.indexOf(DIRECTIONAL_PREFIX) === 0;
}

/**
 * 这个形象是否提供了方向化行走贴图。
 *
 * 只要左右任一侧解析到了方向化贴图就算——**镜像复用**也算，
 * 因为镜像同样表达了「这一帧朝左/朝右」，与正面图语义不同。
 *
 * @param {object} actions 运行期形象的动作表（`pack.actions`）
 */
export function packHasDirectionalWalk(actions) {
  const table = actions || {};
  for (const name of [WALK_LEFT, WALK_RIGHT]) {
    const spec = table[name];
    if (spec && isDirectionalSource(spec.source)) return true;
  }
  return false;
}

/**
 * 行走时最终该怎么画。
 *
 * @param {number} direction 移动方向（负数向左）
 * @param {object} actions 运行期形象的动作表
 * @returns {{action: string, mirror: boolean}}
 *   `action` 是要播的动作名；`mirror` 是是否水平翻转贴图。
 */
export function resolveWalkVisual(direction, actions) {
  const wanted = walkActionFor(direction);
  const spec = (actions || {})[wanted];
  const legacyMirror = Number(direction) < 0;

  // 连行走图都没有（只有 idle）：交给回退链，翻转沿用旧行为
  if (!spec || !spec.url) return { action: wanted, mirror: legacyMirror };

  if (isDirectionalSource(spec.source)) {
    // 方向化贴图：朝向由贴图自己决定，翻转只看后端的镜像标记
    return { action: wanted, mirror: spec.mirror === true };
  }

  // 回退到了正面 `walk`：没有朝向信息，按移动方向翻转（旧行为）
  return { action: wanted, mirror: legacyMirror };
}

/**
 * 非行走动作（idle / sleep / …）是否要按朝向翻转。
 *
 * 提供了方向化贴图的形象**不翻**：作者在意左右差异（头饰、单侧道具），
 * 翻转会让这些细节左右跳。没有方向化贴图的形象保持旧行为。
 *
 * @param {number} facing 当前朝向（负数向左）
 * @param {object} actions 运行期形象的动作表
 */
export function mirrorForNonWalkAction(facing, actions) {
  if (packHasDirectionalWalk(actions)) return false;
  return Number(facing) < 0;
}
