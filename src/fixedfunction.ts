// The creatures' materials as Direct3D 6's fixed-function pipeline drew them
// (docs/original-logic.md 2.2, 2.4, 3.11; docs/fidelity-review.md D3).
//
// What the original does, read from the binary:
//   - ONE global D3DMATERIAL for every lit draw (set once at scene init,
//     0x413429/0x4134e0; no other LIGHTSTATE_MATERIAL is ever set): diffuse
//     and ambient (1,1,1), specular 0.5, power 160.9. The .X files' own
//     colours, specular and power are never used.
//   - Per-VERTEX lighting, in the 8-bit (gamma) values, saturated at 1:
//       diffuse  = clamp(ambient + sum level * max(N.L, 0))
//       specular = clamp(sum 0.5 * level * (N.H)^160.9)   (only where N.L > 0)
//     then colour = texture * diffuse + specular, then vertex fog.
//   - Fish (0x416710): ambient 0xAAAAAAAA, light L2 = (0,-1,0.2) at 1.0,
//     SPECULARENABLE = 1 (0x416917), alpha blending on for the whole body with
//     ALPHA = TEXTURE only (the .X materials' 0.9 alpha is ignored; no alpha
//     test), Z test and write on.
//   - Sea horse (0x41f7f0): as the fish, but ambient 0x80808080 and no
//     specular; the generic mesh renderer blends only the subsets whose .X
//     material alpha is below 1.
//   - Crab and sea star: light L1 = (0,-1,0) at 1.0 over ambient 0x80808080,
//     no specular, same generic blending.
//   - Subsets without a texture (the fish eyes) keep the texture bound by the
//     subset before them: the body texture. Their UVs point at the eye painted
//     into it (regal angel: u 0.09-0.16, v 0.44-0.51).
//   - Specular uses a local viewer at the D3D eye, (0, cy, bbox.min.z - 2000).
//
// Implemented on MeshBasicMaterial (so morph targets, maps and the caustic hook
// keep working): the lighting is computed in the vertex shader, and the
// fragment works on the texture's sRGB bytes, like the framebuffer maths of
// the original. three's own fog (smoothstep) is replaced by D3D's linear
// vertex fog.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";

export interface FixedFunction {
  /** LIGHTSTATE_AMBIENT, as a grey level 0..1. */
  ambient: number;
  /** Direction the light TRAVELS, in .X (Direct3D) world space. */
  light: [number, number, number];
  /** The light's grey colour. */
  level: number;
  /** Material specular while SPECULARENABLE is on; 0 = off. */
  specular: number;
  power: number;
  /** Alpha-blend every subset (the fish draw), or only those whose .X alpha < 1 (generic renderer). */
  blendAll: boolean;
  /** Linear depth fog toward the clear colour (fish and sea horses). */
  fog: boolean;
}

/** The global material (0x413429). */
const SPECULAR = 0.5, POWER = 160.9;

export const FISH: FixedFunction = { ambient: 0xaa / 255, light: [0, -1, 0.2], level: 1, specular: SPECULAR, power: POWER, blendAll: true, fog: true };
export const HORSE: FixedFunction = { ambient: 0x80 / 255, light: [0, -1, 0.2], level: 1, specular: 0, power: POWER, blendAll: false, fog: true };
export const FLOOR: FixedFunction = { ambient: 0x80 / 255, light: [0, -1, 0], level: 1, specular: 0, power: POWER, blendAll: false, fog: false };

/** Per-scene values shared by every creature material. */
const shared = {
  /** The D3D eye, in three.js world space (Z mirrored). */
  ffpEye: { value: new THREE.Vector3(0, 0, 2000) },
  /** Fog colour, sRGB 0..1 (the scene's clear colour). */
  ffpFogColor: { value: new THREE.Vector3(0, 0, 0) },
  /** Linear fog start/end, in view depth (distance along the camera axis). */
  ffpFogRange: { value: new THREE.Vector2(1e9, 2e9) },
};

/**
 * Set the scene's lighting constants: `bbox` is the scene's .X world bbox,
 * `fogColor` the clear colour (0xRRGGBB), and the fog runs linearly from view
 * depth `fogNear` (clear) to `fogFar` (all fog).
 */
export function setFixedFunctionScene(o: { bbox: { minY: number; maxY: number; minZ: number }; fogColor: number; fogNear: number; fogFar: number }): void {
  shared.ffpEye.value.set(0, (o.bbox.minY + o.bbox.maxY) / 2, -(o.bbox.minZ - 2000));
  const c = o.fogColor;
  shared.ffpFogColor.value.set(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
  shared.ffpFogRange.value.set(o.fogNear, o.fogFar);
}

const VERTEX_PARS = /* glsl */ `
uniform vec3 ffpLight;
uniform float ffpAmbient, ffpLevel, ffpSpecular, ffpPower;
uniform vec3 ffpEye;
uniform vec2 ffpFogRange;
uniform float ffpFogOn;
varying vec3 vFfpDiffuse;
varying vec3 vFfpSpecular;
varying float vFfpFog;
`;

// objectNormal: MeshBasicMaterial computes it only for env maps or skinning.
const VERTEX_NORMAL = /* glsl */ `
#if !defined( USE_ENVMAP ) && !defined( USE_SKINNING )
#include <beginnormal_vertex>
#include <morphnormal_vertex>
#endif
`;

const VERTEX_LIGHT = /* glsl */ `
{
  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec3 wn = normalize(mat3(modelMatrix) * objectNormal);
  float nl = dot(wn, ffpLight);
  vec3 d = vec3(ffpAmbient);
  vec3 s = vec3(0.0);
  if (nl > 0.0) {
    d += ffpLevel * nl;
    if (ffpSpecular > 0.0) {
      vec3 h = normalize(ffpLight + normalize(ffpEye - wp));
      s = vec3(ffpSpecular * ffpLevel * pow(max(dot(wn, h), 0.0), ffpPower));
    }
  }
  vFfpDiffuse = clamp(d, 0.0, 1.0);
  vFfpSpecular = clamp(s, 0.0, 1.0);
  vFfpFog = ffpFogOn > 0.5 ? clamp((ffpFogRange.y - (-mvPosition.z)) / (ffpFogRange.y - ffpFogRange.x), 0.0, 1.0) : 1.0;
}
`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec3 ffpFogColor;
varying vec3 vFfpDiffuse;
varying vec3 vFfpSpecular;
varying float vFfpFog;
`;

// Texture bytes x diffuse + specular, saturate, fog: all on the 8-bit values.
// gl_FragColor is linear here; colorspace_fragment encodes it right after.
const FRAGMENT_LIGHT = /* glsl */ `
{
  vec3 c = sRGBTransferOETF(vec4(gl_FragColor.rgb, 1.0)).rgb;
  c = clamp(c * vFfpDiffuse + vFfpSpecular, 0.0, 1.0);
  c = mix(ffpFogColor, c, vFfpFog);
  gl_FragColor.rgb = sRGBTransferEOTF(vec4(c, 1.0)).rgb;
}
`;

/** One fixed-function material standing in for a loaded .X material. */
export function fixedFunctionMaterial(src: THREE.Material, ff: FixedFunction, fallbackMap: THREE.Texture | null): THREE.MeshBasicMaterial {
  const phong = src as THREE.MeshPhongMaterial;
  const xAlpha = (src.userData.xAlpha as number | undefined) ?? (src.transparent ? src.opacity : 1);
  const blend = ff.blendAll || xAlpha < 0.999;
  const mat = new THREE.MeshBasicMaterial({
    name: src.name,
    map: phong.map ?? fallbackMap,
    color: 0xffffff, // the global material's diffuse: the .X colour is never used
    transparent: blend, // SRCALPHA/INVSRCALPHA by the texture's alpha alone
    opacity: 1,
    alphaTest: 0,
    depthWrite: true, // Z on, writes included
    side: src.side,
    fog: false, // D3D's linear vertex fog, below
  });
  const dir = new THREE.Vector3(-ff.light[0], -ff.light[1], ff.light[2]).normalize(); // toward the light, Z mirrored
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, {
      ffpLight: { value: dir },
      ffpAmbient: { value: ff.ambient },
      ffpLevel: { value: ff.level },
      ffpSpecular: { value: ff.specular },
      ffpPower: { value: ff.power },
      ffpFogOn: { value: ff.fog ? 1 : 0 },
    });
    shader.defines = { ...shader.defines, FFP_LIGHTING: "" };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace("#include <begin_vertex>", `${VERTEX_NORMAL}\n#include <begin_vertex>`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERTEX_LIGHT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace("#include <opaque_fragment>", `#include <opaque_fragment>\n${FRAGMENT_LIGHT}`);
  };
  mat.customProgramCacheKey = () => "lma2-ffp";
  return mat;
}

/**
 * Replace every material of a loaded creature model (loadFish's object) with
 * its fixed-function version. Instances cloned afterwards share them.
 */
export function applyFixedFunction(object: THREE.Object3D, ff: FixedFunction): void {
  let body: THREE.Texture | null = null;
  object.traverse((o) => {
    if (body || !(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) body ??= (m as THREE.MeshPhongMaterial).map ?? null;
  });
  const done = new Map<THREE.Material, THREE.Material>();
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const swap = (m: THREE.Material) => {
      let r = done.get(m);
      if (!r) {
        r = fixedFunctionMaterial(m, ff, body);
        done.set(m, r);
        m.dispose();
      }
      return r;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
}
