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
import {
  createUnit,
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

export interface CampaignState {
  version: number;
  /** Campaign-level seed so random encounters stay deterministic. */
  seed: number;
  gil: number;
  /** The player's company — not a BattleState. */
  roster: PersistedUnit[];
  inventory: Record<ItemId, number>;
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
 */
export function migrate(raw: unknown): CampaignState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('campaign migrate: expected an object');
  }

  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'number' ? obj.version : 0;

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
    const roster = normalizeRoster(obj.roster);

    return {
      version: CAMPAIGN_VERSION,
      seed: seed | 0,
      gil: Math.max(0, Math.floor(gil)),
      roster,
      inventory,
      progress,
      createdAt,
      updatedAt,
    };
  }

  // v1 (current): require the full shape. Missing or wrong-typed roster /
  // inventory / progress must throw — silently wiping them to {} would brick a
  // corrupt save into an empty campaign that loadCampaign treats as valid.
  if (typeof obj.seed !== 'number' || !Number.isFinite(obj.seed)) {
    throw new Error('campaign migrate: missing or invalid seed');
  }
  if (typeof obj.gil !== 'number' || !Number.isFinite(obj.gil)) {
    throw new Error('campaign migrate: missing or invalid gil');
  }
  if (typeof obj.createdAt !== 'number' || !Number.isFinite(obj.createdAt)) {
    throw new Error('campaign migrate: missing or invalid createdAt');
  }
  if (typeof obj.updatedAt !== 'number' || !Number.isFinite(obj.updatedAt)) {
    throw new Error('campaign migrate: missing or invalid updatedAt');
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
  const progressObj = obj.progress as Record<string, unknown>;
  if (!Array.isArray(progressObj.completed)) {
    throw new Error('campaign migrate: progress.completed must be an array');
  }

  return {
    version: CAMPAIGN_VERSION,
    seed: obj.seed | 0,
    gil: Math.max(0, Math.floor(obj.gil)),
    roster: normalizeRoster(obj.roster),
    inventory: normalizeInventory(obj.inventory),
    progress: normalizeProgress(obj.progress),
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
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

function normalizeRoster(raw: unknown): PersistedUnit[] {
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

  const gender = (u.gender as Gender) ?? 'male';
  const zodiac = (u.zodiac as Zodiac) ?? 'aries';
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

  const persisted: PersistedUnit = {
    id: u.id,
    name: u.name,
    gender,
    zodiac,
    level,
    exp,
    totalExp,
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
// Battle write-back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a finished (or abandoned) battle back into the campaign.
 *
 * Writes: exp, JP, levels, learned abilities, equipment, support slots, raw stats,
 * party inventory stock, and — on victory — the scenario id into
 * `progress.completed`. Does not mutate `campaign` or `battle`; returns a new state.
 *
 * Scenario identity: pass `scenarioId` (preferred). Falls back to
 * `campaign.progress.current` only when the caller omitted it. Completion is a
 * no-op when neither is set — never invents an id.
 *
 * Inventory: reads `battle.inventories` for the player team if present. Does not
 * call `inventoryFor` (which would mutate the battle and manufacture default
 * stock). When the battle has no player inventory map, campaign inventory is kept.
 */
export function battleToCampaign(
  campaign: CampaignState,
  battle: BattleState,
  timestamp: number,
  scenarioId?: string,
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

  const completedScenario = scenarioId ?? campaign.progress.current;
  const completed = [...campaign.progress.completed];
  if (battle.phase === 'victory' && completedScenario) {
    if (!completed.includes(completedScenario)) {
      completed.push(completedScenario);
    }
  }

  const progress: CampaignProgress = { completed };
  const current = scenarioId ?? campaign.progress.current;
  if (current !== undefined) {
    progress.current = current;
  }

  return {
    version: CAMPAIGN_VERSION,
    seed: campaign.seed,
    gil: campaign.gil,
    roster: nextRoster,
    inventory,
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
