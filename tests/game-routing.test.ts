import { beforeEach, describe, expect, it, vi } from 'vitest';

import { advance, applyCommand } from '../src/core/battle';
import { createCampaign, type CampaignState, type PersistedUnit } from '../src/core/campaign';
import { computeBattleRewards } from '../src/core/economy';
import { BATTLE_DROP_TABLE } from '../src/state/items';
import type {
  ResultScreenVM,
  UIIntent,
  WorldMapScreenVM,
} from '../src/ui/types';

const routing = vi.hoisted(() => ({
  scenario: null as unknown,
  buildCalls: [] as string[],
  launchCalls: [] as string[],
}));

const saves = vi.hoisted(() => ({
  loaded: null as CampaignState | null,
  loadCalls: 0,
  written: [] as CampaignState[],
}));

const uiCapture = vi.hoisted(() => ({
  intentHandler: null as ((intent: UIIntent) => void) | null,
  openedJobVM: null as { jobs?: Array<{ id: string; unlocked: boolean }> } | null,
  openedShopVM: null as {
    title?: string;
    chapter?: number;
    stock?: Array<{ id: string }>;
  } | null,
  openedWorldMapVM: null as WorldMapScreenVM | null,
  intro: null as { mapName: string; encounterName: string } | null,
  outcome: null as { outcome: 'victory' | 'defeat'; subtitle: string } | null,
  result: null as ResultScreenVM | null,
  outcomeGate: null as Promise<void> | null,
}));

vi.mock('../src/state/scenarios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/state/scenarios')>();
  return {
    ...actual,
    getScenario: (id?: string) =>
      (routing.scenario as ReturnType<typeof actual.getScenario> | null)
      ?? actual.getScenario(id),
    buildScenario: (scenario: Parameters<typeof actual.buildScenario>[0]) => {
      routing.buildCalls.push(scenario.id);
      return actual.buildScenario(scenario);
    },
    launchCampaignBattle: (
      scenario: Parameters<typeof actual.launchCampaignBattle>[0],
      opts: Parameters<typeof actual.launchCampaignBattle>[1],
    ) => {
      routing.launchCalls.push(scenario.id);
      return actual.launchCampaignBattle(scenario, opts);
    },
  };
});

vi.mock('../src/state/save', () => ({
  loadCampaign: () => {
    saves.loadCalls += 1;
    return saves.loaded;
  },
  saveCampaign: (campaign: CampaignState) => {
    saves.written.push(campaign);
  },
}));

vi.mock('../src/state/render', () => ({
  SPRITE_LAYER: 1,
  installPostStack: vi.fn(),
  markAsSprite: vi.fn(),
}));

vi.mock('../src/render/camera', () => ({
  TILE_SIZE: 1,
  IsoCamera: class {
    camera = { layers: { enable: vi.fn() } };
    focusTile = vi.fn();
  },
}));

vi.mock('../src/render/lighting', () => ({
  LightingRig: class {
    current = { rimColor: 0xffffff };
    key = {
      position: { x: 0, y: 1, z: 0 },
      target: { position: { x: 0, y: 0, z: 0 } },
    };
    bindRenderer = vi.fn();
    tune = vi.fn();
  },
}));

vi.mock('../src/render/sprites', () => ({
  SpriteLayer: class {
    all: unknown[] = [];
  },
}));

vi.mock('../src/render/stage', () => ({
  Stage: class {
    scene = { add: vi.fn() };
    renderer = {};
    setCamera = vi.fn();
  },
}));

vi.mock('../src/render/terrain', () => ({
  Terrain: class {},
  buildTerrain: vi.fn(),
  tileWorldPosition: vi.fn(),
}));

vi.mock('../src/render/vfx', () => ({
  VFX_KEYS: [],
  VfxSystem: class {
    addTo = vi.fn();
  },
}));

vi.mock('../src/ui/UIRoot', () => ({
  UIRoot: class {
    on = vi.fn((handler: (intent: UIIntent) => void) => {
      uiCapture.intentHandler = handler;
      return vi.fn();
    });
    setHudVisible = vi.fn();
    setTargetPreview = vi.fn();
    closeMenus = vi.fn();
    closeScreen = vi.fn();
    banner = vi.fn();
    presentBattleIntro = vi.fn((vm: { mapName: string; encounterName: string }) => {
      uiCapture.intro = vm;
      return Promise.resolve();
    });
    presentBattleOutcome = vi.fn((vm: { outcome: 'victory' | 'defeat'; subtitle: string }) => {
      uiCapture.outcome = vm;
      return uiCapture.outcomeGate ?? Promise.resolve();
    });
    showResult = vi.fn((vm: ResultScreenVM) => {
      uiCapture.result = vm;
    });
    sound = vi.fn();
    openWorldMapScreen = vi.fn((vm: WorldMapScreenVM) => {
      uiCapture.openedWorldMapVM = vm;
    });
    openShopScreen = vi.fn((vm: typeof uiCapture.openedShopVM) => {
      uiCapture.openedShopVM = vm;
    });
    openJobScreen = vi.fn((vm: typeof uiCapture.openedJobVM) => {
      uiCapture.openedJobVM = vm;
    });
    setTurnOrder = vi.fn();
    setActiveUnit = vi.fn();
    updateJobScreen = vi.fn((vm: typeof uiCapture.openedJobVM) => {
      uiCapture.openedJobVM = vm;
    });
  },
}));

import { Game } from '../src/state/game';
import {
  buildScenario,
  getEncounter,
  getScenario,
  isDiagnosticScenario,
  listScenarios,
  type Scenario,
} from '../src/state/scenarios';

function peacefulFirstBattle(): Scenario {
  const shipped = getScenario('battle-open');
  return {
    ...shipped,
    layers: { ...shipped.layers, ui: false },
    units: shipped.units.filter((placement) => placement.team === 'player'),
  };
}

function persistedDarkKnightCandidate(): PersistedUnit {
  return {
    id: 'k',
    name: 'Knight',
    gender: 'male',
    zodiac: 'aries',
    level: 20,
    exp: 0,
    totalExp: 1900,
    kills: 20,
    currentJob: 'knight',
    jobs: {
      squire: { level: 8, jp: 0, totalJp: 3000, learned: [] },
      knight: { level: 8, jp: 0, totalJp: 3000, learned: [] },
      chemist: { level: 8, jp: 0, totalJp: 3000, learned: [] },
      'black-mage': { level: 8, jp: 0, totalJp: 3000, learned: [] },
    },
    equipment: {},
    raw: { hp: 180, mp: 90, pa: 12, ma: 10, spd: 9 },
    brave: 70,
    faith: 70,
  };
}

function newGame(): Game {
  return new Game({
    scenarioId: 'battle-open',
    container: {} as HTMLElement,
    uiMount: {} as HTMLElement,
  });
}

function renderFacingCast(state: Game['state']) {
  return [...state.units.values()].map((unit) => ({
    id: unit.id,
    name: unit.name,
    team: unit.team,
    currentJob: unit.currentJob,
    gender: unit.gender,
    level: unit.level,
    pos: unit.pos,
    facing: unit.facing,
    ct: unit.ct,
    sprite: unit.sprite,
    stats: unit.stats,
  }));
}

beforeEach(() => {
  routing.scenario = null;
  routing.buildCalls.length = 0;
  routing.launchCalls.length = 0;
  saves.loaded = null;
  saves.loadCalls = 0;
  saves.written.length = 0;
  uiCapture.intentHandler = null;
  uiCapture.openedJobVM = null;
  uiCapture.openedShopVM = null;
  uiCapture.openedWorldMapVM = null;
  uiCapture.intro = null;
  uiCapture.outcome = null;
  uiCapture.result = null;
  uiCapture.outcomeGate = null;
});

describe('Game campaign routing', () => {
  it('boots through the campaign launcher and routes an unlocked town into its shop', () => {
    routing.scenario = peacefulFirstBattle();

    const game = newGame();

    expect(routing.launchCalls).toEqual(['battle-open']);
    expect(routing.buildCalls).toEqual([]);
    expect(saves.loadCalls).toBe(1);
    expect(game.campaign.inventory['use-potion']).toBe(3);
    expect(game.state.inventories?.get('player')?.get('use-potion')).toBe(3);
    expect(game.campaign.progress.current).toBe('battle-open');
    expect(saves.written.at(-1)?.progress.current).toBe('battle-open');

    saves.loaded = {
      ...game.campaign,
      progress: { completed: ['battle-open'], current: 'battle-open' },
    };
    const map = new Game({
      scenarioId: 'battle-open',
      worldMap: true,
      container: {} as HTMLElement,
      uiMount: {} as HTMLElement,
    });
    (map as unknown as { onWorldNodeSelect(nodeId: string): void })
      .onWorldNodeSelect('gariland-camp');
    expect(uiCapture.openedShopVM).toMatchObject({
      title: 'Gariland Camp',
      chapter: 1,
    });
    expect(uiCapture.openedShopVM?.stock?.some((item) => item.id === 'dagger')).toBe(true);
    expect(map.campaign.progress.completed).toEqual(['battle-open', 'gariland-camp']);

    routing.scenario = null;
    saves.loaded = null;
    const firstLesson = new Game({
      scenarioId: 'first-lesson',
      params: new URLSearchParams('node=battle-open'),
      container: {} as HTMLElement,
      uiMount: {} as HTMLElement,
    });
    expect(firstLesson.campaign.progress.current).toBe('battle-open');
    expect(saves.written.at(-1)?.progress.current).toBe('battle-open');
  });

  it('records a victory in the first battle without assigning BattleState fields', () => {
    routing.scenario = peacefulFirstBattle();
    const game = newGame();
    const encounter = getEncounter(game.scenario.encounterId)!;
    const expected = computeBattleRewards(
      game.campaign.seed,
      'battle-open',
      encounter.enemies,
      BATTLE_DROP_TABLE,
    );

    advance(game.state);
    expect(game.state.phase).toBe('victory');

    (game as unknown as { onBattleOver(): void }).onBattleOver();
    expect(game.campaign.progress.completed).toEqual(['battle-open']);
    expect(game.campaign.gil).toBe(expected.gil);
    for (const [itemId, count] of Object.entries(expected.items)) {
      expect(game.campaign.inventory[itemId]).toBe(
        ((itemId === 'use-potion' ? 3 : 0) + count),
      );
    }
  });

  it('presents the authored map and encounter names before starting the first turn', async () => {
    const peaceful = peacefulFirstBattle();
    routing.scenario = { ...peaceful, layers: { ...peaceful.layers, ui: true } };
    const game = newGame();
    const beginTurn = vi.spyOn(game, 'beginTurn').mockResolvedValue();

    await (game as unknown as { startBattle(): Promise<void> }).startBattle();

    expect(uiCapture.intro).toEqual({
      mapName: 'Orbonne Monastery — Cloister Garden',
      encounterName: 'Orbonne Monastery — Cloister Garden',
    });
    expect(beginTurn).toHaveBeenCalledOnce();
  });

  it('keeps the legacy Mandalia entry copy when no encounter record exists', async () => {
    const legacy = getScenario('mandalia-ford');
    routing.scenario = legacy;
    const game = newGame();
    vi.spyOn(game, 'beginTurn').mockResolvedValue();

    await game.startBattle();

    expect(uiCapture.intro).toEqual({
      mapName: 'Mandalia Plains',
      encounterName: 'The river crossing',
    });
  });

  it('holds the outcome presentation before opening the result screen', async () => {
    const peaceful = peacefulFirstBattle();
    routing.scenario = { ...peaceful, layers: { ...peaceful.layers, ui: true } };
    const game = newGame();
    let releaseOutcome = (): void => undefined;
    uiCapture.outcomeGate = new Promise<void>((resolve) => {
      releaseOutcome = resolve;
    });

    advance(game.state);
    expect(game.state.phase).toBe('victory');
    (game as unknown as { onBattleOver(): void }).onBattleOver();

    expect(uiCapture.outcome).toEqual({
      outcome: 'victory',
      subtitle: 'The field is yours.',
    });
    expect(uiCapture.result).toBeNull();

    releaseOutcome();
    await Promise.resolve();
    await Promise.resolve();
    expect(uiCapture.result?.outcome).toBe('victory');
  });

  it('returns to the world map with the saved campaign after dismissing battle results', () => {
    routing.scenario = peacefulFirstBattle();
    const game = newGame();

    advance(game.state);
    expect(game.state.phase).toBe('victory');
    (game as unknown as { onBattleOver(): void }).onBattleOver();

    const saved = saves.written.at(-1);
    expect(saved?.progress.completed).toEqual(['battle-open']);
    expect(uiCapture.intentHandler).not.toBeNull();
    uiCapture.intentHandler?.({ kind: 'result-dismiss' });

    expect(uiCapture.openedWorldMapVM?.gil).toBe(saved?.gil);
    expect(
      uiCapture.openedWorldMapVM?.nodes.find((node) => node.id === 'battle-open'),
    ).toMatchObject({
      id: 'battle-open',
      state: 'completed',
    });
  });

  it('threads persisted kills through the real Game job UI and mutation path', () => {
    routing.scenario = peacefulFirstBattle();
    const campaign = createCampaign(99, 1_000);
    campaign.roster = [persistedDarkKnightCandidate()];
    campaign.formation = [{ unitId: 'k', startIndex: 0 }];
    saves.loaded = campaign;
    const game = newGame();

    advance(game.state);
    expect(game.state.phase).toBe('victory');
    (game as unknown as { onBattleOver(): void }).onBattleOver();
    (game as unknown as { openJobScreenById(unitId: string): void }).openJobScreenById('k');
    expect(uiCapture.openedJobVM?.jobs?.find((job) => job.id === 'dark-knight')?.unlocked).toBe(true);

    // Issue the same intent the UI sends. No UnlockContext is supplied by this
    // test; Game derives it from the persisted kill count.
    (game as unknown as { onSetJob(unitId: string, jobId: string): void })
      .onSetJob('k', 'dark-knight');
    expect(game.campaign.roster[0]?.currentJob).toBe('dark-knight');
  });

  it('keeps shot routing and render-facing casts unchanged', () => {
    for (const id of ['terrain-only', 'sprites-only', 'ui-only']) {
      new Game({
        scenarioId: id,
        container: {} as HTMLElement,
        uiMount: {} as HTMLElement,
        shot: true,
      });
    }

    expect(routing.buildCalls).toEqual(['terrain-only', 'sprites-only', 'ui-only']);
    expect(routing.launchCalls).toEqual([]);
    expect(saves.loadCalls).toBe(0);
    routing.buildCalls.length = 0;

    for (const scenario of listScenarios()) {
      if (isDiagnosticScenario(scenario.id)) continue;
      const game = new Game({
        scenarioId: scenario.id,
        container: {} as HTMLElement,
        uiMount: {} as HTMLElement,
        shot: true,
      });
      const hardcoded = buildScenario(scenario);
      expect(renderFacingCast(game.state), scenario.id).toEqual(renderFacingCast(hardcoded.state));
      expect([...game.built.personalities], scenario.id).toEqual([...hardcoded.personalities]);
    }
    expect(saves.loadCalls).toBe(0);
    expect(saves.written).toEqual([]);
  });

  it('costs an AI its turn when its proposed command is rejected', async () => {
    vi.useFakeTimers();
    try {
      const game = newGame();

      let guard = 0;
      while (guard++ < 1000) {
        if (game.state.phase === 'awaiting-command') {
          const active = game.state.active;
          const unit = active === undefined ? undefined : game.state.units.get(active);
          if (unit?.team === 'enemy') break;
          if (active !== undefined) {
            applyCommand(game.state, { kind: 'wait', unit: active });
            continue;
          }
        }
        advance(game.state);
      }

      const active = game.state.active;
      expect(active).toBeDefined();
      expect(game.state.units.get(active!)?.team).toBe('enemy');

      const submitted: string[] = [];
      vi.spyOn(game, 'submit').mockImplementation(async (command) => {
        submitted.push(command.kind);
        if (submitted.length === 1) return false;

        applyCommand(game.state, command);
        (game as unknown as { disposed: boolean }).disposed = true;
        return true;
      });

      const turn = game.beginTurn();
      await vi.advanceTimersByTimeAsync(280);
      await turn;

      expect(submitted).toEqual([expect.any(String), 'wait']);
      expect(game.state.phase).toBe('tick');
      expect(game.state.active).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
