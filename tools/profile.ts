// Print horizontal "greenness" (G - max(R,B)) profiles for a row band of
// several images, as coarse ASCII strips plus peak positions - for comparing
// where plant stalks sit in a reference frame versus candidate renders.
//
//   deno run --allow-run tools/profile.ts <x0> <x1> <y0> <y1> <img...>

const [x0, x1, y0, y1] = Deno.args.slice(0, 4).map(Number);
const imgs = Deno.args.slice(4);
const W = x1 - x0, H = y1 - y0;

async function greenness(path: string): Promise<Float32Array> {
  const out = await new Deno.Command("convert", {
    args: [path, "-crop", `${W}x${H}+${x0}+${y0}`, "+repage", "-depth", "8", "rgb:-"],
    stdout: "piped",
  }).output();
  const px = out.stdout;
  const col = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      col[x] += Math.max(0, px[i + 1] - Math.max(px[i], px[i + 2]));
    }
  }
  for (let x = 0; x < W; x++) col[x] /= H;
  return col;
}

const shades = " .:-=+*#%@";
for (const p of imgs) {
  const c = await greenness(p);
  const max = Math.max(...c, 1);
  let strip = "";
  for (let x = 0; x < W; x += 3) strip += shades[Math.min(9, Math.floor((c[x] / max) * 9.99))];
  // peaks: local maxima above 35% of max, at least 12px apart
  const peaks: number[] = [];
  for (let x = 2; x < W - 2; x++) {
    if (c[x] > 0.35 * max && c[x] >= c[x - 1] && c[x] >= c[x + 1] && c[x] >= c[x - 2] && c[x] >= c[x + 2]) {
      if (!peaks.length || x - peaks[peaks.length - 1] > 12) peaks.push(x);
    }
  }
  console.log(`${p.split("/").pop()!.padEnd(18)} |${strip}|  peaks at x=${peaks.map((x) => x + x0).join(",")}`);
}
