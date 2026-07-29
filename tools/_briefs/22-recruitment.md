# v0.2 step 1 — Recruitment

Read `docs/ROADMAP-v0.2.md` first. v0.1 is complete and measured; this is the first v0.2 feature.

**The problem it solves:** the party never changes. Six units at the start, the same six at the
end, and a playthrough meaningfully touches six of thirty-four jobs. Every system that makes an FFT
company feel like *yours* — hiring, naming, choosing a job, growing a bench — is absent.

This is deliberately scoped to **generic recruitment only**. Story-joined named units are a later
task and depend on narrative that does not exist yet.

## What to build

### 1. `src/core/recruit.ts` — pure, deterministic

    rollRecruit(rng: Rng, opts: { job: JobId; gender: Gender }): PersistedUnit

Roll a hireable unit: zodiac, base raw stats, Brave and Faith, starting equipment appropriate to
the job. Everything through the seeded `Rng` — **never `Math.random()`**, and never `Date.now()`.
The same seed and the same choices must produce the same unit, because a campaign must replay.

Price the hire. FFT scales cost with level; here the roster's current level is a reasonable basis.
Put the formula in one function so it can be tuned in one place.

### 2. A recruit offer at town nodes

Town nodes already exist on the world map and currently open a shop. A town should also offer a
small number of candidates — three is the FFT-ish number — **generated deterministically from the
campaign seed plus the node id**, so the same town offers the same recruits until one is hired.
Do not re-roll on every visit; a player must be able to leave and come back to a considered choice.

The player picks gender, job (from currently unlocked jobs only), and **names the unit**. A default
name must be offered so a player can hire without typing.

### 3. Wire it to the campaign

- Hiring debits gil and appends to `campaign.roster`.
- **Ids must be unique.** `requireRoster` rejects duplicates loudly (v0.1 step 9) — that fix exists
  precisely because recruitment is what mints ids. Do not defeat it by reusing a counter that
  resets across sessions; derive ids so a save loaded, added to, and re-saved cannot collide.
- Respect a roster cap. Pick one, state it, and make the UI say why hiring is unavailable when full.
- Dismissing a unit already exists in the roster editor — check it still behaves with a roster that
  can now grow, especially dismissing a deployed unit.

### 4. Formation and deployment
A roster larger than the deploy limit is the whole point. Confirm the formation screen handles
more units than slots, and that the deploy limit is enforced rather than assumed.

## Determinism and persistence

- A campaign saved after hiring, reloaded, and continued must produce the same battles.
- Add a test: create a campaign, hire a unit, serialize, deserialize, and assert the roster is
  identical including the new unit's stats and equipment.
- The recruit offer must survive a save/load — a player who quits mid-decision should not return to
  three different candidates.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            597 currently, plus yours
    npm run verify            all four gates green

Plus frames under `shots/recruit/` showing the offer, the naming step, and a roster that has grown
past six — allow-listed **file by file** in `.gitignore`, never by directory.

Report the sweep numbers if you touch anything under `src/core/` (currently `1981` integration /
`3063` content, both `rejected=0` — and that figure is now a real count, not a tautology).

## Explicitly out of scope

- Permadeath. It is an open design decision and changes what recruitment is *for*, not how it
  works. Build hiring so that adding loss later does not require rewriting it.
- Story-joined named characters.
- New jobs or abilities. There are already more than a campaign this size can teach.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes.
- Do not write a test that mocks past the code path it claims to verify.
- Do not describe a rename as a behaviour change.
