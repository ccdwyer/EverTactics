# v0.1 step 2 — Make the party screens two-way

Read `docs/ROADMAP-v0.1.md` and `docs/KNOWN-ISSUES.md` first.

`FormationScreen`, `RosterScreen` and `JobScreen` already render correctly with real data. They are
**viewers**. Nothing in them mutates anything. This task makes them editors.

Step 1 (campaign persistence) is done: `core/campaign.ts` holds the roster, `state/save.ts` persists
it. Every edit here must land in the campaign and survive a refresh.

## READ THIS BEFORE WRITING TESTS

The previous task failed 7 adversarial reviews for one recurring habit: **tests written to confirm
the behaviour the code has, rather than to assert the behaviour the brief requires.** Twice a test
asserted the defect (one explicitly expected a silent omission; one pre-sorted a fixture so a
mutation check couldn't fire).

For every item below: write the test from this brief's wording, watch it fail, then make it pass.
Never adjust a fixture to accommodate the implementation. A green suite over a broken contract is
worse than a red one.

## 1. Formation — choose who deploys, and where

- Pick which roster members deploy, up to the map's limit.
- Assign each to one of the scenario's start tiles.
- Reject: over the limit, two units on one tile, a tile that isn't a legal start, deploying zero units.
- The chosen formation persists to the campaign and is the party the next battle launches with.

## 2. Roster — equip and configure

- Equip/unequip from the campaign inventory, honouring the job's `equip` categories and two-handed
  weapons. Unequipping returns the item to inventory; equipping removes it.
- Set secondary action set, reaction, support and movement from what that unit has learned.
- Rename a unit. Dismiss a unit (with the roster never dropping below one member).
- All of it persists.

## 3. Job screen — spend JP

It already displays the tree, costs, and learned state. Wire the actions:
- Change current job, if unlocked. Derived stats, Move/Jump and the sprite must update.
- Spend JP to learn an ability; refuse if unaffordable or already known.
- Persists to the campaign.

## Rules

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- UI emits `UIIntent`; `state/game.ts` handles it and calls core mutations. Do not mutate core state
  from `src/ui/`.
- Reuse existing core helpers (`setJob`, `learnAbility`, equipment slots, `jobProgress`) — do not
  reimplement rules that already exist, or the screen and the engine will disagree.
- Don't regress the 469 existing tests, the four `tools/metrics.mjs` gates, or the diagnostic
  scenarios the screenshot tooling depends on.
- Never a backtick in a shader-file comment; `npx vitest run tests/shader-source.test.ts` catches it.

## Success criteria — commands and numbers

    npx tsc --noEmit                        clean
    npx vitest run                          469 existing + your new ones, all passing
    npx vitest run tests/party.test.ts

`tests/party.test.ts` must cover: deploy limit enforced; duplicate start tile rejected; equip moves
the item out of inventory and unequip returns it; a job's equip restrictions are honoured; learning
an ability deducts JP and refuses when unaffordable; changing job updates derived stats; every one
of those survives a `serialize`/`deserialize` round trip.

Then prove it in a browser, against a static build (HMR reloads mid-capture):

    npx vite build && npx vite preview --port 4173 --strictPort &
    node tools/play.mjs --steps "key:f,burst:4x200" --port 4173 --out shots/formation

Read the PNGs and confirm the screen responds to input. Report the commands you ran and what they
printed — not a description of what you changed.
