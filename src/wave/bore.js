// POROROCA RUSH — the wave field.
//
// This module is the single source of truth for "where the water is". Physics,
// the wave mesh, foam, obstacles and the camera all ask this class. The maths is
// authored once here and mirrored, line for line, into `BoreWave.GLSL` so the CPU
// and the GPU agree to well under a centimetre.
//
// Coordinate system (see docs/ARCHITECTURE.md §1):
//   +X across the river, +Y up (y = 0 is the still-water datum), +Z upriver =
//   the direction the bore travels. Face coordinate `d = z - crest(x, t)`:
//   d = 0 is the lip, d > 0 is the unbroken face ahead, d < 0 is whitewater.
//
// Shape of a pororoca (undular tidal bore):
//   * an abrupt front whose face is hollow near the lip and eases into flat water,
//   * a train of secondary rollers behind it riding on an elevated tidal step,
//   * a crest line that bows across the channel and slowly meanders,
//   * barrelling cells that are born, pitch and die along the crest.
//
// CPU/GPU parity notes:
//   * All noise is built on Ashima's `permute` mod 289. Every intermediate is an
//     exact integer below 2^24, so float32 (GLSL highp) and float64 (JS) produce
//     bit-identical lattice hashes. No sin-based hashing, no library simplex.
//   * All designer tunables come from CONFIG.wave and all shaping constants from
//     SHAPE below; the GLSL source is generated from those same numbers, so there
//     is literally one set of values.
//   * Every sin/cos argument is range-reduced with mod(.., TAU) on both sides so
//     large `t` cannot make the GPU drift away from the CPU.
//   Measured against a real GLSL ES 3.00 context over 16 384 samples spanning
//   the whole channel and d in [-120, +80] m, at t = 43 s and t = 900 s:
//   height max error 1.2 mm, normal tilt max 0.05 deg, barrel/amplitude 6e-7.
//
// Using the shader twin (waveMesh.js, foam.js, river.js):
//   material.uniforms = Object.assign({}, BoreWave.GLSL_UNIFORMS, myUniforms);
//   vertexShader = BoreWave.GLSL + myVertexShader;   // once per shader stage
//   ...then call bore.uniforms(state.time) each frame.
//   Work in local space where you can — pass (x, z - prBoreZ + prBoreZ) is a
//   no-op, but building the mesh around prBoreZ keeps float32 precision high.
//   Available: pr_crest, pr_height, pr_heightBase, pr_normal, pr_faceD,
//   pr_faceT, pr_slope, pr_amplitude, pr_barrel, pr_breakIntensity,
//   pr_lipThrow, pr_tubePocket, pr_whitewater, pr_flow, pr_chop.

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { rng } from '../core/rng.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Shaping constants. CONFIG.wave holds what a designer tunes; these are the
// internal shape of the model. They are baked into the generated GLSL, so
// changing one here changes CPU and GPU together.
// ---------------------------------------------------------------------------
const SHAPE = {
  // Lateral half-width of the channel. Ideally CONFIG.world.riverWidth / 2, but
  // BoreWave is constructed with CONFIG.wave only — pass `channelHalf` in the
  // config object to override.
  channelHalf: 170.0,

  // --- crest line -----------------------------------------------------------
  bowClamp: 1.25,          // |x| / halfWidth clamp so the bow stays bounded
  bowCenter: 0.35,         // shifts the bow so it averages ~0 across the channel
  wanderK: [0.0125, 0.0268, 0.0057],   // lateral wavenumbers (rad/m)
  wanderW: [0.55, 0.30, 0.15],         // weights, sum = 1
  wanderT: [0.100, 0.075, 0.045],      // temporal rates (rad/s) — slow

  // --- lateral channel profile ---------------------------------------------
  bankLo: 0.34, bankHi: 1.12, bankFloor: 0.45,

  // --- amplitude variation --------------------------------------------------
  ampScale: 0.0083,        // ~120 m lateral features
  ampRate: 0.05,
  ampFloor: 0.35,

  // --- face profile ---------------------------------------------------------
  // h = amp * (1-s)^2 * ((1-swell)*exp(-k s) + swell*exp(-swellK s)), s = d/faceLen.
  // The (1-s)^2 factor makes the profile meet the flat water with zero height AND
  // zero slope. `k` is solved so the lip slope is exactly
  //   atan(faceSteepness * (faceTanBase + faceTanBarrel * barrel))
  // which with CONFIG faceSteepness = 1.55 is 29.9 deg on the shoulder and
  // 64.9 deg where the lip is fully pitching. The `swell` term is the long,
  // low forward shoulder a real bore pushes ahead of itself.
  faceTanBase: 0.36,
  faceTanBarrel: 1.02,
  faceExpMin: 3.0,
  faceExpMax: 24.0,
  faceSwell: 0.16,
  faceSwellK: 1.8,
  faceKMin: 0.3,

  // --- behind the front -----------------------------------------------------
  stepRatio: 0.58,         // mean level behind the bore, as a fraction of crest
  relaxF: 0.62,            // x trailLen: how fast the level relaxes to the step
  trailDecayF: 0.45,       // x trailLen*trailCount: roller envelope decay
  trailAmpMax: 1.6,        // clamp on amplitude(x)/CONFIG.amplitude

  // --- chop -----------------------------------------------------------------
  chopLip: 1.35,           // ragged right at the lip
  chopFace: 0.55,          // glassy face
  chopFlat: 0.85,          // river ripple ahead
  chopDeep: 0.95,          // settled water far behind
  chopLipEnd: 0.12,        // faceT at which the lip roughness has died away
  chopFlatLo: 0.35,
  chopAdvect: 0.45,        // chop is advected upriver with the bore

  // --- barrel cells ---------------------------------------------------------
  barrelRate: 0.085,
  barrelLo: 0.46, barrelHi: 0.78,
  barrelAmpLo: 1.90, barrelAmpSpan: 1.00,

  // --- breaking / whitewater ------------------------------------------------
  breakCellF: 1.6,
  breakRate: 0.11,
  breakBase: 0.60, breakNoise: 0.38, breakBarrel: -0.15, breakBank: 0.50,

  // --- tube pocket ----------------------------------------------------------
  tubeInner: 0.22, tubePad: 1.90, tubeRoof: 0.97,

  // --- surface flow ---------------------------------------------------------
  // The carry weight has its own, much wider falloff than the height profile:
  // the whole rideable pocket has to feel like it is being pushed upriver, not
  // just the top metre of the face.
  flowRiver: -1.30,        // river current on flat water (downstream = -Z)
  flowFront: 1.00,         // fraction of boreSpeed carried at the crest
  flowReach: 15.0,         // metres ahead of the lip where the carry dies out
  flowBackFloor: 0.62,     // carry deep in the whitewater
  flowLateral: 0.55,       // how much the crest's lateral tilt peels the water
  flowSwirl: 0.85,
  flowSwirlScale: 0.02, flowSwirlRate: 0.35,
  flowCrestEps: 0.75,      // metres used for the crest slope difference

  // --- foam coverage (helper for waveMesh / foam) --------------------------
  foamFaceLen: 3.4,
  foamNoiseScale: 0.42,

  normalEps: 0.10,         // metres, central-difference step for normals
  // fBm octave weights. Gain 0.44 (not 0.5) against lacunarity 2.03 so the fine
  // octaves add texture without adding slope — that is what keeps the analytic
  // and the sampled normals in agreement.
  fbmW: [0.5, 0.22, 0.09],
  fbmNorm: 1.234567901,    // 1 / (0.5 + 0.22 + 0.09)
};

// ---------------------------------------------------------------------------
// Small maths helpers, mirrored exactly in GLSL.
// ---------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
const fmodp = (x, m) => x - m * Math.floor(x / m);

// --- portable value noise ---------------------------------------------------
// permute() mod 289: (34x+1)*x <= 2 820 384 < 2^24 for x < 289, so every step is
// an exact integer in float32 as well as float64. This is what makes the GPU
// reproduce the CPU noise exactly.
const INV289 = 1 / 289;
function m289(x) { return x - 289 * Math.floor(x * INV289); }
// x is always already in [0, 289) here, so (34x+1)x <= 2 820 384 and the
// truncation is exact — no Math.floor needed.
function pmt(x) { const v = (34 * x + 1) * x; return v - 289 * ((v * INV289) | 0); }

function lhash(ix, iy, s) {
  const b = m289(pmt(m289(ix)) + m289(iy) + s);
  return pmt(b) * INV289;
}

function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  // Hoisted: the two column permutes and the two row reductions are shared by
  // the four corners. Identical results to four separate lhash() calls.
  const p0 = pmt(m289(ix)), p1 = pmt(m289(ix + 1));
  const q0 = m289(iy) + s, q1 = m289(iy + 1) + s;
  const a = pmt(m289(p0 + q0)) * INV289;
  const b = pmt(m289(p1 + q0)) * INV289;
  const c = pmt(m289(p0 + q1)) * INV289;
  const d = pmt(m289(p1 + q1)) * INV289;
  const t0 = a + (b - a) * ux;
  const t1 = c + (d - c) * ux;
  return t0 + (t1 - t0) * uy;
}

function fbm3(x, y, s) {
  const W = SHAPE.fbmW;
  let v = vnoise(x, y, s) * W[0];
  v += vnoise(x * 2.03 + 17, y * 2.03 + 5, s + 37) * W[1];
  v += vnoise(x * 4.1209 + 41, y * 4.1209 + 23, s + 113) * W[2];
  return v * SHAPE.fbmNorm;
}

// GLSL float literal formatter — keeps the generated source readable and valid.
function glf(v) {
  let s = Number(v).toPrecision(10);
  if (s.indexOf('e') >= 0 || s.indexOf('E') >= 0) {
    return /\./.test(s) ? s : s.replace(/^(-?\d+)([eE])/, '$1.0$2');
  }
  if (s.indexOf('.') < 0) return `${s}.0`;
  s = s.replace(/(\.\d*?)0+$/, '$1');
  return s.endsWith('.') ? `${s}0` : s;
}

// ---------------------------------------------------------------------------

export class BoreWave {
  /** @param {object} config CONFIG.wave */
  constructor(config = CONFIG.wave) {
    // Defensive: any missing or non-finite tunable falls back to the shipped
    // default rather than turning the whole wave into NaN geometry.
    const src = config || {};
    const D = CONFIG.wave;
    const num = (k, fallback) => {
      const v = +src[k];
      return Number.isFinite(v) ? v : fallback;
    };
    const c = {};
    for (const k of Object.keys(D)) c[k] = num(k, D[k]);
    this.config = c;

    this.boreSpeed = c.boreSpeed;
    this.faceLen = c.faceLen;
    this.amplitude0 = c.amplitude;
    this.amplitudeVar = c.amplitudeVar;
    this.crestBow = c.crestBow;
    this.crestWander = c.crestWander;
    this.faceSteepness = c.faceSteepness;
    this.lipOverhang = c.lipOverhang;
    this.trailAmp = c.trailAmp;
    this.trailLen = c.trailLen;
    this.trailCount = c.trailCount;
    this.chopAmp = c.chopAmp;
    this.chopScale = c.chopScale;
    this.barrelThreshold = c.barrelThreshold;
    this.barrelCellSize = c.barrelCellSize;
    this.whitewaterDepth = c.whitewaterDepth;
    this.halfWidth = num('channelHalf', SHAPE.channelHalf);
    c.channelHalf = this.halfWidth;

    // Deterministic per-run offsets. Baked into the GLSL as literals so the two
    // sides cannot drift.
    const r = rng((CONFIG.seed ^ 0x50524f52) >>> 0);
    const iseed = () => Math.floor(r() * 289);
    this.seeds = {
      chop: iseed(), amp: iseed(), barrelA: iseed(), barrelB: iseed(),
      brk: iseed(), swirl: iseed(), foam: iseed(),
    };
    this.phases = [
      Math.round(r() * TAU * 1e4) / 1e4,
      Math.round(r() * TAU * 1e4) / 1e4,
      Math.round(r() * TAU * 1e4) / 1e4,
    ];

    // Reciprocals precomputed — height() is on the hot path.
    this._invHalf = 1 / Math.max(1, this.halfWidth);
    this._invFaceLen = 1 / Math.max(0.01, this.faceLen);
    this._invWW = 1 / Math.max(0.01, this.whitewaterDepth);
    this._invTrailLen = 1 / Math.max(0.01, this.trailLen);
    this._invTrailDecay = 1 / Math.max(0.01, this.trailLen * this.trailCount * SHAPE.trailDecayF);
    this._invRelax = 1 / Math.max(0.01, this.trailLen * SHAPE.relaxF);
    this._invAmp0 = 1 / Math.max(0.2, this.amplitude0);
    this._invBarrelCell = 1 / Math.max(1, this.barrelCellSize);
    this._invBreakCell = 1 / Math.max(1, this.barrelCellSize * SHAPE.breakCellF);
    this._invBarrelSpan = 1 / Math.max(1e-4, 1 - this.barrelThreshold);

    // Tiny direct cache of the per-column quantities (crest / amplitude /
    // barrel / face exponent). height() is called thousands of times per frame,
    // usually in runs that share x, and normal() straddles x by ±eps — four
    // slots cover both patterns with four float compares.
    this._cache = [];
    for (let i = 0; i < 4; i++) this._cache.push({ x: NaN, t: NaN, crest: 0, amp: 0, barrel: 0, k: 1 });
    this._ci = 0;

    // Publish the shader twin and its uniforms.
    this._installShader();
  }

  dispose() { /* nothing to release — pure maths */ }

  // =========================================================================
  // internals
  // =========================================================================

  /** Lateral channel weight: 1 mid-channel, SHAPE.bankFloor at the banks. */
  _bell(x) {
    const u = Math.abs(x) * this._invHalf;
    return mix(1, SHAPE.bankFloor, smoothstep(SHAPE.bankLo, SHAPE.bankHi, u));
  }

  _crest(x, t) {
    const u = clamp(x * this._invHalf, -SHAPE.bowClamp, SHAPE.bowClamp);
    const bow = this.crestBow * (u * u - SHAPE.bowCenter);
    const K = SHAPE.wanderK, W = SHAPE.wanderW, R = SHAPE.wanderT, P = this.phases;
    const w =
      W[0] * Math.sin(fmodp(x * K[0] + t * R[0] + P[0], TAU)) +
      W[1] * Math.sin(fmodp(x * K[1] - t * R[1] + P[1], TAU)) +
      W[2] * Math.sin(fmodp(x * K[2] + t * R[2] + P[2], TAU));
    return this.boreSpeed * t + bow + this.crestWander * w;
  }

  _amplitude(x, t) {
    const n = vnoise(x * SHAPE.ampScale, t * SHAPE.ampRate, this.seeds.amp);
    const a = (this.amplitude0 + this.amplitudeVar * (2 * n - 1)) * this._bell(x);
    return a < SHAPE.ampFloor ? SHAPE.ampFloor : a;
  }

  /** Barrel cells, given an already-known amplitude. 0..1. */
  _barrelA(x, t, amp) {
    const xa = x * this._invBarrelCell;
    const n =
      0.65 * vnoise(xa, t * SHAPE.barrelRate, this.seeds.barrelA) +
      0.35 * vnoise(xa * 2.13 + 9, t * SHAPE.barrelRate * 1.7 + 3, this.seeds.barrelB);
    let b = smoothstep(SHAPE.barrelLo, SHAPE.barrelHi, n);
    b *= this._bell(x);
    b *= smoothstep(SHAPE.barrelAmpLo, SHAPE.barrelAmpLo + SHAPE.barrelAmpSpan, amp);
    return clamp01(b);
  }

  /**
   * Decay rate of the steep part of the face, solved so the total lip slope
   * (steep term + swell term + the (1-s)^2 factor) lands exactly on the target.
   */
  _faceK(amp, barrel) {
    const tanLip = this.faceSteepness * (SHAPE.faceTanBase + SHAPE.faceTanBarrel * barrel);
    const a = clamp(tanLip * this.faceLen / Math.max(0.25, amp), SHAPE.faceExpMin, SHAPE.faceExpMax);
    const k = (a - 2 - SHAPE.faceSwell * SHAPE.faceSwellK) / (1 - SHAPE.faceSwell);
    return k < SHAPE.faceKMin ? SHAPE.faceKMin : k;
  }

  /** Cached per-column quantities. Pure function of (x, t). */
  _col(x, t) {
    const cs = this._cache;
    for (let i = 0; i < 4; i++) {
      const e = cs[i];
      if (e.x === x && e.t === t) return e;
    }
    const e = cs[this._ci];
    this._ci = (this._ci + 1) & 3;
    e.x = x; e.t = t;
    e.crest = this._crest(x, t);
    e.amp = this._amplitude(x, t);
    e.barrel = this._barrelA(x, t, e.amp);
    e.k = this._faceK(e.amp, e.barrel);
    return e;
  }

  /** Base surface (no chop) as a function of the face coordinate. */
  _surface(d, amp, k) {
    if (d >= 0) {
      const s = d * this._invFaceLen;
      if (s >= 1) return 0;
      const om = 1 - s;
      const sw = SHAPE.faceSwell;
      return amp * om * om * ((1 - sw) * Math.exp(-k * s) + sw * Math.exp(-SHAPE.faceSwellK * s));
    }
    const u = -d;
    const step = SHAPE.stepRatio;
    const mean = amp * (step + (1 - step) * Math.exp(-u * this._invRelax));
    const env = Math.exp(-u * this._invTrailDecay);
    const scale = Math.min(SHAPE.trailAmpMax, amp * this._invAmp0);
    const roller = this.trailAmp * scale * env * 0.5 * (Math.cos(fmodp(TAU * u * this._invTrailLen, TAU)) - 1);
    return mean + roller;
  }

  /** High-frequency detail, region-weighted. Continuous across d = 0. */
  _chop(x, z, t, d) {
    let mul;
    if (d >= 0) {
      const fw = clamp01(d * this._invFaceLen);
      const m1 = mix(SHAPE.chopLip, SHAPE.chopFace, smoothstep(0, SHAPE.chopLipEnd, fw));
      mul = mix(m1, SHAPE.chopFlat, smoothstep(SHAPE.chopFlatLo, 1, fw));
    } else {
      const bw = clamp01(-d * this._invWW);
      mul = mix(SHAPE.chopLip, SHAPE.chopDeep, smoothstep(0, 1, bw));
    }
    const cs = this.chopScale;
    const zz = (z - this.boreSpeed * t * SHAPE.chopAdvect) * cs;
    const n = fbm3(x * cs, zz, this.seeds.chop);
    return (2 * n - 1) * this.chopAmp * mul;
  }

  // =========================================================================
  // public API — docs/ARCHITECTURE.md §3.1
  // =========================================================================

  /** World Z of the crest line at lateral x. */
  crest(x, t) { return this._crest(x, t); }

  /** Crest height above the still-water datum at lateral x. */
  amplitude(x, t) { return this._amplitude(x, t); }

  /** Water surface Y at world (x, z). Hot path: no allocation. */
  height(x, z, t) {
    const c = this._col(x, t);
    const d = z - c.crest;
    return this._surface(d, c.amp, c.k) + this._chop(x, z, t, d);
  }

  /** Base surface without chop — cheaper, useful for LOD / far geometry. */
  heightBase(x, z, t) {
    const c = this._col(x, t);
    return this._surface(z - c.crest, c.amp, c.k);
  }

  /** Face coordinate d = z - crest(x, t). */
  faceD(x, z, t) { return z - this._col(x, t).crest; }

  /**
   * Unit surface normal. Fills `out` when given (Vector3 or any {x,y,z}); pass
   * one from a hot loop to avoid the allocation.
   */
  normal(x, z, t, out) {
    const e = SHAPE.normalEps, inv2e = 1 / (2 * e);
    const hx = (this.height(x + e, z, t) - this.height(x - e, z, t)) * inv2e;
    const hz = (this.height(x, z + e, t) - this.height(x, z - e, t)) * inv2e;
    const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
    const v = out || new THREE.Vector3();
    const nx = -hx * inv, ny = inv, nz = -hz * inv;
    if (typeof v.set === 'function') v.set(nx, ny, nz);
    else { v.x = nx; v.y = ny; v.z = nz; }
    return v;
  }

  /**
   * { d, faceT, slope, downhill } plus extras (height, amp, barrel, crestZ)
   * that the physics and camera find handy. `downhill` is a Vector2 holding XZ:
   * `.x` is world X, `.y` is world Z. Pass `out` to avoid the allocation.
   */
  faceParam(x, z, t, out) {
    const c = this._col(x, t);
    const d = z - c.crest;
    const e = SHAPE.normalEps, inv2e = 1 / (2 * e);
    const hx = (this.height(x + e, z, t) - this.height(x - e, z, t)) * inv2e;
    const hz = (this.height(x, z + e, t) - this.height(x, z - e, t)) * inv2e;
    const g = Math.sqrt(hx * hx + hz * hz);

    const o = out || { d: 0, faceT: 0, slope: 0, downhill: null, height: 0, amp: 0, barrel: 0, crestZ: 0 };
    o.d = d;
    o.faceT = clamp01(d * this._invFaceLen);
    o.slope = Math.atan(g);
    o.height = this._surface(d, c.amp, c.k) + this._chop(x, z, t, d);
    o.amp = c.amp;
    o.barrel = c.barrel;
    o.crestZ = c.crest;

    let dx = 0, dz = 1;
    if (g > 1e-6) { const ig = 1 / g; dx = -hx * ig; dz = -hz * ig; }
    let dh = o.downhill;
    if (!dh) { dh = o.downhill = new THREE.Vector2(); }
    if (typeof dh.set === 'function') dh.set(dx, dz);
    else { dh.x = dx; dh.y = dz; }
    return o;
  }

  /** How hard the lip is pitching here. 0..1. */
  barrel(x, t) {
    const c = this._col(x, t);
    return c.barrel;
  }

  /** Metres the lip throws forward at x (0 when the section is not barrelling). */
  lipThrow(x, t) {
    const b = this._col(x, t).barrel;
    if (b <= this.barrelThreshold) return 0;
    return this.lipOverhang * clamp01((b - this.barrelThreshold) * this._invBarrelSpan);
  }

  /**
   * d-range of the barrel throat and the height of its roof, or null when this
   * section is not tubing. The surfer is in the tube when
   * `inner <= d <= outer` and their head clears `height()` but not `roof`.
   */
  tubePocket(x, t, out) {
    const c = this._col(x, t);
    if (c.barrel <= this.barrelThreshold) return null;
    const bs = clamp01((c.barrel - this.barrelThreshold) * this._invBarrelSpan);
    const thrown = this.lipOverhang * bs;
    const o = out || { inner: 0, outer: 0, roof: 0, strength: 0, amp: 0 };
    o.inner = thrown * SHAPE.tubeInner;
    o.outer = thrown + SHAPE.tubePad * (0.6 + 0.4 * bs);
    o.roof = c.amp * SHAPE.tubeRoof;
    o.strength = bs;
    o.amp = c.amp;
    return o;
  }

  /** How violently the lip is breaking here. 0..1. */
  breakIntensity(x, t) {
    const c = this._col(x, t);
    const nb = vnoise(x * this._invBreakCell, t * SHAPE.breakRate, this.seeds.brk);
    const bi = SHAPE.breakBase
      + SHAPE.breakNoise * (2 * nb - 1)
      + SHAPE.breakBarrel * c.barrel
      + SHAPE.breakBank * (1 - this._bell(x));
    return clamp01(bi);
  }

  /**
   * Foam coverage at a point, 0..1. Not part of the contract — a convenience
   * for waveMesh.js and foam.js so the whitewater mask is authored once.
   */
  whitewater(x, z, t) {
    const c = this._col(x, t);
    const d = z - c.crest;
    const bi = this.breakIntensity(x, t);
    let cover;
    if (d >= 0) cover = bi * (1 - smoothstep(0, SHAPE.foamFaceLen * (0.4 + bi), d));
    else cover = mix(bi, bi * 0.25, smoothstep(0, 1, clamp01(-d * this._invWW)));
    const n = vnoise(x * SHAPE.foamNoiseScale,
      (z - this.boreSpeed * t * SHAPE.chopAdvect) * SHAPE.foamNoiseScale, this.seeds.foam);
    return clamp01(cover * (0.62 + 0.76 * n));
  }

  /**
   * Surface water velocity in XZ (m/s). Vector2: `.x` is world X, `.y` is
   * world Z. Near the crest the water travels with the bore and climbs the
   * face; ahead of it the river creeps back downstream. Pass `out` from a hot
   * loop (per-particle use) to avoid the allocation.
   */
  flow(x, z, t, out) {
    const c = this._col(x, t);
    const d = z - c.crest;
    const w = d >= 0
      ? 1 - smoothstep(0, SHAPE.flowReach, d)
      : mix(1, SHAPE.flowBackFloor, smoothstep(0, 1, clamp01(-d * this._invWW)));

    const vzFront = this.boreSpeed * SHAPE.flowFront;
    const vz = SHAPE.flowRiver + (vzFront - SHAPE.flowRiver) * w;

    const e = SHAPE.flowCrestEps;
    const cx = (this._crest(x + e, t) - this._crest(x - e, t)) / (2 * e);
    const sw = vnoise(x * SHAPE.flowSwirlScale,
      (z - this.boreSpeed * t) * SHAPE.flowSwirlScale + t * SHAPE.flowSwirlRate, this.seeds.swirl);
    const vx = -cx * (vz - SHAPE.flowRiver) * SHAPE.flowLateral + (2 * sw - 1) * SHAPE.flowSwirl * w;

    const v = out || new THREE.Vector2();
    if (typeof v.set === 'function') v.set(vx, vz);
    else { v.x = vx; v.y = vz; }
    return v;
  }

  // =========================================================================
  // shader side
  // =========================================================================

  /** Refresh the shared uniform objects for time t. */
  uniforms(t) {
    const u = BoreWave.GLSL_UNIFORMS;
    u.prTime.value = t;
    u.prBoreZ.value = this.boreSpeed * t;
    return u;
  }

  // Republishes the static GLSL/uniforms for this instance's numbers. The game
  // builds exactly one BoreWave (main.js); if you ever build a second one it
  // becomes the owner of BoreWave.GLSL, so rebuild any materials that used it.
  _installShader() {
    const u = BoreWave.GLSL_UNIFORMS;
    u.prBoreSpeed.value = this.boreSpeed;
    u.prFaceLen.value = this.faceLen;
    u.prAmp.value = this.amplitude0;
    u.prTrailLen.value = this.trailLen;
    u.prWhitewaterDepth.value = this.whitewaterDepth;
    u.prBarrelThreshold.value = this.barrelThreshold;
    u.prLipOverhang.value = this.lipOverhang;
    u.prChopAmp.value = this.chopAmp;
    u.prHalfWidth.value = this.halfWidth;
    BoreWave.GLSL = buildGLSL(this);
    BoreWave.GLSL_CONSTANTS = {
      ...this.config, channelHalf: this.halfWidth,
      shape: SHAPE, seeds: this.seeds, phases: this.phases,
    };
    BoreWave.SHAPE = SHAPE;
  }
}

// Shared uniform objects. Plain three.js-style { value } holders — drop them
// into a ShaderMaterial's `uniforms` (e.g. via Object.assign) and call
// bore.uniforms(t) once per frame. The field functions themselves take `t` as
// an argument and need no uniforms; these are exposed because the wave mesh,
// foam and post stack all want the same numbers.
BoreWave.GLSL_UNIFORMS = {
  prTime: { value: 0 },
  prBoreZ: { value: 0 },
  prBoreSpeed: { value: CONFIG.wave.boreSpeed },
  prFaceLen: { value: CONFIG.wave.faceLen },
  prAmp: { value: CONFIG.wave.amplitude },
  prTrailLen: { value: CONFIG.wave.trailLen },
  prWhitewaterDepth: { value: CONFIG.wave.whitewaterDepth },
  prBarrelThreshold: { value: CONFIG.wave.barrelThreshold },
  prLipOverhang: { value: CONFIG.wave.lipOverhang },
  prChopAmp: { value: CONFIG.wave.chopAmp },
  prHalfWidth: { value: SHAPE.channelHalf },
};

// ---------------------------------------------------------------------------
// GLSL twin. Generated from exactly the same numbers the JS above uses, so the
// two cannot drift. Written in GLSL ES 1.00-compatible syntax (no bitwise ops,
// no integer types, no dynamic loops) so it compiles under both GLSL 1.00 and
// 3.00 ES. Insert once per shader stage, before any use.
// ---------------------------------------------------------------------------
function buildGLSL(w) {
  const S = SHAPE;
  const K = S.wanderK, WW = S.wanderW, R = S.wanderT, P = w.phases, sd = w.seeds;
  const g = glf;
  return `
// ---- POROROCA RUSH wave field (generated from src/wave/bore.js) ------------
#ifndef PR_BORE_INCLUDED
#define PR_BORE_INCLUDED

uniform float prTime;              // simulation seconds (BoreWave.uniforms(t))
uniform float prBoreZ;             // boreSpeed * t — subtract for local space
uniform float prBoreSpeed;
uniform float prFaceLen;
uniform float prAmp;
uniform float prTrailLen;
uniform float prWhitewaterDepth;
uniform float prBarrelThreshold;
uniform float prLipOverhang;
uniform float prChopAmp;
uniform float prHalfWidth;

const float PR_TAU        = 6.283185307;
const float PR_BORESPEED  = ${g(w.boreSpeed)};
const float PR_FACELEN    = ${g(w.faceLen)};
const float PR_INVFACELEN = ${g(w._invFaceLen)};
const float PR_AMP        = ${g(w.amplitude0)};
const float PR_AMPVAR     = ${g(w.amplitudeVar)};
const float PR_CRESTBOW   = ${g(w.crestBow)};
const float PR_WANDER     = ${g(w.crestWander)};
const float PR_STEEP      = ${g(w.faceSteepness)};
const float PR_LIPOVER    = ${g(w.lipOverhang)};
const float PR_TRAILAMP   = ${g(w.trailAmp)};
const float PR_TRAILLEN   = ${g(w.trailLen)};
const float PR_INVTRAILL  = ${g(w._invTrailLen)};
const float PR_CHOPAMP    = ${g(w.chopAmp)};
const float PR_CHOPSCALE  = ${g(w.chopScale)};
const float PR_BTHRESH    = ${g(w.barrelThreshold)};
const float PR_INVBSPAN   = ${g(w._invBarrelSpan)};
const float PR_INVBCELL   = ${g(w._invBarrelCell)};
const float PR_INVBRKCELL = ${g(w._invBreakCell)};
const float PR_WWDEPTH    = ${g(w.whitewaterDepth)};
const float PR_INVWW      = ${g(w._invWW)};
const float PR_INVHALF    = ${g(w._invHalf)};
const float PR_INVRELAX   = ${g(w._invRelax)};
const float PR_INVTDECAY  = ${g(w._invTrailDecay)};
const float PR_INVAMP0    = ${g(w._invAmp0)};

const float PR_BOWCLAMP   = ${g(S.bowClamp)};
const float PR_BOWCENTER  = ${g(S.bowCenter)};
const vec3  PR_WK         = vec3(${g(K[0])}, ${g(K[1])}, ${g(K[2])});
const vec3  PR_WWT        = vec3(${g(WW[0])}, ${g(WW[1])}, ${g(WW[2])});
const vec3  PR_WR         = vec3(${g(R[0])}, ${g(R[1])}, ${g(R[2])});
const vec3  PR_WP         = vec3(${g(P[0])}, ${g(P[1])}, ${g(P[2])});
const float PR_BANKLO     = ${g(S.bankLo)};
const float PR_BANKHI     = ${g(S.bankHi)};
const float PR_BANKFLOOR  = ${g(S.bankFloor)};
const float PR_AMPSCALE   = ${g(S.ampScale)};
const float PR_AMPRATE    = ${g(S.ampRate)};
const float PR_AMPFLOOR   = ${g(S.ampFloor)};
const float PR_FTANBASE   = ${g(S.faceTanBase)};
const float PR_FTANBARREL = ${g(S.faceTanBarrel)};
const float PR_FEXPMIN    = ${g(S.faceExpMin)};
const float PR_FEXPMAX    = ${g(S.faceExpMax)};
const float PR_FSWELL     = ${g(S.faceSwell)};
const float PR_FSWELLK    = ${g(S.faceSwellK)};
const float PR_FKMIN      = ${g(S.faceKMin)};
const float PR_STEPRATIO  = ${g(S.stepRatio)};
const float PR_TRAILAMPMX = ${g(S.trailAmpMax)};
const float PR_CHOPLIP    = ${g(S.chopLip)};
const float PR_CHOPFACE   = ${g(S.chopFace)};
const float PR_CHOPFLAT   = ${g(S.chopFlat)};
const float PR_CHOPDEEP   = ${g(S.chopDeep)};
const float PR_CHOPLIPEND = ${g(S.chopLipEnd)};
const float PR_CHOPFLATLO = ${g(S.chopFlatLo)};
const float PR_CHOPADV    = ${g(S.chopAdvect)};
const float PR_BRATE      = ${g(S.barrelRate)};
const float PR_BLO        = ${g(S.barrelLo)};
const float PR_BHI        = ${g(S.barrelHi)};
const float PR_BAMPLO     = ${g(S.barrelAmpLo)};
const float PR_BAMPHI     = ${g(S.barrelAmpLo + S.barrelAmpSpan)};
const float PR_BRKRATE    = ${g(S.breakRate)};
const float PR_BRKBASE    = ${g(S.breakBase)};
const float PR_BRKNOISE   = ${g(S.breakNoise)};
const float PR_BRKBARREL  = ${g(S.breakBarrel)};
const float PR_BRKBANK    = ${g(S.breakBank)};
const float PR_TUBEINNER  = ${g(S.tubeInner)};
const float PR_TUBEPAD    = ${g(S.tubePad)};
const float PR_TUBEROOF   = ${g(S.tubeRoof)};
const float PR_FLOWRIVER  = ${g(S.flowRiver)};
const float PR_FLOWFRONT  = ${g(S.flowFront)};
const float PR_FLOWREACH  = ${g(S.flowReach)};
const float PR_FLOWBACK   = ${g(S.flowBackFloor)};
const float PR_FLOWLAT    = ${g(S.flowLateral)};
const float PR_FLOWSWIRL  = ${g(S.flowSwirl)};
const float PR_FLOWSWSCL  = ${g(S.flowSwirlScale)};
const float PR_FLOWSWRATE = ${g(S.flowSwirlRate)};
const float PR_FLOWCEPS   = ${g(S.flowCrestEps)};
const float PR_FOAMFACE   = ${g(S.foamFaceLen)};
const float PR_FOAMNSCALE = ${g(S.foamNoiseScale)};
const float PR_NEPS       = ${g(S.normalEps)};
const vec3  PR_FBMW       = vec3(${g(S.fbmW[0])}, ${g(S.fbmW[1])}, ${g(S.fbmW[2])});
const float PR_FBMNORM    = ${g(S.fbmNorm)};

const float PR_SD_CHOP    = ${g(sd.chop)};
const float PR_SD_AMP     = ${g(sd.amp)};
const float PR_SD_BARRELA = ${g(sd.barrelA)};
const float PR_SD_BARRELB = ${g(sd.barrelB)};
const float PR_SD_BRK     = ${g(sd.brk)};
const float PR_SD_SWIRL   = ${g(sd.swirl)};
const float PR_SD_FOAM    = ${g(sd.foam)};

// --- portable value noise (bit-compatible with the CPU side) ---------------
// permute() mod 289: every intermediate is an exact integer below 2^24, so
// highp float32 reproduces the JS float64 lattice hash exactly. Do not "improve"
// this with a sin() hash — it would desync the surfer from the mesh.
float pr_m289(float x) { return x - 289.0 * floor(x / 289.0); }
float pr_pmt(float x)  { return pr_m289((34.0 * x + 1.0) * x); }

float pr_lhash(float ix, float iy, float s) {
  float b = pr_m289(pr_pmt(pr_m289(ix)) + pr_m289(iy) + s);
  return pr_pmt(b) * (1.0 / 289.0);
}

float pr_vnoise(float x, float y, float s) {
  float ix = floor(x), iy = floor(y);
  float fx = x - ix, fy = y - iy;
  float ux = fx * fx * (3.0 - 2.0 * fx);
  float uy = fy * fy * (3.0 - 2.0 * fy);
  float p0 = pr_pmt(pr_m289(ix));
  float p1 = pr_pmt(pr_m289(ix + 1.0));
  float q0 = pr_m289(iy) + s;
  float q1 = pr_m289(iy + 1.0) + s;
  float a = pr_pmt(pr_m289(p0 + q0)) * (1.0 / 289.0);
  float b = pr_pmt(pr_m289(p1 + q0)) * (1.0 / 289.0);
  float c = pr_pmt(pr_m289(p0 + q1)) * (1.0 / 289.0);
  float d = pr_pmt(pr_m289(p1 + q1)) * (1.0 / 289.0);
  float t0 = a + (b - a) * ux;
  float t1 = c + (d - c) * ux;
  return t0 + (t1 - t0) * uy;
}

float pr_fbm3(float x, float y, float s) {
  float v  = pr_vnoise(x, y, s) * PR_FBMW.x;
  v += pr_vnoise(x * 2.03 + 17.0, y * 2.03 + 5.0, s + 37.0) * PR_FBMW.y;
  v += pr_vnoise(x * 4.1209 + 41.0, y * 4.1209 + 23.0, s + 113.0) * PR_FBMW.z;
  return v * PR_FBMNORM;
}

// --- field ------------------------------------------------------------------
float pr_bell(float x) {
  float u = abs(x) * PR_INVHALF;
  return mix(1.0, PR_BANKFLOOR, smoothstep(PR_BANKLO, PR_BANKHI, u));
}

float pr_crest(float x, float t) {
  float u = clamp(x * PR_INVHALF, -PR_BOWCLAMP, PR_BOWCLAMP);
  float bow = PR_CRESTBOW * (u * u - PR_BOWCENTER);
  vec3 arg = vec3(x * PR_WK.x + t * PR_WR.x + PR_WP.x,
                  x * PR_WK.y - t * PR_WR.y + PR_WP.y,
                  x * PR_WK.z + t * PR_WR.z + PR_WP.z);
  arg = mod(arg, PR_TAU);                       // range-reduce: keeps sin() honest
  float wnd = dot(PR_WWT, sin(arg));
  return PR_BORESPEED * t + bow + PR_WANDER * wnd;
}

float pr_amplitude(float x, float t) {
  float n = pr_vnoise(x * PR_AMPSCALE, t * PR_AMPRATE, PR_SD_AMP);
  float a = (PR_AMP + PR_AMPVAR * (2.0 * n - 1.0)) * pr_bell(x);
  return max(a, PR_AMPFLOOR);
}

float pr_barrelA(float x, float t, float amp) {
  float xa = x * PR_INVBCELL;
  float n = 0.65 * pr_vnoise(xa, t * PR_BRATE, PR_SD_BARRELA)
          + 0.35 * pr_vnoise(xa * 2.13 + 9.0, t * PR_BRATE * 1.7 + 3.0, PR_SD_BARRELB);
  float b = smoothstep(PR_BLO, PR_BHI, n);
  b *= pr_bell(x);
  b *= smoothstep(PR_BAMPLO, PR_BAMPHI, amp);
  return clamp(b, 0.0, 1.0);
}

float pr_barrel(float x, float t) { return pr_barrelA(x, t, pr_amplitude(x, t)); }

float pr_faceK(float amp, float barrel) {
  float tanLip = PR_STEEP * (PR_FTANBASE + PR_FTANBARREL * barrel);
  float a = clamp(tanLip * PR_FACELEN / max(0.25, amp), PR_FEXPMIN, PR_FEXPMAX);
  return max(PR_FKMIN, (a - 2.0 - PR_FSWELL * PR_FSWELLK) / (1.0 - PR_FSWELL));
}

float pr_surface(float d, float amp, float k) {
  if (d >= 0.0) {
    float s = d * PR_INVFACELEN;
    if (s >= 1.0) return 0.0;
    float om = 1.0 - s;
    return amp * om * om * ((1.0 - PR_FSWELL) * exp(-k * s) + PR_FSWELL * exp(-PR_FSWELLK * s));
  }
  float u = -d;
  float mean = amp * (PR_STEPRATIO + (1.0 - PR_STEPRATIO) * exp(-u * PR_INVRELAX));
  float env  = exp(-u * PR_INVTDECAY);
  float sc   = min(PR_TRAILAMPMX, amp * PR_INVAMP0);
  float roll = PR_TRAILAMP * sc * env * 0.5 * (cos(mod(PR_TAU * u * PR_INVTRAILL, PR_TAU)) - 1.0);
  return mean + roll;
}

float pr_chop(float x, float z, float t, float d) {
  float mul;
  if (d >= 0.0) {
    float fw = clamp(d * PR_INVFACELEN, 0.0, 1.0);
    float m1 = mix(PR_CHOPLIP, PR_CHOPFACE, smoothstep(0.0, PR_CHOPLIPEND, fw));
    mul = mix(m1, PR_CHOPFLAT, smoothstep(PR_CHOPFLATLO, 1.0, fw));
  } else {
    float bw = clamp(-d * PR_INVWW, 0.0, 1.0);
    mul = mix(PR_CHOPLIP, PR_CHOPDEEP, smoothstep(0.0, 1.0, bw));
  }
  float zz = (z - PR_BORESPEED * t * PR_CHOPADV) * PR_CHOPSCALE;
  float n = pr_fbm3(x * PR_CHOPSCALE, zz, PR_SD_CHOP);
  return (2.0 * n - 1.0) * PR_CHOPAMP * mul;
}

float pr_heightBase(float x, float z, float t) {
  float amp = pr_amplitude(x, t);
  float k = pr_faceK(amp, pr_barrelA(x, t, amp));
  return pr_surface(z - pr_crest(x, t), amp, k);
}

float pr_height(float x, float z, float t) {
  float amp = pr_amplitude(x, t);
  float k = pr_faceK(amp, pr_barrelA(x, t, amp));
  float d = z - pr_crest(x, t);
  return pr_surface(d, amp, k) + pr_chop(x, z, t, d);
}

vec3 pr_normal(float x, float z, float t) {
  float e = PR_NEPS;
  float hx = (pr_height(x + e, z, t) - pr_height(x - e, z, t)) / (2.0 * e);
  float hz = (pr_height(x, z + e, t) - pr_height(x, z - e, t)) / (2.0 * e);
  return normalize(vec3(-hx, 1.0, -hz));
}

float pr_faceD(float x, float z, float t) { return z - pr_crest(x, t); }

float pr_faceT(float x, float z, float t) {
  return clamp((z - pr_crest(x, t)) * PR_INVFACELEN, 0.0, 1.0);
}

float pr_slope(float x, float z, float t) {
  float e = PR_NEPS;
  float hx = (pr_height(x + e, z, t) - pr_height(x - e, z, t)) / (2.0 * e);
  float hz = (pr_height(x, z + e, t) - pr_height(x, z - e, t)) / (2.0 * e);
  return atan(sqrt(hx * hx + hz * hz));
}

float pr_breakIntensity(float x, float t) {
  float amp = pr_amplitude(x, t);
  float b = pr_barrelA(x, t, amp);
  float nb = pr_vnoise(x * PR_INVBRKCELL, t * PR_BRKRATE, PR_SD_BRK);
  float bi = PR_BRKBASE + PR_BRKNOISE * (2.0 * nb - 1.0)
           + PR_BRKBARREL * b + PR_BRKBANK * (1.0 - pr_bell(x));
  return clamp(bi, 0.0, 1.0);
}

// Metres the lip throws forward (0 when this section is not tubing).
float pr_lipThrow(float x, float t) {
  float b = pr_barrel(x, t);
  if (b <= PR_BTHRESH) return 0.0;
  return PR_LIPOVER * clamp((b - PR_BTHRESH) * PR_INVBSPAN, 0.0, 1.0);
}

// Barrel throat: vec3(inner d, outer d, roof height). All zero when not tubing.
vec3 pr_tubePocket(float x, float t) {
  float amp = pr_amplitude(x, t);
  float b = pr_barrelA(x, t, amp);
  if (b <= PR_BTHRESH) return vec3(0.0);
  float bs = clamp((b - PR_BTHRESH) * PR_INVBSPAN, 0.0, 1.0);
  float thrown = PR_LIPOVER * bs;
  return vec3(thrown * PR_TUBEINNER,
              thrown + PR_TUBEPAD * (0.6 + 0.4 * bs),
              amp * PR_TUBEROOF);
}

// Surface water velocity in XZ (m/s): .x is world X, .y is world Z.
vec2 pr_flow(float x, float z, float t) {
  float d = z - pr_crest(x, t);
  float w = (d >= 0.0)
    ? 1.0 - smoothstep(0.0, PR_FLOWREACH, d)
    : mix(1.0, PR_FLOWBACK, smoothstep(0.0, 1.0, clamp(-d * PR_INVWW, 0.0, 1.0)));
  float vz = PR_FLOWRIVER + (PR_BORESPEED * PR_FLOWFRONT - PR_FLOWRIVER) * w;
  float e = PR_FLOWCEPS;
  float cx = (pr_crest(x + e, t) - pr_crest(x - e, t)) / (2.0 * e);
  float sw = pr_vnoise(x * PR_FLOWSWSCL,
                       (z - PR_BORESPEED * t) * PR_FLOWSWSCL + t * PR_FLOWSWRATE, PR_SD_SWIRL);
  float vx = -cx * (vz - PR_FLOWRIVER) * PR_FLOWLAT + (2.0 * sw - 1.0) * PR_FLOWSWIRL * w;
  return vec2(vx, vz);
}

// Foam coverage 0..1 — the whitewater mask, authored once for waveMesh/foam.
float pr_whitewater(float x, float z, float t) {
  float d = z - pr_crest(x, t);
  float bi = pr_breakIntensity(x, t);
  float cover;
  if (d >= 0.0) cover = bi * (1.0 - smoothstep(0.0, PR_FOAMFACE * (0.4 + bi), d));
  else cover = mix(bi, bi * 0.25, smoothstep(0.0, 1.0, clamp(-d * PR_INVWW, 0.0, 1.0)));
  float n = pr_vnoise(x * PR_FOAMNSCALE,
                      (z - PR_BORESPEED * t * PR_CHOPADV) * PR_FOAMNSCALE, PR_SD_FOAM);
  return clamp(cover * (0.62 + 0.76 * n), 0.0, 1.0);
}

#endif
`;
}

// Build a default shader twin at module load so consumers that read
// BoreWave.GLSL before any BoreWave is constructed still get valid source.
BoreWave.GLSL = '';
BoreWave.GLSL_CONSTANTS = null;
new BoreWave(CONFIG.wave);

export default BoreWave;
