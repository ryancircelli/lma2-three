// PSNR / RMSE / mean difference between two same-size images over a region,
// with rectangles excluded (e.g. animated billboards).
//
//   deno run -A tools/maskpsnr.ts a.png b.png [--roi WxH+X+Y] [--ex WxH+X+Y,...]
//
// Prints: pixels used, PSNR (dB, 8-bit, all channels), RMSE, mean(a-b) per
// channel, and the % of pixels whose max channel difference is <= 8.
import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["roi", "ex"] });
const [pa, pb] = args._.map(String);
async function load(path: string) {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const out = await new Deno.Command("convert", { args: [path, "-depth", "8", "rgb:-"], stdout: "piped" }).output();
  return { w, h, px: out.stdout };
}
const rect = (g: string) => {
  const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(g)!;
  return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
};
const A = await load(pa), B = await load(pb);
const roi = args.roi ? rect(args.roi) : { w: A.w, h: A.h, x: 0, y: 0 };
const ex = (args.ex ? args.ex.split(",") : []).filter(Boolean).map(rect);
let n = 0, se = 0, within = 0;
const md = [0, 0, 0];
for (let y = roi.y; y < roi.y + roi.h; y++) {
  for (let x = roi.x; x < roi.x + roi.w; x++) {
    if (ex.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue;
    const p = (y * A.w + x) * 3;
    let mx = 0;
    for (let c = 0; c < 3; c++) {
      const d = A.px[p + c] - B.px[p + c];
      se += d * d;
      md[c] += d;
      mx = Math.max(mx, Math.abs(d));
    }
    if (mx <= 8) within++;
    n++;
  }
}
const mse = se / (3 * n);
console.log(
  `px ${n}  PSNR ${(10 * Math.log10(255 * 255 / mse)).toFixed(2)} dB  RMSE ${Math.sqrt(mse).toFixed(2)}  mean(a-b) R ${(md[0] / n).toFixed(2)} G ${(md[1] / n).toFixed(2)} B ${(md[2] / n).toFixed(2)}  within8 ${(100 * within / n).toFixed(1)}%`,
);
