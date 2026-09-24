"""Frame-matched per-row brightness of the water surface, reference vs ours.
  python3 tools/surfaceratio.py REFBASE OURSBASE ref1.png:ours1.png [ref2.png:ours2.png ...]
Each pair shows the same caustics frame. dR = frame - own baseline, over pixels
that are open water (the clear colour) in BOTH baselines; x 150..870."""
import sys
from collections import Counter
from PIL import Image

def load(p):
    im = Image.open(p).convert("RGB")
    return im, im.load()

rb, rbp = load(sys.argv[1]); ob, obp = load(sys.argv[2])
rc = Counter(rb.crop((0, 0, 1024, 140)).getdata()).most_common(1)[0][0]
oc = Counter(ob.crop((0, 0, 1024, 140)).getdata()).most_common(1)[0][0]
print("clear ref", rc, "ours", oc)
H = 132
cols = {y: [x for x in range(150, 870) if rbp[x, y] == rc and obp[x, y] == oc] for y in range(H)}
sr = [0.0] * H; so = [0.0] * H; srg = [0.0] * H; sog = [0.0] * H; n = [0] * H
for pair in sys.argv[3:]:
    a, b = pair.split(":")
    _, rp = load(a); _, op = load(b)
    for y in range(H):
        for x in cols[y]:
            sr[y] += rp[x, y][0] - rbp[x, y][0]; so[y] += op[x, y][0] - obp[x, y][0]
            srg[y] += rp[x, y][1] - rbp[x, y][1]; sog[y] += op[x, y][1] - obp[x, y][1]
            n[y] += 1
print("  y   refR   oursR  ratio   refG  oursG")
tr = to = 0
for y in range(H):
    if n[y]:
        r, o = sr[y] / n[y], so[y] / n[y]
        tr += sr[y]; to += so[y]
        if y % 4 == 0 or y > 118:
            print(f"{y:3d} {r:6.1f} {o:6.1f}  {r / o if o else float('nan'):5.3f}  {srg[y] / n[y]:6.1f} {sog[y] / n[y]:6.1f}")
print(f"overall ratio ref/ours (R): {tr / to:.3f}")
for y0, y1 in [(0, 30), (30, 60), (60, 90), (90, 110), (110, 122), (122, 128)]:
    a = sum(sr[y0:y1]); b = sum(so[y0:y1])
    print(f"  rows {y0}-{y1 - 1}: ratio {a / b if b else float('nan'):.3f}")
