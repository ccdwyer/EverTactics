import { loadIndexed } from './png.mjs';
import { readdirSync } from 'node:fs';
const dir='/Users/chris/Developer/EverTactics/public/assets/sprites/';
for (const f of ['1000_Knight_Male_hd.png','982_Squire_Male_hd.png','1552_Moogle_hd.png']) {
  let file = dir+f; try{loadIndexed(file);}catch{file='/Users/chris/Developer/EverTactics/public/assets/summons/'+f;}
  const s=loadIndexed(file);
  for (const N of [2,4]) {
    let bad=0,tot=0;
    for(let y=0;y+N<=s.h;y+=N)for(let x=0;x+N<=s.w;x+=N){const v=s.idx[y*s.w+x];tot++;
      for(let j=0;j<N;j++)for(let i=0;i<N;i++) if(s.idx[(y+j)*s.w+x+i]!==v){bad++;j=N;break;}}
    console.log(f,s.w+'x'+s.h,`block${N}: ${bad}/${tot} impure`);
  }
}
