// The scene's particle and light effects - bubbles, light rays, light motes -
// wired into the tank view's passes with one object, so main.ts needs only a
// handful of one-line hooks.
//
// Where each one draws (docs/original-logic.md 2.2):
//   scene pass 0 (SceneModel.back):   ... Background plane, then LIGHT RAYS
//   scene pass 1 (SceneModel.front):  BUBBLES first, then far billboards,
//                                     Foreground, caustics, near billboards
//   after the front creatures:        LIGHT MOTES (the original's last draw)
// Nothing in the painting writes depth, so renderOrder is the layering. The
// scene orders its layers by renderOrder = -z (far to near); rays and bubbles
// are slotted just after the Background plane: rays at +0.25, bubbles at +0.5.
// Every pass-1 layer is far nearer than the Background, so both come before
// all of pass 1.
// The motes go in the scene handed to the constructor as `last` - drawn after
// the creatures.
//
// URL: ?bubbles=0 (<bubles value="0">), ?rays=0 (<volume value="0">), ?motes=0.

// @ts-types="npm:@types/three@0.186.0"
import * as THREE from "three";
import { Bubbles } from "./bubbles.ts";
import { Motes } from "./motes.ts";
import { Rays } from "./rays.ts";
import type { SceneModel } from "./scene.ts";
import { loadSceneBox } from "./scenebox.ts";

export class Effects {
  readonly bubbles: Bubbles;
  readonly rays: Rays;
  readonly motes: Motes;

  constructor(assetsUrl: string, params: URLSearchParams, last: THREE.Object3D) {
    this.bubbles = new Bubbles(assetsUrl, params.get("bubbles") !== "0");
    this.rays = new Rays(assetsUrl, params.get("rays") !== "0");
    this.motes = new Motes(assetsUrl, params.get("motes") !== "0");
    this.motes.object.renderOrder = 1e6;
    last.add(this.motes.object);
  }

  /** A scene was loaded: slot rays and bubbles into its pass groups. */
  async setScene(id: string, assetsUrl: string, model: SceneModel): Promise<void> {
    let bgOrder = -Infinity;
    model.back.traverse((o) => {
      if (o.name === "Background" && (o as THREE.Mesh).isMesh) bgOrder = Math.max(bgOrder, o.renderOrder);
    });
    if (!Number.isFinite(bgOrder)) bgOrder = -1e5; // no Background: still before pass 1
    this.rays.object.renderOrder = bgOrder + 0.25;
    this.bubbles.object.renderOrder = bgOrder + 0.5;
    // Both groups mirror z (.X space in, three.js out): rays and bubbles give
    // .X-space positions. Object3D.add takes them out of the previous scene's groups.
    model.back.add(this.rays.object);
    model.front.add(this.bubbles.object);
    const box = await loadSceneBox(id, assetsUrl);
    this.bubbles.setScene(id, box);
    this.rays.setScene(box);
    this.motes.setScene(id, box);
  }

  /** Drawing-buffer pixels per world unit of the (orthographic) tank camera. */
  /** The bubble column's axis x (.X space), or null (bubbles.ts). */
  bubbleColumn(): number | null {
    return this.bubbles.column();
  }

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
