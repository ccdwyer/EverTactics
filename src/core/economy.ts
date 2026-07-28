/**
 * Pure campaign economy rules.
 *
 * No content tables live here. Callers supply item prices and drop candidates,
 * which keeps chapter stock and presentation outside core while the arithmetic,
 * affordability gates, and deterministic reward rolls stay testable.
 */

import type { CampaignState } from './campaign';
import { createRng, pickWeighted, seedFromString } from './rng';
import type { ItemId, Rng } from './types';

export interface RewardEnemy {
  readonly level: number;
}

export interface DropTableEntry {
  readonly itemId: ItemId;
  readonly minLevel: number;
  readonly weight: number;
}

export interface EconomyRewards {
  readonly gil: number;
  readonly items: Readonly<Record<ItemId, number>>;
}

export type EconomyFailure = 'cannot-afford' | 'not-owned' | 'invalid-transaction';

export type EconomyResult =
  | { ok: true; campaign: CampaignState }
  | { ok: false; reason: EconomyFailure };

/** The shop charges the authored item-table price, normalized to whole gil. */
export function buyPrice(basePrice: number): number {
  if (!Number.isFinite(basePrice) || basePrice <= 0) return 0;
  return Math.floor(basePrice);
}

/** Shops buy used goods for half their retail value, rounded down. */
export function sellPrice(basePrice: number): number {
  return Math.floor(buyPrice(basePrice) / 2);
}

/** True only when the whole transaction can settle without negative gil. */
export function canAfford(gil: number, price: number, quantity = 1): boolean {
  if (!Number.isSafeInteger(gil) || gil < 0) return false;
  if (!Number.isSafeInteger(price) || price < 0) return false;
  if (!Number.isSafeInteger(quantity) || quantity < 1) return false;
  const total = price * quantity;
  return Number.isSafeInteger(total) && gil >= total;
}

/**
 * Derive one isolated reward stream from the campaign seed and durable node id.
 * Replaying a victory does not depend on battle RNG consumption or wall-clock
 * time, and different nodes do not perturb one another.
 */
export function rewardRng(campaignSeed: number, nodeId: string): Rng {
  return createRng((campaignSeed | 0) ^ seedFromString(nodeId));
}

/**
 * Compute gil and drops from opposition strength.
 *
 * Gil grows with both head-count and summed level, then receives a bounded
 * seeded field bonus. Drop rolls grow with encounter size and average level;
 * candidate level gates prevent early encounters from yielding late loot.
 */
export function computeBattleRewards(
  campaignSeed: number,
  nodeId: string,
  enemies: readonly RewardEnemy[],
  dropTable: readonly DropTableEntry[],
): EconomyRewards {
  if (enemies.length === 0) return { gil: 0, items: {} };

  const levels = enemies.map((enemy) =>
    Number.isFinite(enemy.level) ? Math.max(1, Math.floor(enemy.level)) : 1,
  );
  const levelTotal = levels.reduce((sum, level) => sum + level, 0);
  const averageLevel = Math.floor(levelTotal / levels.length);
  const rng = rewardRng(campaignSeed, nodeId);

  const baseGil = levelTotal * 16 + enemies.length * 80;
  const fieldBonus = rng.int(Math.max(1, Math.floor(baseGil / 5) + 1));
  const gil = baseGil + fieldBonus;

  const eligible = dropTable.filter(
    (entry) =>
      entry.itemId.length > 0 &&
      Number.isFinite(entry.minLevel) &&
      entry.minLevel <= averageLevel &&
      Number.isFinite(entry.weight) &&
      entry.weight > 0,
  );
  if (eligible.length === 0) return { gil, items: {} };

  const rolls = Math.max(1, Math.ceil(enemies.length / 3) + Math.floor(averageLevel / 10));
  const items: Record<ItemId, number> = {};
  const weights = eligible.map((entry) => entry.weight);
  for (let i = 0; i < rolls; i++) {
    const chosen = pickWeighted(rng, eligible, weights);
    if (chosen) items[chosen.itemId] = (items[chosen.itemId] ?? 0) + 1;
  }

  return { gil, items };
}

/** Spend gil and add stock atomically. The input campaign is never mutated. */
export function buyItem(
  campaign: CampaignState,
  itemId: ItemId,
  basePrice: number,
  timestamp: number,
  quantity = 1,
): EconomyResult {
  const price = buyPrice(basePrice);
  if (
    itemId.length === 0 ||
    price <= 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  ) {
    return { ok: false, reason: 'invalid-transaction' };
  }
  if (!canAfford(campaign.gil, price, quantity)) {
    return { ok: false, reason: 'cannot-afford' };
  }

  const inventory = { ...campaign.inventory };
  inventory[itemId] = (inventory[itemId] ?? 0) + quantity;
  return {
    ok: true,
    campaign: transactionCampaign(
      campaign,
      campaign.gil - price * quantity,
      inventory,
      timestamp,
    ),
  };
}

/** Remove owned stock and add the reduced resale value atomically. */
export function sellItem(
  campaign: CampaignState,
  itemId: ItemId,
  basePrice: number,
  timestamp: number,
  quantity = 1,
): EconomyResult {
  const price = sellPrice(basePrice);
  if (
    itemId.length === 0 ||
    price < 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  ) {
    return { ok: false, reason: 'invalid-transaction' };
  }
  const owned = campaign.inventory[itemId] ?? 0;
  if (!Number.isSafeInteger(owned) || owned < quantity) {
    return { ok: false, reason: 'not-owned' };
  }

  const inventory = { ...campaign.inventory };
  const remaining = owned - quantity;
  if (remaining > 0) inventory[itemId] = remaining;
  else delete inventory[itemId];

  const proceeds = price * quantity;
  if (!Number.isSafeInteger(proceeds) || !Number.isSafeInteger(campaign.gil + proceeds)) {
    return { ok: false, reason: 'invalid-transaction' };
  }
  return {
    ok: true,
    campaign: transactionCampaign(
      campaign,
      campaign.gil + proceeds,
      inventory,
      timestamp,
    ),
  };
}

function transactionCampaign(
  campaign: CampaignState,
  gil: number,
  inventory: Record<ItemId, number>,
  timestamp: number,
): CampaignState {
  return {
    ...campaign,
    gil: Math.max(0, gil),
    roster: [...campaign.roster],
    inventory,
    formation: campaign.formation.map((entry) => ({ ...entry })),
    progress: {
      ...campaign.progress,
      completed: [...campaign.progress.completed],
    },
    updatedAt: timestamp,
  };
}
