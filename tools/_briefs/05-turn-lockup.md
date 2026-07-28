# BUG: the game locks up after the second enemy acts

Player-reported, reproduced in normal play: a battle proceeds, and after roughly the second enemy
turn the game stops advancing. No console errors.

## What is already known — do not re-derive this

**The bug is NOT in the reducer or the AI.** `tests/playthrough.test.ts` and
`tests/integration.test.ts` drive full AI-vs-AI battles to a decisive result across 8 seeds and 2
maps, and they pass (500 tests green). Those tests call `advance` / `decideTurn` / `applyCommand`
directly and never touch `Game`.

So the hang is in the **interactive turn loop in `src/state/game.ts`** — `beginTurn`, `submit`,
`play`, and the `queue` promise chain — not in `src/core/`.

Prime suspects, in order:
1. **`Game.play()` never resolves.** It awaits animations for an event stream; if one event type
   has no handler that settles (or a VFX/timeline promise never completes), the `await` hangs
   forever and `busy` stays true, so no further turn begins. An enemy using an ability the player
   has not used yet would explain "second enemy" specifically.
2. **The `queue` promise chain deadlocks** — something awaits the queue from inside a task already
   on it.
3. **`beginTurn` early-returns without rescheduling.** Look at every `return` in `beginTurn`: if any
   path exits while `phase !== 'awaiting-command'` and nothing re-enters the loop, the clock stops.
4. **An AI unit's `decideTurn` returns commands that `applyCommand` rejects**, the throw is caught
   somewhere, and the turn is never closed out with a `wait`.

## Reproduce it first

Do not fix anything until you can reproduce it on demand. Suggested approach:

    npx vite build && npx vite preview --port 4173 --strictPort &
    node tools/play.mjs --scene battle-open --steps "key:Enter,click:<x>x<y>,burst:20x1500" --port 4173 --out shots/lockup

Note a click only registers on a legal destination tile; a miss leaves `mode` at `command` and
nothing happens. Poll `window.__EVERTACTICS__` (exposed with `?debug=1`) for
`state.phase`, `state.active`, `state.tick`, `busy` and `mode.kind` every second and find the exact
moment `tick` stops advancing while `busy` is true.

A headless alternative that may reproduce faster: drive `Game` directly in a test, letting the AI
take several turns, with a timeout — if `play()` never resolves, the test hangs and you have it.

## Fix requirements

- Whatever the cause, **`busy` must not be able to strand.** Add a defensive timeout or a `finally`
  that always releases it, so a single misbehaving animation degrades to a skipped effect rather
  than a dead game. A hung turn loop is unrecoverable for the player.
- Add a regression test that drives `Game` (not just the reducer) through **at least six
  consecutive turns including multiple enemy turns**, and fails if the clock stops advancing.
- Do not weaken the existing determinism guarantees; `tests/playthrough.test.ts` and
  `tests/integration.test.ts` must keep passing.

## Rules

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- `BattleState` is mutated only by `applyCommand`.
- Never a backtick in a shader-file comment.
- 500 tests currently pass. Do not regress them.

## Success criteria

    npx tsc --noEmit     clean
    npx vitest run       500 existing + your regression test
    npm run verify       green, all four metrics gates

Report: the actual root cause with the file and line, how you reproduced it, and the evidence the
fix works — not a description of what you changed.
