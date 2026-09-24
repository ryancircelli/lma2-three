# Research notes: rebuilding Living Marine Aquarium 2

Everything learned so far about how the original works, the tooling for
measuring it, and the traps that have already cost time. **Read the "Hard
rules" section before doing anything.**

The goal is fidelity: the three.js version should match the original as
closely as can be *measured*. Every constant that is not read from the data
should either be measured against reference frames of the original, or be
marked `CALIBRATE` with a note on what would measure it.

---

## Hard rules

1. **Never run the original screensaver natively on Windows.** It forces the
   whole desktop into its `<videomode>` (measured: 2400x1600 -> 640x480), which
   disrupts the person using this machine. Reference frames come ONLY from
   `tools/wine-ref.sh`, which runs it under Wine on a private Xvfb display.
2. **Never use `DISPLAY=:0` in WSL.** That is WSLg - it draws windows on the
   Windows desktop. `wine-ref.sh` uses `xvfb-run -a`, which picks a private
   display. Do the same for anything X11.
3. **Never write the install's `settings.xml`** (`C:\Program Files (x86)\...`
   or its VirtualStore copy). If you ever write any `settings.xml`, it must have
   **no BOM** - the 2005 XML parser dies on one and the screensaver exits
   instantly. PowerShell's `-Encoding UTF8` adds a BOM. `wine-ref.sh` edits its
   own private copy with `sed`, which is safe.
4. **Never use `wineserver -k` or `wine` without your own `WINEPREFIX`.**
   `wineserver -k` kills every Wine process in that prefix, including another
   agent's capture. Use `LMA2_WINEPREFIX=$HOME/.wine-lma2-<you>` (see below).
5. Stay inside your own worktree, port, browser session and Wine prefix.

---

## Environment

- Repo (WSL Ubuntu-22.04): `/home/ryanc/dev/lma2-three`. From Windows tools:
  `\\wsl.localhost\Ubuntu-22.04\home\ryanc\dev\lma2-three\...` (Read/Write/Edit
  work on these UNC paths).
- Run Linux commands with
  `wsl.exe -d Ubuntu-22.04 --exec bash -lc '...'`.
  Use `--exec`, NOT `--`: with `--` your command goes through the login shell
  twice and `$vars` expand to empty before bash sees them.
- Linux side has: Deno 2.9, git, Wine 6 (32-bit prefixes work), Xvfb,
  xvfb-run, ImageMagick (`convert`, `compare`, `identify`, `montage`, `import`),
  python3. **No ffmpeg** and no sudo.
- Windows side has Node 24 (for `npx agent-browser`), ffmpeg, PowerShell 7.
  PowerShell 7 lacks `System.Drawing` types - prefer ImageMagick in WSL for all
  image maths.
- Editing a shell script through the UNC path drops its executable bit: `chmod +x` after.
- The Claude Code sandbox sometimes blocks `Remove-Item` when the same command
  contains `//`, a regex, or a Program Files path. Keep deletes in their own
  small command.

### Commands

```sh
deno task check      # type-check src/ and tools/
deno task build      # bundle src/main.ts -> dist/app.js   (must pass before any screenshot)
deno task test       # parse/build all 28 .X files headlessly
deno task serve --port <yours>
deno task extract    # already done; assets/ is shared (symlinked into worktrees)
```

---

## Rendering your build: agent-browser (headless Chromium, Windows)

Headless Chrome runs on a private desktop - it never shows on screen.
A wrapper exists at
`C:\Users\ryanr\AppData\Local\Temp\claude\C--Users-ryanr\7c3a0ff9-729d-462a-b99c-371c24ecf509\scratchpad\ab.ps1`:

```powershell
. 'C:\Users\ryanr\AppData\Local\Temp\claude\C--Users-ryanr\7c3a0ff9-729d-462a-b99c-371c24ecf509\scratchpad\ab.ps1'
$global:ABSession = 'lma2-<you>'          # YOUR session - never the default one
[void](AB @('open', 'about:blank') 25)    # first command in a session hangs (daemon holds the pipe); absorb it
AB @('set', 'viewport', '1024', '768')
[void](AB @('open', 'http://127.0.0.1:<port>/?view=tank&scene=1&t=0&clean=1&size=1024x768&fish=0'))
ABWaitReady 'scene-1'                     # polls window.lma2
AB @('screenshot', '\\wsl.localhost\Ubuntu-22.04\home\ryanc\dev\lma2-three\.worktrees\<you>\screenshots\x.png')
AB @('close')                             # when finished
```

`AB` runs each call as a job with a timeout. `window.lma2` = `{ready, view, subject, detail, error}`.
Wait for fish to load by polling for `"creatures"` in `detail` when fish are on.

### Page URL parameters

| param | meaning |
|---|---|
| `view=tank` / `view=fish` | the tank (default) or the single-species viewer |
| `scene=1..3` | tank scene |
| `t=<s>` | freeze time; fish are pre-simulated deterministically (seeded RNG) up to t |
| `size=1024x768` | fixed canvas size - the original's mode; use for every comparison |
| `clean=1` | hide UI |
| `fish=0` | empty tank (backdrop comparisons) |
| `school=0` | disable schooling |
| `zoomx=`, `zoomy=`, `dx=`, `dy=` | override the camera calibration |
| `bb=<a>,<b>` | force billboard layer opacities |

---

## Reference frames: tools/wine-ref.sh

```sh
export LMA2_WINEPREFIX=$HOME/.wine-lma2-<you>
tools/wine-ref.sh setup                                         # once, ~1 min
tools/wine-ref.sh capture OUT.png <scene> <caustics 0|1> <fish 0|1> [delay-s]
tools/wine-ref.sh sequence OUTDIR <scene> <caustics> <fish> <frames> <interval-s> [delay-s]
```

- Wine's render of scene 1 was compared against a real Windows capture of the
  same settings: visually identical. Wine output is a trustworthy reference for
  layout, layering and texturing. Exact colour/filtering are Wine's (Mesa).
- `sequence` records `times.txt` (capture timestamps). ImageMagick `import` of
  a full 1024x768 root takes ~0.5 s, so frames land ~0.7 s apart. For fast
  motion, capture a crop (`import -window root -crop WxH+X+Y`) - edit the
  script or write your own loop on the same pattern.
- The app randomises. Two captures of "the same" config differ in fish
  positions and animation phase. Match structure and statistics, not a single
  frame, for anything animated.
- `videomode` is forced to 0 under Xvfb (only 1024x768 exists there; the
  install's value 2 points past the end of the rebuilt list and the app aborts).

### Analysis tools (tools/)

| tool | use |
|---|---|
| `register.ts ours ref` | local displacement field on a grid of regions (offset vs scale vs per-layer) |
| `colorfit.ts ours ref [x y w h]` | per-channel `ref = a*ours + b` fit; slopes <1 with equal means = blur/misregistration, not colour |
| `sway.ts seqdir x0 x1 rows` | horizontal motion of row bands over a sequence |
| `fitblend.ts seqdir label=png... -- name:geom...` | which candidate render best matches each region in each frame |
| `profile.ts x0 x1 y0 y1 imgs...` | column "greenness" profiles, peak positions |
| `matchsprite.ts ref backdrop x y w h tex...` | true screen placement/scale of a sprite, by silhouette IoU search |
| `inspect.ts file.X` | frames, meshes, bounds, materials, textures |

ImageMagick one-liners used constantly:
`compare -metric PSNR a.png b.png null:`,
`compare -metric AE -fuzz 3% a.png b.png null:`,
`convert a.png -crop WxH+X+Y +repage -format "%[pixel:p{x,y}]" info:`.

---

## What is known about the original

### Formats

- Archives `CRFSFAT` (data.fat index + data.bin), unpacked to `assets/`.
- Meshes: DirectX `.X`, text. No skinning, no AnimationSet.
- Textures: DDS DXT3/DXT5/RGB32, converted to PNG beside each (`.dds` names in
  `.X` files resolve to the `.png`).
- One audio file, an 8 s Ogg loop.

### The painted reef (src/scene.ts) - all three scenes

- A scene is a hand-painted reef on flat tiled planes: `Background`
  (`bg_slice*`, far) and `Foreground` (`fg_slice*`, near), plus billboard quads.
  Viewed through an **orthographic** camera, **unlit**.
- Camera (src/main.ts, from the original's code, verified per scene with
  register.ts): ortho box over the X/Y extent of **every vertex** in mesh.X
  (Relief/billboards/height included) at 98% (`OrthoLH(W*0.98, H*0.98)`), eye
  x = 0, y = box centre; then content 0.5 px right and 0.5 px down (pixel-centre
  convention, inferred). All regions of all three scenes align within ~0.1 px.
  (The old scene-1 fit 1.018 x 1.0209 was this to 0.05%; it left scenes 2-3
  1.2-1.5 px off at the edges.)
- Clear colour per scene, read from the .scr: 1 `#008aff`, 2 `#00cbfd`,
  3 `#036ed6` (exact match to references).
- Tiles are clamped (repeat wrapping produced seam lines).
- Draw order is far-to-near by frame z; nothing writes depth. So billboards with
  z > 0 (scene 1 soft coral, scene 2 sea whips) are hidden behind the Foreground.
  SceneModel exposes the original's two passes: `back` (Background) and `front`
  (billboards, Foreground, Relief, near billboards). Creatures behind the
  foreground go between them, creatures in front go after `front` - over the
  near billboards too (`near` is now always empty; original-logic.md 2.2).
- **Billboards**: the table (textures, class, bbox edit) is hard-coded in one
  setup function per scene (.scr 0x41dc90 / 0x41d3a0 / 0x41e5c0) - see
  `BILLBOARDS` in scene.ts. Each is a quad over its frame's world bbox, with a
  constant edit (scene 1 seaweed x+100 = the old "58px" mystery; scene 2 sea
  whip top +100; scene 3 yellow grass x-150, blue anemones x+200). Two layers
  per plant, both at full opacity. **They MOVE** (`plantsmoving`): four classes
  sway their layers against each other (period pi s) and class B tops rotate
  about the world origin (~19 px, 63 s cycle). The earlier "static" finding was
  wrong. Verified on a 43 s Wine sequence of scene 3: one clock offset fits
  every frame (31-32 dB).
- Scene rotation (`index` 0): once per launch, via registry `SceneIndex`
  (first run shows scene 2); never on a timer (15 min run: no switch).
- `Relief` (the only real 3D mesh) is not drawn yet - it carries the caustics
  (texture name `caustics_00.dds`, which does not exist; frames `_01`..`_29` do).
- `height` (7-8 points) and `Crab_Path` (25-35 points, in path.X) are data, not
  geometry. Their meaning is not established.

### The water surface - NOT BUILT

- Top ~125 px of 768: bright elongated streaks added over the base blue (R and G
  rise, B stays 255 -> additive). Animated. Ends at a faint horizon line ~y=118-125.
- `common/watersurface.X`: 9x9 grid (81 verts), x +-95, z +-24, slightly wavy.
  Material texture `caust00.dds` - i.e. the caustics animation.
- Looks perspective-projected (a horizontal plane seen from below), even though
  the painting is orthographic.

### Bubbles - NOT BUILT

- A column rising from the soft coral in scene 1, around x = 290-380 px.
  Individual small sprites (`common/BUBBLE.png`, 8x8).

### Other common assets

`ray.X` (30x100 quad, `ray.dds`, alpha 0.9 - light shafts?), `light.png`
(32x32 glow), `shadow.png` (32x32 blob), `caustics_01..29.png` (64x64).

### Creatures (src/fish.ts, src/tank.ts)

- Poses become morph targets: swimming fish `center`/`opened`/`closed` are
  **fins spread/folded** (the tail is identical in all three); sea horse
  `left/center/right` sway; crab 12-frame walk (base `full_mesh.X`).
- Fish heads point along +X in model space after the handedness mirror.
- Per-species `settings.xml`: `school`, `scale`, `speed`, `aggression`, `behav`.
- ~~Fish are drawn in perspective~~ - superseded: everything, fish included,
  goes through ONE orthographic camera; near/far size and speed are faked in
  the fish code, and fish are split per frame into a behind-the-foreground and
  an in-front group (docs/original-logic.md 2-4, implemented in src/tank.ts).
- Motion is the decoded model, not tuning. Checked against the original
  (Wine, bare tank, per species, tools/track.ts vs tools/probe-ours.ts +
  tools/motion-stats.ts): whole tank centre-y p02/50/98 7/273/712 px (ref
  6-16/219-319/707-715), speed p50/p90 25/81 px/s (ref 12-26/60-106), width
  p50/p90 57/113 px (ref 55-64/101-117). Fish never go below the Crab_Path
  floor line in the reference (p95 0 px, p99 10 px over 9182 blobs).
- The original is TIME-based (QueryPerformanceCounter dt), so Wine's 2-12 fps
  does not slow its motion: a fish crossing a 7.6 s render stall moved the
  distance its speed predicts.
- Motion captures: `LMA2_GRAB=fast LMA2_SECONDS=40` (tools/xgrab.py keeps only
  new renders, timed), `LMA2_BARE=1` (creatures on flat water: clean
  silhouettes), `LMA2_TANK="Name=N,..."`, `LMA2_SCHOOLING=0|1`.
