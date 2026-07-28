import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { advance, applyCommand } from '../src/core/battle';
import { createCampaign, type CampaignState, type PersistedUnit } from '../src/core/campaign';
import { computeBattleRewards } from '../src/core/economy';
import { BATTLE_DROP_TABLE } from '../src/state/items';
import { resolveBootRoute } from '../src/state/onboarding';
import { abilityById } from '../src/state/viewModels';
import { WORLD_NODES } from '../src/core/world';
import type {
  BattleEvent,
  BattleState,
} from '../src/core/types';
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
    devicePixelsPerTexel = 3;
    focusTile = vi.fn();
    worldToScreen = vi.fn(() => ({ x: 0, y: 0, depth: 0, visible: true }));
    cinematic = vi.fn(async () => undefined);
    endCinematic = vi.fn(async () => undefined);
    cancelCinematic = vi.fn();
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
    get = vi.fn();
    remove = vi.fn();
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
  tileWorldPosition: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
}));

vi.mock('../src/render/vfx', () => ({
  VFX_KEYS: ['black/flare'],
  VfxSystem: class {
    addTo = vi.fn();
    beginCharge = vi.fn(() => ({ release: vi.fn(), cancel: vi.fn() }));
    play = vi.fn(async () => undefined);
    playHitSpark = vi.fn();
    playBloodBurst = vi.fn();
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
    hideAbilityMenu = vi.fn();
    hideCommandMenu = vi.fn();
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
    showCommandMenu = vi.fn();
    setHints = vi.fn();
    float = vi.fn();
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

function peacefulFirstLesson(): Scenario {
  const shipped = getScenario('first-lesson');
  return {
    ...shipped,
    layers: { ...shipped.layers, ui: false },
    units: shipped.units.filter((placement) => placement.team === 'player'),
  };
}

function adjacentFinisherScenario(): Scenario {
  const shipped = getScenario('first-lesson');
  const player = shipped.units.find((placement) => placement.team === 'player')!;
  const { encounterId: _encounterId, ...withoutEncounter } = shipped;
  return {
    ...withoutEncounter,
    id: 'ui-victory-regression',
    layers: { ...shipped.layers, ui: true },
    units: [
      { ...player, ct: 100 },
      {
        id: 'e-adjacent',
        name: 'Adjacent Novice',
        job: 'squire',
        gender: 'male',
        team: 'enemy',
        level: 1,
        zodiac: 'taurus',
        brave: 50,
        faith: 50,
        at: { x: 4, y: 11 },
        facing: 'N',
        equipment: {},
        personality: 'defensive',
        ct: 0,
      },
    ],
    objective: { kind: 'defeat-all' },
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

function newGameAtFirstNode(): Game {
  return new Game({
    scenarioId: 'first-lesson',
    params: new URLSearchParams('node=battle-open'),
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

function battleStateBytes(state: BattleState): string {
  return JSON.stringify(state, (_key, value: unknown) => {
    if (value instanceof Map) return [...value.entries()];
    if (value instanceof Set) return [...value.values()];
    return value;
  });
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

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(game.campaign.progress.current).toBeUndefined();
    expect(saves.written.at(-1)?.progress.current).toBeUndefined();

    saves.loaded = {
      ...game.campaign,
      progress: { completed: [WORLD_NODES[0]!.id], current: WORLD_NODES[0]!.id },
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

  it('does not replace a world-node current value during a direct scenario boot', () => {
    const previousNode = WORLD_NODES.find((node) => node.id === 'gariland-camp')!;
    const campaign = createCampaign(99, 1_000);
    campaign.roster = [persistedDarkKnightCandidate()];
    campaign.formation = [{ unitId: 'k', startIndex: 0 }];
    campaign.progress.current = previousNode.id;
    saves.loaded = campaign;

    const game = new Game({
      scenarioId: 'first-lesson',
      container: {} as HTMLElement,
      uiMount: {} as HTMLElement,
    });

    expect(game.campaign.progress.current).toBe(previousNode.id);
    expect(game.state.campaignNodeId).toBeUndefined();
    expect(saves.written.at(-1)?.progress.current).toBe(previousNode.id);
  });

  it('plays signature presentation from the event stream without changing state or event bytes', async () => {
    routing.scenario = peacefulFirstBattle();
    const game = newGame();
    const actor = [...game.state.units.values()][0]!;
    const event: BattleEvent = {
      kind: 'cast-fire',
      unit: actor.id,
      ability: 'flare',
      target: { ...actor.pos },
    };
    const stateBefore = battleStateBytes(game.state);
    const eventsBefore = JSON.stringify([event]);

    await game.play([event]);

    expect(battleStateBytes(game.state)).toBe(stateBefore);
    expect(JSON.stringify([event])).toBe(eventsBefore);
    expect(game.camera.cinematic).toHaveBeenCalledOnce();
    expect(game.camera.endCinematic).toHaveBeenCalledOnce();
    expect(game.vfx.play).toHaveBeenCalledWith(
      'black/flare',
      expect.objectContaining({ power: expect.any(Number) }),
    );
  });

  it('records a victory in the first battle without assigning BattleState fields', () => {
    routing.scenario = peacefulFirstLesson();
    const game = newGameAtFirstNode();
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

  it('routes a real player attack victory into the outcome and result screens', async () => {
    routing.scenario = adjacentFinisherScenario();
    const campaign = createCampaign(99, 1_000);
    campaign.roster = [{
      ...persistedDarkKnightCandidate(),
      id: 'p-finisher',
      name: 'Finisher',
      equipment: { rightHand: 'defender' },
      support: 'concentrate',
      raw: { hp: 400, mp: 90, pa: 99, ma: 10, spd: 9 },
    }];
    campaign.formation = [{ unitId: 'p-finisher', startIndex: 0 }];
    saves.loaded = campaign;
    const game = new Game({
      scenarioId: 'ui-victory-regression',
      container: {} as HTMLElement,
      uiMount: {} as HTMLElement,
    });

    await game.beginTurn();
    expect(game.state.phase).toBe('awaiting-command');
    expect(game.state.units.get(game.state.active!)?.team).toBe('player');

    uiCapture.intentHandler?.({ kind: 'command', id: 'attack' });
    const enemy = [...game.state.units.values()].find((unit) => unit.team === 'enemy')!;
    await (game as unknown as { onClick(tile: typeof enemy.pos): Promise<void> })
      .onClick(enemy.pos);
    await Promise.resolve();
    await Promise.resolve();

    expect(game.state.phase).toBe('victory');
    expect(uiCapture.outcome?.outcome).toBe('victory');
    expect(uiCapture.result?.outcome).toBe('victory');
  });

  // REMOVED: 'opens the result flow when a player action wins the battle'.
  //
  // It asserted something worth asserting -- that a PLAYER-caused KO routes into
  // the result flow -- but it could not actually get there. It reached past the
  // public input path to assign `game.mode` directly, including a hand-built
  // `legal` set, and `onClick` does not consult `legal` at all: it gates on
  // `canAimAt`. So the setup constructed a state the real code path never
  // produces, and the battle never ended.
  //
  // Three separate premises in it were false: the enemy sat six tiles from a
  // range-1 attack, a level-99 hit does not one-shot a level-1 unit's 100 HP,
  // and the forced `legal` entry conferred no legality on the rules engine.
  // Patching each in turn still left it red, which is the tell that the test
  // was mocking its way around the thing it claimed to verify.
  //
  // Victory routing itself IS covered, through the public surface, by the
  // `onBattleOver` -> `result-dismiss` test below. Rewrite this one against
  // that surface -- drive a real command through `submit` -- rather than
  // restoring the version that poked at private fields.

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
    routing.scenario = peacefulFirstLesson();
    const game = newGameAtFirstNode();

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

  it('clears the battle scene route before a world-map refresh', () => {
    const currentUrl = new URL(
      'https://example.test/?scene=first-lesson&node=battle-open',
    );
    const replaceState = vi.fn(
      (_state: unknown, _unused: string, next: string | URL | null | undefined) => {
        if (next !== null && next !== undefined) {
          currentUrl.href = new URL(String(next), currentUrl).href;
        }
      },
    );
    vi.stubGlobal('window', {
      location: {
        get href() { return currentUrl.href; },
        get pathname() { return currentUrl.pathname; },
        get search() { return currentUrl.search; },
      },
      history: { replaceState },
    });
    routing.scenario = peacefulFirstBattle();
    const game = newGame();

    advance(game.state);
    (game as unknown as { onBattleOver(): void }).onBattleOver();
    uiCapture.intentHandler?.({ kind: 'result-dismiss' });

    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(currentUrl.search).toBe('');
    expect(resolveBootRoute(currentUrl.search)).toEqual({ kind: 'title' });
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

  it('does not overwrite the durable campaign after a live diagnostic scene ends', async () => {
    const durable = createCampaign(99, 1_000);
    durable.roster = [persistedDarkKnightCandidate()];
    durable.formation = [{ unitId: 'k', startIndex: 0 }];
    durable.progress.current = WORLD_NODES[0]!.id;
    saves.loaded = durable;

    const game = new Game({
      scenarioId: 'terrain-only',
      container: {} as HTMLElement,
      uiMount: {} as HTMLElement,
    });
    await game.startBattle();

    expect(game.state.phase).toBe('defeat');
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
