# v0.1 polish — signature ability VFX and ability camera

v0.1 is functionally complete: the loop closes, persistence is proven byte-identical across a
refresh, 545 tests green. This is the first task that is purely about how the game **feels**, not
whether it works.

Read `docs/VISUAL_TARGET.md` before starting. The metrics gates in `npm run verify` are not
optional and not advisory — a change that makes a frame prettier to you and moves `lumaSpread` or
`localContrast` out of band is a regression.

## The problem

Ability effects are **generic archetypes**. Fire, Bolt and Ice differ mainly by tint. In the
reference games, a signature spell is recognisable from across the room with the sound off — a
Summon is an event, a Holy is a column of light, an Ultima is a screen-filling bloom. Right now
every spell is roughly the same shape at a different hue, which is the single loudest remaining
"this is a prototype" signal in the battle view.

## What to build

### 1. Signature effects for at least eight abilities

Pick them for *coverage of archetype*, not for which is easiest: a black-magic nuke, a summon, a
holy/light effect, a heal, a physical limit/charge attack, a status/debuff, an elemental
area-of-effect, and a dark/drain effect. Name your eight in the report and say why.

Each must be distinguishable from the others **in a still frame**, not only in motion. If two
effects are only told apart by their colour ramp, that is the archetype problem again in new paint.

### 2. Ability camera

A signature ability should get camera attention proportional to its weight: a small push-in and
hold for a big spell, nothing at all for a basic attack. FFT and Triangle Strategy both do this
sparingly, and sparingly is the point — **if every ability gets a camera move, the game becomes
unplayable to grind through.**

Requirements:
- Only abilities marked as significant get a move. Basic attacks and items never do.
- **Skippable**, and skipping must not desync the event stream or leave the camera parked.
- The camera must return exactly to its prior framing. A drift of a few degrees per cast compounds
  into an unusable view over a long battle.

### 3. Do not regress what is already good

- Audio already drives from the `BattleEvent` stream via `src/ui/battleAudio.ts`. VFX must hang off
  the same stream, not a parallel path — one event source, two observers.
- Determinism is load-bearing: a seeded battle must emit a byte-identical event stream with VFX and
  camera active. `tests/integration.test.ts` asserts this and must stay green.
- The AI sweep must stay at `rejected=0`.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            545 currently, plus yours
    npm run verify            gates must stay green — this is the one that matters here
    node tools/play.mjs --out shots/vfx --steps "..."   frames showing each of the eight

Report the eight abilities, a frame filename for each, and the gate numbers before and after.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`. VFX jitter belongs in `src/render/` or `src/ui/`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`. **VFX are observers and
  must never mutate battle state.**
- **Never put a backtick in a comment inside a shader file.** Shader source lives in template
  literals; a backtick in a comment closes the string and `tsc` reports a cascade of errors pointing
  at identifiers that were never code. This has happened six times. Use single quotes.
  `npx vitest run tests/shader-source.test.ts` catches it and names the line.
- Do not change `battle-open` or the diagnostic scenes; the screenshot and blind-judge tooling
  depends on them.
- Evidence for anything visual is a frame, not a passing unit test.
