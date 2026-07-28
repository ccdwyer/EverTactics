# v0.1 step 9 — Correctness pass: roster identity, and an audit of the player-reported fixes

Two unrelated jobs, both about *trusting what is already there* rather than adding features.
Steps 1–8 are done; the loop runs end to end with audio and presentation. Before v0.1 closes, one
real data-loss bug must go, and one batch of shipped-but-never-reviewed work must be audited.

---

## Part A — duplicate roster ids cause silent unit loss

`docs/KNOWN-ISSUES.md` item 1, deferred deliberately during step 1 and now due.

`requireRoster` (`src/core/campaign.ts:550`) accepts a roster containing two units with the same
`id`. `campaignToBattle` (`src/state/scenarios.ts`) then inserts them into a `Map` keyed by id, so
**two roster members deploy as one**, and write-back can copy the survivor's earned JP/exp across
both slots — destroying one character's progression permanently.

Nothing mints duplicate ids today, which is why it was accepted. That stops being true the moment
recruitment lands, so fix it now while it is cheap.

**Required:**
- `requireRoster` rejects a roster with duplicate ids, loudly, with an error naming the offending
  id. A corrupt save must fail cleanly — do not silently de-duplicate, because dropping a character
  quietly is the outcome we are trying to prevent.
- `campaignToBattle` must never collapse two roster entries into one. If a duplicate somehow
  reaches it, throw rather than proceed.
- Tests: a hand-written save blob with duplicate ids is rejected by `deserialize`; and a direct
  `campaignToBattle` call with a duplicated roster throws rather than deploying N-1 units.

While you are in there, fix **`docs/KNOWN-ISSUES.md` item 2** if it is cheap: `requireEquipment`
reorders equipment keys on round-trip. Current-version saves are not supposed to be rewritten at
all. If it is not cheap, leave it and say so.

---

## Part B — audit the four player-reported fixes

These were built and committed, the tests passed, but the review died on an infrastructure error, so
**no one has ever checked that they actually do what the player asked for.** The original report,
verbatim:

> - Units seem to float and bob up and down like they have levitate on them.
> - Buff/Debuff icons blur.
> - It is challenging to tell what tiles/units are being targetted. The tile selection should
>   probably be a bit bigger, and sprites should be highlighted if a spell will potentially affect
>   them (red for enemies, blue for allies)
> - In FFT, spells can either target a tile or a unit, we should have support for that.

For **each** of the four: find the code that claims to address it, and determine whether it does.
Report per item as `FIXED`, `PARTIAL`, or `NOT FIXED`, with the file and line as evidence. Fix
anything that is `PARTIAL` or `NOT FIXED`.

Specific things to actually verify, not assume:

1. **Bob.** `src/render/sprites.ts` still applies a procedural sine bob (around line 3074, and see
   the note near 3377). Confirm whether idle units still visibly float. The comment there argues
   the bob is a deliberate trade — if that reasoning is sound, the correct outcome may be to reduce
   its amplitude rather than remove it. Say which you chose and why.
2. **Icon blur.** Status icons must land on exact texel boundaries. A non-integer offset or a
   non-`NearestFilter` sampler will blur pixel art. Check the actual filter and the actual rounding.
3. **Targeting readability.** Verify the tile cursor is genuinely larger than before, and that
   affected units are tinted **red for enemies, blue for allies** — the player specified the
   colours. Capture evidence with `tools/play.mjs` and look at the frames.
4. **Tile-vs-unit targeting.** FFT distinguishes abilities that target a *tile* (a Fire lands on a
   square; units standing there are caught) from those that target a *unit*. Confirm the ability
   model actually carries this distinction and that the targeting UI honours it. This is the one
   most likely to be superficially "done" — a flag that exists but changes nothing.

Evidence for part B is visual. Use:

    node tools/play.mjs --scene gariland-bridge --steps "key:Enter,click:0.42x0.55,burst:12x120"

and inspect the frames. Do not report a visual item as fixed on the strength of a passing unit test.

---

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            533 currently, plus yours
    npm run verify            gates must stay green

Report the exact commands and numbers, plus the four-item `FIXED`/`PARTIAL`/`NOT FIXED` table with
file:line evidence for each.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes; the screenshot and blind-judge tooling
  depends on them.
- A green test over a broken contract is worse than a red one. If an existing test asserts the
  buggy behaviour, delete it and write the one the brief describes.
