export const meta = {
  name: 'evertactics-judge-only',
  description: 'Blind-judge the current frame against shipped SRPG references. No fixing — measurement only.',
  phases: [{ title: 'Judge', detail: 'blind A/B, one independent judge per pair' }],
}

const ROOT = '/Users/chris/Developer/EverTactics'
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const shot = A.shot || 'shots/ad-final.png'
const seed = A.seed || 7
const crop = A.crop || 0.6

const REFS = [
  'official_001_steam.jpg', 'official_003_steam.jpg', 'official_009_steam.jpg',
  'official_019_se_screenshot.jpg', 'official_024_se_screenshot.png',
  'press_002_gematsu_1920x1080.jpg', 'official_006_steam.jpg',
  'official_020_se_screenshot.jpg', 'official_026_se_screenshot.png',
  'official_031_se_screenshot.jpg', 'press_004_gematsu_1920x1080.jpg',
  'official_002_steam.jpg', 'official_005_steam.jpg', 'official_007_steam.jpg',
  'official_008_steam.jpg', 'official_010_steam.jpg', 'official_016_nintendo.jpg',
  'official_021_se_screenshot.jpg',
]

const SCHEMA = {
  type: 'object',
  properties: {
    guess: { type: 'string', enum: ['left', 'right'] },
    confidence: { type: 'number' },
    better: { type: 'string', enum: ['left', 'right'] },
    coherent: { type: 'string', enum: ['left', 'right'], description: 'Which reads more as ONE picture rather than several systems overlapping' },
    tells: { type: 'array', items: { type: 'string' } },
  },
  required: ['guess', 'confidence', 'better', 'coherent', 'tells'],
  additionalProperties: false,
}

phase('Judge')

const pairs = REFS.map((ref, i) => ({ i, ref, swap: (i + seed) % 2 === 1 }))
log(`Judging ${pairs.length} pairs against ${shot}`)

const verdicts = await pipeline(
  pairs,
  async (p) => {
    const dir = `shots/judgeonly/pair-${p.i}`
    await agent(
      `Run exactly this in ${ROOT} and report the output. Do nothing else.
cd ${ROOT} && node tools/ab.mjs --ours ${shot} --ref "refs/curated/triangle/${p.ref}" --out ${dir} --swap ${p.swap ? 1 : 0} --crop ${crop}`,
      { label: `pair-${p.i}`, phase: 'Judge', effort: 'low' },
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
prototype. They are normalised to identical resolution and encoding and centre-cropped, so file
properties and most HUD chrome tell you nothing. Which side is which is not recorded on disk.

Judge the RENDERING — materials, lighting, shadow, atmosphere, depth, cohesion. If the only thing
separating them for you is text, naming or UI convention, say so in your tells; that is recognition,
not quality.

Answer: which side is the shipped game and how confident (0-100); which simply looks better; which
reads more as ONE coherent picture rather than several good systems overlapping; and the concrete
visual tells. Be specific and merciless, but do not invent a difference that is not there — if you
cannot tell, that is the finding.`,
      { label: `judge-${p.i}`, phase: 'Judge', effort: 'high', schema: SCHEMA },
    ).then((v) => (v ? { ...v, pair: p.i, oursSide: p.swap ? 'right' : 'left', ref: p.ref } : null)),
)

const v = verdicts.filter(Boolean)
const caught = v.filter((x) => x.guess !== x.oursSide).length
const preferred = v.filter((x) => x.better === x.oursSide).length
const cohesive = v.filter((x) => x.coherent === x.oursSide).length
const meanConf = v.length ? v.reduce((s, x) => s + (x.confidence || 0), 0) / v.length : 0

log(`identified correctly ${caught}/${v.length} · preferred ours ${preferred}/${v.length} · ours more coherent ${cohesive}/${v.length} · mean confidence ${meanConf.toFixed(0)}`)

return {
  shot,
  n: v.length,
  identifiedCorrectly: caught,
  preferredOurs: preferred,
  oursMoreCoherent: cohesive,
  meanConfidence: Math.round(meanConf),
  tells: v.flatMap((x) => x.tells || []).slice(0, 40),
}
