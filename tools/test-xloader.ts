// Parse every extracted .X file with src/xloader.ts and sanity-check the result
// without a browser: index bounds, NaNs, UV counts, material slots, and that
// every model's pose meshes build into a valid morph mesh.
//
//   deno task test

import { buildMesh, buildMorphMesh, isRenderable, parseX, poseGroups, type XDoc } from "../src/xloader.ts";

const ASSETS = new URL("../assets/", import.meta.url);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else if (/\.x$/i.test(e.name)) yield u;
  }
}

let failures = 0;
const fail = (file: string, msg: string) => {
  failures++;
  console.log(`  FAIL ${file}: ${msg}`);
};

const files: URL[] = [];
for await (const f of walk(ASSETS)) files.push(f);
files.sort((a, b) => a.href.localeCompare(b.href));

for (const file of files) {
  const rel = decodeURIComponent(file.href.slice(ASSETS.href.length));
  let doc: XDoc;
  try {
    // .X text is ASCII; latin1 keeps any stray high bytes 1:1.
    doc = parseX(new TextDecoder("latin1").decode(await Deno.readFile(file)));
  } catch (e) {
    fail(rel, `parse error: ${(e as Error).message}`);
    continue;
  }

  let verts = 0, tris = 0;
  const data: string[] = [];
  for (const m of doc.meshes) {
    const nV = m.positions.length / 3;
    verts += nV;
    for (const f of m.faces) {
      if (f.length >= 3) tris += f.length - 2;
      if (f.some((i) => i < 0 || i >= nV)) {
        fail(rel, `${m.name}: face index out of range (nV=${nV})`);
        break;
      }
    }
    if (m.positions.some(Number.isNaN)) fail(rel, `${m.name}: NaN in positions`);
    if (m.uvs && m.uvs.length / 2 !== nV) fail(rel, `${m.name}: ${m.uvs.length / 2} uvs for ${nV} vertices`);
    if (m.faceMaterials && m.faceMaterials.length) {
      const maxSlot = Math.max(...m.faceMaterials);
      if (maxSlot >= m.materials.length) fail(rel, `${m.name}: uses material slot ${maxSlot}, only ${m.materials.length} defined`);
      if (m.materials.some((x) => x === null)) fail(rel, `${m.name}: unresolved material reference`);
    }
    if (!isRenderable(m)) {
      data.push(`${m.name}(${nV}pts)`); // e.g. Crab_Path, height - not geometry
      continue;
    }
    try {
      const pos = buildMesh(m, null).geometry.getAttribute("position");
      if (pos.count === 0) fail(rel, `${m.name}: built empty geometry`);
      else if (Array.from(pos.array as Float32Array).some(Number.isNaN)) fail(rel, `${m.name}: NaN after build`);
    } catch (e) {
      fail(rel, `${m.name}: build error: ${(e as Error).message}`);
    }
  }

  const pg = poseGroups(doc.meshes);
  let note = "";
  if (pg.kind !== "static") {
    const by = new Map(doc.meshes.map((m) => [m.name, m]));
    try {
      const obj = buildMorphMesh(by.get(pg.base)!, pg.poses.map((n) => by.get(n)!), null);
      const n = obj.geometry.getAttribute("position").count;
      const targets = obj.geometry.morphAttributes.position ?? [];
      if (targets.length !== pg.poses.length) fail(rel, `expected ${pg.poses.length} morph targets, got ${targets.length}`);
      if (targets.some((a) => a.count !== n)) fail(rel, "morph target length mismatch");
      note = `  ${pg.kind}: ${pg.base} + ${pg.poses.length} pose(s)`;
    } catch (e) {
      fail(rel, `morph build error: ${(e as Error).message}`);
    }
  }
  if (data.length) note += `  data: ${data.join(", ")}`;

  const textures = new Set(doc.meshes.flatMap((m) => m.materials).map((m) => m?.texture).filter(Boolean));
  console.log(
    `${rel.padEnd(34)} meshes=${String(doc.meshes.length).padStart(2)} verts=${String(verts).padStart(6)} tris=${String(tris).padStart(6)} tex=${String(textures.size).padStart(2)}${note}`,
  );
}

console.log(failures ? `\n${failures} problem(s) in ${files.length} files` : `\nall ${files.length} files parsed and built cleanly`);
Deno.exit(failures ? 1 : 0);
