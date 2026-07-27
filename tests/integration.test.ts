/**
 * Whole-system integration.
 *
 * The unit suites prove each system is correct in isolation. This file proves they are actually
 * WIRED TOGETHER — the failure mode where a subsystem is fully implemented, fully tested, and
 * never called by anything. Reaction abilities shipped in exactly that state once: `rollReaction`
 * existed, passed its tests, and no code path invoked it.
 *
 * Every assertion here is about emergent behaviour in a real battle, not about a function.
 */
import { describe, it, expect } from 'vitest';
import { buildScenario, getScenario } from '../src/state/scenarios';
import { advance, applyCommand, evaluateObjective } from '../src/core/battle';
import { decideTurn } from '../src/core/ai';
import type { BattleEvent, BattleState } from '../src/core/types';

function isFinished(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

/** Run a full AI-vs-AI battle and collect every event it produced. */
function battle(seed: number, scenarioId = 'battle-open') {
  const state = buildScenario({ ...getScenario(scenarioId), seed }).state;
  const events: BattleEvent[] = [];
  let turns = 0;

  while (turns < 400) {
    if (evaluateObjective(state)) break;
    if (isFinished(state)) break;

    let spins = 0;
    while (state.phase !== 'awaiting-command' && spins < 1000) {
      if (isFinished(state)) break;
      events.push(...advance(state));
      spins++;
    }
    if (state.phase !== 'awaiting-command') break;

    const id = state.active;
    if (!id) break;

    for (const cmd of decideTurn(state, id)) {
      if (state.phase !== 'awaiting-command') break;
      events.push(...applyCommand(state, cmd));
    }
    if (state.phase === 'awaiting-command' && state.active === id) {
      events.push(...applyCommand(state, { kind: 'wait', unit: id }));
    }
    turns++;
  }

  return { state, events, turns };
}

const kindsOf = (events: BattleEvent[]) => new Set(events.map((e) => e.kind));

describe('systems are wired into real battles', () => {
  it('reaction abilities actually trigger during play', () => {
    // Across several seeds so this does not hinge on one lucky Brave roll.
    const fired: Record<string, number> = {};
    let total = 0;

    for (const seed of [1234, 99, 7, 4321, 555]) {
      for (const e of battle(seed).events) {
        if (e.kind !== 'reaction') continue;
        total++;
        const ability = (e as { ability?: string }).ability ?? 'unknown';
        fired[ability] = (fired[ability] ?? 0) + 1;
      }
    }

    expect(total, 'no reaction ever fired in five full battles').toBeGreaterThan(0);
    // More than one KIND, or the trigger is hardcoded to a single ability.
    expect(Object.keys(fired).length).toBeGreaterThan(1);
  });

  it('reaction events carry enough data to render them', () => {
    const events = battle(1234).events;
    const reaction = events.find((e) => e.kind === 'reaction') as
      | { kind: string; unit?: string; ability?: string; source?: string }
      | undefined;

    expect(reaction, 'expected at least one reaction in this seeded battle').toBeDefined();
    expect(reaction!.unit, 'reaction must name the reacting unit').toBeTruthy();
    expect(reaction!.ability, 'reaction must name which ability fired').toBeTruthy();
  });

  it('reaction chains terminate — a battle with reactions still ends', () => {
    const { state, turns } = battle(1234);
    expect(turns).toBeLessThan(400);
    expect(['victory', 'defeat']).toContain(state.phase);
  });

  it('stays deterministic with reactions live', () => {
    const a = battle(1234);
    const b = battle(1234);
    expect(a.turns).toBe(b.turns);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('exercises the full combat vocabulary in one battle', () => {
    // If any of these never appears, some system is implemented but unreachable.
    const kinds = kindsOf(battle(1234).events);
    for (const required of ['moved', 'damage', 'knockdown', 'jp', 'exp', 'reaction']) {
      expect(kinds, `no "${required}" event in a full battle`).toContain(required);
    }
  });

  it('resolves both shipped maps', () => {
    for (const map of ['battle-open', 'mandalia-ford']) {
      const { state, turns } = battle(2468, map);
      expect(turns, `${map} hit the turn cap`).toBeLessThan(400);
      expect(['victory', 'defeat'], `${map} did not resolve`).toContain(state.phase);
    }
  });
});
