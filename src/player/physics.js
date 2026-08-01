// POROROCA RUSH — src/player/physics.js
// The surf solver. Owns every field of `state.player`.
//
// Coordinate contract (docs/ARCHITECTURE.md §1):
//   +X lateral · +Y up · +Z = the direction the bore travels.
//   d = z - crest(x,t) ;  d > 0 = unbroken face ahead of the lip,
//                         d < 0 = broken whitewater behind it.
//   heading ψ: 0 = +Z, +ψ rotates toward +X  →  ψ = atan2(vx, vz).
//
// Model (§3.2), in the order it is integrated each substep:
//   1. face gravity along `downhill`      — dropping gains, climbing costs
//   2. pump                                — throttle in phase with the up-stroke
//   3. drag, measured RELATIVE TO THE WATER — this is what `flowCarry` buys you
//   4. rail carve                          — velocity chases heading, slip scrubs
//
// Nothing about "trimming is fast" is hard-coded. It falls out of the geometry:
// to hold station on the face you need vz ≈ boreSpeed, so at 17 m/s the only
// heading that holds is ψ ≈ ±60° — a line almost along the crest. Point straight
// down the face and you gain fast but run off the front; point at the lip and
// gravity eats you; point purely sideways and the bore rolls over you.

import { CONFIG } from '../config.js';
import { fbm2 } from '../core/rng.js';

// ---------------------------------------------------------------- constants --
// Model-shape numbers. Anything a designer would want to tune lives in config.js.
const SCRUB_BASE = 0.16;    // scrub factor while the rail is holding
const SCRUB_SLIP = 0.44;    // extra scrub once the rail lets go
const SLIP_REF = 0.52;      // rad of slip angle that reads as "full spray"
// Propulsion. In steady trim gravity does no net work (constant height on a
// steady wave form), so the pump is the engine — exactly what CONFIG.pumpGain is
// for. Holding the throttle gets you PUMP_IDLE of it; catching the bottom of the
// arc inside `pumpWindow` peaks above the sustained figure, which is what makes
// rhythm worth more than a held button and much more than mashing.
const PUMP_IDLE = 0.72;     // fraction of pumpGain from simply holding throttle
const PUMP_PEAK = 1.35;     // fraction at the top of a perfectly timed pump
const PUMP_REF = 3.6;       // m/s of up-face travel that counts as a full pump
const PUMP_PERIOD = 1.15;   // fallback pump cycle length, seconds
const TRIM_ASSIST = 1.3;    // rad/s the face weathercocks the board back into trim
const SOUP_CARRY = 0.96;    // whitewater travels with the front — it carries you too
const SOUP_DEPTH = 4.0;     // metres behind the crest to be fully in the soup
const COLLIDE_R = 1.15;     // board + rider collision radius, metres
const HIT_COOLDOWN = 0.35;  // seconds between obstacle hits
const MAX_SUBSTEPS = 12;
const MAX_DRAG = 70;        // m/s² hard ceiling so nothing can explode
const JUMP_GRACE = 0.10;    // seconds tricks.js gets to claim a jump before we hop
const RECOVER_GRACE = 0.4;  // seconds race.js gets to run the recovery before we do
const STALL_TIME = 0.6;     // seconds stalled under the lip before it pitches you
const LOSE_GRACE = 0.80;    // seconds outside the face before the wave is really gone
const LAND_BEHIND = -3.5;   // land further back than this and you go over the falls
// Yaw authority. To hold station you need vz = boreSpeed, i.e. cos psi = 8.6/speed
// — about 55 deg at cruise. Anything past ~80 deg has vz near zero and the bore
// simply rolls over you, so that is where the rail stops biting. (These used to be
// 2.00/2.70 rad = 115/155 deg, which let the stick spin the board right round to
// face back down-river; from there d collapses at ~18 m/s and nothing recovers it.)
const YAW_LIMIT_A = 0.90;   // rad — turning back into the wave starts to bind here
const YAW_LIMIT_B = 1.40;   // rad — and is impossible here
// Landing yaw: at speed the rail bites the direction of travel, so the board comes
// down pointing (roughly) where it is going. Without this an air spin lands the
// surfer facing back down-river and the wave is gone before trim can unwind it.
const LAND_YAW_KEEP = 0.45; // rad of yaw error a landing may keep
const TRIM_HOLD_F = 0.45;   // x faceLen: below this d the weathercock aims down-face

const NUM_FIELDS = [
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'heading', 'pitch', 'roll', 'speed', 'lean',
  'crouch', 'd', 'faceT', 'slope', 'surfaceY', 'airTime', 'tubeTime', 'deepTube',
  'pumpPhase', 'spraySlip', 'gForce', 'wipeoutTimer',
];

// ------------------------------------------------------------------ helpers --
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const expApproach = (rate, h) => 1 - Math.exp(-Math.max(0, rate) * h);

function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

// A Vector2/Vector3 stand-in so bore.normal()/bore.flow() can `out.set(...)`
// even when three.js is not available (headless numeric tests).
function makeVec(THREE, three) {
  if (THREE) return three ? new THREE.Vector3() : new THREE.Vector2();
  const o = three
    ? { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } }
    : { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; return this; } };
  return o;
}

// ============================================================== SurfPhysics ==
export class SurfPhysics {
  /**
   * Accepts the ctx form used by main.js — `new SurfPhysics(ctx)` — and the
   * legacy positional form from the contract — `new SurfPhysics(state, bore, cfg)`.
   */
  constructor(a, b, c) {
    let ctx;
    if (a && a.state) ctx = a;
    else ctx = { state: a, bore: b, config: c && c.physics ? c : { physics: c || CONFIG.physics, wave: CONFIG.wave, world: CONFIG.world } };

    this.ctx = ctx || {};
    this.state = this.ctx.state;
    this.bore = this.ctx.bore || null;
    this.bus = this.ctx.bus || null;
    const cfgRoot = this.ctx.config || CONFIG;
    this.cfg = { ...CONFIG.physics, ...(cfgRoot.physics || {}) };
    this.wcfg = { ...CONFIG.wave, ...(cfgRoot.wave || {}) };
    this.world = { ...CONFIG.world, ...(cfgRoot.world || {}) };

    const THREE = this.ctx.THREE || null;
    this._nrm = makeVec(THREE, true);
    this._flow = makeVec(THREE, false);

    // Reusable sample record — no allocation on the hot path.
    this._s = {
      d: 0, faceT: 0, slope: 0, surfaceY: 0,
      dhx: 0, dhz: 1, nx: 0, ny: 1, nz: 0,
      flowx: 0, flowz: 0, barrel: 0, breakI: 0,
    };
    this._in = { steer: 0, throttle: 0, brake: 0, crouch: 0, spin: 0, jumpPressed: false };

    // Reusable `out` records for bore.faceParam()/bore.tubePocket() (see the
    // signatures in wave/bore.js §3.1). Without them each substep allocated a
    // fresh literal plus a THREE.Vector2 — 240 short-lived objects a second on
    // the hottest path in the game. Both results are consumed inside the call
    // that produced them, so a single instance each is safe.
    this._fp = { d: 0, faceT: 0, slope: 0, downhill: { x: 0, y: 0 }, height: 0, amp: 0, barrel: 0, crestZ: 0 };
    this._tp = { inner: 0, outer: 0, roof: 0, strength: 0, amp: 0 };

    this._acc = 0;
    this._prevD = null;
    this._dRate = 0;
    this._climbDir = -1;
    this._pumpT = 0;
    this._period = PUMP_PERIOD;
    this._noseT = 0;
    this._stallT = 0;
    this._lostT = 0;
    this._hitCool = 0;
    this._lastSide = 1;
    this._landPending = false;
    this._jumpQueued = 0;
    this._pumpDrive = 0;
    this._resets = 0;
    this._panics = 0;

    if (this.state && this.state.player) this.reset({ keepScore: true });
  }

  // ------------------------------------------------------------------ step --
  /** Integrate `dt` seconds in fixed `CONFIG.physics.fixedStep` substeps. */
  step(dt) {
    const st = this.state;
    if (!st || !st.player) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    const h = this.cfg.fixedStep > 0 ? this.cfg.fixedStep : 1 / 120;
    this._acc += Math.min(dt, 0.25);

    let n = 0;
    while (this._acc >= h - 1e-9 && n < MAX_SUBSTEPS) {
      this._sub(h);
      this._acc -= h;
      n++;
    }
    if (n >= MAX_SUBSTEPS) this._acc = 0; // never let the accumulator run away
  }

  // -------------------------------------------------------------- substep ---
  _sub(h) {
    const st = this.state;
    const p = st.player;
    const cfg = this.cfg;
    const t = num(st.time, 0);

    this._readInput();
    const s = this._sample(p.x, p.z, t);

    // Face-relative bookkeeping (written every step, in every mode).
    p.d = s.d;
    p.faceT = s.faceT;
    p.slope = s.slope;
    p.surfaceY = s.surfaceY;

    // Rate of change of d, smoothed — the pump and the pearl both read it.
    const rawRate = this._prevD === null ? 0 : (s.d - this._prevD) / h;
    this._prevD = s.d;
    this._dRate += (clamp(rawRate, -80, 80) - this._dRate) * expApproach(12, h);
    p.dRate = this._dRate;

    // Queued jump (see _readInput): tricks.js had its chance to launch with its
    // own power — if it did, we are already airborne and the queue is dropped.
    if (this._jumpQueued > 0) {
      if (p.airborne || p.wipeout) this._jumpQueued = 0;
      else {
        this._jumpQueued -= h;
        if (this._jumpQueued <= 0) { this._jumpQueued = 0; this.launch(this._jumpPower()); }
      }
    }

    // Crouch: player tuck, forced in the barrel, softened in the air.
    const crouchTarget = Math.max(
      this._in.crouch,
      p.inTube ? 0.85 : 0,
      p.airborne && this._in.grab ? 0.6 : 0,
    );
    p.crouch += (crouchTarget - p.crouch) * expApproach(8.5, h);
    p.crouch = clamp(p.crouch, 0, 1);

    this._pump(h, cfg);

    if (p.wipeout) this._tumble(h, s);
    else if (p.airborne) this._air(h, s);
    else this._ride(h, s);

    if (!p.wipeout) {
      this._channel(h, t);
      this._collide(h);
      this._tube(t);
      this._lossConditions(h, s);
    }

    this._derived(h, s);
    this._sanitize();
  }

  // ---------------------------------------------------------------- input ---
  _readInput() {
    const i = this.state.input || {};
    const o = this._in;
    o.steer = clamp(num(i.steer, 0), -1, 1);
    o.throttle = clamp(num(i.throttle, 0), 0, 1);
    o.brake = clamp(num(i.brake, 0), 0, 1);
    o.crouch = i.crouch ? 1 : 0;
    o.grab = !!i.grab;
    o.spin = clamp(num(i.spin, 0), -1, 1);
    o.jumpPressed = !!i.jumpPressed;

    // Physics owns the hop so the game is playable even if tricks.js is silent —
    // but tricks.js steps AFTER us (main.js' simSystems) and calls launch() with
    // a power proportional to how fast the surfer is climbing the face (§3.3).
    // Launching right here would always win the race and throw that away, so the
    // press is only QUEUED: tricks.js gets first refusal, and the fallback in
    // _sub() fires a proportional hop only if nothing claimed it.
    const p = this.state.player;
    if (o.jumpPressed && !p.airborne && !p.wipeout) this._jumpQueued = JUMP_GRACE;
  }

  // ----------------------------------------------------------- wave sample --
  /** Read the wave field under (x,z). Every bore call is guarded + has a fallback. */
  _sample(x, z, t) {
    const s = this._s;
    const b = this.bore;
    const w = this.wcfg;
    const faceLen = Math.max(1, w.faceLen);

    // --- face parameters ---------------------------------------------------
    let fp = null;
    if (b && typeof b.faceParam === 'function') {
      try { fp = b.faceParam(x, z, t, this._fp); } catch (e) { fp = null; }
    }
    if (fp && Number.isFinite(fp.d)) {
      s.d = clamp(fp.d, -4000, 4000);
      s.faceT = clamp(num(fp.faceT, s.d / faceLen), 0, 1);
      s.slope = clamp(num(fp.slope, 0), -1.4, 1.4);
      const dh = fp.downhill;
      let ax = 0, az = 1;
      if (dh) {
        ax = num(dh.x, 0);
        az = Number.isFinite(dh.y) ? dh.y : num(dh.z, 1);
      }
      const L = Math.hypot(ax, az);
      if (L > 1e-5) { s.dhx = ax / L; s.dhz = az / L; } else { s.dhx = 0; s.dhz = 1; }
    } else {
      let cz = NaN;
      if (b && typeof b.crest === 'function') { try { cz = b.crest(x, t); } catch (e) { cz = NaN; } }
      if (!Number.isFinite(cz)) cz = num(this.state.bore && this.state.bore.z, 0);
      s.d = clamp(z - cz, -4000, 4000);
      s.faceT = clamp(s.d / faceLen, 0, 1);
      s.slope = this._fallbackSlope(s.faceT);
      s.dhx = 0; s.dhz = 1;
    }

    // --- surface height ----------------------------------------------------
    let hy = NaN;
    if (b && typeof b.height === 'function') { try { hy = b.height(x, z, t); } catch (e) { hy = NaN; } }
    s.surfaceY = Number.isFinite(hy) ? clamp(hy, -60, 60) : this._fallbackHeight(s.d);

    // --- normal ------------------------------------------------------------
    s.nx = 0; s.ny = 1; s.nz = 0;
    if (b && typeof b.normal === 'function') {
      try {
        const n = b.normal(x, z, t, this._nrm) || this._nrm;
        const nx = num(n.x, 0), ny = num(n.y, 1), nz = num(n.z, 0);
        const L = Math.hypot(nx, ny, nz);
        if (L > 1e-5) { s.nx = nx / L; s.ny = ny / L; s.nz = nz / L; }
      } catch (e) { /* keep the flat fallback */ }
    }

    // --- surface flow ------------------------------------------------------
    let fx = NaN, fz = NaN;
    if (b && typeof b.flow === 'function') {
      try {
        const f = b.flow(x, z, t, this._flow) || this._flow;
        fx = num(f.x, NaN);
        fz = Number.isFinite(f.y) ? f.y : num(f.z, NaN);
      } catch (e) { fx = NaN; fz = NaN; }
    }
    if (!Number.isFinite(fx) || !Number.isFinite(fz)) {
      // Bore water is being shoved upriver; strongest in the pocket, gone on the flat.
      const mag = s.d < 0 ? w.boreSpeed : w.boreSpeed * Math.pow(1 - s.faceT, 1.4);
      fx = 0; fz = mag;
    }
    const fl = Math.hypot(fx, fz);
    if (fl > 18) { fx = (fx / fl) * 18; fz = (fz / fl) * 18; } // sanity clamp
    s.flowx = fx; s.flowz = fz;

    // --- lip state ---------------------------------------------------------
    s.barrel = 0; s.breakI = 0;
    if (b && typeof b.barrel === 'function') { try { s.barrel = clamp(num(b.barrel(x, t), 0), 0, 1); } catch (e) { s.barrel = 0; } }
    if (b && typeof b.breakIntensity === 'function') { try { s.breakI = clamp(num(b.breakIntensity(x, t), 0), 0, 1); } catch (e) { s.breakI = 0; } }

    return s;
  }

  _fallbackSlope(faceT) {
    const w = this.wcfg;
    const k = Math.max(1e-3, 1 - clamp(faceT, 0, 1));
    const dy = w.amplitude * w.faceSteepness * Math.pow(k, Math.max(0, w.faceSteepness - 1));
    return Math.atan(dy / Math.max(1, w.faceLen));
  }

  _fallbackHeight(d) {
    const w = this.wcfg;
    if (d >= 0) {
      const ft = clamp(d / Math.max(1, w.faceLen), 0, 1);
      return w.amplitude * Math.pow(1 - ft, w.faceSteepness);
    }
    return w.amplitude * (1 + 0.12 * clamp(-d / Math.max(1, w.whitewaterDepth), 0, 1));
  }

  _height(x, z, t) {
    const b = this.bore;
    if (b && typeof b.height === 'function') {
      try {
        const v = b.height(x, z, t);
        if (Number.isFinite(v)) return clamp(v, -60, 60);
      } catch (e) { /* fall through */ }
    }
    let cz = NaN;
    if (b && typeof b.crest === 'function') { try { cz = b.crest(x, t); } catch (e) { cz = NaN; } }
    if (!Number.isFinite(cz)) cz = num(this.state.bore && this.state.bore.z, 0);
    return this._fallbackHeight(z - cz);
  }

  // ----------------------------------------------------------------- pump ---
  // The pump cycle is driven by the surfer's own up/down travel on the face.
  // `climb = -ḋ` is the up-face rate; a down→up flip is the bottom of the arc
  // and opens a `pumpWindow`-second window where throttle pays full `pumpGain`.
  // Outside the window you only get `PUMP_IDLE` — so rhythm beats mashing.
  _pump(h, cfg) {
    const p = this.state.player;
    const climb = -this._dRate;
    const dead = 0.7;

    let dir = this._climbDir;
    if (climb > dead) dir = 1;
    else if (climb < -dead) dir = -1;

    if (dir === 1 && this._climbDir === -1) {
      const measured = clamp(this._pumpT, 0.4, 2.5);
      this._period += (measured - this._period) * 0.5;
      this._pumpT = 0;
    }
    this._climbDir = dir;

    this._pumpT += h;
    const per = clamp(this._period, 0.4, 2.5);
    if (this._pumpT > per * 1.7) this._pumpT = 0; // free-run when not weaving
    p.pumpPhase = clamp(this._pumpT / per, 0, 1);

    const windowOpen = this._pumpT < Math.max(0.05, cfg.pumpWindow);
    const quality = windowOpen ? clamp(climb / PUMP_REF, 0, 1) : 0;
    const drive = this._in.throttle * (PUMP_IDLE + (PUMP_PEAK - PUMP_IDLE) * quality);
    this._pumpDrive = p.airborne || p.wipeout ? 0 : drive;
    p.pumpBoost = this._pumpDrive;
    p.pumpWindow = windowOpen;
  }

  // ------------------------------------------------------------ riding ------
  _ride(h, s) {
    const p = this.state.player;
    const cfg = this.cfg;
    const w = this.wcfg;
    const inp = this._in;
    const t = num(this.state.time, 0);
    const speed0 = Math.max(0, num(p.speed, 0));

    // How much rideable pocket is under the board: 1 just ahead of the lip,
    // 0 out on the flat and 0 once you have dropped into the soup.
    const soup = clamp(-s.d / SOUP_DEPTH, 0, 1);
    const pocketQ = clamp((1 - smoothstep(0.30, 1.0, s.faceT)) * (1 - soup), 0, 1);
    p.pocket = pocketQ;

    // --- rail set: lean lags the stick, heading follows the rail -----------
    const spdT = clamp(speed0 / Math.max(1e-3, cfg.cruiseSpeed), 0, 1);
    const turnRate = cfg.turnRate + (cfg.turnRateLowSpeed - cfg.turnRate) * (1 - spdT);
    p.lean += (clamp(inp.steer, -1, 1) - p.lean) * expApproach(cfg.leanRate, h);
    p.lean = clamp(p.lean, -1, 1);
    let omega = turnRate * p.lean * (1 + 0.35 * inp.brake);
    // You cannot keep rotating back into the wave: past ~80° off the fall line
    // the rail is driving into rising water and the board simply will not come
    // round. This bounds the ride to the face instead of letting it spin.
    const yawA = Math.abs(wrapPi(p.heading));
    if ((omega > 0) === (p.heading > 0) && yawA > YAW_LIMIT_A) {
      omega *= 1 - smoothstep(YAW_LIMIT_A, YAW_LIMIT_B, yawA);
    }
    p.heading = wrapPi(p.heading + omega * h);

    // Weathercock. Water running under a planing hull pushes the tail into line
    // with the face, so a board you stop steering settles onto a line it can hold.
    // The target is NOT the break-even heading everywhere: cos ψ = boreSpeed/speed
    // only holds station, so parking there can never win back ground once you have
    // slipped toward the lip. It therefore rolls off toward straight down-river as
    // d → 0, which is what makes the pocket a stable attractor instead of a knife
    // edge, and what lets a dip behind the crest be a scare rather than a death.
    // An active rail still overrides it, so it never takes a line away from you.
    const side = p.heading >= 0 ? 1 : -1;
    const psiHold = Math.acos(clamp(w.boreSpeed / Math.max(speed0, w.boreSpeed + 0.6), -1, 1));
    const psiTrim = side * psiHold * clamp(s.d / (TRIM_HOLD_F * Math.max(1, w.faceLen)), 0, 1);
    // Stays alive all the way back to the loss line: the soup still shoves the tail
    // around, and without it the whitewater is a one-way trip.
    const waveUnder = Math.max(pocketQ, clamp(1 + s.d / Math.max(1e-3, cfg.loseBehind), 0, 1));
    const assist = TRIM_ASSIST * 1.8 * waveUnder * (1 - 0.6 * Math.abs(p.lean));
    p.heading = wrapPi(p.heading + wrapPi(psiTrim - p.heading) * clamp(assist * h, 0, 0.4));
    p.trimHeading = psiTrim;

    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    let vx = num(p.vx, 0), vz = num(p.vz, 0);

    // --- 1. face gravity ---------------------------------------------------
    // Fades out behind the crest, where there is no clean face left to ride.
    const onFace = s.d > -1.5 ? 1 : clamp(1 + s.d / 6, 0, 1);
    const aG = cfg.gravity * Math.sin(s.slope) * cfg.faceGravityScale * onFace;
    vx += aG * s.dhx * h;
    vz += aG * s.dhz * h;

    // --- 2. pump -----------------------------------------------------------
    // The pump only works where there is a face to push against, so leaving the
    // pocket costs you the engine as well as the free ride.
    const topOff = clamp(1 - 0.55 * Math.pow(speed0 / Math.max(1, cfg.maxSpeed), 4), 0, 1);
    const aPump = cfg.pumpGain * this._pumpDrive * topOff * (0.35 + 0.65 * pocketQ);
    vx += aPump * fx * h;
    vz += aPump * fz * h;

    // --- 3. drag, relative to the moving water -----------------------------
    // This is where `flowCarry` earns its keep: the pocket drags you along, so
    // holding the pocket keeps you fast at low board effort. Flat water does not.
    // The whitewater carries you harder still — you travel with the front, you
    // just cannot surf it, which is what makes a wipeout recoverable.
    const carry = cfg.flowCarry + (SOUP_CARRY - cfg.flowCarry) * soup;
    // Floor the along-river carry at the bore's own speed scaled by how much
    // wave is under you. Both the pocket and the foam travel with the front by
    // definition, so this holds even if bore.flow() reports a weak field.
    const minZ = w.boreSpeed * Math.max(cfg.flowCarry * pocketQ, SOUP_CARRY * soup);
    const wx = s.flowx * carry;
    const wz = Math.max(s.flowz * carry, minZ);
    const rx = vx - wx, rz = vz - wz;
    const rel = Math.hypot(rx, rz);
    if (rel > 1e-5) {
      let aDrag = cfg.dragQuad * rel * rel + cfg.dragLin * rel;
      // Ploughing: the flat ahead and the soup behind both cost more than the pocket.
      aDrag *= 1 + 0.55 * smoothstep(0.72, 1.0, s.faceT) + 2.2 * soup;
      if (speed0 > cfg.maxSpeed) aDrag += (speed0 - cfg.maxSpeed) * 8; // soft ceiling
      aDrag = Math.min(aDrag, MAX_DRAG, (rel / h) * 0.85);             // never reverse
      vx -= aDrag * (rx / rel) * h;
      vz -= aDrag * (rz / rel) * h;
    }

    // --- brake -------------------------------------------------------------
    if (inp.brake > 0) {
      const sp = Math.hypot(vx, vz);
      if (sp > 1e-5) {
        const dv = Math.min(cfg.brakeDecel * inp.brake * h, sp * 0.9);
        const k = (sp - dv) / sp;
        vx *= k; vz *= k;
      }
    }

    // --- 4. rail carve: the velocity vector chases the heading -------------
    const sp0 = Math.hypot(vx, vz);
    const dirAng = Math.atan2(vx, vz);
    const err = wrapPi(p.heading - dirAng);
    const gripRate = Math.max(0.5, cfg.grip
      * (0.78 + 0.30 * p.crouch)
      * (1 - 0.28 * clamp(speed0 / Math.max(1, cfg.maxSpeed), 0, 1))
      * (1 - 0.18 * Math.abs(p.lean)));
    const applied = err * expApproach(gripRate, h);
    const nd = dirAng + applied;
    vx = Math.sin(nd) * sp0;
    vz = Math.cos(nd) * sp0;

    // Redirecting momentum costs speed. A rail that holds costs little; one that
    // is sliding costs a lot — that is the difference between trim and a carve.
    const redirect = Math.abs(applied) / h;
    const slipN = clamp(Math.abs(err) / SLIP_REF, 0, 1);
    const aScrub = cfg.turnScrub * redirect * sp0 * (SCRUB_BASE + SCRUB_SLIP * slipN);
    if (sp0 > 1e-5) {
      const dv = Math.min(aScrub * h, sp0 * 0.4);
      const k = (sp0 - dv) / sp0;
      vx *= k; vz *= k;
    }

    // --- integrate ---------------------------------------------------------
    let sp = Math.hypot(vx, vz);
    const hardCap = cfg.maxSpeed * 1.2;
    if (sp > hardCap) { const k = hardCap / sp; vx *= k; vz *= k; sp = hardCap; }

    p.vx = vx; p.vz = vz; p.speed = sp;
    p.x += vx * h;
    p.z += vz * h;

    const newY = this._height(p.x, p.z, t);
    p.vy = clamp((newY - num(p.y, newY)) / h, -30, 30);
    p.y = newY;
    p.surfaceY = newY;

    p.airTime = 0;
    p.slipAngle = err;
    p._redirect = redirect;
    if (Math.abs(fx) > 0.05) this._lastSide = fx > 0 ? 1 : -1;

    // --- pearl (nose dive) -------------------------------------------------
    // Bombing straight down the face at speed buries the nose. Trimming never
    // gets close to this, so a pearl always reads as the player's own choice.
    const downAlign = fx * s.dhx + fz * s.dhz;
    const pearling = s.faceT > 0.62 && downAlign > 0.88
      && sp > cfg.cruiseSpeed * 0.85 && this._dRate > 9;
    this._noseT = pearling ? this._noseT + h : this._noseT * 0.85;
    if (this._noseT > 0.25) { this.wipeout('nose'); return; }

    // --- stalled under a breaking lip -> over the falls ---------------------
    const underLip = s.d < 2.2 && s.d > -cfg.loseBehind && sp < cfg.minWaveSpeed;
    this._stallT = underLip ? this._stallT + h : 0;
    if (this._stallT > STALL_TIME && s.breakI > 0.25) { this.wipeout('overTheFalls'); return; }
  }

  // -------------------------------------------------------------- airborne --
  _air(h, s) {
    const p = this.state.player;
    const cfg = this.cfg;
    const t = num(this.state.time, 0);

    p.airTime += h;

    // Steering + spin authority in the air.
    const yaw = (this._in.steer * cfg.airSteer + this._in.spin * cfg.airSteer * 1.35) * h;
    p.heading = wrapPi(p.heading + yaw);

    // Ballistic, with mild air drag on the horizontal.
    p.vy = clamp(num(p.vy, 0) - cfg.gravity * h, -60, 60);
    const decay = Math.exp(-cfg.airDrag * h);
    p.vx = num(p.vx, 0) * decay;
    p.vz = num(p.vz, 0) * decay;
    p.speed = Math.hypot(p.vx, p.vz);

    p.x += p.vx * h;
    p.z += p.vz * h;
    p.y = num(p.y, s.surfaceY) + p.vy * h;

    // Pitch tracks the flight path — surfer.js and camera.js read it.
    const flight = Math.atan2(p.vy, Math.max(2, p.speed));
    p.pitch += (clamp(flight, -1.2, 1.2) - num(p.pitch, 0)) * expApproach(5.0, h);
    p.roll += (p.lean * 0.6 - num(p.roll, 0)) * expApproach(4.0, h);
    p.lean += (clamp(this._in.steer, -1, 1) - p.lean) * expApproach(cfg.leanRate * 0.6, h);
    p.lean = clamp(p.lean, -1, 1);

    p.inTube = false;
    p.deepTube = 0;

    const surf = this._height(p.x, p.z, t);
    p.surfaceY = surf;
    if (p.y <= surf && p.vy <= 0 && p.airTime > 0.06) {
      p.y = surf;
      this._doLand(s, false);
    } else if (p.airTime > 8) {
      // Never let an air hang forever, whatever a neighbour did to vy.
      p.y = surf;
      this._doLand(s, true);
    }
  }

  /** Resolve a landing. `forced` skips the angle check (tricks.js said it was clean). */
  _doLand(s, forced) {
    const p = this.state.player;
    const cfg = this.cfg;
    const airTime = num(p.airTime, 0);
    const impact = clamp(Math.abs(num(p.vy, 0)) / 14, 0, 1.6);

    p.airborne = false;
    p.vy = 0;
    p.airTime = 0;

    // Landing behind the crest is the classic over-the-falls.
    if (!forced && s.d < LAND_BEHIND) {
      this.wipeout('overTheFalls');
      return;
    }

    // You cannot land sideways. At landing speed the rail bites the direction of
    // travel, so the board squares up to it (a big spin lands switch, not sliding
    // backwards). Without this a 540 puts the surfer down facing back down-river,
    // the carve then drags the whole velocity vector round with it, and the wave is
    // gone long before the weathercock can unwind 180°.
    const travel = Math.atan2(num(p.vx, 0), num(p.vz, 0));
    p.heading = wrapPi(travel + clamp(wrapPi(num(p.heading, 0) - travel), -LAND_YAW_KEEP, LAND_YAW_KEEP));

    // Pitch the board should have to match the water it is landing on.
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const want = -s.slope * (fx * s.dhx + fz * s.dhz);
    const err = Math.abs(wrapPi(num(p.pitch, 0) - want)) + 0.5 * Math.abs(num(p.roll, 0) - p.lean * 0.6);
    const clean = forced || err <= cfg.landAngleTolerance;

    p.landError = err;
    p.landClean = clean;
    p.pitch = want;

    if (!clean) {
      this.wipeout(num(p.pitch, 0) < want ? 'nose' : 'lostWave');
      return;
    }

    // Clean landing: bleed a little speed, kick spray, shake the camera.
    const bleed = clamp(0.08 + 0.16 * impact, 0, 0.4);
    const k = 1 - bleed;
    p.vx *= k; p.vz *= k;
    p.speed = Math.hypot(p.vx, p.vz);
    p.spraySlip = clamp(p.spraySlip + 0.55 * impact, 0, 1);
    p.gForce = clamp(num(p.gForce, 1) + 2.2 * impact, 0, 8);
    this._shake(0.35 + 0.55 * impact);
    this._emit('player:land', { clean: true, error: err, airTime, impact });
  }

  // ---------------------------------------------------------------- tumble --
  _tumble(h, s) {
    const p = this.state.player;
    const cfg = this.cfg;
    const t = num(this.state.time, 0);

    p.wipeoutTimer = num(p.wipeoutTimer, 0) - h;

    // Dragged along by the water, tumbling.
    const k = expApproach(3.0, h);
    p.vx += (s.flowx - num(p.vx, 0)) * k;
    p.vz += (s.flowz - num(p.vz, 0)) * k;
    p.vy = 0;
    p.speed = Math.hypot(p.vx, p.vz);
    p.x += p.vx * h;
    p.z += p.vz * h;

    const surf = this._height(p.x, p.z, t);
    p.y += (surf - num(p.y, surf)) * expApproach(6, h);
    p.surfaceY = surf;

    p.roll = wrapPi(num(p.roll, 0) + 5.5 * h);
    p.pitch = wrapPi(num(p.pitch, 0) + 2.2 * h);
    p.lean *= 1 - k;
    p.spraySlip = clamp(p.spraySlip + (1 - p.spraySlip) * expApproach(6, h), 0, 1);
    p.gForce += (1 - p.gForce) * expApproach(3, h);
    p.onWave = false;
    p.airborne = false;
    p.inTube = false;
    p.deepTube = 0;
    p.tubeTime = 0;

    // Safety net: if race.js never recovers us, recover ourselves. race.js owns
    // the recovery (§3.5) and calls reset() with a placement of its own the
    // instant this timer expires, so hang back — firing on the same frame just
    // means two resets and two `player:reset` events per wipeout.
    if (p.wipeoutTimer <= -RECOVER_GRACE) this.reset({ keepScore: true });
  }

  // ------------------------------------------------------------------ tube --
  _tube(t) {
    const p = this.state.player;
    const s = this._s;
    const b = this.bore;
    const w = this.wcfg;

    let tp = null;
    if (b && typeof b.tubePocket === 'function') {
      try { tp = b.tubePocket(p.x, t, this._tp); } catch (e) { tp = null; }
    }

    let inside = false, deep = 0;
    if (tp && Number.isFinite(tp.inner) && Number.isFinite(tp.outer)
        && s.barrel >= num(w.barrelThreshold, 0.5)) {
      const lo = Math.min(tp.inner, tp.outer);
      const hi = Math.max(tp.inner, tp.outer);
      const span = Math.max(0.5, hi - lo);
      const underRoof = !Number.isFinite(tp.roof) || p.y < tp.roof + 0.5;
      inside = !p.airborne && !p.wipeout && p.d >= lo - 0.5 && p.d <= hi + 0.5 && underRoof;
      if (inside) deep = clamp((hi - p.d) / span, 0, 1); // 1 = right in the throat
    }

    p.inTube = inside;
    p.deepTube = deep;
    if (inside) p.tubeTime = num(p.tubeTime, 0) + this.cfg.fixedStep;
    else p.tubeTime = 0;
  }

  // ------------------------------------------------------- loss conditions --
  _lossConditions(h, s) {
    const p = this.state.player;
    const cfg = this.cfg;
    const faceLen = Math.max(1, this.wcfg.faceLen);

    // Give the player a grace window so a flick past the edge is a scare, not a
    // death — and so the HUD can warn ("you're losing it") before it happens.
    const behind = s.d < -cfg.loseBehind;          // dropped over the back
    const ahead = s.d > faceLen + cfg.loseAhead;   // outran it onto the flat
    if (behind || ahead) this._lostT += h;
    else this._lostT = Math.max(0, this._lostT - h * 2.5);
    p.lostWarn = clamp(this._lostT / LOSE_GRACE, 0, 1);

    if (this._lostT >= LOSE_GRACE) { this.wipeout('lostWave'); return; }

    p.onWave = !p.wipeout && !behind && !ahead;
  }

  // ------------------------------------------------------------- obstacles --
  _collide(h) {
    const p = this.state.player;
    this._hitCool -= h;
    if (this._hitCool > 0) return;

    const obs = this.ctx && this.ctx.obstacles;
    if (!obs || typeof obs.query !== 'function') return;

    let hit = null;
    // The optional 4th argument lets obstacles.js drop anything we are flying
    // clean over; an implementation that ignores it just behaves as before.
    try { hit = obs.query(p.x, p.z, COLLIDE_R, p.airborne ? p.y : undefined); }
    catch (e) { return; }
    if (!hit) return;

    // The shape of `hit` is obstacles.js's business — derive severity defensively.
    let sev = num(hit.severity, NaN);
    if (!Number.isFinite(sev)) {
      const dist = num(hit.dist, num(hit.distance, NaN));
      const rr = num(hit.r, num(hit.radius, COLLIDE_R));
      sev = Number.isFinite(dist)
        ? clamp(1 - dist / Math.max(0.4, rr + COLLIDE_R), 0, 1)
        : 0.6;
    }
    sev = clamp(sev, 0, 1);

    const big = hit.big === true || hit.type === 'boat' || hit.type === 'riverboat' || hit.type === 'piling';
    const fast = p.speed > this.cfg.cruiseSpeed * 0.8;
    const hard = !p.airborne && (sev > 0.72 || (big && sev > 0.4) || (sev > 0.48 && fast));

    this._hitCool = HIT_COOLDOWN;

    if (hard) {
      this.wipeout('log');
      return;
    }

    // Graze: scrub speed, kick the rail loose, shake the camera.
    const loss = clamp(0.10 + 0.26 * sev, 0, 0.45);
    const k = 1 - loss;
    p.vx *= k; p.vz *= k;
    p.speed = Math.hypot(p.vx, p.vz);
    p.spraySlip = clamp(p.spraySlip + 0.5 * sev, 0, 1);
    p.gForce = clamp(num(p.gForce, 1) + 2.5 * sev, 0, 8);
    this._shake(0.4 + 0.9 * sev);
    this._emit('player:graze', { severity: sev, type: hit.type || 'log' });
  }

  // --------------------------------------------------------- channel guard --
  // Nothing in the contract tells physics where the channel centre is, so this is
  // a soft guard around x = 0, where bore.js centres the bore. It has to bite well
  // inside the bank: the wave field tapers from ~0.34 to ~1.12 of the half-width
  // (bore.js SHAPE.bankLo/bankHi), so past ~130 m the crest is barely half height
  // and there is nothing left to surf — a surfer who drifts out there loses the
  // wave over and over. The old guard started at 0.82 (139 m) with a 6 m/s² nudge
  // and walled off at half + meander/2 + 60 = 335 m, twice the channel half-width,
  // which let a one-sided stick park the surfer 190-210 m off centre.
  _channel(h, t) {
    const p = this.state.player;
    const half = Math.max(40, num(this.world.riverWidth, 340) * 0.5);

    let cx = 0;
    const b = this.bore;
    if (b && typeof b.channelCenter === 'function') {
      try { const v = b.channelCenter(p.z, t); if (Number.isFinite(v)) cx = v; } catch (e) { cx = 0; }
    } else if (this.ctx.river && typeof this.ctx.river.centerX === 'function') {
      try { const v = this.ctx.river.centerX(p.z, t); if (Number.isFinite(v)) cx = v; } catch (e) { cx = 0; }
    }

    const off = p.x - cx;
    const soft = half * 0.55;
    const a = Math.abs(off);
    if (a > soft) {
      const sgn = off > 0 ? 1 : -1;
      const k = clamp((a - soft) / Math.max(1, half * 0.4), 0, 1);
      p.vx -= sgn * k * 18.0 * h;
      p.heading = wrapPi(p.heading - sgn * k * 2.0 * h);
      p.speed = Math.hypot(p.vx, p.vz);
    }
    const hard = half * 0.92;
    if (a > hard) {
      p.x = cx + (off > 0 ? hard : -hard);
      p.vx *= -0.2;
      p.speed = Math.hypot(p.vx, p.vz);
    }
  }

  // ------------------------------------------------------------- derived ----
  _derived(h, s) {
    const p = this.state.player;
    const cfg = this.cfg;
    const t = num(this.state.time, 0);

    if (!p.airborne && !p.wipeout) {
      // Board pitch follows the face under it; roll follows the rail.
      const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
      const want = -s.slope * (fx * s.dhx + fz * s.dhz);
      p.pitch += (clamp(want, -1.2, 1.2) - num(p.pitch, 0)) * expApproach(9, h);
      p.roll += (clamp(p.lean * 0.62, -1, 1) - num(p.roll, 0)) * expApproach(7, h);
    }

    // Slip → spray. The foam system reads spraySlip for the rail jet.
    const err = num(p.slipAngle, 0);
    const lat = Math.abs(Math.sin(err)) * p.speed;
    let sprayTarget = clamp(0.62 * clamp(Math.abs(err) / SLIP_REF, 0, 1)
      + 0.38 * clamp(lat / 5.5, 0, 1), 0, 1);
    sprayTarget *= clamp(p.speed / 7, 0, 1);
    if (p.airborne) sprayTarget = 0;
    if (p.wipeout) sprayTarget = 1;
    // A little deterministic chatter so the jet is not sterile — seeded, never Math.random.
    if (!p.wipeout && sprayTarget > 0.02) {
      sprayTarget *= 0.86 + 0.28 * fbm2(t * 2.4, p.x * 0.07, 2, 7717);
    }
    p.spraySlip = clamp(p.spraySlip + (clamp(sprayTarget, 0, 1) - p.spraySlip) * expApproach(14, h), 0, 1);

    // g-force: centripetal against gravity. 1 at rest, ~0 in the air.
    if (p.airborne) {
      p.gForce += (0.12 - p.gForce) * expApproach(5, h);
    } else if (!p.wipeout) {
      const latA = num(p._redirect, 0) * p.speed;
      const target = Math.hypot(latA, cfg.gravity) / cfg.gravity;
      p.gForce += (clamp(target, 0, 8) - num(p.gForce, 1)) * expApproach(7, h);
    }
    p.gForce = clamp(p.gForce, 0, 8);

    // Trim quality (0..1): how close to the heading that actually holds station,
    // weighted by how much pocket is under you. Useful to foam/HUD/camera.
    const bs = Math.max(0.5, this.wcfg.boreSpeed);
    const ideal = Math.acos(clamp(bs / Math.max(p.speed, bs + 0.4), -1, 1));
    const off = Math.abs(Math.abs(wrapPi(p.heading)) - ideal);
    const pocket = 1 - smoothstep(0.35, 0.95, p.faceT);
    p.trim = clamp((1 - off / 1.1), 0, 1) * clamp(pocket, 0, 1);
  }

  /**
   * Power for the physics-owned fallback hop. Proportional to how fast the
   * surfer is actually travelling up the face (§3.2 "Air"), never a flat 1 —
   * mirrors the shape tricks.js uses so both paths feel the same.
   */
  _jumpPower() {
    const p = this.state.player;
    const climb = Math.max(0, -this._dRate);            // m/s of closure on the lip
    const vUp = climb * Math.abs(Math.sin(num(p.slope, 0))) + Math.max(0, num(p.vy, 0));
    const ref = Math.max(4, num(this.cfg.launchSpeedMin, 11) * 0.55);
    return clamp((vUp * 0.85 + num(p.speed, 0) * 0.16) / ref, 0.3, 1.5);
  }

  // ------------------------------------------------------------- public API --
  /** Boost off the lip. `power` 0..2. Called by tricks.js; also self-fired on jump. */
  launch(power = 1) {
    const p = this.state && this.state.player;
    if (!p || p.airborne || p.wipeout) return;
    const cfg = this.cfg;
    const pw = clamp(num(power, 1), 0, 2);
    if (pw <= 0) return;

    const spd = Math.max(0, num(p.speed, 0));
    if (spd < cfg.launchSpeedMin * 0.5) return; // no pop at all down here

    // Full boost from launchSpeedMin up; a weak hop below it.
    const auth = clamp(spd / Math.max(1, cfg.launchSpeedMin), 0, 1);
    // The lip throws you: more pop the closer to d = 0 and the harder it pitches.
    const lip = 1 + 0.45 * clamp(1 - p.faceT / 0.22, 0, 1) * (0.4 + 0.6 * num(this._s.barrel, 0));
    const vy = cfg.launchGain * (0.35 * spd + 2.2) * pw * auth * lip;

    p.vy = Math.max(num(p.vy, 0), clamp(vy, 0, 18));
    p.airborne = true;
    p.airTime = 0;
    p.inTube = false;
    p.deepTube = 0;
    p.tubeTime = 0;
    p.y = num(p.surfaceY, num(p.y, 0)) + 0.02;
    this._emit('player:launch', { power: pw, vy: p.vy, speed: spd });
  }

  /** Force a clean landing (tricks.js calls this when it has judged the air). */
  land() {
    const p = this.state && this.state.player;
    if (!p || !p.airborne) return;
    p.y = num(p.surfaceY, num(p.y, 0));
    this._doLand(this._s, true);
  }

  /** Force a wipeout. reason: 'log' | 'overTheFalls' | 'lostWave' | 'nose'. */
  wipeout(reason = 'lostWave') {
    const p = this.state && this.state.player;
    if (!p || p.wipeout) return;
    p.wipeout = true;
    p.wipeoutReason = typeof reason === 'string' ? reason : 'lostWave';
    p.wipeoutTimer = Math.max(0.2, num(this.cfg.wipeoutTime, 2.4));
    p.onWave = false;
    p.airborne = false;
    p.airTime = 0;
    p.inTube = false;
    p.deepTube = 0;
    p.tubeTime = 0;
    p.spraySlip = 1;
    this._noseT = 0;
    this._stallT = 0;
    this._lostT = 0;
    this._shake(1.2);
    // race.js owns the canonical `player:wipeout` event (§3.5); this is a hint.
    this._emit('physics:wipeout', { reason: p.wipeoutReason });
  }

  /**
   * Put the surfer back in the pocket, trimming.
   * opts: { x, d, speed, heading, side }  — all optional.
   */
  reset(opts = {}) {
    const st = this.state;
    if (!st || !st.player) return;
    const p = st.player;
    const cfg = this.cfg;
    const w = this.wcfg;
    const t = num(st.time, 0);

    const x = Number.isFinite(opts.x) ? opts.x : num(p.x, 0);
    const dT = Number.isFinite(opts.d) ? opts.d : w.faceLen * 0.42;

    let cz = NaN;
    if (this.bore && typeof this.bore.crest === 'function') {
      try { cz = this.bore.crest(x, t); } catch (e) { cz = NaN; }
    }
    if (!Number.isFinite(cz)) cz = num(st.bore && st.bore.z, 0);

    const spd = clamp(num(opts.speed, cfg.cruiseSpeed * 0.8), 0, cfg.maxSpeed);
    const side = Number.isFinite(opts.side) ? (opts.side >= 0 ? 1 : -1) : this._lastSide;

    // The heading that actually holds station: cos ψ = boreSpeed / speed.
    let psi;
    if (Number.isFinite(opts.heading)) psi = wrapPi(opts.heading);
    else psi = side * Math.acos(clamp(w.boreSpeed / Math.max(spd, w.boreSpeed + 0.6), -1, 1));

    p.x = x;
    p.z = cz + dT;
    p.heading = psi;
    p.vx = Math.sin(psi) * spd;
    p.vz = Math.cos(psi) * spd;
    p.vy = 0;
    p.speed = spd;
    p.y = this._height(p.x, p.z, t);
    p.surfaceY = p.y;
    p.d = dT;
    p.faceT = clamp(dT / Math.max(1, w.faceLen), 0, 1);
    p.slope = this._fallbackSlope(p.faceT);

    p.pitch = 0; p.roll = 0; p.lean = 0; p.crouch = 0;
    p.onWave = true;
    p.airborne = false;
    p.airTime = 0;
    p.inTube = false;
    p.tubeTime = 0;
    p.deepTube = 0;
    p.pumpPhase = 0;
    p.spraySlip = 0;
    p.gForce = 1;
    p.wipeout = false;
    p.wipeoutTimer = 0;
    p.wipeoutReason = null;
    p.slipAngle = 0;
    p.dRate = 0;
    p.trim = 1;
    p._redirect = 0;

    this._prevD = null;
    this._dRate = 0;
    this._climbDir = -1;
    this._pumpT = 0;
    this._period = PUMP_PERIOD;
    this._noseT = 0;
    this._stallT = 0;
    this._lostT = 0;
    this._hitCool = 0.5;
    this._jumpQueued = 0;
    this._acc = 0;
    this._resets++;
    this._emit('player:reset', { x: p.x, z: p.z, speed: spd });
  }

  dispose() {
    this.bore = null;
    this.ctx = {};
  }

  // ------------------------------------------------------------- internals --
  _shake(amount) {
    const a = clamp(num(amount, 0), 0, 3);
    const cam = this.state && this.state.camera;
    if (cam && Number.isFinite(cam.shake)) cam.shake = Math.min(3, cam.shake + a);
    this._emit('player:impact', { strength: a });
  }

  _emit(evt, payload) {
    const bus = this.bus;
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit(evt, payload); } catch (e) { /* a listener must never kill the sim */ }
    }
  }

  /** Last line of defence: nothing leaves this module as NaN. */
  _sanitize() {
    const p = this.state.player;
    let bad = false;
    for (let i = 0; i < NUM_FIELDS.length; i++) {
      if (!Number.isFinite(p[NUM_FIELDS[i]])) { bad = true; break; }
    }
    if (bad || Math.abs(p.x) > 1e6 || Math.abs(p.z) > 1e9 || Math.abs(p.y) > 1e4) {
      this._panics++;
      p.x = Number.isFinite(p.x) ? clamp(p.x, -1e5, 1e5) : 0;
      p.y = 0; p.z = Number.isFinite(p.z) ? p.z : num(this.state.bore && this.state.bore.z, 0);
      p.vx = 0; p.vy = 0; p.vz = 0; p.speed = 0;
      p.heading = 0; p.pitch = 0; p.roll = 0; p.lean = 0; p.crouch = 0;
      p.d = 0; p.faceT = 0; p.slope = 0; p.surfaceY = 0;
      p.airTime = 0; p.tubeTime = 0; p.deepTube = 0; p.pumpPhase = 0;
      p.spraySlip = 0; p.gForce = 1; p.wipeoutTimer = 0;
      p.wipeout = false; p.wipeoutReason = null;
      this.reset({ x: 0, keepScore: true });
      return;
    }
    p.heading = wrapPi(p.heading);
    p.pitch = clamp(p.pitch, -Math.PI, Math.PI);
    p.roll = wrapPi(p.roll);
    p.lean = clamp(p.lean, -1, 1);
    p.crouch = clamp(p.crouch, 0, 1);
    p.faceT = clamp(p.faceT, 0, 1);
    p.deepTube = clamp(p.deepTube, 0, 1);
    p.spraySlip = clamp(p.spraySlip, 0, 1);
    p.gForce = clamp(p.gForce, 0, 8);
    p.pumpPhase = clamp(p.pumpPhase, 0, 1);
    p.speed = clamp(p.speed, 0, this.cfg.maxSpeed * 1.25);
    p.airTime = clamp(p.airTime, 0, 30);
    p.tubeTime = clamp(p.tubeTime, 0, 600);
    p.wipeoutTimer = clamp(p.wipeoutTimer, -1, 20);
  }
}

export default SurfPhysics;
