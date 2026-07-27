#!/usr/bin/env node
/** Report luma mean/sd for rectangular regions of a PNG. Usage: region.mjs img.png x,y,w,h[:label] ... */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , src, ...regions] = process.argv;
const b64 = readFileSync(resolve(src)).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(
  async ({ b64, regions }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return regions.map((spec) => {
      const [rect, label] = spec.split(':');
      const [x, y, w, h] = rect.split(',').map(Number);
      const d = g.getImageData(x, y, w, h).data;
      let s = 0, sq = 0, n = 0;
      let rs = 0, gs = 0, bs = 0;
      for (let i = 0; i < d.length; i += 4) {
        const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        s += L; sq += L * L; n++;
        rs += d[i]; gs += d[i + 1]; bs += d[i + 2];
      }
      const mean = s / n;
      return {
        label: label ?? rect,
        rect,
        mean: +mean.toFixed(2),
        sd: +Math.sqrt(Math.max(0, sq / n - mean * mean)).toFixed(2),
        rgb: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)],
      };
    });
  },
  { b64, regions },
);
console.log(JSON.stringify(out, null, 2));
await browser.close();
