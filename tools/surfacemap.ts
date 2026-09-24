// Recover how the original maps the caustics texture onto the screen in the
// water surface band, from reference frames alone.
//
// The surface mesh (common/watersurface.X) is a grid whose rows each lie at one
// (y, z): under any camera without roll each mesh row projects to a horizontal
// screen line, u runs linearly across it, and the texture repeats in u. So:
//   1. each screen row of the surface is PERIODIC in x - its period is the
//      screen width of one texture repeat at that row (perspective => varies);
//   2. folding a row by that period gives one texture row; matching it against
//      every row of every caustics frame gives v(row) and the frame shown.
//
//   deno run --allow-read --allow-run tools/surfacemap.ts --base BASE.png [--rows 130] [--x0 140 --x1 880]
//        [--period P | --fit] FRAME.png...
//
// --fit: report the autocorrelation period per row (step 1) only.

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, {
  string: ["base", "rows", "x0", "x1", "period", "assets", "step"],
  boolean: ["fit", "mirror", "quiet"],
  default: { rows: "130", x0: "140", x1: "880", assets: "assets/common", step: "1" },
});
const ROWS = Number(args.rows), X0 = Number(args.x0), X1 = Number(args.x1), STEP = Number(args.step);

async function rgb(path: string, crop?: string): Promise<{ w: number; h: number; px: Uint8Array }> {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const out = await new Deno.Command("convert", {
    args: [path, ...(crop ? ["-crop", crop, "+repage"] : []), "-depth", "8", "rgb:-"],
    stdout: "piped",
  }).output();
  return { w, h, px: out.stdout };
}

const base = await rgb(args.base!);
const W = base.w;
const clear = clearColour(base.px);
const isOpen = (x: number, y: number) => {
  const i = (y * W + x) * 3;
  return base.px[i] === clear[0] && base.px[i + 1] === clear[1] && base.px[i + 2] === clear[2];
};

/** The open-water clear colour: the most common colour of the baseline (scene 1: 0,138,255). */
export function clearColour(px: Uint8Array): [number, number, number] {
  const counts = new Map<number, number>();
  for (let i = 0; i < px.length; i += 3) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0, bk = 0;
  for (const [k, n] of counts) if (n > best) (best = n), (bk = k);
  return [bk >> 16, (bk >> 8) & 255, bk & 255];
}

function rowSignal(img: { px: Uint8Array }, y: number): Float32Array {
  const s = new Float32Array(W).fill(NaN);
  for (let x = 0; x < W; x++) if (isOpen(x, y)) s[x] = img.px[(y * W + x) * 3 + 1] - base.px[(y * W + x) * 3 + 1];
  return s;
}

/** Normalised autocorrelation of a row over [X0, X1) at a (fractional) lag. */
function autocorr(s: Float32Array, lag: number): number {
  let m = 0, n = 0;
  for (let x = X0; x < X1; x++) if (!isNaN(s[x])) (m += s[x]), n++;
  m /= n;
  let num = 0, da = 0, db = 0;
  const L = Math.floor(lag), f = lag - L;
  for (let x = X0; x + L + 1 < X1; x++) {
    const a = s[x], b0 = s[x + L], b1 = s[x + L + 1];
    if (isNaN(a) || isNaN(b0) || isNaN(b1)) continue;
    const b = b0 * (1 - f) + b1 * f;
    num += (a - m) * (b - m), da += (a - m) ** 2, db += (b - m) ** 2;
  }
  return num / Math.sqrt(da * db);
}

const frames = await Promise.all(args._.map((f) => rgb(String(f), `${W}x${ROWS}+0+0`)));

if (args.fit) {
  // best period per row (lags 60..600), averaged over frames by summing the autocorrelation curves
  console.log("row  period  corr");
  for (let y = 0; y < ROWS; y += STEP) {
    let best = -Infinity, bp = 0;
    const curve: number[] = [];
    for (let lag = 60; lag <= 600; lag++) {
      let s = 0;
      for (const f of frames) s += autocorr(rowSignal(f, y), lag);
      curve.push(s / frames.length);
    }
    curve.forEach((c, i) => c > best && ((best = c), (bp = 60 + i)));
    console.log(`${String(y).padStart(3)}  ${String(bp).padStart(5)}  ${best.toFixed(3)}`);
  }
  Deno.exit(0);
}

// --- step 2: fold each row by its period and match against texture rows ------
/** Sub-pixel period of one row: best integer lag, halved while half still fits, then refined. */
function period(s: Float32Array): number {
  let best = -Infinity, bp = 0;
  for (let lag = 60; lag <= 600; lag++) {
    const c = autocorr(s, lag);
    if (c > best) (best = c), (bp = lag);
  }
  while (bp / 2 >= 60 && autocorr(s, Math.round(bp / 2)) > 0.9 * best) bp = Math.round(bp / 2);
  let fine = bp;
  best = -Infinity;
  for (let lag = bp - 1.5; lag <= bp + 1.5; lag += 0.05) {
    const c = autocorr(s, lag);
    if (c > best) (best = c), (fine = lag);
  }
  return fine;
}
let P = Number(args.period);
const tex: Float32Array[] = []; // 29 frames x 64x64, green channel
for (let k = 1; k <= 29; k++) {
  const t = await rgb(`${args.assets}/caustics_${String(k).padStart(2, "0")}.png`);
  const g = new Float32Array(64 * 64);
  for (let i = 0; i < 64 * 64; i++) g[i] = t.px[i * 3 + 1];
  tex.push(g);
}

function fold(s: Float32Array): Float32Array | null {
  const bins = new Float32Array(64), n = new Float32Array(64);
  for (let x = X0; x < X1; x++) {
    if (isNaN(s[x])) continue;
    const u = ((((x - W / 2) / P) % 1) + 1) % 1; // phase origin at screen centre
    const b = Math.floor(u * 64) % 64;
    bins[b] += s[x], n[b]++;
  }
  for (let b = 0; b < 64; b++) {
    if (!n[b]) return null;
    bins[b] /= n[b];
  }
  return bins;
}

function zn(a: ArrayLike<number>): Float32Array {
  const o = new Float32Array(a.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let s = 0;
  for (let i = 0; i < a.length; i++) (o[i] = a[i] - m), (s += o[i] ** 2);
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < a.length; i++) o[i] /= s;
  return o;
}

// normalised texture rows, both orientations
const texRows: Float32Array[][] = tex.map((g) => {
  const rows: Float32Array[] = [];
  for (let r = 0; r < 64; r++) {
    const row = g.slice(r * 64, r * 64 + 64);
    rows.push(zn(args.mirror ? row.reverse() : row));
  }
  return rows;
});

frames.forEach((f, fi) => {
  // Per row: its period and folded profile; then, for each texture frame k, the
  // best (v, shift) per row. The whole surface shows one frame at a time, so
  // the k with the best total correlation is the frame on screen.
  const rows: { y: number; P: number; a: Float32Array }[] = [];
  for (let y = 0; y < ROWS; y += STEP) {
    const sig = rowSignal(f, y);
    if (!args.period) {
      let n = 0;
      for (let x = X0; x < X1; x++) if (!isNaN(sig[x]) && sig[x] !== 0) n++;
      if (n < 100) continue;
      P = period(sig);
    }
    const folded = fold(sig);
    if (folded) rows.push({ y, P, a: zn(folded) });
  }
  const perK = texRows.map((tk) =>
    rows.map(({ a }) => {
      let best = -Infinity, bv = 0, bs = 0;
      for (let v = 0; v < 64; v++) {
        const t = tk[v];
        for (let sh = 0; sh < 64; sh++) {
          let c = 0;
          for (let i = 0; i < 64; i++) c += a[i] * t[(i + sh) & 63];
          if (c > best) (best = c), (bv = v), (bs = sh);
        }
      }
      return { c: best, v: bv, sh: bs };
    })
  );
  const totals = perK.map((r) => r.reduce((s, x) => s + x.c, 0) / r.length);
  const order = totals.map((t, k) => [t, k]).sort((p, q) => q[0] - p[0]);
  const k = order[0][1];
  console.log(
    `# ${args._[fi]}: frame k=${k + 1} mean corr ${order[0][0].toFixed(3)}; runner-up k=${order[1][1] + 1} ${
      order[1][0].toFixed(3)
    }; median ${order[14][0].toFixed(3)}`,
  );
  if (args.quiet) return;
  console.log("row  period   v  shift  corr");
  rows.forEach((r, i) => {
    const m = perK[k][i];
    console.log(`${String(r.y).padStart(3)}  ${r.P.toFixed(2).padStart(6)}  ${String(m.v).padStart(2)} ${String(m.sh).padStart(5)}  ${m.c.toFixed(3)}`);
  });
});
