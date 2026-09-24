// Screen boxes (1024x768, the original camera) of every non-painting mesh in a scene (billboards, Relief), padded.
//   deno run -A tools/bbboxes.ts SCENE [pad]
import { loadXDoc } from "../src/xloader.ts";
import * as THREE from "three";
const [s, padS] = Deno.args;
const pad = Number(padS ?? 30);
const doc = await loadXDoc(new URL(`../assets/scenes/${s}/mesh.X`, import.meta.url).href);
const box = new THREE.Box3(), v = new THREE.Vector3();
for (const m of doc.meshes) for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
const W = box.max.x - box.min.x, H = box.max.y - box.min.y, cy = (box.min.y + box.max.y) / 2;
const sx = (x: number) => x / (W * 0.98) * 1024 + 512, sy = (y: number) => (cy - y) / (H * 0.98) * 768 + 384;
const extra: Record<string, number[]> = { green_plant: [100, 100, 0, 0], high_grass: [0, 0, 0, 100], yellow_grass: [-150, -150, 0, 0], anemon_02: [200, 200, 0, 0] };
for (const m of doc.meshes) {
  if (["Background", "Foreground", "Relief", "height"].includes(m.name)) continue;
  const b = new THREE.Box3();
  for (let i = 0; i < m.positions.length; i += 3) b.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
  const e = extra[m.name] ?? [0, 0, 0, 0];
  const x0 = Math.max(0, Math.floor(sx(b.min.x + e[0])) - pad), x1 = Math.min(1023, Math.ceil(sx(b.max.x + e[1])) + pad);
  const y0 = Math.max(0, Math.floor(sy(b.max.y + e[3])) - pad), y1 = Math.min(767, Math.ceil(sy(b.min.y + e[2])) + pad);
  console.log(`${m.name} ${x1 - x0}x${y1 - y0}+${x0}+${y0}`);
}
