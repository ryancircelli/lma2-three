#!/usr/bin/env python3
"""Fit the original's clock to a reference sequence of light rays, then check
the spec (docs/original-logic.md 5.6): with the app time t known, every ray's
position AND its flicker brightness are predicted - compare both.

    rayfit.py SEQDIR NORAYS.png minX maxX minY maxY [row]

SEQDIR: frames with rays (fNNNN.png + times.txt); NORAYS.png: same scene without.
Screen mapping from section 1: eye x = 0, view = 0.98 x bbox, 1024x768.
"""
import math, os, sys
from PIL import Image

seq, norays = sys.argv[1], sys.argv[2]
minX, maxX, minY, maxY = (float(v) for v in sys.argv[3:7])
row = int(sys.argv[7]) if len(sys.argv) > 7 else 40
W, H = maxX - minX, maxY - minY
cy = minY + H / 2
sx, sy = 1024 / (0.98 * W), 768 / (0.98 * H)
names = sorted(f for f in os.listdir(seq) if f.startswith("f") and f.endswith(".png"))
times = [float(l) for l in open(os.path.join(seq, "times.txt"))]
b = Image.open(norays).convert("RGB").load()

def profile(path):
    a = Image.open(path).convert("RGB").load()
    p = []
    for x in range(1024):
        s = 0
        for y in range(row - 4, row + 5):
            s += (a[x, y][0] - b[x, y][0]) + (a[x, y][1] - b[x, y][1])
        p.append(s / 18)
    return [sum(p[max(0, i - 5):i + 6]) / len(p[max(0, i - 5):i + 6]) for i in range(1024)]

obs = []
for n, t in zip(names, times):
    pr = profile(os.path.join(seq, n))
    peaks = [(i, pr[i]) for i in range(10, 1014) if pr[i] > 3 and pr[i] == max(pr[i - 10:i + 11])]
    obs.append((t - times[0], peaks))

Yrow = cy + (384 - row) / sy

def rays(t):
    out = []
    for i in range(9):
        th = math.radians(i * 40) + t / 55
        phi = 0.5 * math.sin(th)
        tx, ty = (maxX - 100) * math.sin(th), maxY + 150 - 40 * math.cos(th)
        L = 1200 * math.cos(math.radians(6))
        if ty - Yrow > L * math.cos(phi):
            continue  # the ray ends above this row
        X = tx + (ty - Yrow) * math.tan(phi)
        g = math.floor(51 * abs(math.cos(2 * t + th / 2)))
        out.append((512 + X * sx, g))
    return out

def cost(t0):
    c = 0
    for dt, peaks in obs:
        pred = [x for x, g in rays(t0 + dt)]
        for x, v in peaks:
            c += min([min(abs(x - p), 60) for p in pred] or [60])
    return c

best = min((cost(t0 / 10), t0 / 10) for t0 in range(0, 4000))
t0 = best[1]
print("best app time at first frame: %.1f s (mean peak miss %.1f px)" % (t0, best[0] / sum(len(p) for _, p in obs)))
# brightness check: observed peak height vs predicted grey, for matched peaks
pairs = []
for dt, peaks in obs:
    pred = rays(t0 + dt)
    for x, v in peaks:
        px, g = min(pred, key=lambda r: abs(r[0] - x))
        if abs(px - x) < 25:
            pairs.append((g, v, x, px))
n = len(pairs)
mg, mv = sum(p[0] for p in pairs) / n, sum(p[1] for p in pairs) / n
cov = sum((p[0] - mg) * (p[1] - mv) for p in pairs)
r = cov / math.sqrt(sum((p[0] - mg) ** 2 for p in pairs) * sum((p[1] - mv) ** 2 for p in pairs))
print("matched peaks %d; |x error| median %.1f px; corr(predicted grey, observed height) = %.2f" % (
    n, sorted(abs(p[2] - p[3]) for p in pairs)[n // 2], r))
for dt, peaks in obs[::8]:
    print("t=%.1f obs %s | pred %s" % (t0 + dt, " ".join("%d:%.0f" % p for p in peaks),
                                      " ".join("%d:%d" % (x, g) for x, g in rays(t0 + dt) if -50 < x < 1074)))
