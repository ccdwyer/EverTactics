/**
 * Guard against the single most-repeated mistake on this project.
 *
 * Shader source lives in tagged template literals:
 *
 *     const FRAG = `
 *       // Some explanation mentioning `uTone`   <-- THIS TERMINATES THE STRING
 *       float x = ...;
 *     `;
 *
 * A backtick inside a comment inside a template literal closes the literal. The
 * file then fails to parse, `tsc` reports a cascade of nonsense errors pointing
 * at identifiers that were never meant to be code, and `vite build` dies.
 *
 * This has happened FOUR separate times here, in backdrop.ts, terrain.ts,
 * materials/terrain.ts and materials/post/glsl.ts — once by the lead, three times
 * by different agents, each independently rediscovering it and losing time.
 *
 * `tsc` does catch it, but only as an unreadable pile of downstream errors. This
 * test names the cause on the offending line, which is the difference between a
 * five-second fix and a twenty-minute hunt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RENDER = resolve(__dirname, '../src/render');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Workflow scripts have the same hazard for the same reason: the fixer briefs are
 * long prose inside template literals. Scoping this guard to `src/render` only was
 * itself a mistake — within an hour of adding it, the same bug was reintroduced in
 * `tools/workflows/polish-round.js`, which the guard did not cover.
 */
const WORKFLOWS = resolve(__dirname, '../tools/workflows');

describe('workflow scripts', () => {
  it('parse — no backticks stranded inside brief template literals', async () => {
    const { execFileSync } = await import('node:child_process');
    for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.js'))) {
      const full = join(WORKFLOWS, file);
      // A workflow script uses top-level await and a bare `return`, so wrap it in
      // an async function before asking node to parse it.
      const src = readFileSync(full, 'utf8').replace(/^export const meta/m, 'const meta');
      const wrapped =
        'async function _w(){const args={},log=()=>{},phase=()=>{},' +
        'agent=async()=>({}),parallel=async()=>[],pipeline=async()=>[];\n' +
        src +
        '\n}';
      expect(() => {
        execFileSync('node', ['--check', '/dev/stdin'], { input: wrapped, stdio: 'pipe' });
      }, `${file} does not parse — usually a backtick inside a brief template literal`).not.toThrow();
    }
  });
});

describe('shader sources', () => {
  it('has no backticks in comment lines', () => {
    const offences: string[] = [];

    for (const file of tsFiles(RENDER)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Pure comment lines only — a backtick in real code is fine.
        if (!/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!line.includes('`')) return;
        offences.push(
          `${file.replace(RENDER, 'src/render')}:${i + 1}  ${line.trim().slice(0, 90)}`,
        );
      });
    }

    expect(
      offences,
      'Backticks in a comment inside a GLSL template literal terminate the string and break the ' +
        'build. Use single quotes in shader-file comments. Offending lines:\n' + offences.join('\n'),
    ).toEqual([]);
  });
});
