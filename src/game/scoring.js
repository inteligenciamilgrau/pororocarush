// POROROCA RUSH — §3.4 Scoring: points, combo multiplier, decay window.
//
// Single authority for the multiplier. `tricks.js` publishes *base* values on the
// bus; this module multiplies by the live combo and commits to `state.score`.
// Nothing else may write `state.score`.
//
// Deterministic: no Math.random(), everything integrated by dt.

import { CONFIG } from '../config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Fallback base values used only when a neighbour emits an event without
// `points` — keeps the run scoring instead of silently flatlining.
const FALLBACK_KEYS = {
  tubo: 'tubeExitBonus', tube: 'tubeExitBonus', barrel: 'tubeExitBonus',
  aereo: 'airBase', aéreo: 'airBase', air: 'airBase', aerial: 'airBase',
  cutback: 'cutbackPoints',
  rasgada: 'snapPoints', snap: 'snapPoints',
  floater: 'floaterPoints',
  tailslide: 'slidePoints', slide: 'slidePoints', deslize: 'slidePoints',
};
const FALLBACK_DEFAULT = 500;

export class Scoring {
  /** @param {object} ctx { state, bus, config, ... } */
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.state = ctx.state || {};
    this.bus = ctx.bus || null;

    const cfg = ctx.config || CONFIG;
    this.cfg = cfg.scoring || CONFIG.scoring;
    this.tricksCfg = cfg.tricks || CONFIG.tricks;

    this.comboWindow = Math.max(0.25, Number(this.cfg.comboWindow) || 4.2);
    this.comboMax = Math.max(1, Math.floor(Number(this.cfg.comboMax) || 20));
    this.comboStep = Math.max(1, Math.floor(Number(this.cfg.comboStep) || 1));
    this.decayRate = Math.max(0, Number(this.cfg.decayRate) || 1);

    // Internal continuous multiplier; state.score.combo is its integer face.
    this.comboF = 1;
    this.window = 0;          // seconds left before the multiplier starts draining
    this.chainPoints = 0;     // points banked inside the current combo chain
    this.pointsF = 0;         // exact integer accumulator (kept in sync with state)
    this._bumpFrame = -1;     // dedupes trick:land + combo:up in the same sim frame
    this._pendingTube = null; // dedupes tube:exit + its paired trick:land

    this._ensureScore();
    this._offs = [];
    this._bind();
  }

  // ---------------------------------------------------------------- plumbing

  _ensureScore() {
    const st = this.state;
    if (!st.score || typeof st.score !== 'object') {
      st.score = {
        points: 0, combo: 1, comboTimer: 0,
        bestCombo: 0, bestComboPoints: 0, lastGain: 0,
      };
    }
    const s = st.score;
    if (!Number.isFinite(s.points)) s.points = 0;
    if (!Number.isFinite(s.combo)) s.combo = 1;
    if (!Number.isFinite(s.comboTimer)) s.comboTimer = 0;
    if (!Number.isFinite(s.bestCombo)) s.bestCombo = 0;
    if (!Number.isFinite(s.bestComboPoints)) s.bestComboPoints = 0;
    if (!Number.isFinite(s.lastGain)) s.lastGain = 0;
    // Additive (non-contract) fields the HUD may use for pop-ups / chain meter.
    if (!Number.isFinite(s.comboPoints)) s.comboPoints = 0;
    if (!Number.isFinite(s.lastGainAt)) s.lastGainAt = -999;
    if (typeof s.lastGainName !== 'string') s.lastGainName = '';
    if (typeof s.comboDraining !== 'boolean') s.comboDraining = false;
    this.pointsF = s.points;
    return s;
  }

  _bind() {
    const bus = this.bus;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (evt, fn) => {
      try { const off = bus.on(evt, fn); if (typeof off === 'function') this._offs.push(off); }
      catch (_) { /* a malformed bus must not break boot */ }
    };

    on('trick:land', (p) => this._onTrickLand(p));
    on('tube:exit', (p) => this._onTubeExit(p));
    on('combo:up', (p) => this._onComboUp(p));
    on('player:wipeout', () => this.resetCombo());
  }

  // ------------------------------------------------------------- event sinks

  _fallbackPoints(payload) {
    const t = this.tricksCfg || {};
    const name = String((payload && payload.name) || '').toLowerCase();
    // A rotation-scored air outranks the plain name lookup.
    const rot = Math.abs(Number(payload && payload.rotation) || 0);
    if (rot >= 12.0) return Number(t.rot720) || FALLBACK_DEFAULT;
    if (rot >= 9.0) return Number(t.rot540) || FALLBACK_DEFAULT;
    if (rot >= 5.8) return Number(t.rot360) || FALLBACK_DEFAULT;
    for (const key in FALLBACK_KEYS) {
      if (name.indexOf(key) !== -1) return Number(t[FALLBACK_KEYS[key]]) || FALLBACK_DEFAULT;
    }
    return FALLBACK_DEFAULT;
  }

  /** Is this payload the tube ride (id 'tubo', name 'TUBO …')? */
  _isTube(payload) {
    const s = String((payload && (payload.id || payload.name)) || '').toLowerCase();
    return s.indexOf('tub') !== -1 || s.indexOf('barrel') !== -1;
  }

  _onTrickLand(payload) {
    // tricks.js banks a tube ride ON EXIT and pairs `tube:exit` with this very
    // landing carrying the SAME number (ARCHITECTURE §3.3). The landing wins and
    // the deferred tube award is dropped, so the ride is counted exactly once.
    if (this._pendingTube && this._isTube(payload)) this._pendingTube = null;

    let base = Number(payload && payload.points);
    if (!Number.isFinite(base) || base === 0) base = this._fallbackPoints(payload);
    if (!(base > 0)) return;                       // a scoreless landing keeps nothing alive
    if (payload && payload.clean === false) {
      const m = Number(this.tricksCfg && this.tricksCfg.sketchyLandingMult);
      // tricks.js normally pre-applies this; only scale when it clearly did not.
      if (Number.isFinite(m) && m > 0 && payload.points === undefined) base *= m;
    }
    this.award(base, (payload && payload.name) || 'manobra');
  }

  _onTubeExit(payload) {
    // A tube that ate the surfer pays nothing: tricks.js reports points: 0 with
    // clean: false and follows with `trick:fail`. Never invent an exit bonus for
    // a ride that was lost.
    if (payload && payload.clean === false) { this._pendingTube = null; return; }

    let base = Number(payload && payload.points);
    if (!Number.isFinite(base) || base <= 0) {
      const t = this.tricksCfg || {};
      const dur = Math.max(0, Number(payload && payload.duration) || 0);
      base = dur * (Number(t.tubePointsPerSec) || 0) + (Number(t.tubeExitBonus) || 0);
    }
    if (!(base > 0)) return;

    // Do NOT award here. tricks.js emits the paired `trick:land` immediately
    // after this event with the same value; awarding both would count the tube
    // twice (three times, in fact, since the second award rides the bumped
    // multiplier). Defer one sim frame instead: the landing claims it, and if no
    // landing ever comes step() banks it. Exactly one of the two ever scores.
    this._pendingTube = { base, frame: this._frame() };
  }

  _onComboUp(payload) {
    const explicit = Number(payload && payload.combo);
    if (Number.isFinite(explicit) && explicit >= 1) {
      this.comboF = clamp(Math.round(explicit), 1, this.comboMax);
      this.window = this.comboWindow;
      this._bumpFrame = this._frame();
      this._syncCombo();
      return;
    }
    this._bumpCombo();
    this.window = this.comboWindow;
    this._syncCombo();
  }

  // ------------------------------------------------------------------- core

  _frame() { return Number(this.state.frame) || 0; }

  /**
   * The displayed multiplier is `ceil(comboF)`, so a draining combo shows the
   * step it is *losing* for the full second it takes to lose it, instead of
   * dropping a notch the instant the window expires.
   */
  _combo() { return clamp(Math.ceil(this.comboF - 1e-9), 1, this.comboMax); }

  /** Raise the multiplier one step, at most once per simulation frame. */
  _bumpCombo() {
    const f = this._frame();
    if (this._bumpFrame === f) return;
    this._bumpFrame = f;
    this.comboF = Math.min(this.comboMax, this._combo() + this.comboStep);
  }

  /**
   * Commit a scoring action. `base` is the raw manobra value; the live combo
   * multiplies it. Public so neighbours can score directly if the bus is absent.
   * @returns {number} points actually added
   */
  award(base, name = '') {
    const b = Number(base);
    if (!Number.isFinite(b) || b <= 0) return 0;
    const s = this._score();

    const combo = this._combo();
    const gain = Math.round(b * combo);

    this.pointsF += gain;
    s.points = this.pointsF;
    s.lastGain = gain;
    s.lastGainAt = Number(this.state.time) || 0;
    s.lastGainName = String(name || '');

    this.chainPoints += gain;
    if (this.chainPoints > s.bestComboPoints) s.bestComboPoints = this.chainPoints;
    s.comboPoints = this.chainPoints;

    // Every scored manobra refills the window and steps the multiplier up.
    this.window = this.comboWindow;
    this._bumpCombo();
    this._syncCombo();

    if (this.bus && typeof this.bus.emit === 'function') {
      this.bus.emit('score:gain', { points: gain, base: b, combo, name: s.lastGainName });
    }
    return gain;
  }

  /** Wipeout: the chain is banked, the multiplier drops to x1. */
  resetCombo() {
    const s = this._score();
    this._endChain();
    this.comboF = 1;
    this.window = 0;
    s.combo = 1;
    s.comboTimer = 0;
    s.comboDraining = false;
    s.comboPoints = 0;
  }

  _endChain() {
    const s = this._score();
    if (this.chainPoints > s.bestComboPoints) s.bestComboPoints = this.chainPoints;
    this.chainPoints = 0;
    s.comboPoints = 0;
  }

  _score() {
    const s = this.state.score;
    return (s && typeof s === 'object') ? s : this._ensureScore();
  }

  _syncCombo() {
    const s = this._score();
    const combo = this._combo();
    if (combo !== s.combo && this.bus && typeof this.bus.emit === 'function') {
      this.bus.emit('score:combo', { combo, prev: s.combo });
    }
    s.combo = combo;
    if (combo > s.bestCombo) s.bestCombo = combo;
  }

  // ------------------------------------------------------------------- step

  step(dt) {
    const d = Number(dt);
    const s = this._score();

    // A `tube:exit` that no paired `trick:land` claimed banks itself here, one
    // sim frame later (see _onTubeExit).
    if (this._pendingTube && this._pendingTube.frame !== this._frame()) {
      const pend = this._pendingTube;
      this._pendingTube = null;
      this.award(pend.base, 'tubo');
    }

    if (!Number.isFinite(d) || d <= 0) { this._meter(s); return; }

    // External writes (debug console, save load) stay authoritative.
    if (Number.isFinite(s.points) && s.points !== this.pointsF) this.pointsF = s.points;

    if (this.window > 0) {
      this.window = Math.max(0, this.window - d);
    } else if (this.comboF > 1) {
      this.comboF = Math.max(1, this.comboF - this.decayRate * d);
      if (this.comboF <= 1 + 1e-6) { this.comboF = 1; this._endChain(); }
    }

    this._syncCombo();
    this._meter(s);
  }

  /**
   * comboTimer 0..1 — the HUD's vertical meter.
   *   window alive  → time left before the multiplier starts falling.
   *   window spent  → the bar refills and drains once per multiplier step lost,
   *                   so "x7 draining to x6" is readable. `comboDraining` lets
   *                   the HUD paint that phase red instead of yellow.
   */
  _meter(s) {
    if (this.window > 0) {
      s.comboTimer = clamp(this.window / this.comboWindow, 0, 1);
      s.comboDraining = false;
    } else if (this.comboF > 1) {
      const frac = this.comboF - Math.floor(this.comboF);
      s.comboTimer = frac === 0 ? 1 : clamp(frac, 0, 1);
      s.comboDraining = true;
    } else {
      s.comboTimer = 0;
      s.comboDraining = false;
    }
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch (_) { /* noop */ } }
    this._offs.length = 0;
  }
}

export default Scoring;
