# v0.1 step 6 — Onboarding: title, new game, load, and a teaching first battle

Read `docs/ROADMAP-v0.1.md` and `docs/KNOWN-ISSUES.md`.

Steps 1–5 are done and reviewed: persistence, party editors, campaign-routed battles, the world map
loop, and the economy. **The game still has no front door.** It boots straight into state. A player
cannot start a game, cannot choose to continue one, and is never taught how anything works.

## 1. Title screen — `src/ui/screens/TitleScreen.ts` (new)

Shown on boot. Follows the existing screen pattern: takes a view model, emits `UIIntent`, never
touches core state.

- **New Game** — creates a fresh campaign and enters the world map. If a save exists, confirm first;
  overwriting someone's campaign without asking is unacceptable.
- **Continue** — loads the save and enters the world map. Disabled, visibly, when `hasSave()` is false.
- Keyboard and mouse navigable, consistent with the other screens.

The art direction is already established — the frame is a warm amber HD-2D night scene that blind
judges prefer to shipped commercial SRPG frames. Match it. Use the existing UI chrome (ornate panel
frames, the serif display face, aged gold on deep blue) rather than inventing a new look.

## 2. A first battle that teaches

The first node of chapter 1 should be winnable by someone who has never played a tactics game, and
should teach in this order: **move → attack → facing matters → turn order.**

Do this with encounter design, not a wall of text: few enemies, low level, positioned so a
back-attack is the obvious play. If you add hints, they must be dismissible and must never block
input.

Do NOT build a scripted tutorial system with forced steps. It is out of scope for v0.1 and it is the
kind of subsystem that becomes load-bearing before it is good.

## 3. Boot logic — `src/main.ts`

    no save    -> title -> New Game -> world map
    save       -> title -> Continue -> world map
    ?scene=... -> straight to that battle   (unchanged; the harnesses depend on it)
    ?shot=...  -> straight to that frame    (unchanged; the metrics gates depend on it)

The diagnostic scenarios (`terrain-only`, `sprites-only`, `ui-only`) and `battle-open` must behave
exactly as they do now. `npm run verify` and all four `tools/metrics.mjs` gates must stay green.

## Tests — write from this wording first, watch them fail, then make them pass

`tests/onboarding.test.ts`:
1. With no save, Continue is unavailable; New Game creates a campaign at chapter 1 with the starting
   roster and seeded inventory.
2. With a save, Continue loads exactly that campaign — same roster, gil, progress.
3. New Game over an existing save requires explicit confirmation and does not clobber it otherwise.
4. `?scene=` and `?shot=` still bypass the title entirely.
5. The first battle node is winnable: run it AI-vs-AI across several seeds and assert the player
   side can win at least once, and that it never hits the turn cap.

**Do not write a test that asserts current behaviour instead of the behaviour above.** Five earlier
tasks failed review for exactly that, including one where the driver swallowed the error that was
hanging the game.

## Rules

- `src/core/` never imports three.js; randomness only via the seeded `Rng`.
- `BattleState` is mutated only by `applyCommand`.
- Campaign editing never touches a live `BattleState`.
- Never a backtick in a shader-file comment.
- 509 tests currently pass; do not regress them.

## Success criteria

    npx tsc --noEmit     clean
    npx vitest run       509 existing + the five above
    npm run verify       green, all four gates

Then prove it in a browser against a static build:

    npx vite build && npx vite preview --port 4173 --strictPort &
    node tools/play.mjs --steps "burst:3x400,key:Enter,burst:3x400" --port 4173 --out shots/title

Read the PNGs — confirm the title renders and New Game reaches the world map. Report the commands
you ran and what they printed.
