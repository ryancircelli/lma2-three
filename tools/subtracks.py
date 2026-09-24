#!/usr/bin/env python3
"""Thin a track.ts JSON to a slower frame rate: keep, per track, only blobs at
least DT seconds after the previous kept one (and frames likewise). Emulates a
slower capture of the same launch when the raw frames are gone.

  subtracks.py IN.json OUT.json DT
"""
import json, sys

src, dst, dt = sys.argv[1], sys.argv[2], float(sys.argv[3])
d = json.load(open(src))
frames, last = [], -1e9
for fr in d["frames"]:
    if fr and fr[0]["t"] - last >= dt - 1e-6:
        frames.append(fr)
        last = fr[0]["t"]
keep_t = {fr[0]["t"] for fr in frames}
tracks = []
for tr in d["tracks"]:
    t2 = [b for b in tr if b["t"] in keep_t]
    if len(t2) >= 4 and t2[-1]["t"] - t2[0]["t"] >= 1.5:
        tracks.append(t2)
json.dump({"tracks": tracks, "frames": frames}, open(dst, "w"))
print(f"{len(d['frames'])} -> {len(frames)} frames, {len(d['tracks'])} -> {len(tracks)} tracks")
