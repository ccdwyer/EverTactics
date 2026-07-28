# v0.1 step 10 — End-to-end acceptance pass

Every roadmap step has shipped: persistence, two-way Formation/Roster, battle-launch, world map,
economy, onboarding, six maps and ten encounters, battle audio and presentation, and the four
player-reported fixes. 540 tests, typecheck clean, all four metrics gates green.

**Each of those was verified in isolation. The whole loop has never been walked end to end.** That
is the classic integration gap: ten green subsystems and a game that cannot actually be played from
the title screen to a second battle. This task is to find out which it is, honestly.

## Part A — walk the loop as a player, with evidence

Drive the real app through the complete v0.1 arc using `tools/play.mjs`:

    title → new game → world map → pick the first battle → formation/deploy →
    fight to victory → result → rewards → shop → back to world map →
    **refresh the browser** → continue → second battle

Every transition must be driven through the actual input path. Do not call internal functions to
skip a screen; if a screen cannot be reached by input, that is the finding.

Capture frames at each stage into `shots/v01-acceptance/`. For each transition report:
`WORKS` / `BROKEN` / `UNREACHABLE`, with the frame filename and, where it failed, the console error.

**The refresh is the most important step in this brief.** It is the one thing that proves
persistence is real: gil, roster JP/levels, learned abilities, inventory and completed-node
progress must all survive. Diff what the player had before the refresh against after, and report
any field that did not survive.

## Part B — the honest v0.1 verdict

Answer these plainly. A "no" is a useful result; a false "yes" is worse than useless.

1. Can a new player start from the title screen and complete two battles without touching devtools?
2. Does progression carry between battles — JP, levels, learned abilities, gil, items?
3. Does anything survive a refresh mid-campaign?
4. Is there any point where the game **soft-locks** — a screen with no way forward? Check
   especially: a battle lost rather than won, an empty shop, a formation with fewer units than the
   deploy minimum, and a completed final node with no next node.
5. Does the AI ever propose a command the reducer rejects during *human* play? The engine sweep
   covers AI-vs-AI; this is the path that produced the reported lockup, where a rejected command
   was re-proposed forever.

## Part C — fix what blocks the loop, and only that

If Part A finds a break, fix it. **Scope discipline matters here:** fix soft-locks, crashes,
unreachable screens and lost progression. Do not take the opportunity to redesign a screen, retune
combat, or add features. Anything you find that is real but not loop-blocking goes in
`docs/KNOWN-ISSUES.md` under a new "v0.1 acceptance" heading, with file:line.

If Part A finds nothing broken, say so and change nothing. **An empty diff is a completely
acceptable outcome for this task** — do not manufacture work to look productive. In that case your
report is the deliverable: the frames plus the five answers.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            540 currently
    npm run verify            gates must stay green

Plus: the stage-by-stage table from Part A, the five answers from Part B, and the frames on disk.

Add a regression test for any loop-blocking bug you fix — the point is that it cannot come back
silently.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`; randomness only
  via the seeded `Rng`.
- Commands in, events out: `BattleState` is mutated only by `applyCommand`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes; the screenshot and blind-judge tooling
  depends on them.
- Render against a static build (`vite build` + `vite preview`), never the dev server — HMR reloads
  the page on any file save and returns it to the boot splash mid-capture.
- Do not report a visual or navigational item as working on the strength of a passing unit test.
  Look at the frame.
