import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAiWorld, decideTurn } from '../src/core/ai';
import {
  IllegalCommandError,
  advance,
  applyCommand,
  evaluateObjective,
} from '../src/core/battle';
import { attackDirection } from '../src/core/combat/hit';
import { forecastTurns } from '../src/core/ct';
import { getMapDef } from '../src/core/grid';
import { stockAwareWorld } from '../src/core/inventory';
import { nextObjective } from '../src/core/world';
import type { CampaignState } from '../src/core/campaign';
import type { BattleState } from '../src/core/types';
import {
  continueCampaign,
  resolveBootRoute,
  startNewCampaign,
  titleScreenVM,
} from '../src/state/onboarding';
import {
  STARTER_CAMPAIGN_INVENTORY,
  campaignToBattle,
  getEncounter,
  getScenario,
} from '../src/state/scenarios';
import { ALL_ABILITIES, ALL_ITEMS } from '../src/state/content';
import {
  CAMPAIGN_STORAGE_KEY,
  loadCampaign,
  saveCampaign,
} from '../src/state/save';

function installMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, value);
    },
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}

function isFinished(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

function expectStarted(
  result: ReturnType<typeof startNewCampaign>,
): CampaignState {
  expect(result.kind).toBe('world-map');
  if (result.kind !== 'world-map') {
    throw new Error(`expected world-map, received ${result.kind}`);
  }
  return result.campaign;
}

function playFirstBattle(seed: number, turnCap = 300): {
  phase: BattleState['phase'];
  turns: number;
} {
  const campaign = expectStarted(
    startNewCampaign({ timestamp: 1_700_000_000_000, confirmOverwrite: true }),
  );
  campaign.seed = seed;
  const firstNode = nextObjective(campaign);
  if (!firstNode?.scenarioId) throw new Error('chapter 1 has no first battle scenario');

  const scenario = getScenario(firstNode.scenarioId);
  const built = campaignToBattle(campaign, scenario);
  const state = built.state;
  const world = stockAwareWorld(createAiWorld({
    abilities: ALL_ABILITIES,
    items: ALL_ITEMS,
  }));
  let turns = 0;

  while (turns < turnCap && !isFinished(state)) {
    if (evaluateObjective(state)) break;

    let clockTicks = 0;
    while (state.phase !== 'awaiting-command' && !isFinished(state) && clockTicks < 1_000) {
      advance(state);
      clockTicks++;
    }
    if (state.phase !== 'awaiting-command') break;

    const activeId = state.active;
    if (!activeId) {
      throw new Error(`battle reached awaiting-command without an active unit for seed ${seed}`);
    }
    const plan = decideTurn(state, activeId, {
      world,
      personalities: built.personalities,
    });
    for (const command of plan) {
      if (state.phase !== 'awaiting-command' || state.active !== activeId) break;
      try {
        applyCommand(state, command);
      } catch (error) {
        if (error instanceof IllegalCommandError) {
          throw new Error(
            `AI proposed an illegal command for seed ${seed}, turn ${turns}: ` +
              `${JSON.stringify(command)} — ${error.message}`,
          );
        }
        throw error;
      }
    }
    if (state.phase === 'awaiting-command' && state.active === activeId) {
      throw new Error(
        `AI plan did not close the turn for seed ${seed}, turn ${turns}: ${JSON.stringify(plan)}`,
      );
    }
    turns++;
  }

  return { phase: state.phase, turns };
}

beforeEach(() => {
  installMemoryStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('onboarding', () => {
  it('disables Continue without a save and creates the chapter 1 starting campaign', () => {
    const vm = titleScreenVM();
    expect(vm.continueAvailable).toBe(false);

    const campaign = expectStarted(startNewCampaign({
      timestamp: 1_700_000_000_000,
      confirmOverwrite: false,
    }));
    expect(nextObjective(campaign)?.chapter).toBe(1);
    expect(campaign.roster.map((unit) => unit.id)).toEqual([
      'p-aldric',
      'p-seryn',
      'p-belric',
      'p-ivane',
      'p-torvald',
      'p-nessa',
    ]);
    expect(campaign.inventory).toEqual(STARTER_CAMPAIGN_INVENTORY);
    expect(loadCampaign()).toEqual(campaign);
  });

  it('continues the exact saved roster, gil, and progress', () => {
    const saved = expectStarted(startNewCampaign({
      timestamp: 1_700_000_000_000,
      confirmOverwrite: false,
    }));
    saved.roster[0]!.name = 'Agrias';
    saved.gil = 8_675;
    saved.progress = {
      completed: ['battle-open', 'gariland-camp'],
      current: 'gariland-camp',
    };
    saveCampaign(saved);

    expect(titleScreenVM().continueAvailable).toBe(true);
    const result = continueCampaign();
    expect(result).toEqual({ kind: 'world-map', campaign: saved });
  });

  it('requires explicit confirmation before New Game overwrites an existing save', () => {
    const saved = expectStarted(startNewCampaign({
      timestamp: 1_700_000_000_000,
      confirmOverwrite: false,
    }));
    saved.gil = 42_000;
    saveCampaign(saved);
    const rawBefore = localStorage.getItem(CAMPAIGN_STORAGE_KEY);

    const refused = startNewCampaign({
      timestamp: 1_700_000_001_000,
      confirmOverwrite: false,
    });
    expect(refused).toEqual({ kind: 'confirmation-required' });
    expect(localStorage.getItem(CAMPAIGN_STORAGE_KEY)).toBe(rawBefore);
    expect(loadCampaign()).toEqual(saved);

    const confirmed = startNewCampaign({
      timestamp: 1_700_000_001_000,
      confirmOverwrite: true,
    });
    expect(confirmed.kind).toBe('world-map');
    if (confirmed.kind !== 'world-map') throw new Error('confirmation did not start a campaign');
    expect(confirmed.campaign.gil).not.toBe(saved.gil);
    expect(loadCampaign()).toEqual(confirmed.campaign);
  });

  it('keeps scene and shot query routes out of the title flow', () => {
    expect(resolveBootRoute('?scene=battle-open')).toEqual({
      kind: 'scene',
      scenarioId: 'battle-open',
    });
    expect(resolveBootRoute('?shot=terrain-only')).toEqual({
      kind: 'shot',
      scenarioId: 'terrain-only',
    });
    expect(resolveBootRoute('?shot=ui-only&scene=battle-open')).toEqual({
      kind: 'shot',
      scenarioId: 'ui-only',
    });
    expect(resolveBootRoute('')).toEqual({ kind: 'title' });
  });

  it('makes the first battle decisively winnable without reaching the turn cap', () => {
    const campaign = expectStarted(startNewCampaign({
      timestamp: 1_700_000_000_000,
      confirmOverwrite: true,
    }));
    const firstNode = nextObjective(campaign);
    if (!firstNode?.scenarioId) throw new Error('chapter 1 has no first battle scenario');
    const scenario = getScenario(firstNode.scenarioId);
    const encounter = getEncounter(scenario.encounterId);
    const starts = getMapDef(scenario.mapId)?.playerStarts ?? [];
    expect(encounter, 'first battle has no authored encounter').toBeDefined();
    expect(encounter!.enemies.length).toBeGreaterThan(0);
    expect(encounter!.enemies.length).toBeLessThanOrEqual(3);
    expect(Math.max(...encounter!.enemies.map((enemy) => enemy.level))).toBeLessThanOrEqual(6);
    expect(
      encounter!.enemies.some((enemy) =>
        starts.some((start) => {
          const distance = Math.abs(start.x - enemy.at.x) + Math.abs(start.y - enemy.at.y);
          return distance <= 5 && attackDirection(
            { ...start, z: 0 },
            { ...enemy.at, z: 0 },
            enemy.facing,
          ) === 'back';
        }),
      ),
      'no first-turn route exposes an enemy back attack',
    ).toBe(true);

    campaign.seed = 1;
    const opening = campaignToBattle(campaign, scenario);
    let openingTicks = 0;
    while (opening.state.phase !== 'awaiting-command' && openingTicks < 1_000) {
      advance(opening.state);
      openingTicks++;
    }
    expect(openingTicks).toBeLessThan(1_000);
    const firstActorId = opening.state.active;
    if (!firstActorId) throw new Error('first lesson opened without an active unit');
    expect(opening.state.units.get(firstActorId)?.team).toBe('player');
    const firstPlan = decideTurn(opening.state, firstActorId, {
      world: stockAwareWorld(createAiWorld({
        abilities: ALL_ABILITIES,
        items: ALL_ITEMS,
      })),
      personalities: opening.personalities,
    });
    const moveIndex = firstPlan.findIndex((command) => command.kind === 'move');
    const actIndex = firstPlan.findIndex((command) => command.kind === 'act');
    expect(
      moveIndex,
      `the first lesson does not require movement: ${JSON.stringify(firstPlan)}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      actIndex,
      `the first lesson offers no follow-up attack: ${JSON.stringify(firstPlan)}`,
    ).toBeGreaterThan(moveIndex);
    const move = firstPlan[moveIndex];
    const act = firstPlan[actIndex];
    if (move?.kind !== 'move' || act?.kind !== 'act' || !act.targetUnit) {
      throw new Error(`unexpected first lesson plan: ${JSON.stringify(firstPlan)}`);
    }
    const destination = move.path.at(-1);
    const target = opening.state.units.get(act.targetUnit);
    if (!destination || !target) throw new Error('first lesson plan has no attack destination');
    expect(attackDirection(destination, target.pos, target.facing)).toBe('back');
    const forecast = forecastTurns(opening.state, 8);
    expect(new Set(forecast.map((entry) => entry.unit)).size).toBeGreaterThan(1);
    expect(
      forecast.some((entry) => opening.state.units.get(entry.unit)?.team === 'enemy'),
      'turn forecast does not expose an enemy turn',
    ).toBe(true);

    const seeds = [1, 2, 3, 5, 8, 13];
    const results = seeds.map((seed) => playFirstBattle(seed));

    expect(results.some((result) => result.phase === 'victory')).toBe(true);
    for (const [index, result] of results.entries()) {
      expect(result.turns, `seed ${seeds[index]} hit the turn cap`).toBeLessThan(300);
      expect(['victory', 'defeat'], `seed ${seeds[index]} did not resolve`).toContain(result.phase);
    }
  });
});
