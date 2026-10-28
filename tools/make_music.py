#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地曲库合成器：生成 12 首旋律情绪特征可控的器乐片段 (MP3)"""
import numpy as np, lameenc, json, os

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "music")
os.makedirs(OUT, exist_ok=True)

MAJ = [0, 2, 4, 5, 7, 9, 11]
MIN = [0, 2, 3, 5, 7, 8, 10]
DOR = [0, 2, 3, 5, 7, 9, 10]
PHR = [0, 1, 3, 5, 7, 8, 10]
LYD = [0, 2, 4, 6, 7, 9, 11]
SCALES = dict(major=MAJ, minor=MIN, dorian=DOR, phrygian=PHR, lydian=LYD)
CHORDS_MAJ = [[0, 4, 7], [5, 9, 12], [7, 11, 14], [2, 5, 9]]
CHORDS_MIN = [[0, 3, 7], [5, 8, 12], [7, 10, 14], [3, 5, 8]]


def midi2f(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def adsr(n, a=0.01, d=0.1, s=0.6, r=0.2, sr=SR):
    a_n = max(1, int(a * sr)); d_n = max(1, int(d * sr)); r_n = max(1, int(r * sr))
    s_idx = np.arange(n)
    env = np.ones(n) * s
    env[:min(a_n, n)] = np.linspace(0, 1, min(a_n, n))
    end_d = min(a_n + d_n, n)
    if end_d > a_n:
        env[a_n:end_d] = np.linspace(1, s, end_d - a_n)
    if n > r_n:
        env[-r_n:] *= np.linspace(1, 0, r_n)
    return env


def osc(kind, freq, dur, vib=0.0, detune=0.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = freq * (1 + detune) * (1 + vib * np.sin(2 * np.pi * 5.2 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    if kind == "sine":
        return np.sin(ph)
    if kind == "triangle":
        return 2 / np.pi * np.arcsin(np.sin(ph))
    if kind == "saw":
        return 2 * ((ph / (2 * np.pi)) % 1.0) - 1
    if kind == "square":
        return np.sign(np.sin(ph))
    return np.sin(ph)


def place(buf, sig, start):
    i = int(start * SR)
    if i >= len(buf):
        return
    k = min(len(sig), len(buf) - i)
    buf[i:i + k] += sig[:k]


def note(buf, midi, start, dur, kind, gain, vib=0, detune=0, a=0.01, d=0.12, s=0.65, r=0.25):
    sig = osc(kind, midi2f(midi), dur, vib, detune) * adsr(int(dur * SR), a, d, s, r) * gain
    place(buf, sig, start)


def kick(dur=0.32, gain=0.9):
    n = int(dur * SR); t = np.arange(n) / SR
    f = 120 * np.exp(-t * 22) + 45
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 8) * gain


def snare(gain=0.5):
    n = int(0.22 * SR); t = np.arange(n) / SR
    noise = np.random.RandomState(7).randn(n)
    noise = np.convolve(noise, np.ones(4) / 4, "same")
    return (noise * 0.7 + np.sin(2 * np.pi * 190 * t) * 0.3) * np.exp(-t * 22) * gain


def hat(gain=0.22, dur=0.06):
    n = int(dur * SR); t = np.arange(n) / SR
    noise = np.random.RandomState(3).randn(n)
    noise = np.diff(noise, prepend=0)
    return noise * np.exp(-t * 70) * gain * 0.35


def render(cfg):
    bpm = cfg["bpm"]; beat = 60.0 / bpm; bars = cfg["bars"]; scale = SCALES[cfg["scale"]]
    root = cfg["root"]; total = bars * 4 * beat + 1.2
    buf = np.zeros(int(total * SR))
    rng = np.random.RandomState(cfg.get("seed", 1))
    chords = CHORDS_MIN if cfg["scale"] in ("minor", "phrygian") else CHORDS_MAJ
    div = cfg.get("div", 2)  # 每拍分割数
    step = beat / div

    for bar in range(bars):
        t0 = bar * 4 * beat
        ch = chords[bar % len(chords)]
        # --- Pad / 和声 ---
        if cfg["pad"]:
            for iv in ch:
                for dtn in (-0.002, 0.002):
                    note(buf, root + iv, t0, 4 * beat, cfg["padwave"], cfg["padgain"], 0.002, dtn,
                         a=0.08, d=0.3, s=0.7, r=0.5)
        # --- Bass ---
        for b in range(4):
            bt = t0 + b * beat
            if cfg["bass"]:
                note(buf, root - 24 + ch[0] + (0 if b % 2 == 0 else 0), bt, beat * 0.9,
                     "triangle" if cfg["basswave"] is None else cfg["basswave"], cfg["bassgain"],
                     a=0.005, d=0.08, s=0.8, r=0.12)
        # --- 旋律（68% 和弦内音 + 32% 级进经过音，保证调性清晰） ---
        steps = 4 * div
        for st in range(steps):
            if rng.rand() > cfg["density"]:
                continue
            if rng.rand() < 0.68:
                deg = rng.choice(ch) + 12 * rng.choice([0, 1] if cfg.get("register_hi") else [0, 0, 1])
            else:
                deg = rng.choice(scale) + 12 * rng.choice([0, 0, 1, 1, 2] if cfg.get("register_hi") else [0, 0, 1])
            st_t = t0 + st * step
            ln = step * rng.choice([0.9, 1.8, 2.6])
            note(buf, root + deg + cfg["lead_oct"], st_t, ln, cfg["lead"], cfg["leadgain"],
                 cfg.get("vib", 0.0), a=cfg.get("attack", 0.005), d=0.1, s=0.6, r=0.15)
        # --- 鼓 ---
        if cfg["drums"]:
            for b in range(4):
                bt = t0 + b * beat
                place(buf, kick(gain=cfg["drums"]), bt)          # 底鼓每拍, 强化节拍层
                if b % 2 == 1:
                    place(buf, snare(cfg["drums"] * 0.7), bt)
                for h in range(2 if div <= 2 else div):
                    place(buf, hat(cfg["drums"] * 0.5), bt + h * beat / (2 if div <= 2 else div))

    buf = np.tanh(buf * cfg.get("drive", 1.0)) * 0.9
    # 简易反馈延迟（空间感）
    if cfg.get("delay", 0) > 0:
        d = int(beat * 0.75 * SR)
        wet = np.zeros_like(buf)
        wet[d:] = buf[:-d] * cfg["delay"]
        wet[d * 2:] += buf[:-d * 2] * cfg["delay"] ** 2
        buf = buf + wet * 0.5
    peak = np.max(np.abs(buf)) or 1
    buf = buf / peak * 0.92
    # 淡入淡出
    f = int(0.02 * SR); buf[:f] *= np.linspace(0, 1, f); buf[-f * 8:] *= np.linspace(1, 0, f * 8)
    return (buf * 32767).astype(np.int16)


def save_pcm16(pcm, name):
    enc = lameenc.Encoder()
    enc.set_bit_rate(128); enc.set_in_sample_rate(SR); enc.set_channels(1); enc.set_quality(3)
    data = enc.encode(pcm.tobytes()) + enc.flush()
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(bytes(data))


TRACKS = [
    # id, 中文名, 情绪目标, 配置
    ("happy_sunrise", "晨光舞步", "happy",
     dict(bpm=126, bars=8, scale="major", root=60, lead="triangle", lead_oct=12, leadgain=0.30,
          pad="triangle", padwave="triangle", padgain=0.10, bass=True, bassgain=0.22, basswave="triangle",
          drums=0.55, density=0.55, div=2, register_hi=True, delay=0.25, seed=11)),
    ("happy_party", "彩色派对", "happy",
     dict(bpm=140, bars=8, scale="major", root=62, lead="square", lead_oct=12, leadgain=0.18,
          pad=None, padgain=0, bass=True, bassgain=0.20, basswave="saw",
          drums=0.62, density=0.72, div=4, register_hi=True, four=True, delay=0.2, seed=12)),
    ("sad_rain", "雨落窗前", "sad",
     dict(bpm=64, bars=7, scale="minor", root=57, lead="sine", lead_oct=0, leadgain=0.32,
          pad="sine", padwave="sine", padgain=0.14, bass=True, bassgain=0.18, basswave="sine",
          drums=0.18, density=0.30, div=2, vib=0.006, delay=0.3, seed=21)),
    ("sad_letter", "旧信笺", "sad",
     dict(bpm=58, bars=6, scale="minor", root=62, lead="triangle", lead_oct=0, leadgain=0.28,
          pad="sine", padwave="sine", padgain=0.15, bass=True, bassgain=0.16, basswave="sine",
          drums=0.18, density=0.25, div=2, vib=0.008, delay=0.35, seed=22)),
    ("angry_storm", "风暴引擎", "angry",
     dict(bpm=168, bars=8, scale="phrygian", root=52, lead="square", lead_oct=12, leadgain=0.16,
          pad="saw", padwave="saw", padgain=0.08, bass=True, bassgain=0.26, basswave="saw",
          drums=0.75, density=0.8, div=4, four=True, drive=1.9, seed=31)),
    ("angry_engine", "熔炉", "angry",
     dict(bpm=176, bars=8, scale="minor", root=55, lead="saw", lead_oct=12, leadgain=0.15,
          pad="saw", padwave="saw", padgain=0.09, bass=True, bassgain=0.28, basswave="square",
          drums=0.8, density=0.85, div=4, four=True, drive=2.2, seed=32)),
    ("calm_lake", "湖面无风", "calm",
     dict(bpm=68, bars=6, scale="major", root=53, lead="sine", lead_oct=12, leadgain=0.22,
          pad="sine", padwave="sine", padgain=0.16, bass=True, bassgain=0.14, basswave="sine",
          drums=0.18, density=0.22, div=2, delay=0.3, seed=41)),
    ("calm_cloud", "云上漫步", "calm",
     dict(bpm=72, bars=6, scale="lydian", root=60, lead="triangle", lead_oct=0, leadgain=0.24,
          pad="triangle", padwave="triangle", padgain=0.14, bass=True, bassgain=0.15, basswave="sine",
          drums=0.18, density=0.28, div=2, delay=0.28, seed=42)),
    ("surprised_spark", "闪光瞬间", "surprised",
     dict(bpm=152, bars=7, scale="major", root=64, lead="square", lead_oct=12, leadgain=0.16,
          pad=None, padgain=0, bass=True, bassgain=0.18, basswave="triangle",
          drums=0.5, density=0.8, div=4, register_hi=True, attack=0.002, seed=51)),
    ("fearful_whisper", "暗夜低语", "fearful",
     dict(bpm=96, bars=7, scale="minor", root=59, lead="sine", lead_oct=12, leadgain=0.20,
          pad="saw", padwave="sine", padgain=0.10, bass=True, bassgain=0.20, basswave="sine",
          drums=0.3, density=0.38, div=4, vib=0.03, delay=0.4, seed=61)),
    ("fearful_shadow", "悬空", "fearful",
     dict(bpm=104, bars=7, scale="phrygian", root=61, lead="triangle", lead_oct=12, leadgain=0.18,
          pad="saw", padwave="triangle", padgain=0.11, bass=True, bassgain=0.22, basswave="sine",
          drums=0.35, density=0.45, div=4, vib=0.035, delay=0.42, seed=62)),
    ("disgusted_rust", "锈迹", "disgusted",
     dict(bpm=88, bars=6, scale="phrygian", root=49, lead="saw", lead_oct=0, leadgain=0.16,
          pad="saw", padwave="saw", padgain=0.09, bass=True, bassgain=0.24, basswave="saw",
          drums=0.28, density=0.40, div=2, drive=1.5, seed=71)),
    ("neutral_walk", "平铺直叙", "neutral",
     dict(bpm=92, bars=6, scale="major", root=60, lead="triangle", lead_oct=0, leadgain=0.26,
          pad="triangle", padwave="triangle", padgain=0.11, bass=True, bassgain=0.18, basswave="triangle",
          drums=0.32, density=0.45, div=2, seed=81)),
]

if __name__ == "__main__":
    meta = []
    for tid, title, emo, cfg in TRACKS:
        pcm = render(cfg)
        save_pcm16(pcm, tid + ".mp3")
        meta.append(dict(id=tid, title=title, target=emo, file="music/%s.mp3" % tid,
                         bpm=cfg["bpm"], scale=cfg["scale"], root=cfg["root"]))
        print("rendered", tid, round(len(pcm) / SR, 1), "s")
    with open(os.path.join(OUT, "library.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("total tracks:", len(meta))
