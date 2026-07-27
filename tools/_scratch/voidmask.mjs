#!/usr/bin/env node
/** Paint the metrics.mjs EDGE-CONNECTED void mask magenta, and report its row profile. */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [, , src, out] = process.argv;
const b64 = readFileSync(resolve(src)).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const r = await page.evaluate(async ({ b64 }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const W = 480, H = 270;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const im = g.getImageData(0, 0, W, H);
  const d = im.data;
  const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i+1], d[i+2]]; };
  const corners = [at(2,2), at(W-3,2), at(2,H-3), at(W-3,H-3)];
  const m = (x,y) => { const [r,g2,b]=at(x,y); return corners.some(([cr,cg,cb])=>Math.abs(r-cr)+Math.abs(g2-cg)+Math.abs(b-cb)<24); };
  const v = new Uint8Array(W*H); const st=[];
  for (let x=0;x<W;x++) for (const y of [0,H-1]) { const i=y*W+x; if(!v[i]&&m(x,y)){v[i]=1;st.push(i);} }
  for (let y=0;y<H;y++) for (const x of [0,W-1]) { const i=y*W+x; if(!v[i]&&m(x,y)){v[i]=1;st.push(i);} }
  let bg=0;
  while(st.length){ const i=st.pop(); bg++; const x=i%W, y=(i/W)|0;
    const p=(nx,ny)=>{ if(nx<0||ny<0||nx>=W||ny>=H)return; const j=ny*W+nx; if(v[j])return; if(!m(nx,ny))return; v[j]=1; st.push(j); };
    p(x+1,y);p(x-1,y);p(x,y+1);p(x,y-1); }
  const rows=[];
  for (let band=0; band<10; band++) { let n=0,t=0;
    for (let y=Math.floor(band*H/10); y<Math.floor((band+1)*H/10); y++) for (let x=0;x<W;x++){ t++; if(v[y*W+x])n++; }
    rows.push(+(n/t).toFixed(3)); }
  for (let i=0;i<W*H;i++) if(v[i]) { d[i*4]=255; d[i*4+1]=0; d[i*4+2]=255; }
  g.putImageData(im,0,0);
  return { frac:+(bg/(W*H)).toFixed(3), rows, corners, png: c.toDataURL('image/png') };
}, { b64 });
console.log('frac', r.frac, 'corners', JSON.stringify(r.corners));
console.log('void share by row decile (top->bottom):', r.rows.join(' '));
if (out) writeFileSync(resolve(out), Buffer.from(r.png.split(',')[1], 'base64'));
await browser.close();
