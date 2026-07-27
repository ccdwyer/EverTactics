#!/usr/bin/env node
/**
 * EverTactics asset pipeline.
 *
 * Reads the raw FFT HD rips in public/assets/ and emits public/assets/manifest.json,
 * the single source of truth the renderer loads at boot.
 *
 * Everything in here is measured, not assumed:
 *   - PNGs are decoded with a self-contained decoder (node zlib only, no deps).
 *   - .act palettes are parsed as Adobe Color Tables and sanity-checked.
 *   - A sheet's palette family is resolved by matching its embedded PLTE chunk
 *     byte-for-byte against the family's battle palette 0. That match is exact,
 *     so the mapping is proven rather than guessed from filenames.
 *   - Whole-body pose frames are found by projection analysis (rows of content
 *     separated by fully transparent scanlines), then per-column bounding boxes
 *     inside each band, then a shape/density test.
 *
 * Usage:
 *   node tools/build-assets.mjs              # write manifest
 *   node tools/build-assets.mjs --report     # write manifest + print a human report
 *   node tools/build-assets.mjs --dry        # analyse, print report, write nothing
 *   node tools/build-assets.mjs --dump KEY   # write a debug PNG of one sheet to tools/out/
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const SPRITE_DIR = path.join(ASSETS, 'sprites');
const PALETTE_DIR = path.join(ASSETS, 'palettes');
const PORTRAIT_DIR = path.join(ASSETS, 'portraits');
const SUMMON_DIR = path.join(ASSETS, 'summons');
const WEAPON_DIR = path.join(ASSETS, 'weapons');
const OUT_FILE = path.join(ASSETS, 'manifest.json');

/**
 * Sheets that are drawn whole rather than assembled from parts carry complete
 * figures across many bands (docs/ASSETS.md §1.4); those are the MON.SHP units.
 * Six or more pose bands is the measured separator — human sheets top out at
 * five, monsters run to nine.
 */
const MONSTER_POSE_BANDS = 6;

/** Minimum band-0 pose pitch, in HD pixels, for MON.SHP's 48px boxes to fit. */
const MON_PITCH_HD = 88;

/**
 * Pick the SHP/SEQ sprite type for a sheet.
 *
 * Honest about its limits: the real mapping is a per-unit field in the game's
 * unit table, which this rip does not include. What is available is the art
 * layout, and that separates the four structurally distinct classes — chocobo,
 * whole-drawn monster, the two Altima forms, and everything human. It does NOT
 * separate TYPE1 from TYPE2, which share a container layout and produce
 * near-identical assemblies on the human sheets tested, so all humans get type1.
 */
function resolveSpriteType(entry) {
  if (entry.broken) return null;
  if (/chocobo/.test(entry.key)) return 'cyoko';
  if (entry.key === 'altima_second_form') return 'arute';
  if (entry.key === 'altima_first_form') return 'kanzen';
  // Cutscene sheets are pose-only: half height, no parts region to assemble from.
  if (/^event_/.test(entry.key)) return null;
  if ((entry.poseBands?.length ?? 0) >= MONSTER_POSE_BANDS) {
    // MON.SHP addresses the sheet with absolute 48x48 boxes, so it only fits a
    // sheet whose figures are actually laid out on a 48px original-pixel pitch
    // (96px in the HD rip). Behemoth measures 92-100; goblin measures 62-68 and
    // would be assembled with a neighbouring figure bleeding into every box.
    // Those sheets keep the pose-frame fallback, which they have plenty of.
    const pitch = posePitchHd(entry);
    return pitch !== null && pitch >= MON_PITCH_HD ? 'mon' : null;
  }
  return 'type1';
}

/** Median horizontal spacing between whole-body poses in band 0, in HD pixels. */
function posePitchHd(entry) {
  const xs = [];
  for (let i = 0; i + 8 <= entry.poses.length; i += 8) {
    if (entry.poses[i] === 0) xs.push(entry.poses[i + 2]);
  }
  if (xs.length < 3) return null;
  xs.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

/** Sprite sheet cell geometry. HD sheets are 2x the original 32px FFT cell. */
const CELL = 64;
const SHEET_W = 512;
const COLUMNS = SHEET_W / CELL;

// ─────────────────────────────────────────────────────────────────────────────
// PNG decoding — indexed (ct3), greyscale (ct0/4), truecolour (ct2/6), 8bpc.
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
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

/** Fast header-only read: width/height/colour type without inflating. */
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(33);
  fs.readSync(fd, b, 0, 33, 0);
  fs.closeSync(fd);
  return {
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    bitDepth: b[24],
    colorType: b[25],
  };
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode an 8-bit-per-channel, non-interlaced PNG.
 * Returns { width, height, colorType, channels, data, palette }.
 * `data` is raw post-filter samples (channels per pixel).
 */
function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const plteChunk = chunks.find((c) => c.type === 'PLTE');
  const palette = plteChunk ? Buffer.from(plteChunk.data) : null;
  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const bpp = channels;
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = data.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
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
        default: throw new Error(`bad filter type ${filter} on row ${y}`);
      }
      cur[x] = v;
    }
  }
  return { width, height, colorType, channels, data, palette };
}

/** Minimal PNG encoder used only by --dump for eyeballing results. */
function encodeRgba(width, height, rgba) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Adobe Color Table (.act) parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An .act is 256 RGB triplets (768 bytes). Files written by the FFT toolkit are
 * 772 bytes: 768 + a 2-byte colour count + 2-byte transparent index trailer.
 * FFT only ever uses the first 16 entries; index 0 is the transparent colour.
 */
function parseAct(file) {
  const buf = fs.readFileSync(file);
  if (buf.length !== 768 && buf.length !== 772) {
    throw new Error(`${path.basename(file)}: expected 768 or 772 bytes, got ${buf.length}`);
  }
  const colours = buf.subarray(0, 48); // first 16 RGB triplets
  let declaredCount = null;
  let transparentIndex = null;
  if (buf.length === 772) {
    declaredCount = buf.readUInt16BE(768);
    transparentIndex = buf.readUInt16BE(770);
  }
  let nonBlack = 0;
  for (let i = 0; i < 16; i++) {
    if (colours[i * 3] || colours[i * 3 + 1] || colours[i * 3 + 2]) nonBlack++;
  }
  return { colours, declaredCount, transparentIndex, nonBlack, empty: nonBlack === 0 };
}

const PALETTE_RE = /^battle_(.+?)_(battle|portrait)_pal(\d+)\.act$/;

function loadPalettes() {
  const families = new Map(); // family -> { battle: (Buffer|null)[8], portrait: (Buffer|null)[8] }
  const problems = [];
  const files = fs.readdirSync(PALETTE_DIR).filter((f) => f.endsWith('.act')).sort();
  for (const f of files) {
    const m = PALETTE_RE.exec(f);
    if (!m) { problems.push(`unparsable palette filename: ${f}`); continue; }
    const [, family, kind, palStr] = m;
    // Filenames on disk are 1-based (pal1..pal8). The toolkit README describes
    // 0-based slots; the disk wins. pal1 -> slot 0.
    const slot = Number(palStr) - 1;
    if (slot < 0 || slot > 7) { problems.push(`palette slot out of range: ${f}`); continue; }
    let entry = families.get(family);
    if (!entry) {
      entry = { battle: new Array(8).fill(null), portrait: new Array(8).fill(null), stats: { battleUsed: 0, portraitUsed: 0 } };
      families.set(family, entry);
    }
    let act;
    try {
      act = parseAct(path.join(PALETTE_DIR, f));
    } catch (err) {
      problems.push(String(err.message));
      continue;
    }
    entry[kind][slot] = act.colours;
    if (!act.empty) entry.stats[kind === 'battle' ? 'battleUsed' : 'portraitUsed']++;
  }
  return { families, problems };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet assembly
// ─────────────────────────────────────────────────────────────────────────────

const SPRITE_RE = /^(\d+)_(.+)_hd\.png$/;

function cleanKey(name) {
  return name
    .replace(/_hd$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Group sprite files into logical sheets.
 *
 * Verified fact: the numbered PNGs come in (primary, continuation) pairs. The
 * primary is 512x512; the continuation is 512x464 and is the *vertical
 * remainder* of the same image — both files carry a byte-identical PLTE, and
 * stacking them yields 512x976, which is exactly 2x the 256x488 FFT SPR canvas.
 * Some sprites have no continuation (short sheets) and some are singletons.
 */
function groupSheets() {
  const files = fs
    .readdirSync(SPRITE_DIR)
    .filter((f) => SPRITE_RE.test(f))
    .map((f) => {
      const m = SPRITE_RE.exec(f);
      const hdr = readHeader(path.join(SPRITE_DIR, f));
      return { file: f, num: Number(m[1]), name: m[2], ...hdr };
    })
    .sort((a, b) => a.num - b.num);

  const groups = [];
  for (let i = 0; i < files.length; i++) {
    const primary = files[i];
    const next = files[i + 1];
    // A continuation is the immediately-following file with the same base name
    // and a height strictly below the 512 primary height.
    const isContinuation =
      next && next.num === primary.num + 1 && next.name === primary.name &&
      primary.height === 512 && next.height < 512;
    if (isContinuation) {
      groups.push({ primary, continuation: next });
      i++;
    } else {
      groups.push({ primary, continuation: null });
    }
  }
  return groups;
}

/** Stack primary + continuation into one index buffer. */
function assemble(group) {
  const a = decodePng(fs.readFileSync(path.join(SPRITE_DIR, group.primary.file)));
  if (a.colorType !== 3) throw new Error(`${group.primary.file}: expected indexed PNG`);
  let b = null;
  if (group.continuation) {
    b = decodePng(fs.readFileSync(path.join(SPRITE_DIR, group.continuation.file)));
    if (b.colorType !== 3) throw new Error(`${group.continuation.file}: expected indexed PNG`);
  }
  const height = a.height + (b ? b.height : 0);
  const indices = Buffer.alloc(a.width * height);
  a.data.copy(indices, 0);
  if (b) b.data.copy(indices, a.height * a.width);
  return {
    width: a.width,
    height,
    indices,
    palette: a.palette,
    continuationPaletteMatches: b ? Boolean(b.palette && a.palette.equals(b.palette)) : null,
    splitY: b ? a.height : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement
// ─────────────────────────────────────────────────────────────────────────────

/** Tight bounding box of non-zero indices inside a rect. */
function boxIn(img, rx, ry, rw, rh) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, px = 0;
  const x1 = Math.min(rx + rw, img.width);
  const y1 = Math.min(ry + rh, img.height);
  for (let y = ry; y < y1; y++) {
    const row = y * img.width;
    for (let x = rx; x < x1; x++) {
      if (img.indices[row + x] !== 0) {
        px++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (px === 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, px };
}

/** Vertical runs of scanlines containing at least one opaque pixel. */
function contentBands(img) {
  const bands = [];
  let start = -1;
  for (let y = 0; y < img.height; y++) {
    let any = false;
    const row = y * img.width;
    for (let x = 0; x < img.width; x++) {
      if (img.indices[row + x] !== 0) { any = true; break; }
    }
    if (any && start < 0) start = y;
    else if (!any && start >= 0) { bands.push({ y0: start, y1: y - 1, h: y - start }); start = -1; }
  }
  if (start >= 0) bands.push({ y0: start, y1: img.height - 1, h: img.height - start });
  return bands;
}

/**
 * All 8-connected components of opaque pixels inside a rect, with bounding box,
 * pixel count and distinct palette-index count. Components smaller than
 * `minPx` are dropped. Coordinates are absolute sheet pixels.
 */
function components(img, rx, ry, rw, rh, minPx = 1) {
  const x1 = Math.min(rx + rw, img.width);
  const y1 = Math.min(ry + rh, img.height);
  const w = x1 - rx, h = y1 - ry;
  const out = [];
  if (w <= 0 || h <= 0) return out;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const s0 = sy * w + sx;
      if (seen[s0] || img.indices[(ry + sy) * img.width + rx + sx] === 0) continue;
      let sp = 0;
      stack[sp++] = s0;
      seen[s0] = 1;
      let minX = sx, maxX = sx, minY = sy, maxY = sy, px = 0;
      const palCounts = new Int32Array(256);
      let palCount = 0;
      while (sp > 0) {
        const cur = stack[--sp];
        const cy = (cur / w) | 0, cx = cur - cy * w;
        px++;
        const idx = img.indices[(ry + cy) * img.width + rx + cx];
        if (palCounts[idx]++ === 0) palCount++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const ni = ny * w + nx;
            if (seen[ni] || img.indices[(ry + ny) * img.width + rx + nx] === 0) continue;
            seen[ni] = 1;
            stack[sp++] = ni;
          }
        }
      }
      if (px >= minPx) {
        let dominant = 0;
        for (let i = 1; i < 256; i++) if (palCounts[i] > dominant) dominant = palCounts[i];
        out.push({
          x: rx + minX, y: ry + minY,
          w: maxX - minX + 1, h: maxY - minY + 1,
          px, colours: palCount, dominant: dominant / px,
        });
      }
    }
  }
  return out;
}

/**
 * Whole-body pose test, applied to one connected component inside a content band.
 *
 * Measured on real sheets: a complete unit frame is a single connected blob that
 * spans most of its band, 44-130 HD pixels tall. Humans are 20-62 wide and sit
 * one per 64px column; monsters are wider (up to ~150) and straddle columns,
 * which is why detection runs across the whole band rather than per column.
 * Loose SHP parts (hands, boot caps, cape shreds) are short, thin, sparse or
 * flat-coloured and fail one of the tests below.
 */
function isFigure(c, band) {
  if (band.h < 48 || band.h > 140) return false;      // a pose band is one figure tall
  if (c.h < 44 || c.h > 132) return false;
  if (c.w < 20 || c.w > 170) return false;
  if (c.h < band.h * 0.6) return false;               // must span most of its band
  if (c.px < 380) return false;
  if (c.px / (c.w * c.h) < 0.3) return false;         // solid, not a wire of parts
  if (c.colours < 6) return false;                    // shaded character, not a flat scrap
  if (c.dominant > 0.62) return false;                // not a near-flat cape/shadow scrap
  return true;
}

/** Feet anchor: mean x of the opaque pixels on the lowest occupied scanlines. */
function feetAnchor(img, box) {
  const bottom = box.y + box.h - 1;
  let sum = 0, n = 0;
  for (let y = bottom; y > bottom - 4 && y >= box.y; y--) {
    const row = y * img.width;
    for (let x = box.x; x < box.x + box.w; x++) {
      if (img.indices[row + x] !== 0) { sum += x; n++; }
    }
    if (n >= 6) break; // one or two solid scanlines are enough
  }
  return { x: n ? sum / n : box.x + box.w / 2, y: bottom };
}

function analyseSheet(img) {
  const rows = Math.ceil(img.height / CELL);

  // Per-cell occupancy + tight boxes on the documented 64px grid.
  const cellBoxes = [];
  const occupancy = new Uint8Array(COLUMNS * rows);
  let occupied = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLUMNS; c++) {
      const i = r * COLUMNS + c;
      const box = boxIn(img, c * CELL, r * CELL, CELL, CELL);
      if (box) {
        occupancy[i] = 1;
        occupied++;
        // store relative to the cell origin so the renderer can use it directly
        cellBoxes.push(i, box.x - c * CELL, box.y - r * CELL, box.w, box.h, box.px);
      }
    }
  }

  // Whole-body pose detection via content bands.
  const bands = contentBands(img);
  const poses = [];
  const poseBands = [];
  // Tall sprites make the first two pose rows touch, merging them into one
  // content band. Split any leading band that is too tall to be a single figure
  // at its sparsest interior scanline.
  const splitTall = (band) => {
    if (band.h <= 110 || band.h > 200) return [band];
    const counts = new Int32Array(band.h);
    for (let y = 0; y < band.h; y++) {
      const row = (band.y0 + y) * img.width;
      let n = 0;
      for (let x = 0; x < img.width; x++) if (img.indices[row + x] !== 0) n++;
      counts[y] = n;
    }
    let mean = 0;
    for (const c of counts) mean += c;
    mean /= band.h;
    let bestY = -1, bestN = Infinity;
    for (let y = 44; y <= band.h - 44; y++) {
      if (counts[y] < bestN) { bestN = counts[y]; bestY = y; }
    }
    if (bestY < 0 || bestN > mean * 0.45) return [band];
    return [
      { y0: band.y0, y1: band.y0 + bestY - 1, h: bestY },
      { y0: band.y0 + bestY, y1: band.y1, h: band.h - bestY },
    ];
  };
  const scanBands = [];
  for (const b of bands) scanBands.push(...splitTall(b));

  // Pose bands only ever occur as the leading content bands of a sheet: FFT
  // packs the complete unit frames at the top-left and everything after the
  // first non-pose band is SHP-assembled parts. Scanning the whole sheet
  // produces false positives (a dense clump of monster feathers can pass the
  // shape test), so stop at the first band that is not a pose band. Monster
  // sheets fail on their very first band and correctly report zero poses.
  for (let bi = 0; bi < scanBands.length; bi++) {
    const band = scanBands[bi];
    if (band.h < 16) continue;                          // leading speck of noise
    if (band.h < 48 || band.h > 140) break;
    const found = components(img, 0, band.y0, img.width, band.h, 380)
      .filter((c) => isFigure(c, band))
      .sort((a, b) => a.x - b.x);
    if (found.length === 0) break;
    poseBands.push({ y: band.y0, h: band.h, count: found.length });
    for (const c of found) {
      const feet = feetAnchor(img, c);
      poses.push({
        band: poseBands.length - 1,
        col: Math.min(COLUMNS - 1, Math.floor((c.x + c.w / 2) / CELL)),
        x: c.x, y: c.y, w: c.w, h: c.h,
        px: c.px,
        // absolute feet position in sheet pixels
        ax: Math.round(feet.x),
        ay: feet.y,
      });
    }
  }

  // Sheet anchor, in the SpriteSheetMeta convention: offset from the pose
  // frame's bottom-centre to the feet. The pose frame is the 64px-wide column
  // clipped to the band, so the frame bottom is band.y0 + band.h - 1.
  let anchor = { x: 0, y: 0 };
  if (poses.length) {
    const dxs = [], dys = [];
    for (const p of poses) {
      const band = poseBands[p.band];
      dxs.push(p.ax - (p.col * CELL + CELL / 2));
      dys.push(p.ay - (band.y + band.h - 1));
    }
    dxs.sort((a, b) => a - b);
    dys.sort((a, b) => a - b);
    anchor = { x: Math.round(dxs[dxs.length >> 1]), y: Math.round(dys[dys.length >> 1]) };
  }

  let opaque = 0;
  for (let i = 0; i < img.indices.length; i++) if (img.indices[i] !== 0) opaque++;

  return { rows, occupancy, occupiedCells: occupied, cellBoxes, bands, poses, poseBands, anchor, opaque };
}

function occupancyHex(occupancy) {
  let out = '';
  for (let i = 0; i < occupancy.length; i += 4) {
    let nib = 0;
    for (let b = 0; b < 4; b++) if (occupancy[i + b]) nib |= 1 << b;
    out += nib.toString(16);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette family matching
// ─────────────────────────────────────────────────────────────────────────────

function buildPaletteIndex(families) {
  const byBytes = new Map(); // base64(48 bytes) -> [{ family, slot }]
  for (const [family, entry] of families) {
    for (let slot = 0; slot < 8; slot++) {
      const p = entry.battle[slot];
      if (!p) continue;
      const key = p.toString('base64');
      let list = byBytes.get(key);
      if (!list) byBytes.set(key, (list = []));
      list.push({ family, slot });
    }
  }
  return byBytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const report = args.includes('--report') || args.includes('--dry');
  const dry = args.includes('--dry');
  const dumpIdx = args.indexOf('--dump');
  const dumpKey = dumpIdx >= 0 ? args[dumpIdx + 1] : null;

  const t0 = Date.now();
  const warnings = [];

  // ── palettes ───────────────────────────────────────────────────────────────
  const { families, problems } = loadPalettes();
  warnings.push(...problems);
  const paletteIndex = buildPaletteIndex(families);

  // Sanity check demanded by the spec: palettes must not all be black.
  let familiesWithColour = 0;
  for (const [, e] of families) if (e.stats.battleUsed > 0) familiesWithColour++;
  if (familiesWithColour < families.size * 0.9) {
    warnings.push(`only ${familiesWithColour}/${families.size} palette families have a non-black battle palette`);
  }

  // ── sheets ─────────────────────────────────────────────────────────────────
  const groups = groupSheets();
  const usedKeys = new Set();
  const pendingSheets = [];
  const sheets = {};
  const byNumber = {};
  const stats = { total: 0, paired: 0, singles: 0, broken: 0, withPoses: 0, poseTotal: 0, unmatchedPalette: 0, ambiguousPalette: 0 };

  for (const g of groups) {
    stats.total++;
    if (g.continuation) stats.paired++; else stats.singles++;

    let img;
    try {
      img = assemble(g);
    } catch (err) {
      warnings.push(`${g.primary.file}: ${err.message}`);
      continue;
    }

    if (g.continuation && img.continuationPaletteMatches === false) {
      warnings.push(`${g.primary.file}: continuation PLTE differs from primary`);
    }

    const baseKey = cleanKey(g.primary.name);

    // Palette family via exact PLTE match.
    const plteKey = img.palette ? img.palette.subarray(0, 48).toString('base64') : null;
    const matches = plteKey ? paletteIndex.get(plteKey) ?? [] : [];
    let paletteFamily = null;
    let paletteSlot = null;
    let paletteAmbiguous = false;
    if (matches.length === 1) {
      paletteFamily = matches[0].family;
      paletteSlot = matches[0].slot;
    } else if (matches.length > 1) {
      // Prefer a slot-0 match, then the family whose name best resembles the key.
      const slot0 = matches.filter((m) => m.slot === 0);
      const pool = slot0.length ? slot0 : matches;
      const scored = pool
        .map((m) => ({ ...m, score: nameAffinity(baseKey, m.family) }))
        .sort((a, b) => b.score - a.score || a.family.localeCompare(b.family));
      paletteFamily = scored[0].family;
      paletteSlot = scored[0].slot;
      paletteAmbiguous = new Set(pool.map((m) => m.family)).size > 1;
      if (paletteAmbiguous) stats.ambiguousPalette++;
    } else {
      stats.unmatchedPalette++;
    }

    const a = analyseSheet(img);

    // Duplicate colours in the base palette break RGB->index inversion at
    // runtime, so flag them explicitly.
    const seen = new Map();
    const dupes = [];
    if (img.palette) {
      for (let i = 0; i < 16; i++) {
        const rgb = (img.palette[i * 3] << 16) | (img.palette[i * 3 + 1] << 8) | img.palette[i * 3 + 2];
        if (seen.has(rgb)) dupes.push([seen.get(rgb), i]);
        else seen.set(rgb, i);
      }
    }

    // Sheets that are only a few pixels tall are failed rips in the source data.
    const broken = img.height < 64 || a.opaque === 0;
    if (broken) stats.broken++;
    if (a.poses.length) { stats.withPoses++; stats.poseTotal += a.poses.length; }

    const files = [`assets/sprites/${g.primary.file}`];
    if (g.continuation) files.push(`assets/sprites/${g.continuation.file}`);

    pendingSheets.push({
      baseKey,
      dumpMatch: dumpKey,
      img,
      analysis: a,
      entry: {
      key: baseKey,
      id: g.primary.num,
      name: g.primary.name.replace(/_/g, ' '),
      url: files[0],
      files,
      width: img.width,
      height: img.height,
      splitY: img.splitY,
      frameWidth: CELL,
      frameHeight: CELL,
      columns: COLUMNS,
      rows: a.rows,
      opaquePixels: a.opaque,
      broken,
      paletteFamily,
      paletteSlot,
      paletteAmbiguous: paletteAmbiguous || undefined,
      basePalette: img.palette ? img.palette.subarray(0, 48).toString('base64') : null,
      duplicatePaletteColours: dupes.length ? dupes : undefined,
      anchor: a.anchor,
      occupiedCells: a.occupiedCells,
      occupancy: occupancyHex(a.occupancy),
      cellBoxes: a.cellBoxes,
      contentBands: a.bands.map((b) => [b.y0, b.h]),
      poseBands: a.poseBands.map((b) => [b.y, b.h, b.count]),
      poses: a.poses.flatMap((p) => [p.band, p.col, p.x, p.y, p.w, p.h, p.ax, p.ay]),
      },
    });
  }

  // Key assignment. Several sheets share a display name (FFT reuses a character
  // across scenario-specific sprite slots). The clean key goes to the best
  // candidate — a usable rip, then the highest sprite number, which is the
  // canonical generic-job block at 996-1067 — and the rest are suffixed with
  // their sprite number so every sheet stays addressable.
  const byBaseKey = new Map();
  for (const p of pendingSheets) {
    let list = byBaseKey.get(p.baseKey);
    if (!list) byBaseKey.set(p.baseKey, (list = []));
    list.push(p);
  }
  for (const [baseKey, list] of byBaseKey) {
    const ranked = [...list].sort(
      (a, b) => Number(a.entry.broken) - Number(b.entry.broken) || b.entry.id - a.entry.id,
    );
    for (let i = 0; i < ranked.length; i++) {
      const p = ranked[i];
      p.entry.key = i === 0 ? baseKey : `${baseKey}_${p.entry.id}`;
    }
  }
  for (const p of pendingSheets) {
    const key = p.entry.key;
    if (usedKeys.has(key)) { warnings.push(`duplicate sheet key ${key}`); continue; }
    usedKeys.add(key);
    sheets[key] = p.entry;
    byNumber[p.entry.id] = key;
    if (dumpKey && key === dumpKey) dumpSheet(key, p.img, p.analysis);
  }

  // ── secondary asset groups ────────────────────────────────────────────────
  const summons = {};
  for (const f of fs.readdirSync(SUMMON_DIR).filter((x) => x.endsWith('.png')).sort()) {
    const m = SPRITE_RE.exec(f);
    const hdr = readHeader(path.join(SUMMON_DIR, f));
    const key = cleanKey(m ? m[2] : f.replace(/\.png$/, ''));
    summons[key] = {
      key,
      id: m ? Number(m[1]) : null,
      url: `assets/summons/${f}`,
      width: hdr.width,
      height: hdr.height,
      frameWidth: CELL,
      frameHeight: CELL,
      columns: Math.floor(hdr.width / CELL),
      rows: Math.floor(hdr.height / CELL),
    };
  }

  const portraits = {};
  for (const f of fs.readdirSync(PORTRAIT_DIR).filter((x) => x.endsWith('.png')).sort()) {
    const hdr = readHeader(path.join(PORTRAIT_DIR, f));
    const key = cleanKey(f.replace(/_uitx\.png$/, '').replace(/\.png$/, ''));
    portraits[key] = { key, url: `assets/portraits/${f}`, width: hdr.width, height: hdr.height };
  }

  const weapons = {};
  for (const f of fs.readdirSync(WEAPON_DIR).filter((x) => x.endsWith('.png')).sort()) {
    const hdr = readHeader(path.join(WEAPON_DIR, f));
    const base = f.replace(/\.png$/, '');
    const actFile = path.join(WEAPON_DIR, `${base}.act`);
    let palette = null;
    if (fs.existsSync(actFile)) {
      try { palette = parseAct(actFile).colours.toString('base64'); }
      catch (err) { warnings.push(String(err.message)); }
    }
    weapons[base.toLowerCase()] = {
      key: base.toLowerCase(),
      url: `assets/weapons/${f}`,
      width: hdr.width,
      height: hdr.height,
      frameWidth: 32,
      frameHeight: 32,
      columns: Math.floor(hdr.width / 32),
      rows: Math.floor(hdr.height / 32),
      palette,
    };
  }

  // ── palette payload ───────────────────────────────────────────────────────
  const palettePayload = {};
  for (const [family, entry] of [...families].sort((a, b) => a[0].localeCompare(b[0]))) {
    palettePayload[family] = {
      battle: entry.battle.map((p) => (p ? p.toString('base64') : null)),
      portrait: entry.portrait.map((p) => (p ? p.toString('base64') : null)),
      battleUsed: entry.stats.battleUsed,
      portraitUsed: entry.stats.portraitUsed,
    };
  }

  // Which SHP/SEQ sprite type each sheet animates with. The authoritative
  // assignment lives in the game's unit table, which is not part of this rip, so
  // it is derived from the measured art layout instead — see docs/ASSETS.md §5.4
  // for exactly how far that gets us.
  for (const entry of Object.values(sheets)) {
    entry.spriteType = resolveSpriteType(entry);
  }

  const manifest = {
    version: 2,
    generator: 'tools/build-assets.mjs',
    generatedAt: new Date().toISOString(),
    grid: { cell: CELL, columns: COLUMNS, sheetWidth: SHEET_W },
    notes: {
      pairing:
        'Numbered sprite PNGs come in (primary, continuation) pairs. The primary is 512x512, ' +
        'the continuation is the vertical remainder of the SAME image (512x464 for full units). ' +
        'Both files carry a byte-identical PLTE. Stacked they form 512x976 = 2x the 256x488 FFT SPR canvas. ' +
        '`splitY` is the y at which the second file begins.',
      transparency: 'Palette index 0 is transparent. Sheets are indexed PNGs with no tRNS chunk.',
      poses:
        'Whole-body frames live in the top content bands, one per 64px column. Everything below is ' +
        'SHP-assembled body parts. Monster sheets contain no whole-body frames at all.',
      cellBoxes: 'Flat array, 6 numbers per occupied cell: [cellIndex, x, y, w, h, pixels], x/y relative to the cell origin.',
      poseArray: 'Flat array, 8 numbers per whole-body pose: [bandIndex, column, x, y, w, h, feetX, feetY] in sheet pixels (origin top-left).',
      spriteType:
        'SHP/SEQ sprite type for public/assets/animations.json. Derived from the measured art ' +
        'layout, not read from the game: type1 vs type2 is NOT distinguishable from this rip and ' +
        'every human sheet is assigned type1.',
      occupancy: 'Hex string, 1 nibble per 4 cells, bit i of the nibble = cell (i) of that group, row-major.',
    },
    stats: {
      ...stats,
      paletteFamilies: families.size,
      summons: Object.keys(summons).length,
      portraits: Object.keys(portraits).length,
      weapons: Object.keys(weapons).length,
    },
    animations: {
      url: 'assets/animations.json',
      generator: 'tools/decode-shp-seq.mjs',
      note:
        'Decoded SHP/SEQ frame assembly and animation sequences. A sheet uses the SHP/SEQ pair ' +
        'named by its `spriteType`; sheets with spriteType null have no decoded animation and ' +
        'fall back to the whole-body pose frames in `poses`.',
    },
    sheets,
    byNumber,
    palettes: palettePayload,
    summons,
    portraits,
    weapons,
    warnings,
  };

  if (!dry) {
    fs.writeFileSync(OUT_FILE, JSON.stringify(manifest));
  }

  if (report) printReport(manifest, families);
  const size = dry ? 0 : fs.statSync(OUT_FILE).size;
  console.log(
    `[assets] ${stats.total} sheets (${stats.paired} paired, ${stats.singles} single, ${stats.broken} broken), ` +
    `${stats.poseTotal} whole-body poses across ${stats.withPoses} sheets, ` +
    `${families.size} palette families, ${warnings.length} warnings, ` +
    `${dry ? 'dry run' : `${(size / 1024).toFixed(0)} KB manifest`}, ${Date.now() - t0} ms`
  );
}

function nameAffinity(key, family) {
  const k = key.replace(/_/g, '');
  const f = family.replace(/_/g, '');
  if (k === f) return 100;
  if (k.startsWith(f) || f.startsWith(k)) return 50;
  let n = 0;
  for (let i = 0; i < Math.min(k.length, f.length); i++) { if (k[i] === f[i]) n++; else break; }
  return n;
}

function printReport(manifest, families) {
  const s = manifest.sheets;
  const keys = Object.keys(s);
  console.log('\n── palette families ──');
  const fam = [...families].slice(0, 6);
  for (const [name, e] of fam) {
    const p0 = e.battle[0];
    const rgb = p0 ? [...p0.subarray(0, 12)].join(',') : 'missing';
    console.log(`  ${name.padEnd(12)} battleUsed=${e.stats.battleUsed} portraitUsed=${e.stats.portraitUsed} pal0[0..3]=${rgb}`);
  }
  console.log('\n── sample sheets ──');
  for (const k of ['knight_male', 'knight_female', 'white_mage_male', 'chocobo', 'ramuza_ch1', 'event_001']) {
    const sh = s[k];
    if (!sh) { console.log(`  ${k}: MISSING`); continue; }
    console.log(
      `  ${k.padEnd(18)} ${sh.width}x${sh.height} pal=${sh.paletteFamily}:${sh.paletteSlot} ` +
      `cells=${sh.occupiedCells} poses=${sh.poses.length / 8} anchor=(${sh.anchor.x},${sh.anchor.y}) ` +
      `bands=[${sh.contentBands.map((b) => `${b[0]}+${b[1]}`).join(' ')}]`
    );
  }
  const noPose = keys.filter((k) => s[k].poses.length === 0 && !s[k].broken);
  console.log(`\n  sheets with no whole-body pose (${noPose.length}): ${noPose.slice(0, 20).join(', ')}${noPose.length > 20 ? ' …' : ''}`);
  const unmatched = keys.filter((k) => !s[k].paletteFamily);
  console.log(`  sheets with no palette family (${unmatched.length}): ${unmatched.slice(0, 20).join(', ')}${unmatched.length > 20 ? ' …' : ''}`);
  const broken = keys.filter((k) => s[k].broken);
  console.log(`  broken source rips (${broken.length}): ${broken.join(', ')}`);
  if (manifest.warnings.length) {
    console.log(`\n── warnings (${manifest.warnings.length}) ──`);
    for (const w of manifest.warnings.slice(0, 20)) console.log(`  ${w}`);
  }
}

function dumpSheet(key, img, a) {
  const outDir = path.join(ROOT, 'tools', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const rgba = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    const v = img.indices[i];
    const o = i * 4;
    if (v === 0) {
      const x = i % img.width, y = (i / img.width) | 0;
      const c = ((x >> 3) + (y >> 3)) % 2 ? 60 : 90;
      rgba[o] = c; rgba[o + 1] = c; rgba[o + 2] = c; rgba[o + 3] = 255;
    } else {
      rgba[o] = img.palette[v * 3];
      rgba[o + 1] = img.palette[v * 3 + 1];
      rgba[o + 2] = img.palette[v * 3 + 2];
      rgba[o + 3] = 255;
    }
  }
  // green boxes around detected poses, magenta feet marker
  const px = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  };
  for (const p of a.poses) {
    for (let x = p.x; x < p.x + p.w; x++) { px(x, p.y, 0, 255, 0); px(x, p.y + p.h - 1, 0, 255, 0); }
    for (let y = p.y; y < p.y + p.h; y++) { px(p.x, y, 0, 255, 0); px(p.x + p.w - 1, y, 0, 255, 0); }
    for (let d = -3; d <= 3; d++) { px(p.ax + d, p.ay, 255, 0, 255); px(p.ax, p.ay + d, 255, 0, 255); }
  }
  const file = path.join(outDir, `${key}.png`);
  fs.writeFileSync(file, encodeRgba(img.width, img.height, rgba));
  console.log(`[assets] dumped ${file}`);
}

main();
