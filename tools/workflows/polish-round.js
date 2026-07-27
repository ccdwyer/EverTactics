export const meta = {
  name: 'evertactics-polish-round',
  description: 'One visual polish round: shoot, blind A/B against shipped tactical RPGs, fan out fixers on the weakest axes, re-shoot, re-judge',
  phases: [
    { title: 'Baseline', detail: 'render current frames' },
    { title: 'Judge', detail: 'blind A/B vs Triangle Strategy + FFT' },
    { title: 'Fix', detail: 'parallel fixers on the weakest axes' },
    { title: 'Verify', detail: 're-shoot and re-judge blind' },
  ],
}

const ROOT = '/Users/chris/Developer/EverTactics'

// `args` can arrive as an object or as a JSON string depending on how the run was
// launched. Round 1 silently lost its entire reference list to exactly this: every
// `args.triangle` read was undefined, the judge pipeline iterated an empty array,
// and the workflow reported success with zero verdicts. Normalise, then assert.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})

const round = A.round || 1
const seed = A.seed || 7

// Curated reference frames — battle dioramas only, no key art or character renders.
// Hard-coded fallback so an args mishap degrades to "judged against the wrong six"
// rather than "silently judged nothing".
const TRI_DEFAULT = [
  'official_001_steam.jpg', 'official_003_steam.jpg', 'official_009_steam.jpg',
  'official_019_se_screenshot.jpg', 'official_024_se_screenshot.png',
  'press_002_gematsu_1920x1080.jpg', 'official_006_steam.jpg',
  'official_020_se_screenshot.jpg', 'official_026_se_screenshot.png',
  'official_031_se_screenshot.jpg', 'press_004_gematsu_1920x1080.jpg',
  'official_002_steam.jpg',
]

const TRI = Array.isArray(A.triangle) && A.triangle.length > 0 ? A.triangle : TRI_DEFAULT

if (!Array.isArray(TRI) || TRI.length < 2) {
  throw new Error(
    'polish-round: no reference frames to judge against. The blind A/B is the ' +
    'entire point of this workflow — refusing to run a round that would report ' +
    'success without judging anything.',
  )
}

log(`Round ${round}: judging against ${TRI.length} reference frames.`)

const BRIEF = `Project: EverTactics — a AAA-quality tactical RPG (Final Fantasy Tactics / Triangle Strategy lineage) in Three.js.
Working directory: ${ROOT}

Read these first, every time:
  ${ROOT}/docs/VISUAL_TARGET.md   — the measured bar, with explicit fail conditions. This is the spec.
  ${ROOT}/docs/ARCHITECTURE.md    — module rules and ownership.
  ${ROOT}/src/core/types.ts       — the type contract.

Reference frames from the actual shipped games live in ${ROOT}/refs/curated/triangle/ and
${ROOT}/refs/curated/fft/. LOOK AT THEM with the Read tool. Do not work from memory of these
games — open the files and study what is actually on screen.

Render a frame any time with:
  cd ${ROOT} && node tools/shoot.mjs --scene battle-open --out shots/<name>.png
Then READ the PNG back and look at it. Iterate on pixels, not on intentions.
Scenes available: battle-open, terrain-only, sprites-only, ui-only.

HARD RULES:
- src/core/ never imports three.js.
- npx tsc --noEmit must pass when you finish. Verify it.
- Own only your listed files. Other agents work concurrently.
- No flat untextured surfaces. No neutral-grey lighting. Read the fail-condition list.`

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    guess: { type: 'string', enum: ['left', 'right'], description: 'Which side you believe is the shipped commercial game' },
    confidence: { type: 'number', description: '0-100, how sure you are' },
    better: { type: 'string', enum: ['left', 'right'], description: 'Which side simply looks better' },
    tells: { type: 'array', items: { type: 'string' }, description: 'Concrete visual tells that gave it away' },
    axisScores: {
      type: 'object',
      description: 'Score the PROTOTYPE side 1-10 on each axis',
      properties: {
        textureDensity: { type: 'number' },
        lighting: { type: 'number' },
        depthOfField: { type: 'number' },
        spriteGrounding: { type: 'number' },
        composition: { type: 'number' },
        colorGrading: { type: 'number' },
        geometryCraft: { type: 'number' },
        uiCraft: { type: 'number' },
      },
      required: ['textureDensity', 'lighting', 'depthOfField', 'spriteGrounding', 'composition', 'colorGrading', 'geometryCraft', 'uiCraft'],
      additionalProperties: false,
    },
    topFixes: { type: 'array', items: { type: 'string' }, description: 'Highest-leverage fixes, each naming the responsible file' },
  },
  required: ['guess', 'confidence', 'better', 'tells', 'axisScores', 'topFixes'],
  additionalProperties: false,
}

// ── Baseline ────────────────────────────────────────────────────────────────
phase('Baseline')
const baseline = await agent(
  `${BRIEF}

=== TASK: baseline render ===
Round ${round}. Render the current state of the game to PNGs so it can be judged.

Run each of these and confirm each produces a real, non-black PNG:
  node tools/shoot.mjs --scene battle-open  --out shots/r${round}/battle-open.png
  node tools/shoot.mjs --scene terrain-only --out shots/r${round}/terrain-only.png
  node tools/shoot.mjs --scene ui-only      --out shots/r${round}/ui-only.png

READ each PNG back and describe honestly what you see. If a shot is black, empty, or errored,
diagnose why (check the console errors the harness prints) and FIX it — you may edit any file
needed to get a real frame rendering. A broken render blocks the whole round.

Report the paths that now contain real frames and what is visibly present in each.`,
  { label: 'baseline', phase: 'Baseline', effort: 'high', schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      shots: { type: 'array', items: { type: 'string' } },
      describes: { type: 'string' },
      fixesApplied: { type: 'string' },
    },
    required: ['ok', 'shots', 'describes', 'fixesApplied'],
    additionalProperties: false,
  } }
)

log(`Baseline: ${baseline && baseline.ok ? 'frames rendered' : 'PROBLEM — see report'}`)

// ── Judge: blind A/B ────────────────────────────────────────────────────────
// Swap side is decided here and never written to disk, so the comparison is blind.
phase('Judge')

const pairs = TRI.slice(0, 6).map((ref, i) => ({
  i,
  ref,
  game: 'triangle',
  swap: (i + seed) % 2 === 1,
}))

const judged = await pipeline(
  pairs,
  async (p) => {
    // Build the normalised blind pair.
    const dir = `shots/r${round}/ab/pair-${p.i}`
    await agent(
      `Run exactly this command in ${ROOT} and report the output verbatim. Do nothing else.
cd ${ROOT} && node tools/ab.mjs --ours shots/r${round}/battle-open.png --ref "refs/curated/triangle/${p.ref}" --out ${dir} --swap ${p.swap ? 1 : 0}`,
      { label: `pair-${p.i}`, phase: 'Judge', effort: 'low' }
    )
    return { ...p, dir }
  },
  async (p) =>
    agent(
      `You are a senior art director with deep knowledge of the tactical RPG genre.

Two images are on disk:
  ${ROOT}/${p.dir}/left.png
  ${ROOT}/${p.dir}/right.png

READ BOTH with the Read tool and study them carefully.

One of them is a frame from a **shipped, commercially released** tactical RPG.
The other is a frame from an **in-development prototype**.
They have been normalised to identical resolution and encoding, so file properties tell you nothing.
Which side is which is not recorded anywhere on disk — do not go looking, judge by eye.

Answer:
1. Which side is the shipped commercial game? How confident are you (0-100)?
2. Which side simply looks better?
3. What concrete visual tells gave it away? Be specific — "the grass is a flat green with uniform
   noise", "no surface has grime in its crevices", "the shadow direction disagrees with the key
   light", "the depth of field is far too weak to read as a diorama".
4. Score the PROTOTYPE side 1-10 on each axis in the schema.
5. List the highest-leverage fixes for the prototype, each naming the likely responsible file.
   Source lives in ${ROOT}/src/render/ — terrain.ts, materials/terrain.ts, materials/water.ts,
   lighting.ts, post.ts, vfx.ts, sprites.ts, materials/sprite.ts, camera.ts, and ${ROOT}/src/ui/.

Be merciless. Encouragement is worthless here. If the prototype is obviously worse, say exactly why.`,
      { label: `judge-${p.i}`, phase: 'Judge', effort: 'high', schema: CRITIC_SCHEMA }
    ).then((v) => ({ ...v, pair: p.i, oursSide: p.swap ? 'right' : 'left', ref: p.ref }))
)

const verdicts = judged.filter(Boolean)
// A critic "caught us" when it correctly identified the shipped game (i.e. did NOT pick our side).
const caught = verdicts.filter((v) => v.guess !== v.oursSide).length
const preferredUs = verdicts.filter((v) => v.better === v.oursSide).length
log(`Round ${round} blind result: identified correctly ${caught}/${verdicts.length}; preferred ours ${preferredUs}/${verdicts.length}`)

// Average each axis to find the weakest.
const AXES = ['textureDensity', 'lighting', 'depthOfField', 'spriteGrounding', 'composition', 'colorGrading', 'geometryCraft', 'uiCraft']
const avg = {}
for (const a of AXES) {
  const xs = verdicts.map((v) => (v.axisScores || {})[a]).filter((n) => typeof n === 'number')
  avg[a] = xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0
}
log('Axis averages: ' + AXES.map((a) => `${a}=${avg[a].toFixed(1)}`).join(' '))

const allTells = verdicts.flatMap((v) => v.tells || [])
const allFixes = verdicts.flatMap((v) => v.topFixes || [])

const CRITIQUE_DIGEST = `Blind A/B result, round ${round}:
Critics correctly identified the shipped game in ${caught} of ${verdicts.length} pairs.
Critics preferred OUR frame in ${preferredUs} of ${verdicts.length} pairs.

Axis averages (our frame, 1-10):
${AXES.map((a) => `  ${a}: ${avg[a].toFixed(1)}`).join('\n')}

Every tell the critics named:
${allTells.map((t) => '  - ' + t).join('\n')}

Every fix the critics requested:
${allFixes.map((t) => '  - ' + t).join('\n')}`

// ── Fix ─────────────────────────────────────────────────────────────────────
phase('Fix')

const FIXERS = [
  {
    label: 'fix-world',
    own: 'src/render/stage.ts, src/render/sky.ts (new), src/render/backdrop.ts (new), src/render/atmosphere.ts (new)',
    focus: `KILL THE VOID. This is the single highest-leverage fix in the project and nothing else on this
list comes close.

Measured: roughly HALF of our 1920x1080 frame is flat background colour (src/render/stage.ts clears
to 0x05060a). The map is a small object centred in emptiness with a hard silhouette. It reads as a
3D asset viewer with a turntable, not a place.

Open refs/curated/triangle/ and look at what is actually behind and around their maps: the
environment CONTINUES past the play area — background walls, distant architecture, crates, lanterns,
hanging banners, drifting embers, atmospheric haze. The board bleeds off the frame edges. There is
no hard silhouette against a flat colour anywhere in either reference game.

Build:
- A graded sky/atmosphere: a vertical gradient tuned per map mood, not a flat clear colour.
- Distance haze/fog that the terrain fades into, coloured to the map's cool tone.
- A far silhouette layer — distant architecture, hills, spires — parallaxed behind the board.
  Even simple layered silhouettes with correct haze read enormously better than a void.
- Ambient particulate: slow drifting motes/embers/dust, lit by the scene, depth-sorted.
  Both references have this and it is a big part of why they feel like a place.
- Ground the diorama: the board should not float. Either extend terrain past the play area into
  haze, or give the pedestal a base that dissolves into fog.

Coordinate by contract only — do NOT edit terrain.ts, lighting.ts, post.ts, camera.ts or anything
in src/ui/ or src/core/. Four other fixers own those. Expose whatever hooks you need and say so
clearly in your report.

Verify by rendering and LOOKING. Success is: less than 25% of the frame is flat background colour,
and the board no longer has a hard silhouette against emptiness.`,
  },
  {
    label: 'fix-terrain',
    own: 'src/render/terrain.ts, src/render/materials/terrain.ts, src/render/materials/water.ts, src/core/grid.ts, and any new files under src/render/materials/textures/',
    focus: `BREAK THE BOX. Round 1 substantially improved your materials — stochastic tiling, per-edge
chamfer, real props, coursed masonry. Texture density is no longer the weak link. Do NOT spend this
round re-polishing materials.

The problem now is SHAPE. The map is a square footprint with uniform-height walls on all four sides
and a flat lawn inside. Its silhouette is a rectangle from every camera yaw, and the pedestal
masonry dominates the lower third of the frame. Round 1's own report flagged this and said the fix
was outside its file list — this round it is inside yours: you also own src/core/grid.ts, where the
map data lives.

Do:
- Author an irregular plan for orbonne-courtyard: drop a corner, terrace the north side away, add a
  ramp and an overhang, open a gap that lets the camera see into the interior. Vary wall heights.
  The silhouette must be interesting from all four yaw positions.
- Thin the exterior pedestal slab dramatically so repeated brick underside stops being ~40% of the
  object's mass.
- Add real vertical interest INSIDE the play area — the references are full of stairs, platforms at
  different heights, bridges. FFT maps are famous for height mattering; ours is a flat lawn.
- Natural surfaces still read as chunky cubes on top. Add per-tile top-face displacement on dirt
  and grass so embankments stop being stepped boxes.

CRITICAL: src/core/grid.ts is pure game logic — it must NOT import three.js, and the maps must stay
legal (reachable, no unreachable spawn tiles). Run \`npx vitest run\` after any grid change; there are
66 pathfinding tests and 8 playthrough tests that will catch a broken map.`,
  },
  {
    label: 'fix-lighting-vfx',
    own: 'src/render/lighting.ts, src/render/vfx.ts',
    focus: `LIGHTING DRAMA and VFX-AS-LIGHT.

In refs/curated/fft/ the night battle is lit almost entirely BY THE SPELL EFFECTS — warm point
lights that illuminate terrain and sprites together, everything outside their radius falling to
deep blue-black. In refs/curated/triangle/ the throne room has a warm orange key from one side and
a cold teal fill from the other: a committed complementary split with aggressive falloff.

Do:
- Every VFX must emit a REAL light (THREE.PointLight or a clustered equivalent) that illuminates
  terrain and sprites. Glowing particles that do not light their surroundings look pasted on.
  Animate intensity over the effect's timeline — flash bright on impact, decay.
- Give each map a committed colour scheme: warm key + cool fill, complementary, saturated.
  Neutral white light on green grass is the most boring possible choice and reads as untuned.
- Aggressive falloff and genuinely dark regions. The references have deep shadow.
- Torch/brazier props need flickering point lights with subtle noise on intensity and position.
- Shadows: soft, correctly biased, no peter-panning, no acne. Units must be visibly grounded.
- Add light probes / a cheap irradiance term so ambient is coloured by the map mood rather than
  flat grey.`,
  },
  {
    label: 'fix-post-camera',
    own: 'src/render/post.ts, src/render/camera.ts, src/state/scenarios.ts, and any files under src/render/materials/post/',
    focus: `COMPOSITION FIRST. Round 1's critic scored composition 3/10 and lighting 2/10; these are
concrete, already-diagnosed defects with file references. Fix them before any new effect work.

**(1) The board is shrunk into the void.** \`fitWholeField: true\` in src/state/scenarios.ts forces
the zoom floor to zoomLevels[0] in src/render/camera.ts, which is why the map is a small object in
a sea of background. Set it false and let the board BLEED PAST THE FRAME EDGES the way both
reference games do. Open refs/curated/triangle/ and confirm: their maps run off the edge.

**(2) Pitch is too top-down.** 40 degrees flattens the height differences the map exists to express.
FFT sits nearer 30 and gets far more read on vertical faces. Also break the perfect symmetry — the
map diamond is currently centred and square to frame, which reads as a turntable. Compose it:
action on a diagonal, negative space used deliberately.

**(3) DOF is blurring gameplay.** dof: 0.35 blurs pillars and gameplay-relevant tiles at the top and
bottom of the board. READ THE UPDATED docs/VISUAL_TARGET.md section 3 — an earlier version of that
rubric told you to push DOF harder and it was wrong. In both reference games the blur is on SCENERY;
the tiles a player must count stay sharp. The focus band must contain the whole playable board with
falloff beyond it. Pull vignette from 0.8 to ~0.35 — it is compounding an already-dark frame.

**(4) Sprites and terrain are not one image.** Sprites are crisp nearest-neighbour at full
saturation over smoothed, graded, desaturated terrain. Route sprites through the same LUT so they
share the scene grade. Shared frequency and shared tint are the whole reason FFT's composite reads
as a single picture. Coordinate with the fix-sprites agent by contract; you own the LUT side.

Then, secondary:`,
  },
  {
    label: 'fix-sprites',
    own: 'src/render/sprites.ts, src/render/materials/sprite.ts, src/render/animation.ts',
    focus: `SPRITE INTEGRATION AND GROUNDING.

In refs/curated/fft/ the White Mage is visibly underlit by the fire in front of her; the Squire is
rim-lit warm on one side and falls to blue on the other. Every unit casts a soft directional shadow
matching the key light. A sprite drawn at full unmodified brightness with a generic dark ellipse
under it is an instant fail.

Do:
- The sprite material must take scene lighting including dynamic VFX point lights, with a rim term.
- Real cast shadows into the shadow map plus a tight contact darkening at the feet. No peter-panning.
- Correct depth sorting: a unit behind a cliff must be occluded; units must sort sanely against
  each other. Floating or wrongly-occluded sprites are an instant AAA fail.
- Pixel-crisp: NearestFilter, alpha test not alpha blend, and texel-to-device-pixel alignment.
  Any shimmer when the camera moves means the snapping is wrong.
- Verify the palette swap actually works — player blue, enemy red, ally green from the .act palettes.
- Facing must switch correctly as the camera yaws through its four positions.`,
  },
  {
    label: 'fix-ui',
    own: 'src/ui/** (everything under src/ui/)',
    focus: `TWO SPECIFIC BUGS FIRST, then craft. Round 1's critic scored UI 6/10 — the highest of any
axis — so the chrome is already good. These are the things dragging it down:

**(1) The command menu sits ON TOP OF THE BOARD and buries units.** src/ui/styles.css centres
\`.et-hud__menus\` between the two side columns (margin-inline: auto), which puts it over the map
centre. In the current frame it occludes the acting unit and at least two other party members.
FFT anchors the command window to ONE SIDE, never over the acting unit. This is a playability bug,
not a taste note. Fix it.

**(2) The UI forms a picture frame that squeezes the game into the middle.** A 12-card roster strip
pinned to the top edge, two large portrait panels bottom-left and bottom-right, key hints along the
bottom. The playfield ends up the SMALLEST element in the composition. That is backwards — the
board is the game. Cut global type size by roughly 25%, shrink the panels, and give the board room.

**(3) The turn-order portraits do not match the units on the field.** The roster strip currently
shows a lizard, a goat and an octopus sitting beside competent human faces, while twelve human
sprites stand on the map. Portraits must correspond to the actual unit's job and gender. Look at
public/assets/portraits/ and at how src/ui/portraitCatalog.ts picks them, and make the mapping
correct and visually coherent — one art direction, not a grab bag.

Then, if time remains, general craft:

Compare against the UI in refs/curated/fft/ and refs/curated/triangle/ — open the frames that show
menus, the turn-order bar, and unit info panels, and study the actual chrome: ornate framed panels,
crisp serif type, deliberate spacing, layered translucency, gold filigree edges.

Do:
- Panel frames with real authored ornament (border-image 9-slice or SVG), parchment/vellum texture,
  layered drop shadows, subtle inner glow. Flat rectangles with system fonts read as a prototype
  no matter how good the 3D behind them is.
- Real display serif for headings and a readable body face, embedded locally (no external CDN
  requests — they are blocked).
- A coherent palette used consistently: deep blues, aged gold, parchment.
- The turn-order bar with portraits from public/assets/portraits/ — a signature genre element.
- Target preview: hit chance, predicted damage, resulting HP, facing indicator. Players depend on it.
- Everything animates with easing that has personality. Numbers count up, panels slide and fade.
- Verify by shooting the ui-only and battle-open scenes and LOOKING at the result.`,
  },
]

const fixed = await parallel(
  FIXERS.map((f) => () =>
    agent(
      `${BRIEF}

=== TASK: ${f.label} — round ${round} ===

You own ONLY: ${f.own}
Do not edit files outside that list. Four other fixers are working concurrently in this repo.

${CRITIQUE_DIGEST}

Your focus this round:
${f.focus}

Work the loop: change something, re-render with tools/shoot.mjs, READ the PNG, compare it side by
side with a reference frame you have open, and keep going until your axis genuinely improves.
Do not report done after one edit. Do not report done without having looked at a rendered frame.

Finish with npx tsc --noEmit passing.`,
      { label: f.label, phase: 'Fix', effort: 'high', schema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' } },
          changed: { type: 'string', description: 'What you actually changed' },
          verified: { type: 'string', description: 'What you saw in the rendered frames, honestly' },
          remaining: { type: 'string', description: 'What still falls short' },
          typecheckPasses: { type: 'boolean' },
        },
        required: ['files', 'changed', 'verified', 'remaining', 'typecheckPasses'],
        additionalProperties: false,
      } }
    )
  )
)

// ── Verify ──────────────────────────────────────────────────────────────────
phase('Verify')

const reshoot = await agent(
  `${BRIEF}

=== TASK: re-render and reconcile — round ${round} ===

Five fixers just edited the renderer and UI concurrently. Reconcile any breakage between them,
get npx tsc --noEmit passing, and re-render:
  node tools/shoot.mjs --scene battle-open  --out shots/r${round}/after/battle-open.png
  node tools/shoot.mjs --scene terrain-only --out shots/r${round}/after/terrain-only.png
  node tools/shoot.mjs --scene ui-only      --out shots/r${round}/after/ui-only.png

READ each result. If anything regressed or is broken, fix it. You may edit any file.
Report what the frames actually look like now — honestly, including what still falls short.`,
  { label: 'reshoot', phase: 'Verify', effort: 'high', schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      typecheckPasses: { type: 'boolean' },
      describes: { type: 'string' },
      regressions: { type: 'string' },
    },
    required: ['ok', 'typecheckPasses', 'describes', 'regressions'],
    additionalProperties: false,
  } }
)

// Re-judge blind on fresh pairs (different refs than the baseline round, to avoid overfitting).
const vpairs = TRI.slice(6, 12).map((ref, i) => ({
  i,
  ref,
  swap: (i + seed + 1) % 2 === 1,
}))

const rejudged = await pipeline(
  vpairs,
  async (p) => {
    const dir = `shots/r${round}/after/ab/pair-${p.i}`
    await agent(
      `Run exactly this command in ${ROOT} and report the output verbatim. Do nothing else.
cd ${ROOT} && node tools/ab.mjs --ours shots/r${round}/after/battle-open.png --ref "refs/curated/triangle/${p.ref}" --out ${dir} --swap ${p.swap ? 1 : 0}`,
      { label: `vpair-${p.i}`, phase: 'Verify', effort: 'low' }
    )
    return { ...p, dir }
  },
  async (p) =>
    agent(
      `You are a senior art director with deep knowledge of the tactical RPG genre.

READ both images with the Read tool and study them:
  ${ROOT}/${p.dir}/left.png
  ${ROOT}/${p.dir}/right.png

One is a frame from a shipped, commercially released tactical RPG. The other is an in-development
prototype. They are normalised to identical resolution and encoding. Which is which is not recorded
on disk — judge by eye alone.

Say which side is the shipped game, how confident you are, which looks better, the concrete tells,
per-axis scores for the prototype, and the highest-leverage remaining fixes with responsible files.
Be merciless.`,
      { label: `rejudge-${p.i}`, phase: 'Verify', effort: 'high', schema: CRITIC_SCHEMA }
    ).then((v) => ({ ...v, pair: p.i, oursSide: p.swap ? 'right' : 'left', ref: p.ref }))
)

const v2 = rejudged.filter(Boolean)
const caught2 = v2.filter((v) => v.guess !== v.oursSide).length
const preferred2 = v2.filter((v) => v.better === v.oursSide).length
const avg2 = {}
for (const a of AXES) {
  const xs = v2.map((v) => (v.axisScores || {})[a]).filter((n) => typeof n === 'number')
  avg2[a] = xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0
}

log(`Round ${round} AFTER: identified correctly ${caught2}/${v2.length}; preferred ours ${preferred2}/${v2.length}`)
log('Axis averages after: ' + AXES.map((a) => `${a}=${avg2[a].toFixed(1)}`).join(' '))

return {
  round,
  before: { caught, total: verdicts.length, preferredUs, axes: avg },
  after: { caught: caught2, total: v2.length, preferredUs: preferred2, axes: avg2 },
  fixers: fixed.filter(Boolean).map((f) => ({ changed: f.changed, remaining: f.remaining })),
  reshoot,
  remainingFixes: v2.flatMap((v) => v.topFixes || []),
  tells: v2.flatMap((v) => v.tells || []),
}
