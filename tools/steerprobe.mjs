// Which way does the board go on screen when the player steers right?
// Projects the surfer into normalised device coords and reports the drift.
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] || 5179);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(`http://127.0.0.1:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.PR_CAPTURE?.ready === true, null, { timeout: 120000, polling: 200 });

const r = await page.evaluate(async () => {
  const { state, ctx, rig } = window.PR;
  const THREE = ctx.THREE;
  const dt = ctx.config.physics.fixedStep;

  async function run(steer) {
    // fresh-ish start
    await window.PR_CAPTURE.seek(6, { cam: 'chase' });
    const startHeading = state.player.heading;
    const startX = state.player.x;
    for (let i = 0; i < 240; i++) {          // 2 s of held steer
      Object.assign(state.input, { steer, throttle: 1, brake: 0, jump: false, jumpPressed: false, crouch: false, grab: false, spin: 0 });
      state.dt = dt; state.time += dt; state.bore.z += state.bore.speed * dt;
      ctx.physics.step(dt);
      if (i % 4 === 0) { rig.step(dt * 4); }
    }
    const p = new THREE.Vector3(state.player.x, state.player.y + 1, state.player.z);
    p.project(ctx.camera);
    return {
      steer,
      ndcX: +p.x.toFixed(3),
      worldDX: +(state.player.x - startX).toFixed(2),
      headingDelta: +(state.player.heading - startHeading).toFixed(3),
      lean: +state.player.lean.toFixed(2),
    };
  }

  const right = await run(+1);
  const left = await run(-1);

  // Where is world +X on screen, independent of the player?
  const camDir = new THREE.Vector3(); ctx.camera.getWorldDirection(camDir);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
  return {
    steerRight: right, steerLeft: left,
    cameraForward: camDir.toArray().map((v) => +v.toFixed(2)),
    cameraRightVector: camRight.toArray().map((v) => +v.toFixed(2)),
    worldPlusXIsOnScreen: camRight.x > 0 ? 'RIGHT' : 'LEFT',
  };
});

console.log(JSON.stringify(r, null, 2));
console.log('\n--- leitura ---');
console.log(`steer=+1 (tecla D) -> ndcX ${r.steerRight.ndcX}  (negativo = anda para a ESQUERDA da tela)`);
console.log(`steer=-1 (tecla A) -> ndcX ${r.steerLeft.ndcX}`);
console.log(`mundo +X aparece na ${r.worldPlusXIsOnScreen} da tela`);
console.log(r.steerRight.ndcX < r.steerLeft.ndcX ? '>> INVERTIDO' : '>> correto');
await browser.close();
