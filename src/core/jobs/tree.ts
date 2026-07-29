/**
 * EverTactics — the job tree: unlock rules, job levels, and the layout the UI draws.
 *
 * Pure and deterministic. No three.js, no randomness, no mutation of the unit passed in.
 */

import type { Gender, Job, JobId, JobRequirement, Unit } from '../types';
import { JOBS, allJobs, getJob } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// Job levels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Total JP earned in a job required to reach job level 2..8, in order.
 * FFT's own table. Job level 1 is free the moment the job is unlocked.
 */
export const JOB_LEVEL_THRESHOLDS: readonly number[] = [100, 200, 400, 700, 1100, 1600, 2200, 3000];

export const MAX_JOB_LEVEL = 8;

/**
 * Job level from lifetime JP earned in that job.
 *
 * Note the FFT quirk this preserves: it is *total* JP ever earned that gates job level, not
 * the unspent balance. Spending JP on abilities never costs you tree progress.
 */
export function jobLevelFromJp(totalJp: number): number {
  if (!Number.isFinite(totalJp) || totalJp <= 0) return 1;
  let level = 1;
  for (const threshold of JOB_LEVEL_THRESHOLDS) {
    if (totalJp >= threshold) level += 1;
    else break;
  }
  return Math.min(level, MAX_JOB_LEVEL);
}

/** Lifetime JP needed to reach a given job level. Level <= 1 costs nothing. */
export function jpForJobLevel(level: number): number {
  if (level <= 1) return 0;
  const idx = Math.min(level, MAX_JOB_LEVEL) - 2;
  return JOB_LEVEL_THRESHOLDS[idx] ?? Number.POSITIVE_INFINITY;
}

/** JP still needed to reach the next job level. 0 when already at max. */
export function jpToNextJobLevel(totalJp: number): number {
  const level = jobLevelFromJp(totalJp);
  if (level >= MAX_JOB_LEVEL) return 0;
  return Math.max(0, jpForJobLevel(level + 1) - totalJp);
}

/** Fractional progress (0..1) through the current job level, for the UI bar. */
export function jobLevelProgress(totalJp: number): number {
  const level = jobLevelFromJp(totalJp);
  if (level >= MAX_JOB_LEVEL) return 1;
  const floor = jpForJobLevel(level);
  const ceil = jpForJobLevel(level + 1);
  if (ceil <= floor) return 1;
  return Math.min(1, Math.max(0, (totalJp - floor) / (ceil - floor)));
}

/** The unit's level in a job, derived from its lifetime JP. Unentered jobs are level 0. */
export function jobLevelOf(unit: Unit, jobId: JobId): number {
  const progress = unit.jobs.get(jobId);
  if (progress === undefined) return 0;
  // Trust whichever is higher: stored level (story grants, cheats) or JP-derived.
  return Math.max(progress.level, jobLevelFromJp(progress.totalJp));
}

// ─────────────────────────────────────────────────────────────────────────────
// Gender locks and special conditions
// ─────────────────────────────────────────────────────────────────────────────

/** Jobs only one gender may take. FFT's Bard/Dancer split, kept. */
export const GENDER_LOCKED: ReadonlyMap<JobId, Gender> = new Map<JobId, Gender>([
  ['bard', 'male'],
  ['dancer', 'female'],
]);

/** Extra context a scenario can supply for unlocks that depend on more than job levels. */
export interface UnlockContext {
  /** Enemies this unit has personally KO'd across the campaign. */
  kills?: number;
}

export interface SpecialCondition {
  readonly job: JobId;
  /** Human-readable requirement for the job menu. */
  readonly text: string;
  readonly met: (unit: Unit, ctx: UnlockContext) => boolean;
}

function killCountOf(unit: Unit, ctx: UnlockContext): number {
  return ctx.kills ?? unit.kills ?? 0;
}

/**
 * Non-job-level unlock gates. Kept as data so the UI can list them alongside the
 * job-level requirements without special-casing anything.
 */
export const SPECIAL_CONDITIONS: ReadonlyMap<JobId, SpecialCondition> = new Map<
  JobId,
  SpecialCondition
>([
  [
    'dark-knight',
    {
      job: 'dark-knight',
      text: 'Defeat 20 units with this character',
      met: (unit, ctx) => killCountOf(unit, ctx) >= 20,
    },
  ],
  [
    'death-knight',
    {
      job: 'death-knight',
      text: 'Defeat 30 units with this character',
      met: (unit, ctx) => killCountOf(unit, ctx) >= 30,
    },
  ],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Unlocking
// ─────────────────────────────────────────────────────────────────────────────

/** Why a job is or is not available, in a form the job menu can render directly. */
export interface UnlockStatus {
  readonly job: JobId;
  readonly unlocked: boolean;
  /** Requirements the unit has not met yet. */
  readonly missing: readonly JobRequirement[];
  /** Requirements already satisfied, so the UI can tick them off. */
  readonly met: readonly JobRequirement[];
  /** Set when the job is barred by gender. */
  readonly genderLocked?: Gender;
  /** Set when a special condition exists; `specialMet` says whether it passes. */
  readonly special?: string;
  readonly specialMet: boolean;
}

/** Full breakdown of a unit's eligibility for a job. Never throws on an unknown id. */
export function unlockStatus(unit: Unit, jobId: JobId, ctx: UnlockContext = {}): UnlockStatus {
  const job = JOBS.get(jobId);
  if (job === undefined) {
    return { job: jobId, unlocked: false, missing: [], met: [], specialMet: false };
  }

  const genderLock = GENDER_LOCKED.get(jobId);
  const genderOk = unit.gender !== 'monster' && (genderLock === undefined || genderLock === unit.gender);

  const missing: JobRequirement[] = [];
  const met: JobRequirement[] = [];
  for (const req of job.requires) {
    if (jobLevelOf(unit, req.job) >= req.level) met.push(req);
    else missing.push(req);
  }

  const condition = SPECIAL_CONDITIONS.get(jobId);
  const specialMet = condition === undefined ? true : condition.met(unit, ctx);

  return {
    job: jobId,
    unlocked: genderOk && missing.length === 0 && specialMet,
    missing,
    met,
    ...(genderLock !== undefined && genderLock !== unit.gender ? { genderLocked: genderLock } : {}),
    ...(condition !== undefined ? { special: condition.text } : {}),
    specialMet,
  };
}

/** True when the unit may switch to this job right now. */
export function canUnlock(unit: Unit, jobId: JobId, ctx: UnlockContext = {}): boolean {
  return unlockStatus(unit, jobId, ctx).unlocked;
}

/** Every job the unit may currently take, in registry order. */
export function unlockedJobs(unit: Unit, ctx: UnlockContext = {}): readonly Job[] {
  return allJobs().filter((job) => canUnlock(unit, job.id, ctx));
}

/**
 * Jobs that are one requirement away from unlocking — the "next goals" list the job menu
 * shows under the available jobs so the player always knows what to grind toward.
 */
export function nearlyUnlockedJobs(unit: Unit, ctx: UnlockContext = {}): readonly UnlockStatus[] {
  const out: UnlockStatus[] = [];
  for (const job of allJobs()) {
    const status = unlockStatus(unit, job.id, ctx);
    if (status.unlocked) continue;
    if (status.genderLocked !== undefined) continue;
    if (status.missing.length === 1 || (status.missing.length === 0 && !status.specialMet)) {
      out.push(status);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The graph
// ─────────────────────────────────────────────────────────────────────────────

export interface JobEdge {
  readonly from: JobId;
  readonly to: JobId;
  /** Level of `from` required. */
  readonly level: number;
}

function buildEdges(): readonly JobEdge[] {
  const edges: JobEdge[] = [];
  for (const job of allJobs()) {
    for (const req of job.requires) {
      edges.push({ from: req.job, to: job.id, level: req.level });
    }
  }
  return edges;
}

/** Every prerequisite relationship in the roster, derived from the job table. */
export const JOB_EDGES: readonly JobEdge[] = buildEdges();

/** Jobs directly unlocked by progressing this one. */
export function childrenOf(jobId: JobId): readonly JobEdge[] {
  return JOB_EDGES.filter((e) => e.from === jobId);
}

/** Jobs this one directly depends on. */
export function parentsOf(jobId: JobId): readonly JobEdge[] {
  return JOB_EDGES.filter((e) => e.to === jobId);
}

/**
 * Every job that must be levelled, transitively, before `jobId` can be taken —
 * with the highest level required for each. Used by the "path to this job" panel.
 */
export function prerequisiteClosure(jobId: JobId): ReadonlyMap<JobId, number> {
  const needed = new Map<JobId, number>();
  const stack: JobRequirement[] = [...getJob(jobId).requires];
  while (stack.length > 0) {
    const req = stack.pop();
    if (req === undefined) break;
    const existing = needed.get(req.job) ?? 0;
    if (req.level <= existing) continue;
    needed.set(req.job, req.level);
    const parent = JOBS.get(req.job);
    if (parent !== undefined) stack.push(...parent.requires);
  }
  return needed;
}

/** Total JP a unit still needs across all prerequisite jobs to reach `jobId`. */
export function jpRemainingToUnlock(unit: Unit, jobId: JobId): number {
  let total = 0;
  for (const [reqJob, reqLevel] of prerequisiteClosure(jobId)) {
    const progress = unit.jobs.get(reqJob);
    const earned = progress?.totalJp ?? 0;
    total += Math.max(0, jpForJobLevel(reqLevel) - earned);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout data for the tree screen
// ─────────────────────────────────────────────────────────────────────────────

/** Lanes the tree screen renders side by side, one per lineage. */
export interface JobTreeLane {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
}

export const JOB_TREE_LANES: readonly JobTreeLane[] = [
  {
    id: 'fft',
    title: 'The Orders of Ivalice',
    subtitle: 'The classical tree. Every soldier starts as a Squire or a Chemist.',
  },
  {
    id: 'eq2',
    title: 'The Foreign Disciplines',
    subtitle: 'Traditions carried in from beyond the Zeklaus — wards, bonds and coercion.',
  },
  {
    id: 'wow',
    title: 'The Old Covenants',
    subtitle: 'Older, harsher pacts: runes, fel, totems and the wild shape.',
  },
];

/**
 * A node's placement on the tree screen. `column` runs left-to-right (unlock depth) and
 * `row` runs top-to-bottom within the lane. Units are grid cells, not pixels — the UI
 * multiplies by whatever card size it uses.
 */
export interface JobTreeNode {
  readonly job: JobId;
  readonly lane: string;
  readonly column: number;
  readonly row: number;
}

export const JOB_TREE_LAYOUT: readonly JobTreeNode[] = [
  // ── FFT lane: two roots, six branches, an elite column and the capstones ──
  { job: 'squire', lane: 'fft', column: 0, row: 3 },
  { job: 'chemist', lane: 'fft', column: 0, row: 9 },

  { job: 'knight', lane: 'fft', column: 1, row: 1 },
  { job: 'archer', lane: 'fft', column: 1, row: 4 },
  { job: 'white-mage', lane: 'fft', column: 1, row: 8 },
  { job: 'black-mage', lane: 'fft', column: 1, row: 11 },

  { job: 'monk', lane: 'fft', column: 2, row: 1 },
  { job: 'thief', lane: 'fft', column: 2, row: 4 },
  { job: 'mystic', lane: 'fft', column: 2, row: 8 },
  { job: 'time-mage', lane: 'fft', column: 2, row: 11 },

  { job: 'geomancer', lane: 'fft', column: 3, row: 1 },
  { job: 'dragoon', lane: 'fft', column: 3, row: 4 },
  { job: 'orator', lane: 'fft', column: 3, row: 8 },
  { job: 'summoner', lane: 'fft', column: 3, row: 11 },

  { job: 'samurai', lane: 'fft', column: 4, row: 0 },
  { job: 'ninja', lane: 'fft', column: 4, row: 3 },
  { job: 'arithmetician', lane: 'fft', column: 4, row: 10 },
  { job: 'dark-knight', lane: 'fft', column: 4, row: 13 },

  { job: 'bard', lane: 'fft', column: 5, row: 2 },
  { job: 'dancer', lane: 'fft', column: 5, row: 5 },
  { job: 'mime', lane: 'fft', column: 5, row: 8 },
  { job: 'onion-knight', lane: 'fft', column: 5, row: 11 },

  // ── EQ2 lane ──
  { job: 'shadowknight', lane: 'eq2', column: 0, row: 0 },
  { job: 'templar', lane: 'eq2', column: 0, row: 3 },
  { job: 'beastlord', lane: 'eq2', column: 0, row: 6 },
  { job: 'coercer', lane: 'eq2', column: 1, row: 0 },
  { job: 'troubador', lane: 'eq2', column: 1, row: 3 },
  { job: 'dirge', lane: 'eq2', column: 1, row: 6 },

  // ── WoW lane ──
  { job: 'paladin', lane: 'wow', column: 0, row: 0 },
  { job: 'druid', lane: 'wow', column: 0, row: 3 },
  { job: 'rogue', lane: 'wow', column: 0, row: 6 },
  { job: 'death-knight', lane: 'wow', column: 1, row: 0 },
  { job: 'warlock', lane: 'wow', column: 1, row: 3 },
  { job: 'shaman', lane: 'wow', column: 1, row: 6 },
];

/** Layout lookup for a single job. */
export function layoutOf(jobId: JobId): JobTreeNode | undefined {
  return JOB_TREE_LAYOUT.find((n) => n.job === jobId);
}

/** Nodes belonging to one lane, sorted for stable rendering. */
export function laneNodes(laneId: string): readonly JobTreeNode[] {
  return JOB_TREE_LAYOUT.filter((n) => n.lane === laneId).sort(
    (x, y) => x.column - y.column || x.row - y.row,
  );
}

/**
 * Structural check for the tree specifically: every job placed exactly once, no cycles,
 * every prerequisite drawn to the left of its dependant within a lane.
 * Returns an empty array when the tree is sound.
 */
export function validateTree(): string[] {
  const problems: string[] = [];
  const placed = new Set<JobId>();

  for (const node of JOB_TREE_LAYOUT) {
    if (placed.has(node.job)) problems.push(`tree: ${node.job} placed twice`);
    placed.add(node.job);
    if (!JOBS.has(node.job)) problems.push(`tree: layout references unknown job ${node.job}`);
    if (!JOB_TREE_LANES.some((l) => l.id === node.lane)) {
      problems.push(`tree: ${node.job} is in unknown lane ${node.lane}`);
    }
  }
  for (const job of allJobs()) {
    if (!placed.has(job.id)) problems.push(`tree: ${job.id} has no layout node`);
  }

  // Cycle detection over the requirement graph.
  const state = new Map<JobId, 'visiting' | 'done'>();
  const visit = (id: JobId, path: JobId[]): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      problems.push(`tree: cycle ${[...path, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    const job = JOBS.get(id);
    if (job !== undefined) {
      for (const req of job.requires) visit(req.job, [...path, id]);
    }
    state.set(id, 'done');
  };
  for (const job of allJobs()) visit(job.id, []);

  // Same-lane prerequisites should read left to right.
  for (const node of JOB_TREE_LAYOUT) {
    const job = JOBS.get(node.job);
    if (job === undefined) continue;
    for (const req of job.requires) {
      const parent = layoutOf(req.job);
      if (parent === undefined) continue;
      if (parent.lane === node.lane && parent.column >= node.column) {
        problems.push(
          `tree: ${node.job} (col ${node.column}) is not right of its prerequisite ${req.job} (col ${parent.column})`,
        );
      }
    }
  }

  return problems;
}
