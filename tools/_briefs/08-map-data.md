# v0.1 step 7 — Move maps and encounters out of source, then author the arc

Read `docs/ROADMAP-v0.1.md` and `docs/KNOWN-ISSUES.md`.

Steps 1–6 are done and reviewed. The full loop exists: title → new game → world map → formation →
battle → result → rewards → shop → map, persisted. **What remains is content.**

Two maps exist (`orbonne-courtyard`, `mandalia-plains`), hand-written as `MapDef` literals inside
`src/core/grid.ts`. That was fine for two. It is the wrong shape for ten — the file is already large,
and every new map makes the pathfinding code harder to read.

## 1. Maps become data

Move map definitions out of `core/grid.ts` into a data directory (`src/content/maps/*.ts` or JSON —
your call, but justify it). `core/grid.ts` keeps the *algorithms* (pathfinding, LoS, range, slope
derivation) and loses the *content*.

`generateMap(id)` must keep working with the same signature, and the two existing maps must produce
**byte-identical** `Battlefield` output — there are 66 pathfinding tests and a determinism suite that
will tell you if a tile moved. Prove it: assert the existing maps serialise identically before and
after the move.

## 2. Encounters become data too

Enemy rosters currently live in `state/scenarios.ts`. An encounter is: a map id, an enemy roster
(job, level, placement, AI personality), an objective, a lighting preset, and a banner. Give it a
type and a directory, so adding a battle is adding a file rather than editing a 700-line module.

## 3. Author the arc

With the format in place, author enough content for a v0.1 campaign: **at least four new maps**
(six total) and **8–10 encounters** across two chapters, wired into the existing `WORLD_NODES` graph.

Design guidance, not decoration:
- Vary the *shape*, not just the tiles — a bridge chokepoint, a height-advantage siege, an open
  field where cavalry-style movement matters, an interior with corners.
- Escalate: chapter 1 encounters should be winnable with the starting roster; chapter 2 should
  assume a job change or two.
- Every encounter needs a reason to exist mechanically. Two fights that play identically on
  different tilesets are one fight.

## Tests

`tests/content.test.ts` (extend the existing one):
1. Every map in the data directory produces a valid `Battlefield` — no unreachable start tiles, no
   units placed on impassable or `void` tiles.
2. Every encounter's `mapId` resolves; every `WORLD_NODES` `scenarioId` resolves to an encounter.
3. Every map is fully connected for a Move-3 Jump-2 unit — no stranded regions. (`tools/` already
   has a flood-fill precedent for this.)
4. The two pre-existing maps are unchanged after the refactor.
5. Every encounter resolves AI-vs-AI within the turn cap across several seeds, with **zero rejected
   commands** — reuse the sweep helper from `tests/integration.test.ts`.

## Rules

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- `BattleState` is mutated only by `applyCommand`.
- Never a backtick in a shader-file comment.
- 515 tests currently pass; do not regress them, and keep the four `tools/metrics.mjs` gates green.
- `terrain-only`, `sprites-only`, `ui-only` and `battle-open` must behave exactly as they do now.

## Success criteria

    npx tsc --noEmit     clean
    npx vitest run       515 existing + the five above
    npm run verify       green, all four gates

Then render at least three of the new maps and look at them:

    npx vite build && npx vite preview --port 4173 --strictPort &
    node tools/shoot.mjs --scene <encounter-id> --port 4173 --out shots/<id>.png

Report the commands, the numbers, and which maps you actually looked at.
