#!/usr/bin/env node
/** Hue histogram (12 bins x 30deg) weighted by pixel count, saturated pixels only. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
const browser = await chromium.launch();
const page = await browser.newPage();
for (const f of process.argv.slice(2)) {
  const mime = extname(f).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const b64 = readFileSync(resolve(f)).toString('base64');
  const r = await page.evaluate(async ({ b64, mime }) => {
    const img = new Image(); img.src = `data:${mime};base64,` + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const bins = new Array(12).fill(0); let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i]/255, G = d[i+1]/255, B = d[i+2]/255;
      const mx = Math.max(R,G,B), mn = Math.min(R,G,B);
      if (mx < 0.06 || mx - mn < 0.06) continue;
      let h;
      if (mx === R) h = ((G - B) / (mx - mn)) % 6;
      else if (mx === G) h = (B - R) / (mx - mn) + 2;
      else h = (R - G) / (mx - mn) + 4;
      h = ((h * 60) % 360 + 360) % 360;
      bins[Math.floor(h / 30)]++; n++;
    }
    return bins.map((v) => +(v / Math.max(1, n)).toFixed(3));
  }, { b64, mime });
  // how many bins hold >=5% -> hue variety
  const variety = r.filter((v) => v >= 0.05).length;
  console.log(basename(f).padEnd(36), r.map((v)=>String(v).padStart(5)).join(''), ' bins>=5%:', variety);
}
await browser.close();
