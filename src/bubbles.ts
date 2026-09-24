// Bubbles: one helical column per scene, BUBBLE.png sprites rising from the
// bottom of the scene box to above its top.
//
// The algorithm is the original's, from docs/original-logic.md 5.7 (read from
// the binary). Reference frames confirm it (tools/wine-burst.sh +
// tools/bubbletrack.ts, fish=0, caustics=0, 1024x768):
//   - column axis at x = 333 px (scenes 1, 2) and 757 px (scene 3): the
//     emitters x0 = -300 / +420 plus the mean spawn offset -5, through the camera;
//   - median rise ~50-57 px/s, tracked p10..p90 ~31..95 px/s: 40-140 units/s;
//   - no acceleration; sprites grow from ~3 px to ~6 px as they rise;
//   - no fade; they leave through the top of the screen;
//   - plain alpha blending (over scene 3's dark water a bubble pixel is darker
//     in blue than the water: rgb(48,129,205) over (3,110,214));
//   - `<bubles value="0">` removes them, and so does `<foreground value="0">`.
//
// Layering (section 2.2): drawn FIRST in scene pass 1, after the pass-0
// Background plane and light rays, so the Foreground painting and every
// billboard cover them. Z test and write are on (only matters among bubbles
// here, and against back creatures in the original).

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { msvcRand } from "./scenebox.ts";

/** Emitter x per scene, world units [read]. */
const EMITTER_X: Record<string, number> = { "1": -300, "2": -300, "3": 420 };
const COUNT = 500; // particles [read]
const PRESIM = 10; // s simulated at init [read]
const Z = 1000; // world z of the column (.X space, behind the Foreground plane at 0) [read]
const QUAD = 10.2; // quad size, world units [read]

/** One life of one particle, from spawn to passing the top of the box. */
interface Life {
  start: number; // s
  duration: number; // s
  x: number; // world
  speed: number; // 80..279; rises at 0.5*speed units/s
  size: number; // 0.8..1.16
  radius: number; // helix radius: 5, or 30..49
  spin: number; // +1 / -1
  phase: number; // 2pi/(rand%10): Infinity for 10% - never visible
}

interface Particle {
  rand: () => number;
  life: Life;
}

const VERTEX = /* glsl */ `
  attribute float size;
  uniform float pxPerWorld;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * pxPerWorld;
  }
`;

// Colour = texture, alpha = texture alpha, blended SRCALPHA/INVSRCALPHA on the
// raw 8-bit values as Direct3D did: the texture is sampled without sRGB
// decoding and written without encoding. gl_PointCoord has v = 0 at the top;
// with the texture flipped on upload the sprite's bottom-row highlight lands
// on top, which is how the reference draws it.
const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  void main() {
    gl_FragColor = texture2D(map, gl_PointCoord);
  }
`;

/** One sprite to draw: centre (.X space), quad side (world units). */
export interface BubbleSprite {
  x: number;
  y: number;
  z: number;
  size: number;
}

/**
 * The particle system alone - no three.js objects, so tools/fxsim.ts can run
 * exactly this code against reference frames. Deterministic: the state at t
 * depends only on the scene and t.
 */
export class BubbleSim {
  private particles: Particle[] = [];
  private box = new THREE.Box3();
  private x0 = 0;
  private seed = 0;
  private lastT = -Infinity;

  setScene(id: string, box: THREE.Box3): void {
    this.box.copy(box);
    this.x0 = EMITTER_X[id] ?? -300;
    this.seed = Number(id) || 0;
    this.spawnAll();
  }

  get count(): number {
    return this.particles.length;
  }

  /** Re-create every particle from its seed, first life starting (at the
   * bottom) PRESIM s before t = 0. */
  private spawnAll(): void {
    this.particles = [];
    for (let i = 0; i < COUNT; i++) {
      const rand = msvcRand((this.seed * 0x9e3779b1 + i * 0x85ebca6b + 1) >>> 0);
      this.particles.push({ rand, life: this.respawn(rand, -PRESIM) });
    }
    this.lastT = -Infinity;
  }

  private respawn(rand: () => number, start: number): Life {
    const x = this.x0 - 50 + 10 * (rand() % 10);
    const speed = 80 + (rand() % 200);
    const size = 0.8 + 0.04 * (rand() % 10);
    const radius = rand() % 10 < 7 ? 5 : 30 + (rand() % 20); // 70% / 30%
    const spin = rand() & 1 ? 1 : -1;
    const phase = (2 * Math.PI) / (rand() % 10);
    // Respawns once min.y + rise passes max.y.
    const duration = (this.box.max.y - this.box.min.y) / (0.5 * speed);
    return { start, duration, x, speed, size, radius, spin, phase };
  }

  /** Every sprite at time t, in draw order. */
  sprites(t: number, out: (s: BubbleSprite) => void): void {
    if (t < this.lastT) this.spawnAll();
    this.lastT = t;
    const { min, max } = this.box;
    const H = max.y - min.y;
    for (const p of this.particles) {
      while (t >= p.life.start + p.life.duration) p.life = this.respawn(p.rand, p.life.start + p.life.duration);
      const L = p.life;
      const rise = 0.5 * L.speed * (t - L.start);
      const y = min.y + rise;
      const copies = L.radius >= 10 ? 3 : 1;
      for (let k = 0; k < copies; k++) {
        const a = L.spin * 0.05 * (rise + L.phase - 0.2 * k * L.speed);
        if (!Number.isFinite(a)) continue; // phase = 2pi/0: no position in the original - never seen
        const scale = (L.size * (3 - k)) / 6 + (0.5 * (y - min.y)) / H;
        // The quad is anchored at its bottom edge; report its centre.
        out({ x: L.x + L.radius * Math.cos(a), y: y + (QUAD * scale) / 2, z: Z + L.radius * Math.sin(a), size: QUAD * scale });
      }
    }
  }
}

export class Bubbles {
  /** Goes in the painting scene (see effects.ts); renderOrder places it. */
  readonly object: THREE.Points;
  /** The `bubles` setting (?bubbles=0 = off). */
  enabled: boolean;
  private readonly sim = new BubbleSim();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  constructor(assetsUrl: string, enabled = true) {
    this.enabled = enabled;
    const map = new THREE.TextureLoader().load(`${assetsUrl}common/BUBBLE.png`);
    map.colorSpace = THREE.NoColorSpace; // raw values, like D3D
    // BUBBLE.dds has no mip levels, so the original's trilinear filter is
    // plain bilinear on it.
    map.generateMipmaps = false;
    map.minFilter = THREE.LinearFilter;
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, pxPerWorld: { value: 1 } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: true,
    });
    const n = COUNT * 3; // up to 3 trailing copies each
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.name = "bubbles";
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Switch scene: `box` is the scene box (scenebox.ts), in .X space. */
  setScene(id: string, box: THREE.Box3): void {
    this.sim.setScene(id, box);
  }

  /** Drawing-buffer pixels per world unit (the painting camera's scale). */
  setScale(pxPerWorld: number): void {
    this.material.uniforms.pxPerWorld.value = pxPerWorld;
  }

  update(t: number): void {
    this.object.visible = this.enabled && this.sim.count > 0;
    if (!this.object.visible) return;
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const size = this.geometry.getAttribute("size") as THREE.BufferAttribute;
    let v = 0;
    this.sim.sprites(t, (s) => {
      pos.setXYZ(v, s.x, s.y, -s.z); // .X space is mirrored into three.js
      size.setX(v++, s.size);
    });
    this.geometry.setDrawRange(0, v);
    pos.needsUpdate = true;
    size.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.uniforms.map.value.dispose();
    this.material.dispose();
  }
}
