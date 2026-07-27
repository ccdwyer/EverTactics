#!/usr/bin/env node
/** 3x3 (or NxN) luma grid + brightest-cell report. Usage: grid.mjs img [n] */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
const files = process.argv.slice(2).filter((a) => !/^\d+$/.test(a));
const N = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 3);
const browser = await chromium.launch();
const page = await browser.newPage();
for (const f of files) {
  const ext = extname(f).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const b64 = readFileSync(resolve(f)).toString('base64');
  const r = await page.evaluate(async ({ b64, mime, N }) => {
    const img = new Image(); img.src = `data:${mime};base64,` + b64; await img.decode();
    const W = img.width, H = img.height;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const im = g.getImageData(0, 0, W, H).data;
    const grid = [];
    for (let r = 0; r < N; r++) {
      const row = [];
      for (let cc = 0; cc < N; cc++) {
        let s = 0, n = 0, sat = 0;
        for (let y = Math.floor(r * H / N); y < Math.floor((r + 1) * H / N); y += 2)
          for (let x = Math.floor(cc * W / N); x < Math.floor((cc + 1) * W / N); x += 2) {
            const i = (y * W + x) * 4;
            s += 0.2126 * im[i] + 0.7152 * im[i + 1] + 0.0722 * im[i + 2];
            const mx = Math.max(im[i], im[i+1], im[i+2]), mn = Math.min(im[i], im[i+1], im[i+2]);
            sat += mx > 0 ? (mx - mn) / mx : 0;
            n++;
          }
        row.push([+(s / n).toFixed(1), +(sat / n).toFixed(2)]);
      }
      grid.push(row);
    }
    return grid;
  }, { b64, mime, N });
  console.log(basename(f));
  for (const row of r) console.log('  ' + row.map(([l, s]) => `${String(l).padStart(6)}/${s.toFixed(2)}`).join(' '));
}
await browser.close();
