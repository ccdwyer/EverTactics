/**
 * Campaign world progression.
 *
 * Pure data and predicates only: no renderer, DOM, storage, clock, or randomness.
 * Node ids are the durable progression keys stored in CampaignProgress.completed.
 */

import type { CampaignState } from './campaign';

export interface WorldNode {
  id: string;
  name: string;
  kind: 'battle' | 'town' | 'event';
  scenarioId?: string;
  position: { x: number; y: number };
  requires: string[];
  chapter: number;
}

/**
 * The v0.1 two-chapter arc. Battles alternate terrain problems so progression
 * asks the company to learn a new tactical answer rather than replaying the
 * same fight on a different palette.
 */
export const WORLD_NODES: readonly WorldNode[] = [
  {
    id: 'battle-open',
    name: 'The Broken Cloister',
    kind: 'battle',
    scenarioId: 'first-lesson',
    position: { x: 0.12, y: 0.72 },
    requires: [],
    chapter: 1,
  },
  {
    id: 'gariland-camp',
    name: 'Gariland Camp',
    kind: 'town',
    position: { x: 0.28, y: 0.58 },
    requires: ['battle-open'],
    chapter: 1,
  },
  {
    id: 'mandalia-skirmish',
    name: 'Mandalia Skirmish',
    kind: 'battle',
    scenarioId: 'mandalia-skirmish',
    position: { x: 0.43, y: 0.7 },
    requires: ['gariland-camp'],
    chapter: 1,
  },
  {
    id: 'crossroads-oath',
    name: 'Oath at the Crossroads',
    kind: 'event',
    position: { x: 0.52, y: 0.47 },
    requires: ['mandalia-skirmish'],
    chapter: 1,
  },
  {
    id: 'gariland-bridge',
    name: 'Gariland Bridge',
    kind: 'battle',
    scenarioId: 'gariland-bridge',
    position: { x: 0.59, y: 0.61 },
    requires: ['crossroads-oath'],
    chapter: 1,
  },
  {
    id: 'zeirchele-charge',
    name: 'Zeirchele Charge',
    kind: 'battle',
    scenarioId: 'zeirchele-charge',
    position: { x: 0.7, y: 0.72 },
    requires: ['gariland-bridge'],
    chapter: 1,
  },
  {
    id: 'chapter-two',
    name: 'The Lion Banner',
    kind: 'event',
    position: { x: 0.75, y: 0.48 },
    requires: ['zeirchele-charge'],
    chapter: 2,
  },
  {
    id: 'lionel-gate',
    name: 'Lionel Gate',
    kind: 'battle',
    scenarioId: 'lionel-gate',
    position: { x: 0.82, y: 0.31 },
    requires: ['chapter-two'],
    chapter: 2,
  },
  {
    id: 'dorter-storehouse',
    name: 'Dorter Storehouse',
    kind: 'battle',
    scenarioId: 'dorter-storehouse',
    position: { x: 0.68, y: 0.25 },
    requires: ['lionel-gate'],
    chapter: 2,
  },
  {
    id: 'dorter-market',
    name: 'Dorter Market',
    kind: 'town',
    position: { x: 0.56, y: 0.39 },
    requires: ['dorter-storehouse'],
    chapter: 2,
  },
  {
    id: 'mandalia-ambush',
    name: 'Mandalia Ambush',
    kind: 'battle',
    scenarioId: 'mandalia-ambush',
    position: { x: 0.45, y: 0.58 },
    requires: ['dorter-market'],
    chapter: 2,
  },
  {
    id: 'orbonne-return',
    name: 'Return to Orbonne',
    kind: 'battle',
    scenarioId: 'orbonne-return',
    position: { x: 0.31, y: 0.37 },
    requires: ['mandalia-ambush'],
    chapter: 2,
  },
  {
    id: 'merchant-road',
    name: 'Merchant Road',
    kind: 'town',
    position: { x: 0.45, y: 0.2 },
    requires: ['orbonne-return'],
    chapter: 2,
  },
  {
    id: 'lionel-reckoning',
    name: 'Lionel Reckoning',
    kind: 'battle',
    scenarioId: 'lionel-reckoning',
    position: { x: 0.91, y: 0.16 },
    requires: ['merchant-road'],
    chapter: 2,
  },
];

/** True when all prerequisite node ids have been completed. */
export function isUnlocked(node: WorldNode, campaign: CampaignState): boolean {
  const completed = new Set(campaign.progress.completed);
  return node.requires.every((required) => completed.has(required));
}

/** Every unlocked destination not already completed, in authored route order. */
export function availableNodes(campaign: CampaignState): WorldNode[] {
  const completed = new Set(campaign.progress.completed);
  return WORLD_NODES.filter(
    (node) => !completed.has(node.id) && isUnlocked(node, campaign),
  );
}

/** The first unfinished destination on the authored route, if the arc remains. */
export function nextObjective(campaign: CampaignState): WorldNode | undefined {
  return availableNodes(campaign)[0];
}

/**
 * Complete a non-battle travel node without mutating the campaign.
 * Battle nodes are completed only by battleToCampaign after a victory.
 */
export function completeTravelNode(
  campaign: CampaignState,
  node: WorldNode,
  timestamp: number,
): CampaignState {
  if (node.kind === 'battle' || !isUnlocked(node, campaign)) return campaign;
  const completed = campaign.progress.completed.includes(node.id)
    ? [...campaign.progress.completed]
    : [...campaign.progress.completed, node.id];
  return {
    ...campaign,
    roster: [...campaign.roster],
    inventory: { ...campaign.inventory },
    formation: campaign.formation.map((entry) => ({ ...entry })),
    progress: { completed, current: node.id },
    updatedAt: timestamp,
  };
}
