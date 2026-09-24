// Local image registration: for a grid of regions, find the integer shift
// (plus a parabolic sub-pixel refinement) that best aligns `ours` to `ref`.
// The shape of the resulting displacement field says what is wrong:
//   uniform           -> a plain offset
//   linear in x/y     -> a scale difference
//   differs by layer  -> depth-dependent (perspective) placement
//
//   deno run --allow-run tools/register.ts ours.png ref.png [--y0 140] [--range 10]

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["y0", "range", "cols", "rows"], default: { y0: "140", range: "10", cols: "5", rows: "4" } });
const [oursPath, refPath] = args._.map(String);

async function gray(path: string): Promise<{ w: number; h: number; g: Float32Array }> {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const out = await new Deno.Command("convert", { args: [path, "-colorspace", "gray", "-depth", "8", "gray:-"], stdout: "piped" }).output();
  return { w, h, g: Float32Array.from(out.stdout) };
}

const A = await gray(oursPath), B = await gray(refPath);
const { w, h } = A;
const R = Number(args.range), y0 = Number(args.y0);
const cols = Number(args.cols), rows = Number(args.rows);
const rw = Math.floor((w - 2 * R) / cols), rh = Math.floor((h - y0 - 2 * R) / rows);

function cost(x0: number, yy0: number, dx: number, dy: number): number {
  let s = 0;
  for (let y = yy0; y < yy0 + rh; y += 2) {
    for (let x = x0; x < x0 + rw; x += 2) {
      const d = A.g[(y + dy) * w + (x + dx)] - B.g[y * w + x];
      s += d * d;
    }
  }
  return s;
}

console.log(`region ${rw}x${rh}, search +-${R}px.  shift = where OURS content sits relative to REF (+x right, +y down)`);
for (let r = 0; r < rows; r++) {
  const cells: string[] = [];
  for (let c = 0; c < cols; c++) {
    const x0 = R + c * rw, yy0 = y0 + R + r * rh;
    let best = Infinity, bx = 0, by = 0;
    const grid = new Map<string, number>();
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const v = cost(x0, yy0, dx, dy);
        grid.set(`${dx},${dy}`, v);
        if (v < best) [best, bx, by] = [v, dx, dy];
      }
    }
    // sub-pixel: parabola through the minimum and its neighbours
    const sub = (m: number, p: number, n: number) => (m + n - 2 * p === 0 ? 0 : (m - n) / (2 * (m + n - 2 * p)));
    const fx = bx + (Math.abs(bx) < R ? sub(grid.get(`${bx - 1},${by}`)!, best, grid.get(`${bx + 1},${by}`)!) : 0);
    const fy = by + (Math.abs(by) < R ? sub(grid.get(`${bx},${by - 1}`)!, best, grid.get(`${bx},${by + 1}`)!) : 0);
    const zero = grid.get("0,0")!;
    cells.push(`(${fx.toFixed(1).padStart(5)},${fy.toFixed(1).padStart(5)}) ${(100 * (1 - best / zero)).toFixed(0).padStart(3)}%`);
  }
  console.log(`y~${String(y0 + R + r * rh + (rh >> 1)).padStart(4)}: ` + cells.join("  "));
}
console.log("(each cell: best shift, and how much of the zero-shift error it removes)");
