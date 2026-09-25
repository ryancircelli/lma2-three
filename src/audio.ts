// The soundtrack: the original has exactly one sound, Sound_undwater.ogg (an
// ~8 s bubbling/ambience loop), played on repeat while the tank runs.
//
// Played through Web Audio rather than <audio loop>, which leaves an audible gap
// at the loop point. Browsers only allow sound after a user gesture, so the
// context starts on the first click or key press. M toggles mute, as in the
// windowed launcher. The panel's volume slider runs from silent to the
// original's own level (100%, the default); both are remembered per browser.
//
//   ?sound=0        no audio at all
//   ?volume=<dB>    level relative to the original (0 = original, -12 = quieter);
//                   overrides the remembered slider. The Windows screensaver
//                   passes its Volume setting this way.

const MUTE_KEY = "lma2.muted";
const VOLUME_KEY = "lma2.volume";

// Slider percent <-> gain. A squared curve, so equal slider steps sound like
// roughly equal loudness steps: 100% = the original level, 50% = -12 dB.
const gainOf = (percent: number) => (percent / 100) ** 2;
const percentOfDb = (db: number) => Math.round(100 * 10 ** (db / 40));

function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    if (localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v)) return Math.min(100, Math.max(0, v));
  } catch {
    // Storage blocked: default.
  }
  return 100;
}

function saveVolume(percent: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(percent));
  } catch {
    // Storage blocked: the slider still works this session.
  }
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // Storage blocked (private window, sandbox): mute still works this session.
  }
}

/** Start the ambient loop and add its toggle to `panel`. */
export function ambience(url: string, params: URLSearchParams, panel: HTMLElement): void {
  if (params.get("sound") === "0") return;
  const db = Number(params.get("volume"));
  let percent = params.has("volume") && Number.isFinite(db) ? Math.min(100, Math.max(0, percentOfDb(db))) : loadVolume();
  let level = gainOf(percent);

  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  let muted = loadMuted();
  gain.gain.value = muted ? 0 : level;

  const button = document.createElement("button");
  button.type = "button";
  button.title = "Toggle sound (M)";
  const render = () => {
    button.textContent = muted ? "Sound: off" : ctx.state === "running" ? "Sound: on" : "Sound: click to start";
  };
  render();

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.value = String(percent);
  slider.className = "volume";
  slider.setAttribute("aria-label", "Volume");
  const showTitle = () => slider.title = `Volume ${percent}% (100% = the original's level)`;
  showTitle();
  slider.addEventListener("pointerdown", (e) => e.stopPropagation()); // don't count as the unlock click
  slider.addEventListener("input", () => {
    percent = Number(slider.value);
    level = gainOf(percent);
    saveVolume(percent);
    showTitle();
    if (muted && percent > 0) setMuted(false); // moving the slider unmutes
    else gain.gain.setTargetAtTime(muted ? 0 : level, ctx.currentTime, 0.03);
    if (ctx.state !== "running") void unlock();
  });
  panel.append(button, slider);

  const setMuted = (m: boolean) => {
    muted = m;
    saveMuted(m);
    // Short ramp: an instant jump to or from zero clicks.
    gain.gain.setTargetAtTime(m ? 0 : level, ctx.currentTime, 0.03);
    render();
  };
  // The button does its own unlocking: if the window-level pointerdown unlock
  // ran first, the context would already be running by `click` and the very
  // first press would mute instead of start.
  button.addEventListener("pointerdown", (e) => e.stopPropagation());
  button.addEventListener("click", () => {
    if (ctx.state === "running") setMuted(!muted);
    else void unlock();
  });
  addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return; // typing in the fish picker
    if (e.key === "m" || e.key === "M") {
      if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) setMuted(!muted);
    }
  });

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
    button.textContent = "Sound: unavailable";
    button.disabled = true;
    console.warn(`ambience: ${url}: ${(e as Error).message}`);
  });
}
