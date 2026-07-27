export const meta = {
  name: 'evertactics-same-game',
  description: 'Discrimination test: can judges separate our frame from a shipped game any better than they separate two shipped games from each other?',
  phases: [{ title: 'Discriminate', detail: 'same-game judgements across control and test pairs' }],
}

const ROOT = '/Users/chris/Developer/EverTactics'
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const shot = A.shot || 'shots/post-defects.png'
const crop = A.crop || 0.6

/**
 * WHY THIS TEST EXISTS
 *
 * The previous protocol asked "which of these is the shipped commercial game?".
 * That measures *identification*, and we came out at ~30% across 36 pairs — i.e.
 * judges systematically pick OUR frame as the shipped one. That is a striking
 * result but it does NOT establish indistinguishability: indistinguishable means
 * 50%, and being reliably picked is its own kind of distinguishable. A judge who
 * uses "more impressive" as a shorthand for "shipped" produces exactly this.
 *
 * So: drop the prototype framing entirely. Show two frames, ask only whether they
 * come from the SAME game or two DIFFERENT games, and compare three conditions:
 *
 *   control-same : two frames from the same shipped title
 *   control-diff : two frames from demonstrably different shipped titles
 *   test         : our frame beside a shipped title
 *
 * If judges call `test` "different games" at roughly the rate they call
 * `control-diff` different, we are separable — a real gap remains.
 * If they call it "different" at roughly the `control-same` rate, our frame is
 * sitting inside the between-shipped-titles noise, which is the honest operational
 * meaning of indistinguishable.
 *
 * The control-diff arm is what makes the test interpretable at all: it establishes
 * that these judges CAN separate two real games under this crop, so a null result
 * on the test arm means something.
 */

// Triangle Strategy frames (same title).
const TRI = [
  'press_002_gematsu_1920x1080.jpg', 'press_004_gematsu_1920x1080.jpg',
  'official_009_steam.jpg', 'official_033_se_screenshot.jpg',
  'official_003_steam.jpg', 'official_019_se_screenshot.jpg',
]
// official_029 is Vanillaware's Unicorn Overlord, not Triangle Strategy — a
// different shipped title, verified visually. That is what makes it a control.
const OTHER = ['official_029_se_screenshot.png']

const PAIRS = [
  // control-same: Triangle vs Triangle
  { kind: 'control-same', a: `refs/curated/triangle/${TRI[0]}`, b: `refs/curated/triangle/${TRI[1]}` },
  { kind: 'control-same', a: `refs/curated/triangle/${TRI[2]}`, b: `refs/curated/triangle/${TRI[3]}` },
  { kind: 'control-same', a: `refs/curated/triangle/${TRI[4]}`, b: `refs/curated/triangle/${TRI[5]}` },
  { kind: 'control-same', a: `refs/curated/triangle/${TRI[0]}`, b: `refs/curated/triangle/${TRI[3]}` },
  // control-diff: Triangle vs Unicorn Overlord
  { kind: 'control-diff', a: `refs/curated/triangle/${TRI[0]}`, b: `refs/curated/triangle/${OTHER[0]}` },
  { kind: 'control-diff', a: `refs/curated/triangle/${TRI[2]}`, b: `refs/curated/triangle/${OTHER[0]}` },
  { kind: 'control-diff', a: `refs/curated/triangle/${TRI[4]}`, b: `refs/curated/triangle/${OTHER[0]}` },
  { kind: 'control-diff', a: `refs/curated/triangle/${TRI[5]}`, b: `refs/curated/triangle/${OTHER[0]}` },
  // test: ours vs Triangle
  { kind: 'test', a: shot, b: `refs/curated/triangle/${TRI[0]}` },
  { kind: 'test', a: shot, b: `refs/curated/triangle/${TRI[1]}` },
  { kind: 'test', a: shot, b: `refs/curated/triangle/${TRI[2]}` },
  { kind: 'test', a: shot, b: `refs/curated/triangle/${TRI[3]}` },
  { kind: 'test', a: shot, b: `refs/curated/triangle/${TRI[4]}` },
  { kind: 'test', a: shot, b: `refs/curated/triangle/${TRI[5]}` },
]

const SCHEMA = {
  type: 'object',
  properties: {
    sameGame: { type: 'boolean', description: 'true if both frames come from the same game' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
  },
  required: ['sameGame', 'confidence', 'reasoning'],
  additionalProperties: false,
}

phase('Discriminate')
log(`Discrimination test on ${shot}: ${PAIRS.length} pairs across three conditions.`)

const results = await pipeline(
  PAIRS.map((p, i) => ({ ...p, i })),
  async (p) => {
    const dir = `shots/samegame/pair-${p.i}`
    await agent(
      `Run exactly this in ${ROOT} and report the output. Do nothing else.
cd ${ROOT} && node tools/ab.mjs --ours "${p.a}" --ref "${p.b}" --out ${dir} --swap ${p.i % 2} --crop ${crop}`,
      { label: `build-${p.i}`, phase: 'Discriminate', effort: 'low' },
    )
    return { ...p, dir }
  },
  async (p) =>
    agent(
      `You are a senior art director with deep knowledge of the tactical RPG genre.

READ both images with the Read tool and study them:
  ${ROOT}/${p.dir}/left.png
  ${ROOT}/${p.dir}/right.png

Answer ONE question: **are these two frames from the SAME game, or from two DIFFERENT games?**

Both are centre-cropped and normalised to identical resolution, so most HUD chrome is gone and file
properties tell you nothing. Judge by rendering: lighting model, material vocabulary, shadow
behaviour, atmosphere, grade, sprite integration, geometry authorship.

Do not speculate about which titles they are, and do not assume either is a prototype — some pairs
are two frames from one shipped game, some are frames from two different shipped games.

Give a boolean (same game or not), your confidence 0-100, and your reasoning grounded in specific
rendering evidence.`,
      { label: `judge-${p.i}`, phase: 'Discriminate', effort: 'high', schema: SCHEMA },
    ).then((v) => (v ? { ...v, kind: p.kind, pair: p.i } : null)),
)

const v = results.filter(Boolean)
const rate = (k) => {
  const rows = v.filter((x) => x.kind === k)
  const diff = rows.filter((x) => !x.sameGame).length
  return { n: rows.length, calledDifferent: diff, pct: rows.length ? Math.round((diff / rows.length) * 100) : 0 }
}

const cs = rate('control-same')
const cd = rate('control-diff')
const t = rate('test')

log(`control-same called DIFFERENT: ${cs.calledDifferent}/${cs.n} (${cs.pct}%)`)
log(`control-diff called DIFFERENT: ${cd.calledDifferent}/${cd.n} (${cd.pct}%)  <- judges' ability to separate two real games`)
log(`test (ours vs shipped)  DIFFERENT: ${t.calledDifferent}/${t.n} (${t.pct}%)`)

return {
  shot,
  controlSame: cs,
  controlDifferent: cd,
  test: t,
  interpretation:
    't.pct near cd.pct => separable, a real gap remains. t.pct near cs.pct => our frame sits inside the between-shipped-titles noise.',
  reasoning: v.map((x) => ({ kind: x.kind, same: x.sameGame, conf: x.confidence, why: (x.reasoning || '').slice(0, 300) })),
}
