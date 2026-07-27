import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [a,b,x,y,w,h,scale] = process.argv.slice(2);
const S=Number(scale||4), W=Number(w), H=Number(h);
const dir = new URL('./shots/', import.meta.url).pathname;
const uri = (n)=>'data:image/png;base64,'+readFileSync(dir+n+'.png').toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({viewport:{width:W*S*2+16,height:H*S}});
await page.setContent(`<body style="margin:0;background:#000;display:flex;gap:16px">
${[a,b].map(n=>`<div style="width:${W*S}px;height:${H*S}px;overflow:hidden;position:relative">
<img src="${uri(n)}" style="position:absolute;left:${-x*S}px;top:${-y*S}px;width:${1280*S}px;image-rendering:pixelated">
</div>`).join('')}</body>`);
await page.waitForTimeout(400);
await page.screenshot({path: dir+'_zoom.png'});
await browser.close();
