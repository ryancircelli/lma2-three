#!/usr/bin/env python3
"""Fast in-process screen grabs of the private Xvfb display (never :0).

    xgrab.py OUTDIR FRAMES X Y W H [min-interval-s]

Grabs FRAMES crops back to back via Pillow's XCB grabber, keeps them in memory,
then writes OUTDIR/fNNNN.png and times.txt. Far faster than one `import`
process per frame. Used by tools/wine-surface.sh (tools/xgrab.py is a separate, lower-level grabber).
"""
import os
import sys
import time

from PIL import ImageGrab

out, n, x, y, w, h = sys.argv[1], int(sys.argv[2]), *map(int, sys.argv[3:7])
gap = float(sys.argv[7]) if len(sys.argv) > 7 else 0.0
disp = os.environ["DISPLAY"]
if disp in (":0", ":0.0"):
    sys.exit("refusing DISPLAY=:0 (WSLg draws on the Windows desktop)")
frames, times = [], []
for i in range(n):
    t = time.time()
    frames.append(ImageGrab.grab(bbox=(x, y, x + w, y + h), xdisplay=disp))
    times.append(t)
    if gap:
        time.sleep(max(0.0, gap - (time.time() - t)))
os.makedirs(out, exist_ok=True)
for i, im in enumerate(frames):
    im.convert("RGB").save(os.path.join(out, f"f{i:04d}.png"))
with open(os.path.join(out, "times.txt"), "w") as f:
    f.write("\n".join(f"{t:.6f}" for t in times) + "\n")
