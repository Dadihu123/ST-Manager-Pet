# 宿主侧反馈（HOST_FEEDBACK）

记录宠物插件在实现过程中发现的**宿主契约偏差**与**期望的宿主能力**。

规则：宿主仓库只读（契约冻结在 `29aa4f4`，工作区 HEAD 为 `1e19a5f`，仅多一份文档提交）。
本文件只记录，不就地改宿主代码。

核对方式：`tools/verify-ambient.mjs` 在**真实 Chrome** 里加载影子宿主
（`tools/host_sandbox.py` 生成，独立 `data/`），用 CDP 驱动宿主真实的
`pluginSurfaceHost.js`，逐条断言。**桌面 + 移动端 11/11 通过**。

另外两套真实浏览器验收也已全绿：

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `tools/verify-ambient.mjs` | 阶段 0 的 ambient 容器契约 | 11/11 |
| `tools/verify-pet.mjs` | 宠物本体：渲染 / 动画 / 拖拽 / 掉落 / 省电 / 移动端 | 19/19 |
| `tools/verify-upload.mjs` | 形象管理链：面板上传 / 像素核对 / 持久化 / 安全拦截 | 15/15 |

---

## 1. 【偏差 · 已绕过】`surfaces.register()` 在移动端**不返回空串**

**实施提示词 §2.1 的说法**：

> **移动端不挂载**：`register()` 直接返回空串（`""`）并 `console.warn`。
> **插件必须处理这个返回值**（见 §4.6）。

**实测（`ST-Manager@1e19a5f`，真实浏览器 mobile 视口 480×900）**：

```json
{ "deviceType": "mobile", "registeredKey": "stm-pet-smoke:smoke", "mountCount": 0 }
```

`register()` **始终**返回 `${pluginId}:${surfaceId}`；移动端不挂载的判断发生在
`PluginSurfaceHost._mountAmbient()` 内部（`hostDeviceType() === 'mobile'` 时
`console.warn` + `return null`），**不影响 `register()` 的返回值**
（`static/js/pluginSurfaceHost.js` 的 `register()` 末尾无条件 `return key`）。

`register()` 唯一返回 `""` 的情形是**参数非法**（`surfaceId` 为空，或 `spec.mount`
不是函数）。也就是说：

```js
const key = api.surfaces.register('pet', { type: 'ambient', mount });
if (!key) { /* 这里其实只会命中「我传错了」，**不是**移动端 */ }
```

**影响**：按提示词写 `if (!key) → 降级` 是**假信号**——桌面端正常时也会走进
降级分支（因为 key 恒为真），而移动端反而会把「注册成功」误判为「已挂载」。
`api.surfaces.isOpen('pet')` 同样不可靠：移动端返回 `false`，桌面端返回 `true`，
**这个是可靠的**，但它是「打开态」而非「能力探测」。

**插件侧的绕法**（不读 store，不做 Provisional 耦合）：

```js
const key = api.surfaces.register('pet', { type: 'ambient', mount });
const mounted = Boolean(key) && api.surfaces.isOpen('pet');
```

`isOpen()` 走的是宿主 `open` 表；移动端 `_mountAmbient` 提前返回，**不写表**，
因此 `isOpen` 为 `false`。实测桌面 `true` / 移动端 `false`，可用来判定「真的挂上了」。

**建议宿主**：让 `register()` 对 `ambient` 在移动端也 `return ""`（与文档一致），
或新增一个显式的 `api.surfaces.available(type)` / 把 `hasAmbient` 暴露成插件可查询的
能力位。当前 `hostFeatures()` 的 `hasAmbient` **只服务于 `entries[].when.feature`**，
插件在 `activate()` 里拿不到它。

---

## 2. 【偏差 · 已绕过】ambient 容器**没有** `plugin-<id>` 类，只有 `data-plugin`

**实施提示词 §1.3 的说法**：

> `api.createRoot()` 生成的容器自动带 `data-plugin`，`pluginHost.js` 也会给根加
> `plugin-<id>` 类。

**实测**（ambient 依赖链，逐层 dump）：

```
DIV.pet-smoke-box                       ← 插件自绘
DIV.plugin-surface__ambient-body
DIV.plugin-surface.plugin-surface--ambient   dataset.plugin = "stm-pet-smoke"   ← 无 plugin-<id> 类
DIV.plugin-surface-root
BODY
```

`plugin-<id>` 类只加在 **`api.createRoot()`** 的产物上（`pluginHost.js:1227`），
而 `createRoot` 的落点是 `#plugin-host-root`——**不是** ambient 容器内部。

**影响**：在 ambient 内按提示词的示例写法给样式加作用域：

```css
.plugin-stm-pet .pet-body { pointer-events: auto; }   /* ← 整份匹配不到 */
```

这条规则**永不生效**，且失败是静默的——症状恰好是提示词 §8 陷阱 1 描述的
「拖不动 / 点了没反应」，很容易被误判成忘了写 `pointer-events: auto`。
本插件第一版就是这样踩的（真实浏览器用例 ③④ 同时失败）。

**插件侧的绕法**（二选一，本插件两个都做）：

```css
[data-plugin="stm-pet"] .pet-body { ... }   /* 宿主给 ambient shell 的标记，稳定 */
.plugin-stm-pet .pet-body { ... }           /* 插件自己给根元素补的类 */
```

```js
root.className = 'pet-root plugin-stm-pet';   // 插件自绘根元素两个都带
root.dataset.plugin = 'stm-pet';
```

**注意与 F11 静态检查的关系**：`installer.scan_css_scope()` 认可的作用域根是
`.plugin-<id>` 或 `[data-plugin="<id>"]`——**两者都算合规**，所以用
`[data-plugin="stm-pet"]` 既能通过检查，又能真正匹配到 DOM。

**建议宿主**：`_mountAmbient` 建 shell 时补一句 `shell.classList.add('plugin-' + record.pluginId)`
（一行，与 `createRoot` 对齐），或把 §1.3 的措辞改准。

---

## 3. 【记录 · 非缺陷】`window.PluginHost` 不存在

`pluginHost.js` 的 `PluginHost` 是 **ESM 具名导出**（另有 `export default`），
没有挂到 `window`。验收脚本第一版想借 `window.PluginHost.PluginSurfaceHost` 开一个
modal 来触发 `is-host-occluded`，拿不到。

不是宿主的错（不往 window 上堆全局是好事），已改为**用插件侧公开的 `api`** 触发
（`api.surfaces.register` + `api.surfaces.open`），更贴近真实插件的行为。

---

## 3b. 【偏差 · 已绕过】`api.log()` 不存在；`api.host.log()` 的参数顺序是 `(message, level)`

**实测**：`static/js/pluginHost.js` 的 `buildApi()` 返回的 `api` 对象上**没有** `log`；
日志能力在 `api.host.log(message, level)`（注意 message 在前、level 在后）。

**为什么值得记一笔**：写错的表现极具误导性。`api.log(...)` 抛出的 `TypeError`
会被宿主在 `loadPlugin()` 的 `try` 里接住，于是控制台只留一句
「插件加载失败」，**但宠物已经画到屏幕上了**（`activate()` 是在抛错点之前完成了
`register()` 的）。更麻烦的是：如果这个抛错发生在
`machine.beginDrag()` 之前的钩子里，用户感知到的症状是**「宠物拖不动」**，
而真正的原因在几百行之外的一次日志调用上。

**插件侧的做法**：加了一层 `createLogger(api)` 适配（兼容 `api.log` /
`api.host.log` / 裸 `console` 三种），并把钩子调用包进 `safeHook`——
外部回调失败只影响它自己，不能打断状态迁移与拖拽路径。
另外补了静态测试（`tests/test_host_api_usage.py`）从宿主源码解析 `api` 的成员表，
逐条核对插件用到的每个 `api.*` 都真实存在。

**建议宿主**：无（当前设计合理）。只是文档里如果提到插件日志，
建议明确写出 `api.host.log(message, level)` 的**参数顺序**——
它和绝大多数日志 API 的 `(level, message)` 相反，容易写反。

---

## 4. 【期望】希望 `api.host.onState` 增加的具体字段

暂无。§2.3 列出的 8 个字段（`mode` / `deviceType` / `darkMode` / `scrimActive` /
`surfaceOpen` / `busy` / `reducedMotion` / `visible`）与 `pluginHost.js` 的
`hostStateBroadcaster.snapshot()` **逐字段核对一致**，够用：

- 省电表（`visible` / `reducedMotion` / `busy` / `scrimActive` / `surfaceOpen`）全覆盖；
- `reducedMotion` 的 `change` 监听确实装了（`installWatchers`），系统改设置立即推送。

**唯一的小缺口**：插件想在**移动端**做降级形态时，`onState` 会推 `deviceType: 'mobile'`，
而首次快照是在 `activate()` 期间的订阅时点推的——那时得到的是正确的值，所以够用。

---

## 5. 【缺口 · ✅ 已修复】`api.toast` 的图标位只接受 **16 个写死的名字**

> **状态：已修复。** 宿主 `ST-Manager@715d0a8`
> 「fix(plugins): toast 图标位接入统一解析，解锁宿主 176 个图标与插件自带图标」。
> 修复提示词见 `docs/HOST_TOAST_ICON_FIX_PROMPT.md`（已被宿主仓库采纳，
> 也放在宿主的 `docs/HOST_TOAST_ICON_FIX_PROMPT.md`）。
>
> 修复后实测（`tools/verify-toast-icon.mjs`，**5/5 通过**）：
> - 旧白名单外的宿主图标（`heart`）→ `kind=host`，`<use href="...#icon-heart">` ✔
> - 插件自带图标 → `kind=asset`，CSS mask 指向 `/api/plugins/stm-pet/assets/...` ✔
> - 未知名字 → `kind=missing` + `console.warn`（不再静默）✔
> - 旧白名单内的名字行为不变 ✔
>
> 插件因此已把通知图标改成**自带的** `frontend/assets/icon.svg`（品牌化）。
> 旧宿主上会降级为 `missing`（图标位留空 + 一条 warn），**文案照常显示**。
>
> 下面保留当时的完整记录，作为「这类缺口怎么被发现与论证」的参考。

这条是插件作者审计出来的宿主设计问题，不是本插件的用法问题。
**证据可复现**：`python tools/check_toast_icons.py`（只读宿主源码，不修改）。

### 现状

`api.toast(msg, duration, icon)` 的第三个参数，在
`static/js/state.js:showToast` 里这样判定：

```js
const hasIcon = TOAST_ICON_NAMES.has(normalizedIconName);
this.toastIcon = hasIcon ? normalizedIconName : "";   // ← 不在白名单就置空
```

渲染处（`templates/layout.html:67`）硬拼前缀：

```html
<use :href="'{{ url_for('static', filename='icons/') }}' + toastIconHref"></use>
```

### 实测后果

| 输入 | 结果 | 说明 |
|---|---|---|
| `check` / `trash` / `close` …（16 个） | 接受 | 白名单内 |
| `heart`、`wand` … | **丢弃** | **是真实存在的宿主图标**，只是没进白名单 |
| `frontend/assets/icon.svg` | **丢弃** | 插件自带图标路径（含 `/`，永远不在 Set 里） |
| `/api/plugins/<id>/assets/.../icon.svg` | **丢弃** | 插件资产绝对 URL |

规模对比（实测）：**宿主图标库 192 个，toast 只接受 16 个 → 91.7% 被拒。**

而且被拒时**不报错、不警告**，只是图标位空着——插件作者要在
DevTools 里翻半天才能发现「名字其实没生效」。

### 为什么说这是缺口而不是策略

1. **它挡的是宿主自己的图标。** 一个会拒掉 `heart` / `wand` 的白名单，
   显然不是「精心挑选了适合通知的图标」，而是「历史上谁用过就加谁」的堆积。
2. **插件系统在别处是支持插件自带图标的，只有 toast 不一致。**
   `entries[].icon` 与 `api.ui.icon()` 都走 `utils/icons.js:resolveIcon()`，
   规则清晰且完备：
   - 不含 `/` 与 `.` → 宿主图标名 → `<use href="/static/icons/<sprite>#icon-<name>">`
   - 含 `/` → 插件资源路径 → `/api/plugins/<id>/assets/<path>`，用 **CSS mask** 渲染
   后端侧 `core/plugins/icons.py` 也做了同样的解析。**唯独 toast 没接这条通路。**
3. **根因是渲染分支缺失。** toast 的图标只有 `<use href>` 一条渲染路径，
   而插件 SVG 是填充式、宿主 sprite 是描边式——塞进 `<use>` 会渲染成**空图形**
   （宿主自己在 `static/js/uiPrimitives.js:54-56` 写了这条注释）。
   于是用白名单回避了「给插件图标加第二条渲染分支」这件事。
4. **白名单也不提供安全边界。** 前缀是模板里硬拼的，白名单并不参与路径校验；
   真正需要的是 `utils/icons.js:resolvePluginIcon()` 那种「校验 + 拼接」
   （它已经实现了拒绝绝对路径、拒绝 `..`、扩展名收在白名单内）。

### 建议（改动很小，且不破坏既有调用）

让 toast 图标复用 `resolveIcon()`，按 `kind` 分两条渲染分支即可：

```js
// showToast：删掉 TOAST_ICON_NAMES 判定，直接存原值
this.toastIcon = String(iconName || "").trim();
```

```html
<!-- layout.html：按 resolved.kind 分支 -->
<template x-if="toastIconResolved.kind === 'asset'">
  <span class="ui-icon ui-icon--asset"
        :style="'--ui-icon-mask: url(' + toastIconResolved.url + ')'"></span>
</template>
<template x-if="toastIconResolved.kind === 'host'">
  <svg class="ui-icon ui-icon--sm" viewBox="0 0 24 24">
    <use :href="toastIconResolved.href"></use>
  </svg>
</template>
```

**兼容性**：白名单里的 16 个名字都是宿主图标名，`resolveIcon()` 对它们
返回 `kind: 'host'` + 同样的 href，行为**逐字节一致**；因此可以直接删掉白名单。
（建议保留一个过渡期：不在白名单里但能解析出 href 的也放行，并在
未知名字时 `console.warn` 一次，把静默失效变成可见。）

### 插件侧当前的绕法

**（已随宿主修复而撤销）** 修复前只能用白名单里语义最贴近的 `check`
（本插件的 toast 只有「扫描完成 / 索引构建完成」），代价是通知无法品牌化。
修复后已改为插件自带图标 `frontend/assets/icon.svg`。

**影响面**：所有想在通知里用自己图标的插件。这不只是宠物插件的问题。

---

## 6. 【记录 · 非缺陷】`entries[].icon` 不能声明 `ambient`

提示词 §2.6 / §8 陷阱 6 已写明，这里作为**实测确认**记录：
manifest 里写 `"surface": {"type": "ambient"}` 会被丢弃 + warning
（后端 `SURFACE_TYPES` 只允许四种）。宠物插件的 ambient 只能通过
`api.surfaces.register(..., {type:'ambient'})` 注册，`entries[]` 只用来放设置入口。

本插件的 manifest 里**没有** ambient 类型的 entry，印证这条是对的。

---

## 5. 【已验证 · 无偏差】提示词中其余宿主事实

在 `1e19a5f` 上逐条复核，**与提示词一致**：

| 事实 | 结论 |
|---|---|
| `api_version` = 2（`core/version.py`） | 一致 |
| ambient 注册即挂载、无 open/close | 一致 |
| 容器 `position: fixed; inset: 0`、整体 `pointer-events: none` | 一致（实测 computed style） |
| `--z-ambient` = 55 | 一致 |
| 无 `role="dialog"` / 无 `aria-modal` / 不碰焦点 / 忽略 ESC | 一致（4 条独立用例） |
| 不参与 `has-fullscreen-scrim` 记账 | 一致 |
| 容器带 `data-marquee-ignore` | 一致 |
| `is-host-occluded` 随对话框开合 + 页面可见性切换 | 一致 |
| 移动端不挂载（`mount()` 不被调用） | 一致（挂载行为对，只是返回值语义不符，见 §1） |
| `plugin:unloaded` → 强制回收、DOM 干净、disposer 被调用 | 一致 |
| 资产白名单不含 `.jpg` / `.jpeg` | 一致（`core/plugins/assets.py`） |
| manifest 顶层键白名单、`permissions` 白名单 | 一致；本插件**不声明任何权限** |
| `config_schema` 只支持 `string/integer/number/boolean/enum` | 一致；形象列表因此自带 UI（§2.8 的建议做法） |
| 安装期 CSS 作用域静态检查 | 一致（实测 `style_scope_errors` 为空） |
| 宿主页面无 CSP；插件资产带严格 CSP + `sandbox` | 一致 |
| `data_dir()` 在插件更新时保留（用户数据优先） | 一致（阶段 5 会做重装回归验证） |

---

## 6. 【记录】宿主仓库零修改

本次实现**没有修改宿主仓库任何文件**。

真实浏览器验收通过**影子宿主**完成（`tools/host_sandbox.py`）：用 junction 复用
宿主的 `core/` `static/` `templates/`，但 `data/` 是独立目录，因此安装冒烟插件、
改插件启用状态都不会污染用户的 `ST-Manager/data/`。
核对方式：`git -C ST-Manager status --porcelain` 应为空。
