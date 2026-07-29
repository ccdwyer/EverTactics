# Encounter balance, and the inspect panel's text

Chris asked for a balance pass alongside the battle-UX work. The UX items are done; this is the
other half.

## Part A — encounter balance, measured

Ten encounters exist across two chapters. **Nobody has ever checked whether any of them is
winnable, losable, or interesting** — only that they resolve without crashing. The content sweep
proves `rejected=0`, not that a fight is worth playing.

Two facts already measured, both signs of trouble:
- A level-13/14 company **cannot be killed** by the level-3 opening encounter no matter how long it
  stands still. Passing every turn for 90 consecutive turns did not lose it.
- The starting roster is level 12–14 while the first encounter's enemies are level 3.

That second one is likely the root cause: the shipped roster was authored for demo screenshots, and
the encounters were authored later against the world map. They have never been reconciled.

### Measure first, tune second

Build a harness (extend `tests/helpers/aiBattle.ts` or add `tools/balance.mjs`) that runs **every
encounter across at least 12 seeds, AI on both sides**, and reports per encounter:

- player win rate
- median turns to resolve
- median surviving player units on a win
- how often a player unit is knocked out at all

Put the table in `docs/BALANCE.md`. **That table is the deliverable even if you tune nothing.**

### What good looks like

- A first encounter that teaches should be winnable but not free: the player should be able to lose
  a unit if careless. A 100% win rate with zero knockdowns across 12 seeds is a cutscene.
- Difficulty should rise across the arc. If encounter 10 has the same win rate as encounter 1, the
  chapter has no shape.
- Nothing should be unwinnable. A 0% win rate is a bug, not difficulty.

Do not tune toward a target win rate mechanically — an AI-vs-AI rate is a proxy, not a player. Use
it to find the encounters that are obviously broken, and say which ones you judged by eye.

### Constraints

- Changing the starting roster's levels or the encounters' levels changes the event stream. State
  the integration and content sweep numbers before and after (currently `2552` and `4504`,
  `rejected=0` both).
- `docs/V01-ACCEPTANCE.md` and `shots/v01-victory/persistence-diff.md` record a real playthrough
  with specific gil and JP values. If your changes invalidate those numbers, say so — do not
  silently leave documentation describing a game that no longer exists.

## Part B — the inspect panel wraps mid-word

`docs/KNOWN-ISSUES.md`, battle UX residual 1. `shots/battle-ux2/02-move-range-after.png` shows
"LONGSWORD" as "LON / GSW / ORD" and "BATTLE BOOTS" as "BATT / LE / BOO / TS".

The column is too narrow for the longest item names. Fix it so the longest name in the item table
fits — widen the column, shrink the type, or wrap on word boundaries, whichever keeps the panel
balanced. **Check against the actual longest item name in the data**, not against "longsword".

This panel is what a player opens to decide whether to attack an enemy, so it looking broken costs
more than a cosmetic bug normally would.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            584 currently, plus yours
    npm run verify            all four gates green

Plus `docs/BALANCE.md` with the table, and a before/after frame for Part B under `shots/balance/`,
allow-listed **file by file** in `.gitignore`.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes — the metrics history and the blind-judge
  tooling are measured against them. Balance changes belong in the campaign encounters.
- Do not describe a rename as a behaviour change.
- Evidence is a measured number or a frame, not an assertion.
