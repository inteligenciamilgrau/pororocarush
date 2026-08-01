// Verifies the game boots the way GitHub Pages serves it: under /<repo>/ instead
// of the domain root, with no dev server rewriting anything. Catches absolute
// paths that work locally and 404 in production.
//
//   node tools/serve.mjs 5191 --root ..
//   node tools/pagescheck.mjs --url http://127.0.0.1:5191/<repo>/index.html
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const URL_ = get('url', 'http://127.0.0.1:5191/jogo_pororoca_rush_opus_5/index.html');
const OFFLINE = argv.includes('--offline');

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });

const failures = [], errors = [];
page.on('requestfailed', (r) => failures.push(`${r.failure()?.errorText} ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// Simulates a visitor with no access to Google Fonts (corporate proxy, offline).
if (OFFLINE) {
  await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
}

let ok = true, info = {};
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });
  info = await page.evaluate(() => {
    window.PR?.post?.render?.();
    const c = document.getElementById('gl');
    const t = document.createElement('canvas'); t.width = 48; t.height = 27;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0, 48, 27);
    const d = g.getImageData(0, 0, 48, 27).data;
    let sum = 0; const u = new Set();
    for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; u.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); }
    return {
      meanLum: Math.round(sum / (48 * 27 * 3)),
      colors: u.size,
      fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
      hudNodes: document.getElementById('hud-root')?.childElementCount ?? 0,
    };
  });
  // Ignore font CDN failures when we deliberately blocked them.
  const real = failures.filter((f) => !(OFFLINE && /fonts\.(googleapis|gstatic)\.com/.test(f)));
  if (real.length) ok = false;
  if (errors.length) ok = false;
  if (info.meanLum < 4 || info.colors < 12) ok = false;
} catch (e) {
  ok = false; errors.push('HARNESS: ' + e.message);
} finally {
  await browser.close();
}

console.log(JSON.stringify({
  ok, url: URL_, offline: OFFLINE, info,
  requestFailures: failures.slice(0, 12), errors: errors.slice(0, 12),
}, null, 2));
process.exit(ok ? 0 : 1);
