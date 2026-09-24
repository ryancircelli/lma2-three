// Measure how a region moves horizontally over a reference frame sequence:
// for each chosen row band, the shift (vs the first frame) that best aligns it,
// by 1-D cross-correlation. Tells whether billboards sway by shearing (top
// moves, base fixed), sliding (all rows equal), and with what period.
//
//   deno run --allow-read --allow-run tools/sway.ts <seqdir> <x0> <x1> <y,y,...> [--band 12] [--range 40]

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["band", "range"], default: { band: "12", range: "40" } });
const [dir, x0s, x1s, ys] = args._.map(String);
const X0 = Number(x0s), X1 = Number(x1s), BAND = Number(args.band), R = Number(args.range);
const rows = ys.split(",").map(Number);

const times = (await Deno.readTextFile(`${dir}/times.txt`)).trim().split("\n").map(Number);
const frames: string[] = [];
for await (const e of Deno.readDir(dir)) if (/^f\d+\.png$/.test(e.name)) frames.push(e.name);
frames.sort();

async function gray(path: string): Promise<{ w: number; g: Uint8Array }> {
  const id = await new Deno.Command("identify", { args: ["-format", "%w", path], stdout: "piped" }).output();
  const w = Number(new TextDecoder().decode(id.stdout).trim());
  const out = await new Deno.Command("convert", { args: [path, "-colorspace", "gray", "-depth", "8", "gray:-"], stdout: "piped" }).output();
  return { w, g: out.stdout };
}

/** Mean horizontal gradient profile of a row band - edges align better than raw intensity. */
function profile(img: { w: number; g: Uint8Array }, y: number): Float32Array {
  const p = new Float32Array(X1 - X0);
  for (let yy = y; yy < y + BAND; yy++) {
    for (let x = X0; x < X1; x++) p[x - X0] += img.g[yy * img.w + x + 1] - img.g[yy * img.w + x - 1];
  }
  return p;
}

function bestShift(a: Float32Array, b: Float32Array): number {
  let best = -Infinity, bs = 0;
  const scores: number[] = [];
  for (let s = -R; s <= R; s++) {
    let sum = 0, n = 0;
    for (let i = R; i < a.length - R; i++) {
      sum += a[i] * b[i + s];
      n++;
    }
    scores.push(sum / n);
    if (sum / n > best) [best, bs] = [sum / n, s];
  }
  // parabolic sub-pixel refinement
  const k = bs + R;
  if (k > 0 && k < scores.length - 1) {
    const [l, m, r] = [scores[k - 1], scores[k], scores[k + 1]];
    const d = l - 2 * m + r;
    if (d !== 0) return bs + (l - r) / (2 * d);
  }
  return bs;
}

const ref = await gray(`${dir}/${frames[0]}`);
const refProfiles = rows.map((y) => profile(ref, y));
console.log(`t(s)    ` + rows.map((y) => `y=${y}`.padStart(8)).join(""));
for (let f = 0; f < frames.length; f++) {
  const img = await gray(`${dir}/${frames[f]}`);
  const shifts = rows.map((y, i) => bestShift(refProfiles[i], profile(img, y)));
  console.log(`${(times[f] - times[0]).toFixed(2).padStart(6)}  ` + shifts.map((s) => s.toFixed(1).padStart(8)).join(""));
}
