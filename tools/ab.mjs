#!/usr/bin/env node
/**
 * Blind A/B pair builder for the visual-critic loop.
 *
 * Takes our rendered frame and a reference screenshot from a shipped commercial
 * tactical RPG, normalises BOTH to identical dimensions and encoding, and writes
 * them as neutrally-named `left.png` / `right.png` in a pair directory.
 *
 * Normalisation matters: differing resolution, aspect or file size is a tell that
 * lets a critic identify our frame without judging it. Both images go through the
 * same canvas draw and the same PNG encoder at the same size.
 *
 * The critic is given only the two paths. Which side is ours is decided by the
 * caller (--swap) and is never written to disk, so the comparison is genuinely
 * blind unless the critic recognises the art on its merits — which is the point.
 *
 * Usage:
 *   node tools/ab.mjs --ours shots/battle-open.png --ref refs/Triangle/x.jpg \
 *                     --out shots/ab/pair-01 --swap 1
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const ours = resolve(arg('ours', 'shots/battle-open.png'));
const ref = resolve(arg('ref', ''));
const outDir = resolve(arg('out', 'shots/ab/pair'));
const swap = arg('swap', '0') === '1';
const W = Number(arg('w', 1600));
const H = Number(arg('h', 900));
// Centre-crop fraction. 1 = whole frame. ~0.6 removes most HUD chrome from both
// sides so judges compare rendering rather than reading names and menu text.
const CROP = Math.max(0.2, Math.min(1, Number(arg('crop', 1))));

for (const [label, p] of [['ours', ours], ['ref', ref]]) {
  if (!p || !existsSync(p)) {
    console.error(`FAIL: ${label} image not found: ${p}`);
    process.exit(2);
  }
}

const dataUri = (p) => {
  const ext = p.toLowerCase().endsWith('.png') ? 'png'
    : p.toLowerCase().endsWith('.webp') ? 'webp' : 'jpeg';
  return `data:image/${ext};base64,${readFileSync(p).toString('base64')}`;
};

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

/**
 * Draw an image "cover"-fitted into a WxH canvas on a black field, so both
 * candidates end up pixel-identical in framing terms.
 */
await page.setContent(`
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
window.draw = (src) => new Promise((done, fail) => {
  const img = new Image();
  img.onload = () => {
    const ctx = document.getElementById('c').getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ${W}, ${H});

    // CROP MODE: take a centred window of the source before fitting.
    //
    // Round 4 showed the uncropped test had hit its ceiling for a reason that has
    // nothing to do with render quality: judges identified frames by READING them.
    // "Right frame is literally Triangle Strategy: 'Prince Roland', speaker
    // 'Erador'", "invented roster names (ALDRIC, CORVIN)", "keyboard prompts
    // (ENTER Confirm, ESC Back)". Character names, HUD vocabulary and on-screen
    // text are recognition cues, not rendering tells, and no amount of shader work
    // removes them. Cropping to the centre drops most HUD chrome on both sides
    // symmetrically and leaves the diorama — which is the thing under test.
    const cropFrac = ${CROP};
    const sw = img.width * cropFrac;
    const sh = img.height * cropFrac;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;

    const s = Math.min(${W} / sw, ${H} / sh);
    const w = sw * s, h = sh * s;
    ctx.drawImage(img, sx, sy, sw, sh, (${W} - w) / 2, (${H} - h) / 2, w, h);
    done({ w: img.width, h: img.height, cropped: cropFrac < 1 });
  };
  img.onerror = () => fail(new Error('decode failed'));
  img.src = src;
});
</script>`);

const sides = swap ? [ref, ours] : [ours, ref];
const names = ['left', 'right'];
const meta = [];

for (let i = 0; i < 2; i++) {
  const info = await page.evaluate((s) => window.draw(s), dataUri(sides[i]));
  await page.screenshot({ path: `${outDir}/${names[i]}.png`, type: 'png' });
  meta.push({ side: names[i], source: info });
}

await browser.close();

// Deliberately does NOT record which side is ours.
console.log(JSON.stringify({ outDir, size: [W, H], sides: meta }, null, 2));
