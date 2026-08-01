// POROROCA RUSH — manobras (trick state machine + scoring hooks).
//
// Reads state.player (owned by physics.js) and the wave field (bore), writes
// state.trick, drives physics.launch()/land()/wipeout(), and emits on the bus:
//
//   trick:start {name}
//   trick:land  {name, points, rotation, clean}
//   trick:fail  {name, reason}
//   tube:enter  {barrel, deep}
//   tube:exit   {duration, points, deep, clean}
//   combo:up    {name, points, chain}
//
// Design rules that make this feel like a surf game and not a random-points
// generator:
//   * every manobra is detected by INTENT — a sustained, deliberate gesture over
//     a time window, never a single-frame coincidence;
//   * every detector has a hysteresis / cooldown so it cannot machine-gun;
//   * risk scales with reward: the tube pays the most and can swallow you.
//
// All maths integrates with dt. No Math.random() anywhere.

import { CONFIG, TAU } from '../config.js';

// ---------------------------------------------------------------- utilities ---

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, f = 0) => (Number.isFinite(v) ? v : f);

/** Wrap an angle into (-PI, PI]. */
function wrapPi(a) {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Shortest signed delta from b to a. */
const angDelta = (a, b) => wrapPi(a - b);

// Module-local feel constants. These are *shapes of gestures*, not scores —
// every point value comes from CONFIG.tricks. If any of these ever need
// tuning from the outside they should be promoted into CONFIG.tricks.
const TUNE = {
  bannerTime: 1.95,       // seconds the HUD banner stays up

  // --- air ---
  airSpinRate: TAU * 1.12, // rad/s of yaw the spin stick can generate in the air
  grabHold: 0.15,          // seconds the grab must be held to count
  jumpBuffer: 0.22,        // jump input is remembered this long (game feel)
  launchCooldown: 0.32,
  launchFaceT: 0.30,       // must be this close to the lip (normalised)
  launchNearD: 6.5,        // ...or this many metres from it
  launchClimbRate: 0.8,    // m/s of d-closure that counts as "going up the face"
  minAirTime: 0.10,        // below this a touchdown is not a landing yet
  landRotTol: 1.05,        // rad of rotation error before the landing fails
  landCleanRot: 0.35,      // rad of rotation error for a clean landing
  landCleanAngle: 0.55,    // fraction of landAngleTolerance for a clean landing
  // Landing assist: on the way down the surfer commits and squares up. Limited
  // authority, so a long uncontrolled spin still lands sketchy and a short one
  // can still be blown completely.
  landAssistT: 0.35,       // seconds before impact the assist takes over
  landAssistH: 1.6,        // ...or this height above the water
  landAssistRate: TAU * 0.5,

  // --- tube ---
  tubeEnterHold: 0.10,     // must be inside this long before tube:enter
  tubeExitHold: 0.20,      // must be outside this long before the tube ends
  tubeDeepBanner: 0.60,    // maxDeep above this reads "TUBO PROFUNDO!"
  tubeDeepMinTime: 1.15,
  tubeGrace: 0.55,         // no closeout kill in the first moments
  tubeCloseHold: 0.26,     // barrel must stay collapsed this long to eat you
  tubeSwallowHold: 0.16,   // must be behind the throat this long to be swallowed
  tubeSwallowMargin: 1.3,  // metres behind the throat that counts as swallowed

  // --- turning tricks (cutback / rasgada) ---
  turnMinRate: 0.55,       // rad/s that counts as "turning on purpose"
  turnBreakRate: 0.26,     // below this the gesture is considered over
  turnBreakTime: 0.26,     // ...for this long
  turnMaxTime: 1.8,        // a gesture longer than this is just wandering
  snapAngle: 1.15,         // rad — a snap is shorter than a cutback
  snapMaxTime: 0.80,       // ...and much faster
  cutbackKeepSpeed: 0.70,  // must retain this fraction of entry speed
  cutbackCooldown: 1.05,
  snapCooldown: 0.85,

  // --- floater ---
  floaterMaxD: 0.9,        // at/behind the lip line
  floaterMinD: -12.0,      // but not buried deep in the whitewater
  floaterBreak: 0.38,      // lip must actually be breaking here
  floaterMinSpeed: 6.0,
  floaterSink: 0.9,        // metres below the surface = not "on top" any more
  floaterCooldown: 0.75,

  // --- tail slide ---
  slideMinTime: 0.30,
  slideMinSpeed: 6.5,
  slideCooldown: 1.0,
  slideAfterTurn: 0.45,    // don't award a slide right after a snap/cutback
};

// ------------------------------------------------------------------ system ---

export class TrickSystem {
  /**
   * @param {object} ctx  { THREE, scene, renderer, camera, state, bus, bore, config, physics }
   *                      Also accepts the legacy positional form
   *                      (state, bore, physics, bus, config).
   */
  constructor(ctx, boreArg, physicsArg, busArg, configArg) {
    const isCtx = ctx && typeof ctx === 'object' && ctx.state;
    this.ctx = isCtx ? ctx : null;

    this.state = isCtx ? ctx.state : ctx;
    this.bore = isCtx ? ctx.bore : boreArg;
    this.bus = isCtx ? ctx.bus : busArg;
    this._physicsArg = isCtx ? undefined : physicsArg;

    const cfg = (isCtx ? ctx.config : configArg) || CONFIG;
    // Accept either the whole CONFIG or just the tricks block.
    this.T = { ...CONFIG.tricks, ...(cfg.tricks || (cfg.snapD !== undefined ? cfg : null) || {}) };
    this.P = { ...CONFIG.physics, ...(cfg.physics || {}) };
    this.W = { ...CONFIG.wave, ...(cfg.wave || {}) };
    this.S = { ...CONFIG.scoring, ...(cfg.scoring || {}) };

    // Which bore methods actually exist / behave. Probed lazily, latched off on
    // the first throw so a broken neighbour costs one exception, not thousands.
    this._boreOk = {
      barrel: true, tubePocket: true, faceParam: true,
      normal: true, height: true, breakIntensity: true, crest: true,
    };

    this._resetAll();
    this._warnedLaunch = false;
    this._emitErrors = 0;
    this._disposed = false;
  }

  // physics is injected on the ctx by main.js *before* our constructor runs, but
  // resolve it lazily anyway so ordering changes cannot break us.
  get physics() {
    return this._physicsArg || this.ctx?.physics || null;
  }

  // ------------------------------------------------------------- lifecycle ---

  _resetAll() {
    const st = this.state;

    this.chain = 0;
    this._lastAwardT = -999;

    this._prevHeading = num(st?.player?.heading, 0);
    this._prevD = num(st?.player?.d, 0);
    this._dRate = 0;
    this._turnRateS = 0;
    this._prevJump = false;
    this._jumpBuffer = 0;
    this._prevWipeout = !!st?.player?.wipeout;
    this._prevAirborne = !!st?.player?.airborne;
    this._lastLaunchT = -999;

    this._air = null;

    this._tube = {
      inside: false, enterT: 0, dur: 0, points: 0,
      maxDeep: 0, holdIn: 0, holdOut: 0,
      closeT: 0, swallowT: 0, announced: false,
    };

    this._turn = { active: false, accum: 0, dur: 0, sign: 0, startSpeed: 0, idle: 0 };
    this._cutbackCd = 0;
    this._snapCd = 0;
    this._lastTurnAwardT = -999;

    this._floater = { on: false, dur: 0, cd: 0, announced: false };
    this._slide = { on: false, dur: 0, cd: 0 };

    if (st?.trick) {
      st.trick.active = null;
      st.trick.rotation = 0;
      st.trick.grab = false;
      st.trick.airPeak = 0;
      st.trick.spinRate = 0;
      st.trick.tubePoints = 0;
      st.trick.tubeDuration = 0;
      st.trick.chain = 0;
      st.trick.landClean = true;
    }
  }

  dispose() { this._disposed = true; }

  // ------------------------------------------------------ defensive helpers ---

  _emit(evt, payload) {
    const bus = this.bus;
    if (!bus || typeof bus.emit !== 'function') return;
    try { bus.emit(evt, payload); } catch (_e) { this._emitErrors++; }
  }

  /** Call a bore method, degrading to `fallback` if it is missing or throws. */
  _bore(name, fallback, a, b, c, d) {
    const bore = this.bore;
    if (!bore || !this._boreOk[name] || typeof bore[name] !== 'function') return fallback;
    try {
      const r = bore[name](a, b, c, d);
      return r === undefined || r === null ? fallback : r;
    } catch (_e) {
      this._boreOk[name] = false;
      return fallback;
    }
  }

  /** Face sample: prefer what physics already computed, fall back to the wave. */
  _face(p, t) {
    let d = p.d, faceT = p.faceT, slope = p.slope;
    let dx = 0, dz = 1;
    if (!Number.isFinite(d) || !Number.isFinite(faceT) || !Number.isFinite(slope)) {
      const fp = this._bore('faceParam', null, p.x, p.z, t);
      if (fp) {
        if (!Number.isFinite(d)) d = num(fp.d, 0);
        if (!Number.isFinite(faceT)) faceT = num(fp.faceT, 0.3);
        if (!Number.isFinite(slope)) slope = num(fp.slope, 0);
        const dh = fp.downhill;
        if (dh) { dx = num(dh.x, num(dh[0], 0)); dz = num(dh.y, num(dh[1], 1)); }
      }
    }
    d = num(d, 0);
    faceT = clamp(num(faceT, 0.3), 0, 1);
    slope = num(slope, 0);
    return { d, faceT, slope, dx, dz };
  }

  /** Water surface Y under the surfer. */
  _waterY(p, t) {
    if (Number.isFinite(p.surfaceY)) return p.surfaceY;
    return num(this._bore('height', 0, p.x, p.z, t), 0);
  }

  /** Unit water normal at (x, z), with a slope-derived fallback. */
  _normal(p, t, face, out) {
    const n = out || { x: 0, y: 1, z: 0 };
    const r = this._bore('normal', null, p.x, p.z, t);
    if (r) {
      const x = num(r.x, num(r[0], NaN));
      const y = num(r.y, num(r[1], NaN));
      const z = num(r.z, num(r[2], NaN));
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        const l = Math.hypot(x, y, z) || 1;
        n.x = x / l; n.y = y / l; n.z = z / l;
        return n;
      }
    }
    // Fallback: tilt "up" away from the downhill direction by the face slope.
    const s = Math.sin(face.slope), c = Math.cos(face.slope);
    const dl = Math.hypot(face.dx, face.dz) || 1;
    n.x = -(face.dx / dl) * s; n.y = c; n.z = -(face.dz / dl) * s;
    return n;
  }

  /**
   * Board "up" vector from the surfer's yaw/pitch/roll.
   * heading 0 = +Z, +heading rotates toward +X (matches ARCHITECTURE §1).
   */
  _boardUp(p, out) {
    const yaw = num(p.heading, 0), pit = num(p.pitch, 0), rol = num(p.roll, 0);
    const sr = Math.sin(rol), cr = Math.cos(rol);
    const sp = Math.sin(pit), cp = Math.cos(pit);
    // roll about forward(Z), then pitch about right(X)
    const ux = -sr, uy = cr * cp, uz = cr * sp;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const n = out || { x: 0, y: 1, z: 0 };
    n.x = ux * cy + uz * sy;
    n.y = uy;
    n.z = -ux * sy + uz * cy;
    const l = Math.hypot(n.x, n.y, n.z) || 1;
    n.x /= l; n.y /= l; n.z /= l;
    return n;
  }

  // ------------------------------------------------------------ scoring I/O ---

  /**
   * Show a banner. Mutates the existing object when the text is unchanged so a
   * long tube ride does not allocate 120 objects a second.
   */
  _banner(text, points) {
    const tr = this.state.trick;
    if (!tr) return;
    const until = num(this.state.time, 0) + TUNE.bannerTime;
    const pts = Math.round(num(points, 0));
    const b = tr.banner;
    if (b && b.text === text) { b.points = pts; b.until = until; return; }
    tr.banner = { text, points: pts, until };
  }

  /**
   * A manobra landed. Single funnel so chaining, banner, state and bus events
   * can never drift apart.
   *   id   — stable machine id ('tubo' | 'aereo' | 'cutback' | ...)
   *   name — Portuguese display string, also used for the HUD banner.
   */
  _award(id, rawPoints, opts = {}) {
    const st = this.state, tr = st.trick;
    const t = num(st.time, 0);
    const points = Math.max(0, Math.round(num(rawPoints, 0)));
    const name = opts.name || id;

    if (t - this._lastAwardT <= num(this.S.comboWindow, 4.2)) this.chain++;
    else this.chain = 1;
    this._lastAwardT = t;

    if (tr) {
      tr.lastLanded = name;
      tr.lastPoints = points;
      tr.chain = this.chain;
      tr.landClean = opts.clean !== false;
    }

    this._banner(name, points);
    this._emit('trick:land', {
      name, id, points,
      rotation: num(opts.rotation, 0),
      clean: opts.clean !== false,
      chain: this.chain,
    });
    this._emit('combo:up', { name, id, points, chain: this.chain });
  }

  _fail(id, reason, name) {
    const tr = this.state.trick;
    if (tr) { tr.lastLanded = null; tr.lastPoints = 0; tr.chain = 0; }
    this.chain = 0;
    this._emit('trick:fail', { name: name || id, id, reason: reason || null });
  }

  // ------------------------------------------------------------------ step ---

  step(dt) {
    if (this._disposed) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;              // never let a hitch teleport the machine

    const st = this.state;
    if (!st || !st.player || !st.trick) return;

    const p = st.player;
    const i = st.input || {};
    const tr = st.trick;
    const t = num(st.time, 0);

    // --- banner expiry -------------------------------------------------------
    if (tr.banner && num(tr.banner.until, 0) <= t) tr.banner = null;

    // --- cooldowns -----------------------------------------------------------
    this._cutbackCd = Math.max(0, this._cutbackCd - dt);
    this._snapCd = Math.max(0, this._snapCd - dt);
    this._floater.cd = Math.max(0, this._floater.cd - dt);
    this._slide.cd = Math.max(0, this._slide.cd - dt);
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

    // --- derived rates -------------------------------------------------------
    const face = this._face(p, t);
    const heading = num(p.heading, 0);
    const speed = Math.max(0, num(p.speed, Math.hypot(num(p.vx, 0), num(p.vz, 0))));
    const airborne = !!p.airborne;
    const wiped = !!p.wipeout;

    const dHead = angDelta(heading, this._prevHeading);
    const dDelta = face.d - this._prevD;
    // physics.reset() teleports the surfer back into the pocket after a wipeout.
    // A discontinuity that large is not a gesture — drop the trackers instead of
    // letting the spike read as a snap or a launch.
    if (Math.abs(dHead) > Math.max(1.2, 25 * dt) || Math.abs(dDelta) > Math.max(12, 60 * dt)) {
      this._turnRateS = 0;
      this._dRate = 0;
      this._jumpBuffer = 0;
      this._turn.active = false; this._turn.accum = 0; this._turn.dur = 0;
    } else {
      this._turnRateS += (dHead / dt - this._turnRateS) * Math.min(1, 18 * dt);
      this._dRate += (dDelta / dt - this._dRate) * Math.min(1, 14 * dt);
    }

    // --- wipeout edge: tear everything down ---------------------------------
    if (wiped && !this._prevWipeout) {
      this._onWipeout(p, t);
      this._prevWipeout = true;
      this._prevHeading = heading; this._prevD = face.d;
      this._prevJump = !!i.jump;
      this._prevAirborne = airborne;
      return;
    }
    this._prevWipeout = wiped;

    if (wiped) {
      // Frozen during the wipeout/recovery beat — keep the machine quiet.
      tr.active = null;
      this._prevHeading = heading; this._prevD = face.d;
      this._prevJump = !!i.jump;
      this._prevAirborne = airborne;
      return;
    }

    // --- jump buffering ------------------------------------------------------
    const jump = !!i.jump;
    if (i.jumpPressed || (jump && !this._prevJump)) this._jumpBuffer = TUNE.jumpBuffer;
    this._prevJump = jump;

    // --- state machines ------------------------------------------------------
    this._stepAir(dt, p, i, tr, t, face, speed, airborne);
    // _stepAir can launch or land us, so re-read the flag before the rest.
    const air2 = !!p.airborne;
    this._stepTube(dt, p, tr, t, face, air2);
    if (!air2) {
      this._stepTurns(dt, p, tr, t, face, speed);
      this._stepFloater(dt, p, tr, t, face, speed);
      this._stepSlide(dt, p, tr, t, speed);
    } else {
      // Boosting off a floater is a legitimate way to finish one — it only
      // fails if we are actually going down.
      this._turn.active = false; this._turn.accum = 0; this._turn.dur = 0;
      this._endFloater(t, !p.wipeout);
      this._slide.on = false; this._slide.dur = 0;
    }

    // --- what the HUD / surfer should read ----------------------------------
    tr.active = this._air ? 'aereo'
      : this._tube.inside ? 'tubo'
      : this._floater.on ? 'floater'
      : this._slide.on ? 'derrapada'
      : null;

    this._prevHeading = heading;
    this._prevD = face.d;
    this._prevAirborne = !!p.airborne;
  }

  _onWipeout(p, t) {
    const tr = this.state.trick;
    if (this._tube.inside) {
      const dur = this._tube.dur;
      this._emit('tube:exit', { duration: dur, points: 0, deep: this._tube.maxDeep, clean: false });
      this._fail('tubo', 'engolido', 'TUBO');
      this._banner('ENGOLIDO!', 0);
    } else if (this._air) {
      this._fail('aereo', 'queda', 'AÉREO');
    } else if (this._floater.on && this._floater.dur >= num(this.T.floaterMinTime, 0.4)) {
      this._fail('floater', 'queda', 'FLOATER');
    }
    this._air = null;
    this._tube.inside = false; this._tube.dur = 0; this._tube.points = 0;
    this._tube.holdIn = 0; this._tube.holdOut = 0; this._tube.maxDeep = 0;
    this._tube.closeT = 0; this._tube.swallowT = 0; this._tube.announced = false;
    this._turn.active = false; this._turn.accum = 0; this._turn.dur = 0;
    this._floater.on = false; this._floater.dur = 0;
    this._slide.on = false; this._slide.dur = 0;
    this.chain = 0;
    if (tr) {
      tr.active = null; tr.rotation = 0; tr.grab = false; tr.airPeak = 0;
      tr.spinRate = 0; tr.tubePoints = 0; tr.tubeDuration = 0; tr.chain = 0;
    }
  }

  // -------------------------------------------------------------------- air ---

  _stepAir(dt, p, i, tr, t, face, speed, airborne) {
    const P = this.P;

    // ---- launch off the lip -------------------------------------------------
    if (!airborne && !this._air) {
      const canBoost =
        this._jumpBuffer > 0 &&
        (t - this._lastLaunchT) > TUNE.launchCooldown &&
        p.onWave !== false &&
        speed >= num(P.launchSpeedMin, 11) &&
        (face.faceT <= TUNE.launchFaceT || face.d <= TUNE.launchNearD) &&
        (this._dRate <= -TUNE.launchClimbRate || num(p.vy, 0) > 0.6);

      if (canBoost) {
        // Vertical speed the surfer carries up the face, normalised into a
        // 0.3..1.5 "power" the physics solver scales with launchGain.
        const climb = Math.max(0, -this._dRate);
        const vUp = climb * Math.abs(Math.sin(face.slope)) + Math.max(0, num(p.vy, 0));
        const ref = Math.max(4, num(P.launchSpeedMin, 11) * 0.55);
        const lipBias = 1 + 0.35 * (1 - clamp(face.d / Math.max(1e-3, TUNE.launchNearD), 0, 1));
        const power = clamp((vUp * 0.85 + speed * 0.16) / ref * lipBias, 0.3, 1.5);

        this._jumpBuffer = 0;
        this._lastLaunchT = t;

        const ph = this.physics;
        if (ph && typeof ph.launch === 'function') {
          try { ph.launch(power); } catch (_e) { /* neighbour not ready */ }
        } else if (!this._warnedLaunch) {
          // Degrade gracefully: a minimal pop so the air machine still has
          // something to score if physics.launch() is not implemented yet.
          this._warnedLaunch = true;
          p.airborne = true;
          p.airTime = 0;
          p.vy = num(p.vy, 0) + 4.5 + 4.5 * power;
        }
        this._beginAir(p, tr, t, face, speed, power);
      }
    }

    // physics.launch() flips player.airborne inside the call above, so the flag
    // captured at the top of step() is stale from here on — re-read it.
    const inAir = !!p.airborne;

    // Physics can also put us in the air on its own (ramp off a section, chop).
    if (inAir && !this._air) this._beginAir(p, tr, t, face, speed, 0);
    if (!this._air) return;

    const air = this._air;
    air.t += dt;
    if (inAir) air.sawAir = true;

    // If the launch never actually took (physics.launch is a no-op, or we were
    // rejected), quietly cancel instead of scoring a phantom air.
    if (!air.sawAir && air.t > 0.4) {
      this._air = null;
      tr.rotation = 0; tr.grab = false; tr.spinRate = 0; tr.airPeak = 0;
      return;
    }

    // ---- grab & altitude ---------------------------------------------------
    if (i.grab) air.grabHold += dt; else air.grabHold = 0;
    if (air.grabHold >= TUNE.grabHold) air.grab = true;
    tr.grab = air.grab;

    const waterY = this._waterY(p, t);
    const h = num(p.y, 0) - waterY;
    if (h > air.peak) air.peak = h;
    tr.airPeak = air.peak;

    // ---- rotation ----------------------------------------------------------
    // On the way down the surfer commits to the landing: the spin input hands
    // over to a limited-authority assist that pulls toward the nearest half
    // revolution (a 540 lands switch, which is a legitimate landing).
    const vy = num(p.vy, 0);
    const tti = vy < -0.1 ? h / -vy : Infinity;
    const committing = inAir && (tti <= TUNE.landAssistT || (h <= TUNE.landAssistH && vy <= 0));

    let spinRate;
    if (committing) {
      const half = Math.PI;
      const target = half * Math.round(air.rotation / half);
      const step = TUNE.landAssistRate * dt;
      const corr = clamp(target - air.rotation, -step, step);
      air.rotation += corr;
      spinRate = corr / dt;
    } else {
      const spin = clamp(num(i.spin, 0), -1, 1);
      spinRate = spin * TUNE.airSpinRate;
      air.rotation += spinRate * dt;
    }
    tr.rotation = air.rotation;
    tr.spinRate = spinRate;

    // ---- resolve: physics dropped the flag, or we touched down --------------
    const touched = air.sawAir && air.t >= TUNE.minAirTime && h <= 0.02;
    const landed = air.sawAir && !inAir;
    if (!landed && !touched) return;

    // If physics still thinks we are flying, tell it we came down.
    if (inAir) {
      const ph = this.physics;
      if (ph && typeof ph.land === 'function') { try { ph.land(); } catch (_e) { /* ignore */ } }
    }
    this._resolveAir(p, tr, t, face, speed, waterY);
  }

  _beginAir(p, tr, t, face, speed, power) {
    this._air = {
      t: 0, rotation: 0, grab: false, grabHold: 0, sawAir: !!p.airborne,
      peak: 0, startT: t, startSpeed: speed, power: num(power, 0),
      startHeading: num(p.heading, 0),
    };
    tr.rotation = 0;
    tr.grab = false;
    tr.airPeak = 0;
    tr.spinRate = 0;
    // An air cancels any pending face gesture.
    this._turn.active = false; this._turn.accum = 0; this._turn.dur = 0;
    this._emit('trick:start', { name: 'aereo', speed, power: num(power, 0) });
  }

  _resolveAir(p, tr, t, face, speed, waterY) {
    const T = this.T, P = this.P;
    const air = this._air;
    this._air = null;
    if (!air) return;

    const rot = air.rotation;
    const turns = Math.abs(rot) / TAU;

    // Rotation error against the nearest half revolution. Whole revolutions
    // (multiples of 2*PI) score zero error exactly as the contract asks; half
    // revolutions also land, switch-stance, which is what makes a 540 rideable.
    const rotErr = Math.abs(rot - Math.PI * Math.round(rot / Math.PI));

    // Board attitude at touchdown. Measured both against the water normal and
    // against level, taking the friendlier of the two: physics may author
    // pitch/roll either face-relative or world-relative, and a board that is
    // genuinely on its side fails both ways.
    const nrm = this._normal(p, t, face);
    const up = this._boardUp(p);
    const angFace = Math.acos(clamp(nrm.x * up.x + nrm.y * up.y + nrm.z * up.z, -1, 1));
    const angLevel = Math.acos(clamp(up.y, -1, 1));
    const landAngle = Math.min(angFace, angLevel);

    const angTol = Math.max(0.15, num(P.landAngleTolerance, 0.72));
    // Landing on the flat, far ahead of the pocket, is less forgiving.
    const flatPenalty = face.faceT > 0.92 ? 0.82 : 1.0;
    const cleanRot = TUNE.landCleanRot;
    const cleanAng = angTol * TUNE.landCleanAngle * flatPenalty;
    const okRot = TUNE.landRotTol;
    const okAng = angTol * flatPenalty;

    const clean = rotErr <= cleanRot && landAngle <= cleanAng && p.onWave !== false;
    const sketchy = !clean && rotErr <= okRot && landAngle <= okAng;

    let name = 'AÉREO';
    let id = 'aereo';
    let rotBonus = 0;
    if (turns >= 1.82) { name = 'AÉREO 720'; id = 'aereo720'; rotBonus = num(T.rot720, 9000); }
    else if (turns >= 1.32) { name = 'AÉREO 540'; id = 'aereo540'; rotBonus = num(T.rot540, 5200); }
    else if (turns >= 0.82) { name = 'AÉREO 360'; id = 'aereo360'; rotBonus = num(T.rot360, 2600); }

    if (!clean && !sketchy) {
      // Too far off — that is a crash, not a landing.
      this._fail(id, 'pouso', name);
      this._banner(`${name} FALHOU`, 0);
      tr.rotation = 0; tr.grab = false; tr.spinRate = 0;
      const ph = this.physics;
      if (ph && typeof ph.wipeout === 'function') {
        try { ph.wipeout('landing'); } catch (_e) { /* ignore */ }
      }
      return;
    }

    // Hang time already pays for altitude — no extra height multiplier, every
    // number here comes straight out of CONFIG.tricks.
    let pts = num(T.airBase, 1200) + num(T.airPerSecond, 900) * air.t + rotBonus;
    if (air.grab) { pts *= num(T.grabMult, 1.45); name += ' GRAB'; id += 'grab'; }
    pts *= clean ? num(T.cleanLandingMult, 1) : num(T.sketchyLandingMult, 0.45);

    this._award(id, pts, {
      rotation: rot, clean, name: clean ? name : `${name} SUJO`,
    });

    tr.rotation = 0;
    tr.grab = false;
    tr.spinRate = 0;
    // Fresh gesture tracking after touchdown.
    this._prevHeading = num(p.heading, 0);
    this._turn.active = false; this._turn.accum = 0; this._turn.dur = 0;
  }

  // ------------------------------------------------------------------- tube ---

  _stepTube(dt, p, tr, t, face, airborne) {
    const T = this.T, W = this.W;
    const tube = this._tube;

    const barrel = clamp(num(this._bore('barrel', 0, p.x, t), 0), 0, 1);
    const thresh = num(W.barrelThreshold, 0.5);
    const pocket = this._bore('tubePocket', null, p.x, t);

    // Depth inside the throat: 1 at the centre of the pocket, 0 at its edges.
    let derivedDeep = 0, inThroat = false, lo = 0, hi = 0;
    if (pocket && Number.isFinite(pocket.inner) && Number.isFinite(pocket.outer)) {
      lo = Math.min(pocket.inner, pocket.outer);
      hi = Math.max(pocket.inner, pocket.outer);
      const mid = (lo + hi) * 0.5;
      const half = Math.max(1e-3, (hi - lo) * 0.5);
      derivedDeep = clamp(1 - Math.abs(face.d - mid) / half, 0, 1);
      inThroat = face.d >= lo - 0.35 && face.d <= hi + 0.35;
    }

    const geomIn = !airborne && inThroat && barrel > thresh;
    const inside = (!airborne && p.inTube === true) || geomIn;

    // --- hysteresis on both edges so the pocket boundary cannot chatter ------
    if (inside) { tube.holdIn += dt; tube.holdOut = 0; }
    else { tube.holdOut += dt; tube.holdIn = 0; }

    if (!tube.inside) {
      if (inside && tube.holdIn >= TUNE.tubeEnterHold) {
        tube.inside = true;
        tube.enterT = t;
        tube.dur = 0; tube.points = 0; tube.maxDeep = 0;
        tube.closeT = 0; tube.swallowT = 0; tube.announced = true;
        this._emit('tube:enter', { barrel, deep: derivedDeep });
        this._emit('trick:start', { name: 'tubo', barrel });
        this._banner('TUBO', 0);
      }
      tr.tubePoints = 0;
      tr.tubeDuration = 0;
      return;
    }

    // ---- inside ------------------------------------------------------------
    let deep = num(p.deepTube, NaN);
    if (!Number.isFinite(deep) || deep <= 0) deep = derivedDeep;
    else deep = Math.max(deep, derivedDeep);
    deep = clamp(deep, 0, 1);

    if (inside) {
      if (deep < 0.2) deep = 0.2;   // being in there at all is worth something
      tube.dur += dt;
      tube.points += num(T.tubePointsPerSec, 900) * deep * dt;
      if (deep > tube.maxDeep) tube.maxDeep = deep;
    }

    tr.tubePoints = Math.round(tube.points);
    tr.tubeDuration = tube.dur;
    // Keep the banner alive and ticking while the ride lasts.
    this._banner(
      (tube.dur > TUNE.tubeDeepMinTime && tube.maxDeep >= TUNE.tubeDeepBanner)
        ? 'TUBO PROFUNDO!' : 'TUBO',
      tube.points,
    );

    // ---- being eaten -------------------------------------------------------
    // 1) pushed behind the throat / behind the crest.
    const behindRef = pocket ? lo - TUNE.tubeSwallowMargin : -0.6;
    if (face.d < behindRef) tube.swallowT += dt; else tube.swallowT = 0;
    // 2) the section closes down on top of you while you are still deep in it.
    const collapsing = barrel < thresh * 0.75 && face.d < 1.0 && deep > 0.35;
    if (collapsing && tube.dur > TUNE.tubeGrace) tube.closeT += dt; else tube.closeT = 0;

    if (tube.swallowT >= TUNE.tubeSwallowHold || tube.closeT >= TUNE.tubeCloseHold) {
      this._endTube(t, false, tube.swallowT > 0 ? 'engolido' : 'fechou');
      const ph = this.physics;
      if (ph && typeof ph.wipeout === 'function' && !p.wipeout) {
        try { ph.wipeout('overTheFalls'); } catch (_e) { /* ignore */ }
      }
      return;
    }

    // ---- clean exit out the front -----------------------------------------
    if (!inside && tube.holdOut >= TUNE.tubeExitHold) {
      const alive = p.onWave !== false && !p.wipeout && face.d > behindRef;
      this._endTube(t, alive, alive ? null : 'perdeu');
    }
  }

  /**
   * Close out the current tube ride.
   * Points are BANKED ON EXIT (ride points + exit bonus) rather than trickled
   * per-frame, so `tube:exit.points` and the `trick:land` award are always the
   * same number and scoring.js can never double-count.
   */
  _endTube(t, success, failReason) {
    const T = this.T;
    const tube = this._tube;
    const tr = this.state.trick;
    const dur = tube.dur;
    const deep = tube.maxDeep;
    const banked = tube.points;

    tube.inside = false;
    tube.holdIn = 0; tube.holdOut = 0;
    tube.closeT = 0; tube.swallowT = 0;
    tube.dur = 0; tube.points = 0; tube.maxDeep = 0;
    tube.announced = false;
    if (tr) { tr.tubePoints = 0; tr.tubeDuration = 0; }

    if (!success) {
      this._emit('tube:exit', { duration: dur, points: 0, deep, clean: false });
      this._fail('tubo', failReason || 'engolido', 'TUBO');
      this._banner(failReason === 'fechou' ? 'TUBO FECHOU!' : 'ENGOLIDO!', 0);
      return;
    }

    // Exit bonus scales with how long and how deep the ride was.
    const durScale = clamp(0.5 + dur * 0.35, 0.5, 1.8);
    const deepScale = 0.7 + 0.6 * deep;
    const points = Math.round(banked + num(T.tubeExitBonus, 4500) * durScale * deepScale);

    const deepRide = deep >= TUNE.tubeDeepBanner && dur >= TUNE.tubeDeepMinTime;
    const name = deepRide ? 'TUBO PROFUNDO!' : 'TUBO';

    this._emit('tube:exit', { duration: dur, points, deep, clean: true });
    this._award('tubo', points, { rotation: 0, clean: true, name });
  }

  // ------------------------------------------------- cutback / rasgada (snap) ---

  _stepTurns(dt, p, tr, t, face, speed) {
    const T = this.T;
    const turn = this._turn;
    const rate = this._turnRateS;
    const mag = Math.abs(rate);
    const sign = rate >= 0 ? 1 : -1;

    if (!turn.active) {
      if (mag >= TUNE.turnMinRate && p.onWave !== false) {
        turn.active = true;
        turn.accum = 0;
        turn.dur = 0;
        turn.sign = sign;
        turn.startSpeed = speed;
        turn.idle = 0;
      }
      return;
    }

    // A reversal ends the gesture and immediately starts the opposite one —
    // that is what makes a real cutback (out, then back) readable.
    if (sign !== turn.sign && mag >= TUNE.turnMinRate) {
      turn.accum = 0; turn.dur = 0; turn.sign = sign;
      turn.startSpeed = speed; turn.idle = 0;
      return;
    }

    turn.accum += angDelta(num(p.heading, 0), this._prevHeading);
    turn.dur += dt;
    if (mag < TUNE.turnBreakRate) turn.idle += dt; else turn.idle = 0;

    const swept = Math.abs(turn.accum);

    // --- RASGADA / snap: short, violent, right under the lip -----------------
    if (
      this._snapCd <= 0 &&
      swept >= TUNE.snapAngle &&
      turn.dur <= TUNE.snapMaxTime &&
      face.d <= num(T.snapD, 4.5) &&
      face.faceT <= 0.4 &&
      speed >= num(T.cutbackMinSpeed, 9) * 0.8
    ) {
      const pts = num(T.snapPoints, 1100) * clamp(0.85 + swept / TAU, 0.85, 1.6);
      this._award('rasgada', pts, { rotation: turn.accum, clean: true, name: 'RASGADA' });
      this._snapCd = TUNE.snapCooldown;
      this._lastTurnAwardT = t;
      turn.active = false; turn.accum = 0; turn.dur = 0;
      return;
    }

    // --- CUTBACK: a deliberate >=120° reversal that keeps its speed ----------
    if (
      this._cutbackCd <= 0 &&
      swept >= num(T.cutbackAngle, 2.09) &&
      speed >= num(T.cutbackMinSpeed, 9) &&
      speed >= turn.startSpeed * TUNE.cutbackKeepSpeed &&
      face.d > num(T.snapD, 4.5) * 0.8
    ) {
      const over = clamp(swept / Math.max(0.1, num(T.cutbackAngle, 2.09)) - 1, 0, 1.2);
      const pts = num(T.cutbackPoints, 1400) * (1 + 0.28 * over);
      this._award('cutback', pts, { rotation: turn.accum, clean: true, name: 'CUTBACK' });
      this._cutbackCd = TUNE.cutbackCooldown;
      this._lastTurnAwardT = t;
      turn.active = false; turn.accum = 0; turn.dur = 0;
      return;
    }

    if (turn.idle >= TUNE.turnBreakTime || turn.dur >= TUNE.turnMaxTime) {
      turn.active = false; turn.accum = 0; turn.dur = 0;
    }
  }

  // ---------------------------------------------------------------- floater ---

  _stepFloater(dt, p, tr, t, face, speed) {
    const T = this.T;
    const fl = this._floater;

    const brk = clamp(num(this._bore('breakIntensity', 0, p.x, t), 0), 0, 1);
    const waterY = this._waterY(p, t);
    const onTop = num(p.y, 0) >= waterY - TUNE.floaterSink;

    const riding =
      p.onWave !== false && !p.wipeout && !p.airborne && !this._tube.inside &&
      face.d <= TUNE.floaterMaxD && face.d >= TUNE.floaterMinD &&
      brk >= TUNE.floaterBreak && onTop && speed >= TUNE.floaterMinSpeed;

    if (riding) {
      if (!fl.on) {
        fl.on = true;
        fl.dur = 0;
        fl.announced = false;
      }
      fl.dur += dt;
      if (!fl.announced && fl.dur >= num(T.floaterMinTime, 0.4)) {
        fl.announced = true;
        this._emit('trick:start', { name: 'floater' });
        this._banner('FLOATER', 0);
      }
      return;
    }

    this._endFloater(t, p.onWave !== false && !p.wipeout);
  }

  _endFloater(t, landedOk) {
    const T = this.T;
    const fl = this._floater;
    if (!fl.on) return;
    const dur = fl.dur;
    fl.on = false;
    fl.dur = 0;

    const minT = num(T.floaterMinTime, 0.4);
    if (dur < minT) return;                    // too short to be a manobra
    if (fl.cd > 0) return;                     // just awarded one

    if (!landedOk) { this._fail('floater', 'queda', 'FLOATER'); return; }

    const pts = num(T.floaterPoints, 1600) * clamp(dur / minT, 1, 2.6);
    this._award('floater', pts, { rotation: 0, clean: true, name: 'FLOATER' });
    fl.cd = TUNE.floaterCooldown;
  }

  // ------------------------------------------------------- tail slide (drift) ---

  _stepSlide(dt, p, tr, t, speed) {
    const T = this.T;
    const sl = this._slide;

    // Slip angle: where the board points vs. where it is actually going.
    let slip = 0;
    const vx = num(p.vx, 0), vz = num(p.vz, 0);
    if (speed > 1.5 && (vx * vx + vz * vz) > 0.5) {
      slip = Math.abs(angDelta(Math.atan2(vx, vz), num(p.heading, 0)));
    }
    const slipHint = clamp(num(p.spraySlip, 0), 0, 1);
    const sliding =
      !p.wipeout && !p.airborne && p.onWave !== false && !this._tube.inside &&
      speed >= TUNE.slideMinSpeed &&
      (slip >= num(T.slideAngle, 0.42) || slipHint >= 0.72);

    if (sliding) {
      if (!sl.on) { sl.on = true; sl.dur = 0; }
      sl.dur += dt;
      return;
    }

    if (!sl.on) return;
    const dur = sl.dur;
    sl.on = false;
    sl.dur = 0;
    if (dur < TUNE.slideMinTime) return;
    if (sl.cd > 0) return;
    // A snap/cutback already paid for this gesture — don't double dip.
    if (t - this._lastTurnAwardT < TUNE.slideAfterTurn) return;
    if (p.wipeout) { this._fail('derrapada', 'queda', 'DERRAPADA'); return; }

    const pts = num(T.slidePoints, 700) * clamp(dur / TUNE.slideMinTime, 1, 2.4);
    this._award('derrapada', pts, { rotation: 0, clean: true, name: 'DERRAPADA' });
    sl.cd = TUNE.slideCooldown;
  }
}

export default TrickSystem;
