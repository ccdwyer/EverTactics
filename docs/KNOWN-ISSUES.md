# Known issues

## Persistence (accepted with these open, v0.1 step 1)

Found by GPT-5.6 Sol across 7 adversarial reviews. Accepted deliberately: none is reachable from
inputs the game currently produces, and persistence blocked the whole roadmap.

1. **Resolved in v0.1 step 9 — duplicate roster ids now fail loudly.** Both current-version
   deserialization and `campaignToBattle` reject the corrupt roster and name the duplicate id, so
   no `Map` insertion can silently collapse two characters into one.
2. **Resolved in v0.1 step 9 — equipment key order is preserved.** `requireEquipment` validates
   slots in their serialized insertion order, so a current-version save is not cosmetically
   rewritten on deserialize/reserialize.
Delivered and verified: campaigns save/load/survive refresh, progress records on victory, storage
failures log rather than fail silently, 469 tests green, typecheck clean.

## Step 3 residuals (reviewer-flagged, accepted)

1. The Dark Knight unlock test fixtures `kills: 20`, so it proves the ctx path, not "earn 20
   knockdowns then unlock". Left as a narrow tree test because battle knockdown credit and the
   persisted-unit fallback are covered separately; a 20-KO integration grind would duplicate both.

## Step 5 residuals (reviewer-flagged, accepted)

1. `world.test.ts` hand-builds reward objects from `computeBattleRewards`. Left as-is because that
   test intentionally owns the pure world/reward seam; the cross-layer Game path is covered in the
   routing tests.

## v0.1 acceptance (step 10 — partial, rounds exhausted)

The acceptance brief asked for two things: fix any loop-blocker found, and produce the evidence
(stage table, five answers, frames). It delivered the first and never the second, across three
rounds, and the reviewer correctly failed all three for it.

**Delivered and kept:**
- **A real loop-blocker fixed.** Campaign battles launch via a hard navigation that plants
  `?scene=`/`?node=`; the return to the world map is an SPA transition that left the query string
  in place. Because boot routing keys off `location.search`, a refresh mid-campaign re-entered the
  battle you had just won instead of going to title → Continue. `enterWorldMap` now clears it.
  Covered by a regression test on the real `result-dismiss` path.
- `tools/play.mjs` gains CDP attach, `reload` and `selector` steps, a richer localStorage campaign
  probe, and **exit code 5 on any `[game] rejected command` warning** — so the harness now fails on
  the signature of the reported lockup instead of screenshotting past it.
- 21 acceptance frames in `shots/v01-acceptance/`, now un-gitignored so they are durable.

**Resolved by subsequent acceptance work:** the loop evidence and measured refresh-persistence
diff now live in `docs/V01-ACCEPTANCE.md`. The previously unchecked unhappy paths are recorded in
`docs/SOFTLOCK-AUDIT.md`.

## v0.1 soft-lock audit residuals

These are unclear or awkward, but none traps the player:

1. An empty shop inventory renders a blank Sell pane without an empty-state explanation
   (`src/ui/screens/ShopScreen.ts:110-118`). Close and Escape still return to the world map.
2. The result screen offers no clickable continue control; its visible route is the
   keyboard-only `Enter — continue` hint (`src/ui/screens/ResultScreen.ts:41-53`,
   `src/ui/screens/ResultScreen.ts:199-208`). Escape also dismisses the result.
3. Formation's Begin Battle action is a mouse button; keyboard confirm while the deployment slate
   is focused edits a slot instead (`src/ui/screens/FormationScreen.ts:41-46`,
   `src/ui/screens/FormationScreen.ts:173-213`). Close and Escape still return to the world map.

## Battle UX part 2 residuals

1. **The inspect panel's EQUIPMENT column wraps mid-word.** `shots/battle-ux2/02-move-range-after.png`
   shows "LONGSWORD" rendered as "LON / GSW / ORD" and "BATTLE BOOTS" as "BATT / LE / BOO / TS".
   The column is too narrow for the longest item names. Functional, and it makes the panel look
   broken at a glance — which matters more than usual because this panel is the thing a player
   opens to make a tactical decision about an enemy.
2. **Item 4's before/after stills were captured at different resolutions** (1600x900 vs 1920x1080),
   so a pixel diff between them proves little. The palette fix is real — verified by the shared-
   sheet row split and visible in the frame — but the evidence pair is weaker than it looks.
