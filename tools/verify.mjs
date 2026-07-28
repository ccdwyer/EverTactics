#!/usr/bin/env node
/**
 * One command that establishes ground truth.
 *
 * A new session (or a returning one after a usage-limit reset) should be able to run this and know
 * exactly where the project stands without re-deriving anything: does it compile, do the tests
 * pass, does it render, and how does the frame measure against the reference corpus.
 *
 * Deliberately renders against a STATIC BUILD, not the dev server. Vite's HMR reloads the page on
 * any file save, which returns it to the boot splash after the harness has already seen it clear —
 * that produced black "successful" screenshots more than once.
 *
 * Appends every run to docs/metrics-history.jsonl so progress is a trend, not a memory.
 *
 * Usage:
 *   node tools/verify.mjs              # full: typecheck, tests, build, shoot, measure
 *   node tools/verify.mjs --quick      # skip the build+render, just typecheck and tests
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

const quick = process.argv.includes('--quick');
const PORT = 4173;

/**
 * Run a command with an argument array — no shell, so nothing here can be
 * reinterpreted as shell syntax. Every invocation below is a constant, but
 * spawning through a shell is a habit worth not forming in a tool that will
 * grow arguments later.
 */
const run = (file, args = []) => {
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const result = { at: new Date().toISOString() };

// ── 1. Typecheck ────────────────────────────────────────────────────────────
process.stderr.write('typecheck... ');
const tsc = run('npx', ['tsc', '--noEmit']);
const tscErrors = (tsc.out.match(/error TS/g) ?? []).length;
result.typecheck = { pass: tsc.ok && tscErrors === 0, errors: tscErrors };
process.stderr.write(result.typecheck.pass ? 'clean\n' : `${tscErrors} errors\n`);
if (!result.typecheck.pass) {
  // Agents editing concurrently produce transient errors. Show them; do not hide them.
  result.typecheck.sample = tsc.out.split('\n').filter((l) => l.includes('error TS')).slice(0, 8);
}

// ── 2. Tests ────────────────────────────────────────────────────────────────
process.stderr.write('tests... ');
const vitest = run('npx', ['vitest', 'run', '--reporter=dot']);
const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(vitest.out);
result.tests = {
  pass: vitest.ok,
  passed: m ? Number(m[2]) : 0,
  failed: m && m[1] ? Number(m[1]) : 0,
};
process.stderr.write(`${result.tests.passed} passed, ${result.tests.failed} failed\n`);

if (quick) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.typecheck.pass && result.tests.pass ? 0 : 1);
}

// ── 3. Build + render + measure ─────────────────────────────────────────────
process.stderr.write('build... ');
const build = run('npx', ['vite', 'build']);
result.build = { pass: build.ok };
process.stderr.write(build.ok ? 'ok\n' : 'FAILED\n');

if (build.ok) {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: true,
  });
  try {
    // wait for the preview server
    const deadline = Date.now() + 30000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const r = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1000) });
        up = r.ok;
      } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 400));
    }

    process.stderr.write('render... ');
    const shot = run('node', [
      'tools/shoot.mjs',
      '--scene',
      'battle-open',
      '--port',
      String(PORT),
      '--out',
      'shots/verify.png',
      '--wait',
      '60000',
    ]);
    let shotJson = null;
    try {
      shotJson = JSON.parse(shot.out.slice(shot.out.indexOf('{'), shot.out.lastIndexOf('}') + 1));
    } catch { /* leave null */ }
    result.render = {
      pass: shotJson?.ok === true,
      brokenMaterials: shotJson?.brokenMaterials ?? [],
      consoleErrors: (shotJson?.errors ?? []).length,
    };
    process.stderr.write(result.render.pass ? 'ok\n' : 'FAILED\n');

    if (existsSync('shots/verify.png')) {
      process.stderr.write('measure... ');
      const met = run('node', ['tools/metrics.mjs', 'shots/verify.png']);
      try {
        const j = JSON.parse(met.out.slice(met.out.indexOf('{'), met.out.lastIndexOf('}') + 1));
        result.metrics = j.metrics;
        result.gates = Object.fromEntries(j.gates.map((g) => [g.key, g.pass]));
        result.gatesPass = j.gates.every((g) => g.pass);
      } catch { /* leave undefined */ }
      process.stderr.write(result.gatesPass ? 'all gates pass\n' : 'gate failure\n');
    }
  } finally {
    try { process.kill(-preview.pid); } catch { /* already gone */ }
  }
}

// ── 4. Record the trend ─────────────────────────────────────────────────────
appendFileSync('docs/metrics-history.jsonl', JSON.stringify(result) + '\n');

console.log(JSON.stringify(result, null, 2));

const green =
  result.typecheck.pass
  && result.tests.pass
  && (quick || (result.build.pass && result.render?.pass && result.gatesPass === true));
process.exit(green ? 0 : 1);
