// Load one species from the extracted assets as an animatable three.js object.
//
// The poses each model ships become morph targets (see xloader.ts):
//
//   swim   center + opened + closed     every swimming fish - FINS spread and
//                                       folded (pectoral + front dorsal). The
//                                       tail is identical in all three poses.
//   sway   center + left + right        sea horse
//   cycle  12-frame walk                anemone crab
//   static                              sea star
//
// Not in the data - the original computes these in compiled code:
//   - body undulation / tail beat
//   - where each fish goes: paths, turning, schooling
// Those are re-created elsewhere, not recovered.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import {
  buildMesh,
  buildMorphMesh,
  handednessRoot,
  isRenderable,
  loadXDoc,
  type PoseGroup,
  poseGroups,
  XTextureCache,
  type XMesh,
} from "./xloader.ts";

export interface FishEntry {
  slug: string;
  name: string;
  files: string[];
  picture: string | null;
  /** From the species' own settings.xml: school, scale, speed, aggression, behav. */
  behaviour: Record<string, number>;
}

/** Per-frame inputs of the original's swim deformation (docs/original-logic.md 3.10). */
export interface SwimPose {
  /** t + the fish's time offset, seconds. */
  tt: number;
  /** Fin phase: starts at the time offset, gains 2*step per frame. */
  ph: number;
  /** The speed state machine's speedAnim (0..15). */
  sa: number;
  /** settings.xml speed * 0.1. */
  speed: number;
}

export interface FishInstance {
  object: THREE.Object3D;
  setPhase(phase: number): void;
  /** Swimming fish only: the original's vertex animation for this frame. */
  swim?(p: SwimPose): void;
}

export interface FishModel {
  /** Handedness-corrected, centred on the origin (unless loaded with recentre: false). Heads point along +X. */
  object: THREE.Group;
  kind: PoseGroup["kind"];
  /** Bounding-sphere radius, in model units. */
  radius: number;
  /**
   * The collision radius the original keeps for this file (+0x4c): the
   * bounding sphere that 0x431ad0 computes at load with 0x42ef70, over EVERY
   * vertex of EVERY mesh in mesh.X (all pose meshes and the eyes, frame
   * matrices applied), centred on the vertex centroid.
   */
  fileRadius: number;
  /** Nose-to-tail extent (X), in model units. */
  length: number;
  triangles: number;
  /** Set the pose. `phase` is in cycles: one fin flap, sway, or walk stride. */
  setPhase(phase: number): void;
  /** An independently animated copy sharing geometry and textures. */
  instance(): FishInstance;
  dispose(): void;
}

export interface LoadOptions {
  /**
   * Centre the model on its bounding box (default, for the model viewer). The
   * tank passes false: the original draws every creature from its raw .X
   * origin, which is off the box centre by (5.4, 7.25) units on the crab,
   * (9.1, 4.0) on the sea star (its spin axis) and 9.3 along the sea horse
   * (docs/fidelity-review.md D5); by ~0 on the fish.
   */
  recentre?: boolean;
}

export async function loadFish(entry: FishEntry, assetsUrl: string, opts: LoadOptions = {}): Promise<FishModel> {
  const base = `${assetsUrl}fish/${entry.slug}/`;
  const textures = new XTextureCache(base);
  const doc = await loadXDoc(base + "mesh.X");
  const fileRadius = fileSphereRadius(doc.meshes);
  const byName = new Map(doc.meshes.map((m) => [m.name, m]));
  let pg = poseGroups(doc.meshes);

  let morphBase: XMesh | null = null;
  let poses: XMesh[] = [];

  if (pg.kind === "cycle" && entry.files.includes("full_mesh.X")) {
    // The crab: mesh.X holds 12 untextured walk frames; full_mesh.X is the same
    // 1006-vertex crab WITH texture and UVs. Use it as the base and every walk
    // frame as a target, so frame i is shown exactly by weight 1 on target i.
    const full = await loadXDoc(base + "full_mesh.X");
    morphBase = full.meshes[0];
    poses = [pg.base, ...pg.poses].map((n) => byName.get(n)!);
    pg = { kind: "cycle", base: morphBase.name, poses: poses.map((p) => p.name) };
  } else if (pg.kind !== "static") {
    morphBase = byName.get(pg.base)!;
    poses = pg.poses.map((n) => byName.get(n)!);
  }

  const inner = new THREE.Group();
  let morph: THREE.Mesh | null = null;
  if (morphBase) {
    morph = buildMorphMesh(morphBase, poses, textures);
    morph.applyMatrix4(morphBase.world);
    inner.add(morph);
  }
  const posed = new Set([...(morphBase ? [morphBase.name] : []), ...poses.map((p) => p.name)]);
  for (const m of doc.meshes) {
    if (posed.has(m.name) || !isRenderable(m)) continue;
    const obj = buildMesh(m, textures);
    obj.applyMatrix4(m.world);
    inner.add(obj);
  }

  const object = handednessRoot();
  object.name = entry.slug;
  object.add(inner);

  // Centre on the origin (in the mirrored space the viewer sees), unless the
  // raw origin is wanted.
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (opts.recentre !== false) inner.position.sub(object.worldToLocal(box.getCenter(new THREE.Vector3())));

  let triangles = 0;
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) triangles += o.geometry.getAttribute("position").count / 3;
  });

  const kind = pg.kind;
  /** Pose driver for one set of morph weights (the template's, or a clone's). */
  function poser(influences: number[]): (phase: number) => void {
    const n = influences.length;
    return (phase: number) => {
      if (!n) return;
      influences.fill(0);
      if (kind === "swim" || kind === "sway") {
        // center -> pose A -> center -> pose B -> center (fins open/fold, or sway)
        const s = Math.sin(phase * Math.PI * 2);
        influences[0] = Math.max(0, s);
        influences[1] = Math.max(0, -s);
      } else if (kind === "cycle") {
        // Linear blend between consecutive frames, wrapping last -> first.
        const p = (((phase % 1) + 1) % 1) * n;
        const i = Math.floor(p), f = p - i;
        influences[i] += 1 - f;
        influences[(i + 1) % n] += f;
      }
    };
  }
  const setPhase = poser(morph?.morphTargetInfluences ?? []);
  setPhase(0);

  const swimData = kind === "swim" && morph ? prepareSwim(morph) : null;

  /**
   * An independent copy for the tank. Geometry, textures and materials are
   * shared with the template (Object3D.clone is shallow for those); morph
   * weights are copied per mesh, so each instance animates on its own.
   */
  function instance(): FishInstance {
    const copy = object.clone(true);
    let weights: number[] = [];
    let body: THREE.Mesh | null = null;
    const eyes: THREE.Object3D[] = [];
    copy.traverse((o) => {
      if (o instanceof THREE.Mesh && o.morphTargetInfluences && o.morphTargetInfluences.length) {
        weights = o.morphTargetInfluences;
        body = o;
      }
      if (/^(Left|Right)Eye$/.test(o.name)) eyes.push(o);
    });
    if (swimData && body) {
      // The swim animation edits vertices on the CPU, as the original does:
      // this copy gets its own position/normal buffers and no morphing.
      const m = body as THREE.Mesh;
      m.geometry = m.geometry.clone();
      m.geometry.morphAttributes = {};
      m.morphTargetInfluences = undefined;
      m.morphTargetDictionary = undefined;
      m.frustumCulled = false;
      return { object: copy, setPhase: () => {}, swim: swimDeformer(swimData, m, eyes, instances++) };
    }
    return { object: copy, setPhase: poser(weights) };
  }

  const size = box.getSize(new THREE.Vector3());

  function dispose(): void {
    object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        (m as THREE.MeshPhongMaterial).map?.dispose();
        m.dispose();
      }
    });
  }

  return { object, kind, radius: sphere.radius, fileRadius, length: size.x, triangles, setPhase, instance, dispose };
}

/** 0x42ef70 (callbacks 0x42e8c0 / 0x42e980): the centroid of all vertices, then the largest distance from it. */
function fileSphereRadius(meshes: XMesh[]): number {
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  let n = 0;
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) c.add(v.fromArray(m.positions, i).applyMatrix4(m.world)), n++;
  }
  if (!n) return 0;
  c.divideScalar(n);
  let r = 0;
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) r = Math.max(r, v.fromArray(m.positions, i).applyMatrix4(m.world).distanceTo(c));
  }
  return r;
}

// --- the original's swim animation (docs/original-logic.md 3.10) ---------------
//
// Each frame the body is rebuilt from the `center` pose, then, in order:
//   1. tail ripple on the `*_tail*` material subset
//   2. gills and pectoral fins blended toward `opened` (w > 0) or `closed`
//      (w < 0) - ONLY those subsets, never the whole body:
//        gills w = sin(10 ph), fin_left w = sin(25 ph / speed), fin_right w = cos(25 ph / speed)
//   3. whole-body bend around a vertical axis (the swimming undulation)
//   4. eyes swivel to random targets, cancelling the bend where they sit
// All in the mesh's own (.X, left-handed) coordinates, as in the original.

let instances = 0;

interface Range {
  start: number;
  count: number;
}

interface SwimData {
  pos: Float32Array;
  nrm: Float32Array;
  opened: { pos: Float32Array; nrm: Float32Array } | null;
  closed: { pos: Float32Array; nrm: Float32Array } | null;
  gills: Range[];
  finLeft: Range[];
  finRight: Range[];
  tail: Range[];
  tailBox: { minX: number; maxX: number; minY: number; maxY: number };
}

function prepareSwim(mesh: THREE.Mesh): SwimData {
  const g = mesh.geometry;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const pick = (re: RegExp): Range[] =>
    g.groups.filter((gr) => re.test(mats[gr.materialIndex ?? 0]?.name ?? "")).map((gr) => ({ start: gr.start, count: gr.count }));
  const dict = mesh.morphTargetDictionary ?? {};
  const target = (name: string) => {
    const i = dict[name];
    if (i === undefined) return null;
    return {
      pos: (g.morphAttributes.position![i] as THREE.BufferAttribute).array as Float32Array,
      nrm: (g.morphAttributes.normal![i] as THREE.BufferAttribute).array as Float32Array,
    };
  };
  const pos = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const tail = pick(/_tail/i);
  const tailBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const r of tail) {
    for (let v = r.start; v < r.start + r.count; v++) {
      tailBox.minX = Math.min(tailBox.minX, pos[v * 3]), tailBox.maxX = Math.max(tailBox.maxX, pos[v * 3]);
      tailBox.minY = Math.min(tailBox.minY, pos[v * 3 + 1]), tailBox.maxY = Math.max(tailBox.maxY, pos[v * 3 + 1]);
    }
  }
  return {
    pos: pos.slice(),
    nrm: ((g.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array).slice(),
    opened: target("opened"),
    closed: target("closed"),
    gills: pick(/gills/i),
    finLeft: pick(/fin_left/i),
    finRight: pick(/fin_right/i),
    tail,
    tailBox,
  };
}

function swimDeformer(d: SwimData, mesh: THREE.Mesh, eyes: THREE.Object3D[], seed: number): (p: SwimPose) => void {
  const posAttr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const nrmAttr = mesh.geometry.getAttribute("normal") as THREE.BufferAttribute;
  const P = posAttr.array as Float32Array, N = nrmAttr.array as Float32Array;
  const eyeBase = eyes.map((e) => ({ q: e.quaternion.clone(), p: e.position.clone() }));
  const q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
  // Eye targets: (3 - rand%6) * 0.1 rad, re-chosen every (rand%20)/15 s.
  let s = (seed * 2654435761 + 12345) >>> 0;
  const rand = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16 & 0x7fff;
  let eyeYaw = 0, eyeNext = -1;

  function blend(ranges: Range[], w: number): void {
    const t = w > 0 ? d.opened : d.closed;
    if (!t || w === 0) return;
    const a = Math.abs(w);
    for (const r of ranges) {
      for (let i = r.start * 3; i < (r.start + r.count) * 3; i++) {
        P[i] = d.pos[i] + (t.pos[i] - d.pos[i]) * a;
        N[i] = d.nrm[i] + (t.nrm[i] - d.nrm[i]) * a;
      }
    }
  }

  return ({ tt, ph, sa, speed }: SwimPose) => {
    P.set(d.pos);
    N.set(d.nrm);
    // 1. tail ripple
    const tb = d.tailBox, h = tb.maxY - tb.minY, wx = tb.maxX - tb.minX;
    if (h > 0 && wx > 0) {
      for (const r of d.tail) {
        for (let v = r.start; v < r.start + r.count; v++) {
          const x = P[v * 3], y = P[v * 3 + 1];
          const u = (tb.maxX - x) / wx;
          const dd = u * u * 0.025 * h * Math.sin(3 * (tb.maxY - y) / h + 5 * tt);
          P[v * 3 + 2] += dd;
          P[v * 3] += dd / 2;
          N[v * 3] += dd / 6;
          N[v * 3 + 2] += dd;
        }
      }
    }
    // 2. gills and fins
    blend(d.gills, Math.sin(10 * ph));
    blend(d.finLeft, Math.sin(25 * ph / speed));
    blend(d.finRight, Math.cos(25 * ph / speed));
    // 3. body bend: k = (sa+6) * clamp(-cos(5 tt) (sa+2)/17, -1, 1) / 21, R = 250/k
    let k = (sa + 6) * THREE.MathUtils.clamp(-Math.cos(5 * tt) * (sa + 2) / 17, -1, 1) / 21;
    if (Math.abs(k) < 1e-4) k = k < 0 ? -1e-4 : 1e-4;
    const R = 250 / k;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], z = P[i + 2], th = x / R, c = Math.cos(th), sn = Math.sin(th);
      P[i] = sn * (R - z);
      P[i + 2] = R - c * (R - z);
      const nx = N[i], nz = N[i + 2];
      let n0 = nx * c - nz * sn, n1 = N[i + 1], n2 = nx * sn + nz * c;
      const l = Math.hypot(n0, n1, n2) || 1;
      n0 /= l, n1 /= l, n2 /= l;
      N[i] = n0, N[i + 1] = n1, N[i + 2] = n2;
    }
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
    // 4. eyes
    if (tt >= eyeNext) {
      eyeYaw = (3 - rand() % 6) * 0.1;
      eyeNext = tt + (rand() % 20) / 15;
    }
    eyes.forEach((e, i) => {
      const { p, q: q0 } = eyeBase[i], th = p.x / R;
      e.position.set(Math.sin(th) * (R - p.z), p.y, R - Math.cos(th) * (R - p.z)); // ride the bend
      e.quaternion.copy(q0).multiply(q.setFromAxisAngle(yAxis, eyeYaw)); // net of the bend, as in the original
    });
  };
}
