// The living part of the tank: fish, sea horses, the crab and the sea star.
//
// Fish follow the original's own model, recovered from its code
// (docs/original-logic.md section 3, on feat/decomp) and checked against
// reference sequences of the original (tools/track.ts, see the numbers below):
//
//   - ONE orthographic camera for everything; there is no perspective. Depth is
//     faked: a fish is drawn 0.4 larger (additive, on scale*0.8) and moves up to
//     3x as far per frame at the near edge of its bounds as at the far edge.
//   - two swim zones: near (in front of the foreground painting, z < 0) and far
//     (behind it, z > 0); each fish flips zone every 10-130 s. Every frame a
//     fish with z < 0 is drawn after everything, one with z > 0 between the
//     background plane and the rest of the painting.
//   - a speed state machine (burst / slow / hold, 2-3 s periods, cosine eased),
//     zone-edge steering, yaw/pitch wobble, the sea floor (Crab_Path) and the
//     reef silhouette (`height`) that fish may only cross the foreground above.
//   - schooling through an invisible leader; avoidance weighted by aggression;
//     Clown Triggers now and then chase the nearest Percula Clown.
//
// All positions are kept in the original's .X / Direct3D coordinates (z grows
// AWAY from the viewer); three.js sees them through a Z mirror.
//
// Measured on the original (Wine, bare tank, tools/track.ts), matched by this
// model without tuning: blue tang side-on 110-120 px long in front / cruise
// 80-90 px/s; regal angel (far zone, slow state) 5 px/s; percula (far zone)
// 25-39 px long; far-zone species never below screen y ~521 (= zone floor).
//
// The crab, the sea star and the sea horse are NOT decoded yet: their motion
// here is fitted to reference sequences and marked CALIBRATE.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { type FishEntry, type FishInstance, type FishModel, loadFish } from "./fish.ts";
import { loadXDoc } from "./xloader.ts";
import { applyCreatureCaustics } from "./caustics.ts"; // caustics hook
import { attachCrabShadow } from "./shadow.ts"; // caustics hook (crab shadow)

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

const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Linear interpolation along a polyline sorted by x, clamped to its ends. */
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

/** The speed state machine (docs/original-logic.md 3.3). */
interface SpeedState {
  state: number;
  start: number;
  duration: number;
}

interface Fish {
  species: string;
  kind: "fish" | "horse";
  inst: FishInstance | null; // null: an invisible schooling leader
  holder: THREE.Group | null;
  scale: number; // settings scale * 0.1
  speed: number; // settings speed * 0.1
  aggression: number; // settings aggression * 0.1
  behav: number;
  school: boolean;
  radius: number; // mesh bounding radius, model units
  isLeader: boolean;
  leader: Fish | null;
  timeOffset: number;
  sa: number; // speedAnim
  sm: SpeedState;
  mode: 0 | 1;
  modeTimer: number;
  pos: THREE.Vector3; // .X space
  yaw: number;
  pitch: number;
  turnTarget: number;
  turnStart: number;
  turnReset: number;
  band: [number, number];
  bandCycle: number;
  steerTimer: number;
  avoid: boolean;
  avoidRing: THREE.Vector3[];
  ph: number;
  // drawn state
  size: number;
  front: boolean;
  // sea horse only
  clock: number;
  swayPhase: number;
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

  /** Place at the segment containing x. */
  seek(x: number): void {
    const p = this.pts;
    this.i = 1;
    while (this.i < p.length - 3 && p[this.i + 1][0] < x) this.i++;
    const [x0] = p[this.i], [x1] = p[this.i + 1];
    this.u = THREE.MathUtils.clamp((x - x0) / (x1 - x0 || 1), 0, 1);
  }

  advance(du: number): void {
    this.u += du;
    const last = this.pts.length - 3;
    while (this.u > 1 && this.i < last) this.u -= 1, this.i++;
    while (this.u < 0 && this.i > 1) this.u += 1, this.i--;
    this.u = THREE.MathUtils.clamp(this.u, 0, 1);
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
  dir: number; // +1 right, -1 left
  speed: number;
  sm: { mode: number; start: number; duration: number; from: number };
  turning: number; // seconds into a 4 s stop-and-reverse, or -1
  turnTimer: number;
  phase: number;
}

interface Star {
  holder: THREE.Group;
  spin: THREE.Group;
  shadow: THREE.Object3D | null;
  glass: boolean;
  walk: PathWalker;
  dir: number;
  yaw: number;
  spinDir: number;
  arms: { mesh: THREE.Mesh; base: Float32Array; arms: { verts: number[]; axis: THREE.Vector3; diag2: number }[] } | null;
}

/** CALIBRATE: world units a sea horse moves per unit of its navigator step (6k).
 * Measured drift 15-37 px/s (26-63 units/s) with 6k/dt = 0.24..0.6 per s. */
const HORSE_GAIN = 105;

/** Scene clear colours (docs/original-logic.md 2.3): the sea horse's fog colour. */
const WATER: Record<string, number> = { "1": 0x008aff, "2": 0x00cbfd, "3": 0x036ed6 };

/** The crab's walk phase counts pose FRAMES: pose int(phase)%12+1 blended into the next. */
const CRAB_FRAMES = 12;

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
  private fish: Fish[] = [];
  private crabs: Crab[] = [];
  private stars: Star[] = [];
  private models = new Map<string, FishModel>();
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
    // Lighting, from the original (docs/original-logic.md 2.4): fish get light
    // L2 (direction (0,-1,0.2)) at full strength over a 0.667 ambient; the crab
    // and sea star L1 (straight down) over a 0.5 ambient. D3D lights in gamma
    // space and saturates at 1; three.js lights linear colour, so intensities
    // are matched at the visible flank (N.L = 0.2) and underside:
    // a -> a^2.2, a + 0.2 d -> (a + 0.2)^2.2; x PI as three's Lambert divides by PI.
    for (const s of [this.floor, this.glass]) s.add(new THREE.AmbientLight(0xffffff, 0.218 * Math.PI));
    // Fish are drawn with ambient 0xaa (0.667 -> 0.41 linear; flank 0.86 -> 0.72).
    for (const s of [this.scene, this.behind]) s.add(new THREE.AmbientLight(0xffffff, 0.41 * Math.PI));
    for (const s of [this.scene, this.behind]) {
      s.fog = this.fog;
      const l2 = new THREE.DirectionalLight(0xffffff, 1.6 * Math.PI);
      l2.position.set(0, 1, 0.2); // light travels (0,-1,0.2) in .X space = (0,-1,-0.2) here
      s.add(l2);
    }
    for (const s of [this.floor, this.glass]) {
      const l1 = new THREE.DirectionalLight(0xffffff, 0.78 * Math.PI);
      l1.position.set(0, 1, 0);
      s.add(l1);
    }
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
    for (const f of this.fish) this.spawn(f);
    const W = bbox.maxX - bbox.minX;
    for (const c of this.crabs) {
      c.walk = new PathWalker(this.data.walkPath);
      c.walk.i = Math.min(4, this.data.walkPath.length - 3);
    }
    for (const st of this.stars) {
      st.walk = new PathWalker(this.data.walkPath);
      st.walk.seek(bbox.minX + 0.85 * W);
    }
  }

  /** MSVC-style rand(): 0..32767. */
  private rand(): number {
    return Math.floor(this.random() * 32768);
  }

  private zone(mode: number): Box {
    const b = this.data!.bounds, depth = b.maxZ - b.minZ, H = b.maxY - b.minY;
    return mode === 0
      ? { ...b, minZ: b.minZ + 300, maxZ: b.maxZ - (0.5 * depth + 750) }
      : { ...b, minZ: b.minZ + 0.5 * depth + 1250, minY: b.minY + 0.25 * H };
  }

  private async model(entry: FishEntry, assetsUrl: string): Promise<FishModel> {
    let m = this.models.get(entry.slug);
    if (!m) {
      m = await loadFish(entry, assetsUrl);
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
        await this.addCrab(model, assetsUrl); // the original caps the crab and sea star at 1
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
    const f: Fish = {
      species: entry.slug,
      kind: horse ? "horse" : "fish",
      inst,
      holder,
      scale: (b.scale ?? 10) * 0.1, // (the sea horse has its own size law)
      speed: (b.speed ?? 10) * 0.1,
      aggression: (b.aggression ?? 20) * 0.1,
      behav: b.behav ?? 1,
      school: (b.school ?? 0) > 0,
      radius: model.radius,
      isLeader,
      leader,
      timeOffset: (this.rand() % 100) * 0.1,
      sa: horse ? 1 : 2,
      sm: { state: this.rand() % 3, start: 0, duration: 4 },
      mode: (this.rand() & 1) as 0 | 1,
      modeTimer: 0,
      pos: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      turnTarget: 0,
      turnStart: 0,
      turnReset: 2,
      band: [[100, 300], [200, 400], [300, 500]][this.rand() % 3] as [number, number],
      bandCycle: -1,
      steerTimer: 0,
      avoid: false,
      avoidRing: [],
      ph: 0,
      size: 1,
      front: true,
      clock: 0,
      swayPhase: 0,
      sway: null,
    };
    f.ph = f.timeOffset;
    f.modeTimer = this.rand() % 120 + 10;
    if (horse && inst) {
      inst.object.traverse((o) => {
        const m = o as THREE.Mesh;
        const dict = m.morphTargetDictionary, w = m.morphTargetInfluences;
        if (dict && w && dict.left !== undefined && dict.right !== undefined) f.sway = { w, left: dict.left, right: dict.right };
      });
    }
    this.fish.push(f);
    if (this.data) this.spawn(f);
    return f;
  }

  /** Start pose (docs/original-logic.md 3.1). */
  private spawn(f: Fish): void {
    const z = this.zone(f.mode), d = this.data!;
    f.pos.set(
      z.minX + (z.maxX - z.minX) * (this.rand() % 80 + 1) / 100,
      z.minY + (z.maxY - z.minY) * (this.rand() % 60 + 20) / 100,
      z.minZ + (z.maxZ - z.minZ) * 0.5,
    );
    f.yaw = (this.rand() % 100 + 1) * 2 * Math.PI / 100;
    f.pitch = (this.rand() % 100 + 1) * Math.PI / 400 - Math.PI / 8;
    if (f.kind === "horse") {
      // The sea horse's navigator starts from the box centre and pre-simulates
      // rand()%45+10 steps (docs 9). Approximated [inferred]: level, near the
      // centre height. Measured: horses swim level (|vy/vx| p50 0.07) at
      // screen y 186-338 in scene 1.
      f.pos.y = (z.minY + z.maxY) / 2 + (z.maxY - z.minY) * 0.1 * (this.random() * 2 - 1);
      f.pitch = 0;
    }
    const lim = 0.25 * (d.bounds.maxZ - d.bounds.minZ);
    if (Math.abs(f.pos.z) < lim) f.pos.y = Math.max(f.pos.y, this.reefLine(f.pos.x, f.pos.z, z));
    f.turnTarget = 0;
    f.turnStart = this.t;
  }

  /** The blended reef line a fish must stay above near the foreground plane. */
  private reefLine(x: number, z: number, zone: Box): number {
    const b = this.data!.bounds, lim = 0.25 * (b.maxZ - b.minZ);
    const k = Math.sin((1 - Math.min(Math.abs(z) / lim, 1)) * Math.PI / 2);
    return zone.minY + (this.data!.height(x) - zone.minY) * k;
  }

  // --- crab (docs/original-logic.md, crab spec) -----------------------------------

  private async addCrab(model: FishModel, assetsUrl: string): Promise<void> {
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
    const walk = new PathWalker(this.data.walkPath);
    walk.i = Math.min(4, this.data.walkPath.length - 3); // starts at sorted point 4
    this.crabs.push({
      inst,
      holder,
      walk,
      dir: -1, // it starts moving left
      speed: 4,
      sm: { mode: 0, start: this.t, duration: 0, from: 4 }, // first duration: uninitialised in the original [unknown] - expires at once
      turning: -1,
      turnTimer: this.rand() % 100,
      phase: 0,
    });
  }

  private updateCrab(c: Crab, dt: number): void {
    const b = this.data!.bbox, W = b.maxX - b.minX, t = this.t;
    // speed: every 2-3 s keep, ease up to 1 or ease down to 0
    if (t - c.sm.start >= c.sm.duration) {
      c.sm = { mode: this.rand() % 3, start: t, duration: this.rand() % 2 + 2, from: c.speed };
    }
    const e = ease(Math.min((t - c.sm.start) / c.sm.duration, 1));
    if (c.sm.mode === 1) c.speed = c.sm.from + (1 - c.sm.from) * e;
    else if (c.sm.mode === 2) c.speed = c.sm.from * (1 - e);
    // turns: at the ends of its stretch, and every rand()%100 s
    const here = c.walk.sample();
    c.turnTimer -= dt;
    if (c.turning < 0) {
      const atEnd = (c.dir < 0 && here.x <= b.minX + 350) || (c.dir > 0 && here.x >= b.minX + 0.7 * W - 250);
      if (atEnd || c.turnTimer <= 0) {
        c.turning = 0;
        c.turnTimer = this.rand() % 100;
      }
    }
    let k = 1;
    if (c.turning >= 0) {
      c.turning += dt;
      const u = Math.min(c.turning / 4, 1);
      k = 1 - Math.sin(u * Math.PI / 2); // 4 s ease-out stop
      if (u >= 1) {
        c.dir = -c.dir;
        c.turning = -1;
      }
    }
    const v = c.speed * k;
    if (v >= 0.05) {
      c.walk.advance(c.dir * dt * v * 0.5);
      c.phase += c.dir * 2.5 * dt * v * 0.5;
    }
    c.inst.setPhase(c.phase / CRAB_FRAMES);
    const p = c.walk.sample();
    // .X: local Z along the tangent (tilted with the floor), RotZ(-pi/10)
    const slope = Math.atan2(p.ty, p.tx);
    c.holder.position.set(p.x, p.y, -b.minZ);
    c.holder.rotation.set(0, 0, slope);
      }

  // --- sea star -------------------------------------------------------------------

  private addStar(model: FishModel): void {
    if (this.stars.length || !this.data) return;
    const b = this.data.bbox, W = b.maxX - b.minX;
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
    const walk = new PathWalker(this.data.walkPath);
    const lo = b.minX + 0.7 * W + 50, hi = b.maxX - 50;
    walk.seek(lo + (hi - lo) * this.random());
    this.stars.push({
      holder,
      spin,
      shadow,
      glass,
      walk,
      dir: this.random() < 0.5 ? -1 : 1,
      yaw: (this.rand() % 36) * 10 * Math.PI / 180,
      spinDir: this.random() < 0.5 ? -1 : 1,
      arms,
    });
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
    s.walk.advance(s.dir * 0.025 * dt);
    const p = s.walk.sample();
    const lo = b.minX + 0.7 * W + 50, hi = b.maxX - 50;
    if ((p.x < lo && s.dir < 0) || (p.x > hi && s.dir > 0)) s.dir = -s.dir;
    s.yaw += s.spinDir * 0.025 * dt;
    s.spin.rotation.y = s.yaw;
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
  // --- simulation ---------------------------------------------------------------

  private speedMachine(f: Fish, t: number): void {
    const sm = f.sm;
    if (t - sm.start >= sm.duration) {
      sm.state = this.rand() % 3;
      sm.start = t;
      sm.duration = this.rand() % 2 + 2;
    }
    const u = Math.min((t - sm.start) / sm.duration, 1), e = ease(u);
    if (sm.state === 1) f.sa = Math.max(f.sa, 15 * e);
    else if (sm.state === 2) f.sa = Math.min(f.sa, 15 * (1 - e));
  }

  private force(f: Fish, state: number, duration: number): void {
    f.sm.state = state;
    f.sm.start = this.t;
    f.sm.duration = duration;
  }

  /** Start (or keep) an eased turn toward an absolute yaw. */
  private turnToward(f: Fish, yawTarget: number): void {
    if (f.turnTarget === 0) {
      f.turnTarget = wrapAngle(yawTarget - f.yaw);
      f.turnStart = this.t;
    }
  }

  /** Avoidance sum (docs/original-logic.md 3.8), computed for all before any moves. */
  private computeAvoidance(f: Fish): void {
    f.avoid = false;
    if (f.isLeader) return;
    const fwd = this.heading(f, new THREE.Vector3());
    const probe = f.pos.clone().addScaledVector(fwd, f.radius * f.size);
    const sum = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (const c of this.fish) {
      if (c === f || c.isLeader) continue;
      let R = 3.2 * c.scale * c.radius;
      if (c.aggression > f.aggression) R *= 1.2;
      else if (c.aggression < f.aggression) R = 0;
      if (R <= 0) continue;
      const d2 = probe.distanceToSquared(c.pos);
      const w = (R * R - d2) / (R * R);
      if (w <= 0) continue;
      sum.add(tmp.subVectors(f.pos, c.pos).normalize().multiplyScalar(w));
    }
    if (sum.lengthSq() > 1e-4) this.force(f, 2, 1 + this.random() * 2);
    f.avoid = sum.lengthSq() > 0;
    if (f.avoid) {
      f.avoidRing.push(sum);
      if (f.avoidRing.length > 10) f.avoidRing.shift();
    }
  }

  private heading(f: Fish, out: THREE.Vector3, pitch = f.pitch, yaw = f.yaw): THREE.Vector3 {
    return out.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw));
  }

  private updateFish(f: Fish, dt: number): void {
    const d = this.data!, b = d.bounds, t = this.t;
    const tt = t + f.timeOffset;
    let step: number;
    if (f.kind === "horse") {
      // CSeaHorse: k = dt/(25-P); the navigator steps 6k, the horse's own clock
      // (which drives its mood timer) 2k, the sway phase k.
      const k = dt / (25 - f.sa);
      f.clock += 2 * k;
      this.speedMachine(f, f.clock);
      step = 6 * k;
      f.swayPhase += k;
    } else {
      this.speedMachine(f, t);
      step = (f.sa + 2) * f.speed * dt / 150;
    }
    const pitchPrev = f.pitch;

    // zone mode: unled fish flip on a timer; followers copy their leader
    if (f.leader) f.mode = f.leader.mode;
    else {
      f.modeTimer -= dt;
      if (f.modeTimer <= 0) {
        f.mode = (1 - f.mode) as 0 | 1;
        f.modeTimer = this.rand() % 120 + 10;
        if (f.mode === 1) f.modeTimer /= 2;
      }
    }
    const zone = this.zone(f.mode);

    // following a leader (schooling, or a trigger chasing a clown)
    if (f.leader && f.kind === "fish") {
      const L = f.leader;
      const cyc = Math.floor(t / 10);
      if (Math.floor(t) % 10 === 9 && f.bandCycle !== cyc) {
        f.band = [[100, 300], [200, 400], [300, 500]][this.rand() % 3] as [number, number];
        f.bandCycle = cyc;
      }
      const dist = f.pos.distanceTo(L.pos);
      if (dist > f.band[1] && f.sm.state !== 1) this.force(f, 1, 1);
      if (dist < f.band[0] && f.sm.state !== 2) this.force(f, 2, 1);
      f.steerTimer -= dt;
      if (f.steerTimer <= 0) {
        f.steerTimer = 0.3;
        const want = Math.atan2(-(L.pos.z - f.pos.z), L.pos.x - f.pos.x);
        const a = wrapAngle(want - f.yaw);
        // turns come in pulses, gated by the tail beat
        const g = -Math.cos(5 * tt);
        if (Math.abs(a) > 1 / 17 && ((a > 0 && g > 0.3) || (a < 0 && g < -0.3))) {
          f.turnTarget = a;
          f.turnStart = t;
        }
      }
      if (f.pos.y < L.pos.y && f.pitch < 0.4) f.pitch += step;
      if (f.pos.y > L.pos.y && f.pitch > -0.4) f.pitch -= step;
    }

    // staying in the zone: the first violated side decides
    const p = f.pos;
    let inside = true;
    if (p.y < zone.minY) {
      inside = false;
      if (f.pitch < 0.2) f.pitch += 5 * step;
    } else if (p.y > zone.maxY) {
      inside = false;
      if (f.pitch > -0.2) f.pitch -= 5 * step;
    } else if (p.x < zone.minX || p.x > zone.maxX || p.z < zone.minZ || p.z > zone.maxZ) {
      inside = false;
      const cx = (zone.minX + zone.maxX) / 2, cz = (zone.minZ + zone.maxZ) / 2;
      this.turnToward(f, Math.atan2(-(cz - p.z), cx - p.x));
    }
    if (inside && !f.leader && !f.avoid) {
      f.turnStart = t;
      f.turnTarget = 0;
    }
    f.turnReset -= dt;
    if (f.turnReset <= 0) {
      f.turnReset = 2;
      if (!f.leader) f.turnTarget = 0;
    }

    // pitch lock: in the bottom quarter of the bounds, or climbing over the reef
    const lim = 0.25 * (b.maxZ - b.minZ);
    const climbing = Math.abs(p.z) < lim && p.y < this.reefLine(p.x, p.z, zone);
    const locked = p.y < b.minY + 0.25 * (b.maxY - b.minY) || climbing;
    if (!locked && f.pitch > 0.7) f.pitch -= step;

    // avoidance: burst away along the recent average push
    const corr = p.clone();
    if (f.avoid && f.avoidRing.length) {
      this.force(f, 1, 1);
      const dir = new THREE.Vector3();
      for (const v of f.avoidRing) dir.add(v);
      dir.divideScalar(f.avoidRing.length);
      corr.addScaledVector(dir, step * 1500);
      const e = 3 * step * ease(Math.min(Math.abs(dir.y) * 4, 1)); // (ease argument [inferred])
      if (!locked && dir.y > 0 && f.pitch < 0.6) f.pitch += e;
      if (!locked && dir.y < 0 && f.pitch > -0.6) f.pitch -= e;
      if (dir.x * dir.x + dir.z * dir.z > 1e-6) {
        f.turnTarget = wrapAngle(Math.atan2(-dir.z, dir.x) - f.yaw);
        f.turnStart = Math.min(f.turnStart, t - 1);
      }
    }

    // the eased turn in progress
    if (Math.abs(f.turnTarget) > 0.1) {
      const dd = 10 * step * ease(Math.min(Math.abs(f.turnTarget), 1)) * ease(Math.min(t - f.turnStart, 1));
      const s = Math.sign(f.turnTarget);
      f.yaw += s * dd;
      f.turnTarget -= s * Math.min(dd, Math.abs(f.turnTarget));
    }

    // the foreground plane: pass it only above the reef line
    if (climbing) {
      f.pitch = Math.min(f.pitch + 7 * step, 0.9);
      if (f.front) corr.z = Math.min(corr.z, -100);
      else corr.z = Math.max(corr.z, 100);
    }
    // the sea floor: Crab_Path for fish; the sea horse keeps above 10% of its box
    corr.y = Math.max(corr.y, f.kind === "horse" ? b.minY + 0.1 * (b.maxY - b.minY) : d.floor(p.x));
    f.pitch = (pitchPrev + f.pitch) / 2;

    // move: average the corrections in, then advance along the nose
    p.add(corr).multiplyScalar(0.5);
    const zf = (b.maxZ - p.z) / (b.maxZ - b.minZ);
    const A = (f.sa + 2) / 17;
    const horse = f.kind === "horse";
    // Sea horse sway: a = 12 phase; the body yaws by cos(a)/3 and blends
    // centre->left (sin a < 0) or ->right. The doc's body yaw is cos(a)/3 - pi/2;
    // the -pi/2 must belong to a frame convention not recovered [inferred]:
    // measured, the original's horses are SIDE-ON while drifting across the
    // screen (width/height 0.42 when |vx| > 15 px/s, 0.18 when < 5 px/s); with
    // -pi/2 here they came out edge-on (0.25 / 0.41). Model +X is the snout.
    const a = 12 * f.swayPhase;
    const wobYaw = horse ? Math.cos(a) / 3 : A * Math.sin(5 * tt) / 6;
    const wobPit = horse ? 0 : -A * Math.cos(2 * tt) / 6;
    const yaw = f.yaw + wobYaw, pitch = f.pitch + wobPit;
    // Sea horse: CALIBRATE - how the navigator turns its 6k step into distance
    // is not recovered; HORSE_GAIN is fitted to its measured drift (see top).
    const dx = horse ? step * HORSE_GAIN : (zf + 0.5) * step * 1000;
    // (the horse moves along its heading, not along its swayed body)
    p.addScaledVector(this.heading(f, new THREE.Vector3(), pitch, horse ? f.yaw : yaw), dx);
    f.size = horse ? 0.6 + 0.4 * zf : f.scale * 0.8 + 0.4 * zf;
    f.ph += 2 * step;
    f.front = p.z < 0;

    if (!f.holder || !f.inst) return;
    // WORLD = Scale(s) Rz(pitch) Ry(yaw) Translate(pos) in .X row-vector order;
    // three.js (column vectors, Z mirrored) = S * T Ry Rz Sc * S.
    const drawZ = Math.max(p.z, b.minZ + 200);
    const m = f.holder.matrix;
    m.makeTranslation(p.x, p.y, drawZ)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeRotationZ(horse ? 0 : pitch)) // the sea horse stays upright
      .multiply(new THREE.Matrix4().makeScale(f.size, f.size, f.size));
    m.premultiply(Tank.MIRROR).multiply(Tank.MIRROR);
    f.holder.matrixWorldNeedsUpdate = true;
    const target = f.front ? this.scene : this.behind;
    if (f.holder.parent !== target) target.add(f.holder);
    if (!this.animate) return;
    if (f.inst.swim) f.inst.swim({ tt, ph: f.ph, sa: f.sa, speed: f.speed });
    else if (f.sway) {
      const sn = Math.sin(a);
      f.sway.w.fill(0);
      f.sway.w[f.sway.left] = Math.max(0, -sn);
      f.sway.w[f.sway.right] = Math.max(0, sn);
    }
  }

  private static readonly MIRROR = new THREE.Matrix4().makeScale(1, 1, -1);

  update(dt: number): void {
    if (!this.data || dt <= 0) return;
    this.t += dt;
    // Every 10 s each Clown Trigger (behav 2) has a 20% chance to chase the
    // nearest Percula Clown (behav 0); otherwise it swims alone.
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
    for (const f of this.fish) this.updateFish(f, dt);
  }

  /** Advance deterministically to time t (for ?t= snapshots). */
  simulateTo(t: number, step = 1 / 30): void {
    for (let s = 0; s < t; s += step) this.update(step);
  }

  /** The creatures behind the foreground painting: draw right after the background plane. */
  renderBehind(renderer: THREE.WebGLRenderer): void {
    renderer.clearDepth();
    renderer.render(this.behind, this.camera);
  }

  /** Crab and sea star, then (Z cleared) the front creatures, then a sea star on the glass. */
  renderFront(renderer: THREE.WebGLRenderer): void {
    renderer.clearDepth();
    renderer.render(this.floor, this.camera);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    if (this.stars.some((s) => s.glass)) {
      renderer.clearDepth();
      renderer.render(this.glass, this.camera);
    }
  }

  /**
   * Measurement hook (tools/track.ts comparisons): every visible creature's
   * on-screen silhouette box in pixels of a `width` x `height` view.
   */
  probe(width = 1024, height = 768): { species: string; front: boolean; x0: number; y0: number; x1: number; y1: number }[] {
    const v = new THREE.Vector3();
    const out: { species: string; front: boolean; x0: number; y0: number; x1: number; y1: number }[] = [];
    const all: [string, boolean, THREE.Object3D][] = [
      ...this.fish.filter((f) => f.holder).map((f) => [f.species, f.front, f.holder!] as [string, boolean, THREE.Object3D]),
      ...this.crabs.map((c) => ["anemone-crab", true, c.holder] as [string, boolean, THREE.Object3D]),
      ...this.stars.map((s) => ["sea-star", true, s.holder] as [string, boolean, THREE.Object3D]),
    ];
    for (const [species, front, holder] of all) {
      holder.updateMatrixWorld(true);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      holder.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.visible) return;
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
    this.crabs = [];
    this.stars = [];
    for (const s of [this.scene, this.behind, this.floor, this.glass]) {
      for (const o of [...s.children]) if (!(o instanceof THREE.Light)) s.remove(o);
    }
  }
}
