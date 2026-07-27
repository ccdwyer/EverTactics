/**
 * Portrait rendering and casting.
 *
 * The shipped face textures are 520x388 atlases; the assembled 128x192 portrait
 * sits at (391, 1). We display it by background-cropping the atlas at an integer
 * scale so the pixel art never resamples softly.
 *
 * Casting rules (round 2). The catalogue contains ~50 monster faces — chocobos,
 * malboros, dragons, goblins, pigs — mixed in with the human cast. Hashing a unit
 * id across the *whole* catalogue put a lizard, a goat and an octopus in the turn
 * rail next to twelve human sprites, which is a listed fail condition in
 * docs/VISUAL_TARGET.md. Selection is now three-tier:
 *
 *   1. explicit job + gender  -> the shipped generic-class portrait for that job
 *   2. gender only            -> a curated, gender-consistent human pool
 *   3. nothing                -> the same pool, hashed
 *
 * Monster faces are never picked implicitly; `monsterPortrait()` exposes them for
 * units that actually are monsters.
 */

import { div } from './dom';
import { PORTRAIT_ATLAS, PORTRAIT_FILES } from './portraitCatalog';

let base = '/assets/portraits/';

export function setPortraitBase(url: string): void {
  base = url.endsWith('/') ? url : `${url}/`;
}

export function portraitUrl(file: string): string {
  return `${base}${file}`;
}

/** All portrait filenames available on disk, humans and monsters alike. */
export function portraitFiles(): readonly string[] {
  return PORTRAIT_FILES;
}

// ─────────────────────────────────────────────────────────────────────────────
// Casting
// ─────────────────────────────────────────────────────────────────────────────

export type PortraitGender = 'male' | 'female' | 'neutral' | 'monster';

/**
 * Faces that are not human. `wldface_134`..`wldface_154` is one contiguous
 * monster block; the rest are one-off story beasts (Boco, Byblos, the zodiac
 * demons) that sit inside the human numbering.
 */
const MONSTER_FILE_NUMBERS: ReadonlySet<number> = new Set([
  60, 62, 64, 67, 69, 72, 73,
  134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144,
  145, 146, 147, 148, 149, 150, 151, 152, 153, 154,
]);

function fileNumber(file: string): number {
  const m = /^wldface_(\d+)_/.exec(file);
  return m?.[1] ? Number(m[1]) : -1;
}

function isMonsterFile(file: string): boolean {
  const n = fileNumber(file);
  return n >= 0 && MONSTER_FILE_NUMBERS.has(n);
}

/**
 * Job -> candidate faces, male list then female list, most-canonical first.
 *
 * `wldface_096`..`wldface_133` is the shipped generic-class cast in job order,
 * male on even numbers and female on odd. Each face ships five palette plates
 * (`_08`..`_12`) which are re-tints of the same drawing.
 *
 * The families below were read off a contact sheet of that block rather than
 * asserted from memory. The unambiguous anchors: 100/101 wear a gold gorget
 * (knight), 108/109 the wide-brimmed black-mage hat, 124/125 a samurai jingasa
 * over plate, 126/127 the ninja face-mask, 106/107 the white cleric hood, and
 * 122/123 a dragon-shaped helm.
 *
 * They are *families*, not single answers, and that is deliberate. One face per
 * job means every Knight in the party is literally the same drawing, which reads
 * as placeholder data — exactly the note the critics filed about Aldric and
 * Corvin both being Knight Lv 14. A family keeps the silhouette honest (armoured
 * man reads as armoured man) while letting a twelve-strong roster stay distinct.
 */
interface FaceFamily {
  readonly male: readonly number[];
  readonly female: readonly number[];
}

/* ROUND 7 — THE BLOCK IS THE JOB LIST, IN ORDER, AND IT WAS MIS-INDEXED.
   ---------------------------------------------------------------------------
   `wldface_096`..`wldface_131` is exactly 36 faces = 18 jobs x 2 genders, male on
   the even number and female on the odd, laid out in the game's own job order.
   Round 2 read the table off a contact sheet but only pinned six anchors and
   interpolated the rest, and the interpolation was off by one slot in the middle
   third — Mystic was pointed at 116, Geomancer at 118 and Orator at 130, when
   116/117 is the Orator, 118/119 the Mystic and 120/121 the Geomancer.

   Re-read from a contact sheet of the whole block (tools: the assembled cell of
   each `_08` plate, tiled 10 across). Every entry below is a thing visible in
   that sheet, not an inference:

     96/97   Squire        plain leather, bandana
     98/99   Chemist       soft billed cap
     100/101 Knight        white gorget over mail
     102/103 Archer        light hood, no armour
     104/105 Monk          blue brow-band, bare shoulders
     106/107 White Mage    white cowl
     108/109 Black Mage    wide straw hat, face in shadow, eyes lit
     110/111 Time Mage     tall red-and-purple hood
     112/113 Summoner      orange head-wrap
     114/115 Thief         green bandana / brown ponytail
     116/117 Orator        pale olive hood with a collar
     118/119 Mystic        dark close cap
     120/121 Geomancer     blue-and-gold brow-band
     122/123 Dragoon       dragon-crest full helm
     124/125 Samurai       jingasa and white scarf over plate
     126/127 Ninja         dark hood and face mask / red bandana
     128/129 Arithmetician bare-headed scholar
     130/131 Bard, Dancer  (the one gender-locked pair — 130 male, 131 female)

   132/133 are NOT the mime pair: 132 is a goggled mask and 133 is a chocobo
   head. Neither is ever cast, implicitly or otherwise. */
const JOB_PAIR: Readonly<Record<string, number>> = {
  squire: 96,
  chemist: 98,
  knight: 100,
  archer: 102,
  monk: 104,
  'white mage': 106,
  'black mage': 108,
  'time mage': 110,
  summoner: 112,
  thief: 114,
  orator: 116,
  mystic: 118,
  geomancer: 120,
  dragoon: 122,
  samurai: 124,
  ninja: 126,
  arithmetician: 128,
  bard: 130,
  dancer: 130,
};

/**
 * Where a job falls back to when its own pair is already taken.
 *
 * The fallback has to stay inside the archetype or the whole point is lost: a
 * second Knight wearing the Black Mage's straw hat is worse than two Knights.
 * These are silhouette families — armoured, light-and-quick, hatted caster,
 * hooded caster, courtly — read off the same contact sheet.
 */
const MARTIAL = [100, 122, 124, 96] as const;
const AGILE = [114, 126, 102, 104] as const;
const ARCANE = [108, 110, 112, 128] as const;
const DEVOUT = [106, 116, 118, 98] as const;
const COURTLY = [130, 120, 116] as const;

const JOB_ARCHETYPE: Readonly<Record<string, readonly number[]>> = {
  squire: MARTIAL,
  chemist: DEVOUT,
  knight: MARTIAL,
  archer: AGILE,
  monk: AGILE,
  thief: AGILE,
  'white mage': DEVOUT,
  'black mage': ARCANE,
  'time mage': ARCANE,
  summoner: ARCANE,
  mystic: DEVOUT,
  geomancer: DEVOUT,
  dragoon: MARTIAL,
  orator: COURTLY,
  samurai: MARTIAL,
  ninja: AGILE,
  arithmetician: ARCANE,
  bard: COURTLY,
  dancer: COURTLY,
  mime: COURTLY,
  'dark knight': MARTIAL,
  'onion knight': MARTIAL,

  // EverQuest II
  shadowknight: MARTIAL,
  templar: DEVOUT,
  coercer: ARCANE,
  beastlord: AGILE,
  warder: AGILE,
  troubador: COURTLY,
  dirge: COURTLY,

  // World of Warcraft
  'death knight': MARTIAL,
  warlock: ARCANE,
  druid: DEVOUT,
  paladin: MARTIAL,
  rogue: AGILE,
  shaman: DEVOUT,
};

/** Jobs with no face of their own borrow the archetype's leader. */
const JOB_ALIAS: Readonly<Record<string, string>> = {
  'dark knight': 'samurai',
  'onion knight': 'squire',
  mime: 'squire',
  shadowknight: 'knight',
  templar: 'white mage',
  coercer: 'time mage',
  beastlord: 'thief',
  warder: 'thief',
  troubador: 'bard',
  dirge: 'bard',
  'death knight': 'knight',
  warlock: 'black mage',
  druid: 'geomancer',
  paladin: 'knight',
  rogue: 'ninja',
  shaman: 'mystic',
};

/**
 * Build the ordered candidate list for a job: its own face first, then its
 * archetype siblings. `+1` on an even base is that job's female plate.
 */
function familyOf(job: string, gender: PortraitGender): number[] {
  const key = JOB_ALIAS[job] ?? job;
  const female = gender === 'female';
  const out: number[] = [];
  const own = JOB_PAIR[key];
  // 130/131 are the one gender-locked pair: Bard is male, Dancer is female, so
  // a female Bard takes the Dancer plate and vice versa rather than reading as
  // the wrong drawing entirely.
  if (own !== undefined) out.push(own + (female ? 1 : 0));
  for (const n of JOB_ARCHETYPE[key] ?? MARTIAL) {
    const f = n + (female ? 1 : 0);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** `{ male, female }` for a job, derived from the pair table above. */
function fam(job: string): FaceFamily {
  return { male: familyOf(job, 'male'), female: familyOf(job, 'female') };
}

/**
 * Keyed by the job's DISPLAY NAME lowercased ("white mage"), because that is
 * what `state/viewModels.portraitFor` hands us — not the kebab id. Written out
 * one job per line rather than generated from the key sets, so that the table of
 * jobs the HUD can dress is greppable and so `tests/content.test.ts` can assert
 * at source level that no job is missing.
 */
const JOB_FACE: Readonly<Record<string, FaceFamily>> = {
  // FFT spine — each of these has a face of its own in the 96..131 block.
  squire: fam('squire'),
  chemist: fam('chemist'),
  knight: fam('knight'),
  archer: fam('archer'),
  monk: fam('monk'),
  'white mage': fam('white mage'),
  'black mage': fam('black mage'),
  'time mage': fam('time mage'),
  summoner: fam('summoner'),
  thief: fam('thief'),
  orator: fam('orator'),
  mystic: fam('mystic'),
  geomancer: fam('geomancer'),
  dragoon: fam('dragoon'),
  samurai: fam('samurai'),
  ninja: fam('ninja'),
  arithmetician: fam('arithmetician'),
  bard: fam('bard'),
  dancer: fam('dancer'),

  // FFT jobs with no generic face of their own — aliased to the nearest one.
  mime: fam('mime'),
  'dark knight': fam('dark knight'),
  'onion knight': fam('onion knight'),

  // EverQuest II
  shadowknight: fam('shadowknight'),
  templar: fam('templar'),
  coercer: fam('coercer'),
  beastlord: fam('beastlord'),
  warder: fam('warder'),
  troubador: fam('troubador'),
  dirge: fam('dirge'),

  // World of Warcraft
  'death knight': fam('death knight'),
  warlock: fam('warlock'),
  druid: fam('druid'),
  paladin: fam('paladin'),
  rogue: fam('rogue'),
  shaman: fam('shaman'),
};

/* The Dragoon helm hides the face completely behind a dragon-crest faceplate.
   That is correct art for a Dragoon — it is what the shipped game draws, and it
   is the reason the enemy line reads as a different silhouette from ours — but
   it may never turn up on a JOBLESS unit, where a faceless helm in the turn rail
   is the "there's a lizard in the queue" note we spent two rounds fixing. */
const DRAGON_HELM = [122, 123] as const;

/** Files whose face number is `n`, neutral palette first. */
function facesNumbered(n: number): readonly string[] {
  const prefix = `wldface_${String(n).padStart(3, '0')}_`;
  return PORTRAIT_FILES.filter((f) => f.startsWith(prefix));
}

/**
 * The curated pool used when no job is known. Order is stable, so a given id
 * always lands on the same face for the life of a save.
 */
function buildPool(gender: PortraitGender): readonly string[] {
  const jobLow = 96;
  const jobHigh = 131; // 132/133 are the mime masks — never cast implicitly.
  const out: string[] = [];

  // Only the generic-class block. It is one illustrator, one line weight, one
  // palette discipline — "one art direction, not a grab bag". The story faces
  // (bearded lords, hooded elders, wounded nobles) are lovely but they read as a
  // different cast standing next to twelve rank-and-file sprites, so they are
  // reserved for units that explicitly name a portrait.
  //
  // Every face ships five palette plates (_08.._12). Those are re-tints of the
  // same drawing — different hair and cloth colour, same person — which is
  // exactly how the shipped game fields a squad of generics without repeating a
  // head. Including them takes the pool from 18 to ~90 per gender.
  for (let n = jobLow; n <= jobHigh; n++) {
    if (DRAGON_HELM.includes(n as 122 | 123)) continue;
    const isFemale = n % 2 === 1;
    if (gender === 'male' && isFemale) continue;
    if (gender === 'female' && !isFemale) continue;
    for (const f of facesNumbered(n)) out.push(f);
  }
  return out;
}

const POOLS: Record<PortraitGender, readonly string[]> = {
  male: buildPool('male'),
  female: buildPool('female'),
  neutral: buildPool('neutral'),
  // A chocobo with a knight's face is the same defect in the other direction.
  monster: PORTRAIT_FILES.filter(isMonsterFile),
};

/**
 * Reverse index: face file -> which gendered pool it belongs to.
 *
 * Built from the WHOLE generic-class block (96..131 by parity), not from POOLS —
 * and that difference is a bug fix, not a detail. POOLS deliberately withholds
 * the Dragoon helm from implicit casting, so building this index off POOLS left
 * 122/123 unmapped, which every caller reads as "this is authored story art,
 * leave it alone". The result was visible in the round-7 rail: a Knight rolled a
 * Dragoon helm out of his own job family, that face was then mistaken for
 * authored art and pinned, and the actual Dragoon standing four chips below him
 * had to fall back to the Knight's gorget. The two units swapped heads.
 *
 * This map answers "is this one of the interchangeable generic faces?" — POOLS
 * answers "may this face be handed to a unit we know nothing about?". They are
 * different questions and they now have different answers.
 */
const POOL_OF = new Map<string, PortraitGender>();
for (let n = 96; n <= 131; n++) {
  const g: PortraitGender = n % 2 === 1 ? 'female' : 'male';
  for (const f of facesNumbered(n)) POOL_OF.set(f, g);
}
for (const f of POOLS.monster) if (!POOL_OF.has(f)) POOL_OF.set(f, 'monster');

/**
 * Upgrade an auto-cast portrait to the job-correct one.
 *
 * The game layer hands the HUD a portrait it derived from a hash of the unit id,
 * which cannot know the unit's job — so a Knight can arrive wearing a Time Mage's
 * hat. This closes that loop without the HUD overriding authored art:
 *
 *   - a face that is NOT in the generic-class pool was deliberately assigned
 *     (a named story character); it is returned untouched.
 *   - a face that IS in the pool was auto-cast, and the pool it came from tells
 *     us the unit's gender, so we can re-cast on job + that gender.
 */
export function castPortrait(
  id: string,
  assigned: string | undefined,
  opts: { job?: string; gender?: PortraitGender | string } = {},
): string | undefined {
  // The group cast wins over any per-unit answer — see the note on CAST.
  const fixed = CAST.get(id);
  if (fixed && (!opts.job || fixed.job === String(opts.job).trim().toLowerCase())) return fixed.file;
  const inferred = assigned ? POOL_OF.get(assigned) : undefined;
  if (assigned && !inferred) return assigned;
  if (!opts.job) return assigned;
  const gender = opts.gender ? genderOf(String(opts.gender)) : (inferred ?? genderOf(id));
  return portraitForUnit(id, { job: opts.job, gender });
}

/** Face numbers a unit of this job+gender could wear, most canonical first. */
function familyFor(job: string | undefined, gender: PortraitGender): readonly number[] {
  const fam = job ? JOB_FACE[job.trim().toLowerCase()] : undefined;
  if (!fam) return [];
  return gender === 'female' ? fam.female : fam.male;
}

export interface RosterCastInput {
  readonly id: string;
  readonly portrait?: string | undefined;
  readonly job?: string | undefined;
  readonly gender?: PortraitGender | string | undefined;
}

/**
 * Cast a WHOLE group at once, with no two units wearing the same drawing.
 *
 * `castPortrait` is per-unit and therefore blind to its neighbours, and a hash
 * over a three- or four-face job family collides constantly: measured on the
 * `battle-open` rail, Nessa (Thief) and Quill (Thief) both landed on face 115
 * and appeared in the turn column four chips apart as the same woman in two
 * bandana colours. Two identical drawings inside one eight-chip rail is exactly
 * the "placeholder data" read the critics filed against the roster strip, and no
 * amount of per-unit hashing can fix it — the constraint is between units.
 *
 * So: one pass, three tiers, deterministic in list order.
 *   1. an authored (non-pool) portrait is inviolable and claims its face number;
 *   2. each remaining unit takes the most canonical UNUSED face in its job
 *      family, so the Black Mage gets the black-mage hat before it gets the
 *      fourth-choice arcane face;
 *   3. if a family is exhausted, fall back to the gendered pool scanning from a
 *      hashed start until an unused drawing turns up.
 *
 * Palette plates (`_08`.._12` — the same drawing re-tinted) are only ever used to
 * separate two units that genuinely had to share a face number.
 */
export function castRoster(units: readonly RosterCastInput[]): (string | undefined)[] {
  const usedFace = new Set<number>();
  const usedFile = new Set<string>();
  const out: (string | undefined)[] = new Array(units.length).fill(undefined);

  // Pass 0 — anything already cast keeps its face, INCLUDING units not in this
  // call. Two reasons, and the first is a bug this function would otherwise have
  // shipped: the rail is re-cast every time the queue reorders, and the queue
  // reorders constantly, so "first come, first served over the list" would hand a
  // unit a different drawing every time a Haste moved it up the column. Faces
  // must be sticky for the life of the battle. The second is that units off the
  // current queue (dead, delayed, not yet summoned) still hold their drawing so
  // nobody inherits it while they are away.
  for (const [id, prev] of CAST) {
    const i = units.findIndex((u) => u.id === id);
    // A unit that has CHANGED JOB re-casts: its face is meant to say what it
    // does, and a Squire promoted to Dragoon keeping the leather cap is the same
    // defect as a Dragoon wearing it in the first place. Its old drawing is
    // released in that case so the job it left can use it again.
    if (i >= 0 && jobKey(units[i]) !== prev.job) continue;
    usedFace.add(fileNumber(prev.file));
    usedFile.add(prev.file);
    if (i >= 0) out[i] = prev.file;
  }

  // Pass 1 — authored art wins and reserves its drawing.
  units.forEach((u, i) => {
    const p = u.portrait;
    if (out[i] !== undefined || !p || POOL_OF.has(p)) return;
    out[i] = p;
    usedFace.add(fileNumber(p));
    usedFile.add(p);
  });

  // Pass 2 — everyone else, in list order so the result is stable.
  units.forEach((u, i) => {
    if (out[i] !== undefined) return;
    const inferred = u.portrait ? POOL_OF.get(u.portrait) : undefined;
    const gender = u.gender ? genderOf(String(u.gender)) : (inferred ?? genderOf(u.id));
    const n = pickFace(u, gender, usedFace);
    if (n !== undefined) usedFace.add(n);
    const file = pickPlate(u.id, n, gender, usedFile);
    usedFile.add(file);
    out[i] = file;
  });

  units.forEach((u, i) => {
    const f = out[i];
    if (f !== undefined) CAST.set(u.id, { file: f, job: jobKey(u) });
  });
  return out;
}

function jobKey(u: RosterCastInput | undefined): string {
  return (u?.job ?? '').trim().toLowerCase();
}

/**
 * Faces the group cast has already committed to, unit id -> file.
 *
 * The turn rail is the only place that sees every combatant at once, so it is
 * the only place that can de-duplicate — but the acting-unit band, the inspect
 * card and the target preview all draw the SAME units independently. Left to
 * themselves they hash their own answer, and round 7's first pass shipped Aldric
 * wearing face 100 in the rail and face 124 in the panel eighteen pixels apart.
 * One shared registry keeps every surface showing one person.
 */
const CAST = new Map<string, { file: string; job: string }>();

/** Drop the group cast — call when the battle roster changes wholesale. */
export function resetCast(): void {
  CAST.clear();
}

/** The face NUMBER this unit should wear, avoiding any already spoken for. */
function pickFace(
  u: RosterCastInput,
  gender: PortraitGender,
  used: ReadonlySet<number>,
): number | undefined {
  if (gender === 'monster') return undefined;
  const family = familyFor(u.job, gender);
  for (const n of family) if (!used.has(n)) return n;
  // Family exhausted (or unknown job): scan the gendered pool from a hashed
  // start so a jobless unit still lands somewhere stable and unshared.
  const pool = POOLS[gender].length > 0 ? POOLS[gender] : POOLS.neutral;
  if (pool.length === 0) return family[0];
  const start = hash(u.id) % pool.length;
  for (let k = 0; k < pool.length; k++) {
    const f = pool[(start + k) % pool.length];
    const n = f === undefined ? -1 : fileNumber(f);
    if (n >= 0 && !used.has(n)) return n;
  }
  return family[hash(u.id) % Math.max(1, family.length)];
}

/** A palette plate of face `n`, preferring one no other unit is already wearing. */
function pickPlate(
  id: string,
  n: number | undefined,
  gender: PortraitGender,
  usedFile: ReadonlySet<string>,
): string {
  if (n === undefined || n < 0) return portraitForId(id, gender);
  const variants = facesNumbered(n);
  if (variants.length === 0) return portraitForId(id, gender);
  const start = hash(`${id}#plate`) % variants.length;
  for (let k = 0; k < variants.length; k++) {
    const f = variants[(start + k) % variants.length];
    if (f !== undefined && !usedFile.has(f)) return f;
  }
  return variants[start] ?? portraitForId(id, gender);
}

/** Every human face on disk, for roster / editor pickers. */
export function humanPortraitFiles(): readonly string[] {
  return PORTRAIT_FILES.filter((f) => !isMonsterFile(f));
}

/** All monster faces, for units that genuinely are monsters. */
export function monsterPortraitFiles(): readonly string[] {
  return PORTRAIT_FILES.filter(isMonsterFile);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function genderOf(key: string): PortraitGender {
  const low = key.toLowerCase();
  if (/(^|[:_\-\s])monster\b/.test(low)) return 'monster';
  if (/(^|[:_\-\s])female\b/.test(low)) return 'female';
  if (/(^|[:_\-\s])male\b/.test(low)) return 'male';
  return 'neutral';
}

/**
 * Portrait for a unit whose job is known.
 *
 * Preferred entry point: it is the only one that can honour "the portrait must
 * look like the job the unit is actually doing". `id` still seeds the palette
 * choice so two Knights of the same gender are not byte-identical chips.
 */
export function portraitForUnit(
  id: string,
  opts: { job?: string; gender?: PortraitGender | string } = {},
): string {
  const gender = opts.gender ? genderOf(String(opts.gender)) : genderOf(id);
  if (gender === 'monster') return portraitForId(id, gender);
  const family = opts.job ? JOB_FACE[opts.job.trim().toLowerCase()] : undefined;
  if (family) {
    const faces = gender === 'female' ? family.female : family.male;
    // THE JOB'S OWN FACE, not a hashed pick inside its family.
    //
    // Round 2 hashed across the family so two Knights would not be the same
    // drawing. That trades the thing being judged (does the portrait look like
    // the job?) for a thing nothing was complaining about — and it does not even
    // work, because a hash over a four-entry list collides constantly anyway.
    // Distinctness is now `castRoster`'s job and it solves it properly, by
    // looking at the other units. This function's only job is to be correct:
    // slot 0 is the job's own generic face, so a Knight is a Knight. The hash
    // still chooses the PALETTE plate, so two Knights differ in hair and cloth
    // colour the way a squad of generics does in the shipped game.
    const n = faces[0];
    if (n !== undefined) {
      const variants = facesNumbered(n);
      const pick = variants[hash(`${id}#plate`) % Math.max(1, variants.length)];
      if (pick) return pick;
    }
  }
  return portraitForId(id, gender);
}

/**
 * Deterministic portrait pick for a unit that has no explicit one assigned.
 * Same id always yields the same face, so rosters stay stable across sessions.
 *
 * The id is expected to carry the gender as a suffix (`"u_aldric:female"`),
 * which is what `state/viewModels.ts` passes; the pool is filtered accordingly
 * and never contains a monster.
 */
export function portraitForId(id: string, gender?: PortraitGender): string {
  const pool = POOLS[gender ?? genderOf(id)];
  const fallback = POOLS.neutral;
  const list = pool.length > 0 ? pool : fallback;
  return list[hash(id) % list.length] ?? list[0] ?? PORTRAIT_FILES[0] ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

export type PortraitSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Displayed widths in CSS pixels; heights follow the 128:192 (2:3) aspect.
 *
 * Measured off `refs/curated/fft/press-042310-cfaa9b3e-fft-tic-mediakit-06.png`
 * at 1080p: the combat-timeline chips are ~62px wide and the active-unit face is
 * ~116px. Round 1 ran 20-30% larger than the shipped game and the HUD ate the
 * board; these are the reference numbers.
 */
/*
 * `xl` is the acting-unit face in the bottom-left band, and it is sized to FILL
 * that panel's height rather than to a nominal chip width. In the shipped frame
 * the acting portrait is 118x190 inside a 210-tall panel — it runs edge to edge,
 * which is what makes the band read as a portrait plate with data beside it
 * rather than as a data panel with a stamp in the corner. At `lg` (104x156) our
 * portrait left 77px of bare navy below it, i.e. the same "empty region of flat
 * panel colour" the critics keep naming, only in the chrome instead of the map.
 */
/*
 * Round 6 — `sm` and `md` are the two rail sizes, and they were too small
 * RELATIVE TO THEIR CHIP rather than in absolute terms.
 *
 * In refs/curated/fft/press-042310-...-mediakit-06.png a Combat Timeline entry
 * is roughly 70px wide and the face inside it is roughly 62px: the portrait IS
 * the chip, and the tick numeral lives in a narrow ~22px column outside it. Ours
 * ran a 46px face inside a 116px chip — 40% face, 60% empty navy — so the rail
 * read as a column of half-filled cards, which is the "ragged dead column"
 * problem the round-3 note tried to fix by stretching the chips rather than by
 * filling them. 54/64 puts the face at ~47% and ~55% of the chip and leaves the
 * tick column at 50px and 39px respectively, both still comfortable for a
 * two-digit numeral in the display face.
 */
const SIZES: Record<PortraitSize, number> = { xs: 30, sm: 54, md: 64, lg: 104, xl: 130 };

export interface PortraitOptions {
  size?: PortraitSize;
  /** Crop to the head only — used by the compact turn-order chips. */
  head?: boolean;
  /** Extra classes on the wrapper. */
  className?: string;
}

/**
 * Build a framed portrait element. The frame is CSS; the inner node is a scaled
 * crop of the atlas. Falls back to an engraved silhouette when no file is given.
 */
export function portrait(file: string | undefined, opts: PortraitOptions = {}): HTMLDivElement {
  const size = opts.size ?? 'md';
  const w = SIZES[size];
  const wrap = div(`et-portrait et-portrait--${size}${opts.className ? ` ${opts.className}` : ''}`);

  // A head crop takes the TOP OF THE FULL PORTRAIT, not the atlas `heads` cells.
  //
  // Two traps here, both hit in turn:
  //  1. Drawing `full` (128x192) into a frame shortened to w*5/6 shows only the
  //     top of a much taller image — hair and forehead, face below the window.
  //     That is the "you just see the top of their heads" rail bug.
  //  2. The atlas `heads` cells look like the fix and are not. They are upper-
  //     face plates cut off at the chin, used by FFT's expression compositor
  //     together with the separate mouth cells further down the sheet. Rendering
  //     one alone gives a face with no jaw.
  //
  // So: same cell, cropped to a near-square that ends just below the chin, and
  // the frame derived from that crop so the two cannot drift apart.
  // Where to cut the head crop, measured off the atlas rather than guessed.
  // Alpha-coverage profile of cell (391,1,128,192) in wldface_100_08: the run
  // narrows monotonically from y=48 (118px wide) to a minimum of 62px at
  // y=120-128 — that minimum IS the neck — and widens again from y=136 as the
  // shoulders come in. So the chin sits at roughly y=138.
  //
  // Round 2 cut at 132, i.e. ABOVE the chin, which is why every face in the rail
  // rendered clipped through the mouth — the critics' "cropped sprite heads at
  // inconsistent crops and inconsistent eye-lines". 148 clears the jaw and takes
  // ten pixels of collar with it, so the crop reads as a portrait bust rather
  // than as a face with the bottom sliced off.
  const HEAD_CROP_H = 156;
  const full = PORTRAIT_ATLAS.full;
  const cell = opts.head ? { ...full, h: Math.min(HEAD_CROP_H, full.h) } : full;
  const frameH = Math.round((w * cell.h) / cell.w);
  wrap.style.width = `${w}px`;
  wrap.style.height = `${frameH}px`;

  const img = div('et-portrait__img');
  if (file) {
    // Scale so the 128px-wide crop exactly fills the frame width.
    const scale = w / cell.w;
    img.style.backgroundImage = `url("${portraitUrl(file)}")`;
    img.style.backgroundSize = `${PORTRAIT_ATLAS.sheetWidth * scale}px ${PORTRAIT_ATLAS.sheetHeight * scale}px`;
    img.style.backgroundPosition = `${-cell.x * scale}px ${-cell.y * scale}px`;
    img.style.width = `${w}px`;
    img.style.height = `${cell.h * scale}px`;
  } else {
    img.classList.add('et-portrait__img--empty');
  }
  wrap.appendChild(img);
  wrap.appendChild(div('et-portrait__gloss'));
  return wrap;
}
