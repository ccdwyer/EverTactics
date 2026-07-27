import { readdirSync, writeFileSync } from 'node:fs';
const files=readdirSync('/Users/chris/Developer/EverTactics/public/assets/sprites/').filter(f=>f.endsWith('.png')).map(f=>f.replace(/\.png$/,''));
const best=new Map();
for(const f of files){
  const m=/^(\d+)_(.+)_hd$/.exec(f); if(!m) {console.log('ODD',f);continue;}
  const id=Number(m[1]); const key=m[2].toLowerCase();
  const rank = id>=980 ? 0 : 1;
  const prev=best.get(key);
  if(!prev || rank<prev.rank || (rank===prev.rank && id<prev.id)) best.set(key,{id,rank,file:f});
}
const title=k=>k.split('_').map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join('_');
let bad=0;
for(const [k,v] of best){ const rebuilt=`${v.id}_${title(k)}_hd`; if(rebuilt!==v.file){bad++;console.log('MISMATCH',v.file,'!=',rebuilt);} }
console.log('mismatches',bad,'of',best.size);
const lines=[...best.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([k,v])=>`${k}:${v.id}`);
const packed=lines.join(' ');
writeFileSync('/tmp/claude-501/-Users-chris-Developer-EverTactics/c00ef071-2c14-4cc2-88bb-fccf4aa9d7f9/scratchpad/alias.txt',packed);
console.log('packed bytes',packed.length);
