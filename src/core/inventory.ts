/**
 * EverTactics — party consumable stock.
 *
 * FFT does not give a unit its own satchel: the Potions belong to the *party*,
 * and any unit with the Item command draws from the same pile. That is the model
 * here — one pool per side, shared by every unit on it.
 *
 * Why per side rather than one global pool: an enemy Chemist drinking the
 * player's last X-Potion would be nonsense, and the AI is allowed to carry
 * consumables too. `inventoryFor(state, team)` hands each team its own pile.
 *
 * The stock itself is plain data (`Map<ItemId, number>`) hanging off
 * `BattleState.inventories`, so it saves, clones and replays exactly like the
 * rest of the state. {@link Inventory} is a thin *view* over that map — it holds
 * no state of its own, so two views over the same team always agree.
 *
 * Consumable identity comes from the ability table: an item is a consumable iff
 * the Item skillset defines an ability under its id. That is already the rule
 * `core/battle.ts` uses to decide whether an item can be used in battle
 * (see `itemAbility` there), so the two can never drift apart.
 */

import { abilitiesInSet } from './abilities';
import type { AiWorld } from './ai/evaluate';
import type { BattleState, ItemId, Team, Unit } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// What counts as a consumable
// ─────────────────────────────────────────────────────────────────────────────

let CONSUMABLES: ReadonlySet<ItemId> | undefined;

/** Ids of every item that can be spent in battle, i.e. the Item skillset. */
export function consumableIds(): ReadonlySet<ItemId> {
  if (CONSUMABLES === undefined) {
    CONSUMABLES = new Set(abilitiesInSet('item').map((a) => a.id));
  }
  return CONSUMABLES;
}

/** True when using `id` should draw from party stock. */
export function isConsumable(id: string): id is ItemId {
  return consumableIds().has(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Starting stock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a party walks onto the field carrying.
 *
 * Tuned so a single skirmish is a real resource decision without being a
 * bookkeeping exercise: enough Potions to cover a bad round twice over, exactly
 * one Elixir, and four Phoenix Downs — fewer than the party has members, which
 * is the number that makes a death hurt.
 *
 * Anything absent from this table starts at zero and can only arrive via
 * `add()`, which is what a battle reward or a shop purchase would call.
 */
export const STARTING_STOCK: Readonly<Record<string, number>> = {
  'use-potion': 8,
  'use-hi-potion': 4,
  'use-x-potion': 2,
  'use-ether': 3,
  'use-hi-ether': 1,
  'use-elixir': 1,
  'use-antidote': 3,
  'use-eye-drops': 3,
  'use-echo-herbs': 2,
  'use-maiden-kiss': 2,
  'use-soft': 2,
  'use-holy-water': 2,
  'use-remedy': 2,
  'use-phoenix-down': 4,
};

/** A fresh stock map. Insertion order follows {@link STARTING_STOCK}, so it is stable. */
export function startingStock(): Map<ItemId, number> {
  const out = new Map<ItemId, number>();
  for (const [id, n] of Object.entries(STARTING_STOCK)) {
    if (n > 0 && isConsumable(id)) out.set(id, n);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The inventory view
// ─────────────────────────────────────────────────────────────────────────────

export interface Inventory {
  /** At least one in stock. */
  has(id: ItemId): boolean;
  /** Remaining count; 0 for anything unheld. */
  count(id: ItemId): number;
  /**
   * Spend one (or `n`). Returns false and changes nothing when the stock will
   * not cover it, so a caller can treat it as a guarded transaction.
   */
  consume(id: ItemId, n?: number): boolean;
  /** Put `n` (default 1) into the pile. */
  add(id: ItemId, n?: number): void;
  /** Held ids with a positive count, in stock order. */
  entries(): [ItemId, number][];
  /** Total items held, across all ids. */
  total(): number;
  /** The backing map. Mutating it mutates the battle state. */
  stock: Map<ItemId, number>;
}

/** A view over an existing stock map. */
export function createInventory(stock: Map<ItemId, number> = new Map()): Inventory {
  return {
    stock,
    has(id) {
      return (stock.get(id) ?? 0) > 0;
    },
    count(id) {
      return Math.max(0, stock.get(id) ?? 0);
    },
    consume(id, n = 1) {
      if (n <= 0) return true;
      const held = stock.get(id) ?? 0;
      if (held < n) return false;
      // Drop the key at zero rather than keeping a 0 entry: `entries()` is what
      // the menu is built from, and a zero row would be a ghost.
      if (held === n) stock.delete(id);
      else stock.set(id, held - n);
      return true;
    },
    add(id, n = 1) {
      if (n <= 0) return;
      stock.set(id, (stock.get(id) ?? 0) + n);
    },
    entries() {
      const out: [ItemId, number][] = [];
      for (const [id, n] of stock) if (n > 0) out.push([id, n]);
      return out;
    },
    total() {
      let sum = 0;
      for (const [, n] of stock) if (n > 0) sum += n;
      return sum;
    },
  };
}

/** A standalone party inventory, stocked as if it had just left camp. */
export function createPartyInventory(): Inventory {
  return createInventory(startingStock());
}

// ─────────────────────────────────────────────────────────────────────────────
// Binding to a battle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stock pile belonging to `team`, created on first use.
 *
 * Lazy creation is deliberate. Battles are built in `state/scenarios.ts` and by
 * a dozen test helpers, and none of them should have to know about inventory to
 * produce a valid battle: the first read installs the default pile. It is still
 * fully deterministic — the defaults are a constant table, no RNG is drawn.
 */
export function inventoryFor(state: BattleState, team: Team): Inventory {
  let map = state.inventories;
  if (map === undefined) {
    map = new Map();
    state.inventories = map;
  }
  let stock = map.get(team);
  if (stock === undefined) {
    stock = startingStock();
    map.set(team, stock);
  }
  return createInventory(stock);
}

/** The pile the given unit draws from. */
export function inventoryOf(state: BattleState, unit: Unit): Inventory {
  return inventoryFor(state, unit.team);
}

// ─────────────────────────────────────────────────────────────────────────────
// The AI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Teach an `AiWorld` that stock is finite.
 *
 * The evaluator filters a unit's options by MP, silence and slot; it has no
 * concept of a consumable running out, so left alone it will price "drink a
 * Potion" as available forever and plan a turn the reducer then refuses. This
 * wrapper removes anything the side cannot pay for before the evaluator ever
 * sees it.
 *
 * This is a shim. The right home for the rule is `defaultAbilitiesFor` in
 * `core/ai/evaluate.ts`, alongside the MP and silence checks — see the note in
 * the handover report. Until that lands, every caller that hands the AI the real
 * ability table has to wrap its world here.
 */
export function stockAwareWorld(world: AiWorld): AiWorld {
  return {
    ...world,
    abilitiesFor: (state, unit) => {
      const inventory = inventoryOf(state, unit);
      return world
        .abilitiesFor(state, unit)
        .filter((a) => !isConsumable(a.id) || inventory.has(a.id));
    },
  };
}
