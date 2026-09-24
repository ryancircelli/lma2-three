// Colour of the creatures in bare-tank frames (flat clear colour behind): per
// frame, pixels differing from the clear colour by > thr in some channel and
// lying in a large blob-ish area; prints the per-channel median, p25/p75 and
// the mean over all such pixels. Compare the same species ours vs reference.
//
//   deno run -A tools/fishcolour.ts --clear 0,138,255 [--thr 40] [--every 1] img...
import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["clear", "thr", "every"], default: { clear: "0,138,255", thr: "40", every: "1" } });
const clear = args.clear.split(",").map(Number);
const THR = Number(args.thr), every = Number(args.every);
const files = args._.map(String).filter((_, i) => i % every === 0);
const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
let n = 0;
for (const f of files) {
  const out = await new Deno.Command("convert", { args: [f, "-depth", "8", "rgb:-"], stdout: "piped" }).output();
  const px = out.stdout;
  for (let p = 0; p < px.length; p += 3) {
    const d = Math.max(Math.abs(px[p] - clear[0]), Math.abs(px[p + 1] - clear[1]), Math.abs(px[p + 2] - clear[2]));
    if (d <= THR) continue;
    n++;
    for (let c = 0; c < 3; c++) hist[c][px[p + c]]++;
  }
}
const q = (h: Uint32Array, frac: number) => {
  let acc = 0;
  for (let i = 0; i < 256; i++) if ((acc += h[i]) >= frac * n) return i;
  return 255;
};
const mean = (h: Uint32Array) => h.reduce((s, v, i) => s + v * i, 0) / n;
console.log(
  `${files.length} frames, ${n} px: ` + ["R", "G", "B"].map((c, i) => `${c} p25/50/75 ${q(hist[i], 0.25)}/${q(hist[i], 0.5)}/${q(hist[i], 0.75)} mean ${mean(hist[i]).toFixed(1)}`).join("  "),
);
