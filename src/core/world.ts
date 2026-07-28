/**
 * Campaign world progression.
 *
 * Pure data and predicates only: no renderer, DOM, storage, clock, or randomness.
 * Node ids are the durable progression keys stored in CampaignProgress.completed.
 */

import { setCurrentWorldNode, type CampaignState } from './campaign';
import { worldNodeId, type WorldNodeId } from './ids';

export interface WorldNode {
  id: WorldNodeId;
  name: string;
  kind: 'battle' | 'town' | 'event';
  scenarioId?: string;
  position: { x: number; y: number };
  requires: WorldNodeId[];
  chapter: number;
}

const WORLD_NODE_IDS = {
  battleOpen: worldNodeId('battle-open'),
  garilandCamp: worldNodeId('gariland-camp'),
  mandaliaSkirmish: worldNodeId('mandalia-skirmish'),
  crossroadsOath: worldNodeId('crossroads-oath'),
  garilandBridge: worldNodeId('gariland-bridge'),
  zeircheleCharge: worldNodeId('zeirchele-charge'),
  chapterTwo: worldNodeId('chapter-two'),
  lionelGate: worldNodeId('lionel-gate'),
  dorterStorehouse: worldNodeId('dorter-storehouse'),
  dorterMarket: worldNodeId('dorter-market'),
  mandaliaAmbush: worldNodeId('mandalia-ambush'),
  orbonneReturn: worldNodeId('orbonne-return'),
  merchantRoad: worldNodeId('merchant-road'),
  lionelReckoning: worldNodeId('lionel-reckoning'),
} as const;

/**
 * The v0.1 two-chapter arc. Battles alternate terrain problems so progression
 * asks the company to learn a new tactical answer rather than replaying the
 * same fight on a different palette.
 */
export const WORLD_NODES: readonly WorldNode[] = [
  {
    id: WORLD_NODE_IDS.battleOpen,
    name: 'The Broken Cloister',
    kind: 'battle',
    scenarioId: 'first-lesson',
    position: { x: 0.12, y: 0.72 },
    requires: [],
    chapter: 1,
  },
  {
    id: WORLD_NODE_IDS.garilandCamp,
    name: 'Gariland Camp',
    kind: 'town',
    position: { x: 0.28, y: 0.58 },
    requires: [WORLD_NODE_IDS.battleOpen],
    chapter: 1,
  },
  {
    id: WORLD_NODE_IDS.mandaliaSkirmish,
    name: 'Mandalia Skirmish',
    kind: 'battle',
    scenarioId: 'mandalia-skirmish',
    position: { x: 0.43, y: 0.7 },
    requires: [WORLD_NODE_IDS.garilandCamp],
    chapter: 1,
  },
  {
    id: WORLD_NODE_IDS.crossroadsOath,
    name: 'Oath at the Crossroads',
    kind: 'event',
    position: { x: 0.52, y: 0.47 },
    requires: [WORLD_NODE_IDS.mandaliaSkirmish],
    chapter: 1,
  },
  {
    id: WORLD_NODE_IDS.garilandBridge,
    name: 'Gariland Bridge',
    kind: 'battle',
    scenarioId: 'gariland-bridge',
    position: { x: 0.59, y: 0.61 },
    requires: [WORLD_NODE_IDS.crossroadsOath],
    chapter: 1,
  },
  {
    id: WORLD_NODE_IDS.zeircheleCharge,
    name: 'Zeirchele Charge',
    kind: 'battle',
    scenarioId: 'zeirchele-charge',
    position: { x: 0.7, y: 0.72 },
    requires: [WORLD_NODE_IDS.garilandBridge],
    chapter: 1,
  },
  {
    id: WORLD_NODE_IDS.chapterTwo,
    name: 'The Lion Banner',
    kind: 'event',
    position: { x: 0.75, y: 0.48 },
    requires: [WORLD_NODE_IDS.zeircheleCharge],
    chapter: 2,
  },
  {
    id: WORLD_NODE_IDS.lionelGate,
    name: 'Lionel Gate',
    kind: 'battle',
    scenarioId: 'lionel-gate',
    position: { x: 0.82, y: 0.31 },
    requires: [WORLD_NODE_IDS.chapterTwo],
    chapter: 2,
  },
  {
    id: WORLD_NODE_IDS.dorterStorehouse,
    name: 'Dorter Storehouse',
    kind: 'battle',
    scenarioId: 'dorter-storehouse',
    position: { x: 0.68, y: 0.25 },
    requires: [WORLD_NODE_IDS.lionelGate],
    chapter: 2,
  },
  {
    id: WORLD_NODE_IDS.dorterMarket,
    name: 'Dorter Market',
    kind: 'town',
    position: { x: 0.56, y: 0.39 },
    requires: [WORLD_NODE_IDS.dorterStorehouse],
    chapter: 2,
  },
  {
    id: WORLD_NODE_IDS.mandaliaAmbush,
    name: 'Mandalia Ambush',
    kind: 'battle',
    scenarioId: 'mandalia-ambush',
    position: { x: 0.45, y: 0.58 },
    requires: [WORLD_NODE_IDS.dorterMarket],
    chapter: 2,
  },
  {
    id: WORLD_NODE_IDS.orbonneReturn,
    name: 'Return to Orbonne',
    kind: 'battle',
    scenarioId: 'orbonne-return',
    position: { x: 0.31, y: 0.37 },
    requires: [WORLD_NODE_IDS.mandaliaAmbush],
    chapter: 2,
  },
  {
    id: WORLD_NODE_IDS.merchantRoad,
    name: 'Merchant Road',
    kind: 'town',
    position: { x: 0.45, y: 0.2 },
    requires: [WORLD_NODE_IDS.orbonneReturn],
    chapter: 2,
  },
  {
    id: WORLD_NODE_IDS.lionelReckoning,
    name: 'Lionel Reckoning',
    kind: 'battle',
    scenarioId: 'lionel-reckoning',
    position: { x: 0.91, y: 0.16 },
    requires: [WORLD_NODE_IDS.merchantRoad],
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
  const arrived = setCurrentWorldNode(campaign, node.id, timestamp);
  return {
    ...arrived,
    progress: { ...arrived.progress, completed },
  };
}
