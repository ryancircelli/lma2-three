// The scene's particle and light effects - bubbles, light rays, light motes -
// wired into the tank view's passes with one object, so main.ts needs only a
// handful of one-line hooks.
//
// Where each one draws (docs/original-logic.md 2.2), mapped onto our passes
// (painting -> creatures -> near billboards):
//   painting pass:  Background plane (renderOrder -2)
//                   light rays       (-1.5)  end of the original's pass 0
//                   bubbles          (-1)    start of its pass 1
//                   everything else in the painting (>= 0): Foreground plane,
//                   far billboards - they cover rays and bubbles
//   near pass:      light motes      (1000)  the original's very last draw
//
// URL: ?bubbles=0 (<bubles value="0">), ?rays=0 (<volume value="0">), ?motes=0.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { Bubbles } from "./bubbles.ts";
import { Motes } from "./motes.ts";
import { Rays } from "./rays.ts";
import { loadSceneBox } from "./scenebox.ts";

export class Effects {
  readonly bubbles: Bubbles;
  readonly rays: Rays;
  readonly motes: Motes;

  constructor(assetsUrl: string, params: URLSearchParams, painting: THREE.Scene, near: THREE.Scene) {
    this.bubbles = new Bubbles(assetsUrl, params.get("bubbles") !== "0");
    this.rays = new Rays(assetsUrl, params.get("rays") !== "0");
    this.motes = new Motes(assetsUrl, params.get("motes") !== "0");
    this.rays.object.renderOrder = -1.5;
    this.bubbles.object.renderOrder = -1;
    this.motes.object.renderOrder = 1000;
    painting.add(this.rays.object, this.bubbles.object);
    near.add(this.motes.object);
  }

  /** A scene was loaded: `paintingRoot` is its painting (SceneModel.object). */
  async setScene(id: string, assetsUrl: string, paintingRoot: THREE.Object3D): Promise<void> {
    // The Background plane leads the painting pass, so rays and bubbles fall
    // between it and the rest of the painting.
    paintingRoot.traverse((o) => {
      if (o.name === "Background" && (o as THREE.Mesh).isMesh) o.renderOrder = -2;
    });
    const box = await loadSceneBox(id, assetsUrl);
    this.bubbles.setScene(id, box);
    this.rays.setScene(box);
    this.motes.setScene(id, box);
  }

  /** Drawing-buffer pixels per world unit of the (orthographic) tank camera. */
  setScale(pxPerWorld: number): void {
    this.bubbles.setScale(pxPerWorld);
    this.motes.setScale(pxPerWorld);
  }

  update(t: number): void {
    this.rays.update(t);
    this.bubbles.update(t);
    this.motes.update(t);
  }
}
