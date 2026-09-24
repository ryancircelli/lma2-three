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
import { ambience } from "./audio.ts";
import { loadScene, nextRotationScene, type SceneModel } from "./scene.ts";
import { Tank } from "./tank.ts";
import { Effects } from "./effects.ts"; // --- effects: bubbles, light rays, light motes

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
  // Open water behind the painting is one flat colour per scene (scene.ts
  // CLEAR_COLOR); set in show().
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  camera.position.set(0, 0, 10000); // looking down -Z = the original's +Z after the mirror
  let current: SceneModel | null = null;

  // Camera, as the original sets it up (recovered from its code, then verified
  // per scene against reference frames with tools/register.ts): an orthographic
  // box over the X/Y extent of EVERY vertex in the scene's mesh.X (W x H - the
  // Relief, billboards and `height` data included, not just the painted
  // planes), shrunk to 98%: OrthoLH(W*0.98, H*0.98), looking from x = 0 (NOT
  // the box's centre) and y = the box's centre. The zoom therefore differs per
  // scene in x, because the Relief overhangs the painted planes by a different
  // amount in each (vs a tight fit of the planes: 1.0180 / 1.0166 / 1.0200).
  // History: scene 1 was first fitted empirically (1.018 x 1.0209 over the
  // planes) - this model reproduces that to 0.05% and also fits scenes 2-3,
  // where scene 1's constants left a 1.2-1.5px linear x error.
  // NUDGE: the residual whole-picture offset after that, measured with
  // register.ts on all three scenes (the same in each): the original's content
  // sits 0.5px right and 0.5px lower than a GL render of the same matrices.
  // Probably the D3D pixel-centre convention (inferred, not proven).
  // ?zoomx= / ?zoomy= (divisors of the bbox, default 1/0.98) and ?dx= / ?dy=
  // (pixels) override, for recalibration.
  const ZOOM_X = Number(params.get("zoomx") ?? 1 / 0.98);
  const ZOOM_Y = Number(params.get("zoomy") ?? 1 / 0.98);
  const NUDGE_X = Number(params.get("dx") ?? 0.5); // + moves content right
  const NUDGE_Y = Number(params.get("dy") ?? 0.5); // + moves content down

  function fit(): void {
    if (!current) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    const f = current.bounds;
    // The original's visible world extent (not quite square pixels at 1024x768).
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
    const cx = 0 - NUDGE_X * (2 * hw / w); // eye x = 0; the camera moves opposite to content
    const cy = (f.min.y + f.max.y) / 2 + NUDGE_Y * (2 * hh / h);
    Object.assign(camera, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
    camera.updateProjectionMatrix();
    // The fish camera sees exactly this view at the painting's plane.
    tank.setView(cx, cy, hw, hh);
    effects.setScale(renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * hh)); // --- effects
  }
  new ResizeObserver(fit).observe(canvas);

  const tank = new Tank();
  const nearScene = new THREE.Scene(); // billboards in front of the fish
  const effects = new Effects(ASSETS, params, nearScene); // --- effects (see effects.ts for the layering)
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
    scene.background = model.clearColor;
    scene.add(model.object);
    nearScene.add(model.near);
    await effects.setScene(id, ASSETS, model); // --- effects
    fit();
    done(`scene-${id}`, `Scene ${id} · ${tank.count} creatures`);
  }
  select.addEventListener("change", () => {
    // A scene picked by hand is pinned in the URL; a rotated one is not, so a
    // reload rotates on like a relaunch of the original.
    params.set("scene", select.value);
    history.replaceState(null, "", `?${params}`);
    show(select.value);
  });

  // ?scene=N pins a scene (calibration relies on it); otherwise rotate once
  // per page load, as the original does once per launch (scene.ts).
  const first = manifest.scenes.find((s) => s.id === params.get("scene"))?.id ??
    nextRotationScene(manifest.scenes.map((s) => s.id));
  select.value = first;
  await show(first);

  // The creatures, once the view exists (spawn points are chosen on screen).
  // ?fish=0 leaves the tank empty, for backdrop comparisons.
  if (params.get("fish") !== "0") {
    try {
      await tank.populate(manifest.fish, manifest.tank, ASSETS);
    } catch (e) {
      fail(`fish: ${(e as Error).message}`);
    }
    if (frozenT !== null) tank.simulateTo(frozenT);
    done(`scene-${select.value}`, `Scene ${select.value} · ${tank.count} creatures`);
  }

  // Three passes, because the original composites two projections: the flat
  // painting (orthographic), the 3D creatures (perspective) in front of it, and
  // the near billboards (orthographic again) in front of the creatures.
  let last = 0;
  return (t) => {
    current?.update(t);
    effects.update(t); // --- effects
    if (frozenT === null) tank.update(Math.min(t - last, 0.1));
    last = t;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(tank.scene, tank.camera);
    renderer.clearDepth();
    renderer.render(nearScene, camera);
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
