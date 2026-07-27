import { readFileSync } from 'node:fs';
const PD='/Users/chris/Developer/EverTactics/public/assets/palettes/';
for(const fam of ['battle_knight_m','battle_kuro_m','battle_ramuza_battle'.replace('_battle','')]) {
for(let i=1;i<=8;i++){
  try{const b=readFileSync(`${PD}${fam}_battle_pal${i}.act`);
  const p=[];for(let k=0;k<16;k++)p.push(`${b[k*3]},${b[k*3+1]},${b[k*3+2]}`);
  const empty=p.every(s=>s==='0,0,0');
  console.log(fam,'pal'+i, empty?'EMPTY':p.slice(3,7).join(' | '));}catch(e){console.log(fam,'pal'+i,'missing');}
}}
