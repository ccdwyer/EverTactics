/**
 * EverTactics — the ability database.
 *
 * `ABILITIES` is the single source of truth for every action, reaction, support
 * and movement ability in the game. Everything else in `core/` looks abilities up
 * through `getAbility()`; the UI builds command menus from `abilitiesInSet()` and
 * `ABILITY_SETS`.
 *
 * Pure data + lookups. No three.js, no randomness, no side effects.
 */

import type { Ability, AbilityId, AbilitySetId, AbilitySlot } from '../types';
import { ACTION_ABILITIES, resolveSetId } from './sets';
import { REACTION_ABILITIES } from './reactions';
import { MOVEMENT_ABILITIES, SUPPORT_ABILITIES } from './support';

export * from './sets';
export * from './reactions';
export * from './support';

/** Pseudo-set ids used by the passive slots, which have no command menu. */
export const REACTION_SET: AbilitySetId = 'reaction';
export const SUPPORT_SET: AbilitySetId = 'support';
export const MOVEMENT_SET: AbilitySetId = 'movement';

const ALL: readonly Ability[] = [
  ...ACTION_ABILITIES,
  ...REACTION_ABILITIES,
  ...SUPPORT_ABILITIES,
  ...MOVEMENT_ABILITIES,
];

/** Every ability in the game, keyed by id. */
export const ABILITIES: ReadonlyMap<AbilityId, Ability> = new Map(ALL.map((a) => [a.id, a]));

/** Abilities grouped by set, preserving authoring order. */
const BY_SET: ReadonlyMap<AbilitySetId, readonly Ability[]> = (() => {
  const map = new Map<AbilitySetId, Ability[]>();
  for (const ability of ALL) {
    const bucket = map.get(ability.set);
    if (bucket === undefined) map.set(ability.set, [ability]);
    else bucket.push(ability);
  }
  return map;
})();

const BY_SLOT: ReadonlyMap<AbilitySlot, readonly Ability[]> = (() => {
  const map = new Map<AbilitySlot, Ability[]>();
  for (const ability of ALL) {
    const bucket = map.get(ability.slot);
    if (bucket === undefined) map.set(ability.slot, [ability]);
    else bucket.push(ability);
  }
  return map;
})();

/** Look up a single ability. Returns `undefined` for unknown ids — callers decide. */
export function getAbility(id: AbilityId): Ability | undefined {
  return ABILITIES.get(id);
}

/**
 * Look up an ability that the caller believes must exist (e.g. an id that came
 * out of a job's learnable list). Throws rather than silently doing nothing,
 * because a missing ability id is always a data bug.
 */
export function requireAbility(id: AbilityId): Ability {
  const ability = ABILITIES.get(id);
  if (ability === undefined) throw new Error(`Unknown ability id: ${id}`);
  return ability;
}

/** Every ability in a set, in menu order. Empty array for unknown sets. */
export function abilitiesInSet(setId: AbilitySetId): Ability[] {
  const direct = BY_SET.get(setId);
  if (direct !== undefined) return direct.slice();
  const resolved = resolveSetIdSafe(setId);
  if (resolved === undefined) return [];
  const viaAlias = BY_SET.get(resolved);
  return viaAlias === undefined ? [] : viaAlias.slice();
}

/** Every ability that fills a given passive/action slot. */
export function abilitiesInSlot(slot: AbilitySlot): Ability[] {
  const bucket = BY_SLOT.get(slot);
  return bucket === undefined ? [] : bucket.slice();
}

/** True when the id names a real ability. */
export function isAbility(id: string): id is AbilityId {
  return ABILITIES.has(id);
}

/** All action-set ids that actually contain abilities. */
export function populatedSets(): AbilitySetId[] {
  const out: AbilitySetId[] = [];
  for (const [setId, list] of BY_SET) {
    if (list.length > 0 && setId !== REACTION_SET && setId !== SUPPORT_SET && setId !== MOVEMENT_SET) {
      out.push(setId);
    }
  }
  return out;
}

/**
 * Data integrity check, used by the test suite and by the asset build script.
 * Returns human-readable problems; an empty array means the table is sound.
 */
export function validateAbilities(): string[] {
  const problems: string[] = [];
  const seen = new Set<AbilityId>();
  for (const ability of ALL) {
    if (seen.has(ability.id)) problems.push(`duplicate ability id: ${ability.id}`);
    seen.add(ability.id);
    if (ability.name.trim() === '') problems.push(`${ability.id}: empty name`);
    if (ability.description.trim().length < 12) problems.push(`${ability.id}: description too thin`);
    if (ability.vfx.trim() === '') problems.push(`${ability.id}: missing vfx key`);
    if (ability.mp < 0) problems.push(`${ability.id}: negative MP`);
    if (ability.ct < 0) problems.push(`${ability.id}: negative CT`);
    if (ability.accuracy < 0 || ability.accuracy > 200) {
      problems.push(`${ability.id}: accuracy out of range (${ability.accuracy})`);
    }
    if (ability.range.range < 0 || ability.range.radius < 0) {
      problems.push(`${ability.id}: negative range/radius`);
    }
    for (const i of ability.inflicts ?? []) {
      if (i.chance <= 0 || i.chance > 100) {
        problems.push(`${ability.id}: inflict chance out of range for ${i.status}`);
      }
    }
  }
  return problems;
}

/** Alias-tolerant set resolution, so a job-table spelling still finds its menu. */
function resolveSetIdSafe(raw: string): AbilitySetId | undefined {
  return resolveSetId(raw);
}
