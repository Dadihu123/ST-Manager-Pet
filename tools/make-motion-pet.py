"""建「程序化运动」测试形象，用于验收 `motion`（呼吸 / 眨眼）。

为什么需要专门的测试形象
------------------------
动图那次踩过同样的坑：核心断言（「它真的在动」）只能靠**像素采样**判定，
而真实素材的帧间差异太小、会落在噪声里。因此这里造一个**逐帧纯色**的
sheet：帧号直接编码进颜色，采样值就能反推出「现在显示第几帧」。

形象内容：
- `idle`：4 帧纯色（红→绿→蓝→黄），声明**呼吸**（幅度 6%，周期 2s）
  与**眨眼**（跳到第 2、3 帧，间隔 1.2–1.8s、每次 200ms）；
- `walk-left`：4 帧纯色，**不声明 motion**（对照组：证明「没声明就不动」）；
- `plain`：另一个动作，也不声明 motion。

用法：
    python tools/make-motion-pet.py <插件 data/pets 目录> [帧宽] [帧高]
"""
import json
import os
import sys

from PIL import Image

#: 逐帧纯色（帧号 → RGB）。高饱和原色，采样差异最大。
FRAME_COLORS = [(220, 40, 40), (40, 190, 60), (50, 70, 220), (230, 200, 40)]


def build_sheet(width, height, colors):
    sheet = Image.new("RGBA", (width * len(colors), height), (0, 0, 0, 0))
    for index, color in enumerate(colors):
        tile = Image.new("RGBA", (width, height), color + (255,))
        # 每帧顶部画一条**不同高度**的深色条：即使采样点落在边缘，
        # 「帧变了」这件事仍然可判（纯色块之间本来就难分边界）。
        bar = Image.new("RGBA", (width, max(2, (index + 1) * height // 8)), (20, 20, 20, 255))
        tile.paste(bar, (0, 0))
        sheet.paste(tile, (index * width, 0))
    return sheet


def main():
    target = sys.argv[1]
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 160

    pack_id = "motion-pet"
    pack_dir = os.path.join(target, pack_id)
    os.makedirs(pack_dir, exist_ok=True)

    build_sheet(width, height, FRAME_COLORS).save(
        os.path.join(pack_dir, "idle.png"), format="PNG", optimize=True,
    )
    build_sheet(width, height, [(90, 90, 90), (120, 120, 120), (150, 150, 150), (180, 180, 180)]).save(
        os.path.join(pack_dir, "walk.png"), format="PNG", optimize=True,
    )

    manifest = {
        "id": pack_id,
        "name": "运动测试",
        "author": "验收脚本",
        "size": {"w": width, "h": height},
        "scale": 1,
        # 锚点**故意不取默认值**：验证 `transform-origin` 真的跟着 anchor.y 走
        # （写死「底部居中」的话，这个形象的呼吸会以错误的点缩放）。
        "anchor": {"x": 0.5, "y": 0.9},
        "physics": {"gravity": 1800, "walkSpeed": 52},
        "animations": {
            # 呼吸 + 眨眼（两者同时开，验证可叠加）
            "idle": {
                "sheet": "idle.png",
                "frames": 4,
                "fps": 4,
                "motion": {
                    "breathe": {"amplitude": 0.06, "periodMs": 2000},
                    "blink": {"frames": [2, 3], "everyMs": [1200, 1800], "durationMs": 200},
                },
            },
            # 对照组：不声明 motion，且是**合法的播报动作**
            # （`REACT_ACTIONS` = happy / sad / angry / click）。
            #
            # 为什么必须用播报动作做对照：验收要验「切到没 motion 的动作后
            # 呼吸被摘掉」，而切动作必须走状态机。`react()` 只接受那四个名字，
            # 拿 walk-left 去 react 会被**拒绝**、状态仍停在 idle——
            # 那样测的其实是「拒绝后呼吸还在」，与断言想验的东西无关。
            "happy": {"sheet": "walk.png", "frames": 4, "fps": 4},
            # 另一个对照组：行走（由物理驱动，不进 REACT 名单）
            "walk-left": {"sheet": "walk.png", "frames": 4, "fps": 4},
            "walk-right": {"sheet": "walk.png", "frames": 4, "fps": 4},
        },
    }
    with open(os.path.join(pack_dir, "pet.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    print(
        f"wrote {pack_dir}\n"
        f"  idle.png  {len(FRAME_COLORS)} frames {width}x{height}  "
        f"motion=breathe(±6%/2s)+blink(frames 2,3)\n"
        f"  walk.png  {len(FRAME_COLORS)} frames {width}x{height}  motion=none (对照)\n"
        f"  anchor y=0.9（故意非默认，验证 transform-origin 跟着走）"
    )


if __name__ == "__main__":
    main()
