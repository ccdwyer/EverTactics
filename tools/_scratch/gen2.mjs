import { readdirSync, writeFileSync } from 'node:fs';
const files=readdirSync('/Users/chris/Developer/EverTactics/public/assets/sprites/').filter(f=>f.endsWith('.png')).map(f=>f.replace(/\.png$/,''));
const best=new Map();
for(const f of files){
  const m=/^(\d+)_(.+)_hd$/.exec(f); if(!m) continue;
  const id=Number(m[1]); const key=m[2].toLowerCase();
  const rank = id>=980 ? 0 : 1;                 // prefer the generic-class block
  const prev=best.get(key);
  if(!prev || rank<prev.rank || (rank===prev.rank && id<prev.id)) best.set(key,{id,rank,file:f});
}
const lines=[...best.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([k,v])=>`  '${k}': '${v.file}',`);
writeFileSync('/tmp/claude-501/-Users-chris-Developer-EverTactics/c00ef071-2c14-4cc2-88bb-fccf4aa9d7f9/scratchpad/alias.ts',lines.join('\n'));
console.log(best.size,'aliases',lines.join('\n').length,'bytes');
console.log(lines.filter(l=>/knight|squire|archer|chemist|monk|mage|thief|choco|summoner|geomancer|dragoon|orator|mediator|bard|dancer|calc|arith|mime|lancer/.test(l)).join('\n'));
