/**
 * Content integrity.
 *
 * 34 jobs and hundreds of abilities are authored by hand across several files, and every one of
 * them names a sprite sheet, an ability set, prerequisite jobs, and formula ids. Data rot in that
 * web is silent — a job whose sprite key is a typo simply renders nothing, and a job that requires
 * a job that does not exist is unreachable forever.
 *
 * These tests make that class of mistake loud.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  JOBS,
  allJobs,
  jobsByOrigin,
  validateJobs,
  totalJpToMaster,
} from '../src/core/jobs';
import {
  ABILITIES,
  getAbility,
  abilitiesInSet,
  validateAbilities,
} from '../src/core/abilities';
import { bootstrapContent } from '../src/state/content';

bootstrapContent();

const REPO = resolve(__dirname, '..');

describe('job roster', () => {
  it('passes its own validator', () => {
    expect(validateJobs()).toEqual([]);
  });

  it('has the full canonical Final Fantasy Tactics roster', () => {
    const fft = jobsByOrigin('fft').map((j) => j.id);
    for (const expected of [
      'squire', 'chemist', 'knight', 'archer', 'monk', 'thief',
      'white-mage', 'black-mage', 'time-mage', 'summoner', 'mystic',
      'geomancer', 'dragoon', 'orator', 'samurai', 'ninja',
      'arithmetician', 'bard', 'dancer', 'mime', 'dark-knight', 'onion-knight',
    ]) {
      expect(fft, `missing FFT job ${expected}`).toContain(expected);
    }
  });

  it('adds jobs drawn from EverQuest 2 and World of Warcraft', () => {
    expect(jobsByOrigin('eq2').length).toBeGreaterThanOrEqual(6);
    expect(jobsByOrigin('wow').length).toBeGreaterThanOrEqual(6);
  });

  it('gives every job a sprite sheet that is present AND actually usable', () => {
    // 22 sheets in the rip are broken stubs — 18-pixel noise strips with no art
    // (the WotL-exclusive jobs among them). A job pointed at one of those renders
    // nothing on the battlefield, so "the file exists" is not a sufficient check:
    // the sheet must be unbroken and must yield whole-body pose frames.
    const manifestPath = resolve(REPO, 'public/assets/manifest.json');
    expect(existsSync(manifestPath), 'run `npm run assets` to build the manifest').toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      sheets: Record<string, { broken?: boolean; poses?: unknown[]; files?: string[] }>;
    };

    /** Job sprite keys are file basenames; manifest keys are slugs. Match either. */
    const lookup = (key: string) => {
      const direct = manifest.sheets[key];
      if (direct) return direct;
      const needle = `${key}.png`;
      for (const entry of Object.values(manifest.sheets)) {
        if (entry.files?.some((f) => f.endsWith(needle))) return entry;
      }
      return undefined;
    };

    const bad: string[] = [];
    for (const job of allJobs()) {
      for (const key of [job.sprite.male, job.sprite.female]) {
        if (!key) {
          bad.push(`${job.id}: empty sprite key`);
          continue;
        }
        const entry = lookup(key);
        if (!entry) {
          bad.push(`${job.id}: "${key}" is not in the sprite manifest`);
        } else if (entry.broken) {
          bad.push(`${job.id}: "${key}" is a broken rip with no artwork`);
        } else if (!entry.poses || entry.poses.length === 0) {
          bad.push(`${job.id}: "${key}" yields no whole-body pose frames`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('only requires jobs that exist, and has no circular prerequisites', () => {
    for (const job of allJobs()) {
      for (const req of job.requires) {
        expect(JOBS.has(req.job), `${job.id} requires unknown job ${req.job}`).toBe(true);
        expect(req.job, `${job.id} requires itself`).not.toBe(job.id);
        expect(req.level).toBeGreaterThan(0);
        expect(req.level).toBeLessThanOrEqual(8);
      }
    }

    // Walk the requirement graph from every job; a cycle would never terminate.
    const seenDepth = new Map<string, number>();
    const depthOf = (id: string, stack: string[] = []): number => {
      expect(stack.includes(id), `circular job requirement: ${[...stack, id].join(' -> ')}`).toBe(false);
      const cached = seenDepth.get(id);
      if (cached !== undefined) return cached;
      const job = JOBS.get(id);
      const d = !job || job.requires.length === 0
        ? 0
        : 1 + Math.max(...job.requires.map((r) => depthOf(r.job, [...stack, id])));
      seenDepth.set(id, d);
      return d;
    };
    for (const job of allJobs()) depthOf(job.id);
  });

  it('has at least one job reachable with no prerequisites', () => {
    const starters = allJobs().filter((j) => j.requires.length === 0);
    expect(starters.length).toBeGreaterThan(0);
    expect(starters.map((j) => j.id)).toContain('squire');
  });

  it('gives every job sane movement and mastery cost', () => {
    for (const job of allJobs()) {
      expect(job.move, `${job.id} move`).toBeGreaterThanOrEqual(1);
      expect(job.move, `${job.id} move`).toBeLessThanOrEqual(6);
      expect(job.jump, `${job.id} jump`).toBeGreaterThanOrEqual(1);
      expect(job.jump, `${job.id} jump`).toBeLessThanOrEqual(6);
      // Mime is the deliberate exception: in FFT it learns nothing at all, so
      // its mastery cost is legitimately zero.
      if (job.id !== 'mime') {
        expect(totalJpToMaster(job.id), `${job.id} mastery cost`).toBeGreaterThan(0);
      }
    }
  });

  it('teaches only abilities that exist', () => {
    const missing: string[] = [];
    for (const job of allJobs()) {
      for (const l of job.learnable) {
        if (!getAbility(l.ability)) missing.push(`${job.id} teaches unknown ability ${l.ability}`);
        if (l.jp <= 0) missing.push(`${job.id}: ${l.ability} costs ${l.jp} JP`);
      }
      for (const inn of job.innate) {
        if (!getAbility(inn)) missing.push(`${job.id} has unknown innate ${inn}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every job a non-empty action set with abilities in it', () => {
    const empty: string[] = [];
    for (const job of allJobs()) {
      if (!job.actionSet) {
        empty.push(`${job.id}: no action set`);
        continue;
      }
      if (abilitiesInSet(job.actionSet).length === 0) {
        empty.push(`${job.id}: action set "${job.actionSet}" is empty`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('has a portrait face family for every job', () => {
    // `JOB_FACE` in src/ui/portraits.ts is keyed by the job's DISPLAY NAME
    // lowercased ("white mage"), not its kebab id ("white-mage"), because that
    // is what `viewModels.portraitFor` passes. A job with no entry silently
    // falls through to a hashed generic face, which is how the turn rail ended
    // up showing a lizard and a goat beside twelve human sprites.
    //
    // This is asserted at source level rather than by importing the module,
    // because portraits.ts pulls in DOM helpers that do not exist under node.
    const src = readFileSync(resolve(REPO, 'src/ui/portraits.ts'), 'utf8');
    const block = /const JOB_FACE[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(block, 'could not find the JOB_FACE table').not.toBeNull();

    // Keys are a mix of quoted multi-word names and bare identifiers. Matching
    // only the bare ones is an easy mistake that makes the table look 6 entries
    // short — count both.
    const keys = new Set(
      [...block![1]!.matchAll(/^\s*(?:['"]([^'"]+)['"]|([A-Za-z_][A-Za-z0-9_]*))\s*:/gm)]
        .map((m) => (m[1] ?? m[2] ?? '').toLowerCase()),
    );

    const missing = allJobs()
      .map((j) => j.name.toLowerCase())
      .filter((name) => !keys.has(name));

    expect(missing, `jobs with no portrait family: ${missing.join(', ')}`).toEqual([]);
  });

  it('writes real prose for every job', () => {
    for (const job of allJobs()) {
      expect(job.name.length, `${job.id} name`).toBeGreaterThan(2);
      expect(job.blurb.length, `${job.id} blurb`).toBeGreaterThan(10);
      expect(job.description.length, `${job.id} description`).toBeGreaterThan(40);
    }
  });
});

describe('ability database', () => {
  it('passes its own validator', () => {
    expect(validateAbilities()).toEqual([]);
  });

  it('is substantial', () => {
    expect(ABILITIES.size).toBeGreaterThan(200);
  });

  it('gives every ability coherent numbers', () => {
    const bad: string[] = [];
    for (const a of ABILITIES.values()) {
      if (a.mp < 0) bad.push(`${a.id}: negative MP`);
      if (a.ct < 0) bad.push(`${a.id}: negative CT`);
      if (a.accuracy < 0 || a.accuracy > 100) bad.push(`${a.id}: accuracy ${a.accuracy}`);
      if (a.range.range < 0) bad.push(`${a.id}: negative range`);
      if (a.range.radius < 0) bad.push(`${a.id}: negative radius`);
      if (!a.name || a.name.length < 2) bad.push(`${a.id}: no name`);
      if (!a.description || a.description.length < 10) bad.push(`${a.id}: no description`);
      if (!a.vfx) bad.push(`${a.id}: no vfx key`);
    }
    expect(bad).toEqual([]);
  });

  it('has no duplicate ability ids', () => {
    const ids = [...ABILITIES.values()].map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every ability slot', () => {
    const slots = new Set([...ABILITIES.values()].map((a) => a.slot));
    for (const s of ['action', 'reaction', 'support', 'movement']) {
      expect(slots, `no abilities in slot ${s}`).toContain(s);
    }
  });

  it('references only statuses the engine knows', async () => {
    const { STATUSES } = await import('../src/core/combat/status');
    const bad: string[] = [];
    for (const a of ABILITIES.values()) {
      for (const inf of a.inflicts ?? []) {
        if (!STATUSES.has(inf.status)) bad.push(`${a.id} inflicts unknown status ${inf.status}`);
        if (inf.chance <= 0 || inf.chance > 100) bad.push(`${a.id}: ${inf.status} chance ${inf.chance}`);
      }
      for (const cure of a.cures ?? []) {
        if (!STATUSES.has(cure)) bad.push(`${a.id} cures unknown status ${cure}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
