// Measures how much of the frame the sun blows out, facing straight into it.
// Reports the share of pixels that are effectively unreadable (near-white, or
// so washed out that contrast is gone) so glare tuning is measured, not guessed.
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] || 5179);
const CAMS = (process.argv[3] || 'front,chase').split(',');

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 836, height: 470 } });
await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });

const out = {};
for (const cam of CAMS) {
  out[cam] = await page.evaluate(async (cam) => {
    await window.PR_CAPTURE.seek(30, { cam, hud: false });
    window.PR.post?.render?.();
    const c = document.getElementById('gl');
    const t = document.createElement('canvas'); t.width = 209; t.height = 118;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0, t.width, t.height);
    const d = g.getImageData(0, 0, t.width, t.height).data;

    let blown = 0, washed = 0, n = 0, sum = 0;
    const lums = [];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      lums.push(lum); sum += lum; n++;
      if (lum > 244) blown++;                       // clipped to white
      else if (lum > 205 && Math.max(r, gg, b) - Math.min(r, gg, b) < 26) washed++; // no colour left
    }
    lums.sort((a, b) => a - b);
    const pct = (p) => Math.round(lums[Math.floor//
      ((lums.length - 1) * p)]);
    return {
      meanLum: Math.round(sum / n),
      blownPct: +(100 * blown / n).toFixed(1),
      washedPct: +(100 * washed / n).toFixed(1),
      p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
      // Contrast in the middle band of the frame, where the player looks.
      dynamicRange: pct(0.95) - pct(0.05),
    };
  }, cam);
  console.log(`[glare] ${cam.padEnd(7)} media=${out[cam].meanLum} estourado=${out[cam].blownPct}% ` +
    `lavado=${out[cam].washedPct}% p05=${out[cam].p05} p50=${out[cam].p50} p95=${out[cam].p95} ` +
    `faixa=${out[cam].dynamicRange}`);
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
