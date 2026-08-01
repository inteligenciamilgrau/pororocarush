// POROROCA RUSH — camera rig.
//
// Five modes, four of which are the four concept frames:
//   chase  — over the shoulder, board in the lower frame, wave face filling one third.
//   front  — reverse angle out on the flat water, whole bore front breaking behind.
//   side   — profile, pulled laterally, both banks and logs in the foreground.
//   aerial — high drone, the bore crossing the whole channel, surfer small on the face.
//   free   — slow cinematic orbit.
//
// Everything is critically damped (spring-damper, no overshoot, no drag), integrated
// by dt, and driven by deterministic noise. Hard rule enforced at the end of every
// step: the camera never sinks into the water and never lets the wave block the
// line of sight to the surfer.

import { valueNoise2 } from '../core/rng.js';

// Cycle order runs the rear family from tightest to widest first — that is where
// the game is actually played — then the display angles.
export const CAMERA_MODES = [
  'chase', 'chaseLow', 'tail', 'pov', 'chaseFar',
  'front', 'side', 'aerial', 'free',
];

// Portuguese labels for the options menu and the on-screen mode flash.
export const CAMERA_LABELS = {
  chase: 'Perseguição',
  chaseLow: 'Perseguição baixa',
  tail: 'Rabeta',
  pov: 'Primeira pessoa',
  chaseFar: 'Perseguição aberta',
  front: 'De frente',
  side: 'De lado',
  aerial: 'Aérea',
  free: 'Livre',
};

// ---------------------------------------------------------------- fallbacks ---
// Used only if a neighbour handed us an incomplete ctx — the game must still boot.
const DEFAULT_CAMERA = {
  pov: { dist: 0.15, height: 1.58, lookAhead: 15.0, side: 0.0, pitch: 0.01 },
  tail: { dist: 3.1, height: 0.72, lookAhead: 12.0, side: 0.0, pitch: 0.03 },
  chaseLow: { dist: 4.7, height: 1.35, lookAhead: 10.5, side: 0.45, pitch: -0.02 },
  chaseFar: { dist: 13.5, height: 5.4, lookAhead: 7.0, side: 2.4, pitch: -0.15 },
  chase: { dist: 6.4, height: 2.35, lookAhead: 9.0, side: 0.9, pitch: -0.06 },
  front: { dist: 9.5, height: 2.05, lookAhead: -6.0, side: 0.0, pitch: -0.02 },
  side: { dist: 17.0, height: 4.2, lookAhead: 4.0, side: 15.0, pitch: -0.10 },
  aerial: { dist: 42.0, height: 68.0, lookAhead: 40.0, side: 0.0, pitch: -0.78 },
  smooth: 6.5, shakeSpeed: 0.35, shakeImpact: 1.6, tubeTighten: 0.55,
};

// Framing policy per mode. These are composition decisions, not tunables:
//   rig     — how the standoff is built ('follow' | 'boom' | 'orbit')
//   smooth  — multiplier on CONFIG.camera.smooth (drones are heavy, chase is snappy)
//   aim     — how much snappier the aim is than the boom (kills subject drift)
//   shake   — how much of the shake budget this framing gets
//   fovGain — how much of CONFIG.render.fovSpeedGain this framing breathes with
const SHAPE = {
  // Rear family — closer and lower means faster and rougher, so those framings
  // get more shake, more FOV breathing and snappier damping.
  pov: { rig: 'follow', smooth: 0.55, aim: 1.00, shake: 1.55, fovGain: 1.35, roll: 1.30 },
  tail: { rig: 'follow', smooth: 0.72, aim: 0.95, shake: 1.35, fovGain: 1.20, roll: 1.15 },
  chaseLow: { rig: 'follow', smooth: 0.88, aim: 0.90, shake: 1.15, fovGain: 1.10, roll: 1.05 },
  chase: { rig: 'follow', smooth: 1.00, aim: 0.85, shake: 1.00, fovGain: 1.00, roll: 1.00 },
  chaseFar: { rig: 'follow', smooth: 1.55, aim: 0.62, shake: 0.62, fovGain: 0.70, roll: 0.55 },
  front: { rig: 'follow', smooth: 1.20, aim: 0.80, shake: 0.72, fovGain: 0.72, roll: 0.45 },
  side: { rig: 'follow', smooth: 1.45, aim: 0.55, shake: 0.50, fovGain: 0.48, roll: 0.30 },
  aerial: { rig: 'boom', smooth: 2.60, aim: 0.25, shake: 0.14, fovGain: 0.20, roll: 0.12 },
  free: { rig: 'orbit', smooth: 1.70, aim: 0.13, shake: 0.34, fovGain: 0.50, roll: 0.25 },
};

// Composition constants (metres / radians). Deliberately local: they describe the
// *framing*, not the ride, so they do not belong in CONFIG.
const FRAME = {
  aimLift: 1.05,        // aim at chest height, never at the board
  airAnchor: 0.62,      // how much of an air the rig follows vertically
  downLineBlend: 0.42,  // stabilise the ride axis toward the down-the-line axis
  turnLead: 1.85,       // metres of aim lead per rad/s of turn
  speedLead: 0.10,      // metres of aim lead per m/s
  waveBias: 3.6,        // push the aim to the flat-water side → wave fills a third
  pocketLead: 5.5,      // extra aim lead when a barrel is pitching down the line
  faceFloor: 1.4,       // keep the rig this far ahead of the lip (d >= this)
  clearMargin: 1.20,    // metres of water clearance under the camera
  clearMarginTube: 0.28,
  clearMarginAerial: 4.0,
  maxLift: 16.0,        // never let a bad height() query fling the rig into orbit
  minSubject: 1.75,     // never end up inside the surfer's head
  shakePos: 0.17,       // metres of positional shake at shake = 1
  shakeRot: 0.0135,     // radians of rotational shake at shake = 1
};

// ------------------------------------------------------------------- helpers ---
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const wrapPi = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

// Scratch record handed to bore.tubePocket() so _tubeRoof() allocates nothing.
const TUBE_OUT = { inner: 0, outer: 0, roof: 0, strength: 0, amp: 0 };

// Critically damped scalar follower (Unity-style SmoothDamp): reaches the target
// fast, never overshoots, never lags behind a moving target the way lerp does.
class Damp {
  constructor(v = 0) { this.v = v; this.vel = 0; }
  set(v) { this.v = v; this.vel = 0; return v; }
  step(target, smoothTime, dt) {
    const st = smoothTime > 1e-4 ? smoothTime : 1e-4;
    const omega = 2 / st;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.v - target;
    const temp = (this.vel + omega * change) * dt;
    let out = target + (change + temp) * exp;
    const nvel = (this.vel - omega * temp) * exp;
    if ((target - this.v > 0) === (out > target)) { out = target; this.vel = (out - target) / dt; }
    else this.vel = nvel;
    this.v = Number.isFinite(out) ? out : target;
    if (!Number.isFinite(this.vel)) this.vel = 0;
    return this.v;
  }
}

class Damp3 {
  constructor() { this.x = new Damp(); this.y = new Damp(); this.z = new Damp(); }
  set(x, y, z) { this.x.set(x); this.y.set(y); this.z.set(z); }
  step(tx, ty, tz, st, dt) { this.x.step(tx, st, dt); this.y.step(ty, st, dt); this.z.step(tz, st, dt); }
}

// Deterministic two-octave shake noise. Never Math.random().
function shakeNoise(t, row, seed) {
  const a = valueNoise2(t * 8.7, row * 13.1 + 0.5, seed) * 2 - 1;
  const b = valueNoise2(t * 19.9, row * 13.1 + 57.5, seed + 977) * 2 - 1;
  return a * 0.62 + b * 0.38;
}

// ================================================================= CameraRig ===
export class CameraRig {
  // Accepts the ctx object main.js builds, and (defensively) the older positional
  // form documented in ARCHITECTURE §3.6: new CameraRig(camera, state, bore, config).
  constructor(ctx, ...rest) {
    let c = ctx;
    if (c && (c.isCamera || c.isPerspectiveCamera)) {
      c = { camera: ctx, state: rest[0], bore: rest[1], config: rest[2] };
    }
    c = c || {};

    this.ctx = c;
    this.camera = c.camera || null;
    this.state = c.state || null;
    this.bore = c.bore || null;
    this.bus = c.bus || null;

    const cfg = c.config || {};
    this.cfg = Object.assign({}, DEFAULT_CAMERA, cfg.camera || {});
    for (const k of ['chase', 'front', 'side', 'aerial']) {
      this.cfg[k] = Object.assign({}, DEFAULT_CAMERA[k], (cfg.camera && cfg.camera[k]) || {});
    }
    this.rcfg = Object.assign({ fov: 58, fovSpeedGain: 14 }, cfg.render || {});
    this.pcfg = Object.assign({ maxSpeed: 24 }, cfg.physics || {});
    this.wcfg = Object.assign({ riverWidth: 340 }, cfg.world || {});
    this.seed = num(cfg.seed, 20260801) | 0;

    this.mode = (this.state && this.state.camera && this.state.camera.mode) || 'chase';
    if (CAMERA_MODES.indexOf(this.mode) < 0) this.mode = 'chase';

    // --- smoothing state
    this.pos = new Damp3();
    this.aim = new Damp3();
    this.ride = new Damp3();      // ride axis as a vector (x in .x, z in .z) — no wrap bugs
    this.fovD = new Damp(num(this.rcfg.fov, 58));
    this.rollD = new Damp(0);
    this.liftD = new Damp(0);
    this.yawRateD = new Damp(0);
    this.latD = new Damp(0);
    this.tubeD = new Damp(0);
    this.airD = new Damp(0);
    this.woD = new Damp(0);

    this._rideSign = 1;
    this._prevRideYaw = 0;
    this._orbit = 0;
    this._impulse = 0;
    this._shake = 0;
    this._snap = true;
    this._boreFails = 0;
    this._boreOk = true;
    this._cycleLatch = false;
    this._prevCycle = false;
    this._disposed = false;

    // Basis (filled every step): crest tangent + outward face direction, XZ.
    this._ax = 1; this._az = 0;   // along the crest line (down-the-line axis)
    this._fx = 0; this._fz = 1;   // from the crest toward flat water (+d)

    this._bindBus();
    this._hookCamCycle();
    if (this.state && this.state.camera) this.state.camera.mode = this.mode;
  }

  // ------------------------------------------------------------------- public
  setMode(mode, external = false) {
    const m = CAMERA_MODES.indexOf(mode) >= 0 ? mode : 'chase';
    const changed = m !== this.mode;
    this.mode = m;
    if (this.state && this.state.camera) this.state.camera.mode = m;
    // A camera mode change is a cut, not a move — snap so we never fly the rig
    // 150 metres across the river in front of the player.
    if (changed || !external) this._snap = true;
    return m;
  }

  getMode() { return this.mode; }

  cycleMode(dir = 1) {
    const i = CAMERA_MODES.indexOf(this.mode);
    const n = CAMERA_MODES.length;
    return this.setMode(CAMERA_MODES[(((i + dir) % n) + n) % n]);
  }

  // Anyone can punch the rig (collisions, landings, checkpoints).
  impulse(amount = 1) { this._impulse = Math.min(3, this._impulse + Math.abs(num(amount, 0))); }

  step(dt) {
    if (this._disposed || !this.camera) return;
    dt = clamp(num(dt, 1 / 60), 1e-4, 0.1);

    const st = this.state;
    if (!st || !st.player) return;
    const p = st.player;
    const t = num(st.time, 0);

    // External mode changes (capture.js sets state.camera.mode then calls setMode).
    if (st.camera && st.camera.mode && st.camera.mode !== this.mode) this.setMode(st.camera.mode, true);
    this._pollCamCycle();

    // ---- sanitised player pose (a broken neighbour must not NaN the camera)
    const px = num(p.x, 0), py = num(p.y, 0), pz = num(p.z, 0);
    const vx = num(p.vx, 0), vz = num(p.vz, 0);
    const speed = Math.max(0, num(p.speed, Math.hypot(vx, vz)));
    const heading = num(p.heading, 0);

    const surfY = this._waterY(px, pz);
    const wipeout = p.wipeout ? 1 : 0;
    const airborne = p.airborne ? 1 : 0;
    const tube = this.tubeD.step(p.inTube ? 1 : 0, 0.28, dt);
    const air = this.airD.step(airborne, 0.30, dt);
    const wo = this.woD.step(wipeout, wipeout ? 0.16 : 0.55, dt);

    // ---- wave basis: crest tangent (down-the-line) and outward face direction
    this._basis(px, t);
    const ax = this._ax, az = this._az;     // along the crest
    const fx = this._fx, fz = this._fz;     // toward flat water

    // Which way down the line are we going? Hysteresis so it never chatters.
    const lat = this.latD.step(clamp((vx * ax + vz * az) / 5.0, -1, 1), 0.55, dt);
    if (lat > 0.16) this._rideSign = 1; else if (lat < -0.16) this._rideSign = -1;
    const sgn = this._rideSign;
    const dlx = ax * sgn, dlz = az * sgn;   // down-the-line unit vector

    // ---- ride axis: velocity, stabilised toward the down-the-line axis
    let vdx = vx, vdz = vz;
    let vm = Math.hypot(vdx, vdz);
    if (vm < 0.6) { vdx = Math.sin(heading); vdz = Math.cos(heading); vm = 1; }
    vdx /= vm; vdz /= vm;
    const bl = FRAME.downLineBlend * (1 - wo * 0.8);
    let rdx = vdx * (1 - bl) + dlx * bl;
    let rdz = vdz * (1 - bl) + dlz * bl;
    let rm = Math.hypot(rdx, rdz);
    if (rm < 0.2) { rdx = vdx; rdz = vdz; rm = 1; }
    rdx /= rm; rdz /= rm;

    const baseSmooth = 1 / Math.max(0.5, num(this.cfg.smooth, 6.5));
    const shape = SHAPE[this.mode] || SHAPE.chase;
    // Wipeout loosens the rig; the tube tightens it.
    const looseness = (1 + wo * 1.15) * (1 - tube * 0.25);
    const smoothPos = baseSmooth * shape.smooth * looseness;
    const smoothAim = smoothPos * num(shape.aim, 0.85);

    if (this._snap) this.ride.set(rdx, 0, rdz);
    else this.ride.step(rdx, 0, rdz, baseSmooth * (1 + wo * 3.0) * shape.smooth, dt);
    let sx = this.ride.x.v, sz = this.ride.z.v;
    const sm = Math.hypot(sx, sz);
    if (sm > 1e-3) { sx /= sm; sz /= sm; } else { sx = rdx; sz = rdz; }

    // ---- look-ahead into the turn
    const rideYaw = Math.atan2(sx, sz);
    if (this._snap) { this._prevRideYaw = rideYaw; this.yawRateD.set(0); }
    const rawYawRate = clamp(wrapPi(rideYaw - this._prevRideYaw) / dt, -4, 4);
    this._prevRideYaw = rideYaw;
    const yawRate = this._snap ? 0 : this.yawRateD.step(rawYawRate, 0.26, dt);
    // d/dψ of (sinψ, cosψ) — the world direction the ride is curving toward.
    const tlx = sz * yawRate * FRAME.turnLead;
    const tlz = -sx * yawRate * FRAME.turnLead;

    // ---- pocket anticipation: a barrel pitching down the line pulls the aim on
    const barrelAhead = this._barrel(px + dlx * 34, t);
    const pocket = clamp01(barrelAhead - 0.25) * 1.33;

    const anchorY = surfY + (py - surfY) * (airborne ? FRAME.airAnchor : 1);
    const maxSpeed = Math.max(1, num(this.pcfg.maxSpeed, 24));
    const speedN = clamp01(speed / maxSpeed);

    // ---- desired pose --------------------------------------------------------
    const D = this._desired(px, pz, anchorY, surfY, speed, {
      sx, sz, ax, az, fx, fz, dlx, dlz, tlx, tlz, tube, air, wo, pocket, dt, t,
    });

    if (this._snap) {
      this.pos.set(D.px, D.py, D.pz);
      this.aim.set(D.ax, D.ay, D.az);
      this.rollD.set(D.roll);
      this.liftD.set(0);
      this._shake = 0;
      this._impulse = 0;
    } else {
      this.pos.step(D.px, D.py, D.pz, smoothPos, dt);
      this.aim.step(D.ax, D.ay, D.az, smoothAim, dt);
      this.rollD.step(D.roll, baseSmooth * 1.6, dt);
    }

    let cx = this.pos.x.v, cy = this.pos.y.v, cz = this.pos.z.v;
    let tx = this.aim.x.v, ty = this.aim.y.v, tz = this.aim.z.v;
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) {
      cx = D.px; cy = D.py; cz = D.pz; this.pos.set(cx, cy, cz);
    }

    // Never end up inside the surfer. Done before the lift, and never written back
    // into the damper — otherwise the correction would compound frame after frame.
    const ox = cx - px, oy = cy - py, oz = cz - pz;
    const od = Math.hypot(ox, oy, oz);
    if (od < FRAME.minSubject && od > 1e-4) {
      const k = FRAME.minSubject / od;
      cx = px + ox * k; cy = py + oy * k; cz = pz + oz * k;
    }

    // ---- HARD RULE: stay out of the water, and keep the surfer visible -------
    const lift = this._clearance(cx, cy, cz, tx, ty, tz, tube);
    const liftS = this._snap ? this.liftD.set(lift) : this.liftD.step(lift, 0.11, dt);
    cy += Math.max(0, num(liftS, 0));

    // ---- shake ---------------------------------------------------------------
    this._impulse *= Math.exp(-dt * 3.1);
    if (this._impulse < 1e-4) this._impulse = 0;
    const shakeSpeedCfg = num(this.cfg.shakeSpeed, 0.35);
    const brk = this._breakIntensity(px, t);
    const nearLip = 1 - clamp01(Math.abs(num(p.d, 8)) / 14);
    const turbulence = brk * nearLip * (p.onWave === false ? 0.4 : 1);
    const rawShake = clamp01(
      this._impulse
      + shakeSpeedCfg * speedN * speedN * 0.9
      + shakeSpeedCfg * turbulence * 0.75
      + tube * 0.16,
    ) * shape.shake;
    this._shake = this._snap ? rawShake : this._shake + (rawShake - this._shake) * Math.min(1, dt * 11);

    const sh = this._shake;
    if (sh > 1e-3) {
      const amp = FRAME.shakePos * sh;
      cx += shakeNoise(t, 1, this.seed) * amp;
      cy += shakeNoise(t, 2, this.seed) * amp * 0.8;
      cz += shakeNoise(t, 3, this.seed) * amp;
    }

    // ---- FOV -----------------------------------------------------------------
    const fovBase = num(this.rcfg.fov, 58);
    const gain = num(this.rcfg.fovSpeedGain, 14) * shape.fovGain;
    const fovTarget = fovBase
      + gain * (speedN * speedN * 0.65 + speedN * 0.35)
      + tube * 2.2
      + wo * 3.0;
    const fov = this._snap ? this.fovD.set(fovTarget) : this.fovD.step(fovTarget, 0.34, dt);

    // ---- apply ---------------------------------------------------------------
    const cam = this.camera;
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) { tx = px; ty = py + 1; tz = pz; }
    cam.position.set(cx, cy, cz);
    if (cam.up) cam.up.set(0, 1, 0);
    cam.lookAt(tx, ty, tz);
    if (sh > 1e-3) {
      cam.rotateY(shakeNoise(t, 4, this.seed) * FRAME.shakeRot * sh);
      cam.rotateX(shakeNoise(t, 5, this.seed) * FRAME.shakeRot * sh * 0.8);
    }
    const roll = this.rollD.v + (sh > 1e-3 ? shakeNoise(t, 6, this.seed) * FRAME.shakeRot * sh * 1.6 : 0);
    if (Math.abs(roll) > 1e-5) cam.rotateZ(roll);

    if (Math.abs((cam.fov || 0) - fov) > 0.01) {
      cam.fov = fov;
      if (cam.updateProjectionMatrix) cam.updateProjectionMatrix();
    }

    if (st.camera) {
      st.camera.fov = cam.fov;
      st.camera.shake = sh;
      st.camera.mode = this.mode;
    }

    this._snap = false;
  }

  dispose() {
    this._disposed = true;
    if (this._unbind) { for (const off of this._unbind) { try { off(); } catch (e) { /* noop */ } } }
    this._unbind = null;
    if (this._unhookCam) { try { this._unhookCam(); } catch (e) { /* noop */ } this._unhookCam = null; }
  }

  // ------------------------------------------------------------------ framing
  // Builds the desired (un-smoothed) camera pose for the current mode.
  _desired(px, pz, anchorY, surfY, speed, k) {
    const cfg = this.cfg;
    const tt = num(cfg.tubeTighten, 0.55);
    const { sx, sz, fx, fz, dlx, dlz, tlx, tlz, tube, air, wo, pocket } = k;
    const out = { px, py: anchorY + 3, pz, ax: px, ay: anchorY + FRAME.aimLift, az: pz, roll: 0 };
    const lean = num(this.state.player.lean, 0);
    const shape = SHAPE[this.mode] || SHAPE.chase;

    if (this.mode === 'chase') {
      const c = cfg.chase;
      const dist = num(c.dist, 6.4) * (1 - tube * tt * 0.55) * (1 + air * 0.20) * (1 + wo * 0.42);
      const height = num(c.height, 2.35) * (1 - tube * tt * 0.78) * (1 - wo * 0.48);
      const side = num(c.side, 0.9) * (1 - tube * 0.6);
      out.px = px - sx * dist + fx * side;
      out.pz = pz - sz * dist + fz * side;
      out.py = anchorY + height;

      const lead = num(c.lookAhead, 9) * (1 + tube * 0.85) + speed * FRAME.speedLead + pocket * FRAME.pocketLead;
      const bias = FRAME.waveBias * (1 - tube * 0.75) * (1 - wo);
      out.ax = px + sx * lead + fx * bias + tlx + dlx * pocket * 2.0;
      out.az = pz + sz * lead + fz * bias + tlz + dlz * pocket * 2.0;
      out.ay = anchorY + FRAME.aimLift + tube * this._tubeRoof(px, k.t) * 0.30;
      out.roll = -lean * 0.055;
      this._faceFloor(out, k.t, FRAME.faceFloor * (1 - tube));
      this._applyPitch(out, num(c.pitch, -0.06) * (1 - tube * 0.5));
    } else if (this.mode === 'front') {
      const c = cfg.front;
      // Out on the flat water in front of the surfer, looking back into the bore.
      let ffx = fx * 0.55 + sx * 0.45, ffz = fz * 0.55 + sz * 0.45;
      const fm = Math.hypot(ffx, ffz) || 1;
      ffx /= fm; ffz /= fm;
      const dist = num(c.dist, 9.5) * (1 + air * 0.15) * (1 + wo * 0.30);
      const height = num(c.height, 2.05) * (1 - wo * 0.40);
      out.px = px + ffx * dist - ffz * num(c.side, 0);
      out.pz = pz + ffz * dist + ffx * num(c.side, 0);
      out.py = anchorY + height;
      // Negative lookAhead: aim *past* the surfer so the wave fills the frame
      // behind him and he stays dead centre.
      const past = Math.abs(num(c.lookAhead, -6));
      out.ax = px - ffx * past + tlx * 0.5;
      out.az = pz - ffz * past + tlz * 0.5;
      out.ay = anchorY + FRAME.aimLift * 0.9;
      out.roll = -lean * 0.02;
      this._applyPitch(out, num(c.pitch, -0.02));
    } else if (this.mode === 'side') {
      const c = cfg.side;
      // Pulled out onto the flat water and back down the line: profile of the
      // ride with the unbroken shoulder ahead of the surfer and both banks in.
      const dist = num(c.dist, 17) * (1 + wo * 0.2);
      const sideOff = num(c.side, 15);
      out.px = px + fx * dist - dlx * sideOff;
      out.pz = pz + fz * dist - dlz * sideOff;
      out.py = anchorY + num(c.height, 4.2);
      const lead = num(c.lookAhead, 4) + speed * FRAME.speedLead * 0.5;
      out.ax = px + sx * lead + tlx * 0.6;
      out.az = pz + sz * lead + tlz * 0.6;
      out.ay = surfY + FRAME.aimLift * 1.2;
      out.roll = -lean * 0.02;
      this._applyPitch(out, num(c.pitch, -0.10));
    } else if (this.mode === 'aerial') {
      const c = cfg.aerial;
      const height = Math.max(8, num(c.height, 68));
      const pitch = Math.max(0.15, Math.abs(num(c.pitch, -0.78)));
      // Boom rig: `pitch` sets the depression to the surfer, `dist` is extra
      // pull-back on top of it. Puts the bore across mid-frame with sky above.
      const stand = height / Math.tan(pitch) + num(c.dist, 42);
      out.px = px + fx * stand;
      out.pz = pz + fz * stand;
      out.py = surfY + height;
      const past = Math.abs(num(c.lookAhead, 40));
      out.ax = px - fx * past;
      out.az = pz - fz * past;
      out.ay = surfY;
      out.roll = 0;
    } else { // free
      const c = cfg.side;
      const steer = num(this.state.input && this.state.input.steer, 0);
      this._orbit += k.dt * (0.22 + steer * 0.85);
      const dist = num(c.dist, 17) * 0.85;
      out.px = px + Math.sin(this._orbit) * dist;
      out.pz = pz + Math.cos(this._orbit) * dist;
      out.py = anchorY + num(c.height, 4.2) * 1.05;
      out.ax = px; out.az = pz;
      out.ay = anchorY + FRAME.aimLift;
      out.roll = 0;
      this._faceFloor(out, k.t, FRAME.faceFloor);
    }

    // Wipeout: let go and look at the water the surfer just went into.
    out.roll *= shape.roll;
    if (wo > 0.01) {
      out.ay = out.ay * (1 - wo) + (surfY - 0.45) * wo;
      out.roll += wo * 0.085 * shape.roll;
    }
    return out;
  }

  // Riding hard down the face would otherwise drop the rig behind the lip and into
  // the whitewater. Slide it back down the face instead of craning it over the top —
  // a vertical rescue turns a chase shot into a bird's-eye shot.
  _faceFloor(out, t, floor) {
    if (floor <= 0 || !this._boreOk) return;
    const zc = this._crest(out.px, t);
    if (zc === null) return;
    const d = out.pz - zc;
    if (d >= floor) return;
    const push = Math.min(floor - d, 14);
    out.px += this._fx * push;
    out.pz += this._fz * push;
  }

  // `pitch` from CONFIG is a trim on the geometric look direction: rotate the aim
  // point about the camera in the vertical plane.
  _applyPitch(out, pitch) {
    if (!pitch) return;
    const dx = out.ax - out.px, dy = out.ay - out.py, dz = out.az - out.pz;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 1e-4) return;
    const ang = Math.atan2(dy, horiz) + pitch;
    const len = Math.hypot(horiz, dy);
    const nh = Math.cos(ang) * len, nv = Math.sin(ang) * len;
    out.ax = out.px + (dx / horiz) * nh;
    out.az = out.pz + (dz / horiz) * nh;
    out.ay = out.py + nv;
  }

  // ---------------------------------------------------------------- clearance
  // The single most common defect in surf games is the camera slicing through the
  // water. We check the camera itself *and* the line of sight to the subject.
  _clearance(cx, cy, cz, tx, ty, tz, tube) {
    if (!this._boreOk) return 0;
    const aerial = this.mode === 'aerial';
    const margin = tube > 0.5 ? FRAME.clearMarginTube : (aerial ? FRAME.clearMarginAerial : FRAME.clearMargin);
    let lift = this._waterY(cx, cz) + margin - cy;

    // Sight-line samples: if the wave wall rises between the camera and the
    // surfer, climb until we can see over it. The required clearance tapers off
    // toward the target — the surfer is *on* the water, so demanding a full
    // margin next to him would launch the rig for no reason.
    const S = [0.25, 0.45, 0.65];
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      const w = this._waterY(cx + (tx - cx) * s, cz + (tz - cz) * s) + margin * 0.5;
      const segY = cy * (1 - s) + ty * s;
      if (w > segY) lift = Math.max(lift, Math.min(8, (w - segY) / (1 - s)));
    }

    if (tube > 0.5) {
      // Inside the throat: stay under the roof so we frame the light at the end
      // of the barrel instead of popping out through the lip.
      const roof = this._tubeRoof(tx, num(this.state.time, 0));
      if (roof > 0.5) lift = Math.min(lift, Math.max(0, roof - 0.35 - cy));
      lift = Math.min(lift, 0.6);
    }
    return clamp(num(lift, 0), 0, FRAME.maxLift);
  }

  // -------------------------------------------------------------- wave access
  _basis(px, t) {
    // Crest tangent by central difference → down-the-line axis and the outward
    // (toward flat water) axis. Only needs bore.crest().
    let dzdx = 0;
    const b = this.bore;
    if (this._boreOk && b && typeof b.crest === 'function') {
      try {
        const h = 3.0;
        const c1 = b.crest(px - h, t), c2 = b.crest(px + h, t);
        if (Number.isFinite(c1) && Number.isFinite(c2)) dzdx = (c2 - c1) / (2 * h);
      } catch (e) { this._fail(); }
    }
    dzdx = clamp(num(dzdx, 0), -2, 2);
    const inv = 1 / Math.hypot(1, dzdx);
    this._ax = inv; this._az = dzdx * inv;
    this._fx = -dzdx * inv; this._fz = inv;
  }

  _crest(x, t) {
    const b = this.bore;
    if (!this._boreOk || !b || typeof b.crest !== 'function') return null;
    try { const c = b.crest(x, t); return Number.isFinite(c) ? c : null; } catch (e) { this._fail(); return null; }
  }

  _waterY(x, z) {
    const b = this.bore;
    if (!this._boreOk || !b || typeof b.height !== 'function') return 0;
    try {
      const y = b.height(x, z, num(this.state.time, 0));
      return Number.isFinite(y) ? clamp(y, -50, 80) : 0;
    } catch (e) { this._fail(); return 0; }
  }

  _barrel(x, t) {
    const b = this.bore;
    if (!this._boreOk || !b || typeof b.barrel !== 'function') return 0;
    try { return clamp01(num(b.barrel(x, t), 0)); } catch (e) { this._fail(); return 0; }
  }

  _breakIntensity(x, t) {
    const b = this.bore;
    if (!this._boreOk || !b || typeof b.breakIntensity !== 'function') return 0;
    try { return clamp01(num(b.breakIntensity(x, t), 0)); } catch (e) { this._fail(); return 0; }
  }

  _tubeRoof(x, t) {
    const b = this.bore;
    if (!this._boreOk || !b || typeof b.tubePocket !== 'function') return 0;
    try {
      // Reused `out` record (bore.js §3.1) — this runs every render frame and the
      // result never outlives this call, so there is no reason to allocate one.
      const r = b.tubePocket(x, t, TUBE_OUT);
      return r && Number.isFinite(r.roof) ? clamp(r.roof, 0, 30) : 0;
    } catch (e) { this._fail(); return 0; }
  }

  _fail() {
    // A neighbour that throws must not take the camera down with it.
    if (++this._boreFails >= 4) this._boreOk = false;
  }

  // --------------------------------------------------------------- plumbing
  _bindBus() {
    const bus = this.bus;
    this._unbind = [];
    if (!bus || typeof bus.on !== 'function') return;
    const k = num(this.cfg.shakeImpact, 1.6);
    const add = (evt, fn) => { try { this._unbind.push(bus.on(evt, fn)); } catch (e) { /* noop */ } };

    add('player:wipeout', () => this.impulse(k));
    add('player:hit', () => this.impulse(k * 0.55));
    add('obstacle:hit', () => this.impulse(k * 0.55));
    add('player:graze', () => this.impulse(k * 0.22));
    add('obstacle:graze', () => this.impulse(k * 0.22));
    add('player:land', () => this.impulse(k * 0.22));
    add('trick:land', (e) => this.impulse(k * (e && e.clean === false ? 0.38 : 0.20)));
    add('trick:fail', () => this.impulse(k * 0.30));
    add('tube:enter', () => this.impulse(k * 0.16));
    add('tube:exit', () => this.impulse(k * 0.30));
    add('race:checkpoint', () => this.impulse(k * 0.12));
    add('camera:shake', (e) => this.impulse(typeof e === 'number' ? e : (e && e.amount) || k * 0.5));
    add('camera:mode', (e) => this.setMode(typeof e === 'string' ? e : (e && e.mode)));
  }

  // input.camCycle is a single-sim-step pulse; the rig runs on render frames and
  // would miss it. Latch writes to the flag instead of polling for them.
  _hookCamCycle() {
    const inp = this.state && this.state.input;
    if (!inp) return;
    const desc = Object.getOwnPropertyDescriptor(inp, 'camCycle');
    if (!desc || !('value' in desc) || desc.configurable === false) return;
    let v = desc.value;
    const self = this;
    try {
      Object.defineProperty(inp, 'camCycle', {
        configurable: true,
        enumerable: desc.enumerable !== false,
        get() { return v; },
        set(nv) { if (nv && !v) self._cycleLatch = true; v = nv; },
      });
      this._unhookCam = () => {
        Object.defineProperty(inp, 'camCycle', {
          configurable: true, enumerable: desc.enumerable !== false, writable: true, value: v,
        });
      };
    } catch (e) { /* polling fallback below still works */ }
  }

  _pollCamCycle() {
    const inp = this.state && this.state.input;
    const now = !!(inp && inp.camCycle);
    if (now && !this._prevCycle) this._cycleLatch = true;
    this._prevCycle = now;
    if (this._cycleLatch) { this._cycleLatch = false; this.cycleMode(1); }
  }
}

export default CameraRig;
