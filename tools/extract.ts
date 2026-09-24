// Extract a Living Marine Aquarium 2 install into web-ready assets.
//
//   deno task extract [--source <install dir>] [--dest <assets dir>]
//                     [--settings <settings.xml>] [--no-textures]
//
// 1. Unpacks every CRFSFAT archive (COMMON, SCENES/*, Fishes/*) to loose files.
// 2. Converts every .dds to .png beside it (tools/dds.ts - pure TypeScript, no
//    ffmpeg), so textures load in every browser, not only ones exposing S3TC.
// 3. Writes manifest.json: every fish and scene, per-fish behaviour settings,
//    and the tank as configured in the install's settings.xml.
//
// --source defaults to the standard install path, as seen from Windows or from
// WSL (/mnt/c/...). --settings picks the tank to mirror; on Windows the
// VirtualStore copy is what an unelevated screensaver actually reads, so pass
// that one if it differs from the copy in the install folder.
//
// CRFSFAT layout (decoded by hand for this project):
//   data.fat : "CRFSFAT" + 01 + 7 spare bytes            (15-byte header)
//              then entries, back to back:
//                u16  nameLen
//                u8   name[nameLen]                       (no terminator)
//                u8   flag                                 (always 01)
//                u32  offset into data.bin
//                u32  size
//                u8   spare[8]                             (absent after the last entry)
//   data.bin : payloads, stored contiguously

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { fromFileUrl, join } from "jsr:@std/path@1";
import { decodeDDS, encodePNG } from "./dds.ts";

const args = parseArgs(Deno.args, { string: ["source", "dest", "settings"], boolean: ["no-textures"] });

const INSTALL_REL = ["Freeze.com", "Living Marine Aquarium 2 Full"];
const SOURCE = args.source ??
  (Deno.build.os === "windows"
    ? join(Deno.env.get("ProgramFiles(x86)") ?? "C:\\Program Files (x86)", ...INSTALL_REL)
    : join("/mnt/c/Program Files (x86)", ...INSTALL_REL)); // WSL view of the Windows install
const DEST = args.dest ?? fromFileUrl(new URL("../assets", import.meta.url));

// Source-control droppings shipped by accident in the scene archives.
const JUNK = new Set(["vssver.scc", "DartSPlugin.log"]);

interface Entry {
  name: string;
  offset: number;
  size: number;
}

function readFat(fat: Uint8Array): Entry[] {
  if (new TextDecoder().decode(fat.subarray(0, 7)) !== "CRFSFAT") throw new Error("not a CRFSFAT index");
  const dv = new DataView(fat.buffer, fat.byteOffset, fat.byteLength);
  const out: Entry[] = [];
  let p = 15;
  while (p + 2 <= fat.length) {
    const nl = dv.getUint16(p, true);
    if (nl < 1 || nl > 255 || p + 2 + nl + 9 > fat.length) break;
    const name = new TextDecoder("latin1").decode(fat.subarray(p + 2, p + 2 + nl));
    const q = p + 2 + nl;
    out.push({ name, offset: dv.getUint32(q + 1, true), size: dv.getUint32(q + 5, true) });
    p = q + 17;
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Unpack one archive pair. Returns the names written. */
async function unpack(fatPath: string, binPath: string, outDir: string): Promise<string[]> {
  const entries = readFat(await Deno.readFile(fatPath));
  const bin = await Deno.readFile(binPath);
  await Deno.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const e of entries) {
    if (JUNK.has(e.name)) continue;
    if (e.offset + e.size > bin.length) {
      console.warn(`  ! ${e.name} runs past the end of ${binPath}; skipped`);
      continue;
    }
    await Deno.writeFile(join(outDir, e.name), bin.subarray(e.offset, e.offset + e.size));
    written.push(e.name);
  }
  return written;
}

async function unpackDir(dir: string, outDir: string): Promise<string[]> {
  const fat = join(dir, "data.fat"), bin = join(dir, "data.bin");
  if (!(await exists(fat)) || !(await exists(bin))) return [];
  return await unpack(fat, bin, outDir);
}

/** "Percula Clown" -> "percula-clown" */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Pull value="…" attributes out of a small, flat XML file. */
function xmlValues(xml: string, tag: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of xml.matchAll(new RegExp(`<(\\w+)\\s+value="(-?[\\d.]+)"`, "g"))) {
    if (m[1] !== tag) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function sortedDirs(path: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(path)) if (e.isDirectory) out.push(e.name);
  return out.sort();
}

// ---------------------------------------------------------------------------

console.log(`source: ${SOURCE}`);
console.log(`dest  : ${DEST}`);
if (!(await exists(SOURCE))) throw new Error(`install not found: ${SOURCE}`);
await Deno.mkdir(DEST, { recursive: true });

let total = 0;

// COMMON holds the only audio. If this machine's copy was patched (the 12 dB
// quieter re-encode), prefer the pre-patch backup so the web build gets the
// original track. Backups are named data.fat.bak-<stamp> / data.bin.bak-<stamp>.
const commonDir = join(SOURCE, "COMMON");
let commonFat = join(commonDir, "data.fat"), commonBin = join(commonDir, "data.bin");
const stamps: string[] = [];
for await (const e of Deno.readDir(commonDir)) {
  const m = e.name.match(/^data\.fat\.bak-(\S+)$/);
  if (m && (await exists(join(commonDir, `data.bin.bak-${m[1]}`)))) stamps.push(m[1]);
}
if (stamps.length) {
  stamps.sort();
  commonFat = join(commonDir, `data.fat.bak-${stamps[0]}`);
  commonBin = join(commonDir, `data.bin.bak-${stamps[0]}`);
  console.log(`  common: using pre-patch backup ${stamps[0]} (original audio)`);
}
const common = await unpack(commonFat, commonBin, join(DEST, "common"));
console.log(`  common              ${String(common.length).padStart(3)} files`);
total += common.length;

const scenes: { id: string; files: string[] }[] = [];
for (const id of await sortedDirs(join(SOURCE, "SCENES"))) {
  const files = await unpackDir(join(SOURCE, "SCENES", id), join(DEST, "scenes", id));
  scenes.push({ id, files });
  console.log(`  scenes/${id.padEnd(12)} ${String(files.length).padStart(3)} files`);
  total += files.length;
}

interface FishEntry {
  slug: string;
  name: string;
  files: string[];
  picture: string | null;
  /** Per-species behaviour from the fish's own settings.xml. */
  behaviour: Record<string, number>;
}
const fish: FishEntry[] = [];
for (const name of await sortedDirs(join(SOURCE, "Fishes"))) {
  const s = slug(name);
  const out = join(DEST, "fish", s);
  const files = await unpackDir(join(SOURCE, "Fishes", name), out);
  let picture: string | null = null;
  if (await exists(join(SOURCE, "Fishes", name, "picture.jpg"))) {
    await Deno.copyFile(join(SOURCE, "Fishes", name, "picture.jpg"), join(out, "picture.jpg"));
    picture = "picture.jpg";
  }
  const behaviour = files.includes("settings.xml") ? xmlValues(await Deno.readTextFile(join(out, "settings.xml")), "fish") : {};
  fish.push({ slug: s, name, files, picture, behaviour });
  console.log(`  fish/${s.padEnd(20)} ${String(files.length).padStart(3)} files`);
  total += files.length;
}
console.log(`extracted ${total} files`);

// --- textures --------------------------------------------------------------
if (!args["no-textures"]) {
  let ok = 0, failed = 0;
  async function* dds(dir: string): AsyncGenerator<string> {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) yield* dds(p);
      else if (/\.dds$/i.test(e.name)) yield p;
    }
  }
  const formats: Record<string, number> = {};
  for await (const p of dds(DEST)) {
    try {
      const img = decodeDDS(await Deno.readFile(p));
      await Deno.writeFile(p.replace(/\.dds$/i, ".png"), await encodePNG(img.width, img.height, img.rgba));
      formats[img.format] = (formats[img.format] ?? 0) + 1;
      ok++;
    } catch (e) {
      failed++;
      console.warn(`  ! could not convert ${p}: ${(e as Error).message}`);
    }
  }
  const mix = Object.entries(formats).map(([f, n]) => `${f}×${n}`).join(" ");
  console.log(`converted ${ok} textures (${mix})${failed ? `, ${failed} FAILED` : ""}`);
}

// --- manifest --------------------------------------------------------------
// The tank as the user configured it: <fish value="N" name="..."/> in the
// install's settings.xml. An explicit --settings wins; otherwise on Windows
// prefer the VirtualStore copy (what an unelevated screensaver actually reads),
// then the copy in the install folder.
const tank: Record<string, number> = {};
const localAppData = Deno.env.get("LOCALAPPDATA");
const settingsCandidates = [
  ...(args.settings ? [args.settings] : []),
  ...(localAppData ? [join(localAppData, "VirtualStore", "Program Files (x86)", ...INSTALL_REL, "settings.xml")] : []),
  join(SOURCE, "settings.xml"),
];
let tankSource: string | null = null;
for (const c of settingsCandidates) {
  if (await exists(c)) {
    const xml = await Deno.readTextFile(c);
    for (const m of xml.matchAll(/<fish\s+value="(\d+)"\s+name="([^"]+)"/g)) tank[slug(m[2])] = Number(m[1]);
    tankSource = c;
    break;
  }
}

const manifest = {
  generated: new Date().toISOString(),
  source: SOURCE,
  tankSource,
  common,
  scenes,
  fish,
  tank,
};
await Deno.writeTextFile(join(DEST, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`wrote manifest.json (${fish.length} fish, ${scenes.length} scenes, tank: ${Object.values(tank).reduce((a, b) => a + b, 0)} fish)`);
