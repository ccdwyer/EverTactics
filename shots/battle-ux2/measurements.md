# Battle UX part 2 measurements

All captures came from static Vite builds served with `vite preview --host localhost`.

## Item 2 — movement range

The paired probe stopped the same `battle-open` frame, sampled 11 visible and
unoccupied reachable tiles with a 10 px radius, then cleared only the move
highlight and rendered the control.

| Build | Highlight saturation | Control saturation | Delta | Highlight luminance | Control luminance | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before | 0.343 | 0.442 | -0.099 | 112.663 | 80.458 | +32.205 |
| After | 0.445 | 0.443 | +0.002 | 93.650 | 79.751 | +13.899 |

The old overlay raised luminance by washing the tiles toward pale stone and
lost 0.099 saturation after the post stack. The final dark-cobalt field keeps a
13.899-point luminance separation without desaturating relative to the same
terrain. Bright cyan is reserved for the boundary, and the overlay vertices use
the terrain relief surface rather than a flat tile plane.

Full-frame metric gates on the highlighted capture:

| Gate | Before | After | Result |
| --- | ---: | ---: | --- |
| `backgroundFraction` | 0.104 | 0.108 | pass |
| `lumaSpread` | 144.268 | 139.368 | pass |
| `localContrast` | 25.794 | 25.380 | pass |
| `meanSaturation` | 0.538 | 0.540 | pass |

The renderer already has distinct sequential move and act colors. A simultaneous
two-state move-plus-act map was not added: deriving action reach from every
possible destination needs a rules/UI decision and is not a cheap color change.

## Item 4 — hostile palettes

The live renderer probe measured all 12 units: 12 of 12 rendered ACT palette
rows matched the row selected for their team. On shared sheets, Nessa and Quill
now resolve to Thief rows 1 and 2, and Torvald and Bram resolve to Monk rows 4
and 2. Legacy scenario palette numbers no longer overwrite the sheet-specific
team choice; deliberate non-default overrides still work.

## Item 5 — inspect any unit

The default inspected unit was hostile. Its measured panel contained 5
equipment rows, 5 ability groups, and 6 derived-stat cells. At 1920×1080 the
panel measured 330×422.078 px and ended at y=454.078, inside the safe area.

## Item 6 — camera control

Three `L` inputs moved the focus 3.000 tiles and shifted the previous subject
288.000 px left without changing yaw. During an attack camera push, the first
`L` input canceled the cinematic and moved focus 1.000 tile. The visible
command-state hint contains `IJKL`, `Q/E`, and zoom.

Player camera input owns the camera immediately: a pan, rotate, zoom, or reset
during a cast skips the authored camera move, then that same key controls the
gameplay camera. The effect and later battle events continue.

## Item 7 — ordinary attack motion

The existing 420 ms attack lunge was real but began before the ordinary action
camera landed. Before, motion started 245.700 ms before camera landing. After,
motion started 0.000 ms from camera landing and reached 15.434 px of measured
post-landing pose displacement. The actor and target are framed together.
Attack motion remains interruptible and is not awaited; VFX and reducer
feedback remain the event-sequencing boundary.
