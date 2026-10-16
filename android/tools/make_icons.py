"""Generate legacy launcher PNGs for the Android app (mipmap-* densities)."""
import os
from PIL import Image, ImageDraw

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "src", "main", "res")
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
BG = (14, 17, 22, 255)
BLUE = (46, 125, 255, 255)
GREEN = (49, 196, 141, 255)
DARK = (14, 17, 22, 255)


def draw_icon(size: int) -> Image.Image:
    scale = 8  # supersample for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)

    # camera body
    body = [int(s * 0.16), int(s * 0.30), int(s * 0.70), int(s * 0.72)]
    d.rounded_rectangle(body, radius=int(s * 0.06), fill=BLUE)

    # lens arc
    lw = max(int(s * 0.055), 1)
    d.arc(
        [int(s * 0.25), int(s * 0.40), int(s * 0.55), int(s * 0.70)],
        start=180, end=360, fill=DARK, width=lw,
    )
    d.line([int(s * 0.25), int(s * 0.55), int(s * 0.25), int(s * 0.62)], fill=DARK, width=lw)
    d.line([int(s * 0.55), int(s * 0.55), int(s * 0.55), int(s * 0.62)], fill=DARK, width=lw)

    # play / cast triangle
    d.polygon(
        [(int(s * 0.74), int(s * 0.36)), (int(s * 0.90), int(s * 0.48)), (int(s * 0.74), int(s * 0.60))],
        fill=GREEN,
    )
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    for name, size in DENSITIES.items():
        out_dir = os.path.join(BASE, "mipmap-" + name)
        os.makedirs(out_dir, exist_ok=True)
        icon = draw_icon(size)
        icon.save(os.path.join(out_dir, "ic_launcher.png"))
        icon.save(os.path.join(out_dir, "ic_launcher_round.png"))
        print("written", out_dir, size)


if __name__ == "__main__":
    main()
