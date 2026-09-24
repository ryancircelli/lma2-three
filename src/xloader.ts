// DirectX .X (text format, "xof 0303txt") loader for three.js.
//
// Written for the Living Marine Aquarium 2 assets, which use a small, regular
// subset of the format: Material, Frame, FrameTransformMatrix, Mesh,
// MeshNormals, MeshTextureCoords, MeshMaterialList, TextureFilename. There is
// no skinning and no AnimationSet. Fish animate by blending whole-mesh poses
// ("opened"/"center"/"closed", or a numbered frame sequence), which this module
// turns into three.js morph targets - see buildMorphMesh().
//
// Coordinate systems: .X is Direct3D - left-handed, row-vector matrices. The
// row-major 16 floats of a D3D matrix are exactly what Matrix4.fromArray()
// wants for three.js's column-vector convention, so matrices go in unchanged.
// Handedness is fixed once, by mirroring Z on the root (handednessRoot()).

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface XMaterial {
  name: string;
  color: [number, number, number];
  opacity: number;
  power: number;
  specular: [number, number, number];
  emissive: [number, number, number];
  texture: string | null;
}

export interface XMesh {
  name: string;
  positions: Float32Array;
  faces: number[][];
  normals: Float32Array | null;
  normalFaces: number[][] | null;
  uvs: Float32Array | null;
  faceMaterials: Int32Array | null;
  materials: (XMaterial | null)[];
  /** Accumulated frame transform, in .X space. */
  world: THREE.Matrix4;
  frameName: string;
}

export interface XFrame {
  name: string;
  local: THREE.Matrix4;
  world: THREE.Matrix4;
  frames: XFrame[];
  meshes: XMesh[];
}

export interface XDoc {
  materials: Map<string, XMaterial>;
  frames: XFrame[];
  meshes: XMesh[];
}

/** How a model's meshes relate: which are poses of which. */
export type PoseGroup =
  | { kind: "swim"; base: string; poses: string[] } //  center + opened/closed
  | { kind: "sway"; base: string; poses: string[] } //  center + left/right
  | { kind: "cycle"; base: string; poses: string[] } // Name01 + Name02..NameNN
  | { kind: "static" };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
// Separators ';' and ',' only group values. Every counted array in this subset
// is self-describing, so they are skipped. What remains: identifiers, numbers,
// strings, GUIDs, and braces.

type Tok =
  | { t: "{" }
  | { t: "}" }
  | { t: "str"; v: string }
  | { t: "guid"; v: string }
  | { t: "num"; v: number }
  | { t: "id"; v: string };

const RE_TOKEN =
  /\s+|\/\/[^\n]*|#[^\n]*|[;,]|(\{)|(\})|"([^"]*)"|<([^>]*)>|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_.\-]*)/y;

function tokenize(text: string): Tok[] {
  // The first line is the "xof 0303txt 0032" header.
  const start = text.startsWith("xof ") ? text.indexOf("\n") + 1 : 0;
  const toks: Tok[] = [];
  RE_TOKEN.lastIndex = start;
  while (RE_TOKEN.lastIndex < text.length) {
    const at = RE_TOKEN.lastIndex;
    const m = RE_TOKEN.exec(text);
    if (!m) {
      throw new Error(`.X tokenizer stuck at offset ${at}: ${JSON.stringify(text.slice(at, at + 30))}`);
    }
    if (m[1]) toks.push({ t: "{" });
    else if (m[2]) toks.push({ t: "}" });
    else if (m[3] !== undefined) toks.push({ t: "str", v: m[3] });
    else if (m[4] !== undefined) toks.push({ t: "guid", v: m[4] });
    else if (m[5] !== undefined) toks.push({ t: "num", v: parseFloat(m[5]) });
    else if (m[6] !== undefined) toks.push({ t: "id", v: m[6] });
    // whitespace, comments and separators produce no token
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Generic block parser
// ---------------------------------------------------------------------------
// Every block is:   Type [Name] { items... }
// Items, in document order, are numbers/strings (data), child blocks, and
// references of the form { Name }. Order matters for MeshMaterialList, where
// references and inline Materials interleave to define material slots.

interface XNode {
  type: string;
  name: string;
  nums: number[];
  strs: string[];
  items: ({ ref: string } | { block: XNode })[];
  children: XNode[];
}

function parseBlocks(toks: Tok[]): XNode[] {
  let i = 0;

  function block(): XNode {
    const head = toks[i++] as { t: "id"; v: string };
    let name = "";
    const maybeName = toks[i];
    if (maybeName && maybeName.t === "id") {
      name = maybeName.v;
      i++;
    }
    if (!toks[i] || toks[i].t !== "{") throw new Error(`.X: expected '{' after ${head.v} ${name}`);
    i++;
    const node: XNode = { type: head.v, name, nums: [], strs: [], items: [], children: [] };
    for (;;) {
      const tk = toks[i];
      if (!tk) throw new Error(`.X: unterminated block ${node.type} ${name}`);
      if (tk.t === "}") {
        i++;
        break;
      }
      if (tk.t === "{") {
        // reference:  { Name }   (a GUID may also appear)
        i++;
        let ref = "";
        while (toks[i] && toks[i].t !== "}") {
          const r = toks[i++];
          if (r.t === "id") ref = r.v;
        }
        i++;
        node.items.push({ ref });
        continue;
      }
      if (tk.t === "id") {
        const child = block();
        node.children.push(child);
        node.items.push({ block: child });
        continue;
      }
      if (tk.t === "num") node.nums.push(tk.v);
      else if (tk.t === "str") node.strs.push(tk.v);
      i++; // guid: ignored
    }
    return node;
  }

  const top: XNode[] = [];
  while (i < toks.length) {
    if (toks[i].t === "id") top.push(block());
    else i++;
  }
  return top;
}

// ---------------------------------------------------------------------------
// Interpreting the blocks
// ---------------------------------------------------------------------------

function readMaterial(node: XNode): XMaterial {
  const d = node.nums;
  const tex = node.children.find((c) => c.type === "TextureFilename");
  return {
    name: node.name,
    color: [d[0] ?? 1, d[1] ?? 1, d[2] ?? 1],
    opacity: d[3] ?? 1,
    power: d[4] ?? 0,
    specular: [d[5] ?? 0, d[6] ?? 0, d[7] ?? 0],
    emissive: [d[8] ?? 0, d[9] ?? 0, d[10] ?? 0],
    texture: tex && tex.strs.length ? tex.strs[0] : null,
  };
}

/** d[k] = face count, then per face: n, i0..i(n-1). */
function readFaces(d: number[], k: number): number[][] {
  const nF = d[k++];
  const faces: number[][] = new Array(nF);
  for (let f = 0; f < nF; f++) {
    const n = d[k++];
    const idx: number[] = new Array(n);
    for (let j = 0; j < n; j++) idx[j] = d[k++];
    faces[f] = idx;
  }
  return faces;
}

function readMesh(node: XNode, materialsByName: Map<string, XMaterial>, world: THREE.Matrix4, frameName: string): XMesh {
  const d = node.nums;
  let k = 0;
  const nV = d[k++];
  const positions = new Float32Array(nV * 3);
  for (let v = 0; v < nV * 3; v++) positions[v] = d[k++];

  const mesh: XMesh = {
    name: node.name,
    positions,
    faces: readFaces(d, k),
    normals: null,
    normalFaces: null,
    uvs: null,
    faceMaterials: null,
    materials: [],
    world: world.clone(),
    frameName,
  };

  for (const c of node.children) {
    if (c.type === "MeshNormals") {
      const nd = c.nums;
      const nN = nd[0];
      mesh.normals = new Float32Array(nd.slice(1, 1 + nN * 3));
      mesh.normalFaces = readFaces(nd, 1 + nN * 3);
    } else if (c.type === "MeshTextureCoords") {
      const td = c.nums;
      mesh.uvs = new Float32Array(td.slice(1, 1 + td[0] * 2));
    } else if (c.type === "MeshMaterialList") {
      const md = c.nums;
      mesh.faceMaterials = new Int32Array(md.slice(2, 2 + md[1]));
      for (const it of c.items) {
        if ("ref" in it) mesh.materials.push(materialsByName.get(it.ref) ?? null);
        else if (it.block.type === "Material") mesh.materials.push(readMaterial(it.block));
      }
    }
  }
  // A material list may give a single face index meaning "all faces".
  if (mesh.faceMaterials && mesh.faceMaterials.length === 1 && mesh.faces.length > 1) {
    mesh.faceMaterials = new Int32Array(mesh.faces.length).fill(mesh.faceMaterials[0]);
  }
  return mesh;
}

function readFrame(node: XNode, materialsByName: Map<string, XMaterial>, parent: THREE.Matrix4, out: XMesh[]): XFrame {
  const local = new THREE.Matrix4();
  const ftm = node.children.find((c) => c.type === "FrameTransformMatrix");
  if (ftm) local.fromArray(ftm.nums);
  const world = new THREE.Matrix4().multiplyMatrices(parent, local);
  const frame: XFrame = { name: node.name, local, world, frames: [], meshes: [] };
  for (const c of node.children) {
    if (c.type === "Frame") frame.frames.push(readFrame(c, materialsByName, world, out));
    else if (c.type === "Mesh") {
      const m = readMesh(c, materialsByName, world, node.name);
      frame.meshes.push(m);
      out.push(m);
    }
  }
  return frame;
}

/**
 * Parse .X text into a plain description: materials, a frame tree, and a flat
 * list of meshes (each carrying its world matrix and the name of its frame).
 */
export function parseX(text: string): XDoc {
  const top = parseBlocks(tokenize(text));
  const materials = new Map<string, XMaterial>();
  for (const b of top) if (b.type === "Material") materials.set(b.name, readMaterial(b));

  const meshes: XMesh[] = [];
  const frames: XFrame[] = [];
  const identity = new THREE.Matrix4();
  for (const b of top) {
    if (b.type === "Frame") frames.push(readFrame(b, materials, identity, meshes));
    else if (b.type === "Mesh") meshes.push(readMesh(b, materials, identity, ""));
  }
  return { materials, frames, meshes };
}

/** Fetch and parse a .X file. */
export async function loadXDoc(url: string): Promise<XDoc> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseX(await res.text());
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Meshes with no triangles are data, not geometry: e.g. "Crab_Path" (a
 * polyline the crab walks) and "height" (the seabed height field). */
export function isRenderable(mesh: XMesh): boolean {
  return mesh.faces.some((f) => f.length >= 3);
}

/** Identify pose meshes by the naming conventions these assets use. */
export function poseGroups(meshes: XMesh[]): PoseGroup {
  const names = new Set(meshes.map((m) => m.name));
  if (names.has("center") && names.has("opened") && names.has("closed")) {
    return { kind: "swim", base: "center", poses: ["opened", "closed"] };
  }
  if (names.has("center") && names.has("left") && names.has("right")) {
    return { kind: "sway", base: "center", poses: ["left", "right"] };
  }
  const seq = meshes.map((m) => m.name).filter((n) => /\d+$/.test(n)).sort();
  if (seq.length > 2) {
    const stem = seq[0].replace(/\d+$/, "");
    if (seq.every((n) => n.startsWith(stem))) return { kind: "cycle", base: seq[0], poses: seq.slice(1) };
  }
  return { kind: "static" };
}

/** A data mesh's vertices in world (.X) space - e.g. the crab's walk path. */
export function pointsOf(mesh: XMesh): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    pts.push(new THREE.Vector3().fromArray(mesh.positions, i).applyMatrix4(mesh.world));
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
// Faces are fan-triangulated and expanded to one vertex per triangle corner
// ("un-indexed"). .X indexes normals separately from positions, so sharing
// vertices would need splitting anyway; un-indexing keeps it simple and makes
// morph targets line up corner for corner.

type Corner = [face: number, slot: number];
interface Group {
  start: number;
  count: number;
  materialIndex: number;
}

/** Triangle corners, ordered by material so each material draws as one group. */
function cornerPlan(mesh: XMesh): { corners: Corner[]; groups: Group[] } {
  const order = [...Array(mesh.faces.length).keys()];
  const fm = mesh.faceMaterials;
  if (fm) order.sort((a, b) => fm[a] - fm[b] || a - b);
  const corners: Corner[] = [];
  const groups: Group[] = [];
  let cur: Group | null = null;
  for (const f of order) {
    const mat = fm ? fm[f] : 0;
    if (!cur || cur.materialIndex !== mat) {
      cur = { start: corners.length, count: 0, materialIndex: mat };
      groups.push(cur);
    }
    const idx = mesh.faces[f];
    for (let t = 1; t + 1 < idx.length; t++) {
      corners.push([f, 0], [f, t], [f, t + 1]);
      cur.count += 3;
    }
  }
  return { corners, groups };
}

function expand(src: Float32Array, faces: number[][], corners: Corner[], stride: number): Float32Array {
  const out = new Float32Array(corners.length * stride);
  for (let c = 0; c < corners.length; c++) {
    const vi = faces[corners[c][0]][corners[c][1]];
    for (let s = 0; s < stride; s++) out[c * stride + s] = src[vi * stride + s];
  }
  return out;
}

/** Smooth normals accumulated per ORIGINAL vertex, then expanded. Used for
 * morphing meshes, whose poses must share one consistent normal definition. */
function smoothNormals(positions: Float32Array, faces: number[][], corners: Corner[]): Float32Array {
  const acc = new Float32Array(positions.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (const idx of faces) {
    for (let t = 1; t + 1 < idx.length; t++) {
      const tri = [idx[0], idx[t], idx[t + 1]];
      a.fromArray(positions, tri[0] * 3);
      b.fromArray(positions, tri[1] * 3);
      c.fromArray(positions, tri[2] * 3);
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)); // area-weighted
      for (const i of tri) {
        acc[i * 3] += n.x;
        acc[i * 3 + 1] += n.y;
        acc[i * 3 + 2] += n.z;
      }
    }
  }
  for (let i = 0; i < acc.length; i += 3) {
    n.fromArray(acc, i);
    if (n.lengthSq() > 0) n.normalize();
    n.toArray(acc, i);
  }
  return expand(acc, faces, corners, 3);
}

function fileNormals(mesh: XMesh, corners: Corner[]): Float32Array | null {
  const { normals, normalFaces } = mesh;
  if (!normals || !normalFaces || normalFaces.length !== mesh.faces.length) return null;
  const out = new Float32Array(corners.length * 3);
  for (let c = 0; c < corners.length; c++) {
    const ni = normalFaces[corners[c][0]][corners[c][1]];
    out[c * 3] = normals[ni * 3];
    out[c * 3 + 1] = normals[ni * 3 + 1];
    out[c * 3 + 2] = normals[ni * 3 + 2];
  }
  return out;
}

function expandUVs(mesh: XMesh, corners: Corner[]): Float32Array | null {
  if (!mesh.uvs) return null;
  const out = expand(mesh.uvs, mesh.faces, corners, 2);
  for (let i = 1; i < out.length; i += 2) out[i] = 1 - out[i]; // D3D v runs top-down
  return out;
}

function transformed(positions: Float32Array, m: THREE.Matrix4): Float32Array {
  const out = new Float32Array(positions.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) v.fromArray(positions, i).applyMatrix4(m).toArray(out, i);
  return out;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Loads textures relative to a base URL, once each. */
export class XTextureCache {
  private readonly baseUrl: string;
  private readonly loader = new THREE.TextureLoader();
  private readonly cache = new Map<string, THREE.Texture>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  }

  get(name: string | null): THREE.Texture | null {
    if (!name) return null;
    // Textures ship as .dds; the extract tool writes a .png beside each so they
    // load in every browser, not just ones exposing S3TC.
    const url = this.baseUrl + encodeURI(name.replace(/\.(dds|bmp|tga)$/i, ".png"));
    let tex = this.cache.get(url);
    if (!tex) {
      tex = this.loader.load(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      this.cache.set(url, tex);
    }
    return tex;
  }
}

function rgb(c: [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}

function makeMaterial(m: XMaterial | null, textures: XTextureCache | null): THREE.Material {
  if (!m) return new THREE.MeshPhongMaterial({ color: 0xff00ff }); // loud: unresolved material
  const map = textures ? textures.get(m.texture) : null;
  const mat = new THREE.MeshPhongMaterial({
    name: m.name,
    color: rgb(m.color),
    specular: rgb(m.specular),
    emissive: rgb(m.emissive),
    shininess: Math.max(1, m.power),
    map,
    side: THREE.DoubleSide,
  });
  mat.userData.xAlpha = m.opacity; // (the tank's creatures use it: fixedfunction.ts)
  // Fins and tails carry their outline in the DXT3 alpha channel. Cut it out
  // rather than blend, so there is no draw order to get wrong between parts.
  if (map) mat.alphaTest = 0.3;
  if (m.opacity < 0.999) {
    mat.transparent = true;
    mat.opacity = m.opacity;
    mat.depthWrite = false;
  }
  return mat;
}

function materialsFor(mesh: XMesh, textures: XTextureCache | null): THREE.Material | THREE.Material[] {
  const mats = mesh.materials.length ? mesh.materials.map((m) => makeMaterial(m, textures)) : [makeMaterial(null, textures)];
  return mats.length === 1 ? mats[0] : mats;
}

// ---------------------------------------------------------------------------
// Building three.js objects
// ---------------------------------------------------------------------------

/** A static THREE.Mesh from a parsed mesh, in its own local (frame) space. */
export function buildMesh(mesh: XMesh, textures: XTextureCache | null): THREE.Mesh {
  const { corners, groups } = cornerPlan(mesh);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(expand(mesh.positions, mesh.faces, corners, 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(fileNormals(mesh, corners) ?? smoothNormals(mesh.positions, mesh.faces, corners), 3));
  const uv = expandUVs(mesh, corners);
  if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  const obj = new THREE.Mesh(g, materialsFor(mesh, textures));
  obj.name = mesh.name;
  return obj;
}

/**
 * A mesh whose poses become morph targets.
 *
 * `base` supplies topology, UVs and materials. Every pose must have the same
 * vertex count and the same vertex ORDER - verified for these assets: pose
 * vertex i sits ~1 unit from base vertex i on a ~180-unit body, versus ~60 from
 * an arbitrary vertex. Pose face lists may differ (Percula's "opened" is
 * retriangulated), so the base's faces are used for every pose.
 *
 * Poses can live in frames with different transforms, so each is brought into
 * the base mesh's local space first.
 */
export function buildMorphMesh(base: XMesh, poses: XMesh[], textures: XTextureCache | null): THREE.Mesh {
  for (const p of poses) {
    if (p.positions.length !== base.positions.length) {
      throw new Error(`pose ${p.name} has ${p.positions.length / 3} vertices, base ${base.name} has ${base.positions.length / 3}`);
    }
  }
  const { corners, groups } = cornerPlan(base);
  const toBase = base.world.clone().invert();

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(expand(base.positions, base.faces, corners, 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(smoothNormals(base.positions, base.faces, corners), 3));
  const uv = expandUVs(base, corners);
  if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.materialIndex);

  const posTargets: THREE.BufferAttribute[] = [];
  const nrmTargets: THREE.BufferAttribute[] = [];
  const dict: Record<string, number> = {};
  poses.forEach((p, idx) => {
    const local = transformed(p.positions, new THREE.Matrix4().multiplyMatrices(toBase, p.world));
    posTargets.push(new THREE.BufferAttribute(expand(local, base.faces, corners, 3), 3));
    nrmTargets.push(new THREE.BufferAttribute(smoothNormals(local, base.faces, corners), 3));
    dict[p.name] = idx;
  });
  g.morphAttributes.position = posTargets;
  g.morphAttributes.normal = nrmTargets;
  g.morphTargetsRelative = false;

  const obj = new THREE.Mesh(g, materialsFor(base, textures));
  obj.name = base.name;
  obj.updateMorphTargets();
  obj.morphTargetDictionary = dict;
  return obj;
}

/**
 * A group that displays .X (Direct3D, left-handed) content correctly in
 * three.js (right-handed) by mirroring Z. three.js notices the negative
 * determinant and flips face winding itself.
 */
export function handednessRoot(): THREE.Group {
  const root = new THREE.Group();
  root.scale.set(1, 1, -1);
  return root;
}
