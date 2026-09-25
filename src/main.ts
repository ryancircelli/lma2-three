// Living Marine Aquarium 2 in three.js.
//
// URL parameters:
//   ?view=tank|fish    the tank (default) or the single-species viewer
//   ?scene=1..3        tank scene
//   ?fish=<slug>       species for the fish viewer
//   ?phase=0..1        fish viewer: freeze the pose (a fish: one tail beat; else one cycle)
//   ?sa=0..15          fish viewer: the swimming speed state (default 5)
//   ?t=<seconds>       freeze animation time (deterministic frames for diffs)
//   ?size=WxH          fixed canvas size in CSS px, e.g. 1024x768 (the original's mode)
//   ?clean=1           hide all UI and play no sound (reference comparisons)
//   ?aa=1              MSAA on (off by default: the original has none)
//   ?tank=<slug>:<n>,...  stock only these species (the Fish picker sets it);  ?bare=1  no painting (flat water)
//   ?sound=0 / ?volume=<dB>   ambient loop off / its level, 0 = the original's (see audio.ts)
//   ?speed=0.5..4      playback speed (also the Speed selector)
//   ?aspect=fit|fill|stretch  window shape (also the View selector): 4:3 with
//                      black bars (default), zoom to cover, or stretch
//
// Keys: F or double-click toggles fullscreen (UI and cursor hide until the
// mouse moves; the display is kept awake); M toggles sound.
//
// window.lma2 exposes load state for automated checks (agent-browser eval).

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
// @ts-types="npm:@types/three@0.186.0/examples/jsm/controls/OrbitControls.d.ts"
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type FishEntry, type FishModel, loadFish } from "./fish.ts";
import { ambience } from "./audio.ts";
import { setFixedFunctionFog } from "./fixedfunction.ts";
import { fishPicker, fullTank, stockParam } from "./fishpicker.ts";
import { loadingScreen } from "./loading.ts";
import { loadScene, nextRotationScene, type SceneModel } from "./scene.ts";
import { Tank } from "./tank.ts";
import { Effects } from "./effects.ts"; // --- effects: bubbles, light rays, light motes
import { WaterSurface } from "./surface.ts"; // water surface

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
  /** Current animation time in seconds (scaled by the Speed selector). */
  time: number;
}

declare global {
  interface Window {
    lma2: Status;
    /** Drop fish food at (nx, ny) in -1..1 over the frame (tests). */
    lma2Feed?: (nx: number, ny: number) => void;
    lma2Food?: () => number;
    lma2Fed?: () => number;
    lma2Flakes?: () => { x: number; y: number }[];
    lma2Bubbles?: () => number | null;
    /** Every fish's mouth in CSS px (tests). */
    lma2Mouths?: () => { x: number; y: number }[];
  }
}

const ASSETS = new URL("assets/", document.baseURI).href;
const params = new URLSearchParams(location.search);
/** The current params as a URL query, keeping ?tank=a:1,b:2 readable. */
const query = () => `?${params}`.replace(/%3A/gi, ":").replace(/%2C/gi, ",");
const view = params.get("view") === "fish" ? "fish" : "tank";
const frozenT = params.has("t") ? Number(params.get("t")) : null;
const frozenPhase = params.has("phase") ? Number(params.get("phase")) : null;

const status: Status = { ready: false, view, subject: null, detail: null, error: null, time: 0 };
window.lma2 = status;

if (params.get("clean") === "1") document.body.classList.add("clean");
// ?saver=1: running as the Windows screensaver (screensaver/): no UI and no
// cursor, but unlike ?clean=1 it keeps sound and the per-launch random seed.
if (params.get("saver") === "1") document.body.classList.add("clean", "saver");

// The original's splash while models and textures load (loading.ts); not for
// reference captures (?clean=1), which must see the tank itself.
const loading = loadingScreen(params.get("clean") !== "1");

// --- renderer ----------------------------------------------------------------

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const size = params.get("size")?.match(/^(\d+)x(\d+)$/);
if (size) {
  canvas.style.width = `${size[1]}px`;
  canvas.style.height = `${size[2]}px`;
}
// No MSAA: the original (Direct3D 6) draws aliased edges on the fish, crab
// and sea star. ?aa=1 turns it back on (for looking, not for comparisons).
const renderer = new THREE.WebGLRenderer({ canvas, antialias: params.get("aa") === "1", preserveDrawingBuffer: true });
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
  loading.finish(); // don't hide the error behind the splash
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

  // The original always shows exactly its 4:3 frame (1024x768). On any other
  // window shape the camera stays that calibrated frame; only the rectangle it
  // is drawn into changes (aspect.ts-style modes, ?aspect= / the View selector):
  //   fit      the 4:3 frame, centred, black bars on the spare sides (default)
  //   fill     the frame scaled to cover the window, the overflow cropped
  //   stretch  the frame stretched to the window (what a monitor scaling a 4:3
  //            mode to full screen does)
  // Everything outside the frame is black, so nothing swims off into open water.
  function fit(): void {
    if (!current) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    const f = current.bounds;
    // The original's visible world extent (not quite square pixels at 1024x768).
    const vw = (f.max.x - f.min.x) / ZOOM_X, vh = (f.max.y - f.min.y) / ZOOM_Y;
    const hw = vw / 2, hh = vh / 2; // each axis's calibration, exactly
    const A = 4 / 3;
    const fw = w / h > A ? h * A : w, fh = fw / A; // the 4:3 frame fitted inside
    let rw = fw, rh = fh;
    if (aspectMode === "fill") {
      const k = Math.max(w / fw, h / fh);
      rw = fw * k;
      rh = fh * k;
    } else if (aspectMode === "stretch") {
      rw = w;
      rh = h;
    }
    frameRect.set(Math.round((w - rw) / 2), Math.round((h - rh) / 2), Math.round(rw), Math.round(rh));
    const cx = 0 - NUDGE_X * (2 * hw / rw); // eye x = 0; the camera moves opposite to content
    const cy = (f.min.y + f.max.y) / 2 + NUDGE_Y * (2 * hh / rh);
    Object.assign(camera, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
    camera.updateProjectionMatrix();
    // The fish camera sees exactly this view at the painting's plane.
    tank.setView(cx, cy, hw, hh);
    effects.setScale(rh * renderer.getPixelRatio() / (2 * hh)); // --- effects (frame px per unit)
  }
  new ResizeObserver(fit).observe(canvas);

  // ?seed=N: the creatures draw from the original's MSVC rand() seeded with N,
  // as a launch whose GetTickCount() was N would (0x412483). ?seed=time: a new
  // seed per load, the original's own behaviour - and the default for normal
  // viewing. Reference captures (?t= or ?clean=1) default to a fixed stream so
  // frames repeat; ?seed=fixed forces that stream anywhere.
  const capture = frozenT !== null || params.get("clean") === "1";
  const seedParam = params.get("seed") === "fixed" ? null : params.get("seed") ?? (capture ? null : "time");
  const tank = seedParam === null
    ? new Tank()
    : new Tank(seedParam === "time" ? Math.floor(performance.timeOrigin + performance.now()) >>> 0 : Number(seedParam) >>> 0, true);
  const nearScene = new THREE.Scene(); // billboards in front of the fish
  const effects = new Effects(ASSETS, params, nearScene); // --- effects (see effects.ts for the layering)
  if (params.get("school") === "0") tank.schooling = false;
  renderer.autoClear = false;

  // Fish food: a click in the tank drops a pinch of flakes (tank.feed). Not in
  // captures (the tank must stay the original's) or the screensaver (a click exits).
  if (!capture && params.get("saver") !== "1") {
    window.lma2Feed = (nx: number, ny: number) => tank.feed(nx, ny); // for tests
    window.lma2Food = () => tank.foodCount;
    window.lma2Fed = () => tank.fedCount;
    window.lma2Flakes = () => tank.flakes;
    window.lma2Bubbles = () => tank.bubbleX;
    window.lma2Mouths = () => {
      const out: { x: number; y: number }[] = [], c = tank.camera, f = frameRect;
      for (let i = 0; i < 200; i++) {
        const m = tank.mouthPos(i);
        if (m) out.push({ x: f.x + (m.x - c.left) / (c.right - c.left) * f.w, y: f.y + (c.top - m.y) / (c.top - c.bottom) * f.h });
      }
      return out;
    };
    feedingOwnsDoubleClick = true;
    // A click drops a pinch; holding the button keeps pouring from the cursor.
    let pour = 0, px = 0, py = 0;
    const at = (e: PointerEvent): boolean => {
      const r = canvas.getBoundingClientRect(), f = frameRect;
      const x = e.clientX - r.left - f.x, y = e.clientY - r.top - f.y;
      if (x < 0 || y < 0 || x > f.w || y > f.h) return false; // the black bars
      px = (x / f.w) * 2 - 1;
      py = 1 - (y / f.h) * 2;
      return true;
    };
    const stop = () => {
      clearInterval(pour);
      pour = 0;
    };
    let lastDown = -1e9, lastX = 0, lastY = 0;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // A double-click toggles fullscreen and takes back the first click's pinch.
      // Detected here: preventDefault below makes the browser's own dblclick unreliable.
      const now = performance.now();
      const double = now - lastDown < 400 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 16;
      lastDown = double ? -1e9 : now;
      lastX = e.clientX;
      lastY = e.clientY;
      if (double) {
        stop();
        tank.undoPinch();
        toggleFullscreen?.();
        return;
      }
      if (!at(e)) return;
      e.preventDefault(); // no text selection or drag gesture
      canvas.setPointerCapture(e.pointerId);
      tank.feed(px, py);
      stop();
      const started = performance.now();
      pour = setInterval(() => {
        if (performance.now() - started > 300) tank.feed(px, py, 1, 0.5);
      }, 140);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (pour) at(e);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(type, stop);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // touch long-press
  }

  // --- water surface (src/surface.ts): scene pass 0, just before the
  // Background (added to each scene's `back` in show()). ?surface=0 hides it
  // (baseline for comparisons).
  const surface = await WaterSurface.load(ASSETS);
  surface.object.visible = params.get("surface") !== "0";
  // --- end water surface

  const select = document.createElement("select");
  for (const s of manifest.scenes) select.add(new Option(`Scene ${s.id}`, s.id));
  const label = document.createElement("label");
  label.append("Scene ", select);
  panel.append(label);

  // View: how the 4:3 frame meets a window of another shape (see fit()).
  const aspectSelect = document.createElement("select");
  for (const [mode, text] of ASPECTS) aspectSelect.add(new Option(text, mode));
  aspectSelect.value = aspectMode;
  aspectSelect.addEventListener("change", () => {
    aspectMode = aspectSelect.value as AspectMode;
    try {
      localStorage.setItem("lma2.aspect", aspectMode);
    } catch { /* storage blocked: the URL still carries it */ }
    if (aspectMode === "fit") params.delete("aspect");
    else params.set("aspect", aspectMode);
    history.replaceState(null, "", query());
    fit();
  });
  const aspectLabel = document.createElement("label");
  aspectLabel.append("View ", aspectSelect);
  aspectLabel.title = "Fit keeps the original 4:3 picture with black bars; Fill zooms to cover and crops; Stretch fills by stretching";
  panel.append(aspectLabel);
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
      surface.object.removeFromParent(); // water surface: not the old scene's to dispose
      scene.remove(current.object);
      nearScene.remove(current.near);
      current.dispose();
    }
    await surface.setScene(id, ASSETS); // water surface
    model.back.add(surface.object); // water surface
    current = model;
    scene.background = model.clearColor;
    scene.add(model.object);
    nearScene.add(model.near);
    await tank.setScene(id, ASSETS); // [feat/fish] fish bounds, sea floor, reef line
    await effects.setScene(id, ASSETS, model); // --- effects
    tank.bubbleX = effects.bubbleColumn(); // fish food drifts in the bubble column
    fit();
    done(`scene-${id}`, `Scene ${id} · ${tank.count} creatures`);
  }
  select.addEventListener("change", () => {
    // A scene picked by hand is pinned in the URL; a rotated one is not, so a
    // reload rotates on like a relaunch of the original.
    params.set("scene", select.value);
    history.replaceState(null, "", query());
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
  // [feat/fish] ?all=1: one of every species (to check each one);
  // ?all=fill: the configured tank with at least one of every species (25);
  // ?tank=<slug>:<n>,... only these (like tools/wine-ref.sh LMA2_TANK; the
  // fish picker writes it too); else the configured tank.
  const only = params.has("tank")
    ? (params.get("tank") ?? "").split(",").map((e) => e.split(":")).filter((e) => e[0])
    : null;
  const stock: Record<string, number> = params.get("fish") === "0"
    ? {}
    : params.get("all") === "1"
    ? Object.fromEntries(manifest.fish.map((f) => [f.slug, 1]))
    : params.get("all") === "fill"
    ? fullTank(manifest.fish, manifest.tank)
    : only
    ? Object.fromEntries(only.map(([slug, n]) => [slug, Number(n ?? 1)]))
    : manifest.tank;
  if (frozenT === null) {
    fishPicker({
      panel,
      fish: manifest.fish,
      installed: manifest.tank,
      initial: stock,
      schooling: tank.schooling,
      async onApply(next, schooling) {
        tank.schooling = schooling;
        await tank.restock(manifest.fish, next, ASSETS);
        for (const k of ["all", "fish"]) params.delete(k);
        params.set("tank", stockParam(next));
        if (schooling) params.delete("school");
        else params.set("school", "0");
        history.replaceState(null, "", query());
        done(`scene-${select.value}`, `Scene ${select.value} · ${tank.count} creatures`);
      },
    });
  }
  if (params.get("fish") !== "0") {
    try {
      await tank.populate(manifest.fish, stock, ASSETS);
    } catch (e) {
      fail(`fish: ${(e as Error).message}`);
    }
    if (frozenT !== null) tank.simulateTo(frozenT);
    done(`scene-${select.value}`, `Scene ${select.value} · ${tank.count} creatures`);
  }
  loading.finish(); // fades once every model and texture has arrived
  // water surface: its diffuse is the ambient light state the previous frame
  // left (surface.ts): the Foreground's 0xFF, 0x80 after the Relief caustics,
  // then whatever the last creatures drawn set (Tank.ambientLeft).
  const caustic = params.get("caustics") !== "0";
  const causticOnFish = caustic && params.get("causticonfish") !== "0";
  const ambientLeft = () => tank.ambientLeft(caustic, causticOnFish) ?? (caustic ? 0x80 / 255 : 1);

  // [feat/fish] The original's draw order (docs/original-logic.md 2.2), one
  // orthographic camera throughout: scene pass 0 (`back`); creatures BEHIND
  // the foreground plane (z > 0); scene pass 1 (`front`: billboards,
  // Foreground, caustics); the crab and sea star; depth cleared, creatures in
  // FRONT of it, over everything; light motes; depth cleared, a sea star on
  // the glass last. Depth is cleared only where the original clears it:
  // bubbles (pass 1) write depth and so hide back creatures behind them.
  // ?bare=1: no painting and no water surface - creatures on the flat clear
  // colour, like tools/wine-ref.sh LMA2_BARE=1 (add rays=0&bubbles=0&caustics=0).
  const bare = params.get("bare") === "1";
  if (bare) setFixedFunctionFog(false); // the original fogs creatures only with the foreground on
  const paint = (pass: 0 | 1) => {
    if (current) {
      current.back.visible = pass === 0 && !bare;
      current.front.visible = pass === 1 && !bare;
    }
    const water = scene.background; // a colour background clears: only on pass 0
    if (pass === 1) scene.background = null;
    renderer.render(scene, camera);
    scene.background = water;
  };
  let last = 0;
  return (t) => {
    current?.update(t);
    effects.update(t); // --- effects
    surface.update(t); // water surface
    if (frozenT === null) tank.update(Math.min(t - last, 0.1));
    last = t;
    // Black outside the frame (letterbox/pillarbox bars), then clip to it.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    const r = frameRect, H = canvas.clientHeight; // three.js viewports count y from the bottom
    renderer.setViewport(r.x, H - r.y - r.h, r.w, r.h);
    renderer.setScissor(Math.max(r.x, 0), Math.max(H - r.y - r.h, 0), Math.min(r.w, canvas.clientWidth), Math.min(r.h, H));
    renderer.setScissorTest(true);
    renderer.clear();
    paint(0); // Z off: writes no depth
    tank.renderBehind(renderer); // Z on
    paint(1); // bubbles test/write depth; the rest of the painting does not
    tank.renderFloor(renderer); // crab, sea star (floor variant)
    renderer.clearDepth();
    tank.renderFront(renderer); // front creatures
    renderer.render(nearScene, camera); // light motes (--- effects)
    renderer.clearDepth();
    tank.renderGlass(renderer); // sea star on the glass
    surface.setAmbient(ambientLeft()); // for the NEXT frame's surface (a render-state leak in the original)
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
  let shown: THREE.Object3D | null = null;
  let animate: (t: number) => void = () => {};
  let token = 0;
  // The original's own animation per kind (docs/original-logic.md 3.10, 4.1,
  // 4.3), not a free-running whole-body morph: the fish at speed state ?sa=
  // (0..15, default 5), the sea horse at P = 7, the crab at walking speed 1.
  const sa = THREE.MathUtils.clamp(Number(params.get("sa") ?? 5), 0, 15);
  const TAIL_BEAT = 2 * Math.PI / 5; // -cos(5 tt): one beat, seconds

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
    if (current && shown) {
      scene.remove(shown);
      shown.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose()); // (an instance's own copies too)
      current.dispose();
    }
    current = model;
    if (model.kind === "swim") {
      // tail ripple, gills, fins, body bend and eyes, edited per frame on the
      // CPU as the original does (fish.ts swimDeformer); ph gains 2 step a frame
      const inst = model.instance();
      const speed = (entry.behaviour.speed ?? 10) * 0.1;
      shown = inst.object;
      animate = (t) => {
        const tt = frozenPhase !== null ? frozenPhase * TAIL_BEAT : t;
        inst.swim!({ tt, ph: 2 * (sa + 2) * speed * tt / 150, sa, speed });
      };
    } else {
      // sea horse: a = 12 k-steps, k = dt/(25 - P); crab: 2.5 * 0.5 poses per s
      // at speed 1, 12 poses a stride; phase in cycles either way
      const rate = model.kind === "sway" ? 12 / (25 - 7) / (2 * Math.PI) : model.kind === "cycle" ? 1.25 / 12 : 0;
      shown = model.object;
      animate = (t) => model.setPhase(frozenPhase ?? t * rate);
    }
    scene.add(shown);

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
    history.replaceState(null, "", query());
    done(entry.slug, `${entry.name} · ${model.kind} · ${model.triangles.toLocaleString()} tris${beh}`);
  }
  select.addEventListener("change", () => show(ordered.find((f) => f.slug === select.value)!));

  const initial = ordered.find((f) => f.slug === params.get("fish")) ?? ordered[0];
  select.value = initial.slug;
  await show(initial);
  loading.finish();

  return (t) => {
    animate(t);
    controls.update();
    renderer.render(scene, camera);
  };
}

// --- main -----------------------------------------------------------------------

const SPEEDS = [0.5, 1, 1.5, 2, 3, 4];

// --- window shape (see fit() in tankView) --------------------------------------
type AspectMode = "fit" | "fill" | "stretch";
const ASPECTS: [AspectMode, string][] = [["fit", "Fit (4:3, black bars)"], ["fill", "Fill (crop)"], ["stretch", "Stretch"]];
function loadAspect(): AspectMode {
  const q = params.get("aspect");
  if (q === "fit" || q === "fill" || q === "stretch") return q;
  try {
    const v = localStorage.getItem("lma2.aspect");
    if (v === "fit" || v === "fill" || v === "stretch") return v;
  } catch { /* storage blocked */ }
  return "fit";
}
let aspectMode: AspectMode = loadAspect();
/** The on-screen rectangle the 4:3 frame is drawn into, in CSS px from the top-left. */
const frameRect = { x: 0, y: 0, w: 1, h: 1, set(x: number, y: number, w: number, h: number) { Object.assign(this, { x, y, w, h }); } };

async function main(): Promise<void> {
  const res = await fetch(ASSETS + "manifest.json");
  if (!res.ok) throw new Error(`assets/manifest.json: HTTP ${res.status} - run \`deno task extract\` first`);
  const manifest = (await res.json()) as Manifest;

  const frame = view === "fish" ? await fishView(manifest) : await tankView(manifest);

  // Playback speed: everything runs off this one scaled clock (fish, crab, sea
  // star, plants, caustics, bubbles, rays), so slow motion stays consistent.
  let timeScale = SPEEDS.includes(Number(params.get("speed"))) ? Number(params.get("speed")) : 1;
  if (frozenT === null) {
    const select = document.createElement("select");
    for (const s of SPEEDS) select.add(new Option(`${s}\u00d7`, String(s)));
    select.value = String(timeScale);
    select.addEventListener("change", () => {
      timeScale = Number(select.value);
      if (timeScale === 1) params.delete("speed");
      else params.set("speed", select.value);
      history.replaceState(null, "", query());
    });
    const label = document.createElement("label");
    label.append("Speed ", select);
    panel.append(label);
  }

  setupFullscreen();
  addLinks();

  const clock = new THREE.Clock();
  let simT = 0;
  renderer.setAnimationLoop(() => {
    simT += clock.getDelta() * timeScale;
    status.time = frozenT ?? simT;
    frame(status.time);
  });
}

// The source, and the Windows screensaver build (screensaver/, published by
// .github/workflows/release.yml; "latest" always points at the newest release).
/** Fullscreen toggle (setupFullscreen), and whether the fish-food handler detects double-clicks itself. */
let toggleFullscreen: (() => void) | null = null;
let feedingOwnsDoubleClick = false;

const GITHUB = "https://github.com/ryancircelli/lma2-three";
const SCREENSAVER = `${GITHUB}/releases/latest/download/LMA2-Aquarium-Setup.exe`;

function addLinks(): void {
  const link = (text: string, href: string, title: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.title = title;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  };
  panel.append(
    link("Screensaver ↓", SCREENSAVER, "Download the Windows screensaver installer: run it, pick your settings, press Install"),
    link("GitHub", GITHUB, "Source code and releases"),
  );
}

// Fullscreen: a panel button, F, or double-click on the scene. While
// fullscreen, the panel, info and cursor hide after a moment without mouse
// movement, so it looks like the screensaver; moving the mouse brings them back.
function setupFullscreen(): void {
  if (!document.fullscreenEnabled) return;
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  };
  const button = document.createElement("button");
  button.type = "button";
  button.title = "Fullscreen (F or double-click)";
  button.textContent = "Fullscreen";
  button.addEventListener("click", toggle);
  panel.append(button);
  // In fullscreen the way out is its own button, top right (it hides with the panel).
  const exit = document.createElement("button");
  exit.type = "button";
  exit.id = "exitfs";
  exit.title = "Exit fullscreen (Esc, F or double-click)";
  exit.setAttribute("aria-label", "Exit fullscreen");
  exit.textContent = "\u2715";
  exit.addEventListener("click", toggle);
  document.body.append(exit);
  const render = () => {
    const full = !!document.fullscreenElement;
    button.hidden = full;
    exit.hidden = !full;
  };
  render();
  toggleFullscreen = toggle;
  canvas.addEventListener("dblclick", () => {
    if (!feedingOwnsDoubleClick) toggle();
  });
  addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "SELECT" || target?.tagName === "INPUT") return;
    if ((e.key === "f" || e.key === "F") && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) toggle();
  });

  let idle = 0;
  const wake = () => {
    document.body.classList.remove("idle");
    clearTimeout(idle);
    if (document.fullscreenElement) idle = setTimeout(() => document.body.classList.add("idle"), 2500);
  };
  addEventListener("mousemove", wake);

  // Keep the display awake while fullscreen, like a screensaver (Screen Wake
  // Lock API). The browser drops the lock whenever the tab is hidden, so it is
  // taken again when the tab comes back while still fullscreen.
  let lock: WakeLockSentinel | null = null;
  const holdAwake = async (on: boolean) => {
    if (!("wakeLock" in navigator)) return; // unsupported: the display may sleep as usual
    if (on && !lock) {
      lock = await navigator.wakeLock.request("screen").catch(() => null);
      lock?.addEventListener("release", () => (lock = null));
    } else if (!on && lock) {
      await lock.release().catch(() => {});
      lock = null;
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.fullscreenElement) void holdAwake(true);
  });

  document.addEventListener("fullscreenchange", () => {
    render();
    button.blur(); // so Space/Enter don't re-trigger it
    exit.blur();
    wake();
    void holdAwake(!!document.fullscreenElement);
  });
}

main().catch((e) => fail((e as Error).message));
