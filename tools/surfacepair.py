"""Pixel error of the surface band for frame-matched pairs (open water, rows 0-127):
RMS of (ref - ours) vs RMS of the surface signal itself, and vs a mismatched pair.
  python3 tools/surfacepair.py REFBASE OURSBASE ref:ours ..."""
import sys
from collections import Counter
from PIL import Image
rb = Image.open(sys.argv[1]).convert("RGB"); ob = Image.open(sys.argv[2]).convert("RGB")
rbp, obp = rb.load(), ob.load()
rc = Counter(rb.crop((0, 0, 1024, 128)).getdata()).most_common(1)[0][0]
pts = [(x, y) for y in range(128) for x in range(0, 1024) if rbp[x, y] == rc and obp[x, y] == rc]
def dr(p, b, x, y):
    return p[x, y][0] - b[x, y][0]
for pair in sys.argv[3:]:
    a, b = pair.split(":")
    rp = Image.open(a).convert("RGB").load(); op = Image.open(b).convert("RGB").load()
    e = s = 0.0
    for x, y in pts:
        r, o = dr(rp, rbp, x, y), dr(op, obp, x, y)
        e += (r - o) ** 2; s += r * r
    n = len(pts)
    print(f"{a.split('/')[-2]}/{a.split('/')[-1]} vs {b.split('/')[-1]}: RMS err {(e / n) ** 0.5:5.2f}  RMS signal {(s / n) ** 0.5:5.2f}  ({n} px)")
