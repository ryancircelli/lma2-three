// Track the creatures through a frame sequence (reference or ours) and report
// motion statistics: apparent sizes, speeds, screen extents, turn-arounds.
//
//   deno run -A tools/track.ts <bgdir> <seqdir> [--thr 28] [--min 60] [--json out.json]
//
// <bgdir> is a fish-free sequence of the same scene (tools/wine-ref.sh sequence
// ... <fish=0>): its per-pixel median is the backdrop and its per-pixel spread is
// the noise floor (water surface ripple, bubbles), so only creatures stand out.
// Frames are f*.png / f*.ppm, timed by times.txt (unix seconds, one per frame).
// Both dirs must be the same size/crop.
//
// Blobs are linked frame to frame by nearest neighbour, gated by distance,
// area and colour. Statistics are per track, then pooled.

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, {
  string: ["thr", "min", "json", "gate", "ox", "oy"],
  default: { thr: "28", min: "60", gate: "260", ox: "0", oy: "0" },
});
const [bgDir, seqDir] = args._.map(String);
const THR = Number(args.thr), MIN_AREA = Number(args.min), GATE = Number(args.gate);
/** Offset of the crop within the 1024x768 screen (so reported y is screen y). */
const OX = Number(args.ox), OY = Number(args.oy);

interface Img {
  w: number;
  h: number;
  px: Uint8Array;
}

async function load(path: string): Promise<Img> {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const out = await new Deno.Command("convert", { args: [path, "-depth", "8", "rgb:-"], stdout: "piped" }).output();
  return { w, h, px: out.stdout };
}

async function frames(dir: string): Promise<{ files: string[]; times: number[] }> {
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) if (/^f\d+\.(png|ppm)$/.test(e.name)) files.push(`${dir}/${e.name}`);
  files.sort();
  let times: number[] = [];
  try {
    times = (await Deno.readTextFile(`${dir}/times.txt`)).trim().split("\n").map(Number);
  } catch { /* ours: no times */ }
  return { files, times };
}

// --- backdrop model ------------------------------------------------------------
const bg = await frames(bgDir);
const bgImgs = await Promise.all(bg.files.slice(0, 25).map(load));
const { w: W, h: H } = bgImgs[0];
const N = W * H;
const median = new Uint8Array(N * 3), noise = new Uint8Array(N);
{
  const vals = new Uint8Array(bgImgs.length);
  for (let i = 0; i < N * 3; i++) {
    for (let k = 0; k < bgImgs.length; k++) vals[k] = bgImgs[k].px[i];
    vals.sort();
    median[i] = vals[vals.length >> 1];
  }
  for (let p = 0; p < N; p++) {
    let m = 0;
    for (const im of bgImgs) {
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(im.px[p * 3 + c] - median[p * 3 + c]));
    }
    noise[p] = Math.min(255, m);
  }
}

// --- blobs ---------------------------------------------------------------------
export interface Blob {
  f: number;
  t: number;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  rgb: [number, number, number];
}

function blobs(img: Img, f: number, t: number): Blob[] {
  const mask = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(img.px[p * 3 + c] - median[p * 3 + c]));
    if (d > Math.max(THR, noise[p] + THR / 2)) mask[p] = 1;
  }
  // Dilate by 2 px for labelling only: fish that match the water in places
  // (blue tang on blue) should not fall apart.
  const dil = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) dil[yy * W + xx] = 1;
        }
      }
    }
  }
  const label = new Int32Array(N).fill(-1);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (!dil[s] || label[s] >= 0) continue;
    const id = out.length;
    let area = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p / W) | 0;
      if (mask[p]) {
        area++;
        sx += x;
        sy += y;
        r += img.px[p * 3];
        g += img.px[p * 3 + 1];
        b += img.px[p * 3 + 2];
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= N || label[q] >= 0 || !dil[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        label[q] = id;
        stack.push(q);
      }
    }
    out.push({
      f,
      t,
      cx: sx / Math.max(area, 1) + OX,
      cy: sy / Math.max(area, 1) + OY,
      x0: x0 + OX,
      y0: y0 + OY,
      x1: x1 + OX,
      y1: y1 + OY,
      area,
      rgb: [r / Math.max(area, 1), g / Math.max(area, 1), b / Math.max(area, 1)].map(Math.round) as [number, number, number],
    });
  }
  return out.filter((b) => b.area >= MIN_AREA);
}

const seq = await frames(seqDir);
const all: Blob[][] = [];
for (let f = 0; f < seq.files.length; f++) {
  const t = seq.times.length ? seq.times[f] - seq.times[0] : f / 30;
  all.push(blobs(await load(seq.files[f]), f, t));
}

// --- linking -------------------------------------------------------------------
const colourDist = (a: Blob, b: Blob) => Math.hypot(a.rgb[0] - b.rgb[0], a.rgb[1] - b.rgb[1], a.rgb[2] - b.rgb[2]);
const tracks: Blob[][] = [];
let open: Blob[][] = [];
for (const fr of all) {
  const pairs: [number, number, number][] = [];
  open.forEach((tr, i) => {
    const last = tr[tr.length - 1];
    const dt = Math.max(fr[0]?.t - last.t, 1e-3);
    fr.forEach((b, j) => {
      const d = Math.hypot(b.cx - last.cx, b.cy - last.cy);
      const ar = Math.max(b.area, last.area) / Math.min(b.area, last.area);
      if (d > GATE * dt + 20 || ar > 2.2 || colourDist(b, last) > 60) return;
      pairs.push([d + 20 * ar + colourDist(b, last), i, j]);
    });
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const usedT = new Set<number>(), usedB = new Set<number>();
  const next: Blob[][] = [];
  for (const [, i, j] of pairs) {
    if (usedT.has(i) || usedB.has(j)) continue;
    usedT.add(i);
    usedB.add(j);
    open[i].push(fr[j]);
    next.push(open[i]);
  }
  open.forEach((tr, i) => usedT.has(i) || tracks.push(tr));
  fr.forEach((b, j) => usedB.has(j) || next.push([b]));
  open = next;
}
tracks.push(...open);

// --- statistics ----------------------------------------------------------------
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const fmt = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "-");

const good = tracks.filter((tr) => tr.length >= 4 && tr[tr.length - 1].t - tr[0].t >= 1.5);
const speeds: number[] = [], vxs: number[] = [], vys: number[] = [], slopes: number[] = [];
let flips = 0, trackTime = 0;
for (const tr of good) {
  trackTime += tr[tr.length - 1].t - tr[0].t;
  // velocity over ~1 s baselines
  let lastSign = 0;
  for (let i = 0; i < tr.length; i++) {
    let j = i + 1;
    while (j < tr.length && tr[j].t - tr[i].t < 0.9) j++;
    if (j >= tr.length) break;
    const dt = tr[j].t - tr[i].t;
    const vx = (tr[j].cx - tr[i].cx) / dt, vy = (tr[j].cy - tr[i].cy) / dt;
    speeds.push(Math.hypot(vx, vy));
    vxs.push(Math.abs(vx));
    vys.push(Math.abs(vy));
    if (Math.abs(vx) > 8) slopes.push(Math.abs(vy / vx));
    const sign = Math.abs(vx) > 15 ? Math.sign(vx) : 0;
    if (sign && lastSign && sign !== lastSign) flips++;
    if (sign) lastSign = sign;
  }
}
const allB = all.flat();
const hs = allB.map((b) => b.y1 - b.y0 + 1), ws = allB.map((b) => b.x1 - b.x0 + 1);
const summary = {
  frames: all.length,
  seconds: all.length ? all[all.length - 1][0]?.t ?? 0 : 0,
  blobsPerFrame: allB.length / Math.max(all.length, 1),
  tracks: good.length,
  trackSeconds: trackTime,
  speed: { p10: q(speeds, 0.1), p50: q(speeds, 0.5), p90: q(speeds, 0.9) },
  absVx: { p50: q(vxs, 0.5), p90: q(vxs, 0.9) },
  absVy: { p50: q(vys, 0.5), p90: q(vys, 0.9) },
  climbSlope: { p50: q(slopes, 0.5), p90: q(slopes, 0.9) },
  turnaroundsPerTrackMinute: flips / Math.max(trackTime / 60, 1e-9),
  cy: { p02: q(allB.map((b) => b.cy), 0.02), p50: q(allB.map((b) => b.cy), 0.5), p98: q(allB.map((b) => b.cy), 0.98) },
  top: q(allB.map((b) => b.y0), 0.01),
  bottom: q(allB.map((b) => b.y1), 0.99),
  cx: { p02: q(allB.map((b) => b.cx), 0.02), p98: q(allB.map((b) => b.cx), 0.98) },
  width: { p10: q(ws, 0.1), p50: q(ws, 0.5), p90: q(ws, 0.9), max: q(ws, 1) },
  height: { p10: q(hs, 0.1), p50: q(hs, 0.5), p90: q(hs, 0.9), max: q(hs, 1) },
};
console.log(
  `frames ${summary.frames} over ${fmt(summary.seconds, 1)}s, ${fmt(summary.blobsPerFrame, 1)} blobs/frame, ${good.length} tracks (${
    fmt(trackTime)
  } track-s)`,
);
console.log(
  `speed px/s p10/50/90 ${fmt(summary.speed.p10)}/${fmt(summary.speed.p50)}/${fmt(summary.speed.p90)}  |vx| p50/90 ${fmt(summary.absVx.p50)}/${
    fmt(summary.absVx.p90)
  }  |vy| p50/90 ${fmt(summary.absVy.p50)}/${fmt(summary.absVy.p90)}  |vy/vx| p50/90 ${fmt(summary.climbSlope.p50, 2)}/${fmt(summary.climbSlope.p90, 2)}`,
);
console.log(`turn-arounds per track-minute ${fmt(summary.turnaroundsPerTrackMinute, 1)}`);
console.log(
  `screen: centre y p02/50/98 ${fmt(summary.cy.p02)}/${fmt(summary.cy.p50)}/${fmt(summary.cy.p98)}, top ${summary.top}, bottom ${summary.bottom}, centre x p02/98 ${
    fmt(summary.cx.p02)
  }/${fmt(summary.cx.p98)}`,
);
console.log(
  `blob w p10/50/90/max ${summary.width.p10}/${summary.width.p50}/${summary.width.p90}/${summary.width.max}  h ${summary.height.p10}/${summary.height.p50}/${summary.height.p90}/${summary.height.max}`,
);
if (args.json) await Deno.writeTextFile(args.json, JSON.stringify({ summary, tracks: good, frames: all }, null, 0));
