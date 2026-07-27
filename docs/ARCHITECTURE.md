# EverTactics — Architecture Brief

Read this before writing any code. It is the shared contract for every agent working on this repo.

## What we are building

A tactical RPG in the lineage of **Final Fantasy Tactics** and **Triangle Strategy**, rendered in
Three.js. Visual target is **HD-2D**: billboarded pixel-art sprites standing inside a fully 3D,
lit, post-processed diorama. This is exactly how both reference games work, and it is the direction
the available assets support.

Quality bar: a harsh visual critic, shown our frame next to a frame from the reference games,
must not be able to say ours is the obviously worse one. That is the loop we run until it passes.

## Non-negotiable rules

1. **`src/core/` never imports `three`.** Core is pure, deterministic, unit-testable game logic.
   If you need to render something, emit a `BattleEvent` and let `src/render/` react.
2. **`src/core/types.ts` is frozen-ish.** You may *add* to it. Do not change the meaning of an
   existing field without saying so loudly in your report — other agents are coding against it.
3. **Determinism.** All randomness goes through the seeded `Rng` interface. Never call `Math.random()`
   in `core/`. A battle must replay identically from `(seed, command list)`.
4. **Commands in, events out.** `BattleState` is mutated only by applying a `Command`, which returns
   `BattleEvent[]`. The renderer animates the event stream. The UI issues commands.
5. **No placeholder art in committed code paths.** We have real FFT sprites in `public/assets/`.
   Use them. Do not draw coloured boxes and call it done.
6. **Everything is typed.** `npm run typecheck` must pass. No `any` without a comment justifying it.

## Layout

```
src/
  core/            pure logic, no three.js
    types.ts       the contract (read it first)
    rng.ts         seeded RNG
    grid.ts        Battlefield, pathfinding, range/AoE resolution
    unit.ts        stat derivation, job application, level/JP
    jobs/          job table + job tree
    abilities/     ability table, per-set definitions
    combat/        formulas, hit rates, damage, status engine
    ai/            enemy decision-making
    battle.ts      the reducer: applyCommand(state, cmd) -> BattleEvent[]
    ct.ts          Charge Time turn system
  render/          three.js only
    stage.ts       renderer, scene graph, resize, frame loop
    camera.ts      tilted-orthographic isometric rig, rotation, zoom
    terrain.ts     diorama mesh generation from Battlefield
    sprites.ts     billboarded unit sprites, palette swap, animation
    post.ts        post-processing stack
    vfx.ts         ability effects
    materials/     shaders
  ui/              DOM/canvas overlay UI
  state/           app-level state, scenario loading
public/assets/
  sprites/    457 HD sheets, 512x512, 8x8 grid of 64px cells
  portraits/  352 face textures
  palettes/   2208 .act files, 16 colours each (see below)
  weapons/    weapon overlay atlases
  summons/    16 summon sheets
```

## Asset facts (verified)

- **Sprite sheets**: `public/assets/sprites/NNNN_Name_Gender_hd.png`, 512×512, laid out as an
  **8×8 grid of 64×64 cells**. Top rows are whole-body poses; lower rows are body parts
  (heads, limbs, cape segments) that the original engine assembles per-frame via SHP/SEQ data.
- **Animation binaries**: `assets-src/unit/*.bin` — `*_shp.bin` (frame assembly) and `*_seq.bin`
  (animation sequences). Decoding these yields authentic FFT animation. This is a real
  reverse-engineering task; the community formats (Ganesha / FFTPatcher lineage) document them.
  Until decoded, use the whole-body pose cells directly.
- **Palettes**: `.act` = Adobe Color Table, 16 RGB triplets (48 bytes, often padded to 768).
  Battle palettes 0–7, portrait palettes 8–15, paired by slot.
  For generic classes: **0=blue (player), 1=red (enemy), 2=green (ally), 3=yellow, 4=purple**.
  Palette swapping should be done **on the GPU** — index texture + palette LUT — not by
  regenerating PNGs.

## Rendering direction

- **Camera**: tilted orthographic, ~30° pitch, 45° yaw, snapping to 4 yaw positions with an eased
  rotate. Slight perspective cheat is acceptable if it reads better.
- **Sprites**: billboarded quads, Y-locked (they rotate about the world Y axis to face the camera
  but never tip). Pixel-crisp: `NearestFilter`, and the quad must land on whole-device-pixel
  boundaries or the pixel art shimmers. Sprites receive scene lighting and cast contact shadows.
- **Terrain**: real geometry, not a heightmap plane. Tile blocks with proper side faces, beveled
  edges, per-surface materials. Water is a shader with refraction + moving normals.
- **Lighting**: one key directional with soft shadows, hemispheric fill, per-map colour grading.
  Ambient occlusion in the tile crevices is what sells the diorama.
- **Post stack** (order matters): SSAO → bloom → depth of field / tilt-shift → colour grade LUT →
  subtle vignette + film grain. Restraint: the reference games are *clean*, not blown out.
- **The single biggest AAA tell** is not any one effect — it is *cohesion*. Consistent palette,
  consistent light direction, consistent pixel density, no aliasing, no z-fighting, no floaty
  sprites disconnected from the ground. Contact shadows and correct depth sorting matter more
  than adding another bloom pass.

## Job system

FFT's job tree is the spine: Squire → Chemist → the six branches, unlocked by job level.
On top of that we add jobs drawn from **EverQuest 2** and **World of Warcraft** — these should feel
native to Ivalice, not bolted on. They get real mechanical identity (threat/taunt, damage-over-time,
pets, stances, resource bars), not reskins.

## Verification

- `npm run typecheck` — must pass.
- `npm test` — core logic has real tests. Combat formulas, pathfinding, CT ordering, and status
  interaction are the high-value targets.
- `npm run shot -- --scene <name>` — renders a scenario headlessly to `shots/<name>.png`.
  The page must set `window.__EVERTACTICS_READY__ = true` on the first converged frame.
  Add a scenario to `src/state/scenarios.ts` for anything you want critics to be able to see.

## Reporting

When you finish, report: files created/modified, what works, what is stubbed, what you had to
assume, and anything you changed that other agents depend on.

## Verifying renders (important)

`tools/shoot.mjs` and `tools/play.mjs` default to the vite DEV server. That is convenient but not
deterministic while other agents are editing: **any file save triggers an HMR reload**, the page
returns to the boot splash *after* the harness already saw it clear, and the capture is a black
rectangle. Both harnesses now re-check for the splash immediately before the shutter and wait it
out, but the reliable path for anything you intend to judge is a static build:

```
npx vite build
npx vite preview --port 4173 --strictPort &
node tools/shoot.mjs --scene battle-open --port 4173 --out shots/x.png
node tools/play.mjs  --keys "j" --port 4173 --out shots/jobscreen
```

`shoot.mjs` fails the shot (non-zero exit) when the frame never converged, the splash never
cleared, the frame is effectively blank, or **any shader failed to compile** — a failed material
does not blank the frame, three.js falls back and renders something wrong, so `ok: true` would
otherwise be meaningless.
