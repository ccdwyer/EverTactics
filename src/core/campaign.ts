/**
 * EverTactics — campaign persistence model.
 *
 * Pure data and pure functions. No three.js, no DOM, no localStorage.
 * Timestamps are passed in; this module never calls Date.now() or Math.random().
 *
 * A CampaignState is the durable company: roster, gil, inventory, story progress.
 * Battle-scoped fields (position, CT, statuses, turn flags) are never stored here —
 * they are derived fresh when a battle is opened, so a save cannot resurrect a
 * half-finished turn.
 */

import type {
  AbilityId,
  AbilitySetId,
  BattleState,
  Equipment,
  Facing,
  Gender,
  ItemId,
  JobId,
  Team,
  Unit,
  UnitId,
  Vec3,
  Zodiac,
} from './types';
import { JOBS } from './jobs';
import {
  createUnit,
  EXP_PER_LEVEL,
  MAX_JOB_LEVEL,
  MAX_LEVEL,
  refreshDerived,
  setRawStats,
  type RawStats,
} from './unit';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Current on-disk schema version. Bump when the shape of CampaignState changes. */
export const CAMPAIGN_VERSION = 1;

export interface PersistedJobProgress {
  level: number;
  jp: number;
  totalJp: number;
  /** Ability ids learned in this job (array for JSON; Unit uses Set). */
  learned: AbilityId[];
}

/**
 * Durable subset of a Unit. Deliberately excludes battle-scoped fields:
 * pos, facing, ct, statuses, turn flags, removed, team, sprite.
 */
export interface PersistedUnit {
  id: UnitId;
  name: string;
  gender: Gender;
  zodiac: Zodiac;
  level: number;
  exp: number;
  /** Lifetime exp total when tracked; optional for older saves. */
  totalExp: number;
  /**
   * Lifetime personal KOs credited to this unit. Gates Dark Knight / Death Knight.
   * Optional on older saves — missing means 0.
   */
  kills?: number;
  currentJob: JobId;
  jobs: Record<JobId, PersistedJobProgress>;
  equipment: Equipment;
  secondaryAction?: AbilitySetId;
  reaction?: AbilityId;
  support?: AbilityId;
  movement?: AbilityId;
  /** Raw, pre-multiplier stats (the layer that survives a job change). */
  raw: RawStats;
  brave: number;
  faith: number;
}

export interface CampaignProgress {
  /** Scenario ids already won. */
  completed: string[];
  /** Scenario (or world-map node) the player is at. */
  current?: string;
}

/** One roster member assigned to one scenario start-tile index. */
export interface FormationEntry {
  unitId: UnitId;
  /** Index into the scenario's player start tiles (0-based). */
  startIndex: number;
}

export interface CampaignState {
  version: number;
  /** Campaign-level seed so random encounters stay deterministic. */
  seed: number;
  gil: number;
  /** The player's company — not a BattleState. */
  roster: PersistedUnit[];
  inventory: Record<ItemId, number>;
  /**
   * Who deploys, and on which start-tile index, for the next battle.
   * Empty means "first N roster members on start tiles 0..N-1" (legacy default).
   */
  formation: FormationEntry[];
  progress: CampaignProgress;
  /** Epoch ms; always passed in, never read from the clock in core. */
  createdAt: number;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A blank campaign. Callers populate the roster and inventory; this never rolls
 * gender, zodiac, or brave/faith (no RNG in core outside the seeded Rng).
 */
export function createCampaign(seed: number, timestamp: number): CampaignState {
  return {
    version: CAMPAIGN_VERSION,
    seed: seed | 0,
    gil: 0,
    roster: [],
    inventory: {},
    formation: [],
    progress: { completed: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit ↔ persisted
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the durable fields of a live unit. Battle-scoped fields are dropped. */
export function unitToPersisted(unit: Unit): PersistedUnit {
  const jobs: Record<JobId, PersistedJobProgress> = {};
  for (const [jobId, progress] of unit.jobs) {
    jobs[jobId] = {
      level: progress.level,
      jp: progress.jp,
      totalJp: progress.totalJp,
      learned: [...progress.learned].sort(),
    };
  }

  const persisted: PersistedUnit = {
    id: unit.id,
    name: unit.name,
    gender: unit.gender,
    zodiac: unit.zodiac,
    level: unit.level,
    exp: unit.exp,
    totalExp: unit.totalExp ?? 0,
    kills: unit.kills ?? 0,
    currentJob: unit.currentJob,
    jobs,
    equipment: { ...unit.equipment },
    raw: {
      hp: unit.rawHp ?? unit.stats.maxHp,
      mp: unit.rawMp ?? unit.stats.maxMp,
      pa: unit.stats.pa,
      ma: unit.stats.ma,
      spd: unit.stats.spd,
    },
    brave: unit.stats.brave,
    faith: unit.stats.faith,
  };

  if (unit.secondaryAction !== undefined) persisted.secondaryAction = unit.secondaryAction;
  if (unit.reaction !== undefined) persisted.reaction = unit.reaction;
  if (unit.support !== undefined) persisted.support = unit.support;
  if (unit.movement !== undefined) persisted.movement = unit.movement;

  return persisted;
}

export interface HydrateOpts {
  team: Team;
  pos: Vec3;
  facing: Facing;
}

/**
 * Rebuild a live Unit from durable data. Battle-scoped fields start fresh:
 * full HP/MP, empty statuses, CT 0, turn flags reset. Caller sets CT if needed.
 */
export function unitFromPersisted(p: PersistedUnit, opts: HydrateOpts): Unit {
  // Level 1 + exact raw base so createUnit does not re-apply growth curves.
  const unit = createUnit({
    id: p.id,
    name: p.name,
    team: opts.team,
    job: p.currentJob,
    gender: p.gender,
    zodiac: p.zodiac,
    level: 1,
    brave: p.brave,
    faith: p.faith,
    pos: opts.pos,
    facing: opts.facing,
    equipment: { ...p.equipment },
    base: { ...p.raw },
    ...(p.secondaryAction !== undefined ? { secondaryAction: p.secondaryAction } : {}),
    ...(p.reaction !== undefined ? { reaction: p.reaction } : {}),
    ...(p.support !== undefined ? { support: p.support } : {}),
    ...(p.movement !== undefined ? { movement: p.movement } : {}),
  });

  unit.level = p.level;
  unit.exp = p.exp;
  unit.totalExp = p.totalExp;
  unit.kills = p.kills ?? 0;
  setRawStats(unit, { ...p.raw });

  unit.jobs.clear();
  for (const [jobId, progress] of Object.entries(p.jobs)) {
    unit.jobs.set(jobId, {
      level: progress.level,
      jp: progress.jp,
      totalJp: progress.totalJp,
      learned: new Set(progress.learned),
    });
  }
  // Ensure the current job always has a progress row.
  if (!unit.jobs.has(p.currentJob)) {
    unit.jobs.set(p.currentJob, { level: 1, jp: 0, totalJp: 0, learned: new Set() });
  }

  const derived = refreshDerived(unit);
  unit.stats.hp = derived.maxHp;
  unit.stats.mp = derived.maxMp;
  unit.stats.brave = p.brave;
  unit.stats.faith = p.faith;
  // Battle-scoped fields stay at createUnit defaults (ct 0, fresh turn flags,
  // gear-granted statuses only, not removed). Caller sets CT for deploy.

  return unit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize / migrate / deserialize
// ─────────────────────────────────────────────────────────────────────────────

export function serialize(state: CampaignState): string {
  return JSON.stringify(state);
}

/**
 * Upgrade a parsed save blob to the current schema.
 * Throws with a clear message when the blob is not a recoverable campaign.
 *
 * Migration policy:
 * - Older versions (version < CAMPAIGN_VERSION) may be upgraded and lightly
 *   normalized (defaults filled, bad inventory counts dropped).
 * - The *current* version must validate content fully. Corrupt current-version
 *   saves fail loudly — never silently rewrite into a plausible empty campaign.
 */
export function migrate(raw: unknown): CampaignState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('campaign migrate: expected an object');
  }

  const obj = raw as Record<string, unknown>;
  const version = resolveSchemaVersion(obj);

  if (version > CAMPAIGN_VERSION) {
    throw new Error(
      `campaign migrate: save version ${version} is newer than supported ${CAMPAIGN_VERSION}`,
    );
  }

  // v0 → v1: early hand-written blobs may omit version, use `gold` for gil,
  // or lack progress/inventory. Fill defaults and normalize the roster.
  if (version < 1) {
    const gil =
      typeof obj.gil === 'number'
        ? obj.gil
        : typeof obj.gold === 'number'
          ? (obj.gold as number)
          : 0;

    const seed = typeof obj.seed === 'number' ? obj.seed : 0;
    const createdAt = typeof obj.createdAt === 'number' ? obj.createdAt : 0;
    const updatedAt = typeof obj.updatedAt === 'number' ? obj.updatedAt : createdAt;

    const inventory = normalizeInventory(obj.inventory);
    const progress = normalizeProgress(obj.progress);
    const roster = normalizeRosterLenient(obj.roster);

    return {
      version: CAMPAIGN_VERSION,
      seed: seed | 0,
      gil: Math.max(0, Math.floor(gil)),
      roster,
      inventory,
      formation: normalizeFormation(obj.formation),
      progress,
      createdAt,
      updatedAt,
    };
  }

  // v1 (current): strict content validation. Any malformed field throws.
  // Never floor, default, or drop — a corrupt current-version save fails loudly.
  return parseCurrentVersion(obj);
}

/**
 * Schema version of a raw blob.
 * - Missing `version` → treat as v0 (legacy hand-written saves).
 * - Present but not a non-negative integer → reject (do not fall through to lenient migration).
 */
function resolveSchemaVersion(obj: Record<string, unknown>): number {
  if (!('version' in obj) || obj.version === undefined) {
    return 0;
  }
  if (!isFiniteInt(obj.version) || (obj.version as number) < 0) {
    throw new Error('campaign migrate: invalid version (must be a non-negative integer)');
  }
  return obj.version as number;
}

export function deserialize(json: string): CampaignState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`campaign deserialize: invalid JSON (${message})`);
  }
  return migrate(parsed);
}

// ─── current-version strict parse ────────────────────────────────────────────

const GENDERS: ReadonlySet<string> = new Set(['male', 'female', 'monster']);
const ZODIACS: ReadonlySet<string> = new Set([
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
  'serpentarius',
]);

/** Top-level keys of a current-version CampaignState. Any other key is corrupt/future. */
const CAMPAIGN_KEYS: ReadonlySet<string> = new Set([
  'version',
  'seed',
  'gil',
  'roster',
  'inventory',
  'formation',
  'progress',
  'createdAt',
  'updatedAt',
]);

const PROGRESS_KEYS: ReadonlySet<string> = new Set(['completed', 'current']);

const PERSISTED_UNIT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'gender',
  'zodiac',
  'level',
  'exp',
  'totalExp',
  'kills',
  'currentJob',
  'jobs',
  'equipment',
  'secondaryAction',
  'reaction',
  'support',
  'movement',
  'raw',
  'brave',
  'faith',
]);

const RAW_STAT_KEYS: ReadonlySet<string> = new Set(['hp', 'mp', 'pa', 'ma', 'spd']);

const JOB_PROGRESS_KEYS: ReadonlySet<string> = new Set(['level', 'jp', 'totalJp', 'learned']);

const EQUIPMENT_SLOT_KEYS: ReadonlySet<string> = new Set([
  'rightHand',
  'leftHand',
  'head',
  'body',
  'accessory',
]);

/**
 * Current-version saves must not silently drop unknown fields.
 * Reject so a future schema key is never rewritten away on load.
 */
function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`campaign migrate: ${path} has unknown field "${key}"`);
    }
  }
}

function parseCurrentVersion(obj: Record<string, unknown>): CampaignState {
  // Unknown top-level keys would be stripped by reconstruction — reject instead.
  rejectUnknownKeys(obj, CAMPAIGN_KEYS, 'campaign');

  if (!isFiniteInt(obj.seed)) {
    throw new Error('campaign migrate: missing or invalid seed (must be an integer)');
  }
  if (!isFiniteInt(obj.gil) || (obj.gil as number) < 0) {
    throw new Error('campaign migrate: missing or invalid gil (must be a non-negative integer)');
  }
  if (!isFiniteInt(obj.createdAt)) {
    throw new Error('campaign migrate: missing or invalid createdAt (must be an integer)');
  }
  if (!isFiniteInt(obj.updatedAt)) {
    throw new Error('campaign migrate: missing or invalid updatedAt (must be an integer)');
  }
  if (!Array.isArray(obj.roster)) {
    throw new Error('campaign migrate: missing or invalid roster');
  }
  if (obj.inventory === null || typeof obj.inventory !== 'object' || Array.isArray(obj.inventory)) {
    throw new Error('campaign migrate: missing or invalid inventory');
  }
  if (obj.progress === null || typeof obj.progress !== 'object' || Array.isArray(obj.progress)) {
    throw new Error('campaign migrate: missing or invalid progress');
  }

  // Accept integers as-is — never floor fractions into a plausible save.
  // `formation` is optional on disk for v1 saves written before party management;
  // missing means an empty slate (roster-order deploy).
  const formation =
    obj.formation === undefined ? [] : requireFormation(obj.formation);

  return {
    version: CAMPAIGN_VERSION,
    seed: obj.seed as number,
    gil: obj.gil as number,
    roster: requireRoster(obj.roster),
    inventory: requireInventory(obj.inventory),
    formation,
    progress: requireProgress(obj.progress),
    createdAt: obj.createdAt as number,
    updatedAt: obj.updatedAt as number,
  };
}

function requireFormation(raw: unknown): FormationEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error('campaign migrate: formation must be an array');
  }
  const out: FormationEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`campaign migrate: formation[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.unitId !== 'string') {
      throw new Error(`campaign migrate: formation[${i}].unitId must be a string`);
    }
    if (!isFiniteInt(e.startIndex) || (e.startIndex as number) < 0) {
      throw new Error(
        `campaign migrate: formation[${i}].startIndex must be a non-negative integer`,
      );
    }
    out.push({ unitId: e.unitId, startIndex: e.startIndex as number });
  }
  return out;
}

/** Lenient formation parse for pre-v1 blobs — drop garbage, never throw. */
function normalizeFormation(raw: unknown): FormationEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FormationEntry[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.unitId !== 'string') continue;
    if (typeof e.startIndex !== 'number' || !Number.isFinite(e.startIndex)) continue;
    const startIndex = Math.max(0, Math.floor(e.startIndex));
    out.push({ unitId: e.unitId, startIndex });
  }
  return out;
}

/**
 * Current-version inventory: every entry must be a non-negative integer.
 * Invalid counts reject the whole save — never drop keys, floor, or rewrite.
 * Zero counts are preserved so a current-version blob round-trips byte-identically
 * (migration of *older* versions may still drop zeros; this path must not).
 */
function requireInventory(raw: object): Record<ItemId, number> {
  const out: Record<ItemId, number> = {};
  for (const [id, n] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFiniteInt(n) || (n as number) < 0) {
      throw new Error(
        `campaign migrate: inventory["${id}"] must be a non-negative integer`,
      );
    }
    out[id] = n as number;
  }
  return out;
}

function requireProgress(raw: object): CampaignProgress {
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(obj, PROGRESS_KEYS, 'progress');
  if (!Array.isArray(obj.completed)) {
    throw new Error('campaign migrate: progress.completed must be an array');
  }
  for (let i = 0; i < obj.completed.length; i++) {
    if (typeof obj.completed[i] !== 'string') {
      throw new Error(`campaign migrate: progress.completed[${i}] must be a string`);
    }
  }
  if (obj.current !== undefined && typeof obj.current !== 'string') {
    throw new Error('campaign migrate: progress.current must be a string when present');
  }
  const progress: CampaignProgress = {
    completed: [...(obj.completed as string[])],
  };
  if (typeof obj.current === 'string') progress.current = obj.current;
  return progress;
}

function requireRoster(raw: unknown[]): PersistedUnit[] {
  return raw.map((entry, index) => requirePersistedUnit(entry, index));
}

function requirePersistedUnit(raw: unknown, index: number): PersistedUnit {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`campaign migrate: roster[${index}] is not an object`);
  }
  const u = raw as Record<string, unknown>;
  const path = `roster[${index}]`;
  rejectUnknownKeys(u, PERSISTED_UNIT_KEYS, path);

  if (typeof u.id !== 'string') throw new Error(`campaign migrate: ${path}.id missing`);
  if (typeof u.name !== 'string') throw new Error(`campaign migrate: ${path}.name missing`);
  if (typeof u.gender !== 'string' || !GENDERS.has(u.gender)) {
    throw new Error(`campaign migrate: ${path}.gender invalid`);
  }
  if (typeof u.zodiac !== 'string' || !ZODIACS.has(u.zodiac)) {
    throw new Error(`campaign migrate: ${path}.zodiac invalid`);
  }
  if (!isFiniteInt(u.level) || (u.level as number) < 1 || (u.level as number) > MAX_LEVEL) {
    throw new Error(
      `campaign migrate: ${path}.level invalid (must be integer 1..${MAX_LEVEL})`,
    );
  }
  // Engine keeps exp in [0, EXP_PER_LEVEL) and forces 0 at MAX_LEVEL (see gainExp).
  if (
    !isFiniteInt(u.exp) ||
    (u.exp as number) < 0 ||
    (u.exp as number) >= EXP_PER_LEVEL
  ) {
    throw new Error(
      `campaign migrate: ${path}.exp invalid (must be integer 0..${EXP_PER_LEVEL - 1})`,
    );
  }
  if ((u.level as number) >= MAX_LEVEL && (u.exp as number) !== 0) {
    throw new Error(
      `campaign migrate: ${path}.exp must be 0 at level ${MAX_LEVEL}`,
    );
  }
  // totalExp is required at the current schema version — never default to 0.
  if (!isFiniteNonNegInt(u.totalExp)) {
    throw new Error(`campaign migrate: ${path}.totalExp missing or invalid (must be non-negative integer)`);
  }
  if (!isFiniteInt(u.brave) || (u.brave as number) < 0 || (u.brave as number) > 100) {
    throw new Error(`campaign migrate: ${path}.brave invalid (must be integer 0..100)`);
  }
  if (!isFiniteInt(u.faith) || (u.faith as number) < 0 || (u.faith as number) > 100) {
    throw new Error(`campaign migrate: ${path}.faith invalid (must be integer 0..100)`);
  }
  if (typeof u.currentJob !== 'string') {
    throw new Error(`campaign migrate: ${path}.currentJob missing`);
  }
  if (!JOBS.has(u.currentJob)) {
    throw new Error(
      `campaign migrate: ${path}.currentJob "${u.currentJob}" is not a known job`,
    );
  }
  if (u.raw === null || typeof u.raw !== 'object' || Array.isArray(u.raw)) {
    throw new Error(`campaign migrate: ${path}.raw missing or invalid`);
  }
  if (u.jobs === null || typeof u.jobs !== 'object' || Array.isArray(u.jobs)) {
    throw new Error(`campaign migrate: ${path}.jobs missing or invalid`);
  }
  if (u.equipment === null || typeof u.equipment !== 'object' || Array.isArray(u.equipment)) {
    throw new Error(`campaign migrate: ${path}.equipment missing or invalid`);
  }

  const rawStats = requireRaw(u.raw as Record<string, unknown>, path);
  const jobs = requireJobs(u.jobs as Record<string, unknown>, path);
  // currentJob must have a progress row — never invent zeroed progress at load.
  if (!(u.currentJob in jobs)) {
    throw new Error(
      `campaign migrate: ${path}.jobs must include an entry for currentJob "${u.currentJob}"`,
    );
  }
  const equipment = requireEquipment(u.equipment as Record<string, unknown>, path);

  // kills is optional on older current-version saves; default 0 when absent.
  let kills = 0;
  if (u.kills !== undefined) {
    if (!isFiniteNonNegInt(u.kills)) {
      throw new Error(`campaign migrate: ${path}.kills invalid (must be non-negative integer)`);
    }
    kills = u.kills as number;
  }

  const persisted: PersistedUnit = {
    id: u.id,
    name: u.name,
    gender: u.gender as Gender,
    zodiac: u.zodiac as Zodiac,
    level: u.level as number,
    exp: u.exp as number,
    totalExp: u.totalExp as number,
    kills,
    currentJob: u.currentJob,
    jobs,
    equipment,
    raw: rawStats,
    brave: u.brave as number,
    faith: u.faith as number,
  };

  if (u.secondaryAction !== undefined) {
    if (typeof u.secondaryAction !== 'string') {
      throw new Error(`campaign migrate: ${path}.secondaryAction invalid`);
    }
    persisted.secondaryAction = u.secondaryAction;
  }
  if (u.reaction !== undefined) {
    if (typeof u.reaction !== 'string') {
      throw new Error(`campaign migrate: ${path}.reaction invalid`);
    }
    persisted.reaction = u.reaction;
  }
  if (u.support !== undefined) {
    if (typeof u.support !== 'string') {
      throw new Error(`campaign migrate: ${path}.support invalid`);
    }
    persisted.support = u.support;
  }
  if (u.movement !== undefined) {
    if (typeof u.movement !== 'string') {
      throw new Error(`campaign migrate: ${path}.movement invalid`);
    }
    persisted.movement = u.movement;
  }

  return persisted;
}

function requireRaw(r: Record<string, unknown>, path: string): RawStats {
  rejectUnknownKeys(r, RAW_STAT_KEYS, `${path}.raw`);
  for (const key of ['hp', 'mp', 'pa', 'ma', 'spd'] as const) {
    if (!isFiniteNonNegInt(r[key])) {
      throw new Error(
        `campaign migrate: ${path}.raw.${key} invalid (must be non-negative integer)`,
      );
    }
  }
  return {
    hp: r.hp as number,
    mp: r.mp as number,
    pa: r.pa as number,
    ma: r.ma as number,
    spd: r.spd as number,
  };
}

function requireJobs(
  raw: Record<string, unknown>,
  path: string,
): Record<JobId, PersistedJobProgress> {
  const out: Record<JobId, PersistedJobProgress> = {};
  for (const [jobId, value] of Object.entries(raw)) {
    // Current-version job keys must exist in the job table — never invent rows.
    if (!JOBS.has(jobId)) {
      throw new Error(`campaign migrate: ${path}.jobs["${jobId}"] is not a known job`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`campaign migrate: ${path}.jobs["${jobId}"] is not an object`);
    }
    const p = value as Record<string, unknown>;
    const jpPath = `${path}.jobs["${jobId}"]`;
    rejectUnknownKeys(p, JOB_PROGRESS_KEYS, jpPath);
    if (!isFiniteInt(p.level) || (p.level as number) < 1 || (p.level as number) > MAX_JOB_LEVEL) {
      throw new Error(
        `campaign migrate: ${jpPath}.level invalid (must be integer 1..${MAX_JOB_LEVEL})`,
      );
    }
    if (!isFiniteNonNegInt(p.jp)) {
      throw new Error(`campaign migrate: ${jpPath}.jp invalid (must be non-negative integer)`);
    }
    if (!isFiniteNonNegInt(p.totalJp)) {
      throw new Error(`campaign migrate: ${jpPath}.totalJp invalid (must be non-negative integer)`);
    }
    if (!Array.isArray(p.learned)) {
      throw new Error(`campaign migrate: ${jpPath}.learned must be an array`);
    }
    for (let i = 0; i < p.learned.length; i++) {
      if (typeof p.learned[i] !== 'string') {
        throw new Error(`campaign migrate: ${jpPath}.learned[${i}] must be a string`);
      }
    }
    // Preserve learned[] order exactly. Sorting would rewrite a current-version
    // save and break round-trip equality (migration of older versions may sort).
    out[jobId] = {
      level: p.level as number,
      jp: p.jp as number,
      totalJp: p.totalJp as number,
      learned: [...(p.learned as string[])],
    };
  }
  return out;
}

function requireEquipment(raw: Record<string, unknown>, path: string): Equipment {
  rejectUnknownKeys(raw, EQUIPMENT_SLOT_KEYS, `${path}.equipment`);
  const equipment: Equipment = {};
  const slots = ['rightHand', 'leftHand', 'head', 'body', 'accessory'] as const;
  for (const slot of slots) {
    const v = raw[slot];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      throw new Error(`campaign migrate: ${path}.equipment.${slot} must be a string`);
    }
    equipment[slot] = v;
  }
  return equipment;
}

/** Finite integer (not a float). Used for all current-version numeric fields. */
function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

function isFiniteNonNegInt(v: unknown): v is number {
  return isFiniteInt(v) && v >= 0;
}

// ─── older-version lenient normalize (migration only) ────────────────────────

function normalizeInventory(raw: unknown): Record<ItemId, number> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<ItemId, number> = {};
  for (const [id, n] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
      out[id] = Math.floor(n);
    }
  }
  return out;
}

function normalizeProgress(raw: unknown): CampaignProgress {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { completed: [] };
  }
  const obj = raw as Record<string, unknown>;
  const completed = Array.isArray(obj.completed)
    ? obj.completed.filter((id): id is string => typeof id === 'string')
    : [];
  const progress: CampaignProgress = { completed: [...completed] };
  if (typeof obj.current === 'string') progress.current = obj.current;
  return progress;
}

function normalizeRosterLenient(raw: unknown): PersistedUnit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => normalizePersistedUnit(entry, index));
}

function normalizePersistedUnit(raw: unknown, index: number): PersistedUnit {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`campaign migrate: roster[${index}] is not an object`);
  }
  const u = raw as Record<string, unknown>;
  if (typeof u.id !== 'string') throw new Error(`campaign migrate: roster[${index}].id missing`);
  if (typeof u.name !== 'string') throw new Error(`campaign migrate: roster[${index}].name missing`);
  if (typeof u.currentJob !== 'string') {
    throw new Error(`campaign migrate: roster[${index}].currentJob missing`);
  }

  const gender = (typeof u.gender === 'string' && GENDERS.has(u.gender)
    ? u.gender
    : 'male') as Gender;
  const zodiac = (typeof u.zodiac === 'string' && ZODIACS.has(u.zodiac)
    ? u.zodiac
    : 'aries') as Zodiac;
  const level = typeof u.level === 'number' ? Math.max(1, Math.floor(u.level)) : 1;
  const exp = typeof u.exp === 'number' ? Math.max(0, Math.floor(u.exp)) : 0;
  const totalExp = typeof u.totalExp === 'number' ? Math.max(0, Math.floor(u.totalExp)) : 0;
  const brave = typeof u.brave === 'number' ? u.brave : 70;
  const faith = typeof u.faith === 'number' ? u.faith : 70;

  const rawStats = normalizeRaw(u.raw, u);
  const jobs = normalizeJobs(u.jobs);
  const equipment =
    u.equipment !== null && typeof u.equipment === 'object' && !Array.isArray(u.equipment)
      ? { ...(u.equipment as Equipment) }
      : {};

  const kills =
    typeof u.kills === 'number' && Number.isFinite(u.kills)
      ? Math.max(0, Math.floor(u.kills))
      : 0;

  const persisted: PersistedUnit = {
    id: u.id,
    name: u.name,
    gender,
    zodiac,
    level,
    exp,
    totalExp,
    kills,
    currentJob: u.currentJob,
    jobs,
    equipment,
    raw: rawStats,
    brave,
    faith,
  };

  if (typeof u.secondaryAction === 'string') persisted.secondaryAction = u.secondaryAction;
  if (typeof u.reaction === 'string') persisted.reaction = u.reaction;
  if (typeof u.support === 'string') persisted.support = u.support;
  if (typeof u.movement === 'string') persisted.movement = u.movement;

  return persisted;
}

function normalizeRaw(raw: unknown, fallback: Record<string, unknown>): RawStats {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    return {
      hp: num(r.hp, 100),
      mp: num(r.mp, 40),
      pa: num(r.pa, 8),
      ma: num(r.ma, 8),
      spd: num(r.spd, 8),
    };
  }
  // v0 may have stored raw stats flat on the unit.
  return {
    hp: num(fallback.rawHp, 100),
    mp: num(fallback.rawMp, 40),
    pa: num(fallback.pa, 8),
    ma: num(fallback.ma, 8),
    spd: num(fallback.spd, 8),
  };
}

function normalizeJobs(raw: unknown): Record<JobId, PersistedJobProgress> {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<JobId, PersistedJobProgress> = {};
  for (const [jobId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const p = value as Record<string, unknown>;
    const learned = Array.isArray(p.learned)
      ? p.learned.filter((id): id is string => typeof id === 'string')
      : [];
    out[jobId] = {
      level: typeof p.level === 'number' ? Math.max(1, Math.floor(p.level)) : 1,
      jp: typeof p.jp === 'number' ? Math.max(0, Math.floor(p.jp)) : 0,
      totalJp: typeof p.totalJp === 'number' ? Math.max(0, Math.floor(p.totalJp)) : 0,
      learned: [...learned].sort(),
    };
  }
  return out;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario launch / battle write-back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark which scenario the player is entering.
 *
 * Pins `progress.current` on a *new* campaign object (does not mutate `campaign`).
 * {@link campaignToBattle} mutates the caller's campaign in place instead, so
 * write-back works with the object the caller already holds.
 *
 * Overwrites any stale `progress.current` so a previous scenario cannot be
 * credited by accident.
 */
export function beginScenario(
  campaign: CampaignState,
  scenarioId: string,
  timestamp: number,
): CampaignState {
  return {
    ...campaign,
    roster: campaign.roster.map(structuredClonePersisted),
    inventory: { ...campaign.inventory },
    formation: (campaign.formation ?? []).map((e) => ({ ...e })),
    progress: {
      completed: [...campaign.progress.completed],
      current: scenarioId,
    },
    updatedAt: timestamp,
  };
}

/**
 * Fold a finished (or abandoned) battle back into the campaign.
 *
 * Writes: exp, JP, levels, learned abilities, equipment, support slots, raw stats,
 * party inventory stock, and — on victory — `progress.current` into
 * `progress.completed`. Does not mutate `campaign` or `battle`; returns a new state.
 *
 * Scenario identity comes only from `campaign.progress.current`. Launch via
 * {@link campaignToBattle} pins `current` on the *caller's* campaign object, so
 * `battleToCampaign(originalCampaign, battle, ts)` records completion without
 * requiring the caller to keep a separate launched copy.
 *
 * Inventory: reads `battle.inventories` for the player team if present. Does not
 * call `inventoryFor` (which would mutate the battle and manufacture default
 * stock). When the battle has no player inventory map, campaign inventory is kept.
 */
export function battleToCampaign(
  campaign: CampaignState,
  battle: BattleState,
  timestamp: number,
): CampaignState {
  const nextRoster: PersistedUnit[] = [];

  // Preserve roster order; update any unit that fought, keep bench units as-is.
  for (const previous of campaign.roster) {
    const live = battle.units.get(previous.id);
    if (live && live.team === 'player') {
      nextRoster.push(unitToPersisted(live));
    } else {
      nextRoster.push(structuredClonePersisted(previous));
    }
  }

  // Pure read — never install a default pile on the battle.
  const battleStock = battle.inventories?.get('player');
  const inventory =
    battleStock !== undefined
      ? stockToRecord(battleStock)
      : { ...campaign.inventory };

  const completed = [...campaign.progress.completed];
  const current = campaign.progress.current;
  if (battle.phase === 'victory' && current !== undefined) {
    if (!completed.includes(current)) {
      completed.push(current);
    }
  }

  const progress: CampaignProgress = { completed };
  if (current !== undefined) {
    progress.current = current;
  }

  return {
    version: CAMPAIGN_VERSION,
    seed: campaign.seed,
    gil: campaign.gil,
    roster: nextRoster,
    inventory,
    // Formation is a pre-battle choice; write-back leaves it alone.
    formation: (campaign.formation ?? []).map((e) => ({ ...e })),
    progress,
    createdAt: campaign.createdAt,
    updatedAt: timestamp,
  };
}

function stockToRecord(stock: ReadonlyMap<ItemId, number>): Record<ItemId, number> {
  const out: Record<ItemId, number> = {};
  for (const [id, n] of stock) {
    if (n > 0) out[id] = n;
  }
  return out;
}

function structuredClonePersisted(u: PersistedUnit): PersistedUnit {
  const copy: PersistedUnit = {
    id: u.id,
    name: u.name,
    gender: u.gender,
    zodiac: u.zodiac,
    level: u.level,
    exp: u.exp,
    totalExp: u.totalExp,
    kills: u.kills ?? 0,
    currentJob: u.currentJob,
    jobs: {},
    equipment: { ...u.equipment },
    raw: { ...u.raw },
    brave: u.brave,
    faith: u.faith,
  };
  for (const [jobId, progress] of Object.entries(u.jobs)) {
    copy.jobs[jobId] = {
      level: progress.level,
      jp: progress.jp,
      totalJp: progress.totalJp,
      learned: [...progress.learned],
    };
  }
  if (u.secondaryAction !== undefined) copy.secondaryAction = u.secondaryAction;
  if (u.reaction !== undefined) copy.reaction = u.reaction;
  if (u.support !== undefined) copy.support = u.support;
  if (u.movement !== undefined) copy.movement = u.movement;
  return copy;
}

/** Deep structural equality for CampaignState (tests and save-guard). */
export function campaignsEqual(a: CampaignState, b: CampaignState): boolean {
  return serialize(a) === serialize(b);
}
