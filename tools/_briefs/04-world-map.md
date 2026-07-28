# v0.1 step 4 — World map and campaign progression

Read `docs/ROADMAP-v0.1.md`, `docs/KNOWN-ISSUES.md`, and `tools/_briefs/03-battle-launch.md`.

Steps 1–3 are done and reviewed: campaigns persist, party editors write to the campaign, and every
battle routes through `campaignToBattle` so victories record and inventory is campaign-owned.

**This is the step that makes it a game.** Right now the app boots straight into one battle. After
this, a player starts a campaign, sees a map, chooses where to go, fights, returns, spends JP, and
goes somewhere new — with all of it surviving a refresh.

## 1. The progression model — `src/core/world.ts` (new, pure)

    WorldNode {
      id: string
      name: string
      kind: 'battle' | 'town' | 'event'
      scenarioId?: string        // for kind 'battle'
      position: { x: number; y: number }   // normalised 0-1, for layout
      requires: string[]         // node ids that must be in progress.completed
      chapter: number
    }

Plus `WORLD_NODES` and pure helpers: `availableNodes(campaign)`, `isUnlocked(node, campaign)`,
`nextObjective(campaign)`. No three.js, no DOM, no randomness outside the seeded `Rng`.

Author enough nodes for a v0.1 arc using the **two maps that exist** (`orbonne-courtyard`,
`mandalia-plains`) — reuse them at different nodes with different encounters rather than inventing
maps you cannot author. Six to eight nodes across two chapters, gated so the path is legible.

## 2. Encounters are data, not hardcoded rosters

A battle node needs an enemy roster (jobs, levels, placement, AI personalities) and an objective.
Today that lives inside `state/scenarios.ts` as `BATTLE_OPEN_UNITS`. Generalise it so a node names an
encounter, and the player's side always comes from the campaign roster.

Do not break the diagnostic scenarios (`terrain-only`, `sprites-only`, `ui-only`) or `battle-open`
as the screenshot tooling uses them. `npm run verify` and all four `tools/metrics.mjs` gates must
stay green.

## 3. The world map screen — `src/ui/screens/WorldMapScreen.ts` (new)

Follow the existing screen pattern (`JobScreen`, `FormationScreen`): the screen takes a view model
and emits `UIIntent`; it never touches core state directly.

Show nodes with their unlock state (locked / available / completed), the current objective, and let
the player select an available node to travel to. From a battle node, launching goes through
Formation (choose who deploys) and then into the battle.

## 4. The loop closes

    world map -> select node -> formation -> battle -> result -> back to world map

On victory: record completion, award JP/exp/gil, return to the map with the next node unlocked.
On defeat: return to the map with nothing recorded, so the node can be retried.

Boot should show the world map when a save exists, and start a new campaign when it does not.

## Tests — write from this wording first, watch them fail, then make them pass

`tests/world.test.ts`:
1. A node with unmet `requires` is locked; completing its prerequisites unlocks it.
2. `availableNodes` returns only unlocked, uncompleted nodes.
3. Winning a battle node records it and unlocks the next.
4. Losing records nothing — the node stays available.
5. The whole chain survives serialize/deserialize.
6. Every node's `scenarioId` resolves to a real scenario, and every `requires` id is a real node
   (no dangling references, no cycles).

**Do not write a test that asserts current behaviour instead of the behaviour above.** Three earlier
tasks failed review for exactly that — one test explicitly expected a silent omission, another
pre-sorted a fixture so a mutation check could not fire.

## Rules

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- `BattleState` is mutated only by `applyCommand`.
- Party editing touches the campaign only, never a live `BattleState` (step 2's rule).
- Never a backtick in a shader-file comment.
- 494 tests currently pass; do not regress them.

## Success criteria

    npx tsc --noEmit     clean
    npx vitest run       494 existing + the six above
    npm run verify       green, all four gates

Then prove the loop in a browser against a static build:

    npx vite build && npx vite preview --port 4173 --strictPort &
    node tools/play.mjs --steps "burst:3x300,key:Enter,burst:3x300" --port 4173 --out shots/worldmap

Read the PNGs. Confirm the map renders with node states visible. Report the commands and what they
printed.
