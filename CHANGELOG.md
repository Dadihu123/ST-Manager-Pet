# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-11

首个版本。实现实施提示词 `2026-10-11-pet-plugin-implementation-prompt.md` 的全部阶段。

### 新增

**宠物本体**

- `ambient` surface 常驻桌面：**不自绘 `position: fixed` 浮层**，
  容器由宿主的 `ambient` surface 提供，宠物在容器内用 `position: absolute`
  + `transform: translate3d()` 定位。
- spritesheet 帧动画（`background-position` 推进，不换 `<img src>`）。
- 固定步长物理（1/120s + 累加器）：重力、终速、摩擦、反弹、边界钳制。
- 拖拽（`setPointerCapture` + 跟手 + 甩出初速度），任何状态都能被拖拽打断。
- 状态机：`idle ⇄ walk`、`idle → drag → fall → land → idle`、
  `idle → sleep → idle`、任意 → 播报态。非法迁移被拒绝并记录。
- 自动漫游（空闲时自己溜达）与打盹（长时间无互动睡着，任意输入唤醒）。

**宠物包格式与形象管理**

- `pet.json` 包格式 + **动作回退链**：任何一张单帧图都能跑起来，
  缺失动作沿链下溯最终落到 `idle`；唯一硬错误是「连 `idle` 都没有」，
  且错误信息会说明包里有哪些动作。
- 两层覆盖：用户覆盖 > 用户包内 > 随包内置。内置形象永远只读。
- 导入/导出 zip；按 magic bytes 判真实格式；JPEG 自动转 PNG
  并同步改写 `pet.json` 的 `sheet` 指向。
- 自带形象管理 UI（`settings` 入口 + `modal` surface）：列表、预览、
  逐动作换图、恢复原图、设为当前、删除、导入导出。
- 随包默认形象「默认小猫」（9 个动作，由 `tools/make_builtin_pets.py` 生成）。
- 插件图标（`frontend/assets/icon.svg`）：裁剪过 viewBox 的单色剪影，
  用在设置入口、面板标题与插件总览三处。

### 交互

- **拖动**：按住宠物拖走（`setPointerCapture`），松手带甩出速度下坠、落地回弹减速。
- **点击**：位移很小算点击，宠物会跳一下（有 `click` 动作时播它）。
- **右键宠物**：打开设置面板。
- **自动漫游**：空闲时自己走到随机位置，朝向跟着翻转。
- **打盹**：长时间无互动睡着；任何输入或核心事件都会唤醒。
- **设置入口**：「设置 → 插件 → 桌面宠物设置」，管理形象、逐动作换图、导入导出。
- **右侧坞入口**：坞里的宠物图标（与 AI 助手并排），点击打开设置面板。

**事件与宿主联动**

- 订阅核心事件（`api.on()` SSE 通路）：卡片类事件 → `happy`/`sad`，
  `scan.completed` / `index.job_done` → 播报。
- **前导 + 尾随限流**：批量操作的高频 `card.updated` 不会让宠物疯狂抽搐，
  但批量结束时会补播一次。
- 消费 `api.host.onState()` 驱动省电表，并消费宿主的
  `is-host-occluded` 状态类作为 CSS 兜底。

**性能与省电**

- 一个 rAF 循环驱动一切，并且**会自己停**：页面不可见 / `reducedMotion`
  时停绘，宿主忙 / 遮罩 / 窄屏时降频。
- `reducedMotion` 语义是**停**（只显示一帧静息图），不是降速。
- `will-change` 只在运动期间加；单帧形象 + 物理静止时 rAF 真的停掉。

**导入安全**

- 路径穿越（含 zip slip）、解码炸弹、伪造扩展名、体积超限、zip 炸弹、
  符号链接逃逸全部拦截，返回结构化错误且**不暴露堆栈**。

### 测试

- `pytest`：296 项（包格式与回退链、导入安全、路径安全、形象存储、
  后端路由契约、CSS/JS 静态契约、宿主 API 用法核对）。
- `node --test`：95 项前端纯逻辑测试（帧推进不漂移、物理与帧率无关、
  边界钳制、状态机迁移、限流、省电决策），用**注入的确定性时钟**，
  不用 `sleep` 后断言。
- 真实浏览器验收：`tools/verify-pet.mjs` 19 项 + `tools/verify-upload.mjs` 15 项，
  在真实 Chrome 里驱动影子宿主（独立 `data/`，不污染用户数据）。

### 与实施提示词的偏差

以**宿主实际代码**为准，详见 `docs/HOST_FEEDBACK.md`：

1. `surfaces.register()` 在移动端**不返回空串**（提示词 §2.1 的说法与实测不符）——
   改为用 `api.surfaces.isOpen()` 判定是否真的挂载。
2. 宿主的 ambient shell **只有 `data-plugin` 属性、没有 `plugin-<id>` 类**，
   因此样式作用域**必须**用 `[data-plugin="stm-pet"]`；
   只写 `.plugin-stm-pet ...` 会整份样式静默失效（症状与「漏写 pointer-events」
   一模一样，极难排查）。
3. 宿主没有 `api.log`（真实签名是 `api.host.log(message, level)`，参数顺序相反）——
   加了一层适配器，并补了静态测试防止复发。
4. `physics.friction` 取 `0.02` 而不是示例里的 `0.85`（理由见 README §3.3）。
5. 帧图路由的缓存策略按调用方是否带 `?v=` 区分：带则长缓存，不带则回源校验
   （否则会出现「换了图却一直看到旧图」）。
6. 插件图标**必须裁剪 viewBox**：宿主用 `mask ... / contain` 渲染
   （`static/css/modules/icons.css:42`），按 SVG 自身比例缩放；
   原稿画布 1792×2400 而内容只占中间一块，不裁剪在 16px 下几乎不可辨。
   已用 `tools/crop_icon.py` 裁剪并加测试锁定。
7. 形象卡片缩略图**只显示 spritesheet 的第 0 帧**：
   `/frame/<id>/idle` 返回整条 256×64 的 4 帧图，
   用 `background-size: contain` 塞进 40px 方框会让每帧只剩 10px、
   看起来像裂图。改为 `background-size: (方框宽 × 帧数) auto` + 左对齐。

### 已上报并修复的宿主问题

审计中发现 `api.toast` 的图标位只接受 **16 个写死的宿主图标名**，
插件自带图标会被**静默丢弃**（宿主自己的 192 个图标也有 176 个用不了）。
写成修复提示词交给主程序仓库后已修复（`ST-Manager@715d0a8`）。
本插件据此把通知图标换成自带的 `frontend/assets/icon.svg`，通知实现品牌化。

- 完整论证与修复方案：`docs/HOST_TOAST_ICON_FIX_PROMPT.md`
- 当时的实证数据：`tools/check_toast_icons.py`
- 修复后的验收（5/5）：`tools/verify-toast-icon.mjs`
- 宿主侧记录：`docs/HOST_FEEDBACK.md` 第 5 条
