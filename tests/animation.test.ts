import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  decodeAll,
  decodeSeq,
  decodeShp,
  SEQ_OPS,
  SIZE_TABLE,
  toClip,
} from '../tools/decode-shp-seq.mjs';
import {
  decodedAnimationSet,
  defaultAnimationSet,
  SEQ_ANIM_INDEX,
  ShpLibrary,
  type DecodedAnimations,
} from '../src/render/animation';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = path.join(ROOT, 'assets-src', 'unit');
const ANIMATIONS = path.join(ROOT, 'public', 'assets', 'animations.json');

const decoded = decodeAll(UNIT_DIR);

/** Accessors that fail loudly rather than letting an absent file read as empty. */
function shp(key: string) {
  const file = decoded.shp[key];
  if (!file) throw new Error(`no SHP '${key}'`);
  return file;
}
function seq(key: string) {
  const file = decoded.seq[key];
  if (!file) throw new Error(`no SEQ '${key}'`);
  return file;
}
function anim(key: string, index: number) {
  const found = seq(key).anims.find((a) => a.index === index);
  if (!found) throw new Error(`no animation ${index} in '${key}'`);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHP container
// ─────────────────────────────────────────────────────────────────────────────

describe('SHP decoding', () => {
  it('decodes every shipped SHP file', () => {
    // 11 *_shp.bin files ship in assets-src/unit.
    expect(Object.keys(decoded.shp).sort()).toEqual([
      'arute', 'cyoko', 'eff1', 'eff2', 'kanzen', 'mon', 'other', 'type1', 'type2', 'wep1', 'wep2',
    ]);
  });

  it('finds the frame counts the pointer tables declare', () => {
    // These are the counts at which every non-zero frame pointer lands on an
    // exact record boundary — the property that pinned the data offset at 0x40A.
    expect(shp('type1').frameCount).toBe(182);
    expect(shp('type2').frameCount).toBe(199);
    expect(shp('cyoko').frameCount).toBe(101);
    expect(shp('mon').frameCount).toBe(207);
    expect(shp('other').frameCount).toBe(17);
    expect(shp('arute').frameCount).toBe(51);
    expect(shp('kanzen').frameCount).toBe(53);
  });

  it('reads the atk split point that switches to the sheet second half', () => {
    expect(shp('type1').atk).toBe(84);
    const low = shp('type1').frames.find((f) => f.index === 20);
    const high = shp('type1').frames.find((f) => f.index === 120);
    expect(low!.parts.every((p) => p.sy < 256)).toBe(true);
    expect(high!.parts.every((p) => p.sy >= 256)).toBe(true);
  });

  it('keeps every part inside the original SPR canvas', () => {
    for (const file of Object.values(decoded.shp)) {
      for (const frame of file.frames) {
        for (const part of frame.parts) {
          expect(part.sx).toBeGreaterThanOrEqual(0);
          expect(part.sy).toBeGreaterThanOrEqual(0);
          // Source x is a 5-bit tile field, so it can never exceed 31 tiles.
          expect(part.sx).toBeLessThanOrEqual(31 * 8);
          expect(part.w).toBeGreaterThan(0);
          expect(part.h).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives every size index a width and height in tiles', () => {
    for (let i = 0; i < 16; i++) {
      const entry = SIZE_TABLE[i]!;
      expect(entry, `size index ${i}`).toBeDefined();
      expect(entry[0]).toBeGreaterThan(0);
      expect(entry[1]).toBeGreaterThan(0);
    }
  });

  it('rejects a truncated file rather than inventing frames', () => {
    const buf = fs.readFileSync(path.join(UNIT_DIR, 'battle_type1_shp.bin')).subarray(0, 2048);
    const short = decodeShp(buf, 'type1');
    expect(short.frameCount).toBeLessThan(182);
    expect(short.warnings.some((w) => w.includes('out of range'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEQ container
// ─────────────────────────────────────────────────────────────────────────────

describe('SEQ decoding', () => {
  it('decodes every shipped SEQ file', () => {
    expect(Object.keys(decoded.seq).length).toBe(14);
  });

  it('reaches a terminator on the overwhelming majority of animations', () => {
    let total = 0;
    let terminated = 0;
    for (const file of Object.values(decoded.seq)) {
      total += file.animCount;
      terminated += file.anims.filter((a) => a.terminated).length;
    }
    // Measured: 2123 of 2134. The opcode arity table is transcribed from the
    // FFHacktics SEQ page; a regression here means an opcode length changed.
    expect(total).toBeGreaterThan(2000);
    expect(terminated / total).toBeGreaterThan(0.99);
  });

  it('covers every opcode the shipped files use', () => {
    for (const file of Object.values(decoded.seq)) {
      for (const entry of file.anims) {
        for (const op of entry.ops) {
          if (op.code === undefined) continue;
          expect(SEQ_OPS[op.code], `opcode 0x${op.code.toString(16)}`).toBeDefined();
        }
      }
    }
  });

  it('decodes the type1 walk cycle', () => {
    const walk = anim('type1', 6);
    const clip = toClip(walk);
    // Seven frames, symmetric about the middle, looping via IncrementLoop.
    expect(clip.frames).toEqual([10, 9, 10, 11, 12, 13, 12]);
    expect(clip.loop).toBe(true);
    expect(clip.durations).toHaveLength(7);
    for (const d of clip.durations) expect(d).toBeGreaterThan(0);
  });

  it('reads the same frames at different speeds for animations 6, 8 and 10', () => {
    const at = (i: number) => toClip(anim('type1', i));
    const six = at(6);
    const eight = at(8);
    const ten = at(10);
    expect(eight.frames).toEqual(six.frames);
    expect(ten.frames).toEqual(six.frames);
    const sum = (d: number[]) => d.reduce((a, b) => a + b, 0);
    // 8 is faster than 6, 10 is slower — the walk / run / slow-walk triple.
    expect(sum(eight.durations)).toBeLessThan(sum(six.durations));
    expect(sum(ten.durations)).toBeGreaterThan(sum(six.durations));
  });

  it('accumulates movement opcodes into per-frame offsets', () => {
    const clip = toClip(anim('type1', 12));
    // The idle bob alternates MoveUp1 / MoveDown1, so offsets must not all be 0.
    expect(clip.offsets.some(([, y]) => y !== 0)).toBe(true);
  });

  it('stops on an unknown opcode instead of running away', () => {
    const buf = Buffer.from(fs.readFileSync(path.join(UNIT_DIR, 'battle_type1_seq.bin')));
    const parsed = decodeSeq(buf, 'type1');
    for (const entry of parsed.anims) expect(entry.ops.length).toBeLessThanOrEqual(512);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

describe('ShpLibrary', () => {
  const json = JSON.parse(fs.readFileSync(ANIMATIONS, 'utf8')) as DecodedAnimations;

  it('is generated and self-describing', () => {
    expect(json.version).toBe(1);
    expect(json.hdScale).toBe(2);
    expect(json.tile).toBe(8);
  });

  it('loads a sprite type', () => {
    const lib = ShpLibrary.fromJson(json, 'type1', 'type1');
    expect(lib).not.toBeNull();
    expect(lib!.frameCount).toBe(182);
    expect(lib!.clipCount).toBeGreaterThan(200);
  });

  it('returns null for a type the rip does not carry', () => {
    expect(ShpLibrary.fromJson(json, 'nope', 'nope')).toBeNull();
  });

  it('assembles a walk cycle into frames made of parts', () => {
    const lib = ShpLibrary.fromJson(json, 'type1', 'type1')!;
    const frames = lib.assemble(SEQ_ANIM_INDEX.walk!);
    expect(frames).toHaveLength(7);
    for (const frame of frames) {
      expect(frame.parts).toBeDefined();
      expect(frame.parts!.length).toBeGreaterThan(0);
      for (const part of frame.parts!) {
        expect(part.w).toBeGreaterThan(0);
        expect(part.h).toBeGreaterThan(0);
      }
    }
  });

  it('assembles the chocobo, which has no whole-body pose frames at all', () => {
    const lib = ShpLibrary.fromJson(json, 'cyoko', 'cyoko')!;
    const frames = lib.assemble(6);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.parts!.length).toBeGreaterThan(1);
  });

  it('reports completeness honestly', () => {
    const lib = ShpLibrary.fromJson(json, 'type1', 'type1')!;
    expect(lib.isComplete(SEQ_ANIM_INDEX.walk!)).toBe(true);
    expect(lib.isComplete(99999)).toBe(false);
  });
});

describe('decodedAnimationSet', () => {
  const json = JSON.parse(fs.readFileSync(ANIMATIONS, 'utf8')) as DecodedAnimations;
  const lib = ShpLibrary.fromJson(json, 'type1', 'type1')!;
  const fallback = defaultAnimationSet();
  const merged = decodedAnimationSet(lib, fallback);

  it('replaces the mapped clips with authentic frames', () => {
    expect(merged.walk.procedural).toBe(false);
    expect(merged.walk.views.side[0]!.parts).toBeDefined();
    expect(merged.walk.durations).toHaveLength(merged.walk.views.side.length);
  });

  it('leaves unmapped clips on the procedural fallback', () => {
    // 'attack' is deliberately not mapped: naming that SEQ slot would be a guess.
    expect(SEQ_ANIM_INDEX.attack).toBeNull();
    expect(merged.attack).toBe(fallback.attack);
    expect(merged.attack.procedural).toBe(true);
  });

  it('populates every view so the player never reads an empty array', () => {
    for (const clip of Object.values(merged)) {
      for (const view of Object.values(clip.views)) expect(view.length).toBeGreaterThan(0);
    }
  });

  it('keeps every AnimName present', () => {
    expect(Object.keys(merged).sort()).toEqual(Object.keys(fallback).sort());
  });
});
