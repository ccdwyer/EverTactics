#!/usr/bin/env node
/**
 * Contact-sheet builder — tiles a directory of images into a labelled grid PNG
 * so a whole reference corpus can be reviewed in one look and curated by eye.
 *
 * Usage:
 *   node tools/contact.mjs --dir refs/Triangle --out shots/contact-triangle.png --cols 8
 */
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const dir = resolve(arg('dir', 'refs/Triangle'));
const out = resolve(arg('out', 'shots/contact.png'));
const cols = Number(arg('cols', 8));
const cell = Number(arg('cell', 320));
const start = Number(arg('start', 0));
const limit = Number(arg('limit', 96));

const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const files = readdirSync(dir)
  .filter((f) => EXT.has(extname(f).toLowerCase()))
  .filter((f) => statSync(join(dir, f)).size > 20000)
  .sort()
  .slice(start, start + limit);

if (!files.length) {
  console.error('No images found in ' + dir);
  process.exit(2);
}

const mime = (f) => {
  const e = extname(f).toLowerCase();
  return e === '.png' ? 'png' : e === '.webp' ? 'webp' : 'jpeg';
};

const items = files.map((f, i) => ({
  i: start + i,
  name: f,
  src: `data:image/${mime(f)};base64,${readFileSync(join(dir, f)).toString('base64')}`,
}));

const rows = Math.ceil(items.length / cols);
const labelH = 26;
const W = cols * cell;
const H = rows * (cell * 0.5625 + labelH);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: Math.ceil(H) },
  deviceScaleFactor: 1,
});

await page.setContent(`
<style>
  html,body{margin:0;background:#111;font:12px ui-monospace,monospace;color:#9fb}
  .g{display:grid;grid-template-columns:repeat(${cols},${cell}px)}
  .c{width:${cell}px}
  .c img{width:${cell}px;height:${Math.round(cell * 0.5625)}px;object-fit:cover;display:block}
  .l{height:${labelH}px;line-height:${labelH}px;padding:0 4px;overflow:hidden;white-space:nowrap;
     text-overflow:ellipsis;background:#000;border-bottom:1px solid #222}
  .n{color:#fd6;font-weight:700}
</style>
<div class="g">
${items.map((it) => `<div class="c"><div class="l"><span class="n">[${it.i}]</span> ${it.name.slice(0, 34)}</div><img src="${it.src}"></div>`).join('')}
</div>`);

await page.waitForTimeout(1500);
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: true, type: 'png' });
await browser.close();

console.log(JSON.stringify({ out, count: items.length, range: [start, start + items.length - 1] }, null, 2));
