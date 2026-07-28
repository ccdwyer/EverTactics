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

---

## ROUND 2 — reviewer objections from GPT-5.6 Sol. Fix all three.

The work is close: 456 tests pass and no purity, determinism or shader rule was violated. Three
real defects remain. (A fourth objection — that campaign.ts/save.ts/tests were missing from the
diff — was a harness bug on my side and is fixed; ignore it.)

**1. `battleToCampaign` can silently omit completion.**
`src/core/campaign.ts:479` adds an undocumented fourth `scenarioId` parameter, and lines 504-509
record nothing when both it and `progress.current` are absent. The test at
`tests/campaign.test.ts:496` then passes `scenario.id` as that fourth argument, bypassing the
contract instead of testing it.

Make the specified three-argument form work: `battleToCampaign(campaign, battleState, timestamp)`
must reliably mark the scenario completed. If it genuinely needs the scenario id, then
`progress.current` must be set when the battle is launched and that must be what it reads — do not
paper over it with an optional parameter the caller has to remember.

**2. Corrupt current-version saves are silently normalised instead of rejected.**
v1 validation at `campaign.ts:282` checks only outer containers, while the normalisers at
`campaign.ts:334` quietly drop invalid inventory counts and reset malformed job/stat data. That
turns a corrupt save into a plausible-looking one with missing progress — the worst outcome for a
player. Validate the *contents*, and reject clearly rather than repairing silently. Migration from
an OLDER version may still upgrade; a corrupt save at the CURRENT version must fail loudly.

**3. Storage-unavailable loads are not logged.**
`src/state/save.ts:27` swallows storage access errors and `loadCampaign` at line 58 returns `null`
silently. The brief said return null *and log*. A player in private-browsing mode losing their save
with no console output is undebuggable.

Add a test for each of the three.

---

## ROUND 3 — read this part first

**The pattern across two rounds is not three separate bugs, it is one habit: tests are being written
to confirm the behaviour the code has, rather than to assert the behaviour the brief requires.**

- Round 2 defect 1: the test at `tests/campaign.test.ts:703` *explicitly asserts* that passing the
  original campaign silently omits completion (lines 715-716). That is the bug, written down as an
  expectation.
- Round 2 defect 2: the round-trip fixture at `campaign.test.ts:179` pre-sorts `learned[]`, which
  hides that `requireJobs` mutates it and breaks deep-equality.

A green suite over a broken contract is worse than a red one. For every fix below, **write the test
from the brief's wording first, watch it fail, then make it pass.** Do not adjust a fixture to
accommodate the implementation.

### Fix 1 — completion must not depend on which object the caller kept
`campaignToBattle` (`src/state/scenarios.ts:328`) creates a fresh campaign at line 336 and returns
it at 394, leaving the caller's original untouched; `battleToCampaign` (`campaign.ts:760`) then reads
only its argument's `progress.current`. So the previous "remember the 4th argument" trap has become
"remember to use `built.campaign`". Same trap, new shape.

Make it work with the campaign the caller already has. Either `campaignToBattle` mutates
`progress.current` on the passed campaign, or `battleToCampaign` derives the scenario from the
`BattleState` itself. Delete the test that asserts the omission and replace it with one asserting
completion IS recorded when the original campaign is passed.

### Fix 2 — a current-version save must round-trip byte-identically
Two violations, both confirmed by Sol at runtime:
- `requireInventory` (`campaign.ts:368`) accepts a count of `0` then drops the entry at 376:
  `{inventory:{"use-potion":0}}` returns `{inventory:{}}`.
- `requireJobs` (`campaign.ts:520`) sorts `learned[]` at 552.

Policy: **migration from an older version may transform; a current-version save is never rewritten.**
Either preserve the value exactly or reject the save. Un-pre-sort the fixture at `campaign.test.ts:179`
so the round-trip test can actually catch this.

### Fix 3 — validate upper bounds, not just lower
`requirePersistedUnit` (`campaign.ts:405`) checks only lower bounds at 423-437. Sol's probe accepted
`brave: 1000`, `faith: 1000`, a level above the engine maximum of 99, and an arbitrary `currentJob`
that does not exist in the job table. Validate against the real ranges and against `JOBS`.

Verification was genuinely green last round (tsc 0, 464/464, campaign 23/23, shaders 2/2) and storage
logging is now correct — keep all of that.
