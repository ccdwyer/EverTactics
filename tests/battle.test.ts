import { beforeEach, describe, expect, it } from 'vitest';

import {
  IllegalCommandError,
  advance,
  applyCommand,
  evaluateObjective,
  getPendingCharges,
} from '../src/core/battle';
import {
  CT_COST_ACT,
  CT_COST_MOVE,
  CT_COST_WAIT,
  CT_THRESHOLD,
  canAccumulateCt,
  ctSpeed,
  hasStatus,
} from '../src/core/ct';
import { createBattlefield } from '../src/core/grid';
import { createRng } from '../src/core/rng';
import { applyStatus } from '../src/core/combat/status';
import {
  createCampaign,
  deserialize,
  serialize,
  unitToPersisted,
} from '../src/core/campaign';
import {
  clearContent,
  createUnit,
  deriveStats,
  registerAbilities,
  registerItems,
  registerJobs,
} from '../src/core/unit';
import type {
  Ability,
  BattleEvent,
  BattleState,
  Battlefield,
  Command,
  Item,
  Job,
  Objective,
  Tile,
  Unit,
  UnitId,
} from '../src/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Test content — a tiny, fully deterministic slice of the game's data
// ─────────────────────────────────────────────────────────────────────────────

function job(over: Partial<Job> & Pick<Job, 'id' | 'name'>): Job {
  return {
    origin: 'fft',
    blurb: '',
    description: '',
    sprite: { male: 'test_male', female: 'test_female' },
    move: 4,
    jump: 3,
    cEvade: 0,
    growth: { hp: 11, mp: 15, pa: 60, ma: 50, spd: 100 },
    mult: { hp: 100, mp: 100, pa: 100, ma: 100, spd: 100 },
    requires: [],
    actionSet: 'test',
    learnable: [],
    equip: [],
    innate: [],
    ...over,
  };
}

function ability(over: Partial<Ability> & Pick<Ability, 'id' | 'name'>): Ability {
  return {
    set: 'test',
    slot: 'action',
    description: '',
    mp: 0,
    ct: 0,
    element: 'none',
    range: { range: 1, radius: 0, vertical: 3, los: false },
    formula: 'physical',
    power: 1,
    accuracy: 100,
    vfx: 'none',
    ...over,
  };
}

const JOBS: Job[] = [
  job({ id: 'squire', name: 'Brawler' }),
  // A deliberately fragile, slow target so scripted kills are unambiguous.
  job({ id: 'strawman', name: 'Strawman', move: 3, mult: { hp: 10, mp: 100, pa: 50, ma: 50, spd: 60 } }),
];

const ABILITIES: Ability[] = [
  ability({ id: 'strike', name: 'Strike', power: 4 }),
  ability({
    id: 'cure',
    name: 'Cure',
    formula: 'heal',
    power: 8,
    mp: 4,
    range: { range: 4, radius: 0, vertical: 3, los: false },
  }),
  ability({
    id: 'firebolt',
    name: 'Firebolt',
    formula: 'magical',
    element: 'fire',
    power: 6,
    mp: 6,
    ct: 8,
    range: { range: 5, radius: 1, vertical: 4, los: false },
  }),
  ability({
    id: 'lullaby',
    name: 'Lullaby',
    formula: 'status-only',
    range: { range: 3, radius: 0, vertical: 3, los: false },
    inflicts: [{ status: 'sleep', chance: 100, duration: 60 }],
  }),
  ability({ id: 'guard-up', name: 'Guard Up', slot: 'support' }),
  ability({
    id: 'potion',
    name: 'Potion',
    formula: 'heal',
    power: 30,
    range: { range: 1, radius: 0, vertical: 3, los: false },
  }),
];

const ITEMS: Item[] = [
  { id: 'potion', name: 'Potion', category: 'consumable', description: '', price: 50 },
  { id: 'brick', name: 'Brick', category: 'consumable', description: '', price: 1 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function flatField(width = 8, height = 8): Battlefield {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        height: 0,
        depth: Infinity,
        surface: 'grass',
        slope: 'flat',
        passable: true,
        submerged: false,
      });
    }
  }
  return createBattlefield(width, height, tiles, 'test-flat');
}

interface Setup {
  state: BattleState;
  hero: Unit;
  brute: Unit;
  mook: Unit;
}

/**
 * Hero at (1,1) with the Brute (a fragile, slow enemy) adjacent at (2,1), and a
 * second enemy, the Mook, parked out of reach at (6,6). The Brawler job is faster
 * than the Strawman, so the hero always leads the order.
 */
function setup(
  objective: Objective = { kind: 'defeat-all' },
  seed = 12345,
  opts: { bruteBaseHp?: number } = {},
): Setup {
  const hero = createUnit({ id: 'hero', name: 'Ramza', team: 'player', job: 'squire', level: 10, pos: { x: 1, y: 1, z: 0 }, zodiac: 'aries', brave: 70, faith: 70 });
  const brute = createUnit({
    id: 'brute',
    name: 'Brute',
    team: 'enemy',
    job: 'strawman',
    level: 8,
    pos: { x: 2, y: 1, z: 0 },
    zodiac: 'aries',
    brave: 70,
    faith: 70,
    ...(opts.bruteBaseHp !== undefined ? { base: { hp: opts.bruteBaseHp } } : {}),
  });
  const mook = createUnit({ id: 'mook', name: 'Mook', team: 'enemy', job: 'strawman', level: 8, pos: { x: 6, y: 6, z: 0 }, zodiac: 'aries', brave: 70, faith: 70 });

  const units = new Map<UnitId, Unit>([
    ['hero', hero],
    ['brute', brute],
    ['mook', mook],
  ]);

  const state: BattleState = {
    field: flatField(),
    units,
    order: [],
    phase: 'deploy',
    tick: 0,
    rngState: createRng(seed).state(),
    log: [],
    objective,
  };
  return { state, hero, brute, mook };
}

const kinds = (events: readonly BattleEvent[]): string[] => events.map((e) => e.kind);

/** Run the clock and give whoever comes up a Wait, until `stop` says otherwise. */
function runUntil(state: BattleState, stop: (events: BattleEvent[]) => boolean, limit = 40): BattleEvent[] {
  const all: BattleEvent[] = [];
  for (let i = 0; i < limit; i++) {
    const events = advance(state);
    all.push(...events);
    if (stop(all)) return all;
    if (state.phase === 'victory' || state.phase === 'defeat') return all;
    if (state.active === undefined) break;
    all.push(...applyCommand(state, { kind: 'wait', unit: state.active }));
    if (stop(all)) return all;
  }
  return all;
}

beforeEach(() => {
  clearContent();
  registerJobs(JOBS);
  registerAbilities(ABILITIES);
  registerItems(ITEMS);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('advance()', () => {
  it('runs the clock and hands the turn to the fastest unit', () => {
    const { state, hero } = setup();
    const events = advance(state);

    expect(state.phase).toBe('awaiting-command');
    expect(state.active).toBe('hero');
    expect(hero.ct).toBeGreaterThanOrEqual(CT_THRESHOLD);
    expect(kinds(events)).toContain('turn-order-changed');
    expect(state.order[0]).toBe('hero');
  });

  it('is a no-op while a unit already holds the turn', () => {
    const { state } = setup();
    advance(state);
    const tickBefore = state.tick;
    expect(advance(state)).toEqual([]);
    expect(state.tick).toBe(tickBefore);
  });

  it('resets the turn flags at the start of every turn', () => {
    const { state, hero } = setup();
    advance(state);
    applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 1, y: 2, z: 0 }] });
    applyCommand(state, { kind: 'wait', unit: 'hero' });
    expect(hero.turn.moved).toBe(true);

    runUntil(state, () => state.active === 'hero');
    expect(state.active).toBe('hero');
    expect(hero.turn.moved).toBe(false);
    expect(hero.turn.acted).toBe(false);
    expect(hero.turn.origin).toEqual({ x: 1, y: 2, z: 0 });
  });

  it('skips the turn of a sleeping unit and burns its CT', () => {
    const { state, hero } = setup();
    advance(state);
    applyStatus(hero, 'sleep', { duration: 400 });
    applyCommand(state, { kind: 'wait', unit: 'hero' });

    advance(state);
    expect(state.active).not.toBe('hero');
    expect(hero.ct).toBeLessThan(CT_THRESHOLD);
  });
});

describe('turn economy', () => {
  it('charges 60 to act, 40 to move, 100 for both and 20 for a bare Wait', () => {
    const cases: { commands: (u: UnitId) => Command[]; cost: number }[] = [
      { commands: (u) => [{ kind: 'wait', unit: u }], cost: CT_COST_WAIT },
      {
        commands: (u) => [{ kind: 'move', unit: u, path: [{ x: 1, y: 2, z: 0 }] }, { kind: 'wait', unit: u }],
        cost: CT_COST_MOVE,
      },
      {
        commands: (u) => [
          { kind: 'act', unit: u, ability: 'strike', target: { x: 2, y: 1, z: 0 } },
          { kind: 'wait', unit: u },
        ],
        cost: CT_COST_ACT,
      },
    ];

    for (const testCase of cases) {
      const { state, hero } = setup();
      advance(state);
      const before = hero.ct;
      for (const cmd of testCase.commands(hero.id)) applyCommand(state, cmd);
      expect(hero.ct).toBe(before - testCase.cost);
    }
  });

  it('ends the turn automatically once the unit has both moved and acted', () => {
    const { state, hero } = setup();
    advance(state);
    const before = hero.ct;
    applyCommand(state, {
      kind: 'move',
      unit: 'hero',
      path: [{ x: 1, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }],
    });
    expect(state.active).toBe('hero');
    applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: { x: 2, y: 1, z: 0 } });
    expect(state.active).toBeUndefined();
    expect(state.phase).toBe('tick');
    expect(hero.ct).toBe(before - CT_THRESHOLD);
  });

  it('allows act-then-move, which FFT does too', () => {
    const { state, hero } = setup();
    advance(state);
    applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: { x: 2, y: 1, z: 0 } });
    expect(state.active).toBe('hero');
    applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 1, y: 2, z: 0 }] });
    expect(state.active).toBeUndefined();
    expect(hero.pos).toEqual({ x: 1, y: 2, z: 0 });
  });

  it('sets facing on the way out', () => {
    const { state, hero } = setup();
    advance(state);
    const events = applyCommand(state, { kind: 'face', unit: 'hero', facing: 'N' });
    expect(events[0]).toEqual({ kind: 'faced', unit: 'hero', facing: 'N' });
    const out = applyCommand(state, { kind: 'wait', unit: 'hero' });
    expect(out).toContainEqual({ kind: 'faced', unit: 'hero', facing: 'N' });
    expect(hero.facing).toBe('N');
  });
});

describe('knockdown credit', () => {
  it('attributes a command knockdown and persists the scorer kill count', () => {
    const { state, hero, brute } = setup(
      { kind: 'defeat-all' },
      12345,
      { bruteBaseHp: 1 },
    );
    advance(state);

    const events = applyCommand(state, {
      kind: 'act',
      unit: hero.id,
      ability: 'strike',
      target: { ...brute.pos },
    });

    expect(events).toContainEqual({
      kind: 'knockdown',
      unit: brute.id,
      source: hero.id,
    });
    expect(hero.kills).toBe(1);

    const campaign = createCampaign(12345, 1_000);
    campaign.roster = [unitToPersisted(hero)];
    const restored = deserialize(serialize(campaign));
    expect(restored.roster[0]?.kills).toBe(1);
  });
});

describe('illegal commands', () => {
  it('rejects a command from a unit that does not hold the turn', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'wait', unit: 'brute' })).toThrow(IllegalCommandError);
    expect(() => applyCommand(state, { kind: 'wait', unit: 'brute' })).toThrow(/it is hero's turn/);
  });

  it('rejects any command while the clock is running', () => {
    const { state } = setup();
    expect(() => applyCommand(state, { kind: 'wait', unit: 'hero' })).toThrow(/phase "deploy"/);
  });

  it('rejects moving twice', () => {
    const { state } = setup();
    advance(state);
    applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 1, y: 2, z: 0 }] });
    expect(() => applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 1, y: 3, z: 0 }] })).toThrow(
      /already moved/,
    );
  });

  it('rejects acting twice', () => {
    const { state } = setup();
    advance(state);
    applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: { x: 2, y: 1, z: 0 } });
    expect(() => applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: { x: 2, y: 1, z: 0 } })).toThrow(
      /already acted/,
    );
  });

  it('rejects a path longer than Move', () => {
    const { state, hero } = setup();
    advance(state);
    expect(deriveStats(hero).move).toBe(4);
    const path = [
      { x: 1, y: 2, z: 0 },
      { x: 1, y: 3, z: 0 },
      { x: 1, y: 4, z: 0 },
      { x: 1, y: 5, z: 0 },
      { x: 1, y: 6, z: 0 },
    ];
    expect(() => applyCommand(state, { kind: 'move', unit: 'hero', path })).toThrow(/Move is 4/);
  });

  it('rejects a path that teleports', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 4, y: 4, z: 0 }] })).toThrow(
      /not adjacent/,
    );
  });

  it('rejects a path that leaves the map', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 0, y: 1, z: 0 }, { x: -1, y: 1, z: 0 }] })).toThrow(
      /off the map/,
    );
  });

  it('rejects stopping on an occupied tile', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 2, y: 1, z: 0 }] })).toThrow(
      /can stop/,
    );
  });

  it('rejects an out-of-range ability', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: { x: 6, y: 6, z: 0 } })).toThrow(
      /out of range/,
    );
  });

  it('rejects aiming a single-target ability at empty ground', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: { x: 1, y: 2, z: 0 } })).toThrow(
      /needs a unit/,
    );
  });

  it('rejects an unknown ability and a non-action ability', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'act', unit: 'hero', ability: 'nonsense', target: { x: 3, y: 1, z: 0 } })).toThrow(
      /unknown ability/,
    );
    expect(() => applyCommand(state, { kind: 'act', unit: 'hero', ability: 'guard-up', target: { x: 2, y: 1, z: 0 } })).toThrow(
      /not an action ability/,
    );
  });

  it('rejects casting without the MP', () => {
    const { state, hero } = setup();
    advance(state);
    hero.stats.mp = 0;
    expect(() => applyCommand(state, { kind: 'act', unit: 'hero', ability: 'cure', target: { x: 1, y: 1, z: 0 } })).toThrow(
      /needs 4 MP/,
    );
  });

  it('rejects casting while silenced', () => {
    const { state, hero } = setup();
    advance(state);
    applyStatus(hero, 'silence');
    expect(() => applyCommand(state, { kind: 'act', unit: 'hero', ability: 'cure', target: { x: 1, y: 1, z: 0 } })).toThrow(
      /silenced/,
    );
  });

  it('rejects moving while rooted', () => {
    const { state, hero } = setup();
    advance(state);
    applyStatus(hero, 'rooted');
    expect(() => applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 1, y: 2, z: 0 }] })).toThrow(
      /cannot move/,
    );
  });

  it('rejects an item with no battle effect', () => {
    const { state } = setup();
    advance(state);
    expect(() => applyCommand(state, { kind: 'item', unit: 'hero', item: 'brick', target: { x: 1, y: 1, z: 0 } })).toThrow(
      /cannot be used in battle/,
    );
  });

  it('leaves the state untouched when a command is rejected', () => {
    const { state, hero } = setup();
    advance(state);
    const before = { pos: { ...hero.pos }, ct: hero.ct, tick: state.tick, rng: state.rngState };
    expect(() => applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 5, y: 5, z: 0 }] })).toThrow();
    expect(hero.pos).toEqual(before.pos);
    expect(hero.ct).toBe(before.ct);
    expect(state.tick).toBe(before.tick);
    expect(state.rngState).toBe(before.rng);
    expect(state.active).toBe('hero');
  });
});

describe('movement', () => {
  it('walks the path, updates position and faces the direction of travel', () => {
    const { state, hero } = setup();
    advance(state);
    const events = applyCommand(state, {
      kind: 'move',
      unit: 'hero',
      path: [
        { x: 1, y: 2, z: 0 },
        { x: 1, y: 3, z: 0 },
      ],
    });

    const moved = events.find((e) => e.kind === 'moved');
    expect(moved).toBeDefined();
    expect(moved && moved.kind === 'moved' && moved.path).toEqual([
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 1, y: 3, z: 0 },
    ]);
    expect(hero.pos).toEqual({ x: 1, y: 3, z: 0 });
    expect(hero.facing).toBe('S');
  });

  it('accepts a path that already includes the origin tile, as grid.pathTo returns', () => {
    const { state, hero } = setup();
    advance(state);
    applyCommand(state, {
      kind: 'move',
      unit: 'hero',
      path: [
        { x: 1, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
    });
    expect(hero.pos).toEqual({ x: 0, y: 1, z: 0 });
    expect(hero.facing).toBe('W');
  });
});

describe('abilities', () => {
  it('damages the target, faces it, and pays JP and EXP to the actor', () => {
    const { state, hero, brute } = setup();
    advance(state);
    const hpBefore = brute.stats.hp;

    const events = applyCommand(state, {
      kind: 'act',
      unit: 'hero',
      ability: 'strike',
      target: { x: 2, y: 1, z: 0 },
    });

    expect(hero.facing).toBe('E');
    expect(brute.stats.hp).toBeLessThan(hpBefore);
    expect(kinds(events)).toContain('cast-fire');
    expect(kinds(events)).toContain('damage');

    const jp = events.find((e) => e.kind === 'jp');
    const exp = events.find((e) => e.kind === 'exp');
    expect(jp && jp.kind === 'jp' && jp.amount).toBeGreaterThan(0);
    expect(exp && exp.kind === 'exp' && exp.amount).toBeGreaterThan(0);
    expect(hero.jobs.get('squire')?.totalJp).toBeGreaterThan(0);
  });

  it('aims cast-fire at the tile that was picked, not the caster', () => {
    const { state } = setup();
    advance(state);
    const events = applyCommand(state, {
      kind: 'act',
      unit: 'hero',
      ability: 'strike',
      target: { x: 2, y: 1, z: 0 },
    });
    const fired = events.filter((e) => e.kind === 'cast-fire');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({ kind: 'cast-fire', unit: 'hero', ability: 'strike', target: { x: 2, y: 1, z: 0 } });
  });

  it('spends MP and heals with a supportive ability', () => {
    const { state, hero } = setup();
    advance(state);
    hero.stats.hp = 1;
    const mpBefore = hero.stats.mp;

    const events = applyCommand(state, {
      kind: 'act',
      unit: 'hero',
      ability: 'cure',
      target: { x: 1, y: 1, z: 0 },
    });

    expect(hero.stats.mp).toBe(mpBefore - 4);
    expect(hero.stats.hp).toBeGreaterThan(1);
    expect(kinds(events)).toContain('heal');
  });

  it('inflicts a status through the shared status engine', () => {
    const { state, brute } = setup();
    advance(state);
    applyCommand(state, { kind: 'act', unit: 'hero', ability: 'lullaby', target: { x: 2, y: 1, z: 0 } });
    expect(hasStatus(brute, 'sleep')).toBe(true);
  });

  it('resolves a consumable through the ability pipeline', () => {
    const { state, hero } = setup();
    advance(state);
    hero.stats.hp = 1;
    applyCommand(state, { kind: 'item', unit: 'hero', item: 'potion', target: { x: 1, y: 1, z: 0 } });
    expect(hero.stats.hp).toBeGreaterThan(1);
    expect(hero.turn.acted).toBe(true);
  });

  it('defending applies the stance and ends the turn', () => {
    const { state, hero } = setup();
    advance(state);
    applyCommand(state, { kind: 'defend', unit: 'hero' });
    expect(hasStatus(hero, 'defending')).toBe(true);
    expect(state.active).toBeUndefined();

    // It falls off at the start of the unit's next turn.
    runUntil(state, () => state.active === 'hero');
    expect(hasStatus(hero, 'defending')).toBe(false);
  });
});

describe('charged spells', () => {
  it('ends the turn on cast-start and lands later during advance()', () => {
    const { state, hero, brute } = setup();
    advance(state);
    const hpBefore = brute.stats.hp;

    const started = applyCommand(state, {
      kind: 'act',
      unit: 'hero',
      ability: 'firebolt',
      target: { x: 2, y: 1, z: 0 },
    });

    expect(kinds(started)).toContain('cast-start');
    expect(kinds(started)).not.toContain('cast-fire');
    expect(hasStatus(hero, 'charging')).toBe(true);
    expect(getPendingCharges(state)).toHaveLength(1);
    expect(state.active).toBeUndefined();
    expect(brute.stats.hp).toBe(hpBefore);

    const events = runUntil(state, (all) => all.some((e) => e.kind === 'cast-fire'));
    expect(kinds(events)).toContain('cast-fire');
    expect(brute.stats.hp).toBeLessThan(hpBefore);
    expect(hasStatus(hero, 'charging')).toBe(false);
    expect(getPendingCharges(state)).toHaveLength(0);
  });

  it('freezes the caster\'s CT while the charge runs, so it does not lose a turn', () => {
    const { state, hero } = setup();
    advance(state);
    applyCommand(state, { kind: 'act', unit: 'hero', ability: 'firebolt', target: { x: 2, y: 1, z: 0 } });

    expect(canAccumulateCt(hero)).toBe(false);
    expect(ctSpeed(hero, deriveStats(hero).spd)).toBe(0);
    expect(state.order).not.toContain('hero');

    runUntil(state, (all) => all.some((e) => e.kind === 'cast-fire'));
    expect(canAccumulateCt(hero)).toBe(true);
    expect(state.order).toContain('hero');
  });
});

describe('KO, the crystal countdown and the objective', () => {
  it('takes a unit down, then crystallises it after three of its turns', () => {
    // `survive` keeps the battle alive so the countdown can actually run.
    const { state, brute } = setup({ kind: 'survive', turns: 999 });
    advance(state);

    // Strike until the brute falls.
    let guard = 0;
    while (brute.stats.hp > 0 && guard++ < 30) {
      if (state.active === 'hero') {
        applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: brute.pos });
        applyCommand(state, { kind: 'wait', unit: 'hero' });
      } else if (state.active !== undefined) {
        applyCommand(state, { kind: 'wait', unit: state.active });
      }
      advance(state);
    }

    expect(brute.stats.hp).toBe(0);
    expect(hasStatus(brute, 'ko')).toBe(true);
    expect(brute.statuses.find((s) => s.status === 'ko')?.remaining).toBe(3);
    expect(brute.removed).toBe(false);

    const events = runUntil(state, (all) => all.some((e) => e.kind === 'crystal'), 60);
    const crystal = events.find((e) => e.kind === 'crystal');
    expect(crystal).toEqual({ kind: 'crystal', unit: 'brute' });
    expect(brute.removed).toBe(true);
    expect(hasStatus(brute, 'crystal') || hasStatus(brute, 'treasure')).toBe(true);
    expect(state.log.some((l) => l.kind === 'crystal')).toBe(true);
  });

  it('a downed unit still takes turns, but never gets a command', () => {
    const { state, brute } = setup({ kind: 'survive', turns: 999 });
    advance(state);
    brute.stats.hp = 0;
    applyStatus(brute, 'ko', { duration: 3 });

    runUntil(state, () => brute.statuses.find((s) => s.status === 'ko') === undefined, 30);
    expect(state.active).not.toBe('brute');
  });

  it('declares victory once every enemy is down', () => {
    const { state, brute, mook } = setup({ kind: 'defeat-all' });
    advance(state);
    brute.stats.hp = 0;
    applyStatus(brute, 'ko', { duration: 3 });
    mook.stats.hp = 0;
    applyStatus(mook, 'ko', { duration: 3 });

    expect(evaluateObjective(state)).toBe(true);
    expect(state.phase).toBe('victory');
    expect(advance(state)).toEqual([]);
  });

  it('declares defeat when the whole player team is down', () => {
    const { state, hero } = setup({ kind: 'defeat-all' });
    advance(state);
    hero.stats.hp = 0;
    applyStatus(hero, 'ko', { duration: 3 });
    expect(evaluateObjective(state)).toBe(true);
    expect(state.phase).toBe('defeat');
  });

  it('honours defeat-target and loseIfDead', () => {
    const { state, brute } = setup({ kind: 'defeat-target', targetUnit: 'brute' });
    advance(state);
    brute.stats.hp = 0;
    applyStatus(brute, 'ko', { duration: 3 });
    expect(evaluateObjective(state)).toBe(true);
    expect(state.phase).toBe('victory');

    const other = setup({ kind: 'defeat-all', loseIfDead: ['hero'] });
    advance(other.state);
    other.hero.stats.hp = 0;
    applyStatus(other.hero, 'ko', { duration: 3 });
    expect(evaluateObjective(other.state)).toBe(true);
    expect(other.state.phase).toBe('defeat');
  });

  it('wins reach-tile when a player unit stands on the goal', () => {
    const { state } = setup({ kind: 'reach-tile', targetTile: { x: 1, y: 2 } });
    advance(state);
    applyCommand(state, { kind: 'move', unit: 'hero', path: [{ x: 1, y: 2, z: 0 }] });
    expect(state.phase).toBe('victory');
  });
});

describe('status clock', () => {
  it('counts durations down on the CT clock and removes them when they expire', () => {
    const { state, hero } = setup({ kind: 'survive', turns: 999 });
    advance(state);
    applyStatus(hero, 'haste', { duration: 5 });
    applyCommand(state, { kind: 'wait', unit: 'hero' });

    const events = runUntil(state, (all) =>
      all.some((e) => e.kind === 'status-remove' && e.unit === 'hero' && e.status === 'haste'),
    );
    expect(kinds(events)).toContain('status-remove');
    expect(hasStatus(hero, 'haste')).toBe(false);
  });

  it('applies poison once per turn, not once per tick', () => {
    const { state, hero } = setup({ kind: 'survive', turns: 999 });
    advance(state);
    const maxHp = deriveStats(hero).maxHp;
    hero.stats.hp = maxHp;
    applyStatus(hero, 'poison', { duration: 2000 });
    applyCommand(state, { kind: 'wait', unit: 'hero' });

    runUntil(state, () => state.active === 'hero');
    expect(hero.stats.hp).toBe(maxHp - Math.max(1, Math.floor(maxHp / 8)));
  });

  it('regenerates once per turn', () => {
    const { state, hero } = setup({ kind: 'survive', turns: 999 });
    advance(state);
    const maxHp = deriveStats(hero).maxHp;
    hero.stats.hp = 1;
    applyStatus(hero, 'regen', { duration: 2000 });
    applyCommand(state, { kind: 'wait', unit: 'hero' });

    runUntil(state, () => state.active === 'hero');
    expect(hero.stats.hp).toBe(1 + Math.max(1, Math.floor(maxHp / 8)));
  });
});

describe('determinism', () => {
  /** Play the same short scripted battle and capture everything observable. */
  function play(seed: number) {
    const { state } = setup({ kind: 'survive', turns: 999 }, seed);
    const events: BattleEvent[] = [];

    events.push(...advance(state));
    for (let turn = 0; turn < 12; turn++) {
      if (state.phase === 'victory' || state.phase === 'defeat') break;
      const active = state.active;
      if (active === undefined) break;
      const unit = state.units.get(active)!;

      const brute = state.units.get('brute')!;
      const bruteStanding = !brute.removed;

      if (active === 'hero' && bruteStanding) {
        events.push(...applyCommand(state, { kind: 'act', unit: 'hero', ability: 'strike', target: { x: 2, y: 1, z: 0 } }));
        // Shuffle between the two tiles that flank the brute, so every turn is a
        // full move-and-act and the path is always legal from wherever we are.
        const path = unit.pos.y === 1
          ? [{ x: 1, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }]
          : [{ x: 1, y: 2, z: 0 }, { x: 1, y: 1, z: 0 }];
        events.push(...applyCommand(state, { kind: 'move', unit: 'hero', path }));
      } else if (active === 'hero') {
        events.push(...applyCommand(state, { kind: 'defend', unit: 'hero' }));
      } else if (active === 'brute') {
        const hero = state.units.get('hero')!;
        events.push(...applyCommand(state, { kind: 'act', unit: 'brute', ability: 'strike', target: { ...hero.pos } }));
        events.push(...applyCommand(state, { kind: 'wait', unit: 'brute' }));
      } else {
        events.push(...applyCommand(state, { kind: 'defend', unit: active }));
      }
      events.push(...advance(state));
    }

    const snapshot = [...state.units.values()].map((u) => ({
      id: u.id,
      hp: u.stats.hp,
      mp: u.stats.mp,
      ct: u.ct,
      pos: u.pos,
      facing: u.facing,
      exp: u.exp,
      level: u.level,
      statuses: u.statuses.map((s) => `${s.status}:${s.remaining}`),
    }));

    return {
      events,
      snapshot,
      tick: state.tick,
      rngState: state.rngState,
      order: state.order,
      log: state.log.map((l) => `${l.tick}|${l.kind}|${l.text}`),
    };
  }

  it('replays identically from the same seed and command list', () => {
    const a = play(20260726);
    const b = play(20260726);
    expect(b.events).toEqual(a.events);
    expect(b.snapshot).toEqual(a.snapshot);
    expect(b.log).toEqual(a.log);
    expect(b.tick).toBe(a.tick);
    expect(b.rngState).toBe(a.rngState);
    expect(b.order).toEqual(a.order);
  });

  it('actually diverges on a different seed', () => {
    const a = play(20260726);
    const c = play(999);
    expect(c.rngState).not.toBe(a.rngState);
    expect(JSON.stringify(c.events)).not.toBe(JSON.stringify(a.events));
  });

  it('produced a battle worth replaying, not an empty one', () => {
    const a = play(20260726);
    expect(a.events.length).toBeGreaterThan(20);
    expect(kinds(a.events)).toContain('damage');
    expect(kinds(a.events)).toContain('moved');
  });
});
