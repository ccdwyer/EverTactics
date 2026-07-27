/**
 * Sanity-checks the job tables: structural validation, tree validation, and that every
 * sprite key referenced by a job, pet or stance resolves to a real sheet in public/assets.
 *
 * Run: node --experimental-strip-types --import ./tools/ts-ext-hook-register.mjs tools/check-jobs.mts
 */
import { readdirSync, existsSync } from 'node:fs';
import { validateJobs, JOBS, allJobs, JOB_MECHANICS } from '../src/core/jobs/index';
import { validateTree } from '../src/core/jobs/tree';

const dir = new URL('../public/assets/sprites/', import.meta.url);
const sheets = new Set(readdirSync(dir).map((f) => f.replace(/\.png$/, '')));

const problems = [...validateJobs(), ...validateTree()];
const keys: [string, string][] = [];
for (const job of allJobs()) {
  keys.push([job.id + '.male', job.sprite.male], [job.id + '.female', job.sprite.female]);
}
for (const m of JOB_MECHANICS.values()) {
  for (const p of m.pets) keys.push([`${m.job}.pet.${p.id}`, p.sprite]);
  for (const s of m.stances) {
    if (s.sprite) keys.push([`${m.job}.${s.id}.male`, s.sprite.male], [`${m.job}.${s.id}.female`, s.sprite.female]);
  }
}
for (const [who, key] of keys) {
  if (!sheets.has(key)) problems.push(`${who}: sprite sheet "${key}.png" does not exist`);
}

console.log(`jobs: ${JOBS.size}, sprite refs checked: ${keys.length}`);
if (problems.length === 0) {
  console.log('OK — job tables are coherent.');
} else {
  for (const p of problems) console.error('FAIL ' + p);
  process.exitCode = 1;
}
