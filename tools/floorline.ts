// Per scene: the original's camera mapping and the fish floor (Crab_Path) /
// reef line (height) / zone limits in SCREEN pixels at 1024x768.
//   deno run -A tools/floorline.ts [scene...]
import { loadXDoc } from "../src/xloader.ts";
import * as THREE from "three";

const root = new URL("../assets/", import.meta.url).href;
for (const s of Deno.args.length ? Deno.args : ["1", "2", "3"]) {
  const doc = await loadXDoc(`${root}scenes/${s}/mesh.X`);
  const box = new THREE.Box3(), v = new THREE.Vector3();
  let height: [number, number][] = [];
  for (const m of doc.meshes) {
    const pts: [number, number][] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      box.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
      pts.push([v.x, v.y]);
    }
    if (m.name === "height") height = pts.sort((a, b) => a[0] - b[0]);
  }
  const W = box.max.x - box.min.x, H = box.max.y - box.min.y, cy = (box.min.y + box.max.y) / 2;
  const sx = (x: number) => (x - 0) / (W * 0.98) * 1024 + 512;
  const sy = (y: number) => (cy - y) / (H * 0.98) * 768 + 384;
  const path = await loadXDoc(`${root}scenes/${s}/path.X`);
  const crab = path.meshes.find((m) => m.name === "Crab_Path")!;
  const raw: [number, number][] = [];
  for (let i = 0; i < crab.positions.length; i += 3) raw.push([crab.positions[i], crab.positions[i + 1]]);
  raw.sort((a, b) => a[0] - b[0]);
  const Ay = box.min.y + 0.15 * H;
  const floorScreen = raw.map(([x, y]) => [Math.round(sx(x)), +sy(y + Ay - 30).toFixed(1)]);
  const minY08 = box.min.y * 0.8;
  console.log(`scene ${s}: bbox x ${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)} y ${box.min.y.toFixed(1)}..${box.max.y.toFixed(1)} z ${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)}`);
  console.log(`  px/unit x ${(1024 / (W * 0.98)).toFixed(4)} y ${(768 / (H * 0.98)).toFixed(4)}; screen y of bbox.min.y ${sy(box.min.y).toFixed(1)}, bounds.minY (min.y*0.8=${minY08.toFixed(1)}) ${sy(minY08).toFixed(1)}`);
  console.log(`  far-zone floor (bounds.minY + 0.25 Hb) screen y ${sy(minY08 + 0.25 * (box.max.y - minY08)).toFixed(1)}`);
  const ys = floorScreen.map((p) => p[1] as number);
  console.log(`  Crab_Path fish floor, screen y range ${Math.min(...ys)}..${Math.max(...ys)}; points (x,y): ${floorScreen.map((p) => p.join(",")).join(" ")}`);
  console.log(`  height (reef line) screen: ${height.map(([x, y]) => `${Math.round(sx(x))},${sy(y).toFixed(0)}`).join(" ")}`);
}
