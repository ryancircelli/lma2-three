// Motion statistics, side by side, for reference tracks (tools/track.ts --json)
// and our own creatures (a probe dump from Tank.probe(), see below).
//
//   deno run -A tools/motion-stats.ts [--species slug] label=file.json[+file2.json...] ...
//
// A probe dump is {probe: true, species: string[], samples: [t, [[i, x0, y0, x1, y1], ...]][]}
// where i indexes `species` per creature slot (slot order is stable), sampled
// like a capture. Tracks are then known exactly; the statistics are the same
// as track.ts computes for the reference.

import { parseArgs } from "jsr:@std/cli@1/parse-args";

interface Blob {
  t: number;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const args = parseArgs(Deno.args, { string: ["species"] });

function fromProbe(d: { species: string[]; samples: [number, number[][]][] }, only?: string): { frames: Blob[][]; tracks: Blob[][] } {
  const tracks = new Map<number, Blob[]>();
  const frames: Blob[][] = [];
  for (const [t, list] of d.samples) {
    const fr: Blob[] = [];
    list.forEach((c, slot) => {
      const [si, x0, y0, x1, y1] = c;
      if (only && d.species[si] !== only) return;
      // keep what a capture could see: on screen
      if (x1 < 0 || x0 > 1024 || y1 < 0 || y0 > 768) return;
      // clipped to the screen, as a captured silhouette is
      const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(1023, x1), cy1 = Math.min(767, y1);
      const b = { t, cx: (cx0 + cx1) / 2, cy: (cy0 + cy1) / 2, x0: cx0, y0: cy0, x1: cx1, y1: cy1 };
      fr.push(b);
      if (!tracks.has(slot)) tracks.set(slot, []);
      tracks.get(slot)!.push(b);
    });
    frames.push(fr);
  }
  return { frames, tracks: [...tracks.values()] };
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const f0 = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "-");

function stats(frames: Blob[][], tracks: Blob[][]) {
  const good = tracks.filter((tr) => tr.length >= 4 && tr[tr.length - 1].t - tr[0].t >= 1.5);
  const speeds: number[] = [], slopes: number[] = [];
  let flips = 0, trackTime = 0;
  for (const tr of good) {
    trackTime += tr[tr.length - 1].t - tr[0].t;
    let lastSign = 0;
    for (let i = 0; i < tr.length; i++) {
      let j = i + 1;
      while (j < tr.length && tr[j].t - tr[i].t < 0.9) j++;
      if (j >= tr.length) break;
      const dt = tr[j].t - tr[i].t;
      const vx = (tr[j].cx - tr[i].cx) / dt, vy = (tr[j].cy - tr[i].cy) / dt;
      speeds.push(Math.hypot(vx, vy));
      if (Math.abs(vx) > 8) slopes.push(Math.abs(vy / vx));
      const sign = Math.abs(vx) > 15 ? Math.sign(vx) : 0;
      if (sign && lastSign && sign !== lastSign) flips++;
      if (sign) lastSign = sign;
    }
  }
  // grouping (schooling): per frame, the mean pairwise and nearest-neighbour
  // distance between the creatures on screen, and how many are visible
  const pair: number[] = [], nn: number[] = [], vis: number[] = [];
  for (const fr of frames) {
    vis.push(fr.length);
    if (fr.length < 2) continue;
    let sum = 0, k = 0;
    for (let i = 0; i < fr.length; i++) {
      let best = Infinity;
      for (let j = 0; j < fr.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(fr[i].cx - fr[j].cx, fr[i].cy - fr[j].cy);
        best = Math.min(best, d);
        if (j > i) sum += d, k++;
      }
      nn.push(best);
    }
    pair.push(sum / k);
  }
  const all = frames.flat();
  const ws = all.map((b) => b.x1 - b.x0 + 1).filter((w) => w < 400), hs = all.map((b) => b.y1 - b.y0 + 1).filter((h) => h < 400);
  return {
    n: all.length,
    speed50: q(speeds, 0.5),
    speed90: q(speeds, 0.9),
    slope50: q(slopes, 0.5),
    turns: flips / Math.max(trackTime / 60, 1e-9),
    cy02: q(all.map((b) => b.cy), 0.02),
    cy50: q(all.map((b) => b.cy), 0.5),
    cy98: q(all.map((b) => b.cy), 0.98),
    w50: q(ws, 0.5),
    w90: q(ws, 0.9),
    h50: q(hs, 0.5),
    h90: q(hs, 0.9),
    pair50: q(pair, 0.5),
    nn50: q(nn, 0.5),
    vis50: q(vis, 0.5),
  };
}

console.log("label".padEnd(28) + "  blobs  speed p50/p90 px/s  |vy/vx|  turns/min  centre-y p02/p50/p98   width p50/p90  height p50/p90  pair/nn/visible");
for (const a of args._.map(String)) {
  const [label, file] = a.includes("=") ? a.split("=") : [a, a];
  // file1+file2+...: pool several runs
  const frames: Blob[][] = [], tracks: Blob[][] = [];
  for (const one of file.split("+")) {
    const d = JSON.parse(await Deno.readTextFile(one));
    const r = d.probe ? fromProbe(d, args.species) : { frames: d.frames as Blob[][], tracks: d.tracks as Blob[][] };
    frames.push(...r.frames), tracks.push(...r.tracks);
  }
  const s = stats(frames, tracks);
  console.log(
    `${label.padEnd(28)}  ${String(s.n).padStart(5)}  ${f0(s.speed50).padStart(6)}/${f0(s.speed90).padEnd(12)} ${f0(s.slope50, 2).padStart(6)}  ${
      f0(s.turns, 1).padStart(8)
    }  ${f0(s.cy02).padStart(7)}/${f0(s.cy50)}/${f0(s.cy98).padEnd(10)} ${f0(s.w50).padStart(6)}/${f0(s.w90).padEnd(7)} ${f0(s.h50).padStart(6)}/${f0(s.h90).padEnd(6)} ${f0(s.pair50)}/${f0(s.nn50)}/${f0(s.vis50)}`,
  );
}
