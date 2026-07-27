/**
 * Reaction abilities — the half of FFT's tactics that happens on somebody else's turn.
 *
 * These tests drive the real reducer (`applyCommand`) rather than poking the reaction
 * engine directly, because the thing that was broken was the *wiring*: `rollReaction`
 * existed and nothing called it. A reaction that only fires when a test calls it by
 * hand is still dead code, so almost everything here goes in through a command and
 * asserts on the `BattleEvent` stream that comes back out.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { advance, applyCommand, evaluateObjective } from '../src/core/battle';
import { createBattlefield } from '../src/core/grid';
import { createRng } from '../src/core/rng';
import { applyStatus } from '../src/core/combat/status';
import {
  MAX_REACTION_DEPTH,
  givePouchItem,
  pouchCount,
  runPostHitReactions,
  type ReactionHost,
} from '../src/core/combat/reactions';
import { reactionChance } from '../src/core/combat/hit';
import { REACTION_ABILITIES } from '../src/core/abilities/reactions';
import { ACTION_ABILITIES } from '../src/core/abilities/sets';
import {
  clearContent,
  createUnit,
  deriveStats,
  registerAbilities,
  registerItems,
  registerJobs,
} from '../src/core/unit';
import { ALL_ABILITIES, ALL_ITEMS, ALL_JOBS } from '../src/state/content';
import { buildScenario, getScenario } from '../src/state/scenarios';
import { decideTurn } from '../src/core/ai';
import type {
  Ability,
  AbilityId,
  BattleEvent,
  BattleState,
  Battlefield,
  Command,
  Item,
  Job,
  Tile,
  Unit,
  UnitId,
} from '../src/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Test content
// ─────────────────────────────────────────────────────────────────────────────

function job(over: Partial<Job> & Pick<Job, 'id' | 'name'>): Job {
  return {
    origin: 'fft',
    blurb: '',
    description: '',
    sprite: { male: 'test_male', female: 'test_female' },
    move: 4,
    jump: 3,
    // No class evade anywhere: every hit in this file lands unless a reaction stops it,
    // which keeps the assertions about reactions and not about evasion rolls.
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

const TEST_JOBS: Job[] = [
  job({ id: 'brawler', name: 'Brawler' }),
  job({ id: 'slowpoke', name: 'Slowpoke', mult: { hp: 100, mp: 100, pa: 100, ma: 100, spd: 40 } }),
];

const TEST_ACTIONS: Ability[] = [
  // A weak swing, so the defender survives to react.
  ability({ id: 't-jab', name: 'Jab', power: 1 }),
  // A hard swing, for the kill-then-check-nothing-reacts cases.
  ability({ id: 't-cleave', name: 'Cleave', power: 40 }),
  ability({
    id: 't-bolt',
    name: 'Bolt',
    formula: 'magical',
    element: 'lightning',
    power: 4,
    range: { range: 5, radius: 0, vertical: 4, los: false },
  }),
  ability({
    id: 't-arrow',
    name: 'Arrow',
    power: 1,
    range: { range: 5, radius: 0, vertical: 4, los: false },
  }),
];

const TEST_ITEMS: Item[] = [
  { id: 't-sword', name: 'Test Sword', category: 'sword', description: '', price: 1, wp: 6 },
];

/** Test jobs + test actions + the *real* reaction and item-use ability tables. */
function useTestContent(): void {
  clearContent();
  registerJobs(TEST_JOBS);
  registerAbilities([...TEST_ACTIONS, ...REACTION_ABILITIES, ...ACTION_ABILITIES]);
  registerItems(TEST_ITEMS);
}

/**
 * The shipping tables, for the end-to-end replay test.
 *
 * `state/content.bootstrapContent()` is one-shot, so once this file's other tests have
 * cleared the registries it cannot put them back. Registering from the same exported
 * tables it uses gives every test in that block the same content, in any order.
 */
function useRealContent(): void {
  clearContent();
  registerJobs([...ALL_JOBS.values()]);
  registerAbilities([...ALL_ABILITIES.values()]);
  registerItems([...ALL_ITEMS.values()]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

function flatField(width = 8, height = 8): Battlefield {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x, y, height: 0, depth: Infinity,
        surface: 'grass', slope: 'flat', passable: true, submerged: false,
      });
    }
  }
  return createBattlefield(width, height, tiles, 'test-flat');
}

interface Options {
  /** The defender's reaction slot. */
  reaction?: AbilityId;
  /** The defender's Brave — the reaction trigger rate. */
  defenderBrave?: number;
  /** The attacker's reaction slot, for chain tests. */
  attackerReaction?: AbilityId;
  attackerBrave?: number;
  seed?: number;
  /** Distance between the two units along x. 1 = adjacent. */
  gap?: number;
  /** Arm the attacker with a real weapon (Blade Grasp needs one to catch). */
  attackerArmed?: boolean;
  defenderJob?: string;
  /** Park a second enemy out of reach, so felling the defender does not end the battle. */
  bystander?: boolean;
}

interface Setup {
  state: BattleState;
  attacker: Unit;
  defender: Unit;
}

/**
 * Attacker at (1,1) facing the defender at (1 + gap, 1). The attacker's job is faster,
 * so `advance()` always hands it the first turn and the tests never have to guess.
 */
function setup(opts: Options = {}): Setup {
  const gap = opts.gap ?? 1;
  const attacker = createUnit({
    id: 'atk', name: 'Attacker', team: 'player', job: 'brawler', level: 12,
    pos: { x: 1, y: 1, z: 0 }, facing: 'E', zodiac: 'aries',
    // Bare-handed damage is PA * Brave / 100, so the attacker needs Brave to hurt anyone.
    brave: opts.attackerBrave ?? 70, faith: 100,
    ...(opts.attackerArmed ? { equipment: { rightHand: 't-sword' } } : {}),
    ...(opts.attackerReaction !== undefined ? { reaction: opts.attackerReaction } : {}),
  });
  const defender = createUnit({
    id: 'def', name: 'Defender', team: 'enemy', job: opts.defenderJob ?? 'slowpoke', level: 12,
    pos: { x: 1 + gap, y: 1, z: 0 }, facing: 'W', zodiac: 'aries',
    brave: opts.defenderBrave ?? 100, faith: 100,
    equipment: { rightHand: 't-sword' },
    ...(opts.reaction !== undefined ? { reaction: opts.reaction } : {}),
  });

  const units = new Map<UnitId, Unit>([['atk', attacker], ['def', defender]]);
  if (opts.bystander === true) {
    units.set('bystander', createUnit({
      id: 'bystander', name: 'Bystander', team: 'enemy', job: 'slowpoke', level: 12,
      pos: { x: 7, y: 7, z: 0 }, zodiac: 'aries', brave: 0, faith: 100,
    }));
  }

  const state: BattleState = {
    field: flatField(),
    units,
    order: [],
    phase: 'deploy',
    tick: 0,
    rngState: createRng(opts.seed ?? 12345).state(),
    log: [],
    objective: { kind: 'defeat-all' },
  };
  return { state, attacker, defender };
}

/** Give the attacker its turn and have it use `abilityId` on the defender. */
function strike(s: Setup, abilityId = 't-jab'): BattleEvent[] {
  const events = advance(s.state);
  expect(s.state.active).toBe('atk');
  events.push(...applyCommand(s.state, {
    kind: 'act', unit: 'atk', ability: abilityId, target: { ...s.defender.pos },
  }));
  return events;
}

/**
 * Drive the same attack across successive seeds until `reaction` fires.
 *
 * Reactions authored below accuracy 100 (Hamedo is 75) do not trigger on every roll
 * even at Brave 100, so a single hard-coded seed would be a coin flip. Searching for a
 * seed keeps the test about the reaction's *effect* while `Brave governs the trigger
 * rate` below owns the question of how often it fires.
 */
function strikeUntilReaction(
  reaction: AbilityId,
  opts: Options = {},
  abilityId = 't-jab',
  extra: (s: Setup, events: BattleEvent[]) => boolean = () => true,
  tries = 60,
): { s: Setup; events: BattleEvent[] } {
  for (let seed = 1; seed <= tries; seed++) {
    const s = setup({ ...opts, reaction, seed });
    const events = strike(s, abilityId);
    if (reactionsIn(events).includes(reaction) && extra(s, events)) return { s, events };
  }
  throw new Error(`${reaction} never triggered in ${tries} seeded attempts`);
}

const reactionsIn = (events: readonly BattleEvent[]): AbilityId[] =>
  events.flatMap((e) => (e.kind === 'reaction' ? [e.ability] : []));

const damageTo = (events: readonly BattleEvent[], unit: UnitId): number =>
  events.reduce((n, e) => (e.kind === 'damage' && e.unit === unit ? n + e.amount : n), 0);

const healsTo = (events: readonly BattleEvent[], unit: UnitId): number =>
  events.reduce((n, e) => (e.kind === 'heal' && e.unit === unit ? n + e.amount : n), 0);

beforeEach(useTestContent);

// ─────────────────────────────────────────────────────────────────────────────

describe('the trigger point is wired at all', () => {
  it('fires a reaction when a commanded attack connects', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100 });
    const events = strike(s);
    expect(reactionsIn(events)).toContain('counter');
  });

  it('fires nothing when the defender has no reaction equipped', () => {
    const s = setup({ defenderBrave: 100 });
    expect(reactionsIn(strike(s))).toEqual([]);
  });

  it('names both sides on the reaction event so the renderer can attribute it', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100 });
    const event = strike(s).find((e) => e.kind === 'reaction');
    expect(event).toMatchObject({ kind: 'reaction', unit: 'def', ability: 'counter', source: 'atk' });
  });
});

describe('Counter', () => {
  it('deals damage back to an adjacent attacker', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100 });
    const hpBefore = s.attacker.stats.hp;

    const events = strike(s);

    expect(reactionsIn(events)).toContain('counter');
    expect(damageTo(events, 'atk')).toBeGreaterThan(0);
    expect(s.attacker.stats.hp).toBeLessThan(hpBefore);
  });

  it('does not reach an attacker standing outside its range', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100, gap: 4 });
    const events = strike(s, 't-arrow');

    expect(damageTo(events, 'def')).toBeGreaterThan(0);   // the arrow landed
    expect(reactionsIn(events)).not.toContain('counter'); // the counter could not
    expect(damageTo(events, 'atk')).toBe(0);
  });

  it('does not answer a spell — it triggers on physical hits only', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100 });
    const events = strike(s, 't-bolt');

    expect(damageTo(events, 'def')).toBeGreaterThan(0);
    expect(reactionsIn(events)).not.toContain('counter');
  });
});

describe('Blade Grasp', () => {
  it('nullifies a physical weapon hit entirely', () => {
    const s = setup({ reaction: 'blade-grasp', defenderBrave: 100, attackerArmed: true });
    const hpBefore = s.defender.stats.hp;

    const events = strike(s);

    expect(reactionsIn(events)).toContain('blade-grasp');
    expect(damageTo(events, 'def')).toBe(0);
    expect(s.defender.stats.hp).toBe(hpBefore);
    expect(events.some((e) => e.kind === 'miss' && e.unit === 'def')).toBe(true);
  });

  it('catches nothing when the attack is a spell', () => {
    const s = setup({ reaction: 'blade-grasp', defenderBrave: 100, attackerArmed: true });
    const events = strike(s, 't-bolt');

    expect(reactionsIn(events)).not.toContain('blade-grasp');
    expect(damageTo(events, 'def')).toBeGreaterThan(0);
  });

  it('lets the blow through when the Brave roll fails', () => {
    const s = setup({ reaction: 'blade-grasp', defenderBrave: 0, attackerArmed: true });
    const events = strike(s);

    expect(reactionsIn(events)).toEqual([]);
    expect(damageTo(events, 'def')).toBeGreaterThan(0);
  });
});

describe('Arrow Guard', () => {
  it('turns aside a physical attack made from range', () => {
    const { s, events } = strikeUntilReaction(
      'arrow-guard', { defenderBrave: 100, gap: 4 }, 't-arrow',
    );
    expect(damageTo(events, 'def')).toBe(0);
    expect(s.defender.stats.hp).toBe(deriveStats(s.defender).maxHp);
  });

  it('does nothing against a blow from an adjacent attacker', () => {
    const s = setup({ reaction: 'arrow-guard', defenderBrave: 100, gap: 1 });
    const events = strike(s);
    expect(reactionsIn(events)).not.toContain('arrow-guard');
    expect(damageTo(events, 'def')).toBeGreaterThan(0);
  });
});

describe('Hamedo', () => {
  it('pre-empts: it strikes first and the original attack never lands', () => {
    // Hamedo is authored at accuracy 75 and its strike then rolls to hit like any
    // other, so search for a seed where it both fires and connects.
    const { s, events } = strikeUntilReaction(
      'hamedo', { defenderBrave: 100 }, 't-jab',
      (_, ev) => damageTo(ev, 'atk') > 0,
    );
    const defenderHpBefore = s.defender.stats.hp + damageTo(events, 'def');

    expect(reactionsIn(events)).toContain('hamedo');
    expect(damageTo(events, 'atk')).toBeGreaterThan(0);   // struck first
    expect(damageTo(events, 'def')).toBe(0);              // and was never struck back
    expect(s.defender.stats.hp).toBe(defenderHpBefore);

    // Ordering matters to the renderer: the pre-emptive strike precedes the cast it cancelled.
    const reactionAt = events.findIndex((e) => e.kind === 'reaction');
    const castAt = events.findIndex((e) => e.kind === 'cast-fire' && e.unit === 'atk');
    expect(reactionAt).toBeGreaterThanOrEqual(0);
    expect(reactionAt).toBeLessThan(castAt);
  });
});

describe('Auto-Potion', () => {
  it('heals the reactor and consumes a potion from the pouch', () => {
    const s = setup({ reaction: 'auto-potion', defenderBrave: 100, defenderJob: 'brawler' });
    // Wounded but not one blow from death — the reactor has to survive to reach its belt.
    s.defender.stats.hp = Math.floor(deriveStats(s.defender).maxHp / 2);
    const hpBefore = s.defender.stats.hp;
    const stockBefore = pouchCount(s.defender, 'use-potion');
    expect(stockBefore).toBeGreaterThan(0);

    const events = strike(s);

    expect(reactionsIn(events)).toContain('auto-potion');
    expect(healsTo(events, 'def')).toBeGreaterThan(0);
    expect(s.defender.stats.hp).toBeGreaterThan(hpBefore - damageTo(events, 'def'));
    expect(pouchCount(s.defender, 'use-potion')).toBe(stockBefore - 1);
  });

  it('does not fire with an empty pouch', () => {
    const s = setup({ reaction: 'auto-potion', defenderBrave: 100, defenderJob: 'brawler' });
    s.defender.pouch = {};
    s.defender.stats.hp = Math.floor(deriveStats(s.defender).maxHp / 2);

    expect(reactionsIn(strike(s))).toEqual([]);
  });

  it('reaches for the weakest healing item it is carrying', () => {
    const s = setup({ reaction: 'auto-potion', defenderBrave: 100, defenderJob: 'brawler' });
    s.defender.pouch = {};
    givePouchItem(s.defender, 'use-x-potion', 1);
    givePouchItem(s.defender, 'use-potion', 1);
    s.defender.stats.hp = Math.floor(deriveStats(s.defender).maxHp / 2);

    strike(s);

    expect(pouchCount(s.defender, 'use-potion')).toBe(0);
    expect(pouchCount(s.defender, 'use-x-potion')).toBe(1);
  });
});

describe('Damage Split and Absorb MP', () => {
  it('Damage Split halves the blow and hands the other half back', () => {
    const s = setup({ reaction: 'damage-split', defenderBrave: 100, defenderJob: 'brawler' });
    const attackerHpBefore = s.attacker.stats.hp;

    const events = strike(s);

    expect(reactionsIn(events)).toContain('damage-split');
    const landed = damageTo(events, 'def');
    const shared = damageTo(events, 'atk');
    expect(landed).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(0);
    expect(s.attacker.stats.hp).toBe(attackerHpBefore - shared);
    // The reactor was refunded the same share it passed on.
    expect(healsTo(events, 'def')).toBe(shared);
  });

  it('Absorb MP converts a spell that landed into MP for the reactor', () => {
    const s = setup({ reaction: 'absorb-mp', defenderBrave: 100, defenderJob: 'brawler' });
    s.defender.stats.mp = 0;

    const events = strike(s, 't-bolt');

    expect(reactionsIn(events)).toContain('absorb-mp');
    expect(damageTo(events, 'def')).toBeGreaterThan(0);
    expect(s.defender.stats.mp).toBeGreaterThan(0);
  });
});

describe('self-affecting reactions', () => {
  it('Regenerator applies Regen to the wounded unit', () => {
    const s = setup({ reaction: 'regenerator', defenderBrave: 100, defenderJob: 'brawler' });
    const events = strike(s);

    expect(reactionsIn(events)).toContain('regenerator');
    expect(s.defender.statuses.some((st) => st.status === 'regen')).toBe(true);
    expect(events.some((e) => e.kind === 'status-add' && e.unit === 'def' && e.status === 'regen')).toBe(true);
  });

  it('Brave Up raises the reactor\'s Bravery, and with it its own trigger rate', () => {
    const s = setup({ reaction: 'brave-up', defenderBrave: 60, defenderJob: 'brawler' });
    const before = s.defender.stats.brave;

    // Brave 60 does not always trigger, so drive it until it does.
    let fired = false;
    for (let i = 0; i < 20 && !fired; i++) {
      const one = setup({ reaction: 'brave-up', defenderBrave: 60, defenderJob: 'brawler', seed: 1000 + i });
      const events = strike(one);
      if (reactionsIn(events).includes('brave-up')) {
        expect(one.defender.stats.brave).toBeGreaterThan(before);
        fired = true;
      }
    }
    expect(fired).toBe(true);
  });

  it('Critical: Quick hands the turn straight back to a unit at critical HP', () => {
    // A weak attacker, so the jab drops the reactor into the critical band without
    // taking it through the floor.
    const s = setup({
      reaction: 'critical-quick', defenderBrave: 100, defenderJob: 'brawler', attackerBrave: 30,
    });
    s.defender.stats.hp = Math.floor(deriveStats(s.defender).maxHp * 0.3);
    const ctBefore = s.defender.ct;

    const events = strike(s);

    expect(reactionsIn(events)).toContain('critical-quick');
    expect(s.defender.ct).toBeGreaterThan(ctBefore);
  });

  it('does not arm Critical: Quick while the reactor is healthy', () => {
    const s = setup({
      reaction: 'critical-quick', defenderBrave: 100, defenderJob: 'brawler', attackerBrave: 30,
    });
    expect(reactionsIn(strike(s))).not.toContain('critical-quick');
  });
});

describe('Dragon Spirit', () => {
  it('brings its owner straight back up from a killing blow', () => {
    const s = setup({ reaction: 'dragon-spirit', defenderBrave: 100, bystander: true });
    s.defender.stats.hp = 1;

    const events = strike(s, 't-cleave');

    expect(reactionsIn(events)).toContain('dragon-spirit');
    expect(s.defender.stats.hp).toBeGreaterThan(0);
    expect(s.defender.statuses.some((st) => st.status === 'ko')).toBe(false);
  });
});

describe('guards against the obvious failures', () => {
  it('a KO\'d unit does not react', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100, bystander: true });
    s.defender.stats.hp = 1;

    const events = strike(s, 't-cleave');

    expect(s.defender.stats.hp).toBe(0);
    expect(reactionsIn(events)).not.toContain('counter');
    expect(damageTo(events, 'atk')).toBe(0);
  });

  it('a unit that was already down before the ability fired does not react', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100, bystander: true });
    s.defender.stats.hp = 0;
    applyStatus(s.defender, 'ko', { duration: 3 });

    const events = strike(s);
    expect(reactionsIn(events)).toEqual([]);
  });

  it.each(['sleep', 'stop', 'petrify', 'confuse'] as const)(
    '%s suppresses reactions',
    (status) => {
      const s = setup({ reaction: 'counter', defenderBrave: 100, defenderJob: 'brawler' });
      applyStatus(s.defender, status, { duration: 100 });

      const events = strike(s);
      expect(reactionsIn(events)).toEqual([]);
    },
  );

  it('a reaction chain terminates: a Counter does not provoke a Counter', () => {
    const s = setup({
      reaction: 'counter', defenderBrave: 100,
      attackerReaction: 'counter', attackerBrave: 100,
      defenderJob: 'brawler',
    });

    const events = strike(s);

    // The defender counters; the attacker, though it also holds Counter at Brave 100,
    // does not answer the answer.
    expect(reactionsIn(events)).toEqual(['counter']);
  });

  it('no reaction rolls at all once the depth cap is reached', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100, defenderJob: 'brawler' });
    advance(s.state);

    const events: BattleEvent[] = [];
    const host: ReactionHost = {
      state: s.state,
      rng: createRng(1),
      depth: MAX_REACTION_DEPTH,
      sync: () => {},
      note: () => {},
    };
    // A hand-built outcome that would certainly trigger Counter at depth 0.
    runPostHitReactions(host, s.attacker, TEST_ACTIONS[0]!, [{
      unit: 'def',
      hit: {
        hit: true, chance: 100, roll: 0, category: 'physical', direction: 'front',
        evade: { classEvade: 0, weaponEvade: 0, shieldEvade: 0, accessoryEvade: 0, magicEvade: 0 },
        evadeNullified: false, consumedEvadeCharge: false, zodiac: 1, breakdown: [],
      },
      direction: 'front',
      damage: {
        target: 'def', kind: 'damage', amount: 10, hpDelta: -10, mpDelta: 0,
        attackerHpDelta: 0, attackerMpDelta: 0, wardAbsorbed: 0, element: 'none',
        crit: false, direction: 'front', affinity: 'normal', zodiac: 1,
        lethal: false, breakdown: [],
      },
      applied: [], removed: [], ko: false, revived: false, events: [],
    }], events);

    expect(events).toEqual([]);
  });

  it('a reaction that kills the acting unit still closes out its turn', () => {
    const s = setup({ reaction: 'counter', defenderBrave: 100, defenderJob: 'brawler' });
    s.attacker.stats.hp = 1;

    strike(s);

    // The attacker died to the counter mid-turn. The reducer must not leave it holding
    // a turn it can never end.
    expect(s.attacker.stats.hp).toBe(0);
    expect(s.state.active).toBeUndefined();
    expect(evaluateObjective(s.state)).toBe(true);
  });

  it('never consumes randomness outside the seeded Rng', () => {
    // Same seed, same commands, same everything — twice.
    const runOnce = () => {
      const s = setup({ reaction: 'counter', defenderBrave: 55, defenderJob: 'brawler', seed: 4242 });
      return JSON.stringify(strike(s));
    };
    expect(runOnce()).toBe(runOnce());
  });
});

describe('Brave governs the trigger rate', () => {
  /** Fraction of `trials` seeded attacks that provoked the defender's reaction. */
  function observedRate(brave: number, trials = 500): number {
    let fired = 0;
    for (let seed = 1; seed <= trials; seed++) {
      const s = setup({ reaction: 'counter', defenderBrave: brave, defenderJob: 'brawler', seed });
      if (reactionsIn(strike(s)).includes('counter')) fired++;
    }
    return fired / trials;
  }

  it('Counter (accuracy 100) fires at very close to Brave%', () => {
    // Counter's authored accuracy is 100, so trigger% == Brave exactly.
    expect(reactionChance(setup({ defenderBrave: 70 }).defender)).toBe(70);

    for (const brave of [20, 50, 80]) {
      const rate = observedRate(brave);
      expect(rate).toBeGreaterThan(brave / 100 - 0.07);
      expect(rate).toBeLessThan(brave / 100 + 0.07);
    }
  });

  it('never fires at Brave 0 and always fires at Brave 100', () => {
    expect(observedRate(0, 60)).toBe(0);
    expect(observedRate(100, 60)).toBe(1);
  });

  it('a rarer reaction fires at accuracy x Brave / 100', () => {
    // Meatbone Slash is authored at accuracy 50, so at Brave 80 it should land ~40%.
    let fired = 0;
    const trials = 500;
    for (let seed = 1; seed <= trials; seed++) {
      const s = setup({
        reaction: 'meatbone-slash', defenderBrave: 80, defenderJob: 'brawler',
        attackerBrave: 30, seed,
      });
      s.defender.stats.hp = Math.floor(deriveStats(s.defender).maxHp * 0.3);
      if (reactionsIn(strike(s)).includes('meatbone-slash')) fired++;
    }
    const rate = fired / trials;
    expect(rate).toBeGreaterThan(0.40 - 0.07);
    expect(rate).toBeLessThan(0.40 + 0.07);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end, on the shipping content
// ─────────────────────────────────────────────────────────────────────────────

function isFinished(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

/** The same AI-vs-AI playout `tests/playthrough.test.ts` uses. */
function playOut(scenarioId: string, seed: number, maxTurns = 400) {
  const state: BattleState = buildScenario({ ...getScenario(scenarioId), seed }).state;
  const events: BattleEvent[] = [];
  const commands: Command[] = [];
  let turns = 0;

  while (turns < maxTurns) {
    if (evaluateObjective(state) || isFinished(state)) break;

    let spins = 0;
    while (state.phase !== 'awaiting-command' && spins < 1000) {
      if (isFinished(state)) break;
      events.push(...advance(state));
      spins++;
    }
    if (state.phase !== 'awaiting-command') break;

    const activeId = state.active;
    if (!activeId) { turns++; continue; }
    const unit = state.units.get(activeId);
    if (!unit || unit.removed) { turns++; continue; }

    for (const cmd of decideTurn(state, activeId)) {
      if (state.phase !== 'awaiting-command') break;
      commands.push(cmd);
      events.push(...applyCommand(state, cmd));
    }
    if (state.phase === 'awaiting-command' && state.active === activeId) {
      events.push(...applyCommand(state, { kind: 'wait', unit: activeId }));
    }
    turns++;
  }

  return { state, events, commands, turns };
}

describe('a real seeded battle', () => {
  beforeEach(useRealContent);

  it('actually produces reaction events', () => {
    const { events } = playOut('battle-open', 12345);
    const fired = reactionsIn(events);

    // Not a token one-off: the shipping roster equips Counter, Brave Up, Regenerator
    // and Sunken State, and over a full battle several of them land.
    expect(fired.length).toBeGreaterThan(3);
    expect(new Set(fired).size).toBeGreaterThan(1);
  });

  it('replays identically from the same seed with reactions active', () => {
    const a = playOut('battle-open', 12345);
    const b = playOut('battle-open', 12345);

    expect(b.commands).toEqual(a.commands);
    expect(b.events).toEqual(a.events);
    expect(b.state.phase).toBe(a.state.phase);
    expect(b.state.tick).toBe(a.state.tick);
    expect(b.state.rngState).toBe(a.state.rngState);
    expect(reactionsIn(b.events)).toEqual(reactionsIn(a.events));
  });

  it('diverges on a different seed, so the replay above is not vacuous', () => {
    const a = playOut('battle-open', 12345);
    const c = playOut('battle-open', 999);
    expect(c.events).not.toEqual(a.events);
  });
});
