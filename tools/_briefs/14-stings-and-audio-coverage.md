# v0.1 polish — victory/defeat stings and an audio coverage audit

Read `docs/STATUS.md` first. v0.1 is functionally complete; 555 tests, gates green. This is polish.

Battle audio shipped in step 8 and deliberately shipped **no music** — silence was judged better
than a weak procedural loop, and that call stands. This task does not reverse it. A looping battle
bed is still out of scope.

## What to build

### 1. Victory and defeat stings

A **sting** is a short authored phrase — two to four seconds, resolving — not a loop. This is the
one place where music earns its keep: the held beat before the result screen already exists
(`BattlePresentationScreen`), and it currently plays into silence, which is why winning does not
land emotionally.

- **Victory:** rising, resolved, triumphant. It should feel like an arrival.
- **Defeat:** falling, unresolved. Shorter than the victory sting — dwelling on a loss is a
  punishment the player did not ask for.
- Both synthesised through the existing `src/ui/audio.ts` layer. **No sample files.** Same
  reasoning as step 8: no assets, no licensing, timbre tuned in source.
- Both must honour the existing mute and master gain, and must duck or replace any SFX still
  ringing so the sting is not fighting a hit sound.
- Both must be **skippable** — skipping the outcome beat must stop the sting, not leave it playing
  over the result screen.

**If you cannot make these sound intentional, ship silence and say so in your report.** That
remains an acceptable outcome and a quietly-bad sting is worse than none. This is a genuine option,
not a formality — step 8 exercised it correctly.

### 2. Audio coverage audit

`src/ui/battleAudio.ts` maps `BattleEvent` kinds to sounds, and step 8 added a totality test so a
new event kind fails rather than being silently silent. Verify that is still true, then extend the
same discipline to the **UI** layer:

- Every `UIIntent` that a player can trigger should produce a sound or be explicitly listed as
  silent, with a test asserting the mapping is total.
- Report any screen transition that is currently silent and should not be: entering the world map,
  entering a shop, a purchase succeeding, a purchase failing for want of gil, deploy confirmed,
  a job change committed.

Report the coverage table: intent → sound, or intent → deliberately silent, with the reason.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            555 currently, plus yours
    npm run verify            gates must stay green

`npm run verify` now requires `gatesPass` for a green exit — it previously exited 0 with a failing
gate, so do not assume a green run from an older log means what it appears to mean.

Audio must remain a **pure observer**: a headless test run must not require an AudioContext, and a
seeded battle must emit a byte-identical event stream with stings active. `tests/integration.test.ts`
asserts this.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`. Audio jitter belongs in `src/ui/`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes.
- Do not write a test that mocks past the code path it claims to verify; one was deleted in step 10
  for exactly that.
