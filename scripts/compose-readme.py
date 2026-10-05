# Composites frames recorded by scripts/capture-readme.cjs onto a faux desktop and writes the README preview.
#   python scripts/compose-readme.py   →  docs/images/nudgi-preview.webp
import glob
import json
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SRC = os.path.join(ROOT, 'output', 'readme')
OUT = os.path.join(ROOT, 'docs', 'images', 'nudgi-preview.webp')
frames = sorted(glob.glob(os.path.join(SRC, 'frames', 'f*.png')))
timing = json.load(open(os.path.join(SRC, 'timing.json')))
W, H = Image.open(frames[0]).size
TB = 40
font = ImageFont.truetype(r'C:\Windows\Fonts\segoeui.ttf', 13)
random.seed(7)

# faux desktop: gradient, an editor window on the left, a taskbar
bg = Image.new('RGBA', (W, H + TB))
g = ImageDraw.Draw(bg)
for y in range(H + TB):
    k = y / (H + TB)
    g.line([(0, y), (W, y)], fill=(int(22 + 10 * k), int(27 + 11 * k), int(38 + 15 * k), 255))
win = Image.new('RGBA', bg.size, (0, 0, 0, 0))
d = ImageDraw.Draw(win)
d.rounded_rectangle((-30, 38, 420, H - 26), radius=14, fill=(30, 34, 46, 255), outline=(52, 58, 76, 255))
d.rectangle((-30, 39, 419, 70), fill=(37, 42, 57, 255))
d.text((150, 46), 'reminders.js - Nudgi', fill=(150, 160, 180, 255), font=font)
cols = [(122, 162, 247), (158, 206, 106), (224, 175, 104), (187, 154, 247), (125, 207, 255), (170, 178, 200)]
y = 88
while y < H - 50:
    x = 24 + random.choice([0, 0, 16, 32, 48])
    for _ in range(random.randint(1, 4)):
        w = random.randint(24, 110)
        if x + w > 400:
            break
        d.rounded_rectangle((x, y, x + w, y + 8), radius=4, fill=random.choice(cols) + (150,))
        x += w + 10
    y += 22
shadow = win.split()[3].filter(ImageFilter.GaussianBlur(10)).point(lambda v: int(v * 0.55))
bg.alpha_composite(Image.merge('RGBA', [Image.new('L', bg.size, 0)] * 3 + [shadow]))
bg.alpha_composite(win)
tb = ImageDraw.Draw(bg)
tb.rectangle((0, H, W, H + TB), fill=(14, 17, 24, 255))
tb.line((0, H, W, H), fill=(48, 54, 70, 255))
for i, c in enumerate([(64, 120, 240), (240, 180, 60), (80, 200, 120), (230, 90, 90), (150, 110, 240), (70, 190, 220), (200, 200, 210)]):
    cx = W // 2 - 3 * 34 + i * 34
    tb.rounded_rectangle((cx - 11, H + 9, cx + 11, H + 31), radius=6, fill=c + (255,))
tb.text((W - 60, H + 11), '10:42', fill=(200, 205, 215, 255), font=font)

has = lambda f: Image.open(f).getchannel('A').getbbox() is not None
start = next(i for i, f in enumerate(frames) if has(f))
end = len(frames) - 1 - next(i for i, f in enumerate(reversed(frames)) if has(f))
scale = 0.86
out, durs = [], []
for i in range(start, end + 1):
    fr = bg.copy()
    fr.alpha_composite(Image.open(frames[i]).convert('RGBA'))
    out.append(fr.resize((int(W * scale), int((H + TB) * scale)), Image.LANCZOS).convert('RGB'))
    durs.append(max(20, (timing[i + 1] - timing[i]) if i + 1 < len(timing) else 60))
durs[-1] = 1000
out[0].save(OUT, save_all=True, append_images=out[1:], duration=durs, loop=0, quality=84, method=6)
print(len(out), 'frames', round(sum(durs) / 1000, 1), 's', round(os.path.getsize(OUT) / 1e6, 2), 'MB')
