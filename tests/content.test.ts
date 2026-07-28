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
import { createHash } from 'node:crypto';
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
import {
  generateMap,
  listMaps,
  moveCostInto,
  reachableTiles,
  tileKey,
} from '../src/core/grid';
import { WORLD_NODES } from '../src/core/world';
import { bootstrapContent } from '../src/state/content';
import {
  ENCOUNTERS,
  SCENARIOS,
  getEncounter,
  getScenario,
} from '../src/state/scenarios';
import { runAiBattle } from './helpers/aiBattle';

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

describe('campaign map and encounter content', () => {
  it('builds every map with legal starts and raw enemy placements', () => {
    const maps = listMaps();
    expect(maps.length, 'v0.1 requires at least six authored maps').toBeGreaterThanOrEqual(6);

    for (const def of maps) {
      const field = generateMap(def.id);
      expect(field.width, `${def.id} width`).toBe(def.width);
      expect(field.height, `${def.id} height`).toBe(def.height);
      expect(field.tiles, `${def.id} tile count`).toHaveLength(def.width * def.height);

      for (const start of [...def.playerStarts, ...def.enemyStarts]) {
        const tile = field.tileAt(start.x, start.y);
        expect(tile, `${def.id} start ${tileKey(start.x, start.y)} is off-map`).toBeDefined();
        expect(tile?.passable, `${def.id} start ${tileKey(start.x, start.y)} is impassable`).toBe(true);
        expect(tile?.surface, `${def.id} start ${tileKey(start.x, start.y)} is void`).not.toBe('void');
        expect(
          tile === undefined ? Infinity : moveCostInto(tile),
          `${def.id} start ${tileKey(start.x, start.y)} is unreachable to a Move-3 unit`,
        ).toBeLessThanOrEqual(3);
      }
    }

    for (const encounter of Object.values(ENCOUNTERS)) {
      const field = generateMap(encounter.mapId);
      const roster = Object.values(SCENARIOS).find(
        (scenario) => scenario.encounterId === encounter.id,
      )?.units;
      expect(roster, `${encounter.id} has no assembled scenario roster`).toBeDefined();
      const ids = roster?.map((unit) => unit.id) ?? [];
      expect(new Set(ids).size, `${encounter.id} has duplicate unit ids`).toBe(ids.length);

      for (const enemy of encounter.enemies) {
        expect(enemy.team, `${encounter.id}: ${enemy.id} is not hostile`).toBe('enemy');
        expect(enemy.personality, `${encounter.id}: ${enemy.id} has no AI personality`).toBeTruthy();
        const tile = field.tileAt(enemy.at.x, enemy.at.y);
        const at = tileKey(enemy.at.x, enemy.at.y);
        expect(tile, `${encounter.id}: ${enemy.id} at ${at} is off-map`).toBeDefined();
        expect(tile?.passable, `${encounter.id}: ${enemy.id} at ${at} is impassable`).toBe(true);
        expect(tile?.surface, `${encounter.id}: ${enemy.id} at ${at} is void`).not.toBe('void');
      }
    }
  });

  it('resolves encounter maps and every world battle scenario', () => {
    const mapIds = new Set(listMaps().map((map) => map.id));
    const encounters = Object.values(ENCOUNTERS);
    expect(encounters.length, 'v0.1 requires 8-10 encounters').toBeGreaterThanOrEqual(8);
    expect(encounters.length, 'v0.1 requires 8-10 encounters').toBeLessThanOrEqual(10);

    for (const encounter of encounters) {
      expect(
        mapIds.has(encounter.mapId),
        `${encounter.id} points at missing map ${encounter.mapId}`,
      ).toBe(true);
    }

    const battleNodes = WORLD_NODES.filter((node) => node.kind === 'battle');
    expect(battleNodes.length, 'v0.1 requires 8-10 battles').toBeGreaterThanOrEqual(8);
    expect(battleNodes.length, 'v0.1 requires 8-10 battles').toBeLessThanOrEqual(10);

    for (const node of battleNodes) {
      expect(node.scenarioId, `${node.id} has no scenarioId`).toBeDefined();
      const scenario = node.scenarioId === undefined ? undefined : SCENARIOS[node.scenarioId];
      expect(scenario, `${node.id} points at missing scenario ${node.scenarioId}`).toBeDefined();
      expect(getScenario(node.scenarioId), `${node.id} getScenario lookup`).toBe(scenario);

      const encounter = getEncounter(node.scenarioId);
      expect(encounter, `${node.id} points at missing encounter ${node.scenarioId}`).toBeDefined();
      expect(encounter?.id, `${node.id} encounter id`).toBe(node.scenarioId);
      expect(scenario?.encounterId, `${node.id} scenario encounter id`).toBe(node.scenarioId);
    }
  });

  it('keeps each map in one Move-3 Jump-2 region excluding cost-4 deepwater', () => {
    for (const def of listMaps()) {
      const field = generateMap(def.id);
      const enterable = field.tiles.filter((tile) => moveCostInto(tile) <= 3);
      expect(enterable.length, `${def.id} has no Move-3-enterable tiles`).toBeGreaterThan(0);

      const first = enterable[0]!;
      const visited = new Set([tileKey(first.x, first.y)]);
      const pending = [first];
      while (pending.length > 0) {
        const from = pending.shift()!;
        const reach = reachableTiles(
          field,
          {
            pos: { x: from.x, y: from.y, z: from.height },
            team: 'player',
            stats: { move: 3, jump: 2 },
          },
          new Map(),
        );
        for (const node of reach.values()) {
          const tile = field.tileAt(node.pos.x, node.pos.y);
          if (tile === undefined || moveCostInto(tile) > 3) continue;
          const key = tileKey(tile.x, tile.y);
          if (visited.has(key)) continue;
          visited.add(key);
          pending.push(tile);
        }
      }

      const stranded = enterable
        .filter((tile) => !visited.has(tileKey(tile.x, tile.y)))
        .map((tile) => tileKey(tile.x, tile.y));
      expect(stranded, `${def.id} has stranded Move-3 Jump-2 regions`).toEqual([]);

      if (def.id === 'mandalia-plains') {
        const deepwater = field.tiles.filter((tile) => tile.surface === 'deepwater');
        expect(deepwater.length, 'Mandalia must retain authored deepwater').toBeGreaterThan(0);
        expect(deepwater.every((tile) => moveCostInto(tile) === 4)).toBe(true);
        expect(deepwater.every((tile) => !visited.has(tileKey(tile.x, tile.y)))).toBe(true);
      }
    }
  });

  it('preserves the two legacy Battlefield serialisations byte-for-byte', () => {
    const expected = {
      'orbonne-courtyard': {
        bytes: 20_840,
        sha256: '092a53f300c48a64b217488ac2e5b28b87dbfc18e69662ea481a211551d6a816',
      },
      'mandalia-plains': {
        bytes: 23_791,
        sha256: '9a497cd4977aa36b1f0614cdf3ddd4eb6d25e9ddada4074176b7ccbb41817635',
      },
    } as const;

    for (const [mapId, baseline] of Object.entries(expected)) {
      const serialised = JSON.stringify(generateMap(mapId));
      expect(Buffer.byteLength(serialised), `${mapId} serialised byte count`).toBe(baseline.bytes);
      expect(
        createHash('sha256').update(serialised).digest('hex'),
        `${mapId} serialised SHA-256`,
      ).toBe(baseline.sha256);
    }
  });

  it(
    'resolves every encounter across several seeds with zero rejected AI commands',
    () => {
      const seeds = [3, 17, 41] as const;
      const encounters = Object.values(ENCOUNTERS);
      let battles = 0;
      let commands = 0;
      let rejectedCommands = 0;

      for (const encounter of encounters) {
        const scenario = Object.values(SCENARIOS).find(
          (candidate) => candidate.encounterId === encounter.id,
        );
        expect(scenario, `${encounter.id} has no scenario`).toBeDefined();
        if (scenario === undefined) continue;

        for (const seed of seeds) {
          const result = runAiBattle(seed, scenario.id, true, 400, false);
          expect(result.turns, `${encounter.id} seed ${seed} hit the turn cap`).toBeLessThan(400);
          expect(
            ['victory', 'defeat'],
            `${encounter.id} seed ${seed} did not resolve`,
          ).toContain(result.state.phase);
          battles++;
          commands += result.commands;
          rejectedCommands += result.rejectedCommands;
        }
      }

      console.info(
        `[content] campaign sweep: maps=${listMaps().length}, ` +
          `encounters=${Object.keys(ENCOUNTERS).length}, battles=${battles}, ` +
          `commands=${commands}, rejected=${rejectedCommands}`,
      );
      expect(battles).toBe(encounters.length * seeds.length);
      expect(commands).toBeGreaterThan(0);
      expect(rejectedCommands).toBe(0);
    },
    90_000,
  );
});
