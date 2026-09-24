// The living part of the tank: fish, sea horses, the crab and the sea star.
//
// The motion is a port of the original's update code, function by function
// (addresses are virtual addresses in `Living Marine Aquarium 2 Full.scr`,
// read from the decompile in ~/lma2-decomp; docs/original-logic.md 3-4, 9):
//
//   - fish: update 0x415150, zone test 0x417c60, zone-centre angle 0x4188c0,
//     avoidance 0x416fb0 / 0x404d40 / 0x403540, mood timer 0x408af0 / 0x408b50,
//     start pose 0x417d10, constructor 0x416400 / 0x414860;
//   - sea horse: update 0x41f540, steer 0x41fa30, navigator 0x4191a0 (init),
//     0x4189b0 (per frame), 0x417e40 (next waypoint), 0x418610 (spline);
//   - crab 0x409d00; sea star 0x4210e0 / 0x420db0 (load) / 0x420260.
//
// ONE orthographic camera for everything; depth is faked by the fish code
// (0.4 larger and up to 3x faster at the near edge of the bounds). Fish with
// z < 0 are drawn after everything, the others between the background plane
// and the rest of the painting.
//
// All positions are kept in the original's .X / Direct3D coordinates (z grows
// AWAY from the viewer); three.js sees them through a Z mirror. Matrices are
// built in D3D's row-vector order and transposed into three.js.
//
// The simulation is per frame, like the original's: its position averaging,
// pitch smoothing and 10-frame avoidance history make it frame-rate
// dependent in the original too.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { type FishEntry, type FishInstance, type FishModel, loadFish } from "./fish.ts";
import { loadXDoc } from "./xloader.ts";
import { applyCreatureCaustics } from "./caustics.ts"; // caustics hook
import { attachCrabShadow } from "./shadow.ts"; // caustics hook (crab shadow)
import { applyFixedFunction, FISH, FLOOR, HORSE, setFixedFunctionScene } from "./fixedfunction.ts"; // [render2]

/** Small seedable PRNG (mulberry32), so a given ?t= always shows the same frame. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** easeIn 0x417bf0: (sin(u pi - pi/2) + 1) / 2 (easeOut 0x417c10 = 1 - easeIn). No clamping. */
const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

type V3 = { x: number; y: number; z: number };

/**
 * 0x417ae0: linear interpolation along a polyline sorted by x, clamped to its
 * ends. (The original returns 0 when x lands exactly on an inner vertex: a
 * measure-zero quirk, not reproduced.)
 */
function polyline(pts: [number, number][]): (x: number) => number {
  pts.sort((a, b) => a[0] - b[0]);
  return (x) => {
    if (!pts.length) return -Infinity;
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1);
      }
    }
    return pts[pts.length - 1][1];
  };
}

/**
 * Signed angle between `h` and `v` (0x42cc80, and 0x4188c0 for the zone
 * centre): acos of the normalised 3D dot product, negative when
 * h.x v.z - v.x h.z < 0. A positive angle is a turn to DECREASING yaw.
 */
function signedAngle(h: V3, v: V3): number {
  const n = Math.hypot(h.x, h.y, h.z) * Math.hypot(v.x, v.y, v.z);
  if (!(n > 0)) return 0;
  const a = Math.acos(Math.min(1, Math.max(-1, (h.x * v.x + h.y * v.y + h.z * v.z) / n)));
  return h.x * v.z - v.x * h.z < 0 ? -a : a;
}

/** Row-vector D3DX rotations applied to a direction (v * M). */
function rotY(v: THREE.Vector3, a: number): THREE.Vector3 {
  const c = Math.cos(a), s = Math.sin(a);
  return v.set(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
function rotZ(v: THREE.Vector3, a: number): THREE.Vector3 {
  const c = Math.cos(a), s = Math.sin(a);
  return v.set(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
}

/** What the creatures need from a scene's data files. */
interface SceneData {
  /** Every vertex of scenes/<n>/mesh.X, world space (the camera's box too). */
  bbox: Box;
  /** Fish bounds: bbox with min.y and max.z scaled by 0.8. */
  bounds: Box;
  /** Fish floor from path.X Crab_Path (RAW points): y = bbox.min.y + 0.15 H + p.y - 30. */
  floor: (x: number) => number;
  /** The crab's and sea star's line: the same points at y = bbox.min.y + 0.15 H + p.y - 80, sorted by x. */
  walkPath: [number, number][];
  /** Top edge of the foreground reef painting (mesh `height`). */
  height: (x: number) => number;
}

/** The mood timer object (0x408af0 / 0x408b50): start, duration, max duration, state. */
interface Mood {
  state: number;
  start: number;
  duration: number;
  max: number;
}

/** Follower distance bands (0x45908c): [near, far]. */
const BANDS: [number, number][] = [[100, 300], [200, 400], [300, 500]];

/** Zone test 0x417c60: inside, or the first violated side (0 below, 1 above, 2..5 x/z walls). */
function zoneTest(z: Box, x: number, y: number, zz: number): { inside: boolean; side: number } {
  if (y < z.minY) return { inside: false, side: 0 };
  if (y > z.maxY) return { inside: false, side: 1 };
  if (x < z.minX) return { inside: false, side: 2 };
  if (x > z.maxX) return { inside: false, side: 3 };
  if (zz < z.minZ) return { inside: false, side: 4 };
  if (zz > z.maxZ) return { inside: false, side: 5 };
  return { inside: true, side: -1 };
}

/** Zone for a mode (0x414770): 0 near (in front of the painting), 1 far (behind it). */
function zoneOf(b: Box, mode: number): Box {
  const depth = b.maxZ - b.minZ, H = b.maxY - b.minY;
  if (mode === 0) return { ...b, minZ: b.minZ + 300, maxZ: b.maxZ - (0.5 * depth + 750) };
  if (mode === 1) return { ...b, minZ: b.minZ + 0.5 * depth + 1250, minY: b.minY + 0.25 * H };
  return { ...b };
}

/** The sea horse's navigator (0x4191a0): a Catmull-Rom path through waypoints ~150 units apart. */
interface Nav {
  full: Box;
  mode: number;
  zone: Box;
  centre: THREE.Vector3;
  /** P0..P4: the spline runs P1 -> P2 over P0..P3; P4 is the newest waypoint. */
  P: THREE.Vector3[];
  u: number;
  turnBack: number; // +4: waypoints left in a 30-degree turn-back, or -1
  cntV: number; // +0xe8: waypoints until the next random pitch
  cntH: number; // +0xec: waypoints until the next random yaw
  flipPending: boolean; // +0xe1
  timer: number; // +0xe4: zone flip timer, in navigator steps
}

interface Fish {
  species: string;
  kind: "fish" | "horse";
  inst: FishInstance | null; // null: an invisible schooling leader
  holder: THREE.Group | null;
  scale: number; // settings scale * 0.1 (+0x278)
  speed: number; // settings speed * 0.1 (+0x27c)
  aggression: number; // settings aggression * 0.1 (+0x280); 1 for the sea horse
  aggRef: number; // +0x7c: the aggression of the last creature this one compared itself to
  behav: number;
  school: boolean;
  meshR: number; // bounding-sphere radius of the mesh file (+0x4c), model units
  isLeader: boolean;
  leader: Fish | null;
  timeOffset: number; // +0x68
  tt: number; // +0x180: t + timeOffset, as of the last update
  sa: number; // speedAnim (+0x80)
  sm: Mood; // +0x260
  mode: number; // zone mode (nav +0x48)
  modeTimer: number; // +0xb4
  pos: THREE.Vector3; // +0xc4
  yaw: number; // +0xd0
  pitch: number; // +0xe8
  pitchVel: number; // +0xf0: the pitch inertia term
  heading: THREE.Vector3; // +0xb8: (cos yaw, 0, -sin yaw), refreshed mid-update
  zoneTurn: number; // +0xf4
  zoneTurnStart: number; // +0xd4
  turnReset: number; // +0x14c
  leadTurn: number; // +0xe0
  leadTurnStart: number; // +0xdc
  reaim: number; // +0x274: decremented by STEP, reset to 0.3
  band: number; // +0x270
  avoidTurn: number; // +0xe4
  avoidStart: number; // +0xec
  gateR: boolean; // +0x144: -cos(5 tt) > 0.3 (previous frame)
  gateL: boolean; // +0x145: -cos(5 tt) < -0.3
  gateMag: number; // +0xfc: -cos(5 tt)
  avoid: boolean; // nav +0xe0
  avoidRing: THREE.Vector3[]; // nav +0xc0: the last 10 avoidance sums, zeros included
  ph: number; // +0x17c
  /** World matrix translation and nose direction (what the other creatures see). */
  mpos: THREE.Vector3;
  mdir: THREE.Vector3;
  // drawn state
  size: number;
  front: boolean; // +5
  // sea horse only
  clock: number; // +0xa4
  swayPhase: number; // +0x68
  nav: Nav | null;
  sway: { w: number[]; left: number; right: number } | null;
}

/**
 * A walker on the seabed line (crab, sea star): Catmull-Rom through the
 * Crab_Path points sorted by x, over a sliding 4-point window; u runs 0..1 per
 * segment and the window shifts by one point on overflow.
 */
class PathWalker {
  i = 1;
  u = 0;
  constructor(private pts: [number, number][]) {}

  /** Advance u; on overflow shift the window. `wrap`: keep the fraction (star); else reset to 0 / 1 (crab). */
  advance(du: number, wrap: boolean): void {
    this.u += du;
    const last = this.pts.length - 3;
    if (this.u > 1) {
      if (this.i < last) this.i++, this.u = wrap ? this.u - 1 : 0;
      else this.u = 1;
    } else if (this.u < 0) {
      if (this.i > 1) this.i--, this.u = wrap ? this.u + 1 : 1;
      else this.u = 0;
    }
  }

  /** Point (x, y) and tangent (dx, dy) at the current place. */
  sample(): { x: number; y: number; tx: number; ty: number } {
    const p = this.pts, i = this.i, u = this.u;
    const a = p[Math.max(i - 1, 0)], b = p[i], c = p[Math.min(i + 1, p.length - 1)], d = p[Math.min(i + 2, p.length - 1)];
    const cr = (k: 0 | 1) =>
      0.5 * (2 * b[k] + (-a[k] + c[k]) * u + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u * u + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * u * u * u);
    const dcr = (k: 0 | 1) =>
      0.5 * ((-a[k] + c[k]) + 2 * (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u + 3 * (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * u * u);
    return { x: cr(0), y: cr(1), tx: dcr(0), ty: dcr(1) };
  }
}

interface Crab {
  inst: FishInstance;
  holder: THREE.Group;
  walk: PathWalker;
  plus: boolean; // +0xc0: walking toward +x
  speed: number; // +0xc4
  sm: Mood; // +0x3c
  turning: boolean; // +200: a turn (4 s forced stop) is running
  turnTimer: number; // +0xbc
  phase: number; // +0x40
}

interface Star {
  holder: THREE.Group;
  spin: THREE.Group;
  shadow: THREE.Object3D | null;
  glass: boolean;
  walk: PathWalker;
  plus: boolean; // +0xb4: walking toward +x
  yaw: number; // +0xac, D3D sense
  arms: { mesh: THREE.Mesh; base: Float32Array; arms: { verts: number[]; axis: THREE.Vector3; diag2: number }[] } | null;
}

/** Scene clear colours (docs/original-logic.md 2.3): the sea horse's fog colour. */
const WATER: Record<string, number> = { "1": 0x008aff, "2": 0x00cbfd, "3": 0x036ed6 };

/** The crab's walk phase counts pose FRAMES: pose int(phase)%12+1 blended into the next. */
const CRAB_FRAMES = 12;

/** Bounding sphere as the original computes it (0x42ef70): max distance from the vertex centroid. */
function meshRadius(object: THREE.Object3D): number {
  object.updateMatrixWorld(true);
  const inv = object.matrixWorld.clone().invert();
  const pts: THREE.Vector3[] = [];
  const c = new THREE.Vector3();
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.name === "crab-shadow") return;
    const p = o.geometry.getAttribute("position");
    const m = inv.clone().multiply(o.matrixWorld);
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m);
      pts.push(v);
      c.add(v);
    }
  });
  if (!pts.length) return 0;
  c.divideScalar(pts.length);
  let r = 0;
  for (const v of pts) r = Math.max(r, v.distanceTo(c));
  return r;
}

export class Tank {
  /** Creatures in FRONT of the foreground painting (drawn last). */
  readonly scene = new THREE.Scene();
  /** Creatures BEHIND the foreground painting (drawn after the background plane). */
  readonly behind = new THREE.Scene();
  /** Crab and sea star (drawn after the painting, before the front creatures). */
  readonly floor = new THREE.Scene();
  /** A sea star on the front glass: drawn over everything. */
  readonly glass = new THREE.Scene();
  /** The painting's orthographic camera (setView). */
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  /** The creature list (0x720): fish, leaders and sea horses; re-sorted far to near every frame. */
  private fish: Fish[] = [];
  /** The same creatures in creation order (stable slots for probe()). */
  private roster: Fish[] = [];
  private crabs: Crab[] = [];
  private stars: Star[] = [];
  private models = new Map<string, FishModel>();
  private radii = new Map<string, number>();
  private random: () => number;
  private data: SceneData | null = null;
  private sceneId: string | null = null;
  private t = 0;
  private predatorClock = 10;
  /** Linear depth fog on fish and sea horses toward the water colour, from the
   * foreground plane (z = 0) to z = 2 * bbox.max.z. (View depth = 10000 + z.) */
  private fog = new THREE.Fog(0x008aff, 10000, 12000);
  schooling = true;
  /** Mesh animation on (off only for headless measurement: tools/probe-ours.ts). */
  animate = true;

  constructor(seed = 20260923) {
    this.random = rng(seed);
    // [render2] Lighting, fog and blending are the original's fixed-function pipeline,
    // per creature class, in the materials themselves (src/fixedfunction.ts,
    // applied in model()): fish L2 over ambient 0xAA with specular; the sea
    // horse L2 over 0x80; the crab and sea star L1 over 0x80. The scenes hold
    // no three.js lights.
  }

  /** Match the painting's orthographic view (called on every resize). */
  setView(cx: number, cy: number, hw: number, hh: number): void {
    const c = this.camera;
    Object.assign(c, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh, near: 1, far: 20000 });
    c.position.set(0, 0, 10000); // looking down -Z = the original's +Z
    c.updateProjectionMatrix();
  }

  /** Load the scene's bounds, sea floor and reef line; re-spawn the creatures in it. */
  async setScene(id: string, assetsUrl: string): Promise<void> {
    if (id === this.sceneId) return;
    const base = `${assetsUrl}scenes/${id}/`;
    const doc = await loadXDoc(base + "mesh.X");
    const bbox: Box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const v = new THREE.Vector3();
    let heightPts: [number, number][] = [];
    for (const m of doc.meshes) {
      const pts: [number, number][] = [];
      for (let i = 0; i < m.positions.length; i += 3) {
        v.fromArray(m.positions, i).applyMatrix4(m.world);
        bbox.minX = Math.min(bbox.minX, v.x), bbox.maxX = Math.max(bbox.maxX, v.x);
        bbox.minY = Math.min(bbox.minY, v.y), bbox.maxY = Math.max(bbox.maxY, v.y);
        bbox.minZ = Math.min(bbox.minZ, v.z), bbox.maxZ = Math.max(bbox.maxZ, v.z);
        pts.push([v.x, v.y]);
      }
      if (m.name === "height") heightPts = pts;
    }
    const H = bbox.maxY - bbox.minY;
    // Crab_Path is NOT baked to world: its RAW vertices are used, frame ignored.
    let raw: [number, number][] = [];
    try {
      const path = await loadXDoc(base + "path.X");
      const crab = path.meshes.find((m) => m.name === "Crab_Path");
      if (crab) for (let i = 0; i < crab.positions.length; i += 3) raw.push([crab.positions[i], crab.positions[i + 1]]);
    } catch { /* no path.X */ }
    if (raw.length < 4) raw = [[bbox.minX, 0], [bbox.minX / 3, 0], [bbox.maxX / 3, 0], [bbox.maxX, 0]];
    raw.sort((p, q) => p[0] - q[0]);
    const Ay = bbox.minY + 0.15 * H;
    this.data = {
      bbox,
      bounds: { ...bbox, minY: bbox.minY * 0.8, maxZ: bbox.maxZ * 0.8 },
      floor: polyline(raw.map(([x, y]) => [x, y + Ay - 30])),
      walkPath: raw.map(([x, y]) => [x, y + Ay - 80]),
      height: polyline(heightPts.length ? heightPts : [[0, bbox.minY]]),
    };
    this.sceneId = id;
    this.fog.color.setHex(WATER[id] ?? 0);
    this.fog.near = 10000;
    this.fog.far = 10000 + 2 * bbox.maxZ;
    setFixedFunctionScene({ bbox, fogColor: WATER[id] ?? 0, fogNear: this.fog.near, fogFar: this.fog.far }); // [render2]
    for (const f of this.fish) this.spawn(f);
    for (const c of this.crabs) this.placeCrab(c);
    for (const st of this.stars) this.placeStar(st);
  }

  /** MSVC-style rand(): 0..32767. */
  private rand(): number {
    return Math.floor(this.random() * 32768);
  }

  private async model(entry: FishEntry, assetsUrl: string): Promise<FishModel> {
    let m = this.models.get(entry.slug);
    if (!m) {
      m = await loadFish(entry, assetsUrl, { recentre: false }); // [render2] raw .X origins, as the original draws them
      this.radii.set(entry.slug, meshRadius(m.object)); // before the shadow quad goes in
      applyFixedFunction(m.object, m.kind === "swim" ? FISH : m.kind === "sway" ? HORSE : FLOOR); // [render2] D3D6 lighting and blending
      applyCreatureCaustics(m.object, m.kind, assetsUrl); // caustics hook: caustic / causticonfish pass
      if (m.kind === "cycle") attachCrabShadow(m.object, assetsUrl); // caustics hook: crab shadow (after caustics)
      this.models.set(entry.slug, m);
    }
    return m;
  }

  /** Add every creature in the tank config: tank[slug] = count. Call setScene first. */
  async populate(fish: FishEntry[], tank: Record<string, number>, assetsUrl: string): Promise<void> {
    for (const entry of fish) {
      let count = tank[entry.slug] ?? 0;
      if (!count) continue;
      const model = await this.model(entry, assetsUrl);
      if (model.kind === "cycle") {
        this.addCrab(model); // the original caps the crab and sea star at 1
        continue;
      }
      if (model.kind === "static") {
        this.addStar(model);
        continue;
      }
      const b = entry.behaviour;
      const school = (b.school ?? 0) > 0;
      const withLeader = model.kind === "swim" && school && count > 1 && this.schooling;
      if (withLeader) count++;
      let leader: Fish | null = null;
      for (let i = 0; i < count; i++) {
        const isLeader = withLeader && i === 0;
        const f = this.addFish(entry, model, isLeader, leader);
        if (isLeader) leader = f;
      }
    }
  }

  private addFish(entry: FishEntry, model: FishModel, isLeader: boolean, leader: Fish | null): Fish {
    const b = entry.behaviour;
    const horse = model.kind === "sway";
    let inst: FishInstance | null = null, holder: THREE.Group | null = null;
    if (!isLeader) {
      inst = model.instance();
      holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.add(inst.object);
      this.scene.add(holder);
    }
    // Fish constructor 0x416400 + load 0x414860; sea horse 0x41f260 + 0x41f330.
    const front = horse ? true : (this.rand() & 1) > 0;
    const band = horse ? 0 : this.rand() % 3;
    const modeTimer = this.rand() % 120 + 10;
    const timeOffset = horse ? 0 : (this.rand() % 100) * 0.1;
    const f: Fish = {
      species: entry.slug,
      kind: horse ? "horse" : "fish",
      inst,
      holder,
      scale: (b.scale ?? 10) * 0.1, // (the sea horse has its own size law)
      speed: (b.speed ?? 10) * 0.1,
      aggression: horse ? 1 : (b.aggression ?? 20) * 0.1, // CSeaHorse's getter returns 1 (0x406c50)
      aggRef: 1, // base constructor 0x406ae0
      behav: b.behav ?? 1,
      school: (b.school ?? 0) > 0,
      meshR: this.radii.get(entry.slug) ?? model.radius,
      isLeader,
      leader,
      timeOffset,
      tt: timeOffset,
      sa: horse ? 1 : 2,
      // first duration: uninitialised memory in the original [unknown] - expires at once
      sm: horse ? { state: 0, start: 0, duration: 0, max: 4 } : { state: this.rand() % 3, start: timeOffset, duration: 0, max: 4 },
      mode: 0,
      modeTimer,
      pos: new THREE.Vector3(),
      yaw: 0,
      pitch: 0.3,
      pitchVel: 0,
      heading: new THREE.Vector3(1, 0, 0),
      zoneTurn: 0,
      zoneTurnStart: 0,
      turnReset: 0,
      leadTurn: 0,
      leadTurnStart: 0,
      reaim: 0.8,
      band,
      avoidTurn: 0,
      avoidStart: 0,
      gateR: false,
      gateL: false,
      gateMag: 0,
      avoid: false,
      avoidRing: [],
      ph: timeOffset,
      mpos: new THREE.Vector3(),
      mdir: new THREE.Vector3(1, 0, 0),
      size: 1,
      front,
      clock: 0,
      swayPhase: 0, // +0x68 is never initialised for the sea horse [unknown]; 0
      nav: null,
      sway: null,
    };
    if (horse && inst) {
      inst.object.traverse((o) => {
        const m = o as THREE.Mesh;
        const dict = m.morphTargetDictionary, w = m.morphTargetInfluences;
        if (dict && w && dict.left !== undefined && dict.right !== undefined) f.sway = { w, left: dict.left, right: dict.right };
      });
    }
    this.fish.push(f);
    this.roster.push(f);
    if (this.data) this.spawn(f);
    return f;
  }

  /** Start pose: navigator 0x4191a0, then (fish) 0x417d10. */
  private spawn(f: Fish): void {
    const d = this.data!, b = d.bounds;
    const nav = this.navInit(b);
    f.mode = nav.mode;
    f.avoidRing = [new THREE.Vector3()];
    f.avoid = false;
    if (f.kind === "horse") {
      f.nav = nav;
      const cur = this.navSpline(nav, nav.u);
      f.pos.copy(cur);
      f.mpos.copy(cur);
      f.mdir.set(1, 0, 0);
      return;
    }
    const z = nav.zone;
    f.pos.set(
      (z.maxX - z.minX) * 0.01 * (this.rand() % 80 + 1) + z.minX,
      (z.maxY - z.minY) * 0.01 * (this.rand() % 60 + 20) + z.minY,
      (z.maxZ - z.minZ) * 0.01 * 50 + z.minZ,
    );
    f.yaw = (this.rand() % 100 + 1) * 0.06283185;
    f.pitch = (this.rand() % 100 + 1) * 0.007853982 - 0.3926991;
    const lim = (b.maxZ - b.minZ) * 0.25;
    if (Math.abs(f.pos.z) < lim) f.pos.y = Math.max(f.pos.y, this.reefLine(f.pos.x, f.pos.z, z));
    f.heading.set(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    f.mpos.copy(f.pos);
    f.mdir.copy(f.heading);
    f.zoneTurn = 0;
    f.zoneTurnStart = f.tt;
  }

  /** The blended reef line a fish must stay above near the foreground plane. */
  private reefLine(x: number, z: number, zone: Box): number {
    const b = this.data!.bounds, lim = 0.25 * (b.maxZ - b.minZ);
    const k = Math.sin((1 - Math.abs(z) / lim) * Math.PI / 2);
    return (this.data!.height(x) - zone.minY) * k + zone.minY;
  }

  // --- sea horse navigator (0x4191a0, 0x4189b0, 0x417e40, 0x418610) ----------------

  private setMode(n: Nav, mode: number): void {
    n.mode = mode;
    n.zone = zoneOf(n.full, mode);
    const z = n.zone;
    n.centre.set((z.maxX - z.minX) * 0.5 + z.minX, (z.maxY - z.minY) * 0.5 + z.minY, (z.maxZ - z.minZ) * 0.5 + z.minZ);
  }

  /** 0x4191a0. Every fish and sea horse builds one (the fish only use its zone). */
  private navInit(full: Box): Nav {
    const n: Nav = {
      full,
      mode: 0,
      zone: full,
      centre: new THREE.Vector3(),
      P: [],
      u: 0,
      // turnBack and the two counters are uninitialised during the pre-simulation [unknown]
      turnBack: -1,
      cntV: 0,
      cntH: 0,
      flipPending: false,
      timer: 0,
    };
    this.setMode(n, this.rand() & 1);
    n.timer = this.rand() % 120 + 10;
    const hw = (n.zone.maxX - n.zone.minX) * 0.5, hd = (n.zone.maxZ - n.zone.minZ) * 0.5;
    this.rand();
    for (let i = 0; i < 5; i++) {
      n.P.push(new THREE.Vector3(Math.cos(i * 1.2566371) * hw + n.centre.x, n.centre.y, Math.sin(i * 1.2566371) * hd + n.centre.z));
    }
    n.u = (this.rand() % 20) * 0.05;
    for (let k = this.rand() % 45 + 10; k > 0; k--) this.navStep(n);
    n.turnBack = -1;
    n.cntV = this.rand() % 3;
    n.cntH = this.rand() % 3;
    return n;
  }

  /** 0x418610: Catmull-Rom over P0..P3 (P1 -> P2). */
  private navSpline(n: Nav, u: number, out = new THREE.Vector3()): THREE.Vector3 {
    const u2 = u * u, u3 = u2 * u;
    const a = 2 * u2 - u3 - u, b = 3 * u3 - 5 * u2 + 2, c = 4 * u2 - 3 * u3 + u, d = u3 - u2;
    const [p0, p1, p2, p3] = n.P;
    return out.set(
      (a * p0.x + b * p1.x + c * p2.x + d * p3.x) * 0.5,
      (a * p0.y + b * p1.y + c * p2.y + d * p3.y) * 0.5,
      (a * p0.z + b * p1.z + c * p2.z + d * p3.z) * 0.5,
    );
  }

  /** 0x417e40 with a zero avoidance vector (the sea horse always passes 0): append a waypoint. */
  private navStep(n: Nav): void {
    const P4 = n.P[4], P3 = n.P[3];
    const d = P4.clone().sub(P3);
    const dir = d.clone().normalize();
    const probe = P4.clone().addScaledVector(dir, 150);
    let { inside, side } = zoneTest(n.zone, probe.x, probe.y, probe.z);
    const c = n.centre;
    if (!inside) {
      if (side === 0) dir.y = Math.sin((this.rand() % 10 + 1) * 0.03926991);
      else if (side === 1) dir.y = -Math.sin((this.rand() % 10 + 1) * 0.03926991);
      else if (n.turnBack < 0) {
        const v1 = c.clone().sub(P4).normalize(), v2 = d.clone().normalize();
        if (v1.dot(v2) < 0) n.turnBack = 5;
      }
      inside = false;
    }
    let stepLen = 150;
    if (n.turnBack >= 0 && inside) n.turnBack = -1;
    if (n.turnBack < 0) {
      if (inside && --n.cntH < 0) {
        const a = (this.rand() % 10 + 1) * 0.03926991;
        rotY(dir, this.rand() % 2 < 1 ? a : -a);
        n.cntH = this.rand() % 3 + 1;
      }
    } else {
      dir.copy(d).normalize();
      rotY(dir, (c.z - P4.z) * d.x - (c.x - P4.x) * d.z < 0 ? 0.5235988 : -0.5235988);
      stepLen = 75;
      n.turnBack--;
    }
    dir.multiplyScalar(stepLen);
    if (n.flipPending) rotZ(dir, (this.rand() % 10 + 1) * 0.009817477 + 0.09817477);
    else if (inside && --n.cntV < 0) {
      const a = (this.rand() % 10 + 1) * 0.019634955;
      rotZ(dir, this.rand() % 2 < 1 ? a : -a);
      n.cntV = this.rand() % 5 + 1;
    }
    const nw = P4.clone().add(dir);
    const zoneH = n.zone.maxY - n.zone.minY;
    const lim = (n.full.maxZ - n.full.minZ) * 0.25;
    let reef = false;
    if (Math.abs(nw.z) < lim) {
      const line = Math.sin((1 - Math.abs(nw.z) / lim) * Math.PI / 2) * (this.data!.height(nw.x) - n.zone.minY) + n.zone.minY;
      if (nw.y < line) nw.y = line, reef = true;
    }
    // too steep: the climb is cut to 70%
    if (!reef && dir.length() * 0.5 < Math.abs(dir.y)) nw.set(P4.x + dir.x, P4.y + dir.y * 0.7, P4.z + dir.z);
    nw.y = Math.max(nw.y, zoneH * 0.1 + n.zone.minY);
    n.P.shift();
    n.P.push(nw);
  }

  /** 0x4189b0: advance by `s` (= 6k); returns the point and the travel direction. */
  private navUpdate(n: Nav, f: Fish, s: number): { cur: THREE.Vector3; fwd: THREE.Vector3 } {
    const cur = this.navSpline(n, n.u);
    if (n.timer > 0) n.timer -= s;
    else {
      n.flipPending = true;
      if ((n.zone.maxY - n.zone.minY) * 0.6 + n.zone.minY < cur.y) {
        this.setMode(n, n.mode === 0 ? 1 : 0);
        n.timer = this.rand() % 120 + 10;
        if (n.mode === 1) n.timer *= 0.5;
        n.flipPending = false;
      }
    }
    if (f.avoid) {
      const push = this.ringAverage(f).multiplyScalar(s * 250);
      if (Math.abs(cur.z + push.z) < 100) push.z = 0;
      for (const p of n.P) if (Math.abs(p.z + push.z) < 100) push.z = 0;
      cur.add(push);
      for (const p of n.P) p.add(push);
    }
    const lim = (n.full.maxZ - n.full.minZ) * 0.25;
    if (Math.abs(cur.z) < lim) {
      const line = Math.sin((1 - Math.abs(cur.z) / lim) * Math.PI / 2) * (this.data!.height(cur.x) - n.zone.minY) + n.zone.minY;
      if (cur.y < line) {
        const dy = line - cur.y;
        for (const p of n.P) p.y += dy;
        cur.y += dy;
      }
    }
    f.avoid = false;
    n.u += s;
    if (n.u >= 1) {
      n.u = 0;
      this.navStep(n);
    }
    const fwd = this.navSpline(n, n.u).sub(cur);
    if (fwd.lengthSq() <= 0) {
      const u2 = n.u + 0.01;
      fwd.copy(u2 <= 1 ? this.navSpline(n, u2).sub(cur) : cur.clone().sub(this.navSpline(n, n.u - 0.01)));
    }
    return { cur, fwd: fwd.normalize() };
  }

  // --- crab (0x409d00) ---------------------------------------------------------------

  private addCrab(model: FishModel): void {
    if (this.crabs.length || !this.data) return;
    const inst = model.instance();
    // Local Z = the path tangent (+x: it walks sideways), then RotZ(-pi/10) so
    // its back tilts toward the viewer. No scale. In three.js (Z mirrored) the
    // model's +X faces the viewer after a -pi/2 yaw, and the tilt is +pi/10.
    const body = new THREE.Group();
    body.add(inst.object);
    body.rotation.z = -Math.PI / 10; // RotZ(-pi/10) in model space: the top leans to the viewer
    const tilt = new THREE.Group();
    tilt.add(body);
    tilt.rotation.y = -Math.PI / 2; // model Z -> +x (sideways), model +X -> the viewer
    const holder = new THREE.Group();
    holder.add(tilt);
    // (Its shadow quad comes with the model: src/shadow.ts, attached in model().)
    this.floor.add(holder);
    const c: Crab = {
      inst,
      holder,
      walk: new PathWalker(this.data.walkPath),
      plus: false, // it starts moving left
      speed: 4,
      sm: { state: 0, start: this.t, duration: 0, max: 5 }, // first duration: uninitialised [unknown] - expires at once
      turning: false,
      turnTimer: this.rand() % 100,
      phase: 0,
    };
    this.placeCrab(c);
    this.crabs.push(c);
  }

  private placeCrab(c: Crab): void {
    c.walk = new PathWalker(this.data!.walkPath);
    c.walk.i = Math.min(4, this.data!.walkPath.length - 3); // starts at sorted point 4
    c.walk.u = 0;
  }

  private updateCrab(c: Crab, dt: number): void {
    const b = this.data!.bbox, W = b.maxX - b.minX, t = this.t;
    // turn timer: every rand()%100 s a turn starts, unless one is running
    // (then it waits, and fires as soon as that one ends)
    if (c.turnTimer < 0) {
      if (!c.turning) {
        c.turnTimer = this.rand() % 100;
        this.moodForce(c.sm, 2, t, 4);
        c.turning = true;
      }
    } else c.turnTimer -= dt;
    // a turn is a forced 4 s ease-down; the direction flips when it expires,
    // and the next mood starts from standstill
    if (this.moodTick(c.sm, t) && c.turning) {
      c.plus = !c.plus;
      c.turning = false;
    }
    c.speed = this.moodSpeed(c.sm, t, c.speed, 1);
    const d = c.speed < 0.05 ? 0 : dt;
    c.phase += d * c.speed * 0.5 * (c.plus ? 2.5 : -2.5);
    if (c.phase < 0) c.phase += 110000;
    c.inst.setPhase(c.phase / CRAB_FRAMES);
    const step = d * c.speed * 0.5;
    if (step === 0) return; // standing still: the pose update is skipped
    const here = c.walk.sample();
    if ((c.plus && !c.turning && here.x >= b.minX + 0.7 * W - 250) || (!c.plus && !c.turning && here.x <= b.minX + 350)) {
      this.moodForce(c.sm, 2, t, 4); // edge turns leave the turn timer alone
      c.turning = true;
    }
    c.walk.advance(c.plus ? step : -step, false);
    const p = c.walk.sample();
    // .X: local Z along the tangent (tilted with the floor), RotZ(-pi/10)
    const slope = Math.atan2(p.ty, p.tx);
    c.holder.position.set(p.x, p.y, -b.minZ);
    c.holder.rotation.set(0, 0, slope);
  }

  // --- sea star (0x4210e0, 0x420db0, 0x420260) --------------------------------------

  private addStar(model: FishModel): void {
    if (this.stars.length || !this.data) return;
    const glass = this.rand() % 10 > 5; // 40%: on the front glass
    const inst = model.instance();
    const spin = new THREE.Group(); // spins about the star's own Y
    spin.add(inst.object);
    const roll = new THREE.Group();
    roll.add(spin);
    // glass: roll +90 deg, underside to the viewer; floor: roll -18 deg
    roll.rotation.x = glass ? -Math.PI / 2 : Math.PI / 10;
    const holder = new THREE.Group();
    holder.add(roll);
    (glass ? this.glass : this.floor).add(holder);
    let shadow: THREE.Object3D | null = null;
    let arms: Star["arms"] = null;
    inst.object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (/shadow/i.test(o.name)) {
        shadow = o;
        o.visible = !glass;
        return;
      }
      arms = this.prepareArms(o);
    });
    const st: Star = {
      holder,
      spin,
      shadow,
      glass,
      walk: new PathWalker(this.data.walkPath),
      plus: false, // +0xb4 = 0: it starts toward -x
      yaw: (this.rand() % 36) * 0.17453293, // a random multiple of 10 degrees
      arms,
    };
    this.placeStar(st);
    this.stars.push(st);
  }

  /** 0x420db0: the sorted path is rotated until the window's first point lies in its range; u = 0 there (at P1). */
  private placeStar(st: Star): void {
    const b = this.data!.bbox, W = b.maxX - b.minX, pts = this.data!.walkPath;
    const lo = b.minX + 0.7 * W, hi = b.maxX;
    let j = pts.findIndex(([x]) => x >= lo && x <= hi);
    if (j < 0) j = 0;
    st.walk = new PathWalker(pts);
    st.walk.i = Math.max(1, Math.min(j + 1, pts.length - 3));
    st.walk.u = 0;
  }

  /** The five arms (materials Top<i>/Bottom<i>): vertex lists, axis and reach. */
  private prepareArms(mesh: THREE.Mesh): Star["arms"] {
    const g = mesh.geometry = mesh.geometry.clone();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const P = (g.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const arms = new Map<string, { verts: number[]; axis: THREE.Vector3; diag2: number }>();
    for (const gr of g.groups) {
      const m = /(?:Top|Bottom)(\d)/.exec(mats[gr.materialIndex ?? 0]?.name ?? "");
      if (!m) continue;
      const a = arms.get(m[1]) ?? { verts: [], axis: new THREE.Vector3(), diag2: 0 };
      for (let v = gr.start; v < gr.start + gr.count; v++) a.verts.push(v);
      arms.set(m[1], a);
    }
    for (const a of arms.values()) {
      for (const v of a.verts) {
        const x = P[v * 3], z = P[v * 3 + 2];
        a.axis.x += x, a.axis.z += z;
        a.diag2 = Math.max(a.diag2, x * x + P[v * 3 + 1] ** 2 + z * z);
      }
      a.axis.normalize();
    }
    mesh.frustumCulled = false;
    return { mesh, base: P.slice(), arms: [...arms.entries()].sort().map(([, a]) => a) };
  }

  private updateStar(s: Star, dt: number): void {
    const b = this.data!.bbox, W = b.maxX - b.minX, t = this.t;
    const lo = b.minX + 0.7 * W, hi = b.maxX;
    const here = s.walk.sample();
    // reverses 50 units inside either end of its range
    if (s.plus && here.x >= hi - 50) s.plus = false;
    else if (!s.plus && here.x <= lo + 50) s.plus = true;
    const du = dt * 0.025;
    s.walk.advance(s.plus ? du : -du, true);
    // the spin follows the travel direction (D3D sense; three.js's yaw is its negative)
    s.yaw += s.plus ? du : -du;
    s.spin.rotation.y = -s.yaw;
    const p = s.walk.sample();
    s.holder.position.set(p.x, p.y + (s.glass ? 100 : 0), -b.minZ);
    // arms curl: s = sin(0.2 t + i pi/4); lifted by w|5s|, turned about Y by
    // w*0.5s, with w = max(0, |v|^2/diag^2 - 0.4) (diag: taken as the arm's reach [inferred])
    if (!s.arms || !this.animate) return;
    const attr = s.arms.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const P = attr.array as Float32Array, B = s.arms.base;
    P.set(B);
    s.arms.arms.forEach((a, i) => {
      const sn = Math.sin(0.2 * t + i * Math.PI / 4), lift = Math.abs(5 * sn);
      for (const v of a.verts) {
        const x = B[v * 3], y = B[v * 3 + 1], z = B[v * 3 + 2];
        const w = Math.max(0, (x * x + y * y + z * z) / a.diag2 - 0.4);
        if (!w) continue;
        const ang = w * 0.5 * sn, c = Math.cos(ang), si = Math.sin(ang); // about the star's Y
        P[v * 3] = x * c + z * si;
        P[v * 3 + 1] = y + w * lift;
        P[v * 3 + 2] = -x * si + z * c;
      }
    });
    attr.needsUpdate = true;
  }

  // --- mood timer (0x408af0, 0x408b50) ----------------------------------------------

  /** Re-roll when the period has run out (strictly); true when it did. */
  private moodTick(m: Mood, now: number): boolean {
    if (now - m.start > m.duration) {
      m.start = now;
      m.state = this.rand() % 3;
      const h = Math.trunc(m.max / 2);
      m.duration = this.rand() % h + h;
      return true;
    }
    return false;
  }

  /** Force a state from `start`; duration -1 = a random one. */
  private moodForce(m: Mood, state: number, start: number, duration: number): void {
    m.start = start;
    m.state = state;
    if (duration === -1) {
      const h = Math.trunc(m.max / 2);
      m.duration = this.rand() % h + h;
    } else m.duration = duration;
  }

  /** State 1 eases the value up to `top`, state 2 down to 0, state 0 holds it. */
  private moodSpeed(m: Mood, now: number, v: number, top: number): number {
    if (m.state !== 1 && m.state !== 2) return v;
    let u = (now - m.start) / m.duration;
    if (u > 1) u = 1;
    return m.state === 1 ? Math.max(v, top * ease(u)) : Math.min(v, top * (1 - ease(u)));
  }

  // --- fish ---------------------------------------------------------------------------

  /** The average of the avoidance history (0x4150a0). */
  private ringAverage(f: Fish): THREE.Vector3 {
    const s = new THREE.Vector3();
    for (const v of f.avoidRing) s.add(v);
    return f.avoidRing.length ? s.divideScalar(f.avoidRing.length) : s;
  }

  /** Collision radius getter (vtable +0x20): scale * mesh radius (fish), mesh radius (sea horse). */
  private radius(f: Fish): number {
    return f.kind === "horse" ? f.meshR : f.scale * f.meshR;
  }

  /**
   * Avoidance (0x416fb0 fish / 0x41fa30 sea horse -> 0x404d40, weight 0x403540),
   * for every creature before any of them moves.
   */
  private computeAvoidance(f: Fish): void {
    if (f.isLeader) return; // leaders never avoid (nor record anything)
    const probe = f.mpos.clone().addScaledVector(f.mdir, f.size * this.radius(f));
    const sum = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (const c of this.fish) {
      // Each comparison stores c's aggression in MY +0x7c, and c's weight
      // compares c's aggression with c's own +0x7c: in effect with the
      // aggression of the last creature in the list, the nearest one.
      f.aggRef = c.aggression;
      const cr = this.radius(c);
      let R = 2 * cr + 1.2 * cr;
      const da = c.aggression - c.aggRef;
      if (da > 0.001) R *= 1.2;
      else if (da < -0.001) R = 0;
      const w0 = R * R - probe.distanceToSquared(c.mpos);
      if (!(w0 >= 0)) continue;
      const w = w0 / (R * R);
      if (!(w > 0) || c.mpos.equals(f.mpos)) continue;
      sum.add(tmp.subVectors(f.mpos, c.mpos).normalize().multiplyScalar(w));
    }
    if (sum.lengthSq() > 1e-4) {
      // (the sea horse stamps its forced mood with its sway phase, not its clock)
      this.moodForce(f.sm, 2, f.kind === "horse" ? f.swayPhase : f.tt, -1);
    }
    f.avoid = sum.x !== 0 || sum.y !== 0 || sum.z !== 0;
    f.avoidRing.push(sum);
    if (f.avoidRing.length > 10) f.avoidRing.shift();
  }

  /** CFish::update, 0x415150. */
  private updateFish(f: Fish, dt: number): void {
    const d = this.data!, b = d.bounds, p = f.pos;
    const pitch0 = f.pitch;
    const prev = p.clone();
    // the sea floor, before the averaging below (so it is soft)
    const fl = d.floor(p.x);
    if (p.y < fl) p.y = fl;
    const tt = this.t + f.timeOffset;
    f.tt = tt;
    // zone mode: unled fish flip on a timer; followers copy their leader
    if (!f.leader) {
      if (f.modeTimer > 0) f.modeTimer -= dt;
      else {
        f.mode = f.mode === 0 ? 1 : 0;
        f.modeTimer = this.rand() % 120 + 10;
        if (f.mode === 1) f.modeTimer *= 0.5;
        f.zoneTurnStart = tt;
        f.zoneTurn = 0;
      }
    } else f.mode = f.leader.mode;
    const zone = zoneOf(b, f.mode);
    f.turnReset -= dt;
    if (f.turnReset < 0) {
      f.turnReset = 2;
      f.zoneTurn = 0;
      f.zoneTurnStart = tt;
    }
    this.moodTick(f.sm, tt);
    f.sa = this.moodSpeed(f.sm, tt, f.sa, 15);
    const step = (f.sa + 2) * f.speed * dt * 0.006666667;
    f.reaim -= step; // in STEP units, not seconds

    // following a leader (schooling, or a trigger chasing a clown)
    const L = f.leader;
    if (L) {
      const [near, far] = BANDS[f.band];
      const d2 = p.distanceToSquared(L.pos);
      if (d2 <= far * far) {
        if (d2 < near * near && f.sm.state !== 2) this.moodForce(f.sm, 2, tt, 1);
      } else if (f.sm.state !== 1) this.moodForce(f.sm, 1, tt, 1);
      if (Math.trunc(tt) % 10 > 8) f.band = this.rand() % 3; // every frame of that second
      if (f.reaim <= 0) {
        const a = signedAngle(f.heading, { x: L.pos.x - p.x, y: L.pos.y - p.y, z: L.pos.z - p.z });
        if (Math.abs(a) > 0.5235988) {
          f.leadTurn = a;
          f.leadTurnStart = f.ph; // (stamped with ph, so the start ease is ~1)
        }
        f.reaim = 0.3;
      }
      if (f.mpos.y < L.mpos.y && f.pitch < 0.4) f.pitch += step;
      if (L.mpos.y < f.mpos.y && f.pitch > -0.4) f.pitch -= step;
    }
    f.ph += 2 * step;
    f.heading.set(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    const { inside, side } = zoneTest(zone, p.x, p.y, p.z);

    // avoidance turn: tail-beat gated, |-cos 5tt| strong
    if (f.avoid && Math.abs(f.avoidTurn) > 0.3) {
      const dd = step * 10 * Math.abs(f.gateMag) * ease(Math.min(tt - f.avoidStart, 1));
      if (f.avoidTurn >= 0) {
        if (f.gateR) f.avoidTurn -= dd, f.yaw -= dd;
      } else if (f.gateL) f.avoidTurn += dd, f.yaw += dd;
    }
    if (!inside) {
      if (side === 0) {
        if (f.pitch < 0.2) f.pitch += 5 * step;
      } else if (side === 1) {
        if (f.pitch > -0.2) f.pitch -= 5 * step;
      } else if (!f.avoid) {
        // an x or z wall: turn toward the zone centre (not while avoiding)
        if (f.zoneTurn === 0) f.zoneTurn = signedAngle(f.heading, { x: zone.minX + (zone.maxX - zone.minX) / 2 - p.x, y: zone.minY + (zone.maxY - zone.minY) / 2 - p.y, z: zone.minZ + (zone.maxZ - zone.minZ) / 2 - p.z });
        const m = Math.abs(f.zoneTurn);
        if (m > 0.1) {
          const dd = step * 10 * ease(Math.min(m, 1)) * ease(Math.min(tt - f.zoneTurnStart, 1));
          if (f.zoneTurn < 0) f.zoneTurn += dd, f.yaw += dd;
          else f.zoneTurn -= dd, f.yaw -= dd;
        }
      }
    } else {
      // inside the zone: the turn toward the leader, tail-beat gated
      const m = Math.abs(f.leadTurn);
      if (m > 0.3) {
        const dd = step * 10 * ease(Math.min(m, 1)) * ease(Math.min(tt - f.leadTurnStart, 1));
        if (f.leadTurn >= 0) {
          if (f.gateR) f.leadTurn -= dd, f.yaw -= dd;
        } else if (f.gateL) f.leadTurn += dd, f.yaw += dd;
      }
      f.zoneTurnStart = tt;
      f.zoneTurn = 0;
    }
    if (f.yaw > 6.2831855) f.yaw -= 6.2831855;
    else if (f.yaw < -6.2831855) f.yaw += 6.2831855;

    // the tail beat: gates for the next frame's turns, and the body bend
    const A = (f.sa + 2) * 0.05882353;
    const g = -Math.cos(5 * tt);
    f.gateR = g > 0.3;
    f.gateL = g < -0.3;
    f.gateMag = g;
    // pitch smoothing: HERE, after the leader and zone nudges only
    f.pitch = (pitch0 + f.pitch) * 0.5;
    const yaw = A * Math.sin(5 * tt) * 0.16666667 + f.yaw;
    const pitch = A * Math.cos(2 * tt) * -0.16666667 + f.pitch;

    // move: average with the start position (only the floor clamp differs), then along the nose
    p.add(prev).multiplyScalar(0.5);
    const depth = b.maxZ - b.minZ;
    f.size = f.scale * 0.8 + (b.maxZ - Math.max(p.z, b.minZ)) / depth * 0.4;
    const dx = ((b.maxZ - p.z) / depth + 0.5) * step * 1000;
    f.mdir.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw));
    p.addScaledVector(f.mdir, dx);
    f.mpos.copy(p);

    // after the move, at full strength: the reef line and the avoidance push
    let locked = false;
    const lim = depth * 0.25;
    if (Math.abs(p.z) < lim && p.y < this.reefLine(p.x, p.z, zone)) {
      if (f.pitch < 0.9) f.pitch += 7 * step;
      locked = true;
      if (!f.front) {
        if (p.z < 100) p.z = 100;
      } else if (p.z > -100) p.z = -100;
    }
    if (p.y < b.minY + 0.25 * (b.maxY - b.minY)) locked = true;
    if (!f.avoid) f.avoidStart = tt;
    else {
      this.moodForce(f.sm, 1, tt, 1);
      const dir = this.ringAverage(f);
      if (!locked) {
        const e = step * 3 * ease(Math.min(tt - f.avoidStart, 1));
        if (dir.y < 0 && f.pitch > -0.6) f.pitch -= e;
        else if (dir.y > 0 && f.pitch < 0.6) f.pitch += e;
      }
      p.addScaledVector(dir, step * 1500);
      const a = signedAngle(f.heading, { x: dir.x, y: 0, z: dir.z });
      if (inside || Math.abs(f.zoneTurn) < 0.5) f.avoidTurn = a;
    }
    if (!locked && f.pitch > 0.7) f.pitch -= step;
    // pitch inertia: when nothing moved the pitch this frame, half the last change again
    if (Math.abs(pitch0 - f.pitch) <= 0) {
      f.pitchVel *= 0.5;
      f.pitch += f.pitchVel;
    } else f.pitchVel = f.pitch - pitch0;

    f.front = f.mpos.z < 0;
    if (!f.holder || !f.inst) return;
    // WORLD = Scale(s) Rz(pitch) Ry(yaw) Translate(pos) in .X row-vector order;
    // three.js (column vectors, Z mirrored) = S * T Ry Rz Sc * S.
    const drawZ = Math.max(f.mpos.z, b.minZ + 200);
    const m = f.holder.matrix;
    m.makeTranslation(f.mpos.x, f.mpos.y, drawZ)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeRotationZ(pitch))
      .multiply(new THREE.Matrix4().makeScale(f.size, f.size, f.size));
    this.place(f);
    if (this.animate && f.inst.swim) f.inst.swim({ tt, ph: f.ph, sa: f.sa, speed: f.speed });
  }

  /** CSeaHorse::update, 0x41f540. */
  private updateHorse(f: Fish, dt: number): void {
    const n = f.nav!, b = this.data!.bounds;
    this.moodTick(f.sm, f.clock);
    f.sa = this.moodSpeed(f.sm, f.clock, f.sa, 15);
    // k = dt/(25-P): the navigator advances 6k, the own clock 2k, the sway phase k
    const k = dt / (25 - f.sa);
    const { cur, fwd } = this.navUpdate(n, f, 6 * k);
    f.pos.copy(cur);
    f.clock += 2 * k;
    const a = f.swayPhase * 12;
    const sn = Math.sin(a), cs = Math.cos(a);
    f.swayPhase += k;
    // the navigator's frame: rows right, up, forward (the travel direction), position.
    // up = right x forward in D3D's left-handed rows (see 0x4189b0)
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x).normalize();
    const up = new THREE.Vector3(
      right.z * fwd.y - right.y * fwd.z,
      right.x * fwd.z - right.z * fwd.x,
      right.y * fwd.x - right.x * fwd.y,
    );
    // body yaw cos(a)/3 - pi/2 about the local Y: the snout (+X) turns to the travel direction
    const th = cs / 3 - Math.PI / 2;
    f.size = ((b.maxZ - cur.z) / (b.maxZ - b.minZ)) * 0.4 + 0.6;
    f.mpos.copy(cur);
    f.mpos.y = Math.max(f.mpos.y, (b.maxY - b.minY) * 0.1 + b.minY);
    f.mdir.copy(right).multiplyScalar(Math.cos(th)).addScaledVector(fwd, -Math.sin(th));
    f.front = f.mpos.z < 0;
    if (!f.holder || !f.inst) return;
    // row-vector WORLD = S * RotY(th) * NAV  ->  column form NAV^T * RotY * S
    const nav = new THREE.Matrix4().set(
      right.x, up.x, fwd.x, f.mpos.x,
      right.y, up.y, fwd.y, f.mpos.y,
      right.z, up.z, fwd.z, Math.max(f.mpos.z, b.minZ + 200),
      0, 0, 0, 1,
    );
    f.holder.matrix.copy(nav)
      .multiply(new THREE.Matrix4().makeRotationY(th))
      .multiply(new THREE.Matrix4().makeScale(f.size, f.size, f.size));
    this.place(f);
    if (this.animate && f.sway) {
      f.sway.w.fill(0);
      f.sway.w[f.sway.left] = Math.max(0, -sn);
      f.sway.w[f.sway.right] = Math.max(0, sn);
    }
  }

  /** Mirror the .X-space matrix into three.js and file the creature in front of / behind the painting. */
  private place(f: Fish): void {
    f.holder!.matrix.premultiply(Tank.MIRROR).multiply(Tank.MIRROR);
    f.holder!.matrixWorldNeedsUpdate = true;
    const target = f.front ? this.scene : this.behind;
    if (f.holder!.parent !== target) target.add(f.holder!);
  }

  private static readonly MIRROR = new THREE.Matrix4().makeScale(1, 1, -1);

  /** One frame of the original's creature update (0x411ec0). */
  update(dt: number): void {
    if (!this.data || dt <= 0) return;
    this.t += dt;
    // Every 10 s each Clown Trigger (behav 2) has a 20% chance to chase the
    // nearest Percula Clown (behav 0); otherwise it swims alone (0x411db0).
    this.predatorClock -= dt;
    if (this.predatorClock <= 0) {
      this.predatorClock = 10;
      const prey = this.fish.filter((f) => f.behav === 0 && !f.isLeader && (f.leader || !f.school));
      for (const f of this.fish) {
        if (f.behav !== 2 || f.isLeader || (f.school && !f.leader)) continue;
        if (this.rand() % 10 >= 8 && prey.length) {
          f.leader = prey.reduce((a, c) => (c.pos.distanceTo(f.pos) < a.pos.distanceTo(f.pos) ? c : a));
        } else f.leader = null;
      }
    }
    for (const c of this.crabs) this.updateCrab(c, dt);
    for (const s of this.stars) this.updateStar(s, dt);
    for (const f of this.fish) this.computeAvoidance(f);
    for (const f of this.fish) {
      if (f.kind === "horse") this.updateHorse(f, dt);
      else this.updateFish(f, dt);
    }
    // painter's order, far to near (comparator 0x40dc60): also the avoidance order
    this.fish.sort((a, b) => b.mpos.z - a.mpos.z);
  }

  /** Advance deterministically to time t (for ?t= snapshots). */
  simulateTo(t: number, step = 1 / 30): void {
    for (let s = 0; s < t; s += step) this.update(step);
  }

  /** The creatures behind the foreground painting: draw right after the background plane. */
  renderBehind(renderer: THREE.WebGLRenderer): void {
    // The original draws scene pass 0 with Z off: whatever it left in our
    // depth buffer must not hide the creatures.
    renderer.clearDepth();
    renderer.render(this.behind, this.camera);
  }

  /** Crab and sea star (floor variant): after scene pass 1, Z on, NO clear (bubbles' depth counts). */
  renderFloor(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.floor, this.camera);
  }

  /** The creatures in front of the foreground plane. The caller clears depth first. */
  renderFront(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  /** A sea star on the front glass, drawn last. The caller clears depth first. */
  renderGlass(renderer: THREE.WebGLRenderer): void {
    if (this.stars.some((s) => s.glass)) renderer.render(this.glass, this.camera);
  }

  /**
   * [render2] The ambient light state (grey, 0..1) that the creatures leave set at the
   * end of a frame, or null if they set none (the water surface inherits it:
   * surface.ts). The last creatures drawn are those in FRONT of the
   * foreground, far to near: the nearest one's draw sets 0xAA (a fish;
   * 0x80 after its caustic pass when causticonfish is on) or 0x80 (a sea
   * horse). A sea star on the glass comes after them, and its caustic pass
   * (with `caustic`) restores 0x80. Invisible leaders draw nothing.
   * (docs/fidelity-review.md D4; SetLightState(AMBIENT) at 0x416925,
   * 0x40612c, 0x41f956, 0x420a65.)
   */
  ambientLeft(caustic: boolean, causticOnFish: boolean): number | null {
    let nearest: Fish | null = null;
    for (const f of this.fish) if (f.holder && f.front && (!nearest || f.pos.z < nearest.pos.z)) nearest = f;
    let level: number | null = nearest ? (nearest.kind === "fish" && !causticOnFish ? 0xaa : 0x80) : null;
    if (caustic && this.stars.some((s) => s.glass)) level = 0x80;
    return level === null ? null : level / 255;
  }

  /**
   * Measurement hook (tools/track.ts comparisons): every visible creature's
   * on-screen silhouette box in pixels of a `width` x `height` view. Shadows
   * (the crab's 200-unit quad, the sea star's shadow mesh) are left out: a
   * captured silhouette does not include them.
   */
  probe(width = 1024, height = 768): { species: string; front: boolean; x0: number; y0: number; x1: number; y1: number }[] {
    const v = new THREE.Vector3();
    const out: { species: string; front: boolean; x0: number; y0: number; x1: number; y1: number }[] = [];
    const all: [string, boolean, THREE.Object3D][] = [
      ...this.roster.filter((f) => f.holder).map((f) => [f.species, f.front, f.holder!] as [string, boolean, THREE.Object3D]),
      ...this.crabs.map((c) => ["anemone-crab", true, c.holder] as [string, boolean, THREE.Object3D]),
      ...this.stars.map((s) => ["sea-star", true, s.holder] as [string, boolean, THREE.Object3D]),
    ];
    for (const [species, front, holder] of all) {
      holder.updateMatrixWorld(true);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      holder.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.visible || /shadow/i.test(o.name)) return;
        const p = o.geometry.getAttribute("position");
        for (let i = 0; i < p.count; i += 2) {
          v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).project(this.camera);
          const x = (v.x + 1) / 2 * width, y = (1 - v.y) / 2 * height;
          x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
        }
      });
      out.push({ species, front, x0, y0, x1, y1 });
    }
    return out;
  }

  get count(): number {
    return this.fish.filter((f) => f.holder).length + this.crabs.length + this.stars.length;
  }

  dispose(): void {
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
    this.fish = [];
    this.roster = [];
    this.crabs = [];
    this.stars = [];
    for (const s of [this.scene, this.behind, this.floor, this.glass]) {
      for (const o of [...s.children]) if (!(o instanceof THREE.Light)) s.remove(o);
    }
  }
}
