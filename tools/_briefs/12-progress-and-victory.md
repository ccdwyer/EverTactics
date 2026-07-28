# v0.1 step 11 — One id space for progress, and a battle won through the UI

Read `docs/V01-ACCEPTANCE.md` first. The loop is reachable end to end and 634 steps of real play
produced zero rejected commands. Two concrete items remain, both found by walking the game rather
than by reading it.

---

## Part A — `progress.current` carries two different id spaces

Two writers, two meanings:

- `src/state/scenarios.ts:430` — `campaign.progress.current = scenario.id` (a **scenario** id)
- `src/state/game.ts:282` — `this.campaign.progress.current = routedNode.id` (a **world-node** id)

Observed live after launching the first battle from the world map: `current: 'battle-open'` — a
scenario id, and not the scenario that was actually launched.

`battleToCampaign` reads this field to decide what to mark completed. The field exists *because* a
step-1 review removed a "caller must remember to pass the scenario id" trap; it is now the same
trap in a new shape, because what the field means depends on which code path ran last.

**Required:**
- Decide which id space `progress.current` holds and make it **one type with one writer**. A world-
  node id is the likelier right answer, since the world map is the thing a player navigates and a
  node already knows its `scenarioId` — but make the call deliberately and write the reasoning in
  a comment, because the next person will ask.
- If both values are genuinely needed, they are **two fields**, not one field with two meanings.
- `battleToCampaign` must record completion correctly regardless of which entry path launched the
  battle: world-map node, direct scenario boot, or diagnostic scene.
- Tests: launching from a world-map node and completing it marks the **right** node completed and
  unlocks its successors; a direct scenario boot does not corrupt `progress.current`; and a
  round-trip through save/load preserves it.

Do not "fix" this by having `battleToCampaign` guess which id space it received by inspecting the
string. That is a third trap.

---

## Part B — win a battle through the UI, then prove the loop closes

The remaining acceptance gap. Nothing has yet driven a battle to **victory through real input**, so
progression across a refresh is unproven.

Use `tools/play.mjs` against a static build (`vite build` + `vite preview`). Note two traps already
paid for:
- The harness defaults to `--host localhost`; `vite preview` binds the IPv6 loopback and a
  `127.0.0.1` default silently fails with "dev server did not start".
- The `surface` probe reports the **underlying** screen while a modal is open. Read the frame, not
  the field. An earlier round wasted itself concluding "Enter does nothing" when the click had
  worked.

Passing turns will not resolve the opening encounter — a level-13/14 company cannot be killed by
level-3 enemies, and waiting kills nothing. You must script ATTACK and target clicks. The command
menu order is MOVE, ATTACK, BATTLE SKILL, BASIC SKILL, DEFEND, WAIT.

**Then measure the loop closing.** Capture campaign state immediately before and after a browser
refresh taken *after* the victory, and report a field-by-field diff of:

    gil, progress.completed, progress.current, and for each roster unit:
    level, exp, currentJob, per-job jp/totalJp/learned, equipment, inventory

**Any field that does not survive is the finding.** A table showing every field identical is the
deliverable; "persistence works" without the table is not.

Also answer, with frames: after victory, does the player reach the result screen, then rewards,
then the world map, with the completed node marked and its successor unlocked?

---

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            541 currently, plus yours
    npm run verify            gates must stay green

Plus the before/after persistence table and the frames on disk under `shots/v01-victory/`.

Add a regression test for anything you fix. If a field turns out not to survive the refresh, fix it
and add the test that would have caught it.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes; the screenshot and blind-judge tooling
  depends on them.
- A green test over a broken contract is worse than a red one. Do not write a test that mocks past
  the code path it claims to verify — a test was deleted in step 10 for exactly that.
- Evidence for anything visual or navigational is a frame, not a passing unit test.
