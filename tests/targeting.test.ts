/**
 * Tile-targeted vs unit-targeted abilities — UI helpers and charged resolution.
 *
 * Covers the FFT distinction: a tile-aimed charge lands on the panel even if the
 * victim walked away; a unit-aimed charge follows the locked unit.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  advance,
  applyCommand,
  getPendingCharges,
  IllegalCommandError,
} from '../src/core/battle';
import { createBattlefield } from '../src/core/grid';
import { createRng } from '../src/core/rng';
import {
  clearContent,
  createUnit,
  registerAbilities,
  registerJobs,
} from '../src/core/unit';
import type {
  Ability,
  BattleEvent,
  BattleState,
  Battlefield,
  Job,
  Tile,
  Unit,
  UnitId,
  Vec3,
} from '../src/core/types';
import {
  abilityTargetsTiles,
  canAimAt,
  coveredTiles,
  legalTargets,
  primaryTargetAt,
} from '../src/state/targeting';
import { ACTION_ABILITIES } from '../src/core/abilities/sets';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
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
    range: { range: 5, radius: 0, vertical: 3, los: false },
    formula: 'physical',
    power: 4,
    accuracy: 100,
    vfx: 'none',
    ...over,
  };
}

const JOBS: Job[] = [
  job({ id: 'caster', name: 'Caster', mult: { hp: 80, mp: 120, pa: 50, ma: 120, spd: 110 } }),
  job({ id: 'target', name: 'Target', mult: { hp: 40, mp: 50, pa: 50, ma: 50, spd: 40 } }),
];

/** Tile-aimed charged nuke (Fire-like): radius 1, targetsTiles true. */
const FIRE_TILE = ability({
  id: 'fire-tile',
  name: 'Fire Tile',
  formula: 'magical',
  element: 'fire',
  power: 8,
  mp: 4,
  ct: 4,
  range: { range: 5, radius: 1, vertical: 4, los: false },
  targetsTiles: true,
});

/** Unit-aimed charged buff/hex: radius 0, targetsTiles false, tracks victim. */
const HEX_UNIT = ability({
  id: 'hex-unit',
  name: 'Hex Unit',
  formula: 'magical',
  element: 'dark',
  power: 8,
  mp: 4,
  ct: 4,
  range: { range: 5, radius: 0, vertical: 4, los: false },
  targetsTiles: false,
});

/** Instant single-target physical — unit-aimed by default. */
const STRIKE = ability({
  id: 'strike',
  name: 'Strike',
  formula: 'physical',
  power: 4,
  range: { range: 1, radius: 0, vertical: 2, los: false },
  targetsTiles: false,
});

/** Explicit unit lock with a burst, to catch aim-tile vs footprint confusion. */
const HEX_BURST_UNIT = ability({
  id: 'hex-burst-unit',
  name: 'Hex Burst Unit',
  formula: 'magical',
  range: { range: 5, radius: 1, vertical: 4, los: false },
  targetsTiles: false,
});

const ABILITIES: Ability[] = [FIRE_TILE, HEX_UNIT, STRIKE, HEX_BURST_UNIT];

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
  caster: Unit;
  foe: Unit;
  ally: Unit;
}

function setup(seed = 99): Setup {
  const caster = createUnit({
    id: 'caster',
    name: 'Caster',
    team: 'player',
    job: 'caster',
    level: 10,
    pos: { x: 2, y: 2, z: 0 },
    zodiac: 'aries',
    brave: 70,
    faith: 70,
  });
  const foe = createUnit({
    id: 'foe',
    name: 'Foe',
    team: 'enemy',
    job: 'target',
    level: 8,
    pos: { x: 4, y: 2, z: 0 },
    zodiac: 'aries',
    brave: 70,
    faith: 70,
  });
  const ally = createUnit({
    id: 'ally',
    name: 'Ally',
    team: 'player',
    job: 'target',
    level: 8,
    pos: { x: 2, y: 4, z: 0 },
    zodiac: 'aries',
    brave: 70,
    faith: 70,
  });
  // Plenty of MP for charged casts.
  caster.stats.mp = 40;
  caster.stats.maxMp = 40;

  const units = new Map<UnitId, Unit>([
    ['caster', caster],
    ['foe', foe],
    ['ally', ally],
  ]);

  const state: BattleState = {
    field: flatField(),
    units,
    order: [],
    phase: 'deploy',
    tick: 0,
    rngState: createRng(seed).state(),
    log: [],
    objective: { kind: 'defeat-all' },
  };
  return { state, caster, foe, ally };
}

function runUntil(
  state: BattleState,
  pred: (events: BattleEvent[]) => boolean,
  guard = 200,
): BattleEvent[] {
  const all: BattleEvent[] = [];
  let n = 0;
  while (n++ < guard) {
    if (state.active !== undefined) {
      // Auto-wait non-scripted actors so the clock advances.
      applyCommand(state, { kind: 'wait', unit: state.active });
    }
    const batch = advance(state);
    all.push(...batch);
    if (pred(all)) return all;
  }
  throw new Error('runUntil: guard exceeded');
}

function castFire(events: BattleEvent[]): BattleEvent | undefined {
  return events.find((e) => e.kind === 'cast-fire');
}

beforeEach(() => {
  clearContent();
  registerJobs(JOBS);
  registerAbilities(ABILITIES);
});

// ─────────────────────────────────────────────────────────────────────────────
// abilityTargetsTiles / canAimAt
// ─────────────────────────────────────────────────────────────────────────────

describe('abilityTargetsTiles', () => {
  it('honours an explicit targetsTiles flag', () => {
    expect(abilityTargetsTiles(FIRE_TILE)).toBe(true);
    expect(abilityTargetsTiles(HEX_UNIT)).toBe(false);
    expect(abilityTargetsTiles(STRIKE)).toBe(false);
  });

  it('treats radius > 0 as tile-aimed when the flag is absent', () => {
    const splash = ability({
      id: 'splash',
      name: 'Splash',
      range: { range: 4, radius: 1, vertical: 3, los: false },
    });
    expect(abilityTargetsTiles(splash)).toBe(true);
  });

  it('treats radius-0 without a flag as unit-aimed', () => {
    const single = ability({
      id: 'single',
      name: 'Single',
      range: { range: 3, radius: 0, vertical: 3, los: false },
    });
    expect(abilityTargetsTiles(single)).toBe(false);
  });

  it('authors radius-0 Holy and Flare as unit spells while Fire remains tile-aimed', () => {
    const authored = new Map(ACTION_ABILITIES.map((entry) => [entry.id, entry]));
    expect(authored.get('holy')?.targetsTiles).toBe(false);
    expect(authored.get('flare')?.targetsTiles).toBe(false);
    expect(authored.get('fire')?.targetsTiles).toBe(true);
  });
});

describe('canAimAt — tile vs unit modes', () => {
  it('allows an empty tile for tile-targeted abilities', () => {
    const { state, caster } = setup();
    const empty: Vec3 = { x: 5, y: 2, z: 0 };
    expect(canAimAt(state, caster, FIRE_TILE, empty)).toBe(true);
    expect(canAimAt(state, caster, HEX_UNIT, empty)).toBe(false);
  });

  it('requires a living unit for unit-targeted abilities', () => {
    const { state, caster, foe } = setup();
    expect(canAimAt(state, caster, HEX_UNIT, foe.pos)).toBe(true);
    expect(canAimAt(state, caster, STRIKE, { x: 3, y: 2, z: 0 })).toBe(false);
  });

  it('does not accept an empty aim tile just because a unit is inside the footprint', () => {
    const { state, caster, foe } = setup();
    const emptyBesideFoe: Vec3 = { x: foe.pos.x + 1, y: foe.pos.y, z: 0 };
    expect(canAimAt(state, caster, HEX_BURST_UNIT, emptyBesideFoe)).toBe(false);
    expect(canAimAt(state, caster, HEX_BURST_UNIT, foe.pos)).toBe(true);
  });

  it('coveredTiles matches the burst the reducer will use', () => {
    const { state, caster, foe } = setup();
    const covered = coveredTiles(state, caster, FIRE_TILE, foe.pos);
    expect(covered.some((t) => t.x === foe.pos.x && t.y === foe.pos.y)).toBe(true);
    expect(covered.length).toBeGreaterThan(1);
    expect(primaryTargetAt(state, caster, FIRE_TILE, foe.pos)?.id).toBe('foe');
  });

  it('legalTargets lists panels in range for both modes', () => {
    const { state, caster } = setup();
    const fire = legalTargets(state, caster, FIRE_TILE);
    const hex = legalTargets(state, caster, HEX_UNIT);
    expect(fire.keys.has('4,2')).toBe(true);
    expect(hex.keys.has('4,2')).toBe(true);
    // Empty tile is in the legal *range* set; canAimAt is the unit-occupancy gate.
    expect(fire.keys.has('5,2')).toBe(true);
    expect(hex.keys.has('5,2')).toBe(true);
    expect(canAimAt(state, caster, HEX_UNIT, { x: 5, y: 2, z: 0 }, hex)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Charged resolution: tile sticks, unit tracks
// ─────────────────────────────────────────────────────────────────────────────

describe('charged tile-targeted ability', () => {
  it('hits the stored tile after the original victim walks away', () => {
    const { state, caster, foe } = setup();
    advance(state);
    expect(state.active).toBe('caster');

    const aim: Vec3 = { x: foe.pos.x, y: foe.pos.y, z: foe.pos.z };
    applyCommand(state, {
      kind: 'act',
      unit: 'caster',
      ability: 'fire-tile',
      target: aim,
    });

    const pending = getPendingCharges(state);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.targetUnit).toBeUndefined();
    expect(pending[0]!.target).toEqual(aim);

    // Victim flees the aim panel before the charge lands.
    foe.pos = { x: 7, y: 7, z: 0 };
    const hpAtNewTile = foe.stats.hp;

    const events = runUntil(state, (all) => all.some((e) => e.kind === 'cast-fire'));
    const fire = castFire(events);
    expect(fire).toBeDefined();
    if (fire && fire.kind === 'cast-fire') {
      expect(fire.target.x).toBe(aim.x);
      expect(fire.target.y).toBe(aim.y);
    }
    // Foe is no longer on the aim tile, so the blast does not connect.
    expect(foe.stats.hp).toBe(hpAtNewTile);
  });

  it('still connects if a different unit walks onto the aim tile', () => {
    const { state, caster, foe, ally } = setup();
    advance(state);

    const aim: Vec3 = { x: foe.pos.x, y: foe.pos.y, z: foe.pos.z };
    applyCommand(state, {
      kind: 'act',
      unit: 'caster',
      ability: 'fire-tile',
      target: aim,
    });

    // Original foe leaves; ally steps into the blast zone (friendly fire).
    foe.pos = { x: 0, y: 0, z: 0 };
    ally.pos = { ...aim };
    const allyHp = ally.stats.hp;

    runUntil(state, (all) => all.some((e) => e.kind === 'cast-fire'));
    expect(ally.stats.hp).toBeLessThan(allyHp);
  });
});

describe('charged unit-targeted ability', () => {
  it('tracks the locked unit when they move between cast and resolution', () => {
    const { state, caster, foe } = setup();
    advance(state);

    const original: Vec3 = { x: foe.pos.x, y: foe.pos.y, z: foe.pos.z };
    applyCommand(state, {
      kind: 'act',
      unit: 'caster',
      ability: 'hex-unit',
      target: original,
      targetUnit: 'foe',
    });

    const pending = getPendingCharges(state);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.targetUnit).toBe('foe');
    expect(pending[0]!.target).toEqual(original);

    // Victim relocates; the charge must follow them.
    const moved: Vec3 = { x: 6, y: 6, z: 0 };
    foe.pos = { ...moved };
    const hpBefore = foe.stats.hp;

    const events = runUntil(state, (all) => all.some((e) => e.kind === 'cast-fire'));
    const fire = castFire(events);
    expect(fire).toBeDefined();
    if (fire && fire.kind === 'cast-fire') {
      expect(fire.target.x).toBe(moved.x);
      expect(fire.target.y).toBe(moved.y);
    }
    expect(foe.stats.hp).toBeLessThan(hpBefore);
  });

  it('refuses an empty tile at cast time', () => {
    const { state, caster } = setup();
    advance(state);
    expect(() =>
      applyCommand(state, {
        kind: 'act',
        unit: 'caster',
        ability: 'hex-unit',
        target: { x: 5, y: 2, z: 0 },
      }),
    ).toThrow(IllegalCommandError);
  });

  it('rejects a targetUnit that does not occupy the validated target tile', () => {
    const { state, caster, foe, ally } = setup();
    advance(state);

    expect(() =>
      applyCommand(state, {
        kind: 'act',
        unit: caster.id,
        ability: HEX_UNIT.id,
        target: foe.pos,
        targetUnit: ally.id,
      }),
    ).toThrow(/target unit "ally" is not on/);
    expect(getPendingCharges(state)).toHaveLength(0);
    expect(caster.turn.acted).toBe(false);
  });

  it('fizzles when the tracked unit is removed before resolution', () => {
    const { state, caster, foe, ally } = setup();
    // Keep a second enemy so defeat-all does not end the fight when foe leaves.
    ally.team = 'enemy';
    advance(state);

    applyCommand(state, {
      kind: 'act',
      unit: 'caster',
      ability: 'hex-unit',
      target: foe.pos,
      targetUnit: 'foe',
    });

    foe.removed = true;
    const events = runUntil(state, (all) => all.some((e) => e.kind === 'cast-fire'));
    expect(events.some((e) => e.kind === 'damage' && e.unit === 'foe')).toBe(false);
    expect(getPendingCharges(state)).toHaveLength(0);
  });
});
