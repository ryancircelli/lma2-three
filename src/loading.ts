// The loading screen: the original's own splash (assets/common/splashfull.jpg,
// which it showed full screen while loading) with a progress bar, over black,
// until the tank is stocked and every model and texture has arrived; then it
// fades out.
//
// Progress comes from three's DefaultLoadingManager, which counts every
// texture load and (via xloader.ts) every .X model fetch. Its total grows as
// the scene and then each species start loading, so the bar only ever moves
// forward.
//
// Not shown for reference captures (?clean=1), which must see the tank itself;
// shown in the Windows screensaver (?saver=1), as the original did.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";

export interface Loading {
  /** The tank (or viewer) is set up: fade out once nothing is still loading. */
  finish(): void;
}

export function loadingScreen(enabled: boolean): Loading {
  const el = document.querySelector<HTMLElement>("#loading");
  if (!el) return { finish() {} };
  if (!enabled) {
    el.remove();
    return { finish() {} };
  }

  const fill = el.querySelector<HTMLElement>(".fill")!;
  let loaded = 0, total = 0, shown = 0;
  const manager = THREE.DefaultLoadingManager;
  const previous = manager.onProgress;
  manager.onProgress = (url, itemsLoaded, itemsTotal) => {
    previous?.(url, itemsLoaded, itemsTotal);
    loaded = itemsLoaded;
    total = itemsTotal;
    // Never backwards; the last 10% is kept for "set up and fully loaded".
    shown = Math.max(shown, Math.min(0.9, (0.9 * loaded) / Math.max(total, 1)));
    fill.style.width = `${(shown * 100).toFixed(1)}%`;
  };

  let finished = false;
  return {
    finish() {
      if (finished) return;
      finished = true;
      const idle = () => loaded >= total;
      const fade = () => {
        fill.style.width = "100%";
        // One more frame so the first fully loaded frame is what appears.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          el.classList.add("done");
          el.addEventListener("transitionend", () => el.remove(), { once: true });
          setTimeout(() => el.remove(), 1500); // if transitions are off
        }));
      };
      if (idle()) return fade();
      const started = performance.now();
      const poll = setInterval(() => {
        // Give up waiting after 20 s: better a tank still streaming in than a stuck splash.
        if (idle() || performance.now() - started > 20000) {
          clearInterval(poll);
          fade();
        }
      }, 100);
    },
  };
}
