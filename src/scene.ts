// One tank scene: a hand-painted reef on flat, tiled planes, viewed through an
// orthographic camera - not modelled 3D geometry.
//
// What each part of scenes/N/mesh.X is (established against reference frames
// captured from the original, see tools/wine-ref.sh):
//
//   Background   plane tiled with bg_slice*.dds - distant reef and open water
//   Foreground   plane tiled with fg_slice*.dds - near coral and sand
//   billboards   single quads (plants, anemones); their materials name no
//                texture - the original assigns a pair of frames in code
//   Relief       the only real 3D mesh: an invisible light-catcher shaped like
//                the painted reef, which carries the animated caustics
//   height       7-8 data points, not geometry
//
// Framing: Foreground and Background are both ~1776 units wide at depths far
// apart. Both can only fill the view under an orthographic projection, and the
// combined extent is exactly 4:3 (1776 x 1332) - the original's 1024x768 mode.
// Verified: great_plant projects to screen x 100-416, y 236-490 at 1024x768,
// where the reference shows the soft coral.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { buildMesh, handednessRoot, isRenderable, loadXDoc, XTextureCache, type XMesh } from "./xloader.ts";

/**
 * The original's billboard classes, named by the constructor its setup code
 * calls (.scr: A 0x417520, B 0x4179d0, C 0x4025c0, D 0x402350). They differ
 * only in how their two layers move (see `animate`).
 */
type PlantClass = "A" | "B" | "C" | "D";

interface BillboardDef {
  /** Layer A (drawn first) and layer B (drawn over it, same quad). */
  tex: [string, string];
  cls: PlantClass;
  /** Added to the frame's world bbox [min.x, max.x, min.y, max.y] before the quad is built. */
  box?: [number, number, number, number];
}

/**
 * Billboards per scene. Not in the data files: the original hard-codes them in
 * one setup function per scene (.scr 0x41dc90 scene 1, 0x41d3a0 scene 2,
 * 0x41e5c0 scene 3), which looks each frame up by name, takes the frame's
 * world bounding box, applies a constant edit to it (the `box` column: fadd /
 * fsub of 100 / 150 / 200 at the .scr addresses noted), and builds the sprite
 * from the result. So this table is READ from the code, not guessed - the box
 * edits are what used to be scene 1's "unexplained +58px" seaweed offset.
 * Every entry was also located in the reference frames with
 * tools/matchsprite.ts (scene 2's `anemone` is the green sponge in the pink
 * pot; scene 3's `anemon_1` the pink tube anemone mid-floor, `anemon_02` the
 * blue anemones bottom-right).
 */
const BILLBOARDS: Record<string, Record<string, BillboardDef>> = {
  "1": {
    great_plant: { tex: ["4.dds", "3.dds"], cls: "A" }, // blue soft coral: dark leaves (4) under the bright fan (3)
    green_plant: { tex: ["1.dds", "2.dds"], cls: "B", box: [100, 100, 0, 0] }, // tall seaweed; .scr 0x41e009
    anemone_0: { tex: ["anemone_1_0.dds", "anemone_1_1.dds"], cls: "C" }, // purple
    anemone_1: { tex: ["anemone_2_0.dds", "anemone_2_1.dds"], cls: "C" }, // tan
  },
  "2": {
    flowers: { tex: ["Flowers-0.dds", "Flowers-1.dds"], cls: "C" },
    red_grass: { tex: ["Red Grass-0.dds", "Red Grass-1.dds"], cls: "A" },
    anemone: { tex: ["SpondeGreen-0.dds", "SpondeGreen-1.dds"], cls: "C" },
    high_grass: { tex: ["High Grass-0.dds", "High Grass-1.dds"], cls: "A", box: [0, 0, 0, 100] }, // top raised; .scr 0x41db7a
  },
  "3": {
    yellow_grass: { tex: ["YellowGrass-0.dds", "YellowGrass-1.dds"], cls: "A", box: [-150, -150, 0, 0] }, // .scr 0x41e717
    anemon_1: { tex: ["Anemone-0.dds", "Anemone-1.dds"], cls: "D" },
    anemon_02: { tex: ["Blue anemones-0.dds", "Blue anemones-1.dds"], cls: "B", box: [200, 200, 0, 0] }, // .scr 0x41eb89
  },
};

/**
 * Class C's layer B alpha is multiplied by this scene texture (a second
 * texture stage), scrolled in a small circle. Only scene 1's setup loads it;
 * elsewhere the stage is empty and alpha passes unchanged.
 */
const MASK: Record<string, string> = { "1": "mask.dds" };

/**
 * Class C's mask scroll phase is t + rand(0..1.9)/2 per plant in the
 * original; the random part cannot be reproduced, so every plant uses its
 * mean. CALIBRATE: per-plant phase is unmeasurable from stills.
 */
const MASK_PHASE = 0.475;
/**
 * Open water behind the painting: one flat colour per scene. Read from the
 * original's scene setup, which stores a D3DCOLOR per scene index as an
 * immediate (0xFF036ED6 / 0xFF00CBFD / 0xFF008AFF at .scr file offsets
 * 0x12571 / 0x12587 / 0x1259d, a switch on the scene number), and matching
 * every open-water sample below the surface band of the reference frames
 * exactly: scene 1 rgb(0,138,255), 2 rgb(0,203,253), 3 rgb(3,110,214).
 */
const CLEAR_COLOR: Record<string, number> = { "1": 0x008aff, "2": 0x00cbfd, "3": 0x036ed6 };

/**
 * Scene rotation (settings `index` = 0, the install's value), as the original
 * does it: once per LAUNCH, never on a timer. Its scene picker (.scr 0x411a50)
 * reads HKLM\Software\Triodesign\Living Marine Aquarium 2.0\SceneIndex
 * (default 0), writes (old + 1) % 3 back and shows scene new + 1 - so the
 * first run shows scene 2, then 3, then 1. Measured under Wine: three
 * successive launches showed scenes 3, 1, 2 with SceneIndex going 1 -> 2 ->
 * 0 -> 1, and one launch left running for 15 minutes (75 frames, 10-15 s
 * apart) stayed on its scene the whole time - no switch, so no transition.
 * Fish are therefore never carried across a switch either. The browser
 * equivalent of the registry value is a localStorage counter, advanced on
 * every page load that does not pin a scene with ?scene=.
 */
export function nextRotationScene(ids: string[]): string {
  const KEY = "lma2.sceneIndex";
  let old = 0;
  try {
    old = Number(localStorage.getItem(KEY) ?? 0) | 0;
  } catch { /* storage blocked: behave like a fresh install */ }
  const next = (old + 1) % ids.length;
  try {
    localStorage.setItem(KEY, String(next));
  } catch { /* ignore */ }
  return ids[next];
}

export interface SceneModel {
  /**
   * The whole painting, `back` then `front` (docs/original-logic.md 2.2):
   * render this, then the creatures, for a two-layer approximation.
   */
  object: THREE.Group;
  /**
   * Scene pass 0 (handedness-corrected): the Background plane. The original
   * draws the creatures BEHIND the foreground (frame z >= 0) after this...
   */
  back: THREE.Group;
  /**
   * ...then scene pass 1: billboards with z >= 0 (far first), the Foreground,
   * the Relief caustics, billboards with z < 0 - all ordered by renderOrder =
   * -z - and only then the creatures in FRONT of the foreground (z < 0), over
   * everything here, near billboards included.
   */
  front: THREE.Group;
  /**
   * Always empty: nothing in the original is drawn over the front creatures
   * (the old "near billboards over the fish" layer was wrong). Kept so
   * existing callers still work.
   */
  near: THREE.Group;
  /** The painted frame in view space (after the Z mirror): Background + Foreground. */
  frame: THREE.Box2;
  /**
   * X/Y extent of EVERY vertex in mesh.X (Relief, billboards and the `height`
   * data included) - what the original fits its camera to. Differs from
   * `frame` in x: the Relief overhangs the painted planes by a few units.
   */
  bounds: THREE.Box2;
  /** The open-water colour behind everything (the frame's clear colour). */
  clearColor: THREE.Color;
  /** Animate billboards etc.; `t` in seconds. */
  update(t: number): void;
  dispose(): void;
}

/** One plant: its class, its bbox corners (D3D world) and its two layer quads. */
interface Billboard {
  cls: PlantClass;
  /** Quad corners before motion, D3D world: v0 (min.x,min.y), v1 (min.x,max.y), v2 (max.x,max.y), v3 (max.x,min.y), all at min.z. */
  base: Float32Array;
  a: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  b: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}

/**
 * A billboard layer as the original builds it: one quad over the frame's
 * world bbox (the quads in mesh.X ship with NO texture coordinates and only
 * serve as that box), corners v0 (min.x,min.y) uv(0,1), v1 (min.x,max.y)
 * uv(0,0), v2 (max.x,max.y) uv(1,0), v3 (max.x,min.y) uv(1,1), all at min.z.
 * (D3D uvs; three.js flips images, so v is mirrored here.)
 */
function billboardQuad(base: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(base.slice(), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Row-vector D3DXMatrixRotationX then RotationZ applied to vertex i of `p` (in place). */
function rotateXZ(p: Float32Array, i: number, ax: number, az: number): void {
  const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
  const y1 = y * Math.cos(ax) - z * Math.sin(ax), z1 = y * Math.sin(ax) + z * Math.cos(ax);
  p[i * 3] = x * Math.cos(az) - y1 * Math.sin(az);
  p[i * 3 + 1] = x * Math.sin(az) + y1 * Math.cos(az);
  p[i * 3 + 2] = z1;
}

/**
 * Plant motion (settings `plantsmoving`), read from the original's per-class
 * update code; s = sin t, c = cos t, t = app seconds. Corner indices as in
 * billboardQuad (1 = top-left, 2 = top-right). The layers move against each
 * other, so the plant appears to sway while its two painted layers shear.
 *   A  layer A: TL.x += 10cs, TR.x -= 10s^2;  layer B: TL.x -= 10cs, TR.x += 10s^2
 *   B  as A with 5 for layer A, then layer A's top corners are rotated about
 *      the WORLD ORIGIN by RotX(cos(0.1t)/60)*RotZ(sin(0.1t)/60), and layer B's
 *      top-right by RotX(-cos(0.1t)/60). The plants sit ~2000 units from the
 *      origin in z, so these tiny angles move their tops by ~33 units (~19px)
 *      over a ~63s cycle.
 *   C  static; layer B is offset in x by int(width)*0.005 (and alpha-masked).
 *   D  layer A: TL.x += 5cs, TR.x -= 5s^2; layer B: BL.x -= 10cs, TL.x += 10cs,
 *      TR.x -= 10s^2, BR.x += 10s^2.
 */
function animate(bb: Billboard, t: number): void {
  const s = Math.sin(t), c = Math.cos(t);
  const pa = bb.a.geometry.getAttribute("position") as THREE.BufferAttribute;
  const pb = bb.b.geometry.getAttribute("position") as THREE.BufferAttribute;
  const A = pa.array as Float32Array, B = pb.array as Float32Array;
  A.set(bb.base);
  B.set(bb.base);
  const dx = (p: Float32Array, i: number, d: number) => (p[i * 3] += d);
  switch (bb.cls) {
    case "A":
      dx(A, 1, 10 * c * s), dx(A, 2, -10 * s * s);
      dx(B, 1, -10 * c * s), dx(B, 2, 10 * s * s);
      break;
    case "B": {
      dx(A, 1, 5 * c * s), dx(A, 2, -5 * s * s);
      dx(B, 1, -10 * c * s), dx(B, 2, 10 * s * s);
      const ax = Math.cos(0.1 * t) / 60, az = Math.sin(0.1 * t) / 60;
      rotateXZ(A, 1, ax, az), rotateXZ(A, 2, ax, az);
      rotateXZ(B, 2, -ax, 0);
      break;
    }
    case "C": {
      const shift = Math.trunc(bb.base[6] - bb.base[0]) * 0.005;
      for (let i = 0; i < 4; i++) dx(B, i, shift);
      break;
    }
    case "D":
      dx(A, 1, 5 * c * s), dx(A, 2, -5 * s * s);
      dx(B, 0, -10 * c * s), dx(B, 1, 10 * c * s), dx(B, 2, -10 * s * s), dx(B, 3, 10 * s * s);
      break;
  }
  pa.needsUpdate = pb.needsUpdate = true;
  bb.a.geometry.computeBoundingSphere();
  bb.b.geometry.computeBoundingSphere();
}

/**
 * Class C's layer B: alpha *= the mask texture's ALPHA (three's alphaMap reads
 * green), sampled at the quad's uv scrolled by (0.1 sin p, 0.1 cos p).
 */
function useMaskAlpha(mat: THREE.MeshBasicMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <alphamap_fragment>",
      "#ifdef USE_ALPHAMAP\n\tdiffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).a;\n#endif",
    );
  };
  mat.customProgramCacheKey = () => "lma2-mask-alpha";
}
/** An unlit version of a static mesh: the painting must not be shaded. */
function unlit(mesh: THREE.Mesh): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const out = mats.map((m) => {
    const src = m as THREE.MeshPhongMaterial;
    if (!src.map) {
      // Tiles with no texture are gaps in the painting (e.g. scene 1 has no
      // bg_slice09); the untextured material covering them must not show.
      return new THREE.MeshBasicMaterial({ visible: false });
    }
    // Tiles abut each other: with repeat wrapping, bilinear filtering at a tile
    // edge samples the OPPOSITE edge of the same texture, which showed up as
    // faint seam lines in the reference diff. Clamp them.
    const map = src.map.clone();
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.needsUpdate = true;
    return new THREE.MeshBasicMaterial({
      name: src.name,
      map,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  });
  for (const m of mats) m.dispose();
  mesh.material = out.length === 1 ? out[0] : out;
}

/** Experiment hook: force billboard frame opacities, `[frame0, frame1]`. */
export interface SceneOptions {
  billboardOpacity?: [number, number];
}

export async function loadScene(id: string, assetsUrl: string, opts: SceneOptions = {}): Promise<SceneModel> {
  const base = `${assetsUrl}scenes/${id}/`;
  const textures = new XTextureCache(base);
  const doc = await loadXDoc(base + "mesh.X");

  // Pass 0 (Background) and pass 1 (everything else), both mirrored for
  // handedness; `root` holds them in that order.
  const back = handednessRoot();
  back.name = `scene-${id}-back`;
  const front = handednessRoot();
  front.name = `scene-${id}-front`;
  const root = new THREE.Group();
  root.name = `scene-${id}`;
  root.add(back, front);
  const billboards: Billboard[] = [];
  const frame3 = new THREE.Box3();
  const table = BILLBOARDS[id] ?? {};

  // Bake each mesh's world matrix into its vertices. Object3D.applyMatrix4()
  // would decompose it into position/rotation/scale and silently DROP any
  // shear - and these frames nest non-uniform scales (great_plant: 1.23x) with
  // rotations, which is exactly how shear arises.
  const near = handednessRoot();
  near.name = `scene-${id}-near`;
  // Nothing writes depth, so draw order IS the layering: far to near by D3D z
  // (larger = farther; original-logic.md 5.3). Also measured: scene 2's sea
  // whips (z 89) stand between Background (2598) and Foreground (0), and the
  // reference hides their stems behind the foreground coral; scene 1's soft
  // coral (z 304) likewise. Billboards set renderOrder the same way.
  const place = (obj: THREE.Mesh, m: XMesh) => {
    obj.geometry.applyMatrix4(m.world);
    obj.renderOrder = -m.world.elements[14];
    (m.name === "Background" ? back : front).add(obj);
  };

  // The camera's box: all vertices, drawn or not (X/Y are unaffected by the Z mirror).
  const bounds = new THREE.Box2();
  {
    const v = new THREE.Vector3();
    for (const m of doc.meshes) {
      for (let i = 0; i < m.positions.length; i += 3) {
        v.fromArray(m.positions, i).applyMatrix4(m.world);
        bounds.expandByPoint(new THREE.Vector2(v.x, v.y));
      }
    }
  }

  for (const m of doc.meshes) {
    if (!isRenderable(m)) continue;

    if (m.name === "Relief") continue; // caustics carrier - added with the caustics effect

    if (m.name === "Background" || m.name === "Foreground") {
      const obj = buildMesh(m, textures);
      unlit(obj);
      place(obj, m);
      obj.updateMatrixWorld(true);
      frame3.union(new THREE.Box3().setFromObject(obj));
      continue;
    }

    const def = table[m.name];
    if (def) {
      // The frame's world bbox, edited as the setup code does.
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(v.fromArray(m.positions, i).applyMatrix4(m.world));
      const [dx0, dx1, dy0, dy1] = def.box ?? [0, 0, 0, 0];
      const x0 = box.min.x + dx0, x1 = box.max.x + dx1, y0 = box.min.y + dy0, y1 = box.max.y + dy1, z = box.min.z;
      const base = new Float32Array([x0, y0, z, x0, y1, z, x1, y1, z, x1, y0, z]);
      const mk = (tex: string, sub: number) => {
        const map = textures.get(tex)!.clone();
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; // sprites: never wrap
        map.needsUpdate = true;
        const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        const obj = new THREE.Mesh(billboardQuad(base), mat);
        obj.name = `${m.name}/${sub ? "B" : "A"}`;
        obj.renderOrder = -z + sub * 0.01; // far to near (see place()); layer A, then B
        front.add(obj);
        return obj;
      };
      const bb: Billboard = { cls: def.cls, base, a: mk(def.tex[0], 0), b: mk(def.tex[1], 1) };
      const maskName = MASK[id];
      if (def.cls === "C" && maskName) {
        const mask = textures.get(maskName)!.clone();
        mask.wrapS = mask.wrapT = THREE.RepeatWrapping; // scrolled: must wrap
        mask.needsUpdate = true;
        bb.b.material.alphaMap = mask;
        useMaskAlpha(bb.b.material);
      }
      billboards.push(bb);
      continue;
    }

    console.warn(`scene ${id}: no texture known for billboard "${m.name}" - skipped`);
  }

  // The frame, in the view space the camera sees (root mirrors Z; X/Y unchanged).
  const frame = new THREE.Box2(
    new THREE.Vector2(frame3.min.x, frame3.min.y),
    new THREE.Vector2(frame3.max.x, frame3.max.y),
  );

  // Billboards: both layers drawn at full opacity (?bb= overrides, for
  // experiments), moving per their class (animate). Driven only by `t`, so a
  // frozen ?t= reproduces a pose exactly.
  function update(t: number): void {
    const [a, b] = opts.billboardOpacity ?? [1, 1];
    for (const bb of billboards) {
      bb.a.material.opacity = a;
      bb.b.material.opacity = b;
      animate(bb, t);
      const mask = bb.b.material.alphaMap;
      if (mask) {
        // D3D v runs down the image; three's up - hence the sign on y.
        const p = t + MASK_PHASE;
        mask.offset.set(0.1 * Math.sin(p), -0.1 * Math.cos(p));
      }
    }
  }
  update(0);

  function dispose(): void {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        (mat as THREE.MeshBasicMaterial).map?.dispose();
        (mat as THREE.MeshBasicMaterial).alphaMap?.dispose();
        mat.dispose();
      }
    });
  }

  const clearColor = new THREE.Color().setHex(CLEAR_COLOR[id] ?? CLEAR_COLOR["1"], THREE.SRGBColorSpace);
  return { object: root, back, front, near, frame, bounds, clearColor, update, dispose };
}
