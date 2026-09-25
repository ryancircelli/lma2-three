// The soundtrack: the original has exactly one sound, Sound_undwater.ogg (an
// ~8 s bubbling/ambience loop), played on repeat while the tank runs.
//
// Played through Web Audio rather than <audio loop>, which leaves an audible gap
// at the loop point. Browsers only allow sound after a user gesture, so the
// context starts on the first click or key press. The panel's Volume slider
// runs from silent to the original's own level (100%); it starts at 50% and
// is remembered per browser. M mutes / restores, as in the windowed launcher.
//
//   ?sound=0        no audio at all
//   ?volume=<dB>    level relative to the original (0 = original, -12 = quieter);
//                   overrides the remembered slider. The Windows screensaver
//                   passes its Volume setting this way.

// Remembered per browser. A new key: earlier builds stored 0-100 at a 100% default
// and a separate mute flag, which no longer exists.
const VOLUME_KEY = "lma2.volume2";
const DEFAULT = 50;

// Slider percent <-> gain. A squared curve, so equal slider steps sound like
// roughly equal loudness steps: 100% = the original level, 50% = -12 dB.
const gainOf = (percent: number) => (percent / 100) ** 2;
const percentOfDb = (db: number) => Math.round(100 * 10 ** (db / 40));

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const v = Number(raw);
    if (raw !== null && Number.isFinite(v)) return Math.min(100, Math.max(0, v));
  } catch {
    // Storage blocked: default.
  }
  return DEFAULT;
}

function saveVolume(percent: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(percent));
  } catch {
    // Storage blocked: the slider still works this session.
  }
}

/** Start the ambient loop and add its Volume slider to `panel`. */
export function ambience(url: string, params: URLSearchParams, panel: HTMLElement): void {
  if (params.get("sound") === "0") return;
  const db = Number(params.get("volume"));
  let percent = params.has("volume") && Number.isFinite(db) ? Math.min(100, Math.max(0, percentOfDb(db))) : loadVolume();
  let before = percent || DEFAULT; // what M restores

  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.value = gainOf(percent);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.className = "volume";
  const label = document.createElement("label");
  label.className = "volume";
  label.append("Volume", slider);
  panel.append(label);

  const render = () => {
    slider.value = String(percent);
    label.title = ctx.state === "running"
      ? `Volume ${percent}% (100% = the original's level; M mutes)`
      : "Sound starts on your first click or key press";
  };
  const set = (p: number, save = true) => {
    percent = Math.min(100, Math.max(0, Math.round(p)));
    if (percent > 0) before = percent;
    // Short ramp: an instant jump to or from zero clicks.
    gain.gain.setTargetAtTime(gainOf(percent), ctx.currentTime, 0.03);
    if (save) saveVolume(percent);
    render();
  };
  render();
  slider.addEventListener("input", () => {
    set(Number(slider.value));
    void unlock();
  });
  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT" && e.target !== slider) return; // typing in the fish picker
    if ((e.key === "m" || e.key === "M") && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) set(percent > 0 ? 0 : before);
  });

  // Browsers only allow sound after a user gesture: the first click or key press.
  const unlock = async () => {
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    render();
    if (ctx.state === "running") {
      removeEventListener("pointerdown", unlock);
      removeEventListener("keydown", unlock);
    }
  };
  addEventListener("pointerdown", unlock);
  addEventListener("keydown", unlock);
  ctx.addEventListener("statechange", render);

  (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
  })().catch((e) => {
    slider.disabled = true;
    label.title = "Sound unavailable";
    console.warn(`ambience: ${url}: ${(e as Error).message}`);
  });
}
