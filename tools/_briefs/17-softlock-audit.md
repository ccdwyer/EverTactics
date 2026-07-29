# v0.1 — soft-lock audit

Read `docs/V01-ACCEPTANCE.md` first. The happy path is proven: title → world map → formation →
battle → victory → rewards → shop → map, surviving a refresh with a byte-identical save.

**Every unhappy path is unverified.** Question 4 of the acceptance answers says so plainly: "None
found on the path walked. The lost-battle path, empty shop, and below-minimum formation remain
unchecked." A soft-lock — a screen with no way forward — is the worst bug this game can have,
because it ends a campaign rather than spoiling a moment, and none of the 566 tests would notice.

## What to check

Drive each through **real input** with `tools/play.mjs` against a static build. For each: does the
player reach a screen with no way out?

1. **A battle LOST rather than won.** Every automated sweep resolves to victory or defeat and moves
   on; a human who loses needs a route back to the world map. Note that passing turns will not lose
   the opening encounter — a level-13/14 company cannot be killed by level-3 enemies. You will need
   a weaker party, a harder encounter, or a scenario built for it.
2. **A formation below the deploy minimum** — deselect units until fewer than the minimum are
   deployed. Is Begin Battle correctly disabled, and is there still a way out of the screen?
3. **An empty shop**, or a shop with nothing affordable at 0 gil. Can the player leave?
4. **The last completed node** with no successor. Does the world map dead-end, and does it say
   something, or does it just sit there?
5. **Escape / back from every screen**: world map, formation, roster, job, shop, result. Any screen
   with no back route is a soft-lock even if every forward route works.
6. **A save from an older schema version.** `migrate` exists and is tested at unit level; feed a
   real older blob through `loadCampaign` and confirm the game boots rather than white-screening.

## What to fix

Fix anything that genuinely traps the player. **Scope discipline:** a dead-end that clearly explains
itself is not a soft-lock, and does not need a redesign. Prefer the smallest change that gives the
player a way out — usually a back button, a disabled-state message, or an unlock condition.

Anything you find that is ugly but not trapping goes in `docs/KNOWN-ISSUES.md` with file:line.

## Report

A table: case → `TRAPPED` / `SAFE` / `SAFE BUT UNCLEAR`, with the frame filename for each. Frames
under `shots/softlock/`. **A visual or navigational claim needs a frame, not a passing test.**

If nothing traps the player, say so and change nothing. **An empty diff is an entirely acceptable
outcome** — the report is the deliverable. Do not manufacture a fix to look productive; a previous
round failed for producing a patch and skipping the evidence.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            566 currently, plus any regression tests you add
    npm run verify            gates must stay green

Add a regression test for each real soft-lock you fix.

## Traps already paid for — do not rediscover these

- `tools/play.mjs` needs `--host localhost`; `vite preview` binds the IPv6 loopback and a
  `127.0.0.1` default fails with "dev server did not start" while `curl` returns 200.
- The `surface` probe reports the **underlying** screen while a modal is open. Read the frame, not
  the field. A round was lost concluding "Enter does nothing" when the click had worked.
- `node tools/metrics.mjs <image>` takes the image **positionally**; `--in` now exits 2.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes.
- Do not write a test that mocks past the code path it claims to verify.
