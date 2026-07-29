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

**Outstanding — the actual question is still unanswered:**
1. No stage-by-stage WORKS/BROKEN/UNREACHABLE table for the loop.
2. No answers to the five Part B questions, including the soft-lock checks (a battle **lost**
   rather than won, an empty shop, a formation below the deploy minimum, a completed final node).
3. **No measured refresh-persistence diff.** The URL fix above makes refresh reach the title
   screen; nothing yet proves gil, JP, levels, learned abilities and inventory survive it.
None of this is known-broken; it is **unverified**, which is a different and more honest claim.
