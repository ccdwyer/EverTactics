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
only. Even-sized medians average the two middle values. All 120 battles resolved within the
400-turn cap. An illegal AI command aborts the harness rather than returning a misleading row.

<!-- balance-table:start -->
| Ch. | Encounter | Player wins | Median turns | Median player survivors on win | Battles with a player KO |
|---:|---|---:|---:|---:|---:|
| 1 | Orbonne Monastery — Cloister Garden | 11/12 (91.7%) | 116.5 | 6 | 12/12 (100%) |
| 1 | Orbonne Monastery — First Watch | 12/12 (100%) | 29 | 6 | 4/12 (33.3%) |
| 1 | Mandalia Plains — Scout Line | 6/12 (50%) | 84.5 | 4 | 12/12 (100%) |
| 1 | Gariland Bridge — The Toll Line | 12/12 (100%) | 56 | 6 | 8/12 (66.7%) |
| 1 | Zeirchele Ridge — Running Battle | 10/12 (83.3%) | 57.5 | 5 | 11/12 (91.7%) |
| 2 | Lionel Gate — The High Ward | 4/12 (33.3%) | 106 | 3 | 12/12 (100%) |
| 2 | Dorter Storehouse — Blind Corners | 7/12 (58.3%) | 86 | 4 | 12/12 (100%) |
| 2 | Mandalia Plains — River Ambush | 10/12 (83.3%) | 75 | 4 | 10/12 (83.3%) |
| 2 | Orbonne Monastery — Ashen Cloister | 3/12 (25%) | 99 | 2 | 12/12 (100%) |
| 2 | Lionel Gate — Reckoning | 3/12 (25%) | 65 | 3 | 12/12 (100%) |
<!-- balance-table:end -->

## Judgment

- First Watch remains a guaranteed AI win, but it is no longer a cutscene proxy: player units are
  knocked down in 4/12 samples and the 29-turn median stays well below the longer campaign fights.
  Its level 5–6 novice guard faces the level 7–9 starting company; Owain's basic Broadsword gives
  the three-unit guard enough threat to teach positioning without adding another enemy.
- Reckoning is now winnable in 3/12 samples, down from First Watch's 12/12, and knocks down a
  player unit in every sample. By eye, the six-unit roster was doing two redundant things: Voss
  duplicated the Samurai front and Celia prolonged it with a healing loop. The final roster keeps
  four distinct jobs, high ground, and levels 12–16.
- The middle encounters were judged from their roles, map positions, survivor counts, and KO
  frequency rather than tuned to a smooth percentage curve. The harness always uses the starting
  company; it deliberately does not invent campaign EXP, purchases, or equipment upgrades for the
  later fights. The late-game rates are therefore conservative.
- The `orbonne-vanguard` row is a protected visual-reference encounter, not a world-map fight.
  `battle-open` and the diagnostic scenes still use their original level 12–14 cast.

## Deterministic sweep impact

Before the balance changes:

```text
[integration] AI command sweep: battles=16, commands=2552, rejected=0
[content] campaign sweep: maps=6, encounters=10, battles=30, commands=4504, rejected=0
```

After the balance changes:

```text
[integration] AI command sweep: battles=16, commands=2552, rejected=0
[content] campaign sweep: maps=6, encounters=10, battles=30, commands=4523, rejected=0
```

The integration total stayed fixed while the content total moved from 4504 to 4523. Starting
levels and authored encounter units changed, so recorded combat values from the earlier v0.1
playthrough are historical; see `docs/V01-ACCEPTANCE.md` and
`shots/v01-victory/persistence-diff.md`.
