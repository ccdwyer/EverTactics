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

import { findItem, shopStockForChapter } from './items';
import { unitVM } from './viewModels';

import { ABILITY_SETS, getAbility } from '@core/abilities';
import type { CampaignState, FormationEntry, PersistedUnit } from '@core/campaign';
import { unitFromPersisted } from '@core/campaign';
import { buyPrice, canAfford, sellPrice } from '@core/economy';
import { JOBS, allJobs, findJob } from '@core/jobs';
import { jobLevelOf, unlockStatus, type UnlockContext } from '@core/jobs/tree';
import { canEquipItem, canSwitchToJob, EQUIP_SLOT_ORDER, type EquipSlot } from '@core/party';
import { jobProgress } from '@core/unit';
import type { Ability, AbilitySetId, BattleState, Job, JobId, Unit, UnitId } from '@core/types';
import { WORLD_NODES, isUnlocked, nextObjective } from '@core/world';
import type {
  AbilitySlotVM,
  FormationScreenVM,
  FormationSlotVM,
  JobNodeVM,
  JobScreenVM,
  LearnableVM,
  RosterEquipSlotVM,
  RosterScreenVM,
  RosterUnitEditVM,
  ShopScreenVM,
  WorldMapScreenVM,
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
    // Must match `canSwitchToJob` in core/party.ts — UI and mutation gate must
    // agree or the panel shows a job as open and changeJob silently refuses.
    const current = job.id === unit.currentJob;
    const unlocked = canSwitchToJob(unit, job.id, ctx);
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
 * Matches `canAssignSecondarySet` in core/party: only skillsets the unit has
 * actually learned an ability from — not every unlocked or empty-banked job.
 */
function secondaryOptions(
  unit: Unit,
  _ctx: UnlockContext,
): { id: string; name: string; description: string }[] {
  const own = findJob(unit.currentJob)?.actionSet;
  const learned = new Set<string>();
  for (const progress of unit.jobs.values()) {
    for (const id of progress.learned) learned.add(id);
  }

  const seen = new Set<AbilitySetId>();
  const out: { id: string; name: string; description: string }[] = [];
  for (const job of allJobs()) {
    if (job.actionSet === own) continue;
    if (seen.has(job.actionSet)) continue;
    const setAbilities = [
      ...job.learnable.map((l) => l.ability),
      ...job.innate,
    ];
    if (!setAbilities.some((id) => learned.has(id))) continue;
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
  opts: { editable?: boolean } = {},
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
    ...(opts.editable === false ? { editable: false } : {}),
  };
}

/**
 * Job screen driven by the campaign roster — the durable source of truth for
 * JP, learned abilities and loadout. Used when the unit may be benched (not on
 * the current field) or when the live battle unit must not be the write target.
 */
export function campaignJobScreenVM(
  campaign: CampaignState,
  unitId: UnitId,
  selectedJob?: JobId,
  ctx: UnlockContext = {},
  opts: { editable?: boolean } = {},
): JobScreenVM | null {
  const persisted = campaign.roster.find((u) => u.id === unitId);
  if (!persisted) return null;
  const unit = hydratePersisted(persisted);
  return jobScreenVM(emptyBattleStub(), unit, selectedJob ?? unit.currentJob, ctx, opts);
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

/**
 * Editable formation slate for the campaign company.
 *
 * `startTiles` are the scenario's player deployment positions; `formation` is
 * the current assignment (slot index → unit). Empty slots stay open for fill.
 */
export function campaignFormationScreenVM(
  campaign: CampaignState,
  opts: {
    startTiles: readonly { x: number; y: number }[];
    formation?: readonly FormationEntry[];
    title?: string;
    subtitle?: string;
    maxDeployed?: number;
    /** False mid-battle — every slot is locked (viewer only). Default true. */
    editable?: boolean;
  },
): FormationScreenVM {
  const startTiles = opts.startTiles;
  const max = opts.maxDeployed ?? startTiles.length;
  const formation = opts.formation ?? campaign.formation ?? [];
  const locked = opts.editable === false;
  const bySlot = new Map<number, UnitId>();
  for (const entry of formation) {
    if (entry.startIndex >= 0 && entry.startIndex < max) {
      bySlot.set(entry.startIndex, entry.unitId);
    }
  }

  const slots: FormationSlotVM[] = [];
  for (let i = 0; i < max; i++) {
    const tile = startTiles[i];
    const unitId = bySlot.get(i);
    slots.push({
      index: i,
      ...(unitId !== undefined ? { unitId } : {}),
      ...(tile ? { tile: tileLabel(tile.x, tile.y) } : {}),
      ...(locked ? { locked: true } : {}),
    });
  }

  const stateStub = emptyBattleStub();
  const roster = campaign.roster.map((p) => {
    const live = unitFromPersisted(p, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    return unitVM(stateStub, live);
  });

  return {
    title: opts.title ?? 'Formation',
    ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
    slots,
    roster,
    maxDeployed: max,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// World map
// ─────────────────────────────────────────────────────────────────────────────

export function worldMapScreenVM(campaign: CampaignState): WorldMapScreenVM {
  const completed = new Set(campaign.progress.completed);
  const objective = nextObjective(campaign);
  return {
    title: 'The Lion War',
    subtitle: objective
      ? `Chapter ${objective.chapter} · ${objective.name}`
      : 'The v0.1 campaign is complete',
    nodes: WORLD_NODES.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      chapter: node.chapter,
      position: { ...node.position },
      requires: [...node.requires],
      state: completed.has(node.id)
        ? 'completed'
        : isUnlocked(node, campaign)
          ? 'available'
          : 'locked',
    })),
    ...(objective
      ? {
          objective: {
            id: objective.id,
            name: objective.name,
            kind: objective.kind,
            chapter: objective.chapter,
          },
        }
      : {}),
    gil: campaign.gil,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shop
// ─────────────────────────────────────────────────────────────────────────────

export function shopScreenVM(
  campaign: CampaignState,
  opts: { chapter: number; townName: string },
): ShopScreenVM {
  const chapter = Math.max(1, Math.floor(opts.chapter));
  const stock = shopStockForChapter(chapter).map((item) => {
    const price = buyPrice(item.price);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      category: item.category,
      price,
      owned: campaign.inventory[item.id] ?? 0,
      affordable: canAfford(campaign.gil, price),
    };
  });

  const inventory = Object.entries(campaign.inventory)
    .filter(([, count]) => count > 0)
    .map(([itemId, count]) => {
      const item = findItem(itemId);
      return item
        ? {
            id: item.id,
            name: item.name,
            description: item.description,
            price: sellPrice(item.price),
            count,
          }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    title: opts.townName,
    subtitle: `Chapter ${chapter} provisions`,
    chapter,
    gil: campaign.gil,
    stock,
    inventory,
  };
}

const EQUIP_SLOT_LABELS: Record<EquipSlot, string> = {
  rightHand: 'Right Hand',
  leftHand: 'Left Hand',
  head: 'Head',
  body: 'Body',
  accessory: 'Accessory',
};

/**
 * Company-wide roster ledger (every persisted member, not just those on the field).
 *
 * When `editable` is false (mid-battle), `edits` is omitted so the screen is a
 * read-only ledger — no equip / rename / dismiss chrome.
 */
export function campaignRosterScreenVM(
  campaign: CampaignState,
  opts: { title?: string; editable?: boolean } = {},
): RosterScreenVM {
  const stateStub = emptyBattleStub();
  const units = campaign.roster.map((p) => unitVM(stateStub, hydratePersisted(p)));
  const notes: Record<string, string> = {};
  const canDismissAny = campaign.roster.length > 1;
  const editable = opts.editable !== false;

  for (const p of campaign.roster) {
    const live = hydratePersisted(p);
    const progress = jobProgress(live, live.currentJob);
    notes[p.id] = `${progress.jp} JP · Job Lv ${jobLevelOf(live, live.currentJob)}`;
  }

  if (!editable) {
    return {
      title: opts.title ?? 'Roster',
      units,
      gil: campaign.gil,
      notes,
    };
  }

  const edits: Record<string, RosterUnitEditVM> = {};
  for (const p of campaign.roster) {
    edits[p.id] = rosterUnitEdit(hydratePersisted(p), campaign.inventory, canDismissAny);
  }

  return {
    title: opts.title ?? 'Roster',
    units,
    gil: campaign.gil,
    notes,
    edits,
  };
}

function rosterUnitEdit(
  unit: Unit,
  inventory: Readonly<Record<string, number>>,
  canDismiss: boolean,
): RosterUnitEditVM {
  const equipment: RosterEquipSlotVM[] = EQUIP_SLOT_ORDER.map((slot) => {
    const itemId = unit.equipment[slot];
    const item = itemId !== undefined ? findItem(itemId) : undefined;
    return {
      slot,
      label: EQUIP_SLOT_LABELS[slot],
      ...(itemId !== undefined ? { itemId } : {}),
      ...(item ? { itemName: item.name } : {}),
    };
  });

  const invRows = Object.entries(inventory)
    .filter(([, n]) => n > 0)
    .map(([id, count]) => {
      const item = findItem(id);
      return {
        id,
        name: item?.name ?? id,
        count,
        canEquip: canEquipItem(unit, id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    unitId: unit.id,
    equipment,
    inventory: invRows,
    canDismiss,
  };
}

function hydratePersisted(p: PersistedUnit): Unit {
  return unitFromPersisted(p, {
    team: 'player',
    pos: { x: 0, y: 0, z: 0 },
    facing: 'S',
  });
}

/** Minimal battle shell so unitVM can run without a live fight. */
function emptyBattleStub(): BattleState {
  const tile = {
    x: 0,
    y: 0,
    height: 0,
    depth: Infinity,
    surface: 'grass' as const,
    slope: 'flat' as const,
    passable: true,
    submerged: false,
  };
  return {
    field: {
      width: 1,
      height: 1,
      tiles: [tile],
      mapId: 'stub',
      tileAt(x: number, y: number) {
        return x === 0 && y === 0 ? tile : undefined;
      },
    },
    units: new Map(),
    order: [],
    phase: 'deploy',
    tick: 0,
    rngState: 0,
    log: [],
    objective: { kind: 'defeat-all' },
  };
}
