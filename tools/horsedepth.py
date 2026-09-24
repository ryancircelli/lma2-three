#!/usr/bin/env python3
"""Sea horse depth by zone, reference tracks vs our probe dumps.

  horsedepth.py ref:label=tracks.json ... ours:label=probe.json ...

A sea horse's drawn size tells its zone (depth scale 0.6..1.0): blob/box height
>= NEAR_H px = near zone (mode 0, floor at screen ~627 in scene 1), below =
far zone (floor ~468). For each track (reference: track.ts tracks; ours: one
creature slot), prints near-zone seconds and the deepest centre y reached,
then pooled: near-zone horse-seconds, how many near-zone episodes reach
y > 571 / > 600, and the deepest centre overall.
"""
import json, sys

NEAR_H = 92


def episodes_ref(d):
    out = []
    for tr in d["tracks"]:
        near = [b for b in tr if b["y1"] - b["y0"] + 1 >= NEAR_H and b["area"] > 200]
        if len(near) < 3:
            continue
        out.append((near[-1]["t"] - near[0]["t"], max(b["cy"] for b in near)))
    return out


def episodes_ours(d):
    slots = {}
    for t, lst in d["samples"]:
        for i, c in enumerate(lst):
            if d["species"][c[0]] != "sea-horse":
                continue
            h = c[4] - c[2]
            if h >= NEAR_H:
                slots.setdefault(i, []).append((t, (c[2] + c[4]) / 2))
    return [(v[-1][0] - v[0][0], max(y for _, y in v)) for v in slots.values() if len(v) >= 3]


for arg in sys.argv[1:]:
    kind, rest = arg.split(":", 1)
    label, files = rest.split("=", 1)
    eps = []
    for f in files.split("+"):
        d = json.load(open(f))
        eps += episodes_ref(d) if kind == "ref" else episodes_ours(d)
    secs = sum(e[0] for e in eps)
    deep = [e[1] for e in eps]
    print(f"{label:28} near-zone episodes {len(eps):3d}  horse-s {secs:7.0f}  deepest cy {max(deep) if deep else float('nan'):5.0f}  "
          f"episodes reaching >571: {sum(y > 571 for y in deep)}  >600: {sum(y > 600 for y in deep)}  "
          f"per 100 near-horse-s >600: {100 * sum(y > 600 for y in deep) / max(secs, 1e-9):.2f}")
