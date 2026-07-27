# v0.1 step 1 — Campaign persistence

Read `docs/ROADMAP-v0.1.md` first. This is step 1 and **everything else depends on it**. Nothing in
this game currently survives a page refresh: not JP, not levels, not the roster, not inventory.

Do not build a world map, a shop, or screen wiring here. Build the state layer they will all sit on.

## What to build

### `src/core/campaign.ts` (new) — the persisted model

Pure data and pure functions. No three.js, no DOM, no `localStorage` access — this file must stay
unit-testable in node.

    CampaignState {
      version: number            // schema version, see migration below
      seed: number               // campaign-level seed, so encounters stay deterministic
      gil: number
      roster: PersistedUnit[]    // the player's company, NOT a BattleState
      inventory: Record<ItemId, number>
      progress: {
        completed: string[]      // scenario ids already won
        current?: string         // where the player is
      }
      createdAt: number          // pass timestamps IN; never call Date.now() in core
      updatedAt: number
    }

`PersistedUnit` is the durable subset of `Unit` — id, name, gender, zodiac, level, exp, currentJob,
per-job `{ level, jp, totalJp, learned[] }`, equipment, secondary/reaction/support/movement, and
base raw stats. **Not** position, facing, CT, statuses or turn flags: those are battle-scoped and
must be derived fresh, or a save will resurrect a half-finished turn.

Functions: `createCampaign(seed, timestamp)`, `serialize(state): string`,
`deserialize(json): CampaignState`, and `migrate(raw): CampaignState`.

### Migration is required, not optional
`deserialize` must handle a save written by an older `version` and either upgrade it or reject it
with a clear error. A schema change must never brick an existing save silently. Write at least one
test that feeds a hand-written v0 blob through `migrate` and asserts the result.

### `src/state/save.ts` (new) — the only place that touches storage

`saveCampaign(state)`, `loadCampaign(): CampaignState | null`, `clearCampaign()`, `hasSave()`.
Uses `localStorage` under one namespaced key. Must not throw when storage is unavailable or the
blob is corrupt — return `null` and log, because a browser in private mode should not crash the game.

### Bridge both directions

- `campaignToBattle(campaign, scenario)` — build a `BattleState` whose player units come from the
  persisted roster instead of the scenario's hardcoded list. Enemy units still come from the
  scenario. Placement uses the scenario's start tiles.
- `battleToCampaign(campaign, battleState, timestamp)` — write back what a battle earned: exp, JP,
  levels, learned abilities, consumed items, and the scenario id into `progress.completed`.

`src/state/scenarios.ts` currently owns unit creation in `buildScenario`. **Do not rip that out** —
`battle-open` and the diagnostic scenes must keep working exactly as they do, because the screenshot
and blind-judge tooling depends on them. Add the campaign path alongside it.

## Determinism — this is load-bearing

There are existing tests asserting a battle replays byte-identically from a seed
(`tests/playthrough.test.ts`, `tests/integration.test.ts`). They must keep passing.

- Never call `Date.now()` or `Math.random()` in `src/core/`. Pass timestamps in as arguments.
- A campaign loaded from a save must produce the *same* battle as one that was never saved, given
  the same seed and roster. **Write a test that proves this**: build a campaign, serialize it,
  deserialize it, run the same seeded battle from both, and assert the event streams are identical.
  That single test is the point of this whole task.

## Success criteria — commands and numbers, not descriptions

    npx tsc --noEmit          clean
    npx vitest run            all existing tests still pass (441 currently), plus your new ones
    npx vitest run tests/campaign.test.ts

`tests/campaign.test.ts` must cover, at minimum:
1. round-trip: `deserialize(serialize(s))` deep-equals `s`
2. migration: a hand-written older-version blob upgrades without throwing
3. corrupt blob: `loadCampaign` returns `null` rather than throwing
4. battle-scoped fields (position, CT, statuses) are NOT persisted
5. **determinism across a save/load boundary** — identical event streams, as described above
6. `battleToCampaign` writes back earned JP/exp and marks the scenario completed

Report the exact commands you ran and the numbers they printed.

## Project rules

- `src/core/` never imports three.js. Randomness only via the seeded `Rng` in `core/types.ts`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file (six occurrences so far);
  `npx vitest run tests/shader-source.test.ts` catches it.
- Do not modify `src/render/`, `src/ui/`, or the existing scenarios' behaviour.
