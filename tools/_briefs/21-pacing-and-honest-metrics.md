# Pacing outliers, and making `rejected=0` mean something

Read `docs/BALANCE.md` first. The arc now has a difficulty curve — chapter 1 averages ~85% player
wins, chapter 2 ~45% ending at 25%. Two problems remain, one about play and one about honesty.

## Part A — the pacing outliers

Win rate is only half of whether a fight is good. The table shows three encounters that pass the
win-rate bar while being tedious:

| encounter | median turns | player KO rate |
|---|---:|---:|
| Orbonne Monastery — Cloister Garden | **116.5** | 12/12 |
| Lionel Gate — The High Ward | 106 | 12/12 |
| Orbonne Monastery — Ashen Cloister | 99 | 12/12 |

For comparison, First Watch resolves in 29 and Gariland Bridge in 56. **A fight that takes four
times as long as another is not four times as interesting.** FFT battles are typically 20–40 turns;
116 is a war of attrition where both sides shuffle and heal.

Diagnose before tuning. Plausible causes, in the order I would check them:
- Too many units on too large a map — the AI spends turns walking rather than fighting.
- Healing outpacing damage, so neither side can close.
- The AI's engage heuristic holding position when it should commit.
- Objective is "defeat all enemies" on a map where a straggler can hide.

**Report the cause you found before the change you made.** If the cause is the AI rather than the
encounter, say so — that is a more valuable finding, and tuning the encounter would be papering
over it.

Target: bring those three toward the 30–60 band the better encounters already occupy, **without**
flattening their win rates into the opener's territory. Re-run the balance harness and put the new
table in `docs/BALANCE.md`, keeping the old numbers visible as a before column.

## Part B — `rejected=0` is currently a tautology

`tests/helpers/aiBattle.ts` increments `rejectedCommands` and then **throws**:

    if (error instanceof IllegalCommandError) {
      rejectedCommands++;
      throw new Error(`AI proposed an illegal command in ...`);
    }

So any battle that returns successfully has `rejectedCommands === 0` **by construction**. Every
sweep in this project asserts that value, and the assertion cannot fail. It has been reported as
evidence in commit messages and status updates for weeks, including by me.

The protection itself is real and worth keeping — an illegal command fails loudly with scenario,
seed and turn, which is exactly what surfaced the reported lockup. The problem is only that the
*number* proves nothing.

Fix it so the reported figure is a measurement. Either:
- give `runAiBattle` a collecting mode that records rejections and continues, so a sweep can report
  a genuine count while the default stays fail-fast; **or**
- delete the vacuous assertions and replace them with a comment saying the throw is the guard.

I mildly prefer the first — a real count would let the sweep distinguish "no illegal commands" from
"one illegal command, and we stopped at the first" — but the second is honest and cheaper. Pick
one, do it properly, and update every call site that currently asserts the tautology.

While you are there: audit the other sweep assertions for the same shape. `commands > 0` is close
to vacuous too. Anything that cannot fail should either be made meaningful or removed, and the
result reported.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            590 currently, plus yours
    npm run verify            all four gates green

Plus the updated `docs/BALANCE.md` with before/after columns, and a statement of which assertions
you found vacuous and what you did about each.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes.
- The balance suite is slow and has flaked `npm run verify` once. If you make it slower, give it a
  budget that holds — do not fix a flake by deleting coverage.
- Do not describe a rename as a behaviour change.
