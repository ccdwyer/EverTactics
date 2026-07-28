import { createAiWorld, decideTurn } from '../../src/core/ai';
import { IllegalCommandError, advance, applyCommand, evaluateObjective } from '../../src/core/battle';
import { stockAwareWorld } from '../../src/core/inventory';
import type { BattleEvent, BattleState } from '../../src/core/types';
import { ALL_ABILITIES, ALL_ITEMS } from '../../src/state/content';
import { buildScenario, getScenario } from '../../src/state/scenarios';

function isFinished(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

/** Run an AI-vs-AI battle and collect every event it produced. */
export function runAiBattle(
  seed: number,
  scenarioId = 'battle-open',
  productionAi = false,
  maxTurns = 400,
  collectEvents = true,
) {
  const built = buildScenario({ ...getScenario(scenarioId), seed });
  const state = built.state;
  const world = productionAi
    ? stockAwareWorld(createAiWorld({ abilities: ALL_ABILITIES, items: ALL_ITEMS }))
    : undefined;
  const events: BattleEvent[] = [];
  let commands = 0;
  let rejectedCommands = 0;
  let turns = 0;

  while (turns < maxTurns) {
    if (evaluateObjective(state)) break;
    if (isFinished(state)) break;

    let spins = 0;
    while (state.phase !== 'awaiting-command' && spins < 1000) {
      if (isFinished(state)) break;
      const advanced = advance(state);
      if (collectEvents) events.push(...advanced);
      spins++;
    }
    if (state.phase !== 'awaiting-command') break;

    const id = state.active;
    if (!id) break;

    const plan = productionAi
      ? decideTurn(state, id, {
          world: world!,
          personalities: built.personalities,
        })
      : decideTurn(state, id);
    for (const cmd of plan) {
      if (state.phase !== 'awaiting-command' || state.active !== id) break;
      commands++;
      try {
        const applied = applyCommand(state, cmd);
        if (collectEvents) events.push(...applied);
      } catch (error) {
        if (error instanceof IllegalCommandError) {
          rejectedCommands++;
          throw new Error(
            `AI proposed an illegal command in ${scenarioId}, seed ${seed}, turn ${turns}: ` +
              `${JSON.stringify(cmd)} — ${error.message}`,
          );
        }
        throw error;
      }
    }
    if (state.phase === 'awaiting-command' && state.active === id) {
      throw new Error(
        `AI plan did not close the turn in ${scenarioId}, seed ${seed}, turn ${turns}: ` +
          JSON.stringify(plan),
      );
    }
    turns++;
  }

  return { state, events, commands, rejectedCommands, turns };
}
