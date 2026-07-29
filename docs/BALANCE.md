# Campaign encounter balance

Measured on 2026-07-29 with production AI controlling both teams:

```bash
npm run balance -- --check
```

The harness runs every encounter across seeds `1, 3, 5, 8, 13, 17, 21, 34, 41, 55, 89, 144`.
Campaign encounters launch through `newGameCampaign` and `campaignToBattle`, so the company uses
its real level 7–9 roster, map deployment, and three-Potion inventory. The protected
`orbonne-vanguard` visual reference still launches directly as `battle-open`.

Each KO figure is the number of battles in which at least one player unit was knocked down,
including a unit later raised. Survivor medians count standing player units at the end of wins
only. Even-sized medians average the two middle values. "Before" is the previous accepted sweep;
"after" is the current measurement. All 120 battles resolved within the 400-turn cap. An illegal
AI command aborts the balance harness rather than returning a misleading row.

<!-- balance-table:start -->
| Ch. | Encounter | Wins before | Wins after | Turns before | Turns after | Survivors before | Survivors after | Player KO before | Player KO after |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Orbonne Monastery — Cloister Garden | 11/12 (91.7%) | 10/12 (83.3%) | 116.5 | 58.5 | 6 | 4 | 12/12 (100%) | 12/12 (100%) |
| 1 | Orbonne Monastery — First Watch | 12/12 (100%) | 12/12 (100%) | 29 | 27 | 6 | 6 | 4/12 (33.3%) | 3/12 (25%) |
| 1 | Mandalia Plains — Scout Line | 6/12 (50%) | 8/12 (66.7%) | 84.5 | 64 | 4 | 4 | 12/12 (100%) | 12/12 (100%) |
| 1 | Gariland Bridge — The Toll Line | 12/12 (100%) | 12/12 (100%) | 56 | 36.5 | 6 | 5 | 8/12 (66.7%) | 9/12 (75%) |
| 1 | Zeirchele Ridge — Running Battle | 10/12 (83.3%) | 11/12 (91.7%) | 57.5 | 49.5 | 5 | 4 | 11/12 (91.7%) | 12/12 (100%) |
| 2 | Lionel Gate — The High Ward | 4/12 (33.3%) | 5/12 (41.7%) | 106 | 59.5 | 3 | 2 | 12/12 (100%) | 12/12 (100%) |
| 2 | Dorter Storehouse — Blind Corners | 7/12 (58.3%) | 9/12 (75%) | 86 | 65 | 4 | 4 | 12/12 (100%) | 12/12 (100%) |
| 2 | Mandalia Plains — River Ambush | 10/12 (83.3%) | 9/12 (75%) | 75 | 60.5 | 4 | 5 | 10/12 (83.3%) | 10/12 (83.3%) |
| 2 | Orbonne Monastery — Ashen Cloister | 3/12 (25%) | 3/12 (25%) | 99 | 55 | 2 | 3 | 12/12 (100%) | 12/12 (100%) |
| 2 | Lionel Gate — Reckoning | 3/12 (25%) | 3/12 (25%) | 65 | 48 | 3 | 1 | 12/12 (100%) | 12/12 (100%) |
<!-- balance-table:end -->

## Diagnosis before tuning

- Travel was not the cause. Instrumented runs reached first damage at roughly turns 5, 6, and 5
  in Cloister Garden, High Ward, and Ashen Cloister; Gariland's comparison fight reached damage
  around turn 5.5. The extra 40–110 turns happened after contact.
- The primary cause was the shared AI's sustain valuation. Raise was authored at 60% accuracy but
  evaluated as certain, then scored twice through both its revival and KO-cure terms. Once units
  started falling, support units recycled casualties instead of helping close the fight. The
  engagement-pressure clock also did not affect healing or revival, so the loop stayed attractive.
- A second AI defect could make defeat-all literally unwinnable: the current Jump content applies
  the `jumping` marker to its target permanently. That target becomes untargetable and never
  returns. AI Jump is excluded until caster leave/return timing is implemented.

## Changes and judgment

- Raise now keeps its authored hit chance and is scored once. After measured contact, engagement
  pressure begins at world-clock tick 16, reaches its ceiling at tick 48, and progressively
  discounts healing and especially revival while making idle or retreating play less attractive.
- Cloister Garden needed no encounter-content change: its median fell from 116.5 to 58.5 while its
  player win rate stayed distinct from First Watch at 10/12 versus 12/12.
- High Ward kept its five-role roster but gained two enemy levels to offset the faster, more
  decisive AI. It moved from 106 turns and 4/12 wins to 59.5 turns and 5/12 wins.
- Ashen Cloister's redundant secondary healing was part of its attrition loop. Mirelle now brings
  Black Magic instead of White Magic, Cassian and Bors commit aggressively, and the roster gained
  two levels. It moved from 99 turns to 55 while holding at 3/12 wins.
- Each Scout Line enemy gained four levels, each Dorter enemy two, and each Reckoning enemy one
  to preserve the curve after the global AI fix. Chapter 1 finishes at 53/60 player wins (88.3%);
  chapter 2 finishes at 29/60 (48.3%), and Reckoning remains 3/12 (25%).
- `battle-open` and the diagnostic scenes were not changed.

## Sweep assertion audit

- `rejectedCommands === 0` was tautological because the helper threw on its first rejection.
  Sweeps now use a collecting mode that records structured scenario/seed/turn/command errors,
  continues safely with a wait when needed, and asserts the collected list is empty. The default
  remains fail-fast for ordinary tests and the balance harness.
- `commands > 0` was removed: every normal plan contains at least a wait, so it could not detect a
  useful regression. Exact command totals remain telemetry.
- Fixed-loop battle-count equalities were removed after the scenario and per-battle resolution
  checks; they only restated loop bookkeeping. Turn-cap and terminal-phase assertions remain
  because they can independently fail.
- The collecting sweep immediately exposed a real mismatch: Frog reduced Move in battle
  validation but not AI pathfinding. Both now use the same reduced movement budget.

## Deterministic sweep impact

Before this pacing change (the last documented sweep):

```text
[integration] AI command sweep: battles=16, commands=2552, rejected=0
[content] campaign sweep: maps=6, encounters=10, battles=30, commands=4523, rejected=0
```

After the pacing change:

```text
[integration] AI command sweep: battles=16, commands=1981, rejected=0
[content] campaign sweep: maps=6, encounters=10, battles=30, commands=3063, rejected=0
```

The new `rejected=0` figures are collected measurements, not values that exist only because the
helper returned. The lower command totals agree with the independently measured turn reductions.
