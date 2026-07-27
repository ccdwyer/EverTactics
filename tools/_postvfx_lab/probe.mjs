import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal']});
const p = await b.newPage({viewport:{width:1280,height:720}});
p.on('console', m=>console.log('[c]',m.text()));
p.on('pageerror', e=>console.log('[e]',e.message));
await p.goto('http://localhost:5173/lab.html?vfx=fire-burst&el=fire&t=0.55',{waitUntil:'load'});
await p.waitForFunction('window.__EVERTACTICS_READY__===true',{timeout:20000});
console.log(await p.evaluate(() => {
  const L = window.__LAB__;
  const vfx = L.vfx;
  const add = vfx.group.children[0];
  const g = add.geometry;
  const life = g.getAttribute('aLife');
  let alive = 0; const t = add.material.uniforms.uTime.value;
  for (let i=0;i<life.count;i++){ const bt=life.getX(i), lt=life.getY(i); const tt=(t-bt)/lt; if(tt>=0&&tt<1) alive++; }
  const atlas = add.material.uniforms.uAtlas.value;
  const rows=[]; const sz=g.getAttribute('aSize'), c0=g.getAttribute('aColor0'), or_=g.getAttribute('aOrigin'), en=g.getAttribute('aEnv');
  for (let i=0;i<life.count && rows.length<6;i++){ const bt=life.getX(i), lt=life.getY(i); const tt=(t-bt)/lt; if(tt>=0&&tt<1)
    rows.push({i, tt:+tt.toFixed(3), sprite:life.getW(i), size:[sz.getX(i),sz.getY(i)], col:[c0.getX(i),c0.getY(i),c0.getZ(i),c0.getW(i)], org:[+or_.getX(i).toFixed(2),+or_.getY(i).toFixed(2),+or_.getZ(i).toFixed(2)], env:[en.getX(i),en.getY(i),en.getZ(i),en.getW(i)]}); }
  return JSON.stringify({ uTime:t, alive, rows }, null, 1);
}));
await b.close();
