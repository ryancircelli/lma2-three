#!/usr/bin/env python3
"""Fairness diagnostics for track JSONs (tools/track.ts, tools/probe-track.ts):
does the pipeline see both sides alike? Pools any number of files per label.

  trackfair.py label=a.json+b.json ...

Per label: frame interval p50, blobs/frame, blob area and width p50, tracks,
track duration p50/p90, share of track time in tracks >= 10 s, turn-arounds per
track-minute (all tracks, and only tracks >= 10 s: a turn needs two ~1 s
velocity windows of opposite sign, so short, broken tracks hide turns), and
|vy/vx| p50.
"""
import json, sys


def q(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, max(0, round(p * (len(v) - 1))))] if v else float("nan")


def turns(trs):
    flips, tt = 0, 0.0
    slopes = []
    for tr in trs:
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
            if abs(vx) > 8:
                slopes.append(abs(vy / vx))
            s = (vx > 15) - (vx < -15)
            if s and last and s != last:
                flips += 1
            if s:
                last = s
    return flips / max(tt / 60, 1e-9), tt, slopes


print(f"{'label':22} {'dt':>5} {'blobs/f':>7} {'area':>6} {'w':>4} {'tracks':>6} {'dur p50/p90':>12} {'>=10s':>6} {'turns':>6} {'turns>=10s':>10} {'|vy/vx|':>7}")
for arg in sys.argv[1:]:
    label, files = arg.split("=", 1)
    frames, tracks = [], []
    for f in files.split("+"):
        d = json.load(open(f))
        frames += d["frames"]
        tracks += [tr for tr in d["tracks"] if len(tr) >= 4 and tr[-1]["t"] - tr[0]["t"] >= 1.5]
    ts = [fr[0]["t"] for fr in frames if fr]
    dts = [b - a for a, b in zip(ts, ts[1:]) if b > a]
    blobs = [b for fr in frames for b in fr]
    durs = [tr[-1]["t"] - tr[0]["t"] for tr in tracks]
    long = [tr for tr in tracks if tr[-1]["t"] - tr[0]["t"] >= 10]
    t_all, tt, slopes = turns(tracks)
    t_long, ttl, _ = turns(long)
    print(f"{label:22} {q(dts,.5):5.2f} {len(blobs)/max(len(frames),1):7.1f} {q([b['area'] for b in blobs],.5):6.0f} {q([b['x1']-b['x0']+1 for b in blobs],.5):4.0f} "
          f"{len(tracks):6d} {q(durs,.5):5.1f}/{q(durs,.9):5.1f} {100*ttl/max(tt,1e-9):5.0f}% {t_all:6.2f} {t_long:10.2f} {q(slopes,.5):7.2f}")
