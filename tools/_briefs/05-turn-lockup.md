# BUG: infinite command-rejection loop hangs the battle

## The root cause is known. Do not re-derive it.

Player console output, repeating forever:

    [game] rejected command                              game.ts:707
      {kind:'act', unit:'e-quill', ability:'yell', target:{…}, targetUnit:'e-maelor'}
      act: (10,1) is out of range for Yell

`decideTurn` proposes an `act` that `applyCommand` refuses as out of range. The turn is never
closed out, `beginTurn` asks the AI again, the AI is deterministic, so it proposes **the same
illegal command** forever. The battle hangs.

This is a **rules disagreement between the AI and the reducer**, not an animation or promise bug.
My earlier guess that `Game.play()` was hanging on an unresolved VFX promise was wrong — ignore it.

Note `tests/playthrough.test.ts` does not catch this because its driver skips a command when the
phase is no longer `awaiting-command` and then force-closes the turn with a `wait`. It papers over
exactly this failure.

## Fix all three of these

### 1. The real bug — AI and reducer must agree on range
`e-quill` believes it can target `e-maelor` at (10,1) with Yell; `applyCommand` disagrees. Find
where the AI computes an ability's legal targets and make it use the **same** function the reducer
validates with. Two implementations of "is this in range" is the defect; one canonical predicate is
the fix. Check `effectiveRange` / `usesWeaponRange` handling in particular — an ability whose reach
comes from the weapon is the likely divergence.

### 2. The engine must never hang, whatever the AI proposes
Even with (1) fixed, a rejected AI command must not be able to loop forever. In the turn loop:
if a unit's proposed commands are all rejected, **log once and close the turn with `wait`**. A
misbehaving AI should cost that unit its turn, not the whole game.

### 3. Stop the test driver from hiding it
`tests/playthrough.test.ts` and `tests/integration.test.ts` swallow this class of bug. Make an
`IllegalCommandError` from an AI-proposed command **fail the test**, rather than being skipped and
force-closed. Then add a regression test that reproduces the loop: run seeded AI-vs-AI battles and
assert no command is ever rejected.

## Requirements

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- `BattleState` is mutated only by `applyCommand`.
- Determinism must hold — same seed, byte-identical event stream.
- 500 tests currently pass; do not regress them.
- Never a backtick in a shader-file comment.

## Success criteria

    npx tsc --noEmit     clean
    npx vitest run       500 existing + your regression test
    npm run verify       green, all four gates

And prove the actual scenario: run seeded AI-vs-AI battles across at least 8 seeds on both maps and
report **zero** rejected commands. Report the root cause with file and line, and the numbers you got.
