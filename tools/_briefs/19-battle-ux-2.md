# Battle UX, part 2 — move range done properly, and items 4–7

Read `tools/_briefs/18-battle-ux.md` first, and the review of it. Items 1 and 3 landed. Item 2 was
graded "real, modest" and I agree with the modest more than the real — looking at
`shots/battle-ux/02-move-range-after.png`, the range tiles are *visible* but they read as
slightly-paler stone, not as an unmistakable overlay.

## Item 2, again — with a target you can measure

The reference behaviour, from Chris watching FFT: movement range is readable **at a glance**, with
no hunting. FFT uses a strongly saturated translucent blue that never reads as terrain.

**The bar:** someone who has never played this game, shown a single still frame, can immediately say
which tiles the active unit can reach.

Make it measurable so "better" is not a matter of taste:

- Capture the same scene with and without a move range active.
- Report the **mean saturation and mean luminance of highlighted tiles vs the same tiles
  unhighlighted**, using `tools/metrics.mjs` or a small purpose-built probe. A highlight that
  changes luminance by a couple of points is why the current one disappears.
- State the numbers before and after in the report.

Constraints that make this harder than "turn up the alpha":
- It must not wash out the pixel-art sprites standing on those tiles.
- It must survive the tilt-shift depth of field — tiles at the edge of the board are blurred, and a
  low-contrast overlay vanishes entirely there.
- **The four metrics gates must stay green.** A saturated overlay across a third of the frame will
  move `meanSaturation`; check it rather than discovering it in review.
- Height differences within range should stay legible — FFT's overlay follows the terrain silhouette
  rather than flattening it.

Also handle the **two-state** case if it is cheap: FFT distinguishes tiles you can *move to* from
tiles you can *act on* with different colours. If that is a large change, say so and leave it.

## Items 4–7, in priority order

### 4. Enemies read as enemies (highest value of the four)
Different armour colour for the hostile team, per Chris. There is a `.act` palette-swap path already
(`docs/ASSETS.md`) — prefer a genuine palette swap over a tint multiply; a flat tint over pixel art
reads as a rendering bug rather than a design choice.

The bar is the same as item 2: separable in a still frame by someone who has never played. Today
team is communicated by a small marker and the turn rail's border colour, which is not enough when
twelve units are on screen.

### 5. Inspect any unit — equipment and abilities
Click or hover any unit, ally **or enemy**, and see equipment, abilities and stats. The unit panel
already shows HP/MP/Brave/Faith; what is missing is equipment, the ability list, and whether it
works on enemies at all. Knowing what an enemy is carrying is a tactical decision in FFT.

### 6. Player camera control
Pan, and rotate if it is cheap. It must not fight the ability camera from item 1 — decide what
happens when the player pans mid-cast and state the choice. Show the binding in the existing
controls hint.

### 7. Ordinary attacks need motion
Step 12 gave eight signature abilities real effects. Check what a **plain physical attack** looks
like — item 1 now pushes the camera onto it, and a camera move onto a static sprite is worse than
no camera at all.

## Scope

Item 2 first, and properly. Then 4 and 5. Then 6 and 7 if there is room. **Say which items you did
and which you did not** — a thin pass over all five is worse than two done well, and the last round
proved the reviewer will fail an unevidenced claim.

## Success criteria

    npx tsc --noEmit          clean
    npx vitest run            579 currently, plus yours
    npm run verify            all four gates green

Frames under `shots/battle-ux2/`, before and after for every item touched, allow-listed **file by
file** in `.gitignore` — never by directory.

## Project rules

- `src/core/` never imports three.js, never calls `Math.random()` or `Date.now()`.
- Commands in, events out; determinism is load-bearing. Report the integration and content sweep
  numbers (currently `2552` and `4504`, both `rejected=0`) if you touch anything in `src/core/`.
- Never put a backtick in a comment inside a shader file — `npx vitest run tests/shader-source.test.ts`.
- Do not change `battle-open` or the diagnostic scenes' composition.
- `tools/play.mjs` needs `--host localhost`; the `surface` probe reports the underlying screen while
  a modal is open — read the frame, not the field.
- Do not describe a rename as a behaviour change. Last round called an existing capability a new
  one; the reviewer caught it and it cost a round.
