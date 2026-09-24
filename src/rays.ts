// Light rays: 9 procedural additive triangles textured with ray.dds, sweeping
// slowly across the top of the scene and flickering. Gated by the original's
// `volume` setting (it does NOT drive the sound volume); ?rays=0 = off.
//
// Algorithm from docs/original-logic.md 5.6 [read]. `ray.X` is loaded by the
// original but never used. Reference frames with <volume value="1"> show the
// shafts (tools/wine-burst.sh with LMA2_PARAMS="volume=1"; the capture scripts
// otherwise force volume=0, which is why earlier references had none).
//
// Layering (section 2.2): end of scene pass 0 - after the water surface and the
// Background plane, before the bubbles and everything in pass 1, so the
// Foreground painting and the billboards cover them. Z off.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";

const RAYS = 9;
const TILT_X = (-6 * Math.PI) / 180; // RotX(-6 deg): only shortens y by cos 6deg under the ortho camera

const VERTEX = /* glsl */ `
  attribute float grey;
  varying vec2 vUv;
  varying float vGrey;
  void main() {
    vUv = uv;
    vGrey = grey;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// ONE/ONE, colour = texture * vertex grey, on raw 8-bit values like D3D.
const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vGrey;
  void main() {
    gl_FragColor = vec4(texture2D(map, vUv).rgb * vGrey, 1.0);
  }
`;

export class Rays {
  /** Goes in the painting scene (see main.ts); renderOrder places it. */
  readonly object: THREE.Mesh;
  /** The `volume` setting. */
  enabled: boolean;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private box = new THREE.Box3();
  private ready = false;

  constructor(assetsUrl: string, enabled = true) {
    this.enabled = enabled;
    const map = new THREE.TextureLoader().load(`${assetsUrl}common/ray.png`);
    map.colorSpace = THREE.NoColorSpace;
    map.flipY = false; // v = 0 is the image's first row, as in D3D
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.generateMipmaps = false; // ray.dds has no mip levels
    map.minFilter = THREE.LinearFilter;
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const n = RAYS * 3;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute("grey", new THREE.BufferAttribute(new Float32Array(n), 1));
    // Local triangle: apex (0,0) uv (0.5,0); base (+200,-1200) uv (1,1), (-200,-1200) uv (0,1).
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < RAYS; i++) uv.set([0.5, 0, 1, 1, 0, 1], i * 6);
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.name = "rays";
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Switch scene: `box` is the scene box (scenebox.ts), in .X space. */
  setScene(box: THREE.Box3): void {
    this.box.copy(box);
    this.ready = true;
  }

  update(t: number): void {
    this.object.visible = this.enabled && this.ready;
    if (!this.object.visible) return;
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const grey = this.geometry.getAttribute("grey") as THREE.BufferAttribute;
    const { min, max } = this.box;
    const local = [[0, 0], [200, -1200], [-200, -1200]];
    const cosX = Math.cos(TILT_X);
    for (let i = 0; i < RAYS; i++) {
      const th = (i * 40 * Math.PI) / 180 + t / 55;
      const phi = 0.5 * Math.sin(th); // RotZ, radians
      const c = Math.cos(phi), s = Math.sin(phi);
      const tx = (max.x - 100) * Math.sin(th), ty = max.y + 150 - 40 * Math.cos(th);
      const g = Math.floor(51 * Math.abs(Math.cos(2 * t + th / 2))) / 255;
      local.forEach(([x, y], j) => {
        const y1 = y * cosX; // RotX: z stays 0 in, only y shrinks (z is irrelevant under ortho, Z off)
        pos.setXYZ(i * 3 + j, x * c - y1 * s + tx, x * s + y1 * c + ty, 0);
        grey.setX(i * 3 + j, g);
      });
    }
    pos.needsUpdate = true;
    grey.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.uniforms.map.value.dispose();
    this.material.dispose();
  }
}
