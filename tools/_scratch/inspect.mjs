import { readFileSync, readdirSync } from 'node:fs';
import zlib from 'node:zlib';

function chunks(buf) {
  const out = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}
function parse(file) {
  const buf = readFileSync(file);
  const cs = chunks(buf);
  const ihdr = cs.find(c => c.type === 'IHDR').data;
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  const plte = cs.find(c => c.type === 'PLTE');
  const trns = cs.find(c => c.type === 'tRNS');
  const idat = Buffer.concat(cs.filter(c => c.type === 'IDAT').map(c => c.data));
  return { w, h, bitDepth, colorType, interlace, plte: plte?.data, trns: trns?.data, idat, types: cs.map(c=>c.type) };
}
function unfilter(raw, w, h, bpp) {
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
      }
      cur[i] = v & 0xff;
    }
  }
  return out;
}

const dir = '/Users/chris/Developer/EverTactics/public/assets/sprites/';
const files = readdirSync(dir).filter(f=>f.endsWith('.png'));
// header survey
const stats = new Map();
for (const f of files) {
  const m = parse(dir + f);
  const k = `${m.w}x${m.h} depth=${m.bitDepth} ct=${m.colorType} il=${m.interlace} plte=${m.plte?.length/3} trns=${m.trns?.length}`;
  stats.set(k, (stats.get(k)||0)+1);
}
console.log([...stats.entries()]);

// compare 1000 vs 1001
for (const f of ['1000_Knight_Male_hd.png','1001_Knight_Male_hd.png','1002_Knight_Female_hd.png']) {
  const m = parse(dir+f);
  const raw = zlib.inflateSync(m.idat);
  const idx = unfilter(raw, m.w, m.h, 1);
  const used = new Set(idx);
  console.log(f, 'indices used:', [...used].sort((a,b)=>a-b).join(','));
  const pal = [];
  for (let i=0;i<m.plte.length/3;i++) pal.push([m.plte[i*3],m.plte[i*3+1],m.plte[i*3+2]].join(','));
  console.log('  PLTE:', pal.join(' | '));
  console.log('  tRNS:', m.trns ? [...m.trns].join(',') : 'none');
  global['idx_'+f] = idx;
}
const a = global['idx_1000_Knight_Male_hd.png'], b = global['idx_1001_Knight_Male_hd.png'];
let diff=0; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) diff++;
console.log('1000 vs 1001 index diff pixels:', diff, '/', a.length);

// act palette
const act = readFileSync('/Users/chris/Developer/EverTactics/public/assets/palettes/battle_knight_m_battle_pal1.act');
console.log('act len', act.length);
const ap=[]; for(let i=0;i<16;i++) ap.push([act[i*3],act[i*3+1],act[i*3+2]].join(','));
console.log('act pal1:', ap.join(' | '));
const act2 = readFileSync('/Users/chris/Developer/EverTactics/public/assets/palettes/battle_knight_m_battle_pal2.act');
const ap2=[]; for(let i=0;i<16;i++) ap2.push([act2[i*3],act2[i*3+1],act2[i*3+2]].join(','));
console.log('act pal2:', ap2.join(' | '));
