# v0.1 step 3 — Route the game through the campaign

Read `docs/ROADMAP-v0.1.md`, `docs/KNOWN-ISSUES.md`, and `tools/_briefs/02-party-management.md`.

Steps 1 and 2 built the campaign layer and the party editors, and they are correct. **The game does
not use them.** Four review rounds on step 2 kept finding symptoms of that one fact, so this task
fixes the cause: the boot sequence.

## The defect, in Sol's words

- `state/game.ts:199` builds the first battle with `buildScenario`, then creates the campaign
  afterwards. That battle has no campaign inventory, so the first item use lazily installs eight
  Potions and finishing the battle can overwrite the campaign's seeded three with seven. It never
  sets `progress.current`, **so the first victory is not recorded.**
- `partyEdit.ts:46` accepts an `unlockCtx`, but `game.ts:1205` passes only a timestamp and both job
  view-models receive `{}`. Persisted units carry no kill count, so Dark Knight and Death Knight can
  never unlock in-game. Tests pass only by injecting `{kills: 20}` directly.
- `core/party.ts:61` lets banked JP bypass an `unlockStatus` rejection, so a monster can switch to
  an ordinary job.

Note what these share: **the campaign functions are right; nothing calls them.** Tests pass because
they invoke `campaignToBattle` directly while the real boot path does not.

## What to build

### 1. One launch path
Every battle — including the very first one of a new game — starts as:

    campaign (loaded, or freshly created)  ->  campaignToBattle(campaign, scenario)  ->  BattleState

`buildScenario` keeps existing ONLY for the diagnostic scenarios (`terrain-only`, `sprites-only`,
`ui-only`) that the screenshot and blind-judge tooling depends on. Do not change their behaviour.

`?shot=` scenes must keep rendering identically — `npm run verify` and the four `tools/metrics.mjs`
gates must still pass.

### 2. `progress.current` is set at launch, always
Set it in the launch path itself, not by the caller. Then a victory is recorded no matter who
started the battle.

### 3. Kill counts are persisted
Add a kill count to `PersistedUnit`, increment it on `knockdown` events attributed to that unit, and
thread a real `unlockCtx` (not `{}`) through `game.ts:1205` into the job view-models. Dark Knight and
Death Knight must be reachable by playing.

### 4. `canSwitchToJob` is exactly `unlockStatus`
Delete the banked-JP bypass at `core/party.ts:61`. One canonical predicate, used by both the UI and
the mutation.

## Tests

Delete `party.test.ts:353`, which calls `campaignToBattle` directly and thereby masks defect 1.

Then, from the brief's wording — write them first, watch them fail, then make them pass:
1. A **new game** boots through `campaignToBattle`: the first battle's inventory equals the
   campaign's seeded stock (three Potions, not eight).
2. Winning the **first** battle of a new game records it in `progress.completed`.
3. A unit that scores knockdowns accumulates a persisted kill count that survives serialize/deserialize.
4. Dark Knight unlocks through the real code path with no injected context.
5. A monster with banked JP cannot switch to an ordinary job.

## Rules

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- `BattleState` is mutated only by `applyCommand`. Step 2 removed the violations — do not add them back.
- Never a backtick in a shader-file comment.
- 489 tests currently pass; do not regress them.

## Success criteria

    npx tsc --noEmit     clean
    npx vitest run       489 existing + the five above
    npm run verify       green, all four metrics gates passing

Report the commands you ran and what they printed.
