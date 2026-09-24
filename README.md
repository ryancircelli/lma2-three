# lma2-three

*Living Marine Aquarium 2* (Freeze.com / Triodesign, 2005) rebuilt in three.js from its **original assets**.

TypeScript throughout, run and bundled with Deno. No Node, no ffmpeg, no system dependencies.

## Quick start

Needs Deno 2.x and a Living Marine Aquarium 2 install. From WSL the Windows install is read at `/mnt/c/Program Files (x86)/...`
automatically.

```sh
deno task extract   # unpack the install into assets/ (~3 s)
deno task build     # bundle src/ -> dist/app.js
deno task serve     # http://127.0.0.1:8000
```

`?fish=<slug>` picks the species, `?phase=0..1` freezes the animation (useful for screenshots).

| Task | What it does |
|---|---|
| `extract` | Unpack every archive, convert textures to PNG, write `assets/manifest.json`. Options: `--source`, `--dest`, `--settings`, `--no-textures` |
| `check` | Type-check everything |
| `test` | Parse and build all 28 `.X` files headlessly, checking indices, UVs, materials, morph targets |
| `build` | Bundle for the browser |
| `serve` | Static server on `127.0.0.1:8000` |

`assets/` is gitignored: it is regenerable, and the content is not ours to redistribute.

## Layout

```
src/xloader.ts        DirectX .X (text) parser -> three.js meshes and morph targets
src/fish.ts           load a species as an animatable object
src/main.ts           the viewer
tools/extract.ts      CRFSFAT unpacker + manifest
tools/dds.ts          DDS (DXT1/3/5, uncompressed) decoder + PNG encoder
tools/test-xloader.ts headless loader test
tools/serve.ts        dev server
```

## What the original data contains

Everything is in open formats - nothing encrypted or obfuscated.

| Asset | Format |
|---|---|
| Archives | `CRFSFAT` - `data.fat` index + `data.bin` payload (layout in `tools/extract.ts`) |
| Meshes | DirectX `.X`, **text** (`xof 0303txt 0032`) - 28 files |
| Textures | DDS: DXT3 x124, DXT5 x7, uncompressed 32-bit x2 |
| Audio | one Ogg Vorbis loop, 8.0 s |
| Settings | small flat XML |

### Animation: what is recovered, what is not

There is **no skinning and no `AnimationSet`** anywhere. Models ship their poses as whole meshes with identical vertex order, which
become three.js morph targets:

| Kind | Poses | Models |
|---|---|---|
| `swim` | `center` + `opened` + `closed` | every swimming fish - **fins** spread and folded (pectoral and front dorsal); the tail is identical in all three |
| `sway` | `center` + `left` + `right` | sea horse |
| `cycle` | 12-frame walk, `Anemone_Crab01..12` | anemone crab |
| `static` | - | sea star (plus its own shadow mesh) |

Vertex correspondence was measured rather than assumed: pose vertex *i* sits ~1 unit from base vertex *i* on a ~180-unit body,
versus ~60 from an arbitrary vertex. Percula's `opened` has a different face list (retriangulated), so the base pose's faces are
used for every pose.

The crab is a special case: its 12 walk frames in `mesh.X` are **untextured**, while `full_mesh.X` is the same 1,006-vertex crab
**with** texture and UVs. `full_mesh.X` is the base; all 12 frames are targets.

**Not in the data** - the original computes these in compiled C++ (`CCrab`, `CSeaHorse`, `CSeaStar`, `KD3DLMAScreensaver`):

- body undulation and tail beat
- where each fish goes: paths, turning, schooling

These have to be re-created, not recovered. Each species' `settings.xml` does supply the tuning inputs: `school`, `scale`, `speed`,
`aggression`, `behav`.

Two meshes have no triangles and are data, not geometry: `Crab_Path` (25-35 points per scene - the crab's walk route) and `height`
(7-8 points per scene).

## Verification

- **Extraction** - all 200 raw files byte-identical to an independent PowerShell extractor.
- **Textures** - all 133 decoded images compared pixel-by-pixel against ffmpeg's decoder: identical dimensions, maximum difference
  **1/255** on any channel. The residual is rounding in DXT palette interpolation, which the format leaves to the implementation.
- **Loader** - `deno task test`: all 28 `.X` files parse and build, every morph set assembles.
- **Rendering** - checked in headless Chromium via [agent-browser](https://github.com/vercel-labs/agent-browser), one species per
  animation kind: page state read through `window.lma2`, then screenshots.

## Sound

The original's only sound, `Sound_undwater.ogg`, loops gaplessly (Web Audio) in the tank view. Browsers allow audio only after
a gesture, so it starts on the first click or key press. **M** or the panel button toggles mute (remembered per browser).
`?sound=0` disables it; `?volume=<dB>` sets the level, default **-12 dB** (the bubbling is loud at the original level; the
install was patched down by the same amount). `?clean=1` and `?t=` captures are silent.

## Deploy (public)

Every push to `main` runs `.github/workflows/deploy.yml`, which type-checks, tests, builds and stages `_site/`, then deploys it with
wrangler as Workers static assets to **https://lma2.ryancircelli.com** (also https://lma2-three.ryancircelli.workers.dev).

- The site is public: no password. (Until 2026-09-24 a Worker gate required one; it was removed along with its secret.)
- The custom domain is attached to the `lma2-three` Worker in Cloudflare (Workers -> lma2-three -> Domains), not in
  `wrangler.jsonc`, so the deploy token needs no zone permissions and deploys never touch the domain.
- **Secrets** (none in the repo): GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token is scoped
  to this one account with only *Workers Scripts: Edit* and *Account Settings: Read*; it is named "lma2-three deploy (GitHub
  Actions)" in the Cloudflare dashboard.
- Without `CLOUDFLARE_API_TOKEN`, CI still builds and tests but skips the deploy.

## Notes

- If the install's `COMMON` archive has `data.fat.bak-*` / `data.bin.bak-*` backups, `extract` uses the earliest pair, so the web
  build gets the original audio rather than a locally patched one.
- `settings.xml` in the install has **no BOM**, and the 2005 parser crashes if one is added. Nothing here writes to the install.

## Next

- The tank: layered background/foreground slices, the 29-frame caustics loop, light rays, water surface, bubbles.
- Fish navigation and schooling, driven by each species' behaviour values.
- Undulation layered on top of the fin poses.
