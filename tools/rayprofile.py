#!/usr/bin/env python3
"""Horizontal profile of the light rays: mean added red (rays are additive grey;
blue is saturated in open water) over a row band, between a frame WITH rays
and one WITHOUT (same scene, static layers). Prints ray peak x positions and
heights, and optionally the whole profile.

    rayprofile.py with.png without.png [y0 y1] [--full]
"""
import sys
from PIL import Image

a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
y0, y1 = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (20, 60)
W = a.width
pa, pb = a.load(), b.load()
prof = []
for x in range(W):
    s = 0
    for y in range(y0, y1):
        s += (pa[x, y][0] - pb[x, y][0]) + (pa[x, y][1] - pb[x, y][1])
    prof.append(s / (2 * (y1 - y0)))
# smooth and find local maxima above 1.5 levels
sm = [sum(prof[max(0, i - 6):i + 7]) / len(prof[max(0, i - 6):i + 7]) for i in range(W)]
peaks = [i for i in range(8, W - 8) if sm[i] > 1.5 and sm[i] == max(sm[i - 8:i + 9])]
print("peaks (x: added level):", " ".join("%d:%.1f" % (i, sm[i]) for i in peaks))
if "--full" in sys.argv:
    print(" ".join("%.1f" % v for v in sm[::8]))
