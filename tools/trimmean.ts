// Robust time average of a region over a frame sequence: per pixel and
// channel, sort the values over the frames, drop the lowest and highest
// `trim` fraction (passing fish, twinkling motes), average the rest; then
// print the region mean per channel. For additive effects under traffic
// (the water surface with fish swimming through it).
//
//   deno run -A tools/trimmean.ts --roi WxH+X+Y [--trim 0.25] [--every 1] img...
import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["roi", "trim", "every"], default: { trim: "0.25", every: "1" } });
const every = Number(args.every);
const files = args._.map(String).filter((_, i) => i % every === 0);
const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(args.roi!)!;
const [W, H, X, Y] = [+m[1], +m[2], +m[3], +m[4]];
const N = W * H * 3;
const stack: Uint8Array[] = [];
for (const f of files) {
  const out = await new Deno.Command("convert", { args: [f, "-crop", `${W}x${H}+${X}+${Y}`, "+repage", "-depth", "8", "rgb:-"], stdout: "piped" }).output();
  stack.push(out.stdout);
}
const k = stack.length, lo = Math.floor(k * Number(args.trim)), hi = k - lo;
const v = new Uint8Array(k);
const sum = [0, 0, 0];
for (let i = 0; i < N; i++) {
  for (let j = 0; j < k; j++) v[j] = stack[j][i];
  v.sort();
  let s = 0;
  for (let j = lo; j < hi; j++) s += v[j];
  sum[i % 3] += s / (hi - lo);
}
const px = W * H;
console.log(`${k} frames, trim ${args.trim}: R ${(sum[0] / px).toFixed(2)} G ${(sum[1] / px).toFixed(2)} B ${(sum[2] / px).toFixed(2)}`);
