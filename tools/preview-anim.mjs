#!/usr/bin/env node
/**
 * EverTactics — SHP/SEQ visual verifier.
 *
 * Assembles decoded SHP frames out of a real sprite sheet and writes a contact
 * sheet PNG. This is how anyone checks that the decode is right: the proof is
 * not that the parse returned without throwing, it is that the knight looks
 * like a knight.
 *
 *   node tools/preview-anim.mjs --sheet knight_male --frames
 *   node tools/preview-anim.mjs --sheet knight_male --anim 6,7,8,9,10,11
 *   node tools/preview-anim.mjs --sheet chocobo --shp cyoko --frames
 *   node tools/preview-anim.mjs --sheet knight_male --score
 *
 * Output goes to tools/out/anim-<sheet>-<what>.png.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeAll, SPRITE_TYPES, scoreShpAgainstSheet } from './decode-shp-seq.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const OUT_DIR = path.join(ROOT, 'tools', 'out');

// ─────────────────────────────────────────────────────────────────────────────
// PNG in / out — self-contained, node zlib only, same approach as build-assets.
// ─────────────────────────────────────────────────────────────────────────────

function readChunks(buf) {
  const out = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    out.push({ type, data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** Decode an 8-bit indexed (colour type 3) PNG into palette indices. */
function decodeIndexedPng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  if (ihdr.data[8] !== 8 || ihdr.data[9] !== 3) throw new Error('expected 8-bit indexed PNG');
  const palette = Buffer.from(chunks.find((c) => c.type === 'PLTE').data);
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const data = Buffer.alloc(width * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + width);
    p += width;
    const cur = data.subarray(y * width, (y + 1) * width);
    const prev = y > 0 ? data.subarray((y - 1) * width, y * width) : null;
    for (let x = 0; x < width; x++) {
      const a = x >= 1 ? cur[x - 1] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 1 ? prev[x - 1] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const est = a + b - c;
          const pa = Math.abs(est - a);
          const pb = Math.abs(est - b);
          const pc = Math.abs(est - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = v;
    }
  }
  return { width, height, data, palette };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let x = 0xffffffff;
  for (const b of buf) x = CRC_TABLE[(x ^ b) & 0xff] ^ (x >>> 8);
  return (x ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodeRgba(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a manifest sheet, stitch its two halves, and downsample the HD rip back
 * to the original 256x488 SPR grid the SHP coordinates are expressed in.
 */
export function loadSheet(manifest, key) {
  const entry = manifest.sheets[key];
  if (!entry) throw new Error(`unknown sheet '${key}'`);
  if (entry.broken) throw new Error(`sheet '${key}' is flagged broken`);
  const halves = entry.files.map((f) => decodeIndexedPng(fs.readFileSync(path.join(ASSETS, f.replace(/^assets\//, '')))));
  const hdW = halves[0].width;
  const hdH = halves.reduce((n, h) => n + h.height, 0);
  const hd = Buffer.alloc(hdW * hdH);
  let y0 = 0;
  for (const h of halves) {
    h.data.copy(hd, y0 * hdW);
    y0 += h.height;
  }
  // SHP coordinates are original-resolution; the HD rip is an exact 2x upscale.
  const width = hdW >> 1;
  const height = hdH >> 1;
  const data = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = hd[y * 2 * hdW + x * 2];
  }
  return { key, width, height, data, hd, hdW, hdH, palette: halves[0].palette };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw one decoded SHP frame into an RGBA buffer, with `(originX, originY)` the
 * unit's origin — the point every part offset is relative to.
 *
 * `scale` samples the HD texture instead of the downsampled one when 2.
 */
export function drawFrame(frame, sheet, target, originX, originY, scale = 1) {
  const src = scale === 2 ? sheet.hd : sheet.data;
  const srcW = scale === 2 ? sheet.hdW : sheet.width;
  const srcH = scale === 2 ? sheet.hdH : sheet.height;
  for (const part of frame.parts) {
    const pw = part.w * scale;
    const ph = part.h * scale;
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const su = part.flipX ? pw - 1 - i : i;
        const sv = part.flipY ? ph - 1 - j : j;
        const sx = part.sx * scale + su;
        const sy = part.sy * scale + sv;
        if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH) continue;
        const index = src[sy * srcW + sx];
        if (index === 0) continue;
        const x = originX + part.dx * scale + i;
        const y = originY + part.dy * scale + j;
        if (x < 0 || y < 0 || x >= target.width || y >= target.height) continue;
        const o = (y * target.width + x) * 4;
        target.rgba[o] = sheet.palette[index * 3];
        target.rgba[o + 1] = sheet.palette[index * 3 + 1];
        target.rgba[o + 2] = sheet.palette[index * 3 + 2];
        target.rgba[o + 3] = 255;
      }
    }
  }
}

function newTarget(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 18;
    rgba[i * 4 + 1] = 20;
    rgba[i * 4 + 2] = 28;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Thin separator so cells are countable in the contact sheet. */
function grid(target, cell, cols, rows) {
  for (let r = 1; r < rows; r++) {
    for (let x = 0; x < target.width; x++) {
      const o = ((r * cell - 1) * target.width + x) * 4;
      target.rgba[o] = 40; target.rgba[o + 1] = 44; target.rgba[o + 2] = 58;
    }
  }
  for (let c = 1; c < cols; c++) {
    for (let y = 0; y < target.height; y++) {
      const o = (y * target.width + c * cell - 1) * 4;
      target.rgba[o] = 40; target.rgba[o + 1] = 44; target.rgba[o + 2] = 58;
    }
  }
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
  const decoded = decodeAll();
  const sheetKey = String(arg('sheet', 'knight_male'));
  const sheet = loadSheet(manifest, sheetKey);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Which SHP/SEQ pair? Explicit, or the best-scoring candidate.
  let shpKey = arg('shp');
  if (!shpKey || arg('score')) {
    const scores = Object.values(SPRITE_TYPES)
      .map((t) => t.shp)
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((k) => [k, scoreShpAgainstSheet(decoded.shp[k], sheet)])
      .sort((a, b) => b[1] - a[1]);
    console.log(`${sheetKey}: SHP fit ` + scores.map(([k, s]) => `${k}=${s.toFixed(3)}`).join(' '));
    if (!shpKey) shpKey = scores[0][0];
  }
  const shp = decoded.shp[shpKey];
  if (!shp) throw new Error(`unknown SHP '${shpKey}'`);
  const seqKey = String(arg('seq', Object.values(SPRITE_TYPES).find((t) => t.shp === shpKey)?.seq ?? shpKey));
  const scale = Number(arg('scale', 2));

  // Cells must be big enough for the largest part box on this SHP, or the
  // contact sheet clips figures and looks like a decode bug when it is not.
  const maxPart = Math.max(
    48,
    ...shp.frames.flatMap((f) => f.parts.map((p) => Math.max(p.w, p.h) + 16)),
  );
  const CELL = maxPart * scale;
  const byIndex = new Map(shp.frames.map((f) => [f.index, f]));

  if (arg('anim')) {
    const wanted = String(arg('anim')).split(',').map(Number);
    const seq = decoded.seq[seqKey];
    const rows = [];
    for (const id of wanted) {
      const anim = seq.anims.find((a) => a.index === id);
      if (!anim) continue;
      rows.push({ id, frames: anim.ops.filter((o) => o.op === 'LoadFrameAndWait').map((o) => o.frame) });
    }
    const cols = Math.max(1, ...rows.map((r) => r.frames.length));
    const target = newTarget(cols * CELL, rows.length * CELL);
    grid(target, CELL, cols, rows.length);
    rows.forEach((row, r) => {
      row.frames.forEach((fi, c) => {
        const frame = byIndex.get(fi);
        if (frame) drawFrame(frame, sheet, target, c * CELL + CELL / 2, r * CELL + CELL - 8 * scale, scale);
      });
    });
    const out = path.join(OUT_DIR, `anim-${sheetKey}-seq.png`);
    fs.writeFileSync(out, encodeRgba(target.width, target.height, target.rgba));
    console.log(`wrote ${path.relative(ROOT, out)} — ${rows.length} animations, ${shpKey}/${seqKey}`);
    return;
  }

  // Default: every SHP frame, in index order.
  const first = Number(arg('first', 0));
  const limit = Number(arg('limit', 128));
  const list = shp.frames.slice(first, first + limit);
  const cols = 16;
  const rows = Math.ceil(list.length / cols);
  const target = newTarget(cols * CELL, rows * CELL);
  grid(target, CELL, cols, rows);
  list.forEach((frame, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    drawFrame(frame, sheet, target, c * CELL + CELL / 2, r * CELL + CELL - 8 * scale, scale);
  });
  const out = path.join(OUT_DIR, `anim-${sheetKey}-frames.png`);
  fs.writeFileSync(out, encodeRgba(target.width, target.height, target.rgba));
  console.log(`wrote ${path.relative(ROOT, out)} — frames ${first}..${first + list.length - 1} of ${shp.frameCount}, ${shpKey}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
