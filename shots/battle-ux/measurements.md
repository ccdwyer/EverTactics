# Battle UX measurements

Baseline is the static build from `HEAD` (`3b41903`). After is the static build
from the working tree. Both were served with `vite preview --host localhost`
and captured at 1600 x 900 through the same Chromium CDP session.

## 1. Camera follows the action

The fixed capture starts with Maelor off-screen, plays an ordinary attack, freezes
the stage 320 ms after the event begins, then resumes and waits for restoration.

| Measurement | Before | After |
| --- | ---: | ---: |
| Target visible at impact | false | true |
| Target screen x at impact | 2672.658 | 679.857 |
| Target screen y at impact | 112.798 | 542.085 |
| Camera pixel scale at impact | 5.0 | 5.3 |
| Camera focus at impact | `[4, 1, 12]` | `[10, 3.25, 1]` |
| Impact feedback visible | none | flash and `37` damage |
| Restored scale | 5.0 | 5.0 |
| Restored focus | `[4, 1, 12]` | `[4, 1, 12]` |

The after capture restores the exact pre-action target projection as well:
`(2672.658, 112.798)`, still off-screen.

The focus is a Three.js world vector aimed halfway up the target figure, not a
grid coordinate. Multi-target actions additionally derive a maximum pixel scale
from the projected target-tile and figure bounds, with 120 px viewport padding.

Frames:

- `01-camera-before.png`
- `01-camera-after.png`

## 2. Movement range readability

Both frames use `battle-open`, Aldric active, 12 units, 15 reachable tiles,
`stageElapsed=0`, and `terrainElapsed=0`. The overlay and a no-highlight control
were captured from the same stopped render state. Metrics sample 15 projected
reachable-tile centres using 15 px diameter patches; 8 centres are unobscured in
both builds.

| Median visible-tile measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| Blue-dominance gain, `(B-R)` overlay minus control | 39.14 | 49.03 | +25.3% |
| Absolute RGB displacement from control | 62.27 | 52.85 | -15.1% |
| Absolute luma displacement from control | 61.72 | 49.06 | -20.5% |

The result is more distinctly blue while displacing terrain luminance less. The
after frame also gives each reachable cell a dark seam, so adjacent same-height
tiles no longer merge into the baseline's near-white strip.

Frames:

- `02-move-range-before.png`
- `02-move-range-after.png`

## 3. Pass through allies, not enemies

The reducer capture sends the same raw move command in both builds:

`(8,4,4) -> enemy at (9,4,4) -> (10,4,4)`

| Measurement | Before | After |
| --- | ---: | ---: |
| Raw enemy-crossing command accepted | true | false |
| Aldric position afterward | `(10,4,4)` | `(8,4,4)` |

The core tests separately assert that the corresponding route through an allied
intermediate tile remains legal and that an enemy or neutral intermediate tile
is rejected.

Deterministic sweep consequence:

| Sweep | Before | After |
| --- | ---: | ---: |
| Content commands / rejected | 4504 / 0 | 4504 / 0 |
| Integration commands / rejected | 2552 / 0 | 2552 / 0 |

Frames:

- `03-enemy-path-before.png`
- `03-enemy-path-after.png`
