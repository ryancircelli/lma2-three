# Fidelity review (pessimist): the remake vs the original

> **Rounds 2, 3 and 4 are at the end of this file. Round 4 (`main` @ fe7fd19) has the current verdict: as close as reasonably possible.**
> Sections 1-5 are the round-1 review of 4828608. They are kept as they were, for the before/after comparison.

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

---

# Round 2 (`main` @ 4d5476d)

- **What changed:** feat/motion2 (a port of the creature motion code) and feat/render2 (fixed-function materials, raw origins, surface ambient, no MSAA, plant wrap and mask phase, a caustic clock per fish, crab shadow bob) were merged.
- **How it was checked:** everything was re-measured with the round-1 pipelines. The fix agents' own numbers were not trusted.

## R2.0 What was run

**Static stills (ours)**
- Re-shot at 1024x768: `r2/oP*`, `r2/oC*`, `r2/oW*`.
- Compared against the same round-1 Wine stills.

**Headless motion (ours)**
- `tools/probe-ours.ts` on the new `src/tank.ts`, with the round-1 24-fish tank.
- 3 scenes × 4 seeds × 300 s.
- Three simulation frame lengths: 1/30 s, 1/6 s (roughly Wine's rate) and 1/60 s. `probe-ours.ts` gained `--step` for this.

**Rendered runs, same pipeline (ours)**
- The browser with the new `?bare=1&tank=…` switches.
- Each run goes through `tools/track.ts`, exactly like the reference:
  - bare 24-fish tank, 3 scenes, 300 frames each (`r2/bare{s}`, `r2/win/bare{s}`);
  - full default tank, 200 frames each (`r2/win/full{s}`).
- The Wine references were subsampled to the same ~1.7 fps (`r2/refsub{s}`).

**New Wine captures** (at most two at a time, as asked)
- 180 s single-species runs for the 8 species the installed tank never stocks. Scene 1, bare, 4 fish; 3 for the sea horse. Output in `r2/sp/<slug>`.
  - Species: convict tang, flame angel, juvenile angel, purple tang, raccoon butterfly, sea horse, yellow tang, powder brown tang.
- A crab plus sea star run, `r2/ref/crab`. Its positions are usable. Its timestamps were broken by the WSL crash, so no speeds come from it.

**Per-species headless (ours)**
- All 19 species, 4 seeds × 180 s, in the same set-up as the references (`r2/sp-ours`).

**New tools**
- `tools/trimmean.ts`: robust time average of a region, trimming out passing fish.
- `tools/fishcolour.ts`: creature colour distribution on bare frames.

## R2.1 Before / after / reference

"R1" is round 1 (4828608) and "R2" is now (4d5476d). Reference values come from the same Wine data as round 1 unless noted.

| Feature | R1 (ours) | R2 (ours) | Reference | R2 verdict |
|---|---|---|---|---|
| Registration (all regions, 3 scenes) | 0.0-0.4 px | 0.0-0.4 px | - | MATCHES |
| Painting outside billboards, PSNR | 44.4 / 42.6 / 42.3 dB | 44.6 / 42.9 / 42.5 dB | - | MATCHES (noise floor) |
| Relief caustics, added light ours/ref | 0.965 / 0.914 / 1.024 | 0.966 / 0.915 / 1.025 | 1 | CLOSE (scene 2 8.5 % dim) |
| Surface, no fish, added ours/ref | 0.978 / 0.984 / 1.035 | 0.978 / 0.984 / 1.035 | 1 | MATCHES |
| Surface horizon row 127 (R+G) | +5.4 / +4.3 | **0 / 0** | 0 / 0 | **CLOSED** (MSAA off) |
| Surface with fish + caustics, scene 1, trimmed-mean R / G over open water | fixed 0.64/0.46 tint | **16.0 / 152.4** | 15.9 / 152.8 | **CLOSED** (≈ 0x80 ambient, as D4 predicted) |
| same, scene 3 | - | 16.6 / 122.2 | 17.6 / 122.7 | **CLOSED** |
| Whole-tank speed p50/p90 px/s (headless 1/30 s) | 27/81, 29/76, 28/80 | 32/81, 32/80, 33/81 | 31/86, 30/83, 30/80 | MATCHES |
| Whole-tank \|vy/vx\| p50 | 0.32 / 0.34 / 0.36 | **0.44 / 0.43 / 0.52** | 0.43 / 0.43 / 0.53 | **CLOSED** |
| Whole-tank turns per track-minute (headless) | 4.8 / 4.1 / 4.6 | 4.2 / 3.6 / 3.9 | 3.7 / 2.4 / 2.9 | CLOSE, 1.1-1.5× (see R2.3) |
| same, same-pipeline rendered vs subsampled ref | - | 2.5 / 3.7 / 3.9 | 3.4 / 2.4 / 2.5 | CLOSE, mean 3.4 vs 2.8 = 1.2× |
| Centre-y p50/p98 (headless) | 214/684, 182/676, 177/590 | 234/690, 209/679, 187/669 | 246/689, 196/680, 221/676 | CLOSE (s3 p98 fixed; s3 p50 still 34 px high) |
| Lowest fish per frame p50, scene 3 | 470-579 | 610 (pooled) | 684 | better, still high |
| Fish in front of the reef: % of moving detections below the reef line (>150 px below) | 47 (33) / 44 (11) / 35 (10) | **63 (48) / 64 (40) / 44 (19)** | 56 (39) / 63 (40) / 49 (27) | CLOSE (s2 matches; s1 now 7-9 pts over; s3 5-8 pts under) |
| Floor contact: % time centre below floor | 4.1 / 1.8 / 0.2 | 5.0 / 3.3 / 0.8 | 5.7 / 5.8 / 2.3 | CLOSE |
| Never below the screen bottom | yes | yes (max box bottom 745-752) | yes (max 724-760) | MATCHES |
| Crab still-fraction / \|vx\| p90 | 0.32-0.44 / 26 | 0.36-0.50 / 25-26 | 0.44 / 25 | **MATCHES** |
| Crab bottom edge by x (8 bins, x 80-640) | - | within -4..+4 px of ref; 0-1 px at x 480-640 | - | MATCHES: the "6 px low at the right end" is **not reproduced** |
| Sea star glass / floor screen centre y | - | 647 / 709 | 653 / ≈707 | MATCHES |
| Sea horse centre-y p02/50/98 (scene 1) | 27/238/625 | 24/348/619 | 42/345/563 (180 s run) | CLOSE (see R2.3) |
| Yellow tang colour, B mean on bare frames | - | 30.0 | 43.3 (180 s), 46.6 (40 s) | **OFF**, cause found (R2.3 #1) |

**Code checks against the decompile** (my own reads, added to the round-1 audit):
- **Fish update 0x415150: ported as read.**
  - The follower re-aim runs on the step clock (`f.reaim -= step`).
  - The re-aim threshold is π/6. The turn applies only inside the zone and when \|target\| > 0.3.
  - Gating is applied per frame.
  - Pitch smoothing comes after the leader and zone nudges, and the inertia term is present.
  - The reef hold and the avoidance push come after the move, at full strength.
- **Sea horse: matches the decompile.**
  - The navigator is the 0x4189b0 / 0x417e40 waypoint spline.
  - Its constants match the binary (`rd.py`): 150, 75, 0.6 flip height, 0.1 floor, 0.7 climb cut, ±30° turn-back.
  - Re-stamping the mood with the sway phase (+0x68) is what 0x41fa30 does, so it is not a remake bug. My round-1 note flagged the old `this.t` stamp as a bug, which it was. The fix now follows the original, including its quirk.
- **Crab turn: matches 0x409d00.** A forced mood 2 for 4 s, flip the direction when it expires, restart from standstill.
- **Sea star: matches.** Starts at P1 heading −x; the spin follows the direction of travel.
- **Surface ambient:** set per frame from `Tank.ambientLeft()`. The measured result is in the table above.
- **Also present as described in the code:**
  - plant texture wrap;
  - per-plant mask phase;
  - crab shadow bob;
  - per-fish caustic clock;
  - `view=fish` per-part animation.

## R2.2 Per-species motion (all 19)

**Reference.** Wine, scene 1, bare tank, 4 of the species (3 sea horses; 1 crab or star).
- **ref180:** this round's 180 s runs.
- **ref40:** the fish agent's 40 s runs.

**Ours.** Headless, 4 seeds × 180 s, same stock.

Each cell lists: speed p50/p90 px/s · \|vy/vx\| p50 · turns per track-minute · centre-y p02/p50/p98 · width p50/p90.

| Species | school | ref | Reference | Ours | Flag |
|---|---|---|---|---|---|
| bicolor angel | 1 | 40 s | 26/75 · 0.37 · 0.0 · 345/665/695 · 34/80 | 28/70 · 0.44 · 4.4 · 6/194/674 · 39/78 | ref too short |
| blue hippo tang | 1 | 40 s | 55/83 · 0.26 · 3.6 · 224/467/694 · 86/117 | 27/68 · 0.40 · 4.1 · 5/167/574 · 53/102 | ref too short (one school, near zone) |
| clown trigger | 0 | 40 s | 54/140 · 0.25 · 1.3 · 21/444/711 · 92/144 | 24/95 · 0.27 · 4.1 · 6/221/689 · 63/122 | ref too short; turns? |
| **convict tang** | 1 | 180 s | 30/82 · 0.41 · 3.1 · 5/158/636 · 44/101 | 31/72 · 0.40 · 4.4 · 8/206/675 · 45/93 | turns 1.4× |
| cuban hog | 1 | 40 s | 24/35 · 0.47 · 0.4 · 21/250/465 · 43/67 | 28/73 · 0.43 · 3.9 · 6/199/671 · 39/90 | ref too short (far zone only) |
| **flame angel** | 0 | 180 s | 11/60 · 0.23 · 1.8 · 4/323/695 · 24/58 | 9/43 · 0.30 · 1.7 · 5/245/674 · 23/45 | **p90 speed -28 %** |
| **juvenile angel** | 0 | 180 s | 12/53 · 0.21 · 1.1 · 7/155/696 · 44/88 | 12/45 · 0.30 · 2.0 · 5/184/678 · 46/88 | turns 1.8× (low counts) |
| majestic angel | 0 | 40 s | 9/52 · 0.15 · 0.0 · 56/329/541 · 64/111 | 10/39 · 0.30 · 1.5 · 3/185/677 · 55/84 | ref too short |
| moorish idol | 1 | 40 s | 38/84 · 0.44 · 2.1 · 8/317/631 · 55/86 | 26/65 · 0.40 · 3.3 · 5/202/583 · 31/71 | ref too short |
| percula clown | 1 | 40 s | 33/56 · 0.65 · 0.0 · 3/204/364 · 25/32 | 35/105 · 0.37 · 6.0 · 5/246/686 · 33/62 | **turns 6.0/min, the highest**; ref too short to confirm |
| **powder brown tang** | 1 | 180 s | 37/80 · 0.38 · 3.8 · 5/218/679 · 51/92 | 34/76 · 0.41 · 4.6 · 8/234/669 · 57/91 | MATCHES (turns 1.2×) |
| **purple tang** | 0 | 180 s | 14/64 · 0.27 · 1.8 · 4/313/691 · 40/88 | 10/42 · 0.27 · 1.7 · 5/232/674 · 37/74 | **p90 speed -34 %** |
| **raccoon butterfly** | 1 | 180 s | 22/57 · 0.34 · 2.2 · 3/158/688 · 22/56 | 21/61 · 0.42 · 3.0 · 6/178/545 · 26/57 | turns 1.4×; y p98 545 vs 688 |
| regal angel | 0 | 40 s | 9/37 · 0.52 · 0.0 · 5/246/478 · 66/105 | 11/41 · 0.31 · 1.8 · 6/190/675 · 53/105 | ref too short |
| yellow angel | 1 | 40 s | 33/67 · 0.91 · 4.1 · 7/373/692 · 24/68 | 28/71 · 0.40 · 3.8 · 5/227/683 · 36/72 | ref too short |
| **yellow tang** | 1 | 180 s | 29/73 · 0.46 · 1.9 · 4/190/630 · 38/85 | 30/73 · 0.40 · 4.4 · 8/248/683 · 42/86 | **turns 2.3×** |
| **sea horse** | - | 180 s | 16/28 · 0.14 · 0.7 · 42/345/563 · 37/57 | 17/39 · 0.10 · 1.0 · 24/348/619 · 32/48 | CLOSE |
| anemone crab | - | 90 s | 2/26 · 0.10 · 1.3 · 701/710/728 · 98/103 | 4/26 · 0.09 · 1.7 · 698/708/725 · 107/108 (probe box) | MATCHES |
| sea star | - | 90 s | 1/2 · - · 0 · 650/653/657 · 97/101 (glass) | 2/2 · - · 0 · 642/704/716 · 99/100 (floor + glass seeds mixed) | MATCHES per variant |

**40 s references are too thin to judge.** The same species measured twice disagrees with itself:
- convict tang p90: 42 (40 s) vs 82 (180 s);
- yellow tang p90: 38 vs 73;
- raccoon butterfly y p50: 545 vs 158.

A school stays in one zone for tens of seconds, so a 40 s run samples one zone. Only the 180 s rows, and the pooled multi-species runs, are good enough for a verdict.

**Turn-arounds split cleanly by schooling.**
- Solo species (school = 0) match: flame angel 1.7 vs 1.8, purple tang 1.7 vs 1.8. Juvenile angel is 2.0 vs 1.1, but on very few events.
- Schooling followers turn too often:
  - yellow tang 2.3×;
  - convict tang 1.4×;
  - raccoon butterfly 1.4×;
  - powder brown tang 1.2×;
  - percula clown: 6.0/min in ours, the highest of any species.

**Top speed of slow solo species is low.** Flame angel and purple tang p90 are 43 / 42 in ours against 60 / 64.

**Frame rate is not the cause.** Wine runs at about 5 fps, and the original updates per frame, so I re-ran ours at 6, 30 and 60 fps (`r2/fps`):
- yellow tang turns: 4.6 / 4.1 / 3.8;
- flame angel p90: 44 / 45 / 44.

Neither residual comes from Wine's low frame rate.

## R2.3 Ranked residuals after round 2

### 1. Fish are drawn double-sided; the original culls back faces

This is visible on every fish in every frame.

**Evidence**
- `fixedfunction.ts` keeps the loader's `side: DoubleSide`.
- Every swimming-fish mesh is modelled double-sided: every material group has equal +z and −z facing triangle counts. Yellow tang: 401/401 on the body, 26/26 per fin.
- The original never sets `D3DRENDERSTATE_CULLMODE` to NONE. The only CULLMODE write in the binary is `CCW`, in the mote draw at 0x407724, and CCW is D3D's default.
- So ours draws the inner twin as well, blended with and z-fighting the outer one.

**Measured** (B channel on bare yellow-tang frames):

| Render | B mean | B p75 |
|---|---|---|
| Ours, double-sided | 30.0 | 44 |
| Ours, same frames, rebuilt with `side: FrontSide` | 44.1 | 76 |
| Reference | 43.3-46.6 | 68-77 |

- This is the fix agent's open item "yellow tang about 10 levels less blue".
- The FrontSide test was a local build in `/tmp`; it is not pushed.
- **Caveat:** ours `?bare=1` keeps the fish depth fog, while the original's bare mode (foreground = 0) turns fish fog off. Far-zone fish in ours bare frames are therefore fogged.
  - That does not affect the FrontSide vs DoubleSide delta above: both were measured on identical frames.

**Fix.** In `fixedFunctionMaterial`, set `side: THREE.FrontSide` for FISH, HORSE and FLOOR.
- In the test, the Z mirror did not invert the culling.
- Check the crab and sea star meshes for the same twin faces.

**Closable:** yes.

### 2. Schooling followers still turn around 1.2-2.3× too often

Solo species match.

**Measured** (turn-arounds per track-minute)

| Case | Ours | Reference |
|---|---|---|
| Whole tank, headless | 3.6-4.2 | 2.4-3.7 |
| Same-pipeline rendered, mean | 3.4 | 2.8 |
| Yellow tang | 4.4 | 1.9 |
| Percula clown | 6.0 | - |

**Likely cause.**
- The excess is confined to the follower path of `updateFish` (the `if (L)` block, leadTurn and gate), or to avoidance inside a school.
- The solo navigator path matches, so the zone-turn logic is not the cause.

**Candidates to check against 0x415150:**
- the sign convention of `signedAngle` against which gate (`gateR` / `gateL`) turns which way. A wrong pairing turns the fish away, and it then re-aims 180° later;
- whether `leadTurn` is cleared when the fish leaves the zone;
- the avoidance radius inside a tight school. The aggression comparison makes every same-species neighbour an obstacle at R = 3.2·scale·radius.

**Fix.** Instrument one follower (yaw against leader bearing over 60 s) and compare with the decompiled branch structure.

**Closable:** yes, deterministic code.

### 3. Slow solo species top out low: p90 speed 28-34 % under

- Flame angel 43 vs 60; purple tang 42 vs 64.
- Juvenile angel (45 vs 53) and majestic angel (39 vs 52) point the same way, but their references are thin.
- The p50 matches (9-12 vs 11-14).
- So either the burst state (sa → 15) or the near-zone share (zf factor 0.5-1.5) is under-represented for solo fish.

**Candidates:**
- the solo fish's first mood duration: uninitialised in the original, treated as 0 here;
- the start of the zone-flip timer (`rand%120+10`, 10-130 s). That is long against a 180 s run, so the near/far split per run is noisy.

**Fix.** A 600 s multi-launch reference for one solo species would decide whether this is real.

**Closable:** partially; it needs more reference time first.

### 4. Front-of-reef share off by 5-9 points in scenes 1 and 3

| Scene | Below reef line, ours (deep) | Reference (deep) |
|---|---|---|
| 1 | 63 % (48 %) | 56 % (39 %) |
| 2 | matches | matches |
| 3 | 44 % (19 %) | 49 % (27 %) |

- In scene 3 the centre-y p50 is still 187-209 against 221.
- In scene 3 the lowest fish per frame has p50 610 against 684.
- Probably coupled to #2 (school behaviour near the reef line) and to the per-launch zone timers (10-130 s).

**Closable:** partially. It is statistical and needs longer runs on both sides.

### 5. Sea horse

- Height band: ours 24/348/619 vs 42/345/563. Turns: 1.0 vs 0.7 per minute.
- Seed-to-seed spread in ours is large: p50 178-490 over 12 seeds × 60 s.
- The original also differs from launch to launch: 250 (40 s run) vs 345 (180 s run).
- Remaining gaps:
  - the navigator's first-frame state, which the original leaves uninitialised (turnBack, counters, sway phase);
  - the sea horse's caustic clock (ours uses the scene clock; the original's own field is [unknown]).

**Closable:** partially. The distribution is right; per-launch randomness cannot be matched frame for frame.

### 6. Scene-2 Relief caustics 8.5 % dim

- Unchanged since round 1, and within the Wine/Mesa rounding band.

**Closable:** partially; closing it would mean tuning toward Wine.

### 7. `?bare=1` differs from the original's `LMA2_BARE`

- The original's bare mode sets foreground = 0, which also turns the fish depth fog off (§3.11) and removes pass 1.
- Ours keeps the fog, so bare-mode colour comparisons of far fish are biased toward blue.
- This is a measurement-tooling issue, not a fidelity one.

**Fix.** Make `bare=1` also disable fish fog.

### Closed since round 1

- climb/dive
- screen-bottom behaviour
- surface with fish
- horizon row
- MSAA
- crab turn, crab height and crab width (the width was a probe artefact)
- sea star start, spin and variants
- sea horse speed-freeze bug and its gross height error
- raw origins
- plant wrap
- mask phase
- crab shadow bob
- `view=fish`
- `wine-ref.sh` volume (rays)
- scenes 2 and 3 now have fish references

### Not re-measured (code unchanged)

- Bubbles, light rays and motes. Their round-1 verdicts stand.

## R2.4 Verdict

**Close, but not yet "as close as reasonably possible".**

**The static picture is done.** It has been at the Wine/WebGL noise floor since round 1, and round 2 closed its last two items:
- the horizon row;
- the surface brightness with fish, now within 1 level in R and G.

**Motion moved from "structurally wrong" to "statistically close".**
- Climb and speed match.
- The height and in-front shares are within a few points.
- The crab and sea star match.

**Top items that would still move it, in order:**
1. `side: FrontSide` on creature materials. One line, visible on every fish. Closable.
2. Follower turn rate, 1.2-2.3× too high in schools and fine for solo fish. Closable; the cause is in the follower branch.
3. Top speed of slow solo species (p90 −30 %). Probably closable; confirm with a longer reference first.
4. In-front and height shares in scenes 1 and 3 (5-9 points). Partially closable; may follow from #2.
5. `?bare=1` should also drop fish fog, so bare comparisons are fair. Tooling.

**Irreducible limits** (unchanged from round 1):
- **Wine's software GL is the reference, not a 2005 driver.** That caps the painting at 42-45 dB and the caustic levels at ±9 %.
- **The original seeds `rand()` per launch.** Zone timers (10-130 s), school membership, sea horse spawn, the star variant and the mask phases can match only in distribution. That is also why a single reference run under about 3 minutes cannot rank a species.
- **The original integrates per frame.** Tested from 6 to 60 fps: turn rates change by about 20 %, speeds by less than 5 %.

---

# Round 3 (`main` @ 38026f1)

Since round 2, two things landed:
- 63b509a: back faces are now culled (FrontSide), and `?bare=1` has no creature fog. These were my round-2 items 1 and 7.
- 38026f1: `tools/probe-track.ts` and `Tank.silhouettes()`. No motion code changed.

I checked the motion agent's claims myself rather than taking them as given:
- **Probe-track runs.** I ran `probe-track` on seeds it did not use: 21-24, all 3 scenes, at f30 and f5.
- **Pipeline fairness.** I measured both sides with a new diagnostic, `tools/trackfair.py`.
- **More reference launches.** I captured 8 new launches of the original (two at a time): 2 × yellow tang, 2 × purple tang (300 s), 2 × sea horse, and a second full-scene launch each for scenes 1 and 3. They are in `r3/ref/*`. The frames are thinned to every 60th to save disk; the tracks are kept.

## R3.1 Is the same-pipeline comparison fair?

`trackfair.py` reports the same quantities for both sides, per source. Scene 1 is shown; scenes 2 and 3 look the same.

| Source | Frame dt | Blobs/frame | Blob area p50 | Width p50 | Track duration p50/p90 (s) | Turns/min | Turns/min, tracks ≥ 10 s | \|vy/vx\| |
|---|---|---|---|---|---|---|---|---|
| Wine reference, 300 s | 0.20 | 18.5 | 1170 | 42 | 5.4 / 15.8 | 3.73 | 4.39 | 0.43 |
| probe-track f30, my seeds | 0.20 | 17.7 | 1213 | 45 | 4.6 / 14.2 | 2.80 | 3.30 | 0.44 |
| probe-track f5, my seeds | 0.20 | 17.5 | 1302 | 47 | 4.8 / 13.8 | 3.10 | 3.39 | 0.48 |
| probe-track f30, motion agent's seeds | 0.20 | 17.7 | 1205 | 45 | 5.0 / 14.4 | 2.72 | 3.14 | 0.47 |
| Wine subsampled to 0.6 s | 0.60 | 18.5 | 1172 | 42 | 4.2 / 12.6 | 3.38 | 3.86 | 0.43 |
| My round-2 browser run | 0.48 | 17.5 | 1222 | 46 | 4.9 / 13.8 | 2.47 | 2.38 | 0.44 |

**The pipeline is fair enough for whole-tank statistics.** Frame interval, blob count, blob size and track length agree within about 10 %. Two biases remain, and they are small:
- **Silhouette size.** Ours covers the whole triangle footprint, including fully transparent fin texels, so blobs are 3-12 % larger and merge slightly more.
- **Solo fish tracks run longer in ours.** On single-species runs our track p90 is 35-83 s against 20-57 s. A synthetic mask has no near-threshold dropouts, motes or colour noise, so tracks break less. The "tracks ≥ 10 s" column is less sensitive to breaks, which is why I report it.

**Occlusion.** `--occlude` hides behind-fish pixels only below the reef polyline. A real full-scene capture also loses fish behind the billboards, and in animated areas (plants, caustics, surface, bubbles) where the noise map raises the threshold. So probe-track reef-front numbers are only approximate, and I cross-check them against my real-pixel browser runs.

**Frame rate.** Sampling matches (0.20 s both sides). Simulating at f5 instead of f30 changes turn counts by 5-20 %.

## R3.2 Whole-tank turns: the motion agent is right, and my round-2 claim is retracted

| Scene | Reference | Ours f30 / f5 (my seeds) | Tracks ≥ 10 s, ref vs ours f30 / f5 |
|---|---|---|---|
| 1 | 3.73 | 2.80 / 3.10 | 4.39 vs 3.30 / 3.39 |
| 2 | 2.42 | 1.94 / 2.39 | 2.35 vs 2.25 / 2.56 |
| 3 | 2.87 | 2.22 / 2.38 | 3.22 vs 2.55 / 2.50 |

- This reproduces the motion agent's numbers on independent seeds.
- Whole-tank turn rate is **not** too high. If anything it is 0.75-1.0× the reference.
- Round 2's "1.2-2.3×" had two causes:
  - I compared exact probe tracks against blob tracks.
  - My browser runs for scenes 2 and 3 ran at about 1 s per frame (dt 0.96-1.04, against 0.6 for the subsampled reference). That changes track linking.
- **Retracted.** The two new full-scene launches (with caustics) put the reference itself at 1.6 and 2.3 turns/min in scenes 1 and 3, against 2.3 and 2.4 in round 1. So launch-to-launch spread alone is about ±25 %.

## R3.3 Per species, same pipeline

The table compares probe-track (4 seeds × 180 s, scene 1) against the 180 s Wine references. "ref" values are single launches except where three are listed.

| Species | Turns/min ref | Turns/min ours | ≥ 10 s ref / ours | \|vy/vx\| ref / ours | Verdict |
|---|---|---|---|---|---|
| **yellow tang** | 1.86 / **1.66** / **2.34** (3 launches, pooled 1.96) | 3.66 (my seeds); 2.71 (agent's 11 seeds); per seed 1.4-4.1, median about 2.9 | 2.11 / 3.05-3.79 | 0.44 / 0.41-0.43 | **OFF, 1.4-1.9×** |
| convict tang | 3.10 | 3.67 (agent: 3.22) | 3.17 / 3.93 | 0.41 / 0.39 | CLOSE (1.0-1.2×, one launch) |
| powder brown tang | 3.80 | 4.04 | 3.58 / 4.20 | 0.38 / 0.41 | CLOSE |
| raccoon butterfly | 2.22 | 1.92 | 2.44 / 2.01 | 0.34 / 0.41 | CLOSE |
| flame angel (solo) | 1.77 | 1.82 | 1.83 / 1.86 | 0.23 / **0.32** | MATCHES; climbs more |
| purple tang (solo) | 1.79 | 2.03 | 1.72 / 2.07 | 0.27 / 0.28 | MATCHES |
| juvenile angel (solo) | 1.08 | 1.68 | 1.06 / 1.74 | 0.21 / **0.29** | CLOSE (few events); climbs more |

**Yellow tang turns too often: 1.4-1.9×.**
- This is the one per-species excess that survives the fair pipeline.
- The three new reference launches are tight: 1.66 to 2.34.
- 7 of the motion agent's 11 seeds lie above the highest reference launch, and so does the pool of my 4 seeds.
- So it is not launch spread. The motion agent's "2.6-2.9 vs 1.9" is correct, and the gap is real.
- Other schooling species (convict, powder brown, raccoon) are within 1.0-1.2×.
- One candidate: yellow tang is the largest schooling fish in the set (scale 8 against 6). Avoidance radius is 3.2·scale·meshRadius, and it applies between every same-species pair and the invisible leader, so a bigger fish means more avoidance turns inside its own school.
- **Can close:** probably. Instrument avoidance events per school member (yellow tang against convict) and compare the turn sources.

**Solo angels climb 35-40 % more.** Flame angel \|vy/vx\| is 0.32 against 0.23, juvenile angel 0.29 against 0.21; purple tang matches. Only three solo species have 180 s references. This is a small effect, and on thin reference data.

## R3.4 Purple tang top speed: closed (it was a one-launch artefact)

| | Speed p50/p90 (px/s) | Centre-y p50 |
|---|---|---|
| Reference, round-2 launch (180 s) | 14 / 64 | 313 |
| Reference, new launch b (300 s) | 9 / 44 | 262 |
| Reference, new launch c (300 s) | 9 / 50 | 259 |
| Reference, 3 launches pooled | 10 / 51 | 266 |
| Ours, probe-track | 10 / 48 | 168 |
| Ours, exact probe | 10 / 42 | 232 |

- My round-2 "p90 −34 %" came from the one fast launch. Pooled over three launches, ours is within 6-18 %: **MATCHES within launch spread.**
- The flame angel p90 (50 against 60) has only one launch, but its turns and p50 match. I agree with "within spread".

## R3.5 Sea horse lows: not explained by launch randomness

Five scene-1 reference launches, blob centroids, blobs with area > 200 px:

| Launch | Duration | Deepest centre y | % of time below y = 470 | Height p50/p90 |
|---|---|---|---|---|
| fish agent | 40 s | 338 (p98) | 0 | 75 / 111 |
| round 2, sp | 180 s | **571** | 11.2 | 103 / 112 |
| round 2, horse1 | 300 s | 475 | 0.1 | 82 / 111 |
| round 3, b | 240 s | 484 | 0.7 | 72 / 106 |
| round 3, c | 240 s | 463 | 0 | 74 / 109 |
| **Ours**, 4 seeds × 180 s | | p98 619, max about 627 | 1.4-13.8 per seed | 73 / 110 |

- **Instrumented, ours:** 10 seeds × 180 s × 3 horses, screen-y of the origin.
  - Horses in zone mode 0 (near): p02/50/98 = 18 / 466 / **627**.
  - Horses in zone mode 1 (far): p02/50/98 = 10 / 285 / 468.
  - 627 is the horse floor `minY + 0.1·H` of the whole box. 468 is the same floor rule applied to the far zone (`zone.minY + 0.1·zoneH`).
- **In the original:**
  - Near-zone horses do exist: the round-2 launch has height p50 103 px, the near-zone size.
  - They are visited low: 11 % of that launch was below 470.
  - Yet across 5 launches (about 15 horses, 1000+ s) the deepest centroid is 571, and 4 of 5 launches never went below 484.
- **Verdict:** ours reaches roughly 50 px lower than anything observed. Per-launch randomness alone is unlikely to hide a 627-px floor for 15 horses.
- **Where it comes from is unresolved.** The navigator, the zone table (0x414770), the waypoint floor (0x417e40) and the per-frame clamp in 0x41f540 all read the same as our port. I re-checked the box argument order of the horse loader (0x41f330, via the disassembly at 0x4132af): it passes (min.x, 0.8·min.y, min.z), (max.x, max.y, 0.8·max.z), which matches ours.
- **Can close:** probably. Next step: log the navigator state (mode, zone.minY, waypoint y, clamp) for one horse in ours. Then decide which floor the original must be using, from the 571 px launch; it sits between the two floors.

## R3.6 Fish in front of the reef (two launches now)

"Below" is the share of moving-fish detections below the reef line; the figure in brackets is the share more than 150 px below it.

| Scene | Reference launch 1 | Reference launch 2 (new) | Ours, real-pixel browser run | Ours, probe-track --occlude, 4 seeds (agent) |
|---|---|---|---|---|
| 1 | 56.3 % (39.3) | 53.0 % (33.3) | 63.1 % (47.8) | 40-60 % (25-45) |
| 3 | 48.5 % (26.5) | 52.0 % (28.8) | 43.6 % (18.7) | 31-47 % (15-29) |

- **Scene 1:** ours brackets the reference. MATCHES within spread.
- **Scene 3:** every one of our five measurements (4 seeds plus the real-pixel run) is below both reference launches. The gap is about −5 to −17 points, and −8 to −14 deep.
  - It agrees with the scene-3 centre-y p50 being high since round 1: 187-209 against 221.
  - It is small, but it is consistent, and it is scene-specific. Scene 3's reef line reaches down to y = 315, the lowest of the three scenes.
- **Can close:** partially. The first step is to check the reef-line clamp against scene 3's `height` polyline, and the scene-3 zone/floor numbers.

## R3.7 Colour after the FrontSide fix

Measured with `tools/fishcolour.ts` on bare frames at the same `?t=` values as round 2. Our frames now also have no fog, like the original's bare mode.

| Species | Ours R3 (R / G / B mean) | Reference (R / G / B mean) | Round 2 |
|---|---|---|---|
| yellow tang | 151.6 / 152.3 / **40.1** | 146.0-147.4 / 148.9-151.4 / **43.3-46.6** | B 30.0 (double-sided) |
| purple tang | 48.2 / 54.3 / 114.8 | 45.2 / 50.3 / 105.2 | - |
| flame angel | 144.9 / 95.1 / 61.5 | 135.5 / 84.9 / 51.2 | - |

- **Yellow tang: CLOSED.** B is now within 3-6 levels, and R and G are within 1-6.
- **Purple tang and flame angel** are 3-10 levels brighter in every channel in ours.
  - That is the order of the Wine/WebGL rounding band plus sampling (12 frames, small fish).
  - A small systematic gain difference in the fixed-function emulation cannot be excluded. The sign is not the same for every species: yellow tang B is lower.
  - **CLOSE.**

## R3.8 Round-3 verdict

**The remake is not yet at the limit, but what remains is small and specific.** Almost everything else is now at the noise floor or within launch-to-launch spread.

Round-3 closures, verified:
- whole-tank turn rate (my round-2 claim was a measurement artefact);
- purple tang top speed (a single-launch artefact);
- yellow-tang colour (FrontSide);
- the bare-mode fog.

**Still closable, concretely:**
1. **Yellow tang turn rate, 1.4-1.9×.** Three tight reference launches (1.66-2.34) against a median of about 2.9 over 15 seeds. The other schooling species are fine.
   - Instrument the school's avoidance and leader turns; the suspect is the avoidance radius, which is scale-dependent, inside a school of large fish.
   - **Closable: probably.**
2. **Sea horse lower bound.** Ours goes down to 627 px; the original never went below 571 over 5 launches (4 of 5 stayed above 484).
   - Log the navigator floors in ours and find which one the original applies to near-zone horses.
   - **Closable: probably.**
3. **Scene-3 in-front share and height,** about −8 points and about 30 px high, consistent over 5 of our runs against 2 launches.
   - Check the reef-line blend and floor for scene 3.
   - **Closable: partially.**
4. **Minor:** solo angels climb 35-40 % more (\|vy/vx\| 0.29-0.32 against 0.21-0.23, on single launches). Not worth a change until a second launch confirms it.

If items 1-3 turn out to be deliberate original behaviour that our port already matches (the decompile reads have not found a difference yet), then I would agree the remake is as close as reasonably possible. Until they have been instrumented, I do not.

**Irreducible limits:**
- **The reference is Wine's software GL, not a 2005 D3D6 driver.**
  - Painting: 42-45 dB.
  - Caustic level: ±9 % (scene 2 is 8.5 % dim).
  - Creature colour: ±10 levels.
- **Per-launch `rand()` seeded from GetTickCount.**
  - Zone timers (10-130 s), school membership, sea-horse spawn, sea-star variant and plant mask phases can only match in distribution.
  - Measured launch spread: turn rate ±25 % (whole tank), purple tang p90 44-64, sea horse time below 470 px 0-11 %.
  - Any claim from one launch under about 3 minutes cannot rank a species.
- **Per-frame integration in the original.** Changing the simulation rate from f5 to f30 moves turn counts by 5-20 %. Wine runs at about 5 fps; the original on real hardware would have run faster.
- **Measurement.** probe-track's synthetic silhouettes break tracks less than real captures, and its reef-only occlusion is approximate. Differences below about 10 % in blob-pipeline statistics are within method error.

---

# Round 4 (`main` @ fe7fd19)

Round 4 re-checks what feat/decomp2 (merged at cf35e23), 0263f33 and fe7fd19 changed. The motion3 and decomp2 reports were checked against my own measurements, not taken as given:

- **Seeds and generator:** new seeds (3001-3016) with the original's CRT `rand()` (`--crt`).
- **New reference launches:** 4 more bare sea-horse launches and a second full-scene launch of scene 2, at most two Wine captures at a time (`r4/ref`, frames thinned to every 60th).
- **Real-pixel runs:** our browser, seeded from the clock (`?seed=time`), run through the same `track.ts` as the reference (`r4/full2a`, `r4/full2b`, `r4/full3a`, `r4/ytang-rp-*`).
- **New tools:** `tools/horsedepth.py` (sea-horse depth per zone) and `tools/subtracks.py` (thins a track file to a slower frame rate).

## R4.1 The "raw height = y 0" claim: CONFIRMED

- **Loader:** `0x41bac0` finds the mesh named `height` through `0x42ecc0`. `0x42f7a0` (GetGeometry) only returns the +0x60 vertex pointer and the +0x5c count; I read it in the disassembly and it is 6 instructions long.
- **Copy:** the copy loop at 0x4126d1 reads x and y at a 32-byte stride into the polyline. No matrix is applied anywhere on that path.
- **Data:** the raw `height` vertices in all three `mesh.X` files have y = 0.000000 exactly. The profile is modelled in z, and only the frame matrix stands it upright for drawing.
- **Consistency:** this matches how `Crab_Path` is read raw, which round 2 confirmed from the crab's screen height (within ±4 px).
- **Consequence:** the reef line is world y = 0 everywhere. In scene 2, world y = 0 lies below the bottom of the screen, so fish there may cross the foreground plane anywhere.

## R4.2 Nothing at 4:3 changed

Nine 1024x768 `?clean=1&t=` stills were rendered on fe7fd19: painting, surface and caustics, all three scenes. Each is **pixel-identical** (ImageMagick AE = 0) to the same URL rendered on 4d5476d in round 2.

## R4.3 Sea horse lows: CLOSED (my round-3 claim retracted)

Blob height separates the two zones cleanly: near-zone horses are ≥ 92 px tall, far-zone ones 64-80 px. `horsedepth.py` measures the deepest centroid of every near-zone episode.

| | Near-zone horse-seconds | Episodes | Deepest centre y | Episodes reaching > 600 px | Per 100 near horse-s |
|---|---|---|---|---|---|
| Reference, 5 older launches | 814 | 17 | 571 | 0 | 0 |
| Reference, 4 new launches (d, e, f, g) | 1364 | 23 | **615 / 620 / 622** | 5 | 0.37 |
| **Reference, all 9 launches** | 2177 | 40 | 622 | 5 | **0.23** |
| Ours, 16 seeds × 240 s | 5081 | 28 | 628 | 15 | **0.30** |

- **The original reaches the floor too.** 3 of the 4 new launches went to 615-622 px.
- **The old launches were unrepresentative.** Four of them were mostly far-zone, where the floor is at 468 px.
- **So "about half of near-zone horses reach the floor" is consistent with the original.** The floor-reaching rate is 0.30 against 0.23 per 100 near-horse-seconds, well within Poisson error for 5 events.
- **The uninitialised fields need no explanation here.** Nothing is left for them to explain.

## R4.4 Fish in front of the reef, after the raw-height change

The table shows the share of moving-fish detections below the painted reef edge. The figure in brackets is the share more than 150 px below it.

| Scene | Reference launches | Ours, probe-track --occlude, 4 CRT seeds | Ours, real pixels |
|---|---|---|---|
| 1 | 56.3 (39.3), 53.0 (33.3) | 58.1 (41.6), 53.5 (35.5), 51.3 (36.4), 43.9 (27.5) | - |
| 2 | 63.3 (39.8), **59.7 (36.3) new** | 78.2 (63.5), 72.1 (52.0), 75.9 (62.2), 70.9 (59.3) | 72.6 (51.2), 64.2 (41.9) |
| 3 | 48.5 (26.5), 52.0 (28.8) | 48.2 (27.2), 51.1 (29.3), 50.7 (35.6), 35.1 (16.4) | 43.7 (15.8) |

- **Scenes 1 and 3:** the reference launches sit inside our spread, so both MATCH. My round-3 scene-3 item is CLOSED.
- **Scene 2:** the new launch agrees with the old one (60-63 %, 36-40 % deep). Ours is higher.
  - probe-track reads +10 to +24 points, but it ignores the occlusion by scene 2's large billboards and the real noise floor.
  - The two real-pixel runs read +1 to +13 points (64/42 and 73/51 against 60/36 and 63/40). They are the fair comparison, because they are detected exactly like the reference.
  - **Verdict: CLOSE, possibly slightly high.** With two launches per side and about ±6 points of launch spread, the difference is not established. It follows from R4.1: in scene 2 nothing stops fish crossing low. That is the original's rule, so there is no code change to make.

## R4.5 Turn rate: the metric depends on the pipeline, and nothing can be claimed from it

**Whole tank** (probe-track, CRT seeds, 30 fps; turns per track-minute):

| Scene | Ours | Reference | Ratio |
|---|---|---|---|
| 1 | 2.69 | 3.73 | 0.72 |
| 2 | 2.09 | 2.42 | 0.86 |
| 3 | 2.29 | 2.87 | 0.80 |

At Wine's ~5 fps, ours rises 5-20 % (round 3), which puts it at 0.85-1.0. MATCHES.

**Yellow tang: the near/far explanation is only partly right.**
- The motion agent's claim was that all three reference launches were far-zone. They were not. Splitting tracks by blob width (< 44 px = far-sized) gives:

| | Far-sized tracks | Near-sized tracks |
|---|---|---|
| Reference, 3 launches | 1.73 (1215 s) | 2.36 (712 s) |
| probe-track, 8 + 11 + 4 seeds | 2.28-2.75 | 3.28-4.88 |

- At matched size, probe-track still says ours turns 1.3-2× as often.
- **The decisive test is real pixels.** Three clock-seeded browser launches of `?bare=1&tank=yellow-tang:4` were tracked by `track.ts`. Against the reference thinned to the same frame rate (`subtracks.py`):

| | Turns per min | Tracks ≥ 10 s | Track length p50 | Speed p50/p90 |
|---|---|---|---|---|
| Ours, real pixels | **0.91** (0.54-1.35) | 0.93 | 5.9 s | 26/70 |
| Reference | 1.65 (1.27-2.12) | 1.95 | 11.8 s | 25/65 |

  Speeds agree, so the browser clock was not throttled.
- **Two pipelines give opposite answers:** real pixels say ours turns about half as often, probe-track about 1.5× as often.
- **Why they disagree:**
  - With 4 fish in a tight school, the blob linker merges fish, splits them and swaps identities.
  - How often that happens depends on silhouette detail: fringes, alpha, colour noise.
  - So the count moves by ±2× between measurement methods, more than any remaining difference between the programs.
- **Code check:** the decompile audit (motion3) matches the follower, avoidance and gate code instruction by instruction.
- **Verdict:** the yellow-tang turn excess is **not established**. The metric cannot resolve better than about 2× for a tight school, so there is nothing to fix. My round-3 item is withdrawn.

## R4.6 Round-4 verdict

**I agree: the remake is now as close to the original as can reasonably be achieved or measured.**

Every item I raised in rounds 1-3 is closed, retracted or not established:

- **Closed:** camera, painting, surface, caustic-lit surface, horizon, bubbles, colour, back faces, climb/dive, speeds, screen-bottom behaviour, crab, sea star, the sea-horse speed bug and start pose, reef-front in scenes 1 and 3.
- **Retracted:**
  - round-2 whole-tank turn excess: a pipeline artefact;
  - round-3 sea-horse floor: the original reaches it too;
  - round-2 purple-tang top speed: a single-launch artefact.
- **Not established:**
  - yellow-tang turn rate: the metric resolves only to about 2×;
  - scene-2 reef-front, +1 to +13 points over 2 launches: the original's own rule;
  - solo-angel climb ratio: a single launch per species.

None of these has a code-level cause left. Pursuing them would need tens of reference launches per item, and even then the answer would be "distribution matches".

**Final irreducible limits:**
1. **The reference is Wine, not the original hardware.** Wine renders Direct3D 6 through Mesa's software GL, not a 2005 driver:
   - painting 42-45 dB PSNR;
   - Relief caustic level within ±9 % (scene 2 is 8.5 % dim);
   - creature colours within ±10 levels;
   - 1-px edge rules approximated by the 0.5 px nudge.
2. **Per-launch randomness.** The original calls `srand(GetTickCount())` once (0x412483). The start state is unknowable, and after the first frame the sequence also depends on frame timing (motes draw `rand()` every frame). So zone timers (10-130 s), school membership, start poses, sea-horse spawn, the sea-star variant and the plant mask phases can only match in distribution. The measured launch-to-launch spread in the original:
   - whole-tank turn rate ±25 %;
   - purple-tang p90 speed 44-64 px/s;
   - sea horse near-zone share and floor visits from 0 to 3 per launch;
   - reef-front ±6 points.
3. **Per-frame integration.** The original's position averaging, pitch smoothing and 10-frame avoidance history make its motion depend on frame rate. Wine runs it at about 5 fps, the browser at 60. The measured effect is 5-20 % on turn counts and under 5 % on speeds.
4. **What the measurements can resolve:**
   - Blob tracking of real or synthetic frames resolves speed, height, size and zone statistics to about 10 %.
   - It resolves turn-around counts of tightly schooling fish only to about 2×.
   - Any single reference launch shorter than about 3 minutes cannot rank a species.
