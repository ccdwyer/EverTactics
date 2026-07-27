import { loadIndexed } from './png.mjs';
const s = loadIndexed('/Users/chris/Developer/EverTactics/public/assets/sprites/1000_Knight_Male_hd.png');
const cell=(c,r)=>{const o=[];for(let y=0;y<64;y++)for(let x=0;x<64;x++)o.push(s.idx[(r*64+y)*s.w+c*64+x]);return o;};
const mir=a=>{const o=[];for(let y=0;y<64;y++)for(let x=0;x<64;x++)o.push(a[y*64+63-x]);return o;};
const diff=(a,b)=>{let d=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])d++;return d;};
// bbox
const bbox=a=>{let x0=99,y0=99,x1=-1,y1=-1;for(let y=0;y<64;y++)for(let x=0;x<64;x++)if(a[y*64+x]){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}return[x0,y0,x1,y1];};
for(let r=0;r<2;r++)for(let c=0;c<8;c++){const a=cell(c,r);console.log(`r${r}c${c} nonzero=${a.filter(v=>v).length} bbox=${bbox(a)}`);}
console.log('--- mirror tests (row0) ---');
for(let i=0;i<8;i++)for(let j=0;j<8;j++){const d=diff(mir(cell(i,0)),cell(j,0));if(d<600)console.log(`mirror(r0c${i}) ~ r0c${j}: diff=${d}`);}
console.log('--- r0 vs r1 ---');
for(let i=0;i<8;i++){console.log(`r0c${i} vs r1c${i} diff=${diff(cell(i,0),cell(i,1))}`);}
