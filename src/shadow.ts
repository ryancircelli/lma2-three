// common/shadow.png (32x32 dark blob with alpha): the anemone crab's shadow.
//
// Findings (reference frames of the original + docs/original-logic.md 4.1):
//   - Only the CRAB uses it: a soft dark ellipse under its body is visible in
//     every reference frame with the crab. Fish cast NO shadow - fish passing
//     low over the sand in the references leave the sand unchanged - and the
//     sea star carries its own Sea_Star_Shadow mesh.
//   - Decompiled: a 200x200 quad in crab space at local y = 3*sin(phase) - 10,
//     colour = texture, alpha = texture*diffuse, SRCALPHA/INVSRCALPHA, Z off,
//     drawn before the crab's body.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";

/** Quad size and height in the crab's own model units (decompiled). */
const SIZE = 200;
const Y = -10;

/**
 * Put the shadow under a crab model. `model` is the object loadFish() returns
 * (handedness root -> inner model-space group); the quad goes into model space,
 * so instances cloned from it carry their own copy.
 *
 * Not reproduced: the +-3 unit bob with the walk phase (~2 px on screen).
 * CALIBRATE: alpha = texture * diffuse; diffuse taken as 1.
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
