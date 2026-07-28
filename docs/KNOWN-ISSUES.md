# Known issues

## Persistence (accepted with these open, v0.1 step 1)

Found by GPT-5.6 Sol across 7 adversarial reviews. Accepted deliberately: none is reachable from
inputs the game currently produces, and persistence blocked the whole roadmap.

1. **Duplicate roster ids silently collapse.** `requireRoster` (`core/campaign.ts:473`) accepts
   duplicates; `campaignToBattle` (`state/scenarios.ts:351`) then inserts them into a `Map`, so two
   roster members launch as one. Write-back can duplicate the survivor across both slots.
   **The real one of the three — genuine data loss.** Only reachable if something upstream mints a
   duplicate id, which nothing does today. Fix before recruitment lands, since that will mint ids.
2. **Equipment keys reorder** on deserialize/reserialize (`requireEquipment`, `campaign.ts:660`) —
   semantically identical, not byte-identical. My brief said "byte-identical" as shorthand for
   "don't silently mutate saves"; Sol enforced the letter. Cosmetic.
3. **`{"__proto__": 0}` as an inventory key** vanishes through the inherited setter
   (`requireInventory`, `campaign.ts:439`). No real item id looks like this.

Delivered and verified: campaigns save/load/survive refresh, progress records on victory, storage
failures log rather than fail silently, 469 tests green, typecheck clean.

## Step 3 residuals (reviewer-flagged, accepted)

1. `tree.ts` reads only `ctx.kills`; `killCountOf(unit, ctx)` was removed. Production is fine
   because `Game` always builds the context, but a core helper called with `{}` silently locks a
   unit that has the kills. Same "nothing calls them" shape that cost step 2 four rounds —
   restore the fallback if core helpers get used directly.
2. The Dark Knight unlock test fixtures `kills: 20`, so it proves the ctx path, not "earn 20
   knockdowns then unlock". Kill increment is tested separately.
3. Status-tick KOs in `battle.ts` emit unattributed knockdowns, so those kills aren't credited.
   Pre-existing.
