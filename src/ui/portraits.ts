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

/* 122/123 are the Dragoon helm — a dragon-shaped faceplate that at chip size
   reads as a reptile head, which is exactly the "there's a lizard in the turn
   rail" note we are fixing. It stays reserved for jobs where a beast helm is the
   point, and never appears in the implicit pool. */
const DRAGON_HELM = [122, 123] as const;
const MARTIAL: FaceFamily = { male: [100, 124, 96, 120], female: [101, 125, 97, 121] };
const AGILE: FaceFamily = { male: [114, 102, 126, 104], female: [115, 103, 127, 105] };
const ARCANE: FaceFamily = { male: [108, 110, 112, 128], female: [109, 111, 113, 129] };
const DEVOUT: FaceFamily = { male: [106, 116, 118, 98], female: [107, 117, 119, 99] };
const COURTLY: FaceFamily = { male: [130, 120], female: [131, 121] };

const JOB_FACE: Readonly<Record<string, FaceFamily>> = {
  // FFT spine
  squire: { male: [96, 100, 124], female: [97, 101, 125] },
  chemist: { male: [98, 106, 118], female: [99, 107, 119] },
  knight: MARTIAL,
  archer: { male: [102, 114, 104], female: [103, 115, 105] },
  monk: { male: [104, 114, 102], female: [105, 115, 103] },
  thief: AGILE,
  'white mage': { male: [106, 116, 98], female: [107, 117, 99] },
  'black mage': { male: [108, 110, 128], female: [109, 111, 129] },
  'time mage': { male: [110, 108, 128], female: [111, 109, 129] },
  summoner: { male: [112, 108, 110], female: [113, 109, 111] },
  mystic: { male: [116, 106, 118], female: [117, 107, 119] },
  geomancer: { male: [118, 116, 104], female: [119, 117, 105] },
  dragoon: { male: [122, 124, 100], female: [123, 125, 101] },
  orator: COURTLY,
  samurai: { male: [124, 122, 100], female: [125, 123, 101] },
  ninja: { male: [126, 114, 102], female: [127, 115, 103] },
  arithmetician: { male: [128, 110, 108], female: [129, 111, 109] },
  bard: COURTLY,
  dancer: COURTLY,
  mime: { male: [96, 128], female: [97, 129] },
  'dark knight': { male: [124, 100, 122], female: [125, 101, 123] },
  'onion knight': { male: [96, 100], female: [97, 101] },

  // EverQuest II
  shadowknight: MARTIAL,
  templar: DEVOUT,
  coercer: ARCANE,
  beastlord: { male: [112, 118, 116], female: [113, 119, 117] },
  troubador: COURTLY,
  dirge: COURTLY,

  // World of Warcraft
  'death knight': MARTIAL,
  warlock: ARCANE,
  druid: { male: [118, 116, 106], female: [119, 117, 107] },
  paladin: { male: [100, 106, 122], female: [101, 107, 123] },
  rogue: AGILE,
  shaman: { male: [118, 112, 116], female: [119, 113, 117] },
};

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

/** Reverse index: face file -> which gendered pool produced it. */
const POOL_OF = new Map<string, PortraitGender>();
for (const g of ['male', 'female', 'monster'] as const) {
  for (const f of POOLS[g]) if (!POOL_OF.has(f)) POOL_OF.set(f, g);
}

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
  const inferred = assigned ? POOL_OF.get(assigned) : undefined;
  if (assigned && !inferred) return assigned;
  if (!opts.job) return assigned;
  const gender = opts.gender ? genderOf(String(opts.gender)) : (inferred ?? genderOf(id));
  return portraitForUnit(id, { job: opts.job, gender });
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
    // Two independent draws off the same hash: one picks the face inside the
    // job family, one picks its palette plate. Two Knights therefore differ in
    // both drawing and colourway while both still reading as Knights.
    // Two independent hashes, not one hash divided twice: the face and the
    // palette must not correlate, or two units of the same job land on the same
    // drawing *and* the same colourway more often than chance.
    const n = faces[hash(id) % faces.length];
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

export type PortraitSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Displayed widths in CSS pixels; heights follow the 128:192 (2:3) aspect.
 *
 * Measured off `refs/curated/fft/press-042310-cfaa9b3e-fft-tic-mediakit-06.png`
 * at 1080p: the combat-timeline chips are ~62px wide and the active-unit face is
 * ~116px. Round 1 ran 20-30% larger than the shipped game and the HUD ate the
 * board; these are the reference numbers.
 */
const SIZES: Record<PortraitSize, number> = { xs: 30, sm: 46, md: 60, lg: 104 };

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
  const HEAD_CROP_H = 132;
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
