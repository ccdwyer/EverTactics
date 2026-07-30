# v0.2 step 2 — Permadeath: the FFT crystal timer

Chris has decided: **FFT's crystal timer.** A downed unit has a few turns before it is gone for
good. This is the mechanic that makes losing someone hurt, and it is what the recruitment system
built in step 1 exists to feed.

Read `docs/ROADMAP-v0.2.md` and `src/core/recruit.ts` first.

## The mechanic

A unit reduced to 0 HP is **downed**, not dead. It carries a countdown — FFT uses 3 — which
decrements each time that unit would have taken its turn. Revive it before the count expires
(Phoenix Down, Raise) and it stands up. Let the count reach zero and it **crystallises**: gone from
the battle, and for a player unit, gone from the roster permanently.

Details that matter:

- **The countdown is per-unit and turn-based, not real-time.** It ticks on the downed unit's own
  would-be turn, so a fast unit's timer runs out sooner in wall-clock terms. Do not attach it to a
  global turn counter.
- **The count must be visible.** The turn rail and the unit panel both need to show it. A hidden
  timer is a punishment the player cannot plan around, and this is the single most consequential
  number on screen while it is running.
- **Enemies crystallise too**, which is how FFT prevents a downed enemy from being revived forever.
- Existing `knockdown` events already carry attribution (v0.1 step 14). Build on that rather than
  adding a parallel death path.

## Where this gets dangerous

**Permadeath plus a deploy minimum is a soft-lock vector.** If a player loses enough units that the
roster falls below the number a battle requires, and cannot afford to hire, the campaign is over
with no way forward. That is exactly the class of bug the step-16 audit went hunting for.

Handle it explicitly and say what you chose:
- What happens when the roster falls below the deploy minimum?
- What happens if the roster empties entirely?
- Can a player be left unable to afford a hire *and* unable to fight? If so, that is a soft-lock and
  needs a floor — a free conscript, a guaranteed-affordable candidate, or a defeat-to-title path.

**Add a regression test for the below-minimum case.** `docs/SOFTLOCK-AUDIT.md` is the format.

## Persistence

- A crystallised player unit is removed from `campaign.roster` on write-back, not during the battle
  — `BattleState` is battle-scoped and the roster is durable.
- A save mid-campaign must not resurrect a crystallised unit. Add a test.
- **Do not remove a unit that was merely downed** when the battle ended. Surviving a loss while
  downed is normal in FFT; the battle ending stops the clock.

## Balance consequences

This will move every number in `docs/BALANCE.md`. Losing a unit mid-battle changes outcomes far more
than any tuning so far.

- Re-run the balance harness and update the table with before/after columns.
- **Expect win rates to fall.** If chapter 2 drops from 25% to near zero, say so rather than
  quietly re-tuning encounters in the same round — that would confound the mechanic's effect with
  the tuning's.
- Report the integration and content sweep numbers (currently `1981` and `3063`, both `rejected=0`,
  and that count is real since step 20).

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            616 currently, plus yours
    npm run verify            all four gates green

Plus:
- frames under `shots/permadeath/` showing a downed unit with a visible count, and a crystallised
  one — allow-listed **file by file** in `.gitignore`, never by directory
- the updated `docs/BALANCE.md`
- your answers to the soft-lock questions above

**Capture the frames.** Four rounds in this project have failed for shipping working code with no
evidence, most recently step 22 rounds 1 and 2 — one of which allow-listed frame filenames that
were never captured.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`. A battle must still replay byte-identically from a seed.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`, which returns
  `BattleEvent[]`. Crystallisation is an event the renderer observes, not a mutation the UI performs.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes.
- Do not write a test that mocks past the code path it claims to verify.
- Do not describe a rename as a behaviour change.
