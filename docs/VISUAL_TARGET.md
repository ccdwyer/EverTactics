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

### 3. Depth of field is strong, not subtle
Reference: `refs/Triangle/press_041...` — the top ~15% and bottom ~20% of the frame are visibly
soft; only a horizontal band through the middle is sharp. FFT's frame has the entire background
blurred out.

This is *the* diorama tell and we are likely to under-do it out of timidity. Push it until it
reads as a miniature, then back off slightly.

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

## How the blind test works

`tools/ab.mjs` normalises our frame and a reference frame to identical size and encoding and writes
them as `left.png` / `right.png`. The critic is told one is a shipped commercial tactical RPG and
one is an in-development prototype, and must say which is which and which looks better.
Which side is ours is never written to disk.

Note: our sprites *are* FFT sprites, so FFT pairs are confounded for identification — a critic may
recognise the characters regardless of render quality. **Triangle Strategy pairs are the clean test**
for terrain, lighting, post and composition. Use FFT pairs to judge sprite integration and UI only.

We are done when critics cannot reliably pick our frame out of Triangle Strategy pairs.
