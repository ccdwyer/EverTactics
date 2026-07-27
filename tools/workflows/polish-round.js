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
const round = (args && args.round) || 1
const seed = (args && args.seed) || 7

// Curated reference frames — battle dioramas only, no key art or character renders.
const TRI = args && args.triangle ? args.triangle : []
const FFT = args && args.fft ? args.fft : []

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
    label: 'fix-terrain',
    own: 'src/render/terrain.ts, src/render/materials/terrain.ts, src/render/materials/water.ts, and any new files under src/render/materials/textures/',
    focus: `TEXTURE DENSITY and GEOMETRY CRAFT — currently the weakest link in almost every tactics-game
clone, and the fastest thing a critic spots.

Study refs/curated/triangle/ and refs/curated/fft/ closely. In those frames there is not one flat
polygon. Stone has per-block colour variation, mortar lines, edge wear and grime pooling in corners.
Grass has clumping, directional variation and darker roots between blades. FFT's terrain is
hand-painted: texture flows across tile boundaries rather than tiling per-tile.

Do:
- Author genuinely detailed procedural materials (multi-octave noise, worley/voronoi for stone
  blocks and grass clumps, directional streaking for wear). Generate to canvas/DataTexture at
  adequate resolution. Flat colour + a single noise octave is a fail.
- Break per-tile repetition: vary UV offset/rotation per tile, or use triplanar world-space UVs so
  the pattern crosses tile boundaries.
- Bake real ambient occlusion into vertex colours — sample neighbour heights so crevices between
  tiles and the inside corners of walls darken. This is what makes it read as sculpted.
- Chamfer tile top edges. Hard 90-degree corners read as programmer art.
- Add PROPS. An empty tile field reads as a test scene no matter how well textured. The references
  are full of railings, stairs, pillars, banners, crates, torches, foliage, rubble. Build a prop
  system and populate the maps.
- Water: animated normals, depth-based colour ramp, fresnel reflection, refraction, shoreline foam.`,
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
    own: 'src/render/post.ts, src/render/camera.ts, and any files under src/render/materials/post/',
    focus: `DEPTH OF FIELD, GRADING and COMPOSITION.

Measured from refs/curated/triangle/: the top ~15% and bottom ~20% of the frame are visibly soft;
only a horizontal band through the middle is sharp. Our instinct will be to under-do this. Push it
until it reads as a miniature, then back off slightly.

Also measured: a character is roughly 12% of frame height in Triangle Strategy, ~17% in FFT.
If our units fill a third of the screen the composition is wrong — pull the camera back.

Do:
- Strong tilt-shift / DOF with quality bokeh and a controllable focus band.
- Colour grading via a real 3D LUT per map mood. Crush blacks toward the map's cool tone (blacks
  should be blue or warm-brown, never neutral) and push highlights warm. Neither reference uses
  neutral grey anywhere.
- Bloom: wide, soft, low intensity, physically-motivated threshold. Only genuinely bright things
  bloom. A global haze is a fail.
- Film grain and a strong dark vignette — both references have both, clearly visible.
- Verify the camera framing against the reference measurements above and fix the default zoom.
- Verify pixel-snapping: sprite texels must land on whole device pixels or the art shimmers.`,
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
    focus: `UI CRAFT.

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
