#!/usr/bin/env node
/**
 * farTop / board luminance ratio.
 *
 * farTop = mean luma of the top 15% of frame height, full width (the empty upper band).
 * board  = mean luma of the central staging region, y in [0.30, 0.85], x in [0.12, 0.88].
 *
 * References measure 0.46-0.53. Ours measured 1.05 in round 7.
 * Usage: fartop.mjs img.png [img2.jpg ...]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';

const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
const rows = [];
for (const f of files) {
  const ext = extname(f).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const b64 = readFileSync(resolve(f)).toString('base64');
  const r = await page.evaluate(
    async ({ b64, mime }) => {
      const img = new Image();
      img.src = `data:${mime};base64,` + b64;
      await img.decode();
      const W = img.width, H = img.height;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const im = g.getImageData(0, 0, W, H).data;
      const region = (x0, y0, x1, y1) => {
        let s = 0, n = 0, p = [];
        for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
          for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x++) {
            const i = (y * W + x) * 4;
            const L = 0.2126 * im[i] + 0.7152 * im[i + 1] + 0.0722 * im[i + 2];
            s += L; n++;
            if (((x + y) & 3) === 0) p.push(L);
          }
        }
        p.sort((a, b) => a - b);
        return { mean: s / n, p95: p[Math.floor(p.length * 0.95)] };
      };
      const top = region(0, 0, 1, 0.15);
      const board = region(0.12, 0.30, 0.88, 0.85);
      const bot = region(0, 0.88, 1, 1);
      return {
        farTop: +top.mean.toFixed(2), farTopP95: +top.p95.toFixed(1),
        board: +board.mean.toFixed(2), boardP95: +board.p95.toFixed(1),
        bottom: +bot.mean.toFixed(2),
        ratio: +(top.mean / board.mean).toFixed(3),
        botRatio: +(bot.mean / board.mean).toFixed(3),
      };
    },
    { b64, mime },
  );
  rows.push({ file: basename(f), ...r });
}
console.table(rows);
await browser.close();
