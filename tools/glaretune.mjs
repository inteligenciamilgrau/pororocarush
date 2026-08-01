// Coordinate-descent search for glare settings that make the into-sun view
// readable without losing the golden-hour look. Everything is tweaked live in one
// page load, so hundreds of measurements cost one boot instead of one each.
//
//   node tools/glaretune.mjs
//
// Prints the winning CONFIG.look values to paste into src/config.js.
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] || 5179);

// Target band, measured from the concept art with tools/refglare.mjs. The art
// itself sits at mean 58-82, blown 0.2-0.5%, p05 6-9, p50 47-69, p95 153-188.
// p95 is the one that decides whether the sun "glows" or "blinds", so it carries
// the heaviest weight here.
const TARGET = {
  blownMax: 0.5, meanLo: 62, meanHi: 92, p05Max: 14,
  p50Lo: 46, p50Hi: 84, p95Lo: 150, p95Hi: 192, rangeMin: 138,
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 836, height: 470 } });
await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });

const result = await page.evaluate(async ({ TARGET }) => {
  const { post, scene } = window.PR;

  // Find the sky dome's shader uniforms.
  let skyU = null;
  scene.traverse((o) => {
    const m = o.material;
    if (m && m.uniforms && ('uGlare' in m.uniforms || 'uSkyGain' in m.uniforms)) skyU = m.uniforms;
  });

  function apply(k) {
    if (post.bloom) {
      post.bloom.strength = k.bloomStrength;
      post.bloom.radius = k.bloomRadius;
      // UnrealBloomPass caches the threshold in a uniform at construction; the
      // plain property is not read again, so set the uniform directly.
      post.bloom.threshold = k.bloomThreshold;
      const hp = post.bloom.highPassUniforms;
      if (hp && hp.luminosityThreshold) hp.luminosityThreshold.value = k.bloomThreshold;
    }
    if (skyU) {
      if (skyU.uGlare) skyU.uGlare.value = k.sunGlare;
      if (skyU.uHalo) skyU.uHalo.value = k.sunHalo;
      if (skyU.uSkyGain) skyU.uSkyGain.value = k.skyGain;
    }
    post.set?.({ blackPoint: k.blackPoint, exposure: k.exposure });
    // post.set may not cover these; poke the grade uniforms too.
    const g = post._grade?.uniforms || post.grade?.uniforms;
    if (g) {
      if (g.uBlack) g.uBlack.value = k.blackPoint;
      if (g.uExposure) g.uExposure.value = k.exposure;
    }
  }

  function measure() {
    post.render();
    const c = document.getElementById('gl');
    const t = document.createElement('canvas'); t.width = 209; t.height = 118;
    const g2 = t.getContext('2d'); g2.drawImage(c, 0, 0, t.width, t.height);
    const d = g2.getImageData(0, 0, t.width, t.height).data;
    let blown = 0, n = 0, sum = 0; const lums = [];
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lums.push(lum); sum += lum; n++; if (lum > 244) blown++;
    }
    lums.sort((a, b) => a - b);
    const q = (p) => lums[Math.floor((lums.length - 1) * p)];
    return {
      mean: sum / n, blown: 100 * blown / n,
      p05: q(0.05), p50: q(0.5), p95: q(0.95), range: q(0.95) - q(0.05),
    };
  }

  // Distance from the target band — zero means fully inside it.
  function cost(m) {
    let c = 0;
    c += Math.max(0, m.blown - TARGET.blownMax) * 14;
    c += Math.max(0, TARGET.meanLo - m.mean) * 1.1 + Math.max(0, m.mean - TARGET.meanHi) * 1.1;
    c += Math.max(0, m.p05 - TARGET.p05Max) * 2.4;
    c += Math.max(0, TARGET.p50Lo - m.p50) * 0.9 + Math.max(0, m.p50 - TARGET.p50Hi) * 0.9;
    // The highlight shoulder: this is what the player experiences as glare.
    c += Math.max(0, m.p95 - TARGET.p95Hi) * 2.8 + Math.max(0, TARGET.p95Lo - m.p95) * 1.4;
    c += Math.max(0, TARGET.rangeMin - m.range) * 0.8;
    return c;
  }

  const AXES = {
    bloomThreshold: [2.4, 3.0, 3.8, 4.6, 5.6, 7.0],
    bloomStrength: [0.62, 0.5, 0.38, 0.28, 0.2, 0.14],
    sunHalo: [0.42, 0.34, 0.26, 0.19, 0.13, 0.08],
    skyGain: [0.62, 0.54, 0.46, 0.38, 0.31, 0.25],
    sunGlare: [1.0, 0.85, 0.7, 0.55, 0.42, 0.3],
    blackPoint: [0.0, 0.006, 0.014, 0.024, 0.036],
    exposure: [0.94, 0.88, 0.82, 0.76, 0.7],
    bloomRadius: [0.72, 0.6, 0.48, 0.36],
  };

  let best = { bloomThreshold: 2.4, bloomStrength: 0.42, bloomRadius: 0.18,
               sunHalo: 0.42, skyGain: 0.62, sunGlare: 1.0, blackPoint: 0.005, exposure: 0.94 };
  apply(best);
  let bestM = measure(), bestC = cost(bestM);
  const trail = [{ stage: 'baseline', ...roundM(bestM), cost: +bestC.toFixed(1) }];

  function roundM(m) {
    return { mean: Math.round(m.mean), blown: +m.blown.toFixed(1), p05: Math.round(m.p05),
             p50: Math.round(m.p50), p95: Math.round(m.p95), range: Math.round(m.range) };
  }

  // Two passes of coordinate descent — enough for a smooth, mostly monotonic space.
  for (let pass = 0; pass < 2; pass++) {
    for (const [axis, values] of Object.entries(AXES)) {
      let localBest = best[axis], localC = bestC, localM = bestM;
      for (const v of values) {
        const cand = { ...best, [axis]: v };
        apply(cand);
        const m = measure(), c = cost(m);
        if (c < localC - 1e-6) { localC = c; localBest = v; localM = m; }
      }
      best = { ...best, [axis]: localBest };
      bestC = localC; bestM = localM;
      apply(best);
      if (pass === 1) trail.push({ stage: axis, value: localBest, ...roundM(bestM), cost: +bestC.toFixed(1) });
    }
    if (bestC === 0) break;
  }

  apply(best);
  const chase = roundM(measure());

  // Make sure the away-from-sun view did not regress.
  await window.PR_CAPTURE.seek(30, { cam: 'front', hud: false });
  apply(best);
  const front = roundM(measure());

  return { best, chase, front, cost: +bestC.toFixed(2), trail, skyUniformsFound: !!skyU };
}, { TARGET });

console.log(JSON.stringify(result, null, 2));
console.log('\n=== descida coordenada (passo final) ===');
for (const t of result.trail) {
  console.log(`  ${String(t.stage).padEnd(15)} ${t.value !== undefined ? String(t.value).padStart(5) : '     '}  ` +
    `media=${String(t.mean).padStart(3)} estourado=${String(t.blown).padStart(5)}% p05=${String(t.p05).padStart(3)} ` +
    `p50=${String(t.p50).padStart(3)} faixa=${String(t.range).padStart(3)}  custo=${t.cost}`);
}
console.log('\n=== valores vencedores para CONFIG.look ===');
for (const [k, v] of Object.entries(result.best)) console.log(`    ${k}: ${v},`);
console.log(`\nchase: ${JSON.stringify(result.chase)}`);
console.log(`front: ${JSON.stringify(result.front)}`);
await browser.close();
