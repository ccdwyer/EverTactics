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

## Step 5 residuals (reviewer-flagged, accepted)

1. Economy tests hardcode prices (dagger 200, potion 100) rather than reading the item table — they
   still exercise the rules, but a price change breaks the test instead of the test catching it.
2. `sellItem` allows a resale price of `0` (`price < 0` rather than `<= 0`). Edge case.
3. `world.test.ts` hand-builds reward objects from `computeBattleRewards`; the Game path is covered
   in the routing tests instead.
