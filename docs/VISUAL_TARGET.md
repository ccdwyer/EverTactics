# Visual Target — measured from the reference corpus

These notes come from actually looking at frames in `refs/Triangle` and `refs/FFT`, not from memory.
Builders and critics both work from this. Every claim here is observable in a specific reference file.

## The five things that actually separate us from them

Ranked by how fast a critic spots the difference. Fix in this order.

### 1. Texture density — no flat surfaces, anywhere
Reference: `refs/Triangle/press_041_gematsu_1920x1080.jpg`.
Every single surface carries detail: stone floor has mortar lines and colour variation per block,
the floor has inlaid patterned medallions, railings are modelled wood with grain, banners have
woven pattern and fold shading, the rock walls have strata.

There is **not one flat-coloured polygon in the frame.**

A terrain material that is "green with some noise" fails immediately. Grass needs clumping,
directional variation, and darker roots in the crevices. Stone needs per-block colour variation,
mortar, edge wear, and grime that accumulates in corners. This is the single biggest tell.

### 2. Dramatic, coloured, dynamic lighting
Reference: both files.
Triangle's throne room is lit by a warm orange key from the right and a cold teal fill from the
left — complementary split, high saturation, deep falloff. FFT's night battle is lit almost
entirely by *spell effects*: warm point lights that illuminate terrain and sprites together,
with everything outside their radius falling to deep blue-black.

Consequences for us:
- Ability VFX must emit **real point lights** that light the terrain and the sprites. A particle
  sprite that glows but does not illuminate its surroundings looks pasted on.
- Neutral white-ish daylight on green grass is the most boring possible choice. Every map needs a
  committed colour scheme with a warm/cool split.
- Light falloff must be aggressive. Reference frames have genuinely dark regions.

### 3. Depth of field is strong — but it must never blur a playable tile
Reference: `refs/Triangle/press_041...` — the top ~15% and bottom ~20% of the frame are visibly
soft; only a horizontal band through the middle is sharp. FFT's frame has the entire background
blurred out.

**Refined after round 1** (an earlier version of this section said only "push it harder", and a
critic correctly called that out): look at *what* is blurred in the references. It is scenery —
foreground props, background architecture, distant terrain. The tiles the player has to count,
and the units standing on them, stay sharp in both games.

So the rule is not "more blur". It is: the focus band must contain the whole playable board, and
the blur lives beyond it. Blurring pillars and gameplay-relevant tiles at the top and bottom of
the board is a defect, not atmosphere. Get the diorama read from the *scenery* falloff plus a
world that extends past the board — not by softening the game itself.

Vignette obeys the same logic: it frames, it does not darken the play space. If the vignette is
compounding an already-dark frame, it is too strong.

### 4. Sprites are lit by, and grounded in, the scene
In the FFT frame the White Mage is visibly underlit by the fire in front of her; the Squire on the
left is rim-lit warm on his right side and falls to blue on his left. Every unit casts a soft
directional shadow onto the terrain that matches the key light.

A sprite drawn at full unmodified brightness with a generic dark ellipse under it is an instant fail.
The sprite material must take scene lighting, including dynamic VFX point lights.

### 5. Grain, vignette, and bloom are all present and all restrained
Both references have visible film grain and a strong dark vignette. Bloom is wide and soft and
only on genuinely bright things (torches, spell light, emissive lattice) — never a global haze.

## Camera and framing

- Both games pull the camera **back**. In the Triangle frame a character is roughly 130px tall in
  a 1080p image — about 12% of frame height. In the FFT frame roughly 180px, ~17%.
  If our units fill a third of the screen the composition is wrong.
- Tilted-orthographic, roughly 30° pitch. Terrain reads as a floating island; there is no horizon
  and no skybox doing work — the background is near-black atmosphere or blurred scenery.
- Frames are **composed**: the action sits on a diagonal, negative space above, the brightest
  point near the centre of interest.

## Terrain geometry

- FFT tiles are **irregular slabs**, not cubes: visible thickness, slightly organic top edges,
  painted texture that flows across tile boundaries rather than repeating per-tile.
- Triangle builds real architecture — modelled stairs, railings, pillars, hanging banners.
  Props matter. An empty tile field, however well textured, reads as a test scene.
- Grid seams are **subtle glowing lines**, not opaque overlay quads.

## Colour grading

- Triangle: magenta/pink against teal, heavily graded, crushed blacks with a colour tint
  (blacks are blue, not neutral).
- FFT: warm amber against deep navy.
- Neither uses neutral greys. Crush blacks toward the map's cool tone and push highlights warm.

## The void problem — read this before touching materials

**STATUS: FIXED IN ROUND 2. Do not rebuild this.** Measured in round 1, roughly half the frame was
flat background colour. As of round 5 the connected-component void measures **0.113**, inside the
reference band of 0.087–0.180. `sky.ts`, `backdrop.ts` and `atmosphere.ts` carry a graded sky,
distance haze, a surround of silhouette architecture and a mote field, and they work — disabling
the environment at runtime reverts the board to the round-1 floating island, which is how that was
confirmed. The history below is kept because it explains WHY those modules exist; it is not a
live defect. Read `node tools/metrics.mjs <frame>` before acting on any claim in this file.

Neither reference game ever does this. In both, the map **bleeds off the frame edges** and is backed
by sky, haze, distant silhouettes or painted scenery. Triangle Strategy's environments continue past
the play area — background walls, crates, lanterns, drifting embers.

This is worth more than any material improvement. A perfectly textured object floating in a black
void still reads as a tech demo. Fixing it means: a graded sky and distance haze, a far silhouette
layer, letting the board extend past the frame, and an irregular map footprint so the silhouette
is not a rectangle from every camera yaw.

## Explicit fail conditions

A frame with any of these is not shippable:
- Any flat untextured surface
- Perfectly cubic tiles with hard 90° corners
- White or neutral-grey lighting
- Sprites at uniform full brightness, unaffected by scene light
- Sprites that appear to float, or whose shadow direction disagrees with the key light
- Aliased/shimmering pixel art (means the pixel-snapping is wrong)
- Weak or absent depth of field
- Opaque flat-coloured tile-highlight overlays
- An empty prop-less battlefield
- Visible z-fighting anywhere
- A map whose silhouette is a rectangle from every camera yaw
- More than ~25% of the frame being flat background colour
- Any UI panel sitting over the playable board and occluding units
- Depth of field or vignette obscuring tiles the player must count
- Sprites at full saturation over a graded, desaturated map — they must share one grade
- Turn-order portraits that do not match the units actually on the field


## Reference luminance — cite a FILE, never "the references"

Two agents once spent a whole round pulling exposure in opposite directions, each quoting "the
references": one said meanLuma 66–88, the other 38.4. Both were right about their own sample.

Measured across all 28 curated Triangle frames, `meanLuma` spans **36.5 to 142.6** — a 4× range —
because the corpus holds night interiors *and* daylight snowfields. There is no single reference
luminance. Match the band that fits the scene's mood:

| mood | meanLuma | lumaP95 | darkShareOfSubject | example |
|---|---|---|---|---|
| night / interior | 36 – 50 | 116 – 136 | 0.41 – 0.63 | `press_002`, `official_009`, `official_033` |
| overcast / dusk | 50 – 70 | 135 – 190 | 0.25 – 0.48 | `official_016`, `official_007`, `official_027` |
| daylight / snow | 84 – 143 | 152 – 242 | 0.01 – 0.24 | `official_001`, `official_020`, `official_026` |

`battle-open` is a torch-lit night courtyard and belongs in the first row. It currently measures
luma 45.8 / p95 155.9 / dark 0.42 at `post.exposure: 2.1`.

**This is why `meanLuma` is reported but never gated** — a gate would have to know the scene's mood,
and a frame is not wrong for being bright.

## Exposure has exactly one owner

`Game.applyPostProfile` used to compute `scenario.post.exposure * lightingPreset.exposure`. Two
owners on one dial cancel each other: in one round the scenario value went 2.65 → 3.4 → 3.9 while
the preset factor was cut 1.4 → 0.95, the product barely moved, and both parties concluded their
change "wasn't reaching the frame".

A scenario's `post.exposure` is now **final**; the preset's value applies only when a scenario
declines to state one. If you own lighting, own the *ratios* — key/fill, chroma, colour split,
bounce — all of which survive whatever absolute exposure lands on.

## How the blind test works

`tools/ab.mjs` normalises our frame and a reference frame to identical size and encoding and writes
them as `left.png` / `right.png`. The critic is told one is a shipped commercial tactical RPG and
one is an in-development prototype, and must say which is which and which looks better.
Which side is ours is never written to disk.

Note: our sprites *are* FFT sprites, so FFT pairs are confounded for identification — a critic may
recognise the characters regardless of render quality. **Triangle Strategy pairs are the clean test**
for terrain, lighting, post and composition. Use FFT pairs to judge sprite integration and UI only.

We are done when critics cannot reliably pick our frame out of Triangle Strategy pairs.
