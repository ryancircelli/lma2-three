// For each frame of a reference sequence, find which of a set of candidate
// renders best matches each region - e.g. candidates rendered at cross-fade
// weights w = 0, 0.1 .. 1 recover w(t) per billboard: its period and waveform.
//
//   deno run --allow-read --allow-run tools/fitblend.ts <seqdir> <label=candidate.png ...> -- <name:WxH+X+Y ...>

async function crop(path: string, geom: string): Promise<Uint8Array> {
  const out = await new Deno.Command("convert", { args: [path, "-crop", geom, "+repage", "-depth", "8", "rgb:-"], stdout: "piped" }).output();
  return out.stdout;
}

const sep = Deno.args.indexOf("--");
const [dir, ...cands] = Deno.args.slice(0, sep);
const regions = Deno.args.slice(sep + 1).map((r) => {
  const [name, geom] = r.split(":");
  return { name, geom };
});
const candidates = cands.map((c) => {
  const [label, path] = c.split("=");
  return { label, path };
});

const times = (await Deno.readTextFile(`${dir}/times.txt`)).trim().split("\n").map(Number);
const frames: string[] = [];
for await (const e of Deno.readDir(dir)) if (/^f\d+\.png$/.test(e.name)) frames.push(e.name);
frames.sort();

// candidate crops, once
const cand = new Map<string, Uint8Array>();
for (const c of candidates) for (const r of regions) cand.set(`${c.label}|${r.name}`, await crop(c.path, r.geom));

const mae = (a: Uint8Array, b: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

console.log("t(s)   " + regions.map((r) => r.name.padStart(16)).join(""));
for (let f = 0; f < frames.length; f++) {
  const cells: string[] = [];
  for (const r of regions) {
    const ref = await crop(`${dir}/${frames[f]}`, r.geom);
    let best = Infinity, bl = "";
    for (const c of candidates) {
      const e = mae(ref, cand.get(`${c.label}|${r.name}`)!);
      if (e < best) [best, bl] = [e, c.label];
    }
    cells.push(`${bl.padStart(6)} (${best.toFixed(1).padStart(4)})`.padStart(16));
  }
  console.log(`${(times[f] - times[0]).toFixed(2).padStart(6)} ` + cells.join(""));
}
