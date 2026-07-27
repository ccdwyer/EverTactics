# Resume point — read this first

## In flight when the last session ended

**Grok's work on four player-reported defects is UNCOMMITTED in the working tree**, awaiting a
GPT-5.6 Sol review that was still running.

    src/render/animation.ts, sprites.ts, terrain.ts
    src/state/game.ts, targeting.ts
    src/core/abilities/sets.ts, battle.ts
    332 insertions, 60 deletions across 7 files

Independently verified before handoff: **typecheck clean, 441 tests passing** (up from 429),
including a new `tests/targeting.test.ts` with 12 tests.

The four defects, reported by the user from actually playing:
1. Units float and bob like they have Levitate
2. Buff/debuff icons blur
3. Tile cursor too small; affected units not highlighted (red enemies / blue allies)
4. FFT tile-targeted vs unit-targeted abilities not honoured by the targeting UI or resolution

Grok's diagnosis on (1) looks right and matches `docs/ASSETS.md`: a sheet-wide `groundOffset`
cannot work when each pose has a different foot position, so it added per-pose `frameFootPlant`
from `footBottomY`, and cut the bob to `sin * 0.45` (≤1 sprite pixel).

### First three commands

```bash
cat tools/_delegate/round1-sol.txt     # Sol's verdict, if it finished
npm run verify                         # ground truth, ~2 min
git diff --stat                        # what is pending
```

If Sol returned PASS and verify is green: commit it.
If FAIL: `npm run delegate --task-file tools/_briefs/targeting-and-polish.md --rounds 2` —
the harness feeds Sol's objections back to Grok automatically. **Commit or stash first**; the
harness refuses a dirty tree, and that guard is load-bearing.

## The open visual work

Discrimination test, both control arms stable across two runs:

    control-same   two Triangle frames        25%
    OURS                                      50%   <- was 83%
    control-diff   Triangle vs Unicorn Ov.    75%

Not indistinguishable. The gap halved, it did not close. Four named defects behind the remainder:
**lighting model, cast-shadow behaviour, texel density, sprite-to-geometry authorship.**

Texel density may be structural rather than merely unfixed: we composite 1997 sprites against a
modern renderer, while the reference games drew their sprites *for* theirs. Closing it likely means
quantising the world down to the sprites — a large, opinionated change, not a tuning pass. Consider
whether that is worth it before spending a round on it.

`tools/workflows/same-game.js` is widened to 24 pairs (test arm 12) so the next run can resolve a
delta, not just a position between controls. Run it against a fresh frame after the pending work lands.

## What worked, and what to keep doing

- **One director beats parallel fixers now.** Per-axis fan-out was right while subsystems were
  missing (rounds 1-7). Once they all exist, the remaining defect is coherence, and coherence cannot
  be parallelised — six agents each optimising their own axis is what produced the incoherence.
- **Delegate implementation** with `npm run delegate`: Grok 4.5 builds, Sol reviews the real diff.
  Write success criteria as *a command and an expected number*, never a description.
- **Read the failure list in `docs/STATUS.md` before trusting any tool here.** Nine times a
  "finding about the code" was really a defect in the instrument measuring it.
