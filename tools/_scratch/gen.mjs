import { readFileSync, writeFileSync } from 'node:fs';
const m=JSON.parse(readFileSync('/tmp/claude-501/-Users-chris-Developer-EverTactics/c00ef071-2c14-4cc2-88bb-fccf4aa9d7f9/scratchpad/palmap.json','utf8'));
const byFam=new Map();
for(const [sheet,v] of Object.entries(m)){
  const fam=v.fams[0].replace(/^battle_/,'');
  const id=sheet.split('_')[0];
  if(!byFam.has(fam))byFam.set(fam,[]);
  byFam.get(fam).push(id);
}
const lines=[...byFam.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([f,ids])=>`  ${/^[a-z][a-z0-9_]*$/.test(f)?f:JSON.stringify(f)}: '${ids.join(' ')}',`);
writeFileSync('/tmp/claude-501/-Users-chris-Developer-EverTactics/c00ef071-2c14-4cc2-88bb-fccf4aa9d7f9/scratchpad/fam.ts',lines.join('\n'));
console.log(byFam.size,'families'); console.log(lines.slice(0,6).join('\n'));
console.log('bytes',lines.join('\n').length);
