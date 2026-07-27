/**
 * EverTactics — core state → full-screen view models.
 *
 * `viewModels.ts` adapts the battle HUD (unit panels, command rows, target
 * previews). This file does the same job for the three full-screen overlays:
 * the job tree, the formation slate and the roster ledger.
 *
 * Same contract as its sibling: nothing here mutates state, nothing here imports
 * three.js, and every value handed to `src/ui` is plain serialisable data.
 *
 * The numbers are the real ones. Job levels come from `core/jobs/tree`, JP
 * balances from the unit's own `JobProgress`, and ability prices from
 * `Job.learnable` — the same table `core/unit.learnAbility` charges against, so
 * anything the screen calls affordable really is purchasable.
 */

import { unitVM } from './viewModels';

import { ABILITY_SETS, getAbility } from '@core/abilities';
import { JOBS, allJobs, findJob } from '@core/jobs';
import { jobLevelOf, unlockStatus, type UnlockContext } from '@core/jobs/tree';
import { jobProgress } from '@core/unit';
import type { Ability, AbilitySetId, BattleState, Job, JobId, Unit } from '@core/types';
import type {
  AbilitySlotVM,
  FormationScreenVM,
  FormationSlotVM,
  JobNodeVM,
  JobScreenVM,
  LearnableVM,
  RosterScreenVM,
} from '@ui/types';

// ─────────────────────────────────────────────────────────────────────────────
// Tree geometry
// ─────────────────────────────────────────────────────────────────────────────

const tierCache = new Map<JobId, number>();

/**
 * A job's column in the tree: the longest requirement chain behind it.
 *
 * `JOB_TREE_LAYOUT` in `core/jobs/tree.ts` carries an authored column too, but it
 * restarts at 0 in each lineage lane, so an EQ2 job that requires a tier-4 FFT
 * job would draw to the *left* of its own prerequisite once the three lanes are
 * flattened into the single column strip `JobScreen` renders. Requirement depth
 * cannot do that: a parent is always at least one tier lower than its child, so
 * the tracery reads left to right for every edge in the graph.
 */
export function jobTier(jobId: JobId): number {
  const cached = tierCache.get(jobId);
  if (cached !== undefined) return cached;
  // Guard against a cycle in hand-authored data rather than blowing the stack.
  tierCache.set(jobId, 0);
  const job = JOBS.get(jobId);
  let depth = 0;
  if (job !== undefined) {
    for (const req of job.requires) {
      depth = Math.max(depth, jobTier(req.job) + 1);
    }
  }
  tierCache.set(jobId, depth);
  return depth;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job screen
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable unlock requirement, or undefined when the job is available. */
export function requirementText(unit: Unit, jobId: JobId, ctx: UnlockContext = {}): string | undefined {
  const status = unlockStatus(unit, jobId, ctx);
  if (status.unlocked) return undefined;
  const parts: string[] = [];
  if (status.genderLocked !== undefined) {
    parts.push(`${status.genderLocked === 'male' ? 'Male' : 'Female'} units only`);
  }
  for (const req of status.missing) {
    const job = findJob(req.job);
    parts.push(`${job?.name ?? req.job} Lv ${req.level}`);
  }
  if (status.special !== undefined && !status.specialMet) parts.push(status.special);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Learnable entries the job actually prices — the list `learnAbility` charges. */
function pricedLearnables(job: Job): { ability: Ability; jp: number }[] {
  const out: { ability: Ability; jp: number }[] = [];
  for (const entry of job.learnable) {
    const ability = getAbility(entry.ability);
    if (ability) out.push({ ability, jp: entry.jp });
  }
  return out;
}

/** How many of a job's priced learnables this unit already owns. */
function learnedCount(unit: Unit, job: Job): number {
  const learned = unit.jobs.get(job.id)?.learned;
  if (!learned) return 0;
  let n = 0;
  for (const entry of pricedLearnables(job)) {
    if (learned.has(entry.ability.id)) n += 1;
  }
  return n;
}

export function jobNodeVMs(unit: Unit, ctx: UnlockContext = {}): JobNodeVM[] {
  const out: JobNodeVM[] = [];
  for (const job of allJobs()) {
    const progress = unit.jobs.get(job.id);
    const status = unlockStatus(unit, job.id, ctx);
    // A unit standing in a job is in it whatever the requirement table says —
    // scenario units are authored straight into Knight or Black Mage without
    // ever having levelled the Squire the table asks for. A job it has *held*
    // stays open for the same reason: otherwise a scenario Knight who tries out
    // Monk can never go back, having no Squire levels to re-satisfy the gate.
    const current = job.id === unit.currentJob;
    const held = (progress?.totalJp ?? 0) > 0;
    const unlocked = status.unlocked || current || held;
    const requirement = unlocked ? undefined : requirementText(unit, job.id, ctx);
    const priced = pricedLearnables(job);
    out.push({
      id: job.id,
      name: job.name,
      origin: job.origin,
      blurb: job.blurb,
      jobLevel: jobLevelOf(unit, job.id),
      jp: progress?.jp ?? 0,
      totalJp: progress?.totalJp ?? 0,
      unlocked,
      ...(requirement !== undefined ? { requirement } : {}),
      current,
      tier: jobTier(job.id),
      parents: job.requires.map((r) => r.job),
      learned: learnedCount(unit, job),
      learnable: priced.length,
    });
  }
  return out;
}

export function learnableVMs(unit: Unit, jobId: JobId): LearnableVM[] {
  const job = findJob(jobId);
  if (!job) return [];
  const progress = unit.jobs.get(jobId);
  const learned = progress?.learned;
  const balance = progress?.jp ?? 0;
  return pricedLearnables(job).map(({ ability, jp }) => {
    const known = learned?.has(ability.id) ?? false;
    return {
      id: ability.id,
      name: ability.name,
      description: ability.description,
      jp,
      learned: known,
      affordable: !known && balance >= jp,
      slot: ability.slot,
    };
  });
}

function setName(setId: AbilitySetId): string {
  const meta = ABILITY_SETS.get(setId);
  if (meta?.name) return meta.name;
  return setId
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Every passive the unit has actually learned, in a given slot. */
function learnedPassives(unit: Unit, slot: 'reaction' | 'support' | 'movement'): Ability[] {
  const seen = new Set<string>();
  const out: Ability[] = [];
  for (const progress of unit.jobs.values()) {
    for (const id of progress.learned) {
      if (seen.has(id)) continue;
      const ability = getAbility(id);
      if (!ability || ability.slot !== slot) continue;
      seen.add(id);
      out.push(ability);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Skillsets the unit may borrow as its secondary command.
 *
 * FFT's rule is "any job you have unlocked", which for a fresh recruit is Squire
 * and Chemist and for a veteran is most of the tree. Jobs the unit has already
 * banked JP in count too, since a scenario can drop a unit straight into one.
 */
function secondaryOptions(
  unit: Unit,
  ctx: UnlockContext,
): { id: string; name: string; description: string }[] {
  const own = findJob(unit.currentJob)?.actionSet;
  const seen = new Set<AbilitySetId>();
  const out: { id: string; name: string; description: string }[] = [];
  for (const job of allJobs()) {
    if (job.actionSet === own) continue;
    if (seen.has(job.actionSet)) continue;
    if (!unlockStatus(unit, job.id, ctx).unlocked && !unit.jobs.has(job.id)) continue;
    seen.add(job.actionSet);
    out.push({ id: job.actionSet, name: setName(job.actionSet), description: job.blurb });
  }
  // Whatever is already equipped stays selectable even when its job is not.
  const current = unit.secondaryAction;
  if (current !== undefined && current !== own && !seen.has(current)) {
    out.unshift({ id: current, name: setName(current), description: 'Currently equipped.' });
  }
  return out;
}

export function abilitySlotVMs(unit: Unit, ctx: UnlockContext = {}): AbilitySlotVM[] {
  const slots: AbilitySlotVM[] = [];

  const secondary = secondaryOptions(unit, ctx);
  slots.push({
    slot: 'secondary',
    label: 'Secondary',
    ...(unit.secondaryAction !== undefined
      ? { assignedName: setName(unit.secondaryAction), assignedId: unit.secondaryAction }
      : {}),
    options: secondary,
  });

  const passive = [
    { slot: 'reaction', label: 'Reaction', assigned: unit.reaction },
    { slot: 'support', label: 'Support', assigned: unit.support },
    { slot: 'movement', label: 'Movement', assigned: unit.movement },
  ] as const;

  for (const entry of passive) {
    const options = learnedPassives(unit, entry.slot);
    const assigned = entry.assigned !== undefined ? getAbility(entry.assigned) : undefined;
    if (assigned && !options.some((o) => o.id === assigned.id)) options.unshift(assigned);
    slots.push({
      slot: entry.slot,
      label: entry.label,
      ...(assigned ? { assignedName: assigned.name, assignedId: assigned.id } : {}),
      options: options.map((a) => ({ id: a.id, name: a.name, description: a.description })),
    });
  }

  return slots;
}

/**
 * The whole job screen for one unit.
 *
 * `selectedJob` is the node the detail pane is focused on; it defaults to the
 * unit's current job and follows the tree cursor thereafter (`inspect-job`).
 */
export function jobScreenVM(
  state: BattleState,
  unit: Unit,
  selectedJob?: JobId,
  ctx: UnlockContext = {},
): JobScreenVM {
  const selected = selectedJob !== undefined && JOBS.has(selectedJob) ? selectedJob : unit.currentJob;
  // Touch the record so a unit that has never entered its own job still reports
  // a real (zeroed) progress line rather than blanks.
  jobProgress(unit, unit.currentJob);
  return {
    unit: unitVM(state, unit),
    jobs: jobNodeVMs(unit, ctx),
    learnables: learnableVMs(unit, selected),
    slots: abilitySlotVMs(unit, ctx),
    selectedJob: selected,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Roster
// ─────────────────────────────────────────────────────────────────────────────

/** Player-side units still on the field, in turn-rail order. */
export function partyUnits(state: BattleState): Unit[] {
  return [...state.units.values()].filter((u) => u.team === 'player' && !u.removed);
}

export function rosterScreenVM(
  state: BattleState,
  opts: { title?: string; gil?: number } = {},
): RosterScreenVM {
  const units = partyUnits(state);
  const notes: Record<string, string> = {};
  for (const unit of units) {
    const progress = jobProgress(unit, unit.currentJob);
    notes[unit.id] = `${progress.jp} JP · Job Lv ${jobLevelOf(unit, unit.currentJob)}`;
  }
  return {
    title: opts.title ?? 'Roster',
    units: units.map((u) => unitVM(state, u)),
    ...(opts.gil !== undefined ? { gil: opts.gil } : {}),
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formation
// ─────────────────────────────────────────────────────────────────────────────

/** FFT's tile naming: column letter, row number, 1-based. */
export function tileLabel(x: number, y: number): string {
  const letter = String.fromCharCode(65 + Math.max(0, Math.min(25, x)));
  return `${letter}${y + 1}`;
}

/**
 * The deployment slate.
 *
 * Once a battle has been joined the slate is a record of it, not an editor —
 * every slot is reported `locked` so the screen refuses reassignment rather than
 * teleporting a unit mid-turn. `maxDeployed` is the slate size.
 */
export function formationScreenVM(
  state: BattleState,
  opts: { title?: string; subtitle?: string; maxDeployed?: number; editable?: boolean } = {},
): FormationScreenVM {
  const units = partyUnits(state);
  const max = opts.maxDeployed ?? Math.max(units.length, 6);
  const locked = opts.editable !== true;
  const slots: FormationSlotVM[] = [];
  for (let i = 0; i < max; i++) {
    const unit = units[i];
    slots.push({
      index: i,
      ...(unit ? { unitId: unit.id, tile: tileLabel(unit.pos.x, unit.pos.y) } : {}),
      ...(locked ? { locked: true } : {}),
    });
  }
  return {
    title: opts.title ?? 'Formation',
    ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
    slots,
    roster: units.map((u) => unitVM(state, u)),
    maxDeployed: max,
  };
}
