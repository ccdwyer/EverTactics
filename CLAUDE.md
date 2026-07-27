# EverTactics

A tactical RPG (Final Fantasy Tactics / Triangle Strategy lineage) in Three.js.

## Read this first, every session

**`docs/STATUS.md`** is the handoff document. It carries current state, the blind-test scoreboard,
open items, how to run the next polish round, and a list of hard-won failure modes that will
otherwise be rediscovered the expensive way.

Then establish ground truth before changing anything:

```bash
npm run verify          # typecheck + tests + build + render + measure (~2 min)
npm run verify:quick    # typecheck + tests only (~30 s)
```

## The other docs

| file | what it holds |
|---|---|
| `docs/STATUS.md` | **current state and how to resume** — start here |
| `docs/ARCHITECTURE.md` | module rules, file ownership, how to verify renders |
| `docs/VISUAL_TARGET.md` | the visual bar, measured from the reference corpus, with fail conditions |
| `docs/ASSETS.md` | sprite/palette formats, measured — including which sheets are broken |
| `docs/JOBS.md` | the 34-job roster, stats, sprite mapping, design notes |
| `docs/metrics-history.jsonl` | every `npm run verify` run, so progress is a trend not a memory |

## Non-negotiables

1. `src/core/` never imports three.js. It is pure, deterministic, testable game logic.
2. All randomness goes through the seeded `Rng` in `src/core/types.ts`. Never `Math.random()` in
   core. A battle must replay identically from the same seed.
3. Commands in, events out. `BattleState` is mutated only by `applyCommand`, which returns
   `BattleEvent[]`. The renderer animates events; the UI issues commands.
4. **Verify by measuring, not by reading reports.** The dominant failure mode in this project has
   been tools and agents reporting success while silently doing nothing — see the list in
   `docs/STATUS.md`. A screenshot harness that returns `ok: true` has been wrong more than once.
5. Render against a static build (`vite build` + `vite preview`), not the dev server. HMR reloads
   the page on any file save and returns it to the boot splash mid-capture.

## Running parallel agents

File ownership is the only thing preventing lost work. Give every agent an explicit owned-file
list and tell it to *report*, not edit, anything outside it. Transient `tsc` errors during a round
are normal — agents mid-write — so re-check before treating one as a regression.

## The one mistake that keeps recurring

**Never put a backtick in a comment inside a shader file.** Shader source lives in template
literals; a backtick in a comment closes the string, and `tsc` then reports a cascade of errors
pointing at identifiers that were never code. This has happened four separate times in
`src/render/**`, to four different authors. `tests/shader-source.test.ts` now catches it and names
the line. Use single quotes in shader-file comments.

## Delegating work to other models

Both CLIs are authenticated on this machine and verified working headlessly:

```bash
grok -p "<prompt>" --permission-mode dontAsk   # Grok 4.5 (xAI)
codex exec "<prompt>"                          # model from ~/.codex/config.toml (gpt-5.6-sol)
```

`npm run delegate` runs the loop: **Grok 4.5 builds → repo verification runs → GPT-5.6 Sol reviews
the real diff → Sol's objections become Grok's next brief**, until Sol returns PASS with
verification green. Claude writes the brief and reads the verdict; the implementation cost lands on
other providers' quota.

```bash
node tools/delegate.mjs --task "Fix X. Success is: <command> prints <number>." --rounds 3
node tools/delegate.mjs --task-file brief.md --rounds 2 --verify "npm run verify:quick"
```

Logs land in `tools/_delegate/roundN-{grok,verify,sol}.txt`.

**It refuses to run on a dirty tree**, and that guard is load-bearing: the first live test diffed
against HEAD while another agent was editing `src/render/`, so Sol reviewed a third party's changes
as though they were Grok's. Commit or stash first.

**Write the success criterion as a command and an expected number**, not a description. Sol grades
against evidence and will fail a plausible-looking change that never ran — which is the correct
behaviour for this codebase.
