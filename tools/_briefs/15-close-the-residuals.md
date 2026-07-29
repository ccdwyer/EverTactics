# v0.1 cleanup — close the accepted residuals

Read `docs/KNOWN-ISSUES.md`. v0.1 is functionally complete (561 tests, gates green), so the debt
that was deliberately deferred to unblock the roadmap is now due.

Every item below was **accepted on purpose** by a reviewer who judged it not worth blocking on at
the time. That judgement was right then. It is not right now, because the reasons they were safe
("nothing upstream produces this input yet") expire as the game grows.

Fix them, delete the entries you fix from `docs/KNOWN-ISSUES.md`, and leave anything you decide
**not** to fix in the file with a sentence on why. A shorter honest list beats a long stale one.

## The items

### 1. `{"__proto__": 0}` as an inventory key vanishes
`requireInventory` in `src/core/campaign.ts`. The key disappears through the inherited setter. No
real item id looks like this, which is why it was accepted — but it is a prototype-pollution shaped
hole in a function whose whole job is validating untrusted save data. Use a null-prototype object
or an explicit own-property check, and test with `__proto__`, `constructor`, and `prototype` as keys.

### 2. `killCountOf` fallback removed
`src/core/tree.ts` reads only `ctx.kills`. Production is fine because `Game` always builds the
context, but a core helper called with `{}` silently locks a unit that has earned the kills.
Restore a fallback or make the parameter non-optional so the compiler catches the empty case. The
step-3 note says this is "the same 'nothing calls them' shape that cost step 2 four rounds".

### 3. Status-tick KOs emit unattributed knockdowns
`src/core/battle.ts`. A unit killed by poison/doom credits no kill, so Dark Knight unlock progress
silently stalls for a player who leans on damage-over-time. Attribute the KO to whoever applied the
status. If that provenance is not currently tracked, say so and what it would cost — do not fake it
by crediting the active unit.

### 4. Economy tests hardcode prices
`tests/economy.test.ts` asserts dagger 200 / potion 100 rather than reading the item table, so a
price change breaks the test instead of the test catching a real regression. Read the table.

### 5. `sellItem` allows a resale price of 0
`price < 0` should be `price <= 0`. One character, plus a test.

### 6. The deleted player-victory routing test
Step 10 removed `opens the result flow when a player action wins the battle` from
`tests/game-routing.test.ts`; the comment left in its place explains why. **Rewrite it properly.**

The old one assigned `game.mode` directly with a hand-built `legal` set, but `onClick` gates on
`canAimAt` and never reads `legal` — so it constructed a state the real input path cannot produce.
Drive a real command through the public surface instead. Note two facts already measured: a
level-99 attacker does **not** one-shot a level-1 unit's 100 HP, and a basic attack has range 1, so
the target must be adjacent and genuinely killable.

### 7. The sting skip test asserts the wrong mechanism
`tests/audio.test.ts`. It expects a second `oscillator.stop()`, which the `FakeAudioContext`
permits and a real `AudioContext` throws on — silence on skip actually comes from the voice gain
fade and disconnect. Assert the mechanism that really produces silence.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            561 currently, plus yours
    npm run verify            gates must stay green

For each of the seven: report FIXED or NOT FIXED with file:line, and for anything not fixed, the
reason. Report the diff to `docs/KNOWN-ISSUES.md`.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`. Determinism is
  load-bearing — the AI sweep must stay at `battles=16, commands=2552, rejected=0`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes.
- **Write each test from the requirement first and watch it fail.** Several items here exist
  because a test was shaped around the code's behaviour rather than the contract; do not add an
  eighth.
