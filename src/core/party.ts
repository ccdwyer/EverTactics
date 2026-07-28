/**
 * EverTactics — party management mutations.
 *
 * Pure functions over CampaignState: formation, equip/unequip, rename, dismiss,
 * job change and ability learning. No three.js, no DOM, no Math.random(), no
 * Date.now() — timestamps are passed in.
 *
 * UI emits intents; state/game.ts calls these and saves. Screens must not
 * reimplement the rules, or the panel and the engine will disagree.
 */

import { getAbility } from './abilities';
import { SUPPORT_EFFECTS } from './abilities/support';
import {
  type CampaignState,
  type FormationEntry,
  type PersistedUnit,
  unitFromPersisted,
  unitToPersisted,
} from './campaign';
import { allJobs } from './jobs';
import { unlockStatus, type UnlockContext } from './jobs/tree';
import type {
  AbilityId,
  AbilitySetId,
  Equipment,
  EquipCategory,
  Item,
  ItemId,
  JobId,
  Unit,
  UnitId,
} from './types';
import {
  deriveStats,
  getItem,
  getJob,
  jobProgress,
  learnAbility,
  refreshDerived,
  setJob,
} from './unit';

/**
 * True when the unit may switch into `jobId`.
 *
 * Uses {@link unlockStatus} as the canonical gate (job prereqs, gender locks,
 * kill conditions). Previously held jobs stay selectable so a scenario Knight
 * can leave and return without re-grinding Squire — but only for job-level
 * prereqs. Gender locks and kill/special conditions always bind: banked JP
 * must never open Dark Knight without kills, or Bard for a female unit.
 */
export function canSwitchToJob(
  unit: Unit,
  jobId: JobId,
  ctx: UnlockContext = {},
): boolean {
  if (unit.currentJob === jobId) return true;
  const status = unlockStatus(unit, jobId, ctx);
  if (status.unlocked) return true;
  // Gender-locked against this unit: never open, held-JP or not.
  if (status.genderLocked !== undefined) return false;
  // Kill gates / special conditions always bind — banked JP is not a bypass.
  if (!status.specialMet) return false;
  // Previously held (job-prereq shortfall only): any total JP banked keeps it
  // selectable so a scenario Knight can leave and return without re-grinding.
  const progress = unit.jobs.get(jobId);
  return (progress?.totalJp ?? 0) > 0;
}

export type { FormationEntry };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EquipSlot = keyof Equipment;

export const EQUIP_SLOT_ORDER: readonly EquipSlot[] = [
  'rightHand',
  'leftHand',
  'head',
  'body',
  'accessory',
] as const;

export type FormationFail =
  | 'empty'
  | 'over-limit'
  | 'duplicate-tile'
  | 'illegal-tile'
  | 'unknown-unit'
  | 'duplicate-unit';

export type FormationResult =
  | { ok: true; campaign: CampaignState }
  | { ok: false; reason: FormationFail };

export type EquipFail =
  | 'unknown-unit'
  | 'unknown-item'
  | 'not-in-inventory'
  | 'cannot-equip'
  | 'empty-slot'
  | 'bad-slot';

export type EquipResult =
  | { ok: true; campaign: CampaignState }
  | { ok: false; reason: EquipFail };

export type PartyMutateFail =
  | 'unknown-unit'
  | 'last-member'
  | 'job-locked'
  | 'not-learned'
  | 'bad-name'
  | 'learn-failed';

export type PartyMutateResult =
  | { ok: true; campaign: CampaignState }
  | { ok: false; reason: PartyMutateFail; detail?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Formation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace the campaign's deployment slate.
 *
 * Rejects: zero units, over the deploy limit, two units on one start index,
 * a start index outside [0, startTileCount), unknown roster ids, the same unit
 * twice.
 */
export function setFormation(
  campaign: CampaignState,
  entries: readonly FormationEntry[],
  opts: {
    startTileCount: number;
    maxDeployed: number;
    timestamp: number;
  },
): FormationResult {
  if (entries.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (entries.length > opts.maxDeployed) {
    return { ok: false, reason: 'over-limit' };
  }

  const rosterIds = new Set(campaign.roster.map((u) => u.id));
  const seenUnits = new Set<UnitId>();
  const seenTiles = new Set<number>();

  for (const entry of entries) {
    if (!rosterIds.has(entry.unitId)) {
      return { ok: false, reason: 'unknown-unit' };
    }
    if (seenUnits.has(entry.unitId)) {
      return { ok: false, reason: 'duplicate-unit' };
    }
    seenUnits.add(entry.unitId);

    if (
      !Number.isInteger(entry.startIndex) ||
      entry.startIndex < 0 ||
      entry.startIndex >= opts.startTileCount
    ) {
      return { ok: false, reason: 'illegal-tile' };
    }
    if (seenTiles.has(entry.startIndex)) {
      return { ok: false, reason: 'duplicate-tile' };
    }
    seenTiles.add(entry.startIndex);
  }

  const formation: FormationEntry[] = entries.map((e) => ({
    unitId: e.unitId,
    startIndex: e.startIndex,
  }));

  return {
    ok: true,
    campaign: withUpdate(campaign, { formation }, opts.timestamp),
  };
}

/**
 * Validate tile coordinates against a concrete start-tile list, then store by index.
 * Convenience for callers that work in map space rather than slot indices.
 */
export function setFormationByTiles(
  campaign: CampaignState,
  assignments: readonly { unitId: UnitId; x: number; y: number }[],
  opts: {
    startTiles: readonly { x: number; y: number }[];
    maxDeployed: number;
    timestamp: number;
  },
): FormationResult {
  const entries: FormationEntry[] = [];
  for (const a of assignments) {
    const startIndex = opts.startTiles.findIndex((t) => t.x === a.x && t.y === a.y);
    if (startIndex < 0) {
      return { ok: false, reason: 'illegal-tile' };
    }
    entries.push({ unitId: a.unitId, startIndex });
  }
  return setFormation(campaign, entries, {
    startTileCount: opts.startTiles.length,
    maxDeployed: opts.maxDeployed,
    timestamp: opts.timestamp,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment
// ─────────────────────────────────────────────────────────────────────────────

/** Which equipment slot an item occupies by category. */
export function slotForItem(item: Item): EquipSlot | null {
  const c = item.category;
  if (c === 'consumable') return null;
  if (c === 'shield') return 'leftHand';
  if (c === 'helm' || c === 'hat' || c === 'ribbon') return 'head';
  if (c === 'armor' || c === 'robe' || c === 'clothing') return 'body';
  if (c === 'accessory' || c === 'shoes' || c === 'armlet') return 'accessory';
  // Weapons (knife, sword, bow, rod, …) default to the right hand.
  return 'rightHand';
}

/** Whether the unit's job (plus equip-support passives) may wear this category. */
export function canEquipCategory(unit: Unit, category: EquipCategory): boolean {
  const job = getJob(unit.currentJob);
  if (job.equip.includes(category)) return true;

  const abilityIds: AbilityId[] = [...job.innate];
  if (unit.support !== undefined) abilityIds.push(unit.support);

  for (const id of abilityIds) {
    const effect = SUPPORT_EFFECTS.get(id);
    if (!effect) continue;
    if (effect.kind === 'equip-any') return true;
    if (effect.kind === 'equip-category' && effect.categories?.includes(category)) {
      return true;
    }
  }
  return false;
}

export function canEquipItem(unit: Unit, itemId: ItemId): boolean {
  const item = getItem(itemId);
  if (!item || item.category === 'consumable') return false;
  if (slotForItem(item) === null) return false;
  return canEquipCategory(unit, item.category as EquipCategory);
}

/**
 * Move an item from campaign inventory onto a roster unit.
 * Returns the displaced gear (if any) to inventory. Honours job equip lists
 * and two-handed weapons (a two-hander clears the off-hand).
 */
export function equipItem(
  campaign: CampaignState,
  unitId: UnitId,
  itemId: ItemId,
  timestamp: number,
): EquipResult {
  const index = campaign.roster.findIndex((u) => u.id === unitId);
  if (index < 0) return { ok: false, reason: 'unknown-unit' };

  const item = getItem(itemId);
  if (!item || item.category === 'consumable') return { ok: false, reason: 'unknown-item' };

  const slot = slotForItem(item);
  if (slot === null) return { ok: false, reason: 'cannot-equip' };

  const held = campaign.inventory[itemId] ?? 0;
  if (held < 1) return { ok: false, reason: 'not-in-inventory' };

  const unit = hydrate(campaign.roster[index]!);
  if (!canEquipItem(unit, itemId)) return { ok: false, reason: 'cannot-equip' };

  // Two-handed weapons always take the right hand and clear the left.
  const targetSlot: EquipSlot = item.twoHanded ? 'rightHand' : slot;

  // Cannot put anything in the left hand while a two-hander is equipped.
  if (targetSlot === 'leftHand') {
    const right = getItem(unit.equipment.rightHand);
    if (right?.twoHanded) return { ok: false, reason: 'cannot-equip' };
  }

  const inventory = { ...campaign.inventory };
  takeFromInventory(inventory, itemId, 1);

  const returned: ItemId[] = [];
  const previous = unit.equipment[targetSlot];
  if (previous !== undefined) returned.push(previous);

  if (item.twoHanded) {
    const left = unit.equipment.leftHand;
    if (left !== undefined && left !== previous) returned.push(left);
    delete unit.equipment.leftHand;
  }

  // Equipping a left-hand piece while right is free is fine; if we are replacing
  // a two-hander via rightHand, left was already cleared above.
  unit.equipment[targetSlot] = itemId;

  for (const id of returned) addToInventory(inventory, id, 1);
  refreshDerived(unit);

  const roster = campaign.roster.slice();
  roster[index] = unitToPersisted(unit);
  return {
    ok: true,
    campaign: withUpdate(campaign, { roster, inventory }, timestamp),
  };
}

/** Strip a slot and return the item to campaign inventory. */
export function unequipItem(
  campaign: CampaignState,
  unitId: UnitId,
  slot: EquipSlot,
  timestamp: number,
): EquipResult {
  if (!EQUIP_SLOT_ORDER.includes(slot)) return { ok: false, reason: 'bad-slot' };

  const index = campaign.roster.findIndex((u) => u.id === unitId);
  if (index < 0) return { ok: false, reason: 'unknown-unit' };

  const unit = hydrate(campaign.roster[index]!);
  const worn = unit.equipment[slot];
  if (worn === undefined) return { ok: false, reason: 'empty-slot' };

  delete unit.equipment[slot];

  // Unequipping a two-hander only clears rightHand; left is already empty.
  const inventory = { ...campaign.inventory };
  addToInventory(inventory, worn, 1);
  refreshDerived(unit);

  const roster = campaign.roster.slice();
  roster[index] = unitToPersisted(unit);
  return {
    ok: true,
    campaign: withUpdate(campaign, { roster, inventory }, timestamp),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Roster: rename / dismiss / ability slots
// ─────────────────────────────────────────────────────────────────────────────

export function renameUnit(
  campaign: CampaignState,
  unitId: UnitId,
  name: string,
  timestamp: number,
): PartyMutateResult {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'bad-name' };

  const index = campaign.roster.findIndex((u) => u.id === unitId);
  if (index < 0) return { ok: false, reason: 'unknown-unit' };

  const roster = campaign.roster.slice();
  roster[index] = { ...structuredClonePersisted(roster[index]!), name: trimmed };
  return { ok: true, campaign: withUpdate(campaign, { roster }, timestamp) };
}

/** Remove a unit. Refuses when the roster would drop below one member. */
export function dismissUnit(
  campaign: CampaignState,
  unitId: UnitId,
  timestamp: number,
): PartyMutateResult {
  if (campaign.roster.length <= 1) return { ok: false, reason: 'last-member' };
  const index = campaign.roster.findIndex((u) => u.id === unitId);
  if (index < 0) return { ok: false, reason: 'unknown-unit' };

  const departing = campaign.roster[index]!;
  const inventory = { ...campaign.inventory };
  // Return every equipped piece so gear is not destroyed with the unit.
  for (const slot of EQUIP_SLOT_ORDER) {
    const id = departing.equipment[slot];
    if (id !== undefined) addToInventory(inventory, id, 1);
  }

  const roster = campaign.roster.filter((u) => u.id !== unitId);
  // Drop the dismissed unit from the formation slate.
  const formation = (campaign.formation ?? []).filter((e) => e.unitId !== unitId);

  return {
    ok: true,
    campaign: withUpdate(campaign, { roster, inventory, formation }, timestamp),
  };
}

/**
 * Assign secondary / reaction / support / movement from what the unit has learned.
 *
 * Secondary is a skillset id only when the unit has learned at least one ability
 * belonging to that skillset (any job row). Reaction / support / movement must
 * be learned (any job) or innate on the current job. Clearing (`null`) is always
 * allowed.
 */
export function assignAbilitySlot(
  campaign: CampaignState,
  unitId: UnitId,
  slot: 'secondary' | 'reaction' | 'support' | 'movement',
  abilityId: string | null,
  timestamp: number,
): PartyMutateResult {
  const index = campaign.roster.findIndex((u) => u.id === unitId);
  if (index < 0) return { ok: false, reason: 'unknown-unit' };

  const unit = hydrate(campaign.roster[index]!);

  if (abilityId !== null) {
    if (slot === 'secondary') {
      if (!canAssignSecondarySet(unit, abilityId)) {
        return { ok: false, reason: 'not-learned' };
      }
      unit.secondaryAction = abilityId as AbilitySetId;
    } else {
      if (!canAssignPassive(unit, slot, abilityId)) {
        return { ok: false, reason: 'not-learned' };
      }
      unit[slot] = abilityId as AbilityId;
    }
  } else if (slot === 'secondary') {
    delete unit.secondaryAction;
  } else {
    delete unit[slot];
  }

  refreshDerived(unit);
  const roster = campaign.roster.slice();
  roster[index] = unitToPersisted(unit);
  return { ok: true, campaign: withUpdate(campaign, { roster }, timestamp) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job screen — change job / spend JP
// ─────────────────────────────────────────────────────────────────────────────

export function changeJob(
  campaign: CampaignState,
  unitId: UnitId,
  jobId: JobId,
  timestamp: number,
  ctx: UnlockContext = {},
): PartyMutateResult {
  const index = campaign.roster.findIndex((u) => u.id === unitId);
  if (index < 0) return { ok: false, reason: 'unknown-unit' };

  const unit = hydrate(campaign.roster[index]!);
  if (unit.currentJob === jobId) {
    return { ok: true, campaign };
  }
  if (!canSwitchToJob(unit, jobId, ctx)) {
    return { ok: false, reason: 'job-locked' };
  }

  setJob(unit, jobId);
  const roster = campaign.roster.slice();
  roster[index] = unitToPersisted(unit);
  return { ok: true, campaign: withUpdate(campaign, { roster }, timestamp) };
}

export function spendJpToLearn(
  campaign: CampaignState,
  unitId: UnitId,
  jobId: JobId,
  abilityId: AbilityId,
  timestamp: number,
): PartyMutateResult {
  const index = campaign.roster.findIndex((u) => u.id === unitId);
  if (index < 0) return { ok: false, reason: 'unknown-unit' };

  const unit = hydrate(campaign.roster[index]!);
  // Ensure the job progress row exists before charging.
  jobProgress(unit, jobId);
  const result = learnAbility(unit, abilityId, jobId);
  if (!result.learned) {
    return {
      ok: false,
      reason: 'learn-failed',
      detail: result.reason,
    };
  }

  const roster = campaign.roster.slice();
  roster[index] = unitToPersisted(unit);
  return { ok: true, campaign: withUpdate(campaign, { roster }, timestamp) };
}

/** Re-derive live stats for a persisted unit (tests / callers that need numbers). */
export function derivedStatsOf(persisted: PersistedUnit) {
  const unit = hydrate(persisted);
  return deriveStats(unit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function hydrate(p: PersistedUnit): Unit {
  return unitFromPersisted(p, {
    team: 'player',
    pos: { x: 0, y: 0, z: 0 },
    facing: 'S',
  });
}

function withUpdate(
  campaign: CampaignState,
  patch: Partial<Pick<CampaignState, 'roster' | 'inventory' | 'formation' | 'gil' | 'progress'>>,
  timestamp: number,
): CampaignState {
  return {
    ...campaign,
    roster: patch.roster ?? campaign.roster.map(structuredClonePersisted),
    inventory: patch.inventory ?? { ...campaign.inventory },
    formation: patch.formation ?? (campaign.formation ? campaign.formation.map((e) => ({ ...e })) : []),
    progress: {
      completed: [...campaign.progress.completed],
      ...(campaign.progress.current !== undefined
        ? { current: campaign.progress.current }
        : {}),
    },
    updatedAt: timestamp,
  };
}

function takeFromInventory(inv: Record<ItemId, number>, id: ItemId, n: number): void {
  const held = inv[id] ?? 0;
  const next = held - n;
  if (next <= 0) delete inv[id];
  else inv[id] = next;
}

function addToInventory(inv: Record<ItemId, number>, id: ItemId, n: number): void {
  inv[id] = (inv[id] ?? 0) + n;
}

function hasLearnedOrInnate(unit: Unit, abilityId: AbilityId): boolean {
  for (const p of unit.jobs.values()) {
    if (p.learned.has(abilityId)) return true;
  }
  const job = getJob(unit.currentJob);
  return job.innate.includes(abilityId);
}

/**
 * Secondary skillset rule (brief): only skillsets the unit has actually earned
 * abilities from — not merely an unlocked or empty-banked job row.
 */
function canAssignSecondarySet(unit: Unit, setId: string): boolean {
  const own = getJob(unit.currentJob).actionSet;
  if (setId === own) return false;

  const setAbilities = new Set<AbilityId>();
  let knownSet = false;
  for (const job of allJobs()) {
    if (job.actionSet !== setId) continue;
    knownSet = true;
    for (const entry of job.learnable) setAbilities.add(entry.ability);
    for (const id of job.innate) setAbilities.add(id);
  }
  if (!knownSet || setAbilities.size === 0) return false;

  for (const progress of unit.jobs.values()) {
    for (const abilityId of progress.learned) {
      if (setAbilities.has(abilityId)) return true;
    }
  }
  return false;
}

/** Reaction / support / movement: must exist, match the slot kind, and be known. */
function canAssignPassive(
  unit: Unit,
  slot: 'reaction' | 'support' | 'movement',
  abilityId: string,
): boolean {
  const ability = getAbility(abilityId);
  if (!ability || ability.slot !== slot) return false;
  return hasLearnedOrInnate(unit, abilityId);
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
