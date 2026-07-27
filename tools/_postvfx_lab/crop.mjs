import { chromium } from 'playwright';
const [a,b,x,y,w,h] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({viewport:{width:Number(w)*2+20,height:Number(h)}});
const dir = new URL('./shots/', import.meta.url).href;
await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:20px">
<div style="width:${w}px;height:${h}px;overflow:hidden;position:relative"><img src="${dir}${a}.png" style="position:absolute;left:${-x}px;top:${-y}px"></div>
<div style="width:${w}px;height:${h}px;overflow:hidden;position:relative"><img src="${dir}${b}.png" style="position:absolute;left:${-x}px;top:${-y}px"></div>
</body>`);
await page.waitForTimeout(500);
await page.screenshot({path: new URL('./shots/_cmp.png', import.meta.url).pathname});
await browser.close();
