#!/usr/bin/env python3
"""Fast burst capture of a screen region from the current X display ($DISPLAY).

    xgrab-burst.py OUTDIR FRAMES INTERVAL_S X Y W H

Keeps one Xlib connection and one XImage (XGetSubImage into it), so a small
crop costs a few ms instead of ImageMagick `import`'s ~0.5 s. Frames are held
in memory and written as OUTDIR/fNNNN.png afterwards, with capture timestamps
(seconds, monotonic-ish wall clock) in OUTDIR/times.txt.

Only ever run this on a private Xvfb display (xvfb-run -a) - never :0.
"""
import ctypes
import ctypes.util
import os
import sys
import time

from PIL import Image


class XImage(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
        ("data", ctypes.c_void_p),
        ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int),
        ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int),
        ("bits_per_pixel", ctypes.c_int),
    ]


def main() -> None:
    outdir, frames, interval = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    x, y, w, h = (int(v) for v in sys.argv[4:8])
    disp = os.environ.get("DISPLAY", "")
    if disp in (":0", ":0.0"):
        sys.exit("refusing to capture DISPLAY=:0 (WSLg = the real desktop)")
    x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11"))
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XGetImage.restype = ctypes.POINTER(XImage)
    x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                              ctypes.c_ulong, ctypes.c_int]
    x11.XGetSubImage.restype = ctypes.POINTER(XImage)
    x11.XGetSubImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                                 ctypes.c_uint, ctypes.c_ulong, ctypes.c_int, ctypes.POINTER(XImage), ctypes.c_int,
                                 ctypes.c_int]
    d = x11.XOpenDisplay(None)
    if not d:
        sys.exit("cannot open display")
    root = x11.XDefaultRootWindow(d)
    ALL_PLANES, ZPIXMAP = 0xFFFFFFFF, 2
    img = x11.XGetImage(d, root, x, y, w, h, ALL_PLANES, ZPIXMAP)
    bpl = img.contents.bytes_per_line
    size = bpl * h
    shots = []
    t_next = time.time()
    for _ in range(frames):
        x11.XGetSubImage(d, root, x, y, w, h, ALL_PLANES, ZPIXMAP, img, 0, 0)
        shots.append((time.time(), ctypes.string_at(img.contents.data, size)))
        t_next += interval
        delay = t_next - time.time()
        if delay > 0:
            time.sleep(delay)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "times.txt"), "w") as f:
        for i, (t, raw) in enumerate(shots):
            f.write(f"{t:.4f}\n")
            Image.frombuffer("RGB", (w, h), raw, "raw", "BGRX", bpl, 1).save(os.path.join(outdir, f"f{i:04d}.png"))
    print(f"{frames} frames {w}x{h}+{x}+{y} over {shots[-1][0] - shots[0][0]:.2f}s -> {outdir}")


if __name__ == "__main__":
    main()
