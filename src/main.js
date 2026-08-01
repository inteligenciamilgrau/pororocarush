// POROROCA RUSH — bootstrap and game loop.
// Integrator-owned. Subsystem agents must not edit this file.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createState } from './core/state.js';
import { Bus } from './core/bus.js';
import { Input } from './core/input.js';

import { BoreWave } from './wave/bore.js';
import { WaveMesh } from './wave/waveMesh.js';
import { Foam } from './wave/foam.js';

import { River } from './world/river.js';
import { Scenery } from './world/scenery.js';
import { Obstacles } from './world/obstacles.js';
import { Gates } from './world/gates.js';

import { SurfPhysics } from './player/physics.js';
import { TrickSystem } from './player/tricks.js';
import { Surfer } from './player/surfer.js';

import { CameraRig } from './game/camera.js';
import { Scoring } from './game/scoring.js';
import { Race } from './game/race.js';

import { Sky } from './gfx/sky.js';
import { Lighting } from './gfx/lighting.js';
import { Post } from './gfx/post.js';

import { HUD } from './hud/hud.js';
import { Menu } from './hud/menu.js';
import { TitleScreen } from './hud/title.js';
import { StoryScreen } from './hud/story.js';
import { installCapture } from './capture.js';

const boot = document.getElementById('boot');
const bootBar = document.querySelector('#bar i');
const bootMsg = document.getElementById('boot-msg');
const progress = (p, msg) => {
  if (bootBar) bootBar.style.width = `${Math.round(p * 100)}%`;
  if (msg && bootMsg) bootMsg.textContent = msg;
};

export async function boot_() {
  const params = new URLSearchParams(location.search);
  const captureMode = params.get('capture') === '1';

  // ---------------------------------------------------------------- renderer
  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.render.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CONFIG.render.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.render.near,
    CONFIG.render.far,
  );
  scene.add(camera);

  const state = createState();
  const bus = new Bus();
  const bore = new BoreWave(CONFIG.wave);

  const ctx = { THREE, scene, renderer, camera, state, bus, bore, config: CONFIG };

  // ------------------------------------------------------------- subsystems
  progress(0.08, 'céu e luz…');
  const sky = new Sky(ctx);
  const lighting = new Lighting(ctx);

  progress(0.24, 'esculpindo a pororoca…');
  const waveMesh = new WaveMesh(ctx);
  const river = new River(ctx);

  progress(0.44, 'povoando as margens…');
  const scenery = new Scenery(ctx);
  const obstacles = new Obstacles(ctx);
  const gates = new Gates(ctx);

  progress(0.62, 'encerando a prancha…');
  const surfer = new Surfer(ctx);
  const physics = new SurfPhysics(ctx);
  ctx.physics = physics;
  ctx.obstacles = obstacles;
  const tricks = new TrickSystem(ctx);

  progress(0.76, 'espuma e respingos…');
  const foam = new Foam(ctx);

  progress(0.86, 'câmeras…');
  const rig = new CameraRig(ctx);
  const scoring = new Scoring(ctx);
  const race = new Race(ctx);

  progress(0.94, 'pós-processamento…');
  const post = new Post(ctx);

  const input = new Input(state, { capture: captureMode });
  ctx.input = input;   // hud/menu.js needs it to arbitrate ESC vs pointer lock
  const hud = new HUD(document.getElementById('hud-root'), state, bus, CONFIG);

  // Options menu. Skipped entirely under capture so screenshots are never
  // paused behind an overlay.
  let menu = null;
  if (!captureMode) {
    menu = new Menu(ctx, {
      onOptsChange: (o) => {
        input.opts = o;
        rig.setMode(o.camera);
        state.camera.mode = o.camera;
        state.camera.flip180 = !!o.flip180;
        camera.fov = o.fov;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(
          Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio) * o.renderScale,
        );
        onResize();   // pixel ratio only takes effect on the next setSize
        const hudRoot = document.getElementById('hud-root');
        if (hudRoot) hudRoot.style.display = o.showHud ? '' : 'none';
      },
    });
  }

  // Order matters: input → physics → tricks → scoring/race → world → visuals.
  const simSystems = [physics, tricks, gates, scoring, race, obstacles];
  const viewSystems = [waveMesh, river, scenery, surfer, foam, sky, lighting, rig, post, hud];

  // ------------------------------------------------------------- simulation
  const FIXED = CONFIG.physics.fixedStep;
  let acc = 0;

  function simulate(dt) {
    state.dt = dt;
    state.time += dt;
    state.bore.z += state.bore.speed * dt;
    input.step(dt);
    for (const s of simSystems) s.step(dt);
    state.frame++;
  }

  function stepFixed(dtReal) {
    const scaled = dtReal * state.slowmo;
    acc += Math.min(scaled, 0.25);
    let guard = 0;
    while (acc >= FIXED && guard++ < 240) { simulate(FIXED); acc -= FIXED; }
  }

  function updateView(dt) {
    for (const s of viewSystems) s.step(dt);
  }

  function render() {
    post.render();
  }

  // ------------------------------------------------------------------ loop
  let last = performance.now();
  let rafId = 0;
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dtReal = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (state.paused) return;
    stepFixed(dtReal);
    updateView(dtReal);
    render();
  }

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    post.setSize(w, h);
  }
  window.addEventListener('resize', onResize);
  onResize();

  // Warm the pipeline so the first visible frame is not a compile hitch.
  progress(0.99, 'compilando shaders…');
  simulate(FIXED);
  updateView(FIXED);
  renderer.compile(scene, camera);
  render();

  installCapture({
    ctx, simulate, updateView, render, rig, hud, input,
    fixedStep: FIXED,
    onResize,
  });

  progress(1, 'pronto');
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 900);

  if (!captureMode) { last = performance.now(); rafId = requestAnimationFrame(frame); }

  // Opening screen. Holds the sim paused behind it so the first thing the player
  // sees is the title over a live scene, not a surfer already halfway down the run.
  if (!captureMode) {
    const story = new StoryScreen({ onClose: () => title.show() });
    const title = new TitleScreen({
      onStart: () => {
        state.paused = false;
        // Controls are a lot to remember, and a surf game is unplayable if you
        // never learn to pump and tuck — so show them once, on the first run only.
        if (menu && !localStorage.getItem('pororoca.seen')) {
          try { localStorage.setItem('pororoca.seen', '1'); } catch { /* private mode */ }
          menu.show();
        }
      },
      onStory: () => { title.hide(); story.show(); },
    });
    state.paused = true;
    title.show();
    window.PR_UI = { title, story, menu };
  }

  window.PR = { ctx, state, bore, physics, tricks, gates, rig, hud, post, renderer, scene, camera,
                pause: () => { state.paused = true; }, resume: () => { state.paused = false; },
                stop: () => cancelAnimationFrame(rafId) };
  return window.PR;
}

boot_().catch((err) => {
  const el = document.getElementById('fatal');
  el.style.display = 'block';
  el.textContent += `\n[boot] ${err && (err.stack || err.message || err)}\n`;
  console.error(err);
});
