#!/usr/bin/env node
/**
 * EverTactics — FFT SHP / SEQ animation decoder.
 *
 * Decodes the `*_shp.bin` (frame assembly) and `*_seq.bin` (animation sequence)
 * binaries in `assets-src/unit/` into `public/assets/animations.json`.
 *
 * The container layout and the SEQ instruction set are documented by the FFT
 * modding community (FFHacktics wiki, "SHP & Graphic info page" and
 * "SEQ & Animation info page"). Everything that page leaves in RAM rather than
 * on disk — chiefly the 16-entry graphic size table at 0x800946c8 — was
 * *measured* from the shipped art; see `SIZE_TABLE` below and docs/ASSETS.md §5.
 *
 * Usage:
 *   node tools/decode-shp-seq.mjs             # write public/assets/animations.json
 *   node tools/decode-shp-seq.mjs --report    # + print a human-readable summary
 *   node tools/decode-shp-seq.mjs --dry       # analyse only, write nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = path.join(ROOT, 'assets-src', 'unit');
const OUT_FILE = path.join(ROOT, 'public', 'assets', 'animations.json');

// ─────────────────────────────────────────────────────────────────────────────
// Container geometry
// ─────────────────────────────────────────────────────────────────────────────

/** Unit/monster SHP: 8-byte section 1, then a 0x400 pointer table. */
const SHP_UNIT = { section1: 0x08, tableBytes: 0x400 };
/** WEP/EFF SHP: 0x44-byte section 1, then a 0x800 pointer table. */
const SHP_WEP = { section1: 0x44, tableBytes: 0x800 };

/** SEQ: 4-byte section 1, then a 0x400 pointer table, then a u32 size. */
const SEQ_SECTION1 = 0x04;
const SEQ_TABLE_BYTES = 0x400;

/** A "tile" in the SHP load-location fields is 8x8 pixels of the original SPR. */
const TILE = 8;
/** Original FFT SPR canvas. The HD rip is a clean 2x upscale of this. */
const SPR_W = 256;
/** Frames at or above the SHP's `atk` field read from the sheet's second half. */
const SPR_HALF = 256;

/**
 * The in-RAM graphic size table (0x800946c8), in **tiles**, as `[w, h]`.
 *
 * Not present in any file, so this is measured rather than read: for every
 * distinct size index the decoder was pointed at the real art and the column /
 * row occupancy profile of every part carrying that index was accumulated. A
 * part's box width is the period at which that profile returns to a valley —
 * i.e. where the neighbouring part in the packed sheet begins.
 *
 * Confidence is not uniform. Indices 6, 10 and 11 carry 1652 / 476 / 212
 * samples and their periods are unambiguous. Indices 0, 5, 8, 9 and 13 carry
 * 8-56 samples; their widths are clean but some heights are inferred from the
 * regular structure of the neighbouring entries. Unused indices default to 4x4.
 */
export const SIZE_TABLE = {
  0: [2, 2],
  1: [3, 2],
  2: [2, 2],
  3: [2, 3],
  4: [3, 1],
  5: [3, 2],
  6: [3, 3],
  7: [3, 4],
  8: [4, 2],
  9: [4, 3],
  10: [4, 4],
  11: [4, 5],
  12: [5, 3],
  13: [5, 4],
  14: [6, 6],
  15: [8, 8],
};

/**
 * Sample counts behind each `SIZE_TABLE` entry, so a consumer can tell a
 * measured value from an inferred one. Reported by `--report`.
 */
export const SIZE_TABLE_SAMPLES = {
  0: 311, 1: 4, 2: 73, 3: 45, 4: 12, 5: 191, 6: 3472, 7: 0,
  8: 105, 9: 31, 10: 1004, 11: 432, 12: 2, 13: 16, 14: 259, 15: 615,
};

// ─────────────────────────────────────────────────────────────────────────────
// SEQ instruction set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `0xFF <opcode> <params…>`. Parameter counts and names transcribed from the
 * FFHacktics SEQ page; every opcode the shipped files actually use is covered,
 * and the table is validated below by requiring each animation to parse to a
 * terminator without desyncing.
 */
export const SEQ_OPS = {
  0xbe: ['Unknown_BE', 0],
  0xbf: ['Unknown_BF', 0],
  0xc0: ['WaitForDistort', 1],
  0xc1: ['QueueDistortAnim', 2],
  0xc2: ['QueueNextImmediate', 0],
  0xc3: ['UnloadMFItem', 0],
  0xc4: ['MFItemPos', 2],
  0xc5: ['LoadMFItem', 0],
  0xc6: ['WaitForInput', 1],
  0xc7: ['Unknown_C7', 1],
  0xc8: ['Unknown_C8', 1],
  0xc9: ['Unknown_C9', 1],
  0xca: ['Unknown_CA', 1],
  0xcb: ['MoveUp2', 0],
  0xcc: ['MoveUp1', 0],
  0xcd: ['MoveBackward2', 0],
  0xce: ['MoveBackward1', 0],
  0xcf: ['MoveDown2', 0],
  0xd0: ['MoveDown1', 0],
  0xd1: ['MoveForward2', 0],
  0xd2: ['MoveForward1', 0],
  0xd3: ['WeaponSheatheCheck1', 1],
  0xd4: ['PlayAttackSound', 1],
  0xd5: ['IncrementLoop', 0],
  0xd6: ['WeaponSheatheCheck2', 1],
  0xd7: ['Unknown_D7', 1],
  0xd8: ['SetFrameOffset', 1],
  0xd9: ['QueueThrowAnimation', 2],
  0xda: ['ReturnErrorFinishAnim', 0],
  0xdb: ['SetSlowdown', 1],
  0xdc: ['ReloadAnimation', 0],
  0xdd: ['OverrideAnimation', 1],
  0xde: ['PostGenericAttack', 0],
  0xdf: ['SetYRotation0', 0],
  0xe0: ['ClearShadow', 0],
  0xe1: ['SetShadow', 0],
  0xe2: ['SetLayerPriority', 1],
  0xe3: ['Unknown_E3', 1],
  0xe4: ['Unknown_E4', 1],
  0xe5: ['SaveYSpin', 2],
  0xe6: ['Unknown_E6', 1],
  0xe7: ['Unknown_E7', 1],
  0xe8: ['Unknown_E8', 1],
  0xe9: ['Unknown_E9', 1],
  0xea: ['Unknown_EA', 1],
  0xeb: ['FlipVertical', 0],
  0xec: ['FlipHorizontal', 0],
  0xed: ['Unknown_ED', 1],
  0xee: ['MoveUnitFB', 1],
  0xef: ['MoveUnitDU', 1],
  0xf0: ['MoveUnitRL', 1],
  0xf1: ['Unknown_F1', 1],
  0xf2: ['QueueSpriteAnim', 2],
  0xf3: ['Unknown_F3', 1],
  0xf4: ['Unknown_F4', 1],
  0xf5: ['Unknown_F5', 1],
  0xf6: ['PlaySound', 1],
  0xf7: ['Unknown_F7', 3],
  0xf8: ['Unknown_F8', 1],
  0xf9: ['Unknown_F9', 0],
  0xfa: ['MoveUnit', 3],
  0xfb: ['Unknown_FB', 1],
  0xfc: ['Wait', 2],
  0xfd: ['HoldWeapon', 1],
  0xfe: ['EndAnimation', 0],
  0xff: ['PauseAnimation', 0],
};

/** Opcodes after which the sequence is over. */
const TERMINATORS = new Set([0xd5, 0xda, 0xfe, 0xff]);

// ─────────────────────────────────────────────────────────────────────────────
// SHP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode one `*_shp.bin`.
 *
 * Layout (unit/monster files):
 *
 * | offset | size  | meaning                                                  |
 * |--------|-------|----------------------------------------------------------|
 * | 0x00   | u16   | swim pointer — start of the submerged frame table         |
 * | 0x02   | u16   | (zero in every shipped file)                              |
 * | 0x04   | u16   | `atk` — first frame that reads the sheet's second half     |
 * | 0x06   | u16   | deprecated                                                |
 * | 0x08   | 0x400 | 256 u32 frame pointers, relative to the frame data block   |
 * | 0x408  | u16   | byte length of the frame data block                       |
 * | 0x40A  | …     | frame data                                                |
 *
 * A frame is `u8 header, u8 flags` then `(header & 7) + 1` 4-byte parts.
 * The wiki documents `header & 7` as "No. graphics to load"; the shipped data
 * only tiles the frame block exactly when the count is `(header & 7) + 1`, and
 * that reading places all 182/199/101/207/51/53/17 frame pointers of every unit
 * SHP on an exact record boundary, so the +1 is used here.
 *
 * A part is `i8 dx, i8 dy, u16 desc` with
 * `desc & 0x001f` = source x in tiles, `desc & 0x03e0` = source y in tiles,
 * `desc & 0x3c00` = index into the graphic size table, `desc & 0xc000` = flips.
 */
export function decodeShp(buf, name) {
  const wep = /wep|eff/.test(name);
  const geom = wep ? SHP_WEP : SHP_UNIT;
  const tableAt = geom.section1;
  const count = geom.tableBytes / 4;
  const sizeAt = tableAt + geom.tableBytes;
  const dataAt = sizeAt + 2;

  const swimPtr = wep ? 0 : buf.readUInt16LE(0);
  const atk = wep ? 0 : buf.readUInt16LE(4);
  const blockSize = buf.readUInt16LE(sizeAt);

  const pointers = [];
  for (let i = 0; i < count; i++) pointers.push(buf.readUInt32LE(tableAt + i * 4));

  // Frame 0 always lives at pointer 0; every later zero pointer is an unused slot.
  const used = [];
  for (let i = 0; i < count; i++) if (i === 0 || pointers[i] > 0) used.push(i);

  const frames = [];
  const warnings = [];
  let malformed = 0;
  for (const index of used) {
    const at = dataAt + pointers[index];
    if (at + 2 > buf.length) {
      malformed++;
      continue;
    }
    const header = buf[at];
    const nParts = (header & 7) + 1;
    const end = at + 2 + nParts * 4;
    if (end > buf.length) {
      malformed++;
      continue;
    }
    const parts = [];
    for (let p = 0; p < nParts; p++) {
      const r = at + 2 + p * 4;
      const desc = buf.readUInt16LE(r + 2);
      const sizeIndex = (desc >> 10) & 0x0f;
      const [tw, th] = SIZE_TABLE[sizeIndex];
      parts.push({
        dx: buf.readInt8(r),
        dy: buf.readInt8(r + 1),
        sx: (desc & 0x1f) * TILE,
        sy: ((desc >> 5) & 0x1f) * TILE + (atk && index >= atk ? SPR_HALF : 0),
        w: tw * TILE,
        h: th * TILE,
        flipX: ((desc >> 14) & 1) === 1,
        flipY: ((desc >> 15) & 1) === 1,
        sizeIndex,
      });
    }
    frames.push({ index, yRotation: header >> 3, flags: buf[at + 1], parts });
  }

  // Structural check: the frame block should tile exactly up to the swim pointer.
  const chainEnd = frames.length
    ? dataAt + pointers[used[used.length - 1]] + 2 + frames[frames.length - 1].parts.length * 4
    : dataAt;
  const declaredEnd = dataAt + blockSize;
  if (!wep && swimPtr && declaredEnd !== swimPtr) {
    warnings.push(`${name}: frame block ends at ${declaredEnd}, swim pointer is ${swimPtr}`);
  }
  if (malformed) warnings.push(`${name}: ${malformed} frame pointer(s) out of range`);

  return { name, swimPtr, atk, blockSize, frameCount: frames.length, frames, chainEnd, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEQ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode one `*_seq.bin`.
 *
 * | offset | size  | meaning                                             |
 * |--------|-------|-----------------------------------------------------|
 * | 0x00   | u16   | animation at which the attacker's sprites unpack     |
 * | 0x02   | u16   | animation at which the SP2 sheet is opened instead   |
 * | 0x04   | 0x400 | 256 u32 animation pointers, relative to the data block |
 * | 0x404  | u32   | byte length of the animation data block              |
 * | 0x408  | …     | animation data                                       |
 *
 * An instruction is either `u8 frame, u8 wait` (LoadFrameAndWait) when the lead
 * byte is not 0xFF, or `0xFF u8 opcode <params>` otherwise. Frame ids are
 * therefore capped at 0xFE; in practice they never exceed the SHP's frame count
 * (type1 tops out at 0xB5 = 181 against 182 decoded frames).
 */
export function decodeSeq(buf, name) {
  const tableAt = SEQ_SECTION1;
  const count = SEQ_TABLE_BYTES / 4;
  const sizeAt = tableAt + SEQ_TABLE_BYTES;
  const dataAt = sizeAt + 4;

  const pointers = [];
  for (let i = 0; i < count; i++) pointers.push(buf.readUInt32LE(tableAt + i * 4));

  const anims = [];
  const warnings = [];
  let desync = 0;
  for (let index = 0; index < count; index++) {
    if (index > 0 && pointers[index] === 0) continue;
    const start = dataAt + pointers[index];
    if (start >= buf.length) continue;
    const ops = [];
    let o = start;
    let ended = false;
    // 512 instructions is far beyond anything the shipped files use; the cap
    // only exists so a mis-parse cannot run away.
    for (let guard = 0; guard < 512 && o < buf.length; guard++) {
      const lead = buf[o];
      if (lead !== 0xff) {
        ops.push({ op: 'LoadFrameAndWait', frame: lead, wait: buf[o + 1] });
        o += 2;
        continue;
      }
      const code = buf[o + 1];
      const entry = SEQ_OPS[code];
      if (!entry) break; // unknown opcode; counted once below, via `ended`
      const [opName, arity] = entry;
      const args = [];
      for (let a = 0; a < arity; a++) args.push(buf.readInt8(o + 2 + a));
      ops.push({ op: opName, code, args });
      o += 2 + arity;
      if (TERMINATORS.has(code)) {
        ended = true;
        break;
      }
    }
    if (!ended) desync++;
    anims.push({ index, ops, terminated: ended, byteLength: o - start });
  }
  if (desync) warnings.push(`${name}: ${desync} animation(s) did not reach a terminator`);
  return { name, animCount: anims.length, anims, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived clips
// ─────────────────────────────────────────────────────────────────────────────

/** FFT ticks are 1/60 s and every wait in the shipped data is an even count. */
export const TICK_MS = 1000 / 60;

/**
 * Reduce an animation's opcode stream to the thing a renderer needs: an ordered
 * list of `(frame, durationMs)` plus whether it loops and how far the unit is
 * displaced. Movement opcodes are accumulated into a per-frame offset so a
 * lunge or a recoil survives the reduction.
 */
export function toClip(anim) {
  const frames = [];
  const durations = [];
  const offsets = [];
  let ox = 0;
  let oy = 0;
  let loop = false;
  let impactAt = null;
  for (const op of anim.ops) {
    switch (op.op) {
      case 'LoadFrameAndWait':
        frames.push(op.frame);
        durations.push(Math.max(1, op.wait) * TICK_MS);
        offsets.push([ox, oy]);
        break;
      case 'MoveUp1': oy -= 1; break;
      case 'MoveUp2': oy -= 2; break;
      case 'MoveDown1': oy += 1; break;
      case 'MoveDown2': oy += 2; break;
      case 'MoveForward1': ox += 1; break;
      case 'MoveForward2': ox += 2; break;
      case 'MoveBackward1': ox -= 1; break;
      case 'MoveBackward2': ox -= 2; break;
      case 'MoveUnitFB': ox += op.args[0]; break;
      case 'MoveUnitDU': oy += op.args[0]; break;
      case 'MoveUnit': oy += op.args[1]; ox += op.args[2]; break;
      case 'IncrementLoop': loop = true; break;
      case 'PostGenericAttack':
      case 'PlayAttackSound':
        if (impactAt === null && frames.length) impactAt = frames.length - 1;
        break;
      default:
        break;
    }
  }
  return { index: anim.index, frames, durations, offsets, loop, impactAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet → SHP/SEQ assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The game reads a unit's sprite *type* from its unit table, which is not part
 * of this rip. The pairing below is the one documented on the FFHacktics SEQ
 * page ("Sprite Types").
 *
 * Which sheet gets which type is resolved **by sheet class**, in
 * `resolveSpriteType` in `tools/build-assets.mjs`, and recorded as
 * `manifest.sheets[key].spriteType`. That is the only assignment anything
 * should use. Pixel-similarity scoring was tried and does not work — see
 * `measureShpAgainstSheet`.
 */
export const SPRITE_TYPES = {
  type1: { shp: 'type1', seq: 'type1' },
  type2: { shp: 'type2', seq: 'type3' },
  cyoko: { shp: 'cyoko', seq: 'cyoko' },
  mon: { shp: 'mon', seq: 'mon' },
  other: { shp: 'other', seq: 'other' },
  ruka: { shp: 'mon', seq: 'ruka' },
  arute: { shp: 'arute', seq: 'arute' },
  kanzen: { shp: 'kanzen', seq: 'kanzen' },
};

/**
 * How a decoded SHP's part rectangles land on a sheet's actual artwork.
 *
 * **This is a diagnostic, not an assignment rule, and it must never be used to
 * pick a sheet's SHP.** An earlier version returned `opaque` alone and
 * `preview-anim.mjs` picked the best-scoring table with it; on `knight_male`
 * that chose `other` (0.294) over the correct `type1` (0.235) and rendered
 * heads with no bodies, because `other` holds 17 frames of exactly one part
 * each and its 17 rectangles happen to sit on dense artwork. Measured across
 * `knight_male`, `chocobo`, `behemoth` and `black_mage_female`, no combination
 * of these numbers ranks the correct table first on all four, and none
 * separates `type1` from `type2` at all (they differ by <0.006 everywhere).
 * Sheets are assigned by class in `tools/build-assets.mjs`.
 *
 * What the numbers mean:
 *
 * * `opaque` — mean fraction of non-transparent pixels inside every part rect.
 *   Biased hard toward tables with few, large, well-placed parts.
 * * `recall` — fraction of the sheet's opaque pixels covered by some part rect.
 *   Biased toward tables with many or oversized parts.
 * * `emptyPartRate` — fraction of part rects that land on <2 % opaque pixels,
 *   i.e. blits into blank sheet. This is the one number that does carry signal:
 *   a table built for a different sheet layout aims parts at nothing
 *   (`cyoko` on `knight_male` = 30.5 %, `type1` on `behemoth` = 24.0 %). It
 *   still cannot rank `mon`/`other`/`kanzen`, whose 48×48 and 64×64 boxes are
 *   too big to miss.
 */
export function measureShpAgainstSheet(shp, sheet) {
  const covered = new Uint8Array(sheet.width * sheet.height);
  let inside = 0;
  let total = 0;
  let emptyParts = 0;
  let partCount = 0;
  for (const frame of shp.frames) {
    for (const part of frame.parts) {
      partCount++;
      let partOpaque = 0;
      let partTotal = 0;
      for (let j = 0; j < part.h; j++) {
        for (let i = 0; i < part.w; i++) {
          const x = part.sx + i;
          const y = part.sy + j;
          if (x >= sheet.width || y >= sheet.height) continue;
          total++;
          partTotal++;
          covered[y * sheet.width + x] = 1;
          if (sheet.data[y * sheet.width + x] !== 0) {
            inside++;
            partOpaque++;
          }
        }
      }
      if (partTotal && partOpaque / partTotal < 0.02) emptyParts++;
    }
  }
  let sheetOpaque = 0;
  let sheetCovered = 0;
  for (let i = 0; i < covered.length; i++) {
    if (sheet.data[i] === 0) continue;
    sheetOpaque++;
    if (covered[i]) sheetCovered++;
  }
  return {
    opaque: total ? inside / total : 0,
    recall: sheetOpaque ? sheetCovered / sheetOpaque : 0,
    emptyPartRate: partCount ? emptyParts / partCount : 0,
    parts: partCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

export function decodeAll(dir = UNIT_DIR) {
  const files = fs.readdirSync(dir);
  const shp = {};
  const seq = {};
  const warnings = [];
  for (const file of files) {
    const m = /^battle_(.+)_(shp|seq)\.bin$/.exec(file);
    if (!m) continue;
    const [, key, kind] = m;
    const buf = fs.readFileSync(path.join(dir, file));
    try {
      const decoded = kind === 'shp' ? decodeShp(buf, key) : decodeSeq(buf, key);
      (kind === 'shp' ? shp : seq)[key] = decoded;
      warnings.push(...decoded.warnings);
    } catch (err) {
      warnings.push(`${file}: ${err.message}`);
    }
  }
  return { shp, seq, warnings };
}

/** Compact the decode into the JSON the runtime loads. */
export function buildAnimationsJson(decoded) {
  const shp = {};
  for (const [key, file] of Object.entries(decoded.shp)) {
    shp[key] = {
      atk: file.atk,
      swimPtr: file.swimPtr,
      frameCount: file.frameCount,
      // 8 numbers per part: dx, dy, sx, sy, w, h, flipBits, sizeIndex.
      frames: file.frames.map((f) => ({
        i: f.index,
        p: f.parts.flatMap((q) => [
          q.dx, q.dy, q.sx, q.sy, q.w, q.h, (q.flipX ? 1 : 0) | (q.flipY ? 2 : 0), q.sizeIndex,
        ]),
      })),
    };
  }
  const seq = {};
  for (const [key, file] of Object.entries(decoded.seq)) {
    seq[key] = {
      animCount: file.animCount,
      anims: file.anims.map((a) => {
        const clip = toClip(a);
        return {
          i: a.index,
          f: clip.frames,
          d: clip.durations.map((d) => Math.round(d)),
          o: clip.offsets.flat(),
          loop: clip.loop,
          impactAt: clip.impactAt,
        };
      }),
    };
  }
  return {
    version: 1,
    generator: 'tools/decode-shp-seq.mjs',
    generatedAt: new Date().toISOString(),
    tile: TILE,
    sprCanvas: { width: SPR_W, half: SPR_HALF },
    hdScale: 2,
    sizeTable: SIZE_TABLE,
    spriteTypes: SPRITE_TYPES,
    notes: {
      coordinates:
        'All source rects and destination offsets are in ORIGINAL 256x488 SPR pixels. ' +
        'The HD rip is a clean 2x upscale, so multiply by hdScale before sampling it.',
      flip: 'flipBits: 1 = mirror horizontally, 2 = mirror vertically.',
      partCount: 'Frame header byte & 7 is the part count minus one.',
    },
    shp,
    seq,
    warnings: decoded.warnings,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const report = args.includes('--report') || dry;
  const decoded = decodeAll();
  const json = buildAnimationsJson(decoded);

  if (report) {
    console.log('SHP files');
    for (const [key, f] of Object.entries(decoded.shp)) {
      const parts = f.frames.reduce((n, fr) => n + fr.parts.length, 0);
      console.log(
        `  ${key.padEnd(8)} frames=${String(f.frameCount).padStart(4)} parts=${String(parts).padStart(5)}` +
          ` atk=${f.atk} swimPtr=${f.swimPtr} blockEndsAtSwimPtr=${f.swimPtr ? f.chainEnd <= f.swimPtr : 'n/a'}`,
      );
    }
    console.log('SEQ files');
    for (const [key, f] of Object.entries(decoded.seq)) {
      const term = f.anims.filter((a) => a.terminated).length;
      const withFrames = f.anims.filter((a) => a.ops.some((o) => o.op === 'LoadFrameAndWait')).length;
      console.log(
        `  ${key.padEnd(8)} anims=${String(f.animCount).padStart(4)} terminated=${String(term).padStart(4)}` +
          ` withFrames=${String(withFrames).padStart(4)}`,
      );
    }
    if (decoded.warnings.length) {
      console.log('Warnings');
      for (const w of decoded.warnings) console.log('  ' + w);
    }
  }

  if (!dry) {
    fs.writeFileSync(OUT_FILE, JSON.stringify(json));
    const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(0);
    console.log(`wrote ${path.relative(ROOT, OUT_FILE)} (${kb} KB)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
