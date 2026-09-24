// How many light motes our MoteSim (src/motes.ts) has alive, and how many are
// clearly visible, over time - to compare with the blobs tools/bubbletrack.ts
// finds in a reference sequence with every painting layer off.
//
//   deno run -A tools/motecount.ts <scene> [t0 t1 step]

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { MoteSim } from "../src/motes.ts";
import { parseX } from "../src/xloader.ts";

const [scene, a = "0", b = "120", s = "10"] = Deno.args;
const root = new URL("..", import.meta.url);
const doc = parseX(await Deno.readTextFile(new URL(`assets/scenes/${scene}/mesh.X`, root)));
const box = new THREE.Box3();
const v = new THREE.Vector3();
for (const m of doc.meshes) {
  for (let i = 0; i < m.positions.length; i += 3) {
    box.expandByPoint(v.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]).applyMatrix4(m.world));
  }
}
const sim = new MoteSim();
sim.setScene(scene, box);
const sy = 768 / (0.98 * (box.max.y - box.min.y));
for (let t = Number(a); t <= Number(b); t += Number(s)) {
  let n = 0, vis = 0, fogs: number[] = [];
  sim.sprites(t, (m) => {
    n++;
    // on screen, not fading, at least ~3 px
    const py = 384 - (m.y - (box.min.y + box.max.y) / 2) * sy;
    if (m.alpha > 0.5 && m.size * sy >= 3 && py >= 0 && py < 640) vis++;
    fogs.push(m.fog);
  });
  fogs = fogs.sort();
  console.log(`t=${t.toFixed(0)}s alive ${n}, visible-ish ${vis}, fog factor median ${fogs[fogs.length >> 1]?.toFixed(2)} (1 = unfogged)`);
}
