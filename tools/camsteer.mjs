// A direção move o jogador, mas NÃO a câmera?
// Roda duas corridas com steer oposto e compara o deslocamento câmera-jogador.
// Se o deslocamento for igual nas duas, o teclado não mexe na câmera.
import { chromium } from 'playwright';
const PORT = Number(process.argv[2] || 5179);
const b = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--use-gl=angle']});

async function corrida(steer){
  const ctx = await b.newContext({viewport:{width:700,height:400}});
  await ctx.addInitScript(()=>{ try{localStorage.clear();}catch{} });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`,{waitUntil:'domcontentloaded',timeout:120000});
  await p.waitForFunction(()=>window.PR_CAPTURE?.ready===true,null,{timeout:120000,polling:200});
  const r = await p.evaluate(async (steer)=>{
    const {state:S, ctx:C, rig} = window.PR;
    rig.setMode('chase');
    const dt=C.config.physics.fixedStep;
    for(let i=0;i<Math.round(10/dt);i++){
      Object.assign(S.input,{steer, throttle:1, brake:0, jump:false, jumpPressed:false, crouch:false, grab:false, spin:0});
      S.dt=dt; S.time+=dt; S.bore.z+=S.bore.speed*dt;
      C.physics.step(dt);
      if(i%4===0) rig.step(dt*4);
    }
    const c=window.PR.camera, s=S.player;
    return { steer, headingGraus:+(s.heading*57.3).toFixed(1),
             desloc:[+(c.position.x-s.x).toFixed(2), +(c.position.y-s.y).toFixed(2), +(c.position.z-s.z).toFixed(2)] };
  }, steer);
  await ctx.close();
  return r;
}

const dir = await corrida(1), esq = await corrida(-1);
console.log(JSON.stringify({direita:dir, esquerda:esq},null,1));
const d=Math.hypot(dir.desloc[0]-esq.desloc[0], dir.desloc[2]-esq.desloc[2]);
const giro=Math.abs(dir.headingGraus-esq.headingGraus);
console.log(`\njogador girou ${giro.toFixed(0)} graus entre as duas corridas`);
console.log(`camera deslocou ${d.toFixed(2)} m entre as duas`);
console.log(d < 1.5 ? '>> OK: o teclado move o jogador, nao a camera' : '>> FALHA: o teclado ainda move a camera');
await b.close();
