/**
 * Campaign economy — battle spoils and town shop transactions.
 *
 * These tests are written against the step-5 contract. They exercise the pure
 * campaign/economy seams and the existing roster equip seam, never a live
 * BattleState mutation path.
 */
import { describe, expect, it } from 'vitest';

import {
  battleToCampaign,
  createCampaign,
  deserialize,
  serialize,
  type CampaignState,
  type PersistedUnit,
} from '../src/core/campaign';
import {
  buyItem,
  computeBattleRewards,
  sellItem,
  sellPrice,
  type DropTableEntry,
} from '../src/core/economy';
import { equipItem } from '../src/core/party';
import { WORLD_NODES } from '../src/core/world';
import { bootstrapContent } from '../src/state/content';
import {
  campaignToBattle,
  getEncounter,
  getScenario,
  newGameCampaign,
} from '../src/state/scenarios';
import { campaignRosterScreenVM, shopScreenVM } from '../src/state/screens';

bootstrapContent();

const DROP_TABLE: readonly DropTableEntry[] = [
  { itemId: 'use-potion', minLevel: 1, weight: 5 },
  { itemId: 'dagger', minLevel: 4, weight: 1 },
];

function unit(
  overrides: Partial<PersistedUnit> & Pick<PersistedUnit, 'id' | 'name' | 'currentJob'>,
): PersistedUnit {
  const job = overrides.currentJob;
  const { jobs: jobOverrides, ...rest } = overrides;
  return {
    gender: 'male',
    zodiac: 'aries',
    level: 5,
    exp: 0,
    totalExp: 0,
    equipment: {},
    raw: { hp: 120, mp: 50, pa: 10, ma: 8, spd: 8 },
    brave: 70,
    faith: 70,
    ...rest,
    jobs: {
      squire: { level: 2, jp: 100, totalJp: 200, learned: [] },
      [job]: { level: 2, jp: 500, totalJp: 600, learned: [] },
      ...jobOverrides,
    },
  };
}

function campaignOf(
  roster: PersistedUnit[] = [],
  inventory: Record<string, number> = {},
  gil = 0,
  seed = 73,
): CampaignState {
  const campaign = createCampaign(seed, 1_000);
  campaign.roster = roster;
  campaign.inventory = { ...inventory };
  campaign.gil = gil;
  return campaign;
}

describe('campaign economy', () => {
  it('awards gil and deterministic item drops for the same campaign seed and node', () => {
    const campaign = newGameCampaign(getScenario('battle-open'), 1_000);
    const scenario = getScenario('battle-open');
    const encounter = getEncounter(scenario.encounterId);
    expect(encounter).toBeDefined();
    const enemies = encounter!.enemies.map((enemy) => ({ level: enemy.level }));

    const rewards = computeBattleRewards(campaign.seed, scenario.id, enemies, DROP_TABLE);
    const replayed = computeBattleRewards(campaign.seed, scenario.id, enemies, DROP_TABLE);

    expect(rewards.gil).toBeGreaterThan(0);
    expect(Object.values(rewards.items).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(replayed).toEqual(rewards);

    const built = campaignToBattle(campaign, scenario);
    const won = battleToCampaign(
      campaign,
      { ...built.state, phase: 'victory' },
      2_000,
      { ...encounter!.rewards, gil: rewards.gil, items: rewards.items },
    );

    expect(won.gil).toBe(campaign.gil + rewards.gil);
    for (const [itemId, count] of Object.entries(rewards.items)) {
      expect(won.inventory[itemId]).toBe((campaign.inventory[itemId] ?? 0) + count);
    }
  });

  it('awards nothing after a loss', () => {
    const campaign = newGameCampaign(getScenario('battle-open'), 1_000);
    const scenario = getScenario('battle-open');
    const encounter = getEncounter(scenario.encounterId)!;
    const built = campaignToBattle(campaign, scenario);
    const beforeGil = campaign.gil;
    const beforeInventory = { ...campaign.inventory };
    const rewards = computeBattleRewards(
      campaign.seed,
      scenario.id,
      encounter.enemies.map((enemy) => ({ level: enemy.level })),
      DROP_TABLE,
    );

    const lost = battleToCampaign(
      campaign,
      { ...built.state, phase: 'defeat' },
      2_000,
      { ...encounter.rewards, gil: rewards.gil, items: rewards.items },
    );

    expect(lost.gil).toBe(beforeGil);
    expect(lost.inventory).toEqual(beforeInventory);
    expect(lost.progress.completed).not.toContain(scenario.id);
  });

  it('buys an item atomically and refuses an unaffordable purchase', () => {
    const campaign = campaignOf([], {}, 500);
    const chapterOne = shopScreenVM(campaign, { chapter: 1, townName: 'Gariland Camp' });
    const chapterTwo = shopScreenVM(campaign, { chapter: 2, townName: 'Merchant Road' });
    expect(chapterOne.stock.some((item) => item.id === 'dagger')).toBe(true);
    expect(chapterOne.stock.some((item) => item.id === 'long-sword')).toBe(false);
    expect(chapterTwo.stock.some((item) => item.id === 'long-sword')).toBe(true);

    const bought = buyItem(campaign, 'dagger', 200, 2_000);
    expect(bought.ok).toBe(true);
    if (!bought.ok) throw new Error('expected the affordable purchase to succeed');
    expect(bought.campaign.gil).toBe(300);
    expect(bought.campaign.inventory.dagger).toBe(1);

    const beforeRefusal = serialize(bought.campaign);
    const refused = buyItem(bought.campaign, 'defender', 20_000, 3_000);
    expect(refused).toEqual({ ok: false, reason: 'cannot-afford' });
    expect(serialize(bought.campaign)).toBe(beforeRefusal);
  });

  it('sells an owned item at the reduced rate and refuses an item not owned', () => {
    const campaign = campaignOf([], { dagger: 2 }, 40);

    const sold = sellItem(campaign, 'dagger', 200, 2_000);
    expect(sold.ok).toBe(true);
    if (!sold.ok) throw new Error('expected the owned item to sell');
    expect(sellPrice(200)).toBe(100);
    expect(sold.campaign.gil).toBe(140);
    expect(sold.campaign.inventory.dagger).toBe(1);

    const beforeRefusal = serialize(sold.campaign);
    const refused = sellItem(sold.campaign, 'rod', 200, 3_000);
    expect(refused).toEqual({ ok: false, reason: 'not-owned' });
    expect(serialize(sold.campaign)).toBe(beforeRefusal);
  });

  it('never lets gil become negative through any sequence of operations', () => {
    let campaign = campaignOf([], {}, 250);

    for (let i = 0; i < 20; i++) {
      const result = buyItem(campaign, `use-potion`, 100, 2_000 + i);
      if (result.ok) campaign = result.campaign;
      expect(campaign.gil).toBeGreaterThanOrEqual(0);
    }

    expect(campaign.gil).toBe(50);
    expect(campaign.inventory['use-potion']).toBe(2);
  });

  it('makes bought equipment immediately equippable while respecting job restrictions', () => {
    let campaign = campaignOf(
      [
        unit({ id: 'k', name: 'Knight', currentJob: 'knight' }),
        unit({ id: 'm', name: 'Mage', currentJob: 'black-mage' }),
      ],
      {},
      4_000,
    );

    for (let i = 0; i < 2; i++) {
      const bought = buyItem(campaign, 'long-sword', 1_500, 2_000 + i);
      expect(bought.ok).toBe(true);
      if (!bought.ok) throw new Error('expected equipment purchase to succeed');
      campaign = bought.campaign;
    }

    const roster = campaignRosterScreenVM(campaign);
    expect(
      roster.edits?.k?.inventory.find((item) => item.id === 'long-sword'),
    ).toMatchObject({ count: 2, canEquip: true });
    expect(
      roster.edits?.m?.inventory.find((item) => item.id === 'long-sword'),
    ).toMatchObject({ count: 2, canEquip: false });

    const knightEquip = equipItem(campaign, 'k', 'long-sword', 3_000);
    expect(knightEquip.ok).toBe(true);
    if (!knightEquip.ok) throw new Error('expected the knight to equip the bought sword');
    expect(knightEquip.campaign.roster[0]!.equipment.rightHand).toBe('long-sword');

    const mageEquip = equipItem(knightEquip.campaign, 'm', 'long-sword', 3_001);
    expect(mageEquip).toEqual({ ok: false, reason: 'cannot-equip' });
    expect(knightEquip.campaign.inventory['long-sword']).toBe(1);
  });

  it('preserves rewards, transactions, gil, inventory, and equipment through serialization', () => {
    let campaign = campaignOf(
      [unit({ id: 'm', name: 'Mage', currentJob: 'black-mage' })],
      { dagger: 1 },
      1_000,
    );
    const sold = sellItem(campaign, 'dagger', 200, 2_000);
    if (!sold.ok) throw new Error('expected sale to succeed');
    campaign = sold.campaign;
    const bought = buyItem(campaign, 'rod', 200, 2_001);
    if (!bought.ok) throw new Error('expected purchase to succeed');
    campaign = bought.campaign;
    const equipped = equipItem(campaign, 'm', 'rod', 2_002);
    if (!equipped.ok) throw new Error('expected bought rod to equip');
    campaign = equipped.campaign;
    const node = WORLD_NODES[0]!;
    const scenario = getScenario(node.scenarioId);
    const built = campaignToBattle(campaign, scenario, { worldNodeId: node.id });
    campaign = battleToCampaign(
      campaign,
      { ...built.state, phase: 'victory' },
      3_000,
      { gil: 123, exp: 0, jp: 0, items: { 'use-potion': 2 } },
    );

    const restored = deserialize(serialize(campaign));
    expect(restored).toEqual(campaign);
    expect(restored.gil).toBe(1_023);
    expect(restored.inventory.dagger).toBeUndefined();
    expect(restored.inventory['use-potion']).toBe(2);
    expect(restored.roster[0]!.equipment.rightHand).toBe('rod');
    expect(restored.progress.completed).toContain(node.id);
  });
});
