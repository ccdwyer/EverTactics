import { describe, it } from 'vitest';
import { buildScenario, getScenario, listScenarios } from '../src/state/scenarios';
import { advance, applyCommand, evaluateObjective } from '../src/core/battle';
import { decideTurn } from '../src/core/ai';
import type { BattleEvent, BattleState, Command } from '../src/core/types';

function finished(s: BattleState) { return s.phase === 'victory' || s.phase === 'defeat'; }

function playOut(scenarioId: string, seed: number, maxTurns = 400) {
  const scenario = { ...getScenario(scenarioId), seed };
  const state: BattleState = buildScenario(scenario).state;
  const events: BattleEvent[] = [];
  const commands: Command[] = [];
  let turns = 0;
  while (turns < maxTurns) {
    if (evaluateObjective(state) || finished(state)) break;
    let spins = 0;
    while (state.phase !== 'awaiting-command' && spins < 1000) {
      if (finished(state)) break;
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
  return { state, events, turns };
}

describe('probe', () => {
  it('counts reaction events across scenarios and seeds', () => {
    const totals = new Map<string, number>();
    let grand = 0;
    for (const sc of listScenarios()) {
      for (const seed of Array.from({length: 20}, (_, i) => i * 7717 + 1)) {
        const { events, state, turns } = playOut(sc.id, seed);
        let n = 0;
        for (const e of events) {
          if (e.kind === 'reaction') {
            n++; grand++;
            totals.set(e.ability, (totals.get(e.ability) ?? 0) + 1);
          }
        }
        console.log(`${sc.id} seed=${seed} phase=${state.phase} turns=${turns} events=${events.length} reactions=${n}`);
      }
    }
    console.log('TOTAL reactions:', grand);
    console.log('BY KIND:', JSON.stringify(Object.fromEntries([...totals].sort((a, b) => b[1] - a[1])), null, 1));
  });
});
