// Run OUR tank headlessly (no WebGL: simulation + projection only) and dump
// every creature's on-screen box over time, for tools/motion-stats.ts.
//
//   deno run -A tools/probe-ours.ts OUT.json [--scene 1] [--tank slug=4,slug=2 | --all]
//        [--warm 10] [--seconds 60] [--hz 5] [--seed N] [--school 0]
//
// Without --tank, the configured tank (assets/manifest.json). The camera is
// the original's: ortho over 98% of the scene's full bbox, eye x = 0.

import { parseArgs } from "jsr:@std/cli@1/parse-args";

// Textures are irrelevant here: a stand-in <img> that "loads" at once.
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
  string: ["scene", "tank", "warm", "seconds", "hz", "school", "seed"],
  boolean: ["all"],
  default: { scene: "1", warm: "10", seconds: "60", hz: "5" },
});
const out = String(args._[0]);
const root = new URL("../assets/", import.meta.url).href;
const manifest = JSON.parse(await Deno.readTextFile(new URL("../assets/manifest.json", import.meta.url)));
let stock: Record<string, number> = manifest.tank;
if (args.all) stock = Object.fromEntries(manifest.fish.map((f: { slug: string }) => [f.slug, 1]));
if (args.tank) stock = Object.fromEntries(args.tank.split(",").map((e) => [e.split("=")[0], Number(e.split("=")[1] ?? 1)]));

// the original's camera box: 98% of the full bbox, eye x = 0
const doc = await loadXDoc(`${root}scenes/${args.scene}/mesh.X`);
const box = new THREE.Box3(), v = new THREE.Vector3();
for (const m of doc.meshes) for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
const tank = new Tank(args.seed ? Number(args.seed) : undefined);
tank.animate = false; // positions only: much faster
if (args.school === "0") tank.schooling = false;
tank.setView(0, (box.min.y + box.max.y) / 2, (box.max.x - box.min.x) * 0.98 / 2, (box.max.y - box.min.y) * 0.98 / 2);
await tank.setScene(args.scene, root);
await tank.populate(manifest.fish, stock, root);

const hz = Number(args.hz), step = 1 / 30;
tank.simulateTo(Number(args.warm));
const species: string[] = [];
const idx = (s: string) => (species.includes(s) ? species.indexOf(s) : species.push(s) - 1);
const samples: [number, number[][]][] = [];
const n = Math.round(Number(args.seconds) / step), every = Math.max(1, Math.round(1 / hz / step));
for (let i = 0; i <= n; i++) {
  if (i % every === 0) {
    samples.push([+(i * step).toFixed(3), tank.probe().map((c) => [idx(c.species), Math.round(c.x0), Math.round(c.y0), Math.round(c.x1), Math.round(c.y1), c.front ? 1 : 0])]);
  }
  tank.update(step);
}
await Deno.writeTextFile(out, JSON.stringify({ probe: true, species, samples }));
console.log(`${samples.length} samples of ${tank.count} creatures -> ${out}`);
