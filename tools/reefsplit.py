#!/usr/bin/env python3
"""Where are creatures SEEN relative to the reef silhouette? For track.ts JSON
of full-scene sequences (ours or reference, same pipeline).

  reefsplit.py SCENE TRACKS.json [TRACKS2.json ...]

The reef line is the scene's `height` polyline in screen px (tools/floorline.ts
prints it; hard-coded below). A fish blob whose centre is BELOW that line must
be in front of the foreground painting (behind it the painting hides it), so
the share of blob detections below the line measures how often fish are seen
crossing in front of the reef. Blobs near the floor that could be the crab or
sea star (centre y > 690, width < 120) are dropped, and only tracks that
move > 60 px (x span + y span) count, which drops swaying plants, bubbles and
surface flicker.
"""
import json, sys

HEIGHT = {
    "1": [(-3, 210), (230, 210), (429, 219), (542, 279), (675, 181), (854, 156), (1015, 184)],
    "2": [(1, 77), (248, 76), (381, 158), (532, 136), (680, 176), (829, 76), (1014, 58)],
    "3": [(5, 43), (222, 85), (357, 217), (547, 277), (645, 315), (796, 255), (821, 195), (1013, 148)],
}


def line(pts, x):
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


s = sys.argv[1]
for path in sys.argv[2:]:
    d = json.load(open(path))
    n = below = 0
    deep = 0
    bands = [0] * 8
    moving = []
    for tr in d["tracks"]:
        xs = [b["cx"] for b in tr]; ys = [b["cy"] for b in tr]
        if max(xs) - min(xs) + max(ys) - min(ys) > 60:
            moving.append(tr)
    for fr in moving:
        for b in fr:
            w = b["x1"] - b["x0"] + 1
            if b["cy"] > 690 and w < 120:
                continue
            if b["area"] < 60:
                continue
            n += 1
            r = line(HEIGHT[s], b["cx"])
            if b["cy"] > r:
                below += 1
                if b["cy"] > r + 150:
                    deep += 1
            bands[min(7, int(b["cy"] // 96))] += 1
    print(f"{path}: blobs {n}; below reef line {100*below/n:.1f}%  (>150 px below: {100*deep/n:.1f}%); "
          f"by 96-px screen band: " + " ".join(f"{100*c/n:.0f}" for c in bands))
