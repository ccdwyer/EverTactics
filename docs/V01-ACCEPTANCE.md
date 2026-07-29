# v0.1 acceptance walk

Driven through the real input path with `tools/play.mjs` against a static build (`vite build` +
`vite preview`), not the dev server. Frames in `shots/acc-mine*/`. Walked by Claude after three
delegated rounds produced fixes but no evidence.

> Historical balance note (2026-07-29): this walk predates the encounter balance pass. The new
> campaign company starts at level 7–9 and First Watch's enemies are level 5–6. The level 13/14
> versus level 3 statement below remains valid evidence about that captured build, not the current
> game. See `docs/BALANCE.md`.

## Stage table

| stage | verdict | evidence |
|---|---|---|
| Title screen renders, offers New Game / Continue | **WORKS** | `acc-mine/00-boot.png` — Continue correctly greyed with "No saved campaign" |
| New Game → world map | **WORKS** | `acc-mine/01-Enter.png` — Chapter 1, 14 nodes, roster of 6 minted |
| World map shows locked vs available | **WORKS** | one node available ("The Broken Cloister"), 13 locked with padlocks |
| Select node → Formation | **WORKS** | `acc-mine2/02-click-0.113-0.75.png` — 6/6 deployed, roster panel, BEGIN BATTLE |
| Begin Battle → live battle | **WORKS** | `acc-mine3/03-*.png` — `phase=awaiting-command`, `active=Aldric` |
| Battle intro presentation | **WORKS** | `acc-mine4/04-reload.png` — map and encounter name, "Any input — skip" |
| Refresh mid-battle | **WORKS** | re-enters the battle cleanly; roster of 6 survives |
| Console errors across the whole walk | **NONE** | `errors: 0` at every step |
| Rejected commands across the whole walk | **NONE** | `rejectedCommands: 0` — the lockup signature |

## Answers

1. **Can a new player reach a battle from the title screen without devtools?** Yes. Title → New
   Game → world map → node → Formation → Begin Battle, all through real input.
2. **Does progression carry between battles?** *Not yet verified* — no battle has been driven to
   completion through the UI. Covered at engine level by the 30-battle content sweep, which is a
   weaker claim than a player-driven win.
3. **Does anything survive a refresh?** Yes, partially proven: the roster of 6 survives a
   mid-battle reload and the battle re-enters cleanly. Gil/JP/completed-node survival after a
   *won* battle is still unverified.
4. **Any soft-lock?** None found on the path walked. The lost-battle path, empty shop, and
   below-minimum formation remain unchecked.
5. **Does the AI propose rejected commands during human play?** No — `rejectedCommands: 0`
   throughout. `play.mjs` now exits 5 if one ever appears, so this is enforced, not observed once.

## Notes

**The `surface` probe is unreliable.** It reported `world-map` while the Formation screen was
open, because Formation is a modal over the map. Do not read a stage transition from that field —
read the frame. This cost a round: an earlier reading of "Enter does nothing on the world map" was
wrong; the click had worked and the probe simply did not say so.

**`tools/play.mjs` defaulted to `--host 127.0.0.1`** after the step-10 rewrite, while
`vite preview` binds the IPv6 loopback. Node's `fetch` refused the v4 address, so every run died
with "dev server did not start" while `curl` to the same port returned 200. Default restored to
`localhost`. This is why three delegated rounds struggled to produce frames.

## Still open

Driving a battle to victory through the UI, then checking gil/JP/learned abilities/completed nodes
across a refresh. That is the remaining gap between "the loop is reachable" and "the loop closes".

---

## Second walk — resolution attempt, and a finding

Drove 90 consecutive turns through real input (634 steps, `shots/acc-outcome/`), passing every turn
via the command menu's WAIT.

**Result: 0 console errors, 0 rejected commands across 634 steps.** Seven units cycled through the
turn order correctly. That is the strongest evidence yet against the reported lockup: the exact
input path that produced it now runs for 90 turns clean, and `play.mjs` exits 5 the moment a
rejected command appears.

**Neither victory nor defeat was reachable this way**, which is a scenario-balance fact rather than
a defect: a level-13/14 company cannot be killed by the level-3 opening encounter no matter how
long it stands still, and passing turns never kills anything. Driving to victory needs scripted
ATTACK + target clicks, which is the remaining piece of work.

### Finding: `progress.current` has two writers using different id spaces

- `src/state/scenarios.ts:430` — `campaign.progress.current = scenario.id` (a **scenario** id)
- `src/state/game.ts:282` — `this.campaign.progress.current = routedNode.id` (a **world-node** id)

Observed live after launching the first battle from the world map: `current: 'battle-open'` — a
scenario id, and not even the scenario that was launched.

This matters because `battleToCampaign` reads `progress.current` to decide what to mark completed.
That field was introduced precisely to remove a "remember to pass the right argument" trap during
step 1; it now carries values from two different id spaces depending on which path ran last, which
is the same trap in a new shape. Not yet proven to mis-record a completion — the world map does
unlock correctly on the paths walked — but it should be one type with one writer before recruitment
and chapter 2 gating depend on it.
