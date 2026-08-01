// Captures the full four-angle shot set for a version, in one browser session.
//
//   node tools/shots.mjs --v v1
//   node tools/shots.mjs --v v3 --only chase
//
// Angles and sim times are fixed so vN/chase.png is always the same moment of the
// same run — that is what makes the version-over-version comparison honest.
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
const V = args.v || 'v1';
const PORT = Number(args.port || 5179);
const W = Number(args.w || 1672);
const H = Number(args.h || 941);
const OUTDIR = resolve(`shots/${V}`);

// Sim time per angle. Chosen deep into the run so the HUD reads like the concept
// art (checkpoint 7-9 of 12, 1,2-1,8 KM) rather than 0/12 at 100 m — at boreSpeed
// 8.6 m/s over a 2000 m course, t=140 s ≈ 1,2 KM ≈ checkpoint 7.
// Re-measure with tools/playtest.mjs if courseLength or boreSpeed change.
const ANGLES = [
  { name: 'chase',  cam: 'chase',  t: 140, ref: 'pororoca_rush_capa.png' },
  { name: 'frente', cam: 'front',  t: 186, ref: 'pororoca_rush_frente.png' },
  { name: 'lado',   cam: 'side',   t: 168, ref: 'pororoca_rush_lado.png' },
  { name: 'cima',   cam: 'aerial', t: 205, ref: 'pororoca_rush_cima.png' },
];
const wanted = args.only ? ANGLES.filter((a) => a.name === args.only || a.cam === args.only) : ANGLES;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
         '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=4096'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await mkdir(OUTDIR, { recursive: true });
const results = [];
let hardFail = null;

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });

  for (const a of wanted) {
    // Reload between angles so each seek starts from a clean t=0 state.
    if (results.length) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });
    }
    const info = await page.evaluate(async ({ t, cam }) => {
      const r = await window.PR_CAPTURE.seek(t, { cam, hud: true });
      const snap = window.PR_CAPTURE.snapshot();
      const ren = window.PR?.renderer;
      return { ...r, snap, render: ren ? { calls: ren.info.render.calls, tris: ren.info.render.triangles } : null };
    }, { t: a.t, cam: a.cam });
    await page.waitForTimeout(300);
    const out = `${OUTDIR}/${a.name}.png`;
    await page.screenshot({ path: out, type: 'png' });
    results.push({ ...a, out, info });
    console.log(`[shots] ${a.name.padEnd(7)} t=${String(a.t).padEnd(5)} -> ${out}  ` +
      `speed=${(info.snap.player.speed * 3.6).toFixed(0)}km/h pts=${info.snap.score.points} ` +
      `calls=${info.render?.calls} tris=${info.render?.tris}`);
  }
} catch (err) {
  hardFail = err.message;
  console.error(`[shots] FAILED: ${err.message}`);
} finally {
  await browser.close();
}

await writeFile(`${OUTDIR}/manifest.json`, JSON.stringify({
  version: V, width: W, height: H, angles: results, errors: errors.slice(0, 30), hardFail,
}, null, 2));

if (errors.length) {
  console.log(`[shots] ${errors.length} console/page errors — first few:`);
  console.log(errors.slice(0, 6).map((e) => '  ' + e.slice(0, 200)).join('\n'));
}
process.exit(hardFail || results.length !== wanted.length ? 1 : 0);
