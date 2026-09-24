// Light motes: up to 40 soft light.dds sprites drifting slowly through the
// front half of the scene, twinkling, fogged toward pale blue. Always on in the
// original (no setting); ?motes=0 = off here.
//
// Algorithm from docs/original-logic.md 5.8 [read]. Reference frames (all
// painting layers off, so only the motes move: tools/wine-burst.sh with
// LMA2_PARAMS="foreground=0 background=0") agree: 3-6 px specks drifting in
// straight lines at 3-23 px/s, 11-14 visible at once, alternating between a
// pale-blue/white state and a fainter green-tinted one from frame to frame
// (e.g. rgb(165,214,254) <-> (97,216,191) over scene 1's rgb(0,138,255)).
//
// Layering (section 2.2): the very last thing drawn (after the front
// creatures), so in front of everything here.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { msvcRand } from "./scenebox.ts";

const MAX = 40;
const MIN = 10; // below this, one spawns per frame (starting at u = 0.2)
const QUAD = 10.2;
const FOG_END = 3500; // linear fog 0..3500 in eye space
const FOG_COLOUR = [0x99 / 255, 0xd0 / 255, 0xfe / 255];
const EYE_BACK = 2000; // the camera eye is at bbox.min.z - 2000 (section 1)
const STEP = 1 / 60; // fixed simulation step: the same motes for any frame rate or ?t=

interface Mote {
  id: number;
  a: THREE.Vector3; // .X space
  b: THREE.Vector3;
  u: number; // 0..1 along a -> b; dies at 1
  rate: number; // du/dt = 0.02 * spd, spd 1.0..1.9 (26-50 s lives)
  size: number; // 0.5..0.95 of the quad
}

const VERTEX = /* glsl */ `
  attribute float size;
  attribute vec4 tint; // rgb: TFACTOR colour (white or black), a: fade alpha
  attribute float fog; // D3D fog factor: 1 = no fog
  uniform float pxPerWorld;
  varying vec4 vTint;
  varying float vFog;
  void main() {
    vTint = tint;
    vFog = fog;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * pxPerWorld;
  }
`;

// Colour = texture + TFACTOR, alpha = texture * TFACTOR.a, then vertex fog,
// SRCALPHA/INVSRCALPHA - on raw 8-bit values like D3D.
const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 fogColour;
  varying vec4 vTint;
  varying float vFog;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    vec3 rgb = min(tex.rgb + vTint.rgb, 1.0);
    gl_FragColor = vec4(mix(fogColour, rgb, vFog), tex.a * vTint.a);
  }
`;

/** Stable 0/1 per (mote, frame): the twinkle, reproducible for a frozen ?t=. */
function coin(id: number, frame: number): boolean {
  let h = Math.imul(id ^ 0x5bd1e995, 0x27d4eb2d) ^ Math.imul(frame, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h & 1) === 1;
}

/** One mote to draw, in .X space. */
export interface MoteSprite {
  x: number;
  y: number;
  z: number;
  size: number; // quad side, world units
  white: boolean; // TFACTOR white this frame (twinkle)
  alpha: number; // TFACTOR alpha: fade in / flicker / fade out
  fog: number; // D3D fog factor, 1 = none
}

/**
 * The mote system alone - no three.js objects, so it can be checked offline.
 * Advanced in fixed steps, so the state at t is the same for any frame rate
 * or a frozen ?t=.
 */
export class MoteSim {
  private box = new THREE.Box3();
  private motes: Mote[] = [];
  private rand = msvcRand(1);
  private seed = 0;
  private nextId = 0;
  private simT = 0; // simulated up to here
  private nextSpawn = 0; // timer spawns (once there are MIN)
  ready = false;

  setScene(id: string, box: THREE.Box3): void {
    this.box.copy(box);
    this.seed = Number(id) || 0;
    this.ready = true;
    this.reset();
  }

  private reset(): void {
    this.rand = msvcRand((0x51ed27 + this.seed * 7919) >>> 0);
    this.motes = [];
    this.nextId = 0;
    this.simT = 0;
    this.nextSpawn = 0;
  }

  /** A random point of the mote box on a NINTHS grid, 0..1 inclusive
   * ((rand()%10) * 0.11111111 at 0x406e10, constant 0x4588b4): x across the
   * full width, y from min.y + 0.2H to max.y, z in the front half. */
  private point(): THREE.Vector3 {
    const { min, max } = this.box;
    const f = () => (this.rand() % 10) * 0.11111111;
    const H = max.y - min.y, D = max.z - min.z;
    return new THREE.Vector3(min.x + f() * (max.x - min.x), min.y + 0.2 * H + f() * 0.8 * H, min.z + f() * 0.5 * D);
  }

  /** 0x406e10, in its rand() order: start point, end point, size, speed. */
  private spawn(u: number): void {
    const a = this.point(), b = this.point();
    const size = 0.5 + 0.05 * (this.rand() % 10);
    const spd = 1 + 0.1 * (this.rand() % 10);
    this.motes.push({ id: this.nextId++, a, b, u, rate: 0.02 * spd, size });
  }

  private step(dt: number): void {
    for (const m of this.motes) m.u += dt * m.rate;
    this.motes = this.motes.filter((m) => m.u < 1);
    if (this.motes.length < MIN) {
      this.spawn(0.2); // one per frame while fewer than 10
      this.nextSpawn = this.simT + (this.rand() % 5);
    } else if (this.simT >= this.nextSpawn) {
      if (this.motes.length < MAX) this.spawn(0);
      this.nextSpawn = this.simT + (this.rand() % 5);
    }
    this.simT += dt;
  }

  /** Every live mote at time t. */
  sprites(t: number, out: (s: MoteSprite) => void): void {
    if (!this.ready) return;
    if (t < this.simT - STEP) this.reset();
    while (this.simT + STEP <= t) this.step(STEP);
    const eyeZ = this.box.min.z - EYE_BACK;
    const frame = Math.floor(t * 60);
    const p = new THREE.Vector3();
    for (const m of this.motes) {
      p.lerpVectors(m.a, m.b, m.u);
      const alpha = m.u < 0.1 ? m.u / 0.1 : m.u > 0.9 ? (1 - m.u) / 0.1 : 0.9 + 0.1 * Math.abs(Math.sin(100 * m.u));
      out({
        x: p.x,
        y: p.y,
        z: p.z,
        size: QUAD * m.size,
        white: coin(m.id, frame), // TFACTOR white on a random half of frames, else black
        alpha,
        fog: THREE.MathUtils.clamp((FOG_END - (p.z - eyeZ)) / FOG_END, 0, 1),
      });
    }
  }
}

export class Motes {
  /** Goes in the pass after the creatures (effects.ts). */
  readonly object: THREE.Points;
  enabled: boolean;
  private readonly sim = new MoteSim();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  constructor(assetsUrl: string, enabled = true) {
    this.enabled = enabled;
    const map = new THREE.TextureLoader().load(`${assetsUrl}common/light.png`);
    map.colorSpace = THREE.NoColorSpace;
    map.generateMipmaps = false; // light.dds has no mip levels
    map.minFilter = THREE.LinearFilter;
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, pxPerWorld: { value: 1 }, fogColour: { value: new THREE.Vector3(...FOG_COLOUR) } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    this.geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(MAX), 1));
    this.geometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(MAX * 4), 4));
    this.geometry.setAttribute("fog", new THREE.BufferAttribute(new Float32Array(MAX), 1));
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.name = "motes";
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Switch scene: `box` is the scene box (scenebox.ts), in .X space. */
  setScene(id: string, box: THREE.Box3): void {
    this.sim.setScene(id, box);
  }

  /** Drawing-buffer pixels per world unit (the camera's scale). */
  setScale(pxPerWorld: number): void {
    this.material.uniforms.pxPerWorld.value = pxPerWorld;
  }

  update(t: number): void {
    this.object.visible = this.enabled && this.sim.ready;
    if (!this.object.visible) return;
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const size = this.geometry.getAttribute("size") as THREE.BufferAttribute;
    const tint = this.geometry.getAttribute("tint") as THREE.BufferAttribute;
    const fog = this.geometry.getAttribute("fog") as THREE.BufferAttribute;
    let i = 0;
    this.sim.sprites(t, (s) => {
      pos.setXYZ(i, s.x, s.y, -s.z); // .X space mirrored into three.js (this scene has no mirroring root)
      size.setX(i, s.size);
      const w = s.white ? 1 : 0;
      tint.setXYZW(i, w, w, w, s.alpha);
      fog.setX(i++, s.fog);
    });
    this.geometry.setDrawRange(0, i);
    for (const a of [pos, size, tint, fog]) a.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.uniforms.map.value.dispose();
    this.material.dispose();
  }
}
