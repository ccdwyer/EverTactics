import { loadIndexed } from './png.mjs';
const s=loadIndexed('/Users/chris/Developer/EverTactics/public/assets/sprites/1000_Knight_Male_hd.png');
const cell=(c,r)=>{const o=[];for(let y=0;y<64;y++)for(let x=0;x<64;x++)o.push(s.idx[(r*64+y)*s.w+c*64+x]);return o;};
// index meaning: 2=white(face highlight?) 8,9,10 grays(cape) 11..15 skin/hair oranges, 3-6 blue/green cloth
for(let r=0;r<2;r++)for(let c=0;c<7;c++){
  const a=cell(c,r);
  let cx0=0,n0=0,cx1=0,n1=0,minx=99,maxx=-1;
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){const v=a[y*64+x];if(!v)continue;if(x<minx)minx=x;if(x>maxx)maxx=x;
    if(v>=8&&v<=10){cx0+=x;n0++;} if(v>=11&&v<=15){cx1+=x;n1++;}}
  const mid=(minx+maxx)/2;
  console.log(`r${r}c${c} cape@${(cx0/n0-mid).toFixed(1)} skin@${(cx1/n1-mid).toFixed(1)} capeN=${n0} skinN=${n1}`);
}
