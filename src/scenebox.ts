// The scene's world bounding box, as the original computes it (docs/original-logic.md
// section 1): min/max over every vertex of every mesh in scenes/<n>/mesh.X - Relief,
// Background, Foreground, billboards and the `height` polyline included - with
// the frame transforms applied. In .X (Direct3D, left-handed) space: +z is AWAY
// from the viewer. Our scene roots mirror z (xloader handednessRoot); x and y
// are the same in both.
//
// The bubbles, light rays and light motes are all placed relative to it.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { loadXDoc } from "./xloader.ts";

const cache = new Map<string, Promise<THREE.Box3>>();

export function loadSceneBox(id: string, assetsUrl: string): Promise<THREE.Box3> {
  const key = `${assetsUrl}|${id}`;
  let box = cache.get(key);
  if (!box) {
    box = loadXDoc(`${assetsUrl}scenes/${id}/mesh.X`).then((doc) => {
      const b = new THREE.Box3();
      const v = new THREE.Vector3();
      for (const m of doc.meshes) {
        for (let i = 0; i < m.positions.length; i += 3) {
          b.expandByPoint(v.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]).applyMatrix4(m.world));
        }
      }
      return b;
    });
    cache.set(key, box);
  }
  return box;
}

/** Deterministic stand-in for MSVC rand(): integers 0..32767 (mulberry32 underneath). */
export function msvcRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) >>> 17;
  };
}
