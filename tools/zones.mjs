#!/usr/bin/env node
/**
 * Per-zone warm/cool measurement.
 *
 * Round 9 measured "our frame is a warm diorama inside a cold shell" by hand.
 * This makes that measurement repeatable: mean (red - blue) per zone, on a fixed
 * 480x270 draw so a 1920x1080 PNG and a 1280x720 JPEG stay comparable.
 *
 *   node tools/zones.mjs shots/battle-open.png refs/curated/triangle/press_002_gematsu_1920x1080.jpg
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: node tools/zones.mjs <image> [image...]');
  process.exit(2);
}

const mimeOf = (p) => {
  const e = extname(p).toLowerCase();
  return e === '.png' ? 'png' : e === '.webp' ? 'webp' : 'jpeg';
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });

const ZONES = {
  cornerTL: [0.0, 0.0, 0.25, 0.25],
  cornerBR: [0.75, 0.75, 1.0, 1.0],
  nearBand: [0.0, 0.8, 1.0, 1.0],
  farBand: [0.0, 0.0, 1.0, 0.2],
  centre: [0.3, 0.3, 0.7, 0.7],
};

const rows = [];
for (const f of files) {
  const p = resolve(f);
  if (!existsSync(p)) {
    console.error(`missing: ${p}`);
    continue;
  }
  const src = `data:image/${mimeOf(p)};base64,${readFileSync(p).toString('base64')}`;
  const res = await page.evaluate(
    async ({ src, ZONES }) => {
      const img = new Image();
      await new Promise((ok, no) => {
        img.onload = ok;
        img.onerror = no;
        img.src = src;
      });
      const W = 480,
        H = 270;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      const out = {};
      for (const [name, [x0, y0, x1, y1]] of Object.entries(ZONES)) {
        let sum = 0,
          n = 0,
          luma = 0;
        for (let y = Math.round(y0 * H); y < Math.round(y1 * H); y++) {
          for (let x = Math.round(x0 * W); x < Math.round(x1 * W); x++) {
            const i = (y * W + x) * 4;
            sum += d[i] - d[i + 2];
            luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            n++;
          }
        }
        out[name] = { rb: sum / n, luma: luma / n };
      }
      return out;
    },
    { src, ZONES },
  );
  rows.push({ name: basename(p), res });
}

await browser.close();

const names = Object.keys(ZONES);
const pad = (s, n) => String(s).padStart(n);
console.log(pad('image', 34) + names.map((n) => pad(n, 10)).join(''));
for (const r of rows) {
  console.log(
    pad(r.name.slice(0, 34), 34) + names.map((n) => pad(r.res[n].rb.toFixed(1), 10)).join(''),
  );
}
console.log('\nluma:');
console.log(pad('image', 34) + names.map((n) => pad(n, 10)).join(''));
for (const r of rows) {
  console.log(
    pad(r.name.slice(0, 34), 34) + names.map((n) => pad(r.res[n].luma.toFixed(1), 10)).join(''),
  );
}
