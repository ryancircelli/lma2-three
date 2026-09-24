// Assemble the deployable site in _site/: exactly what the browser loads.
//
//   deno task stage        (after `deno task build`)
//
// index.html + dist/ + assets/, minus the .dds originals - the viewer loads the
// PNG conversions beside them, so the DDS files would only be dead weight.

import { dirname, fromFileUrl, join, relative } from "jsr:@std/path@1";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const OUT = join(ROOT, "_site");

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile || e.isSymlink) yield p;
  }
}

async function copy(from: string): Promise<number> {
  const to = join(OUT, relative(ROOT, from));
  await Deno.mkdir(dirname(to), { recursive: true });
  await Deno.copyFile(from, to);
  return (await Deno.stat(to)).size;
}

await Deno.remove(OUT, { recursive: true }).catch(() => {});
await Deno.mkdir(OUT, { recursive: true });

try {
  await Deno.stat(join(ROOT, "dist", "app.js"));
} catch {
  throw new Error("dist/app.js missing - run `deno task build` first");
}

let files = 0, bytes = 0;
for (const p of [join(ROOT, "index.html")]) {
  bytes += await copy(p);
  files++;
}
for (const dir of ["dist", "assets"]) {
  for await (const p of walk(join(ROOT, dir))) {
    if (/\.dds$/i.test(p)) continue;
    bytes += await copy(p);
    files++;
  }
}
console.log(`staged ${files} files, ${(bytes / 1048576).toFixed(1)} MB -> ${relative(ROOT, OUT)}/`);
