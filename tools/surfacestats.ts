// Statistics of the animated water surface, isolated as (frame - baseline):
// the original draws it additively, so a surface-free baseline (the original
// with <water value="0">, or our render with ?surface=0) subtracts it out.
// Because the surface is animated and random, compare these statistics across
// several frames rather than any single frame pixel for pixel.
//
//   deno run --allow-read --allow-run tools/surfacestats.ts --base BASE.png [--rows 140]
//        [--band 10] [--thresh 24] [--motion] FRAME.png|SEQDIR ...
//
// Frames are the top band of the screen (a crop at y=0) or full frames; BASE
// is cropped to match. Reported:
//   - per-channel mean of the difference (additive blend => R,G rise, B ~0)
//   - per-row-band mean dG and fraction of pixels above --thresh (profile, horizon)
//   - "open water" pixels (base = the clear colour) vs painted pixels: whether
//     the surface shows through the painting (drawn behind) or over it
//   - streak shape per band: horizontal/vertical autocorrelation half-widths
//     of dG, and connected-component widths/heights above --thresh
//   - with --motion and a SEQDIR (times.txt): how often the frame changes, the
//     temporal decorrelation, and the horizontal/vertical drift per band

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, {
  string: ["base", "rows", "band", "thresh", "max"],
  boolean: ["motion"],
  default: { rows: "140", band: "10", thresh: "24", max: "400" },
});
const ROWS = Number(args.rows), BAND = Number(args.band), T = Number(args.thresh);

interface Img {
  w: number;
  h: number;
  px: Uint8Array;
}

async function load(path: string, rows: number): Promise<Img> {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h0] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const h = Math.min(h0, rows);
  const out = await new Deno.Command("convert", {
    args: [path, "-crop", `${w}x${h}+0+0`, "+repage", "-depth", "8", "rgb:-"],
    stdout: "piped",
  }).output();
  return { w, h, px: out.stdout };
}

async function expand(p: string): Promise<{ files: string[]; times: number[] | null }> {
  const st = await Deno.stat(p);
  if (!st.isDirectory) return { files: [p], times: null };
  const files: string[] = [];
  for await (const e of Deno.readDir(p)) if (/^f\d+\.png$/.test(e.name)) files.push(`${p}/${e.name}`);
  files.sort();
  let times: number[] | null = null;
  try {
    times = (await Deno.readTextFile(`${p}/times.txt`)).trim().split("\n").map(Number);
  } catch { /* none */ }
  return { files, times };
}

const base = await load(args.base!, ROWS);
const W = base.w, H = base.h;
const N = W * H;
// Open water: exactly the clear colour (the baseline's most common colour).
const open = new Uint8Array(N);
{
  const counts = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const k = (base.px[i * 3] << 16) | (base.px[i * 3 + 1] << 8) | base.px[i * 3 + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let clear = 0, best = 0;
  for (const [k, n] of counts) if (n > best) (best = n), (clear = k);
  for (let i = 0; i < N; i++) {
    open[i] = ((base.px[i * 3] << 16) | (base.px[i * 3 + 1] << 8) | base.px[i * 3 + 2]) === clear ? 1 : 0;
  }
  console.log(`clear colour ${clear >> 16},${(clear >> 8) & 255},${clear & 255}`);
}

/** dG (and dR, dB) of a frame vs base, as floats. */
function diff(img: Img): { r: Float32Array; g: Float32Array; b: Float32Array } {
  const r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    r[i] = img.px[i * 3] - base.px[i * 3];
    g[i] = img.px[i * 3 + 1] - base.px[i * 3 + 1];
    b[i] = img.px[i * 3 + 2] - base.px[i * 3 + 2];
  }
  return { r, g, b };
}

const inputs = await Promise.all(args._.map((p) => expand(String(p))));
const files = inputs.flatMap((i) => i.files).slice(0, Number(args.max));
const bands = Math.ceil(H / BAND);

const acc = {
  r: 0, g: 0, b: 0, nOpen: 0,
  paintG: 0, nPaint: 0,
  rowG: new Float64Array(H), rowN: new Float64Array(H), rowHi: new Float64Array(H),
  hHalf: new Float64Array(bands), vHalf: new Float64Array(bands), nHalf: new Float64Array(bands),
  compW: [] as number[][], compH: [] as number[][], compArea: 0,
  hist: new Float64Array(256),
};
for (let k = 0; k < bands; k++) (acc.compW[k] = []), (acc.compH[k] = []);

/** Autocorrelation half-width (lag where normalised autocorr first drops below 0.5) along x or y, within one band. */
function halfWidth(g: Float32Array, y0: number, y1: number, dir: "x" | "y"): number {
  let mean = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) if (open[y * W + x]) (mean += g[y * W + x]), n++;
  if (n < 200) return NaN;
  mean /= n;
  const at = (x: number, y: number) => g[y * W + x] - mean;
  const corr = (lag: number) => {
    let s = 0, m = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const x2 = dir === "x" ? x + lag : x, y2 = dir === "y" ? y + lag : y;
        if (x2 >= W || y2 >= H) continue;
        if (!open[y * W + x] || !open[y2 * W + x2]) continue;
        s += at(x, y) * at(x2, y2);
        m++;
      }
    }
    return m ? s / m : 0;
  };
  const c0 = corr(0);
  if (c0 <= 1e-6) return NaN;
  let prev = 1;
  for (let lag = 1; lag < 200; lag++) {
    const c = corr(lag) / c0;
    if (c < 0.5) return lag - 1 + (prev - 0.5) / (prev - c);
    prev = c;
  }
  return 200;
}

const diffs: Float32Array[] = [];
for (const f of files) {
  const img = await load(f, ROWS);
  if (img.w !== W) throw new Error(`${f}: width ${img.w} != base ${W}`);
  const d = diff(img);
  if (args.motion) diffs.push(d.g);
  for (let i = 0; i < img.h * W; i++) {
    const y = Math.floor(i / W);
    if (open[i]) {
      acc.r += d.r[i], acc.g += d.g[i], acc.b += d.b[i], acc.nOpen++;
      acc.rowG[y] += d.g[i], acc.rowN[y]++;
      if (d.g[i] > T) acc.rowHi[y]++;
      acc.hist[Math.max(0, Math.min(255, Math.round(d.g[i])))]++;
    } else (acc.paintG += d.g[i]), acc.nPaint++;
  }
  // autocorrelation shape per band (every frame is costly: sample up to 12 frames)
  if (files.indexOf(f) % Math.max(1, Math.floor(files.length / 12)) === 0) {
    for (let k = 0; k < bands; k++) {
      const y0 = k * BAND, y1 = Math.min(H, y0 + BAND);
      const hx = halfWidth(d.g, y0, y1, "x"), hy = halfWidth(d.g, y0, y1, "y");
      if (!isNaN(hx) && !isNaN(hy)) (acc.hHalf[k] += hx), (acc.vHalf[k] += hy), acc.nHalf[k]++;
    }
  }
  // connected components of dG > T in open water (4-connected)
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  for (let i = 0; i < img.h * W; i++) {
    if (seen[i] || !open[i] || d.g[i] <= T) continue;
    let x0 = W, x1 = -1, y0 = H, y1 = -1, area = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % W, y = (j - x) / W;
      area++;
      x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < img.h - 1 ? j + W : -1]) {
        if (k >= 0 && !seen[k] && open[k] && d.g[k] > T) (seen[k] = 1), stack.push(k);
      }
    }
    if (area < 6) continue;
    const band = Math.min(bands - 1, Math.floor((y0 + y1) / 2 / BAND));
    acc.compW[band].push(x1 - x0 + 1);
    acc.compH[band].push(y1 - y0 + 1);
    acc.compArea += area;
  }
}

const F = files.length;
const med = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : NaN);
const f1 = (v: number) => (isNaN(v) ? "   -" : v.toFixed(1).padStart(6));
console.log(`${F} frames, ${W}x${H}, open-water px/frame ${(acc.nOpen / F).toFixed(0)}`);
console.log(`mean diff in open water: dR ${(acc.r / acc.nOpen).toFixed(2)}  dG ${(acc.g / acc.nOpen).toFixed(2)}  dB ${(acc.b / acc.nOpen).toFixed(2)}`);
console.log(`mean dG over painted px: ${(acc.paintG / Math.max(1, acc.nPaint)).toFixed(2)}  (${(acc.nPaint / F).toFixed(0)} px/frame)`);
const tot = acc.hist.reduce((a, b) => a + b, 0);
const pct = (p: number) => {
  let c = 0;
  for (let v = 0; v < 256; v++) if ((c += acc.hist[v]) >= p * tot) return v;
  return 255;
};
console.log(`dG percentiles (open water, rows<${H}): p50 ${pct(0.5)} p75 ${pct(0.75)} p90 ${pct(0.9)} p95 ${pct(0.95)} p99 ${pct(0.99)} max ${pct(1)}`);
console.log(`\nband     meanG  >T%   acHalfX acHalfY  comps/f  medW  medH`);
let horizon = -1;
for (let y = 0; y < H; y++) if (acc.rowN[y] && acc.rowG[y] / acc.rowN[y] > 1.5) horizon = y;
for (let k = 0; k < bands; k++) {
  const y0 = k * BAND, y1 = Math.min(H, y0 + BAND);
  let g = 0, n = 0, hi = 0;
  for (let y = y0; y < y1; y++) (g += acc.rowG[y]), (n += acc.rowN[y]), (hi += acc.rowHi[y]);
  console.log(
    `${String(y0).padStart(3)}-${String(y1 - 1).padEnd(3)} ${f1(n ? g / n : NaN)} ${f1(n ? (100 * hi) / n : NaN)}  ${
      f1(acc.hHalf[k] / acc.nHalf[k])
    }  ${f1(acc.vHalf[k] / acc.nHalf[k])}  ${f1(acc.compW[k].length / F)} ${f1(med(acc.compW[k]))} ${f1(med(acc.compH[k]))}`,
  );
}
console.log(`last row with mean dG > 1.5: y=${horizon}`);
const rowsOut = [];
for (let y = 0; y < H; y++) rowsOut.push(acc.rowN[y] ? (acc.rowG[y] / acc.rowN[y]).toFixed(1) : "-");
console.log(`per-row mean dG: ${rowsOut.join(" ")}`);

if (args.motion && inputs.length === 1 && inputs[0].times) {
  const times = inputs[0].times.slice(0, F);
  // How often the picture actually changes (the app's frame rate under Wine).
  let changes = 0;
  for (let i = 1; i < F; i++) {
    let s = 0;
    for (let j = 0; j < N; j++) s += Math.abs(diffs[i][j] - diffs[i - 1][j]);
    if (s / N > 0.05) changes++;
  }
  const span = times[F - 1] - times[0];
  console.log(`\nframes grabbed ${F} over ${span.toFixed(2)}s; distinct updates ${changes} (${(changes / span).toFixed(1)}/s)`);
  // temporal correlation of dG vs lag (seconds), over the open water of the top bands
  const mask: number[] = [];
  for (let j = 0; j < N; j++) if (open[j] && Math.floor(j / W) < Math.max(20, horizon)) mask.push(j);
  const corrAt = (a: Float32Array, b: Float32Array) => {
    let ma = 0, mb = 0;
    for (const j of mask) (ma += a[j]), (mb += b[j]);
    ma /= mask.length, mb /= mask.length;
    let s = 0, sa = 0, sb = 0;
    for (const j of mask) (s += (a[j] - ma) * (b[j] - mb)), (sa += (a[j] - ma) ** 2), (sb += (b[j] - mb) ** 2);
    return s / Math.sqrt(sa * sb);
  };
  console.log(`temporal corr of dG vs lag:`);
  for (const lag of [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6]) {
    let s = 0, n = 0;
    for (let i = 0; i < F; i += 3) {
      const k = times.findIndex((t) => t >= times[i] + lag);
      if (k < 0) break;
      s += corrAt(diffs[i], diffs[k]), n++;
    }
    if (n) console.log(`  ${lag.toFixed(2)}s  r=${(s / n).toFixed(3)}  (n=${n})`);
  }
  // drift per band: best (dx, dy) aligning frame i to frame at i+lag
  const LAG = 0.5;
  console.log(`drift over ${LAG}s per band (px/s, x then y; search +-24 x, +-6 y):`);
  for (let k = 0; k < bands; k++) {
    const y0 = k * BAND + 6, y1 = Math.min(H - 6, y0 + BAND);
    if (y1 <= y0) continue;
    const dxs: number[] = [], dys: number[] = [];
    for (let i = 0; i < F; i += 4) {
      const k2 = times.findIndex((t) => t >= times[i] + LAG);
      if (k2 < 0) break;
      const a = diffs[i], b = diffs[k2];
      let best = -Infinity, bx = 0, by = 0;
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -24; dx <= 24; dx++) {
          let s = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = 30; x < W - 30; x += 2) {
              const p = y * W + x, q = (y + dy) * W + x + dx;
              if (open[p] && open[q]) s += a[p] * b[q];
            }
          }
          if (s > best) (best = s), (bx = dx), (by = dy);
        }
      }
      dxs.push(bx / (times[k2] - times[i]));
      dys.push(by / (times[k2] - times[i]));
    }
    if (dxs.length) console.log(`  y ${y0}-${y1}: dx ${f1(med(dxs))}  dy ${f1(med(dys))}`);
  }
}
