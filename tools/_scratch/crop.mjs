import { loadIndexed, writeRGBA } from './png.mjs';
const [,,file,sx,sy,sw,sh,scale,out] = process.argv;
const s = loadIndexed(file);
const S=Number(scale), X=Number(sx),Y=Number(sy),W=Number(sw),H=Number(sh);
const rgba=Buffer.alloc(W*S*H*S*4);
for(let y=0;y<H*S;y++)for(let x=0;x<W*S;x++){
  const px=X+Math.floor(x/S), py=Y+Math.floor(y/S);
  const i=s.idx[py*s.w+px]||0;
  const o=(y*W*S+x)*4;
  if(i===0){ // checkerboard
    const c=((Math.floor(x/8)+Math.floor(y/8))%2)?60:40;
    rgba[o]=c;rgba[o+1]=c;rgba[o+2]=c;rgba[o+3]=255;
  } else {rgba[o]=s.plte[i*3];rgba[o+1]=s.plte[i*3+1];rgba[o+2]=s.plte[i*3+2];rgba[o+3]=255;}
}
writeRGBA(out,W*S,H*S,rgba);
