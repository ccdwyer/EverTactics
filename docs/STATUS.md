# EverTactics — STATUS / RESUME

**If you are a new session, start here. Read this file first, then run `npm run verify`.**

This file is the handoff. It is updated at the end of every polish round. Everything in it is
either measured or linked to the command that measures it — do not trust a claim here that you
have not re-verified, because rounds land between updates.

---

## Resume in three commands

```bash
npm run verify          # typecheck + tests + build + render + measure. Ground truth in ~2 min.
npm run round           # run the next visual polish round (see "The loop" below)
git log --oneline -20   # what the last session actually did
```

`npm run verify` appends to `docs/metrics-history.jsonl`, so the trend survives across sessions
even when the conversation does not.

---

## What this project is

A tactical RPG in the lineage of Final Fantasy Tactics and Triangle Strategy, in Three.js.
HD-2D: real FFT sprites billboarded inside a lit, post-processed 3D diorama.
Job system is FFT's spine (22 canon jobs) plus 6 from EverQuest 2 and 6 from World of Warcraft.

The bar, set by the user: **blind judges shown our frame next to a shipped commercial tactical RPG
should not be able to tell which is which.**

---

## Current state — last updated end of round 5

### Gameplay: complete
- Battle loop: CT turn order with predictive forecast, movement with height/jump, facing and back
  attacks, FFT damage formulas, zodiac compatibility, status engine, reaction abilities firing live
- 34 jobs, ~395 abilities, JP economy, unlock tree — **reachable in-game** (press `J` in battle)
- AI engages and resolves: verified 16/16 battles across 8 seeds x 2 maps
- Deterministic: same seed produces a byte-identical event stream
- Interactive play verified through real keyboard input
- 362 tests, typecheck clean

### Visuals: measurably close, not yet indistinguishable
Blind A/B against curated Triangle Strategy battle frames, six pairs per round:

| round | judges who identified ours | judges who preferred ours | notes |
|-------|---------------------------|---------------------------|-------|
| 1 | 6/6 | 0/6 | |
| 2 | 6/6 | 2/6 | |
| 3 | 6/6 | 3/6 | |
| 4 | 6/6 | 5/6 | test found to be confounded — see below |
| 5 | **4/6** (baseline, cropped) | 4/6 | first identification failure |
| 5 | 5/6 (after fixes) | 5/6 | grounding 2.5 -> 4.5 |
| 6 | 4/6 baseline, 5/6 after | 4/6 | |
| 7 | 5/6 baseline, 5/6 after | 5/6 | |
| 8 | **2/6** baseline, 5/6 after | **6/6** baseline | see the variance note |
| 9 | 5/12 baseline, 9/12 after | **11/12** and **10/12** | first n=12 round |

### Round 9, the first round with enough samples to say anything
Identification: 5 of 12 then 9 of 12. Tested against a pooled rate of 0.58, P(<=5 of 12)=0.19 and
P(>=9 of 12)=0.19 — so even at n=12 that swing is NOT significant. Do not read it as a regression.

Preference IS significant. Judges preferred our frame 11 of 12 and 10 of 12.
P(>=10 of 12 | a true coin flip) = **0.019**.

So the defensible statement, as of round 9, is:
**judges reliably prefer our frame to a shipped commercial SRPG frame (p ~ 0.02), while still
identifying which is the prototype more often than chance.** Those are different claims and only
the first is established. The user's bar is the second, and it is not met.

### n=6 was never enough to read a single round
Rounds 7 and 8 scored essentially the same build at 5/6, then 2/6, then 5/6 identified. That is not
improvement followed by regression — it is noise. Under a true identification rate of ~70%:

    P(<= 2 of 6) = 0.07        P(>= 5 of 6) = 0.42

Both are ordinary outcomes of one underlying rate. **Do not read a single round's number as
signal, and do not celebrate a good one.** Round 8's baseline of 2/6 caught and 6/6 preferring ours
is the best result recorded here and it is probably mostly luck.

Judging now runs **12 pairs per stage** (was 6), drawn from 24 curated references so the after-judges
never see a frame the before-judges saw. Doubling n roughly halves the standard error. The honest
long-run read across rounds 5-8 is an identification rate somewhere around 60-80%, trending down
slowly, with preference for our frame consistently at 4-6 of 6.

### The plateau, and what it probably is
Rounds 5 and 6 both sit at 4–5 of 6 identified. Identification has broken twice but is not
trending toward zero, while preference holds at 4–5 of 6. Per-axis scores keep climbing, so the
renderer is still improving and the test has stopped responding to it.

The likely irreducible part: **our units are literal FFT sprites.** Triangle Strategy's sprites are
its own art. A judge who knows the genre recognises Ivalice character art regardless of how well it
is lit or grounded — the same class of recognition cue as the character names and HUD vocabulary
that forced the crop in round 5, and equally immune to shader work.

### That plateau hypothesis was WRONG — tested and refuted
A sprite-free comparison was run: our `terrain-only` render against environment-dominant shipped
frames. If the residual had been sprite recognition, environments alone would have been hard to
separate. **They were not.** The judge separated all four instantly, at 95-99 confidence, and
produced a long list of concrete environment defects (flat ambient with no cavity darkening, no
bounce from the brazier, a fixed-radius PCF penumbra that never hardens at contact, one roughness
value scene-wide, masonry joints painted into albedo rather than normal-mapped, visible tiling
period, no aerial perspective, DOF as a two-layer threshold rather than a ramp, duotone palette
with no tertiary hue, no focal hierarchy, unreadable scale).

So the environment rendering is genuinely still distinguishable. There is real work left and it is
enumerated. Do not attribute the gap to the sprites.

**Two flaws in that experiment, both mine, worth not repeating:**
1. I used ONE `terrain-only.png` against four references, so the same prototype frame appeared in
   all four pairs and the per-pair shuffle was trivially defeated by cross-referencing. The judge
   caught this and said so rather than pretending to four independent reads. Use a different
   scene/angle per pair.
2. One reference was a dialogue box ~85% occluded by UI — worthless for an environment test.

### The reference corpus is NOT all Triangle Strategy
`refs/curated/triangle/` is mislabelled. The judge identified `official_029_se_screenshot.png` as
Vanillaware's **Unicorn Overlord**, and visual audit confirms it. A few others look like they may
also not be Triangle. The set is better described as **shipped commercial SRPG frames, mostly
Triangle Strategy**. The blind test is still valid — it asks "shipped game or prototype?" — but do
not describe results as "vs Triangle Strategy" without checking the specific file.

Metric gates (`node tools/metrics.mjs <frame>`), all passing as of round 5:

| metric | reference range | ours |
|---|---|---|
| connected-component void | 0.087 – 0.180 | 0.113 |
| luminance spread | 118 – 166 | 198 |
| local contrast | 17 – 20 | 33 |
| mean saturation | 0.45 – 0.86 | 0.50 |

---

## Known open items

0. **THE COOL TOP-FACE WASH — FIXED at the end of round 8. Do not re-chase it.**
   Named by critics across four rounds ("a bright cyan-white edge strip on nearly every block's
   top-front edge regardless of orientation — it fires identically on faces turned toward and away
   from the key light, and inside the shadowed pit"), attributed to "the terrain shader" mid-round-8
   but not to a line. **The line was the inter-reflection floor** — the `uBounceFloor` term in
   `src/render/materials/terrain.ts`, added earlier in round 8 to stop unlit faces going pure black.
   The term was right; its *magnitude and hue were compile-time constants*, so it lit the board
   with no light in the scene at all, and its hard-coded blue sky-bounce was a daylight assumption
   imposed on a torch-lit night courtyard. That is why four rounds of lighting work never moved it:
   nothing in `lighting.ts` reached it.

   Diagnostic that pins it (run it before believing any future claim about this):

       node tools/shoot.mjs --scene terrain-only --out shots/alldark.png \
         --query "lightdebug=keyIntensity:0,rimIntensity:0,hemiIntensity:0,ambientIntensity:0,\
   probeIntensity:0,cavity:0,practicalGain:0,sourceBounce:0"

   **Independently re-verified by the lead, and the claim is only partly borne out.** That command
   gives `meanLuma` **17.9**, not the "low single digits" reported. The fix is real and the
   direction is right — the term is no longer the dominant emissive contributor — but something
   still lights the frame with every light at zero. Most likely the environment layer (sky, glow
   cards, motes), which is legitimately emissive and is **not** covered by `?lightdebug`. Before
   concluding anything further here, disable the environment too (`StageOptions.environment: false`
   or `stage.environment.setEnabled(false)`) and re-measure.

   With **every light at zero** the board must be black. Before the fix it was fully legible and its
   up-faces read cool blue: a flagstone finishing at rgb(127,121,118) still carried rgb(31,48,76),
   whose channel ratio 0.41:0.63:1.00 is the old `BOUNCE_COOL` constant to a rounding error. Not the
   grade (`?postdebug=no-grade` leaves it), not fog (`fogStart:9000` leaves it).

   The fix: `LightingRig.publishTerrainBounce()` premultiplies the rig's *own* graded sky and
   ground-bounce colours by the levels it actually committed and pushes them through
   `setTerrainBounce()`. The lobes are now irradiance, not colour, so the term follows every dial
   including all the way to zero.

   Measured on `battle-open`, before → after:

   | | before | after | reference |
   |---|---|---|---|
   | terrain residual with all lights off | rgb(31,48,76) | rgb(7,8,13) | ~0 |
   | lumaP95 | 158.9 | 148.4 | 116 – 136 |
   | meanLuma | 51.7 | 46.8 | 36 – 50 (night) |
   | meanSaturation | 0.542 | 0.576 | 0.45 – 0.86 |
   | darkShareOfSubject | 0.39 | 0.405 | 0.41 – 0.63 (night) |

   A lit top face under the warm key now reads rgb(112,98,88) — warm — where it used to read
   rgb(127,121,118), i.e. neutral grey under an amber light, which is its own entry on the fail list.
   `lumaP95` is still ~12 over the band; the residue is a broad near-clipping specular lobe on stone
   up-faces (`floor` p99 measures 244), not this term. That is the next thing to look at, and it
   belongs to `roughRange` in `materials/terrain.ts`, not to the lighting rig.

0b. **Hard two-tone chevrons over the play board — OPEN, unattributed.**
   Small saturated wedges, one half warm cream and one half cyan, scattered across tile tops in the
   mid-band (clearest at `shots/r8/after/crop-z.png`, a 6× crop of terrain-only at 860,490). They are
   *lit* geometry, not an overlay: they go dark in the all-lights-off render. They survive
   `rimIntensity:0,contrast:0`, so they are not the rim. They appear in `terrain-only`, so they are
   not sprites or UI. Most likely a foliage/shoot card being lit warm on one face and cold on the
   other with no softening. Hard-edged saturated artefacts sitting on tiles the player has to count
   are a rubric problem; worth one focused session.

1. **Composition (4.3) and geometry craft (4.5)** are the lowest axes. Round 6 targets them.
   The critique is no longer "wrong framing" — it is **no focal hierarchy**: everything equally
   detailed, lit and sharp, so the eye has nowhere to land.
2. **Inventory** — consumables were infinite; an agent was mid-way adding a party stock model.
   Verify with `npx vitest run tests/inventory.test.ts`.
3. **SHP/SEQ animation — PARTIALLY decoded, deliberately NOT shipped.**
   `tools/decode-shp-seq.mjs` and `tools/preview-anim.mjs` exist and produce
   `public/assets/animations.json` for 12 sheets. `src/render/animation.ts` can consume it.
   **But the assembly is incomplete**: run `node tools/preview-anim.mjs` and look at
   `tools/out/anim-knight_male-frames.png` — heads and torsos assemble, limbs and lower bodies do
   not, and the decoder's own SHP-table fit scores top out at 0.294, i.e. it is guessing which
   table applies. A partial figure is WORSE than a complete static pose, so nothing fetches
   `animations.json` at runtime and units still use whole-body pose cells. Do not wire it in until
   the preview sheet shows complete figures.
   This remains the largest available art win; it is a real reverse-engineering problem, not a
   plumbing one.
4. **22 sprite sheets in the rip are broken stubs** (see docs/ASSETS.md §1.2). Dark Knight and
   Onion Knight are re-pointed at Knight/Squire sheets; `chocobo` has zero whole-body frames.

---

## Diagnostic hooks worth knowing

- `?lightdebug=<field>:<value>,...` overrides any LightingPreset field, applied last in `commit()`
  so it beats a scenario's `tune()`. `?lightdebug=shadows:0` kills every shadow map.
  Pass it through the harness with `--query`. This is how the cool-wash bug above was attributed to
  a layer, and it is far faster than reasoning about the shader.
- `window.__EVERTACTICS_STAGE__.environment` exposes `setEnabled`, `refresh`, `setBoardBounds`, and
  named children (`env-ground`, `env-glow`, `env-backdrop-<band>`). Toggling layers and re-measuring
  is how several defects were attributed to the right owner.
- **Do NOT per-pixel diff two screenshots.** Two identical `tools/shoot.mjs` runs differ by
  meanAbsDiff ~25/255. Sample regions of a few thousand pixels instead.

## The loop

One round = shoot, blind A/B judge, fan out fixers on the weakest axes, re-shoot, re-judge.

```bash
# Round N. Change the seed each round so judges see different reference pairs.
# This is token-heavy: ~3M subagent tokens per round.
```
Invoke via the Workflow tool with `tools/workflows/polish-round.js` and
`args: {"round": N, "seed": <any int>}`.

The fixer briefs inside that script are **living text** — retarget them at what the round's own
judges actually cited. Do not leave stale claims in them; an agent once spent effort re-fixing the
void because the brief still quoted a round-1 measurement as current.

### The blind test is confounded above the crop level
Round 4 hit 6/6 identification with 5/6 preferring ours. The tells showed why: judges were
identifying frames by **reading** them — *"Right frame is literally Triangle Strategy: 'Prince
Roland', speaker 'Erador'"*, *"invented roster names (ALDRIC, CORVIN)"*, *"keyboard prompts
(ENTER Confirm)"*. Those are recognition cues, not rendering quality, and no shader work removes
them. Judging now runs at `--crop 0.6` so most HUD chrome is gone from both sides symmetrically.

Note the crop **breaks the `uiCraft` axis** (it slices panels in half — 7.2 uncropped vs 3.7
cropped) and lowers all baseline scores by magnifying defects. Cropped and uncropped numbers are
not comparable; the cropped ones are harsher and more honest.

---

## Hard-won lessons — read before trusting any tool here

The dominant failure mode in this project has been **something reporting success while silently
doing nothing or the wrong thing.** It happened at least six times:

1. `shoot.mjs` returned `ok: true` on a **black boot-splash frame** — READY fires on renderer
   convergence but the splash is removed on a later event.
2. The workflow's blind judging **ran zero pairs** and reported success, because `args` arrived as
   a JSON string so `args.triangle` was `undefined` and the pipeline iterated an empty array.
3. **Every elemental spell played the same generic flash** — the lookup compared `'fire'` against a
   registry holding `'fire-burst'`, so the branch could never pass.
4. A **GLSL reserved word** (`patch`) failed a whole fragment shader; the frame still rendered with
   a fallback material, so every existing check passed.
5. `play.mjs` had the **same splash bug** as `shoot.mjs`, fixed one file over.
6. `backgroundFraction` measured **hue similarity, not emptiness** — it counted shadow-side terrain
   and UI panels, and went *up* as the frame improved.

Consequences now baked in, do not remove them:
- `shoot.mjs` fails the shot on: no convergence, splash present, blank frame, **or any shader
  compile error** (a failed material does not blank the frame).
- Render against a **static build**, not the dev server. HMR reloads the page on any file save and
  returns it to the splash. See the bottom of `docs/ARCHITECTURE.md`.
- Verify agent claims by measuring, not by reading reports. Two separate agents "added" features
  that were not visible in the rendered frame.
- **Twice** a comment containing backticks was pasted inside a GLSL template literal and terminated
  the JS string. Do not put backticks in shader comments.

---

## Working with parallel agents

Agents run concurrently in one repo, so **file ownership is the only thing preventing lost work.**
Give each agent an explicit owned-file list and tell it to report — not edit — anything outside it.
Cross-boundary requests come back as messages; wire them yourself.

Transient `tsc` errors during a round are normal (agents mid-write). Re-check before reacting; a
"regression" has more than once been a file half-saved.

---

## Updating this file

At the end of each round: update the blind-test table, the metric table, the open items, and
anything learned that would cost the next session time to rediscover. Keep it measured.
