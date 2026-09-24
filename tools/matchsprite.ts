// Find where the original actually draws a billboard sprite.
//
// The reference's plant silhouette = pixels where the reference differs from a
// render of ours with billboards hidden (the backdrop alone). The candidate
// silhouette = the union of the sprite textures' alpha, placed into a screen
// rectangle. Search that rectangle's position and size for the best overlap
// (intersection over union).
//
//   deno run --allow-run tools/matchsprite.ts <ref.png> <backdrop.png> <x> <y> <w> <h> <tex.png...>
//     x y w h = where OUR placement puts the quad on screen (the starting guess)

const [refPath, bgPath, xs, ys, ws, hs, ...texs] = Deno.args;
const QX = Number(xs), QY = Number(ys), QW = Number(ws), QH = Number(hs);

async function raw(path: string, fmt: "rgb" | "rgba", extra: string[] = []): Promise<{ w: number; h: number; px: Uint8Array }> {
  const id = await new Deno.Command("identify", { args: ["-format", "%w %h", path], stdout: "piped" }).output();
  const [w, h] = new TextDecoder().decode(id.stdout).trim().split(" ").map(Number);
  const out = await new Deno.Command("convert", { args: [path, ...extra, "-depth", "8", `${fmt}:-`], stdout: "piped" }).output();
  return { w, h, px: out.stdout };
}

const ref = await raw(refPath, "rgb"), bg = await raw(bgPath, "rgb");
const W = ref.w, H = ref.h;

// Reference silhouette: where the plant changes the picture noticeably.
const refMask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const d = Math.abs(ref.px[i * 3] - bg.px[i * 3]) + Math.abs(ref.px[i * 3 + 1] - bg.px[i * 3 + 1]) +
    Math.abs(ref.px[i * 3 + 2] - bg.px[i * 3 + 2]);
  refMask[i] = d > 60 ? 1 : 0;
}

// Sprite silhouette: union of texture alphas, all textures the same size.
const tex = await Promise.all(texs.map((t) => raw(t, "rgba")));
const TW = tex[0].w, TH = tex[0].h;
const spr = new Uint8Array(TW * TH);
for (const t of tex) for (let i = 0; i < TW * TH; i++) if (t.px[i * 4 + 3] > 128) spr[i] = 1;

// Search window: generous around our guess.
const X0 = Math.max(0, QX - 200), X1 = Math.min(W, QX + QW + 200);
const Y0 = Math.max(0, QY - 200), Y1 = Math.min(H, QY + QH + 200);

function iou(x: number, y: number, w: number, h: number): number {
  let inter = 0, uni = 0;
  for (let py = Y0; py < Y1; py += 2) {
    for (let px = X0; px < X1; px += 2) {
      const u = (px - x) / w, v = (py - y) / h;
      const s = u >= 0 && u < 1 && v >= 0 && v < 1 ? spr[Math.floor(v * TH) * TW + Math.floor(u * TW)] : 0;
      const r = refMask[py * W + px];
      if (s && r) inter++;
      if (s || r) uni++;
    }
  }
  return uni ? inter / uni : 0;
}

let best = { s: -1, x: QX, y: QY, w: QW, h: QH };
const consider = (x: number, y: number, w: number, h: number) => {
  const s = iou(x, y, w, h);
  if (s > best.s) best = { s, x, y, w, h };
};
// coarse: position +-150 step 6, scale 0.8-1.3
for (let k = 0.8; k <= 1.3; k += 0.05) {
  for (let dx = -150; dx <= 150; dx += 6) {
    for (let dy = -90; dy <= 90; dy += 6) consider(QX + dx, QY + dy, QW * k, QH * k);
  }
}
// fine: around the coarse best, independent x/y scale
const c = { ...best };
for (let kx = 0.94; kx <= 1.06; kx += 0.01) {
  for (let ky = 0.94; ky <= 1.06; ky += 0.01) {
    for (let dx = -6; dx <= 6; dx += 1) for (let dy = -6; dy <= 6; dy += 1) consider(c.x + dx, c.y + dy, c.w * kx, c.h * ky);
  }
}
const ours = iou(QX, QY, QW, QH);
console.log(`our placement : x=${QX} y=${QY} w=${QW} h=${QH}   IoU=${ours.toFixed(3)}`);
console.log(`best placement: x=${best.x.toFixed(1)} y=${best.y.toFixed(1)} w=${best.w.toFixed(1)} h=${best.h.toFixed(1)}   IoU=${best.s.toFixed(3)}`);
console.log(`delta         : dx=${(best.x - QX).toFixed(1)} dy=${(best.y - QY).toFixed(1)}  scale x${(best.w / QW).toFixed(3)} y${(best.h / QH).toFixed(3)}  (screen px)`);
