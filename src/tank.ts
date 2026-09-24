// The living part of the tank: fish, crab and sea star, in a perspective volume
// in front of the painted (orthographic) reef.
//
// What is and is not from the original:
//   - models, textures, fin/sway/walk poses, per-species `speed`, `scale` and
//     `school` values, and which fish are in the tank: from the data.
//   - that fish are in PERSPECTIVE while the painting is flat: from reference
//     frames (distant fish are tiny, near ones large, some seen head-on).
//   - everything about MOTION below - steering, schooling, speeds, sizes, the
//     body wiggle - is re-created. The original computes it in compiled code.
//     Constants are marked CALIBRATE: first guesses, to be fitted against
//     reference frame sequences (tools/wine-ref.sh sequence).

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { type FishEntry, type FishInstance, type FishModel, loadFish } from "./fish.ts";

// --- CALIBRATE ---------------------------------------------------------------
/** Camera distance in front of the painting's plane (three.js z=0). Sets how
 * strongly depth changes apparent size: near fish ~1.9x, far ~1.04x. */
const CAMERA_DISTANCE = 3600;
/** Swim depth range, three.js z: in front of the painting (0), behind the near
 * billboards (~1960). */
const DEPTH_MIN = 150, DEPTH_MAX = 1700;
/** Where fish may head, as NDC y (1 = top). Reference fish span ~115-400px of 768. */
const NDC_Y_MIN = -0.08, NDC_Y_MAX = 0.72;
/** Fish length in world units = behaviour.scale * this. */
const SIZE_PER_SCALE = 18;
/** Cruise speed in world units/s = behaviour.speed * this. */
const SPEED_PER_UNIT = 6;
/** Fin flaps per second at cruise speed. */
const FLAP_HZ = 1.4;
/** Body wiggle (radians of yaw) - there is no tail beat in the data. */
const WIGGLE = 0.07;
/** Steering responsiveness, 1/s. */
const TURN_RATE = 1.2;
// ------------------------------------------------------------------------------

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

interface Swimmer {
  species: string;
  inst: FishInstance;
  /** Positioned and oriented in the tank. */
  holder: THREE.Group;
  /** Inside the holder: sized, and wiggled for the body motion. */
  pivot: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  retargetIn: number;
  cruise: number;
  length: number;
  school: boolean;
  phase: number;
}

interface Walker {
  inst: FishInstance;
  holder: THREE.Group;
  x: number;
  dir: number;
  phase: number;
  speed: number;
}

export class Tank {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 4 / 3, 10, 20000);
  private swimmers: Swimmer[] = [];
  private walkers: Walker[] = [];
  private models = new Map<string, FishModel>();
  private random = rng(20260923);
  private view = { cx: 0, cy: 0, hw: 1, hh: 1 };
  schooling = true;

  constructor() {
    // Lighting for the 3D creatures only; the painting is unlit.
    this.scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x2a4a5a, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(0.3, 1, 0.5);
    this.scene.add(key);
  }

  /** Match the painting's orthographic view at the painting's plane (z=0). */
  setView(cx: number, cy: number, hw: number, hh: number): void {
    this.view = { cx, cy, hw, hh };
    const c = this.camera;
    c.position.set(cx, cy, CAMERA_DISTANCE);
    c.lookAt(cx, cy, 0);
    c.fov = THREE.MathUtils.radToDeg(2 * Math.atan(hh / CAMERA_DISTANCE));
    c.aspect = hw / hh;
    c.updateProjectionMatrix();
  }

  /** World point at NDC (x, y) and depth z. */
  private at(ndcX: number, ndcY: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const s = (CAMERA_DISTANCE - z) / CAMERA_DISTANCE; // frustum shrinks toward the camera
    return out.set(this.view.cx + ndcX * this.view.hw * s, this.view.cy + ndcY * this.view.hh * s, z);
  }

  private randomTarget(out: THREE.Vector3): THREE.Vector3 {
    const r = this.random;
    return this.at(-1.15 + 2.3 * r(), NDC_Y_MIN + (NDC_Y_MAX - NDC_Y_MIN) * r(), DEPTH_MIN + (DEPTH_MAX - DEPTH_MIN) * r(), out);
  }

  private async model(entry: FishEntry, assetsUrl: string): Promise<FishModel> {
    let m = this.models.get(entry.slug);
    if (!m) {
      m = await loadFish(entry, assetsUrl);
      this.models.set(entry.slug, m);
    }
    return m;
  }

  /** Add every creature in the tank config: tank[slug] = count. */
  async populate(fish: FishEntry[], tank: Record<string, number>, assetsUrl: string): Promise<void> {
    for (const entry of fish) {
      const count = tank[entry.slug] ?? 0;
      if (!count) continue;
      const model = await this.model(entry, assetsUrl);
      for (let i = 0; i < count; i++) {
        if (model.kind === "cycle") this.addWalker(model);
        else if (model.kind === "static") this.addResting(model);
        else this.addSwimmer(entry, model);
      }
    }
  }

  private addSwimmer(entry: FishEntry, model: FishModel): void {
    const b = entry.behaviour;
    const inst = model.instance();
    const pivot = new THREE.Group();
    const length = (b.scale ?? 6) * SIZE_PER_SCALE;
    pivot.scale.setScalar(length / model.length);
    pivot.add(inst.object);
    const holder = new THREE.Group();
    holder.add(pivot);
    this.scene.add(holder);
    const pos = this.randomTarget(new THREE.Vector3());
    const heading = this.random() < 0.5 ? -1 : 1;
    const cruise = (b.speed ?? 10) * SPEED_PER_UNIT;
    this.swimmers.push({
      species: entry.slug,
      inst,
      holder,
      pivot,
      pos,
      vel: new THREE.Vector3(heading * cruise, 0, 0),
      target: this.randomTarget(new THREE.Vector3()),
      retargetIn: 4 + 8 * this.random(),
      cruise: cruise * (0.85 + 0.3 * this.random()),
      length,
      school: (b.school ?? 0) > 0,
      phase: this.random(),
    });
  }

  /** The crab walks the sand near the front, sideways, as crabs do. */
  private addWalker(model: FishModel): void {
    const inst = model.instance();
    const holder = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.scale.setScalar(110 / model.length); // CALIBRATE: ~90px wide in the reference
    pivot.add(inst.object);
    holder.add(pivot);
    this.scene.add(holder);
    this.walkers.push({ inst, holder, x: -0.6, dir: 1, phase: 0, speed: 0.035 }); // speed: NDC/s, CALIBRATE
  }

  /** The sea star lies on the sand, bottom right in the reference. */
  private addResting(model: FishModel): void {
    const inst = model.instance();
    const holder = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.scale.setScalar(120 / model.length); // CALIBRATE
    pivot.rotation.x = 0.45; // CALIBRATE: seen from a shallow angle above in the reference
    pivot.add(inst.object);
    holder.add(pivot);
    holder.position.copy(this.at(0.62, -0.85, 1200));
    this.scene.add(holder);
    this.resting++;
  }
  private resting = 0;

  private static readonly UP = new THREE.Vector3(0, 1, 0);

  update(dt: number): void {
    const tmp = new THREE.Vector3(), desired = new THREE.Vector3();
    const centre = new THREE.Vector3(), align = new THREE.Vector3(), push = new THREE.Vector3();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const fwd = new THREE.Vector3(), up = new THREE.Vector3(), side = new THREE.Vector3();

    for (const f of this.swimmers) {
      f.retargetIn -= dt;
      if (f.retargetIn <= 0 || f.pos.distanceTo(f.target) < f.length) {
        this.randomTarget(f.target);
        f.retargetIn = 5 + 9 * this.random();
      }
      desired.subVectors(f.target, f.pos).normalize().multiplyScalar(f.cruise);

      // Schooling (boids): cohesion + alignment with the same species.
      centre.set(0, 0, 0);
      align.set(0, 0, 0);
      push.set(0, 0, 0);
      let mates = 0;
      for (const o of this.swimmers) {
        if (o === f) continue;
        const d = f.pos.distanceTo(o.pos);
        const sep = (f.length + o.length) * 0.9;
        if (d < sep && d > 0) push.add(tmp.subVectors(f.pos, o.pos).multiplyScalar((sep - d) / (d * sep)));
        if (this.schooling && f.school && o.species === f.species && d < 450) {
          centre.add(o.pos);
          align.add(o.vel);
          mates++;
        }
      }
      if (mates) {
        // CALIBRATE: a loose school. At 0.35/0.8 all five clownfish balled up;
        // the reference shows the species spread across the tank.
        centre.divideScalar(mates).sub(f.pos).multiplyScalar(0.12);
        align.divideScalar(mates).multiplyScalar(0.45);
        desired.multiplyScalar(0.75).add(centre).add(align);
      }
      desired.add(push.multiplyScalar(f.cruise * 2));
      // Fish swim mostly level: cap the climb/dive component.
      const cap = 0.3 * desired.length();
      desired.y = THREE.MathUtils.clamp(desired.y, -cap, cap);
      desired.setLength(f.cruise);

      f.vel.lerp(desired, 1 - Math.exp(-TURN_RATE * dt));
      f.pos.addScaledVector(f.vel, dt);
      f.holder.position.copy(f.pos);

      // Orientation: head (+X) along velocity, belly down.
      fwd.copy(f.vel).normalize();
      up.copy(Tank.UP).addScaledVector(fwd, -Tank.UP.dot(fwd)).normalize();
      side.crossVectors(fwd, up);
      m.makeBasis(fwd, up, side);
      q.setFromRotationMatrix(m);
      f.holder.quaternion.slerp(q, 1 - Math.exp(-6 * dt));

      // Fins flap with effort; the body wiggles in step (no tail beat in the data).
      const speedNow = f.vel.length();
      f.phase += dt * FLAP_HZ * (0.6 + 0.6 * speedNow / f.cruise);
      f.inst.setPhase(f.phase);
      f.pivot.rotation.y = WIGGLE * Math.sin(f.phase * Math.PI * 2);
    }

    for (const w of this.walkers) {
      w.x += w.dir * w.speed * dt;
      if (w.x > 0.85 || w.x < -0.85) w.dir *= -1;
      w.phase += dt * 0.6; // CALIBRATE: strides/s
      w.inst.setPhase(w.phase);
      w.holder.position.copy(this.at(w.x, -0.82, 1300));
    }
  }

  /** Advance deterministically to time t (for ?t= snapshots). */
  simulateTo(t: number, step = 1 / 30): void {
    for (let s = 0; s < t; s += step) this.update(step);
  }

  get count(): number {
    return this.swimmers.length + this.walkers.length + this.resting;
  }

  dispose(): void {
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
    this.swimmers = [];
    this.walkers = [];
    this.scene.clear();
  }
}
