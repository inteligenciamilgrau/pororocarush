// Measures blowout in the concept art, to give glare tuning an objective target.
import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p = await b.newPage({viewport:{width:900,height:520}});
await p.goto('http://127.0.0.1:5179/index.html', {waitUntil:'domcontentloaded', timeout:120000});
const files = ['capa','frente','lado','cima'];
for (const f of files) {
  const r = await p.evaluate(async (f) => {
    const img = new Image();
    img.src = '/imagens_conceito/pororoca_rush_' + f + '.png';
    await img.decode();
    const t = document.createElement('canvas'); t.width=209; t.height=118;
    const g = t.getContext('2d'); g.drawImage(img,0,0,t.width,t.height);
    const d = g.getImageData(0,0,t.width,t.height).data;
    let blown=0,washed=0,n=0,sum=0; const lums=[];
    for(let i=0;i<d.length;i+=4){
      const r=d[i],gg=d[i+1],bb=d[i+2];
      const lum=0.2126*r+0.7152*gg+0.0722*bb;
      lums.push(lum); sum+=lum; n++;
      if(lum>244) blown++;
      else if(lum>205 && Math.max(r,gg,bb)-Math.min(r,gg,bb)<26) washed++;
    }
    lums.sort((a,b)=>a-b);
    const pct=q=>Math.round(lums[Math.floor((lums.length-1)*q)]);
    return {mean:Math.round(sum/n), blown:+(100*blown/n).toFixed(1), washed:+(100*washed/n).toFixed(1),
            p05:pct(.05),p50:pct(.5),p95:pct(.95),faixa:pct(.95)-pct(.05)};
  }, f);
  console.log(`[conceito] ${f.padEnd(7)} media=${String(r.mean).padStart(3)} estourado=${String(r.blown).padStart(4)}% lavado=${String(r.washed).padStart(4)}% p05=${r.p05} p50=${r.p50} p95=${r.p95} faixa=${r.faixa}`);
}
await b.close();
