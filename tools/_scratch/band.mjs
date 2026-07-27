import { loadIndexed } from './png.mjs';
for (const f of ['1000_Knight_Male_hd.png','1016_Black_Mage_Male_hd.png','1008_Monk_Male_hd.png','1068_Chocobo_hd.png']) {
 let s; try{ s=loadIndexed('/Users/chris/Developer/EverTactics/public/assets/sprites/'+f);}catch(e){console.log(f,'skip');continue;}
 console.log('===',f,s.w+'x'+s.h);
 // row-occupancy profile of first 128 rows
 for(let c=0;c<8;c++){
   let y0=999,y1=-1,x0=999,x1=-1;
   for(let y=0;y<100;y++)for(let x=c*64;x<c*64+64;x++){ if(s.idx[y*s.w+x]){ if(y<y0)y0=y; if(y>y1)y1=y; if(x<x0)x0=x; if(x>x1)x1=x;} }
   console.log(` col${c} y:${y0}..${y1} x:${x0-c*64}..${x1-c*64}`);
 }
 // empty-row scan of whole sheet
 const empt=[];for(let y=0;y<s.h;y++){let e=true;for(let x=0;x<s.w;x++)if(s.idx[y*s.w+x]){e=false;break;}if(e)empt.push(y);}
 console.log(' empty rows:', empt.slice(0,60).join(','));
}
