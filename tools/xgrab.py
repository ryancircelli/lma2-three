#!/usr/bin/env python3
"""Fast timed screen grabs of $DISPLAY (a private Xvfb - never :0) via Xlib.

ImageMagick `import` costs ~0.7 s per frame (process start + encode); this
grabs in a few ms, so fish can be tracked frame to frame.

  xgrab.py OUTDIR FRAMES INTERVAL_S [WxH+X+Y] [PID] [SECONDS]

Writes OUTDIR/fNNNN.ppm and OUTDIR/times.txt (unix time of each grab).
Stops early if PID (the screensaver) exits.

The app renders only ~3-12 fps under Wine's software GL, so with a short
INTERVAL most grabs repeat the last render. With SECONDS given, the grabber
polls for that long and keeps only NEW renders (up to FRAMES), each timed by
its first appearance - i.e. render times to within one poll.
"""
import ctypes, ctypes.util, os, sys, time

outdir, frames, interval = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
geom = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
pid = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else None
seconds = float(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] else None
if os.environ.get("DISPLAY", "") in (":0", ":0.0"):
    sys.exit("refusing DISPLAY=:0 (that is WSLg, the real desktop)")

x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")


class XImage(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
                ("format", ctypes.c_int), ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int),
                ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int),
                ("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int)]


x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XGetImage.restype = ctypes.POINTER(XImage)
x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                          ctypes.c_ulong, ctypes.c_int]
x11.XFree.argtypes = [ctypes.c_void_p]

dpy = x11.XOpenDisplay(None)
if not dpy:
    sys.exit("cannot open display")
root = x11.XDefaultRootWindow(dpy)
w, h, x0, y0 = 1024, 768, 0, 0
if geom:
    wh, x0, y0 = geom.split("+")[0], int(geom.split("+")[1]), int(geom.split("+")[2])
    w, h = map(int, wh.split("x"))

os.makedirs(outdir, exist_ok=True)
times = []
width = len(str(frames - 1))
nxt = start = time.time()
last = None
i = 0
while i < frames and (seconds is None or time.time() - start < seconds):
    if pid and not os.path.exists(f"/proc/{pid}"):
        sys.exit("screensaver exited early")
    t = time.time()
    img = x11.XGetImage(dpy, root, x0, y0, w, h, 0xFFFFFFFF, 2)  # ZPixmap
    im = img.contents
    raw = ctypes.string_at(im.data, im.bytes_per_line * h)
    x11.XFree(im.data)
    x11.XFree(img)
    if seconds is not None:
        if raw == last:
            nxt += interval
            time.sleep(max(0.0, nxt - time.time()))
            continue
        last = raw
    times.append(t)
    if im.bits_per_pixel != 32:
        sys.exit(f"unsupported {im.bits_per_pixel} bpp")
    if im.bytes_per_line != w * 4:
        raw = b"".join(raw[r * im.bytes_per_line:r * im.bytes_per_line + w * 4] for r in range(h))
    rgb = bytearray(w * h * 3)
    rgb[0::3], rgb[1::3], rgb[2::3] = raw[2::4], raw[1::4], raw[0::4]
    with open(f"{outdir}/f{i:0{width}d}.ppm", "wb") as f:
        f.write(b"P6\n%d %d\n255\n" % (w, h))
        f.write(rgb)
    i += 1
    nxt += interval
    time.sleep(max(0.0, nxt - time.time()))
with open(f"{outdir}/times.txt", "w") as f:
    f.write("".join(f"{t:.6f}\n" for t in times))
