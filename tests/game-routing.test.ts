import { beforeEach, describe, expect, it, vi } from 'vitest';

import { advance, applyCommand } from '../src/core/battle';
import { createCampaign, type CampaignState, type PersistedUnit } from '../src/core/campaign';

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
  openedJobVM: null as { jobs?: Array<{ id: string; unlocked: boolean }> } | null,
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
    on = vi.fn(() => vi.fn());
    setHudVisible = vi.fn();
    setTargetPreview = vi.fn();
    closeMenus = vi.fn();
    banner = vi.fn();
    sound = vi.fn();
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
  uiCapture.openedJobVM = null;
});

describe('Game campaign routing', () => {
  it('boots a new game through the campaign launcher with three Potions', () => {
    routing.scenario = peacefulFirstBattle();

    const game = newGame();

    expect(routing.launchCalls).toEqual(['battle-open']);
    expect(routing.buildCalls).toEqual([]);
    expect(saves.loadCalls).toBe(1);
    expect(game.campaign.inventory['use-potion']).toBe(3);
    expect(game.state.inventories?.get('player')?.get('use-potion')).toBe(3);
    expect(game.campaign.progress.current).toBe('battle-open');
    expect(saves.written.at(-1)?.progress.current).toBe('battle-open');
  });

  it('records a victory in the first battle without assigning BattleState fields', () => {
    routing.scenario = peacefulFirstBattle();
    const game = newGame();

    advance(game.state);
    expect(game.state.phase).toBe('victory');

    (game as unknown as { onBattleOver(): void }).onBattleOver();
    expect(game.campaign.progress.completed).toEqual(['battle-open']);
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
