// Headless screenshot harness for Pororoca Rush.
//
//   node tools/shot.mjs --out shots/v1/capa.png --cam chase --t 12 [--w 1672 --h 941]
//
// Drives the game through the deterministic capture API the game exposes on
// `window.PR_CAPTURE` (see src/capture.js). Waits for the game to report ready,
// seeks to a fixed sim time so shots are reproducible, then grabs the canvas.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const OUT = resolve(args.out || 'shots/shot.png');
const PORT = Number(args.port || 5179);
const W = Number(args.w || 1672);
const H = Number(args.h || 941);
const CAM = args.cam || 'chase';
const T = Number(args.t ?? 12);
const HUD = args.hud === 'off' ? false : true;
const TIMEOUT = Number(args.timeout || 120000);
const URL_EXTRA = args.q ? `&${args.q}` : '';

const url = `http://127.0.0.1:${PORT}/index.html?capture=1&cam=${encodeURIComponent(CAM)}&t=${T}&hud=${HUD ? 1 : 0}${URL_EXTRA}`;

const browser = await chromium.launch({
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
    '--force-device-scale-factor=1',
    '--js-flags=--max-old-space-size=4096',
  ],
});

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

let failed = false;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction(() => window.PR_CAPTURE && window.PR_CAPTURE.ready === true, null, {
    timeout: TIMEOUT, polling: 250,
  });
  // Deterministic seek: run the sim in fixed steps up to T seconds, then render.
  await page.evaluate(async ({ t, cam, hud }) => {
    await window.PR_CAPTURE.seek(t, { cam, hud });
  }, { t: T, cam: CAM, hud: HUD });
  await page.waitForTimeout(400);
  await mkdir(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, type: 'png' });
  console.log(`[shot] wrote ${OUT}  (cam=${CAM} t=${T} ${W}x${H})`);
} catch (err) {
  failed = true;
  console.error(`[shot] FAILED: ${err.message}`);
} finally {
  if (logs.length) {
    console.log('--- page console ---');
    console.log(logs.slice(-60).join('\n'));
  }
  await browser.close();
}
process.exit(failed ? 1 : 0);
