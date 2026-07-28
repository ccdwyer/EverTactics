import { describe, expect, it } from 'vitest';

import {
  battleToCampaign,
  deserialize,
  serialize,
  type CampaignState,
} from '../src/core/campaign';
import { computeBattleRewards } from '../src/core/economy';
import {
  WORLD_NODES,
  availableNodes,
  isUnlocked,
  nextObjective,
  type WorldNode,
} from '../src/core/world';
import {
  ENCOUNTERS,
  SCENARIOS,
  campaignToBattle,
  getEncounter,
  getScenario,
  newGameCampaign,
} from '../src/state/scenarios';
import { BATTLE_DROP_TABLE } from '../src/state/items';
import type { BattleState } from '../src/core/types';

const FIRST_BATTLE_ID = 'battle-open';
const FIRST_DESTINATION_ID = 'gariland-camp';

function freshCampaign(): CampaignState {
  return newGameCampaign(getScenario(FIRST_BATTLE_ID), 1_700_000_000_000);
}

function finishedBattle(state: BattleState, phase: 'victory' | 'defeat'): BattleState {
  return { ...state, phase };
}

describe('world progression', () => {
  it('locks a node until every prerequisite is completed', () => {
    const campaign = freshCampaign();
    const destination = WORLD_NODES.find((node) => node.id === FIRST_DESTINATION_ID);
    expect(destination).toBeDefined();
    expect(isUnlocked(destination!, campaign)).toBe(false);

    const progressed: CampaignState = {
      ...campaign,
      progress: { ...campaign.progress, completed: [FIRST_BATTLE_ID] },
    };
    expect(isUnlocked(destination!, progressed)).toBe(true);
  });

  it('returns only unlocked, uncompleted nodes', () => {
    const campaign = freshCampaign();
    expect(availableNodes(campaign).map((node) => node.id)).toEqual([FIRST_BATTLE_ID]);

    const progressed: CampaignState = {
      ...campaign,
      progress: { ...campaign.progress, completed: [FIRST_BATTLE_ID] },
    };
    expect(availableNodes(progressed).map((node) => node.id)).toEqual([FIRST_DESTINATION_ID]);
  });

  it('records a won battle node and unlocks the next objective', () => {
    const campaign = freshCampaign();
    const scenario = getScenario(FIRST_BATTLE_ID);
    const encounter = getEncounter(scenario.encounterId);
    expect(encounter).toBeDefined();
    const firstUnit = campaign.roster[0]!;
    const firstJob = firstUnit.jobs[firstUnit.currentJob]!;
    const economy = computeBattleRewards(
      campaign.seed,
      FIRST_BATTLE_ID,
      encounter!.enemies,
      BATTLE_DROP_TABLE,
    );
    const built = campaignToBattle(campaign, scenario);
    const won = battleToCampaign(
      campaign,
      finishedBattle(built.state, 'victory'),
      1_700_000_001_000,
      { ...encounter!.rewards, gil: economy.gil, items: economy.items },
    );

    expect(won.progress.completed).toContain(FIRST_BATTLE_ID);
    expect(nextObjective(won)?.id).toBe(FIRST_DESTINATION_ID);
    expect(availableNodes(won).map((node) => node.id)).toContain(FIRST_DESTINATION_ID);
    expect(won.gil).toBe(campaign.gil + economy.gil);
    expect(won.roster[0]!.totalExp).toBe(firstUnit.totalExp + encounter!.rewards.exp);
    expect(won.roster[0]!.jobs[firstUnit.currentJob]!.totalJp).toBe(
      firstJob.totalJp + encounter!.rewards.jp,
    );
  });

  it('records nothing after a loss so the battle node remains available', () => {
    const campaign = freshCampaign();
    const built = campaignToBattle(campaign, getScenario(FIRST_BATTLE_ID));
    const lost = battleToCampaign(
      campaign,
      finishedBattle(built.state, 'defeat'),
      1_700_000_001_000,
    );

    expect(lost.progress.completed).not.toContain(FIRST_BATTLE_ID);
    expect(availableNodes(lost).map((node) => node.id)).toContain(FIRST_BATTLE_ID);
  });

  it('preserves the whole progression chain through serialize and deserialize', () => {
    const campaign = freshCampaign();
    const first = campaignToBattle(campaign, getScenario(FIRST_BATTLE_ID));
    const won = battleToCampaign(
      campaign,
      finishedBattle(first.state, 'victory'),
      1_700_000_001_000,
    );
    const visitedTown: CampaignState = {
      ...won,
      progress: {
        completed: [...won.progress.completed, FIRST_DESTINATION_ID],
        current: FIRST_DESTINATION_ID,
      },
      updatedAt: 1_700_000_002_000,
    };

    const restored = deserialize(serialize(visitedTown));
    expect(restored.progress).toEqual(visitedTown.progress);
    expect(nextObjective(restored)?.requires).toContain(FIRST_DESTINATION_ID);
  });

  it('has real scenarios and an acyclic graph with no dangling prerequisites', () => {
    const ids = new Set(WORLD_NODES.map((node) => node.id));
    expect(ids.size).toBe(WORLD_NODES.length);

    for (const node of WORLD_NODES) {
      for (const required of node.requires) {
        expect(ids.has(required), `${node.id} requires missing node ${required}`).toBe(true);
      }
      if (node.kind === 'battle') {
        expect(node.scenarioId, `${node.id} has no scenario`).toBeDefined();
        const scenario = node.scenarioId ? SCENARIOS[node.scenarioId] : undefined;
        expect(
          scenario,
          `${node.id} points at missing scenario ${node.scenarioId ?? '(none)'}`,
        ).toBeDefined();
        expect(scenario?.encounterId, `${node.id} has no encounter`).toBeDefined();
        expect(
          scenario?.encounterId ? ENCOUNTERS[scenario.encounterId] : undefined,
          `${node.id} points at missing encounter ${scenario?.encounterId ?? '(none)'}`,
        ).toBeDefined();
      }
    }

    const byId = new Map<string, WorldNode>(WORLD_NODES.map((node) => [node.id, node]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      expect(visiting.has(id), `cycle reaches ${id}`).toBe(false);
      visiting.add(id);
      for (const required of byId.get(id)?.requires ?? []) visit(required);
      visiting.delete(id);
      visited.add(id);
    };
    for (const node of WORLD_NODES) visit(node.id);
    expect(visited.size).toBe(WORLD_NODES.length);
  });
});
