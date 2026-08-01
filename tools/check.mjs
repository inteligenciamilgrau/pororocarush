// Boots the game headless and reports console errors, exceptions, missing
// modules and basic sim health. Run this after every change:
//
//   node tools/check.mjs            # boot + 8s of simulated play
//   node tools/check.mjs --t 25     # longer soak
import { chromium } from 'playwright';

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
const T = Number(args.t ?? 8);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [], warns = [], logs = [];
page.on('console', (m) => {
  const t = m.type(), s = m.text();
  if (t === 'error') errors.push(s);
  else if (t === 'warning') warns.push(s);
  else logs.push(s);
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`));
page.on('requestfailed', (r) => errors.push(`REQFAIL: ${r.url()} — ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });

let ok = true, report = {};
try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.PR_CAPTURE?.ready === true || document.getElementById('fatal')?.style.display === 'block',
    null, { timeout: 90000, polling: 200 });

  const fatal = await page.evaluate(() => {
    const el = document.getElementById('fatal');
    return el && el.style.display === 'block' ? el.textContent : null;
  });
  if (fatal) { ok = false; errors.push('FATAL OVERLAY:\n' + fatal.slice(0, 4000)); }

  if (!fatal) {
    const t0 = Date.now();
    await page.evaluate((t) => window.PR_CAPTURE.seek(t, { cam: 'chase' }), T);
    report.seekMs = Date.now() - t0;
    report.sim = await page.evaluate(() => window.PR_CAPTURE.snapshot());
    report.renderInfo = await page.evaluate(() => {
      const r = window.PR?.renderer;
      return r ? { calls: r.info.render.calls, tris: r.info.render.triangles, programs: r.info.programs?.length, textures: r.info.memory.textures, geometries: r.info.memory.geometries } : null;
    });
    // Non-black frame check. The canvas is created without preserveDrawingBuffer,
    // so the backing store is discarded once the frame is composited — sampling it
    // from a separate evaluate() always reads black. Re-render and sample inside
    // the SAME task instead.
    report.pixels = await page.evaluate(() => {
      window.PR?.post?.render?.();
      const c = document.getElementById('gl');
      const t = document.createElement('canvas'); t.width = 64; t.height = 36;
      const g = t.getContext('2d'); g.drawImage(c, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      let sum = 0, uniq = new Set();
      for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; uniq.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`); }
      return { meanLum: Math.round(sum / (64 * 36 * 3)), distinctColors: uniq.size };
    });
    const p = report.sim?.player;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.speed)) { ok = false; errors.push('SIM: player state has NaN/undefined — ' + JSON.stringify(p)); }
    if (report.pixels.meanLum < 4) { ok = false; errors.push(`RENDER: frame is essentially black (meanLum=${report.pixels.meanLum})`); }
    if (report.pixels.distinctColors < 12) { ok = false; errors.push(`RENDER: frame is nearly flat (${report.pixels.distinctColors} distinct colours)`); }
  }
} catch (err) {
  ok = false;
  errors.push(`HARNESS: ${err.message}`);
} finally {
  await browser.close();
}

if (errors.length) ok = false;

console.log(JSON.stringify({ ok, errors: errors.slice(0, 25), warnCount: warns.length, warns: warns.slice(0, 8), report }, null, 2));
process.exit(ok ? 0 : 1);
