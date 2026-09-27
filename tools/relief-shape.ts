// Is each scene's Relief mesh terrain-like (faces up) or a relief facing the
// camera? Prints area-weighted normal components and, on a grid of downward
// rays at several depths, how often a ray hits it and the hit heights.
//   deno run --allow-read tools/relief-shape.ts
import { parseX } from "../src/xloader.ts";

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

for (const id of ["1", "2", "3"]) {
  const doc = parseX(await Deno.readTextFile(new URL(`../assets/scenes/${id}/mesh.X`, import.meta.url)));
  const m = doc.meshes.find((m) => m.name === "Relief")!;
  const e = m.world.elements;
  const P: V[] = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    const [px, py, pz] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
    P.push([e[0] * px + e[4] * py + e[8] * pz + e[12], e[1] * px + e[5] * py + e[9] * pz + e[13], e[2] * px + e[6] * py + e[10] * pz + e[14]]);
  }
  let ax = 0, ay = 0, az = 0, up = 0, down = 0, toward = 0, away = 0;
  const tris: [V, V, V][] = [];
  for (const face of m.faces) for (let j = 1; j + 1 < face.length; j++) {
    const a = P[face[0]], b = P[face[j]], c = P[face[j + 1]];
    tris.push([a, b, c]);
    const n = cross(sub(b, a), sub(c, a));
    ax += Math.abs(n[0]), ay += Math.abs(n[1]), az += Math.abs(n[2]);
    if (n[1] > 0) up += n[1]; else down -= n[1];
    if (n[2] < 0) toward -= n[2]; else away += n[2];
  }
  const s = ax + ay + az;
  console.log(`scene ${id}: ${tris.length} tris; |n| share x ${(ax / s).toFixed(2)} y ${(ay / s).toFixed(2)} z ${(az / s).toFixed(2)}; y+ ${up.toFixed(0)} vs y- ${down.toFixed(0)}; toward-camera(z-) ${toward.toFixed(0)} vs away ${away.toFixed(0)}`);
  // downward rays: highest hit at (x, z)
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of P) minZ = Math.min(minZ, p[2]), maxZ = Math.max(maxZ, p[2]);
  const hitY = (x: number, z: number): number | null => {
    let best: number | null = null;
    for (const [a, b, c] of tris) {
      // barycentric in xz
      const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
      const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const y = l1 * a[1] + l2 * b[1] + l3 * c[1];
      if (best === null || y > best) best = y;
    }
    return best;
  };
  for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const z = minZ + f * (maxZ - minZ);
    const row: string[] = [];
    let hits = 0;
    for (let x = -850; x <= 850; x += 170) {
      const y = hitY(x, z);
      if (y !== null) hits++;
      row.push(y === null ? "  --" : String(Math.round(y)).padStart(4));
    }
    console.log(`  z ${z.toFixed(0).padStart(6)}: hits ${hits}/11  y: ${row.join(" ")}`);
  }
}
