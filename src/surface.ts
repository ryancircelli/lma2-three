// The water surface: the band of bright, moving streaks across the top of the
// tank (common/watersurface.X textured with the caustics animation).
//
// How the original draws it (docs/original-logic.md 5.5, 0x41c300), each point
// verified against reference frames (tools/wine-surface.sh captures;
// tools/surfacemap.ts, tools/surfacestats.ts):
//
//   - FIRST in scene pass 0, before the Background plane, through the same
//     ORTHOGRAPHIC camera as the painting. So it shows only where the painting
//     is transparent - measured: mean dG 31 over open water, 1.8 over painted
//     pixels - like the clear colour it is added to.
//   - The "perspective" is baked into the mesh: a trapezoid (x +-4.75 at
//     z=+24, +-95 at z=-24) whose rows fold near z=12, so drawn flat it looks
//     like a plane seen from below. World = Scale(19,15,18), then Translate(0,
//     bboxMaxY - 200, bboxMaxZ) over the scene's world bbox. Scene 1: rows land
//     116/125/127/122/110/91/65/33/-7 px from the top; the fold at ~127 px is
//     the "horizon". Measured per screen row of the reference, BEFORE the
//     decompile was available: the texture repeats every 519.6 px at y=0,
//     falling to 161 px at y=126 (exactly periodic rows: autocorr 1.000), and
//     the texel row advances 2.2 repeats down the band; a free camera fit
//     converged on an orthographic view with x:y scale 1.27 (19/15 = 1.267).
//     This placement predicts the period to 0.3% (519.6 at y=0, 224.7 vs 224.9
//     at y=120, 160.2 vs 161.4 at y=126).
//   - u 0..4 across, v 1..-2 over the rows, WRAP. Texture = the current caustics
//     frame, shared with the Relief (caustics.ts causticClock: 18 fps; measured
//     here too: 18.0 frames/s over a 32 s reference sequence). No UV scroll:
//     the mapping is identical 7 s apart.
//   - ONE/ONE additive, Z off, colour = texture x diffuse x fog, where the fog
//     is linear vertex fog to BLACK - the only thing that fades the streaks
//     toward the horizon.
//   - Back faces culled: the rows that fold back up (0-2) are not drawn (with
//     them the band near y=116-126 would be 10-30% brighter than measured).

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { causticClock, causticTextures } from "./caustics.ts";
import { loadXDoc, type XMesh } from "./xloader.ts";

/** World transform of the mesh, from the decompiled draw call. */
const SCALE = { x: 19, y: 15, z: 18 };
const DROP_Y = 200; // below the scene bbox's top

/**
 * The surface's vertex diffuse. Every normal of watersurface.X points DOWN
 * (n.y -0.986..-0.998), so neither light reaches it: its diffuse is exactly
 * the AMBIENT light state, and nothing sets that before the surface draws -
 * it is whatever the previous frame's last ambient-setting draw left
 * (docs/fidelity-review.md D4, frame order 0x40e330):
 *   Foreground plane 0xFF; Relief caustics (caustic) 0x80 after; then the
 *   nearest creature in front: fish 0xAA, 0x80 with causticonfish; sea horse
 *   0x80; a sea star on the glass 0x80 (caustic). Tank.ambientLeft().
 * The first frame sees the init state, 0x80. Grey: the measured G/B "tint"
 * with creatures was scene 1's channel saturation.
 * Measured before this was known (scene 1; tools/surfacemap.ts,
 * tools/surfaceratio.py): 1.00 with no creatures and caustics off, 0.50 with
 * caustics on (ref/ours 1.003 and 1.008 over 40 frames each) - both as
 * predicted - and, as sequence means with creatures, R 0.65 / G 0.61
 * (caustics off; 0xAA = 0.667) and R 0.64 / G 0.46 (on; 0x80 = 0.50). The
 * R 0.64 in the last case is not explained. ?surfshade=<v> forces a level.
 */
const SHADE_OVERRIDE = new URLSearchParams(globalThis.location?.search ?? "").get("surfshade");
/** LIGHTSTATE_AMBIENT at init (0x4134f3). */
const INITIAL_AMBIENT = 0x80 / 255;

/** Linear fog to black, as the original sets it up from the scene depth
 * (bbox z extent): factor = (end - zEye) / (end - start), clamped. */
function fogFactor(zEye: number, depth: number): number {
  const end = depth + 2500, start = 0.8 * (depth + 1000) + 1500;
  return Math.min(1, Math.max(0, (end - zEye) / (end - start)));
}

// Per-vertex fog factor, interpolated like D3D's vertex fog.
const vertexShader = /* glsl */ `
  attribute float fog;
  varying vec2 vUv;
  varying float vFog;
  void main() {
    vUv = uv;
    vFog = fog;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Raw 8-bit values in, raw values out: D3D blended in gamma space, and so does
// this (no colour-space conversion on the texture or the output). Fog to black
// = lerp(black, colour, f) = colour * f.
const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 diffuse;
  varying vec2 vUv;
  varying float vFog;
  void main() {
    gl_FragColor = vec4(texture2D(map, vUv).rgb * diffuse * vFog, 1.0);
  }
`;

export class WaterSurface {
  /** Add to the scene's pass-0 group (`SceneModel.back`, mirrored for
   * handedness): the geometry is in .X world space. */
  readonly object = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly textures: THREE.Texture[];

  private constructor(private readonly src: XMesh, assetsUrl: string) {
    this.object.name = "water-surface";
    this.textures = causticTextures(assetsUrl);
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.textures[0] }, diffuse: { value: new THREE.Vector3(1, 1, 1) } },
      vertexShader,
      fragmentShader,
      // Opaque-list material (drawn before every transparent part of the
      // painting) with custom blending: exactly D3D's SRCBLEND=ONE, DESTBLEND=ONE.
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthTest: false,
      depthWrite: false,
      side: THREE.FrontSide, // D3D's default CULL_CCW (the Z mirror keeps "front" the same)
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.object.add(this.mesh);
    this.setAmbient(INITIAL_AMBIENT);
  }

  static async load(assetsUrl: string): Promise<WaterSurface> {
    const doc = await loadXDoc(`${assetsUrl}common/watersurface.X`);
    const src = doc.meshes.find((m) => m.faces.length && m.uvs);
    if (!src) throw new Error("watersurface.X: no textured mesh");
    return new WaterSurface(src, assetsUrl);
  }

  /** The ambient light state the previous frame left (grey 0..1): the surface's diffuse. Call once per frame. */
  setAmbient(level: number): void {
    const d = SHADE_OVERRIDE !== null ? Number(SHADE_OVERRIDE) : level;
    (this.material.uniforms.diffuse.value as THREE.Vector3).setScalar(d);
  }

  /** Place the surface for a scene: it hangs from the top of the scene's world
   * bounding box (every vertex in its mesh.X, Relief included), in .X space. */
  async setScene(id: string, assetsUrl: string): Promise<void> {
    const doc = await loadXDoc(`${assetsUrl}scenes/${id}/mesh.X`);
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const m of doc.meshes) {
      for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
    }
    this.build(box);
    // Scene objects are ordered far to near by renderOrder = -z (scene.ts);
    // this goes just before the Background (z = bbox max z).
    this.mesh.renderOrder = -box.max.z - 1;
  }

  private build(box: THREE.Box3): void {
    const m = this.src;
    const n = m.positions.length / 3;
    const depth = box.max.z - box.min.z;
    const eyeZ = box.min.z - 2000; // the original's eye: 2000 in front of the bbox
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), fog = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
      const wz = SCALE.z * z + box.max.z;
      pos.set([SCALE.x * x, SCALE.y * y + box.max.y - DROP_Y, wz], i * 3);
      uv.set([m.uvs![i * 2], 1 - m.uvs![i * 2 + 1]], i * 2); // D3D v runs top-down
      fog[i] = fogFactor(wz - eyeZ, depth);
    }
    const index = m.faces.flatMap((f) => f.slice(1, -1).flatMap((_, k) => [f[0], f[k + 1], f[k + 2]]));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("fog", new THREE.BufferAttribute(fog, 1));
    g.setIndex(index);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** Show the caustics frame for time `t` (seconds) - the Relief's clock. */
  update(t: number): void {
    this.material.uniforms.map.value = this.textures[causticClock(t).frame];
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose(); // the textures are shared with caustics.ts
  }
}
