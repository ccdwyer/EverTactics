#!/usr/bin/env node
/** Crop a region out of a PNG and optionally upscale it, for close inspection. */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , src, x, y, w, h, out, scaleArg] = process.argv;
const s = Number(scaleArg ?? 2);
const b64 = readFileSync(resolve(src)).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(
  async ({ b64, x, y, w, h, s }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  },
  { b64, x: +x, y: +y, w: +w, h: +h, s },
);
writeFileSync(resolve(out), Buffer.from(data, 'base64'));
await browser.close();
console.log('ok', out);
