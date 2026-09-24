// Bulk motion of small bright sprites (bubbles) between rendered frames, by
// 2-D cross-correlation of the "brighter than background" image - robust where
// the sprites are too dense to track one by one.
//
//   deno run --allow-read --allow-run tools/flow.ts <seqdir> X,Y,W,H [--lags 1,2,3,4] [--thresh 10] [--off X,Y] [--list]
//
// --list prints every pair at the first lag, flagging pairs that straddle a
// SIGSTOP from wine-burst.sh LMA2_STALL (stalls.txt).
//
// For every pair of rendered frames k, k+lag it finds the integer shift
// (dx, dy) maximising the correlation of the region, then reports dy against
// the pair's time difference. A time-based animation gives dy proportional to
// dt (intercept ~0); a per-frame one gives dy proportional to the frame lag.

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { boolean: ["list"], string: ["lags", "thresh", "off"], default: { lags: "1,2,3,4,6", thresh: "10", off: "0,0" } });
const dir = String(args._[0]);
const [OX, OY] = args.off.split(",").map(Number);
const [RX, RY, W, H] = String(args._[1]).split(",").map(Number);
const lags = args.lags.split(",").map(Number), THRESH = Number(args.thresh);
const [CX, CY] = [RX - OX, RY - OY];

// Optional SIGSTOP times written by wine-burst.sh LMA2_STALL.
const stalls = await Deno.readTextFile(`${dir}/stalls.txt`).then((s) => s.trim().split("\n").map(Number)).catch(() => [] as number[]);
const names: string[] = [];
for await (const e of Deno.readDir(dir)) if (/^f\d+\.png$/.test(e.name)) names.push(e.name);
names.sort();
const times = (await Deno.readTextFile(`${dir}/times.txt`)).trim().split("\n").map(Number);

// Load with a margin so shifted windows stay inside.
const M = 40;
const LW = W + 2 * M, LH = H + 2 * M;
async function luma(path: string): Promise<Uint8Array> {
  const out = await new Deno.Command("convert", {
    args: [path, "-crop", `${LW}x${LH}+${CX - M}+${CY - M}`, "+repage", "-background", "black", "-extent", `${LW}x${LH}`,
      "-colorspace", "gray", "-depth", "8", "gray:-"],
    stdout: "piped",
  }).output();
  return out.stdout;
}
const frames: { t: number; g: Uint8Array; i: number }[] = [];
let prev: Uint8Array | null = null;
for (let i = 0; i < names.length; i++) {
  const g = await luma(`${dir}/${names[i]}`);
  if (prev && g.every((v, k) => v === prev![k])) continue;
  frames.push({ t: times[i], g, i });
  prev = g;
}
// Per-pixel median background.
const bg = new Uint8Array(LW * LH);
const col = new Uint8Array(frames.length);
for (let p = 0; p < LW * LH; p++) {
  for (let k = 0; k < frames.length; k++) col[k] = frames[k].g[p];
  col.sort();
  bg[p] = col[col.length >> 1];
}
const ex = frames.map((f) => {
  const e = new Float32Array(LW * LH);
  for (let p = 0; p < e.length; p++) e[p] = Math.max(0, f.g[p] - bg[p] - THRESH);
  return e;
});

function best(a: Float32Array, b: Float32Array): { dx: number; dy: number; score: number } {
  let bestS = -1, bdx = 0, bdy = 0;
  for (let dy = -M; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      let s = 0, na = 0, nb = 0;
      for (let y = M; y < M + H; y++) {
        const ra = y * LW, rb = (y + dy) * LW + dx;
        for (let x = M; x < M + W; x++) {
          const va = a[ra + x], vb = b[rb + x];
          s += va * vb, na += va * va, nb += vb * vb;
        }
      }
      const score = s / Math.sqrt(na * nb + 1e-9);
      if (score > bestS) (bestS = score), (bdx = dx), (bdy = dy);
    }
  }
  return { dx: bdx, dy: bdy, score: bestS };
}

console.log(`${frames.length} rendered frames; region ${W}x${H}+${RX}+${RY}`);
const rows: { lag: number; dt: number; dy: number; dx: number; score: number }[] = [];
for (const lag of lags) {
  for (let k = 0; k + lag < frames.length; k += Math.max(1, Math.floor(lag / 2))) {
    const r = best(ex[k], ex[k + lag]);
    if (r.score < 0.2) continue;
    rows.push({ lag, dt: frames[k + lag].t - frames[k].t, dy: -r.dy, dx: r.dx, score: r.score });
    if (args.list && lag === lags[0]) {
      const ta = frames[k].t, tb = frames[k + lag].t;
      const st = stalls.filter((s) => s > ta - 0.05 && s < tb).length ? "  <- stall (SIGSTOP) in between" : "";
      console.log(`t=${(ta - frames[0].t).toFixed(2)} dt=${(tb - ta).toFixed(3)} rise=${-r.dy}px dx=${r.dx} score=${r.score.toFixed(2)}${st}`);
    }
  }
}
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}
for (const lag of lags) {
  const r = rows.filter((q) => q.lag === lag);
  if (!r.length) continue;
  console.log(`lag ${lag}: n=${r.length} dt median ${median(r.map((q) => q.dt)).toFixed(3)}s  rise median ${median(r.map((q) => q.dy))}px ` +
    `-> ${(median(r.map((q) => q.dy / q.dt))).toFixed(1)} px/s  dx median ${median(r.map((q) => q.dx))}  score ${median(r.map((q) => q.score)).toFixed(2)}`);
}
// Least squares dy = a + v*dt over all pairs.
const n = rows.length, mt = rows.reduce((s, q) => s + q.dt, 0) / n, my = rows.reduce((s, q) => s + q.dy, 0) / n;
const v = rows.reduce((s, q) => s + (q.dt - mt) * (q.dy - my), 0) / rows.reduce((s, q) => s + (q.dt - mt) ** 2, 0);
console.log(`fit: rise = ${(my - v * mt).toFixed(2)}px + ${v.toFixed(1)} px/s * dt   (n=${n})`);
// Same fit against frame lag, to compare.
const ml = rows.reduce((s, q) => s + q.lag, 0) / n;
const vl = rows.reduce((s, q) => s + (q.lag - ml) * (q.dy - my), 0) / rows.reduce((s, q) => s + (q.lag - ml) ** 2, 0);
const res = (f: (q: typeof rows[0]) => number) => Math.sqrt(rows.reduce((s, q) => s + (q.dy - f(q)) ** 2, 0) / n);
console.log(`residual rms: vs dt ${res((q) => my + v * (q.dt - mt)).toFixed(2)}px, vs frame lag ${res((q) => my + vl * (q.lag - ml)).toFixed(2)}px`);
