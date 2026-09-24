// Compare two same-size images colour-wise: fit ref = a*ours + b per channel
// over pixels where both are "painted" (not the flat water colour), and report
// how much a global colour transform explains versus what is left over.
//
//   deno run --allow-read --allow-run tools/colorfit.ts ours.png ref.png [x y w h]
//
// Uses ImageMagick (`convert`) to decode to raw RGB.

async function rgb(path: string, crop?: string): Promise<{ w: number; h: number; px: Uint8Array }> {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  let [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const args = [path];
  if (crop) {
    args.push("-crop", crop, "+repage");
    const m = crop.match(/^(\d+)x(\d+)/)!;
    w = Number(m[1]);
    h = Number(m[2]);
  }
  args.push("-depth", "8", "rgb:-");
  const out = await new Deno.Command("convert", { args, stdout: "piped" }).output();
  return { w, h, px: out.stdout };
}

const [oursPath, refPath, x, y, w, h] = Deno.args;
const crop = w ? `${w}x${h}+${x}+${y}` : undefined;
const A = await rgb(oursPath, crop), B = await rgb(refPath, crop);
if (A.px.length !== B.px.length) throw new Error("size mismatch");

const WATER = [0, 138, 255];
const n = A.px.length / 3;
const names = ["R", "G", "B"];
let used = 0;
const sx = [0, 0, 0], sy = [0, 0, 0], sxx = [0, 0, 0], sxy = [0, 0, 0];
let exact = 0, within8 = 0;
for (let i = 0; i < n; i++) {
  const a = [A.px[i * 3], A.px[i * 3 + 1], A.px[i * 3 + 2]];
  const b = [B.px[i * 3], B.px[i * 3 + 1], B.px[i * 3 + 2]];
  const isWater = (p: number[]) => Math.abs(p[0] - WATER[0]) + Math.abs(p[1] - WATER[1]) + Math.abs(p[2] - WATER[2]) < 6;
  if (isWater(a) && isWater(b)) continue;
  used++;
  const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  if (d === 0) exact++;
  if (d <= 8) within8++;
  for (let c = 0; c < 3; c++) {
    sx[c] += a[c];
    sy[c] += b[c];
    sxx[c] += a[c] * a[c];
    sxy[c] += a[c] * b[c];
  }
}
console.log(`painted pixels compared: ${used} of ${n}`);
console.log(`  identical: ${(100 * exact / used).toFixed(1)}%   within 8/255: ${(100 * within8 / used).toFixed(1)}%`);
for (let c = 0; c < 3; c++) {
  const a = (used * sxy[c] - sx[c] * sy[c]) / (used * sxx[c] - sx[c] * sx[c]);
  const b = (sy[c] - a * sx[c]) / used;
  console.log(`  ${names[c]}: ref ~= ${a.toFixed(3)} * ours + ${b.toFixed(1)}    mean ours ${(sx[c] / used).toFixed(1)}  mean ref ${(sy[c] / used).toFixed(1)}`);
}
