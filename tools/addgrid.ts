// Mean ADDED light (on - off) per grid cell, ours vs reference: for additive
// effects whose animation phase differs between the two (caustics, surface,
// rays), where only region means can be compared.
//
//   deno run -A tools/addgrid.ts oursOn oursOff refOn refOff [--cols 8] [--rows 6] [--roi WxH+X+Y]
//
// Prints per cell "ours/ref" of mean(on - off) over R,G,B, then the overall
// ratio sum(ours)/sum(ref) and the cell-wise correlation.
import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["cols", "rows", "roi"], default: { cols: "8", rows: "6" } });
const [a1, a0, b1, b0] = args._.map(String);
async function load(path: string) {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const out = await new Deno.Command("convert", { args: [path, "-depth", "8", "rgb:-"], stdout: "piped" }).output();
  return { w, h, px: out.stdout };
}
const [A1, A0, B1, B0] = await Promise.all([a1, a0, b1, b0].map(load));
const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(args.roi ?? `${A1.w}x${A1.h}+0+0`)!;
const [RW, RH, RX, RY] = [+m[1], +m[2], +m[3], +m[4]];
const C = Number(args.cols), R = Number(args.rows);
const cw = Math.floor(RW / C), ch = Math.floor(RH / R);
const os: number[] = [], rs: number[] = [];
let lines = "";
const chan = [0, 0, 0, 0, 0, 0];
for (let r = 0; r < R; r++) {
  const cells: string[] = [];
  for (let c = 0; c < C; c++) {
    let so = 0, sr = 0, n = 0;
    for (let y = RY + r * ch; y < RY + (r + 1) * ch; y++) {
      for (let x = RX + c * cw; x < RX + (c + 1) * cw; x++) {
        const p = (y * A1.w + x) * 3;
        for (let k = 0; k < 3; k++) {
          const o = A1.px[p + k] - A0.px[p + k], f = B1.px[p + k] - B0.px[p + k];
          so += o, sr += f, chan[k] += o, chan[3 + k] += f;
        }
        n += 3;
      }
    }
    os.push(so / n), rs.push(sr / n);
    cells.push(`${(so / n).toFixed(1).padStart(5)}/${(sr / n).toFixed(1).padEnd(5)}`);
  }
  lines += `y${String(RY + r * ch).padStart(4)}: ${cells.join(" ")}\n`;
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const mo = mean(os), mr = mean(rs);
let sxy = 0, sxx = 0, syy = 0;
for (let i = 0; i < os.length; i++) sxy += (os[i] - mo) * (rs[i] - mr), sxx += (os[i] - mo) ** 2, syy += (rs[i] - mr) ** 2;
console.log(lines + `mean added: ours ${mo.toFixed(2)}  ref ${mr.toFixed(2)}  ratio ${(mo / mr).toFixed(3)}  cell corr ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`);
console.log(`per channel ours R ${(chan[0]).toExponential(2)} G ${chan[1].toExponential(2)} B ${chan[2].toExponential(2)} | ref R ${chan[3].toExponential(2)} G ${chan[4].toExponential(2)} B ${chan[5].toExponential(2)}`);
