/**
 * EverTactics — unit construction and stat derivation.
 *
 * FFT keeps two layers of stats. The *raw* value is a large hidden number that grows
 * on level up according to the job's growth constant; the *displayed* value is that
 * raw number run through the current job's percentage multiplier, then adjusted by
 * equipment and active statuses. Change job and every displayed stat changes with it,
 * while the raw layer — everything you actually earned — is untouched.
 *
 * Raw growth per level:   raw += floor(raw / (growthConstant + level))
 * Displayed:              floor(raw * jobMultiplier / 100) + equipment mods
 *
 * Pure module. No three.js, no Math.random.
 */

import type {
  Ability, AbilityId, AbilitySetId, Equipment, Facing, Gender, Item, ItemId, Job, JobId,
  JobProgress, Rng, SpriteRef, Stats, StatusId, Team, Unit, UnitId, Vec3, Zodiac,
} from './types';
import {
  accuracyScale, ctScale, hasStatus, isDisabled, isImmobile, statusDef, tickStatuses,
  type StatusTickResult,
} from './combat/status';
import { ALL_ZODIAC } from './combat/zodiac';

// Raw HP/MP have nowhere to live on the frozen `Unit` contract (`stats.hp` is the
// current pool, `stats.pa/ma/spd` are already raw per the contract's own comment),
// so widen `Unit` additively rather than editing the shared file.
declare module './types' {
  interface Unit {
    /** Raw, pre-multiplier HP pool. Grows on level up; job multiplier turns it into maxHp. */
    rawHp?: number;
    /** Raw, pre-multiplier MP pool. */
    rawMp?: number;
    /** Total exp needed for the next level is always 100; this is the running total. */
    totalExp?: number;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Content registry
//
// `core/jobs`, `core/abilities` and the item table are owned by other modules. Rather
// than import them (and hard-couple to their shapes) the unit layer keeps a registry
// that the bootstrap fills in once. Tests register fixtures directly.
// ─────────────────────────────────────────────────────────────────────────────

const jobRegistry = new Map<JobId, Job>();
const itemRegistry = new Map<ItemId, Item>();
const abilityRegistry = new Map<AbilityId, Ability>();

export function registerJobs(jobs: Iterable<Job>): void {
  for (const j of jobs) jobRegistry.set(j.id, j);
}
export function registerItems(items: Iterable<Item>): void {
  for (const i of items) itemRegistry.set(i.id, i);
}
export function registerAbilities(abilities: Iterable<Ability>): void {
  for (const a of abilities) abilityRegistry.set(a.id, a);
}
export function clearContent(): void {
  jobRegistry.clear();
  itemRegistry.clear();
  abilityRegistry.clear();
}

export function getItem(id: ItemId | undefined): Item | undefined {
  return id === undefined ? undefined : itemRegistry.get(id);
}
export function getAbility(id: AbilityId | undefined): Ability | undefined {
  return id === undefined ? undefined : abilityRegistry.get(id);
}

/**
 * Fallback job used when a unit references a job the registry does not know about yet.
 * Neutral multipliers, Squire-ish mobility — so a half-built content table still yields
 * sane numbers instead of NaN.
 */
export const NEUTRAL_JOB: Job = {
  id: '__neutral__',
  name: 'Unaffiliated',
  origin: 'original',
  blurb: 'No job set.',
  description: 'A unit with no job assigned. Neutral in every respect.',
  sprite: { male: 'squire_male', female: 'squire_female' },
  move: 4,
  jump: 3,
  cEvade: 5,
  growth: { hp: 11, mp: 15, pa: 60, ma: 60, spd: 100 },
  mult: { hp: 100, mp: 100, pa: 100, ma: 100, spd: 100 },
  requires: [],
  actionSet: 'basic',
  learnable: [],
  equip: [],
  innate: [],
};

export function getJob(id: JobId | undefined): Job {
  if (id === undefined) return NEUTRAL_JOB;
  return jobRegistry.get(id) ?? NEUTRAL_JOB;
}

export function knownJob(id: JobId): boolean {
  return jobRegistry.has(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw stats
// ─────────────────────────────────────────────────────────────────────────────

export interface RawStats {
  hp: number;
  mp: number;
  pa: number;
  ma: number;
  spd: number;
}

/** Level-1 raw stat line before any job multiplier is applied. */
export const BASE_RAW_STATS: Readonly<RawStats> = { hp: 100, mp: 40, pa: 8, ma: 8, spd: 8 };

export function rawStats(unit: Unit): RawStats {
  return {
    hp: unit.rawHp ?? unit.stats.maxHp,
    mp: unit.rawMp ?? unit.stats.maxMp,
    pa: unit.stats.pa,
    ma: unit.stats.ma,
    spd: unit.stats.spd,
  };
}

export function setRawStats(unit: Unit, raw: RawStats): void {
  unit.rawHp = raw.hp;
  unit.rawMp = raw.mp;
  unit.stats.pa = raw.pa;
  unit.stats.ma = raw.ma;
  unit.stats.spd = raw.spd;
}

/** One level of raw growth: `raw += floor(raw / (growth + level))`. */
export function growRaw(raw: RawStats, job: Job, level: number): RawStats {
  const g = job.growth;
  const step = (value: number, constant: number): number =>
    value + Math.floor(value / Math.max(1, constant + level));
  return {
    hp: step(raw.hp, g.hp),
    mp: step(raw.mp, g.mp),
    pa: step(raw.pa, g.pa),
    ma: step(raw.ma, g.ma),
    spd: step(raw.spd, g.spd),
  };
}

/** Raw stat line for a unit that reached `level` entirely inside one job. */
export function rawStatsAtLevel(job: Job, level: number, base: RawStats = { ...BASE_RAW_STATS }): RawStats {
  let raw = { ...base };
  for (let l = 1; l < level; l++) raw = growRaw(raw, job, l);
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment
// ─────────────────────────────────────────────────────────────────────────────

export interface EquipmentMods {
  hp: number; mp: number; pa: number; ma: number; spd: number; move: number; jump: number;
  /** Statuses permanently granted by gear. */
  granted: StatusId[];
}

const EQUIP_SLOTS = ['rightHand', 'leftHand', 'head', 'body', 'accessory'] as const;

export function equippedItems(unit: Unit): Item[] {
  const out: Item[] = [];
  for (const slot of EQUIP_SLOTS) {
    const item = getItem(unit.equipment[slot]);
    if (item) out.push(item);
  }
  return out;
}

export function equipmentMods(unit: Unit): EquipmentMods {
  const mods: EquipmentMods = { hp: 0, mp: 0, pa: 0, ma: 0, spd: 0, move: 0, jump: 0, granted: [] };
  for (const item of equippedItems(unit)) {
    const m = item.mods;
    if (m) {
      mods.hp += m.hp ?? 0;
      mods.mp += m.mp ?? 0;
      mods.pa += m.pa ?? 0;
      mods.ma += m.ma ?? 0;
      mods.spd += m.spd ?? 0;
      mods.move += m.move ?? 0;
      mods.jump += m.jump ?? 0;
    }
    if (item.grantsStatus) mods.granted.push(...item.grantsStatus);
  }
  return mods;
}

/** The weapon in the right hand, or the left hand if the right is empty. */
export function weaponOf(unit: Unit): Item | undefined {
  const right = getItem(unit.equipment.rightHand);
  if (right && right.wp !== undefined) return right;
  const left = getItem(unit.equipment.leftHand);
  if (left && left.wp !== undefined) return left;
  return undefined;
}

/** The shield in either hand, if any. */
export function shieldOf(unit: Unit): Item | undefined {
  for (const slot of ['leftHand', 'rightHand'] as const) {
    const item = getItem(unit.equipment[slot]);
    if (item && item.category === 'shield') return item;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived stats
// ─────────────────────────────────────────────────────────────────────────────

function mult(raw: number, percent: number): number {
  return Math.floor((raw * percent) / 100);
}

/**
 * The effective stat line: raw → job multipliers → equipment → active statuses.
 * `hp` / `mp` stay the unit's live pools, clamped to the derived maxima.
 */
export function deriveStats(unit: Unit): Stats {
  const job = getJob(unit.currentJob);
  const raw = rawStats(unit);
  const mods = equipmentMods(unit);

  let maxHp = Math.max(1, mult(raw.hp, job.mult.hp) + mods.hp);
  let maxMp = Math.max(0, mult(raw.mp, job.mult.mp) + mods.mp);
  let pa = Math.max(0, mult(raw.pa, job.mult.pa) + mods.pa);
  let ma = Math.max(0, mult(raw.ma, job.mult.ma) + mods.ma);
  let spd = Math.max(1, mult(raw.spd, job.mult.spd) + mods.spd);
  let move = Math.max(0, job.move + mods.move);
  let jump = Math.max(0, job.jump + mods.jump);

  let brave = unit.stats.brave;
  let faith = unit.stats.faith;

  // Statuses.
  if (hasStatus(unit, 'faith')) faith = 100;
  if (hasStatus(unit, 'innocent')) faith = 0;
  if (hasStatus(unit, 'berserk')) { brave = 100; pa = Math.floor(pa * 1.5); }
  if (hasStatus(unit, 'chicken')) brave = Math.min(brave, 9);
  if (hasStatus(unit, 'frog')) {
    pa = Math.max(1, Math.floor(pa / 2));
    ma = Math.max(1, Math.floor(ma / 2));
    move = Math.max(1, move - 1);
  }
  if (hasStatus(unit, 'float')) jump += 1;
  if (isImmobile(unit)) move = 0;

  return {
    hp: Math.max(0, Math.min(unit.stats.hp, maxHp)),
    maxHp,
    mp: Math.max(0, Math.min(unit.stats.mp, maxMp)),
    maxMp,
    pa,
    ma,
    spd,
    move,
    jump,
    brave: clamp(brave, 0, 100),
    faith: clamp(faith, 0, 100),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function isKO(unit: Unit): boolean {
  return unit.removed || unit.stats.hp <= 0 || hasStatus(unit, 'ko')
    || hasStatus(unit, 'crystal') || hasStatus(unit, 'treasure');
}

/** True when the unit may be given a command this turn. */
export function canAct(unit: Unit): boolean {
  if (isKO(unit)) return false;
  return !isDisabled(unit);
}

/** True when the unit is a legal target for abilities. */
export function isTargetable(unit: Unit): boolean {
  return !unit.removed && !hasStatus(unit, 'crystal') && !hasStatus(unit, 'treasure')
    && !hasStatus(unit, 'jumping');
}

export function effectiveMove(unit: Unit): number {
  return deriveStats(unit).move;
}

export function effectiveJump(unit: Unit): number {
  return deriveStats(unit).jump;
}

/**
 * Speed as the CT clock sees it: the derived stat scaled by Haste / Slow / Stop.
 * `ct.ts` can add this straight into the accumulator.
 */
export function effectiveSpeed(unit: Unit): number {
  const base = deriveStats(unit).spd;
  return Math.max(0, Math.floor(base * ctScale(unit)));
}

/** Physical accuracy scalar contributed by the attacker's own statuses (Blind). */
export function attackerAccuracyScale(unit: Unit): number {
  return accuracyScale(unit);
}

/** Advance a unit's statuses one clock tick, using its own derived max HP. */
export function tickUnitStatuses(unit: Unit, ticks = 1): StatusTickResult {
  const stats = deriveStats(unit);
  return tickStatuses(unit, { maxHp: stats.maxHp, hp: unit.stats.hp, ticks });
}

// ─────────────────────────────────────────────────────────────────────────────
// Job levels, JP and abilities
// ─────────────────────────────────────────────────────────────────────────────

/** Total JP earned in a job required to reach each job level (index = level - 1). */
export const JOB_LEVEL_JP: readonly number[] = [0, 100, 200, 400, 700, 1100, 1600, 2200];

export const MAX_JOB_LEVEL = JOB_LEVEL_JP.length;
export const MAX_LEVEL = 99;
export const EXP_PER_LEVEL = 100;

export function jobLevelFor(totalJp: number): number {
  let level = 1;
  for (let i = 0; i < JOB_LEVEL_JP.length; i++) {
    const need = JOB_LEVEL_JP[i];
    if (need !== undefined && totalJp >= need) level = i + 1;
  }
  return level;
}

export function jpToNextJobLevel(totalJp: number): number {
  const level = jobLevelFor(totalJp);
  if (level >= MAX_JOB_LEVEL) return 0;
  const need = JOB_LEVEL_JP[level];
  return need === undefined ? 0 : Math.max(0, need - totalJp);
}

export function jobProgress(unit: Unit, job: JobId = unit.currentJob): JobProgress {
  let p = unit.jobs.get(job);
  if (!p) {
    p = { level: 1, jp: 0, totalJp: 0, learned: new Set<AbilityId>() };
    unit.jobs.set(job, p);
  }
  return p;
}

export interface JpGain {
  job: JobId;
  amount: number;
  jobLevel: number;
  /** True when this gain pushed the job to a new job level. */
  levelledUp: boolean;
}

export function gainJp(unit: Unit, amount: number, job: JobId = unit.currentJob): JpGain {
  const p = jobProgress(unit, job);
  const before = p.level;
  const gain = Math.max(0, Math.floor(amount));
  p.jp += gain;
  p.totalJp += gain;
  p.level = jobLevelFor(p.totalJp);
  return { job, amount: gain, jobLevel: p.level, levelledUp: p.level > before };
}

export interface LearnResult {
  learned: boolean;
  reason?: 'already-known' | 'not-learnable' | 'insufficient-jp';
  cost: number;
}

export function abilityCost(job: Job, ability: AbilityId): number | undefined {
  return job.learnable.find((l) => l.ability === ability)?.jp;
}

export function hasLearned(unit: Unit, ability: AbilityId): boolean {
  for (const p of unit.jobs.values()) if (p.learned.has(ability)) return true;
  return false;
}

export function learnAbility(unit: Unit, ability: AbilityId, jobId: JobId = unit.currentJob): LearnResult {
  const job = getJob(jobId);
  const cost = abilityCost(job, ability);
  if (cost === undefined) return { learned: false, reason: 'not-learnable', cost: 0 };
  const p = jobProgress(unit, jobId);
  if (p.learned.has(ability)) return { learned: false, reason: 'already-known', cost };
  if (p.jp < cost) return { learned: false, reason: 'insufficient-jp', cost };
  p.jp -= cost;
  p.learned.add(ability);
  return { learned: true, cost };
}

/** Abilities the unit could buy right now in the given job. */
export function learnableNow(unit: Unit, jobId: JobId = unit.currentJob): AbilityId[] {
  const job = getJob(jobId);
  const p = jobProgress(unit, jobId);
  return job.learnable.filter((l) => !p.learned.has(l.ability) && p.jp >= l.jp).map((l) => l.ability);
}

/** True when the unit meets a job's prerequisite job levels. */
export function jobUnlocked(unit: Unit, jobId: JobId): boolean {
  const job = getJob(jobId);
  return job.requires.every((req) => (unit.jobs.get(req.job)?.level ?? 1) >= req.level);
}

// ─────────────────────────────────────────────────────────────────────────────
// Levelling
// ─────────────────────────────────────────────────────────────────────────────

export interface LevelUpResult {
  level: number;
  before: RawStats;
  after: RawStats;
  /** Displayed HP gained, for the floating "+N HP" text. */
  hpGained: number;
}

export function levelUp(unit: Unit): LevelUpResult | undefined {
  if (unit.level >= MAX_LEVEL) return undefined;
  const job = getJob(unit.currentJob);
  const before = rawStats(unit);
  const hpBefore = deriveStats(unit).maxHp;
  const after = growRaw(before, job, unit.level);
  setRawStats(unit, after);
  unit.level += 1;
  const stats = deriveStats(unit);
  // Levelling tops the unit up by exactly what it gained, FFT-style.
  const hpGained = stats.maxHp - hpBefore;
  unit.stats.hp = Math.min(stats.maxHp, unit.stats.hp + Math.max(0, hpGained));
  unit.stats.mp = Math.min(stats.maxMp, unit.stats.mp);
  return { level: unit.level, before, after, hpGained };
}

/**
 * Void-returning level-up, which is the shape `battle.ts` wires into its dependency
 * table. Prefer {@link levelUp} when you want the stat delta back.
 */
export function applyLevelUp(unit: Unit): void {
  levelUp(unit);
}

export interface ExpGain {
  amount: number;
  levels: LevelUpResult[];
}

export function gainExp(unit: Unit, amount: number): ExpGain {
  const gain = Math.max(0, Math.floor(amount));
  const levels: LevelUpResult[] = [];
  unit.exp += gain;
  unit.totalExp = (unit.totalExp ?? 0) + gain;
  while (unit.exp >= EXP_PER_LEVEL && unit.level < MAX_LEVEL) {
    unit.exp -= EXP_PER_LEVEL;
    const res = levelUp(unit);
    if (!res) break;
    levels.push(res);
  }
  if (unit.level >= MAX_LEVEL) unit.exp = 0;
  return { amount: gain, levels };
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitSpec {
  id: UnitId;
  name: string;
  team: Team;
  job: JobId;
  gender?: Gender;
  zodiac?: Zodiac;
  level?: number;
  brave?: number;
  faith?: number;
  pos?: Vec3;
  facing?: Facing;
  equipment?: Equipment;
  secondaryAction?: AbilitySetId;
  reaction?: AbilityId;
  support?: AbilityId;
  movement?: AbilityId;
  sprite?: SpriteRef;
  /** Override the level-1 raw stat line (monsters, bosses, story units). */
  base?: Partial<RawStats>;
  /** Abilities the unit starts with, per job. */
  learned?: Readonly<Record<JobId, readonly AbilityId[]>>;
  /** Starting JP per job. */
  jp?: Readonly<Record<JobId, number>>;
  /** Used to roll gender / zodiac / brave / faith when not specified. */
  rng?: Rng;
}

const TEAM_PALETTE: Readonly<Record<Team, number>> = {
  player: 0,
  enemy: 1,
  ally: 2,
  neutral: 3,
};

export function createUnit(spec: UnitSpec): Unit {
  const rng = spec.rng;
  const gender: Gender = spec.gender ?? (rng ? (rng.int(2) === 0 ? 'male' : 'female') : 'male');
  const zodiac: Zodiac = spec.zodiac
    ?? (rng ? (ALL_ZODIAC[rng.int(12)] ?? 'aries') : 'aries');
  const level = clamp(Math.floor(spec.level ?? 1), 1, MAX_LEVEL);
  const job = getJob(spec.job);

  // FFT rolls Brave/Faith in the 40–70 band for generics.
  const brave = spec.brave ?? (rng ? 40 + rng.int(31) : 70);
  const faith = spec.faith ?? (rng ? 40 + rng.int(31) : 70);

  const base: RawStats = { ...BASE_RAW_STATS, ...spec.base };
  const raw = rawStatsAtLevel(job, level, base);

  const stats: Stats = {
    hp: 1, maxHp: 1, mp: 0, maxMp: 0,
    pa: raw.pa, ma: raw.ma, spd: raw.spd,
    move: job.move, jump: job.jump,
    brave: clamp(brave, 0, 100),
    faith: clamp(faith, 0, 100),
  };

  const pos: Vec3 = spec.pos ? { ...spec.pos } : { x: 0, y: 0, z: 0 };
  const sheet = gender === 'female' ? job.sprite.female : job.sprite.male;

  const unit: Unit = {
    id: spec.id,
    name: spec.name,
    team: spec.team,
    gender,
    zodiac,
    level,
    exp: 0,
    currentJob: spec.job,
    jobs: new Map<JobId, JobProgress>(),
    stats,
    equipment: spec.equipment ? { ...spec.equipment } : {},
    pos,
    facing: spec.facing ?? 'S',
    ct: 0,
    statuses: [],
    turn: { moved: false, acted: false, origin: { ...pos }, originFacing: spec.facing ?? 'S' },
    removed: false,
    sprite: spec.sprite ?? { sheet, palette: TEAM_PALETTE[spec.team] },
    rawHp: raw.hp,
    rawMp: raw.mp,
    totalExp: 0,
  };

  if (spec.secondaryAction !== undefined) unit.secondaryAction = spec.secondaryAction;
  if (spec.reaction !== undefined) unit.reaction = spec.reaction;
  if (spec.support !== undefined) unit.support = spec.support;
  if (spec.movement !== undefined) unit.movement = spec.movement;

  // Job records.
  jobProgress(unit, spec.job);
  if (spec.jp) {
    for (const [jobId, amount] of Object.entries(spec.jp)) {
      const p = jobProgress(unit, jobId);
      p.jp += amount;
      p.totalJp += amount;
      p.level = jobLevelFor(p.totalJp);
    }
  }
  if (spec.learned) {
    for (const [jobId, abilities] of Object.entries(spec.learned)) {
      const p = jobProgress(unit, jobId);
      for (const a of abilities) p.learned.add(a);
    }
  }

  const derived = deriveStats(unit);
  unit.stats.maxHp = derived.maxHp;
  unit.stats.maxMp = derived.maxMp;
  unit.stats.hp = derived.maxHp;
  unit.stats.mp = derived.maxMp;
  unit.stats.move = derived.move;
  unit.stats.jump = derived.jump;

  // Gear-granted permanent statuses (Float boots, Reraise pendants, ...).
  const granted = equipmentMods(unit).granted;
  for (const s of granted) {
    if (!STATUS_EXISTS(s)) continue;
    unit.statuses.push({ status: s, remaining: -1 });
  }

  return unit;
}

function STATUS_EXISTS(id: StatusId): boolean {
  try {
    statusDef(id);
    return true;
  } catch {
    return false;
  }
}

/** Refresh the cached `maxHp` / `maxMp` / `move` / `jump` mirrors on `unit.stats`. */
export function refreshDerived(unit: Unit): Stats {
  const d = deriveStats(unit);
  unit.stats.maxHp = d.maxHp;
  unit.stats.maxMp = d.maxMp;
  unit.stats.move = d.move;
  unit.stats.jump = d.jump;
  unit.stats.hp = Math.min(unit.stats.hp, d.maxHp);
  unit.stats.mp = Math.min(unit.stats.mp, d.maxMp);
  return d;
}

/** Switch a unit's job, re-deriving everything the multipliers touch. */
export function setJob(unit: Unit, jobId: JobId): void {
  jobProgress(unit, jobId);
  const beforeMax = deriveStats(unit).maxHp;
  unit.currentJob = jobId;
  const after = refreshDerived(unit);
  // Keep the HP *ratio* across a job change rather than the flat value.
  const ratio = beforeMax > 0 ? unit.stats.hp / beforeMax : 1;
  unit.stats.hp = Math.max(1, Math.min(after.maxHp, Math.round(after.maxHp * ratio)));
  const job = getJob(jobId);
  const sheet = unit.gender === 'female' ? job.sprite.female : job.sprite.male;
  unit.sprite = { sheet, palette: unit.sprite.palette };
}
