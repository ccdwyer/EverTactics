# v0.1 step 5 — Economy: rewards, shop, loot

Read `docs/ROADMAP-v0.1.md` and `docs/KNOWN-ISSUES.md`.

Steps 1–4 are done and reviewed: campaigns persist, party editors write to the campaign, every
battle routes through `campaignToBattle`, and the world map closes the loop
(map → formation → battle → result → map with unlocks).

`gil` exists on `CampaignState` and items exist in `state/items.ts`, but **nothing earns or spends
money**. This step closes the economy so progression has a second axis besides JP.

## 1. Battle rewards

On victory, award gil and item drops alongside the existing exp/JP. Amounts should scale with the
encounter (enemy count and level), be deterministic from the campaign seed plus node id — the same
victory must always pay the same — and be recorded in the campaign.

Show them on the existing `ResultScreen`, which already displays exp/JP.

## 2. A shop

A `town` node on the world map opens a shop instead of a battle. `WorldNode.kind` already supports
`'town'`.

- Buy from a stock list gated by chapter, spending gil, adding to campaign inventory.
- Sell from inventory at a reduced rate.
- Refuse purchases the party cannot afford. Never allow negative gil.
- Equipment bought becomes available to the Roster screen's equip flow immediately.

New screen `src/ui/screens/ShopScreen.ts`, following the existing screen pattern: it takes a view
model and emits `UIIntent`; it never touches core state directly.

## 3. Pure rules in core

Put the arithmetic in `src/core/economy.ts` (new, pure): reward computation, buy/sell price rules,
affordability checks. No three.js, no DOM, randomness only via the seeded `Rng`.

## Tests — write from this wording first, watch them fail, then make them pass

`tests/economy.test.ts`:
1. Winning a battle awards gil, and the same seed + node always awards the same amount.
2. Losing awards nothing.
3. Buying deducts gil and adds the item; buying what you cannot afford is refused and changes nothing.
4. Selling adds gil and removes the item; selling something you do not own is refused.
5. Gil can never go negative by any sequence of operations.
6. Bought equipment is equippable from the Roster screen (respecting job restrictions).
7. All of it survives serialize/deserialize.

**Do not write a test that asserts current behaviour instead of the behaviour above.** Five earlier
tasks failed review for exactly that, including one where the test driver swallowed the very error
that was hanging the game.

## Rules

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- `BattleState` is mutated only by `applyCommand`.
- Party/campaign editing touches the campaign only, never a live `BattleState`.
- Never a backtick in a shader-file comment.
- 502 tests currently pass; do not regress them, and keep the four `tools/metrics.mjs` gates green.

## Success criteria

    npx tsc --noEmit     clean
    npx vitest run       502 existing + the seven above
    npm run verify       green, all four gates

Then prove it in a browser against a static build:

    npx vite build && npx vite preview --port 4173 --strictPort &
    node tools/play.mjs --steps "burst:3x300" --port 4173 --out shots/shop

Report the commands you ran and what they printed.
