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

export interface FishInstance {
  object: THREE.Object3D;
  setPhase(phase: number): void;
}

export interface FishModel {
  /** Handedness-corrected, centred on the origin. Heads point along +X. */
  object: THREE.Group;
  kind: PoseGroup["kind"];
  /** Bounding-sphere radius, in model units. */
  radius: number;
  /** Nose-to-tail extent (X), in model units. */
  length: number;
  triangles: number;
  /** Set the pose. `phase` is in cycles: one fin flap, sway, or walk stride. */
  setPhase(phase: number): void;
  /** An independently animated copy sharing geometry and textures. */
  instance(): FishInstance;
  dispose(): void;
}

export async function loadFish(entry: FishEntry, assetsUrl: string): Promise<FishModel> {
  const base = `${assetsUrl}fish/${entry.slug}/`;
  const textures = new XTextureCache(base);
  const doc = await loadXDoc(base + "mesh.X");
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

  // Centre on the origin (in the mirrored space the viewer sees).
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  inner.position.sub(object.worldToLocal(box.getCenter(new THREE.Vector3())));

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

  /**
   * An independent copy for the tank. Geometry, textures and materials are
   * shared with the template (Object3D.clone is shallow for those); morph
   * weights are copied per mesh, so each instance animates on its own.
   */
  function instance(): FishInstance {
    const copy = object.clone(true);
    let weights: number[] = [];
    copy.traverse((o) => {
      if (o instanceof THREE.Mesh && o.morphTargetInfluences && o.morphTargetInfluences.length) weights = o.morphTargetInfluences;
    });
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

  return { object, kind, radius: sphere.radius, length: size.x, triangles, setPhase, instance, dispose };
}
