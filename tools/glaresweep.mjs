// Isolates WHAT is blowing out the into-sun view: bloom, fog, exposure or the
// sky itself. One page load, live-tweaks each knob, measures each time.
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] || 5179);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 836, height: 470 } });
await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });
await page.evaluate(() => window.PR_CAPTURE.seek(30, { cam: 'chase', hud: false }));

const res = await page.evaluate(() => {
  const { renderer, scene, post } = window.PR;

  function measure() {
    post?.render?.();
    const c = document.getElementById('gl');
    const t = document.createElement('canvas'); t.width = 209; t.height = 118;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0, t.width, t.height);
    const d = g.getImageData(0, 0, t.width, t.height).data;
    let blown = 0, n = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += lum; n++; if (lum > 244) blown++;
    }
    return { mean: Math.round(sum / n), blown: +(100 * blown / n).toFixed(1) };
  }

  // locate the bloom pass
  const passes = post?.composer?.passes || post?._composer?.passes || [];
  const bloom = passes.find((p) => /bloom/i.test(p.constructor?.name || '') || 'strength' in p);
  const passNames = passes.map((p) => p.constructor?.name || '?');

  const out = { passNames, bloomFound: !!bloom, steps: {} };
  out.steps.baseline = measure();

  // 1. bloom off
  if (bloom) {
    const s = bloom.strength;
    bloom.strength = 0;
    out.steps.semBloom = measure();
    bloom.strength = s;
  }

  // 2. fog off
  const fog = scene.fog;
  scene.fog = null;
  out.steps.semNevoa = measure();
  scene.fog = fog;
  out.fog = fog ? { type: fog.isFogExp2 ? 'FogExp2' : 'Fog', color: '#' + fog.color.getHexString(), density: fog.density, near: fog.near, far: fog.far } : null;

  // 3. exposure down
  const e = renderer.toneMappingExposure;
  renderer.toneMappingExposure = e * 0.7;
  out.steps.exposicao70 = measure();
  renderer.toneMappingExposure = e;

  // 4. sky hidden
  const sky = scene.getObjectByName('sky');
  if (sky) { sky.visible = false; out.steps.semCeu = measure(); sky.visible = true; }

  // 5. everything toned down together
  if (bloom) bloom.strength *= 0.45;
  renderer.toneMappingExposure = e * 0.8;
  if (fog && fog.isFogExp2) fog.density *= 0.55; else if (fog) fog.far *= 1.8;
  out.steps.combinado = measure();

  out.exposureBase = e;
  out.bloom = bloom ? { strength: bloom.strength, radius: bloom.radius, threshold: bloom.threshold } : null;
  return out;
});

console.log(JSON.stringify(res, null, 2));
console.log('\n--- quanto cada fator contribui para o estouro ---');
const b = res.steps.baseline.blown;
for (const [k, v] of Object.entries(res.steps)) {
  if (k === 'baseline') continue;
  console.log(`  ${k.padEnd(12)} estourado ${String(v.blown).padStart(5)}%  (baseline ${b}%)  media ${v.mean}`);
}
await browser.close();
