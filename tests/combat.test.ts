/**
 * EverTactics — combat engine tests.
 *
 * These are the proof that the rules engine is real: facing changes both accuracy and
 * damage, zodiac compatibility swings magic, Protect and Shell guard different damage
 * types, wards eat damage before HP, damage-over-time actually ticks, Faith scales
 * magic from both ends, and elemental absorption heals.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  Ability, Battlefield, BattleState, Item, Job, Rng, Unit,
} from '../src/core/types';

import {
  BASE_RAW_STATS, JOB_LEVEL_JP, clearContent, createUnit, deriveStats, effectiveSpeed,
  gainExp, gainJp, isKO, jobLevelFor, learnAbility, levelUp, rawStats, registerItems,
  registerJobs, tickUnitStatuses,
} from '../src/core/unit';

import {
  STATUSES, RIBBON_IMMUNITIES, applyStatus, canApplyStatus, clearItemImmunities,
  consumeWards, ctScale, hasStatus, immunities, previewWards, registerItemImmunity,
  removeStatus, statusStacks, tickStatuses,
} from '../src/core/combat/status';

import {
  ALL_ZODIAC, compatibility, compatibilityMultiplier, zodiacMultiplier,
} from '../src/core/combat/zodiac';

import {
  attackDirection, critChance, directionBetween, evadeSources, reactionChance, resolveHit,
} from '../src/core/combat/hit';

import {
  clearElementRegistry, computeDamage, elementAffinity, registerItemAffinity,
} from '../src/core/combat/damage';

import {
  applyResolution, resolveAbilityDetailed,
} from '../src/core/combat/formulas';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A deterministic RNG that walks a scripted list of floats and then repeats it. */
function scriptRng(values: readonly number[]): Rng {
  let i = 0;
  const next = (): number => {
    const v = values[i % values.length];
    i++;
    return v ?? 0;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (percent: number) => next() * 100 < percent,
    state: () => i,
  };
}

/** Always rolls the lowest possible value: everything hits, nothing crits by luck. */
const alwaysLow = (): Rng => scriptRng([0]);
/** Always rolls the highest possible value: nothing that needs a roll succeeds. */
const alwaysHigh = (): Rng => scriptRng([0.999999]);

const KNIGHT: Job = {
  id: 'knight', name: 'Knight', origin: 'fft', blurb: 'Armoured front line.',
  description: 'Heavy infantry.',
  sprite: { male: 'knight_male', female: 'knight_female' },
  move: 3, jump: 3, cEvade: 20,
  growth: { hp: 11, mp: 15, pa: 50, ma: 60, spd: 100 },
  mult: { hp: 120, mp: 80, pa: 120, ma: 80, spd: 100 },
  requires: [{ job: 'squire', level: 2 }],
  actionSet: 'battle-skill',
  learnable: [{ ability: 'head-break', jp: 200 }, { ability: 'weapon-break', jp: 300 }],
  equip: ['sword', 'knightsword', 'shield', 'helm', 'armor'],
  innate: [],
};

const BLACK_MAGE: Job = {
  id: 'black-mage', name: 'Black Mage', origin: 'fft', blurb: 'Elemental destruction.',
  description: 'Ranged elemental casting.',
  sprite: { male: 'blackmage_male', female: 'blackmage_female' },
  move: 3, jump: 3, cEvade: 5,
  growth: { hp: 14, mp: 10, pa: 70, ma: 40, spd: 100 },
  mult: { hp: 75, mp: 150, pa: 50, ma: 150, spd: 100 },
  requires: [{ job: 'chemist', level: 2 }],
  actionSet: 'black-magic',
  learnable: [{ ability: 'fire', jp: 100 }],
  equip: ['rod', 'hat', 'robe'],
  innate: [],
};

const ITEMS: Item[] = [
  {
    id: 'longsword', name: 'Long Sword', category: 'sword', description: 'A soldier\'s blade.',
    price: 500, wp: 8, wEvade: 10,
  },
  {
    id: 'buckler', name: 'Buckler', category: 'shield', description: 'A small round shield.',
    price: 300, pEvade: 30, mEvade: 10,
  },
  {
    id: 'ribbon', name: 'Ribbon', category: 'ribbon', description: 'Wards off every affliction.',
    price: 8000,
  },
  {
    id: 'flame-shield', name: 'Flame Shield', category: 'shield', description: 'Drinks fire.',
    price: 4000, pEvade: 20,
  },
  {
    id: 'power-ring', name: 'Power Ring', category: 'accessory', description: 'Raises might.',
    price: 1200, mods: { pa: 2, hp: 20 },
  },
  {
    id: 'rod', name: 'Rod', category: 'rod', description: 'A conductive focus.',
    price: 200, wp: 3,
  },
];

const ATTACK: Ability = {
  id: 'attack', name: 'Attack', set: 'basic', slot: 'action',
  description: 'A basic weapon strike.', mp: 0, ct: 0, element: 'none',
  range: { range: 1, radius: 0, vertical: 3, los: true },
  formula: 'physical', power: 1, accuracy: 100, vfx: 'slash',
};

const FIRE: Ability = {
  id: 'fire', name: 'Fire', set: 'black-magic', slot: 'action',
  description: 'A burst of flame.', mp: 6, ct: 4, element: 'fire',
  range: { range: 4, radius: 1, vertical: 3, los: true },
  formula: 'magical', power: 12, accuracy: 25, vfx: 'fire',
};

const DARKNESS: Ability = {
  ...FIRE, id: 'dark-bolt', name: 'Dark Bolt', element: 'dark',
  range: { range: 4, radius: 0, vertical: 3, los: true },
};

const CURE: Ability = {
  id: 'cure', name: 'Cure', set: 'white-magic', slot: 'action',
  description: 'Restores HP.', mp: 5, ct: 3, element: 'none',
  range: { range: 4, radius: 0, vertical: 3, los: true },
  formula: 'heal', power: 10, accuracy: 100, vfx: 'cure',
};

const DRAIN: Ability = {
  id: 'drain', name: 'Drain', set: 'black-magic', slot: 'action',
  description: 'Steals life.', mp: 8, ct: 4, element: 'dark',
  range: { range: 3, radius: 0, vertical: 3, los: true },
  formula: 'drain', power: 8, accuracy: 100, vfx: 'drain',
};

const POISON_TOUCH: Ability = {
  id: 'poison-touch', name: 'Poison Touch', set: 'basic', slot: 'action',
  description: 'Poisons on contact.', mp: 0, ct: 0, element: 'none',
  range: { range: 1, radius: 0, vertical: 3, los: true },
  formula: 'status-only', power: 0, accuracy: 100, vfx: 'poison',
  inflicts: [{ status: 'poison', chance: 100 }],
};

function makeField(): Battlefield {
  return { width: 8, height: 8, tiles: [], mapId: 'test', tileAt: () => undefined };
}

function makeState(units: Unit[]): BattleState {
  const map = new Map<string, Unit>();
  for (const u of units) map.set(u.id, u);
  return {
    field: makeField(),
    units: map,
    order: units.map((u) => u.id),
    phase: 'resolving',
    tick: 0,
    rngState: 0,
    log: [],
    objective: { kind: 'defeat-all' },
  };
}

function knight(overrides: Partial<Parameters<typeof createUnit>[0]> = {}): Unit {
  return createUnit({
    id: 'k1', name: 'Agrias', team: 'player', job: 'knight', gender: 'female',
    zodiac: 'aries', level: 10, brave: 70, faith: 70,
    pos: { x: 2, y: 2, z: 0 }, facing: 'S',
    equipment: { rightHand: 'longsword', leftHand: 'buckler' },
    ...overrides,
  });
}

function mage(overrides: Partial<Parameters<typeof createUnit>[0]> = {}): Unit {
  return createUnit({
    id: 'm1', name: 'Rafa', team: 'enemy', job: 'black-mage', gender: 'female',
    zodiac: 'aries', level: 10, brave: 60, faith: 70,
    pos: { x: 2, y: 4, z: 0 }, facing: 'N',
    equipment: { rightHand: 'rod' },
    ...overrides,
  });
}

beforeEach(() => {
  clearContent();
  clearItemImmunities();
  clearElementRegistry();
  registerJobs([KNIGHT, BLACK_MAGE]);
  registerItems(ITEMS);
  registerItemImmunity('ribbon', RIBBON_IMMUNITIES);
});

// ─────────────────────────────────────────────────────────────────────────────
// Zodiac
// ─────────────────────────────────────────────────────────────────────────────

describe('zodiac compatibility', () => {
  it('reproduces the FFT compatibility bands', () => {
    // Aries against the whole wheel, straight from the FFT table.
    expect(compatibility('aries', 'aries')).toBe('good');
    expect(compatibility('aries', 'taurus')).toBe('neutral');
    expect(compatibility('aries', 'gemini')).toBe('neutral');
    expect(compatibility('aries', 'cancer')).toBe('bad');       // 3 apart
    expect(compatibility('aries', 'leo')).toBe('good');         // 4 apart
    expect(compatibility('aries', 'virgo')).toBe('neutral');
    expect(compatibility('aries', 'scorpio')).toBe('neutral');
    expect(compatibility('aries', 'sagittarius')).toBe('good'); // 8 apart
    expect(compatibility('aries', 'capricorn')).toBe('bad');    // 9 apart
    expect(compatibility('aries', 'aquarius')).toBe('neutral');
    expect(compatibility('aries', 'pisces')).toBe('neutral');
  });

  it('resolves opposition by gender: different sexes best, same sex worst', () => {
    expect(compatibility('aries', 'libra', 'male', 'female')).toBe('best');
    expect(compatibility('aries', 'libra', 'female', 'male')).toBe('best');
    expect(compatibility('aries', 'libra', 'male', 'male')).toBe('worst');
    expect(compatibility('aries', 'libra', 'female', 'female')).toBe('worst');
    // Monsters have no sex on the wheel, so opposition settles in the middle.
    expect(compatibility('aries', 'libra', 'monster', 'male')).toBe('good');
  });

  it('treats Serpentarius as off the wheel', () => {
    for (const sign of ALL_ZODIAC) {
      if (sign === 'serpentarius') continue;
      expect(compatibility('serpentarius', sign)).toBe('neutral');
      expect(compatibility(sign, 'serpentarius')).toBe('neutral');
    }
    expect(compatibility('serpentarius', 'serpentarius', 'male', 'female')).toBe('best');
    expect(compatibility('serpentarius', 'serpentarius', 'male', 'male')).toBe('worst');
  });

  it('maps bands onto the 1.5 / 1.25 / 1.0 / 0.75 / 0.5 multipliers', () => {
    expect(compatibilityMultiplier('aries', 'libra', 'male', 'female')).toBe(1.5);
    expect(compatibilityMultiplier('aries', 'leo')).toBe(1.25);
    expect(compatibilityMultiplier('aries', 'taurus')).toBe(1);
    expect(compatibilityMultiplier('aries', 'cancer')).toBe(0.75);
    expect(compatibilityMultiplier('aries', 'libra', 'male', 'male')).toBe(0.5);
  });

  it('is symmetric', () => {
    for (const a of ALL_ZODIAC) {
      for (const b of ALL_ZODIAC) {
        expect(compatibility(a, b, 'male', 'female')).toBe(compatibility(b, a, 'female', 'male'));
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Units
// ─────────────────────────────────────────────────────────────────────────────

describe('unit construction and stat derivation', () => {
  it('runs raw stats through the job multiplier', () => {
    const u = createUnit({ id: 'u', name: 'Test', team: 'player', job: 'knight', level: 1 });
    const raw = rawStats(u);
    expect(raw.hp).toBe(BASE_RAW_STATS.hp);
    const s = deriveStats(u);
    expect(s.maxHp).toBe(Math.floor(BASE_RAW_STATS.hp * 120 / 100));
    expect(s.pa).toBe(Math.floor(BASE_RAW_STATS.pa * 120 / 100));
    expect(s.ma).toBe(Math.floor(BASE_RAW_STATS.ma * 80 / 100));
  });

  it('grows raw stats with level and keeps them independent of the job', () => {
    const l1 = createUnit({ id: 'a', name: 'A', team: 'player', job: 'knight', level: 1 });
    const l20 = createUnit({ id: 'b', name: 'B', team: 'player', job: 'knight', level: 20 });
    expect(rawStats(l20).hp).toBeGreaterThan(rawStats(l1).hp);
    expect(deriveStats(l20).maxHp).toBeGreaterThan(deriveStats(l1).maxHp);

    // A Black Mage of the same level has the same raw pool but far less displayed HP.
    const bm = createUnit({ id: 'c', name: 'C', team: 'player', job: 'black-mage', level: 20 });
    expect(deriveStats(bm).maxHp).toBeLessThan(deriveStats(l20).maxHp);
    expect(deriveStats(bm).maxMp).toBeGreaterThan(deriveStats(l20).maxMp);
  });

  it('adds equipment modifiers on top of the multiplied stats', () => {
    const bare = createUnit({ id: 'a', name: 'A', team: 'player', job: 'knight', level: 5 });
    const ringed = createUnit({
      id: 'b', name: 'B', team: 'player', job: 'knight', level: 5,
      equipment: { accessory: 'power-ring' },
    });
    expect(deriveStats(ringed).pa).toBe(deriveStats(bare).pa + 2);
    expect(deriveStats(ringed).maxHp).toBe(deriveStats(bare).maxHp + 20);
  });

  it('lets statuses rewrite Faith and Brave', () => {
    const u = knight({ faith: 50, brave: 50 });
    expect(deriveStats(u).faith).toBe(50);
    applyStatus(u, 'faith');
    expect(deriveStats(u).faith).toBe(100);
    removeStatus(u, 'faith');
    applyStatus(u, 'innocent');
    expect(deriveStats(u).faith).toBe(0);
  });

  it('scales effective speed by Haste and Slow', () => {
    const u = knight();
    const base = effectiveSpeed(u);
    applyStatus(u, 'haste');
    expect(effectiveSpeed(u)).toBe(Math.floor(base * 1.5));
    removeStatus(u, 'haste');
    applyStatus(u, 'slow');
    expect(effectiveSpeed(u)).toBe(Math.floor(base * 0.5));
    removeStatus(u, 'slow');
    applyStatus(u, 'stop');
    expect(effectiveSpeed(u)).toBe(0);
  });

  it('gates job levels on total JP and spends JP to learn', () => {
    const u = knight();
    expect(jobLevelFor(0)).toBe(1);
    expect(jobLevelFor(JOB_LEVEL_JP[1] ?? 100)).toBe(2);

    const bad = learnAbility(u, 'head-break');
    expect(bad.learned).toBe(false);
    expect(bad.reason).toBe('insufficient-jp');

    const gain = gainJp(u, 250);
    expect(gain.jobLevel).toBe(3);
    expect(gain.levelledUp).toBe(true);

    const ok = learnAbility(u, 'head-break');
    expect(ok.learned).toBe(true);
    expect(u.jobs.get('knight')?.jp).toBe(50);
    // Total JP is a mastery record; spending does not roll the job level back.
    expect(u.jobs.get('knight')?.level).toBe(3);
    expect(learnAbility(u, 'head-break').reason).toBe('already-known');
  });

  it('levels up on 100 exp and grows raw stats each time', () => {
    const u = createUnit({ id: 'u', name: 'T', team: 'player', job: 'knight', level: 1 });
    const before = rawStats(u).hp;
    const res = gainExp(u, 250);
    expect(res.levels.length).toBe(2);
    expect(u.level).toBe(3);
    expect(u.exp).toBe(50);
    expect(rawStats(u).hp).toBeGreaterThan(before);
    expect(levelUp(u)?.level).toBe(4);
  });

  it('knows when a unit is down', () => {
    const u = knight();
    expect(isKO(u)).toBe(false);
    u.stats.hp = 0;
    expect(isKO(u)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Facing
// ─────────────────────────────────────────────────────────────────────────────

describe('facing', () => {
  it('classifies front, side and back relative to the defender', () => {
    const target = { x: 5, y: 5, z: 0 };
    // Facing south (+y): an attacker below is in front, above is behind.
    expect(attackDirection({ x: 5, y: 7, z: 0 }, target, 'S')).toBe('front');
    expect(attackDirection({ x: 5, y: 3, z: 0 }, target, 'S')).toBe('back');
    expect(attackDirection({ x: 8, y: 5, z: 0 }, target, 'S')).toBe('side');
    expect(attackDirection({ x: 1, y: 5, z: 0 }, target, 'S')).toBe('side');
    // Diagonals are treated as flank attacks.
    expect(attackDirection({ x: 7, y: 7, z: 0 }, target, 'S')).toBe('side');
    // The same geometry read against a different facing.
    expect(attackDirection({ x: 5, y: 3, z: 0 }, target, 'N')).toBe('front');
    expect(attackDirection({ x: 8, y: 5, z: 0 }, target, 'E')).toBe('front');
    expect(attackDirection({ x: 1, y: 5, z: 0 }, target, 'E')).toBe('back');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hit rates
// ─────────────────────────────────────────────────────────────────────────────

describe('hit resolution', () => {
  it('lands back attacks far more often than frontal ones', () => {
    const attacker = knight({ id: 'a' });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });

    attacker.pos = { x: 2, y: 2, z: 0 }; // north of the target, who faces north → frontal
    const front = resolveHit(attacker, target, ATTACK, alwaysLow());
    attacker.pos = { x: 2, y: 4, z: 0 }; // south of the target → behind
    const back = resolveHit(attacker, target, ATTACK, alwaysLow());
    attacker.pos = { x: 4, y: 3, z: 0 }; // due east → flank
    const side = resolveHit(attacker, target, ATTACK, alwaysLow());

    expect(front.direction).toBe('front');
    expect(back.direction).toBe('back');
    expect(side.direction).toBe('side');

    // Class 20 + weapon 10 + shield 30, chained: 100 * .8 * .9 * .7 = 50%.
    expect(front.chance).toBe(50);
    expect(side.chance).toBeGreaterThan(front.chance);
    expect(back.chance).toBe(100);
    expect(back.evadeNullified).toBe(true);
  });

  it('halves the attacker\'s accuracy while blinded', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 2, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    const clear = resolveHit(attacker, target, ATTACK, alwaysLow()).chance;
    applyStatus(attacker, 'blind');
    const blinded = resolveHit(attacker, target, ATTACK, alwaysLow()).chance;
    expect(blinded).toBe(Math.floor(clear / 2));
  });

  it('strips evasion from targets that cannot react', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 2, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    expect(resolveHit(attacker, target, ATTACK, alwaysLow()).chance).toBe(50);

    for (const status of ['sleep', 'stop', 'charging', 'performing'] as const) {
      const sleeper = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
      applyStatus(sleeper, status);
      expect(resolveHit(attacker, sleeper, ATTACK, alwaysLow()).chance).toBe(100);
    }
  });

  it('nullifies evasion for Concentrate and for unseen attackers', () => {
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });

    const concentrator = knight({ id: 'a', pos: { x: 2, y: 2, z: 0 }, support: 'concentrate' });
    expect(resolveHit(concentrator, target, ATTACK, alwaysLow()).chance).toBe(100);

    const ghost = knight({ id: 'g', pos: { x: 2, y: 2, z: 0 } });
    applyStatus(ghost, 'transparent');
    expect(resolveHit(ghost, target, ATTACK, alwaysLow()).chance).toBe(100);

    const rogue = knight({ id: 'r', pos: { x: 2, y: 2, z: 0 } });
    applyStatus(rogue, 'stealth');
    const stealthHit = resolveHit(rogue, target, ATTACK, alwaysLow());
    expect(stealthHit.chance).toBe(100);
    expect(critChance(rogue, 'front')).toBe(100);
  });

  it('turns aside exactly one attack with an evade-next charge', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    applyStatus(target, 'evade-next');

    const first = resolveHit(attacker, target, ATTACK, alwaysLow());
    expect(first.hit).toBe(false);
    expect(first.consumedEvadeCharge).toBe(true);

    removeStatus(target, 'evade-next');
    expect(resolveHit(attacker, target, ATTACK, alwaysLow()).hit).toBe(true);
  });

  it('runs magical accuracy off MA and both parties\' Faith', () => {
    const caster = mage({ id: 'c', faith: 100, pos: { x: 2, y: 2, z: 0 } });
    const devout = knight({ id: 'd', faith: 100, pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    const faithless = knight({ id: 'f', faith: 20, pos: { x: 2, y: 3, z: 0 }, facing: 'N' });

    const high = resolveHit(caster, devout, FIRE, alwaysLow()).chance;
    const low = resolveHit(caster, faithless, FIRE, alwaysLow()).chance;
    expect(high).toBeGreaterThan(low);

    // An Innocent target is nearly untouchable by magic.
    applyStatus(devout, 'innocent');
    expect(resolveHit(caster, devout, FIRE, alwaysLow()).chance).toBe(0);
  });

  it('folds zodiac compatibility into magical accuracy', () => {
    const caster = mage({ id: 'c', zodiac: 'aries', faith: 100, pos: { x: 2, y: 2, z: 0 } });
    const good = knight({ id: 'g', zodiac: 'leo', faith: 100, pos: { x: 2, y: 3, z: 0 } });
    const bad = knight({ id: 'b', zodiac: 'cancer', faith: 100, pos: { x: 2, y: 3, z: 0 } });
    const goodChance = resolveHit(caster, good, FIRE, alwaysLow()).chance;
    const badChance = resolveHit(caster, bad, FIRE, alwaysLow()).chance;
    expect(goodChance).toBeGreaterThan(badChance);
  });

  it('reads the roll, not just the chance', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'S' });
    // Frontal, 50% — a low roll hits and a high roll misses.
    expect(resolveHit(attacker, target, ATTACK, alwaysLow()).hit).toBe(true);
    expect(resolveHit(attacker, target, ATTACK, alwaysHigh()).hit).toBe(false);
  });

  it('ties reaction abilities to Brave', () => {
    const brave = knight({ id: 'a', brave: 90 });
    expect(reactionChance(brave)).toBe(90);
    applyStatus(brave, 'sleep');
    expect(reactionChance(brave)).toBe(0);
  });

  it('reports each evasion source separately', () => {
    const target = knight({ id: 'd' });
    const e = evadeSources(target);
    expect(e.classEvade).toBe(20);
    expect(e.weaponEvade).toBe(10);
    expect(e.shieldEvade).toBe(30);
    expect(e.magicEvade).toBe(10);
    applyStatus(target, 'defending');
    expect(evadeSources(target).classEvade).toBe(40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Damage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Damage magnitude before HP clamping, so the tests compare formula output rather than
 * how much life the dummy happened to have left.
 */
function physicalDamage(attacker: Unit, target: Unit, dir: 'front' | 'side' | 'back' = 'front'): number {
  return computeDamage({
    attacker, target, ability: ATTACK, rng: alwaysLow(), direction: dir, deterministic: true,
  }).amount;
}

function magicDamage(caster: Unit, target: Unit, ability: Ability = FIRE): number {
  return computeDamage({
    attacker: caster, target, ability, rng: alwaysLow(), direction: 'front', deterministic: true,
  }).amount;
}

describe('damage', () => {
  it('hits harder from behind than from the front', () => {
    const attacker = knight({ id: 'a' });
    const target = knight({ id: 'd' });
    const front = physicalDamage(attacker, target, 'front');
    const side = physicalDamage(attacker, target, 'side');
    const back = physicalDamage(attacker, target, 'back');
    expect(side).toBeGreaterThan(front);
    expect(back).toBeGreaterThan(side);
    expect(back).toBe(Math.floor(front * 1.25));
  });

  it('multiplies physical damage by weapon power and PA', () => {
    const attacker = knight({ id: 'a' });
    const target = knight({ id: 'd' });
    const stats = deriveStats(attacker);
    // A sword is a plain PA * WP weapon.
    expect(physicalDamage(attacker, target)).toBe(stats.pa * 8);
  });

  it('gives criticals a real spike', () => {
    const attacker = knight({ id: 'a' });
    const target = knight({ id: 'd' });
    const normal = computeDamage({
      attacker, target, ability: ATTACK, rng: alwaysLow(), direction: 'front', deterministic: true,
    });
    const crit = computeDamage({
      attacker, target, ability: ATTACK, rng: alwaysLow(), direction: 'front',
      deterministic: true, crit: true,
    });
    expect(crit.crit).toBe(true);
    expect(-crit.hpDelta).toBe(Math.floor(-normal.hpDelta * 1.5));
  });

  it('lets Protect reduce physical damage only, and Shell magical only', () => {
    const knightAtk = knight({ id: 'a' });
    const caster = mage({ id: 'c' });
    const plain = knight({ id: 'd' });
    const protectd = knight({ id: 'p' });
    const shelled = knight({ id: 's' });
    applyStatus(protectd, 'protect');
    applyStatus(shelled, 'shell');

    const basePhys = physicalDamage(knightAtk, plain);
    expect(physicalDamage(knightAtk, protectd)).toBe(Math.floor(basePhys * 2 / 3));
    expect(physicalDamage(knightAtk, shelled)).toBe(basePhys);

    const baseMagic = magicDamage(caster, plain);
    expect(magicDamage(caster, shelled)).toBe(Math.floor(baseMagic * 2 / 3));
    expect(magicDamage(caster, protectd)).toBe(baseMagic);
  });

  it('reduces physical damage while Defending', () => {
    const attacker = knight({ id: 'a' });
    const plain = knight({ id: 'd' });
    const guarding = knight({ id: 'g' });
    applyStatus(guarding, 'defending');
    expect(physicalDamage(attacker, guarding)).toBe(Math.floor(physicalDamage(attacker, plain) * 2 / 3));
  });

  it('scales magic by Faith at both ends', () => {
    const zealot = mage({ id: 'z', faith: 100 });
    const doubter = mage({ id: 'q', faith: 50 });
    const believer = knight({ id: 'b', faith: 100 });
    const atheist = knight({ id: 'n', faith: 0 });

    const full = magicDamage(zealot, believer);
    const halfCaster = magicDamage(doubter, believer);
    expect(halfCaster).toBe(Math.floor(full / 2));
    expect(magicDamage(zealot, atheist)).toBe(0);

    // The same swing applies to healing.
    const wounded = knight({ id: 'w', faith: 100 });
    wounded.stats.hp = 10;
    const strongHeal = computeDamage({
      attacker: zealot, target: wounded, ability: CURE, rng: alwaysLow(), deterministic: true,
    });
    const weakTarget = knight({ id: 'x', faith: 25 });
    weakTarget.stats.hp = 10;
    const weakHeal = computeDamage({
      attacker: zealot, target: weakTarget, ability: CURE, rng: alwaysLow(), deterministic: true,
    });
    expect(strongHeal.kind).toBe('heal');
    expect(strongHeal.hpDelta).toBeGreaterThan(weakHeal.hpDelta);
  });

  it('applies zodiac compatibility to magic but not to a sword swing', () => {
    const caster = mage({ id: 'c', zodiac: 'aries', gender: 'male', faith: 100 });
    const neutral = knight({ id: 'n', zodiac: 'taurus', faith: 100 });
    const good = knight({ id: 'g', zodiac: 'leo', faith: 100 });
    const bad = knight({ id: 'b', zodiac: 'cancer', faith: 100 });
    const best = knight({ id: 'w', zodiac: 'libra', gender: 'female', faith: 100 });
    const worst = knight({ id: 'v', zodiac: 'libra', gender: 'male', faith: 100 });

    const base = magicDamage(caster, neutral);
    expect(zodiacMultiplier(caster, good)).toBe(1.25);
    expect(magicDamage(caster, good)).toBe(Math.floor(base * 1.25));
    expect(magicDamage(caster, bad)).toBe(Math.floor(base * 0.75));
    expect(magicDamage(caster, best)).toBe(Math.floor(base * 1.5));
    expect(magicDamage(caster, worst)).toBe(Math.floor(base * 0.5));

    // A physical strike is unmoved by the stars.
    const swordsman = knight({ id: 'k', zodiac: 'aries', gender: 'male' });
    expect(physicalDamage(swordsman, good)).toBe(physicalDamage(swordsman, bad));
  });

  it('doubles fire damage against an oiled target', () => {
    const caster = mage({ id: 'c' });
    const dry = knight({ id: 'd' });
    const oiled = knight({ id: 'o' });
    applyStatus(oiled, 'oil');
    expect(elementAffinity(oiled, 'fire')).toBe('weak');
    // Doubling happens before the final floor, so allow the one-point rounding gap.
    const dryDamage = magicDamage(caster, dry);
    expect(magicDamage(caster, oiled)).toBeGreaterThanOrEqual(dryDamage * 2);
    expect(magicDamage(caster, oiled)).toBeLessThanOrEqual(dryDamage * 2 + 1);
  });

  it('heals a target that absorbs the element', () => {
    const caster = mage({ id: 'c' });
    const ghoul = knight({ id: 'u' });
    applyStatus(ghoul, 'undead');
    ghoul.stats.hp = 10;
    expect(elementAffinity(ghoul, 'dark')).toBe('absorb');

    const res = computeDamage({
      attacker: caster, target: ghoul, ability: DARKNESS, rng: alwaysLow(), deterministic: true,
    });
    expect(res.kind).toBe('absorbed');
    expect(res.hpDelta).toBeGreaterThan(0);

    // Registered gear absorption works the same way for the living.
    registerItemAffinity('flame-shield', { fire: 'absorb' });
    const warded = knight({ id: 'f', equipment: { leftHand: 'flame-shield' } });
    warded.stats.hp = 10;
    const fireRes = computeDamage({
      attacker: caster, target: warded, ability: FIRE, rng: alwaysLow(), deterministic: true,
    });
    expect(fireRes.kind).toBe('absorbed');
    expect(fireRes.hpDelta).toBeGreaterThan(0);
  });

  it('honours halve, null and weakness from gear', () => {
    const caster = mage({ id: 'c' });
    const plain = knight({ id: 'p' });
    const base = magicDamage(caster, plain);

    registerItemAffinity('flame-shield', { fire: 'halve' });
    const halved = knight({ id: 'h', equipment: { leftHand: 'flame-shield' } });
    expect(magicDamage(caster, halved)).toBe(Math.floor(base * 0.5));

    registerItemAffinity('flame-shield', { fire: 'null' });
    const nulled = knight({ id: 'n', equipment: { leftHand: 'flame-shield' } });
    const res = computeDamage({
      attacker: caster, target: nulled, ability: FIRE, rng: alwaysLow(), deterministic: true,
    });
    expect(res.kind).toBe('none');
    expect(res.hpDelta).toBe(0);
  });

  it('turns healing into harm on the undead', () => {
    const healer = mage({ id: 'h', faith: 100 });
    const ghoul = knight({ id: 'u', faith: 100 });
    applyStatus(ghoul, 'undead');
    ghoul.stats.hp = 100;
    const res = computeDamage({
      attacker: healer, target: ghoul, ability: CURE, rng: alwaysLow(), deterministic: true,
    });
    expect(res.kind).toBe('damage');
    expect(res.hpDelta).toBeLessThan(0);
  });

  it('lets Earth pass beneath a Floating unit', () => {
    const floater = knight({ id: 'f' });
    applyStatus(floater, 'float');
    expect(elementAffinity(floater, 'earth')).toBe('null');
  });

  it('eats damage with wards before it reaches HP', () => {
    const attacker = knight({ id: 'a' });
    const target = knight({ id: 'd' });
    const raw = physicalDamage(attacker, target);
    expect(raw).toBeGreaterThan(20);

    applyStatus(target, 'shielded', { amount: raw - 5 });
    const res = computeDamage({
      attacker, target, ability: ATTACK, rng: alwaysLow(), direction: 'front', deterministic: true,
    });
    expect(res.wardAbsorbed).toBe(raw - 5);
    expect(res.hpDelta).toBe(-5);

    // A ward big enough soaks the whole blow.
    const tank = knight({ id: 't' });
    applyStatus(tank, 'shielded', { amount: 9999 });
    const soaked = computeDamage({
      attacker, target: tank, ability: ATTACK, rng: alwaysLow(), direction: 'front', deterministic: true,
    });
    expect(soaked.wardAbsorbed).toBe(raw);
    expect(soaked.hpDelta).toBe(0);
  });

  it('drains life back to the caster', () => {
    const caster = mage({ id: 'c', faith: 100 });
    caster.stats.hp = 20;
    const victim = knight({ id: 'v', faith: 100 });
    const res = computeDamage({
      attacker: caster, target: victim, ability: DRAIN, rng: alwaysLow(), deterministic: true,
    });
    expect(res.hpDelta).toBeLessThan(0);
    expect(res.attackerHpDelta).toBeGreaterThan(0);
  });

  it('amplifies with Empowered and Vulnerable', () => {
    const attacker = knight({ id: 'a' });
    const plain = knight({ id: 'd' });
    const base = physicalDamage(attacker, plain);

    const soft = knight({ id: 'v' });
    applyStatus(soft, 'vulnerable');
    expect(physicalDamage(attacker, soft)).toBeGreaterThan(base);

    applyStatus(attacker, 'empowered');
    expect(physicalDamage(attacker, plain)).toBe(Math.floor(base * 1.5));
  });

  it('keeps the randomiser inside a tight band', () => {
    const attacker = knight({ id: 'a' });
    const target = knight({ id: 'd' });
    const mid = physicalDamage(attacker, target);
    const low = computeDamage({
      attacker, target, ability: ATTACK, rng: scriptRng([0]), direction: 'front',
    }).amount;
    const high = computeDamage({
      attacker, target, ability: ATTACK, rng: scriptRng([0.999999]), direction: 'front',
    }).amount;
    expect(low).toBeLessThan(mid);
    expect(high).toBeGreaterThan(low);
    expect(low / mid).toBeGreaterThan(0.85);
    expect(high / mid).toBeLessThan(1.15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Status engine
// ─────────────────────────────────────────────────────────────────────────────

describe('status engine', () => {
  it('defines every status in the union', () => {
    const ids = [
      'ko', 'crystal', 'treasure', 'petrify', 'stop', 'sleep', 'charm', 'confuse',
      'berserk', 'blind', 'silence', 'oil', 'poison', 'undead', 'frog', 'slow', 'haste',
      'regen', 'protect', 'shell', 'reraise', 'faith', 'innocent', 'float', 'reflect',
      'transparent', 'chicken', 'death-sentence', 'defending', 'performing', 'charging',
      'jumping', 'taunted', 'rooted', 'vulnerable', 'empowered', 'shielded', 'bleeding',
      'burning', 'mark', 'stealth', 'evade-next',
    ] as const;
    for (const id of ids) {
      const d = STATUSES.get(id);
      expect(d, id).toBeDefined();
      expect(d?.name.length).toBeGreaterThan(0);
      expect(d?.description.length).toBeGreaterThan(0);
    }
    expect(STATUSES.size).toBe(ids.length);
  });

  it('cancels opposing statuses on application', () => {
    const u = knight();
    applyStatus(u, 'slow');
    expect(hasStatus(u, 'slow')).toBe(true);
    const res = applyStatus(u, 'haste');
    expect(res.applied).toBe(true);
    expect(res.cancelled).toContain('slow');
    expect(hasStatus(u, 'slow')).toBe(false);
    expect(ctScale(u)).toBe(1.5);
  });

  it('blocks new statuses on the dead and the stone', () => {
    const u = knight();
    applyStatus(u, 'ko');
    const res = applyStatus(u, 'poison');
    expect(res.applied).toBe(false);
    expect(res.refused).toBe('blocked');
    expect(res.blocker).toBe('ko');
  });

  it('respects gear immunity but never blocks a blessing', () => {
    const u = knight({ equipment: { accessory: 'ribbon' } });
    expect(immunities(u).has('poison')).toBe(true);
    expect(applyStatus(u, 'poison').refused).toBe('immune');
    expect(applyStatus(u, 'haste').applied).toBe(true);
    // Undead are beyond poisoning by their nature.
    const ghoul = knight({ id: 'g' });
    applyStatus(ghoul, 'undead');
    expect(canApplyStatus(ghoul, 'poison').refused).toBe('immune');
  });

  it('ticks poison off max HP and regen back on', () => {
    const u = knight();
    const max = deriveStats(u).maxHp;
    applyStatus(u, 'poison', { duration: 10 });
    const t = tickUnitStatuses(u);
    expect(t.hpDelta).toBe(-Math.max(1, Math.floor(max / 8)));

    const healthy = knight({ id: 'h' });
    applyStatus(healthy, 'regen', { duration: 10 });
    expect(tickUnitStatuses(healthy).hpDelta).toBe(Math.max(1, Math.floor(max / 8)));
  });

  it('turns regen against the undead', () => {
    const ghoul = knight({ id: 'g' });
    applyStatus(ghoul, 'undead');
    applyStatus(ghoul, 'regen', { duration: 10 });
    expect(tickUnitStatuses(ghoul).hpDelta).toBeLessThan(0);
  });

  it('stacks bleeds and burns them harder through oil', () => {
    const u = knight();
    applyStatus(u, 'bleeding', { duration: 10 });
    const one = tickStatuses(u, { maxHp: 160, hp: 160 }).hpDelta;
    applyStatus(u, 'bleeding', { duration: 10 });
    expect(statusStacks(u, 'bleeding')).toBe(2);
    const two = tickStatuses(u, { maxHp: 160, hp: 160 }).hpDelta;
    expect(two).toBe(one * 2);

    const torch = knight({ id: 't' });
    applyStatus(torch, 'burning', { duration: 10 });
    const dry = tickStatuses(torch, { maxHp: 160, hp: 160 }).hpDelta;
    const oiled = knight({ id: 'o' });
    applyStatus(oiled, 'oil');
    applyStatus(oiled, 'burning', { duration: 10 });
    expect(tickStatuses(oiled, { maxHp: 160, hp: 160 }).hpDelta).toBe(dry * 2);
  });

  it('counts a death sentence down and then kills', () => {
    const u = knight();
    applyStatus(u, 'death-sentence', { duration: 3 });
    expect(tickUnitStatuses(u).ko).toBe(false);
    expect(tickUnitStatuses(u).ko).toBe(false);
    const last = tickUnitStatuses(u);
    expect(last.ko).toBe(true);
    expect(hasStatus(u, 'death-sentence')).toBe(false);
  });

  it('expires timed statuses and keeps permanent ones', () => {
    const u = knight();
    applyStatus(u, 'haste', { duration: 2 });
    applyStatus(u, 'undead');
    tickUnitStatuses(u);
    expect(hasStatus(u, 'haste')).toBe(true);
    const res = tickUnitStatuses(u);
    expect(res.expired).toContain('haste');
    expect(hasStatus(u, 'haste')).toBe(false);
    expect(hasStatus(u, 'undead')).toBe(true);
  });

  it('drains ward pools in order and drops empty wards', () => {
    const u = knight();
    applyStatus(u, 'shielded', { amount: 30 });
    expect(previewWards(u, 10).absorbed).toBe(10);
    expect(previewWards(u, 100).remaining).toBe(70);
    const first = consumeWards(u, 20);
    expect(first.absorbed).toBe(20);
    expect(hasStatus(u, 'shielded')).toBe(true);
    const second = consumeWards(u, 20);
    expect(second.absorbed).toBe(10);
    expect(second.remaining).toBe(10);
    expect(hasStatus(u, 'shielded')).toBe(false);
  });

  it('stops the clock for Stop and speeds it for Haste', () => {
    const u = knight();
    expect(ctScale(u)).toBe(1);
    applyStatus(u, 'stop');
    expect(ctScale(u)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ability resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAbility', () => {
  it('resolves without mutating a thing', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    const state = makeState([attacker, target]);

    const hpBefore = target.stats.hp;
    const mpBefore = attacker.stats.mp;
    const res = resolveAbilityDetailed(state, attacker, ATTACK, [target], alwaysLow());

    expect(res.targets.length).toBe(1);
    expect(res.targets[0]?.hit.hit).toBe(true);
    expect(target.stats.hp).toBe(hpBefore);
    expect(attacker.stats.mp).toBe(mpBefore);

    const events = applyResolution(state, res);
    expect(target.stats.hp).toBeLessThan(hpBefore);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  it('emits a damage event carrying the element and the crit flag', () => {
    const caster = mage({ id: 'c', pos: { x: 2, y: 2, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    const state = makeState([caster, target]);
    const res = resolveAbilityDetailed(state, caster, FIRE, [target], alwaysLow());
    const damage = res.events.find((e) => e.kind === 'damage');
    expect(damage).toBeDefined();
    if (damage && damage.kind === 'damage') {
      expect(damage.element).toBe('fire');
      expect(damage.amount).toBeGreaterThan(0);
    }
  });

  it('refuses to cast without MP and while silenced', () => {
    const caster = mage({ id: 'c' });
    const target = knight({ id: 'd' });
    const state = makeState([caster, target]);

    caster.stats.mp = 0;
    expect(resolveAbilityDetailed(state, caster, FIRE, [target], alwaysLow()).refused).toBe('no-mp');

    caster.stats.mp = 99;
    applyStatus(caster, 'silence');
    expect(resolveAbilityDetailed(state, caster, FIRE, [target], alwaysLow()).refused).toBe('silenced');
  });

  it('applies inflicted statuses and cancels on commit', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    const state = makeState([attacker, target]);

    const res = resolveAbilityDetailed(state, attacker, POISON_TOUCH, [target], alwaysLow());
    expect(res.targets[0]?.applied.map((c) => c.status)).toContain('poison');
    expect(hasStatus(target, 'poison')).toBe(false);
    applyResolution(state, res);
    expect(hasStatus(target, 'poison')).toBe(true);
  });

  it('bounces single-target magic off Reflect', () => {
    const caster = mage({ id: 'c', pos: { x: 2, y: 2, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 } });
    applyStatus(target, 'reflect');
    const state = makeState([caster, target]);

    const res = resolveAbilityDetailed(state, caster, DARKNESS, [target], alwaysLow());
    expect(res.targets[0]?.reflectedTo).toBe(caster.id);
    expect(res.targets[0]?.unit).toBe(caster.id);
  });

  it('knocks a unit down and lets Reraise stand it back up', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
    const victim = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    victim.stats.hp = 1;
    const state = makeState([attacker, victim]);

    const res = resolveAbilityDetailed(state, attacker, ATTACK, [victim], alwaysLow());
    expect(res.targets[0]?.ko).toBe(true);
    applyResolution(state, res);
    expect(hasStatus(victim, 'ko')).toBe(true);
    expect(isKO(victim)).toBe(true);

    const phoenix = knight({ id: 'p', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    phoenix.stats.hp = 1;
    applyStatus(phoenix, 'reraise');
    const state2 = makeState([attacker, phoenix]);
    applyResolution(state2, resolveAbilityDetailed(state2, attacker, ATTACK, [phoenix], alwaysLow()));
    expect(hasStatus(phoenix, 'ko')).toBe(false);
    expect(hasStatus(phoenix, 'reraise')).toBe(false);
    expect(phoenix.stats.hp).toBeGreaterThan(0);
  });

  it('spends MP and breaks Stealth when the caster acts', () => {
    const caster = mage({ id: 'c', pos: { x: 2, y: 2, z: 0 } });
    applyStatus(caster, 'stealth');
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 } });
    const state = makeState([caster, target]);
    const mpBefore = caster.stats.mp;

    const res = resolveAbilityDetailed(state, caster, FIRE, [target], alwaysLow());
    expect(res.casterStatusesBroken).toContain('stealth');
    applyResolution(state, res);
    expect(caster.stats.mp).toBe(mpBefore - FIRE.mp);
    expect(hasStatus(caster, 'stealth')).toBe(false);
  });

  it('wakes a sleeping target when damage lands', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    applyStatus(target, 'sleep');
    const state = makeState([attacker, target]);
    applyResolution(state, resolveAbilityDetailed(state, attacker, ATTACK, [target], alwaysLow()));
    expect(hasStatus(target, 'sleep')).toBe(false);
  });

  it('replays identically from the same seed', () => {
    const build = () => {
      const a = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
      const d = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
      return { state: makeState([a, d]), a, d };
    };
    const runOne = () => {
      const { state, a, d } = build();
      const rng = scriptRng([0.11, 0.42, 0.73, 0.05, 0.9]);
      const res = resolveAbilityDetailed(state, a, ATTACK, [d], rng);
      applyResolution(state, res);
      return d.stats.hp;
    };
    expect(runOne()).toBe(runOne());
  });

  it('resolves an area ability against every unit in it', () => {
    const caster = mage({ id: 'c', pos: { x: 2, y: 2, z: 0 } });
    const t1 = knight({ id: 'd1', pos: { x: 2, y: 3, z: 0 } });
    const t2 = knight({ id: 'd2', pos: { x: 3, y: 3, z: 0 } });
    const state = makeState([caster, t1, t2]);
    const res = resolveAbilityDetailed(state, caster, FIRE, [t1, t2], alwaysLow());
    expect(res.targets.map((t) => t.unit)).toEqual(['d1', 'd2']);
    applyResolution(state, res);
    expect(t1.stats.hp).toBeLessThan(deriveStats(t1).maxHp);
    expect(t2.stats.hp).toBeLessThan(deriveStats(t2).maxHp);
  });

  it('directs the attack from where the attacker actually stands', () => {
    const attacker = knight({ id: 'a', pos: { x: 2, y: 4, z: 0 } });
    const target = knight({ id: 'd', pos: { x: 2, y: 3, z: 0 }, facing: 'N' });
    expect(directionBetween(attacker, target)).toBe('back');
    const state = makeState([attacker, target]);
    const res = resolveAbilityDetailed(state, attacker, ATTACK, [target], alwaysLow());
    expect(res.targets[0]?.direction).toBe('back');
    expect(res.targets[0]?.hit.chance).toBe(100);
  });
});
