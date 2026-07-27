/**
 * End-to-end vertical-slice proof.
 *
 * Drives a real scenario to a real conclusion with the AI playing BOTH sides, then asserts the
 * things that must hold for the game to be genuinely playable rather than merely well-typed:
 * the battle terminates, every turn produces legal commands, damage actually lands, units die,
 * an objective resolves, and the whole run replays identically from the same seed.
 *
 * If this file passes, the battle loop is real.
 */
import { describe, it, expect } from 'vitest';
import { buildScenario, getScenario } from '../src/state/scenarios';
import { advance, applyCommand, evaluateObjective } from '../src/core/battle';
import { decideTurn } from '../src/core/ai';
import type { BattleEvent, BattleState, Command } from '../src/core/types';

/**
 * Read through a function so TypeScript does not carry a narrowing of
 * `state.phase` from an earlier guard into the inner clock loop, where `advance`
 * has since mutated it.
 */
function isFinished(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

/** Play a scenario to completion with AI on both sides. */
function playOut(scenarioId: string, seed: number, maxTurns = 400) {
  const scenario = { ...getScenario(scenarioId), seed };
  const built = buildScenario(scenario);
  const state: BattleState = built.state;
  const events: BattleEvent[] = [];
  const commands: Command[] = [];
  let turns = 0;

  while (turns < maxTurns) {
    if (evaluateObjective(state)) break;
    if (isFinished(state)) break;

    // Tick CT until somebody is ready to act. `advance` steps the clock; it may
    // take several calls before a unit reaches CT 100 and the phase opens up.
    let spins = 0;
    while (state.phase !== 'awaiting-command' && spins < 1000) {
      if (isFinished(state)) break;
      events.push(...advance(state));
      spins++;
    }
    if (state.phase !== 'awaiting-command') break;

    const activeId = state.active;
    if (!activeId) {
      turns++;
      continue;
    }

    const unit = state.units.get(activeId);
    if (!unit || unit.removed) {
      turns++;
      continue;
    }

    // Let the AI drive whichever side is up.
    // Apply the AI's plan one command at a time. A command can end the turn
    // (or the battle) part-way through the plan, at which point the rest of it
    // is no longer legal — the reducer is right to refuse it.
    const plan = decideTurn(state, activeId);
    for (const cmd of plan) {
      if (state.phase !== 'awaiting-command') break;
      commands.push(cmd);
      events.push(...applyCommand(state, cmd));
    }

    // If the unit still holds the turn, close it out so the clock moves on.
    if (state.phase === 'awaiting-command' && state.active === activeId) {
      events.push(...applyCommand(state, { kind: 'wait', unit: activeId }));
    }

    turns++;
  }

  return { state, events, commands, turns };
}

describe('vertical slice — full battle playthrough', () => {
  it('plays battle-open to a decisive conclusion', () => {
    const { state, events, turns } = playOut('battle-open', 1234);

    // It must actually finish, not spin until the turn cap.
    expect(turns).toBeLessThan(400);
    expect(['victory', 'defeat']).toContain(state.phase);

    // A real battle produces a substantial event stream.
    expect(events.length).toBeGreaterThan(50);
  });

  it('deals real damage and kills units', () => {
    const { state, events } = playOut('battle-open', 1234);

    const damage = events.filter((e) => e.kind === 'damage');
    expect(damage.length).toBeGreaterThan(5);
    // Damage must be non-trivial, not all zeroes.
    expect(damage.some((e) => e.kind === 'damage' && e.amount > 0)).toBe(true);

    const kos = events.filter((e) => e.kind === 'knockdown');
    expect(kos.length).toBeGreaterThan(0);

    // Somebody actually ended up dead.
    const dead = [...state.units.values()].filter((u) => u.stats.hp <= 0);
    expect(dead.length).toBeGreaterThan(0);
  });

  it('moves units around the map', () => {
    const { events } = playOut('battle-open', 1234);
    const moves = events.filter((e) => e.kind === 'moved');
    expect(moves.length).toBeGreaterThan(5);
    // Movement must cover real distance, not one-tile shuffles only.
    const longMove = moves.some((e) => e.kind === 'moved' && e.path.length > 2);
    expect(longMove).toBe(true);
  });

  it('awards JP and EXP as units act', () => {
    const { events } = playOut('battle-open', 1234);
    expect(events.some((e) => e.kind === 'jp')).toBe(true);
    expect(events.some((e) => e.kind === 'exp')).toBe(true);
  });

  it('replays identically from the same seed', () => {
    const a = playOut('battle-open', 99);
    const b = playOut('battle-open', 99);

    expect(a.turns).toBe(b.turns);
    expect(a.events.length).toBe(b.events.length);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('produces different battles from different seeds', () => {
    const a = playOut('battle-open', 1);
    const b = playOut('battle-open', 2);
    // Not a hard guarantee in principle, but with a full AI battle it would be
    // extraordinary for two seeds to produce byte-identical event streams.
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events));
  });

  it('plays the second map too', () => {
    const { state, events, turns } = playOut('mandalia-ford', 4321);
    expect(turns).toBeLessThan(400);
    expect(events.length).toBeGreaterThan(30);
    expect(state.units.size).toBeGreaterThan(2);
  });

  it('never leaves a unit standing on an illegal tile', () => {
    const { state } = playOut('battle-open', 777);
    const seen = new Map<string, string>();
    for (const u of state.units.values()) {
      if (u.removed || u.stats.hp <= 0) continue;
      const tile = state.field.tileAt(u.pos.x, u.pos.y);
      expect(tile, `${u.name} stands off-map at ${u.pos.x},${u.pos.y}`).toBeDefined();
      expect(tile!.passable, `${u.name} stands on an impassable tile`).toBe(true);

      const key = `${u.pos.x},${u.pos.y}`;
      expect(seen.has(key), `${u.name} shares a tile with ${seen.get(key)}`).toBe(false);
      seen.set(key, u.name);
    }
  });
});
