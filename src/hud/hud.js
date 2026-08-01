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

/**
 * Short range readout, pt-BR: "340 M" close in, "1,2 KM" far out.
 * Quantised above 100 m so the label does not churn once per frame.
 */
function range(m) {
  const v = Math.max(0, num(m, 0));
  if (v >= 950) return `${km1(v)} KM`;
  if (v >= 100) return `${Math.round(v / 5) * 5} M`;
  return `${Math.round(v)} M`;
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
  ribbon: 21,       // ribbon width, reference px
  lat: 1.85,        // lateral exaggeration, px per metre (strip-map styling)
  // The ribbon stands for the *navigable corridor*, not the full bank-to-bank
  // width: normalising a ±60 m buoy course against a 170 m half-river squeezed
  // the whole serpentine into two pixels and the course read as a straight line.
  corridor: 90,
};

/**
 * Corridor offset (in corridor half-widths) -> ribbon pixels. Soft, not clamped:
 * a hard clamp made every wide position identical, so a course that had wandered
 * outside the corridor stopped saying which side of you it was on. Bounded at
 * ~1.35, which is the ribbon's own edge.
 */
const laneCurve = (u) => u / Math.sqrt(1 + 0.55 * u * u);

// Off-screen gate indicator. The wedge is pinned to an ellipse inset from the
// frame; the vertical squash and the side-dependent bias keep it out of the two
// blocks that live on the middle of each edge (score/combo on the left,
// objective/minimap on the right) without ever lying about the direction — the
// anchor moves, the rotation is always the true screen-space bearing.
const ARROW = {
  insetX: 96,      // reference px from the left/right frame edge
  insetY: 150,     // reference px from the top/bottom frame edge
  squashY: 0.55,   // vertical squash applied to the anchor ray only
  biasMid: 26,     // reference px of downward bias at dead ahead …
  biasSide: 62,    // … ±this much depending on which side it lands on
  // Keep-out bands, reference px: the middle of each edge already belongs to
  // PONTUAÇÃO/COMBO on the left and OBJETIVO/minimapa on the right.
  bandL: [378, 514],
  bandR: [514, 616],
  labelGap: 52,    // reference px the distance label sits inward of the wedge
  showAt: 0.60,    // |ndc.x| that brings the arrow in …
  hideAt: 0.44,    // … and the tighter one that sends it away (hysteresis)
  nearHide: 6,     // metres: you are already in the gate, drop the arrow
};

// Minimap gate glyph palette, keyed by state.
const GATE_LOOK = {
  done: { buoy: '#f5c033', edge: 'rgba(28,15,4,.85)', bar: 'rgba(245,192,51,.85)', r: 2.9 },
  next: { buoy: '#ffd24a', edge: '#fff6de', bar: 'rgba(255,210,74,.95)', r: 3.4 },
  todo: { buoy: 'rgba(253,246,234,.30)', edge: 'rgba(253,246,234,.95)', bar: 'rgba(253,246,234,.55)', r: 3.0 },
  miss: { buoy: '#7d2412', edge: 'rgba(28,10,4,.8)', bar: 'rgba(176,58,28,.5)', r: 2.7 },
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

/** Off-screen indicator wedge. Points at +X (screen right) when unrotated. */
function gateArrowSVG() {
  return `<svg viewBox="0 0 72 56" aria-hidden="true">
  <defs>
    <linearGradient id="prGateA" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffe04f"/><stop offset=".5" stop-color="#ffab1c"/>
      <stop offset="1" stop-color="#ff6f11"/>
    </linearGradient>
  </defs>
  <path d="M7 5.5 L67 28 L7 50.5 L21 28 Z" fill="url(#prGateA)"
        stroke="#2a1206" stroke-width="5.4" stroke-linejoin="round" paint-order="stroke"/>
  <path d="M16 14 L49 26.4 L16 22 Z" fill="#fff3c8" opacity=".55"/>
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

    // --- gates (world/gates.js) — every one of these degrades to "absent" ---
    this._gates = null;         // the gates module, once it shows up on the ctx
    this._cam = null;           // three camera, for the off-screen indicator
    this._ctxTries = 0;
    this._ctxProbeAt = -99;
    this._gateNext = null;      // last gates.next()
    this._gateList = null;      // normalised gates.all() snapshot
    this._gatePollAcc = 99;
    this._gateTotal = this.total;
    this._gateArrowA = 0;       // smoothed indicator alpha
    this._gateArrowOn = false;  // hysteresis latch
    this._gatePassAt = -99;
    this._gateMissAt = -99;

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
  <div class="pr-cp-gate">
    <span class="pr-cpg-lab">PORTAL</span><span class="pr-cpg-n">1/${this.total}</span>
    <span class="pr-cpg-dot"></span><span class="pr-cpg-d">0 M</span>
  </div>
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

<div class="pr-gate-arrow">
  <div class="pr-ga-wedge">${gateArrowSVG()}</div>
  <div class="pr-ga-dist">0 M</div>
</div>

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
    this.cpGateN = q('.pr-cpg-n');
    this.cpGateD = q('.pr-cpg-d');
    this.gateArrow = q('.pr-gate-arrow');
    this.gateWedge = q('.pr-ga-wedge');
    this.gateDist = q('.pr-ga-dist');
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

    // --- percurso de boias ------------------------------------------------
    on('gate:pass', (p) => {
      const i = Math.max(1, Math.round(num(p && p.index, 1)));
      const tot = Math.max(i, Math.round(num(p && p.total, this._gateTotal)));
      this._gateTotal = tot;
      this._gatePassAt = this._now();
      if (this._gatePerfect(p)) {
        this._show('PORTAL PERFEITO!', 0, 'pr-good', 1.4, 2);
        this._doFlash('rgba(255,232,160,.55)', 0.42, 0.8);
      } else {
        this._show(`PORTAL ${i}/${tot}`, 0, '', 1.1, 2);
        this._doFlash('rgba(255,196,60,.45)', 0.32, 0.55);
      }
    });

    on('gate:miss', (p) => {
      const i = Math.max(0, Math.round(num(p && p.index, 0)));
      this._gateMissAt = this._now();
      this._show(i > 0 ? `PORTAL ${i} PERDIDO` : 'PORTAL PERDIDO', 0, 'pr-bad', 1.2, 2);
      this._doFlash('rgba(232,70,24,.55)', 0.4, 0.75);
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

  /**
   * The modules the HUD only *reads* publish themselves on the shared ctx
   * (river.js does `ctx.river = this`, gates.js is expected to do the same).
   * The HUD is built before some of them, so poll instead of assuming.
   */
  _probeCtx(t) {
    const needRiver = !this._river && this._riverTries <= 8;
    const needGates = !this._gates && this._ctxTries <= 24;
    const needCam = !this._cam && this._ctxTries <= 24;
    if (!needRiver && !needGates && !needCam) return;
    if (t - this._ctxProbeAt < 0.75) return;
    this._ctxProbeAt = t;
    this._riverProbeAt = t;
    this._ctxTries++;

    let ctx = null;
    try {
      ctx = (typeof window !== 'undefined' && window.PR) ? (window.PR.ctx || window.PR) : null;
    } catch (_) { ctx = null; }
    if (!ctx) return;

    if (needRiver) {
      this._riverTries++;
      try {
        const r = ctx.river;
        if (r && typeof r.centerX === 'function' && Number.isFinite(r.centerX(0))) this._river = r;
      } catch (_) { this._river = null; }
    }
    if (needGates) {
      try {
        const g = ctx.gates;
        if (g && typeof g.next === 'function') this._gates = g;
      } catch (_) { this._gates = null; }
    }
    if (needCam) {
      try {
        const c = ctx.camera;
        if (c && c.position && c.quaternion && Number.isFinite(num(c.fov, NaN))) this._cam = c;
      } catch (_) { this._cam = null; }
    }
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

  // =============================================================== portais ==
  // Everything below no-ops when world/gates.js is absent: no node is written,
  // no class is set, and the concept-art HUD keeps working exactly as before.

  /** `margem` may be metres of clearance or a 0..1 fraction; small = threaded. */
  _gatePerfect(p) {
    const m = Math.abs(num(p && (p.margem !== undefined ? p.margem : p.margin), NaN));
    if (!Number.isFinite(m)) return false;
    const w = num(p && p.width, NaN);
    const ref = (Number.isFinite(w) && w > 2) ? w * 0.5 : 1;
    return m <= ref * 0.25;
  }

  /** Copy gates.all() into a shape we own, so a neighbour recycling its array
   *  cannot make the minimap flicker. Sorted along the river. */
  _readGates(g) {
    let raw = null;
    try { raw = typeof g.all === 'function' ? g.all() : null; } catch (_) { raw = null; }
    if (!raw) return null;
    const src = Array.isArray(raw)
      ? raw
      : (typeof raw.length === 'number' ? Array.prototype.slice.call(raw) : null);
    if (!src || !src.length) return null;

    const out = [];
    for (let i = 0; i < src.length && out.length < 64; i++) {
      const e = src[i];
      if (!e || typeof e !== 'object') continue;
      const x = num(e.x, NaN), z = num(e.z, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const idx = Math.round(num(e.index, out.length + 1));
      if (idx > this._gateTotal) this._gateTotal = idx;
      out.push({ i: idx, x, z, w: num(e.width, NaN), passed: !!e.passed, missed: !!e.missed });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.z - b.z);
    return out;
  }

  /**
   * World (x,z) -> normalised device coords, using the live camera basis.
   * Reads camera.position/quaternion directly: the renderer's matrixWorldInverse
   * is a frame stale during play and *many* frames stale under capture.js' seek,
   * which would leave the indicator pointing at where the camera used to be.
   */
  _project(x, z) {
    const p = this.state.player || {};
    const y = num(p.y, 0) + 1.4;      // roughly buoy-top height
    const cam = this._cam;

    if (cam) {
      const c = cam.position, q = cam.quaternion;
      const qx = num(q.x, 0), qy = num(q.y, 0), qz = num(q.z, 0), qw = num(q.w, 1);
      const vx = x - num(c.x, 0), vy = y - num(c.y, 0), vz = z - num(c.z, 0);
      // columns of the quaternion's rotation matrix = camera right / up / back
      const rx = 1 - 2 * (qy * qy + qz * qz), ry = 2 * (qx * qy + qz * qw), rz = 2 * (qx * qz - qy * qw);
      const ux = 2 * (qx * qy - qz * qw), uy = 1 - 2 * (qx * qx + qz * qz), uz = 2 * (qy * qz + qx * qw);
      const bx = 2 * (qx * qz + qy * qw), by = 2 * (qy * qz - qx * qw), bz = 1 - 2 * (qx * qx + qy * qy);
      const sx = vx * rx + vy * ry + vz * rz;
      const sy = vx * ux + vy * uy + vz * uz;
      const depth = -(vx * bx + vy * by + vz * bz);        // three cameras look down -Z
      const fov = num(cam.fov, num(this.config.render && this.config.render.fov, 58));
      const asp = num(cam.aspect, 0) > 0.2 ? cam.aspect : this._aspect();
      const tanH = Math.tan(clamp(fov, 5, 175) * Math.PI / 360);
      const dd = Math.max(0.05, Math.abs(depth));
      const nx = (sx / dd) / Math.max(1e-4, tanH * asp);
      const ny = (sy / dd) / Math.max(1e-4, tanH);
      if (Number.isFinite(nx) && Number.isFinite(ny)) return { nx, ny, ahead: depth > 0.05 };
    }

    // No camera yet: fall back to the heading. +psi rotates toward +X, and world
    // +X falls on the LEFT of the screen, hence the minus.
    const heading = num(p.heading, 0);
    let rel = Math.atan2(x - num(p.x, 0), z - num(p.z, 0)) - heading;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const tanH = Math.tan(num(this.config.render && this.config.render.fov, 58) * Math.PI / 360);
    const nx = -Math.tan(clamp(rel, -1.4, 1.4)) / Math.max(1e-4, tanH * this._aspect());
    return { nx, ny: -0.12, ahead: Math.abs(rel) < 1.45 };
  }

  _aspect() {
    const w = (typeof window !== 'undefined' && window.innerWidth) || CONFIG.render.width;
    const h = (typeof window !== 'undefined' && window.innerHeight) || CONFIG.render.height;
    return h > 0 ? w / h : 16 / 9;
  }

  _stepGates(d, t) {
    const g = this._gates;
    const has = !!g;
    if (this._cache.gcls !== has && this.el) {
      this._cache.gcls = has;
      this.el.classList.toggle('pr-gates', has);
    }
    if (!has) { this._gateNext = null; this._gateList = null; return; }

    // --- next gate -----------------------------------------------------
    let nx = null;
    try { nx = typeof g.next === 'function' ? g.next() : null; } catch (_) { nx = null; }
    if (!nx || typeof nx !== 'object') nx = null;

    const p = this.state.player || {};
    const plx = num(p.x, 0), plz = num(p.z, 0);
    let gx = NaN, gz = NaN, dist = NaN;
    if (nx) {
      gx = num(nx.x, NaN);
      gz = num(nx.z, NaN);
      if (Number.isFinite(gx) && Number.isFinite(gz)) dist = Math.hypot(gx - plx, gz - plz);
      if (!Number.isFinite(dist) && typeof g.bearingTo === 'function') {
        try {
          const b = g.bearingTo(plx, plz);
          if (b && Number.isFinite(b.dist)) {
            dist = Math.max(0, b.dist);
            if (Number.isFinite(b.angle)) {
              gx = plx + Math.sin(b.angle) * dist;
              gz = plz + Math.cos(b.angle) * dist;
            }
          }
        } catch (_) { /* a broken neighbour just costs us the readout */ }
      }
      const idx = Math.round(num(nx.index, 0));
      if (idx > this._gateTotal) this._gateTotal = idx;
    }
    this._gateNext = nx && Number.isFinite(gx) && Number.isFinite(gz)
      ? { i: Math.round(num(nx.index, 0)), x: gx, z: gz, dist }
      : null;

    // --- active gates, polled at the minimap's own rate -----------------
    this._gatePollAcc += d;
    if (this._gatePollAcc >= 0.1) { this._gatePollAcc = 0; this._gateList = this._readGates(g); }

    // --- the CHECKPOINT block gains a "PORTAL n/12 · 340 M" line --------
    const live = !!this._gateNext && !(this.state.race || {}).finished;
    if (this._cache.gon !== live && this.el) {
      this._cache.gon = live;
      this.el.classList.toggle('pr-gate-on', live);
    }
    if (live) {
      const tot = Math.max(1, Math.round(this._gateTotal));
      const idx = clamp(this._gateNext.i || 1, 1, tot);
      this._set('gn', this.cpGateN, `${idx}/${tot}`);
      this._set('gd', this.cpGateD, range(this._gateNext.dist));
    }

    // pass / miss pulse on that same line
    const pulse = (t - this._gatePassAt) < 0.32 ? 'pr-gpass'
      : ((t - this._gateMissAt) < 0.32 ? 'pr-gmiss' : '');
    if (this._cache.gpulse !== pulse && this.cpEl) {
      this.cpEl.classList.remove('pr-gpass', 'pr-gmiss');
      if (pulse) this.cpEl.classList.add(pulse);
      this._cache.gpulse = pulse;
    }

    this._stepGateArrow(d, t, live);
  }

  /** The edge indicator: shown only while the gate is not comfortably framed. */
  _stepGateArrow(d, t, live) {
    const node = this.gateArrow;
    if (!node) return;

    const s = this._s || 1;
    const W = (typeof window !== 'undefined' && window.innerWidth) || CONFIG.render.width;
    const H = (typeof window !== 'undefined' && window.innerHeight) || CONFIG.render.height;
    const cx = W * 0.5, cy = H * 0.5;

    let want = 0, ax = cx, ay = cy, ang = 0, dirX = 1, dirY = 0;
    const gate = this._gateNext;

    if (live && gate && !(Number.isFinite(gate.dist) && gate.dist < ARROW.nearHide)) {
      const pr = this._project(gate.x, gate.z);
      const lim = this._gateArrowOn ? ARROW.hideAt : ARROW.showAt;
      const framed = pr.ahead && Math.abs(pr.nx) <= lim && Math.abs(pr.ny) <= 0.85;
      this._gateArrowOn = !framed;
      want = framed ? 0 : 1;

      // Screen-space delta from the middle of the frame. Behind the camera the
      // projection mirrors, so flip it — the wedge must point back, not forward.
      let dx = pr.nx * cx, dy = -pr.ny * cy;
      if (!pr.ahead) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
      ang = Math.atan2(dy, dx);
      dirX = dx; dirY = dy;

      // Pin it on an ellipse inset from the frame, with the vertical squashed so
      // the wedge hugs the sides instead of parking over the centre blocks.
      const rx = Math.max(40, W * 0.5 - ARROW.insetX * s);
      const ry = Math.max(40, H * 0.5 - ARROW.insetY * s);
      const ex = dx, ey = dy * ARROW.squashY;
      const k = 1 / Math.max(1e-4, Math.hypot(ex / rx, ey / ry));
      const side = clamp((ex * k) / rx, -1, 1);
      ax = cx + ex * k;
      ay = cy + ey * k + (ARROW.biasMid + ARROW.biasSide * side) * s;

      // Once the wedge is genuinely pinned to a side, fade in that side's
      // keep-out band so it never lands on top of a HUD block.
      const w = clamp((Math.abs(side) - 0.3) / 0.45, 0, 1);
      const band = side > 0 ? ARROW.bandR : ARROW.bandL;
      const hRef = H / s;
      const lo = 130 + (band[0] - 130) * w;
      const hi = (hRef - 150) + (band[1] - (hRef - 150)) * w;
      ay = clamp(ay / s, Math.min(lo, hi), Math.max(lo, hi)) * s;
    } else {
      this._gateArrowOn = false;
    }

    const k = d > 0 ? 1 - Math.exp(-d / 0.1) : 1;
    this._gateArrowA += (want - this._gateArrowA) * k;
    if (!Number.isFinite(this._gateArrowA)) this._gateArrowA = want;
    const a = clamp(this._gateArrowA, 0, 1);

    this._style('gaop', node, 'opacity', (Math.round(a * 50) / 50).toFixed(2));
    if (a < 0.01) return;

    this._style('gax', node, '--gx', `${(Math.round(ax * 2) / 2).toFixed(1)}px`);
    this._style('gay', node, '--gy', `${(Math.round(ay * 2) / 2).toFixed(1)}px`);

    const deg = Math.round(ang * 1800 / Math.PI) / 10;
    this._style('gaa', this.gateWedge, '--ga', `${deg}deg`);
    const beat = 1 + 0.055 * Math.sin(t * 6.3);
    this._style('gas', this.gateWedge, '--gs', beat.toFixed(3));

    // the readout rides inward of the wedge, upright, so it never reads mirrored
    this._style('gadx', this.gateDist, '--gdx', `${(-dirX * ARROW.labelGap * s).toFixed(1)}px`);
    this._style('gady', this.gateDist, '--gdy', `${(-dirY * ARROW.labelGap * s).toFixed(1)}px`);
    if (gate) this._set('gadt', this.gateDist, range(gate.dist));
  }

  // ------------------------------------------------------------------ step

  step(dt) {
    if (!this.ok || this._disposed) return;
    const d = clamp(num(dt, 0), 0, 0.25);
    const st = this.state || {};
    const t = this._now();

    this._syncScale(false);
    this._probeCtx(t);

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

    // -------------------------------------------------------------- portais
    this._stepGates(d, t);

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
    // zoom, but a position across the channel is normalised to the drawn ribbon —
    // the arrow must always sit in the water, never beside it.
    //
    // Orientation: this is a view straight down with +Z (the way the bore runs)
    // up the circle, so world +X falls on the LEFT of the map — the same side it
    // falls on in the 3D view. Any other convention has the minimap telling the
    // player to turn one way while the wave tells them the other.
    const laneOf = (x, z) => laneCurve(
      (x - this._centerX(z)) / Math.min(this._halfWidth(z), MAP.corridor),
    ) * (MAP.ribbon * 0.5 - 2.6);
    const lane = laneOf(plx, pz);
    const toX = (x, z) => R - ((laneOf(x, z) - lane) + (this._centerX(z) - cx0) * MAP.lat);
    const toY = (z) => MAP.py - (z - pz) * this.mapAlong;
    const mx = (u) => toX(this._centerX(pz + u), pz + u);
    const my = (u) => toY(pz + u);

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

      // ------------------------------------------- the course through the gates
      const gates = this._gateList;
      if (gates && gates.length) {
        this._drawCourse(g, gates, toX, toY, pz, plx);
      } else {
        // No gates module: the original "keep going up the channel" hint.
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

        // ------------------------------------------------ checkpoint pins
        const dist = num(race.distance, 0);
        const doneCp = Math.max(0, Math.round(num(race.checkpoint, 0)));
        const totalCp = Math.max(1, Math.round(num(race.total, this.total)));
        for (let c = doneCp + 1; c <= totalCp; c++) {
          const u = c * this.spacing - dist;
          if (u < -40 || u > this.mapAhead + 40) continue;
          this._pin(g, mx(u), my(u));
        }
      }

      // ------------------------------------------------------ player + cone
      g.save();
      g.translate(R, MAP.py);
      // +heading rotates toward +X, and +X is map-left → anticlockwise on canvas.
      g.rotate(-heading);

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

  /**
   * The buoy course: a line threading every gate in view, with the player spliced
   * in at their own position so the map answers "where do I go next" in one look.
   */
  _drawCourse(g, gates, toX, toY, pz, plx) {
    const back = (MAP.size - MAP.py) / this.mapAlong + 30;
    const zMin = pz - back, zMax = pz + this.mapAhead + 80;
    const nextI = this._gateNext ? this._gateNext.i : -1;
    const t = this._now();

    const vis = [];
    for (let i = 0; i < gates.length; i++) {
      const e = gates[i];
      if (e.z < zMin || e.z > zMax) continue;
      vis.push({ e, x: toX(e.x, e.z), y: toY(e.z) });
    }
    if (!vis.length) return;

    // The player joins the line where they actually are along the course.
    const me = { e: null, x: toX(plx, pz), y: toY(pz) };
    let at = 0;
    while (at < vis.length && vis[at].e.z < pz) at++;
    const pts = vis.slice(0, at).concat([me], vis.slice(at));

    // ---- the ribbon of the course itself
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      g.quadraticCurveTo(a.x, a.y, (a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
    }
    g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    g.strokeStyle = 'rgba(26,14,4,0.62)';
    g.lineWidth = 5.6;
    g.stroke();
    g.setLineDash([6, 5]);
    g.strokeStyle = 'rgba(245,192,51,0.95)';
    g.lineWidth = 2.6;
    g.stroke();
    g.restore();

    // ---- one glyph per gate, oriented across the course
    for (let i = 0; i < vis.length; i++) {
      const p = vis[i];
      const prev = vis[i - 1] || me, nextP = vis[i + 1] || null;
      const ax = (nextP ? nextP.x : p.x) - prev.x;
      const ay = (nextP ? nextP.y : p.y) - prev.y;
      const tan = (Math.abs(ax) + Math.abs(ay)) > 1e-3 ? Math.atan2(ay, ax) : -Math.PI / 2;
      const kind = p.e.missed ? 'miss'
        : (p.e.passed ? 'done' : (p.e.i === nextI ? 'next' : 'todo'));
      this._gateGlyph(g, p.x, p.y, tan + Math.PI / 2, kind, t);
    }
  }

  /** A gate reads as two boias on a crossbar — not a pin. */
  _gateGlyph(g, x, y, ang, kind, t) {
    const look = GATE_LOOK[kind] || GATE_LOOK.todo;
    const half = kind === 'next' ? 7.4 : 6.4;
    const c = Math.cos(ang) * half, s = Math.sin(ang) * half;

    g.save();
    if (kind === 'next') {
      const r = 10 + 1.7 * Math.sin(t * 4.2);
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.strokeStyle = 'rgba(255,210,74,0.55)';
      g.lineWidth = 1.8;
      g.stroke();
    }

    g.beginPath();
    g.moveTo(x - c, y - s);
    g.lineTo(x + c, y + s);
    g.strokeStyle = 'rgba(20,11,3,0.75)';
    g.lineWidth = 4.0;
    g.lineCap = 'round';
    g.stroke();
    g.strokeStyle = look.bar;
    g.lineWidth = 2.0;
    g.stroke();

    for (let k = -1; k <= 1; k += 2) {
      g.beginPath();
      g.arc(x + c * k, y + s * k, look.r, 0, TAU);
      g.fillStyle = look.buoy;
      g.strokeStyle = look.edge;
      g.lineWidth = kind === 'next' ? 1.9 : 1.5;
      g.fill();
      g.stroke();
    }
    g.restore();
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
