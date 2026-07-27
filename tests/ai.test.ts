import { describe, expect, it } from 'vitest';

import type {
  Ability,
  AbilityId,
  BattleState,
  Battlefield,
  Command,
  Facing,
  Team,
  Tile,
  Unit,
  UnitId,
  Vec3,
  Zodiac,
} from '../src/core/types';
import {
  BASIC_ATTACK,
  PERSONALITIES,
  createAiWorld,
  decideTurn,
  manhattan,
  planTurn,
  tilesInAoe,
} from '../src/core/ai/index';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a battlefield from an ASCII map. Each row is one `y`, each character is
 * one `x`: a digit is the tile height, `#` is impassable.
 */
function makeField(rows: readonly string[], mapId = 'test'): Battlefield {
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < width; x++) {
      const ch = row[x] ?? '#';
      const passable = ch !== '#';
      tiles.push({
        x,
        y,
        height: passable ? Number.parseInt(ch, 10) : 0,
        depth: Infinity,
        surface: passable ? 'grass' : 'stone',
        slope: 'flat',
        passable,
        submerged: false,
      });
    }
  }
  return {
    width,
    height,
    tiles,
    mapId,
    tileAt(x: number, y: number): Tile | undefined {
      if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
      return tiles[y * width + x];
    },
  };
}

interface UnitOverrides {
  hp?: number;
  maxHp?: number;
  mp?: number;
  pa?: number;
  ma?: number;
  spd?: number;
  move?: number;
  jump?: number;
  facing?: Facing;
  zodiac?: Zodiac;
  job?: string;
  learned?: readonly AbilityId[];
  statuses?: Unit['statuses'];
}

function makeUnit(
  id: UnitId,
  team: Team,
  pos: Vec3,
  over: UnitOverrides = {},
): Unit {
  const maxHp = over.maxHp ?? 200;
  const job = over.job ?? 'squire';
  return {
    id,
    name: id,
    team,
    gender: 'male',
    zodiac: over.zodiac ?? 'aries',
    level: 10,
    exp: 0,
    currentJob: job,
    jobs: new Map([[job, { level: 4, jp: 0, totalJp: 0, learned: new Set(over.learned ?? []) }]]),
    stats: {
      hp: over.hp ?? maxHp,
      maxHp,
      mp: over.mp ?? 60,
      maxMp: 60,
      pa: over.pa ?? 10,
      ma: over.ma ?? 6,
      spd: over.spd ?? 8,
      move: over.move ?? 3,
      jump: over.jump ?? 3,
      brave: 70,
      faith: 70,
    },
    equipment: {},
    pos: { ...pos },
    facing: over.facing ?? 'S',
    ct: 0,
    statuses: over.statuses ?? [],
    turn: { moved: false, acted: false, origin: { ...pos }, originFacing: over.facing ?? 'S' },
    removed: false,
    sprite: { sheet: 'squire_male', palette: team === 'enemy' ? 1 : 0 },
  };
}

function makeState(field: Battlefield, units: readonly Unit[]): BattleState {
  const map = new Map<UnitId, Unit>();
  for (const unit of units) map.set(unit.id, unit);
  return {
    field,
    units: map,
    order: units.map((u) => u.id),
    phase: 'awaiting-command',
    tick: 0,
    rngState: 1,
    log: [],
    objective: { kind: 'defeat-all' },
  };
}

const FIREBALL: Ability = {
  id: 'fireball',
  name: 'Fire',
  set: 'black-magic',
  slot: 'action',
  description: 'A burst of flame.',
  mp: 10,
  ct: 0,
  element: 'fire',
  range: { range: 5, radius: 1, vertical: 4, los: false },
  formula: 'magical',
  power: 4,
  accuracy: 100,
  vfx: 'fire',
};

const SLOW_METEOR: Ability = {
  ...FIREBALL,
  id: 'meteor',
  name: 'Meteor',
  ct: 5,
  mp: 20,
  power: 6,
  range: { range: 6, radius: 1, vertical: 6, los: false },
};

function actOf(commands: readonly Command[]): Extract<Command, { kind: 'act' }> | undefined {
  for (const c of commands) if (c.kind === 'act') return c;
  return undefined;
}

function moveOf(commands: readonly Command[]): Extract<Command, { kind: 'move' }> | undefined {
  for (const c of commands) if (c.kind === 'move') return c;
  return undefined;
}

function finalPos(commands: readonly Command[], fallback: Vec3): Vec3 {
  const move = moveOf(commands);
  if (move === undefined) return fallback;
  return move.path[move.path.length - 1] ?? fallback;
}

const OPEN_9 = [
  '000000000',
  '000000000',
  '000000000',
  '000000000',
  '000000000',
  '000000000',
  '000000000',
  '000000000',
  '000000000',
];

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('decideTurn — lethal kills', () => {
  it('takes the kill when one is available', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 2, y: 2, z: 0 });
    const weak = makeUnit('weak', 'player', { x: 2, y: 1, z: 0 }, { hp: 30 });
    const strong = makeUnit('strong', 'player', { x: 1, y: 2, z: 0 }, { hp: 200 });
    const state = makeState(field, [ai, weak, strong]);

    const commands = decideTurn(state, 'ai', { personality: 'aggressive' });
    const act = actOf(commands);

    expect(act).toBeDefined();
    expect(act?.ability).toBe(BASIC_ATTACK.id);
    expect(act?.targetUnit).toBe('weak');
  });

  it('walks into range to secure a kill rather than poking the nearer healthy target', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, { move: 3 });
    const healthy = makeUnit('healthy', 'player', { x: 3, y: 4, z: 0 }, { hp: 200 });
    const dying = makeUnit('dying', 'player', { x: 4, y: 1, z: 0 }, { hp: 12 });
    const state = makeState(field, [ai, healthy, dying]);

    const commands = decideTurn(state, 'ai', { personality: 'assassin' });
    const act = actOf(commands);

    expect(act?.targetUnit).toBe('dying');
    // It had to close the distance to do it.
    expect(moveOf(commands)).toBeDefined();
  });
});

describe('decideTurn — terrain', () => {
  it('prefers high ground when the two options are otherwise identical', () => {
    // A T-junction: the unit may step left (height 0) or right (height 2).
    // Both end tiles sit exactly 3 tiles from the only hostile, which is walled
    // off, so no attack is possible and the choice is purely positional.
    const field = makeField([
      '###',
      '002',
      '###',
      '#0#',
    ]);
    const ai = makeUnit('ai', 'enemy', { x: 1, y: 1, z: 0 }, { move: 1 });
    const foe = makeUnit('foe', 'player', { x: 1, y: 3, z: 0 }, { move: 3 });
    const state = makeState(field, [ai, foe]);

    const plan = planTurn(state, 'ai', { personality: 'tactician' });
    expect(plan).toBeDefined();
    const chosen = plan?.candidate;
    expect(chosen?.pos.x).toBe(2);
    expect(chosen?.pos.z).toBe(2);
  });

  it('scores the elevated tile above the flat one at equal distance', () => {
    const field = makeField([
      '###',
      '002',
      '###',
      '#0#',
    ]);
    const ai = makeUnit('ai', 'enemy', { x: 1, y: 1, z: 0 }, { move: 1 });
    const foe = makeUnit('foe', 'player', { x: 1, y: 3, z: 0 }, { move: 3 });
    const state = makeState(field, [ai, foe]);

    const plan = planTurn(state, 'ai', { personality: 'defensive' });
    const all = [plan?.candidate, ...(plan?.alternatives ?? [])];
    const high = all.find((c) => c !== undefined && c.pos.x === 2 && c.pos.y === 1);
    const low = all.find((c) => c !== undefined && c.pos.x === 0 && c.pos.y === 1);
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(high!.score).toBeGreaterThan(low!.score);
    expect(high!.terms.height).toBeGreaterThan(low!.terms.height);
  });
});

describe('decideTurn — friendly fire', () => {
  it('places an area spell so it misses its own ally', () => {
    const field = makeField(OPEN_9);
    const caster = makeUnit('caster', 'enemy', { x: 0, y: 2, z: 0 }, {
      job: 'blackmage',
      ma: 14,
      learned: ['fireball'],
      move: 3,
    });
    const friend = makeUnit('friend', 'enemy', { x: 4, y: 1, z: 0 });
    const foeA = makeUnit('foeA', 'player', { x: 4, y: 2, z: 0 });
    const foeB = makeUnit('foeB', 'player', { x: 4, y: 3, z: 0 });
    const state = makeState(field, [caster, friend, foeA, foeB]);

    const abilities = new Map<AbilityId, Ability>([[FIREBALL.id, FIREBALL]]);
    const plan = planTurn(state, 'caster', { personality: 'tactician', abilities });
    const commands = plan?.commands ?? [];
    const act = actOf(commands);

    expect(act?.ability).toBe('fireball');
    const covered = tilesInAoe(field, FIREBALL, plan!.candidate.actFrom ?? plan!.candidate.pos, act!.target);
    const hitsFriend = covered.some((t) => t.x === friend.pos.x && t.y === friend.pos.y);
    const hostilesHit = covered.filter(
      (t) => (t.x === foeA.pos.x && t.y === foeA.pos.y) || (t.x === foeB.pos.x && t.y === foeB.pos.y),
    );
    expect(hitsFriend).toBe(false);
    expect(hostilesHit.length).toBe(2);
    expect(plan!.candidate.terms.friendlyFire).toBe(0);
  });

  it('will not fire at all when every placement would burn an ally worse than it helps', () => {
    const field = makeField(OPEN_9);
    const caster = makeUnit('caster', 'enemy', { x: 0, y: 4, z: 0 }, {
      job: 'blackmage',
      ma: 20,
      learned: ['fireball'],
      move: 0,
    });
    // The lone hostile is completely wrapped in our own people.
    const foe = makeUnit('foe', 'player', { x: 4, y: 4, z: 0 }, { hp: 400, maxHp: 400 });
    const shields = [
      makeUnit('s1', 'enemy', { x: 3, y: 4, z: 0 }, { hp: 40, maxHp: 40 }),
      makeUnit('s2', 'enemy', { x: 5, y: 4, z: 0 }, { hp: 40, maxHp: 40 }),
      makeUnit('s3', 'enemy', { x: 4, y: 3, z: 0 }, { hp: 40, maxHp: 40 }),
      makeUnit('s4', 'enemy', { x: 4, y: 5, z: 0 }, { hp: 40, maxHp: 40 }),
    ];
    const state = makeState(field, [caster, foe, ...shields]);

    const abilities = new Map<AbilityId, Ability>([[FIREBALL.id, FIREBALL]]);
    const commands = decideTurn(state, 'caster', { personality: 'support', abilities });
    expect(actOf(commands)).toBeUndefined();
  });
});

describe('decideTurn — personalities', () => {
  it('a coward at 15% HP runs away from the enemy', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, { hp: 30, maxHp: 200, move: 3 });
    const foe = makeUnit('foe', 'player', { x: 6, y: 4, z: 0 }, { pa: 14 });
    const state = makeState(field, [ai, foe]);

    const commands = decideTurn(state, 'ai', { personality: 'coward' });
    const end = finalPos(commands, ai.pos);

    expect(moveOf(commands)).toBeDefined();
    expect(manhattan(end, foe.pos)).toBeGreaterThan(manhattan(ai.pos, foe.pos));
  });

  it('the same unit as an aggressor closes instead of fleeing', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, { hp: 30, maxHp: 200, move: 3 });
    const foe = makeUnit('foe', 'player', { x: 6, y: 4, z: 0 }, { pa: 14 });
    const state = makeState(field, [ai, foe]);

    const commands = decideTurn(state, 'ai', { personality: 'aggressive' });
    const end = finalPos(commands, ai.pos);

    expect(manhattan(end, foe.pos)).toBeLessThan(manhattan(ai.pos, foe.pos));
    expect(actOf(commands)).toBeDefined();
  });

  it('a support unit heals a wounded ally instead of attacking', () => {
    const field = makeField(OPEN_9);
    const cure: Ability = {
      id: 'cure',
      name: 'Cure',
      set: 'white-magic',
      slot: 'action',
      description: 'Restore HP.',
      mp: 6,
      ct: 0,
      element: 'none',
      range: { range: 4, radius: 0, vertical: 3, los: false },
      formula: 'heal',
      power: 3,
      accuracy: 100,
      vfx: 'cure',
    };
    const healer = makeUnit('healer', 'enemy', { x: 4, y: 4, z: 0 }, {
      job: 'priest', ma: 14, learned: ['cure'],
    });
    const hurt = makeUnit('hurt', 'enemy', { x: 4, y: 5, z: 0 }, { hp: 40, maxHp: 220 });
    const foe = makeUnit('foe', 'player', { x: 4, y: 3, z: 0 });
    const state = makeState(field, [healer, hurt, foe]);

    const abilities = new Map<AbilityId, Ability>([[cure.id, cure]]);
    const commands = decideTurn(state, 'healer', { personality: 'support', abilities });
    const act = actOf(commands);

    expect(act?.ability).toBe('cure');
    expect(act?.targetUnit).toBe('hurt');
  });

  it('an assassin picks the squishy caster over the armoured tank', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, { move: 4 });
    const tank = makeUnit('tank', 'player', { x: 4, y: 3, z: 0 }, { maxHp: 400, hp: 400, pa: 14, ma: 3 });
    const caster = makeUnit('caster', 'player', { x: 4, y: 1, z: 0 }, { maxHp: 90, hp: 90, pa: 4, ma: 16 });
    const state = makeState(field, [ai, tank, caster]);

    const commands = decideTurn(state, 'ai', { personality: 'assassin' });
    expect(actOf(commands)?.targetUnit).toBe('caster');
  });
});

describe('decideTurn — compulsions', () => {
  it('a taunted unit attacks its taunter even when a softer target is adjacent', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 2, y: 2, z: 0 }, {
      statuses: [{ status: 'taunted', remaining: 30, source: 'tank' }],
    });
    const tank = makeUnit('tank', 'player', { x: 2, y: 1, z: 0 }, { maxHp: 400, hp: 400 });
    const squishy = makeUnit('squishy', 'player', { x: 1, y: 2, z: 0 }, { maxHp: 90, hp: 20 });
    const state = makeState(field, [ai, tank, squishy]);

    const commands = decideTurn(state, 'ai', { personality: 'assassin' });
    const act = actOf(commands);

    expect(act).toBeDefined();
    expect(act?.targetUnit).toBe('tank');
  });

  it('without the taunt the same unit takes the kill', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 2, y: 2, z: 0 });
    const tank = makeUnit('tank', 'player', { x: 2, y: 1, z: 0 }, { maxHp: 400, hp: 400 });
    const squishy = makeUnit('squishy', 'player', { x: 1, y: 2, z: 0 }, { maxHp: 90, hp: 20 });
    const state = makeState(field, [ai, tank, squishy]);

    expect(actOf(decideTurn(state, 'ai', { personality: 'assassin' }))?.targetUnit).toBe('squishy');
  });

  it('a berserk unit attacks the nearest body with a plain attack', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, {
      job: 'blackmage',
      learned: ['fireball'],
      statuses: [{ status: 'berserk', remaining: -1 }],
    });
    const near = makeUnit('near', 'player', { x: 4, y: 5, z: 0 });
    const far = makeUnit('far', 'player', { x: 4, y: 1, z: 0 }, { hp: 10 });
    const state = makeState(field, [ai, near, far]);

    const abilities = new Map<AbilityId, Ability>([[FIREBALL.id, FIREBALL]]);
    const act = actOf(decideTurn(state, 'ai', { abilities }));
    expect(act?.ability).toBe(BASIC_ATTACK.id);
    expect(act?.targetUnit).toBe('near');
  });

  it('a disabled unit issues nothing but a wait', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, {
      statuses: [{ status: 'sleep', remaining: 40 }],
    });
    const foe = makeUnit('foe', 'player', { x: 4, y: 5, z: 0 });
    const state = makeState(field, [ai, foe]);

    expect(decideTurn(state, 'ai')).toEqual([{ kind: 'wait', unit: 'ai' }]);
  });
});

describe('decideTurn — charge time', () => {
  it('leads a moving target instead of aiming where it currently stands', () => {
    const field = makeField(OPEN_9);
    const caster = makeUnit('caster', 'enemy', { x: 0, y: 4, z: 0 }, {
      job: 'blackmage', ma: 16, move: 0, learned: ['meteor'],
    });
    // The runner is sprinting straight at the caster, so by the time a 5-CT
    // spell lands it will be two tiles further west than it is now.
    const runner = makeUnit('runner', 'player', { x: 5, y: 4, z: 0 }, { move: 2, spd: 25 });
    const state = makeState(field, [caster, runner]);

    const abilities = new Map<AbilityId, Ability>([[SLOW_METEOR.id, SLOW_METEOR]]);
    const plan = planTurn(state, 'caster', { personality: 'tactician', abilities });
    const act = actOf(plan?.commands ?? []);

    expect(act?.ability).toBe('meteor');
    // Aimed ahead of the runner, on the side it is travelling toward.
    expect(act!.target.x).toBeLessThan(runner.pos.x);
    // And the blast still covers where the runner is predicted to end up.
    const covered = tilesInAoe(field, SLOW_METEOR, plan!.candidate.pos, act!.target);
    expect(covered.some((t) => t.x === 3 && t.y === 4)).toBe(true);
  });

  it('prefers a charged spell against an immobilised target (no whiff risk)', () => {
    const field = makeField(OPEN_9);
    const caster = makeUnit('caster', 'enemy', { x: 0, y: 4, z: 0 }, {
      job: 'blackmage', ma: 16, move: 0, learned: ['meteor'],
    });
    const frozen = makeUnit('frozen', 'player', { x: 4, y: 4, z: 0 }, {
      statuses: [{ status: 'stop', remaining: 60 }],
    });
    const state = makeState(field, [caster, frozen]);

    const abilities = new Map<AbilityId, Ability>([[SLOW_METEOR.id, SLOW_METEOR]]);
    const plan = planTurn(state, 'caster', { personality: 'tactician', abilities });

    expect(plan?.candidate.prediction).toBe(1);
    expect(plan?.candidate.terms.wasteRisk).toBe(0);
  });
});

describe('decideTurn — turn shape', () => {
  it('ends the turn facing the threat rather than showing its back', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, { facing: 'N', move: 0 });
    const foe = makeUnit('foe', 'player', { x: 4, y: 6, z: 0 }, { pa: 16 });
    const state = makeState(field, [ai, foe]);

    const commands = decideTurn(state, 'ai', { personality: 'defensive' });
    const face = commands.find((c) => c.kind === 'face');
    expect(face).toBeDefined();
    expect(face?.kind === 'face' ? face.facing : undefined).toBe('S');
  });

  it('emits commands in a legal order and terminates the turn', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 4, y: 6, z: 0 }, { move: 3 });
    const foe = makeUnit('foe', 'player', { x: 4, y: 3, z: 0 });
    const state = makeState(field, [ai, foe]);

    const commands = decideTurn(state, 'ai', { personality: 'aggressive' });
    expect(commands.length).toBeGreaterThan(0);
    expect(commands[commands.length - 1]?.kind).toBe('wait');
    expect(commands.filter((c) => c.kind === 'move').length).toBeLessThanOrEqual(1);
    expect(commands.filter((c) => c.kind === 'act').length).toBeLessThanOrEqual(1);
    // A move command's path must start on the unit's tile.
    const move = moveOf(commands);
    if (move !== undefined) {
      expect(move.path[0]).toEqual({ x: 4, y: 6, z: 0 });
    }
  });

  it('can strike first and then retreat out of reach', () => {
    // A short-range bruiser stands next to us; our unit outranges it. The best
    // play is to hit and then walk away, which requires act-then-move ordering.
    const field = makeField(OPEN_9);
    const sniper = makeUnit('sniper', 'enemy', { x: 4, y: 4, z: 0 }, {
      job: 'archer', move: 4, hp: 60, maxHp: 200,
    });
    const brute = makeUnit('brute', 'player', { x: 4, y: 5, z: 0 }, {
      pa: 22, move: 1, maxHp: 400, hp: 400,
    });
    const state = makeState(field, [sniper, brute]);

    const plan = planTurn(state, 'sniper', { personality: 'coward' });
    const commands = plan?.commands ?? [];
    const actIndex = commands.findIndex((c) => c.kind === 'act');
    const moveIndex = commands.findIndex((c) => c.kind === 'move');

    expect(plan?.candidate.actFrom).toBeDefined();
    expect(actIndex).toBeGreaterThanOrEqual(0);
    expect(moveIndex).toBeGreaterThan(actIndex);
    const end = finalPos(commands, sniper.pos);
    expect(manhattan(end, brute.pos)).toBeGreaterThan(1);
  });
});

describe('decideTurn — engineering guarantees', () => {
  it('is deterministic without an RNG', () => {
    const build = (): BattleState => {
      const field = makeField(OPEN_9);
      return makeState(field, [
        makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, { move: 4 }),
        makeUnit('p1', 'player', { x: 6, y: 4, z: 0 }, { hp: 80 }),
        makeUnit('p2', 'player', { x: 2, y: 6, z: 0 }),
        makeUnit('p3', 'player', { x: 7, y: 7, z: 0 }, { hp: 30 }),
      ]);
    };
    const a = decideTurn(build(), 'ai');
    const b = decideTurn(build(), 'ai');
    expect(a).toEqual(b);
  });

  it('never targets a unit outside the chosen ability range', () => {
    const field = makeField(OPEN_9);
    const ai = makeUnit('ai', 'enemy', { x: 0, y: 0, z: 0 }, { move: 2 });
    const foe = makeUnit('foe', 'player', { x: 8, y: 8, z: 0 });
    const state = makeState(field, [ai, foe]);

    const plan = planTurn(state, 'ai', { personality: 'aggressive' });
    const act = actOf(plan?.commands ?? []);
    if (act !== undefined) {
      const from = plan!.candidate.actFrom ?? plan!.candidate.pos;
      expect(manhattan(from, act.target)).toBeLessThanOrEqual(BASIC_ATTACK.range.range);
    }
  });

  it('decides a crowded 20x20 board well inside the frame budget', () => {
    const rows: string[] = [];
    for (let y = 0; y < 20; y++) {
      let row = '';
      for (let x = 0; x < 20; x++) row += String((x + y) % 3);
      rows.push(row);
    }
    const field = makeField(rows);
    const units: Unit[] = [
      makeUnit('ai', 'enemy', { x: 10, y: 10, z: (10 + 10) % 3 }, {
        job: 'blackmage', ma: 18, move: 4, jump: 4, learned: ['fireball', 'meteor'],
      }),
    ];
    for (let i = 0; i < 7; i++) {
      const x = 2 + i * 2;
      const y = 3 + (i % 4);
      units.push(makeUnit(`p${i}`, 'player', { x, y, z: (x + y) % 3 }, { hp: 60 + i * 20 }));
    }
    for (let i = 0; i < 5; i++) {
      const x = 5 + i * 2;
      const y = 15 - (i % 3);
      units.push(makeUnit(`e${i}`, 'enemy', { x, y, z: (x + y) % 3 }));
    }
    const state = makeState(field, units);
    const abilities = new Map<AbilityId, Ability>([
      [FIREBALL.id, FIREBALL],
      [SLOW_METEOR.id, SLOW_METEOR],
    ]);

    const world = createAiWorld({ abilities });
    // Warm up so we time steady-state, not first-call JIT.
    decideTurn(state, 'ai', { world, personality: 'tactician' });
    const start = performance.now();
    const commands = decideTurn(state, 'ai', { world, personality: 'tactician' });
    const elapsed = performance.now() - start;

    expect(commands.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });

  it('exposes a distinct weight vector per archetype', () => {
    const ids = Object.keys(PERSONALITIES);
    const signatures = new Set(ids.map((id) => JSON.stringify(PERSONALITIES[id as keyof typeof PERSONALITIES].weights)));
    expect(signatures.size).toBe(ids.length);
  });
});

describe('decideTurn — archetypes diverge on one board', () => {
  const build = (): BattleState => makeState(makeField(OPEN_9), [
    makeUnit('ai', 'enemy', { x: 4, y: 4, z: 0 }, { hp: 60, maxHp: 200, move: 3 }),
    makeUnit('hurtAlly', 'enemy', { x: 3, y: 5, z: 0 }, { hp: 20, maxHp: 200 }),
    makeUnit('tank', 'player', { x: 4, y: 2, z: 0 }, { maxHp: 400, hp: 400, pa: 16 }),
    makeUnit('mage', 'player', { x: 6, y: 6, z: 0 }, { maxHp: 180, hp: 180, ma: 18, pa: 3 }),
  ]);

  it('a berserk archetype fixates on the nearest body, an assassin on the softest', () => {
    const berserk = actOf(decideTurn(build(), 'ai', { personality: 'berserk' }));
    const assassin = actOf(decideTurn(build(), 'ai', { personality: 'assassin' }));
    expect(berserk?.targetUnit).toBe('tank');   // nearest
    expect(assassin?.targetUnit).toBe('mage');  // softest
  });

  it('a coward disengages from the same board the aggressor commits to', () => {
    const cowardCommands = decideTurn(build(), 'ai', { personality: 'coward' });
    const aggressiveCommands = decideTurn(build(), 'ai', { personality: 'aggressive' });
    const start = { x: 4, y: 4, z: 0 };
    const nearest = (p: Vec3): number =>
      Math.min(manhattan(p, { x: 4, y: 2 }), manhattan(p, { x: 6, y: 6 }));

    expect(actOf(cowardCommands)).toBeUndefined();
    expect(nearest(finalPos(cowardCommands, start))).toBeGreaterThan(nearest(start));
    expect(actOf(aggressiveCommands)).toBeDefined();
    expect(nearest(finalPos(aggressiveCommands, start))).toBeLessThan(nearest(start));
  });

  it('scales to a crowded board with a full spell list inside one frame', () => {
    const rows: string[] = [];
    for (let y = 0; y < 24; y++) {
      let row = '';
      for (let x = 0; x < 24; x++) row += String((x * 7 + y * 3) % 4);
      rows.push(row);
    }
    const field = makeField(rows);
    const abilities = new Map<AbilityId, Ability>();
    const ids: AbilityId[] = [];
    for (let i = 0; i < 16; i++) {
      const id = `spell${i}`;
      ids.push(id);
      abilities.set(id, {
        ...FIREBALL, id, ct: i % 3, mp: 2,
        range: { range: 3 + (i % 4), radius: i % 3, vertical: 6, los: false },
      });
    }
    const units: Unit[] = [
      makeUnit('ai', 'enemy', { x: 12, y: 12, z: (12 * 7 + 12 * 3) % 4 }, {
        job: 'blackmage', ma: 18, move: 5, jump: 6, mp: 200, learned: ids,
      }),
    ];
    let n = 0;
    for (let x = 2; x < 22; x += 3) {
      for (let y = 2; y < 22; y += 6) {
        if (x === 12 && y === 12) continue;
        units.push(makeUnit(`u${n}`, n % 2 === 0 ? 'player' : 'enemy',
          { x, y, z: (x * 7 + y * 3) % 4 }, { hp: 50 + n * 5 }));
        n++;
      }
    }
    const state = makeState(field, units);
    const world = createAiWorld({ abilities });
    decideTurn(state, 'ai', { world, personality: 'tactician' });
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) decideTurn(state, 'ai', { world, personality: 'tactician' });
    const ms = (performance.now() - t0) / 5;
    expect(ms).toBeLessThan(100);
  });
});
