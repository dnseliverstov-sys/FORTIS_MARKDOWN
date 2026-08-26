#!/usr/bin/env python3
"""Рисует иконки приложения.

  build/icon.png   — во весь квадрат, для Linux (и как запасной вариант)
  build/icon.ico   — то же, набором размеров, для Windows
  build/icon.icns  — по правилам macOS: знак занимает не весь квадрат,
                     а вписан с полями, иначе в доке он выглядит крупнее
                     соседних иконок

Знак: тёмный грунт FORTIS (#161826) и markdown-метка акцентным цветом
оформления Nocturne (#9184d9). Требуется Pillow: pip3 install pillow
Файл .icns собирается только на macOS (нужен iconutil).
"""
import pathlib
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # рисуем вчетверо крупнее и уменьшаем — так края выходят гладкими
BG = "#161826"
ACCENT = "#9184d9"

# macOS оставляет вокруг знака поля: сам квадрат занимает 824 из 1024,
# а его углы скруглены на 22,37% стороны — так выглядят иконки системы.
MAC_SIDE = 824
CORNER = 0.2237

# Геометрия markdown-метки в системе координат 208x128.
MARK_W, MARK_H = 208, 128
BORDER = (5, 5, 203, 123)
BORDER_RADIUS, BORDER_WIDTH = 10, 10
LETTER_M = [(30, 98), (30, 30), (50, 30), (70, 55), (90, 30), (110, 30),
            (110, 98), (90, 98), (90, 59), (70, 84), (50, 59), (50, 98)]
ARROW = [(155, 98), (125, 65), (145, 65), (145, 30), (165, 30), (165, 65), (185, 65)]

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"


def draw_mark(d, side, off_x, off_y):
    """Рисует markdown-метку внутри квадрата стороной side."""
    k = side * 0.625 / MARK_W  # метка занимает 62,5% ширины квадрата
    mx = off_x + (side - MARK_W * k) / 2
    my = off_y + (side - MARK_H * k) / 2
    pt = lambda p: (mx + p[0] * k, my + p[1] * k)

    x0, y0, x1, y1 = BORDER
    d.rounded_rectangle((*pt((x0, y0)), *pt((x1, y1))), radius=BORDER_RADIUS * k,
                        outline=ACCENT, width=round(BORDER_WIDTH * k))
    d.polygon([pt(p) for p in LETTER_M], fill=ACCENT)
    d.polygon([pt(p) for p in ARROW], fill=ACCENT)


def render(full_bleed: bool) -> Image.Image:
    canvas = SIZE * SS
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if full_bleed:
        side = canvas
        off = 0
        d.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=CORNER * canvas, fill=BG)
    else:
        side = MAC_SIDE * SS
        off = (canvas - side) / 2
        d.rounded_rectangle((off, off, off + side - 1, off + side - 1), radius=CORNER * side, fill=BG)

    draw_mark(d, side, off, off)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def write_icns(mac: Image.Image) -> None:
    if not shutil.which("iconutil"):
        print("iconutil не найден — .icns не собран (нужен macOS)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = pathlib.Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            mac.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
            mac.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")], check=True)
    print("написан", BUILD / "icon.icns")


def main() -> None:
    BUILD.mkdir(exist_ok=True)

    flat = render(full_bleed=True)
    flat.save(BUILD / "icon.png")
    flat.save(BUILD / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    print("написан", BUILD / "icon.png")
    print("написан", BUILD / "icon.ico")

    write_icns(render(full_bleed=False))


if __name__ == "__main__":
    main()
