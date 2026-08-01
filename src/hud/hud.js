// POROROCA RUSH — §3.8 DOM HUD.
//
//   new HUD(rootDiv, state, bus, config)
//   step(dt)
//
// The layout lives in hud.css, which was authored 1:1 against
// imagens_conceito/*.png on a 1672x941 reference frame: every size there is
// `N * var(--s)` reference pixels. This file builds exactly the DOM that sheet
// expects and then only *writes values*, never structure.
//
// Rules honoured here:
//  - no layout thrash: every node is cached, every write is guarded by the last
//    value written, and nothing is read back from the DOM inside step().
//  - deterministic: all animation is driven by `state.time` (simulation clock),
//    never by wall-clock CSS animations — otherwise capture.js' seek() would
//    produce a different frame every run.
//  - defensive: a neighbour handing over rubbish degrades to a dash, never a
//    thrown exception. The game has to boot.
//  - zero Math.random().

import { CONFIG, KMH, TAU } from '../config.js';

// ---------------------------------------------------------------- utilities

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (Number.isFinite(v) ? v : (Number.isFinite(+v) ? +v : d));

/** Reference-pixel length as a CSS value (hud.css scales everything by --s). */
const px = (n) => `calc(${Math.round(n * 1000) / 1000} * var(--s))`;

/** 125760 -> "125.760" (pt-BR grouping, done by hand so it cannot drift with ICU). */
function grp(n) {
  let v = Math.round(num(n, 0));
  const neg = v < 0;
  if (neg) v = -v;
  let s = String(v);
  let out = '';
  while (s.length > 3) { out = '.' + s.slice(-3) + out; s = s.slice(0, -3); }
  return (neg ? '-' : '') + s + out;
}

/** metres -> "1,2" (pt-BR decimal comma). */
function km1(m) {
  const v = Math.max(0, num(m, 0)) / 1000;
  return (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Compass tape: 252 reference px per 45° cardinal step. That is the period the
// mask on `.pr-crule` uses to break the rule around each label, and it puts
// exactly SE / S / SW inside the 580 px window at bearing 180 — the concept art.
const PXDEG = 252 / 45;
const TAPE_B0 = -90;      // tape covers 540°, enough for any bearing in [0,360)
const TAPE_B1 = 450;

// Minimap framing (reference px inside the 225 px circle). The along-course
// range is derived from CONFIG.race.courseLength in the constructor so the
// circle always shows 2–3 checkpoint pins, exactly like the concept art.
const MAP = {
  size: 225,
  cx: 112.5,
  py: 162,          // the player sits low, like the concept art
  ribbon: 17,       // ribbon width, reference px
  lat: 1.85,        // lateral exaggeration, px per metre (strip-map styling)
};

const WIPEOUT_TEXT = {
  log: 'BATEU NO TRONCO',
  overTheFalls: 'PASSOU POR CIMA',
  lostWave: 'PERDEU A ONDA',
  nose: 'ENTERROU O BICO',
  landing: 'POUSO FALHO',
  wipeout: 'QUEDA!',
};

// ------------------------------------------------------------------- markup

function logoSVG() {
  return `<svg viewBox="0 0 392 160" aria-hidden="true">
  <defs>
    <linearGradient id="prLogoW" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".62" stop-color="#fbf4e7"/>
      <stop offset="1" stop-color="#dccfb8"/>
    </linearGradient>
    <linearGradient id="prLogoO" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe04f"/><stop offset=".34" stop-color="#ffab1c"/>
      <stop offset=".72" stop-color="#ff6f11"/><stop offset="1" stop-color="#d3300a"/>
    </linearGradient>
    <linearGradient id="prLogoS" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff8a16"/><stop offset="1" stop-color="#ff8a16" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- brush entry stroke, tapering into the R of RUSH at the same italic rake -->
  <g transform="skewX(-15)" fill="#ffffff">
    <path d="M52 100.6 L62 89.5 L112 89.5 L112 102.5 Z" opacity=".95"/>
    <path d="M66 107.5 L72 104 L112 104 L112 110 Z" opacity=".6"/>
  </g>

  <g transform="translate(27 76) skewX(-10)">
    <text x="0" y="0" textLength="309" lengthAdjust="spacingAndGlyphs"
          font-family="'Archivo Black','Barlow Condensed',Impact,sans-serif"
          font-size="72" fill="url(#prLogoW)">POROROCA</text>
  </g>

  <g transform="translate(68 136) skewX(-15)">
    <text x="0" y="0" textLength="196" lengthAdjust="spacingAndGlyphs"
          font-family="'Archivo Black','Barlow Condensed',Impact,sans-serif"
          font-size="68" fill="url(#prLogoO)"
          stroke="#2a1206" stroke-width="4.5" paint-order="stroke">RUSH</text>
  </g>

  <!-- speed streaks -->
  <g transform="skewX(-15)">
    <path d="M286 88 L378 88 L372 99 L280 99 Z" fill="url(#prLogoS)"/>
    <path d="M292 103 L364 103 L359 111 L287 111 Z" fill="#171008" opacity=".92"/>
    <path d="M282 115 L372 115 L366 124 L276 124 Z" fill="url(#prLogoS)"/>
    <path d="M296 127 L352 127 L348 134 L292 134 Z" fill="#171008" opacity=".85"/>
    <path d="M300 138 L338 138 L335 143 L297 143 Z" fill="#ff8a16" opacity=".55"/>
  </g>
</svg>`;
}

function compassMarkSVG() {
  return `<svg viewBox="0 0 24 47" aria-hidden="true">
  <path d="M3.2 0 H20.8 L12 12.6 Z" fill="#ffc42e"/>
  <path d="M12 20 L22 31 L12 42 L2 31 Z" fill="rgba(10,7,3,.45)" stroke="#ffc42e" stroke-width="2.6"
        stroke-linejoin="round"/>
  <path d="M12 26.6 L16.6 31 L12 35.4 L7.4 31 Z" fill="#ffd24a"/>
</svg>`;
}

function diamondSVG(size, fill) {
  const h = size / 2;
  return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
  <path d="M${h} 1 L${size - 1} ${h} L${h} ${size - 1} L1 ${h} Z" fill="${fill}"
        stroke="rgba(24,14,4,.75)" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M${h} 1 L${size - 1} ${h} L${h} ${h} Z" fill="#fff0bf" opacity=".45"/>
</svg>`;
}

function gaugeSVG() {
  const d = 'M4.5 7 Q56 37 107.5 7';
  return `<svg viewBox="0 0 112 28" aria-hidden="true">
  <defs>
    <linearGradient id="prGauge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8f2406"/><stop offset=".24" stop-color="#dc450c"/>
      <stop offset=".54" stop-color="#ff8a16"/><stop offset=".82" stop-color="#ffd24a"/>
      <stop offset="1" stop-color="#ffe9a8"/>
    </linearGradient>
  </defs>
  <path d="${d}" fill="none" stroke="rgba(8,5,2,.62)" stroke-width="13" stroke-linecap="round"/>
  <path d="${d}" fill="none" stroke="rgba(126,110,88,.38)" stroke-width="9.4" stroke-linecap="round"/>
  <path class="prGaugeFill" d="${d}" pathLength="100" fill="none" stroke="url(#prGauge)"
        stroke-width="9.4" stroke-linecap="butt" stroke-dasharray="0 100"/>
  <path class="prGaugeTip" d="${d}" pathLength="100" fill="none" stroke="#fffaf0"
        stroke-width="9.8" stroke-linecap="butt" stroke-dasharray="0 200" stroke-dashoffset="0"/>
</svg>`;
}

function compassTapeHTML() {
  let html = '';
  // baseline rule + fine ticks (the mask in hud.css breaks it around each label)
  html += `<span class="pr-crule" style="left:${px(TAPE_B0 * PXDEG)};width:${px((TAPE_B1 - TAPE_B0) * PXDEG)}"></span>`;
  // upper tick row
  for (let b = TAPE_B0; b <= TAPE_B1 + 1e-6; b += 5) {
    const m45 = Math.abs(b % 45) < 1e-6;
    const m15 = Math.abs(b % 15) < 1e-6;
    const cls = m45 ? 'pr-t3' : (m15 ? 'pr-t2' : 'pr-t1');
    html += `<span class="pr-ct ${cls}" style="left:${px(b * PXDEG)}"></span>`;
  }
  // cardinal labels
  for (let b = TAPE_B0; b <= TAPE_B1 + 1e-6; b += 45) {
    const i = ((Math.round(b / 45) % 8) + 8) % 8;
    html += `<span class="pr-cl" style="left:${px(b * PXDEG)}">${CARDINALS[i]}</span>`;
  }
  return html;
}

function hintHTML(keyCls, key, label) {
  return `<div class="pr-hint"><span class="pr-key ${keyCls}">${key}</span><em>${label}</em></div>`;
}

// ================================================================== the HUD

export class HUD {
  /**
   * @param {HTMLElement} root  #hud-root
   * @param {object} state      the GameState
   * @param {object} bus        core/bus.js
   * @param {object} config     CONFIG
   */
  constructor(root, state, bus, config) {
    this.state = state || {};
    this.bus = bus || null;
    this.config = config || CONFIG;
    this.raceCfg = (this.config && this.config.race) || CONFIG.race;
    this.worldCfg = (this.config && this.config.world) || CONFIG.world;
    this.physCfg = (this.config && this.config.physics) || CONFIG.physics;

    this.total = Math.max(1, Math.floor(num(this.raceCfg.checkpoints, 12)));
    this.courseLength = Math.max(1, num(this.raceCfg.courseLength, 9600));
    this.spacing = this.courseLength / this.total;
    this.speedMax = Math.max(1, num(this.physCfg.maxSpeed, 24) * KMH);

    // Zoom the minimap to the course: ~3.4 checkpoint gaps fit in the circle.
    this.mapAhead = clamp(this.spacing * 3.4, 320, 1900);
    this.mapAlong = MAP.py / this.mapAhead;      // px per metre along the course
    this.mapRoute = this.mapAhead * 0.55;        // metres of dotted route drawn

    this.ok = !!(root && root.appendChild);
    this._offs = [];
    this._disposed = false;

    // animated / cached display values
    this._s = 0;
    this._mapK = 1;
    this._scoreShown = 0;
    this._speedShown = 0;
    this._cache = Object.create(null);
    this._banner = null;
    this._flash = { t0: -99, dur: 0.5, color: 'rgba(255,200,80,.55)', peak: 0 };
    this._cpHitAt = -99;
    this._comboPopAt = -99;
    this._lastCombo = null;
    this._mapAcc = 99;
    this._river = null;
    this._riverTries = 0;
    this._riverProbeAt = -99;

    // fallback meander, mirroring world/river.js so the minimap traces the
    // channel the player is actually in even when ctx.river is unreachable.
    this._buildFallbackRiver();

    if (!this.ok) return;
    try {
      this._build(root);
      this._bind();
      this._syncScale(true);
      this.step(0);
    } catch (err) {
      // A broken HUD must never take the game down with it.
      this.ok = false;
      if (typeof console !== 'undefined') console.error('[hud] build failed', err);
    }
  }

  // ------------------------------------------------------------------ build

  _build(root) {
    const el = document.createElement('div');
    el.className = 'pr-hud';
    const name = String(this.raceCfg.name || 'POROROCA');
    const objective = String(this.raceCfg.objective || '');

    el.innerHTML = `
<div class="pr-logo">${logoSVG()}</div>

<div class="pr-score">
  <div class="pr-lab">PONTUAÇÃO</div>
  <div class="pr-row pr-row-1"><span class="pr-big pr-n-score">0</span><span class="pr-pts">PTS</span></div>
  <div class="pr-lab pr-lab-2">MELHOR COMBO</div>
  <div class="pr-row pr-row-2"><span class="pr-big pr-n-best">0</span><span class="pr-pts pr-pts-s">PTS</span></div>
</div>

<div class="pr-combo">
  <div class="pr-lab">COMBO</div>
  <div class="pr-combo-val"><span class="pr-x">x</span><span class="pr-c">1</span></div>
  <div class="pr-meter-wrap"><div class="pr-meter">
    <div class="pr-meter-fill"></div>
    <div class="pr-meter-grid"></div>
    <div class="pr-meter-edge"></div>
  </div></div>
</div>

<div class="pr-compass">
  <div class="pr-compass-win"><div class="pr-tape">${compassTapeHTML()}</div></div>
  <div class="pr-cmark">${compassMarkSVG()}</div>
</div>

<div class="pr-cp">
  <div class="pr-cp-banner"><span>CHECKPOINT</span></div>
  <div class="pr-big pr-cp-count">1<i>/</i>${this.total}</div>
  <div class="pr-cp-dist">0,0 KM</div>
</div>

<div class="pr-speed">
  <div class="pr-lab">VELOCIDADE</div>
  <div class="pr-speed-row"><span class="pr-big pr-speed-n">0</span><span class="pr-speed-u">KM/H</span></div>
  ${gaugeSVG().replace('<svg ', '<svg class="pr-gauge" ')}
</div>

<div class="pr-obj">
  <div class="pr-obj-title">${name}</div>
  <div class="pr-obj-goal"><span>${objective}</span>${diamondSVG(23, '#f5c033')}</div>
</div>

<div class="pr-map">
  <canvas></canvas>
  <div class="pr-map-ring"></div>
  <div class="pr-map-goal">${diamondSVG(26, '#ffd24a')}</div>
</div>

<div class="pr-hints">
  ${hintHTML('pr-key-round pr-key-stick', 'L', 'DIREÇÃO')}
  ${hintHTML('pr-key-trig', 'RT', 'ACELERAR')}
  ${hintHTML('pr-key-trig', 'LT', 'FREAR')}
  ${hintHTML('pr-key-round', 'B', 'SAIR')}
</div>

<div class="pr-banner"><div class="pr-banner-name"></div><div class="pr-banner-pts"></div></div>
<div class="pr-flash"></div>
<div class="pr-finish">PERCURSO CONCLUÍDO</div>`;

    root.appendChild(el);
    this.el = el;

    const q = (s) => el.querySelector(s);
    this.nScore = q('.pr-n-score');
    this.nBest = q('.pr-n-best');
    this.comboVal = q('.pr-combo-val');
    this.nCombo = q('.pr-combo-val .pr-c');
    this.meterFill = q('.pr-meter-fill');
    this.tape = q('.pr-tape');
    this.cpEl = q('.pr-cp');
    this.cpCount = q('.pr-cp-count');
    this.cpDist = q('.pr-cp-dist');
    this.nSpeed = q('.pr-speed-n');
    this.gaugeFill = q('.prGaugeFill');
    this.gaugeTip = q('.prGaugeTip');
    this.bannerEl = q('.pr-banner');
    this.bannerName = q('.pr-banner-name');
    this.bannerPts = q('.pr-banner-pts');
    this.flashEl = q('.pr-flash');
    this.finishEl = q('.pr-finish');
    this.mapCanvas = q('.pr-map canvas');

    this.mapCtx = null;
    if (this.mapCanvas && this.mapCanvas.getContext) {
      try { this.mapCtx = this.mapCanvas.getContext('2d'); } catch (_) { this.mapCtx = null; }
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

    on('race:checkpoint', (p) => {
      const i = Math.max(1, Math.round(num(p && p.index, 1)));
      const t = Math.max(1, Math.round(num(p && p.total, this.total)));
      this._cpHitAt = this._now();
      this._show(`CHECKPOINT ${i}/${t}`, 0, 'pr-good', 1.5, 2);
      this._doFlash('rgba(255,208,90,.55)', 0.5, 0.85);
    });

    on('race:finish', () => {
      this._show('CHEGADA!', 0, 'pr-good', 3.2, 3);
      this._doFlash('rgba(255,225,150,.6)', 0.9, 1);
    });

    on('player:wipeout', (p) => {
      const reason = String((p && p.reason) || 'wipeout');
      this._show(WIPEOUT_TEXT[reason] || WIPEOUT_TEXT.wipeout, 0, 'pr-bad', 1.9, 3);
      this._doFlash('rgba(230,60,20,.55)', 0.55, 0.9);
    });

    on('tube:enter', () => this._doFlash('rgba(255,245,220,.42)', 0.35, 0.6));
    on('tube:exit', (p) => {
      const pts = Math.round(num(p && p.points, 0));
      if (pts > 0) this._doFlash('rgba(255,214,120,.5)', 0.45, 0.75);
    });
    on('trick:fail', (p) => {
      const nm = String((p && p.name) || 'MANOBRA').toUpperCase();
      this._show(`${nm} FALHOU`, 0, 'pr-bad', 1.3, 2);
    });
  }

  // ------------------------------------------------------------- fallbacks

  /** Mirror of world/river.js' analytic meander, used when ctx.river is absent. */
  _buildFallbackRiver() {
    const W = this.worldCfg || CONFIG.world;
    const halfMin = (num(W.riverWidth, 340) - num(W.riverWidthVar, 70)) * 0.5;
    // river.js caps the meander so the |x| <= 80 corridor stays open water.
    const amp = Math.min(num(W.riverMeander, 210), Math.max(0, halfMin - 80 - 8 - 5));
    const kM = TAU / Math.max(120, num(W.riverMeanderLen, 1500));
    this._mA = [0.58 * amp, 0.27 * amp, 0.15 * amp];
    this._mK = [0.50 * kM, 1.00 * kM, 1.93 * kM];
    this._mP = [0.0, 2.31, 4.77];
  }

  _centerX(z) {
    const r = this._river;
    if (r) {
      try {
        const v = r.centerX(z);
        if (Number.isFinite(v)) return v;
      } catch (_) { this._river = null; }
    }
    const A = this._mA, K = this._mK, P = this._mP;
    return A[0] * Math.sin(K[0] * z + P[0])
         + A[1] * Math.sin(K[1] * z + P[1])
         + A[2] * Math.sin(K[2] * z + P[2]);
  }

  /** Half the channel width at world z, metres. */
  _halfWidth(z) {
    const r = this._river;
    if (r && typeof r.widthAt === 'function') {
      try {
        const w = r.widthAt(z);
        if (Number.isFinite(w) && w > 20) return w * 0.5;
      } catch (_) { /* fall through */ }
    }
    return Math.max(20, num(this.worldCfg.riverWidth, 340) * 0.5);
  }

  /** world/river.js publishes itself on ctx.river; grab it if the boot got that far. */
  _probeRiver(t) {
    if (this._river || this._riverTries > 8) return;
    if (t - this._riverProbeAt < 0.75) return;
    this._riverProbeAt = t;
    this._riverTries++;
    try {
      const r = (typeof window !== 'undefined' && window.PR && window.PR.ctx) ? window.PR.ctx.river : null;
      if (r && typeof r.centerX === 'function' && Number.isFinite(r.centerX(0))) this._river = r;
    } catch (_) { this._river = null; }
  }

  // ------------------------------------------------------------------ misc

  _now() { return num(this.state && this.state.time, 0); }

  /** Mirrors the --s formula in hud.css so canvas work lands on whole pixels. */
  _syncScale(force) {
    const w = (typeof window !== 'undefined' && window.innerWidth) || CONFIG.render.width;
    const h = (typeof window !== 'undefined' && window.innerHeight) || CONFIG.render.height;
    const s = Math.max(0.52, Math.min(w / 1672, h / 941));
    if (!force && Math.abs(s - this._s) < 0.0005) return;
    this._s = s;
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    const cv = this.mapCanvas;
    if (cv) {
      const size = Math.max(32, Math.round(MAP.size * s * dpr));
      if (cv.width !== size || cv.height !== size) { cv.width = size; cv.height = size; }
      this._mapK = size / MAP.size;
    }
    this._mapAcc = 99;   // force a redraw at the new resolution
  }

  _set(key, node, value) {
    if (!node || this._cache[key] === value) return;
    this._cache[key] = value;
    node.textContent = value;
  }

  _style(key, node, prop, value) {
    if (!node || this._cache[key] === value) return;
    this._cache[key] = value;
    node.style.setProperty(prop, value);
  }

  // --------------------------------------------------------------- banners

  _show(text, points, kind, dur, prio) {
    const t = this._now();
    const cur = this._banner;
    if (cur && cur.prio > (prio || 1) && t < cur.lock) return;   // do not stomp a fresh alert
    if (cur && cur.text === text && cur.kind === kind) {
      cur.points = Math.round(num(points, 0));
      cur.until = t + (dur || 1.6);
      return;
    }
    this._banner = {
      text: String(text || ''),
      points: Math.round(num(points, 0)),
      kind: kind || '',
      prio: prio || 1,
      t0: t,
      lock: t + 0.9,
      until: t + (dur || 1.6),
    };
  }

  _doFlash(color, dur, peak) {
    this._flash.t0 = this._now();
    this._flash.dur = Math.max(0.05, dur || 0.4);
    this._flash.color = color;
    this._flash.peak = clamp(num(peak, 0.8), 0, 1);
  }

  /** state.trick.banner is the tricks module's own channel — poll and adopt it. */
  _pollTrickBanner(t) {
    const tr = this.state && this.state.trick;
    const b = tr && tr.banner;
    if (!b || typeof b !== 'object') return;
    const until = num(b.until, 0);
    if (until <= t) return;
    const text = String(b.text || '').trim();
    if (!text) return;
    const cur = this._banner;
    if (cur && cur.prio >= 2 && t < cur.lock) return;
    const pts = Math.round(num(b.points, 0));
    if (cur && cur.text === text && cur.prio === 1) {
      cur.points = pts;
      cur.until = until;
      return;
    }
    this._banner = { text, points: pts, kind: '', prio: 1, t0: t, lock: t, until };
  }

  _stepBanner(t) {
    const b = this._banner;
    const node = this.bannerEl;
    if (!node) return;
    if (!b) {
      this._style('bop', node, 'opacity', '0');
      return;
    }
    const IN = 0.16, OUT = 0.26;
    const age = t - b.t0;
    const left = b.until - t;
    if (left <= -OUT) { this._banner = null; this._style('bop', node, 'opacity', '0'); return; }

    let k = 1, y = 0, sc = 1;
    if (age < IN) {
      const u = clamp(age / IN, 0, 1);
      const e = 1 - (1 - u) * (1 - u) * (1 - u);
      k = e; y = (1 - e) * 16; sc = 0.84 + 0.16 * e;
    } else if (left < OUT) {
      const u = clamp(1 - left / OUT, 0, 1);
      k = 1 - u; y = -u * 12; sc = 1 + u * 0.09;
    }

    this._set('btxt', this.bannerName, b.text);
    this._set('bpts', this.bannerPts, b.points > 0 ? `+${grp(b.points)} PTS` : '');
    const cls = `pr-banner${b.kind ? ' ' + b.kind : ''}`;
    if (this._cache.bcls !== cls) { this._cache.bcls = cls; node.className = cls; }
    this._style('bop', node, 'opacity', k.toFixed(3));
    this._style('btr', node, 'transform',
      `translateX(-50%) translateY(${px(y)}) scale(${sc.toFixed(3)})`);
  }

  _stepFlash(t) {
    const f = this._flash;
    const node = this.flashEl;
    if (!node) return;
    const age = t - f.t0;
    if (age < 0 || age > f.dur) { this._style('fop', node, 'opacity', '0'); return; }
    const u = clamp(age / f.dur, 0, 1);
    const a = f.peak * (1 - u) * (1 - u);
    this._style('fcol', node, '--flash', f.color);
    this._style('fop', node, 'opacity', a.toFixed(3));
  }

  // ------------------------------------------------------------------ step

  step(dt) {
    if (!this.ok || this._disposed) return;
    const d = clamp(num(dt, 0), 0, 0.25);
    const st = this.state || {};
    const t = this._now();

    this._syncScale(false);
    this._probeRiver(t);

    const player = st.player || {};
    const score = st.score || {};
    const race = st.race || {};

    // ---------------------------------------------------------------- score
    const points = Math.max(0, num(score.points, 0));
    if (points < this._scoreShown - 1 || !Number.isFinite(this._scoreShown)) this._scoreShown = points;
    else {
      const k = 1 - Math.exp(-d * 7.5);
      this._scoreShown += (points - this._scoreShown) * k;
      if (Math.abs(points - this._scoreShown) < 1.2) this._scoreShown = points;
    }
    this._set('score', this.nScore, grp(this._scoreShown));
    this._set('best', this.nBest, grp(num(score.bestComboPoints, 0)));

    // ---------------------------------------------------------------- combo
    const combo = Math.max(1, Math.round(num(score.combo, 1)));
    if (this._lastCombo === null) this._lastCombo = combo;
    else if (combo !== this._lastCombo) {
      if (combo > this._lastCombo) this._comboPopAt = t;
      this._lastCombo = combo;
    }
    this._set('combo', this.nCombo, String(combo));

    const popAge = t - this._comboPopAt;
    if (popAge >= 0 && popAge < 0.34) {
      const u = clamp(popAge / 0.34, 0, 1);
      const sc = 1 + 0.26 * (1 - u) * (1 - u);
      this._style('cpop', this.comboVal, 'transform', `scale(${sc.toFixed(3)})`);
    } else {
      this._style('cpop', this.comboVal, 'transform', 'scale(1)');
    }

    const fill = clamp(num(score.comboTimer, 0), 0, 1) * 100;
    this._style('meter', this.meterFill, '--fill', (Math.round(fill * 2) / 2).toFixed(1));

    // -------------------------------------------------------------- compass
    let bearing = num(race.bearing, 180);
    bearing = ((bearing % 360) + 360) % 360;
    const tx = Math.round(-bearing * PXDEG * 20) / 20;
    this._style('tape', this.tape, '--tx', String(tx));

    // ----------------------------------------------------------- checkpoint
    // Reads "7 / 12" + "1,2 KM" = checkpoints cleared and distance covered.
    // CONFIG.race is tuned so a capture lands exactly on the concept art frame
    // (12 checkpoints over a 2 km course: 7 cleared at 1,2 km).
    const total = Math.max(1, Math.round(num(race.total, this.total)));
    const done = clamp(Math.round(num(race.checkpoint, 0)), 0, total);
    this._setCheckpoint(done, total);
    let travelled = num(race.distance, NaN);
    if (!Number.isFinite(travelled)) {
      travelled = Math.max(0, this.courseLength - num(race.distanceRemaining, this.courseLength));
    }
    this._set('cpd', this.cpDist, `${km1(travelled)} KM`);

    const hit = (t - this._cpHitAt) >= 0 && (t - this._cpHitAt) < 0.3;
    if (this._cache.cphit !== hit && this.cpEl) {
      this._cache.cphit = hit;
      this.cpEl.classList.toggle('pr-hit', hit);
    }

    // -------------------------------------------------------------- velocity
    const raw = Math.max(0, num(player.speed, Math.hypot(num(player.vx, 0), num(player.vz, 0))));
    const kmh = raw * KMH;
    const ks = 1 - Math.exp(-d * 9);
    this._speedShown += (kmh - this._speedShown) * (d > 0 ? ks : 1);
    if (!Number.isFinite(this._speedShown)) this._speedShown = kmh;
    this._set('speed', this.nSpeed, String(Math.round(this._speedShown)));

    const g = clamp(this._speedShown / this.speedMax, 0, 1) * 100;
    const gq = Math.round(g * 4) / 4;
    this._style('gfill', this.gaugeFill, 'stroke-dasharray', `${gq} 100`);
    if (this.gaugeTip) {
      if (gq > 5) {
        this._style('gtipd', this.gaugeTip, 'stroke-dasharray', '4 200');
        this._style('gtipo', this.gaugeTip, 'stroke-dashoffset', String(-(gq - 4)));
        this._style('gtipv', this.gaugeTip, 'opacity', '1');
      } else {
        this._style('gtipv', this.gaugeTip, 'opacity', '0');
      }
    }

    // --------------------------------------------------------------- banner
    this._pollTrickBanner(t);
    this._stepBanner(t);
    this._stepFlash(t);

    // --------------------------------------------------------------- finish
    const finished = !!race.finished || st.phase === 'finish';
    if (this._cache.fin !== finished && this.finishEl) {
      this._cache.fin = finished;
      this.finishEl.classList.toggle('pr-on', finished);
    }

    // -------------------------------------------------------------- minimap
    this._mapAcc += d;
    if (this._mapAcc >= 0.05) { this._mapAcc = 0; this._drawMap(); }
  }

  _setCheckpoint(done, total) {
    const key = `${done}/${total}`;
    if (this._cache.cpc === key || !this.cpCount) return;
    this._cache.cpc = key;
    this.cpCount.textContent = '';
    this.cpCount.appendChild(document.createTextNode(String(done)));
    const i = document.createElement('i');
    i.textContent = '/';
    this.cpCount.appendChild(i);
    this.cpCount.appendChild(document.createTextNode(String(total)));
  }

  // ------------------------------------------------------------- minimap

  _drawMap() {
    const g = this.mapCtx;
    if (!g) return;
    const st = this.state || {};
    const player = st.player || {};
    const race = st.race || {};
    const S = MAP.size, R = MAP.cx, k = this._mapK || 1;

    const pz = num(player.z, 0);
    const plx = num(player.x, 0);
    const cx0 = this._centerX(pz);
    const heading = num(player.heading, 0);

    // Strip map: the channel *shape* is exaggerated so the meander reads at this
    // zoom, but the player's position across the channel is normalised to the
    // drawn ribbon — the arrow must always sit in the water, never beside it.
    const lane = clamp((plx - cx0) / this._halfWidth(pz), -1, 1) * (MAP.ribbon * 0.5 - 2.5);
    const mx = (u) => R - lane + (this._centerX(pz + u) - cx0) * MAP.lat;
    const my = (u) => MAP.py - u * this.mapAlong;

    try {
      g.setTransform(k, 0, 0, k, 0, 0);
      g.clearRect(0, 0, S, S);
      g.save();
      g.beginPath();
      g.arc(R, R, R - 1.2, 0, TAU);
      g.clip();

      // backdrop — just enough to lift the ribbon off bright water
      const bg = g.createRadialGradient(R, R * 0.85, 8, R, R, R);
      bg.addColorStop(0, 'rgba(20,14,8,0.20)');
      bg.addColorStop(1, 'rgba(8,5,3,0.42)');
      g.fillStyle = bg;
      g.fillRect(0, 0, S, S);

      // ---------------------------------------------------------- the river
      const back = (MAP.size - MAP.py) / this.mapAlong;
      const u0 = -back - 60, u1 = this.mapAhead + 60, steps = 64;
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = u0 + (u1 - u0) * (i / steps);
        const x = mx(u), y = my(u);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(14,22,24,0.55)';
      g.lineWidth = MAP.ribbon + 4.2;
      g.stroke();
      g.strokeStyle = 'rgba(176,205,209,0.96)';
      g.lineWidth = MAP.ribbon;
      g.stroke();
      g.strokeStyle = 'rgba(226,240,242,0.55)';
      g.lineWidth = MAP.ribbon * 0.34;
      g.stroke();

      // ------------------------------------------------------ route ahead
      g.save();
      g.setLineDash([5.5, 8.5]);
      g.lineWidth = 3.4;
      g.strokeStyle = 'rgba(255,255,255,0.94)';
      g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i <= 26; i++) {
        const u = (this.mapRoute * i) / 26;
        const x = mx(u), y = my(u);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.restore();

      // -------------------------------------------------- checkpoint pins
      const dist = num(race.distance, 0);
      const doneCp = Math.max(0, Math.round(num(race.checkpoint, 0)));
      const totalCp = Math.max(1, Math.round(num(race.total, this.total)));
      for (let c = doneCp + 1; c <= totalCp; c++) {
        const u = c * this.spacing - dist;
        if (u < -40 || u > this.mapAhead + 40) continue;
        this._pin(g, mx(u), my(u));
      }

      // ------------------------------------------------------ player + cone
      g.save();
      g.translate(R, MAP.py);
      g.rotate(heading);

      // view cone
      const cone = g.createLinearGradient(0, 0, 0, -60);
      cone.addColorStop(0, 'rgba(255,255,255,0.42)');
      cone.addColorStop(1, 'rgba(255,255,255,0.02)');
      g.fillStyle = cone;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(-23, -58);
      g.lineTo(23, -58);
      g.closePath();
      g.fill();

      // arrow
      g.beginPath();
      g.moveTo(0, -14.5);
      g.lineTo(10.5, 11);
      g.lineTo(0, 5.5);
      g.lineTo(-10.5, 11);
      g.closePath();
      g.fillStyle = '#ffc42e';
      g.strokeStyle = 'rgba(30,16,4,0.85)';
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.fill();
      g.stroke();
      g.restore();

      g.restore();
    } catch (_) {
      // A dead 2D context must not stop the frame.
      this.mapCtx = null;
    }
  }

  _pin(g, x, y) {
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.moveTo(0, 2);
    g.bezierCurveTo(-7.5, -5.5, -6.5, -14, 0, -14);
    g.bezierCurveTo(6.5, -14, 7.5, -5.5, 0, 2);
    g.closePath();
    g.fillStyle = '#e8402a';
    g.strokeStyle = 'rgba(30,10,4,0.8)';
    g.lineWidth = 1.6;
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(0, -8.4, 2.5, 0, TAU);
    g.fillStyle = 'rgba(255,232,206,0.92)';
    g.fill();
    g.restore();
  }

  // ------------------------------------------------------------------ misc

  setVisible(on) {
    if (this.el) this.el.classList.toggle('pr-off', !on);
  }

  dispose() {
    this._disposed = true;
    for (const off of this._offs) { try { off(); } catch (_) { /* noop */ } }
    this._offs.length = 0;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this.mapCtx = null;
  }
}

export default HUD;
