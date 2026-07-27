#!/usr/bin/env node
/**
 * Delegate a task to Grok 4.5, have GPT-5.6 Sol review it, and loop until Sol passes.
 *
 * The point is to move work off the Claude session's token budget. Claude writes the brief and
 * reads the final verdict; everything in between runs on other providers' quota.
 *
 * Both CLIs are already authenticated on this machine:
 *   grok  -p "<prompt>"   -> Grok 4.5 (xAI), headless single-turn
 *   codex exec "<prompt>" -> model from ~/.codex/config.toml (currently gpt-5.6-sol)
 *
 * Usage:
 *   node tools/delegate.mjs --task "Fix X. Success is Y." --rounds 3
 *   node tools/delegate.mjs --task-file brief.md --rounds 2 --verify "npm run verify:quick"
 *
 * Every round: Grok implements -> repo verification runs -> Sol reviews the real diff -> if Sol
 * says PASS, stop; otherwise Sol's objections become Grok's next brief.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const taskFile = arg('task-file', '');
const task = taskFile ? readFileSync(taskFile, 'utf8') : arg('task', '');
const maxRounds = Number(arg('rounds', 3));
const verifyCmd = arg('verify', 'npm run verify:quick');
const logDir = arg('log', 'tools/_delegate');

if (!task) {
  console.error('FAIL: pass --task "..." or --task-file path');
  process.exit(2);
}
mkdirSync(logDir, { recursive: true });

const sh = (file, args, opts = {}) => {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 45 * 60 * 1000,
    ...opts,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** House rules that every delegated brief inherits. Hard-won; see docs/STATUS.md. */
const HOUSE_RULES = `
PROJECT RULES (non-negotiable, from docs/STATUS.md and CLAUDE.md):
- src/core/ must never import three.js. It is pure, deterministic, testable game logic.
- All randomness goes through the seeded Rng in src/core/types.ts. Never Math.random() in core.
  A battle must replay byte-identically from the same seed; there are tests asserting this.
- Commands in, events out: BattleState is mutated only by applyCommand, which returns BattleEvent[].
- NEVER put a backtick inside a comment in a shader file. Shader source lives in template literals
  and a backtick in a comment terminates the string. This has broken the build six times.
  Run: npx vitest run tests/shader-source.test.ts
- Render against a static build (vite build + vite preview), never the dev server. HMR reloads the
  page mid-capture and you will screenshot a boot splash.
- Verify by measuring, not by asserting. This project has recorded EIGHT separate occasions where a
  tool or agent reported success while silently doing nothing. If you claim something works, say
  which command you ran and what number it printed.
`.trim();

const buildPrompt = (round, feedback) => `
You are implementing a change in a TypeScript + Three.js tactical RPG.

Working directory: ${process.cwd()}

${HOUSE_RULES}

=== TASK ===
${task}
${feedback ? `\n=== REVIEWER OBJECTIONS FROM ROUND ${round - 1} — address every one ===\n${feedback}\n` : ''}
Implement it. Then run \`${verifyCmd}\` and make it pass before you finish.
Do not commit; leave changes in the working tree so they can be reviewed.
Report concisely: files changed, what you did, and the exact verification output you saw.
`.trim();

const reviewPrompt = (diffstat, diff, verifyOut) => `
You are reviewing another model's implementation. Be rigorous and specific; this project has a long
record of changes that looked right and did nothing.

=== THE TASK THEY WERE GIVEN ===
${task}

${HOUSE_RULES}

=== VERIFICATION OUTPUT (typecheck + tests, run after their changes) ===
${verifyOut.slice(-4000)}

=== DIFFSTAT ===
${diffstat}

=== DIFF ===
${diff.slice(0, 120000)}

Judge only what the diff actually does. Check specifically:
- Does it accomplish the stated task, or only appear to?
- Does it violate any project rule above (core purity, determinism, shader backticks)?
- Are there silent no-ops — a branch that can never be taken, a lookup that can never match, a
  feature added but never called? That class of bug has bitten this project repeatedly.
- Is anything asserted without evidence?

Respond with a first line of exactly PASS or FAIL, then your reasoning. Use FAIL if anything above
is wrong. Be concrete: name files and lines.
`.trim();

/**
 * Refuse to run on a dirty tree.
 *
 * The first live test of this harness diffed against HEAD while another agent was
 * concurrently editing src/render/. Grok made no changes at all, but the diff was
 * full of the other agent's work, so Sol reviewed someone else's code as though it
 * were Grok's — and quite correctly failed it for violating the single-file scope.
 * Attributing one worker's diff to another is worse than no review.
 */
const dirty = git('status', '--porcelain');
if (dirty) {
  console.error(
    'FAIL: working tree is dirty. This harness diffs against HEAD to show the reviewer what was\n' +
    'built, so any pre-existing change would be attributed to the builder. Commit or stash first.\n\n' +
    dirty.split('\n').slice(0, 15).join('\n'),
  );
  process.exit(3);
}

const before = git('rev-parse', 'HEAD');
let feedback = '';
let verdict = 'NO ROUNDS RUN';

for (let round = 1; round <= maxRounds; round++) {
  console.error(`\n── round ${round}/${maxRounds} · Grok 4.5 implementing ─────────────────`);
  const build = sh('grok', [
    '-p', buildPrompt(round, feedback),
    '--permission-mode', 'dontAsk',
    '--cwd', process.cwd(),
  ]);
  writeFileSync(`${logDir}/round${round}-grok.txt`, build.out);
  console.error(build.out.slice(-1500));

  console.error(`\n── round ${round} · verifying ───────────────────────────────────`);
  const verify = sh('sh', ['-c', verifyCmd]);
  writeFileSync(`${logDir}/round${round}-verify.txt`, verify.out);
  console.error(verify.ok ? 'verification PASSED' : 'verification FAILED');

  const diff = git('diff', before);
  const diffstat = git('diff', '--stat', before);
  if (!diff.trim()) {
    verdict = 'FAIL — Grok produced no changes';
    console.error(verdict);
    break;
  }

  console.error(`\n── round ${round} · GPT-5.6 Sol reviewing ──────────────────────`);
  const review = sh('codex', ['exec', reviewPrompt(diffstat, diff, verify.out)]);
  writeFileSync(`${logDir}/round${round}-sol.txt`, review.out);
  console.error(review.out.slice(-2500));

  // Sol's verdict is the first PASS/FAIL token in its output.
  const m = /\b(PASS|FAIL)\b/.exec(review.out);
  verdict = m ? m[1] : 'UNCLEAR';

  if (verdict === 'PASS' && verify.ok) {
    console.error(`\n✓ Sol passed it on round ${round}, and ${verifyCmd} is green.`);
    break;
  }
  feedback = review.out.slice(-6000);
  console.error(`\n✗ round ${round}: verdict=${verdict}, verify=${verify.ok ? 'ok' : 'failed'} — iterating`);
}

console.log(JSON.stringify({
  verdict,
  rounds: maxRounds,
  diffstat: git('diff', '--stat', before),
  logs: logDir,
}, null, 2));
