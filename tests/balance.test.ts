import { describe, expect, it } from 'vitest';

import { ENCOUNTERS } from '../src/content/encounters';
import {
  BALANCE_SEEDS,
  balanceScenarioId,
  measureEncounterBalanceRow,
  renderBalanceTable,
} from './helpers/aiBattle';

describe('campaign encounter balance', () => {
  it('uses twelve unique deterministic seeds', () => {
    expect(BALANCE_SEEDS).toHaveLength(12);
    expect(new Set(BALANCE_SEEDS).size).toBe(BALANCE_SEEDS.length);
    expect(BALANCE_SEEDS.every(Number.isInteger)).toBe(true);
  });

  it('maps every encounter to its intended scenario', () => {
    expect(
      Object.values(ENCOUNTERS).map((encounter) => [
        encounter.id,
        balanceScenarioId(encounter.id),
      ]),
    ).toEqual([
      ['orbonne-vanguard', 'battle-open'],
      ['first-lesson', 'first-lesson'],
      ['mandalia-skirmish', 'mandalia-skirmish'],
      ['gariland-bridge', 'gariland-bridge'],
      ['zeirchele-charge', 'zeirchele-charge'],
      ['lionel-gate', 'lionel-gate'],
      ['dorter-storehouse', 'dorter-storehouse'],
      ['mandalia-ambush', 'mandalia-ambush'],
      ['orbonne-return', 'orbonne-return'],
      ['lionel-reckoning', 'lionel-reckoning'],
    ]);
  });

  it('keeps First Watch short but capable of knocking out player units', () => {
    const row = measureEncounterBalanceRow('first-lesson');
    expect(row.resolved).toBe(BALANCE_SEEDS.length);
    expect(row.playerWins).toBe(BALANCE_SEEDS.length);
    expect(row.playerKnockdownBattles).toBeGreaterThanOrEqual(3);
    expect(row.medianTurns).toBeLessThanOrEqual(40);
  }, 30_000);

  it('keeps Reckoning dangerous but demonstrably winnable', () => {
    const row = measureEncounterBalanceRow('lionel-reckoning');
    expect(row.resolved).toBe(BALANCE_SEEDS.length);
    expect(row.playerWins).toBeGreaterThanOrEqual(3);
    expect(row.playerWins).toBeLessThan(BALANCE_SEEDS.length);
    expect(row.playerKnockdownBattles).toBe(BALANCE_SEEDS.length);
  }, 30_000);

  it('renders stable Markdown rows for the checked balance document', () => {
    expect(renderBalanceTable([
      {
        encounterId: 'example',
        encounterName: 'Example',
        chapter: 2,
        battles: 12,
        resolved: 12,
        playerWins: 4,
        playerWinRate: 1 / 3,
        medianTurns: 64,
        medianSurvivingPlayersOnWin: 3,
        playerKnockdownBattles: 12,
        playerKnockdownRate: 1,
      },
    ])).toContain('| 2 | Example | 4/12 (33.3%) | 64 | 3 | 12/12 (100%) |');
  });
});
