# Fidelity review (pessimist): the remake vs the original

- **Reviewed:** `main` @ 4828608. **Branch:** `review/pessimist`.
- Every number below was measured for this review, unless marked *(other agent)*.
- Evidence paths are relative to `.worktrees/review/screenshots/`. That folder is gitignored and stays on the machine (about 25 GB of frames).

## How this was measured

**Reference: the original under Wine**
- Runs on a private Xvfb display, with four prefixes of my own: `~/.wine-lma2-review{,2,3,4}`.
- `ref/stills/{P,C,W,R,B,A}{1,2,3}`: full-frame bursts per scene, 7 to 10 frames 0.7 to 1 s apart, captured with `tools/wine-burst.sh` and `LMA2_PARAMS`. One feature is switched on at a time:
  - **P**: painting only (plantsmoving=0, volume=0, water=0, bubles=0, caustic=0).
  - **C**: P plus Relief caustics.
  - **W**: P plus the water surface.
  - **R**: P plus light rays (volume=1).
  - **B**: P plus bubbles.
  - **A**: everything as installed, no fish.
- `ref/bottom/s{1,2,3}`: 300 s bare-tank sequences per scene, with LMA2_BARE=1 and LMA2_GRAB=fast, about 1500 renders each.
  - Tank of 24: Percula 6, Yellow Tang 5, Cuban Hog 4, Regal 2, Clown Trigger 2, Majestic 1, Juvenile 1, Flame 2, Blue Hippo 1.
  - Schooling on.
- `ref/full/s{1,2,3}`: 240 s full-scene sequences per scene, with the install's default tank and caustics on, 728 renders each.
  - Scenes 2 and 3 had no fish reference at all before this review.
- `ref/full/bg{s}` and `ref/bottom/bg{s}`: fish-free backdrops for `tools/track.ts`.

**Ours**
- **Stills:** agent-browser at 1024x768 on port 8110, with the matching switches. Files `o{P,C,W,R,B,A}{s}.png`. Animated features are averaged over 7 to 10 values of `?t=`: `oWmean`, `oCmean`, `oBmean`.
- **Motion:** `tools/probe-ours.ts` with the same tanks, 4 seeds x 300 s per scene (`ours/bottom-s*.json`).
- **Live rendered runs:** `ours/live-fish{s}`, 150 frames over about 95 s, rays off like the wine-ref captures. They are analysed with the same `track.ts` pipeline as the reference.

**Comparison method**
- Phase-free comparisons are used for animated additive effects: the time-averaged light each effect adds, per screen cell (`tools/addgrid.ts`). A per-pixel diff of two frames with different animation phase says nothing.

**New tools (committed)**
- `tools/floorline.ts`: camera, floor and reef lines in screen px.
- `tools/bbboxes.ts`: billboard screen boxes.
- `tools/maskpsnr.ts`: PSNR with regions excluded.
- `tools/addgrid.ts`
- `tools/bottomrows.ts`: lowest creature row per frame.
- `tools/colortracks.py`: per-colour, i.e. per-species, track stats.
- `tools/reefsplit.py`: where moving fish are seen relative to the reef line.

**Decompile audit**
- A read-only sub-audit answered specific questions from `~/lma2-decomp` (Ghidra output, with addresses).
- I re-read the key ones myself: the follower re-aim timer in `fn/00415150.c` lines 136-201, and the water-surface normals.
- Everything cited as "decomp" below comes from that audit, with the address given.

---

## 1. Per-feature verdicts

### Static frame (all three scenes)

| Feature | Verdict | Ours vs reference | Evidence |
|---|---|---|---|
| Camera / registration | **MATCHES** | Every region of the painting is within 0.0-0.4 px, in all 30 cells, in every scene. The one exception is scene 2's class-C plants at +1.0 px: the reference ran with plantsmoving=0, which skips the `int(w)*0.005` shift of layer B. | `register.ts oP{s} ref/P{s}` |
| 0.5 px nudge | **MATCHES (empirical)** | Residual 0.0 px. The cause, the D3D pixel-centre rule, is still inferred. The value is right. | same |
| Clear colour | **MATCHES** | Top band of scene 1: 61.8 dB | `maskpsnr` |
| Background + Foreground painting | **MATCHES** | Billboards excluded: 44.4 / 42.6 / 42.3 dB, RMSE 1.5 / 1.9 / 2.0, 99.0 / 98.0 / 98.2 % of pixels within 8/255. Ours is +0.3 to +0.7 levels brighter on average. | `maskpsnr --ex` |
| Billboards, whole frame | **CLOSE** | 32.0 / 30.6 / 33.1 dB. The residual is only on class B (green_plant: ours has its RotX tilt at t=0, the plantsmoving=0 reference has none) and class C (mask and shift). This is a phase difference, not an error. | `m_dP.png` |
| Billboard motion (A/B/C/D) | **MATCHES (code)**, not re-measured | scene.ts `animate()` matches §5.3 and §8 formula by formula, including the corner indices and the RotX-then-RotZ order. | code |
| Anemone mask phase (class C) | **OFF (small)** | Ours uses the constant 0.475 for every plant. The original gives each plant its own `(rand%20)*0.05` per launch (decomp 0x417070, 0x4026d0). | decomp |
| Relief caustics | **CLOSE** | Time-averaged added light, ours/ref: 0.965 / 0.914 / 1.024. Cell correlation 0.990 / 0.984 / 0.989. | `addgrid oCmean{s} oP{s} ref/Cmean{s} ref/P{s}` |
| Water surface, no fish, caustics off | **MATCHES** | Added light 0.978 / 0.984 / 1.035. Cell correlation 0.987 / 0.991 / 0.993. Per-row profile over y 110-126 within about 10 %. | `addgrid oWmean…` |
| Surface horizon edge | **OFF, 1 row** | Ours lights row 127 (+5.4 and +4.3 R+G in scenes 1 and 3); the reference has 0 there. The "one pixel extra" known item is confirmed. | per-row table in section 4 |
| Surface with fish or caustics | **CLOSE (averaged)** | Ours uses a fixed diffuse per configuration. In the original, the diffuse is exactly the ambient light state left over from the previous frame's last ambient-setting draw (D4). | decomp |
| Light rays | **CLOSE** (structure only) | Same count, width, lean and reach, and the same B-channel saturation to yellow in scene 1. The phase differs, so there is no ratio. | `m_rays.png` |
| Bubbles | **MATCHES** | Time-averaged column brightness 1.049 / 0.997 / 1.044. Per-band correlation 0.999 / 0.995 / 0.992. | `addgrid oBmean…` |
| Light motes | **MATCHES (code)**, not re-measured | motes.ts matches §5.8. | code |
| Crab shadow | **CLOSE** | Same shape and darkness. The ±3-unit bob (about 2 px) is not implemented; shadow.ts says so. | `m_crab.png` |

### Creatures

| Feature | Verdict | Ours vs reference | Evidence |
|---|---|---|---|
| Crab size | **MATCHES** | Rendered 95 px wide; reference 95-106 (p50 98). **The "118 px" known item is a measuring artefact.** `Tank.probe()` includes the 200-unit shadow quad (200 × 0.587 = 117 px). | `m_crab.png`, diff bbox |
| Crab walk | **CLOSE** | Share of 2-s windows standing still: 0.32-0.44 vs 0.44. Speed p50 6 vs 2 px/s (reference is one 90 s run). The turn logic differs from the code (D8). | `motion-stats`, still fraction |
| Sea star | **CLOSE** | Floor/glass odds (`rand%10>5`) and the glass-last draw are right; y 650-657 on the floor. Start point, start direction and spin direction are random in ours. The original starts at path point P1 moving toward −x, and the spin sign follows the travel direction (decomp 0x4210e0, 0x420260). | decomp |
| Sea horse | **OFF** | Centre-y p02/50/98: 27/238/625 vs 186/250/338. Turn-arounds 2.5 vs 0.4 per minute. Speed p50/p90 14/33 vs 13/36 (a coincidence, see D2). | `motion-stats ref-horse ours-horse` |
| Fish below the bottom edge | **MATCHES** | Never, in any scene, in either version. See section 3. | `ref/bottom/rows{s}.txt` |
| Fish speed, whole tank (24 fish, 300 s) | **MATCHES** | p50/p90 px/s: 27/81, 29/76, 28/80 vs 31/86, 30/83, 30/80. | `motion-stats ref-s{s} ours-s{s}` |
| Fish speed, yellow tang | **MATCHES** | 27/61, 30/67, 30/67 vs 29/73, 27/63, 29/69. **The "too fast" known item is refuted**, see section 3. | `colortracks.py … 110 110 60` |
| Turn-arounds | **OFF** | Whole tank 4.8 / 4.1 / 4.6 vs 3.7 / 2.4 / 2.9 per track-minute. Yellow tang 4.1 / 4.3 / 4.8 vs 2.6 / 1.9 / 2.5 (1.6-2.3×). Rendered default tank 4.0 / 2.9 / 3.1 vs 2.3 / 1.5 / 2.4. | `motion-stats`, `track.ts` |
| Climb / dive | **OFF** | Median \|vy/vx\| 0.32 / 0.34 / 0.36 vs 0.43 / 0.43 / 0.53; yellow tang 0.33-0.36 vs 0.44-0.56. Ours swims 25-35 % flatter. | `motion-stats` |
| Height on screen | **CLOSE in s1, OFF in s2/s3** | Centre-y p50/p98: s1 214/684 vs 246/689; s2 182/676 vs 196/680; s3 177/590 vs 221/676. Lowest fish per frame in s3: p50 470-579 over 4 seeds vs 684. | `motion-stats`, `bottomrows` |
| Fish in front of the reef (layering) | **OFF** | Share of moving-fish detections below the reef line (necessarily in front of the Foreground): 47 / 44 / 35 % vs 56 / 63 / 49 %. More than 150 px below it: 33 / 11 / 10 % vs 39 / 40 / 27 %. In scenes 2 and 3 ours keeps its front fish high. | `reefsplit.py` on `ours/live-fish{s}.json` and `ref/full/s{s}.json` |
| Floor contact | **CLOSE** | Share of time a blob centre is below the Crab_Path floor: 4.1 / 1.8 / 0.2 % vs 5.7 / 5.8 / 2.3 %. Deepest: 8-12 px vs 23-30 px. | floor analysis |
| School tightness (yellow tang) | **OFF (weak evidence)** | Nearest-neighbour distance p50 116-128 px vs 152-196 px. The reference merges overlapping blobs and sees 3 of 5 fish where ours sees 5. | colortracks nn |
| Silhouette size | **CLOSE** | Width p50 47-48 vs 39-42; height 47-48 vs 49-52. Part of this is the method (probe boxes vs thresholded blobs). The same-pipeline rendered run gives width 40/37/45 vs 39/41/48. | `motion-stats`, `track.ts` |
| Tail ripple, fins, gills, bend | **MATCHES (code)** | fish.ts follows §3.10 term by term. Not pixel-measured. | code |
| Eyes | **CLOSE** | Targets and timing match. Ours snaps to each new target. | code |
| Fish diffuse lighting | **CLOSE** | Hue and shading qualitatively the same (regal angel crops). Ours lights in linear space, fitted to D3D's gamma-space ramp at two points. | `m_regal.png`, tank.ts |
| Fish specular | **MISSING (wrong values)** | Ours uses the `.X` material's 0.135 at power 10, per pixel. The original forces specular 0.5 at power 160.9 with SPECULARENABLE=1, per vertex (decomp 0x416917, 0x413429). | decomp, `src/xloader.ts` |
| Fin and tail edges | **OFF** | Ours uses `alphaTest 0.3`, a hard cut-out, plus `opacity 0.9` from the `_Alpha`/`_tail` materials. The original alpha-blends with the texture's alpha only and ignores material alpha (ALPHAOP=SELECTARG1(TEXTURE)). | `src/xloader.ts` makeMaterial, decomp |
| Edge antialiasing | **OFF** | `WebGLRenderer({antialias:true})` (main.ts:65) gives MSAA edges on fish, crab and star. D3D6 draws aliased edges. | code |
| Caustics on fish | **CLOSE / uncertain** | Ours uses the shared scene frame. The original uses each fish's own clock `t+timeOffset` (0x4060f3), and the pass is lit by L2 as well as ambient 0x10. The measured effect is faint *(other agent)*. | decomp |
| Fish depth fog | **MATCHES (code)** | Linear, z=0 to 2·max.z, in the water colour. | code |
| Pitch inertia | **MISSING** | Confirmed, and the smoothing sits at the wrong point (D1). | decomp 0x415150 |
| `view=fish` | **OFF** (the original has no such view) | Still the whole-body morph (`main.ts` fishView → `poser`). | code |

---

## 2. Ranked discrepancies (largest visible effect first)

### D1. Fish steering: too many turn-arounds, too flat, schools too tight, front fish kept too high

**Measured.**
- Turn-arounds are 1.3-2.3× the original's, whichever way you slice the data: whole tank, per species, or rendered runs.
- \|vy/vx\| is 25-35 % lower.
- The share of fish seen in front of the reef, low down, is too small: >150 px below the reef line 11 % vs 40 % in scene 2, and 10 % vs 27 % in scene 3.
- In scene 3 the lowest-fish p50 is 470-579 vs 684.
- Yellow tang nearest-neighbour distance is about 25 % smaller.

This is the most visible difference: it changes the character of the swimming on every screen.

**Causes** (`src/tank.ts` `updateFish`, against original-logic §3.4-3.8 and decomp 0x415150, 0x417c60, 0x4188c0):

1. **Follower re-aim is far too frequent.**
   - The original decrements its re-aim timer (`+0x274`) by **step**, not dt, and resets it to 0.3. That is a re-aim every `0.3·150/((sa+2)·speed)` s: about 11 s at cruise, 2.6 s at full burst. Verified in `fn/00415150.c` lines 136-138 and 190-201.
   - Ours re-aims every 0.3 s.
   - The threshold is π/6 (0x459160 = 0.5236), not 1/17, and the angle is 3D.
   - The turn is applied only while the fish is inside its zone and \|target\| > 0.3, not 0.1.
   - The tail-beat gate is applied per frame to the ongoing turn, not only when the target is set. The audit also reports that ours pairs the gate's signs the wrong way round.
   - The turn is never eased in: the start is stamped with `ph`, so the ease term is 1.
2. **Avoidance turns are too strong and too eager.**
   - The original applies an avoidance turn only when \|target\| > 0.3.
   - It is gated by the tail beat, at a rate of `10·step·|−cos 5tt|·easeIn(tt−avoidStart)` with no ease on \|θ\|, which averages about 3.5× slower than ours.
   - Zero vectors are pushed into the 10-entry ring every frame, so the average ramps up. Ours pushes only non-zero entries.
   - The original also counts the invisible leader as an obstacle.
3. **Zone turns during avoidance.** The original skips the wall turn while avoiding, and its "inside" and 2 s resets clear the zone target for every fish. Ours still turns, and resets only for fish that are not following and not avoiding.
4. **Pitch.**
   - `pitch = (prev + pitch)/2` belongs right after the leader and zone nudges. The reef climb (+7·step), the avoidance pitch (±3·step) and the >0.7 decay come after it at full strength. Ours halves all of them.
   - The inertia term is missing: if pitch did not change this frame, `v *= 0.5; pitch += v`, else `v = pitch − prev`.
   - This matches the "too flat" measurement.
5. **Full-strength corrections are halved.** The avoidance push (`dir·step·1500`) and the reef z-hold (z = ±100) are applied after the move at full strength in the original. Ours puts them in `corr`, which is then halved.
6. **Band re-roll clock.** The band re-roll uses the fish's own clock `(int)tt % 10 == 9`, every frame while true. Ours uses shared t, once per cycle.

**Fix.** Port 0x415150 exactly:
- keep separate zone (+0xf4), leader (+0xe0) and avoid (+0xe4) turn targets;
- decrement the step-based re-aim timer;
- move the pitch smoothing, add the inertia term, and apply the corrections after the move;
- then re-measure with `motion-stats` against `ref/bottom/*.json`, and with `reefsplit.py`.

**Can it be closed?** **Yes.** This is deterministic code, and the decompile is readable. What remains is per-launch randomness, which is statistical only.

### D2. Sea horse: wrong navigator, plus a bug that freezes its speed

**Measured.**
- Vertical spread is 27-625 px vs 186-338 px.
- Turn-arounds are 2.5 vs 0.4 per minute.
- It only shows when sea horses are stocked: the install stocks 0.

**Causes.**
- **Wrong navigator** (decomp 0x4191a0, 0x4189b0, 0x417e40, 0x418610).
  - The original moves a Catmull-Rom spline parameter by `6k` through waypoints spaced 150 units apart (75 during its 5-step ±30° turn-back).
  - Five start waypoints lie on the ellipse inscribed in the zone, all at the zone's **centre height**, so the horse stays near that height. That is the 186-338 band: zone centres at screen y 257 and 345 in scene 1.
  - Speed is about `900/(25−P)` units/s. HORSE_GAIN = 105 is a fit to that.
  - Its zone flip counts in `6k` units and only happens while y is above `zone.minY + 0.6·h`.
  - Its avoidance push is `avg·6k·250`.
  - Spawn: `u = (rand%20)·0.05`, then `rand%45 + 10` waypoint steps.
  - The −π/2 body yaw is equivalent to ours: no error there.
- **Remake bug.** `force()` stamps `sm.start = this.t`, but the horse's mood machine runs on `f.clock` (≈ 2k per frame).
  - After the first avoidance, `clock − start` is permanently negative. The mood never re-rolls, and `min(sa, 15·(1 − ease(u<0)))` walks `sa` down to 0.
  - From then on the horse is stuck at its slowest.

**Fix.**
- Port the waypoint spline.
- Stamp the horse's forced moods with `f.clock`.
- Delete HORSE_GAIN.

**Can it be closed?** **Yes.**

### D3. Fish materials: specular, fin edges, antialiasing, gamma-space lighting

**Measured / read.**
- Specular: ours 0.135 at power 10, per pixel. The original: 0.5 at power 160.9, per vertex, SPECULARENABLE on (0x416917, material at 0x413429).
- Fins and tails: ours cuts them out at alpha 0.3 and makes them 10 % translucent. The original blends with texture alpha only.
- MSAA is on (main.ts:65); the original has no antialiasing.
- These show on every fish in every frame: glints, soft fin fringes and silhouette edges. The crab crop shows the original's soft whitish alpha fringe on the legs (`m_crab.png`).

**Fix.**
- In `makeMaterial` (or a fish-only override in fish.ts), set specular 0.5 and shininess 160.9. Ideally compute the lighting per vertex, in gamma space, in `onBeforeCompile`: D3D lights the vertex and saturates before modulating the texture.
- Set `opacity = 1`, drop `alphaTest`, and set `transparent: true` with depth write on. The original draws with Z on and alpha blend, back to front: three's transparent sort gives the same order.
- Set `antialias: false`.

**Can it be closed?**
- **Mostly.** Per-vertex specular needs a small custom shader.
- The exact 8-bit rounding of Wine versus a real D3D6 driver cannot be reproduced.

### D4. Water-surface brightness when fish or caustics are on

**Read** (decomp 0x41c300, frame order 0x40e330).
- Every `watersurface.X` normal points down (n_y −0.986 to −0.998, checked), so neither light reaches it.
- Its diffuse is exactly the **ambient light state** left by the previous frame's last ambient-setting draw:

| Draw | Ambient it leaves |
|---|---|
| Background, Foreground | 0xFF |
| Rays | 0x80 |
| Fish | 0xAA; 0x80 if causticonfish |
| Sea horse | 0x80 |
| Relief / crab / star caustic passes | 0x80 |

- This reproduces the other agent's measurements: 1.0 plain and 0.50 with caustics.
- The measured G/B tint is scene 1's channel saturation, not a tint. The R = 0.64 with fish plus caustics is not explained yet; check it frame-matched.

**Fix.** Track the last ambient in draw order each frame and use it as a grey diffuse on the next frame.

**Can it be closed?** **Yes**, apart from confirming the fish-plus-caustics case against the reference.

### D5. Crab turn, sea star start and spin

**Read** (0x409d00, 0x4210e0, 0x420260).
- The crab's turn forces mood 2 for 4 s. The direction flips when that expires, and a fresh mood starts from speed ≈ 0, so the crab stands for about 5 s on average.
- Ours multiplies by `1 − sin(uπ/2)` and resumes the old speed at once. Edge turns in the original do not reset the turn timer.
- The sea star starts at P1, heading −x, and `spin = ±0.025` with the sign of its travel direction.
- Fish, crab and star are all drawn from **raw model origins**. `loadFish` re-centres every model on its bounding-box centre. Offsets:

| Model | Offset (units) | Effect |
|---|---|---|
| crab | (5.4, 7.25) | about 3 px low |
| star | (9.1, 4.0) | spins about the wrong point |
| sea horse | −9.3 along the body | shifted |
| fish | ≈ 0 | none |

**Fix.** Port these as read, and add a `recentre=false` path for creatures.

**Can it be closed?** **Yes.** The effect is small.

### D6. Billboard mask phase and one-pixel edges

- **Class-C mask phase:** use a per-plant random `(rand%20)·0.05`. The distribution then matches; the exact value is per launch.
- **Surface horizon:** ours lights one row (127) too many. This is a rasterisation edge-rule difference, fixable by moving the far row down by about 0.5 px, or by applying the D3D fill rule in the vertex shader.
- **Class A only clamps.** B, C and D WRAP in the original; ours clamps all of them. Visible only if a texture edge is not transparent.

**Can it be closed?** Mask: **distribution only**. Horizon: **yes**.

### D7. Caustic light level

- Scene 2 Relief caustics are 8.6 % dim, scenes 1 and 3 within ±3.5 %. The painting is +0.5 levels bright.
- Likely cause: Mesa's fixed-point modulate and rounding against GL's float pipeline, plus the 7-frame sample.

**Can it be closed?** **Partially.** It could be tuned per scene, but that tunes toward Wine, not toward a real 2005 D3D driver.

### D8. Smaller items

- **Fish caustic clock.** Each fish should pick its caustic frame from its own `t + timeOffset`, and the pass is also lit by L2. The effect is faint.
- **Crab shadow bob.** `y = 3·sin(phase) − 10` is missing: about 2 px.
- **Eyes** snap instead of easing. The original may snap too; the decompile does not say either way.
- **`view=fish`** still uses the whole-body morph. The original has no such view, so this does not affect fidelity.

---

## 3. The known open items, verified

| Item | Verdict |
|---|---|
| 0.5 px nudge | **Holds.** Registration residual is 0.0 px in every cell of all three scenes. The cause is still inferred. |
| Anemone mask phase random per launch | **True.** Ours uses one constant for all plants, while the original draws each plant's phase independently (0x417070). Make it random per plant. The exact value is irreducible. |
| Tang/hog top speed too high (p90 ~75 vs 35-42) | **Refuted.** The 35-42 came from single 40 s runs of one school, which stays in one zone: the far zone moves at 0.5×. In the 300 s, 3-scene reference, yellow tang p90 is 63-73 px/s vs ours 61-67, and the whole tank is 80-86 vs 76-81. |
| Turn-arounds too frequent | **Confirmed**, 1.3-2.3×. Causes are in D1. |
| Yellow tang schools too tight | **Probably true.** Nearest-neighbour distance is 116-128 vs 152-196 px, but the evidence is weak. The cause, follower re-aim frequency, is certain (D1). |
| Sea horse HORSE_GAIN fitted, spawn spread too wide | **Confirmed and explained.** The navigator is a waypoint spline at the zone's centre height with a gain of 150. A remake bug also freezes its speed (D2). |
| Crab 118 px vs 98-103 | **Refuted: measuring artefact.** The probe box includes the 200-unit shadow quad. The rendered crab is 95 px, the reference 95-106. |
| Surface tint with fish is a sequence average | **True, and closable.** The value is the leaked ambient state (D4). |
| Horizon row one pixel extra | **Confirmed.** Row 127 is lit in ours and 0 in the reference, in scenes 1 and 3. |
| Pitch inertia missing | **Confirmed.** The smoothing is also in the wrong place (D1.4). |
| Specular on fish missing | **Confirmed, and worse.** The values in use are wrong (0.135 at power 10 instead of 0.5 at power 160.9), and the fins are 10 % translucent and alpha-tested (D3). |
| `view=fish` whole-body morph | **Confirmed.** It does not affect fidelity: the original has no such view. |
| wine-ref.sh forces volume=0 (no rays) | **Confirmed** in `cmd_capture` and `cmd_sequence`. `wine-burst.sh` keeps volume and was used here for the ray stills. |
| Scenes 2 and 3 have no fish reference | **Fixed.** New captures are in `ref/full/s2`, `ref/full/s3`, `ref/bottom/s2` and `ref/bottom/s3`. |

### Priority question: do fish leave through the bottom of the screen?

**No.** Not in the original, in any scene, and not in ours.

| Scene | Frames touching row 767 | Lowest creature pixel, p50 / p90 / p99 / max |
|---|---|---|
| 1 | 0 / 1498 | 716 / 732 / 748 / 760 |
| 2 | 0 / 1500 | 714 / 725 / 733 / 740 |
| 3 | 0 / 1499 | 684 / 705 / 718 / 724 |

- **The floor clamp binds the stored position.** The decomp confirms it: y is written back at 0x4151ad, and the later stores are the new position, not a restore.
- **Scene 2 would have shown it if not.** Its zone floor `0.8·min.y` lands off-screen at y 776, while scenes 1 and 3 have it at 697.5.
- **Ours, same tank, 4 seeds:** never touches row 767. The lowest box bottom maxes out at 739-746, 725-736 and 706-719.

---

## 4. Supporting tables

**Surface, per row** (mean added R+G, cols 380-640, 7-frame means):

| Scene | Rows 110-126 | Row 127 |
|---|---|---|
| 1 | within about 10 % of the reference | ours 5.4, reference 0 |
| 3 | within about 10 % of the reference | ours 4.3, reference 0 |

**Floor lines, screen px** (tools/floorline.ts):
- Crab_Path fish floor: scene 1 662-695, scene 2 663-681, scene 3 665-687.
- Zone floor `0.8·min.y`: 697.5 / 776.2 / 697.5.
- Far-zone floor: 521 / 580 / 521.

**Same-pipeline rendered runs** (`track.ts`, default tank). Ours is about 95 s per scene, the reference 240 s.

| Scene | Speed p50/p90, ours vs ref | Turns/min, ours vs ref | \|vy/vx\| p50, ours vs ref |
|---|---|---|---|
| 1 | 16/78 vs 11/72 | 4.0 vs 2.3 | 0.29 vs 0.49 |
| 2 | 15/63 vs 23/84 | 2.9 vs 1.5 | 0.29 vs 0.40 |
| 3 | 17/58 vs 17/86 | 3.1 vs 2.4 | 0.37 vs 0.48 |

---

## 5. Overall judgement

**Not yet "as close as reasonably possible"**, but the split is clear.

**The static picture is essentially done.**
- Camera, clear colour, painting (42-44 dB outside the plants), surface, bubbles and caustics (within 2-9 %) are at or near the Wine-versus-WebGL noise floor.

**The motion is where the remaining fidelity is.**
- The fish steering was rebuilt from the spec. The spec summarised 0x415150 too loosely: timer units, thresholds, gating, the order of pitch smoothing, and the halved corrections.
- Every one of those errors pushes the same way, toward more twitchy, flatter swimming that stays high. That is what the measurements show.

**Top five changes that would move it most:**
1. Port the fish update 0x415150 exactly (D1): step-based re-aim, π/6 threshold, per-frame tail-beat gating, separate turn targets, pitch smoothing order and inertia, full-strength post-move corrections.
2. Sea horse: waypoint-spline navigator, and fix the `f.clock` stamping bug (D2).
3. Fish materials: specular 0.5 at power 160.9, alpha-blended fins without alphaTest or 0.9 opacity, `antialias: false`, gamma-space vertex lighting (D3).
4. Per-frame leaked-ambient diffuse for the water surface (D4).
5. Crab turn, sea star start and spin, raw model origins, per-plant mask phase (D5, D6).

**Irreducible limits:**
- **Wine is the reference, not a 2005 D3D6 driver.** Mesa's software GL rounding and texture filtering cap the painting at about 42-44 dB (+0.5 levels) and caustic level agreement at a few percent. Fitting further would fit Wine.
- **Per-launch randomness.** The original seeds MSVC `rand()` from GetTickCount. Fish start poses, zone timers, the class-C mask phases, the star's floor/glass choice and the eye targets can only match in distribution, never frame for frame.
- **Frame timing.** Wine renders at 3-12 fps, ours at 60 fps. The motion is time-based, so statistics agree, but per-frame integration (the position averaging and ½-pitch smoothing are per frame) makes trajectories slightly frame-rate dependent in the original itself.
- **Rasterisation rules.** D3D6 pixel centres and fill rules versus GL are approximated by the 0.5 px nudge. One-pixel edge differences (the horizon row) can be patched case by case, but not in general.
