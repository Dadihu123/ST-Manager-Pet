"""建「动图容器」测试形象，用于验收 `layout: "animated"` 这条路线。

为什么需要专门的测试形象
------------------------
动图路线的核心断言是「**浏览器真的在播它**」，而判据只能是
「同一张图过一段时间采样两次，像素变了」。要让它可判定，动图必须是
**每一帧颜色都明显不同**的——真实素材帧间差异小，采样值会落在噪声里。

因此这里造一张逐帧变色的动图（红→绿→蓝→黄循环），并把**帧号写进色相**
（第 n 帧 = 色相 n/N），这样采样值本身就能反推出「播到第几帧」。

同时造一个**静态动作**（`walk-left`），用来验证两种路线能在同一个形象里并存
——这正是「第二路线」的卖点：作者可以只把某个动作换成动图。

用法：
    python tools/make-animated-pet.py <插件 data/pets 目录> [帧数] [宽] [高]
"""
import json
import os
import sys

from PIL import Image

#: 逐帧色相表（帧号 → RGB）。用高饱和的原色，采样值差异最大。
PALETTE = [
    (255, 0, 0), (255, 128, 0), (255, 255, 0), (128, 255, 0),
    (0, 255, 0), (0, 255, 128), (0, 255, 255), (0, 128, 255),
    (0, 0, 255), (128, 0, 255), (255, 0, 255), (255, 0, 128),
]


def build_frames(count, width, height):
    """造 `count` 帧：每帧整块纯色（色相按帧号推进）+ 一个移动的方块。

    纯色保证采样值能直接读出帧号；移动方块保证「帧间确实有变化」这件事
    在任何采样点上都成立（即使采样点落在纯色区的边缘）。
    """
    frames = []
    for index in range(count):
        color = PALETTE[index % len(PALETTE)]
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        # 主体：纯色块（覆盖大部分面积，让采样点几乎一定落在它上面）
        body = Image.new("RGBA", (width, height), color + (255,))
        image.paste(body, (0, 0))
        # 移动的深色方块：位置随帧号推进，作为「这确实是动图」的第二证据
        size = max(4, width // 6)
        left = int((width - size) * (index / max(1, count - 1)))
        top = int((height - size) * (index / max(1, count - 1)))
        block = Image.new("RGBA", (size, size), (20, 20, 20, 255))
        image.paste(block, (left, top))
        frames.append(image)
    return frames


def main():
    target = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 240
    height = int(sys.argv[4]) if len(sys.argv) > 4 else 240
    if count < 2:
        raise SystemExit("动图至少要 2 帧")

    pack_id = "animated-pet"
    pack_dir = os.path.join(target, pack_id)
    os.makedirs(pack_dir, exist_ok=True)

    frames = build_frames(count, width, height)

    # 动图 GIF：帧间隔 90ms（采样间隔取 130ms 时能稳定采到不同帧）
    gif_path = os.path.join(pack_dir, "idle.gif")
    frames[0].save(
        gif_path, format="GIF", save_all=True, append_images=frames[1:],
        duration=90, loop=0, disposal=2,
    )

    # 动图 WebP（同一内容的另一种容器，用来验 WebP 也走这条路）
    webp_path = os.path.join(pack_dir, "look.webp")
    frames[0].save(
        webp_path, format="WEBP", save_all=True, append_images=frames[1:],
        duration=90, loop=0, quality=90, method=4,
    )

    # 静态动作：一张普通横向 spritesheet（验证两条路线并存）
    sheet = Image.new("RGBA", (width * 4, height), (0, 0, 0, 0))
    for index in range(4):
        tile = Image.new("RGBA", (width, height), (60, 60, 200, 255))
        sheet.paste(tile, (index * width, 0))
    sheet.save(os.path.join(pack_dir, "walk.png"), format="PNG", optimize=True)

    # 静态标准图像（供 reducedMotion 兜底：动图停不下来时改画它）
    frames[0].save(os.path.join(pack_dir, "still.png"), format="PNG")

    manifest = {
        "id": pack_id,
        "name": "动图测试",
        "author": "验收脚本",
        "size": {"w": width, "h": height},
        "scale": 1,
        "physics": {"gravity": 1800, "walkSpeed": 52},
        # 标准图像显式声明成**静态图**：动图容器在 reducedMotion 下
        # 停不下来（没有 CSS 能暂停 GIF），此时前端改画标准图像来兑现承诺。
        "still": {"sheet": "still.png"},
        "animations": {
            # 动图 GIF
            "idle": {"sheet": "idle.gif", "layout": "animated"},
            # 动图 WebP：同一内容、另一种容器
            "look": {"sheet": "look.webp", "layout": "animated"},
            # 帧序列（与动图并存）
            "walk-left": {"sheet": "walk.png", "frames": 4, "fps": 4},
            "walk-right": {"sheet": "walk.png", "frames": 4, "fps": 4},
        },
    }
    with open(os.path.join(pack_dir, "pet.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    gif_bytes = os.path.getsize(gif_path)
    webp_bytes = os.path.getsize(webp_path)
    print(
        f"wrote {pack_dir}\n"
        f"  idle.gif  {count} frames {width}x{height}  {gif_bytes:,} bytes\n"
        f"  look.webp {count} frames {width}x{height}  {webp_bytes:,} bytes\n"
        f"  walk.png  4 frames (spritesheet, 与动图并存)"
    )


if __name__ == "__main__":
    main()
