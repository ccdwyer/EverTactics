import { describe, expect, it } from 'vitest';
import {
  CT_COST_ACT,
  CT_COST_MOVE,
  CT_COST_WAIT,
  CT_MAX,
  CT_THRESHOLD,
  canAccumulateCt,
  computeTurnOrder,
  consumeFullTurn,
  ctSpeed,
  forecastTurns,
  grantQuick,
  isReady,
  skipsTurn,
  spendTurnCt,
  tickCt,
  ticksUntilTurn,
  turnCtCost,
} from '../src/core/ct';
import { applyStatus } from '../src/core/combat/status';
import type { ActiveStatus, BattleState, Battlefield, Tile, Unit, UnitId } from '../src/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeField(width = 4, height = 4): Battlefield {
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
  return {
    width,
    height,
    tiles,
    mapId: 'test',
    tileAt(x: number, y: number) {
      if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
      return tiles[y * width + x];
    },
  };
}

let idCounter = 0;

export function makeUnit(over: Partial<Unit> & { spd?: number } = {}): Unit {
  const id = over.id ?? `u${idCounter++}`;
  const spd = over.spd ?? 8;
  const unit: Unit = {
    id,
    name: over.name ?? id,
    team: over.team ?? 'player',
    gender: 'male',
    zodiac: 'aries',
    level: over.level ?? 10,
    exp: 0,
    currentJob: 'squire',
    jobs: new Map([['squire', { level: 1, jp: 0, totalJp: 0, learned: new Set<string>() }]]),
    stats: {
      hp: 100,
      maxHp: 100,
      mp: 20,
      maxMp: 20,
      pa: 6,
      ma: 6,
      spd,
      move: 4,
      jump: 3,
      brave: 70,
      faith: 70,
    },
    equipment: {},
    pos: { x: 0, y: 0, z: 0 },
    facing: 'S',
    ct: 0,
    statuses: [],
    turn: { moved: false, acted: false, origin: { x: 0, y: 0, z: 0 }, originFacing: 'S' },
    removed: false,
    sprite: { sheet: 'squire_male', palette: 0 },
    ...over,
  };
  // `over` may have supplied a partial stats object; make sure spd wins if given.
  if (over.spd !== undefined) unit.stats.spd = over.spd;
  return unit;
}

function makeState(units: Unit[]): BattleState {
  const map = new Map<UnitId, Unit>();
  for (const unit of units) map.set(unit.id, unit);
  return {
    field: makeField(),
    units: map,
    order: [],
    phase: 'tick',
    tick: 0,
    rngState: 1,
    log: [],
    objective: { kind: 'defeat-all' },
  };
}

const status = (s: ActiveStatus['status'], remaining = -1): ActiveStatus => ({ status: s, remaining });

const derivedSpeed = (u: Unit) => u.stats.spd;

// ─────────────────────────────────────────────────────────────────────────────

describe('CT accumulation', () => {
  it('gains CT equal to effective speed each tick', () => {
    const unit = makeUnit({ spd: 7 });
    expect(tickCt(unit, ctSpeed(unit, 7))).toBe(7);
    expect(tickCt(unit, ctSpeed(unit, 7))).toBe(14);
  });

  it('clamps to CT_MAX', () => {
    const unit = makeUnit({ spd: 50, ct: CT_MAX - 10 });
    tickCt(unit, 50);
    expect(unit.ct).toBe(CT_MAX);
  });

  it('is ready at exactly 100', () => {
    const unit = makeUnit({ ct: 99 });
    expect(isReady(unit)).toBe(false);
    unit.ct = CT_THRESHOLD;
    expect(isReady(unit)).toBe(true);
  });

  it('haste is x1.5 and slow is x0.5, per the shared status table', () => {
    const base = makeUnit({ spd: 10 });
    expect(ctSpeed(base, 10)).toBe(10);

    const hasted = makeUnit({ spd: 10, statuses: [status('haste')] });
    expect(ctSpeed(hasted, 10)).toBe(15);

    const slowed = makeUnit({ spd: 10, statuses: [status('slow')] });
    expect(ctSpeed(slowed, 10)).toBe(5);
  });

  it('haste cancels slow when applied through the status engine', () => {
    const unit = makeUnit({ spd: 10 });
    applyStatus(unit, 'slow');
    expect(ctSpeed(unit, 10)).toBe(5);
    applyStatus(unit, 'haste');
    expect(unit.statuses.map((s) => s.status)).toEqual(['haste']);
    expect(ctSpeed(unit, 10)).toBe(15);
  });

  it('never rounds a positive speed down to zero', () => {
    const slowed = makeUnit({ spd: 1, statuses: [status('slow')] });
    expect(ctSpeed(slowed, 1)).toBe(1);
  });

  it('a slowed unit falls behind an unhindered one', () => {
    const a = makeUnit({ id: 'a', spd: 8, statuses: [status('slow', 40)] });
    const b = makeUnit({ id: 'b', spd: 8 });
    expect(ctSpeed(a, 8)).toBe(4);
    expect(ctSpeed(b, 8)).toBe(8);
  });

  it('stop and petrify freeze the clock entirely', () => {
    for (const s of ['stop', 'petrify', 'crystal', 'treasure', 'charging'] as const) {
      const unit = makeUnit({ spd: 10, statuses: [status(s)] });
      expect(canAccumulateCt(unit)).toBe(false);
      expect(ctSpeed(unit, 10)).toBe(0);
      tickCt(unit, ctSpeed(unit, 10));
      expect(unit.ct).toBe(0);
    }
  });

  it('KO does not freeze the clock — the death counter needs turns', () => {
    const unit = makeUnit({ spd: 10, statuses: [status('ko', 3)] });
    unit.stats.hp = 0;
    expect(canAccumulateCt(unit)).toBe(true);
    expect(ctSpeed(unit, 10)).toBe(10);
  });

  it('sleep lets the clock run but eats the turn', () => {
    const unit = makeUnit({ spd: 10, statuses: [status('sleep', 40)] });
    expect(canAccumulateCt(unit)).toBe(true);
    expect(skipsTurn(unit)).toBe(true);
  });

  it('Quick jumps straight to the threshold', () => {
    const unit = makeUnit({ ct: 12 });
    grantQuick(unit);
    expect(unit.ct).toBe(CT_THRESHOLD);
  });
});

describe('CT spend and carry-over', () => {
  it('charges 60 to act, 40 to move, 100 for both, 20 for a bare Wait', () => {
    const acted = makeUnit();
    acted.turn.acted = true;
    expect(turnCtCost(acted)).toBe(CT_COST_ACT);

    const movedOnly = makeUnit();
    movedOnly.turn.moved = true;
    expect(turnCtCost(movedOnly)).toBe(CT_COST_MOVE);

    const full = makeUnit();
    full.turn.moved = true;
    full.turn.acted = true;
    expect(turnCtCost(full)).toBe(CT_THRESHOLD);

    expect(turnCtCost(makeUnit())).toBe(CT_COST_WAIT);
  });

  it('carries the leftover forward', () => {
    const unit = makeUnit({ ct: 118 });
    unit.turn.acted = true;
    spendTurnCt(unit);
    expect(unit.ct).toBe(58);
  });

  it('never goes negative', () => {
    const unit = makeUnit({ ct: 100 });
    unit.turn.moved = true;
    unit.turn.acted = true;
    spendTurnCt(unit);
    expect(unit.ct).toBe(0);
  });

  it('a waiting unit comes back much sooner than one that acted', () => {
    const waiter = makeUnit({ id: 'waiter', spd: 10, ct: 100 });
    const worker = makeUnit({ id: 'worker', spd: 10, ct: 100 });
    worker.turn.moved = true;
    worker.turn.acted = true;
    spendTurnCt(waiter); // -20 -> 80
    spendTurnCt(worker); // -100 -> 0
    expect(waiter.ct).toBe(80);
    expect(worker.ct).toBe(0);

    const state = makeState([waiter, worker]);
    // Waiter needs 2 ticks to be ready again, worker needs 10.
    expect(computeTurnOrder(state, 2, derivedSpeed)).toEqual(['waiter', 'worker']);
    expect(ticksUntilTurn(state, 'waiter', derivedSpeed)).toBe(2);
    expect(ticksUntilTurn(state, 'worker', derivedSpeed)).toBe(10);
  });

  it('consumeFullTurn always burns 100', () => {
    const unit = makeUnit({ ct: 145 });
    consumeFullTurn(unit);
    expect(unit.ct).toBe(45);
  });
});

describe('computeTurnOrder', () => {
  it('matches a hand-computed sequence for three different speeds', () => {
    // Hand-computed, assuming every predicted turn spends a full 100 CT:
    //   t=10  fast hits 100 -> acts, drops to 0.   (mid 50, slow 40)
    //   t=20  fast 100 AND mid 100 -> tie, insertion order puts fast first, then mid.
    //   t=25  slow reaches 100.                    (fast 50, mid 25)
    //   t=30  fast is back.
    const fast = makeUnit({ id: 'fast', spd: 10 });
    const mid = makeUnit({ id: 'mid', spd: 5 });
    const slow = makeUnit({ id: 'slow', spd: 4 });
    const state = makeState([fast, mid, slow]);

    const forecast = forecastTurns(state, 5, derivedSpeed);
    expect(forecast.map((f) => f.unit)).toEqual(['fast', 'fast', 'mid', 'slow', 'fast']);
    expect(forecast.map((f) => f.tick)).toEqual([10, 20, 20, 25, 30]);
    expect(forecast.map((f) => f.ct)).toEqual([100, 100, 100, 100, 100]);
  });

  it('is genuinely predictive rather than a sort by current CT', () => {
    // `slow` currently leads on CT but `fast` overtakes it before either acts.
    const fast = makeUnit({ id: 'fast', spd: 20, ct: 0 });
    const slow = makeUnit({ id: 'slow', spd: 2, ct: 90 });
    const state = makeState([fast, slow]);

    const byCurrentCt = [...state.units.values()].sort((a, b) => b.ct - a.ct).map((u) => u.id);
    expect(byCurrentCt).toEqual(['slow', 'fast']);

    expect(computeTurnOrder(state, 2, derivedSpeed)).toEqual(['fast', 'slow']);
  });

  it('haste reorders the bar', () => {
    const a = makeUnit({ id: 'a', spd: 8 });
    const b = makeUnit({ id: 'b', spd: 7 });
    const state = makeState([a, b]);
    expect(computeTurnOrder(state, 2, derivedSpeed)).toEqual(['a', 'b']);

    b.statuses.push(status('haste'));
    // b now moves at 10 and is ready at tick 10; a is ready at tick 13.
    expect(computeTurnOrder(state, 2, derivedSpeed)).toEqual(['b', 'a']);
  });

  it('slow reorders the bar the other way', () => {
    const a = makeUnit({ id: 'a', spd: 9 });
    const b = makeUnit({ id: 'b', spd: 8 });
    const state = makeState([a, b]);
    expect(computeTurnOrder(state, 2, derivedSpeed)).toEqual(['a', 'b']);

    a.statuses.push(status('slow'));
    expect(computeTurnOrder(state, 2, derivedSpeed)).toEqual(['b', 'a']);
  });

  it('omits crystallised units but keeps KO\'d ones in line', () => {
    const alive = makeUnit({ id: 'alive', spd: 10 });
    const downed = makeUnit({ id: 'downed', spd: 10, statuses: [status('ko', 3)] });
    downed.stats.hp = 0;
    const gone = makeUnit({ id: 'gone', spd: 30, statuses: [status('crystal')], removed: true });
    const state = makeState([alive, downed, gone]);

    const order = computeTurnOrder(state, 4, derivedSpeed);
    expect(order).not.toContain('gone');
    expect(order).toContain('downed');
    expect(forecastTurns(state, 2, derivedSpeed).find((f) => f.unit === 'downed')?.downed).toBe(true);
  });

  it('breaks ties by insertion order, deterministically', () => {
    const a = makeUnit({ id: 'a', spd: 10 });
    const b = makeUnit({ id: 'b', spd: 10 });
    const c = makeUnit({ id: 'c', spd: 10 });
    const state = makeState([a, b, c]);
    expect(computeTurnOrder(state, 6, derivedSpeed)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('puts the unit currently holding the turn first', () => {
    const a = makeUnit({ id: 'a', spd: 10, ct: 100 });
    const b = makeUnit({ id: 'b', spd: 10, ct: 100 });
    const state = makeState([a, b]);
    state.active = 'b';
    expect(computeTurnOrder(state, 2, derivedSpeed)[0]).toBe('b');
  });

  it('terminates when the whole field is Stopped', () => {
    const a = makeUnit({ id: 'a', spd: 10, statuses: [status('stop', 50)] });
    const b = makeUnit({ id: 'b', spd: 10, statuses: [status('stop', 50)] });
    const state = makeState([a, b]);
    expect(computeTurnOrder(state, 5, derivedSpeed)).toEqual([]);
  });

  it('returns nothing for an empty field', () => {
    expect(computeTurnOrder(makeState([]), 5, derivedSpeed)).toEqual([]);
  });
});
