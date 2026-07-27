#!/usr/bin/env node
/** Paint the metrics.mjs background mask magenta so it can be seen. */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , src, out] = process.argv;
const b64 = readFileSync(resolve(src)).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const png = await page.evaluate(
  async ({ b64 }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const W = img.width, H = img.height;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const im = g.getImageData(0, 0, W, H);
    const d = im.data;
    const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const corners = [px(2, 2), px(W - 3, 2), px(2, H - 3), px(W - 3, H - 3)];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      for (const [cr, cg, cb] of corners) {
        if (Math.abs(r - cr) + Math.abs(gg - cg) + Math.abs(b - cb) < 24) {
          d[i] = 255; d[i + 1] = 0; d[i + 2] = 220;
          break;
        }
      }
    }
    g.putImageData(im, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  },
  { b64 },
);
writeFileSync(resolve(out), Buffer.from(png, 'base64'));
await browser.close();
console.log('ok', out);
