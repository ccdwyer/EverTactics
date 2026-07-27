#!/usr/bin/env node
/**
 * Audit which effect each ability actually plays.
 *
 * The VFX system registers a small set of archetypes; the ability table authors
 * path-style keys ("black/fire", "white/cure"). Mapping many abilities onto few
 * archetypes is the intended design — 340 bespoke effects is not a thing anyone
 * should build. What this checks is that the mapping is SENSIBLE: that a Fire
 * spell plays fire, not a generic flash.
 *
 * Mirrors `resolveVfxKey` in src/state/game.ts. If that changes, change this.
 *
 * Usage: node tools/vfx-audit.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';

/** Brace-depth scan: only depth-1 keys are effect names, not nested params. */
function topLevelKeys(source, declaration) {
  const i = source.indexOf(declaration);
  if (i < 0) return [];
  const start = source.indexOf('{', i);
  const keys = [];
  let depth = 0;
  let line = '';
  for (let p = start; p < source.length; p++) {
    const c = source[p];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    line += c;
    if (c === '\n') {
      const m = /^\s*(?:['"]([^'"]+)['"]|([A-Za-z_][\w-]*))\s*:/.exec(line);
      if (m) keys.push(m[1] ?? m[2]);
      line = '';
    }
  }
  return keys;
}

const vfxSrc = readFileSync('src/render/vfx.ts', 'utf8');
const registered = new Set(topLevelKeys(vfxSrc, 'const EFFECTS'));

const gameSrc = readFileSync('src/state/game.ts', 'utf8');
const elementMap = Object.fromEntries(
  [...(/const ELEMENT_VFX[^=]*=\s*\{([\s\S]*?)\n\};/.exec(gameSrc)?.[1] ?? '')
    .matchAll(/^\s*([a-z]+)\s*:\s*'([^']+)'/gm)].map((m) => [m[1], m[2]]),
);

const FORMULA_VFX = {
  heal: 'heal-sparkle',
  buff: 'buff-aura',
  'status-only': 'debuff-drip',
  summon: 'summon-circle',
  raise: 'holy-pillar',
  magical: 'impact-flash',
  drain: 'impact-flash',
};

const abilities = [];
for (const f of readdirSync('src/core/abilities')) {
  if (!f.endsWith('.ts')) continue;
  const src = readFileSync(`src/core/abilities/${f}`, 'utf8');
  for (const m of src.matchAll(
    /id:\s*'([^']+)'[\s\S]{0,2500}?element:\s*'([^']+)'[\s\S]{0,2500}?formula:\s*'([^']+)'[\s\S]{0,2500}?vfx:\s*'([^']+)'/g,
  )) {
    abilities.push({ id: m[1], element: m[2], formula: m[3], vfx: m[4] });
  }
}

const resolve = (a) => {
  if (registered.has(a.vfx)) return { key: a.vfx, via: 'exact' };
  const tail = a.vfx.split('/').pop() ?? '';
  if (registered.has(tail)) return { key: tail, via: 'path-tail' };
  if (a.element !== 'none') {
    const byEl = elementMap[a.element];
    if (byEl && registered.has(byEl)) return { key: byEl, via: 'element' };
  }
  return { key: FORMULA_VFX[a.formula] ?? 'slash-arc', via: 'formula' };
};

const byVia = {};
const byKey = {};
const elementalGeneric = [];
for (const a of abilities) {
  const r = resolve(a);
  byVia[r.via] = (byVia[r.via] ?? 0) + 1;
  byKey[r.key] = (byKey[r.key] ?? 0) + 1;
  // The thing that actually matters: an elemental ability that does not play
  // its element.
  if (a.element !== 'none' && r.via === 'formula') elementalGeneric.push(a.id);
}

console.log(JSON.stringify({
  registeredArchetypes: registered.size,
  abilities: abilities.length,
  resolvedVia: byVia,
  effectUsage: Object.fromEntries(Object.entries(byKey).sort((a, b) => b[1] - a[1])),
  elementalAbilitiesPlayingGenericEffect: elementalGeneric.length,
  examples: elementalGeneric.slice(0, 12),
}, null, 2));

if (elementalGeneric.length > 0) {
  console.error(`\n${elementalGeneric.length} elemental abilities do not play their element.`);
  process.exit(1);
}
