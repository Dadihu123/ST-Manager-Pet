"""把用户设计的宠物图标裁剪 viewBox，并渲染成各尺寸核对观感。

背景（为什么必须裁剪 viewBox）
------------------------------
宿主把插件图标当 **CSS mask** 渲染（`static/css/modules/icons.css:42`）：

    .ui-icon.ui-icon--asset {
      background-color: currentColor;
      -webkit-mask: var(--ui-icon-mask) center / contain no-repeat;
    }

`contain` 会把整个 SVG 缩放**完全放进** 16–24px 的方框里。原文件
`width=1792 height=2400` 而内容只占中间一块（x 93–1699, y 603–1916），
不裁剪的话图形在图标位里只剩很小一团。

另外宿主用 mask 抠形，意味着：
- 只有**不透明**区域可见，颜色统一由 `currentColor` 决定 → 必须是单色剪影；
- 原始 `fill="#000000"` 正好合适（mask 只看 alpha）；
- 反过来说，多色 / 渐变设计在这里会被抹平。

用法：
    python tools/crop_icon.py            # 生成裁剪版 + 各尺寸渲染对照
"""

import os
import re
import subprocess
import sys

#: 图标设计稿（用户提供的原始 SVG）。
#:
#: 默认取宿主仓库 `tmp/插件/宠物.svg`；换机器时用 `ICON_SOURCE` 环境变量指定。
#: 注意：本工具**只在设计稿更新时需要跑**，产物 `frontend/assets/icon.svg`
#: 已提交进仓库，日常构建/测试不依赖这个源文件。
SOURCE = os.environ.get(
    'ICON_SOURCE',
    os.path.join(
        os.environ.get('HOST_ROOT', r'D:\Workspace\MyOwn\ST-Manager'),
        'tmp', '插件', '宠物.svg',
    ),
)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(REPO_ROOT, 'frontend', 'assets', 'icon.svg')
OUT_DIR = os.path.join(REPO_ROOT, 'artifacts', 'icon-analysis')

#: 内容 bbox（原设计稿坐标系）。
#:
#: 由解析 path 的 M/L 坐标得到；重跑一次即可复现：
#:     python tools/crop_icon.py --measure
#: 源文件画布是 1792×2400，而内容只占中间这一块，
#: 因此**必须**裁剪 viewBox（见文件头的说明）。
CONTENT_BBOX = (93, 603, 1699, 1916)

#: 在内容四周留一点内边距（占内容尺寸的比例）。
#: 不留会显得"贴边"；留太多在 16px 下又白费像素。0.02 约等于各边 1px@48px。
PADDING_RATIO = 0.02


def measure_bbox(svg_text: str):
    """解析 SVG 里所有 path 的坐标，返回内容 bbox。

    只解析 `M/m/L/l/H/h/V/v/Z/z`（VTracer 的产物只用这些）。
    重跑 `--measure` 时会用这个函数核对 `CONTENT_BBOX` 是否仍然正确。
    """
    xs, ys = [], []
    for d in re.findall(r'\bd="([^"]+)"', svg_text):
        tokens = re.findall(r'[A-Za-z]|-?\d*\.?\d+', d)
        cx = cy = 0.0
        startx = starty = 0.0
        cmd = ''
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if re.match(r'[A-Za-z]', token):
                cmd = token
                index += 1
                if cmd in 'Zz':
                    cx, cy = startx, starty
                continue
            if cmd in ('M', 'm'):
                x = float(tokens[index]); y = float(tokens[index + 1]); index += 2
                if cmd == 'm':
                    x += cx; y += cy
                cx, cy = x, y
                startx, starty = x, y
                xs.append(x); ys.append(y)
                cmd = 'l' if cmd == 'm' else 'L'
            elif cmd in ('L', 'l'):
                x = float(tokens[index]); y = float(tokens[index + 1]); index += 2
                if cmd == 'l':
                    x += cx; y += cy
                cx, cy = x, y
                xs.append(x); ys.append(y)
            elif cmd in ('H', 'h'):
                x = float(tokens[index]); index += 1
                if cmd == 'h':
                    x += cx
                cx = x
                xs.append(x)
            elif cmd in ('V', 'v'):
                y = float(tokens[index]); index += 1
                if cmd == 'v':
                    y += cy
                cy = y
                ys.append(y)
            else:
                index += 1
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def build_cropped_svg(source: str, *, square: bool = False) -> str:
    """返回裁剪了 viewBox 的 SVG 文本。

    Args:
        square: True 时把 viewBox 扩成正方形（内容居中）。
            正方形在 `contain` 下会留白，但能保证任何容器比例都不变形；
            紧致裁剪则让图形在方框里尽可能大。图标位是正方形，
            因此这里**默认紧致**，把宝贵的 16px 都用来画内容。
    """
    x0, y0, x1, y1 = CONTENT_BBOX
    width = x1 - x0
    height = y1 - y0

    pad_x = width * PADDING_RATIO
    pad_y = height * PADDING_RATIO
    box_x = x0 - pad_x
    box_y = y0 - pad_y
    box_w = width + pad_x * 2
    box_h = height + pad_y * 2

    if square:
        side = max(box_w, box_h)
        box_x -= (side - box_w) / 2
        box_y -= (side - box_h) / 2
        box_w = box_h = side

    # 取出所有 path（丢掉注释与生成器标记）
    paths = re.findall(r'<path[^>]*/>', source)
    if not paths:
        raise SystemExit(f'在 {SOURCE} 里找不到 path')

    def tidy(path_tag: str) -> str:
        """统一成显式 fill（mask 只看 alpha，颜色本身无所谓，但别留空）。"""
        # 已经有 fill 就保留；没有则补上 currentColor
        if re.search(r'\bfill="', path_tag):
            return path_tag
        return path_tag.replace('<path', '<path fill="currentColor"', 1)

    body = '\n'.join(f'  {tidy(tag)}' for tag in paths)
    # 坐标是整数，viewBox 保留一位小数即可，别把文件撑大
    def fmt(value: float) -> str:
        return str(int(value)) if float(value).is_integer() else f'{value:.1f}'

    # `width`/`height` 按 viewBox 的比例给（不是 24×24）：
    # 两者同时存在时，SVG 的**固有宽高比**取自 width/height；若写成 24×24，
    # 固有比例就是 1:1，与 viewBox 的 1.22:1 不一致，多出来的部分只能靠
    # `preserveAspectRatio` 内补——多数浏览器结果一样，但没必要留这个歧义。
    # 这里显式给出真实比例，让固有尺寸与 viewBox 一致。
    nominal = 24.0
    out_w = nominal
    out_h = nominal * (box_h / box_w)

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{fmt(box_x)} {fmt(box_y)} {fmt(box_w)} {fmt(box_h)}" '
        f'width="{fmt(out_w)}" height="{fmt(round(out_h, 1))}" '
        'role="img" aria-hidden="true">\n'
        f'{body}\n'
        '</svg>\n'
    )


def find_browser() -> str:
    for path in (
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    ):
        if os.path.isfile(path):
            return path
    return ''


def render(svg_text: str, png_path: str, size: int, browser: str, *, on_dark: bool = False) -> bool:
    """按**宿主真实的渲染方式**出图：mask 抠形 + currentColor 着色。

    这样看到的就是插件在坞 / 设置页 / 弹层标题里的真实观感，
    而不是"把 SVG 当图片缩一缩"的假象。
    """
    import base64
    mask_url = 'data:image/svg+xml;base64,' + base64.b64encode(
        svg_text.encode('utf-8'),
    ).decode('ascii')
    color = '#f5f5f5' if on_dark else '#2b2b2b'
    background = '#1e1e1e' if on_dark else '#ffffff'
    html = (
        '<html><body style="margin:0;background:%s;display:flex;'
        'align-items:center;justify-content:center;width:100vw;height:100vh">'
        f'<span style="display:block;width:{size}px;height:{size}px;'
        f'background-color:{color};'
        f'-webkit-mask:url(\'{mask_url}\') center / contain no-repeat;'
        f'mask:url(\'{mask_url}\') center / contain no-repeat"></span>'
        '</body></html>' % background
    )
    html_path = png_path + '.html'
    with open(html_path, 'w', encoding='utf-8') as handle:
        handle.write(html)
    subprocess.run(
        [browser, '--headless=new', '--disable-gpu', '--hide-scrollbars',
         f'--screenshot={png_path}', f'--window-size={size},{size}',
         '--default-background-color=FFFFFFFF',
         f'file:///{html_path.replace(chr(92), "/")}'],
        capture_output=True, text=True, check=False,
    )
    os.remove(html_path)
    return os.path.isfile(png_path)


def build_sheet(svg_text: str, browser: str, out_path: str) -> bool:
    """把多个尺寸拼成一张对照图。

    为什么不逐个尺寸截图：无头 Chrome 的 `--screenshot` 受窗口最小尺寸限制，
    设 16/24px 会产出空白图（实测）。因此改成在一个足够大的窗口里
    用 CSS 把同一枚图标渲染成多种尺寸，一次截图拿全。
    """
    import base64

    mask_url = 'data:image/svg+xml;base64,' + base64.b64encode(
        svg_text.encode('utf-8'),
    ).decode('ascii')

    def cell(size: int, color: str, background: str, label: str) -> str:
        return (
            f'<div style="display:flex;flex-direction:column;align-items:center;gap:6px">'
            f'<div style="width:96px;height:96px;display:flex;align-items:center;'
            f'justify-content:center;background:{background};border-radius:8px">'
            f'<span style="display:block;width:{size}px;height:{size}px;'
            f'background-color:{color};'
            f'-webkit-mask:url(\'{mask_url}\') center / contain no-repeat;'
            f'mask:url(\'{mask_url}\') center / contain no-repeat"></span></div>'
            f'<small style="font:11px system-ui;color:#666">{label}</small></div>'
        )

    cells = []
    for size in (48, 32, 24, 20, 16):
        cells.append(cell(size, '#2b2b2b', '#ffffff', f'{size}px 浅色'))
    for size in (24, 16):
        cells.append(cell(size, '#f0f0f0', '#1e1e1e', f'{size}px 深色'))
    cells.append(cell(24, '#ffffff', '#7c5cff', '24px 强调色'))

    html = (
        '<html><body style="margin:0;background:#fff;padding:16px;'
        'font:12px system-ui">'
        '<div style="display:flex;gap:14px;align-items:flex-end">'
        + ''.join(cells)
        + '</div></body></html>'
    )
    html_path = out_path + '.html'
    with open(html_path, 'w', encoding='utf-8') as handle:
        handle.write(html)
    subprocess.run(
        [browser, '--headless=new', '--disable-gpu', '--hide-scrollbars',
         f'--screenshot={out_path}', '--window-size=1000,160',
         '--default-background-color=FFFFFFFF',
         f'file:///{html_path.replace(chr(92), "/")}'],
        capture_output=True, text=True, check=False,
    )
    os.remove(html_path)
    return os.path.isfile(out_path)


def main() -> int:
    if not os.path.isfile(SOURCE):
        raise SystemExit(f'找不到源文件: {SOURCE}')

    with open(SOURCE, 'r', encoding='utf-8') as handle:
        source = handle.read()

    # `--measure`：只核对 CONTENT_BBOX 是否仍与源文件一致（改了设计稿就跑一次）
    if '--measure' in sys.argv:
        measured = measure_bbox(source)
        print(f'实测内容 bbox: {measured}')
        print(f'脚本内常量  : {CONTENT_BBOX}')
        if measured and tuple(int(value) for value in measured) != CONTENT_BBOX:
            print('⚠️ 不一致 —— 源文件变了，请更新 CONTENT_BBOX 后重跑')
            return 1
        print('一致')
        return 0

    cropped = build_cropped_svg(source)
    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    with open(TARGET, 'w', encoding='utf-8') as handle:
        handle.write(cropped)
    print(f'已写出裁剪版: {TARGET}  ({len(cropped)} 字节)')

    x0, y0, x1, y1 = CONTENT_BBOX
    print(f'  内容 bbox: {x1 - x0} x {y1 - y0}（原画布 {1792} x {2400}）')
    view_box = re.search(r'viewBox="([^"]+)"', cropped).group(1)
    print(f'  新 viewBox: {view_box}')

    browser = find_browser()
    if not browser:
        print('找不到浏览器，跳过渲染')
        return 0

    os.makedirs(OUT_DIR, exist_ok=True)
    # 大图看形状
    for size in (512, 96):
        target = os.path.join(OUT_DIR, f'cropped-mask-{size}.png')
        if render(cropped, target, size, browser):
            print(f'  {size}px → {os.path.basename(target)}')

    # 小尺寸拼一张对照图（逐个截 16/24px 会得到空白，见 build_sheet 说明）
    sheet = os.path.join(OUT_DIR, 'sizes-sheet.png')
    if build_sheet(cropped, browser, sheet):
        print(f'  多尺寸对照 → {os.path.basename(sheet)}')

    # 未裁剪的对照组（证明"必须裁剪"这件事）
    original = re.sub(r'<\?xml[^>]*\?>', '', source)
    control = os.path.join(OUT_DIR, 'uncropped-sheet.png')
    if build_sheet(original, browser, control):
        print(f'  对照（未裁剪）→ {os.path.basename(control)}')

    return 0


if __name__ == '__main__':
    sys.exit(main())
