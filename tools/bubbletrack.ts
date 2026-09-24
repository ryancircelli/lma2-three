// Detect and track bubbles in a burst captured by tools/wine-burst.sh (or any
// directory of fNNNN.png + times.txt), to measure the original's bubbles:
// how many are alive, where the column is, rise speed vs height, sideways
// wobble, and sprite size vs height.
//
//   deno run --allow-read --allow-run --allow-write tools/bubbletrack.ts <seqdir> [--crop X,Y,W,H] [--off X,Y]
//        [--thresh 18] [--band 40] [--json out.json] [--mask X,Y,W,H;...]
//
// --crop   region of each frame to analyse (default: whole frame)
// --off    screen position of the frame's top-left (if frames are crops already)
// --mask   screen rectangles to ignore (e.g. swaying plants)
//
// Method: consecutive identical captures are collapsed (the app renders slower
// than we capture; the first capture of each rendered frame is kept, with its
// time). Background = per-pixel median over all rendered frames (bubbles move,
// so each pixel is mostly background). A bubble is a connected blob of pixels
// brighter than the background by > thresh (luma). Blobs are linked frame to
// frame by nearest neighbour inside an upward search window, using each
// track's last velocity as the prediction.

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, {
  string: ["crop", "off", "thresh", "band", "json", "mask", "vmax"],
  default: { thresh: "18", band: "40", off: "0,0", vmax: "400" },
});
const dir = String(args._[0]);
const [OX, OY] = args.off.split(",").map(Number);
const THRESH = Number(args.thresh), BAND = Number(args.band), VMAX = Number(args.vmax);
const masks = (args.mask ?? "").split(";").filter(Boolean).map((m) => m.split(",").map(Number));

const names: string[] = [];
for await (const e of Deno.readDir(dir)) if (/^f\d+\.png$/.test(e.name)) names.push(e.name);
names.sort();
const times = (await Deno.readTextFile(`${dir}/times.txt`)).trim().split("\n").map(Number);

const id = await new Deno.Command("identify", { args: ["-format", "%w %h", `${dir}/${names[0]}`], stdout: "piped" }).output();
const [FW, FH] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
const [CX, CY, W, H] = args.crop ? args.crop.split(",").map(Number) : [0, 0, FW, FH];

async function luma(path: string): Promise<Uint8Array> {
  const out = await new Deno.Command("convert", {
    args: [path, "-crop", `${W}x${H}+${CX}+${CY}`, "+repage", "-colorspace", "gray", "-depth", "8", "gray:-"],
    stdout: "piped",
  }).output();
  return out.stdout;
}

// --- load, collapsing repeated captures of one rendered frame ----------------
const frames: { t: number; g: Uint8Array; name: string }[] = [];
let prev: Uint8Array | null = null;
for (let i = 0; i < names.length; i++) {
  const g = await luma(`${dir}/${names[i]}`);
  if (prev && g.every((v, k) => v === prev![k])) continue;
  frames.push({ t: times[i], g, name: names[i] });
  prev = g;
}
const t0 = frames[0].t;
const dts = frames.slice(1).map((f, i) => f.t - frames[i].t);
console.log(`${names.length} captures -> ${frames.length} rendered frames over ${(frames.at(-1)!.t - t0).toFixed(2)}s ` +
  `(~${((frames.length - 1) / (frames.at(-1)!.t - t0)).toFixed(1)} fps; median dt ${median(dts).toFixed(3)}s)`);

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

// --- background --------------------------------------------------------------
const bg = new Uint8Array(W * H);
{
  const col = new Uint8Array(frames.length);
  for (let p = 0; p < W * H; p++) {
    for (let k = 0; k < frames.length; k++) col[k] = frames[k].g[p];
    col.sort();
    bg[p] = col[col.length >> 1];
  }
}

// --- detection -----------------------------------------------------------------
interface Blob {
  x: number; // screen centroid
  y: number;
  w: number; // bbox
  h: number;
  area: number;
  peak: number; // max luma above background
}

function masked(sx: number, sy: number): boolean {
  return masks.some(([x, y, w, h]) => sx >= x && sx < x + w && sy >= y && sy < y + h);
}

function detect(g: Uint8Array): Blob[] {
  const on = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    if (g[p] - bg[p] > THRESH && !masked(OX + CX + (p % W), OY + CY + Math.floor(p / W))) on[p] = 1;
  }
  const seen = new Uint8Array(W * H);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (!on[p] || seen[p]) continue;
    let n = 0, sx = 0, sy = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, peak = 0;
    stack.push(p);
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % W, y = (q / W) | 0;
      n++, sx += x, sy += y;
      x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      peak = Math.max(peak, g[q] - bg[q]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const r = yy * W + xx;
          if (on[r] && !seen[r]) (seen[r] = 1), stack.push(r);
        }
      }
    }
    // Merge nothing; a bubble's ring is one blob at 8-connectivity.
    blobs.push({ x: OX + CX + sx / n, y: OY + CY + sy / n, w: x1 - x0 + 1, h: y1 - y0 + 1, area: n, peak });
  }
  return blobs;
}

const detections = frames.map((f) => detect(f.g));

// --- per-frame counts and spatial statistics ------------------------------------
const counts = detections.map((d) => d.length);
console.log(`blobs per frame: median ${median(counts)}, min ${Math.min(...counts)}, max ${Math.max(...counts)}`);
const all = detections.flat();
const ys = all.map((b) => b.y);
console.log(`blob y range: ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} (p2 ${pct(ys, 0.02).toFixed(0)}, p98 ${pct(ys, 0.98).toFixed(0)})`);

function pct(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function mean(a: number[]): number {
  return a.reduce((s, v) => s + v, 0) / a.length;
}
function sd(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

// --- tracking -------------------------------------------------------------------
interface Track {
  pts: { t: number; x: number; y: number; w: number; h: number; peak: number }[];
  vx: number;
  vy: number;
}
const tracks: Track[] = [];
let live: Track[] = [];
for (let k = 0; k < frames.length; k++) {
  const blobs = detections[k];
  const t = frames[k].t - t0;
  const used = new Set<number>();
  const next: Track[] = [];
  if (k > 0) {
    const dt = frames[k].t - frames[k - 1].t;
    // Greedy by distance to prediction, over all (track, blob) candidate pairs.
    const pairs: [number, number, number][] = [];
    live.forEach((tr, i) => {
      const last = tr.pts.at(-1)!;
      const hasV = tr.pts.length > 1;
      const px = last.x + (hasV ? tr.vx * dt : 0), py = last.y + (hasV ? tr.vy * dt : -60 * dt);
      const rx = hasV ? 4 : 6, ry = hasV ? 5 + 20 * dt : VMAX * dt;
      blobs.forEach((b, j) => {
        const dx = b.x - px, dy = b.y - py;
        if (Math.abs(dx) > rx || Math.abs(dy) > ry || b.y > last.y + 2) return;
        pairs.push([dx * dx + dy * dy, i, j]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const tUsed = new Set<number>();
    for (const [, i, j] of pairs) {
      if (tUsed.has(i) || used.has(j)) continue;
      tUsed.add(i), used.add(j);
      const tr = live[i], b = blobs[j], last = tr.pts.at(-1)!;
      const vx = (b.x - last.x) / dt, vy = (b.y - last.y) / dt;
      tr.vx = tr.pts.length > 1 ? 0.5 * tr.vx + 0.5 * vx : vx;
      tr.vy = tr.pts.length > 1 ? 0.5 * tr.vy + 0.5 * vy : vy;
      tr.pts.push({ t, x: b.x, y: b.y, w: b.w, h: b.h, peak: b.peak });
      next.push(tr);
    }
  }
  blobs.forEach((b, j) => {
    if (used.has(j)) return;
    const tr: Track = { pts: [{ t, x: b.x, y: b.y, w: b.w, h: b.h, peak: b.peak }], vx: 0, vy: 0 };
    tracks.push(tr);
    next.push(tr);
  });
  live = next;
}

const good = tracks.filter((tr) => tr.pts.length >= 6 && tr.pts[0].y - tr.pts.at(-1)!.y > 20);
console.log(`tracks: ${tracks.length} total, ${good.length} with >=6 points and >20px rise`);

// Rise speed and size by height band, from track segments (least-squares slope
// over a 5-point window, so per-frame centroid noise averages out).
const bands = new Map<number, { vy: number[]; vx: number[]; w: number[]; n: number; x: number[] }>();
const band = (y: number) => Math.floor(y / BAND) * BAND;
for (const tr of good) {
  const p = tr.pts;
  for (let i = 2; i + 2 < p.length; i++) {
    const win = p.slice(i - 2, i + 3);
    const tm = mean(win.map((q) => q.t)), ym = mean(win.map((q) => q.y)), xm = mean(win.map((q) => q.x));
    const stt = win.reduce((s, q) => s + (q.t - tm) ** 2, 0);
    const vy = win.reduce((s, q) => s + (q.t - tm) * (q.y - ym), 0) / stt;
    const vx = win.reduce((s, q) => s + (q.t - tm) * (q.x - xm), 0) / stt;
    const b = band(p[i].y);
    if (!bands.has(b)) bands.set(b, { vy: [], vx: [], w: [], n: 0, x: [] });
    const e = bands.get(b)!;
    e.vy.push(-vy), e.vx.push(vx), e.w.push(p[i].w), e.x.push(p[i].x);
  }
}
// Density: blobs per band per frame.
for (const d of detections) for (const b of d) {
  const k = band(b.y);
  if (!bands.has(k)) bands.set(k, { vy: [], vx: [], w: [], n: 0, x: [] });
  bands.get(k)!.n++;
}
console.log("\n  y band   | blobs/frame | x mean  x sd  x p5..p95 | rise px/s (median, p10..p90) | |vx| median | bbox w median (p10..p90)");
for (const k of [...bands.keys()].sort((a, b) => a - b)) {
  const e = bands.get(k)!;
  const xs = detections.flat().filter((b) => band(b.y) === k).map((b) => b.x);
  const vy = e.vy.length ? `${median(e.vy).toFixed(0).padStart(4)} (${pct(e.vy, 0.1).toFixed(0)}..${pct(e.vy, 0.9).toFixed(0)})` : "  -";
  const vx = e.vx.length ? median(e.vx.map(Math.abs)).toFixed(1) : "-";
  const ws = detections.flat().filter((b) => band(b.y) === k).map((b) => b.w);
  console.log(
    `${String(k).padStart(4)}-${String(k + BAND).padEnd(4)} | ${(e.n / frames.length).toFixed(2).padStart(11)} | ` +
      `${mean(xs).toFixed(0).padStart(6)} ${sd(xs).toFixed(1).padStart(5)}  ${pct(xs, 0.05).toFixed(0)}..${pct(xs, 0.95).toFixed(0)} | ` +
      `${vy.padEnd(28)} | ${String(vx).padStart(5)} | ${median(ws)} (${pct(ws, 0.1)}..${pct(ws, 0.9)}) n=${e.vy.length}`,
  );
}

// Per-track horizontal wobble: residual of x after removing a linear drift.
const wob: { amp: number; period: number; len: number; vy: number }[] = [];
for (const tr of good.filter((t) => t.pts.length >= 15)) {
  const p = tr.pts;
  const tm = mean(p.map((q) => q.t)), xm = mean(p.map((q) => q.x));
  const stt = p.reduce((s, q) => s + (q.t - tm) ** 2, 0);
  const slope = p.reduce((s, q) => s + (q.t - tm) * (q.x - xm), 0) / stt;
  const r = p.map((q) => q.x - xm - slope * (q.t - tm));
  // Zero crossings of the smoothed residual -> half periods.
  const sm = r.map((_, i) => mean(r.slice(Math.max(0, i - 1), i + 2)));
  const zc: number[] = [];
  for (let i = 1; i < sm.length; i++) if (sm[i - 1] * sm[i] < 0) zc.push(p[i].t);
  const period = zc.length >= 3 ? 2 * (zc.at(-1)! - zc[0]) / (zc.length - 1) : NaN;
  const vy = -(p.at(-1)!.y - p[0].y) / (p.at(-1)!.t - p[0].t);
  wob.push({ amp: (pct(r, 0.95) - pct(r, 0.05)) / 2, period, len: p.length, vy });
}
if (wob.length) {
  const periods = wob.map((w) => w.period).filter((v) => !isNaN(v));
  console.log(
    `\nwobble over ${wob.length} tracks (>=15 pts): x residual half-range median ${median(wob.map((w) => w.amp)).toFixed(2)}px ` +
      `(p90 ${pct(wob.map((w) => w.amp), 0.9).toFixed(2)}), period median ${periods.length ? median(periods).toFixed(2) : "-"}s ` +
      `(n=${periods.length}); track mean rise ${median(wob.map((w) => w.vy)).toFixed(0)} px/s`,
  );
}
// Where do tracks begin and end? (births low = emitter; deaths = where they vanish)
const births = good.map((t) => t.pts[0].y), deaths = good.map((t) => t.pts.at(-1)!.y);
console.log(`track starts y: p10 ${pct(births, 0.1).toFixed(0)} median ${median(births).toFixed(0)} p90 ${pct(births, 0.9).toFixed(0)}`);
console.log(`track ends   y: p10 ${pct(deaths, 0.1).toFixed(0)} median ${median(deaths).toFixed(0)} p90 ${pct(deaths, 0.9).toFixed(0)}`);
const bx = good.map((t) => t.pts[0].x);
console.log(`track starts x: p10 ${pct(bx, 0.1).toFixed(0)} median ${median(bx).toFixed(0)} p90 ${pct(bx, 0.9).toFixed(0)}`);

if (args.json) {
  await Deno.writeTextFile(args.json, JSON.stringify({ frames: frames.map((f) => f.t - t0), files: frames.map((f) => f.name), detections, tracks: good.map((t) => t.pts) }));
  console.log(`wrote ${args.json}`);
}
