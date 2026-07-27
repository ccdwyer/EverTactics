/**
 * Sanity-checks the job tables: structural validation, tree validation, and that every
 * sprite key referenced by a job, pet or stance resolves to a real sheet in public/assets
 * that is actually *usable* — not one of the 22 broken rips.
 *
 * File existence alone is not enough. The WotL sheets 1110-1130 exist on disk but are
 * 18-pixel grey noise strips with no artwork, and the manifest flags them `broken: true`
 * (see docs/ASSETS.md §1.2). A job pointing at one renders nothing at all, so both checks
 * run here: the file is on disk, and the manifest says there is art inside it.
 *
 * Run: node --experimental-strip-types --import ./tools/ts-ext-hook-register.mjs tools/check-jobs.mts
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { validateJobs, JOBS, allJobs, JOB_MECHANICS } from '../src/core/jobs/index';
import { validateTree } from '../src/core/jobs/tree';

const dir = new URL('../public/assets/sprites/', import.meta.url);
const sheets = new Set(readdirSync(dir).map((f) => f.replace(/\.png$/, '')));

/**
 * Job sprite keys are filename stems (`1000_Knight_Male_hd`); manifest sheet keys are
 * slugs (`knight_male`). The leading sprite number is what joins them, via `byNumber`.
 */
interface Manifest {
  sheets: Record<string, { broken?: boolean; poses?: unknown[] }>;
  byNumber: Record<string, string>;
}

const manifestUrl = new URL('../public/assets/manifest.json', import.meta.url);
const manifest: Manifest | undefined = existsSync(manifestUrl)
  ? (JSON.parse(readFileSync(manifestUrl, 'utf8')) as Manifest)
  : undefined;

/** `undefined` when the sheet is fine; otherwise why it is not usable. */
function unusable(spriteKey: string): string | undefined {
  if (manifest === undefined) return undefined; // pipeline has not run; existence check stands alone
  const number = /^(\d+)_/.exec(spriteKey)?.[1];
  if (number === undefined) return undefined;
  const sheetKey = manifest.byNumber[number];
  if (sheetKey === undefined) return `sprite ${number} is absent from the manifest`;
  const entry = manifest.sheets[sheetKey];
  if (entry === undefined) return `manifest has no sheet "${sheetKey}"`;
  if (entry.broken === true) return `sheet "${sheetKey}" is flagged broken in the manifest`;
  if ((entry.poses?.length ?? 0) === 0) return `sheet "${sheetKey}" has no whole-body pose frames`;
  return undefined;
}

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
  if (!sheets.has(key)) {
    problems.push(`${who}: sprite sheet "${key}.png" does not exist`);
    continue;
  }
  const why = unusable(key);
  if (why !== undefined) problems.push(`${who}: sprite sheet "${key}" is unusable — ${why}`);
}

console.log(`jobs: ${JOBS.size}, sprite refs checked: ${keys.length}`);
if (problems.length === 0) {
  console.log('OK — job tables are coherent.');
} else {
  for (const p of problems) console.error('FAIL ' + p);
  process.exitCode = 1;
}
