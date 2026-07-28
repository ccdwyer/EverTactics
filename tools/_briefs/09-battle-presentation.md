# v0.1 step 8 — Battle audio and presentation

Read `docs/ROADMAP-v0.1.md` step 5 first. Steps 1–7 are done: the full loop runs, and there are six
maps and ten encounters. What is missing now is not systems, it is **presentation** — a battle
starts abruptly, resolves abruptly, and is completely silent except for menu clicks.

This is the difference between "the engine works" and "this feels like a game".

## Do not rebuild what exists

`src/ui/audio.ts` is already a working synthesised UI audio layer — cursor, confirm, cancel, error,
open, close, page, award, levelup, with autoplay policy honoured and a master gain. **Extend it.
Do not replace it, do not add a second AudioContext, and do not ship sample files.**

Everything below is synthesised with WebAudio for the same reasons stated in that file's header: no
assets, no licensing, timbre tuned in source.

## What to build

### 1. Battle SFX — `src/ui/audio.ts` (extend)

Add a `BattleSound` type and `playBattle(sound, opts?)` alongside the existing UI path:

    'step' | 'swing' | 'hit' | 'crit' | 'miss' | 'heal' | 'cast' | 'ko' | 'counter'

Requirements that make this sound like a game rather than a test tone:

- **`hit` must vary with severity.** Take a normalised damage fraction and move brightness//decay
  with it. One invariant thud for a 3-damage poke and a 90-damage crit reads as broken audio.
- **Pitch jitter.** Every repeated sound gets a small random detune, or ten steps in a row sound
  like a machine. Use `Math.random()` here — this is `src/ui/`, not `src/core/`, and audio must
  never touch the seeded `Rng` or it will perturb battle determinism.
- **Voice cap.** A ten-tile walk or a multi-target spell can fire many sounds in one frame. Cap
  concurrent voices and drop the excess rather than clipping the master bus.

### 2. Wire SFX to battle events, not to call sites

The renderer already consumes `BattleEvent[]`. **Drive audio from that stream** — one subscriber
mapping event kinds to sounds. Do not sprinkle `playBattle()` calls through ability code: that path
guarantees the day someone adds an event and forgets the sound.

Map at minimum: `moved` → step (per tile), `damage` → hit/crit scaled by amount, `miss` → miss,
`heal` → heal, `reaction` → counter, `knockdown` → ko, ability start → cast.

**Replay safety:** audio must be a pure observer. Running a battle headless in tests must not
require an AudioContext and must not change the event stream. `npx vitest run` must stay green,
and the determinism tests in `tests/integration.test.ts` must produce byte-identical streams.

### 3. Battle intro and outcome presentation — `src/ui/screens/`

- **Intro:** the map name and encounter name, briefly, over the opening camera. There is already an
  encounter model in `src/content/encounters/` with names — use them.
- **Victory / defeat:** a held beat before the result screen appears. Right now the transition is
  instant, which is why winning does not feel like anything.
- Both must be **skippable** on any input, and must not block the battle from resolving if skipped.

Keep these short. FFT's victory beat is about two seconds, not a cutscene.

### 4. Music — one loop, done properly, or none at all

A single synthesised battle bed: slow, sparse, low. If you cannot make it sound intentional, **ship
silence and say so in your report** — no music is far better than bad procedural music, and this is
the one item here I would rather you skip than fake.

If you do ship it: it must fade in, duck under the outcome beat, and honour the existing mute.

## Success criteria — commands and numbers

    npx tsc --noEmit            clean
    npx vitest run              520 currently, plus yours
    npm run verify              gates must stay green
    node tools/play.mjs --scene gariland-bridge --steps "key:Enter,click:0.42x0.55,burst:12x120"

`tests/audio.test.ts` must cover, at minimum:
1. the event→sound mapping is total — every event kind the engine emits either maps to a sound or
   is explicitly listed as silent, so a new event kind fails the test rather than being silent
2. severity scaling: a large `damage` and a small one produce different parameters
3. headless safety: the mapping module imports and runs under node with no AudioContext
4. determinism: a seeded battle with the audio subscriber attached emits an identical event stream
   to one without it

## Project rules

- `src/core/` never imports three.js and never calls `Math.random()` or `Date.now()`.
- Randomness in `src/core/` only via the seeded `Rng`. Audio jitter belongs in `src/ui/`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change existing scenario behaviour; the screenshot and blind-judge tooling depends on
  `battle-open` and the diagnostic scenes.

## Report

State exactly which commands you ran and the numbers they printed. If you shipped silence instead
of music, say so plainly — that is an acceptable outcome, quietly shipping a bad loop is not.
