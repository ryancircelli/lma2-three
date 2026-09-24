// common/shadow.png (32x32 dark blob with alpha): the anemone crab's shadow.
//
// Findings (reference frames of the original + docs/original-logic.md 4.1):
//   - Only the CRAB uses it: a soft dark ellipse under its body is visible in
//     every reference frame with the crab. Fish cast NO shadow - fish passing
//     low over the sand in the references leave the sand unchanged - and the
//     sea star carries its own Sea_Star_Shadow mesh.
//   - Decompiled: a 200x200 quad in crab space at local y = 3*sin(phase) - 10
//     (phase = the walk phase), colour = texture, alpha = texture*diffuse
//     (diffuse = its white vertex colour), SRCALPHA/INVSRCALPHA, Z off, drawn
//     before the crab's body.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";

/** Quad size and height in the crab's own model units (decompiled). */
const SIZE = 200;
const Y = -10;

/**
 * Put the shadow under a crab model. `model` is the object loadFish() returns
 * (handedness root -> inner model-space group); the quad goes into model space,
 * so instances cloned from it carry their own copy. Its vertices are
 * D3DLVERTEX with colour white (FVF 0x1e2), so alpha = texture alpha.
 * The +-3 unit bob with the walk phase: bobCrabShadow(), every frame.
 */
export function attachCrabShadow(model: THREE.Object3D, assetsUrl: string): void {
  const inner = model.children[0] ?? model;
  const map = new THREE.TextureLoader().load(`${assetsUrl}common/shadow.png`);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map,
    depthTest: false, // Z off
    depthWrite: false,
    side: THREE.DoubleSide,
    // SRCALPHA/INVSRCALPHA, but kept in three.js's OPAQUE list (transparent =
    // false) so renderOrder can put it before the body, as the original does.
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), material);
  quad.name = "crab-shadow";
  quad.rotation.x = -Math.PI / 2; // lies flat, in the crab's XZ plane
  quad.position.y = Y;
  quad.renderOrder = -1;
  inner.add(quad);
}

const quads = new WeakMap<THREE.Object3D, THREE.Object3D | null>();

/**
 * The shadow's height follows the crab's walk phase (the pose counter, 0x409d00
 * / draw 0x40ab70): local y = 3 sin(phase) - 10, a +-3 unit bob (~2 px).
 * `crab` is the crab's instance object (it holds its own quad copy).
 */
export function bobCrabShadow(crab: THREE.Object3D, phase: number): void {
  let q = quads.get(crab);
  if (q === undefined) {
    q = crab.getObjectByName("crab-shadow") ?? null;
    quads.set(crab, q);
  }
  if (q) q.position.y = 3 * Math.sin(phase) + Y;
}
