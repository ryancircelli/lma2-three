#!/usr/bin/env python3
"""Motion stats for reference tracks (tools/track.ts --json) selected by colour.

  colortracks.py TRACKS.json [rmin gmin bmax]   (default: yellow 170 150 110)

Same statistics as tools/motion-stats.ts (speed over ~1 s baselines, turn-
arounds when |vx| > 15 px/s flips sign), restricted to tracks whose median
blob colour passes R >= rmin, G >= gmin, B <= bmax.
"""
import json, sys

path = sys.argv[1]
rmin, gmin, bmax = (int(x) for x in sys.argv[2:5]) if len(sys.argv) > 4 else (170, 150, 110)
d = json.load(open(path))


def q(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, round(p * (len(v) - 1)))] if v else float("nan")


sp, ws, hs, cys, slopes = [], [], [], [], []
flips, tt, ntr = 0, 0.0, 0
for tr in d["tracks"]:
    r, g, b = sorted(bl["rgb"] for bl in tr)[len(tr) // 2]
    if not (r >= rmin and g >= gmin and b <= bmax):
        continue
    ntr += 1
    tt += tr[-1]["t"] - tr[0]["t"]
    last = 0
    for i in range(len(tr)):
        j = i + 1
        while j < len(tr) and tr[j]["t"] - tr[i]["t"] < 0.9:
            j += 1
        if j >= len(tr):
            break
        dt = tr[j]["t"] - tr[i]["t"]
        vx = (tr[j]["cx"] - tr[i]["cx"]) / dt
        vy = (tr[j]["cy"] - tr[i]["cy"]) / dt
        sp.append((vx * vx + vy * vy) ** 0.5)
        if abs(vx) > 8:
            slopes.append(abs(vy / vx))
        sg = (vx > 15) - (vx < -15)
        if sg and last and sg != last:
            flips += 1
        if sg:
            last = sg
    ws += [bl["x1"] - bl["x0"] + 1 for bl in tr]
    hs += [bl["y1"] - bl["y0"] + 1 for bl in tr]
    cys += [bl["cy"] for bl in tr]
print(f"{path}: {ntr} tracks, {tt:.0f} track-s; speed p50/p90 {q(sp,.5):.0f}/{q(sp,.9):.0f}; |vy/vx| p50 {q(slopes,.5):.2f}; "
      f"turns/min {flips/max(tt/60,1e-9):.1f}; width p50/p90 {q(ws,.5)}/{q(ws,.9)}; height p50/p90 {q(hs,.5)}/{q(hs,.9)}; "
      f"cy p02/50/98 {q(cys,.02):.0f}/{q(cys,.5):.0f}/{q(cys,.98):.0f}")
