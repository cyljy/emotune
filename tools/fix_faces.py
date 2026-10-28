# -*- coding: utf-8 -*-
"""整理人脸演示图：重命名为 <emotion>-<n>.jpg，压缩为 720px，并生成contact sheet便于人工校验"""
import os, glob
from PIL import Image

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "faces")
MAP = [
    ("happy-1", "28岁中国女性_露齿大笑"),
    ("happy-2", "35岁中国男性_咧嘴大笑"),
    ("happy-3", "22岁中国女大学生"),
    ("sad-1", "30岁中国男性_嘴角下垂"),
    ("sad-2", "45岁中国女性_眉头内侧上"),
    ("sad-3", "19岁中国青年男性_低头垂"),
    ("angry-1", "32岁中国男性_瞪眼怒视"),
    ("angry-2", "26岁中国女性_眉尾下压"),
    ("angry-3", "50岁中国男性_双眉紧锁"),
    ("surprised-1", "24岁中国女性_双眼睁大"),
    ("surprised-2", "29岁中国男性_眼睛霍然睁"),
    ("surprised-3", "20岁中国女性_突然睁大双"),
    ("fearful-1", "34岁中国女性_双眉内侧紧"),
    ("fearful-2", "41岁中国男性_眉毛呈八字"),
    ("fearful-3", "23岁中国男性_眉头向内上"),
    ("disgusted-1", "37岁中国男性_鼻子皱起"),
    ("disgusted-2", "31岁中国女性_鼻子微皱"),
    ("disgusted-3", "55岁中国女性_皱鼻"),
    ("neutral-1", "33岁中国男性_面部肌肉放"),
    ("neutral-2", "27岁中国女性_表情平静淡"),
    ("neutral-3", "48岁中国男性_面容平静"),
]
files = glob.glob(os.path.join(D, "*.png"))
used = []
for name, key in MAP:
    hit = [f for f in files if key in os.path.basename(f)]
    assert len(hit) == 1, (key, hit)
    src = hit[0]
    im = Image.open(src).convert("RGB")
    w, h = im.size
    s = 720 / max(w, h)
    im = im.resize((int(w * s), int(h * s)), Image.LANCZOS)
    out = os.path.join(D, name + ".jpg")
    im.save(out, "JPEG", quality=88, optimize=True)
    used.append(src)
    os.remove(src)

cells = [Image.open(os.path.join(D, n + ".jpg")).resize((240, 240)) for n, _ in MAP]
sheet = Image.new("RGB", (240 * 7, 240 * 3), "white")
for i, c in enumerate(cells):
    sheet.paste(c, ((i // 3) * 240, (i % 3) * 240))
sheet.save(os.path.join(D, "_sheet.jpg"), quality=82)
print("done", len(used), "remaining png:", len(glob.glob(os.path.join(D, "*.png"))))
print("total size MB", round(sum(os.path.getsize(os.path.join(D, f)) for f in os.listdir(D)) / 1e6, 2))
