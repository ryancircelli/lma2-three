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
L1 = ambientLevel, L2 = 0 ;  scene.draw(pass 0)       -- background layer, light rays
Z on;  L1 = 0, L2 = 1
    creatures with drawInFront == false: draw
Z off; L1 = ambientLevel, L2 = 0 ;  scene.draw(pass 1) -- bubbles, billboards, foreground, caustic Relief
Z on;  L1 = 1, L2 = 0
    crab.draw ; seaStar.draw (if its "after" flag +0xb5 is clear)
Clear2(zbuffer only)
L1 = 0, L2 = 1 ;  creatures with drawInFront == true: draw
L1 = 1, L2 = 0 ;  bubbleSystem(this+0x700).draw
Clear2(zbuffer only)
seaStar.draw (if its +0xb5 flag is set)
overlay (0x40bd70)
EndScene
```

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

### 3.5 The sea floor and the reef line

Two polylines from the scene data are used as functions of x (0x417ae0: linear
interpolation, clamped to the end points). [read]

- **Crab_Path** (path.X, `Crab_Path`) is the **sea floor**. Its points are
  stored with `y = (bbox.min.y + 0.15*H) + p.y - 30`. Each frame a fish's y is
  raised to at least `floor(x)`. Because of the position averaging this
  correction is soft.
- **height** (mesh.X, mesh `height`, 7-8 points, world-transformed) is the
  **top edge of the foreground reef painting**. Near the foreground plane
  (`|z| < lim`, `lim = 0.25 * depth`) a fish must be above
  `lerp(zone.min.y, height(x), sin((1 - |z|/lim) * pi/2))`. If it is below:
  - pitch += 7*step (up to 0.9)
  - a fish currently behind the plane is held at z >= +100; one in front is
    held at z <= -100

  So fish can only pass through the foreground plane above the reef silhouette.

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

---

## Feature inventory (so far)

- [x] single ortho camera from scene bbox (0.98 zoom), eye X = 0
- [x] per-scene clear colour and ambient level
- [x] two directional lights re-levelled per pass; 0.5 ambient; material with specular
- [x] draw order: back scenery, back creatures, front scenery, crab, sea star, Z clear, front creatures, bubbles
- [x] per-frame front/back classification of creatures by z vs foreground plane; back-to-front sort
- [x] fish: invisible schooling leader, followers with distance bands
- [x] fish: two swim zones (near/far) with timed migration
- [x] fish: speed state machine (burst/slow/hold) with cosine easing
- [x] fish: fake perspective (depth-scaled size and speed)
- [x] fish: floor = Crab_Path polyline; reef silhouette = height polyline; plane-crossing rule
- [x] fish: zone-edge steering, pitch control, yaw/pitch wobble
- [x] fish: inter-creature avoidance weighted by aggression
- [x] fish: predator (behav 2) occasionally chases nearest prey (behav 0)
- [x] fish mesh animation: tail ripple, gill and fin pose blends, whole-body bend, eye swivel
- [x] fish caustic overlay (additive, planar UVs)
- [ ] crab, sea star, sea horse (in progress)
- [ ] scenery: water surface, caustics on Relief, bubbles, rays, billboards, scene rotation (in progress)
