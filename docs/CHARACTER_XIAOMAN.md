# 默认形象设计：小满（xiaoman）

> 目标：为宠物插件做一个**随包内置**的默认形象，形象是「真人小女孩」。
> 本文是形象规格书 —— 画师或图像模型可以据此直接出图，出图后按 §6 打包即可。
>
> 相关：`resources/pets/default-cat/pet.json`（现有默认形象，猫）、
> `backend/core/pack.py`（包格式与上限）、`tools/make_builtin_pets.py`（内置形象的生成方式）。

---

## 1. 名字

**小满**（拼音 `Xiǎomǎn`，包 id `xiaoman`）

理由：

| 维度 | 说明 |
|---|---|
| 字面 | 二十四节气之一，「小得盈满」—— 麦子将熟未熟、**刚刚好**的状态 |
| 气质 | 不喧哗、不索取注意力。桌面宠物是**长期共处**的东西，名字不该是「糖糖」「闹闹」这类高唤醒词 |
| 读音 | 两个字、上声+上声，短促好念，中文语境里是真实存在的女孩名 |
| 与配色 | 小满对应麦熟，正好落在**栗色/麦金**的发色上（见 §4） |
| 与现有形象 | 现有默认小猫是橘色（`#F7A84C`）。小满的栗发是同一色系的低饱和版本 —— 换形象后视觉上仍是「同一个位置的同一个东西」 |

备选（如果想换）：**小禾**（麦苗，更幼态）、**穗穗**（麦穗，更软萌）。
本文按「小满」写，换名只需改 `pet.json` 的 `name`。

---

## 2. 一句话概念

> 一个七岁左右的小女孩，栗色短发，米白开衫配藏青背心裙，
> 头发上别着一枚**卡片形状的发夹** —— 像从 ST-Manager 的卡片堆里走出来的小管理员。

## 3. 与项目的关系（「结合当前项目」的落点）

不做成通用萌妹，而是让她的细节**只属于这个项目**：

- **卡片发夹**：左鬓一枚白色小发夹，形状就是一张竖着的卡片（带一道细横线当"标题"）。
  这是她的识别符号，也是全身上下唯一的"项目梗"，克制到不喧宾夺主。
- **配色取自卡片管理器本身**：米白（卡片底）+ 藏青（深色主题的窗口底色）。
  深色主题下她是暖色亮点，浅色主题下靠藏青裙压住，两边都不脏。
- **身份是"管理员"而非"宠物"**：动作里没有讨好式的卖萌，更多是「在忙自己的事」——
  张望（`look`）、打盹（`sleep`）、被拖起来时有点无奈（`drag`）。
  这比一只会作揖的宠物更耐看，也更符合工具型应用的陪伴定位。

---

## 4. 视觉描述

### 4.1 给画师 / 图像模型的完整描述

> 半写实风格的**游戏插画**，不是照片写实。约五头身（儿童比例，头略大），
> 柔和的赛璐璐上色（3–4 阶平涂），深栗色清晰描边，剪影干净、无碎发飘丝。
>
> **头部**：栗棕色（`#6B4A2F`）齐下巴短发（bob），发尾微微外翻；
> 头顶有一小撮向上翘的呆毛（ahoge）。发丝用**整块色块**概括，不要画成一根根。
> 大而明亮的琥珀棕眼睛（`#8C5A2B`），眼白清晰、有明确的白色高光点——
> **高光是这个尺寸下唯一能读出"有神"的手段**。脸颊淡红晕，皮肤暖白（`#F6DCC8`）。
>
> **服装**：米白罗纹针织开衫（`#F2E8D8`）罩在藏青背心裙（`#2E3A5C`）外面，
> 浅米色短袜，棕色小皮鞋。服装结构要**简单**：不要蕾丝、蝴蝶结、多层褶边，
> 那些在 64–128px 下只会变成噪点。
>
> **配饰**：左鬓一枚白色卡片形状小发夹（`#FFFFFF`，带一道细横线）。
>
> **禁止**：照片写实、皮肤毛孔/次表面散射、复杂织物纹理、飘逸长发、
> 渐变背景、投影、任何文字。

### 4.2 为什么是「半写实」而不是「真人写实」

这是本项目最硬的一条约束，必须说清：

内置形象的**逻辑尺寸**由 `pet.json` 的 `size` 决定，现有默认是 **64×64**。
在 64px 见方里画一个真人：

- 整张脸只有约 20px，五官合计不到 10px；
- 写实的皮肤过渡、发丝、布料纹理**全部退化成脏点**；
- 结果是远看一团肉色，近看一坨噪点 —— 比抽象的小猫更难看。

所以「真人小女孩」的正确落地方式是：**真人比例 + 插画化概括**。
真人感来自**比例和神态**（五头身、眼神、姿态），而不是来自纹理精度。

推荐尺寸：`size` 用 **128×128**（比猫大一倍，给脸留出可读像素），
素材按 **2× 出图（256×256/帧）** 再降采样，兼顾 HiDPI 与清晰度。

---

## 5. 配色表

| 用途 | 色值 | 说明 |
|---|---|---|
| 主发色 | `#6B4A2F` | 栗棕，麦熟感 |
| 发暗部 | `#4E3421` | 只用于描边与发尾收束 |
| 瞳色 | `#8C5A2B` | 琥珀棕 |
| 皮肤 | `#F6DCC8` | 暖白 |
| 腮红 | `#E8A0A0` | 淡，面积要小 |
| 开衫 | `#F2E8D8` | 米白（卡片底） |
| 背心裙 | `#2E3A5C` | 藏青（深色主题窗口） |
| 袜 | `#EFE6D6` | 浅米 |
| 鞋 | `#5A3A24` | 棕 |
| 描边 | `#3A2A20` | 深栗，**不要纯黑**（纯黑在深色主题下像挖空） |
| 强调色 | `#E08A3C` | 暖橙，只用于卡片发夹的横线或小面积点缀 |

---

## 6. 动作规格（11 个）

对齐 `backend/core/pack.py` 的动作词表。**必需**动作缺失不报错、会沿回退链退化，
但内置形象应该**全部给全**（否则用户会看到「缺少必要动作」的警告）。

| 动作 | 标签 | 帧数 | fps | loop | 表演要点 |
|---|---|---|---|---|---|
| `idle` | 待机 | 6 | 6 | ✅ | 呼吸起伏 + 一次眨眼。幅度极小，**这是出现时间最长的动作**，花最多功夫 |
| `walk` | 行走 | 8 | 10 | ✅ | 小幅快走，手臂自然摆；裙摆微微动 |
| `drag` | 被拖动 | 2 | 4 | ✅ | 双脚离地、手向上、表情略无奈（不是惊恐） |
| `fall` | 下落 | 2 | 8 | ✅ | 身体前倾、头发向上飘 |
| `land` | 落地 | 3 | 12 | ❌ 单次 | 屈膝缓冲 → 站直；第 1 帧轻微压扁 |
| `sleep` | 睡觉 | 4 | 3 | ✅ | 抱膝坐或侧躺，眼睛闭合，飘 2–3 个「Z」 |
| `click` | 被点击 | 4 | 12 | ❌ 单次 | 轻微一跳 + 回头，带一点被打扰的反应 |
| `happy` | 开心 | 6 | 8 | ❌ 单次 | 弯眼笑，小幅原地跳 |
| `sad` | 难过 | 4 | 5 | ✅ | 垂眼、眉毛下压、肩膀下沉 |
| `angry` | 生气 | 4 | 8 | ✅ | 鼓腮、眉压低；**要可爱不要凶** |
| `look` | 张望 | 6 | 6 | ✅ | 左右转头找东西，像在找某张卡片 |

上限提醒（`pack.py`）：单动作 ≤ **256 帧**、`fps` ≤ **60**、
单帧边长 1–512px、sheet 尺寸 ≤ 4096px。上表远在安全区内。

---

## 7. `pet.json` 骨架

```json
{
  "format": 1,
  "id": "xiaoman",
  "name": "小满",
  "author": "ST-Manager",
  "size": { "w": 128, "h": 128 },
  "anchor": { "x": 0.5, "y": 1.0 },
  "physics": {
    "gravity": 1800,
    "walkSpeed": 70,
    "friction": 0.02,
    "terminalVelocity": 2400,
    "bounce": 0.12
  },
  "animations": {
    "idle":  { "sheet": "idle.png",  "frames": 6, "fps": 6,  "loop": true  },
    "walk":  { "sheet": "walk.png",  "frames": 8, "fps": 10, "loop": true  },
    "drag":  { "sheet": "drag.png",  "frames": 2, "fps": 4,  "loop": true  },
    "fall":  { "sheet": "fall.png",  "frames": 2, "fps": 8,  "loop": true  },
    "land":  { "sheet": "land.png",  "frames": 3, "fps": 12, "loop": false },
    "sleep": { "sheet": "sleep.png", "frames": 4, "fps": 3,  "loop": true  },
    "click": { "sheet": "click.png", "frames": 4, "fps": 12, "loop": false },
    "happy": { "sheet": "happy.png", "frames": 6, "fps": 8,  "loop": false },
    "sad":   { "sheet": "sad.png",   "frames": 4, "fps": 5,  "loop": true  },
    "angry": { "sheet": "angry.png", "frames": 4, "fps": 8,  "loop": true  },
    "look":  { "sheet": "look.png",  "frames": 6, "fps": 6,  "loop": true  }
  }
}
```

与小猫的差异及理由：

- `size` 128（猫是 64）：人形需要更多像素承载脸部，见 §4.2。
- `walkSpeed` 70（猫是 60）：人走路比猫踱步略快，且 128px 身高的位移看起来更慢，
  略提速度避免「飘着走」。
- `bounce` 0.12（猫是 0.15）：人落地比猫「实」，回弹要更小。
- `anchor.y = 1.0`：脚底对齐容器底边 —— 人形必须站住，不能悬空。

---

## 8. 出图与打包

### 8.1 生成素材

内置形象走 `tools/make_builtin_pets.py` 那条路（Pillow 程序化绘制）**不适合人形** ——
画一个可信的小女孩不是几十行 `draw.ellipse` 能办到的。
人形应该**用图像模型出图 + 人工/脚本切帧**，产物提交进仓库。

出图 prompt（每位姿一张，保持同一角色）：

> Character sheet, semi-realistic stylized game illustration, 2× supersampled.
> A wholesome 7-year-old girl, chestnut-brown chin-length bob with a small upward
> ahoge and slightly flipped-out ends, large warm amber-brown eyes with clear white
> highlight dots, rosy cheeks, warm white skin. Cream ribbed knit cardigan over a
> navy blue pinafore dress, light cream socks, small brown leather shoes. A tiny
> white card-shaped hair clip on her left temple. Soft cel shading in 3–4 flat tone
> steps, crisp dark-brown outlines, clean readable silhouette, flat fills, no
> gradients, no photorealism, no text, plain off-white background.
> Pose: **&lt;此处替换为 §6 的表演要点&gt;**

同一角色跨动作的一致性靠**同一段角色描述逐字复用**来保证；
若模型支持参考图，先用 §4.1 出一张定妆图，后续全部以它为参考。

### 8.2 打包

```bash
# 1) 目录
resources/pets/xiaoman/
    pet.json
    idle.png walk.png drag.png fall.png land.png
    sleep.png click.png happy.png sad.png angry.png look.png

# 2) 校验（形状、帧数、白名单、上限）
python -c "from backend.core.pack import load_pack; print(load_pack('resources/pets/xiaoman'))"

# 3) 跑测试
python -m pytest tests/ -q
```

### 8.3 两条硬性注意

1. **不要放 `.jpg`**。运行期 sheet 白名单是
   `{.png .webp .gif .avif .svg}`，JPEG 只在**导入期**被转码放行；
   落盘的包里有 JPEG 会被拒（`pack.py:ALLOWED_SHEET_EXTENSIONS`）。
2. **单帧必须等宽**，横向 sheet 的总宽 = 帧数 × 单帧宽。
   帧宽不一致会让 `background-position` 推进错位（表现为动作抖动/串帧）。

---

## 9. 已知约束（需要留意，但不是阻塞）

**`image-rendering: pixelated` 目前是恒开的。**

`frontend/plugin.css:81` 写了：

```css
[data-plugin="stm-pet"][data-pet-pixelated="false"] .pet-sprite { image-rendering: auto; }
```

但这个 `data-pet-pixelated` 属性**前端 JS 从未设置**，`pack.py` 也没有对应字段 ——
所以这条规则永远不生效，贴图始终按「硬边放大」渲染。

对小满的影响：**1× 显示（scale=1）没问题**（256 源 → 128 CSS px 是降采样）；
但用户把「宠物大小倍率」调到 2× 以上时，写实插画会出现明显块状边缘，
观感不如平滑插值。

三种处理，按代价从低到高：

- **不处理**：默认 scale=1，多数用户不会调。可接受。
- **降规格**：源图按 1× 出（128×128/帧），彻底回避放大场景。
- **修契约**（推荐，但属于插件改动）：在 `pet.json` 增加 `pixelated` 布尔字段
  （`pack.py` 解析 → `petview.js` 写 `dataset.petPixelated`），
  让写实形象自动拿到 `image-rendering: auto`。
  CSS 那条规则已经是现成的，只差把值接上。

---

## 10. 待办

- [ ] 出定妆图（§4.1），确认角色一致性
- [ ] 按 §6 出 11 个动作的 spritesheet
- [ ] 写 `resources/pets/xiaoman/pet.json`（§7 骨架）
- [ ] 决定 `pixelated` 契约是否要修（§9）
- [ ] 决定小满是否取代 `default-cat` 成为默认形象，或作为并列的内置形象
      （`store.py` 的内置形象扫描支持多个，并列不需要删猫）
