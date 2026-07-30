# Road to v0.2 — a proposal

v0.1 is done and measured. The loop closes, persistence is byte-identical across a refresh, the
campaign has a difficulty curve, battles run at FFT tempo, and the seven battle-UX gaps Chris named
from real FFT footage are all closed. 597 tests, gates green, repo verified from a clean clone.

**This document is a proposal, not a plan of record.** Nothing here is committed to until Chris
picks. See "What I would do" at the end for a recommendation.

---

## Where v0.1 actually leaves us

| | state |
|---|---|
| Battle rules | Complete and deterministic |
| Jobs | 34, ~395 abilities, unlock tree — but the campaign only ever fields six units |
| Campaign loop | Title → map → formation → battle → rewards → shop → map, persisted |
| Content | 6 maps, 10 encounters, 2 chapters, 14 world nodes |
| Balance | Measured across 12 seeds per encounter; chapter 1 ~85% wins, chapter 2 ~45% ending at 25% |
| Battle UX | Camera follows the action, range legible, enemies coloured, any unit inspectable |

**The obvious gap: the party never changes.** You start with six units and finish with the same
six. Every recruitment, hiring, story-join and permadeath system that makes an FFT campaign feel
like *yours* is absent. 34 jobs exist and a playthrough meaningfully touches six of them.

---

## Candidate scope, in dependency order

### 1. Recruitment — the highest-leverage single feature
Hire generic units at a town node, FFT-style: pick gender, name, starting job, roll stats from the
seeded `Rng`. Story-joined named units later.

Everything it needs already exists: `PersistedUnit`, the roster editor, gil, and town nodes. The
one prerequisite was **duplicate roster ids**, which was deliberately fixed in v0.1 step 9 *because*
recruitment would be the thing that mints ids.

**Estimate: medium.** Highest ratio of "campaign feels alive" to work required.

### 2. Permadeath, or an explicit decision not to have it
FFT's three-turn crystal timer is the mechanic that makes losing a unit *mean* something, and it is
the reason recruitment matters. This is a design decision, not an engineering one — a game with
recruitment and no loss is a game where the roster only grows.

**Estimate: small once decided.** The status engine and knockdown attribution already exist.

### 3. Chapter 3 and the rest of the arc
Two chapters and ten encounters is a demo arc. A v0.2 campaign wants perhaps 18–24 encounters
across four chapters, with the world map's branch structure actually used.

Content authoring is now cheap — maps and encounters are data (v0.1 step 7) and balance is
measurable (step 19). **Estimate: large, mostly authoring.**

### 4. Story
There is currently no narrative at all: no dialogue, no cutscenes, no reason the company fights.
The world map already has `event` node types that nothing uses.

**Estimate: large, and the least like the rest of this project** — it is writing, not systems.

### 5. The job system made to matter
34 jobs, ~395 abilities, and a campaign that fields six units barely touches them. Job unlocks are
gated on JP which is gated on battles, and there are only ten. This is partly fixed by (1) and (3)
rather than by touching the job system itself.

---

## What I would do

**Recruitment first, then permadeath, then content.** Those three together turn a campaign you play
into a company you own, and they compound: recruitment is what makes loss matter, loss is what makes
recruitment matter, and content is what gives both room to operate.

Story last — not because it is unimportant, but because it is the piece least dependent on
everything else and the most likely to be rewritten once the campaign's shape is known.

I would explicitly **not** start with more jobs or abilities. There are already more than a v0.2
campaign can teach, and `docs/ROADMAP-v0.1.md` records that lesson.

---

## Decided

1. **Permadeath: FFT's crystal timer.** A downed unit has a few turns before it is gone for good.
   Chris chose this over KO-only and over a toggle. It is what the step-1 recruitment system exists
   to feed, and it settles the question the roadmap called the one that shapes the rest.
2. **Campaign length: keep two chapters and deepen them.** No chapter 3. Instead: optional side
   encounters, random battles, and town content on the existing map. This changes item 3 below from
   "author chapters 3-4" to "make the existing map worth revisiting".

## Still open for Chris
1. **Story: authored, or a light framing?** A full script is a different project; named characters
   and a paragraph per battle is not.
2. **Blind-judge round?** Still unspent, still the original success metric, and the renderer has
   changed materially since the last one (highlight rolloff, enemy palettes, range overlay).
