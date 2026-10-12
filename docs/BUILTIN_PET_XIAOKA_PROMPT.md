# 新建官方内置形象：小卡（xiaoka）出图提示词

> 目标：给宠物插件再做一个**随包内置**的官方形象 —— 写实真人风格的小女孩。
> 本文是可直接投喂图像模型的提示词规格书；出图后按 §7 切帧、按 §8 打包。
>
> 相关：`docs/CHARACTER_XIAOMAN.md`（另一个内置形象小满的规格书）、
> `backend/core/pack.py`（包格式与上限）、`tools/preview_builtin_pet.py`（对照图工具）。

---

## 1. 形象定位

**小卡**（`id: xiaoka`）—— 六到七岁的小女孩，围裙口袋里插着一张索引卡，
腰侧挂着一枚木质的卡片吊牌。她是「卡片堆里的小管理员」。

与已有形象的分工（插件只有这两个内置形象）：

| 形象 | 风格 | 作用 |
|---|---|---|
| `xiaoman` | 半写实插画（非照片） | **首次安装的默认形象**（`store.DEFAULT_PET_ID`） |
| **`xiaoka`** | **写实真人**（照片级） | 想要「桌面上真的站着一个人」的那部分用户 |

> 早先还有一个 `default-cat`（64×64 程序化像素橘猫）作为兜底形象，
> 2026-10 已随生成脚本一起移除：真正需要兜底时单帧 `idle` 就够了
> （回退链保证任何一张图都能跑起来），而像素猫与两个真人形象摆在一起只是噪音。

`xiaoka` 与 `xiaoman` 的关键差别是**渲染目标**：小满刻意避开照片写实
（见小满文档 §4.2），小卡则**要**照片写实 —— 皮肤有毛孔、布料有经纬、
头发有散丝。这也决定了参数不同：`pixelated: false` 是硬要求（放大时平滑插值）。

### 1.1 设计要点（为什么是这几个元素）

| 元素 | 取值 | 理由 |
|---|---|---|
| 年龄 | 6–7 岁 | 再小读不出「懂事」，再大就不是陪伴感而是陌生人感 |
| 发型 | 深栗黑、及肩、低双马尾 + 米白棉绳 | 双马尾在 173px 观感宽度下**仍能读出剪影轮廓**；纯披发会糊成一团 |
| 上衣 | 燕麦米白短袖棉 T | 浅色上半身 = 深色主题下头部周围不会消失 |
| 围裙 | 深咖啡棕帆布半身围裙 | 主体色块，把「她是来干活的」写进剪影；同时压住下半身 |
| 卡片道具 | 胸袋插一张米白索引卡（露出一截）+ 腰侧木牌吊坠（一道刻线） | **项目梗的落点**：卡片管理器。放在腰侧而不是手上，避免逐帧生成时道具漂移 |
| 袜子/鞋 | 浅灰短袜 + 深棕乐福鞋 | 与围裙同色系，脚部在浅色地面上仍有轮廓 |

**禁止**：任何文字/字母（模型写不对且会显得廉价）、手持物（逐帧一致性会崩）、
蕾丝/蝴蝶结/多层褶边（173px 下全是噪点）、眼镜（遮挡唯一的表情载体）。

---

## 2. 通用出图提示词（英文，直接投喂）

### 2.1 角色锁定段（**每个动作逐字复用**）

跨动作一致性不靠模型记忆，靠这段文字**一个字都不改**地重复。改一个字，
脸型就会漂。若模型支持参考图，先用 §2.2 出定妆图，之后所有动作都以它做 i2i 参考。

```
Photorealistic full-body photograph of a wholesome real 6-7 year old East Asian girl
with warm light skin and soft natural photographic texture (fine pores, gentle subsurface
warmth on the nose tip and ear rims, faint rosy cheeks, subtle lip colour). Deep
chestnut-black hair, chin-to-shoulder length with soft natural waves and a few fine
flyaway strands, low twin pigtails tied with cream cotton cord on each side, wispy
natural bangs. Large bright dark-brown eyes with natural eyelashes, calm friendly
expression with a small closed-mouth smile. She wears an oatmeal-cream cotton
short-sleeve tee and a deep espresso-brown canvas work apron over it; the apron has
one chest pocket holding a small ivory index card whose top edge sticks out, and a
small pale-wood card-shaped tag engraved with a single horizontal line hangs from a
short cord at the right side of the apron waistband. Light grey ankle socks, dark
brown leather loafers.
```

### 2.2 定妆图（baseline，**已确认**）

在角色锁定段后面接：

```
Pose: standing upright facing the camera, arms relaxed at her sides slightly away from
the body, feet together, weight even — a calm idle stance.
Composition: full body from head to shoes, centred horizontally; the top of her hair
sits about 10% down from the top edge of the picture and the soles of her shoes about
93% down, leaving clear empty space above and below; nothing cropped.
Lighting: soft window light from camera left, warm gentle tones, no harsh shadows,
clean readable silhouette.
```

### 2.3 透明背景段（**每个动作都要带**）

模型能出真透明 PNG，但**必须把话说到位**。实测漏掉任何一句都会出问题：

```
Background: genuine transparency — a PNG with a real alpha channel. Everything around
her is exactly alpha 0; her body, hair, clothing and shoes are fully opaque at alpha
255. No backdrop, no floor, no ground plane, no drop shadow, no contact shadow, no cast
shadow, no reflection, no grey halo or fringe around the outline, no checkerboard
pattern, no white box, no border, no frame, no text, no watermark, no other people.
Vertical 2:3 portrait composition.
```

> **实测结论**：即使这样写，模型输出的 alpha **最高只到 254、内部还有大片半透明**，
> 且周围会留 1000+ 个 alpha 1–59 的淡雾点。所以透明是「生成 + 程序化清理」两件事，
> 清理管线见 §7.2，**不要**靠肉眼看预览图判断（预览会合成到白底，看起来永远像白背景）。

### 2.4 动作段（替换 §2.2 的 Pose 行，其余照抄）

| 动作 | Pose 行 |
|---|---|
| `idle` | `standing upright facing the camera, arms relaxed at her sides, feet together, weight even, calm idle stance` |
| `walk-right` | `full side view, turned to face the RIGHT side of the picture, seen in profile, mid-step — the leg on the LEFT side of the picture is planted flat on the ground and the leg on the RIGHT side of the picture is lifted and swinging forward, arms swinging naturally in the opposite direction, torso upright, head level looking ahead` |
| `walk-left` | 同 `walk-right`，把 LEFT / RIGHT 互换 |

> `walk-left` / `walk-right` 的完整版提示词见 **§2.5.6**（含摆臂交替与反顺拐的硬约束）。
> 下表这一行只是**简版**；行走帧必须用 §2.5.6 的模板，否则会踩 §2.5.1 的相位塌陷。

| `drag` | `being lifted off the ground by the collar of her apron, both feet dangling and clearly off the ground, arms hanging down, body slightly swaying, mildly resigned expression (not frightened), head tilted a little` |
| `fall` | `falling through the air, body tilted slightly forward, both legs trailing behind and bent, arms raised outward, hair lifted upward by the air, eyes wide` |
| `land` | `just landed, knees deeply bent in a crouch to absorb the impact, arms out for balance, apron hem flaring slightly outward, torso leaning forward` |
| `sleep` | `sitting on the ground with knees drawn up and arms wrapped around them, head resting on her knees, eyes closed, relaxed sleeping face` |
| `click` | `startled mid-turn, small hop with both feet barely off the ground, upper body twisted to look back over her shoulder, eyes wide, mouth slightly open` |
| `happy` | `smiling widely with eyes curved into happy crescents, small hop with both feet just off the ground, arms lifted a little, shoulders up` |
| `sad` | `standing with shoulders slumped and head lowered, eyebrows angled up in the middle, eyes downcast and slightly teary, arms hanging limply` |
| `angry` | `standing with both cheeks puffed out and eyebrows pressed down, small frown, fists clenched at her sides, feet planted apart — cute rather than frightening` |
| `look` | `standing still, upper body and head turned to look toward the side of the picture, one hand raised to shade her eyes, curious searching expression` |

**侧视图的两个坑（实测）**：

1. 朝向必须用**画面空间**描述（"the leg on the RIGHT side of the picture is planted"），
   写成「她的右腿」模型会固定抬同一条腿，做不出交替步态。
2. 侧视图容易把**服装配色画漂**（深棕变灰紫、米白变金黄）。提示词里要重申
   `Keep the apron the same deep espresso brown, the tee the same oatmeal cream,
   and the cord ties the same cream as in the reference; do not shift the colours
   toward grey-purple or gold.`

**为什么不逐帧生成**：一帧一张图、每张都以 §2.2 定妆图做 i2i 参考。
让模型一次画「多帧 sprite sheet」会让角色在格与格之间漂移，动画会闪。

---

### 2.5 行走循环：摆臂交替与「顺拐」（**本节是实测结论，不是设计意图**）

需求：同向的几帧里，**不能每帧都是同一条胳膊在前**；手臂要与腿反向摆动，**不能顺拐**。

这一条**不能靠提示词实现**。下面全是量出来的，不是推测。

#### 2.5.1 实测：模型换不来相位交替

「接触帧」（前脚落地那一刻）是行走循环里唯一能读出相位的姿势。
一个完整循环需要**两个互为反相的接触帧**（contact-A 与 contact-B）。
让模型画 contact-B（提示词里明确写了「近侧那条腿必须在身后，这是通常接触姿势的反面」），
结果如下 —— 用剪影 IoU 衡量（IoU 越接近 1 越像同一张图）：

| 尝试 | 与 contact-A 的 IoU | 判定 |
|---|---|---|
| i2i 参考图 + 「近侧腿在后」 | **0.8753** | 几乎复刻同一姿势 |
| 纯文生图（不带参考图）+ 同一描述 | **0.8180** | 仍然复刻 |
| i2i + 逐条列出「哪条腿在前」 | **0.8554** | 仍然复刻 |
| i2i + **把四条肢体逐一钉死**（含手臂前后） | **0.8303** | 仍然复刻（见 §2.5.4.2） |
| 3/4 视角 + 「左右腿互换」 | 0.7493 | 勉强不同，但相位仍不对 |
| **换描述维度**：按身体高度状态（§2.5.3） | **0.4370–0.4867** | ✅ 真正的不同姿势 |

**结论**：模型有一个极强的「标准行走姿势」先验 —— **近侧手在前、近侧腿在前**。
无论怎么描述相反相位（i2i、纯文生图、逐肢钉死、换视角），它都会回到那个先验上。
**i2i 参考图会让情况更糟** —— 参考图本身携带了姿势信息。
唯一有效的是**换一个描述维度**（不再谈左右，改谈身体高低）。

#### 2.5.2 实测：镜像也换不来相位

一个自然的想法是「把 contact-A 水平镜像，就得到 contact-B」。**这是错的。**

镜像是一个**刚体变换**：它翻转朝向，但**不改变步态相位**。
量出来的证据（`measure_limbs.py`，手臂带的皮肤块位置）：

| 帧 | 手 A x | 手 B x |
|---|---|---|
| `walk-0`（朝左走） | 96.5 | 270.9 |
| `walk-2` = mirror(`walk-0`) | 286.5 | 112.1 |

`384 − 96.5 = 287.5 ≈ 286.5`、`384 − 270.9 = 113.1 ≈ 112.1` ——
walk-2 是 walk-0 的**精确镜像**。walk-0 里「在后的那只手」镜像后仍然在**新的后方**。

> 换句话说：镜像得到的是「朝右走、相位不变」，**不是**「朝左走、相位相反」。
>
> 这条对插件是**好消息**：`walk-right = mirror(walk-left)` 恰好就是正确的配对
> （同相位、反方向），也正好是插件 `mirror` 回退标记的语义
> （`backend/core/pack.py:WALK_DIRECTION_ACTIONS`）。
> 但它**不能**用来在同一个方向内制造摆臂交替。

#### 2.5.3 有效的做法：按「身体高度状态」描述，而不是按「哪条腿在前」

上表里唯一明显不同的是 3/4 视角那一组（IoU 0.749），说明**改变提问的维度**才有用。
真正有效的是改用**垂直方向的身体状态**描述 —— 模型对「身体高低、脚跟离地」
这类描述的服从度，远高于对「左腿还是右腿在前」的服从度。

实测两组「按垂直状态描述」的帧，与 contact-A 的差异都很大：

| 帧 | 描述维度 | 与 contact-A 的 IoU | 两帧之间 |
|---|---|---|---|
| `lowest-point` | 重心最低、微屈膝、后脚刚要离地 | 0.4867 | 0.3589 |
| `push-off` | 重心最高、踮脚、另一腿抬起前摆 | 0.4370 | （同上） |

IoU 0.36–0.49 说明这是**真正不同的姿势**，不是同一张图的重画。
所以行走循环的四个关键帧应该按**身体状态**定义（§2.5.4），而不是按左右腿定义。

#### 2.5.4 四个关键帧（按垂直状态定义）

| # | 关键帧 | 可辨识的身体状态（模型能听懂的部分） |
|---|---|---|
| 1 | `contact` | 前脚跟刚触地、脚尖翘起；后脚只有脚尖着地；身体中等高度 |
| 2 | `down` | 重心**最低**、双膝微屈、承重脚全脚掌着地；后脚趾刚离地 |
| 3 | `passing` | 双腿并拢交叉、脚几乎在同一位置；身体**最高**；手臂垂在髋侧 |
| 4 | `push-off` | 踮起后脚、脚跟**抬得很高**；另一腿屈膝抬起前摆；身体伸展 |

**摆臂怎么落位**：不要单独描述手臂的前后，而是**绑在腿上**描述 ——
`contact` 时手臂摆幅最大（与腿反相），`passing` 时手臂近乎垂直。
腿的位置一旦正确，手臂跟着反相，`passing` 自然回到中位。

#### 2.5.4.1 这四个关键帧的实测摆臂数据

用 `measure_limbs.py --band arms` 量出的手部皮肤块（`area` 在 300–400 的是胸袋那张索引卡，
不是手；按面积和 y 坐标可以分开）：

| 帧 | 检出的手（x 中心） | 手间距 | 占内容宽 | 判定 |
|---|---|---|---|---|
| `contact` | 96.5 / 270.9 | 174px | **56%** | ✅ 摆幅大，两只手都清楚 |
| `passing` | 107.3 / 249.5 | 142px | **56%** | ✅ 摆幅仍大（这一帧理应回中位，见下） |
| `push-off` | 108.9 / 321.2 | 212px | **63%** | ✅ 摆幅最大，一只手抬到脸侧 |
| `down` | **只检出 1 只**（241.0） | — | — | ❌ 另一只手被围裙完全挡住 |

**两条实测教训**：

1. **`down` 这一帧的摆臂读不出来**：重心压低时手臂贴着身体，远侧的手被围裙挡住，
   手臂带里只剩一个手部块。**摆臂信息只在手臂离体时存在** —— 所以提示词里
   「`Both arms held clear of the apron so the gap between arm and body is visible`」
   这一句不是修辞，是**功能性要求**，缺了它这一帧就白出。
2. **`passing` 的摆幅没有回中位**（56%，与 `contact` 相同）。模型把「手臂垂在髋侧」
   理解成了「手臂依然分开」，没有做出真实的经过姿势。**这是可接受的**：
   经过帧摆幅大只会让摆臂看起来更活跃，不会产生顺拐。

> **不要用 `content_top` 跨帧比较身体高度**：每帧是独立生成的，取景与缩放会漂移。
> 实测四帧的 `content_top` 为 passing 8 / contact 26 / push-off 30 / down 45，
> 顺序既不符合步态理论也不稳定 —— 这个量只在**同一帧内**（例如头部 vs 脚底）有意义。
> 垂直节奏要靠**帧内相对关系**读（膝盖弯曲度、脚跟离地高度），不能靠跨帧的绝对 y。

#### 2.5.4.2 一个尚未解决的缺口：跨帧的相位连续性

上面四条只能保证**单帧内部**手臂与腿反相（`each arm swings opposite to the leg on the
SAME side`）。但每帧是**独立生成**的，所以**无法保证帧与帧之间手臂真的左右交替** ——
完全可能四帧都恰好是「近侧手在前」。

实测现状：`contact` 的近侧手 x=96.5（在**前**），`push-off` 的近侧手 x=108.9（也在**前**）。
**两帧的近侧手都在前面**，也就是说这四帧拼成循环后，摆臂并不交替。

**并且：显式指定相位同样无效。** 又试了一次，在提示词里把四条肢体逐一钉死
（`near arm BACKWARD, near leg FORWARD, far arm FORWARD, far leg BACKWARD`），
结果与 `contact-A` 的剪影 IoU = **0.8303**，近侧手 x = **87.2**（仍在前面）。
见 `walk-lab/strip-phase-swap-arms.png` —— 两帧的手臂配置肉眼可见地一致。

> **定论**：这个模型在侧视行走上有一个极强的姿势先验（近侧手在前、近侧腿在前），
> **提示词无法覆盖它**。无论 i2i、纯文生图、逐肢钉死、换视角，都换不来相位交替。
> 交替必须**由构造保证**，而目前构造不出来 —— 只能接受或退让。

这是本轮**没有解决**的问题，如实记在这里。可选的收尾办法：

1. **接受它**（推荐）：四帧的身体姿态确实各不相同（IoU 0.36–0.49），行走的「动感」成立；
   摆臂不交替在 173×259 下几乎不可见 —— 手只有约 8px 宽，
   而 `walk-left` 整张贴图按 `scale 0.45` 显示后，手的横向位移差约 30px×0.45 ≈ **13px**。
   它读起来是「手臂轻微同步摆」，不是「明显顺拐」。
2. **只出 2 帧**（`contact` + `passing`），彻底回避跨帧相位问题（§2.5.7）。
3. **手工重绘**其中一帧的前后肢（改遮挡关系与手臂位置），成本最高但唯一能拿到真交替。

> **注意「顺拐」这个词的严格含义**：本轮四帧**都没有顺拐** —— 每一帧内部手臂与腿都是
> 反相的（提示词里那句 `each arm swings opposite to the leg on the SAME side` 起作用了）。
> 缺的是**帧间交替**。这是两件不同的事，不要混为一谈：
> 顺拐 = 单帧内同侧手脚同向（已避免）；不交替 = 跨帧始终同一侧在前（未解决）。

> 另外：本轮 4 个「按垂直状态描述」的提示词里有 **2 个被上游内容政策拦截**
> （400 `upstream_text_reply`），措辞涉及「双腿交叉」「踮脚抬起、腾空」的那两条；
> 用 `scissored`、`airborne-feeling` 这类词会被拦。改成中性的
> 「重心最低 / 双腿并拢」后就通过了。**纯文生图比 i2i 更容易被拦** ——
> 同一段措辞走 i2i（带参考图）可以通过。

#### 2.5.5 顺拐为什么**不能**靠程序自动判定（重要）

在**纯侧视**里，正确行走时「向前的手」和「向前的脚」本来就在**同一个视觉侧**
（都朝画面左）。所以从剪影几何**分不出**对错 —— 顺拐与否取决于**遮挡关系**
（哪条手臂画在身体前面），而那是像素级的绘制顺序，不是位置。

因此验收分两层：

| 层次 | 手段 | 判据 |
|---|---|---|
| **可自动判定** | `measure_limbs.py` | ① 手臂带里检出**两个**手部皮肤块，横向间距 ≥ 内容宽度的 15%；② 腿带里检出两条腿且明显分开；③ 相邻帧剪影 IoU **< 0.8**（`compare_frames.py`），否则说明相位塌陷成了同一张图 |
| **必须肉眼** | `contact-sheet.png` / `strip-arms.png` | 在对照图上确认「向前的手 ↔ 向后的腿」同侧成对，且没有同侧手脚一起向前 |

**顺拐的准确定义**（写进提示词的那一句）：*同一个身体侧的胳膊和腿不得同时向前* ——
`each arm swings opposite to the leg on the SAME side of her body`。
这一句要出现在**每一个**行走帧的提示词里，它是唯一能压住这个错误的手段。

#### 2.5.6 行走帧的 Pose 段模板

在 §2.1 角色锁定段之后，把 §2.2 的 `Pose:` 行整行替换为下面之一。
每个模板末尾都要接上 §2.4 的**配色重申句**和 §2.3 的透明背景段。

```
# contact（前脚跟落地）
Pose: full side view, she is turned to face the LEFT side of the picture, seen in profile,
walking toward the left edge of the picture. This is the CONTACT frame, the instant the front
foot lands: the leg nearer the camera is stretched forward and its heel is just touching the
ground with the toes lifted, while the leg farther from the camera is stretched back with only
its toe on the ground. Her arms swing opposite to her legs the way a real walk works: the arm
nearer the camera swings BACKWARD behind her hip, and the arm farther from the camera swings
FORWARD past her waist. Both arms held clear of the apron so the gap between arm and body is
visible. Elbows slightly bent, hands relaxed. Torso upright, shoulders counter-rotated, head
level looking ahead.
Critical: each arm swings opposite to the leg on the SAME side of her body — when a leg is
forward, the arm on that same side is always backward. Never let the near arm and the near leg
both come forward.

# down（重心最低）
Pose: full side view facing the LEFT side of the picture, in profile, walking toward the left
edge. This is the LOWEST point of the step: she is in a small crouch with her knees slightly
bent, her weight fully settled on the foot that is planted flat under her hip. Her other foot
is behind her, just lifting off the ground with the toe still touching, about to swing forward.
Her arms hang down and slightly back, both hands behind the line of her hips, shoulders a
little forward. Body low, compact, grounded.
Critical: each arm swings opposite to the leg on the SAME side of her body.

# passing（双腿并拢、身体最高）
Pose: full side view facing the LEFT side of the picture, in profile, walking toward the left
edge. This is the moment her feet PASS each other: her two legs are together and nearly
parallel, both feet close to the same spot under her body. The foot nearer the camera is lifted
just barely off the ground, bent at the knee, swinging through; the foot farther from the camera
is planted flat on the ground bearing her weight. Her arms hang straight down and close to her
body, both hands near her hips, one passing forward and one passing back. Torso at its tallest,
upright.
Critical: each arm swings opposite to the leg on the SAME side of her body.

# push-off（踮脚、另一腿抬起前摆）
Pose: full side view facing the LEFT side of the picture, in profile, walking toward the left
edge. This is the HIGHEST point of the step, the moment of maximum push-off: her body is at its
tallest and she is rising up on the toes of the foot that is planted behind her, that heel
lifted well off the ground and clearly visible. Her other leg is bent at the knee and swinging
forward, that foot lifted high off the ground in front of her. Her arms swing strongly, the near
arm forward and lifted, the far arm back behind her. Tall, extended push-off stride.
Critical: each arm swings opposite to the leg on the SAME side of her body.
```

#### 2.5.7 如果某一帧反复塌陷

按 §2.5.1，contact-B 很可能反复画成 contact-A。**不要硬耗**。可选的退路，按推荐顺序：

1. **把 `walk` 降到 2 帧循环**（`contact` + `passing`）。这两帧相位一致、无顺拐，
   在 `8fps` 下已经是可用的行走；代价是摆臂不交替 —— 而**摆臂不交替在 173×259 的
   观感尺寸下几乎看不出来**（手只有约 8px 宽）。
2. **补第 3、4 帧走垂直状态**（`down` / `push-off`），把循环做成 4 帧。
   实测这两帧的姿势确实不同（IoU 0.36–0.49），且与 contact 一起能读出「起—落」的节奏，
   观感上的「走动感」主要来自这个垂直起伏，而不是摆臂。
3. 最后才是手工改姿势（例如把某一帧的前后肢重绘），成本最高。

> 这一条与 `xiaoman` 的结论一致：那份文档 §6 把 `idle` 降到 4fps、`walk` 降到 8fps，
> 理由就是「快起来会露馅」。行走的**可信度主要来自垂直节奏**，摆臂交替是加分项。

### 2.6 可直接投喂的完整提示词（定妆图，实测产出 §4 的基准）

把 §2.1 + §2.2 + §2.3 拼成一段即可。下面就是**实际用出去、产出基准形象的那一段**，
一字未改，可以直接复制：

```
Photorealistic full-body photograph of a wholesome real 6-7 year old East Asian girl with
warm light skin and soft natural photographic texture (fine pores, gentle subsurface warmth
on the nose tip and ear rims, faint rosy cheeks, subtle lip colour). Deep chestnut-black
hair, chin-to-shoulder length with soft natural waves and a few fine flyaway strands, low
twin pigtails tied with cream cotton cord on each side, wispy natural bangs. Large bright
dark-brown eyes with natural eyelashes, calm friendly expression with a small closed-mouth
smile. She wears an oatmeal-cream cotton short-sleeve tee and a deep espresso-brown canvas
work apron over it; the apron has one chest pocket holding a small ivory index card whose
top edge sticks out, and a small pale-wood card-shaped tag engraved with a single horizontal
line hangs from a short cord at the right side of the apron waistband. Light grey ankle
socks, dark brown leather loafers. Pose: standing upright facing the camera, arms relaxed
at her sides slightly away from the body, feet together, weight even — a calm idle stance.
Composition: full body from head to shoes, centred horizontally; the top of her hair sits
about 10% down from the top edge of the picture and the soles of her shoes about 93% down,
leaving clear empty space above and below; nothing cropped. Lighting: soft window light
from camera left, warm gentle tones, no harsh shadows, clean readable silhouette.
Background: genuine transparency — a PNG with a real alpha channel. Everything around her
is exactly alpha 0; her body, hair, clothing and shoes are fully opaque at alpha 255. No
backdrop, no floor, no ground plane, no drop shadow, no contact shadow, no cast shadow, no
reflection, no grey halo or fringe around the outline, no checkerboard pattern, no white
box, no border, no frame, no text, no watermark, no other people. Vertical 2:3 portrait
composition.
```

侧视行走帧（`walk-left` / `walk-right`）用同一段，只把 `Pose:` 行整行替换为 §2.4 表里
对应的那一行，并**追加**侧视图的配色重申句（§2.4 第 2 点）。

---

## 3. 出图参数

| 参数 | 值 | 说明 |
|---|---|---|
| 比例 | **2:3** | 人形需要竖构图；与小满一致 |
| 分辨率 | 1024×1536（2K 档） | 单帧上限 1024px，384×576 正好是它的 0.375 等比 |
| 背景 | 透明 | 提示词说明即可，模型直接出真 alpha |
| 参考图 | §2.2 定妆图（i2i） | 除定妆图本身，所有动作都要带参考 |
| 每动作帧数 | 见 §6 | 帧数由 `pet.json` 声明，出图张数 = 帧数 |

---

## 4. 基准形象（**已确认**）

`artifacts/builtin-xiaoka-baseline/`：

| 文件 | 说明 |
|---|---|
| `source-front-idle-1024x1536.png` | 定妆图原始输出（透明） |
| `source-side-walk-1024x1536.png` | 侧视行走单帧原始输出 |
| `idle-384x576.png` | 清理 + 缩放后的正式帧 |
| `walk-left-384x576.png` | 同上，侧视 |
| `preview-idle-dark.png` / `preview-idle-light.png` | 深色/浅色主题合成预览 |
| `preview-idle-dark-173x259.png` | **观感尺寸**预览（`scale 0.45`），用来判断「真的站在桌面上是什么样」 |
| `contact-sheet.png` | 五格对照图：原始输出 / 清理后 / 浅色主题 / 两种观感尺寸 |
| `walk-lab/` | 行走循环实验产物：4 个关键帧 + 相位塌陷/摆臂/腿脚/镜像四张对照带（§2.5 的证据） |
| `tools/` | 清理、分析、量锚点、量肢体、比帧、拼对照图的脚本（见下） |

> `artifacts/` 在 `.gitignore` 里（与仓库现有的截图/核对产物一致），所以这一整套
> 是**本地产物、不进版本库**。基准形象确认后，正式素材要落到 `resources/pets/xiaoka/`
> 才会随包分发 —— 那里才是唯一需要提交的位置。

配套脚本（只依赖 Pillow，与插件运行期依赖一致）：

| 脚本 | 用途 |
|---|---|
| `tools/clean_frame.py <源图> <输出目录> <前缀>` | 清理 alpha + 缩放成 384×576，并出深/浅色与观感尺寸预览 |
| `tools/analyze.py <图> [输出目录]` | 统计 alpha 质量：255 像素数、最大 alpha、远离主体的雾点数、内容 bbox |
| `tools/measure_anchor.py <帧> [更多帧]` | 量脚底基准线与建议 `anchor.y`、内容水平中心、脚底横向跨度 |
| `tools/measure_limbs.py <帧...> --band arms\|legs` | 按皮肤色聚类量出**每只手 / 每条腿**的水平位置（§2.5 的核心验收手段） |
| `tools/measure_arm_swing.py <帧...>` | 按剪影极值粗量摆臂（**侧视图下会量到围裙**，已被 `measure_limbs.py` 取代，保留作对照） |
| `tools/compare_frames.py <帧...>` | 两两剪影 IoU / XOR，可带 `mirror=True` —— 判断「是不是同一张姿势」 |
| `tools/locate_tag.py <帧...>` | 定位腰侧木牌吊坠，量化镜像换相的代价 |
| `tools/flip_phase.py <目录> <前缀> <帧1> <帧2>` | 由半个循环镜像出完整 4 帧（注意 §2.5.2：镜像**不换相位**） |
| `tools/make_walk_strip.py <输出> <帧...> [--mirror]` | 行走帧对照带（可同时出镜像行） |
| `tools/make_band_strip.py <输出> <帧...> --band arms\|legs` | 放大裁出「手臂带 / 腿脚带」，用来肉眼核对摆臂与步态 |
| `tools/make_contact_sheet.py <基准目录>` | 把基准帧拼成对照图（`contact-sheet.png`） |

**本轮（12 动作定稿后）新增 / 修订的脚本**：

| 脚本 | 用途 |
|---|---|
| `tools/console_encoding.py` | **导入即生效**的控制台编码兜底（见 §8 第 5 条）：Windows 控制台是 GBK，验收脚本一旦 print 出 GBK 编不出来的字符（`✓` `✗`）就会抛 `UnicodeEncodeError` 并以 **1** 退出，与「验收不通过」撞码 |
| `tools/align_assemble.py <sheet> <地面线y> <帧...>` | 按地面线逐帧对齐后拼 sheet（踩地动作用；腾空动作不要用） |
| `tools/pack_sheet.py <out> <帧...>` / `--dir/--prefix/--count` | 通用拼 sheet（可 `--align-ground Y`），带帧数与上限校验 |
| `tools/build_pack.py`（默认 `--ground 570`） | **一条命令出全 12 张 sheet + `pet.json`**（含逐动作对齐策略：`ground` 逐帧对齐 / `shift` 整组平移；装配时清掉残留的 `walk.png`） |
| `tools/clean_batch.py <原始输出目录> <输出目录>` | 批量跑修好的 `clean_frame.py`（`整理/` → `xiaoka-clean/`） |
| `tools/check_seams.py --pack\|--frames ... --raw ...` | **缝隙检查**（§7.2.2）：三条分辨率/平移无关的判据，拦「清理管线把腋下/胯下糊掉」 |
| `tools/measure_frames.py <标签...> --dir <目录>` | 批量量底边/顶边/内容中心/alpha0 占比，决定切帧对齐 |
| `tools/measure_feet.py <标签...> --dir <目录>` | 按深棕皮鞋色量每帧**鞋底 y**，判断该动作是不是「每帧都踩地」 |
| `tools/measure_ground_fit.py <源帧目录>` | 由最高的一帧反推**不裁顶所需的地面线**，并列各候选值的裁顶帧与余量（按 12 动作取材，含方向化行走） |
| `tools/check_top_clipping.py <包目录>` | 逐帧检查有没有顶到画面上边缘（发顶被裁） |
| `tools/check_scale_drift.py <帧...>` | 用头宽/躯干宽判定帧间高度变化是**真起伏**还是模型改了人物尺度 |
| `tools/measure_front_legs.py <sheet.png>` | 腿脚带的块位读出（**历史用途**：正面 `walk` 的围裙挡剪影，全局 IoU 不敏感，改看腿带） |
| `tools/measure_motion.py <包目录> [动作名 ...]` | **与构图无关**的动感指标（相邻帧 dRGB、轮廓变化量），可横向对比各动作；缺 sheet 只跳过，不再崩 |
| `tools/accept_pack.py <包目录>` | §8 + §8.1 整套验收（白名单/宽度/真透明/IoU/手部块） |
| `tools/verify_delivery.py <包目录>` | 声明↔像素交叉核验：帧数、尺寸、真透明、地面线是否齐 |
| `tools/verify_traceability.py <包目录> <源帧目录>` | 每帧能否溯源到清理后的源帧（允许地面线平移）；方向化行走的源帧命名与其它动作一致，已删掉旧别名表与「方向帧目录」参数 |
| `tools/verify_objective.py <包目录>` | 按目标逐条核对（**12 动作 / 42 帧**，出现声明外动作即报错） |
| `tools/check_walk_reachability.py <包目录>` | 推演 `direction.js`：正面 `walk` 在运行期是否可达 |
| `tools/check_http_frames.py` | 走真实路由栈逐动作取图（端到端链路）；**逐字节比对**取到的图确实是该动作自己的 sheet，防回退链「假通过」 |
| `tools/check_redlines.py <包目录>` | §8 三条红线复查（白名单扩展名 / 宽度 / 8MB / 帧数 / fps） |
| `tools/crop_tag_windows.py <out> <帧...>` | 裁同一相对窗口放大并排，**肉眼判定木牌是否可见**（决策②的验收手段） |
| `tools/make_accept_strip.py <out> <右向帧...> --left <左向帧...>` | 手臂带+腿脚带四行对照图（§8.1 第③条肉眼核对用） |
| `tools/collect_final_frames.py <输出目录>` | 把最终单帧与它们的原始输出配对整合（`frames-384x576/` + `cleaned-source/` + `raw-1024x1536/` + `provenance.json`） |

实测数据（`analyze.py` / `measure_anchor.py`）：

| 指标 | 定妆图 | 侧视帧 |
|---|---|---|
| 源图 alpha 最大值 | 254（**没有 255**） | 254 |
| 远离主体的淡雾像素 | 1223（最大 alpha 5） | 1725（最大 alpha 6） |
| 清理后 alpha = 255 像素数 | 56361 | — |
| 清理后远离主体的淡雾像素 | **0** | **0** |
| 清理后 384×576 内容 bbox | top 10 / bottom 562 | top 23 / bottom 536 |
| 内容水平中心 | 0.4987 | 0.4258 |
| 建议 `anchor.y` | **0.9774** | 0.9323（见 §5 的说明） |

---

## 5. 观感尺寸与 `anchor`

沿用 `xiaoman` 的结论（小满文档 §4.2）：**大贴图 + 小 `scale`**。

- `size = 384×576`（贴图尺寸，2:3）
- `scale = 0.45` → 观感约 **173×259**
- `pixelated = false`（写实照片放大必须平滑插值）

**`anchor.y` 只能取一个值，但它必须按「脚踩地」的动作量。**
定妆图实测脚底落在 562/576 → 建议 `anchor.y = 0.9774`（**不是 1.0**；写 1.0 会整体悬空约 5px 观感）。
侧视帧量出 0.9323 是因为那一帧有一只脚**抬在半空**，不是素材问题 ——
切帧时要把 `walk-left`/`walk-right` 的内容底边**对齐到同一条地面线**（小满文档 §8.3），
对齐后各动作的 `anchor` 才会一致。

> **但最终交付用的地面线是 570，不是 562** —— 见 §9.1 的注记：
> 562 会让行走里最高的一帧（内容高 570px）**裁掉发顶 7px**。
> 地面线必须 ≥ 最高的那一帧，所以抬到 570（`anchor.y = 0.9913`）。
> 定妆图那 562 是**单张静态图**的脚底，不含「站得最高」的姿态。

**左右不对称必须画两套侧视图**：腰侧木牌吊坠只在单侧，靠 `mirror` 镜像会把它翻到另一边
（`backend/core/pack.py:WALK_DIRECTION_ACTIONS` 的注释已经写明这条）。

> **木牌到底挂在哪一侧（口径统一）**：§2.1 角色锁定段写的是
> `at the right side of the apron waistband` —— 那是**画面视角**的描述
> （正面定妆图里木牌出现在画面右侧，实测内容中心偏移 +0.07）。
> 正视图中画面右侧 = **她的左髋**。所以两种说法指的是同一个物理位置：
> **木牌在小卡的左髋**。
>
> 由此推出的可见性规则（§9.1 的实测复核就是按这条做的）：
> **朝画面左走 → 左髋朝镜头 → 木牌可见；朝画面右走 → 左髋在远侧 → 木牌应被身体挡住。**
> 镜像会同时翻转朝向与吊牌可见性，因此**两个方向各出一套**才能让吊牌始终物理正确。

---

## 6. 动作规格

对齐 `pack.py` 的动作词表与回退链。**内置形象应该全部给全**，否则用户会看到
「缺少必要动作」的警告（`REQUIRED_ACTIONS = idle / walk / drag / fall`；
其中 `walk` 只要给了**任一方向**的侧视行走即算满足，见下）。

| 动作 | 标签 | 帧数 | fps | loop | 上限检查 |
|---|---|---|---|---|---|
| `idle` | 待机 | 4 | 4 | ✅ | 4×384 = 1536 ≤ 4096 |
| `walk-left` | 向左走 | **4**（见下） | 8 | ✅ | 1536 |
| `walk-right` | 向右走 | **4**（见下） | 8 | ✅ | 1536 |
| `drag` | 被拖动 | 2 | 4 | ✅ | 768 |
| `fall` | 下落 | 2 | 8 | ✅ | 768 |
| `land` | 落地 | 3 | 12 | ❌ 单次 | 1152 |
| `sleep` | 睡觉 | 4 | 3 | ✅ | 1536 |
| `click` | 被点击 | 3 | 12 | ❌ 单次 | 1152 |
| `happy` | 开心 | 4 | 6 | ❌ 单次 | 1536 |
| `sad` | 难过 | 4 | 4 | ✅ | 1536 |
| `angry` | 生气 | 4 | 6 | ✅ | 1536 |
| `look` | 张望 | 4 | 5 | ✅ | 1536 |

**共 12 个动作、42 帧。** 正面 `walk` **已废弃**（2026-10）：

- `petview.js` 的 WALK 态一律取 `walk-left` / `walk-right`，正面 `walk` **不可达**
  （只曾用于面板预览与「两侧都缺」的回退）；
- `pack.py:missing_required()` 对 `walk` 有特判：提供任一方向的侧视行走即算满足；
- 因此不再出图、不再进包。`build_pack.py` 会在装配时清掉残留的 `walk.png`。

**行走帧数与相位**（§2.5 的结论直接改了这一行）：

- 4 帧 = `contact` → `down` → `passing` → `push-off`，**按身体高度状态出图**，不按左右腿出图；
- `walk-left` / `walk-right` **各出一套**（用户决策②）。文档早先版本写的
  「`walk-right` 由 `walk-left` 镜像得到」在**相位上**是对的（镜像换朝向、不换相位，
  §2.5.2），但**漏算了木牌**：镜像会把木牌从「远侧（看不见）」翻到「近侧（看得见）」，
  物理上错。所以两个方向各自出图 —— 朝右走时木牌在远侧、应当看不见；
  朝左走时木牌在近侧、可见。**这条以放大对照图肉眼核对为准**（见 §9.1 的注记：
  颜色阈值判定在浅木色木牌与手臂皮肤之间会失效）；
- 若 4 帧里有帧反复塌陷成同一姿势，退到 **2 帧循环**（`contact` + `passing`），见 §2.5.7。

上限（`pack.py`）：单动作 ≤ 256 帧、`fps` ≤ 60、单帧边长 ≤ 1024px、
sheet 总宽 ≤ 4096、单文件 ≤ 8MB。上表全在安全区。

> 节奏沿用 `xiaoman` 的实测修正：`idle` **4fps**（6fps 看着像喘气）、`walk` **8fps** +
> `walkSpeed 52`（70/10fps 明显滑步）。真人形象的呼吸与步频比二次元形象更需要「慢」。

---

## 7. 从出图到可用帧

### 7.1 目录

```
resources/pets/xiaoka/
    pet.json
    idle.png walk-left.png walk-right.png
    drag.png fall.png land.png
    sleep.png click.png happy.png sad.png angry.png look.png
```

（**没有 `walk.png`** —— 正面 `walk` 已废弃，见 §6。）

### 7.2 清理管线（**必做**，脚本见 `artifacts/builtin-xiaoka-baseline/tools/clean_frame.py`）

> **2026-10 修订：管线已收敛为「只做放大缩小 / 移动 / 拼接」。**
> 旧版本在这三步之外还做了 alpha floor、形态学闭运算、填洞、连通域过滤、
> 掩膜内强制 alpha 255 —— 这些**全部删除**，它们是「腋下 / 胯下 / 两腿之间糊成一片」
> 的根因。完整判据与实测对照见 §7.2.2。

允许的操作**只有**三类，外加一项逐像素的值域归一：

1. **值域归一**（点运算，不看邻域）：模型的输出最高只到 **254**（整幅没有一个 255）。
   把观测到的峰值线性映射到 255，形状完全不变。
   —— 这是为了让「主体内部存在 alpha 255」这条运行期/验收要求成立；
   旧版本用「掩膜内强制 255」去凑，那才是糊边。
2. **等比缩放**：整幅 1024×1536 → 384×576（0.375）。**统一变换，不要逐帧裁剪对齐** ——
   整幅缩放能原样保留模型画出的所有位移（跳跃、呼吸、压扁）且零逐帧漂移。
3. **整帧平移**（整数像素，画布尺寸不变）：用于第 4 步的地面线对齐。
4. **拼接**：把若干帧横向并成 sheet（`--stitch`）。

**明确禁止**（历史 bug 的来源，代码里已不再出现实现）：

| 禁止的操作 | 后果 |
|---|---|
| alpha floor / 阈值清零 | 啃掉细窄部位（脚后跟、发丝、鞋带） |
| 形态学闭运算 `_close` | 膨胀**先**把腋下、胯下的缝焊上 |
| 填洞 `_fill_holes` | 把「手臂与躯干之间」「两腿之间」当内部孔洞填掉 |
| 连通域过滤 / 最大块裁剪 | 把分离的肢体部件（手、发梢、吊坠）整块丢掉 |
| 掩膜内强制 alpha 255 | 糊边的直接原因 |
| 逐帧裁剪对齐 / 重采样对齐 | 破坏模型画出的帧间位移 |

**地面线对齐**（只对每帧都踩地的动作：`idle` / `walk-left` / `walk-right` / `sleep` /
`land` / `sad` / `angry` / `look`）：逐帧把内容底边对齐到同一条线；腾空动作
（`drag` / `fall` / `click` / `happy` 的跳跃）**整组同幅平移**，保留帧间垂直关系 ——
逐帧对齐会把跳跃抹平。

#### 7.2.1 两个必须程序化拦截的坏输出（本轮实测）

**① 烤死的棋盘格底**。模型有时不输出真 alpha，而是把「透明」画成一格一格的
灰白棋盘**像素**。这种图**能通过「alpha255 数量」这类弱检查**（整幅都是 255，
`alpha0` 占比 0.0），但它是**完全不透明**的 —— 贴上桌面会带一个大白框。

判定方法（`check_seams.py` 已实现）：看 `alpha0_ratio`，真透明帧实测在
**0.589–0.799**；若 `alpha0_ratio == 0.0`，就是棋盘格底，**必须重出**。

**② 纯文生图更容易被内容政策拦**。`drag-1` 曾被上游以 safety 拒绝
（其中一条列出 `sexual` —— 那是「被拎起」这个动作本身的误判）。
**不要硬耗**：换 provider / 重发一次通常就过，
`edit_image` 走 i2i（带参考图）比纯文生图稳。

> 这两条都只能靠**读像素**发现，看预览图判断不出来（预览会合成到白底，
> 棋盘格与真透明看起来一样）。所以「真透明要程序化验证」不只是 §8 的验收项，
> 也是**生成阶段的守门条件**。

#### 7.2.2 缝隙检查（`check_seams.py`，§8 新增验收项）

**为什么旧的验收拦不住糊边**：旧判据看的是「alpha255 数量」「远处雾点」「IoU」。
糊边的表现恰恰是 **alpha255 变多、雾点变少、剪影变大** —— 每一项在旧判据里都是
「更通过」。所以必须换一组判据。三条判据全部**与分辨率、与是否平移无关**，
因此在源图或成品帧上都能算：

| 判据 | 通过条件 | 只做缩放（实测） | 旧管线（实测） |
|---|---|---|---|
| A 反糊边 | `alpha255` 占**剪影** ≤ 0.35 | 0.0125–0.1052 | **0.9150–0.9714** |
| B 反凭空补实心 | 清理后 `alpha>=200`、对应源块（2.67px）内无 `alpha>=128` 的像素数 ≤ 剪影 × 0.001 | **恒为 0** | 0–26791 px |
| C 缝隙完整 | 剪影内部孔洞面积 ≥ 基线 × 0.5 | 基线的 **0.988** | **0.0000–0.3907** |

- 判据 A 用「占剪影」而不是「占整帧」：占整帧会被透明背景稀释，钝到没用。
- 判据 C 的基线 = 在**源图原生分辨率**上算出的孔洞面积 × 面积比
  （384×576 / 1024×1536）。基线 < 20px 的帧噪声大，只告警。
- 判据 B/C 比较前按内容底边对齐，并只用「平移后仍留在画面内」的行 —— 否则
  地面线对齐本身会被误判成「凭空补实心」。

> **数字会随复刻细节浮动，判据不会**：旧管线的原实现已从仓库删除，
> 复核时只能**复刻**（`binary_closing(5×5)` + `binary_fill_holes` + 最大块 +
> 掩膜内强制 255）。本机复刻实测：不通过项 **118**（原记 115）、
> 基线 ≥ 20px 的 39 帧里缝隙归零 **12** 帧（原记「42 帧里 25 帧」）。
> 差异来自复刻参数（半径/结构元）而非判据 —— 三张表里**唯一关键的结论
> 「0 帧通过」在两版复刻下都成立**。引用时以「0 帧通过 / 大面积不通过」为准，
> 不要精确引用项数。

**门槛有效性已验证**（拿复刻的旧管线跑同一组 42 帧）：**0 帧通过**（不通过项
115–118，随复刻实现的细节浮动）；修好的管线：**42/42 通过**。

```bash
# 对清理后的单帧目录
python check_seams.py --frames <清理后目录> --raw <原始输出目录>
# 或直接对落盘的包
python check_seams.py --pack resources/pets/xiaoka --raw <原始输出目录>
```

### 7.3 `pet.json` 骨架

> `anchor.y` 定稿为 **0.9913**（= (570+1)/576，按最终地面线实测，见 §9.1）。
> 下面骨架里保留 0.9774 是**出图前的预估**；实际值由 `build_pack.py`
> 按 `--ground` 自动算出，不要手抄。

```json
{
  "format": 1,
  "id": "xiaoka",
  "name": "小卡",
  "author": "ST-Manager",
  "size": { "w": 384, "h": 576 },
  "anchor": { "x": 0.5, "y": 0.9774 },
  "scale": 0.45,
  "pixelated": false,
  "physics": {
    "gravity": 1800,
    "walkSpeed": 52,
    "friction": 0.02,
    "terminalVelocity": 2400,
    "bounce": 0.12
  },
  "animations": {
    "idle":       { "sheet": "idle.png",       "frames": 4, "fps": 4,  "loop": true  },
    "walk-left":  { "sheet": "walk-left.png",  "frames": 4, "fps": 8,  "loop": true  },
    "walk-right": { "sheet": "walk-right.png", "frames": 4, "fps": 8,  "loop": true  },
    "drag":       { "sheet": "drag.png",       "frames": 2, "fps": 4,  "loop": true  },
    "fall":       { "sheet": "fall.png",       "frames": 2, "fps": 8,  "loop": true  },
    "land":       { "sheet": "land.png",       "frames": 3, "fps": 12, "loop": false },
    "sleep":      { "sheet": "sleep.png",      "frames": 4, "fps": 3,  "loop": true  },
    "click":      { "sheet": "click.png",      "frames": 3, "fps": 12, "loop": false },
    "happy":      { "sheet": "happy.png",      "frames": 4, "fps": 6,  "loop": false },
    "sad":        { "sheet": "sad.png",        "frames": 4, "fps": 4,  "loop": true  },
    "angry":      { "sheet": "angry.png",      "frames": 4, "fps": 6,  "loop": true  },
    "look":       { "sheet": "look.png",       "frames": 4, "fps": 5,  "loop": true  }
  }
}
```

> **`walk` 已废弃**（2026-10）：插件运行期 `petview.js` 的 WALK 态一律取
> `walk-left` / `walk-right`，正面 `walk` **不可达**；`pack.py:missing_required()`
> 对 `walk` 有特判 —— 提供任一方向的侧视行走即算满足。因此 `xiaoka` 不再出、
> 不再打包正面 `walk`。动作集从 13 个降到 **12 个**，帧数 48 → **42**。

`anchor.y` 与 `scale` 都**按素材实测定**，不要照抄本文的数字 —— 换素材就要重新量。

---

## 8. 校验与打包

```bash
# 形状、帧数、白名单、上限
python -c "from backend.core.pack import load_file; print(load_file('resources/pets/xiaoka/pet.json', pack_id='xiaoka'))"

# 全套测试
python -m pytest tests/ -q
node --test tests/frontend/logic.test.mjs tests/frontend/announce.test.mjs
```

三条硬性注意（与 `xiaoman` 相同）：

1. **不要放 `.jpg`** —— 运行期 sheet 白名单是 `{.png .webp .gif .avif .svg}`，
   JPEG 只在导入期被转码放行；落盘的包里出现 JPEG 会被拒。
2. **单帧必须等宽**，横向 sheet 总宽 = 帧数 × 单帧宽（384 的整数倍）。
3. **真透明要程序化验证**，不要看预览图。判定标准：主体内部 alpha 必须存在 255，
   且远离主体的雾点数为 0。

第四条（**2026-10 新增**）：

4. **缝隙要程序化验证** —— `python check_seams.py --pack resources/pets/xiaoka
   --raw <原始输出目录>`。判据与实测对照见 §7.2.2。**这一条拦的是「清理管线把
   腋下 / 胯下 / 两腿之间糊掉」，旧的三条拦不住**（糊边会让 alpha255 变多、
   雾点变少，在旧判据里全是「更通过」）。

第五条（**2026-10 新增，工具链自身的缺陷**）：

5. **验收脚本的退出码必须可信** —— Windows 控制台默认编码是 **GBK(cp936)**，
   `python <脚本>.py` 会把 `sys.stdout` 设成 GBK。脚本里只要有一个 GBK 编不出来的
   字符走到 `print`（`✓` `✗` `−` `↔` `⚠` …），Python 就抛 `UnicodeEncodeError`
   并让进程以 **1** 退出 —— **与「验收不通过」的退出码完全撞车**：

   ```
   ✓ 全部硬性检查通过     ← 本来是这句，结果崩在 print 上，exit 1
   ```

   实测中招的七个：`accept_pack.py` / `check_seams.py` / `verify_delivery.py` /
   `verify_traceability.py` / `check_top_clipping.py` / `check_redlines.py` /
   `verify_objective.py`。**它们全都会在「全部通过」的那一行崩掉**，
   于是「全部通过」被读成「有 1 项不通过」。

   两道防线（`tools/console_encoding.py`）：

   - 所有会打到 stdout 的字符只用 **GBK 能编的**：`√`（U+221A）替 `✓`、
     `×`（U+00D7）替 `✗`、`-` 替 `−`、`!` 替 `⚠`、`<->` 替 `↔`；
     `→` `≥` `≤` `·` 本身 GBK 就能编，保留。
   - 每个会 print 的脚本顶部 `import console_encoding`，它把 stdout/stderr 的
     `errors` 改成 `replace` 兜底 —— 将来漏了一个字符也只降级成 `?`，不会崩。

   **不要**把编码强行改成 UTF-8：在 cp936 控制台上那会把中文打成乱码，
   比降级一个符号更糟。`errors='replace'` 保留控制台原编码。

   验证方式：**不加** `PYTHONIOENCODING` 直接跑，全部应以 0 退出。

### 8.1 行走循环的验收清单（§2.5 的落地）

切帧前先跑这三条，**全部通过才继续**：

```bash
# ① 每帧的手部/腿部检出（手臂带应有两个手部块，横向间距 >= 内容宽 15%）
python tools/measure_limbs.py frames/*.png --band arms
python tools/measure_limbs.py frames/*.png --band legs

# ② 相邻帧剪影 IoU < 0.8（否则相位塌陷成同一张图）
python tools/compare_frames.py frames/*.png

# ③ 肉眼核对摆臂与步态（顺拐无法自动判定，见 §2.5.5）
python tools/make_band_strip.py out/arms.png frames/*.png --band arms --zoom 3
python tools/make_walk_strip.py out/strip.png frames/*.png
```

判据汇总：

| 检查 | 通过条件 | 失败含义 |
|---|---|---|
| 手部块数量 | 手臂带检出 **2** 个手部皮肤块 | 一只手被身体完全挡住 → 摆臂读不出来（`down` 帧实测就是这种情况） |
| 手部间距 | ≥ 内容宽度 × 15% | 摆幅太小 → 看起来像夹着胳膊走 |
| 相邻帧 IoU | **< 0.8** | 相位塌陷：模型重画了同一个姿势 |
| 单帧内反相（**不顺拐**） | **肉眼**：同侧手臂与腿不得同时向前 | 无法自动判定（§2.5.5） |
| 帧间交替 | **不可达** —— 提示词无法实现（§2.5.4.2），只能接受或手工修 | — |

> 手臂带里 `area` 300–400、`x≈199` 的那个块是**胸袋里的索引卡**，不是手。
> 按面积与 y 坐标排除，别把它数成第二只手。

---

## 9. 状态

- [x] 形象设计（§1）
- [x] 定妆图 + 侧视基准帧，alpha 已程序化验证（§4）
- [x] **用户确认基准形象**
- [x] 行走循环的摆臂/顺拐问题已实测定论（§2.5）：
      - **单帧内不顺拐** —— 提示词能做到（`each arm swings opposite to the leg on the SAME side`）；
      - **帧间摆臂交替** —— 提示词**做不到**（5 种写法全部复刻同一姿势，IoU 0.82–0.88）；
      - 镜像也换不来相位（§2.5.2）；
      - 唯一有效的是改描述维度：按身体高度状态出图（IoU 降到 0.44–0.49）。
- [x] **12 个动作**全部出图 + 清理 + 切帧（正面 `walk` 已废弃，见 §6）
- [x] **清理管线收敛为「只做放大缩小 / 移动 / 拼接」**（§7.2）——
      删掉 alpha floor / 闭运算 / 填洞 / 连通域过滤 / 掩膜内强制 255，
      糊边根因已消除
- [x] **新增缝隙检查 `check_seams.py`** 作为验收门槛（§7.2.2）：
      修好的管线 42/42 通过；复刻的旧管线 **0 帧通过**（不通过项 115–118，
      随复刻实现的细节浮动，见 §9.5 ③）
- [x] **验收工具链自身的缺陷已修**（§9.5）：7 个脚本在 Windows GBK 控制台上
      打印「全部通过」时抛 `UnicodeEncodeError` 并以 1 退出（与「不通过」撞码）；
      `verify_objective.py` 的期望表还留着已废弃的正面 `walk`（永远报 2 项不通过）；
      `check_http_frames.py` 请求 `walk` 被回退链兜成 `idle`（假通过）
- [x] `resources/pets/xiaoka/pet.json`
- [x] 与 `xiaoman` 并列注册为内置形象（`store.py` 的内置目录扫描；
      原 `default-cat` 已移除，插件现在只有这两个内置形象）
- [x] **§8 + §8.1 全部校验通过**（见 §9.1 的校验表）
- [x] 两个侧视行走 sheet 的相邻帧 IoU 全部 < 0.8（0.41–0.55）

### 9.1 交付结果（实测）

`resources/pets/xiaoka/`：**12 个动作** + `pet.json`，共 **5.75 MB**、**42 帧**。
`anchor.y = 0.9913`（= (570+1)/576，按**地面线实测**，见下方注记）、
`scale = 0.45`（观感身高 249px，与 `xiaoman` 的 253px 同量级）、`pixelated = false`。
全部 sheet 的文件名、帧数、fps、loop 与 §6 表格一致。

**素材来源**：`D:\Workspace\MyOwn\ST-Manager\dsh-image-gen\xiaoka-final-frames\整理\`
（用户重新整理后的 **42 张原始模型输出**，真 alpha，未被任何管线动过）。
清理后落在 `dsh-image-gen\xiaoka-clean\`，装配命令：

```bash
python clean_batch.py <整理目录> <清理后目录>
python build_pack.py            # --src 默认指向 xiaoka-clean
python check_seams.py --pack resources/pets/xiaoka --raw <整理目录>
```

> **地面线为什么是 570 而不是 562**：562 是定妆图脚底实测值，也是腾空动作组的
> 平移基准（校验点：`happy-4` 自然底边实测 = **562**，与本轮素材一致）。
> 但踩地动作里最高的一帧内容高 **555px**（`angry-4`），按 562 对齐只剩 7px 余量；
> 抬到 **570**（`anchor.y = 571/576 = 0.9913`，底部留 5px）后，对齐后最小顶边 **16px**，
> 腾空组整组 +8px 后最小顶边 **10px** —— 全组都不裁顶。
>
> 改地面线时**两类动作的处理不同**（`build_pack.py` 的对齐模式）：
> - **踩地动作**（idle / walk-left / walk-right / land / sleep / sad / angry / look）→ `ground`：
>   逐帧把内容底边对齐到 570；
> - **腾空动作**（drag / fall / click / happy）→ `shift`：**整组同幅 +8px**，
>   保留帧间的垂直关系（跳跃的起伏不能抹平）。
> - 方向化行走的 4 帧也在 `ground` 组里，与 idle 用同一条地面线 ——
>   否则切 idle↔walk 时宠物会上下跳。

**已通过的校验**：

| 校验 | 命令 / 手段 | 结果 |
|---|---|---|
| 包格式 | `pack.load_file('resources/pets/xiaoka/pet.json')` | ✅ `missing_required()` 为空、12 个动作 |
| 全套测试 | `pytest tests/ -q` | ✅ **401 passed** |
| 前端逻辑测试 | `node --test tests/frontend/*.test.mjs` | ✅ **110 passed / 0 fail** |
| 声明↔像素 | `verify_delivery.py` | ✅ 42 帧全部一致、地面线齐 |
| §8 红线 | `check_redlines.py` | ✅ 无 JPEG、无超限、宽度合规 |
| 真透明 | 逐帧内部 alpha 255 + 远处雾点 0 | ✅ 42/42 帧通过 |
| **缝隙检查** | `check_seams.py --pack … --raw …` | ✅ **42/42 帧通过**（旧管线同组 0 帧通过） |
| 逐帧可溯源 | `verify_traceability.py` | ✅ 42/42（含地面线平移） |
| 无裁顶 | `check_top_clipping.py` | ✅ 无任何帧顶到画面边缘 |
| 目标逐条 | `verify_objective.py` | ✅ 12 动作 / 42 帧、无声明外动作 |
| 端到端取图 | `check_http_frames.py` | ✅ 12/12 逐字节等于该动作自己的 sheet |
| 内置注册 | `PetStore(builtin_dir='resources/pets').list_pets()` | ✅ 含 `xiaoka`（与 `xiaoman` 并列） |
| §8.1 相邻帧 IoU | `accept_pack.py` | ✅ 侧视 0.408–0.551，全部 < 0.8 |
| **退出码可信** | 不加 `PYTHONIOENCODING` 直跑全部验收脚本 | ✅ 全部 exit 0（见 §8 第 5 条） |
| 管线可复现 | `clean_batch` + `build_pack` 重跑后与交付包比对 | ✅ 13/13 文件哈希一致 |

**用户已决策（§9 待决策三条）**：

| 决策 | 选择 | 落地 |
|---|---|---|
| ① 行走循环范围 | **A：4 帧按身体高度状态** | contact / down / passing / push-off；侧视相邻帧 IoU 0.41–0.55 |
| ② `walk-right` 来源 | **单独出图，不镜像** | 4 张新图（朝画面右）；左向 4 帧为另一组 |
| ③ 帧间不交替 | **接受** | 与 §2.5.4.2 的结论一致 |

**两个侧视行走 sheet 全部满足 §8.1 的 IoU 判据**（定稿）：

| sheet | 相邻帧全身 IoU | 结论 |
|---|---|---|
| `walk-left`（侧视） | 0.4381 / 0.4880 / 0.5175 / 0.5508 | ✅ |
| `walk-right`（侧视） | 0.4080 / 0.4496 / 0.5157 / 0.5324 | ✅ |

**木牌吊坠的左右不对称（§5 的落地）**：木牌在小卡的**左髋**。
朝画面左走时左髋朝向镜头 → 木牌可见；朝画面右走时左髋在远侧 → 木牌应不可见。
因此 `walk-left` 与 `walk-right` **各出一套**（决策②），不靠 `mirror` 复用 ——
镜像会同时翻转朝向与木牌的可见性，把「远侧的吊牌」搬到近侧，物理上是错的。

**实测复核（同一相对窗口裁切 4 倍放大肉眼核对，`tools/crop_tag_windows.py`）**：

| 方向 | f0 | f1 | f2 | f3 |
|---|---|---|---|---|
| `walk-left`（朝左） | 木牌可见 | 木牌可见 | 木牌可见 | 木牌可见 |
| `walk-right`（朝右） | 无 | 无 | 无 | 无 |

> **为什么这条必须以肉眼为准（很重要）**：试过三种程序化判定，**全部不可靠** ——
> 木牌是浅木色，而**她的手臂皮肤是同一色系**：
> - `locate_tag.py` 的判据「亮 + 暖」会把臂膀框进来（朝右帧里检出块跨度 **85–97px**，
>   而真木牌只有 **51–63px**）；
> - 以 `idle` 帧取色键做紧容差匹配同样失效 —— 取到的「色键」实测是 **RGB(222,175,150)**、
>   块高 141px，那是**手臂不是木牌**；
> - 换成「暗色围裙外的孤立浅块」也不行：木牌由绳结连着腰带，不是孤立连通域。
>
> 结论：**木牌可见性只能靠肉眼判定**（这也是 §8.1 ③ 要求肉眼核对的原因）。
> 上面的四行结论来自放大对照图，不是阈值脚本。
>
> **附带结论：`locate_tag.py` 的 `mirror_shift` 数值（86–243px）不可用于论证「镜像代价」** ——
> 它依赖的正是上面这个失效的判据。文档早先版本引用过 140–145px，那个数字**同样不可信**。
> 决策②的真正依据不是这个数值，而是**可见性方向本身**：木牌是单侧的，
> 镜像会把「远侧看不见」翻成「近侧看得见」，与朝向无关地错。

### 9.2 正面 `walk` 的垂直起伏是解掉相位塌陷的关键（**历史记录，动作已废弃**）

> **本节记录的是已废弃动作的分析过程，保留用于沿革。** 正面 `walk` 在 2026-10 被
> 移出 xiaoka 的动作集（运行期不可达，见 §9.4），下面所有数字都出自那一轮素材。

**问题**：正面 `walk` 最初 6 帧相邻 IoU 高达 **0.86–0.92**，按 §8.1 判为相位塌陷。
量下去发现根因不是「模型复刻了同一姿势」，而是**帧间整体高度几乎没变** ——
头部顶端在整个循环里只移动了约 **10px**，剪影自然几乎重合。

**解法（§2.5.3 那条唯一有效的杠杆，用到正面视图上）**：把描述维度从
「哪条腿在前」换成**身体高度状态**，并在提示词里显式要求
「这一帧要比参考图**明显更矮**（重心下沉、双膝弯）／**明显更高**（挺身站高）」。
重出后头部顶端行程从 10px 提升到 **61px**，内容高度极差 **85px**。

**判定「这是真起伏还是模型把人物画大了」**（`tools/check_scale_drift.py`）：
量一个与姿态无关的尺度基准 —— 头宽。实测头宽均值 94.2px、**极差仅 9px（9.6%）**，
躯干宽波动 4.0% ⇒ 人物比例未变，高度变化来自**腿部伸展与整体上下位移**，是真起伏。

**定稿实测（全部通过）**：

| 指标 | 值 | 判据 |
|---|---|---|
| 全身剪影相邻 IoU | **0.65–0.79** | ✅ 六对全部 < 0.8（最接近的一对 0.7916） |
| 腿带（内容高 80%–100%）相邻 IoU | **0.36–0.62** | ✅ |
| 两腿横向间隙 | `24 → 8 → 0 → 17 → 10 → 0` px | 分开/收窄/并拢/换腿分开 |
| 内容高度极差 | 85px | 起伏可见 |
| 头宽极差 | 9px | 比例未漂移 |

**与构图无关的独立佐证**（`tools/measure_motion.py`）—— 同一组指标横向比：

| 动作 | 相邻帧 dRGB | 轮廓变化量 |
|---|---|---|
| `idle`（对照：几乎不动） | 11.93 | 3 352 px |
| **`walk`（正面）** | **45.03** | **18 434 px** |
| `walk-right`（侧视） | 25.68 | 29 706 px |
| `walk-left`（侧视） | 46.71 | 35 332 px |

正面 `walk` 的 `dRGB`（**45.03**）已经与侧视 `walk-left`（46.71）**持平**，
是 idle 的 **3.8 倍**。

**结论：正面 `walk` 不再需要任何判据豁免 —— 它按 §8.1 原判据（IoU < 0.8）直接通过。**

> 早先版本记过一条「正面构图导致 IoU 误报、改看腿带」的偏差说明。
> 那条**现在已不成立**：起伏补上之后全局 IoU 自己就降到门槛以下了。
> 保留这段沿革是因为它记录了**根因判断的修正** ——
> 最初以为是「围裙占剪影太大」的构图问题（那不可解），
> 实测后才发现是「起伏不够」（那可以解）。`accept_pack.py` 里
> 「正面 walk 看腿带」的兜底分支保留着，但定稿素材已经走不到那个分支。

### 9.3 正面 `walk` 的取材（**历史记录，动作已废弃**）

正面 6 帧按**身体高度状态**描述、并**显式写出与参考图的高度差**
（`CLEARLY LOWER … dropped down, both knees bent` /
`CLEARLY TALLER … risen up, standing tall`），配合
`Do not draw her at her normal height unless the pose sentence says NORMAL height`。
6 帧的高度序列为 常规 → **低** → **高** → 常规 → **低** → **高**（两拍循环）。

**手臂摆幅不是问题**：正面 6 帧的手部间距占内容宽 **0.68–0.81**，远高于 §8.1
的 15% 门槛 —— 正面视图里手臂本来就露在围裙外，不存在侧视图 `down` 帧
「远侧手被围裙挡住」的问题。

其余 11 个动作均为独立取材，未做跨帧相位判定（§8.1 的 IoU 判据只针对行走）。

### 9.4 正面 `walk` 在运行期不可达（**这条最终导致该动作被废弃**）

`frontend/petview.js:applyActionForState()` 在 WALK 态**一律**用
`walkActionFor(walkDirection)` 取动作名 —— 向左取 `walk-left`、向右取 `walk-right`，
**永远不取正面 `walk`**。而 `frontend/direction.js` 只在「两侧都没提供」时才回退到
正面图（`resolveWalkVisual` 的最后一条分支）。

xiaoka **两侧都提供了**自己画的方向化贴图，所以：

| 状态 | 实际播的 sheet | 是否翻转 |
|---|---|---|
| 向左走 | `walk-left.png` | **否**（朝向由贴图自己决定） |
| 向右走 | `walk-right.png` | **否** |

**2026-10 决定：既然运行期不可达，就不再出图、不再进包**（动作集 13 → 12）。
`pack.py:missing_required()` 对 `walk` 有特判 —— 提供了任一方向的侧视行走即算满足，
所以移出正面 `walk` **不会**让用户看到「缺少必要动作」。

验证：`tools/check_walk_reachability.py`（推演 `direction.js` 的判定），
以及前端单测 `tests/frontend/logic.test.mjs` 的
「方向：两侧都有时按方向取图，且都不翻转」（**110 项 node 测试全通过**）。

### 9.5 验收工具链自身的缺陷（**本轮修好**）

> 与 §7.2 那条「清理管线糊边」并列：一个是**素材**的缺陷，一个是**验收工具**的缺陷。
> 后者的危害更隐蔽 —— 它把「全部通过」显示成「不通过」，会让人去改根本没坏的素材。

**① 退出码不可信（阻塞级）**

Windows 控制台默认编码是 GBK(cp936)，`python <脚本>.py` 会把 `sys.stdout` 设成 GBK。
七个验收脚本的**成功分支**里都 print 了 `✓`（U+2713）/ `✗`（U+2717）—— 这两个字符
GBK 编不出来，于是脚本在**打印「全部通过」的那一刻**抛 `UnicodeEncodeError`
并以 **1** 退出，与「验收不通过」的退出码完全撞车。

| 脚本 | 崩在哪一行 |
|---|---|
| `accept_pack.py` | `print('✓ 全部硬性检查通过')` |
| `check_seams.py` | `print('✓ 全部帧通过：…')` |
| `verify_delivery.py` | `print('✓ 从声明到像素全部一致')` |
| `verify_traceability.py` | `print('✓ 全部可溯源' if …)` |
| `check_top_clipping.py` | `print('✓ 没有任何帧被裁顶')` |
| `check_redlines.py` | `print('红线问题: 无 ✓')` |
| `verify_objective.py` | `print('✓ 目标逐条全部达成')` |

修法（两道防线，见 §8 第 5 条）：换成 GBK 能编的 `√` / `×`，并加
`tools/console_encoding.py` 把 `errors` 改成 `replace` 兜底。
**现在不加 `PYTHONIOENCODING` 直跑，七个脚本全部 exit 0。**

**② 三处「过期假设」让检查假通过或假失败**

| 脚本 | 缺陷 | 修法 |
|---|---|---|
| `verify_objective.py` | 期望表里还留着**已废弃的正面 `walk`（6 帧）**，于是**每一轮都必然报 2 项不通过**（`walk` 帧数 None、动作数 12 ≠ 13）—— 一个永远不会绿的检查等于没有检查 | 改成 12 动作 / 42 帧；**并新增「出现声明外动作即报错」**，防 `walk.png` 又被打包进来 |
| `check_http_frames.py` | 仍在请求 `walk`，而回退链会把它落到 `idle` —— HTTP 200、`image/png`、字节数正常，**看不出根本没有这张图**，于是「13 动作可经 HTTP 取图」是假通过 | 只请求实际声明的 12 个动作；**并把响应逐字节与 `pet.json` 声明的 sheet 比对**，回退到别的动作会立刻暴露 |
| `measure_motion.py` / `measure_ground_fit.py` / `verify_traceability.py` | 默认序列/别名表里还写着 `walk`：`measure_motion.py` 直接 **FileNotFoundError 崩掉**；`measure_ground_fit.py` 少算方向化行走的 8 帧；`verify_traceability.py` 留着 `ALIASES = {}` 与没人用的「方向帧目录」参数 | 统一按 12 动作取材；缺 sheet 只跳过并标注，不再崩；删掉死参数 |

**③ 复现验证**

- 修好的管线重跑 `clean_batch` + `build_pack`，产物与交付包 **13/13 文件哈希一致**；
- 复刻旧管线（`binary_closing` + `binary_fill_holes` + 掩膜内强制 255）跑同一组 42 帧，
  `check_seams.py` 报 **118 项不通过 / 0 帧通过**（`alpha255` 占剪影 0.9150–0.9714、
  凭空补实心最多 26791px、39 帧里 12 帧缝隙归零）—— 门槛确实拦得住。

---

### 原「待用户决策」（**已决策，见 §9.1**）

**① 行走循环做到哪一步**（帧间交替拿不到，只能退让）：

| 方案 | 帧间摆臂交替 | 成本 | 实测状态 |
|---|---|---|---|
| A. 4 帧按垂直状态出图 | 无（但姿态各不相同） | 4 张图 | ✅ 4 帧已出，IoU 0.36–0.49 |
| B. 2 帧循环（`contact` + `passing`） | 无 | 2 张图，最省 | ✅ 2 帧已出 |
| C. 手工重绘一帧的前后肢 | **有** | 最高，需人工修图 | 未做 |

A 与 B 在 173×259 观感尺寸下的差别**很小**：手约 8px 宽，
摆幅差约 13px（观感尺度）。行走的「动感」主要来自垂直起伏，不是摆臂。

**② `walk-right` 怎么来**：

| 方案 | 木牌吊坠 | 成本 |
|---|---|---|
| 镜像 `walk-left`（`mirror: true`） | 会把「远侧看不见」翻成「近侧看得见」，吊牌凭空出现在错误的一侧髋部 —— 观感尺度下**肉眼可见**（早先引用的 140–146px 出自已证失效的判据，见 §9.1 注记，但结论不变） | 0 张图 |
| 单独出一套 | 保持在正确的一侧，物理正确 | 4 张图 |

**③ 是否接受「帧间不交替」**：如果这条对你重要，那就只能走 C（手工修图）；
否则建议 A + 单独出 `walk-right`，行走质量已经够用。
