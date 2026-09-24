// The water surface: the band of bright, moving streaks across the top of the
// tank (common/watersurface.X textured with the caustics animation).
//
// How the original draws it (decompiled, FUN_0041c300) - and verified against
// reference frames (tools/wine-surface.sh, tools/surfacemap.ts, tools/surfacestats.ts):
//
//   - FIRST in the scene pass, before the Background plane, with the same
//     ORTHOGRAPHIC camera as the painting. So it shows only where the painting
//     is transparent (measured: mean dG over painted pixels 1.8 vs 31 over open
//     water), exactly like the clear colour it is added to.
//   - The "perspective" is baked into the mesh: a trapezoid (x +-4.75 at z=+24,
//     +-95 at z=-24) whose rows fold at z~12, so drawn flat it LOOKS like a
//     horizontal plane seen from below. World = Scale(19,15,18) then
//     Translate(0, bboxMaxY - 200, bboxMaxZ) over the scene's world bbox.
//     Scene 1: rows land at 116/125/127/122/110/91/65/33/-7 px from the top;
//     the fold at ~127 px is the "horizon". Measured per screen row, the
//     texture repeat width runs 519.6 px (y=0) -> 161 px (y=126) and the texel
//     row advances 2.2 repeats down the band: this placement reproduces both to
//     0.3% / 0.4 texel (tools/surfacemap.ts on reference vs ours).
//   - u 0..4 across, v 1..-2 over the rows, WRAP. The texture is the current
//     caustics frame, floor(t * 18) % 29 + 1 (measured: 18.0 frames/s over a
//     32 s reference sequence; the mesh's own "caust00.dds" is unused).
//   - Blend ONE/ONE (additive; G clips at 255 in scene 1), z test off,
//     colour = vertex diffuse x texture, then linear vertex fog to BLACK - the
//     fog is what fades the streaks toward the horizon (gain ~0.9 at the top,
//     ~0.4 at y=122). No scrolling: the mapping is identical 7 s apart.
//   - Back faces culled: the part of the mesh that folds back up (rows 0-2) is
//     not drawn (the measured gain near the fold fits the front layer alone).

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { handednessRoot, loadXDoc, type XMesh } from "./xloader.ts";

/** Caustics animation: frames caustics_01..29, advanced by wall time. */
const FRAMES = 29;
const FPS = 18;

/** World transform of the mesh, from the decompiled draw call. */
const SCALE = { x: 19, y: 15, z: 18 };
const DROP_Y = 200; // below the scene bbox's top

// --- CALIBRATE ---------------------------------------------------------------
/** Vertex lighting: diffuse = AMBIENT + LIGHT * (N . down), per channel,
 * clamped to 1. The decompile shows ambient + one directional light; AMBIENT
 * 0x80 is inferred, LIGHT fitted to the measured per-row gain (rms 0.048 with
 * fog). The data cannot separate this from a flat ~0.93: N . down only spans
 * 0.80-0.99 across the band. */
const AMBIENT = 128 / 255;
const LIGHT = 0.5;
// ------------------------------------------------------------------------------

/** Linear fog to black, as the original sets it up from the scene depth
 * (bbox z extent): factor = (end - zEye) / (end - start), clamped. */
function fogFactor(zEye: number, depth: number): number {
  const end = depth + 2500, start = 0.8 * (depth + 1000) + 1500;
  return Math.min(1, Math.max(0, (end - zEye) / (end - start)));
}

const vertexShader = /* glsl */ `
  attribute float shade;
  attribute float fog;
  varying vec2 vUv;
  varying float vShade;
  varying float vFog;
  void main() {
    vUv = uv;
    vShade = shade;
    vFog = fog;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Raw 8-bit values in, raw values out: D3D blended in gamma space, and so does
// this (no colour-space conversion on the texture or the output).
const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vShade;
  varying float vFog;
  void main() {
    gl_FragColor = vec4(texture2D(map, vUv).rgb * vShade * vFog, 1.0);
  }
`;

export class WaterSurface {
  /** Add to the painting's (orthographic) scene; it draws before the painting. */
  readonly object = handednessRoot();
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private frame = -1;

  private constructor(private readonly src: XMesh, private readonly textures: THREE.Texture[]) {
    this.object.name = "water-surface";
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: textures[0] } },
      vertexShader,
      fragmentShader,
      // Opaque-list material (drawn before the transparent painting) with
      // custom blending: exactly D3D's SRCBLEND=ONE, DESTBLEND=ONE.
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
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.object.add(this.mesh);
  }

  static async load(assetsUrl: string): Promise<WaterSurface> {
    const doc = await loadXDoc(`${assetsUrl}common/watersurface.X`);
    const src = doc.meshes.find((m) => m.faces.length && m.uvs && m.normals);
    if (!src) throw new Error("watersurface.X: no textured mesh");
    const loader = new THREE.TextureLoader();
    const textures = await Promise.all(
      Array.from({ length: FRAMES }, (_, i) =>
        loader.loadAsync(`${assetsUrl}common/caustics_${String(i + 1).padStart(2, "0")}.png`).then((t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.colorSpace = THREE.NoColorSpace; // raw values - see the fragment shader
          return t;
        })
      ),
    );
    return new WaterSurface(src, textures);
  }

  /** Place the surface for a scene: it hangs from the top of the scene's world
   * bounding box (every mesh in its mesh.X, Relief included), in .X space. */
  async setScene(id: string, assetsUrl: string): Promise<void> {
    const doc = await loadXDoc(`${assetsUrl}scenes/${id}/mesh.X`);
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const m of doc.meshes) {
      for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
    }
    this.build(box);
  }

  private build(box: THREE.Box3): void {
    const m = this.src;
    const n = m.positions.length / 3;
    const depth = box.max.z - box.min.z;
    const eyeZ = box.min.z - 2000; // the original's eye: 2000 in front of the bbox
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const shade = new Float32Array(n), fog = new Float32Array(n);
    // Normals are indexed separately in .X; this mesh's normal faces match its
    // position faces corner for corner, so map them through the faces.
    const normalOf = new Int32Array(n).fill(-1);
    m.faces.forEach((f, fi) => f.forEach((vi, c) => (normalOf[vi] = m.normalFaces?.[fi]?.[c] ?? vi)));
    for (let i = 0; i < n; i++) {
      const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
      const wz = SCALE.z * z + box.max.z;
      pos.set([SCALE.x * x, SCALE.y * y + box.max.y - DROP_Y, wz], i * 3);
      uv.set([m.uvs![i * 2], 1 - m.uvs![i * 2 + 1]], i * 2); // D3D v runs top-down
      const ny = m.normals![normalOf[i] * 3 + 1];
      shade[i] = Math.min(1, AMBIENT + LIGHT * Math.max(0, -ny));
      fog[i] = fogFactor(wz - eyeZ, depth);
    }
    const index = m.faces.flatMap((f) => f.slice(1, -1).flatMap((_, k) => [f[0], f[k + 1], f[k + 2]]));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("shade", new THREE.BufferAttribute(shade, 1));
    g.setAttribute("fog", new THREE.BufferAttribute(fog, 1));
    g.setIndex(index);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** Show the caustics frame for time `t` (seconds). */
  update(t: number): void {
    const k = ((Math.floor(t * FPS) % FRAMES) + FRAMES) % FRAMES;
    if (k === this.frame) return;
    this.frame = k;
    this.material.uniforms.map.value = this.textures[k];
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const t of this.textures) t.dispose();
  }
}
