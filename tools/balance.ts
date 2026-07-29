#!/usr/bin/env vite-node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BALANCE_SEEDS,
  measureEncounterBalance,
  measureEncounterBalanceRow,
  renderBalanceTable,
} from '../tests/helpers/aiBattle';

const TABLE_START = '<!-- balance-table:start -->';
const TABLE_END = '<!-- balance-table:end -->';
const docsPath = fileURLToPath(new URL('../docs/BALANCE.md', import.meta.url));

const encounterFlag = process.argv.indexOf('--encounter');
const encounterId = encounterFlag >= 0 ? process.argv[encounterFlag + 1] : undefined;
if (encounterFlag >= 0 && !encounterId) {
  throw new Error('--encounter requires an encounter id');
}

const report = (row: ReturnType<typeof measureEncounterBalanceRow>) => {
  process.stderr.write(
    `[balance] ${row.encounterId}: wins=${row.playerWins}/${row.battles}, `
    + `turns=${row.medianTurns}, player-ko=${row.playerKnockdownBattles}/${row.battles}\n`,
  );
};
const rows = encounterId
  ? [measureEncounterBalanceRow(encounterId, BALANCE_SEEDS)]
  : measureEncounterBalance(BALANCE_SEEDS, report);
if (encounterId) report(rows[0]!);
const table = renderBalanceTable(rows);
const resolved = rows.reduce((total, row) => total + row.resolved, 0);
const battles = rows.reduce((total, row) => total + row.battles, 0);

console.log(table);
console.log(`[balance] encounters=${rows.length}, battles=${battles}, resolved=${resolved}`);

if (process.argv.includes('--check')) {
  if (encounterId) {
    throw new Error('--check requires the complete encounter set');
  }
  const docs = readFileSync(docsPath, 'utf8');
  const start = docs.indexOf(TABLE_START);
  const end = docs.indexOf(TABLE_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Missing balance table markers in ${docsPath}`);
  }
  const documented = docs.slice(start + TABLE_START.length, end).trim();
  if (documented !== table) {
    process.stderr.write('[balance] docs/BALANCE.md table does not match the measured rows\n');
    process.exitCode = 1;
  } else {
    process.stderr.write('[balance] docs/BALANCE.md table matches all measured rows\n');
  }
}
