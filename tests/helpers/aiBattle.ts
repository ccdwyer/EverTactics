import { createAiWorld, decideTurn } from '../../src/core/ai';
import { IllegalCommandError, advance, applyCommand, evaluateObjective } from '../../src/core/battle';
import { stockAwareWorld } from '../../src/core/inventory';
import { isKO } from '../../src/core/unit';
import type { BattleEvent, BattleState } from '../../src/core/types';
import { ENCOUNTERS } from '../../src/content/encounters';
import { ALL_ABILITIES, ALL_ITEMS } from '../../src/state/content';
import {
  CAMPAIGN_START_SCENARIO_ID,
  buildScenario,
  campaignToBattle,
  getScenario,
  newGameCampaign,
  SCENARIOS,
  type BuiltScenario,
} from '../../src/state/scenarios';

export const BALANCE_SEEDS = [1, 3, 5, 8, 13, 17, 21, 34, 41, 55, 89, 144] as const;

export interface EncounterBalanceRow {
  readonly encounterId: string;
  readonly encounterName: string;
  readonly chapter: number;
  readonly battles: number;
  readonly resolved: number;
  readonly playerWins: number;
  readonly playerWinRate: number;
  readonly medianTurns: number;
  readonly medianSurvivingPlayersOnWin: number | null;
  readonly playerKnockdownBattles: number;
  readonly playerKnockdownRate: number;
}

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
  onEvents?: (events: readonly BattleEvent[], state: BattleState) => void,
) {
  const built = buildScenario({ ...getScenario(scenarioId), seed });
  return runBuiltAiBattle(
    seed,
    scenarioId,
    built,
    productionAi,
    maxTurns,
    collectEvents,
    onEvents,
  );
}

function runCampaignAiBattle(
  seed: number,
  scenarioId: string,
  onEvents?: (events: readonly BattleEvent[], state: BattleState) => void,
) {
  const starter = { ...getScenario(CAMPAIGN_START_SCENARIO_ID), seed };
  const campaign = newGameCampaign(starter, 0);
  const built = campaignToBattle(campaign, getScenario(scenarioId));
  return runBuiltAiBattle(seed, scenarioId, built, true, 400, false, onEvents);
}

function runBuiltAiBattle(
  seed: number,
  scenarioId: string,
  built: BuiltScenario,
  productionAi: boolean,
  maxTurns: number,
  collectEvents: boolean,
  onEvents?: (events: readonly BattleEvent[], state: BattleState) => void,
) {
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
      onEvents?.(advanced, state);
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
        onEvents?.(applied, state);
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

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/**
 * Run every authored encounter with production AI controlling both teams.
 *
 * This is a balance proxy, not a player-skill model. Its job is to expose
 * obviously free or impossible fights with repeatable numbers.
 */
export function measureEncounterBalance(
  seeds: readonly number[] = BALANCE_SEEDS,
  onRow?: (row: EncounterBalanceRow) => void,
): EncounterBalanceRow[] {
  const rows: EncounterBalanceRow[] = [];
  for (const encounter of Object.values(ENCOUNTERS)) {
    const row = measureEncounterBalanceRow(encounter.id, seeds);
    onRow?.(row);
    rows.push(row);
  }
  return rows;
}

/** Resolve authored encounters without depending on scenario-registry insertion order. */
export function balanceScenarioId(encounterId: string): string {
  return encounterId === 'orbonne-vanguard' ? 'battle-open' : encounterId;
}

/** Measure one authored encounter across the supplied deterministic seeds. */
export function measureEncounterBalanceRow(
  encounterId: string,
  seeds: readonly number[] = BALANCE_SEEDS,
): EncounterBalanceRow {
  const encounter = Object.values(ENCOUNTERS).find((candidate) => candidate.id === encounterId);
  if (encounter === undefined) {
    throw new Error(`Unknown encounter "${encounterId}"`);
  }
  const scenarioId = balanceScenarioId(encounter.id);
  const scenario = SCENARIOS[scenarioId];
  if (scenario?.encounterId !== encounter.id) {
    throw new Error(`No scenario assembles encounter "${encounter.id}"`);
  }

  const turns: number[] = [];
  const survivingPlayersOnWins: number[] = [];
  let resolved = 0;
  let playerWins = 0;
  let playerKnockdownBattles = 0;

  for (const seed of seeds) {
    let playerKnockedDown = false;
    const onEvents = (events: readonly BattleEvent[], state: BattleState) => {
      if (playerKnockedDown) return;
      playerKnockedDown = events.some(
        (event) =>
          event.kind === 'knockdown'
          && state.units.get(event.unit)?.team === 'player',
      );
    };
    const result = encounter.id === 'orbonne-vanguard'
      ? runAiBattle(seed, scenario.id, true, 400, false, onEvents)
      : runCampaignAiBattle(seed, scenario.id, onEvents);

    turns.push(result.turns);
    if (result.state.phase === 'victory' || result.state.phase === 'defeat') resolved++;
    if (result.state.phase === 'victory') {
      playerWins++;
      survivingPlayersOnWins.push(
        [...result.state.units.values()].filter(
          (unit) => unit.team === 'player' && !isKO(unit),
        ).length,
      );
    }
    if (playerKnockedDown) playerKnockdownBattles++;
  }

  const battles = seeds.length;
  return {
    encounterId: encounter.id,
    encounterName: encounter.name,
    chapter: encounter.chapter,
    battles,
    resolved,
    playerWins,
    playerWinRate: battles === 0 ? 0 : playerWins / battles,
    medianTurns: median(turns) ?? 0,
    medianSurvivingPlayersOnWin: median(survivingPlayersOnWins),
    playerKnockdownBattles,
    playerKnockdownRate: battles === 0 ? 0 : playerKnockdownBattles / battles,
  };
}

function formatRate(count: number, total: number): string {
  const percent = total === 0 ? 0 : (count / total) * 100;
  return `${count}/${total} (${percent.toFixed(1).replace(/\.0$/, '')}%)`;
}

/** Render the measured rows as the Markdown table checked into docs/BALANCE.md. */
export function renderBalanceTable(rows: readonly EncounterBalanceRow[]): string {
  const lines = [
    '| Ch. | Encounter | Player wins | Median turns | Median player survivors on win | Battles with a player KO |',
    '|---:|---|---:|---:|---:|---:|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.chapter} | ${row.encounterName} | `
      + `${formatRate(row.playerWins, row.battles)} | ${row.medianTurns} | `
      + `${row.medianSurvivingPlayersOnWin ?? '—'} | `
      + `${formatRate(row.playerKnockdownBattles, row.battles)} |`,
    );
  }
  return lines.join('\n');
}
