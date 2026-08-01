// Deterministic capture API for the screenshot harness (tools/shot.mjs).
// Integrator-owned. Subsystem agents must not edit this file.
//
//   window.PR_CAPTURE.seek(12, { cam: 'chase', hud: true })
//
// Fast-forwards the simulation in fixed steps from t=0 to t, then renders. Because
// every system is seeded and dt-driven, the same t always yields the same frame —
// which is what makes v1/v2/v3 comparisons meaningful.

export function installCapture({ ctx, simulate, updateView, render, rig, hud, input, fixedStep }) {
  const { state } = ctx;

  const api = {
    ready: false,
    version: 1,
    state,

    setCam(mode) {
      state.camera.mode = mode;
      rig.setMode(mode);
    },

    setHud(on) {
      const root = document.getElementById('hud-root');
      if (root) root.style.display = on ? '' : 'none';
    },

    // Scripted input so the surfer is actually doing something interesting at
    // the captured instant instead of coasting in a straight line.
    //
    // The steer curve carries a positive bias on purpose: the wave face only
    // fills the left third of frame while the surfer runs the line toward +X
    // (camera rig's note). Riding -X mirrors the whole composition away from
    // `pororoca_rush_capa.png`, which would cost us the blind comparison for a
    // reason that has nothing to do with render quality.
    script(t) {
      const i = state.input;
      i.throttle = 1;
      i.brake = 0;
      i.steer = 0.26 + Math.sin(t * 0.62) * 0.62 + Math.sin(t * 1.9) * 0.14;
      i.crouch = Math.sin(t * 0.31) > 0.62;   // tuck into the barrel periodically
      const jumpWindow = (t % 9.5) > 8.9;
      i.jump = jumpWindow;
      i.jumpPressed = jumpWindow && ((t - fixedStep) % 9.5) <= 8.9;
      i.grab = state.player.airborne && state.player.airTime > 0.25;
      i.spin = state.player.airborne ? 0.9 : 0;
    },

    // Fast-forwards from t=0 in fixed steps. Captures happen deep into a run
    // (t≈140 s puts the HUD at "7 / 12 · 1,2 KM"), so the bulk of the seek runs
    // simulation-only and drives the view systems sparsely; the last few seconds
    // run dense so streaming, particles and camera damping settle honestly.
    async seek(t, opts = {}) {
      const target = Math.max(0, Number(t) || 0);
      if (opts.cam) api.setCam(opts.cam);
      if (opts.hud !== undefined) api.setHud(!!opts.hud);

      if (input && input.setScripted) input.setScripted(true);

      const steps = Math.round(target / fixedStep);
      const denseFrom = Math.max(0, steps - Math.round(4 / fixedStep)); // last 4 s
      const COARSE = 24, FINE = 2;
      let simT = 0;

      for (let n = 0; n < steps; n++) {
        api.script(simT);
        simulate(fixedStep);
        simT += fixedStep;
        const every = n >= denseFrom ? FINE : COARSE;
        if (n % every === 0) updateView(fixedStep * every);
        if (n % 1200 === 1199) await new Promise((r) => setTimeout(r, 0)); // yield
      }
      // Settle the camera and view systems on the final pose.
      for (let n = 0; n < 30; n++) updateView(fixedStep * 2);
      render();
      await new Promise((r) => requestAnimationFrame(r));
      render();
      return {
        t: target,
        points: state.score.points,
        speed: state.player.speed,
        checkpoint: state.race.checkpoint,
        distance: state.race.distance,
        wipeout: state.player.wipeout,
        phase: state.phase,
      };
    },

    snapshot() {
      return JSON.parse(JSON.stringify({
        time: state.time,
        player: state.player,
        score: state.score,
        race: state.race,
      }));
    },
  };

  window.PR_CAPTURE = api;
  api.ready = true;
  return api;
}
