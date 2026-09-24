// Render OUR bubbles (src/bubbles.ts BubbleSim - the exact code the page runs)
// over a reference backdrop captured WITHOUT bubbles, as a frame sequence the
// same analysis tools read (fNNNN.png + times.txt). Lets tools/bubbletrack.ts
// compare our column with the original's statistic for statistic, without a
// browser (agent-browser takes ~75 s a frame).
//
//   deno run -A tools/fxsim.ts <scene> <backdrop.png> <outdir> [--t0 30] [--dt 0.1] [--n 120] [--crop X,Y,W,H]
//        [--times track.json]
//
// --times: render at the reference's own frame times (the `frames` list that
// bubbletrack.ts --json wrote), so both go through the tracker identically.
//
// Point sprites are emulated like GL draws them: every pixel whose centre is
// inside the sprite's square, gl_PointCoord from that centre, bilinear sample
// of BUBBLE.png (clamped; uploaded flipped, so v = 0 is the image's bottom
// row), SRCALPHA/INVSRCALPHA on raw 8-bit values, depth test+write (LessEqual).
// Camera: section 1 of docs/original-logic.md (eye x = 0, 0.98 x bbox) plus
// main.ts's 0.5 px nudge. The backdrop has the whole painting, so compare only
// where nothing covers the column (open water above the corals).

import { parseArgs } from "jsr:@std/cli@1/parse-args";
// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { BubbleSim } from "../src/bubbles.ts";
import { parseX } from "../src/xloader.ts";

const args = parseArgs(Deno.args, { string: ["t0", "dt", "n", "crop", "times"], default: { t0: "30", dt: "0.1", n: "120" } });
const [scene, backdrop, outdir] = args._.map(String);
const T0 = Number(args.t0), DT = Number(args.dt);
const refTimes: number[] | null = args.times ? JSON.parse(await Deno.readTextFile(args.times)).frames : null;
const N = refTimes ? refTimes.length : Number(args.n);
const [CX, CY, CW, CH] = (args.crop ?? "0,0,1024,768").split(",").map(Number);
const root = new URL("..", import.meta.url);

async function raw(path: string, map: string): Promise<Uint8Array> {
  const out = await new Deno.Command("convert", { args: [path, "-depth", "8", `${map}:-`], stdout: "piped" }).output();
  return out.stdout;
}

// Scene box, as scenebox.ts computes it (read from disk here instead of fetch).
const doc = parseX(await Deno.readTextFile(new URL(`assets/scenes/${scene}/mesh.X`, root)));
const box = new THREE.Box3();
const v = new THREE.Vector3();
for (const m of doc.meshes) {
  for (let i = 0; i < m.positions.length; i += 3) {
    box.expandByPoint(v.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]).applyMatrix4(m.world));
  }
}
const W = box.max.x - box.min.x, H = box.max.y - box.min.y;
const sx = 1024 / (0.98 * W), sy = 768 / (0.98 * H);
const cy = (box.min.y + box.max.y) / 2;
const NUDGE = 0.5; // main.ts: content 0.5 px right and down
const toPx = (x: number, y: number) => [512 + x * sx + NUDGE, 384 - (y - cy) * sy + NUDGE];

const tex = await raw(new URL("assets/common/BUBBLE.png", root).pathname, "rgba"); // 8x8
function sample(u: number, vv: number): [number, number, number, number] {
  // flipY upload: texture v = 0 is the image's LAST row.
  const fx = u * 8 - 0.5, fy = (1 - vv) * 8 - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  const px = (x: number, y: number, c: number) =>
    tex[(Math.min(7, Math.max(0, y)) * 8 + Math.min(7, Math.max(0, x))) * 4 + c];
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    out[c] = (px(x0, y0, c) * (1 - ax) + px(x0 + 1, y0, c) * ax) * (1 - ay) +
      (px(x0, y0 + 1, c) * (1 - ax) + px(x0 + 1, y0 + 1, c) * ax) * ay;
  }
  return out;
}

const bg = await raw(backdrop, "rgb");
const sim = new BubbleSim();
sim.setScene(scene, box);
await Deno.mkdir(outdir, { recursive: true });
const times: string[] = [];
for (let f = 0; f < N; f++) {
  const t = T0 + (refTimes ? refTimes[f] : f * DT);
  const img = new Float32Array(1024 * 768 * 3);
  for (let i = 0; i < img.length; i++) img[i] = bg[i];
  const depth = new Float32Array(1024 * 768).fill(Infinity);
  sim.sprites(t, (s) => {
    const [px, py] = toPx(s.x, s.y);
    const S = s.size * sy; // square pixels in y; x scale differs by <0.3%
    const x0 = Math.ceil(px - S / 2 - 0.5), x1 = Math.floor(px + S / 2 - 0.5);
    const y0 = Math.ceil(py - S / 2 - 0.5), y1 = Math.floor(py + S / 2 - 0.5);
    for (let y = Math.max(0, y0); y <= Math.min(767, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(1023, x1); x++) {
        const k = y * 1024 + x;
        if (s.z > depth[k]) continue;
        depth[k] = s.z;
        const u = (x + 0.5 - (px - S / 2)) / S, vv = (y + 0.5 - (py - S / 2)) / S;
        const [r, g, b, a] = sample(u, vv);
        const al = a / 255;
        img[k * 3] = r * al + img[k * 3] * (1 - al);
        img[k * 3 + 1] = g * al + img[k * 3 + 1] * (1 - al);
        img[k * 3 + 2] = b * al + img[k * 3 + 2] * (1 - al);
      }
    }
  });
  const crop = new Uint8Array(CW * CH * 3);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      for (let c = 0; c < 3; c++) crop[(y * CW + x) * 3 + c] = Math.round(img[((y + CY) * 1024 + x + CX) * 3 + c]);
    }
  }
  const name = `${outdir}/f${String(f).padStart(4, "0")}.png`;
  const p = new Deno.Command("convert", { args: ["-size", `${CW}x${CH}`, "-depth", "8", "rgb:-", name], stdin: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(crop);
  await w.close();
  await p.status;
  times.push(t.toFixed(4));
}
await Deno.writeTextFile(`${outdir}/times.txt`, times.join("\n") + "\n");
console.log(`${N} frames of scene ${scene} (t ${T0}..${times.at(-1)}) -> ${outdir}`);
