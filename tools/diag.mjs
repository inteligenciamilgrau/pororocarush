// Diagnostic probe: why is the frame black / what is actually in the scene?
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] || 5179);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });
await page.evaluate(() => window.PR_CAPTURE.seek(8, { cam: 'chase' }));

const out = await page.evaluate(() => {
  const { scene, camera, renderer, state } = window.PR;
  const sample = () => {
    const c = document.getElementById('gl');
    const t = document.createElement('canvas'); t.width = 48; t.height = 27;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0, 48, 27);
    const d = g.getImageData(0, 0, 48, 27).data;
    let s = 0; const u = new Set();
    for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; u.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); }
    return { meanLum: +(s / (48 * 27 * 3)).toFixed(1), colors: u.size, first: [...u].slice(0, 4) };
  };

  const top = [];
  scene.traverse((o) => { if (o.parent === scene) top.push({ name: o.name || o.type, type: o.type, visible: o.visible, children: o.children.length }); });

  let meshes = 0, visibleMeshes = 0;
  scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isInstancedMesh) { meshes++; if (o.visible) visibleMeshes++; } });

  // A: what the game's own render() produces
  window.PR.post?.render?.();
  const viaPost = sample();

  // B: bypass post entirely
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(scene, camera);
  const viaDirect = sample();

  return {
    sceneChildren: scene.children.length,
    topLevel: top,
    meshes, visibleMeshes,
    background: scene.background ? (scene.background.isColor ? '#' + scene.background.getHexString() : scene.background.type) : null,
    fog: scene.fog ? { type: scene.fog.type || 'Fog', color: '#' + scene.fog.color.getHexString(), near: scene.fog.near, far: scene.fog.far, density: scene.fog.density } : null,
    camera: {
      pos: camera.position.toArray().map((v) => +v.toFixed(2)),
      fov: +camera.fov.toFixed(1), near: camera.near, far: camera.far,
      quat: camera.quaternion.toArray().map((v) => +v.toFixed(3)),
    },
    player: { x: +state.player.x.toFixed(2), y: +state.player.y.toFixed(2), z: +state.player.z.toFixed(2), d: +state.player.d.toFixed(2) },
    renderInfo: { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, programs: renderer.info.programs?.length },
    postClass: window.PR.post?.constructor?.name || null,
    postHasComposer: !!(window.PR.post && (window.PR.post.composer || window.PR.post._composer)),
    viaPost, viaDirect,
    toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace,
  };
});

console.log(JSON.stringify({ errors: errs.slice(0, 10), ...out }, null, 2));
await browser.close();
