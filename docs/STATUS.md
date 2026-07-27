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
| 6 | 4/6 baseline, 5/6 after | 4/6 | **plateau** — see below |

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

1. **Composition (4.3) and geometry craft (4.5)** are the lowest axes. Round 6 targets them.
   The critique is no longer "wrong framing" — it is **no focal hierarchy**: everything equally
   detailed, lit and sharp, so the eye has nowhere to land.
2. **Inventory** — consumables were infinite; an agent was mid-way adding a party stock model.
   Verify with `npx vitest run tests/inventory.test.ts`.
3. **SHP/SEQ animation data** in `assets-src/unit/*.bin` is still undecoded. Units use whole-body
   pose cells. Decoding gives authentic FFT animation and is the largest remaining art win.
4. **22 sprite sheets in the rip are broken stubs** (see docs/ASSETS.md §1.2). Dark Knight and
   Onion Knight are re-pointed at Knight/Squire sheets; `chocobo` has zero whole-body frames.

---

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
