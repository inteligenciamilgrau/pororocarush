// POROROCA RUSH — §3.5 Race: distance, 12 checkpoints, compass bearing,
// and the wipeout → slow-mo → recover loop.
//
// There is no game-over. A wipeout costs the combo and a couple of seconds; the
// bore keeps rolling upriver and the run continues.
//
// Deterministic: no Math.random(), everything integrated by dt.

import { CONFIG, TAU } from '../config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const RAD2DEG = 180 / Math.PI;

// Compass tape labels — the concept art uses the international abbreviations
// ("SE · S · SW"), not the Portuguese ones.
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// +Z (the direction the bore travels) points south on the in-game compass, so
// the tape sits around S exactly like the concept HUD.
const BEARING_AT_PLUS_Z = 180;

// Feel constants for the recovery flow. Overridable from CONFIG.race if it ever
// grows the fields; kept local so config.js does not have to change now.
const DEF_SLOWMO_MIN = 0.35;   // time scale at the instant of the wipeout
const DEF_SLOWMO_TIME = 0.8;   // seconds (sim time) easing back to 1
const SLOWMO_FLOOR = 0.15;     // never stall main.js' accumulator
const BEARING_TAU = 0.30;      // seconds of smoothing on the compass tape
// The channel meander is worth ~41 deg at its steepest; damp it so the tape
// reads S with a slow drift and the player's own carve stays the main signal
// (concept HUD sweeps SE..S..SW).
const BEND_WEIGHT = 0.35;

export class Race {
  /** @param {object} ctx { state, bus, config, physics, bore, ... } */
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.state = ctx.state || {};
    this.bus = ctx.bus || null;

    const cfg = ctx.config || CONFIG;
    this.cfg = cfg.race || CONFIG.race;
    this.phys = cfg.physics || CONFIG.physics;
    this.world = cfg.world || CONFIG.world;
    this.wave = cfg.wave || CONFIG.wave;

    this.total = Math.max(1, Math.floor(Number(this.cfg.checkpoints) || 12));
    this.courseLength = Math.max(1, Number(this.cfg.courseLength) || 9600);
    this.spacing = this.courseLength / this.total;

    this.wipeoutTime = Math.max(0.1, Number(this.phys.wipeoutTime) || 2.4);
    this.recoverTime = Math.max(0.05, Number(this.phys.recoverTime) || 1.1);
    this.slowmoMin = clamp(Number(this.cfg.slowmoMin) || DEF_SLOWMO_MIN, SLOWMO_FLOOR, 1);
    this.slowmoTime = Math.max(0.05, Number(this.cfg.slowmoTime) || DEF_SLOWMO_TIME);

    this.distance = 0;
    this._prevBoreZ = null;
    this._started = false;

    // wipeout / recovery
    this._wipeTimer = 0;
    this._recoverTimer = 0;
    this._slowmoT = Infinity;      // Infinity = no slow-mo running
    this._reason = null;
    this._prevWipeFlag = false;
    this._autoLock = 0;            // blocks flag-based re-triggering after a reset

    // compass
    this._bearing = null;

    this._ensureRace();
    this._offs = [];
    this._bind();
  }

  // ---------------------------------------------------------------- plumbing

  _ensureRace() {
    const st = this.state;
    if (!st.race || typeof st.race !== 'object') st.race = {};
    const r = st.race;
    r.total = this.total;
    if (!Number.isFinite(r.checkpoint)) r.checkpoint = 0;
    if (!Number.isFinite(r.distance)) r.distance = 0;
    if (!Number.isFinite(r.distanceToNext)) r.distanceToNext = this.spacing;
    if (typeof r.finished !== 'boolean') r.finished = false;
    if (!Number.isFinite(r.bearing)) r.bearing = BEARING_AT_PLUS_Z;
    if (typeof r.heading !== 'string') r.heading = 'S';
    // Additive (non-contract) conveniences for the HUD / minimap.
    if (!Number.isFinite(r.progress)) r.progress = 0;
    r.courseLength = this.courseLength;
    r.name = String(this.cfg.name || 'POROROCA');
    r.objective = String(this.cfg.objective || '');
    this.distance = r.distance;
    return r;
  }

  _race() {
    const r = this.state.race;
    return (r && typeof r === 'object') ? r : this._ensureRace();
  }

  _emit(evt, payload) {
    if (this.bus && typeof this.bus.emit === 'function') {
      try { this.bus.emit(evt, payload); } catch (_) { /* a bad listener must not kill the run */ }
    }
  }

  _bind() {
    const bus = this.bus;
    if (!bus || typeof bus.on !== 'function') return;
    try {
      const off = bus.on('player:wipeout', (p) => {
        this.beginWipeout((p && p.reason) || 'wipeout');
      });
      if (typeof off === 'function') this._offs.push(off);
    } catch (_) { /* noop */ }
  }

  // ------------------------------------------------------------ wipeout flow

  /** Enter the wipeout hold. Idempotent while already down. */
  beginWipeout(reason = 'wipeout') {
    const st = this.state;
    if (st.phase === 'wipeout' || st.phase === 'recover') return;
    this._reason = String(reason || 'wipeout');
    st.phase = 'wipeout';
    this._wipeTimer = this.wipeoutTime;
    this._recoverTimer = 0;
    this._slowmoT = 0;
    st.slowmo = this.slowmoMin;
    this._emit('race:wipeout', { reason: this._reason, checkpoint: this._race().checkpoint });
  }

  _beginRecover() {
    const st = this.state;
    st.phase = 'recover';
    this._recoverTimer = this.recoverTime;
    this._autoLock = this.recoverTime + 0.5;

    // Hand the surfer back to the pocket. Unknown keys are safe to ignore.
    const p = st.player || {};
    const halfWidth = (Number(this.world.riverWidth) || 340) * 0.35;
    const faceLen = Number(this.wave.faceLen) || 26;
    const opts = {
      reason: this._reason || 'recover',
      x: clamp(Number(p.x) || 0, -halfWidth, halfWidth),
      d: faceLen * 0.55,
      faceT: 0.55,
      heading: 0.28,
      speed: (Number(this.phys.cruiseSpeed) || 17) * 0.8,
    };
    const phys = this.ctx.physics;
    if (phys && typeof phys.reset === 'function') {
      try { phys.reset(opts); } catch (_) { /* degrade rather than stall the run */ }
    }
    this._emit('race:recover', opts);
  }

  _endRecover() {
    const r = this._race();
    this.state.phase = r.finished ? 'finish' : 'ride';
    this.state.slowmo = 1;
    this._slowmoT = Infinity;
    this._reason = null;
  }

  _stepWipeout(dt) {
    const st = this.state;

    // Slow-mo dip, easing back to normal time (eased in sim seconds).
    if (this._slowmoT < this.slowmoTime) {
      this._slowmoT += dt;
      const k = clamp(this._slowmoT / this.slowmoTime, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);              // easeOutCubic
      st.slowmo = clamp(this.slowmoMin + (1 - this.slowmoMin) * e, SLOWMO_FLOOR, 1);
    } else {
      this._slowmoT = Infinity;
      if (st.slowmo !== 1) st.slowmo = 1;
    }

    if (st.phase === 'wipeout') {
      this._wipeTimer -= dt;
      if (this._wipeTimer <= 0) this._beginRecover();
    } else if (st.phase === 'recover') {
      this._recoverTimer -= dt;
      if (this._recoverTimer <= 0) this._endRecover();
    }
  }

  /**
   * Safety net: if physics raises state.player.wipeout without emitting on the
   * bus, drive the flow anyway (and publish the event the rest of the game
   * expects, so scoring/camera/hud still react).
   */
  _watchWipeoutFlag(dt) {
    const p = this.state.player || {};
    const flag = !!p.wipeout;
    const rose = flag && !this._prevWipeFlag;
    this._prevWipeFlag = flag;
    if (this._autoLock > 0) { this._autoLock -= dt; return; }
    if (!rose) return;
    if (this.state.phase === 'wipeout' || this.state.phase === 'recover') return;
    const reason = p.wipeoutReason || 'wipeout';
    this._emit('player:wipeout', { reason });
    this.beginWipeout(reason);   // in case nothing was listening
  }

  // ---------------------------------------------------------------- distance

  _advance(dt) {
    const b = this.state.bore || {};
    const fallback = Math.max(0, Number(b.speed) || Number(this.wave.boreSpeed) || 8.6) * dt;
    const bz = Number(b.z);
    if (!Number.isFinite(bz)) return fallback;
    if (this._prevBoreZ === null) { this._prevBoreZ = bz; return 0; }
    let adv = bz - this._prevBoreZ;
    this._prevBoreZ = bz;
    // Guard against a neighbour rebasing or teleporting the scrolling frame.
    if (!Number.isFinite(adv) || adv < 0 || adv > 500) return fallback;
    return adv;
  }

  _checkpoints(r) {
    if (r.finished) { r.distanceToNext = 0; return; }
    let guard = 0;
    while (r.checkpoint < this.total && this.distance >= (r.checkpoint + 1) * this.spacing && guard++ < 64) {
      r.checkpoint++;
      this._emit('race:checkpoint', {
        index: r.checkpoint,
        total: this.total,
        distance: this.distance,
        time: Number(this.state.time) || 0,
      });
    }
    if (r.checkpoint >= this.total || this.distance >= this.courseLength) {
      r.checkpoint = this.total;
      r.finished = true;
      r.distanceToNext = 0;
      if (this.state.phase !== 'wipeout' && this.state.phase !== 'recover') this.state.phase = 'finish';
      const sc = this.state.score || {};
      this._emit('race:finish', {
        time: Number(this.state.time) || 0,
        distance: this.distance,
        points: Number(sc.points) || 0,
        bestCombo: Number(sc.bestCombo) || 0,
        bestComboPoints: Number(sc.bestComboPoints) || 0,
      });
      return;
    }
    r.distanceToNext = Math.max(0, (r.checkpoint + 1) * this.spacing - this.distance);
  }

  // ----------------------------------------------------------------- compass

  /** Approximate tangent of the meandering channel at world z, in radians. */
  _riverBend(z) {
    const amp = Number(this.world.riverMeander) || 0;
    const len = Math.max(1, Number(this.world.riverMeanderLen) || 1500);
    if (!(amp > 0)) return 0;
    const k = TAU / len;
    return Math.atan(amp * k * Math.cos(k * z));
  }

  _stepCompass(dt, r) {
    const p = this.state.player || {};
    const psi = Number(p.heading);
    const z = Number(p.z);
    const bend = this._riverBend(Number.isFinite(z) ? z : (Number(this.state.bore && this.state.bore.z) || 0));
    const yaw = Number.isFinite(psi) ? psi : 0;

    // +psi rotates toward +X, which is the direction the tape scrolls right.
    let target = BEARING_AT_PLUS_Z + (yaw + bend * BEND_WEIGHT) * RAD2DEG;
    target = ((target % 360) + 360) % 360;

    if (this._bearing === null || !Number.isFinite(this._bearing)) {
      this._bearing = target;
    } else {
      const k = 1 - Math.exp(-Math.max(0, dt) / BEARING_TAU);
      let diff = ((target - this._bearing + 540) % 360) - 180;
      this._bearing = ((this._bearing + diff * k) % 360 + 360) % 360;
    }

    r.bearing = this._bearing;
    r.heading = CARDINALS[Math.round(this._bearing / 45) % 8];
  }

  // ------------------------------------------------------------------- step

  step(dt) {
    const d = Number(dt);
    const r = this._race();
    if (!Number.isFinite(d) || d < 0) return;

    if (!this._started) {
      this._started = true;
      this._emit('race:start', {
        name: r.name, total: this.total, courseLength: this.courseLength,
        objective: r.objective,
      });
    }

    // Wipeout / recovery drives the phase and the time scale.
    if (this.state.phase === 'wipeout' || this.state.phase === 'recover') {
      this._stepWipeout(d);
    } else {
      // Heal a stray time scale, but leave 'intro' alone — another system may
      // legitimately be slowing time there.
      const ph = this.state.phase;
      if ((ph === 'ride' || ph === 'finish') && this.state.slowmo !== 1) this.state.slowmo = 1;
      this._watchWipeoutFlag(d);
    }

    // Distance keeps accumulating through a wipeout — the bore never stops.
    this.distance += this._advance(d);
    if (this.distance > this.courseLength) this.distance = this.courseLength;
    r.distance = this.distance;
    r.progress = clamp(this.distance / this.courseLength, 0, 1);

    this._checkpoints(r);
    r.distanceRemaining = Math.max(0, this.courseLength - this.distance);
    this._stepCompass(d, r);
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch (_) { /* noop */ } }
    this._offs.length = 0;
    if (this.state) this.state.slowmo = 1;
  }
}

export default Race;
