#!/usr/bin/env node
/** Report mean RGB/luma of rectangular regions of an image. Usage: sample.mjs img x,y,w,h [more...] */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
const [, , src, ...rects] = process.argv;
const e = extname(src).toLowerCase();
const mime = e === '.png' ? 'png' : e === '.webp' ? 'webp' : 'jpeg';
const uri = `data:image/${mime};base64,${readFileSync(resolve(src)).toString('base64')}`;
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ({ uri, rects }) => {
  const img = new Image();
  img.src = uri;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return rects.map((r) => {
    const [x, y, w, h] = r.split(',').map(Number);
    const d = g.getImageData(x, y, w, h).data;
    let R = 0, G = 0, B = 0, n = 0, mn = 999, mx = -1;
    const L = [];
    for (let i = 0; i < d.length; i += 4) {
      R += d[i]; G += d[i + 1]; B += d[i + 2]; n++;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      L.push(l); mn = Math.min(mn, l); mx = Math.max(mx, l);
    }
    const mean = L.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(L.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    return { rect: r, rgb: [R / n, G / n, B / n].map((v) => Math.round(v)), luma: +mean.toFixed(1), sd: +sd.toFixed(1), min: +mn.toFixed(0), max: +mx.toFixed(0) };
  });
}, { uri, rects });
await browser.close();
console.log(JSON.stringify(out, null, 1));
