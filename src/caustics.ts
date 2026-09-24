// Caustics: the animated rippling light the original projects onto the reef
// (setting `caustic`) and onto the fish (setting `causticonfish`).
//
// THE REEF - each scene's `Relief` mesh is an invisible light-catcher shaped
// like the painted reef. It is drawn once per frame as a pure light pass, right
// after the painting: its own material texture ("caustics_00.dds", which does
// not exist) is never used. Established from reference frames of the original
// (tools/wine-ref.sh; caustics=1 vs caustics=0, no fish) and matching the
// decompiled draw call (FUN_0041ce30):
//
//   UVs      Relief's own MeshTextureCoords. They are an exact planar
//            projection FROM ABOVE: u = 0.00225*x + c, v = -k*z + c' (fit
//            residual 0 in scenes 2-3, <0.01 in scene 1; no dependence on
//            height). The 64x64 frames tile 4x4 over the mesh's x/z extent.
//   scroll   every frame v -= 0.5*dt, u -= 0.5*dt/6. Measured: the best-fitting
//            texture offset moved by (+0.281, +0.625) mod 1 over 20.745 s of
//            reference; the model predicts (+0.271, +0.627).
//   frames   caustics_01..29 at 18 fps (floor(t*18) % 29). Measured: frame 17
//            -> 14 over the same 20.745 s; 18 fps predicts 13.4.
//   blend    ADDITIVE and grey (dst += src): on - off is equal in R, G and B and
//            independent of the colour underneath (slope vs base colour
//            0.00-0.05 in every channel, every scene).
//   light    colour = texel * k * max(0, n.y): Lambert from a light straight
//            down, no ambient. Measured in scene 1: k = 0.28-0.29 in every
//            band of n.y (0.1 .. 1.0), r = 0.92-0.95 over ~250k pixels, zero
//            intercept; the decompiled light is 0.3 (scene 1) / 0.5 (2, 3).
//   depth    z test off (decompiled), so where the Relief folds over itself
//            every up-facing layer adds.
//
// THE CREATURES - an extra additive pass over each creature with the same
// frame, UVs from world position (worldZ, worldX) * scale, lit only by ambient
// 0x10101010 (decompiled): fish and sea horses at scale 0.01 (causticonfish),
// crab and sea star at 0.0025, scrolled (caustic). Too faint to measure in the
// reference (<= ~11 levels). See applyFishCaustics() / applyCreatureCaustics().

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { buildMesh, type XMesh } from "./xloader.ts";

/** caustics_01..29.png: a seamless loop (29 -> 01 differs as little as any
 * neighbouring pair: RMSE 0.056). */
export const CAUSTIC_FRAMES = 29;
/** Frames per second (decompiled; consistent with the reference, see above). */
export const CAUSTIC_FPS = 18;
/** UV scroll per second, in the .X/Direct3D texture convention (decompiled). */
export const CAUSTIC_SCROLL = { u: -0.5 / 6, v: -0.5 };
/** Strength of the straight-down light on the Relief, per scene (decompiled;
 * scene 1 measured 0.28-0.29). */
export const RELIEF_LIGHT: Record<string, number> = { "1": 0.3, "2": 0.5, "3": 0.5 };
/** The fish pass's ambient, 0x10101010 (0x406050). The rest of its lighting
 * is read too: 0x406050 changes only the blend (ONE/ONE), stage 0
 * (TEXTURE x DIFFUSE, alpha = TEXTURE), the ambient and the fog colour, so the
 * creature's own light (L2 for fish and sea horse, left on by the draw) and
 * the fish's SPECULARENABLE still apply - as the shader below does. */
export const FISH_CAUSTIC_AMBIENT = 0x10 / 255;

/** The shared caustic clock at time t (seconds): which frame, and the UV scroll
 * (Direct3D convention; the original wraps at -10, which is the same thing for
 * a repeating texture - kept in [0,1) here for float precision). A pure
 * function of t, so ?t= reproduces it. The water surface uses the same clock. */
export function causticClock(t: number): { frame: number; u: number; v: number } {
  const frame = ((Math.floor(t * CAUSTIC_FPS) % CAUSTIC_FRAMES) + CAUSTIC_FRAMES) % CAUSTIC_FRAMES;
  const wrap = (x: number) => x - Math.floor(x);
  return { frame, u: wrap(CAUSTIC_SCROLL.u * t), v: wrap(CAUSTIC_SCROLL.v * t) };
}

/** Experiment hooks, read from the page URL so no caller has to plumb them:
 *   ?caustics=0          off (reef and fish)
 *   ?caustics=uv|normal  analysis renders of the Relief alone, encoded (see shader)
 *   ?causticframe=<0..28>&causticuv=<du>,<dv>   freeze the frame / D3D uv offset
 *   ?causticlight=<k>    override the Relief light
 *   ?causticonfish=0     no caustics on fish;  ?causticfishambient=<a>  exaggerate them (checks) */
function urlParams(): URLSearchParams {
  return new URLSearchParams(globalThis.location?.search ?? "");
}

/** Uniforms shared by every caustic material (Relief and fish), so one clock
 * update moves them all. */
const shared = {
  causticMap: { value: null as THREE.Texture | null },
  /** Added to D3D-convention UVs. */
  causticOffset: { value: new THREE.Vector2() },
};

let frameTextures: THREE.Texture[] | null = null;
/** caustics_01..29, loaded once. */
export function causticTextures(assetsUrl: string): THREE.Texture[] {
  if (frameTextures) return frameTextures;
  const loader = new THREE.TextureLoader();
  frameTextures = Array.from({ length: CAUSTIC_FRAMES }, (_, i) => {
    const tex = loader.load(`${assetsUrl}common/caustics_${String(i + 1).padStart(2, "0")}.png`);
    // Raw bytes: the light is added straight into the framebuffer, as D3D did.
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  });
  shared.causticMap.value = frameTextures[0];
  return frameTextures;
}

/** The caustic frame texture for time t (?causticframe= pins it). */
function frameAt(t: number): THREE.Texture | null {
  if (!frameTextures) return null;
  const p = urlParams();
  const frame = p.has("causticframe") ? Number(p.get("causticframe")) : causticClock(t).frame;
  return frameTextures[((frame % CAUSTIC_FRAMES) + CAUSTIC_FRAMES) % CAUSTIC_FRAMES];
}

/** Advance every caustic material to time t. Called by the scene's update(). */
export function updateCaustics(t: number): void {
  if (!frameTextures) return;
  const p = urlParams();
  const c = causticClock(t);
  shared.causticMap.value = frameAt(t);
  const fixed = p.get("causticuv")?.split(",").map(Number);
  if (fixed?.length === 2) shared.causticOffset.value.set(fixed[0], fixed[1]);
  else shared.causticOffset.value.set(c.u, c.v);
}

// Direct3D samples v top-down; three.js textures are flipped (flipY), so a D3D
// coordinate (u, v) is three.js (u, 1 - v).
const SAMPLE_D3D = /* glsl */ `
  vec3 causticSample(vec2 d3dUv) {
    return texture2D(causticMap, vec2(d3dUv.x, 1.0 - d3dUv.y)).rgb;
  }
`;

const reliefVertex = /* glsl */ `
  uniform float light;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying float vDiffuse;
  void main() {
    vUv = vec2(uv.x, 1.0 - uv.y); // back to the .X file's own (D3D) v
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vNormal = normalize(normalMatrix * normal);
    // Fixed-function vertex lighting: one directional light straight down.
    vDiffuse = light * max(n.y, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const reliefFragment = /* glsl */ `
  uniform sampler2D causticMap;
  uniform vec2 causticOffset;
  uniform int mode;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying float vDiffuse;
  ${SAMPLE_D3D}
  void main() {
    if (mode == 1) {
      // D3D uv (v in -3..1): R = u*64, G = (v+3)*64 (texel index),
      // B = 128 + 8*(eighths of u's texel) + (eighths of v's)
      vec2 t = vec2(vUv.x, vUv.y + 3.0) * 64.0;
      vec2 f = floor(fract(t) * 8.0);
      gl_FragColor = vec4(floor(t) / 255.0, (128.0 + f.x * 8.0 + f.y) / 255.0, 1.0);
      return;
    }
    if (mode == 2) {
      gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
      return;
    }
    // No colour-space conversion: added to the framebuffer's bytes, as D3D did.
    gl_FragColor = vec4(causticSample(vUv + causticOffset) * vDiffuse, 1.0);
  }
`;

export interface Caustics {
  object: THREE.Mesh;
  update(t: number): void;
  dispose(): void;
}

/**
 * The reef's caustic light pass, from a scene's Relief mesh. The geometry is
 * baked into world units like the rest of the painting; add the object under
 * the scene's handedness root. Returns null when caustics are off.
 */
export function createCaustics(relief: XMesh, sceneId: string, assetsUrl: string): Caustics | null {
  const p = urlParams();
  const setting = p.get("caustics") ?? "1";
  if (setting === "0") return null;
  const mode = setting === "uv" ? 1 : setting === "normal" ? 2 : 0;
  causticTextures(assetsUrl);

  const obj = buildMesh(relief, null);
  (obj.material as THREE.Material).dispose();
  obj.geometry.applyMatrix4(relief.world);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      light: { value: Number(p.get("causticlight") ?? RELIEF_LIGHT[sceneId] ?? 0.5) },
      mode: { value: mode },
    },
    vertexShader: reliefVertex,
    fragmentShader: reliefFragment,
    side: THREE.DoubleSide,
    // Light pass: z test off (decompiled). Analysis renders want the nearest
    // surface instead.
    depthTest: mode !== 0,
    depthWrite: mode !== 0,
    transparent: mode === 0,
    blending: THREE.NoBlending,
  });
  if (mode === 0) {
    // ONE/ONE: dst += src. (THREE.AdditiveBlending is SRC_ALPHA/ONE.)
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendEquation = THREE.AddEquation;
  }
  obj.material = material;
  obj.name = "Relief";
  obj.renderOrder = 10; // after every painting layer
  obj.frustumCulled = false;

  let hidden = false;
  function update(t: number): void {
    updateCaustics(t);
    if (mode !== 0 && !hidden && obj.parent) {
      // Analysis renders: the Relief alone on the clear colour.
      obj.parent.traverse((o) => {
        if (o !== obj && o instanceof THREE.Mesh) o.visible = false;
      });
      hidden = true;
    }
  }

  function dispose(): void {
    obj.geometry.dispose();
    material.dispose();
  }

  return { object: obj, update, dispose };
}

// --- creatures ------------------------------------------------------------------

/** Planar caustic UV scale on creatures, per world unit (decompiled). Two
 * different code paths, not a disagreement: fish and sea horses (causticonfish,
 * 0x403660 / 0x406050) use 0.01 = one tile per 100 units; the crab and sea star
 * (caustic, 0x40a7a0 / 0x420970) use 0.0025 = one tile per 400 units, and
 * scroll like the Relief. NOT measurable in the reference: with only the
 * 0x10 ambient lighting it, the pass adds at most ~11 levels (mean ~2.5) - the
 * B channel of saturated yellow fish pixels is the same with causticonfish on
 * and off (median 68 vs 70, p90 90 vs 92, ~50k px each). */
export const CREATURE_CAUSTICS = {
  fish: { scale: 0.01, scroll: false },
  floor: { scale: 0.0025, scroll: true },
} as const;

/**
 * Caustics on one creature material: the original draws an extra ONE/ONE pass
 * with the current caustic frame, UVs from world position
 * (worldZ*scale, worldX*scale) and ambient 0x10101010. For an opaque surface
 * that equals adding the term to the material's own output, which is what this
 * does - in framebuffer space, after colour-space conversion, like the Relief.
 *
 * Works on the built-in lit materials (MeshPhongMaterial etc.), morph targets
 * included; call once per material (instances sharing it are covered). World
 * is the tank's three.js world: X as the original's, Z mirrored. The shared
 * clock is advanced by the scene's update().
 *
 * Every material starts on the scene's shared frame; ownCausticClock() gives
 * one fish its own (each fish picks its frame by t + timeOffset, 0x4060f3).
 * `light` > 0 adds a straight-down Lambert term, if the pass turns out to be
 * lit by more than the ambient.
 */
export function applyFishCaustics(
  material: THREE.Material,
  assetsUrl: string,
  opts: { scale?: number; scroll?: boolean; light?: number } = {},
): void {
  causticTextures(assetsUrl);
  const { scale = CREATURE_CAUSTICS.fish.scale, scroll = false, light = 0 } = opts;
  const prev = material.onBeforeCompile;
  hooked.add(material);
  // `this` is the material being compiled: a per-fish copy (ownCausticClock)
  // shares this function and brings its own caustic uniforms.
  material.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, own.get(this) ?? shared, {
      causticAmbient: { value: Number(urlParams().get("causticfishambient") ?? FISH_CAUSTIC_AMBIENT) },
      causticLight: { value: light },
      // ?causticlit=0: the pass lit by its 0x10 ambient alone (the old model, for comparisons)
      causticLit: { value: urlParams().get("causticlit") === "0" ? 0 : 1 },
      causticScale: { value: scale },
      causticScroll: { value: scroll ? 1 : 0 },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCausticWorld;\nvarying vec3 vCausticNormal;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvCausticWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCausticNormal = normalize(mat3(modelMatrix) * objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D causticMap;
        uniform vec2 causticOffset;
        uniform float causticAmbient, causticLight, causticScale, causticScroll, causticLit;
        varying vec3 vCausticWorld;
        varying vec3 vCausticNormal;
        ${SAMPLE_D3D}`,
      )
      .replace(
        "#include <colorspace_fragment>",
        `#include <colorspace_fragment>
        {
          // Original world: X as ours, Z mirrored.
          vec2 d3dUv = vec2(-vCausticWorld.z, vCausticWorld.x) * causticScale + causticOffset * causticScroll;
          #ifdef FFP_LIGHTING
          // The pass is drawn lit (FVF 0x112, flags 0) with the creature's own
          // light still on (fish/horse L2, crab/star L1) over ambient 0x10, and
          // SPECULARENABLE still set for fish: texture * clamp(0x10 + N.L)
          // + specular, fogged to black (fixedfunction.ts varyings).
          float lit = clamp(causticAmbient + causticLit * vFfpNL, 0.0, 1.0);
          gl_FragColor.rgb += (causticSample(d3dUv) * lit + causticLit * vFfpSpecular) * vFfpFog;
          #else
          float lit = causticAmbient + causticLight * max(normalize(vCausticNormal).y, 0.0);
          gl_FragColor.rgb += causticSample(d3dUv) * lit;
          #endif
        }`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|caustics:${scale}:${scroll}`;
  material.needsUpdate = true;
}

/** Materials carrying the caustic hook, and the per-fish uniforms of copies made by ownCausticClock(). */
const hooked = new WeakSet<THREE.Material>();
const own = new WeakMap<THREE.Material, typeof shared>();

/**
 * Give one creature instance (a clone sharing the template's materials) its
 * own caustic clock: its caustic-hooked materials are replaced by copies (the
 * same shader program; own uniforms), and the returned function shows the
 * frame for the creature's time - for a fish, tt = t + timeOffset (0x4060f3:
 * the pass reads fish+0x6c, which the update 0x415150 sets to t + timeOffset).
 * Null when the instance has no caustic pass (?caustics=0 / ?causticonfish=0).
 */
export function ownCausticClock(object: THREE.Object3D): ((tt: number) => void) | null {
  const uniforms: typeof shared = { causticMap: { value: shared.causticMap.value }, causticOffset: { value: new THREE.Vector2() } };
  const copies = new Map<THREE.Material, THREE.Material>();
  const swap = (m: THREE.Material): THREE.Material => {
    if (!hooked.has(m)) return m;
    let c = copies.get(m);
    if (!c) {
      c = m.clone();
      c.onBeforeCompile = m.onBeforeCompile;
      c.customProgramCacheKey = m.customProgramCacheKey;
      own.set(c, uniforms);
      copies.set(m, c);
    }
    return c;
  };
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  if (!copies.size) return null;
  return (tt: number) => {
    uniforms.causticMap.value = frameAt(tt);
  };
}

/**
 * Give a whole creature model its caustic pass, by kind: the crab (`cycle`)
 * and sea star (`static`) get the floor variant when `caustic` is on, every
 * other creature the fish variant when `causticonfish` is on. URL: ?caustics=0
 * turns both off, ?causticonfish=0 only the fish.
 */
export function applyCreatureCaustics(object: THREE.Object3D, kind: string, assetsUrl: string): void {
  const p = urlParams();
  if (p.get("caustics") === "0") return;
  const floor = kind === "cycle" || kind === "static";
  if (!floor && p.get("causticonfish") === "0") return;
  const opts = floor ? CREATURE_CAUSTICS.floor : CREATURE_CAUSTICS.fish;
  const done = new Set<THREE.Material>();
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (done.has(m)) continue;
      done.add(m);
      applyFishCaustics(m, assetsUrl, opts);
    }
  });
}

