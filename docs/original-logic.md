# Living Marine Aquarium 2: behaviour recovered from the binary

This is a behaviour specification of the original screensaver
(`Living Marine Aquarium 2 Full.scr`, 475,136 bytes, 2005-02-21). It was
recovered by static analysis only: Ghidra 12.1 headless, plus objdump for the
COM calls whose stack arguments the decompiler drops. The original was never
run. Everything below is written in our own words. No decompiled code is
reproduced, and none of the binary or the decompiler output is in this repo.
The exports live outside the repo in `~/lma2-decomp/`.

Addresses are virtual addresses in the original image (base 0x400000), given
so each rule can be traced back.

Confidence tags:

- **[read]**: read directly from code or constant data.
- **[inferred]**: deduced from surrounding code, names or data layout; very
  likely, but not proven instruction by instruction.
- **[unknown]**: not recovered.

---

## 0. Engine facts

- **Direct3D version: DirectX 6.1** [read]. The binary contains the GUIDs of
  IDirectDraw4, IDirect3D3, IDirectDrawSurface4, IDirect3DTexture2 and the
  HAL/RGB/MMX/Ref device GUIDs, and none of the DX7 ones (IDirect3D7,
  IDirectDraw7, TnLHal). The source path strings mention `engine\Saver61dx`.
  The device interface is `IDirect3DDevice3`, which uses the legacy viewport
  object (`IDirect3DViewport3::Clear2`), `D3DLIGHT2` light objects and
  `D3DMATERIAL` handles. DX6 has no hardware texture-coordinate generation, so
  every generated UV (caustics) is computed on the CPU.
- **Time** [read]: a DXUtil-style QueryPerformanceCounter timer (0x42dea0). Each
  frame reads `t` (seconds since start) and `dt` (seconds since the last frame)
  into this+0x530 and this+0x534. All simulation uses variable-step seconds.
- **Randomness** [read]: MSVC `rand()`, seeded once from `GetTickCount()` at
  scene init (0x412450).
- **Meshes** are DirectX `.X` files. Vertices are `D3DVERTEX` (position, normal,
  uv; 32 bytes). Everything is drawn with `DrawIndexedPrimitive(TRIANGLELIST,
  XYZ|NORMAL|TEX1)`.

- **Exit rules** (window procedure 0x413d80) [read]:
  - The first mouse-move message records the position. A later move of 121 px
    or more on either axis closes the saver.
  - Any key press (WM_KEYDOWN, WM_SYSKEYDOWN) or left/right button press
    closes it.
  - The cursor is hidden in full-screen mode.
- **Files** [read]:
  - `settings.xml` and `videomodes.xml` are read from the install directory.
    The install path comes from the registry key `HKLM\Software\Triodesign\
    Living Marine Aquarium 2.0`, value `InstallPath`.
  - Assets come from the `CRFSFAT`/`CRFSBIN` package (`data.fat`/`data.bin`).
  - A debug log goes to `c:\lma_log.html`.
  - Preview mode shows `preview_full.jpg`. `SplashFull.jpg` is a splash
    picture.

---

## 1. Camera and projection (0x412450, render loop 0x40e330)

Everything in the scene is drawn through one **orthographic** camera: painting,
Relief, billboards, fish, crab, sea star and bubbles. There is no perspective
pass anywhere. [read]

```
bbox   = min/max over every vertex of every mesh in SCENES/<n>/mesh.X
         (Relief, Background, Foreground, billboards and the height polyline
          are all included; world space: our numbers match only with the frame
          transforms applied)                                      [read/inferred]
W = bbox.max.x - bbox.min.x ;  H = bbox.max.y - bbox.min.y
cy = bbox.min.y + H/2

VIEW = LookAtLH(eye = (0, cy, bbox.min.z - 2000),
                at  = (0, cy, bbox.max.z),
                up  = (0, 1, 0))                                     [read]
PROJ = OrthoLH(width = W * 0.98, height = H * 0.98, zn = 0, zf = 100000)  [read]
       (m11 = 2/w, m22 = 2/h, m33 = 1/(zf-zn), m43 = zn/(zn-zf))
WORLD for the scenery = identity                                    [read]
```

- The eye's X is always **0**, not the bbox centre. Every scene is almost
  centred, so this matters by at most about 0.3 units. [read]
- The camera looks along +Z, so a **smaller z means nearer the viewer**. [read]
- A perspective matrix (FOV pi/2, aspect 1.0, near 0, far 10000) is built at
  this+0x580 and set once at init. The per-frame loop replaces it with the
  ortho matrix before every pass, so it never affects a frame. [read]
- **Where the calibrated "zoom" comes from.** The painted planes are 1776.58 x
  1331.48 units. The view is 0.98 x bbox, and the bbox is set by the Relief
  mesh, which is slightly wider than the planes. The zoom factors per scene:

  | scene | bbox x | bbox y | zoom X = 1776.58/(0.98 W) | zoom Y |
  |---|---|---|---|---|
  | 1 | [-890.41, 890.41] | [-665.74, 665.74] | 1.01798 | 1.02041 |
  | 2 | [-891.32, 891.87] | [3.20, 1334.68] (cy 668.94) | 1.01662 | 1.02041 |
  | 3 | [-889.06, 888.29] | [-665.74, 665.74] | 1.01997 | 1.02041 |

  These match the empirically fitted scene-1 values (1.018 / 1.0209). [read +
  computed]
- The remaining ~0.8 px vertical offset is most likely D3D6's pixel-centre
  convention (pixel centres at integer coordinates, about half a pixel from
  GL's) rather than a camera parameter. [inferred]
- The viewport is the whole back buffer. The video mode comes from
  `videomodes.xml`; 1024x768 was the reference.

---

## 2. Frame structure, lighting, render order

### 2.1 Per-frame update (0x411ec0)

```
countdown(this+0x730) -= dt ; if <= 0: reassign predator targets (see 3.9), countdown = 10 s
crab.update(t, dt) ; seaStar.update(t, dt)
scene.update(t, dt)                        (0x41bca0)
for each creature: creature.computeAvoidance(allCreatures)   (vtable slot 5)
for each creature:
    creature.update(t, dt)                 (vtable slot 3)
    creature.drawInFront = (creature.z < scene.foregroundZ)   (scene+0x68 = z of the
                                             Foreground mesh = 0 in all three scenes)
sort creatures by z, descending (far to near, painter's order)   (comparator 0x40dc60)
bubbles.update(t, dt)                      (0x408290)
```

### 2.2 Per-frame draw (0x40e330) [read]

```
Clear2(target + zbuffer, colour = sceneClearColour, z = 1)
BeginScene
Z off (ZENABLE = 0, ZWRITE = 0); PROJ = ortho
L1 = ambientLevel, L2 = 0 ;  scene pass 0:
    water surface            (if water)          5.5
    Background plane         (if background)     5.2
    Foreground plane HERE instead, if foreground == 0
    light rays               (if volume)         5.6
Z on;  L1 = 0, L2 = 1
    creatures with drawInFront == false (back to front)
Z off; L1 = ambientLevel, L2 = 0 ;  scene pass 1 (ONLY if foreground == 1):
    bubbles                  (if bubles; Z test/write ON for them)  5.7
    billboards with z >= 0, far first                               5.3
    Foreground plane
    Relief caustics          (if caustic)        5.4
    billboards with z < 0
Z on;  L1 = 1, L2 = 0
    crab.draw ; seaStar.draw (floor variant)     4.1, 4.2
Clear2(zbuffer only)
L1 = 0, L2 = 1 ;  creatures with drawInFront == true (back to front)
L1 = 1, L2 = 0 ;  light motes (this+0x700)       5.8
Clear2(zbuffer only)
seaStar.draw (glass variant)                     4.2
FPS bookkeeping (0x40bd70; nothing visible)
EndScene
```

Consequence [read]: with `foreground = 0`, pass 1 never runs, so there are
no bubbles, no billboards and no Relief caustics, and the Foreground painting
is drawn behind every creature.

So fish behind the foreground plane are always painted over by the foreground
painting, and fish in front of it are always painted over nothing but bubbles.
Z-buffering only sorts creatures among themselves.

### 2.3 Scene constants set at init (0x412450) [read]

| scene | clear colour (ARGB) | ambientLevel (this+0x764) |
|---|---|---|
| 1 | 0xFF008AFF = rgb(0,138,255) | 0.3 |
| 2 | 0xFF00CBFD = rgb(0,203,253) | 0.5 |
| 3 | 0xFF036ED6 = rgb(3,110,214) | 0.5 |

(default when the index is out of range: colour 0, level 0.3)

### 2.4 Lights and material [read]

- Two `D3DLIGHT2` **directional** lights:
  - L1 at this+0x704: direction (0,-1,0), i.e. straight down.
  - L2 at this+0x708: direction (0,-1,0.2), down and slightly away from the
    viewer.

  Their initial colours ((0.3,0.3,0.2) and (0.9,0.9,0.5)) are overwritten every
  frame. The helper at 0x40e1b0 sets a light's colour to grey (v,v,v) with the
  per-pass value v given in 2.2.
- Ambient light state = 0x80808080 (0.5 grey).
- Material: diffuse (1,1,1,1), ambient (1,1,1,1), specular (0.5,0.5,0.5,0.5),
  power 160.9. The specular field placement is [inferred].
- Net effect: scenery gets L1 at the scene's ambient level from above. Creatures
  get L2 at full strength from above-behind, plus 0.5 ambient. The crab and
  sea star get L1 at full strength.

---

## 3. Fish (class vtable 0x45916c; update 0x415150; draw 0x416710)

### 3.1 Spawning (0x412450)

For each `<fish name=... value=N>` in `settings.xml` (the special names
`Anemone Crab`, `Sea Star` and `Sea Horse` are handled separately, see 4):

```
species = FISHES/<name>/settings.xml
scaleSetting  = scale * 0.1          speedSetting = speed * 0.1
aggression    = aggression * 0.1     school, behav as integers
if species.school && N > 1 && settings.schooling:
    N = N + 1                       -- one extra, invisible leader
leader = none
for i in 0..N-1:
    fish = new Fish(mesh = FISHES/<name>/mesh.X)
    fish.bounds = sceneBBox with min.y *= 0.8 and max.z *= 0.8
    fish.leader = leader
    if i == 0 and species.school and N > 1 and settings.schooling:
        fish.isLeader = true ; leader = fish       -- never drawn (0x416710 returns early)
    if (fish has a leader) or (not species.school):
        behav 2 -> add to "predators" list ; behav 0 -> add to "prey" list
```
[read]

Per-fish initial state [read]:

- `timeOffset` = (rand % 100) * 0.1 s. It is added to `t` for all of this
  fish's oscillators, and it also seeds the fin phase.
- `speedAnim` = 2.0.
- The speed state machine gets a random state and max duration 4.
- A **nav** object (0x4191a0) holds the swim zone, the zone mode and the
  avoidance history.
- `zoneMode` = rand & 1.
- Start pose (0x417d10), with `zone` = the mode's box (3.2):
  - x = zone.min.x + zone.w * (rand%80 + 1)%
  - y = zone.min.y + zone.h * (rand%60 + 20)%
  - z = zone.min.z + zone.d * 50%
  - yaw = (rand%100 + 1) * 2pi/100
  - pitch = (rand%100 + 1) * pi/400 - pi/8
  - Near the foreground plane (|z| < 0.25 * full depth), y is raised to at
    least the blended height line (3.5).

### 3.2 Swim zones (0x414770)

The nav keeps the fish's full bounds and a current zone. With `depth` = full
z extent and `H` = full y extent:

| mode | zone |
|---|---|
| 0 (near) | z in [min.z + 300, max.z - (0.5*depth + 750)] ; x, y = full |
| 1 (far)  | z in [min.z + 0.5*depth + 1250, max.z] ; y from min.y + 0.25*H ; x = full |

Scene 1, for example: fish bounds z in [-2149, 1155], so near = [-1849, -1247]
and far = [753, 1155]. The far zone is behind the foreground plane at z = 0.

A fish without a leader flips its mode when its timer (rand%120 + 10 s,
halved when entering mode 1) runs out. A follower copies its leader's mode
every frame. [read]

### 3.3 Speed

```
step = (speedAnim + 2) * speedSetting * dt / 150          (per frame)
```

`speedAnim` is driven by a 3-state machine (object at fish+0x260, 0x408af0 and
0x408b50):

```
every period (duration = rand%2 + 2, i.e. 2 or 3 s):
    state = rand % 3 ; start = t
u = min((t - start) / duration, 1) ; ease(u) = (1 - cos(pi*u)) / 2
state 1 (burst): speedAnim = max(speedAnim, 15 * ease(u))
state 2 (slow) : speedAnim = min(speedAnim, 15 * (1 - ease(u)))
state 0        : unchanged
```

Other code forces a state: the leader-distance rules (3.7) force state 1 or 2
for 1 s. Avoidance (3.8) forces state 2 with a random duration. [read]

### 3.4 Orientation and world matrix (0x415150)

The model's nose is local +X; heading = (cos yaw, 0, -sin yaw). Yaw only turns
about Y; pitch is a rotation about local Z. Each frame [read]:

```
A      = (speedAnim + 2) / 17
tt     = t + timeOffset
wobYaw = A * sin(5*tt) / 6
wobPit = -A * cos(2*tt) / 6
pos    = (posPrev + posNow) / 2                          (smooths corrections)
zf     = (bounds.max.z - z) / (bounds.max.z - bounds.min.z)  (1 = nearest, 0 = farthest)
dx     = (zf + 0.5) * step * 1000                        (forward distance this frame)
s      = scaleSetting * 0.8 + 0.4 * zf                   (depth-dependent size)
WORLD  = Scale(s) * Translate(dx,0,0) * RotZ(pitch + wobPit) * RotY(yaw + wobYaw) * Translate(pos)
pos    = translation row of WORLD (before the scale is applied)
```

- **The perspective look is faked** [read]. A fish at the near edge of the
  bounds is drawn 0.4 larger (additive) than at the far edge, and moves 3x as
  far per frame (factor 0.5 to 1.5).
- Pitch is smoothed: `pitch = (pitchPrev + pitch) / 2` each frame. A small
  inertia term re-applies half of the last change when nothing else moved it.
- The draw clamps `z >= bounds.min.z + 200`.
- A "pitch-locked" flag is set when the fish is in the bottom quarter of its
  bounds (`y < min.y + 0.25*(max.y - min.y)`) or is climbing over the reef
  line (3.5). While it is set, avoidance does not change pitch, and the usual
  decay is skipped. That decay is: if pitch > 0.7, pitch -= step. [read; a
  nested "pitch up in the band 0.1-0.25" branch is unreachable]

### 3.5 The sea floor and the reef line

Two polylines from the scene data are used as functions of x (0x417ae0: linear
interpolation, clamped to the end points). [read]

- **Crab_Path** (path.X, `Crab_Path`) is the **sea floor**. Its points are
  stored with `y = (bbox.min.y + 0.15*H) + p.y - 30`. Here `p` is the RAW
  vertex position in path.X: unlike the scene mesh.X, path.X is not
  transformed to world space, so its frame matrix (e.g. y +80.7 in scene 1) is
  ignored. [read] Each frame a fish's y is
  raised to at least `floor(x)`. Because of the position averaging this
  correction is soft.
- **height** (mesh.X, mesh `height`, 7-8 points) is read RAW, like Crab_Path
  (see §10.1): its frame matrix is ignored, and every raw vertex has y = 0, so
  **height(x) = 0 for every x in all three scenes** [read]. It is not the drawn
  reef edge (the frame matrix would put it there). Near the foreground plane
  (`|z| < lim`, `lim = 0.25 * depth`) a fish must be above
  `lerp(zone.min.y, height(x), sin((1 - |z|/lim) * pi/2))`. If it is below:
  - pitch += 7*step (up to 0.9)
  - a fish currently behind the plane is held at z >= +100; one in front is
    held at z <= -100

  So fish can only pass through the foreground plane above world y = 0: the
  screen's middle row in scenes 1 and 3, and below the whole tank in scene 2
  (bbox y from 3.2), where the rule never binds.

### 3.6 Staying in the zone (0x417c60, 0x4188c0)

The zone test reports the first violated side.

| side | reaction |
|---|---|
| below (y < min) | pitch += 5*step while pitch < 0.2 |
| above (y > max) | pitch -= 5*step while pitch > -0.2 |
| x or z wall | turn toward the zone centre |

Turning toward the centre:

```
if targetTurn == 0:
    targetTurn = signed angle between heading and (centre - pos), in XZ
if |targetTurn| > 0.1:
    d = 10 * step * ease(min(|targetTurn|, 1)) * ease(min(t - turnStart, 1))
    move yaw and targetTurn toward zero by d
```

Back inside the zone, the turn resets (turnStart = t, targetTurn = 0).
Additionally, a timer resets the turn target every 2 s. [read]

### 3.7 Schooling (followers of a leader)

The leader is invisible and swims with the normal rules; followers track it.
[read]

```
band = [(100,300), (200,400), (300,500)][rand % 3]     -- per follower
       re-rolled while floor(t) mod 10 == 9            [inferred: operand is t]
d = distance(follower, leader)
if d > band.far  and state != 1: force state 1 (burst) for 1 s
if d < band.near and state != 2: force state 2 (slow) for 1 s
every 0.3 s: a = signed XZ angle(heading, leader.pos - pos)
             if |a| > 1/17: start a turn of a (same eased turn as 3.6)
if follower.y < leader.y and pitch < 0.4:  pitch += step
if follower.y > leader.y and pitch > -0.4: pitch -= step
```

The turn toward the leader is applied only while the follower is gated by the
wobble phase. Right turns happen when `-cos(5 tt) > 0.3`, left turns when
`-cos(5 tt) < -0.3`, so turns come in pulses synchronised with the tail beat.
[read]

With `schooling = 0` in settings.xml, no leader is created and every fish is
independent.

### 3.8 Avoidance between creatures (0x416fb0, 0x404d40, 0x403540)

```
probe = point one mesh-radius*scale ahead of my nose (world space)
sum = 0
for each creature c (skipping only a leader when it is c itself):
    R = 3.2 * c.scaleSetting * c.meshRadius                  (2*size + 1.2*size)
    if c.aggression is higher than the recorded comparison: R *= 1.2
    if lower: R = 0                                         [comparison operands: inferred]
    w = max(0, (R^2 - |probe - c.pos|^2) / R^2)
    sum += normalize(myPos - c.pos) * w
if |sum|^2 > 1e-4: force state 2 (slow down, random duration)
nav.avoid = (sum != 0) ; push sum into a ring buffer (keeps the last ~10)
```

In the update, while `nav.avoid`:

- force state 1 (burst) for 1 s
- `dir` = the average of the ring buffer
- pos += dir * step * 1500
- pitch moves toward the sign of dir.y at 3*step*ease (limit +-0.6)
- the yaw target becomes the XZ angle to dir

Leaders never avoid. [read]

### 3.9 Predator / prey (behav) (0x411db0)

Every 10 s, each fish of a behav-2 species (Clown Trigger) has a 20% chance
(`rand%10 >= 8`) to take the **nearest behav-0 fish** (Percula Clown) as its
leader. It then chases that fish with the schooling rules. Otherwise its
leader is cleared. behav 1 (all other species) has no special behaviour.
[read]

### 3.10 Mesh animation (0x414f10, 0x414d80, 0x4145f0, 0x403ab0)

Each frame the working mesh is reset from the pristine `center` pose. The
following vertex edits are then applied in order. `ph` is a per-fish phase
that starts at `timeOffset` and gains `2*step` per frame. [read]

1. **Tail ripple.** Applies to the vertices of the material group whose name
   contains `_tail`, using that group's x/y extent in the center pose:
   `u = (maxX - x)/(maxX - minX)`, `h = maxY - minY`,
   `d = u^2 * 0.025*h * sin(3*(maxY - y)/h + 5*tt)`; then `z += d`,
   `x += d/2`, and the normal is nudged by `(d/6, 0, d)` and renormalised.
2. **Gills.** The material group `gills` is blended between poses with
   `w = sin(10*ph)`: w > 0 lerps center to `opened`, w < 0 lerps center to
   `closed` by |w|. Positions and normals are blended.
3. **Fins.** The group `fin_left` uses `w = sin(25*ph/speedSetting)` and
   `fin_right` uses `w = cos(25*ph/speedSetting)`, with the same pose blend.
   So the opened/center/closed pose meshes are only ever used for these three
   material subsets, never as a whole-body morph.
4. **Body bend** (all vertices). With `k = (speedAnim+6) *
   clamp(-cos(5*tt)*(speedAnim+2)/17, -1, 1) / 21` (magnitude clamped to at
   least 1e-4) and `R = 250/k`, the mesh is bent around a vertical axis:
   `x' = sin(x/R)*(R - z)`, `z' = R - cos(x/R)*(R - z)`. This is the swimming
   undulation. It is small at cruising speed and about 0.2 rad at the tail at
   full burst.
5. **Eyes.** The `LeftEye`/`RightEye` frames are redrawn with their own
   matrices. Each eye yaws to a random target `(3 - rand%6)*0.1` rad, re-chosen
   every `(rand%20)/15` s, minus the local bend angle, so the eyes stay steady
   while the body bends.

### 3.11 Fish rendering (0x416710)

- Skipped for invisible leaders. [read]
- Pass 1 [read]:
  - `ALPHABLENDENABLE = 1`, `SRCBLEND = SRCALPHA`, `DESTBLEND = INVSRCALPHA`
  - stage 0: `COLOR = TEXTURE * DIFFUSE` (lit), `ALPHA = TEXTURE`
  - the texture is the species texture named in its material
- The eyes are drawn next, with the same states and their own matrices.
- **causticonfish** (per-creature flag at +4) adds a second additive pass over
  the body and the eyes (0x403660, 0x406050) [read]:
  - `SRC = ONE`, `DEST = ONE`
  - ambient 0x10101010
  - the fog colour is saved and restored around the pass
  - texture = the scene's current caustic frame (picked by `t + timeOffset`,
    see 7)
  - UVs are recomputed every frame from world position: `u = worldZ*0.01`,
    `v = worldX*0.01`. This is a planar projection straight down, one tile per
    100 units.
- Afterwards: ambient back to 0x80808080, SRCALPHA/INVSRCALPHA, alpha blending
  off, specular off.
- **Depth fog** (only when the `foreground` setting is 1) [read]:
  - Linear vertex fog (`FOGENABLE = 1`, `LIGHTSTATE_FOGMODE = LINEAR`).
  - Colour = the scene's clear colour (2.3).
  - Starts at world z = 0 (eye distance `2000 - bbox.min.z`) and is total at
    world z = `2*bbox.max.z` (eye distance `2*bbox.max.z - bbox.min.z + 2000`).
  - A fish is clear in front of the foreground plane and fades into the water
    colour behind it; at the Background plane it is about 50% fogged.

---

## 4. Crab, sea star, sea horse

### Shared helpers

- **Mood timer** [read] (the same object as the fish speed machine, 3.3): it
  holds start, duration, maximum duration and mode.
  - Every `duration` seconds it rolls `mode = rand()%3` and a new
    `duration = rand()%(max/2) + max/2` (whole seconds).
  - mode 1 eases the speed up to the top value; mode 2 eases it down to 0;
    mode 0 holds it.
  - Easing: `easeIn(p) = (sin(p*pi - pi/2) + 1)/2`; `easeOut = 1 - easeIn`.
- **Path spline** [read]: a Catmull-Rom curve over a sliding 4-point window of
  the Crab_Path points (sorted by x at load).
  - When the parameter u leaves [0,1], the list rotates by one point, and u
    wraps (sea star) or resets to 0 or 1 (crab).
  - The turn rules below keep each walker inside its own x range.
- **Creature caustic pass** for the crab and sea star (0x40a7a0, 0x420970),
  only when `caustic` and `foreground` are both on [read]:
  - blend ONE/ONE; ambient 0x10101010; fog colour 0
  - texture = caustic frame by `t` (5.4)
  - UVs per vertex: `u = worldZ*0.0025 - dt*0.5/6`, `v = worldX*0.0025 - dt*0.5`
    (the fish use 0.01, see 3.11)
  - the mesh's own UVs are restored afterwards

### 4.1 Anemone crab (CCrab; update 0x409d00; draw 0x40ab70; load 0x40b120)

- **Spawn and data** [read]:
  - At most one crab, spawned if the `Anemone Crab` value is > 0.
  - Meshes: `full_mesh.X` (drawn mesh `Anemone_Crab07`) and `mesh.X`
    (12 walk poses `Anemone_Crab01..12`).
  - Path: Crab_Path with `y = raw.y + bbox.min.y + 0.15*H - 80`,
    `z = bbox.min.z`, starting at sorted point 4.
- **Speed** [read]: from the mood timer with top = 1, starting at 4.0. The
  timer's first duration is uninitialised; treat it as expiring at once
  [unknown]. Below 0.05 the crab stands still.
- **Walking** [read]:
  - It starts walking toward -x.
  - `step = dt * speed * 0.5`; u moves by +step or -step with the direction.
  - It turns at `x <= bbox.min.x + 350` or `x >= bbox.min.x + 0.7*W - 250`
    (about -540 to +106 in every scene), and also every rand()%100 s.
  - A turn forces a 4 s ease-down, then flips the direction.
- **Orientation** [read]: the crab always faces +x (the path tangent toward
  increasing u) and walks sideways and backwards. Its frame is built from the
  tangent and world down, then rolled -18 deg (RotZ(-pi/10)) so its back tilts
  toward the camera. It is not scaled.
- **Walk cycle** [read]:
  - `phase += step * (+2.5 or -2.5)`.
  - The drawn pose is a linear blend (positions only) of pose
    `int(phase)%12 + 1` and the next pose, by the fractional part of `phase`.
  - That is 1.25 frames/s at speed 1, and it plays backwards when walking
    toward -x.
- **Shadow** [read]:
  - A 200x200 `shadow.dds` quad in crab space at local y =
    `3*sin(phase) - 10`, colour white.
  - Colour = texture; alpha = texture*diffuse; SRCALPHA/INVSRCALPHA; Z off.
  - It is drawn before the body.
- Debug: the Up-arrow key flips the direction.
- Drawn after scene pass 1 and before the Z clear, so fish in front cover it.

### 4.2 Sea star (CSeaStar; update 0x420260; draw 0x420c90; load 0x420db0)

- **Spawn** [read]: at most one. It walks the same seabed line, restricted to
  x in [bbox.min.x + 0.7*W, bbox.max.x].
- **Motion** [read]:
  - `u` changes by `0.025*dt`, about 40 s per path segment.
  - It reverses instantly 50 units inside either end.
  - It spins about its own Y at 0.025 rad/s from a random multiple of 10 deg.
- **Arms** [read]: 5 arms, found as the material groups
  `SNFMat_Top<n>`/`SNFMat_Bottom<n>`.
  - Each arm i uses `s = sin(0.2*t + i*pi/4)`.
  - Each vertex gets weight `w = max(0, |v|^2/diag^2 - 0.4)`.
  - The vertex is lifted by `w*|5s|` and rotated about Y by `w*0.5s`.
  - So the arm tips slowly curl and sway, on a 31 s cycle.
- **Two variants**, chosen once with `rand()%10 > 5` (40% on glass) [read]:
  - **floor** (60%): rolled -18 deg like the crab. The whole file is drawn,
    including the `Sea_Star_Shadow` mesh. It draws right after the crab.
  - **glass** (40%): rolled +90 deg so the underside
    (`sea_star_down_diffuse`) faces the viewer, and lifted +100 in y. Only the
    `Sea_Star` frame is drawn (no shadow). It draws **last**, after a Z clear,
    over everything including front fish.

### 4.3 Sea horse (CSeaHorse, vtable 0x4596a8; update 0x41f540; draw 0x41f7f0)

- **Spawn** [read]:
  - N sea horses, placed in the normal creature list (so they get the
    front/back split, sorting and avoidance).
  - Box: (min.x, 0.8*min.y, min.z) to (max.x, max.y, 0.8*max.z).
  - They use the same navigator as the fish (3.2-3.6).
- **Speed** [read]:
  - P runs from 0 to 15 (the mood timer with top 15, on the sea horse's own
    clock, starting at P = 1).
  - `k = dt/(25 - P)`; the navigator advances by `6k`; the own clock
    advances by `2k`.
- **Sway** [read]:
  - `a = 12*phase`, with `phase += k`.
  - Body yaw = `cos(a)/3 - pi/2`.
  - Pose: blend center->`left` by `-sin a` when sin a <= 0, otherwise
    center->`right` by `sin a`.
  - Period `2pi(25-P)/12`: 13 s when slow, 5.2 s when fast.
- **Depth scale** [read]: uniform
  `0.6 + 0.4*(box.max.z - z)/(box.max.z - box.min.z)`.
- **Floor** [read]: y >= box.min.y + 0.1*box height.
- **Avoidance** forces a slow-down. **Fog** is as for fish, but the colour is
  read from a field that is never set [unknown; probably black].

---

## 5. Scenery and effects (scene object: ctor 0x41d180, load 0x41ecc0, update 0x41bca0, draw 0x41ce30)

### 5.1 Settings that gate scenery [read]

| setting | effect |
|---|---|
| `water` | water surface |
| `background` | Background plane |
| `foreground` | Foreground plane in pass 1 (else pass 0), enables the whole of pass 1, and fish fog |
| `bubles` | bubbles |
| `plantsmoving` | billboard animation |
| `caustic` | Relief caustics; crab and star caustics (needs `foreground` too) |
| `causticonfish` | fish and sea-horse caustic pass |
| `volume` | the **light rays** (not sound volume) |
| `sound` | ambient loop |

- Texture filtering: stages 0 and 1 use linear MAG, linear MIN and linear
  MIP (trilinear).
- The Background and Foreground tiles CLAMP in U and V.

### 5.2 Painted planes [read]

- Drawn as lit meshes, but with the ambient light state forced to 0xFFFFFFFF,
  so they come out full-bright (texture colour).
- Subsets whose material alpha is not 1.0 (the 0.9 `*_slice` tiles) alpha-blend
  with SRCALPHA/INVSRCALPHA. Colour = texture*diffuse, alpha = texture alpha.
- Z is off, so draw order alone decides visibility.

### 5.3 Billboards (plants and anemones; build 0x41dc90; classes 0x417240, 0x417660, 0x402460, 0x402260)

- **Quad** [read]: built from the named frame's **world bounding box**.
  - Corners: (minx,miny)/(0,1), (minx,maxy)/(0,0), (maxx,maxy)/(1,0),
    (maxx,miny)/(1,1), all at z = minz.
  - Vertex colour white; unlit.
- **Layers** [read]: layer "-0" is drawn first and "-1" on top, both full
  opacity, as 4-vertex fans.
  - Colour = texture; alpha = texture*diffuse; SRCALPHA/INVSRCALPHA; Z off.
- **Order** [read]: sorted by z, far first. Billboards with z >= 0 draw
  before the Foreground plane, those with z < 0 after it.
- **Texture table and hard-coded offsets** [read]:

| scene | frame | layer -0 / -1 | class | offset applied in code |
|---|---|---|---|---|
| 1 | great_plant | 4.dds / 3.dds | A | none |
| 1 | green_plant | 1.dds / 2.dds | B | **x + 100** (= 58.7 px right) |
| 1 | anemone_0 | anemone_1_0 / anemone_1_1 | C | none |
| 1 | anemone_1 | anemone_2_0 / anemone_2_1 | C | none |
| 2 | flowers | Flowers-0 / -1 | C | none |
| 2 | red_grass | Red Grass-0 / -1 | A | none |
| 2 | anemone | SpondeGreen-0 / -1 | C | none |
| 2 | high_grass | High Grass-0 / -1 | A | **top edge + 100** |
| 3 | yellow_grass | YellowGrass-0 / -1 | A | **x - 150** |
| 3 | anemon_1 | Anemone-0 / -1 | D | none |
| 3 | anemon_02 | Blue anemones-0 / -1 | B | **x + 200** |

- **Animation** (only when `plantsmoving` = 1; `s = sin t`, `c = cos t`,
  absolute time) [read]:
  - **A**: layer -0: top-left x += 10cs, top-right x -= 10s^2. Layer -1:
    the opposite signs. The top edge shears by up to about 6 px, period
    pi s, with the layers moving against each other.
  - **B**: layer -0 shears by 5cs / 5s^2; layer -1 by 10cs / 10s^2 in the
    opposite direction. Then layer -0's top corners are rotated about the
    **world origin** by Rx(cos(0.1t)/60) and Rz(sin(0.1t)/60), and layer
    -1's top-right corner by Rx(-cos(0.1t)/60). Because green_plant sits at
    z = -1967, the Rx term lifts its top by up to about 33 units (19 px)
    over a 63 s cycle. This is the likely cause of the measured "14 px up".
    [inferred]
  - **C**: layer -1 is shifted by about 0.5% of its width.
    - Its alpha is multiplied on stage 1 by `mask.dds`, using a second UV set
      offset by `(0.1 sin p, 0.1 cos p)`, where p = t + per-plant phase: one
      circle per 2pi s.
    - Only scene 1 ships `mask.dds`. [read; UV terms inferred from x87 stack
      tracking]
  - **D**: layer -0 shears by 5cs / 5s^2; all four corners of layer -1 shear
    by 10cs / 10s^2.
  - The research notes measured the billboards as static over 34 s. The code
    clearly moves them when `plantsmoving` = 1 (the install's value), so
    either that capture ran with it off, or the motion (a shear of a few px at
    the top corners, a slow tilt) was missed. Worth re-measuring.

### 5.4 Caustics on the Relief [read]

- The caustic animation preloads `caustics_01..29.dds`. The frame is
  `caustics_{floor(t*18) mod 29 + 1}`: **18 fps**, a 1.61 s loop.
  - The Relief/water use the scene's `t`.
  - Each creature uses its own clock: fish use `t + timeOffset`.
  - `caustics_00` / `caust00` in the .X files is never loaded; the code
    substitutes the current frame.
- The Relief is drawn **only** as an additive light pass, right after the
  Foreground plane:
  - Texture = caustic frame × vertex lighting (L1, straight down, at the
    scene ambient level). Ambient state 0.
  - ONE/ONE, Z off.
- Relief UVs scroll each frame: `v -= 0.5*dt`, `u -= 0.5*dt/6`. When any
  coordinate drops below -10, 10 is added to all of them.

### 5.5 Water surface (0x41c300) [read]

- WORLD = Scale(19, 15, 18) then Translate(0, bbox.max.y - 200, bbox.max.z).
  The mesh is a pre-distorted trapezoid:
  - the near row is wide and high; the far row is narrow and low
  - UVs tile 4 across and 3 deep (v runs 1 to -2), x mirrored
- Texture = the current caustic frame, WRAP; ONE/ONE additive;
  colour = texture*diffuse (lit, white material); Z off.
- **Vertex fog to black**, linear:
  - `fogStart = 0.8*(depth + 1000) + 1500`, `fogEnd = depth + 2500`, with
    `depth = bbox.max.z - bbox.min.z`
  - Brightness falls from 100% at the top of the screen to about 7% at the
    horizon row, which lands 116-127 px from the top in scene 1
  - This is the "faint horizon line"
- The exact diffuse level while it draws (ambient probably 0x80808080 + L1)
  is [inferred].

### 5.6 Light rays (`volume` setting; 0x41c6e0) [read]

- `ray.X` is loaded but not used. The rays are 9 procedural triangles,
  drawn additively with `ray.dds` in one list.
  - Local triangle: apex (0,0,0) uv (0.5,0); base (±200, -1200, 0) uv (1,1)/(0,1).
  - Render states: ONE/ONE; ambient 0x80808080; clamp; Z off.
- For ray i = 0..8: `th = i*40deg + t/55` (one revolution per 345.6 s).
  - WORLD = RotX(-6deg), then RotZ(0.5 sin th), then Translate(
    (bbox.max.x - 100)*sin th, bbox.max.y + 150 - 40 cos th, bbox.max.z).
  - Rays at the sides lean outward. The apexes sit above the top of the
    screen, and the rays reach about 2/3 of the way down.
- Brightness: vertex grey `floor(51*|cos(2t + th/2)|)`, i.e. at most 20% of
  the texture, flickering.

### 5.7 Bubbles (init 0x4086f0; respawn 0x407120; update 0x407350; draw 0x407a10) [read]

- One emitter per scene, 500 particles, with 10 s pre-simulated at init.
  - Emitter x = -300 in scenes 1 and 2, +420 in scene 3.
  - Base y = bbox.min.y; z = 1000 (behind the Foreground plane).
- Each (re)spawn:

  | field | value |
  |---|---|
  | x | x0 - 50 + 10*(rand%10) |
  | speed | 80 + rand%200 |
  | size | 0.8 + 0.04*(rand%10) |
  | helix radius | 5 (70%) or 30 + rand%20 (30%) |
  | spin direction | rand&1 |
  | phase | 2pi/(rand%10); this divides by 0 in 10% of cases, and those bubbles never show [inferred] |

- Rise: `rise += 0.5*speed*dt`, i.e. 40-140 units/s. A bubble respawns
  once it passes bbox.max.y.
- Drawn as 1 copy, or 3 trailing copies when the radius is >= 10. For copy
  k = 0, 1, 2:
  - `a = ±0.05*(rise + phase - 0.2*k*speed)`
  - position = `(x + r cos a, min.y + rise, 1000 + r sin a)`, a helix
  - scale = `size*(3-k)/6 + 0.5*(y - min.y)/H`, so bubbles grow as they rise
  - quad 10.2 x 10.2 units (anchored at the bottom), `BUBBLE.dds`
- Render states: SRCALPHA/INVSRCALPHA, colour = texture, alpha = texture
  alpha. **Z test and write on**, so back fish hide them. Drawn first in pass
  1, so the Foreground painting and billboards cover them.

### 5.8 Light motes (this+0x700; spawn 0x406e10; update 0x406fb0/0x408290; draw 0x407620) [read]

A feature missing from the handbook, and always on.

- Up to 40 `light.dds` sprites in the box: x across the full width;
  y from min.y + 0.2H to max.y; z in the front half, min.z to
  min.z + depth/2.
- Each mote drifts linearly between two random box points on a tenths grid,
  with `u += dt*0.02*spd` (spd 1.0-1.9), a life of 26-50 s.
  - Size 0.5-0.95 of a 10.2-unit quad.
  - While fewer than 10 exist, one spawns per frame (starting at u = 0.2);
    after that, one spawns every rand%5 s up to 40.
- Look:
  - Colour = texture + TFACTOR; TFACTOR is white on a random 50% of frames,
    otherwise black (twinkle).
  - Alpha = texture*TFACTOR.a: a fade-in over the first 10% of life, then
    0.9-1.0 flicker (`|sin 100u|`), then a fade-out.
  - Linear fog from 0 to 3500 in eye space, toward light blue 0xFF99D0FE, so
    most motes are pale blue.

### 5.9 Scene selection (0x411a50) [read]

- `index` 1-3 picks that scene.
- `index` 0 does **not** rotate during a session. At startup the saver:
  1. reads DWORD `SceneIndex` from
     `HKLM\Software\Triodesign\Living Marine Aquarium 2.0` (default 0)
  2. writes back `(old + 1) % 3`
  3. uses scene `new + 1`

  So the scene advances by one per launch, 1→2→3→1. There is no transition
  and no timer.

### 5.10 Sound (0x413a67) [read]

`Sound_undwater.ogg` is played looping at volume argument 100 (through the
bundled Ogg decoder and DirectSound) when `sound` = 1. It is the same file
for every scene.

---

## 6. Feature inventory (everything the binary implements)

Rendering and camera
1. Single orthographic camera from the scene bbox, 0.98 zoom, eye x = 0 (1)
2. Per-scene clear colour and ambient level (2.3)
3. Two directional lights re-levelled per pass, 0.5 ambient, specular material (2.4)
4. Two-pass scenery with creatures sandwiched between and two Z-only clears (2.2)
5. Trilinear filtering; clamped painted tiles (5.1)

Scenery
6. Background and Foreground painted planes, full-bright, 0.9-alpha tiles (5.2)
7. Billboards: bbox quads, two stacked layers, sorted and split around the foreground plane (5.3)
8. Billboard animation classes A-D (shear, world-origin tilt, mask shimmer), gated by `plantsmoving` (5.3)
9. Hard-coded billboard offsets: green_plant x+100, high_grass top+100, yellow_grass x-150, anemon_02 x+200 (5.3)
10. Relief = additive caustic light pass, 18 fps x 29 frames, UV scroll (5.4)
11. Water surface: pre-distorted mesh, additive caustic texture, fog to black toward the horizon (5.5)
12. Light-ray ring: 9 procedural additive rays, slow rotation, flicker (`volume`) (5.6)
13. Bubbles: 500 helical particles, one emitter per scene, growth with height, trails (5.7)
14. Light motes: up to 40 drifting, twinkling, fogged sprites (5.8)

Fish
15. Species settings: scale/speed/aggression x0.1; school; behav (3.1)
16. Invisible schooling leader plus followers with distance bands; `schooling` toggle (3.1, 3.7)
17. Near and far swim zones with timed migration across the foreground plane (3.2)
18. Speed mood machine (burst / slow / hold, cosine easing) (3.3)
19. Fake perspective: depth-dependent size (+0.4) and speed (x0.5-1.5) (3.4)
20. Yaw/pitch wobble tied to speed; position and pitch smoothing (3.4)
21. Sea floor = Crab_Path; reef silhouette = height, which gates crossing the plane (3.5)
22. Zone-edge steering with eased turns; pitch limits (3.6)
23. Aggression-weighted avoidance between all creatures (3.8)
24. Predator (behav 2) occasionally chases the nearest prey (behav 0) (3.9)
25. Mesh animation: tail ripple, gill and fin pose blends, whole-body bend, eye swivel (3.10)
26. Per-frame front/back layer by z, painter's sort (2.1)
27. Caustics on fish (additive, planar UVs x0.01, own clock) (3.11)
28. Depth fog toward the water colour when `foreground` is on (3.11)

Other creatures
29. Crab: seabed spline walk, speed moods, edge and timed turns, 12-pose walk blend, -18 deg tilt, bobbing shadow, caustics (4.1)
30. Sea star: slow crawl and spin, 5-arm curl, floor or glass variant (glass drawn over everything) (4.2)
31. Sea horse: navigator, sway yaw and left/right pose blend, depth scale 0.6-1.0, floor clamp (4.3)

Application
32. Scene advances once per launch via registry `SceneIndex` when `index` = 0 (5.9)
33. Looping ambient sound (5.10)
34. Exit on key, mouse button, or a 121 px mouse move; cursor hidden (0)

---

## 7. Not recovered / open questions

- **The ~0.8 px vertical residual** is not a camera constant.
  Half-pixel-centre convention is the likely cause. [inferred]
- **The avoidance aggression comparison**: which two values are compared is
  unclear, because it goes through virtual getters and a field written during
  the loop. The x1.2 / x0 effect is read; its operands are [inferred].
- **The crab's first mood duration** is uninitialised memory; treat it as
  expiring immediately. [unknown]
- **The sea horse's fog colour** is read from a never-written field
  (probably 0, black). [unknown]
- **The water surface's exact diffuse level**: the lighting at that moment
  and the mesh normals were not evaluated numerically. [inferred]
- **The fish follower band re-roll condition** (`floor(value) mod 10 == 9`):
  the value's source on the FPU stack is [inferred] to be the time.
- **The sound volume mapping** of the `volume`/`sound` settings; `volume`
  itself drives the light rays. The DirectSound volume argument is a
  constant 100.
- **Loaded or built but unused**: `ray.X`, the texture name
  `caust00`/`caustics_00`, the perspective matrix at this+0x580, and a 4 s
  WM_CLOSE timer in a base-class code path the LMA path does not take. (The
  scene-3 `Anemone-*` and `Blue anemones-*` textures ARE used; see 5.3.)

---

## 8. Addendum: scenery cross-check (second decomp pass)

A second, independent pass over the scenery and effects code (sections 2 and 5)
agrees with everything above. Below are only the corrections and the details
the sections above leave out.

- **Fish ambient is 0xAAAAAAAA, not 0.5** [read]. Right before the body is
  drawn, the fish draw (0x416710, at 0x41691d) sets `LIGHTSTATE_AMBIENT =
  0xAAAAAAAA` (about 0.67 grey) and `SPECULARENABLE = 1`. It restores
  0x80808080 and specular off afterwards (3.11). So the "0.5 ambient" in 2.4
  holds for scenery but not for fish bodies. Just before this, the same function
  draws a small unlit triangle list (FVF 0x1E2). Its purpose was not examined.
- **Billboard class D, exact corners** (0x402260) [read]. Layer -0: top-left
  x += 5cs, top-right x -= 5s². Layer -1: bottom-left x -= 10cs, top-left
  x += 10cs, top-right x -= 10s², bottom-right x += 10s². The layer -1 quad
  therefore rocks as a parallelogram about its middle.
- **Billboard class A clamps** U and V (`ADDRESSU/V = CLAMP`); classes B, C and
  D leave WRAP. [read]
- **Billboard class C phase** [read]. The per-plant phase starts at
  `(rand%20)*0.1` and gains `2*dt` each frame. The mask offset uses half of it,
  so `p = t + phase0/2`. The layer -1 x shift is `int(width)*0.005`
  (truncated), with no time dependence.
- **Water surface rows on screen, scene 1** [read + computed]. The nine mesh
  rows (local z = -24 … +24) land at about -7, 32, 65, 91, 110, 122, 127, 125
  and 116 px from the top. The fog factor per row is
  `clamp((500 - 18*z_local) / (0.2*depth + 200), 0, 1)`, with depth =
  bbox.max.z - bbox.min.z. That is 1.0 at the top row and 0.074 at the
  horizon row in scene 1.
- **Bubble start-up artefact** [read]. At init, each bubble's `rise` is
  `bbox.min.y + (rand%10)*H/10` instead of `(rand%10)*H/10`. That puts the
  initial particles below the floor before the 10 s pre-simulation, which
  hides the effect. The respawn test uses `bbox.min.y + rise > bbox.max.y`.
- **Light-mote fade-out** [inferred]. For `u >= 0.9` the alpha is computed as
  `(0.9 - u)*10*255` and truncated to a byte. The result is negative, so the
  low byte wraps: there is a one-frame pop, then a descending ramp. A rebuild
  can use a plain linear fade-out.
- **Registry failure** [read]. If `SceneIndex` cannot be written, the index
  function returns 0. The code then uses the out-of-range defaults (colour 0,
  level 0.3), and loading `SCENES/0` fails.

## 9. Addendum: crab, sea star and sea horse cross-check

A second pass over section 4 (crab, sea star, sea horse), from separate
notes. Section 4 agrees with it. These are the details it leaves out, plus
one open point.

### Caustic UV scale on creatures (two different constants) [read]

| creatures | pass | UV rule | constant | read at |
|---|---|---|---|---|
| crab | 0x408cc0 | `u = z*0.0025 - (dt*0.5)/6`, `v = x*0.0025 - dt*0.5` | 0.0025 at 0x458948 | `fmul` at 0x408d5d and 0x408d75 (the 1/6 is at 0x4588f8, used at 0x408cf3) |
| sea star | 0x41fad0 | same | 0.0025 at 0x458948 | `fmul` at 0x41fb6d and 0x41fb85 (1/6 at 0x41fb05) |
| fish and **sea horse** | 0x403660 | `u = z*0.01`, `v = x*0.01` | 0.01 at 0x458568 | `fmul` at 0x4036ed and 0x403701 |

- The crab and sea star tile the caustic texture every 400 world units; the
  fish and the sea horse tile it every 100.
- The sea horse draws through the fish caustic routine (0x41f7f0 calls
  0x403660), so it uses 0.01, not 0.0025.

### Mood timer durations actually rolled [read]

- A duration is `rand()%(max/2) + max/2` in whole units.
  - crab: max = 5, so 2 or 3 s
  - sea horse: max = 4, so 2 or 3 units of its own clock
- The sea horse clock advances `2*dt/(25-P)`, so one mood lasts about 10 s
  (fast, P = 15) to about 37 s (slow, P = 0) of real time.

### Crab details [read]

- **Turn gating:** an edge turn starts only when no turn is already running.
- **When the walk stops:** if `step == 0` (speed < 0.05), the whole
  position/orientation update is skipped that frame. The walk-phase update
  still runs, but with a zero step.
- **Orientation frame:** built from the path tangent and world down, rows
  `[right, up, f, position]`:
  - `f = normalize(forward)`
  - `right = normalize(f x (0,-1,0))`
  - `up = right x f`
- **Shadow quad:** a 4-vertex TRIANGLEFAN of D3DLVERTEX (FVF 0x1e2). Corners
  (+-100, s, +-100) with UVs:
  - (-100,-100) -> (0,1)
  - (-100,+100) -> (0,0)
  - (+100,+100) -> (1,0)
  - (+100,-100) -> (1,1)
- **Walk-phase wrap:** when the phase goes below 0, 110000 is added (0x458974).

### Sea star details [read]

- **Tangent:** a finite difference of the spline at u +- 0.005 (0x4584c8),
  taken in the direction of travel. The frame is built as for the crab.
- **Path window:** at load the sorted path list is rotated until the first
  window point lies in [min.x + 0.7*W, max.x].
- **Glass variant:** the +100 in y is added to the freshly rebuilt frame's
  translation (matrix _42) each frame, so it does not accumulate.
  Order: +100 is added, then the roll RotZ(+pi/2) and the spin RotY are
  applied.
- **Arm vertices:** a vertex is deformed only while it still equals the
  pristine copy (tolerance 1e-5). The mesh is restored from the pristine copy
  at the start of every update.

### Sea horse details [read]

- **Pose morph:** blends normals as well as positions (0x403ab0).
- **Steer (0x41fa30):** a non-zero avoidance vector (|v|^2 > 1e-4) forces a
  slow-down. The mood start is stamped with the sway phase (+0x68) instead of
  its own clock (+0xa4); this looks like a bug.
- **Navigator pre-simulation:** at init the navigator pre-simulates
  `rand()%45 + 10` steps from the box centre (0x4191a0).
- **Fog colour table:** the fog colour switch at 0x41f835 reads field +0x84.
  - No sea-horse code path writes +0x84, which confirms the [unknown] in 4.3.
  - Its table is 1 -> 0xff00cbfd, 2 -> 0xff008aff, 3 -> 0xff036ed6. Scenes 1
    and 2 are swapped compared with the fish table (0x416783, which reads the
    scene index at fish+0x150 and matches the clear colours).
  - So even a correctly initialised field would give the wrong fog colour in
    scenes 1 and 2. Rebuild: use the scene clear colour, as for the fish.

### One point to re-check (fish floor, 3.5) [inferred]

- In 0x415150 the fish's y is saved, raised to at least the Crab_Path floor
  (via 0x417220), and later restored along with x and z (the stores back to
  +0xc4/+0xc8/+0xcc near the end of the orientation block).
- The clamp may therefore only affect the pose and steering computed in
  between, not the stored position. Section 3.5 describes it as a soft
  per-frame raise. Whoever owns fish motion should confirm which values are
  written back.

## 10. Addendum: randomness, the reef line and other settled points (third decomp pass)

Everything here was read instruction by instruction unless tagged. The port
(src/tank.ts, src/fish.ts, src/motes.ts) follows it.

### 10.1 RNG: seeded from the clock, once [read]

- `srand` (0x4455c6, stores the per-thread `_holdrand`) has ONE call site,
  0x412483, at the top of scene init: `srand(GetTickCount())`.
- `rand` (0x4455d3) is the MSVC CRT one: `h = h*214013 + 2531011; return
  (h >> 16) & 0x7fff`. There are 35 direct call sites plus 24 through
  `rand() % n` (0x417be0). No other generator exists. All calls run on the
  main thread.
- So the initial state is a pure function of the tick count at launch, which
  nobody records: per-launch randomness is irreducible. After the first frame
  the sequence also depends on frame timing (the mote draw 0x4078ba calls
  rand() once per mote per frame; bubbles re-spawn, moods re-roll and eyes
  re-aim on time), so even a known seed would not replay a run.
- Startup order of rand() calls:
  1. scene load: each class-C plant's mask phase, `rand()%20` (0x417070);
  2. each `<fish>` element of settings.xml, IN FILE ORDER:
     - crab: turn timer `rand()%100` (0x40b030);
     - sea star: glass `rand()%10` (0x4210e0), spin `rand()%36` (0x420db0);
     - sea horse: its navigator only (0x4191a0);
     - fish: constructor 0x416400 draws front `rand()%2`, band `rand()%3`,
       zone timer `rand()%120`; load 0x414860 draws time offset `rand()%100`,
       then the navigator, the start pose `%80 %60 %100 %100` (0x417d10) and
       the mood state `rand()%3`;
  3. motes and bubbles (0x407530, 0x4084d0, 0x4086f0: 500 re-spawns of 7
     calls each, plus the 10 s pre-simulation);
  4. the predator roll (0x411db0).
- Navigator (0x4191a0): `rand()%2` mode, `%120` timer, one discarded call,
  `%20` spline u, `%45` pre-simulation steps (each step draws a variable
  number), then `%3`, `%3`.
- The port offers `?seed=N` / `--crt` (the exact generator, and the tank's
  own calls in this order). It cannot reproduce a launch: plants, bubbles and
  motes use their own streams, and the tick count is unknown.

### 10.2 The reef line is world y = 0 [read]

- 0x412450 builds the polyline behind 0x417200 from FindObject("height")
  (0x41bac0 -> 0x42ea80, which matches MESH names) and
  CD3DFileMesh::GetGeometry (vtable 0x45a2f4 slot 5 = 0x42f7a0: returns the
  +0x60 vertex array and the +0x5c count). It copies x and y of each 32-byte
  D3DVERTEX.
- Frame matrices are applied only at draw time (CD3DFileFrame render
  0x42f8e0 multiplies its +0x5c into WORLD) and in the bounding-box and
  bounding-sphere visitors (0x42ee60, 0x42eec0). No loader function
  transforms vertices.
- The `height` mesh is modelled flat in its XZ plane: every raw y is 0 in
  all three scenes. So height(x) = 0. The fish crossing rule (3.5), the
  start-pose raise (0x417d10) and the navigator clamps (0x417e40, 0x4189b0)
  all use world y = 0.
- 0x417ae0 does not sort. It keeps file order: x below the first point
  gives that point's y, x above the last gives the last y, otherwise the
  first segment with x0 < x < x1 (strictly) is interpolated, else 0.
  Crab_Path and height are stored in ascending x, so only an exact vertex
  hit differs from a sorted lookup, and it returns 0.
- Measured effect (probe-track --occlude, share of moving-fish detections
  below the painted reef edge, 4 seeds, before -> after; reference):
  - scene 1: 37-47 -> 46-56 % (53.0 / 56.3)
  - scene 3: 25-42 -> 34-51 % (48.5 / 52.0)
  - scene 2: 59-67 -> 67-76 % (63, one launch)

### 10.3 Sea horse

- **Pre-simulation counters** [read + inferred].
  - 0x4191a0 writes the turn-back counter (+4) and the random pitch and yaw
    counters (+0xe8, +0xec) only AFTER its pre-simulation loop (0x419392,
    0x4193a0, 0x4193bc). During the 10-54 steps they hold stale heap memory.
  - The captures show what that memory does. All 8 horses tracked at launch
    in 3 Wine runs start level, at exactly their zone centre height (blob cy
    246-251 px far, 330-334 px near).
  - With zeroed counters the pre-simulation pitches the path: 0 of 90 of the
    port's horses started level. So the counters do not fire, and the port
    treats them as large.
- **Caustic frame** [read]. The fish and sea-horse caustic pass (0x406050)
  takes its frame from creature +0x6c. The fish update writes t + timeOffset
  there (0x4151eb). The sea horse never writes it, so it keeps the base
  constructor's 0 (0x406b4b) and always shows caustics_01.
- **Floor** [read].
  - The hard lower bound is the per-frame clamp in 0x41f540,
    `M._42 >= box.min.y + 0.1*(box.max.y - box.min.y)`, with box.min.y =
    0.8*bbox.min.y (disassembly at 0x4132af). In scene 1 that is -412.8,
    screen y 627 for the origin.
  - It is also the navigator's near-zone waypoint floor (0x418526). The
    far-zone waypoint floor is -143.1, screen y 468.
  - A screen y of 616 is therefore reachable.
- **Floor statistics** [open].
  - Across 5 reference launches the near-zone horses stayed above about
    571 px (blob centroid). The port's near horses reach the floor in about
    half of all 240 s runs.
  - Every instruction of 0x4191a0, 0x417e40, 0x4189b0, 0x418610, 0x41f540
    and 0x41fa30 matches the port.
  - The remaining unknowns are stale memory: +0x68 (the sway phase, which
    stamps forced moods) and the first mood duration. Varying either does
    not change the depth statistics.

### 10.4 Smaller points [read]

- **Collision radius** (+0x4c). The fish getter (vtable +0x20, 0x4163d0)
  returns scale * +0x4c; the sea horse's (0x406c40) returns +0x4c. It is the
  bounding sphere that 0x431ad0 computes at load with 0x42ef70: over EVERY
  vertex of EVERY mesh in mesh.X (pose meshes and eyes included, frame
  matrices applied), centred on the vertex centroid (0x42e8c0, 0x42e980).
- **Avoidance** (0x404d40).
  - The probe is local (radius, 0, 0) through the creature's own WORLD
    matrix, so it includes the depth scale.
  - The obstacle radius is `2r + 1.2r` of the OTHER creature's getter
    (settings scale x mesh radius, no depth term).
  - It is x1.2 when that creature's aggression exceeds its own +0x7c by
    0.001, and 0 when it is 0.001 below.
  - Every creature is an obstacle, including invisible leaders. A leader's
    +0x7c stays at 1.0, so it gets x1.2 against aggression-2 fish. Only a
    leader skips itself.
- **Motes** (0x406e10). Start and end points lie on a NINTHS grid,
  `(rand()%10) * 0.1111` of the box, 0..1 inclusive. Then come size
  `0.5 + 0.05*(rand()%10)` and speed `1 + 0.1*(rand()%10)`.
- **Sea star arms** (0x41fe90, 0x420050). Each `SNFMat_Top<i>` and
  `SNFMat_Bottom<i>` subset keeps its own bounding box. A vertex's weight is
  `|v|^2 / |box.max - box.min|^2 - 0.4`.
- **Fish settings** (0x412450 via 0x4066f0). `school`, `scale`, `speed`,
  `aggression` and `behav` are read as integers from
  FISHES/<name>/settings.xml; scale, speed and aggression are multiplied by
  0.1. The binary holds no species names other than Anemone Crab, Sea Star
  and Sea Horse, so there are no per-species overrides.
  assets/manifest.json carries the files' values unchanged.
