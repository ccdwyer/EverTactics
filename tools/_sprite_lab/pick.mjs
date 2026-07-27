import { readFileSync } from 'node:fs';
const PD='/Users/chris/Developer/EverTactics/public/assets/palettes/';
const HUE={player:225,enemy:10,ally:110,neutral:50};
function empty(p){for(let i=3;i<48;i++)if(p[i])return false;return true;}
function score(pal,targetDeg,base){
  const t=targetDeg*Math.PI/180; let s=0,w=0;
  for(let i=1;i<16;i++){
    const r=pal[i*3]/255,g=pal[i*3+1]/255,b=pal[i*3+2]/255;
    if(r+g+b===0)continue;
    if(base){const dr=r-base[i*3]/255,dg=g-base[i*3+1]/255,db=b-base[i*3+2]/255;
      if(dr*dr+dg*dg+db*db<0.0016)continue;}
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b),c=mx-mn;
    if(c<0.06)continue;
    let h; if(mx===r)h=((g-b)/c)%6; else if(mx===g)h=(b-r)/c+2; else h=(r-g)/c+4;
    h=h*Math.PI/3; s+=Math.cos(h-t)*c; w+=c;
  }
  return w>1e-4?s/w:-Infinity;
}
for(const fam of ['knight_m','kuro_m','monk_m','siro_m','yumi_w','thief_m']){
  const pals=[];
  for(let i=1;i<=8;i++){try{pals.push(readFileSync(`${PD}battle_${fam}_battle_pal${i}.act`).slice(0,48));}catch{}}
  const out=[];
  for(const [team,hue] of Object.entries(HUE)){
    if(team==='player'){out.push(`${team}=0`);continue;}
    const alt=pals.slice(1); let best=0,bs=-Infinity;
    alt.forEach((p,i)=>{ if(empty(p))return; const sc=score(p,hue,pals[0]); if(sc>bs){bs=sc;best=i;} });
    out.push(`${team}=${1+best}(${bs.toFixed(2)})`);
  }
  // describe each slot
  const desc=pals.map((p,i)=>{ if(empty(p))return `${i}:empty`;
    let r=0,g=0,b=0,n=0; for(let k=1;k<16;k++){const R=p[k*3],G=p[k*3+1],B=p[k*3+2];
      if(Math.abs(R-pals[0][k*3])+Math.abs(G-pals[0][k*3+1])+Math.abs(B-pals[0][k*3+2])<12 && i>0)continue;
      r+=R;g+=G;b+=B;n++;}
    return n? `${i}:rgb(${(r/n)|0},${(g/n)|0},${(b/n)|0})`:`${i}:same`;});
  console.log(fam.padEnd(9), out.join(' '), '|', desc.join(' '));
}
