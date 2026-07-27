/**
 * EverTactics — job registry.
 *
 * `JOBS` is the single source of truth for every playable job. It is assembled from three
 * lineage tables (`fft.ts`, `eq2.ts`, `wow.ts`) and is immutable at runtime.
 *
 * `Job` (in `core/types.ts`) is deliberately narrow: it describes what every job has.
 * The EverQuest 2 and World of Warcraft jobs carry mechanics FFT has no vocabulary for —
 * threat tables, absorb wards, permanent pets, combo points, stances, tile-anchored totems.
 * Rather than widening the frozen `Job` contract, those live in a parallel table,
 * `JOB_MECHANICS`, declared here and consumed by `core/abilities/`, `core/combat/` and
 * `core/ai/`. A job with no entry has no special resource behaviour.
 *
 * Nothing in this module imports three.js, and nothing here is mutable.
 */

import type { AbilityId, AbilitySetId, Job, JobId, JobOrigin, StatusId } from '../types';
import { FFT_JOBS } from './fft';
import { EQ2_JOBS, EQ2_MECHANICS } from './eq2';
import { WOW_JOBS, WOW_MECHANICS } from './wow';

// ─────────────────────────────────────────────────────────────────────────────
// Extended mechanics vocabulary (additive — `core/types.ts` is untouched)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A job-scoped resource bar tracked alongside HP/MP for the duration of a battle.
 * The combat layer owns the numbers; this table declares that the bar exists and how it behaves.
 */
export interface JobResource {
  /** Stable key. Ability definitions reference this to spend/generate. */
  readonly id: string;
  readonly name: string;
  /** Maximum value. */
  readonly max: number;
  /** Value the unit enters battle with. */
  readonly startsAt: number;
  /** Passive change applied at the start of each of the unit's turns (may be negative). */
  readonly perTurn: number;
  /** True when the bar empties completely if the unit ends a turn without spending it. */
  readonly decaysOnIdle: boolean;
  /** True when the resource is attached to a target rather than the owner (e.g. combo points). */
  readonly onTarget: boolean;
  readonly description: string;
}

/** Coarse tags the ability, AI and UI layers branch on without knowing the job. */
export type JobMechanicTag =
  | 'threat'          // generates and manipulates a threat table
  | 'ward'            // applies absorb shields that soak damage before HP
  | 'charm'           // takes control of enemy units
  | 'pet'             // commands a persistent second body on the field
  | 'aura'            // emits a persistent radius effect from the unit
  | 'dot'             // stacking damage-over-time is the core damage pattern
  | 'combo'           // builder/finisher resource on the target
  | 'stealth'         // enters an untargetable-until-acting state
  | 'stance'          // swaps form, changing stats and command set
  | 'totem'           // places persistent entities on tiles
  | 'lifetap'         // converts damage dealt into self healing
  | 'resurrect';      // returns fallen units, possibly as something else

/** A persistent companion unit the job brings onto the field. */
export interface PetSpec {
  readonly id: string;
  readonly name: string;
  /** Sprite sheet key (see docs/JOBS.md for the key convention). */
  readonly sprite: string;
  /** Pet stats are derived as `master.stat * scale` at summon time. */
  readonly scale: { hp: number; pa: number; ma: number; spd: number; move: number; jump: number };
  /** Ability set the pet acts with when the AI drives it. */
  readonly actionSet: AbilitySetId;
  /** True when the pet is present from the first tick rather than being summoned. */
  readonly permanent: boolean;
  /** True when the pet's death costs the master something (declared per-job in `notes`). */
  readonly deathPenalty: boolean;
}

/** A form the unit can shift into, replacing its stats and command set. */
export interface StanceSpec {
  readonly id: string;
  readonly name: string;
  /** Sprite sheet override while in this stance; undefined keeps the base job sprite. */
  readonly sprite?: { male: string; female: string };
  /** Command set granted while shifted. */
  readonly actionSet: AbilitySetId;
  /** Percent deltas applied on top of the job multipliers (0 = unchanged). */
  readonly mult: { hp: number; pa: number; ma: number; spd: number };
  readonly move: number;
  readonly jump: number;
  readonly cEvade: number;
  /** Statuses forced on while shifted. */
  readonly grants: readonly StatusId[];
  readonly description: string;
}

/** How a job interacts with the threat table used by tank AI. */
export interface ThreatProfile {
  /** Multiplier on all threat this job generates (1 = baseline). */
  readonly generated: number;
  /** True when the job has a hard taunt that forces target selection. */
  readonly hasTaunt: boolean;
  /** Flat threat added per point of damage dealt, on top of `generated`. */
  readonly perDamage: number;
  /** Flat threat added per point of healing done. */
  readonly perHeal: number;
}

/** Absorb-shield behaviour. Wards subtract from incoming damage before HP is touched. */
export interface WardProfile {
  /** Formula coefficient: ward amount = MA * `coefficient` for the job's baseline ward. */
  readonly coefficient: number;
  /** Wards expire after this many CT ticks unless the ability overrides it. */
  readonly duration: number;
  /** True when multiple wards on one unit stack rather than replacing. */
  readonly stacks: boolean;
}

export interface JobMechanics {
  readonly job: JobId;
  readonly tags: readonly JobMechanicTag[];
  readonly resources: readonly JobResource[];
  readonly pets: readonly PetSpec[];
  readonly stances: readonly StanceSpec[];
  readonly threat?: ThreatProfile;
  readonly ward?: WardProfile;
  /** Abilities the ability layer must implement for this job to function at all. */
  readonly keyAbilities: readonly AbilityId[];
  /** Design intent — read this before touching the numbers. */
  readonly notes: string;
  /** Which existing sprite sheet this job borrows and what art work it still needs. */
  readonly spriteBorrow?: { readonly from: string; readonly recolour: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const ALL_JOBS: readonly Job[] = [...FFT_JOBS, ...EQ2_JOBS, ...WOW_JOBS];

function buildJobs(): ReadonlyMap<JobId, Job> {
  const map = new Map<JobId, Job>();
  for (const job of ALL_JOBS) {
    if (map.has(job.id)) throw new Error(`Duplicate job id: ${job.id}`);
    map.set(job.id, job);
  }
  return map;
}

/** Every job in the game, keyed by id. Insertion order is FFT, then EQ2, then WoW. */
export const JOBS: ReadonlyMap<JobId, Job> = buildJobs();

/** Extended mechanics for jobs that have them. FFT jobs are intentionally absent. */
export const JOB_MECHANICS: ReadonlyMap<JobId, JobMechanics> = new Map(
  [...EQ2_MECHANICS, ...WOW_MECHANICS].map((m) => [m.job, m] as const),
);

/** Lookup that never lies: throws on an unknown id rather than returning undefined. */
export function getJob(id: JobId): Job {
  const job = JOBS.get(id);
  if (job === undefined) throw new Error(`Unknown job id: ${id}`);
  return job;
}

/** Non-throwing lookup for UI paths that may hold a stale id. */
export function findJob(id: JobId): Job | undefined {
  return JOBS.get(id);
}

/** All jobs, in registry order. */
export function allJobs(): readonly Job[] {
  return ALL_JOBS;
}

export function jobsByOrigin(origin: JobOrigin): readonly Job[] {
  return ALL_JOBS.filter((j) => j.origin === origin);
}

export function getJobMechanics(id: JobId): JobMechanics | undefined {
  return JOB_MECHANICS.get(id);
}

/** Every ability set referenced by a job's primary command. */
export function allActionSets(): readonly AbilitySetId[] {
  const seen = new Set<AbilitySetId>();
  for (const job of ALL_JOBS) seen.add(job.actionSet);
  for (const m of JOB_MECHANICS.values()) {
    for (const stance of m.stances) seen.add(stance.actionSet);
    for (const pet of m.pets) seen.add(pet.actionSet);
  }
  return [...seen];
}

/** Every ability id any job can teach or grant, deduplicated. */
export function allJobAbilityIds(): readonly AbilityId[] {
  const seen = new Set<AbilityId>();
  for (const job of ALL_JOBS) {
    for (const l of job.learnable) seen.add(l.ability);
    for (const i of job.innate) seen.add(i);
  }
  for (const m of JOB_MECHANICS.values()) {
    for (const k of m.keyAbilities) seen.add(k);
  }
  return [...seen];
}

/** Total JP required to learn everything a job teaches. Used by the job-detail panel. */
export function totalJpToMaster(id: JobId): number {
  return getJob(id).learnable.reduce((sum, l) => sum + l.jp, 0);
}

/**
 * Structural self-check. Returns a list of problems; empty means the table is coherent.
 * Called by the job unit tests, and cheap enough to call from a dev build.
 */
export function validateJobs(): string[] {
  const problems: string[] = [];
  const ids = new Set(ALL_JOBS.map((j) => j.id));

  for (const job of ALL_JOBS) {
    for (const req of job.requires) {
      if (!ids.has(req.job)) {
        problems.push(`${job.id}: requires unknown job "${req.job}"`);
      }
      if (req.level < 1 || req.level > 8) {
        problems.push(`${job.id}: requirement on ${req.job} has out-of-range level ${req.level}`);
      }
      if (req.job === job.id) {
        problems.push(`${job.id}: requires itself`);
      }
    }
    const learned = new Set<AbilityId>();
    for (const l of job.learnable) {
      if (learned.has(l.ability)) problems.push(`${job.id}: duplicate learnable "${l.ability}"`);
      learned.add(l.ability);
      if (l.jp <= 0) problems.push(`${job.id}: "${l.ability}" has non-positive JP cost`);
    }
    if (job.move < 1 || job.jump < 1) {
      problems.push(`${job.id}: move/jump must be at least 1`);
    }
    for (const key of ['hp', 'mp', 'pa', 'ma', 'spd'] as const) {
      if (job.growth[key] <= 0) problems.push(`${job.id}: growth.${key} must be positive`);
      if (job.mult[key] < 0) problems.push(`${job.id}: mult.${key} must not be negative`);
    }
  }

  for (const m of JOB_MECHANICS.values()) {
    if (!ids.has(m.job)) problems.push(`mechanics: unknown job "${m.job}"`);
  }

  return problems;
}

export { FFT_JOBS } from './fft';
export { EQ2_JOBS, EQ2_MECHANICS } from './eq2';
export { WOW_JOBS, WOW_MECHANICS } from './wow';
