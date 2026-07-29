# Battle UX — readability and feel, measured against real FFT play

This comes directly from Chris watching real Final Fantasy Tactics footage beside our build. It is
**higher priority than v0.2 scoping**. The battle engine is correct; playing it does not yet feel
like playing FFT, and the gap is readability and camera, not rules.

Reference: https://www.youtube.com/watch?v=-kKfYPkFLvU — FFT gameplay. You cannot watch it. The
observations below are Chris's, taken from it directly. Treat them as the spec.

## The gaps, in Chris's words

> Spells/abilities have animations, the map scrolls to your target(s) to show your attacks/abilities
> hitting them, it is much easier to see where your movement range includes, you can walk through
> allies but not enemies, enemies have a different color armor, you can move the map, you can
> inspect any unit and see their equipment and abilities.

That is seven items. Take them in this order — the first three change how the game *plays*, the
rest change how much it *tells you*.

### 1. Camera follows the action
When an ability resolves, the camera moves to frame the target(s) so the player sees the hit land.
Today the camera sits still and a spell can resolve off-screen entirely — the player learns what
happened from a number, not from watching it.

Step 12 shipped `src/render/abilityCamera.ts` with a sparse push-in for *signature* abilities, and
it already saves and restores framing exactly (tests assert no drift over 100 casts). **Extend that
module — do not build a second camera system.** The difference: this applies to *ordinary* actions
too, and it frames the **target**, not the caster.

Keep it fast. FFT's camera move is well under a second. Skippable, and it must not desync the event
stream — the existing `AbilityCameraDirector` contract already covers this.

### 2. Movement range must be obvious at a glance
Chris: *"it is much easier to see where your movement range includes"* — meaning in FFT, not ours.
Find out why ours is harder to read. Likely candidates: tile highlight contrast against terrain,
the edge treatment, whether height differences within range are distinguishable, whether the
reachable set is visually separable from the merely-visible set.

Measure before and after with frames. This is a comparison against FFT's readability, not against
"it is now blue".

### 3. Pass through allies, not enemies
FFT lets a unit walk **through** an ally's tile (it may not end there) but never through an enemy.
Ours currently blocks on any occupied tile — check `buildOccupancy` and `pathTo` in `src/core/`.

This is a **rules change in `src/core/`**, so: determinism is load-bearing, the AI sweep must stay
at `rejected=0`, and existing pathfinding tests must be updated deliberately rather than deleted.
Expect the content sweep's `commands` count to move — that is fine and expected, but **state the
before and after numbers** so it is a recorded consequence rather than a surprise.

### 4. Enemies read as enemies at a glance
Different armour colour for the hostile team. There is already a palette-swap path for team
recolouring (`.act` palettes, `docs/ASSETS.md`) — use it rather than a tint multiply if you can, a
flat tint over pixel art tends to look like a bug. Allies and enemies must be separable in a still
frame by someone who has never played.

### 5. The player can move the camera
Pan, and rotate if cheap. FFT allows the player to look around the board before committing. Bind it
sensibly, show the binding in the existing controls hint, and make sure it cannot fight the
ability camera from item 1 — decide what happens if the player pans mid-cast and say what you chose.

### 6. Inspect any unit
Click or hover any unit — ally or enemy — and see their equipment, abilities and stats. Some of
this exists (the unit panel shows HP/MP/Brave/Faith); what is missing is equipment and the ability
list, and whether it works on *enemies*. Knowing what an enemy is carrying is a tactical decision
in FFT, not a nicety.

### 7. Ability animations
Item 1 gives them a camera; this gives them motion worth pointing it at. Step 12 shipped eight
signature effects — check what an *ordinary* attack looks like and whether a plain physical hit has
any impact at all. A camera push onto a static sprite is worse than no camera.

## Scope

This is large. **Do items 1–3 first and report.** If you run out of room, a solid 1–3 with frames
beats a thin pass over all seven. Say clearly which items you did and which you did not.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            567 currently, plus yours
    npm run verify            all four gates green

Frames under `shots/battle-ux/`, before and after for each item you touch. **A readability claim
needs a frame, not a passing test.**

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes' composition — the metrics history is
  measured against them.
- Evidence is allow-listed **file by file** in `.gitignore`, never by directory. Directory
  negations previously put 428MB of screenshots into the repo.
- `tools/play.mjs` needs `--host localhost`. The `surface` probe reports the underlying screen while
  a modal is open — read the frame, not the field.
