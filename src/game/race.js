// POROROCA RUSH — §3.5 Race: percurso de boias, distância, bússola, e o laço
// wipeout → slow-mo → recuperação.
//
// O percurso deixou de ser um hodômetro e passou a ser um SLALOM DE PORTAIS.
// `world/gates.js` planta pares de boias atravessados no rio e publica no bus:
//
//   gate:pass {index, total, width, margem}   margem 0 = centro, 1 = raspou a boia
//   gate:miss {index}
//
// Regras do percurso (decisões desta camada, documentadas de propósito):
//
//   * `state.race.checkpoint` = QUANTOS PORTAIS FORAM FEITOS. Só sobe em
//     `gate:pass`. É o placar de acertos que o HUD mostra como "7 / 12".
//   * Portal perdido fica para trás. Não dá para voltar, não há game over, a
//     corrida continua. O `gate:miss` só consome o portal (conta como resolvido)
//     e quebra a sequência de precisão em scoring.js.
//   * `race:finish` sai quando o ÚLTIMO portal for RESOLVIDO — passado ou
//     perdido — e não quando o contador de acertos chega ao total (senão uma
//     corrida com um portal perdido nunca terminaria).
//   * `state.race.distance` continua correndo com a pororoca: o HUD lê KM dali.
//   * `state.race.distanceToNext` passa a ser a distância até o PRÓXIMO PORTAL,
//     perguntada a `ctx.gates.next()`.
//
// Se `ctx.gates` não existir (ordem de boot, módulo ausente, agente vizinho
// atrasado) tudo cai no comportamento antigo por distância e o jogo continua
// jogável: checkpoints por hodômetro a cada `courseLength / checkpoints` metros.
//
// Determinístico: nada de Math.random(), tudo integrado por dt.

import { CONFIG, TAU } from '../config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, f = 0) => (Number.isFinite(v) ? v : f);
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

// --- percurso de boias -------------------------------------------------------
// Local knobs, NOT scores. Promote to CONFIG.race if they ever need external
// tuning (see the report): `gateFinishGrace`, `gateMaxDistance`.
const TUNE = {
  // Backstop: if the odometer tops out and gates.js has gone quiet, write the
  // unresolved portals off as missed after this many seconds so the run can
  // still reach `race:finish` instead of hanging at 11/12 forever.
  gateFinishGrace: 8.0,
  // Sanity ceiling on anything gates.js reports as "distance to the next gate".
  gateMaxDistance: 4000,
};

export class Race {
  /** @param {object} ctx { state, bus, config, physics, bore, gates, ... } */
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
    this._lastT = 0;               // rewind detector for PR_CAPTURE.seek()

    // --- portais ---
    this._gateMode = false;        // latched the moment gates.js shows up
    this._seen = new Set();        // resolved gate ids, so a repeat never counts twice
    this.passed = 0;
    this.missed = 0;
    this._finishGrace = 0;

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

    // Publish ourselves so gates.js / hud.js can find the run without reaching
    // into main.js. Never clobber a handle somebody else already installed.
    if (ctx && typeof ctx === 'object' && !ctx.race) {
      try { ctx.race = this; } catch (_) { /* frozen ctx is fine */ }
    }
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
    // Additive (non-contract) conveniences for the HUD / minimap / scoreboard.
    if (!Number.isFinite(r.progress)) r.progress = 0;
    if (!Number.isFinite(r.gatesPassed)) r.gatesPassed = this.passed;
    if (!Number.isFinite(r.gatesMissed)) r.gatesMissed = this.missed;
    if (!Number.isFinite(r.gatesResolved)) r.gatesResolved = this.passed + this.missed;
    if (!Number.isFinite(r.gateIndex)) r.gateIndex = 1;   // 1-based ordinal of the NEXT portal
    if (typeof r.gateMode !== 'boolean') r.gateMode = false;
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
    const on = (evt, fn) => {
      try {
        const off = bus.on(evt, (p) => { try { fn(p); } catch (_) { /* never break the emitter */ } });
        if (typeof off === 'function') this._offs.push(off);
      } catch (_) { /* a malformed bus must not break boot */ }
    };

    on('player:wipeout', (p) => this.beginWipeout((p && p.reason) || 'wipeout'));
    on('gate:pass', (p) => this._onGate(p, true));
    on('gate:miss', (p) => this._onGate(p, false));
  }

  // ------------------------------------------------------------------ gates

  /** gates.js is live as soon as ctx.gates exists or the first gate event lands. */
  _armGates() {
    if (this._gateMode) return true;
    const g = this.ctx && this.ctx.gates;
    if (!g) return false;
    this._gateMode = true;
    this._race().gateMode = true;
    return true;
  }

  /**
   * Stable id for dedupe. gates.js may number from 0 or from 1, and may re-emit
   * on a re-entry; either way the same portal must only ever resolve once. When
   * the payload carries no usable index we fall back to the resolve counter,
   * which never repeats.
   */
  _gateKey(p) {
    const i = Number(p && p.index);
    return Number.isFinite(i) ? `i${Math.round(i)}` : `n${this.passed + this.missed}`;
  }

  _onGate(payload, ok) {
    const r = this._race();
    this._gateMode = true;
    r.gateMode = true;

    // gates.js is the authority on how many portals the course actually has.
    const t = Math.round(Number(payload && payload.total));
    if (Number.isFinite(t) && t >= 1 && t <= 999 && t !== this.total) {
      this.total = t;
      this.spacing = this.courseLength / this.total;
      r.total = t;
    }

    if (r.finished) return;                       // late event after the flag drops

    const key = this._gateKey(payload);
    if (this._seen.has(key)) return;              // same portal twice = one portal
    this._seen.add(key);

    if (ok) {
      this.passed++;
      r.checkpoint = Math.min(this.passed, this.total);
      // Same event the HUD has always listened to — `index` stays "how many are
      // done", so the CHECKPOINT pill and this banner can never disagree.
      this._emit('race:checkpoint', {
        index: r.checkpoint,
        total: this.total,
        gate: this.passed + this.missed,          // ordinal of the portal itself
        margem: num(payload && (payload.margem ?? payload.margin), NaN),
        distance: this.distance,
        time: num(this.state.time, 0),
      });
    } else {
      this.missed++;
      // No checkpoint advance, no game over: the buoy pair simply slides past.
      this._emit('race:gateMissed', {
        gate: this.passed + this.missed,
        index: r.checkpoint,
        total: this.total,
        passed: this.passed,
        missed: this.missed,
        distance: this.distance,
        time: num(this.state.time, 0),
      });
    }

    this._syncGates(r);
    if (this.passed + this.missed >= this.total) this._finish('portais');
  }

  _syncGates(r) {
    r.gatesPassed = this.passed;
    r.gatesMissed = this.missed;
    r.gatesResolved = this.passed + this.missed;
    r.gateIndex = Math.min(this.total, r.gatesResolved + 1);
  }

  /**
   * Distance to the next portal, straight from gates.js. Deliberately liberal
   * about the shape `next()` returns, because that module is being written in
   * parallel: an object with `distance`/`dist`/`dz`, an object with a world `z`,
   * or a bare number of metres all work. Anything unrecognised → null and the
   * caller falls back to the even spacing estimate.
   */
  _gateDistance() {
    const g = this.ctx && this.ctx.gates;
    if (!g) return null;

    // Preferred: gates.js' own bearingTo(x, z) — true 2D distance to the next
    // pair, the same number the HUD's gate arrow uses.
    if (typeof g.bearingTo === 'function') {
      try {
        const p = this.state.player || {};
        const b = g.bearingTo(num(p.x, 0), num(p.z, num(this.state.bore && this.state.bore.z, 0)));
        const v = Number(b && b.dist);
        if (Number.isFinite(v)) {
          // dist 0 with no gate left means the course is over, not "0 m away".
          if (v > 0 || (b && b.gate)) return clamp(v, 0, TUNE.gateMaxDistance);
        }
      } catch (_) { /* fall through to next() */ }
    }

    let nx = null;
    try {
      if (typeof g.next === 'function') nx = g.next();
      else if (g.next && typeof g.next === 'object') nx = g.next;
      else if (typeof g.nextGate === 'function') nx = g.nextGate();
    } catch (_) { return null; }

    if (nx === null || nx === undefined) {
      // No portal left ahead: 0 if everything is resolved, otherwise let the
      // spacing estimate keep the HUD honest while gates.js streams the next one.
      return (this.passed + this.missed >= this.total) ? 0 : null;
    }

    if (typeof nx === 'number') {
      // A bare number is read as METRES REMAINING (documented expectation).
      return Number.isFinite(nx) ? clamp(nx, 0, TUNE.gateMaxDistance) : null;
    }
    if (typeof nx !== 'object') return null;

    for (const k of ['distance', 'dist', 'distanceToNext', 'remaining', 'dz', 'ahead']) {
      const v = Number(nx[k]);
      if (Number.isFinite(v)) return clamp(v, 0, TUNE.gateMaxDistance);
    }
    for (const k of ['z', 'worldZ', 'zc']) {
      const v = Number(nx[k]);
      if (!Number.isFinite(v)) continue;
      const p = this.state.player || {};
      const pz = Number.isFinite(Number(p.z)) ? Number(p.z)
        : num(this.state.bore && this.state.bore.z, 0);
      return clamp(v - pz, 0, TUNE.gateMaxDistance);
    }
    return null;
  }

  // ---------------------------------------------------------------- progress

  _finish(reason) {
    const r = this._race();
    if (r.finished) return;
    r.finished = true;
    r.distanceToNext = 0;
    if (!this._gateMode) r.checkpoint = this.total;
    this._syncGates(r);
    if (this.state.phase !== 'wipeout' && this.state.phase !== 'recover') {
      this.state.phase = 'finish';
    }
    const sc = this.state.score || {};
    this._emit('race:finish', {
      reason: String(reason || 'fim'),
      time: num(this.state.time, 0),
      distance: this.distance,
      points: num(sc.points, 0),
      bestCombo: num(sc.bestCombo, 0),
      bestComboPoints: num(sc.bestComboPoints, 0),
      // Placar do percurso: quantos portais foram feitos.
      checkpoints: r.checkpoint,
      total: this.total,
      gatesPassed: this.passed,
      gatesMissed: this.missed,
      gateMode: this._gateMode,
    });
  }

  /** Odometer-driven checkpoints — the pre-gates behaviour, kept as the fallback. */
  _legacyCheckpoints(r) {
    let guard = 0;
    while (r.checkpoint < this.total
           && this.distance >= (r.checkpoint + 1) * this.spacing
           && guard++ < 64) {
      r.checkpoint++;
      this.passed = r.checkpoint;
      this._emit('race:checkpoint', {
        index: r.checkpoint,
        total: this.total,
        distance: this.distance,
        time: num(this.state.time, 0),
      });
    }
    this._syncGates(r);
    if (r.checkpoint >= this.total || this.distance >= this.courseLength) {
      this._finish(r.checkpoint >= this.total ? 'checkpoints' : 'distancia');
      return;
    }
    r.distanceToNext = Math.max(0, (r.checkpoint + 1) * this.spacing - this.distance);
  }

  _stepProgress(dt, r) {
    if (r.finished) { r.distanceToNext = 0; return; }

    this._armGates();
    if (!this._gateMode) { this._legacyCheckpoints(r); return; }

    this._syncGates(r);

    // Distance to the next portal, with an even-spacing estimate as the floor so
    // the HUD never reads NaN while gates.js is streaming.
    let dn = this._gateDistance();
    if (dn === null || !Number.isFinite(dn)) {
      dn = (r.gatesResolved + 1) * this.spacing - this.distance;
    }
    r.distanceToNext = clamp(dn, 0, TUNE.gateMaxDistance);

    // Backstop: the bore reached the end of the course but portals are still
    // open — gates.js is gone or the last pair never resolved. Write them off as
    // missed so the run can finish. No game over either way.
    if (this.distance >= this.courseLength - 1e-6) {
      this._finishGrace += Math.max(0, dt);
      if (this._finishGrace >= TUNE.gateFinishGrace) {
        this.missed += Math.max(0, this.total - (this.passed + this.missed));
        this._syncGates(r);
        this._finish('distancia');
      }
    } else {
      this._finishGrace = 0;
    }
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

  // -------------------------------------------------------------- rewind

  /**
   * PR_CAPTURE.seek() rewinds state.time to 0 and restores a pristine
   * state.race, but the module-local counters are ours to reset. Without this
   * the second seek() in a page starts its odometer where the first one ended.
   */
  _checkRewind(t) {
    if (t >= this._lastT - 1e-6) { this._lastT = t; return; }
    this._lastT = t;
    const r = this._race();
    this.distance = Number.isFinite(r.distance) ? r.distance : 0;
    this._prevBoreZ = null;
    this._seen.clear();
    this.passed = Math.max(0, Math.round(num(r.checkpoint, 0)));
    this.missed = 0;
    this._finishGrace = 0;
    this._bearing = null;
    this._started = false;
    this._prevWipeFlag = false;
    this._autoLock = 0;
    this._slowmoT = Infinity;
    this._reason = null;
    this._syncGates(r);
  }

  // ------------------------------------------------------------------- step

  step(dt) {
    const d = Number(dt);
    const r = this._race();
    if (!Number.isFinite(d) || d < 0) return;

    this._checkRewind(num(this.state.time, 0));

    if (!this._started) {
      this._started = true;
      this._armGates();
      this._emit('race:start', {
        name: r.name, total: this.total, courseLength: this.courseLength,
        objective: r.objective, gateMode: this._gateMode,
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
    if (!Number.isFinite(this.distance)) this.distance = num(r.distance, 0);
    if (this.distance > this.courseLength) this.distance = this.courseLength;
    r.distance = this.distance;
    r.progress = clamp(this.distance / this.courseLength, 0, 1);

    this._stepProgress(d, r);
    r.distanceRemaining = Math.max(0, this.courseLength - this.distance);
    this._stepCompass(d, r);
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch (_) { /* noop */ } }
    this._offs.length = 0;
    if (this.ctx && this.ctx.race === this) { try { delete this.ctx.race; } catch (_) { /* noop */ } }
    if (this.state) this.state.slowmo = 1;
  }
}

export default Race;
