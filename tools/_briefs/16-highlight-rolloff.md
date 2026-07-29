# Visual parity — highlight rolloff

Read `docs/VISUAL_TARGET.md` first. This is a measured divergence with a specific lever, not a
general "make it prettier" task.

## The finding

Measured with `node tools/metrics.mjs <image>` (the image is **positional** — `--in` is not a flag
and now exits 2; it used to be silently ignored, which produced a false reading):

| frame | meanLuma | lumaP95 | darkShare |
|---|---|---|---|
| ours (`shots/verify.png`) | 44.4 | **147.8** | 0.50 |
| `refs/curated/triangle/official_003_steam.jpg` (night) | 49.0 | **119.7** | 0.44 |
| `refs/curated/triangle/official_001_steam.jpg` (day) | 84.3 | 182.4 | 0.23 |

Overall exposure and dark share are already in the night band. **`lumaP95` is the outlier: ~28
above a comparably-lit reference.** At the same mean luminance our highlights blow considerably
hotter than the corpus.

The hypothesis — and it is a hypothesis, not an established cause — is that an over-hot specular
and bloom reads as *rendered* rather than *painted*. That is the kind of tell a blind judge picks
up without being able to name it, and `docs/STATUS.md` records that identification never reached
parity even after preference did.

## What to do

Bring `lumaP95` down toward the night band (116–136) **without** dragging the frame flat. The
levers, roughly in order of how surgical they are:

- bloom threshold and intensity
- specular strength / roughness floor on terrain and sprite materials
- highlight rolloff or a filmic shoulder in the tonemap
- light intensity (**last resort** — this lowers meanLuma too, which is already in band, so it
  trades a good number for a bad one)

**Do not simply lower exposure.** Dropping everything uniformly moves `lumaP95` and `meanLuma`
together, and meanLuma is currently correct. The goal is a *shoulder*: highlights compress while
midtones and shadows hold. If you find the two cannot be separated with the current pipeline, say
so and explain why — that is a real finding, not a failure.

## Measure honestly

- Report `meanLuma`, `lumaP95`, `darkShareOfSubject`, `lumaSpread`, `localContrast` and
  `meanSaturation` **before and after**, from `node tools/metrics.mjs shots/verify.png`.
- All four `npm run verify` gates must stay green. Note that `lumaSpread` will fall as `lumaP95`
  falls — check you have not pushed it out the bottom of its band while fixing the top.
- Compare against **at least three** reference frames of comparable mood, not one. The corpus holds
  night interiors and daylight snowfields; a single comparison proves nothing.
- Capture a before/after pair of the same scene and put both filenames in the report.

If the honest outcome is "moved from 147.8 to 141 and further would flatten the image", that is a
good result and I want it reported as that, not dressed up. A small real improvement beats a large
claimed one.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            566 currently
    npm run verify            all four gates green — non-negotiable here

## Project rules

- `src/core/` never imports three.js. Rendering changes live in `src/render/`.
- **Never put a backtick in a comment inside a shader file.** Shader source lives in template
  literals; a backtick in a comment closes the string and `tsc` reports a cascade of errors
  pointing at identifiers that were never code. This has happened six times, to six different
  authors. Use single quotes. `npx vitest run tests/shader-source.test.ts` catches it.
- Do not change `battle-open` or the diagnostic scenes' composition — they are the fixed baseline
  the whole metrics history is measured against. Changing what the scene *contains* invalidates
  `docs/metrics-history.jsonl` as a trend.
- Evidence is a measured number and a frame, not an assertion that it looks better.
