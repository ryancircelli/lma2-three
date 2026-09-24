// Print the structure of one or more .X files: frames, meshes, bounds,
// materials and textures. A development aid for working out how scenes fit
// together.
//
//   deno task inspect assets/scenes/1/mesh.X [more.X ...]

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { isRenderable, parseX, type XFrame } from "../src/xloader.ts";

function bounds(pos: Float32Array, m: THREE.Matrix4): THREE.Box3 {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) b.expandByPoint(v.fromArray(pos, i).applyMatrix4(m));
  return b;
}
const f1 = (n: number) => n.toFixed(1).padStart(8);
const box = (b: THREE.Box3) => `x[${f1(b.min.x)},${f1(b.max.x)}] y[${f1(b.min.y)},${f1(b.max.y)}] z[${f1(b.min.z)},${f1(b.max.z)}]`;

function tree(f: XFrame, depth: number): void {
  const pad = "  ".repeat(depth);
  const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  f.local.decompose(t, q, s);
  const ident = f.local.equals(new THREE.Matrix4());
  console.log(`${pad}Frame ${f.name || "(anon)"}${ident ? "" : `  t=(${t.toArray().map((n) => n.toFixed(1))}) s=(${s.toArray().map((n) => n.toFixed(2))})`}`);
  for (const m of f.meshes) console.log(`${pad}  Mesh ${m.name}`);
  for (const c of f.frames) tree(c, depth + 1);
}

for (const path of Deno.args) {
  const doc = parseX(new TextDecoder("latin1").decode(await Deno.readFile(path)));
  console.log(`\n=== ${path}`);
  console.log("frames:");
  for (const f of doc.frames) tree(f, 1);
  console.log("meshes:");
  const all = new THREE.Box3();
  for (const m of doc.meshes) {
    const b = bounds(m.positions, m.world);
    all.union(b);
    const tris = m.faces.reduce((n, f) => n + Math.max(0, f.length - 2), 0);
    const tex = [...new Set(m.materials.map((x) => x?.texture).filter(Boolean))];
    const mats = m.materials.map((x) => x ? `${x.name}${x.opacity < 1 ? `(a=${x.opacity})` : ""}` : "?");
    console.log(`  ${m.name.padEnd(18)} v=${String(m.positions.length / 3).padStart(5)} t=${String(tris).padStart(5)} ${isRenderable(m) ? "" : "DATA "}${box(b)}`);
    if (mats.length) console.log(`  ${"".padEnd(18)} mats: ${mats.join(", ")}`);
    if (tex.length) console.log(`  ${"".padEnd(18)} tex : ${tex.join(", ")}`);
    if (!isRenderable(m) && m.positions.length <= 3 * 40) {
      const pts: string[] = [];
      const v = new THREE.Vector3();
      for (let i = 0; i < m.positions.length; i += 3) {
        v.fromArray(m.positions, i).applyMatrix4(m.world);
        pts.push(`(${v.x.toFixed(0)},${v.y.toFixed(0)},${v.z.toFixed(0)})`);
      }
      console.log(`  ${"".padEnd(18)} pts : ${pts.join(" ")}`);
    }
  }
  console.log(`overall ${box(all)}`);
}
