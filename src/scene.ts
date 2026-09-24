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
import { type Caustics, createCaustics } from "./caustics.ts"; // caustics hook
import { buildMesh, handednessRoot, isRenderable, loadXDoc, XTextureCache, type XMesh } from "./xloader.ts";

/**
 * Billboard -> its two animation frames, per scene. Not recorded anywhere in
 * the data. Scene 1 was matched against a reference frame (quad aspect ratio
 * and position vs texture). Scenes 2-3 are matched by name and aspect ratio
 * and still need checking against their references.
 */
const BILLBOARDS: Record<string, Record<string, [string, string]>> = {
  "1": {
    green_plant: ["1.dds", "2.dds"], // tall seaweed, 256x512  (quad ~1:1.9)
    great_plant: ["3.dds", "4.dds"], // blue soft coral, 256x256 (quad ~1:1 before its 1.23 x-scale)
    anemone_0: ["anemone_1_0.dds", "anemone_1_1.dds"], // purple, 256x128 (quad 2.3:1)
    anemone_1: ["anemone_2_0.dds", "anemone_2_1.dds"], // tan, 256x256 (quad 1:1)
  },
  "2": {
    flowers: ["Flowers-0.dds", "Flowers-1.dds"],
    red_grass: ["Red Grass-0.dds", "Red Grass-1.dds"],
    high_grass: ["High Grass-0.dds", "High Grass-1.dds"],
    anemone: ["SpondeGreen-0.dds", "SpondeGreen-1.dds"], // by elimination - unverified
  },
  "3": {
    yellow_grass: ["YellowGrass-0.dds", "YellowGrass-1.dds"],
  },
};

/**
 * Measured corrections, in world units, for billboards the original draws
 * somewhere other than where their frame puts them. Found by silhouette
 * matching against reference frames (tools/matchsprite.ts): scene 1's seaweed
 * is drawn 58px right / 14px up at 1024x768, same size. Why is unknown - the
 * other billboards sit exactly where their frames say, and it is not
 * perspective (that would scale both axes by one factor). Empirical, so
 * re-measure rather than extrapolate.
 */
const PLACEMENT_FIX: Record<string, Record<string, { dx: number; dy: number }>> = {
  "1": { green_plant: { dx: 96.4, dy: 22.2 } },
};

/** Billboards nearer than this (D3D z) draw in front of the fish. Scene 1's
 * anemones and seaweed sit at ~-1960; its soft coral at +304 is behind. */
const NEAR_Z = -1000;

export interface SceneModel {
  /** Handedness-corrected root: the painting and anything behind the fish. */
  object: THREE.Group;
  /** Near billboards, drawn after (in front of) the fish. */
  near: THREE.Group;
  /** The painted frame in view space (after the Z mirror); fit the camera to this. */
  frame: THREE.Box2;
  /** Animate billboards etc.; `t` in seconds. */
  update(t: number): void;
  dispose(): void;
}

interface Billboard {
  a: THREE.MeshBasicMaterial;
  b: THREE.MeshBasicMaterial;
}

/**
 * Billboard quads ship with NO texture coordinates (verified: all four in
 * scene 1), and lie flat in their local XZ plane - their frame rotates them
 * upright. So derive UVs from each vertex's position in the upright (world)
 * plane: left->right is u 0->1, bottom->top is v 0->1 (three.js flips images
 * so v=1 is the top row).
 */
function billboardUVs(geometry: THREE.BufferGeometry, world: THREE.Matrix4): void {
  const pos = geometry.getAttribute("position");
  const v = new THREE.Vector3();
  const box = new THREE.Box2();
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(world);
    const p = new THREE.Vector2(v.x, v.y);
    pts.push(p);
    box.expandByPoint(p);
  }
  const size = box.getSize(new THREE.Vector2());
  const uv = new Float32Array(pos.count * 2);
  pts.forEach((p, i) => {
    uv[i * 2] = (p.x - box.min.x) / size.x;
    uv[i * 2 + 1] = (p.y - box.min.y) / size.y;
  });
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
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

  const root = handednessRoot();
  root.name = `scene-${id}`;
  const billboards: Billboard[] = [];
  const frame3 = new THREE.Box3();
  const table = BILLBOARDS[id] ?? {};
  let caustics: Caustics | null = null; // caustics hook

  // Bake each mesh's world matrix into its vertices. Object3D.applyMatrix4()
  // would decompose it into position/rotation/scale and silently DROP any
  // shear - and these frames nest non-uniform scales (great_plant: 1.23x) with
  // rotations, which is exactly how shear arises.
  const near = handednessRoot();
  near.name = `scene-${id}-near`;
  const place = (obj: THREE.Mesh, m: XMesh) => {
    obj.geometry.applyMatrix4(m.world);
    (m.world.elements[14] < NEAR_Z ? near : root).add(obj);
  };

  for (const m of doc.meshes) {
    if (!isRenderable(m)) continue;

    // --- caustics hook (src/caustics.ts): Relief carries the caustic light ---
    if (m.name === "Relief") {
      caustics = createCaustics(m, id, assetsUrl);
      if (caustics) root.add(caustics.object);
      continue;
    }
    // --- end caustics hook ---

    if (m.name === "Background" || m.name === "Foreground") {
      const obj = buildMesh(m, textures);
      unlit(obj);
      place(obj, m);
      obj.updateMatrixWorld(true);
      frame3.union(new THREE.Box3().setFromObject(obj));
      continue;
    }

    const frames = table[m.name];
    if (frames) {
      // Two stacked copies, cross-faded: the original alternates frame _0/_1.
      const fix = PLACEMENT_FIX[id]?.[m.name];
      const mk = (tex: string, order: number) => {
        const obj = buildMesh(m, null);
        billboardUVs(obj.geometry, m.world);
        const map = textures.get(tex)!.clone();
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; // sprites: never wrap
        map.needsUpdate = true;
        const mat = new THREE.MeshBasicMaterial({
          map,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        (obj.material as THREE.Material).dispose();
        obj.material = mat;
        obj.renderOrder = order;
        place(obj, m);
        // After baking, vertices are in world units (X/Y unaffected by the Z mirror).
        if (fix) obj.geometry.translate(fix.dx, fix.dy, 0);
        return mat;
      };
      billboards.push({ a: mk(frames[0], 0), b: mk(frames[1], 1) });
      continue;
    }

    console.warn(`scene ${id}: no texture known for billboard "${m.name}" - skipped`);
  }

  // The frame, in the view space the camera sees (root mirrors Z; X/Y unchanged).
  const frame = new THREE.Box2(
    new THREE.Vector2(frame3.min.x, frame3.min.y),
    new THREE.Vector2(frame3.max.x, frame3.max.y),
  );

  // Billboards are STATIC, both layers fully drawn. Measured over a 48-frame,
  // 34-second reference sequence: no horizontal movement at any height (<1px),
  // and no cross-fade weight fits better at any moment than another - the
  // best-fitting blend is constant. The two textures of a pair are two layers
  // of one plant (e.g. the soft coral's dark leaves behind its bright fan),
  // not two animation frames.
  function update(t: number): void {
    caustics?.update(t); // caustics hook
    const [a, b] = opts.billboardOpacity ?? [1, 1];
    for (const bb of billboards) {
      bb.a.opacity = a;
      bb.b.opacity = b;
    }
  }
  update(0);

  function dispose(): void {
    for (const r of [root, near]) r.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        (mat as THREE.MeshBasicMaterial).map?.dispose();
        mat.dispose();
      }
    });
  }

  return { object: root, near, frame, update, dispose };
}
