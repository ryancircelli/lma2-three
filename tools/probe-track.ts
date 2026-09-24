// Run OUR tank headlessly and push it through the SAME blob pipeline as a
// captured sequence (tools/track.ts): every creature's triangles are
// rasterised into a 1024x768 silhouette mask, the mask is dilated and
// labelled into blobs exactly as track.ts does, and blobs are linked frame to
// frame with track.ts's gates. So fish that overlap merge into one blob and
// break their tracks, as they do in a capture of the original.
//
// tools/probe-ours.ts gives every creature's exact track instead. That is
// right for solo fish, but it over-counts turn-arounds of schools against a
// tracked reference: a school's tracks break at every merge, and a turn is
// only counted inside one unbroken track.
//
//   deno run -A tools/probe-track.ts OUT.json [--scene 1] [--tank slug=4,...]
//        [--warm 18] [--seconds 180] [--hz 4.5] [--seed N] [--step 0.0333]
//        [--min 25] [--occlude]
//
// --occlude: hide the pixels of creatures BEHIND the foreground painting that
// fall below the reef line (the painting's top edge, tools/reefsplit.py), as a
// full-scene capture would. Off = a bare tank (LMA2_BARE=1 / ?bare=1).
//
// OUT.json has track.ts's {summary, tracks, frames} shape, for
// tools/motion-stats.ts and tools/reefsplit.py.

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const fakeImg = () => {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    width: 1,
    height: 1,
    addEventListener(k: string, f: () => void) {
      (listeners[k] ??= []).push(f);
    },
    removeEventListener() {},
    set src(_v: string) {
      setTimeout(() => (listeners.load ?? []).forEach((f) => f()), 0);
    },
  };
};
(globalThis as Record<string, unknown>).document = { createElementNS: fakeImg, createElement: fakeImg, baseURI: "file:///" };

const { Tank } = await import("../src/tank.ts");
const { loadXDoc } = await import("../src/xloader.ts");
const THREE = await import("three");

const args = parseArgs(Deno.args, {
  string: ["scene", "tank", "warm", "seconds", "hz", "school", "seed", "step", "min"],
  boolean: ["all", "occlude"],
  default: { scene: "1", warm: "18", seconds: "180", hz: "4.5", min: "25" },
});
const out = String(args._[0]);
const root = new URL("../assets/", import.meta.url).href;
const manifest = JSON.parse(await Deno.readTextFile(new URL("../assets/manifest.json", import.meta.url)));
let stock: Record<string, number> = manifest.tank;
if (args.all) stock = Object.fromEntries(manifest.fish.map((f: { slug: string }) => [f.slug, 1]));
if (args.tank) stock = Object.fromEntries(args.tank.split(",").map((e) => [e.split("=")[0], Number(e.split("=")[1] ?? 1)]));

const doc = await loadXDoc(`${root}scenes/${args.scene}/mesh.X`);
const box = new THREE.Box3(), v = new THREE.Vector3();
for (const m of doc.meshes) for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
const tank = new Tank(args.seed ? Number(args.seed) : undefined);
tank.animate = false;
if (args.school === "0") tank.schooling = false;
tank.setView(0, (box.min.y + box.max.y) / 2, (box.max.x - box.min.x) * 0.98 / 2, (box.max.y - box.min.y) * 0.98 / 2);
await tank.setScene(args.scene, root);
await tank.populate(manifest.fish, stock, root);

// the reef line in screen px (tools/reefsplit.py)
const HEIGHT: Record<string, [number, number][]> = {
  "1": [[-3, 210], [230, 210], [429, 219], [542, 279], [675, 181], [854, 156], [1015, 184]],
  "2": [[1, 77], [248, 76], [381, 158], [532, 136], [680, 176], [829, 76], [1014, 58]],
  "3": [[5, 43], [222, 85], [357, 217], [547, 277], [645, 315], [796, 255], [821, 195], [1013, 148]],
};
const reef = HEIGHT[args.scene] ?? HEIGHT["1"];
const reefY = new Float32Array(1024);
for (let x = 0; x < 1024; x++) {
  let y = reef[reef.length - 1][1];
  if (x <= reef[0][0]) y = reef[0][1];
  else {
    for (let i = 1; i < reef.length; i++) {
      if (x <= reef[i][0]) {
        const [x0, y0] = reef[i - 1], [x1, y1] = reef[i];
        y = y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        break;
      }
    }
  }
  reefY[x] = y;
}

const W = 1024, H = 768, N = W * H, MIN_AREA = Number(args.min), GATE = 260;
/** Per-pixel owner creature index + 1 (0 = water). */
const owner = new Int32Array(N);
const pv = new THREE.Vector3();

// A stable fake colour per species (track.ts gates links by colour distance).
const colourOf = new Map<string, [number, number, number]>();
const colour = (s: string): [number, number, number] => {
  let c = colourOf.get(s);
  if (!c) {
    const k = colourOf.size;
    c = [(k * 97) % 256, (k * 57 + 80) % 256, (k * 151 + 160) % 256];
    colourOf.set(s, c);
  }
  return c;
};

function raster(): { species: string; front: boolean }[] {
  owner.fill(0);
  const list = tank.silhouettes();
  list.forEach((cr, ci) => {
    const occlude = args.occlude && !cr.front;
    for (const { geometry, matrix } of cr.meshes) {
      const pos = geometry.getAttribute("position");
      const sx = new Float32Array(pos.count), sy = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        pv.fromBufferAttribute(pos, i).applyMatrix4(matrix).project(tank.camera);
        sx[i] = (pv.x + 1) / 2 * W;
        sy[i] = (1 - pv.y) / 2 * H;
      }
      const idx = geometry.index;
      const nt = idx ? idx.count / 3 : pos.count / 3;
      for (let t = 0; t < nt; t++) {
        const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
        if (x0 > x1 || y0 > y1) continue;
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (area === 0) continue;
        const s = area > 0 ? 1 : -1;
        for (let y = y0; y <= y1; y++) {
          const py = y + 0.5;
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5;
            const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * s;
            const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * s;
            const w2 = ((ax - px) * (by - py) - (ay - py) * (bx - px)) * s;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            if (occlude && py > reefY[x]) continue;
            owner[y * W + x] = ci + 1;
          }
        }
      }
    }
  });
  return list.map((c) => ({ species: c.species, front: c.front }));
}

interface Blob {
  f: number;
  t: number;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  rgb: [number, number, number];
}

const dil = new Uint8Array(N), label = new Int32Array(N);
function blobs(info: { species: string }[], f: number, t: number): Blob[] {
  dil.fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!owner[y * W + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) dil[yy * W + xx] = 1;
        }
      }
    }
  }
  label.fill(-1);
  const res: Blob[] = [];
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (!dil[s] || label[s] >= 0) continue;
    const id = res.length;
    let area = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p / W) | 0;
      const o = owner[p];
      if (o) {
        const c = colour(info[o - 1].species);
        area++;
        sx += x;
        sy += y;
        r += c[0];
        g += c[1];
        b += c[2];
        x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      }
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= N || label[q] >= 0 || !dil[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        label[q] = id;
        stack.push(q);
      }
    }
    const k = Math.max(area, 1);
    res.push({ f, t, cx: sx / k, cy: sy / k, x0, y0, x1, y1, area, rgb: [r / k, g / k, b / k].map(Math.round) as [number, number, number] });
  }
  return res.filter((bl) => bl.area >= MIN_AREA);
}

const hz = Number(args.hz), step = args.step ? Number(args.step) : 1 / 30;
tank.simulateTo(Number(args.warm), step);
const all: Blob[][] = [];
const secs = Number(args.seconds);
let simT = 0, nextSample = 0, f = 0;
while (simT <= secs + 1e-9) {
  if (simT + 1e-9 >= nextSample) {
    all.push(blobs(raster(), f++, +simT.toFixed(4)));
    nextSample += 1 / hz;
  }
  tank.update(step);
  simT += step;
}

// --- linking (tools/track.ts) ---------------------------------------------------
const colourDist = (a: Blob, b: Blob) => Math.hypot(a.rgb[0] - b.rgb[0], a.rgb[1] - b.rgb[1], a.rgb[2] - b.rgb[2]);
const tracks: Blob[][] = [];
let open: Blob[][] = [];
for (const fr of all) {
  const pairs: [number, number, number][] = [];
  open.forEach((tr, i) => {
    const last = tr[tr.length - 1];
    const dt = Math.max(fr[0]?.t - last.t, 1e-3);
    fr.forEach((b, j) => {
      const d = Math.hypot(b.cx - last.cx, b.cy - last.cy);
      const ar = Math.max(b.area, last.area) / Math.min(b.area, last.area);
      if (d > GATE * dt + 20 || ar > 2.2 || colourDist(b, last) > 60) return;
      pairs.push([d + 20 * ar + colourDist(b, last), i, j]);
    });
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const usedT = new Set<number>(), usedB = new Set<number>();
  const next: Blob[][] = [];
  for (const [, i, j] of pairs) {
    if (usedT.has(i) || usedB.has(j)) continue;
    usedT.add(i);
    usedB.add(j);
    open[i].push(fr[j]);
    next.push(open[i]);
  }
  open.forEach((tr, i) => usedT.has(i) || tracks.push(tr));
  fr.forEach((b, j) => usedB.has(j) || next.push([b]));
  open = next;
}
tracks.push(...open);
const good = tracks.filter((tr) => tr.length >= 4 && tr[tr.length - 1].t - tr[0].t >= 1.5);
await Deno.writeTextFile(out, JSON.stringify({ tracks: good, frames: all }));
console.log(`${all.length} frames, ${(all.flat().length / all.length).toFixed(1)} blobs/frame, ${good.length} tracks -> ${out}`);
