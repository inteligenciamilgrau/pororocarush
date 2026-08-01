// Mechanics probe. Runs several scripted play profiles through the real simulation
// and reports whether the game actually *plays* — before anyone spends effort on
// making it pretty.
//
//   node tools/playtest.mjs
//   node tools/playtest.mjs --film shots/v1/filmstrip --frames 8 --cam chase
//
// Profiles are input scripts, not cheats: they drive state.input exactly like a
// player would, so the numbers reflect the real physics.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2), n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; }
    }
  }
  return o;
}
const args = parseArgs(process.argv);
const PORT = Number(args.port || 5179);
const DUR = Number(args.t || 45);
const FILM = args.film || null;
const FRAMES = Number(args.frames || 8);
const CAM = args.cam || 'chase';

// Each profile returns the input object for a given sim time.
const PROFILES = {
  parado:      't => ({ steer:0, throttle:0, brake:0, jump:false, crouch:false, grab:false, spin:0 })',
  reto:        't => ({ steer:0, throttle:1, brake:0, jump:false, crouch:false, grab:false, spin:0 })',
  trimando:    't => ({ steer: 0.22*Math.sin(t*0.35), throttle:1, brake:0, jump:false, crouch:false, grab:false, spin:0 })',
  bombeando:   't => ({ steer: 0.75*Math.sin(t*0.9), throttle: (Math.sin(t*0.9+1.1)>0)?1:0, brake:0, jump:false, crouch:false, grab:false, spin:0 })',
  agressivo:   't => ({ steer: 0.95*Math.sin(t*0.62)+0.2*Math.sin(t*2.3), throttle:1, brake:(Math.sin(t*0.5)<-0.85)?1:0, jump:(t%7)>6.85, crouch:Math.sin(t*0.31)>0.5, grab:true, spin:0.9 })',
  tubo:        't => ({ steer: 0.35*Math.sin(t*0.28)-0.12, throttle:1, brake:0, jump:false, crouch:true, grab:false, spin:0 })',
  suicida:     't => ({ steer: (t%4<2)?1:-1, throttle:1, brake:0, jump:(t%3)>2.9, crouch:false, grab:false, spin:1 })',
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const out = { profiles: {}, errors: [] };

async function fresh() {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });
}

try {
  for (const [name, fnSrc] of Object.entries(PROFILES)) {
    await fresh();
    const r = await page.evaluate(async ({ fnSrc, DUR }) => {
      const drive = eval(fnSrc);
      const S = window.PR.state, P = window.PR.ctx;
      const dt = P.config.physics.fixedStep;
      const steps = Math.round(DUR / dt);
      const m = {
        speeds: [], dVals: [], faceT: [], wipeouts: 0, wipeoutReasons: {},
        tubeTime: 0, airTime: 0, tricks: [], nan: 0, offWave: 0, maxCombo: 0,
      };
      P.bus.on('trick:land', (e) => m.tricks.push(e?.name || '?'));
      P.bus.on('tube:exit', (e) => m.tricks.push('tubo:' + (e?.duration || 0).toFixed(1)));
      P.bus.on('player:wipeout', (e) => { m.wipeouts++; const r = e?.reason || '?'; m.wipeoutReasons[r] = (m.wipeoutReasons[r] || 0) + 1; });

      let t = 0;
      const sim = window.__PR_SIM || null;
      for (let i = 0; i < steps; i++) {
        Object.assign(S.input, drive(t));
        S.input.jumpPressed = !!S.input.jump;
        // Drive the same fixed-step path main.js uses.
        S.dt = dt; S.time += dt; S.bore.z += S.bore.speed * dt;
        P.physics.step(dt);
        window.PR.tricks?.step?.(dt);
        window.PR.ctx.scoringRef?.step?.(dt);
        t += dt;
        if (i % 6 === 0) {
          const p = S.player;
          if (!Number.isFinite(p.x) || !Number.isFinite(p.speed) || !Number.isFinite(p.y)) m.nan++;
          m.speeds.push(p.speed); m.dVals.push(p.d); m.faceT.push(p.faceT);
          if (p.inTube) m.tubeTime += dt * 6;
          if (p.airborne) m.airTime += dt * 6;
          if (!p.onWave) m.offWave += dt * 6;
          m.maxCombo = Math.max(m.maxCombo, S.score.combo);
        }
      }
      const stat = (a) => a.length ? {
        min: +Math.min(...a).toFixed(2), max: +Math.max(...a).toFixed(2),
        mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2),
      } : null;
      return {
        speedMs: stat(m.speeds),
        speedKmh: m.speeds.length ? { min: +(Math.min(...m.speeds) * 3.6).toFixed(0), max: +(Math.max(...m.speeds) * 3.6).toFixed(0), mean: +(m.speeds.reduce((x, y) => x + y, 0) / m.speeds.length * 3.6).toFixed(0) } : null,
        d: stat(m.dVals), faceT: stat(m.faceT),
        wipeouts: m.wipeouts, wipeoutReasons: m.wipeoutReasons,
        tubeTimeS: +m.tubeTime.toFixed(1), airTimeS: +m.airTime.toFixed(1),
        offWaveS: +m.offWave.toFixed(1),
        trickCount: m.tricks.length, tricks: m.tricks.slice(0, 25),
        maxCombo: m.maxCombo, points: S.score.points, nanSamples: m.nan,
        finalPhase: S.phase, checkpoint: S.race.checkpoint, distanceM: Math.round(S.race.distance),
      };
    }, { fnSrc, DUR });
    out.profiles[name] = r;
    console.log(`[playtest] ${name.padEnd(11)} vel=${r.speedKmh?.mean}km/h (${r.speedKmh?.min}-${r.speedKmh?.max}) ` +
      `d=${r.d?.mean} quedas=${r.wipeouts} tubo=${r.tubeTimeS}s ar=${r.airTimeS}s manobras=${r.trickCount} ` +
      `combo=${r.maxCombo} pts=${r.points} NaN=${r.nanSamples}`);
  }

  if (FILM) {
    await mkdir(resolve(FILM), { recursive: true });
    for (let i = 0; i < FRAMES; i++) {
      const t = 6 + i * 3.5;
      await fresh();
      await page.evaluate(async ({ t, cam }) => { await window.PR_CAPTURE.seek(t, { cam, hud: true }); }, { t, cam: CAM });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${FILM}/f${String(i).padStart(2, '0')}_t${t.toFixed(1)}.png` });
      console.log(`[playtest] filmstrip frame ${i} @ t=${t.toFixed(1)}s`);
    }
  }
} catch (err) {
  out.errors.push(`HARNESS: ${err.message}`);
  console.error(`[playtest] FAILED: ${err.message}`);
} finally {
  await browser.close();
}

out.errors.push(...errors.slice(0, 20));
await mkdir(resolve('shots'), { recursive: true });
await writeFile(resolve('shots/playtest.json'), JSON.stringify(out, null, 2));
console.log('\n' + JSON.stringify(out, null, 2).slice(0, 6000));
