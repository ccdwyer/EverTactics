# EverTactics — Asset Format Reference

Everything in this document was **measured** from the files in `public/assets/` by
`tools/build-assets.mjs`. Where it contradicts the vendor README shipped with the
rip (`public/assets/palettes/.README.txt`), the measurement wins and the
contradiction is called out.

Run the pipeline with:

```
npm run assets                        # writes public/assets/manifest.json
node tools/build-assets.mjs --report  # + human-readable summary
node tools/build-assets.mjs --dry     # analyse only, write nothing
node tools/build-assets.mjs --dump knight_male   # debug PNG in tools/out/
```

The pipeline has **no dependencies**: PNG decoding is a self-contained
inflate + unfilter implementation on top of `node:zlib`.

---

## 1. Sprite sheets — `public/assets/sprites/*.png`

457 files, named `NNNN_Name_Gender_hd.png`. All are **8-bit indexed
(colour type 3) PNGs, 512 pixels wide, with a 16-colour `PLTE` chunk and no
`tRNS` chunk**. Palette index 0 is the transparent colour.

### 1.1 A "sheet" is two files stacked vertically

This is the most important fact and it is not obvious from the filenames.

Consecutive numbered files with the same name (`1000_Knight_Male_hd.png`,
`1001_Knight_Male_hd.png`) are **not two variants**. They are the top and bottom
halves of one image:

| | height | contents |
|---|---|---|
| `1000_Knight_Male_hd.png` | 512 | rows 0-511 of the sheet |
| `1001_Knight_Male_hd.png` | 464 | rows 512-975 of the same sheet |

Evidence:

* Their `PLTE` chunks are **byte-identical** (checked for all 139 pairs; the
  pipeline warns if any pair ever diverges).
* Stacked they form **512 × 976**, which is exactly 2× the original FFT
  `SPR` canvas of **256 × 488**. The HD rip is a clean 2× upscale.
* Content is continuous across the seam: a figure that starts at y = 460 in the
  first file finishes in the second.
* Rows 496-511 of the primary and rows 0-1 of the continuation are always
  empty: the original 488-row canvas doubled to 976 leaves the last 16 rows of
  the 512-tall primary unused.

`manifest.json` records this as `files: [primary, continuation]`, `height: 976`
and `splitY: 512`. `SpriteAtlas` stitches them into one texture at load time.

### 1.2 File size classes

| stitched size | files | count | what it is |
|---|---|---|---|
| 512 × 976 | 2 | 139 | full unit sheets (all generic jobs, story characters, monsters) |
| 512 × 512 | 1 | 17 | the 15 `*_2` monster variants plus `904_Alma_Dead` and `909_Ajora` |
| 512 × 442 | 1 | 141 | `Event_001`-`Event_141` cutscene units (pose frames only, no parts) |
| 512 × 18 | 1 | 21 | **broken rips** — `1110`-`1130` (Dark Knight, Onion Knight, Balthier, Luso, Argath DK, Aliste, Bremondt, Master Sword). 18-pixel grey noise strips with no sprite content. |

318 logical sheets total; 22 are flagged `broken: true` (the 21 stubs above plus
`event_017`, which decodes to zero opaque pixels). `SpriteAtlas.loadSheet`
rejects broken keys rather than silently rendering noise. **The WotL-exclusive
jobs have no usable art in this rip.**

### 1.3 The 64 × 64 cell grid — and what it really means

The documented grid is real: **64 × 64 cells, 8 columns**, i.e. 2× the original
32 × 32 FFT cell. A 512 × 976 sheet is 8 × 15.25 cells (the last row is only 16
pixels tall). `manifest.json` reports per-cell occupancy and tight bounding boxes
on that grid, and `SpriteAtlas.getFrameUV(key, cell)` addresses it row-major.

**But the grid does not describe the artwork.** Two measured facts:

1. **Columns are meaningful, rows are not.** Complete unit frames sit one per
   64-pixel column, but they are **70-72 pixels tall** — they overflow their row
   and straddle the horizontal cell lines. `getFrameUV(key, cell)` therefore
   clips a standing knight's boots. Use `getPoseUV`/`getPose` instead (§1.4).
2. **Most cells are body parts, not poses.** The original engine assembles each
   animation frame from parts (heads, arms, hands, boot caps, cape segments)
   using the `*_shp.bin` / `*_seq.bin` data in `assets-src/unit/`. Those parts
   are packed at arbitrary offsets, so a per-cell bounding box below the pose
   region is a *slice through several unrelated parts*.

### 1.4 Whole-body poses vs body parts — measured layout

Content on a sheet forms **bands**: vertical runs of scanlines that contain at
least one opaque pixel, separated by fully transparent gaps. This is the
structural primitive the pipeline uses, because it matches the artwork instead of
the grid. `manifest.json` records every band as `contentBands: [[y, height], …]`.

Measured layout for a human unit sheet (`knight_male`, verified visually):

| band | y | height | contents |
|---|---|---|---|
| 0 | 8 | 72 | **7 complete standing frames**, one per column 0-6. Column 7 holds a loose head. |
| 1 | 88 | 70 | **7 complete frames**, columns 0-6. Column 7 is a head + arm. |
| 2 | 164 | 80 | column 0 = 1 complete frame (kneel); columns 1-7 = parts |
| 3 | 248 | 56 | column 0 = 1 complete frame (falling/KO); rest = parts |
| 4 | 306 | 190 | parts only — heads, torsos, cape segments |
| 5+ | 514 → 975 | | parts only |

So for a human unit: **14 reliable whole-body frames in bands 0-1**, plus 1-3
extras in bands 2-3.

Other sheet classes measure differently:

* **Monsters that are drawn whole** (`behemoth`, `dragon`, `bomb`, `ghost`,
  `malboro`, `minotaur`, `goblin`, `skeleton`, …) carry complete frames across
  the *entire* sheet — 9 pose bands, 4-5 frames per band, ~36 usable frames.
  Their frames are **wider than one column** (up to ~90 px) and straddle column
  boundaries, so pose detection runs across the full band width, not per column.
* **`chocobo` has zero whole-body frames.** Its first content band is 398 pixels
  tall and consists entirely of heads, wings, legs and feathers. Rendering a
  chocobo requires SHP assembly. The pipeline correctly reports `poses: []`
  for it.
* **Event sheets** (`event_001`-`event_141`, 512 × 442) are pose-only: two bands
  of ~5-6 complete frames near the top and, for most of them, nothing at all
  below — `event_001` has exactly two content bands in a 442-tall image.

Only 7 non-broken sheets yield no poses at all: `chocobo`,
`altima_second_form`, and the sparse event sheets 020, 041, 062, 105 and 141.
Pose-band count distribution across all 318 sheets: 0 bands ×29 (22 broken +
those 7), 1 ×5, 2 ×24, 3 ×57, 4 ×93, 5 ×84, 6 ×2, 7 ×2, 9 ×22. 6128 whole-body
frames were detected in total.

#### How poses are detected

Inside each candidate band, the pipeline finds 8-connected components of opaque
pixels and accepts a component as a whole-body frame when it:

* spans ≥ 60 % of the band height, and is 44-132 px tall and 20-170 px wide,
* has ≥ 380 opaque pixels and fills ≥ 30 % of its own bounding box,
* uses ≥ 6 distinct palette indices with no single index over 62 % of it
  (a shaded character, not a flat cape scrap).

Scanning stops at the first band that yields no figure — pose bands only ever
occur as the *leading* bands of a sheet, and scanning further produced false
positives (a dense clump of chocobo feathers passes a naive shape test).

This is a heuristic, and it is honest about being one: expect ~1 false positive
per human sheet in bands 2-3 (a narrow dark cape strip), and a handful of missed
frames on monsters whose attack poses include a detached flame or breath effect.
**Bands 0 and 1 are reliable.** Every pose carries `w`, `h` and its own tight box
in the manifest, so a consumer can filter further.

#### Feet anchor

Each pose records `feetX, feetY`: the mean x of the opaque pixels on its lowest
scanlines, and that lowest scanline's y, in sheet pixels. That is the point that
must land on the tile surface — a billboard quad placed by bounding-box centre
will float or sink, because capes, wings and weapons make the box asymmetric.

`SheetManifestEntry.anchor` is the median offset from a pose frame's
bottom-centre to the feet, in the `SpriteSheetMeta.anchor` convention from
`src/core/types.ts` (frame = the 64-px column clipped to the band). Typical
values are small for humans (`knight_male` = `(1, -2)`) and larger for monsters
and event units whose frames sit off-centre in their column (`behemoth` =
`(10, -4)`).

### 1.5 Sheet keys

Keys are derived from the filename: `1000_Knight_Male_hd.png` → `knight_male`.

FFT reuses a character across several scenario-specific sprite slots, so names
collide (`Squire Male` appears 8 times, `Black Mage Male` 3 times). The clean key
goes to the best candidate — a non-broken rip, then the **highest** sprite number,
which is the canonical generic-job block at 996-1067 — and the rest are suffixed
with their sprite number (`black_mage_male_920`, `black_mage_male_940`). Every
sheet stays addressable, and `manifest.byNumber` maps raw FFT sprite numbers to
keys.

The 20 generic job sheets a job table should reference:

| job | male | female |
|---|---|---|
| Squire | `squire_male` (992) | `squire_female` (994) |
| Chemist | `chemist_male` (996) | `chemist_female` (998) |
| Knight | `knight_male` (1000) | `knight_female` (1002) |
| Archer | `archer_male` (1004) | `archer_female` (1006) |
| Monk | `monk_male` (1008) | `monk_female` (1010) |
| White Mage | `white_mage_male` (1012) | `white_mage_female` (1014) |
| Black Mage | `black_mage_male` (1016) | `black_mage_female` (1018) |
| Time Mage | `time_mage_male` (1020) | `time_mage_female` (1022) |
| Summoner | `summoner_male` (1024) | `summoner_female` (1026) |
| Thief | `thief_male` (1028) | `thief_female` (1030) |
| Orator | `orator_male` (1032) | `orator_female` (1034) |
| Mystic | `mystic_male` (1036) | `mystic_female` (1038) |
| Geomancer | `geomancer_male` (1040) | `geomancer_female` (1042) |
| Dragoon | `dragoon_male` (1044) | `dragoon_female` (1046) |
| Samurai | `samurai_male` (1048) | `samurai_female` (1050) |
| Ninja | `ninja_male` (1052) | `ninja_female` (1054) |
| Arithmetician | `arithmetician_male` (1056) | `arithmetician_female` (1058) |
| Bard / Dancer | `bard_male` (1060) | `dancer_female` (1062) |
| Mime | `mime_male` (1064) | `mime_female` (1066) |
| Dark Knight / Onion Knight | *no usable art* | *no usable art* |

---

## 2. Palettes — `public/assets/palettes/*.act`

2208 files. Each is an **Adobe Color Table**: 256 RGB triplets = 768 bytes, plus a
4-byte trailer (`uint16` colour count, `uint16` transparent index) making 772
bytes on disk. **FFT uses only the first 16 entries.** Index 0 is transparent.

### 2.1 Naming — the README is wrong about the numbering

Files on disk are named:

```
battle_{FAMILY}_battle_pal{N}.act      N = 1..8
battle_{FAMILY}_portrait_pal{N}.act    N = 1..8
```

The vendor README describes `sprite_{NUMBER}_{TYPE}_palette_{INDEX}.act` with
0-based indices and sprite *numbers*. Neither is what is on disk: the files use
**family names** (`knight_m`, `cyoko`, `ramuza`) and **1-based** `palN`. The
pipeline maps `pal1 → slot 0`, so slot indices in `manifest.json` are 0-based and
match the game's own numbering. There are **138 families**, 16 files each.

Battle slot *n* pairs with portrait slot *n* (README's "slot pairing" claim
holds: battle 0-7 and portrait 0-7 in separate files here rather than as
palettes 0-15).

### 2.2 Which sheet uses which palette — proven, not guessed

Family names are Japanese-derived internal codes and do not resemble the English
sheet names, so the mapping is established by **exact byte comparison**: a
sheet's embedded 48-byte `PLTE` is matched against every family's battle
palettes. The match is exact for 277 of 318 sheets, and the results are
self-evidently correct:

| sheet | family | meaning |
|---|---|---|
| `chemist_male` | `item_m` | *item* = Chemist |
| `squire_male` | `mina_m` | |
| `archer_male` | `yumi_m` | *yumi* = bow |
| `white_mage_male` | `siro_m` | *shiro* = white |
| `black_mage_male` | `kuro_m` | *kuro* = black |
| `time_mage_male` | `toki_m` | *toki* = time |
| `summoner_male` | `syou_m` | *shōkan* = summon |
| `mystic_male` | `onmyo_m` | *onmyō* = divination |
| `geomancer_male` | `fusui_m` | *fūsui* = feng shui |
| `dragoon_male` | `ryu_m` | *ryū* = dragon |
| `dancer_female` | `odori_w` | *odori* = dance |
| `arithmetician_male` | `san_m` | *san* = calculation |
| `mime_male` | `mono_m` | |
| `orator_male` | `waju_m` | |
| `chocobo` | `cyoko` | |

Unmatched: the 22 broken sheets and 20 event sheets whose palettes are not in the
`.act` set. 30 sheets match more than one family byte-for-byte (families that
share a palette); the pipeline prefers a slot-0 match and then name affinity, and
flags them `paletteAmbiguous: true`.

**Every sprite sheet also carries its own palette** in `basePalette` (base64 of
the 48-byte `PLTE`), so palette work never depends on the family match
succeeding.

### 2.3 Slot semantics — measured, and the README is wrong here too

The README claims generic classes use `0 = blue, 1 = red, 2 = green,
3 = yellow, 4 = purple`. Rendering `knight_male` and `black_mage_female` through
all 8 slots gives the actual ordering:

| slot | measured colour |
|---|---|
| 0 | **blue** — player default |
| 1 | teal / cyan |
| 2 | grey |
| 3 | green |
| 4 | **red** — enemy |
| 5-7 | all black (unused) |

**Red is slot 4, not slot 1.** Do not hardcode `1` for enemies.

`manifest.palettes[family].battleUsed` reports how many slots actually carry
colour — 5 for nearly every generic class, which corroborates "5 team colours"
and matches the README's claim that slots 5-7 are empty. Monsters use the same
slots as colour *variants* (yellow / black / red chocobo), and story characters
use only slot 0. `SpriteAtlas.getSheetPalette` falls back to the sheet's own
`basePalette` when a requested slot is empty, so asking for slot 7 never yields a
black silhouette.

11 sheets have **duplicate colours inside their 16-entry palette**
(`duplicatePaletteColours`). This matters only for RGB→index inversion (§3.2);
the pipeline resolves ties to the lowest index.

---

## 3. Runtime — `src/render/spriteAtlas.ts`

```ts
const atlas = await SpriteAtlas.load();               // fetches assets/manifest.json
const sheet = await atlas.loadSheet('knight_male');   // stitches both PNGs, builds textures
const uv    = atlas.getPoseUV('knight_male', 0);      // GL UVs for a whole-body frame
const lut   = atlas.getPaletteTexture('knight_m', 4); // 16x1 red-team LUT
```

### 3.1 Textures

`loadSheet` returns:

* `colorTexture` — RGBA `DataTexture`, `SRGBColorSpace`, **alpha 0 wherever the
  FFT palette index is 0**. Directly usable with a plain material.
* `indexTexture` — single-channel `R8` `DataTexture`; each byte *is* the original
  FFT palette index. This is the input for GPU palette swapping.

Both are `NearestFilter`, `generateMipmaps = false`, `ClampToEdgeWrapping`,
`unpackAlignment = 1`, `premultiplyAlpha = false`.

Both are uploaded **bottom-up** (the loader flips rows) with `flipY = false`,
because `UNPACK_FLIP_Y_WEBGL` is ignored for `ArrayBufferView` uploads and a
`DataTexture` would otherwise disagree with a `CanvasTexture`. Consequence:
`getFrameUV` / `getPoseUV` / `getRectUV` return conventional GL UVs where `v0` is
the frame's **bottom** edge and `v1` its top, so they drop straight into a
`PlaneGeometry` uv attribute with no flipping.

### 3.2 GPU palette swap

Palette swapping is done on the GPU, per the architecture brief — no PNG
regeneration, one texture per sheet regardless of how many teams are on screen.

The index texture is reconstructed at load time: the browser decodes the indexed
PNG to RGB, and the loader inverts that back to indices using the sheet's own
`basePalette` (exact RGB match, lowest index wins, nearest-colour fallback so a
stray pixel can never punch a hole). Verified against a fresh independent decode
of `knight_male`: **0 index mismatches and 0 alpha mismatches across all 499 712
pixels.**

`PALETTE_SWAP_GLSL` is exported from `spriteAtlas.ts` so `render/sprites.ts` and
`render/materials/` share one definition:

```glsl
float index = texture2D(uIndexMap, uv).r * 255.0;
vec4  texel = texture2D(uPalette, vec2((index + 0.5) / 16.0, 0.5));
```

Palette LUTs are 16 × 1 RGBA `DataTexture`s with **texel 0 alpha 0**, cached and
shared across sheets.

---

## 4. Other asset groups

| directory | count | format | manifest section |
|---|---|---|---|
| `portraits/` | 352 | 520 × 388 RGBA PNG (colour type 6) | `portraits` — url + size only |
| `summons/` | 16 | 512 × 512 RGB PNG (colour type 2) | `summons` — 8 × 8 grid of 64 px cells |
| `weapons/` | 2 | 256 × 256 RGBA PNG + matching `.act` | `weapons` — 8 × 8 grid of 32 px cells, palette inlined |

Summon and weapon sheets are truecolour, not indexed, so they have no index
texture and cannot be palette-swapped. `WEP1.act` / `WEP2.act` parse as normal
Adobe Color Tables and are inlined into the manifest.

---

## 5. Not done yet

* **`*_shp.bin` / `*_seq.bin` are not decoded.** They live in
  `assets-src/unit/` (25 files: `type1`-`type4`, `mon`, `other`, `arute`,
  `cyoko`, `kanzen`, `wep1`, `wep2`, `eff1`, `eff2`) and hold the real frame
  assembly and animation timing. Until they are decoded, animation must be built
  from the whole-body pose frames, which means (a) `chocobo` cannot be rendered
  at all and (b) `SpriteSheetMeta.animations` in `src/core/types.ts` has no
  pipeline-produced value — the manifest exposes `poses` instead and deliberately
  does not fabricate `SpriteAnimation` records.
* **Pose→facing mapping is not established.** Visual inspection of band 0
  suggests column order runs side → 3/4 front → front → 3/4 back → back, then
  further frames, but that ordering is only confirmable against `seq` data and is
  therefore *not* asserted in the manifest. Poses are exposed by index.
* Event sheets 020, 041, 062, 105, 141 and `altima_second_form` are too sparse
  or too irregular for the pose detector and yield no frames.

## 6. Manifest field reference

Top level: `version`, `generator`, `generatedAt`, `grid`, `notes`, `stats`,
`sheets`, `byNumber`, `palettes`, `summons`, `portraits`, `weapons`, `warnings`.

Compact encodings (all documented inline in `notes`, and parsed for you by
`SpriteAtlas`):

* `occupancy` — hex string, one nibble per four cells, row-major; bit *i* of the
  nibble is cell *i* of that group. `atlas.isCellOccupied(key, cell)`.
* `cellBoxes` — flat array, **6 numbers per occupied cell**:
  `[cellIndex, x, y, w, h, pixels]`, `x`/`y` relative to the cell origin.
  `atlas.getCellBoxes(key)`.
* `poses` — flat array, **8 numbers per pose**:
  `[bandIndex, column, x, y, w, h, feetX, feetY]` in sheet pixels, origin
  top-left. `atlas.getPoses(key)`.
* `contentBands` / `poseBands` — `[y, height]` and `[y, height, figureCount]`.
* `basePalette`, `palettes[*].battle[n]`, `palettes[*].portrait[n]` — base64 of
  48 bytes (16 RGB triplets).

The manifest is 955 KB raw / 223 KB gzipped and is fetched once at boot.
