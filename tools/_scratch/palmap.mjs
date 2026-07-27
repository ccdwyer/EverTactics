import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadIndexed } from './png.mjs';
const SD='/Users/chris/Developer/EverTactics/public/assets/sprites/';
const PD='/Users/chris/Developer/EverTactics/public/assets/palettes/';
const fams=new Map();
for(const f of readdirSync(PD).filter(f=>f.endsWith('.act'))){
  const m=/^(.*)_battle_pal(\d+)\.act$/.exec(f); if(!m) continue;
  const b=readFileSync(PD+f); const key=[...b.subarray(0,48)].join(',');
  if(!fams.has(m[1])) fams.set(m[1],{});
  fams.get(m[1])[Number(m[2])]=key;
}
const bySig=new Map();
for(const [fam,pals] of fams) for(const [slot,sig] of Object.entries(pals)) {
  if(!bySig.has(sig)) bySig.set(sig,[]); bySig.get(sig).push(fam+'#'+slot);
}
const out={}; let miss=[]; const slotHist={};
for(const f of readdirSync(SD).filter(f=>f.endsWith('.png'))){
  const s=loadIndexed(SD+f); const sig=[...s.plte.subarray(0,48)].join(',');
  const hit=bySig.get(sig);
  if(!hit){miss.push(f);continue;}
  // prefer unique family
  const fams2=[...new Set(hit.map(h=>h.split('#')[0]))];
  out[f.replace(/\.png$/,'')]={fams:fams2,slots:hit.map(h=>Number(h.split('#')[1]))};
  for(const h of hit){const sl=h.split('#')[1];slotHist[sl]=(slotHist[sl]||0)+1;}
}
console.log('matched',Object.keys(out).length,'missed',miss.length);
console.log('missed sample',miss.slice(0,15));
console.log('slot histogram',slotHist);
const amb=Object.entries(out).filter(([,v])=>v.fams.length>1);
console.log('ambiguous',amb.length, amb.slice(0,5));
writeFileSync('/tmp/claude-501/-Users-chris-Developer-EverTactics/c00ef071-2c14-4cc2-88bb-fccf4aa9d7f9/scratchpad/palmap.json',JSON.stringify(out,null,1));
console.log(Object.entries(out).slice(0,25).map(([k,v])=>k+' -> '+v.fams.join('|')+' slot'+v.slots.join(',')).join('\n'));
