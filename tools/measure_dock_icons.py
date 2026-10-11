"""按宿主真实渲染方式测量坞图标的**实际视觉大小**，并与参照插件对比。

为什么必须实测而不是算 viewBox
------------------------------
坞槽位是 `--dock-icon-size: 1.625rem` = **26px 的正方形**
（`entry-dock.css:369-382`），图标以 `mask: ... center / contain` 渲染。
`contain` 的缩放是：

    scale = 26 / max(viewBox 宽, viewBox 高)

也就是说**视觉大小取决于「内容在 viewBox 里的占比」**，而不只是 viewBox 本身：
两个 viewBox 尺寸相同的图标，若内边距不同，实际墨迹大小会差很多。
所以这里把两个图标都按真实方式渲染出来，**逐像素量墨迹包围盒**。

用法：python tools/measure_dock_icons.py [--out artifacts/icon-analysis/dock-compare.png]
"""

import base64
import os
import subprocess
import sys

from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_ROOT = os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager')
AI_ROOT = os.environ.get('AI_ASSISTANT_ROOT', r'D:\Workspace\MyOwn\ST-Manager-AI-Assistant')
OUT_DIR = os.path.join(REPO_ROOT, 'artifacts', 'icon-analysis')

#: 坞图标槽位边长（`entry-dock.css:65`）。窄屏是 1.5rem=24px（同文件 969 行）。
DOCK_ICON_SIZE = 26
DOCK_ICON_SIZE_NARROW = 24

#: 放大倍数：26px 太小，量墨迹包围盒会有 ±1px 的量化误差。
#: 按同一比例放大后测量再折算回去，结论更可靠（比例不变）。
SUPERSAMPLE = 16

ICONS = {
    'ai': ('AI 助手（参照）', os.path.join(AI_ROOT, 'frontend', 'assets', 'icon.svg')),
    'pet': ('桌面宠物', os.path.join(REPO_ROOT, 'frontend', 'assets', 'icon.svg')),
}


def find_browser():
    for path in (
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    ):
        if os.path.isfile(path):
            return path
    raise SystemExit('找不到 Chrome / Edge，无法渲染测量')


def render_at(svg_text, size_px, png_path, browser):
    """按宿主真实方式渲染：mask 抠形 + 实色填充（只看形状，颜色无所谓）。"""
    mask_url = 'data:image/svg+xml;base64,' + base64.b64encode(
        svg_text.encode('utf-8'),
    ).decode('ascii')
    # 用纯黑填充、纯白底：便于按亮度阈值分离墨迹
    html = (
        '<html><body style="margin:0;background:#ffffff">'
        f'<span style="position:absolute;left:0;top:0;display:block;'
        f'width:{size_px}px;height:{size_px}px;background-color:#000000;'
        f'-webkit-mask:url(\'{mask_url}\') center / contain no-repeat;'
        f'mask:url(\'{mask_url}\') center / contain no-repeat"></span>'
        '</body></html>'
    )
    html_path = png_path + '.html'
    with open(html_path, 'w', encoding='utf-8') as handle:
        handle.write(html)
    subprocess.run(
        [browser, '--headless=new', '--disable-gpu', '--hide-scrollbars',
         f'--screenshot={png_path}', f'--window-size={size_px},{size_px}',
         '--default-background-color=FFFFFFFF',
         f'file:///{html_path.replace(chr(92), "/")}'],
        capture_output=True, text=True, check=False,
    )
    os.remove(html_path)
    if not os.path.isfile(png_path):
        raise SystemExit(f'渲染失败: {png_path}')


def measure_ink(png_path):
    """量墨迹：包围盒 + 不透明像素数（阈值取中灰，抗抗锯齿边缘）。"""
    with Image.open(png_path) as img:
        gray = img.convert('L')
        width, height = gray.size
        pixels = gray.load()
        min_x, min_y, max_x, max_y = width, height, -1, -1
        ink = 0
        for y in range(height):
            for x in range(width):
                if pixels[x, y] < 128:
                    ink += 1
                    if x < min_x:
                        min_x = x
                    if y < min_y:
                        min_y = y
                    if x > max_x:
                        max_x = x
                    if y > max_y:
                        max_y = y
        if max_x < 0:
            return None
        return {
            'ink_w': max_x - min_x + 1,
            'ink_h': max_y - min_y + 1,
            'ink_px': ink,
            'canvas': (width, height),
        }


def build_compare_sheet(browser, out_path):
    """并排渲染两个图标在**坞真实尺寸**下的样子，放大便于肉眼判断。

    为什么要看图：数字只能说「高度差 3%」，但坞槽位是方的、图标横竖占比不同，
    观感是否协调要看并排效果。槽位背景/圆角按 `entry-dock.css` 还原。
    """
    zoom = 8
    cells = []
    for key in ('ai', 'pet'):
        if key not in ICONS:
            continue
        label, path = ICONS[key]
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as handle:
            svg = handle.read()
        mask_url = 'data:image/svg+xml;base64,' + base64.b64encode(
            svg.encode('utf-8'),
        ).decode('ascii')
        for size in (DOCK_ICON_SIZE, DOCK_ICON_SIZE_NARROW):
            box = size * zoom
            radius = 8 * zoom  # 槽位圆角 0.5rem = 8px
            cells.append(
                f'<div style="display:flex;flex-direction:column;align-items:center;gap:10px">'
                f'<div style="width:{box}px;height:{box}px;display:flex;align-items:center;'
                f'justify-content:center;background:#f2f2f5;'
                f'border:1px solid #e0e0e6;border-radius:{radius}px">'
                f'<span style="display:block;width:{box}px;height:{box}px;'
                f'background-color:#4a4a55;'
                f'-webkit-mask:url(\'{mask_url}\') center / contain no-repeat;'
                f'mask:url(\'{mask_url}\') center / contain no-repeat"></span></div>'
                f'<small style="font:13px system-ui;color:#444">{label} · {size}px</small></div>'
            )

    html = (
        '<html><body style="margin:0;background:#fff;padding:28px;font:13px system-ui">'
        '<div style="font:600 15px system-ui;margin-bottom:18px">'
        '坞入口图标并排对照（还原坞槽位背景与圆角，放大 8 倍）</div>'
        '<div style="display:flex;gap:36px;align-items:flex-end">'
        + ''.join(cells)
        + '</div></body></html>'
    )
    html_path = out_path + '.html'
    with open(html_path, 'w', encoding='utf-8') as handle:
        handle.write(html)
    subprocess.run(
        [browser, '--headless=new', '--disable-gpu', '--hide-scrollbars',
         f'--screenshot={out_path}', '--window-size=1100,340',
         '--default-background-color=FFFFFFFF',
         f'file:///{html_path.replace(chr(92), "/")}'],
        capture_output=True, text=True, check=False,
    )
    os.remove(html_path)
    return os.path.isfile(out_path)


def main():
    browser = find_browser()
    os.makedirs(OUT_DIR, exist_ok=True)
    big = DOCK_ICON_SIZE * SUPERSAMPLE

    reports = {}
    print(f'坞槽位 {DOCK_ICON_SIZE}px（窄屏 {DOCK_ICON_SIZE_NARROW}px）'
          f'，按 {SUPERSAMPLE}× 放大测量后折算\n')
    for key, (label, path) in ICONS.items():
        if not os.path.isfile(path):
            print(f'{label}: 找不到 {path}（跳过）')
            continue
        with open(path, encoding='utf-8') as handle:
            svg = handle.read()
        png = os.path.join(OUT_DIR, f'dock-{key}-{big}px.png')
        render_at(svg, big, png, browser)
        measured = measure_ink(png)
        if not measured:
            print(f'{label}: 渲染出来是空白')
            continue
        # 折算回坞里的真实像素
        scaled = {
            'w': measured['ink_w'] / SUPERSAMPLE,
            'h': measured['ink_h'] / SUPERSAMPLE,
            'px': measured['ink_px'] / (SUPERSAMPLE ** 2),
        }
        reports[key] = {'label': label, 'path': path, 'raw': measured, 'dock': scaled}

        print(f'{label}')
        print(f'  文件      : {os.path.relpath(path, os.path.dirname(REPO_ROOT))}')
        print(f'  墨迹(放大) : {measured["ink_w"]} x {measured["ink_h"]} px  '
              f'（画布 {measured["canvas"][0]}x{measured["canvas"][1]}）')
        print(f'  → 坞内实际 : {scaled["w"]:.2f} x {scaled["h"]:.2f} px，'
              f'墨迹面积 ≈ {scaled["px"]:.0f} 平方像素')
        print()

    if 'ai' in reports and 'pet' in reports:
        ai = reports['ai']['dock']
        pet = reports['pet']['dock']
        print('=' * 70)
        print('对比（坞内实际像素）')
        print('=' * 70)
        print(f'  宽   : 参照 {ai["w"]:.2f}  vs  宠物 {pet["w"]:.2f}   '
              f'（{pet["w"] - ai["w"]:+.2f}px）')
        print(f'  高   : 参照 {ai["h"]:.2f}  vs  宠物 {pet["h"]:.2f}   '
              f'（{pet["h"] - ai["h"]:+.2f}px）')
        print(f'  面积 : 参照 {ai["px"]:.0f}  vs  宠物 {pet["px"]:.0f}   '
              f'（{(pet["px"] / ai["px"] - 1) * 100:+.1f}%）')

        # 判定口径：视觉"大小感"由**高度**主导（槽位是方的、图标横向顶满，
        # 高度差才是肉眼能看出来的那个），面积作为辅助参考。
        height_ratio = pet['h'] / ai['h']
        area_ratio = pet['px'] / ai['px']
        print()
        if abs(height_ratio - 1) <= 0.04 and abs(area_ratio - 1) <= 0.12:
            print('  → 视觉大小已与参照一致（高度差 ≤4%、面积差 ≤12%），无需调整。')
        else:
            print(f'  → 高度差 {abs(1 - height_ratio) * 100:.1f}%、'
                  f'面积差 {abs(1 - area_ratio) * 100:.1f}%，超出容差。')
            if height_ratio < 1:
                print(f'     宠物偏矮：要把内容高度放大 {1 / height_ratio:.3f} 倍。')
            else:
                print(f'     宠物偏高：要把内容高度缩小 {height_ratio:.3f} 倍。')

    sheet = os.path.join(OUT_DIR, 'dock-compare.png')
    if build_compare_sheet(browser, sheet):
        print(f'\n并排对照图: {os.path.relpath(sheet, REPO_ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
