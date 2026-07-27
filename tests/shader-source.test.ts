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
