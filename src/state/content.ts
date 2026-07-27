/**
 * EverTactics — content bootstrap.
 *
 * `core/unit.ts` keeps a private registry that every other core module reads
 * through (`getJob` / `getItem` / `getAbility`). Nothing populates it on its own:
 * without this call a unit falls back to `NEUTRAL_JOB` and abilities resolve to
 * `undefined`. The app must call `bootstrapContent()` exactly once at startup.
 *
 * This module also owns two pieces of glue the subsystem authors deliberately
 * left open:
 *
 *  1. **The generic Attack.** FFT's Attack is a universal command, not a member
 *     of any job's skillset, so `core/abilities` never defined it — but
 *     `core/battle.ts` resolves `{kind:'act', ability:'attack'}` through the same
 *     registry as everything else, and `core/ai` assumes an ability with the id
 *     `attack` exists (`BASIC_ATTACK` in `ai/evaluate.ts`). We register a real
 *     one here so both agree on a single record.
 *  2. **Item elemental affinity and status immunity**, which `combat/damage.ts`
 *     and `combat/status.ts` expose as registration hooks that stay empty until
 *     an item table exists.
 */

import { ABILITIES } from '@core/abilities';
import { registerItemAffinity, registerItemBoost, type ElementTable } from '@core/combat/damage';
import { registerItemImmunity } from '@core/combat/status';
import { allJobs } from '@core/jobs';
import {
  clearContent,
  registerAbilities,
  registerItems,
  registerJobs,
} from '@core/unit';
import type {
  Ability,
  AbilityId,
  Element,
  Item,
  ItemId,
  Job,
  JobId,
  StatusId,
} from '@core/types';

import { ITEMS } from './items';

// ─────────────────────────────────────────────────────────────────────────────
// The generic Attack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The universal Attack command.
 *
 * `range` is a floor: `combat/damage.ts` reads the equipped weapon for the actual
 * numbers, and the UI widens the displayed range using `Item.range` (a bow reaches
 * 5). Kept structurally identical to `ai/evaluate.ts`'s `BASIC_ATTACK` so the AI's
 * prediction and the reducer's resolution are the same ability.
 */
export const ATTACK: Ability = {
  id: 'attack',
  name: 'Attack',
  set: 'basic',
  slot: 'action',
  description: 'Strike with the equipped weapon.',
  mp: 0,
  ct: 0,
  element: 'none',
  range: { range: 1, radius: 0, vertical: 3, los: false },
  formula: 'physical',
  power: 1,
  accuracy: 100,
  vfx: 'slash-arc',
  castAnim: 'attack',
};

// ─────────────────────────────────────────────────────────────────────────────
// Elemental / immunity registries
// ─────────────────────────────────────────────────────────────────────────────

/** Weapons and rods that add their element to whatever the wielder casts. */
const ELEMENT_BOOSTS: Readonly<Record<ItemId, readonly Element[]>> = {
  'flame-rod': ['fire'],
};

/** Gear that changes how its wearer takes an element. */
const AFFINITIES: Readonly<Record<ItemId, ElementTable>> = {
  'mythril-armor': { fire: 'halve', ice: 'halve', lightning: 'halve' },
  'silk-robe': { fire: 'halve' },
  'reflect-ring': { dark: 'halve' },
};

/** The Ribbon is the FFT catch-all: everything short of death slides off it. */
const IMMUNITIES: Readonly<Record<ItemId, readonly StatusId[]>> = {
  ribbon: [
    'poison', 'blind', 'silence', 'oil', 'frog', 'chicken', 'confuse', 'charm',
    'berserk', 'sleep', 'slow', 'stop', 'petrify', 'death-sentence', 'undead',
  ],
  'green-beret': ['blind'],
  headband: ['silence'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

let jobList: readonly Job[] = [];
let abilityList: readonly Ability[] = [];
let booted = false;

/** Every ability the game knows about, including the generic Attack. */
export const ALL_ABILITIES: ReadonlyMap<AbilityId, Ability> = (() => {
  const map = new Map<AbilityId, Ability>(ABILITIES);
  if (!map.has(ATTACK.id)) map.set(ATTACK.id, ATTACK);
  return map;
})();

export const ALL_ITEMS: ReadonlyMap<ItemId, Item> = new Map(ITEMS.map((i) => [i.id, i]));

export const ALL_JOBS: ReadonlyMap<JobId, Job> = new Map(allJobs().map((j) => [j.id, j]));

/**
 * Populate every core registry. Idempotent — safe to call from a hot reload or a
 * test that has already booted.
 */
export function bootstrapContent(): void {
  if (booted) return;
  booted = true;

  jobList = allJobs();
  abilityList = [...ALL_ABILITIES.values()];

  clearContent();
  registerJobs(jobList);
  registerAbilities(abilityList);
  registerItems(ITEMS);

  for (const [item, elements] of Object.entries(ELEMENT_BOOSTS)) {
    registerItemBoost(item, elements);
  }
  for (const [item, table] of Object.entries(AFFINITIES)) {
    registerItemAffinity(item, table);
  }
  for (const [item, statuses] of Object.entries(IMMUNITIES)) {
    registerItemImmunity(item, statuses);
  }
}

/** Sanity report used by the boot log — cheap, and it catches a dropped table. */
export function contentSummary(): { jobs: number; abilities: number; items: number } {
  return { jobs: jobList.length, abilities: abilityList.length, items: ITEMS.length };
}
