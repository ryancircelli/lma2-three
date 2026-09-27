// Print each scene's depth layout (.X space, z larger = farther): every mesh's
// z range, the fish bounds, and how the Relief mesh relates to the fish floor.
// Used to place fish food at scene depths and land it on the reef.
//   deno run --allow-read tools/scene-depths.ts
import { parseX } from "../src/xloader.ts";

for (const id of ["1", "2", "3"]) {
  const doc = parseX(await Deno.readTextFile(new URL(`../assets/scenes/${id}/mesh.X`, import.meta.url)));
  console.log(`scene ${id}`);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const m of doc.meshes) {
    let z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    const e = m.world.elements;
    for (let i = 0; i < m.positions.length; i += 3) {
      const [px, py, pz] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      const x = e[0] * px + e[4] * py + e[8] * pz + e[12];
      const y = e[1] * px + e[5] * py + e[9] * pz + e[13];
      const z = e[2] * px + e[6] * py + e[10] * pz + e[14];
      z0 = Math.min(z0, z), z1 = Math.max(z1, z), y0 = Math.min(y0, y), y1 = Math.max(y1, y), x0 = Math.min(x0, x), x1 = Math.max(x1, x);
    }
    minX = Math.min(minX, x0), maxX = Math.max(maxX, x1), minY = Math.min(minY, y0), maxY = Math.max(maxY, y1), minZ = Math.min(minZ, z0), maxZ = Math.max(maxZ, z1);
    console.log(`  ${m.name.padEnd(14)} verts ${String(m.positions.length / 3).padStart(5)}  x ${x0.toFixed(0)}..${x1.toFixed(0)}  y ${y0.toFixed(0)}..${y1.toFixed(0)}  z ${z0.toFixed(0)}..${z1.toFixed(0)}`);
  }
  console.log(`  bbox x ${minX.toFixed(0)}..${maxX.toFixed(0)} y ${minY.toFixed(0)}..${maxY.toFixed(0)} z ${minZ.toFixed(0)}..${maxZ.toFixed(0)}; fish bounds z ${minZ.toFixed(0)}..${(maxZ * 0.8).toFixed(0)}, y from ${(minY * 0.8).toFixed(0)}`);
}
