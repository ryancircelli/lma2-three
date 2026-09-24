// Living Marine Aquarium 2 in three.js.
//
// URL parameters:
//   ?view=tank|fish    the tank (default) or the single-species viewer
//   ?scene=1..3        tank scene
//   ?fish=<slug>       species for the fish viewer
//   ?phase=0..1        fish viewer: freeze the pose
//   ?t=<seconds>       freeze animation time (deterministic frames for diffs)
//   ?size=WxH          fixed canvas size in CSS px, e.g. 1024x768 (the original's mode)
//   ?clean=1           hide all UI and play no sound (reference comparisons)
//   ?sound=0 / ?volume=<dB>   ambient loop off / its level (see audio.ts)
//
// window.lma2 exposes load state for automated checks (agent-browser eval).

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
// @ts-types="npm:@types/three@0.186.0/examples/jsm/controls/OrbitControls.d.ts"
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type FishEntry, type FishModel, loadFish } from "./fish.ts";
import { loadScene, type SceneModel } from "./scene.ts";
import { ambience } from "./audio.ts";
import { Tank } from "./tank.ts";

interface Manifest {
  fish: FishEntry[];
  scenes: { id: string }[];
  tank: Record<string, number>;
}

interface Status {
  ready: boolean;
  view: string;
  subject: string | null;
  detail: string | null;
  error: string | null;
}

declare global {
  interface Window {
    lma2: Status;
  }
}

const ASSETS = new URL("assets/", document.baseURI).href;
const params = new URLSearchParams(location.search);
const view = params.get("view") === "fish" ? "fish" : "tank";
const frozenT = params.has("t") ? Number(params.get("t")) : null;
const frozenPhase = params.has("phase") ? Number(params.get("phase")) : null;

const status: Status = { ready: false, view, subject: null, detail: null, error: null };
window.lma2 = status;

if (params.get("clean") === "1") document.body.classList.add("clean");

// --- renderer ----------------------------------------------------------------

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const size = params.get("size")?.match(/^(\d+)x(\d+)$/);
if (size) {
  canvas.style.width = `${size[1]}px`;
  canvas.style.height = `${size[2]}px`;
}
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
// A fixed size is for pixel comparison - keep it 1:1 with CSS pixels.
renderer.setPixelRatio(size ? 1 : Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b3a52);

const info = document.querySelector<HTMLElement>("#info")!;
const panel = document.querySelector<HTMLElement>("#panel")!;

function fail(message: string): void {
  status.error = message;
  info.textContent = `Error: ${message}`;
  info.classList.add("error");
  console.error(message);
}

function done(subject: string, detail: string): void {
  Object.assign(status, { ready: true, subject, detail, error: null });
  info.textContent = detail;
  info.classList.remove("error");
}

// --- tank view ------------------------------------------------------------------

async function tankView(manifest: Manifest): Promise<(t: number) => void> {
  // Open water behind the painting is one flat colour: measured rgb(0,138,255)
  // at every open-water sample below the surface band of a reference frame.
  scene.background = new THREE.Color().setRGB(0, 138 / 255, 1, THREE.SRGBColorSpace);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  camera.position.set(0, 0, 10000); // looking down -Z = the original's +Z after the mirror
  let current: SceneModel | null = null;

  // Calibration against reference frames of the original (tools/register.ts).
  // The painted planes overscan the original's view: at 1024x768 its content
  // is ~1.8% larger than a tight fit of the planes. First measured as a
  // displacement running linearly from +7.4px (left) to -6.8px (right) and +2
  // to -6.4px (top to bottom) - the same slope in every layer, so a scale, not
  // perspective. A second pass left +0.7px/-0.6px top/bottom with x already
  // aligned: the vertical scale is ~0.28% larger than the horizontal.
  // ?zoomx= / ?zoomy= / ?dx= / ?dy= (pixels) override, for recalibration.
  const ZOOM_X = Number(params.get("zoomx") ?? 1.018);
  const ZOOM_Y = Number(params.get("zoomy") ?? 1.0209);
  const NUDGE_X = Number(params.get("dx") ?? 0);
  const NUDGE_Y = Number(params.get("dy") ?? 0.8); // + moves content down

  function fit(): void {
    if (!current) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    const f = current.frame;
    // The original's visible world extent (calibrated, not quite square pixels).
    const vw = (f.max.x - f.min.x) / ZOOM_X, vh = (f.max.y - f.min.y) / ZOOM_Y;
    let hw: number, hh: number;
    if (Math.abs(w / h - 4 / 3) < 0.01) {
      // The original's own 4:3 mode: reproduce each axis's calibration exactly.
      hw = vw / 2;
      hh = vh / 2;
    } else {
      // Any other shape: contain the view uniformly; spare room is margin.
      const pxPerUnit = Math.min(w / vw, h / vh);
      hw = w / pxPerUnit / 2;
      hh = h / pxPerUnit / 2;
    }
    const cx = (f.min.x + f.max.x) / 2 - NUDGE_X * (2 * hw / w); // camera moves opposite to content
    const cy = (f.min.y + f.max.y) / 2 + NUDGE_Y * (2 * hh / h);
    Object.assign(camera, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
    camera.updateProjectionMatrix();
    // The fish camera sees exactly this view at the painting's plane.
    tank.setView(cx, cy, hw, hh);
  }
  new ResizeObserver(fit).observe(canvas);

  const tank = new Tank();
  const nearScene = new THREE.Scene(); // billboards in front of the fish
  if (params.get("school") === "0") tank.schooling = false;
  renderer.autoClear = false;

  const select = document.createElement("select");
  for (const s of manifest.scenes) select.add(new Option(`Scene ${s.id}`, s.id));
  const label = document.createElement("label");
  label.append("Scene ", select);
  panel.append(label);
  if (params.get("clean") !== "1" && frozenT === null) ambience(ASSETS + "common/Sound_undwater.ogg", params, panel);

  async function show(id: string): Promise<void> {
    status.ready = false;
    info.textContent = `Loading scene ${id}…`;
    let model: SceneModel;
    // ?bb=<a>,<b> forces billboard frame opacities (calibration experiments).
    const bb = params.get("bb")?.split(",").map(Number);
    try {
      model = await loadScene(id, ASSETS, bb?.length === 2 ? { billboardOpacity: [bb[0], bb[1]] } : {});
    } catch (e) {
      fail(`scene ${id}: ${(e as Error).message}`);
      return;
    }
    if (current) {
      scene.remove(current.object);
      nearScene.remove(current.near);
      current.dispose();
    }
    current = model;
    scene.add(model.object);
    nearScene.add(model.near);
    await tank.setScene(id, ASSETS); // [feat/fish] fish bounds, sea floor, reef line
    fit();
    params.set("scene", id);
    history.replaceState(null, "", `?${params}`);
    done(`scene-${id}`, `Scene ${id} · ${tank.count} creatures`);
  }
  select.addEventListener("change", () => show(select.value));

  const first = manifest.scenes.find((s) => s.id === params.get("scene"))?.id ?? manifest.scenes[0].id;
  select.value = first;
  await show(first);

  // The creatures, once the view exists (spawn points are chosen on screen).
  // ?fish=0 leaves the tank empty, for backdrop comparisons.
  if (params.get("fish") !== "0") {
    try {
      // [feat/fish] ?all=1: one of every species (to check each one), else the configured tank.
      const stock = params.get("all") === "1" ? Object.fromEntries(manifest.fish.map((f) => [f.slug, 1])) : manifest.tank;
      await tank.populate(manifest.fish, stock, ASSETS);
    } catch (e) {
      fail(`fish: ${(e as Error).message}`);
    }
    if (frozenT !== null) tank.simulateTo(frozenT);
    done(`scene-${select.value}`, `Scene ${select.value} · ${tank.count} creatures`);
  }

  // [feat/fish] The original's draw order (docs/original-logic.md 2.2), one
  // orthographic camera throughout: the Background plane; creatures BEHIND the
  // foreground plane (z > 0); the rest of the painting (foreground, billboards,
  // ...); then the crab and sea star, and - depth cleared - creatures in FRONT
  // of it, over everything; a sea star on the glass last.
  const drawable = (o: THREE.Object3D) => (o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite || (o as THREE.Line).isLine;
  const paint = (background: boolean) => {
    scene.traverse((o) => {
      if (drawable(o)) o.visible = (o.name === "Background") === background;
    });
    const water = scene.background; // a colour background clears: only on the first pass
    if (!background) scene.background = null;
    renderer.render(scene, camera);
    scene.background = water;
  };
  let last = 0;
  return (t) => {
    current?.update(t);
    if (frozenT === null) tank.update(Math.min(t - last, 0.1));
    last = t;
    renderer.clear();
    paint(true);
    tank.renderBehind(renderer);
    renderer.clearDepth();
    paint(false);
    renderer.render(nearScene, camera);
    tank.renderFront(renderer);
  };
}

// --- fish view ------------------------------------------------------------------

async function fishView(manifest: Manifest): Promise<(t: number) => void> {
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // Roughly a fixed-function D3D scene of the era: strong key light from above,
  // cool and fairly bright ambient.
  scene.add(new THREE.HemisphereLight(0x9fd4ff, 0x1a3040, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(0.4, 1, 0.6);
  scene.add(key);

  new ResizeObserver(() => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }).observe(canvas);

  const select = document.createElement("select");
  const inTank = (f: FishEntry) => (manifest.tank[f.slug] ?? 0) > 0;
  const ordered = [...manifest.fish.filter(inTank), ...manifest.fish.filter((f) => !inTank(f))];
  for (const f of ordered) select.add(new Option(inTank(f) ? `${f.name} ×${manifest.tank[f.slug]}` : f.name, f.slug));
  const label = document.createElement("label");
  label.append("Fish ", select);
  panel.append(label);

  let current: FishModel | null = null;
  let token = 0;

  async function show(entry: FishEntry): Promise<void> {
    const mine = ++token;
    status.ready = false;
    info.textContent = `Loading ${entry.name}…`;
    let model: FishModel;
    try {
      model = await loadFish(entry, ASSETS);
    } catch (e) {
      fail(`${entry.name}: ${(e as Error).message}`);
      return;
    }
    if (mine !== token) return model.dispose();
    if (current) {
      scene.remove(current.object);
      current.dispose();
    }
    current = model;
    scene.add(model.object);

    const dist = model.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
    camera.position.set(dist * 0.15, dist * 0.2, dist);
    camera.near = dist / 100;
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();

    const b = entry.behaviour;
    const beh = Object.keys(b).length ? ` · speed ${b.speed} · scale ${b.scale} · school ${b.school}` : "";
    params.set("fish", entry.slug);
    history.replaceState(null, "", `?${params}`);
    done(entry.slug, `${entry.name} · ${model.kind} · ${model.triangles.toLocaleString()} tris${beh}`);
  }
  select.addEventListener("change", () => show(ordered.find((f) => f.slug === select.value)!));

  const initial = ordered.find((f) => f.slug === params.get("fish")) ?? ordered[0];
  select.value = initial.slug;
  await show(initial);

  return (t) => {
    current?.setPhase(frozenPhase ?? t);
    controls.update();
    renderer.render(scene, camera);
  };
}

// --- main -----------------------------------------------------------------------

async function main(): Promise<void> {
  const res = await fetch(ASSETS + "manifest.json");
  if (!res.ok) throw new Error(`assets/manifest.json: HTTP ${res.status} - run \`deno task extract\` first`);
  const manifest = (await res.json()) as Manifest;

  const frame = view === "fish" ? await fishView(manifest) : await tankView(manifest);
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => frame(frozenT ?? clock.getElapsedTime()));
}

main().catch((e) => fail((e as Error).message));
