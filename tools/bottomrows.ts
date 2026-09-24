// Do creatures reach / cross the bottom of the screen? For bare-tank sequences
// (flat clear colour + motes; tools/wine-ref.sh with LMA2_BARE=1).
//
//   deno run -A tools/bottomrows.ts SEQDIR BGDIR [--thr 20]
//
// Per frame: the lowest screen row holding creature pixels (foreground = any
// channel differs from the backdrop median by > thr; eroded 3x3-cross so 1-3 px
// motes vanish; a row counts with >= 4 eroded pixels), and whether a creature
// touches the last row (>= 6 px foreground in each of the last 3 rows at the
// same x). Frames are PPM (P6) or anything ImageMagick reads.
import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, { string: ["thr"], default: { thr: "20" } });
const [seqDir, bgDir] = args._.map(String);
const THR = Number(args.thr);

async function load(path: string): Promise<{ w: number; h: number; px: Uint8Array }> {
  if (path.endsWith(".ppm")) {
    const b = await Deno.readFile(path);
    // P6\nW H\n255\n
    let i = 0, fields: string[] = [];
    while (fields.length < 4) {
      let s = "";
      while (b[i] === 0x20 || b[i] === 0x0a) i++;
      while (b[i] !== 0x20 && b[i] !== 0x0a) s += String.fromCharCode(b[i++]);
      fields.push(s);
    }
    i++;
    return { w: +fields[1], h: +fields[2], px: b.subarray(i) };
  }
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const out = await new Deno.Command("convert", { args: [path, "-depth", "8", "rgb:-"], stdout: "piped" }).output();
  return { w, h, px: out.stdout };
}
const list = async (d: string) => {
  const f: string[] = [];
  for await (const e of Deno.readDir(d)) if (/^f\d+\.(png|ppm)$/.test(e.name)) f.push(`${d}/${e.name}`);
  return f.sort();
};

const bgs = await Promise.all((await list(bgDir)).map(load));
const { w: W, h: H } = bgs[0];
const med = new Uint8Array(W * H * 3);
{
  const v = new Uint8Array(bgs.length);
  for (let i = 0; i < med.length; i++) {
    for (let k = 0; k < bgs.length; k++) v[k] = bgs[k].px[i];
    v.sort();
    med[i] = v[v.length >> 1];
  }
}
const files = await list(seqDir);
const lows: number[] = [];
let touch = 0;
const touchFrames: string[] = [];
const fg = new Uint8Array(W * H);
for (const f of files) {
  const im = await load(f);
  for (let p = 0; p < W * H; p++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(im.px[p * 3 + c] - med[p * 3 + c]));
    fg[p] = d > THR ? 1 : 0;
  }
  let low = -1;
  for (let y = H - 2; y >= 1 && low < 0; y--) {
    let n = 0;
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (fg[p] && fg[p - 1] && fg[p + 1] && fg[p - W] && fg[p + W]) n++;
    }
    if (n >= 4) low = y;
  }
  lows.push(low);
  let n = 0;
  for (let x = 0; x < W; x++) if (fg[(H - 1) * W + x] && fg[(H - 2) * W + x] && fg[(H - 3) * W + x]) n++;
  if (n >= 6) touch++, touchFrames.push(f.split("/").pop()!);
}
const lw = lows.filter((l) => l >= 0).sort((a, b) => a - b);
const q = (p: number) => lw[Math.min(lw.length - 1, Math.round(p * (lw.length - 1)))];
console.log(`${seqDir}: ${files.length} frames; creature touching the bottom row (y=${H - 1}): ${touch} frames (${(100 * touch / files.length).toFixed(2)}%)`);
console.log(`  lowest creature row per frame p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${lw[lw.length - 1]}`);
for (const lim of [700, 720, 740, 760]) {
  const k = lw.filter((l) => l > lim).length;
  console.log(`  frames with creature pixels below y=${lim}: ${k} (${(100 * k / files.length).toFixed(1)}%)`);
}
{ const i = lows.indexOf(Math.max(...lows)); console.log("  lowest at " + files[i].split("/").pop()); }
if (touchFrames.length) console.log("  e.g. " + touchFrames.slice(0, 15).join(" "));
