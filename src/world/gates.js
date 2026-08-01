// POROROCA RUSH — src/world/gates.js
//
// THE COURSE. Twelve buoy gates strung up the channel: a pair of moored floats
// with a mast and a bandeirola on each, and the surfer has to thread the middle.
// The gates zig-zag across the navigable channel, so holding one line for four
// minutes is not a run — you have to move.
//
// Coordinate contract (docs/ARCHITECTURE.md §1):
//   +X lateral · +Y up · +Z = the direction the bore travels.
//   d = z - bore.crest(x, t):  d > 0 = the unbroken, surfable face.
//
// WHY THE GATES SIT AT FIXED WORLD Z
// ----------------------------------
// `state.bore.z` is integrated as `bore.z += boreSpeed * dt` from 0, so it is
// exactly `boreSpeed * t` — the bore's arrival at a world Z is a pure function of
// that Z. Anchoring gate k at `z = k * spacing` is therefore *identical* to a
// bore-relative schedule (`gate k arrives at t = k*spacing/boreSpeed`), and it
// gets two things a bore-relative offset cannot:
//   * the course is a real thing moored in the river — it does not slide along
//     under the player, and the buoys sit still while the wave moves through them;
//   * `race.js` measures `distance` off the very same `bore.z`, so gate k is
//     crossed within a couple of seconds of `race:checkpoint {index: k}`.
// The bore can never outrun the course, because the surfer's `d` is bounded by
// physics (`loseBehind` / `loseAhead`), so `player.z` is pinned to `crest ± 35 m`
// for the whole run. Verified over 240 s of simulation, see the module report.
//
// DETECTION
// ---------
// A gate is a *segment* between its two buoys. Every fixed step we take the
// signed area (2-D cross product) of the segment against the previous and the
// current player position; a change of sign is a crossing of the gate's infinite
// line, and the crossing point is interpolated and projected onto the segment:
// inside → `gate:pass`, outside → `gate:miss`. Because it is a segment crossing
// and not a proximity test, it cannot tunnel — at any step size, if the player
// went from one side to the other the sign flipped.
//
// This module DETECTS ONLY. Scoring and checkpoint progression belong to
// scoring.js and race.js; we just put the events on the bus.
//
// Deterministic: no Math.random(), everything seeded off CONFIG.seed and
// integrated with dt.

import * as THREE_NS from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { hash2 } from '../core/rng.js';

const TAU = Math.PI * 2;

// ------------------------------------------------------------------ tunables --

const LAYOUT = {
  widthStart: 34.0,     // metres between the buoys at the first gate — generous
  widthEnd: 16.0,       // ... and at the last one — the course tightens
  widthJitter: 1.8,
  swingStart: 34.0,     // lateral throw of the serpentine, first gate
  swingEnd: 52.0,       // ... last gate: further to travel, narrower to hit
  swingMin: 0.55,       // seeded magnitude lives in [swingMin, 1] * swing
  bankMargin: 38.0,     // open water kept between the outer buoy and the bank
  // physics/_channel soft-guards the surfer past 0.55 * riverWidth/2 (~93 m off
  // the channel axis). A gate the surfer has to fight the guard to reach is a
  // broken gate, so the whole course lives well inside that.
  corridorHalf: 78.0,
};

const DETECT = {
  latchBehind: 8.0,     // metres past an unresolved gate before it counts as missed
  teleportBase: 4.0,    // single-step displacement that can only be a reset...
  teleportRate: 50.0,   // ... scaled for absurd dt (max real motion is 0.2 m/step)
};

const VIEW = {
  behind: 220,          // metres of course kept instanced behind the player
  ahead: 1400,          // ... and ahead
  maxBuoys: 24,         // instanced capacity (12 gates x 2 fits with room to spare)
  mastTop: 3.45,        // local Y of the flag halyard
  lampY: 2.86,          // local Y of the lantern
};

// Float dynamics. Not a rigid-body sim — a critically-ish damped heave that
// chases `bore.height()`, plus the shove the breaking front gives it.
const FLOAT = {
  spring: 52.0,         // rad^2/s^2 — ~1.15 Hz bob
  damp: 9.0,
  vyMin: -9, vyMax: 11,
  tossUp: 24.0,         // m/s^2 of extra lift right under the breaking lip
  tossSpin: 5.2,        // rad/s^2 of yaw the surge puts into a moored float
  shake: 0.55,          // radians of extra thrash on the tilt
  tiltRate: 5.5,        // how fast the hull settles onto the water normal
  yawDamp: 1.5,
  kickFront: 13.0,      // d ahead of the crest where the surge starts to bite
  kickBack: -9.0,       // ... and behind it where it lets go
};

// Per-state instance tint. Multiplies the baked vertex colours.
const TINT = {
  pending: [0.90, 0.88, 0.84],
  next: [1.32, 1.14, 0.86],
  passed: [0.46, 0.44, 0.42],
  missed: [0.80, 0.33, 0.26],
};

// ------------------------------------------------------------------ helpers --

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Deterministic 0..1 from a float pair — hash2 wants integers. */
function nz(a, b, seed) {
  return hash2(Math.round(a * 64), Math.round(b * 64), seed);
}

/** Bake a per-vertex colour so one material can render every painted part. */
function paint(THREE, geo, fn) {
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.setRGB(1, 1, 1);
    fn(c, pos.getX(i), pos.getY(i), pos.getZ(i));
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Give a geometry the attribute set mergeGeometries insists on. */
function normalise(THREE, geo) {
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.color) paint(THREE, geo, () => {});
  return geo;
}

function mergeAll(THREE, parts) {
  if (parts.length === 1) return normalise(THREE, parts[0]);
  const merged = mergeGeometries(parts.map((p) => normalise(THREE, p)), false);
  if (!merged) return normalise(THREE, parts[0]);
  for (const p of parts) p.dispose();
  return merged;
}

// ----------------------------------------------------------------- geometry --

/**
 * One moored float. Authored with **y = 0 on the waterline** so the instance
 * matrix can put it straight onto `bore.height()`.
 *
 * A ribeirinho river marker, not a traffic cone: a sun-bleached plastic drum
 * lashed with hemp, a rusted iron hoop round its belly, a skirt of algae at the
 * waterline, a thin hardwood mast for the bandeirola and the mooring line
 * trailing away underneath.
 */
function makeBuoy(THREE, seed) {
  const parts = [];

  // --- float body (lathe: drum belly, narrow neck) ---------------------------
  const profile = [
    [0.00, -0.58], [0.17, -0.55], [0.31, -0.46], [0.41, -0.28],
    [0.45, -0.06], [0.445, 0.12], [0.385, 0.28], [0.275, 0.40],
    [0.155, 0.47], [0.105, 0.55], [0.105, 0.66], [0.00, 0.68],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const body = new THREE.LatheGeometry(profile, 16);
  paint(THREE, body, (c, x, y, z) => {
    const g = nz(x * 3 + z * 5, y * 9, seed);
    if (y < -0.30) {
      // deep, permanently wet: dark silt-stained plastic
      c.setHex(0x6b4a24).multiplyScalar(0.70 + g * 0.34);
    } else if (y < 0.02) {
      // the algae skirt right on the waterline
      c.setHex(0x3d4a24).multiplyScalar(0.62 + g * 0.62);
    } else if (y < 0.10) {
      // scum line: bleached, crusty
      c.setHex(0xb99a63).multiplyScalar(0.78 + g * 0.40);
    } else {
      // faded orange drum, chalky where the sun has been on it for years
      c.setHex(g > 0.62 ? 0xd8a24a : 0xc8701f).multiplyScalar(0.80 + g * 0.42);
    }
  });
  parts.push(body);

  // --- rusted iron hoop round the belly --------------------------------------
  const hoop = new THREE.TorusGeometry(0.452, 0.030, 5, 18);
  hoop.rotateX(Math.PI / 2);
  hoop.translate(0, 0.02, 0);
  paint(THREE, hoop, (c, x, y, z) => {
    const g = nz(x * 7, z * 7, seed + 5);
    c.setHex(g > 0.5 ? 0x8a4a24 : 0x5a3a26).multiplyScalar(0.72 + g * 0.5);
  });
  parts.push(hoop);

  // --- hemp lashing round the shoulder and the neck --------------------------
  for (const [r, y, tube] of [[0.305, 0.345, 0.026], [0.132, 0.585, 0.023], [0.132, 0.638, 0.023]]) {
    const rope = new THREE.TorusGeometry(r, tube, 4, 14);
    rope.rotateX(Math.PI / 2);
    rope.translate(0, y, 0);
    paint(THREE, rope, (c, x, y2, z) => {
      const g = nz(x * 11, z * 11, seed + 9);
      c.setHex(0xa8875a).multiplyScalar(0.66 + g * 0.52);
    });
    parts.push(rope);
  }

  // --- mast: a thin hardwood pole. The silhouette is the gameplay: at 200 m
  //     this dark vertical against bright water is what tells you a gate is
  //     coming while there is still time to steer for it.
  const mast = new THREE.CylinderGeometry(0.028, 0.044, 2.86, 6, 1, false);
  mast.translate(0, 0.66 + 1.43, 0);
  paint(THREE, mast, (c, x, y, z) => {
    const g = nz(x * 21 + z * 13, y * 4, seed + 13);
    c.setHex(0x3a2a19).multiplyScalar(0.74 + g * 0.46);
  });
  parts.push(mast);

  // collar where the mast is stepped into the drum
  const collar = new THREE.CylinderGeometry(0.072, 0.092, 0.10, 7, 1, false);
  collar.translate(0, 0.70, 0);
  paint(THREE, collar, (c) => c.setHex(0x8a6c40));
  parts.push(collar);

  // --- mooring line, trailing down to the poita. Only ever visible when the
  //     bore lifts the float clear of the water — which is exactly the moment
  //     it sells that these things are anchored and the river is moving.
  const line = new THREE.CylinderGeometry(0.017, 0.017, 1.70, 4, 1, false);
  line.rotateZ(0.24);
  line.translate(0.16, -1.42, 0.05);
  paint(THREE, line, (c, x, y, z) => {
    const g = nz(x * 17, z * 17, seed + 17);
    c.setHex(0x2e2418).multiplyScalar(0.7 + g * 0.6);
  });
  parts.push(line);

  return mergeAll(THREE, parts);
}

/**
 * The bandeirola. Origin sits at the halyard so the instance matrix is just
 * `buoyMatrix * translate(0, mastTop, 0) * scale(emph)`. Cream cloth with a
 * teal fly — teal is the boat paint of the region and it is the one hue that
 * still reads against an amber sunset.
 */
function makeFlag(THREE) {
  const NSEG = 6, LEN = 0.98;
  const pos = [], col = [], uv = [], idx = [];
  const c = new THREE.Color();
  for (let i = 0; i <= NSEG; i++) {
    const u = i / NSEG;
    const x = u * LEN;
    const top = -0.03 - 0.02 * u;
    const drop = lerp(0.36, 0.13, u);
    const z = 0.115 * Math.sin(u * 4.1) * u;      // baked flutter
    pos.push(x, top, z, x, top - drop, z);
    uv.push(u, 1, u, 0);
    for (let k = 0; k < 2; k++) {
      if (u < 0.055) c.setHex(0x2a2018);           // dark hoist tape
      else if (u < 0.60) c.setHex(0xe6d8bc);       // cream cloth
      else c.setHex(0x2f6f7c);                     // teal fly
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NSEG; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The lantern on the next gate's masts — a lamparina, not a runway light. */
function makeLamp(THREE) {
  const parts = [];
  const glass = new THREE.SphereGeometry(0.088, 8, 6);
  paint(THREE, glass, (c) => c.setRGB(1, 0.78, 0.44));
  parts.push(glass);
  const cap = new THREE.CylinderGeometry(0.052, 0.072, 0.055, 6, 1, false);
  cap.translate(0, 0.105, 0);
  paint(THREE, cap, (c) => c.setRGB(0.30, 0.22, 0.15));
  parts.push(cap);
  return mergeAll(THREE, parts);
}

// ======================================================================== ===
export class Gates {
  /** @param {object} ctx { THREE, scene, state, bus, bore, config, river } */
  constructor(ctx = {}) {
    const THREE = ctx.THREE || THREE_NS;
    this.THREE = THREE;
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.state = ctx.state || null;
    this.bus = ctx.bus || null;
    this.bore = ctx.bore || null;

    const cfg = ctx.config || CONFIG;
    this.config = cfg;
    const race = cfg.race || CONFIG.race;
    this.world = cfg.world || CONFIG.world;
    this.seed = (num(cfg.seed, CONFIG.seed) | 0) || 1;

    this.total = Math.max(1, Math.floor(num(race.checkpoints, 12)));
    this.courseLength = Math.max(50, num(race.courseLength, 2000));
    this.spacing = this.courseLength / this.total;

    this.t = 0;
    this.enabled = true;
    this._boreFails = 0;
    this._built = false;
    this._laid = false;

    this.gates = [];
    this.buoys = [];       // flat list, 2 per gate, in course order
    this._nextIdx = 0;     // index into this.gates of the first unresolved gate

    // previous player position for the segment-crossing test
    this._px = 0; this._pz = 0; this._hasPrev = false;

    // --- bore capability probe (bore.js is a parallel module) ----------------
    const B = this.bore;
    this._hasCrest = !!(B && typeof B.crest === 'function');
    this._hasHeight = !!(B && typeof B.height === 'function');
    this._hasNormal = !!(B && typeof B.normal === 'function');
    this._hasBreak = !!(B && typeof B.breakIntensity === 'function');

    // --- scratch (never allocate per frame) ---------------------------------
    this._n = new THREE.Vector3(0, 1, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._nrm = new THREE.Vector3(0, 1, 0);
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._mLocal = new THREE.Matrix4();
    this._mOut = new THREE.Matrix4();
    this._bearing = { dist: 0, angle: 0, index: 0, gate: null };

    this.group = new THREE.Group();
    this.group.name = 'gates';
    this._geos = [];
    this._mats = [];
    this.buoyMesh = null;
    this.flagMesh = null;
    this.lampMesh = null;

    try {
      this._build(THREE);
      this._built = true;
    } catch (err) {
      this.enabled = false;
      console.warn('[gates] mesh build failed, running headless:', err && err.message);
    }
    if (this.scene && this.group.children.length) this.scene.add(this.group);

    // Publish before anything else can ask for us.
    ctx.gates = this;

    // The course itself needs river.js for the channel centreline, and module
    // construction order is the integrator's business — so lay it out lazily and
    // let every public entry point make sure it exists first.
    this._ensureCourse();
  }

  // ======================================================================= API

  /**
   * The gate the surfer is currently heading for — the first one neither passed
   * nor missed. `null` once the course is finished.
   * @returns {{index:number,x:number,z:number,width:number,passed:boolean,missed:boolean}|null}
   */
  next() {
    this._ensureCourse();
    for (let i = this._nextIdx; i < this.gates.length; i++) {
      if (!this.gates[i].resolved) return this.gates[i];
    }
    return null;
  }

  /**
   * Every gate of the course, in order, for the HUD and the minimap. Live
   * records — read them, do not mutate them.
   */
  all() {
    this._ensureCourse();
    return this.gates;
  }

  /**
   * Where the next gate is from (x, z). `angle` is measured against the river
   * axis and follows the heading convention: 0 = straight up the channel,
   * positive turns toward +X.
   * @returns {{dist:number, angle:number}}
   */
  bearingTo(x, z, gate) {
    this._ensureCourse();
    const g = gate || this.next();
    const out = this._bearing;
    const px = num(x, 0), pz = num(z, 0);
    if (!g) { out.dist = 0; out.angle = 0; out.index = 0; out.gate = null; return out; }
    const dx = g.x - px, dz = g.z - pz;
    out.dist = Math.sqrt(dx * dx + dz * dz);
    out.angle = wrapPi(Math.atan2(dx, dz) - this._riverAngle(pz));
    out.index = g.index;
    out.gate = g;
    return out;
  }

  // =================================================================== course

  _river() { return this.ctx ? this.ctx.river : null; }

  _centerX(z) {
    const r = this._river();
    if (r && typeof r.centerX === 'function') {
      const v = r.centerX(z);
      if (Number.isFinite(v)) return v;
    }
    return 0;
  }

  _halfWidth(z) {
    const r = this._river();
    if (r && typeof r.halfWidth === 'function') {
      const v = r.halfWidth(z);
      if (Number.isFinite(v) && v > 10) return v;
    }
    return Math.max(30, num(this.world.riverWidth, 340) * 0.5);
  }

  /** Angle of the river axis at z (0 = +Z, positive toward +X). */
  _riverAngle(z) {
    const r = this._river();
    if (r && typeof r.centerSlope === 'function') {
      const m = r.centerSlope(z);
      if (Number.isFinite(m)) return Math.atan(m);
    }
    if (r && typeof r.tangent === 'function') {
      const tg = r.tangent(z);
      if (tg && Number.isFinite(tg.x)) return Math.atan2(tg.x, num(tg.z, num(tg.y, 1)));
    }
    return 0;
  }

  /**
   * Lay the course out. Pure function of CONFIG.seed and river.js' analytic
   * channel — identical on every run, on every machine, forever.
   */
  _ensureCourse() {
    if (this._laid) return;
    // River may not exist yet if the integrator builds us first; without it the
    // centreline is 0 and the course would be laid down the wrong channel. Wait
    // one construction round, but never wait past the first simulated step.
    if (!this._river() && !this._forceLayout) return;
    this._laid = true;

    const N = this.total;
    const S = this.seed ^ 0x47415445;      // 'GATE'
    const startSide = hash2(0, 7, S) < 0.5 ? -1 : 1;

    for (let i = 0; i < N; i++) {
      const u = N > 1 ? i / (N - 1) : 0;

      // Anchored on the same lattice race.js counts distance against, so gate k
      // is threaded within a couple of seconds of race:checkpoint {index: k}.
      const z = (i + 1) * this.spacing;

      // Width: generous while you are learning the wave, mean by the finish.
      const wj = (hash2(i, 31, S) * 2 - 1) * LAYOUT.widthJitter;
      let width = lerp(LAYOUT.widthStart, LAYOUT.widthEnd, u) + wj;
      width = clamp(width, 9, 60);

      // Lateral: strict alternation (that is what makes it a slalom) with a
      // seeded magnitude, so the rhythm is never metronomic.
      const side = ((i & 1) === 0 ? 1 : -1) * startSide;
      const swing = lerp(LAYOUT.swingStart, LAYOUT.swingEnd, u);
      const mag = swing * (LAYOUT.swingMin + (1 - LAYOUT.swingMin) * hash2(i, 53, S));

      // Keep every buoy in navigable water AND inside the corridor the surf
      // physics will actually let the player reach.
      const room = Math.max(
        6,
        Math.min(this._halfWidth(z) - LAYOUT.bankMargin, LAYOUT.corridorHalf) - width * 0.5,
      );
      const off = clamp(side * mag, -room, room);

      const cx = this._centerX(z) + off;

      // The gate line runs across the channel: perpendicular to the river axis.
      const a = this._riverAngle(z);
      const lx = Math.cos(a), lz = -Math.sin(a);   // unit lateral, pointing +X
      const h = width * 0.5;

      const g = {
        index: i + 1,                 // 1..N — same numbering as race:checkpoint
        i,
        x: cx, z,
        width,
        off,
        ax: cx - lx * h, az: z - lz * h,   // buoy on the -X side
        bx: cx + lx * h, bz: z + lz * h,   // buoy on the +X side
        ux: lx, uz: lz,                    // unit A -> B
        passed: false,
        missed: false,
        resolved: false,
        margem: NaN,
        time: NaN,
        emph: 0,
        dist: Infinity,
        angle: 0,
        buoys: null,
      };

      const b0 = this._makeBuoyRecord(g, g.ax, g.az, i * 2, S);
      const b1 = this._makeBuoyRecord(g, g.bx, g.bz, i * 2 + 1, S);
      g.buoys = [b0, b1];
      this.buoys.push(b0, b1);
      this.gates.push(g);
    }
  }

  _makeBuoyRecord(gate, x, z, k, S) {
    const h1 = hash2(k, 101, S);
    const h2 = hash2(k, 211, S);
    const h3 = hash2(k, 307, S);
    const y0 = this._height(x, z, 0);
    return {
      gate, x, z,
      y: y0, vy: 0,
      yaw: h1 * TAU, wYaw: (h2 - 0.5) * 0.25,
      scale: 0.92 + h3 * 0.24,
      phase: h2 * TAU,
      spin: (h3 - 0.5) * 2,
      nx: 0, ny: 1, nz: 0,      // smoothed water normal under the float
      kick: 0,
    };
  }

  // ============================================================ bore wrappers
  // Guarded: a half-finished neighbour degrades to flat water, never to NaN.

  _crest(x, t) {
    if (this._hasCrest && this._boreFails < 4) {
      try {
        const v = this.bore.crest(x, t);
        if (Number.isFinite(v)) return v;
      } catch (e) { this._boreFails++; }
    }
    const s = this.state;
    return (s && s.bore && num(s.bore.z, 0)) || 0;
  }

  _height(x, z, t) {
    if (this._hasHeight && this._boreFails < 4) {
      try {
        const v = this.bore.height(x, z, t);
        if (Number.isFinite(v)) return v;
      } catch (e) { this._boreFails++; }
    }
    return 0;
  }

  _normal(x, z, t) {
    const n = this._n;
    if (this._hasNormal && this._boreFails < 4) {
      try {
        const r = this.bore.normal(x, z, t, n) || n;
        const ny = num(r.y, 1);
        if (ny > 1e-3) { n.set(num(r.x, 0), ny, num(r.z, 0)); return n; }
      } catch (e) { this._boreFails++; }
    }
    n.set(0, 1, 0);
    return n;
  }

  _break(x, t) {
    if (this._hasBreak && this._boreFails < 4) {
      try {
        const v = this.bore.breakIntensity(x, t);
        if (Number.isFinite(v)) return clamp01(v);
      } catch (e) { this._boreFails++; }
    }
    return 0.75;
  }

  // ================================================================= detection

  /** 2 x signed area of (A, B, P). Negative before the gate, positive after. */
  _side(g, x, z) {
    return (g.bx - g.ax) * (z - g.az) - (g.bz - g.az) * (x - g.ax);
  }

  _emit(evt, payload) {
    if (!this.bus || typeof this.bus.emit !== 'function') return;
    try { this.bus.emit(evt, payload); } catch (e) { /* a bad listener must not kill the run */ }
  }

  _resolve(g, passed, margem, cx, cz, side) {
    g.resolved = true;
    g.passed = !!passed;
    g.missed = !passed;
    g.margem = Number.isFinite(margem) ? clamp01(margem) : 1;
    g.time = this.t;
    while (this._nextIdx < this.gates.length && this.gates[this._nextIdx].resolved) this._nextIdx++;

    const p = this.state && this.state.player;
    if (passed) {
      this._emit('gate:pass', {
        index: g.index,
        total: this.total,
        width: g.width,
        margem: g.margem,
        x: cx, z: cz,
        gateX: g.x, gateZ: g.z,
        speed: p ? num(p.speed, 0) : 0,
        time: this.t,
      });
    } else {
      this._emit('gate:miss', {
        index: g.index,
        total: this.total,
        width: g.width,
        side,                       // -1 outside the -X buoy, +1 the +X buoy, 0 = never crossed
        x: cx, z: cz,
        gateX: g.x, gateZ: g.z,
        time: this.t,
      });
    }
  }

  /**
   * One fixed-step crossing test against every unresolved gate. Must be driven
   * from main.js' FIXED simulation step (`simSystems`), not from the view step:
   * the maths tunnels at no step size, but a view-rate dt would make the
   * resolution of `margem` frame-rate dependent.
   */
  _detect(dt) {
    const p = this.state && this.state.player;
    if (!p) return;
    const x = num(p.x, 0), z = num(p.z, 0);

    if (!this._hasPrev) { this._px = x; this._pz = z; this._hasPrev = true; return; }

    const dx = x - this._px, dz = z - this._pz;
    // A wipeout recovery re-seats the surfer in the pocket, which is a teleport,
    // not a ride. Crossing a gate line by being placed on the far side of it is
    // not passing it — re-baseline and let the behind-latch call it a miss.
    const jump = Math.max(DETECT.teleportBase, DETECT.teleportRate * Math.max(dt, 0));
    const teleported = (dx * dx + dz * dz) > jump * jump;

    if (!teleported) {
      for (let i = this._nextIdx; i < this.gates.length; i++) {
        const g = this.gates[i];
        if (g.resolved) continue;
        // Cheap reject: nothing more than a step's travel away can flip sign.
        if (g.z - z > 60 && g.z - this._pz > 60) continue;

        const s0 = this._side(g, this._px, this._pz);
        const s1 = this._side(g, x, z);
        if (!(s0 < 0 && s1 >= 0)) continue;     // forward crossings only

        const denom = s0 - s1;
        const u = Math.abs(denom) > 1e-9 ? clamp01(s0 / denom) : 0;
        const cx = this._px + dx * u;
        const cz = this._pz + dz * u;

        // Project the crossing point onto the segment: 0 = buoy A, 1 = buoy B.
        const ex = g.bx - g.ax, ez = g.bz - g.az;
        const len2 = ex * ex + ez * ez;
        const sPar = len2 > 1e-9 ? ((cx - g.ax) * ex + (cz - g.az) * ez) / len2 : 0.5;

        if (sPar >= 0 && sPar <= 1) {
          this._resolve(g, true, Math.abs(sPar * 2 - 1), cx, cz, 0);
        } else {
          this._resolve(g, false, 1, cx, cz, sPar < 0 ? -1 : 1);
        }
      }
    }

    // Backstop: anything the surfer is unambiguously astern of and that never
    // registered a crossing (teleported past by a wipeout recovery) is a miss.
    // Without this a skipped gate would sit "next" forever.
    //
    // Measured PERPENDICULAR to the gate line, not along z: the line is rotated
    // with the channel, so a surfer 60 m off to one side is still *in front of*
    // a gate whose centre z he is already several metres past. Latching on raw
    // z stole those gates from the crossing test and reported them as
    // never-crossed misses (side = 0) — same verdict, wrong reason, and it would
    // have hidden a real tunnelling bug the day one appeared.
    for (let i = this._nextIdx; i < this.gates.length; i++) {
      const g = this.gates[i];
      if (g.resolved) continue;
      const perp = this._side(g, x, z) / Math.max(1, g.width);
      if (perp > DETECT.latchBehind) this._resolve(g, false, 1, x, z, 0);
      else break;    // gates are in ascending z
    }

    this._px = x; this._pz = z;
  }

  // ==================================================================== visual

  _build(THREE) {
    const S = this.seed;

    const buoyGeo = normalise(THREE, makeBuoy(THREE, S + 3));
    buoyGeo.computeBoundingSphere();
    const buoyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.0,
    });
    buoyMat.name = 'gate-buoy';
    const buoy = new THREE.InstancedMesh(buoyGeo, buoyMat, VIEW.maxBuoys);
    buoy.name = 'gates:buoy';
    buoy.frustumCulled = false;         // instances span the whole course
    buoy.castShadow = false;            // the sun is 3 deg up; these would smear
    buoy.receiveShadow = false;
    buoy.count = 0;
    buoy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    buoy.setColorAt(0, new THREE.Color(1, 1, 1));
    if (buoy.instanceColor) buoy.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.buoyMesh = buoy;
    this._geos.push(buoyGeo); this._mats.push(buoyMat);
    this.group.add(buoy);

    const flagGeo = normalise(THREE, makeFlag(THREE));
    flagGeo.computeBoundingSphere();
    const flagMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0.0,
      side: THREE.DoubleSide,
    });
    flagMat.name = 'gate-flag';
    const flag = new THREE.InstancedMesh(flagGeo, flagMat, VIEW.maxBuoys);
    flag.name = 'gates:flag';
    flag.frustumCulled = false;
    flag.castShadow = false;
    flag.count = 0;
    flag.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flag.setColorAt(0, new THREE.Color(1, 1, 1));
    if (flag.instanceColor) flag.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.flagMesh = flag;
    this._geos.push(flagGeo); this._mats.push(flagMat);
    this.group.add(flag);

    const lampGeo = normalise(THREE, makeLamp(THREE));
    lampGeo.computeBoundingSphere();
    const lampMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, fog: true, toneMapped: true,
    });
    lampMat.name = 'gate-lamp';
    const lamp = new THREE.InstancedMesh(lampGeo, lampMat, 4);
    lamp.name = 'gates:lamp';
    lamp.frustumCulled = false;
    lamp.count = 0;
    lamp.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    lamp.setColorAt(0, new THREE.Color(1, 1, 1));
    if (lamp.instanceColor) lamp.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.lampMesh = lamp;
    this._geos.push(lampGeo); this._mats.push(lampMat);
    this.group.add(lamp);
  }

  /** Float dynamics for every buoy on the course. 24 records — no windowing. */
  _floats(dt, t) {
    const list = this.buoys;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const wy = this._height(b.x, b.z, t);

      // How hard the front is going off right under this float. Plateau across
      // the churn at the lip, tapering into clean water ahead and foam behind.
      const d = b.z - this._crest(b.x, t);
      let kick = 0;
      if (d > FLOAT.kickBack && d < FLOAT.kickFront) {
        const w = d < FLOAT.kickBack + 6 ? (d - FLOAT.kickBack) / 6
          : d > FLOAT.kickFront - 6 ? (FLOAT.kickFront - d) / 6 : 1;
        kick = this._break(b.x, t) * clamp01(w);
      }
      b.kick += (kick - b.kick) * Math.min(1, 8 * dt);

      // Heave: a damped spring chasing the water surface. The bore lifts the
      // float three metres in a couple of seconds and the overshoot is the
      // "sobe e é chacoalhada" the brief asks for — it falls out of the model.
      b.vy += ((wy - b.y) * FLOAT.spring - b.vy * FLOAT.damp) * dt;
      b.vy += kick * FLOAT.tossUp * dt;
      if (b.vy < FLOAT.vyMin) b.vy = FLOAT.vyMin; else if (b.vy > FLOAT.vyMax) b.vy = FLOAT.vyMax;
      b.y += b.vy * dt;
      if (!(b.y > -80 && b.y < 80)) { b.y = wy; b.vy = 0; }

      // Yaw: moored, so it only spins on its own line — hard when the surge hits.
      b.wYaw += (b.spin + Math.sin(t * 1.9 + b.phase) * 0.7) * kick * FLOAT.tossSpin * dt;
      b.wYaw -= b.wYaw * FLOAT.yawDamp * dt;
      b.yaw += b.wYaw * dt;
      if (b.yaw > TAU) b.yaw -= TAU; else if (b.yaw < -TAU) b.yaw += TAU;

      // Tilt: settle onto the water normal, plus a thrash while it is in the churn.
      const n = this._normal(b.x, b.z, t);
      const k = Math.min(1, FLOAT.tiltRate * dt);
      const sh = b.kick * FLOAT.shake;
      const tx = n.x + Math.sin(t * 5.3 + b.phase) * sh;
      const tz = n.z + Math.sin(t * 4.1 + b.phase * 1.7) * sh;
      b.nx += (tx - b.nx) * k;
      b.ny += (n.y - b.ny) * k;
      b.nz += (tz - b.nz) * k;
      if (!(b.ny > 0.05)) { b.nx = 0; b.ny = 1; b.nz = 0; }
    }
  }

  _writeInstances(t) {
    const buoy = this.buoyMesh, flag = this.flagMesh, lamp = this.lampMesh;
    if (!buoy || !flag || !lamp) return;
    const THREE = this.THREE;

    const p = this.state && this.state.player;
    const pz = p ? num(p.z, 0) : 0;

    const m = this._m, mLocal = this._mLocal, mOut = this._mOut;
    const pos = this._p, sc = this._s, q = this._q, qy = this._qy;
    const nrm = this._nrm, up = this._up;

    let nb = 0, nf = 0, nl = 0;
    const bc = buoy.instanceColor ? buoy.instanceColor.array : null;
    const fc = flag.instanceColor ? flag.instanceColor.array : null;
    const lc = lamp.instanceColor ? lamp.instanceColor.array : null;

    for (let gi = 0; gi < this.gates.length; gi++) {
      const g = this.gates[gi];
      if (g.z < pz - VIEW.behind || g.z > pz + VIEW.ahead) continue;

      // Tint by state. `emph` is lerped in step(), so the highlight never pops.
      let cr, cg, cb;
      if (g.passed) { cr = TINT.passed[0]; cg = TINT.passed[1]; cb = TINT.passed[2]; }
      else if (g.missed) { cr = TINT.missed[0]; cg = TINT.missed[1]; cb = TINT.missed[2]; }
      else {
        const e = g.emph;
        cr = lerp(TINT.pending[0], TINT.next[0], e);
        cg = lerp(TINT.pending[1], TINT.next[1], e);
        cb = lerp(TINT.pending[2], TINT.next[2], e);
      }
      const flagScale = 1 + 0.85 * g.emph;

      for (let k = 0; k < 2; k++) {
        if (nb >= VIEW.maxBuoys) break;
        const b = g.buoys[k];

        nrm.set(b.nx, b.ny, b.nz).normalize();
        qy.setFromAxisAngle(up, b.yaw);
        q.setFromUnitVectors(up, nrm);        // tilt in WORLD space...
        q.multiply(qy);                       // ... applied over the float's own spin
        pos.set(b.x, b.y, b.z);
        sc.set(b.scale, b.scale, b.scale);
        m.compose(pos, q, sc);
        buoy.setMatrixAt(nb, m);
        if (bc) { const o = nb * 3; bc[o] = cr; bc[o + 1] = cg; bc[o + 2] = cb; }
        nb++;

        // Bandeirola at the halyard. Its own slow flutter on top of the mast.
        if (nf < VIEW.maxBuoys) {
          const wob = Math.sin(t * 2.1 + b.phase) * (0.22 + 0.5 * b.kick)
                    + Math.sin(t * 5.7 + b.phase * 2.3) * 0.09;
          pos.set(0, VIEW.mastTop, 0);
          qy.setFromAxisAngle(up, wob);
          sc.set(flagScale, flagScale, flagScale);
          mLocal.compose(pos, qy, sc);
          mOut.multiplyMatrices(m, mLocal);
          flag.setMatrixAt(nf, mOut);
          if (fc) { const o = nf * 3; fc[o] = cr; fc[o + 1] = cg; fc[o + 2] = cb; }
          nf++;
        }

        // Lamparina — only the gate you are actually going for carries a light.
        if (g.emph > 0.15 && nl < 4) {
          pos.set(0, VIEW.lampY, 0);
          qy.identity();
          sc.set(1, 1, 1);
          mLocal.compose(pos, qy, sc);
          mOut.multiplyMatrices(m, mLocal);
          lamp.setMatrixAt(nl, mOut);
          if (lc) {
            const fl = (0.90 + 0.10 * Math.sin(t * 3.3 + b.phase)) * (0.25 + 0.75 * g.emph);
            const o = nl * 3;
            lc[o] = 3.4 * fl; lc[o + 1] = 2.1 * fl; lc[o + 2] = 0.9 * fl;
          }
          nl++;
        }
      }
    }

    buoy.count = nb; flag.count = nf; lamp.count = nl;
    buoy.instanceMatrix.needsUpdate = true;
    flag.instanceMatrix.needsUpdate = true;
    lamp.instanceMatrix.needsUpdate = true;
    if (buoy.instanceColor) buoy.instanceColor.needsUpdate = true;
    if (flag.instanceColor) flag.instanceColor.needsUpdate = true;
    if (lamp.instanceColor) lamp.instanceColor.needsUpdate = true;
  }

  // ====================================================================== step

  step(dt) {
    let h = Number(dt);
    if (!(h > 0)) h = 1 / 120;
    if (h > 0.05) h = 0.05;

    this._forceLayout = true;
    this._ensureCourse();

    const s = this.state;
    this.t = (s && Number.isFinite(s.time)) ? s.time : this.t + h;

    this._detect(h);

    // HUD conveniences + the highlight ramp.
    const p = s && s.player;
    const px = p ? num(p.x, 0) : 0;
    const pz = p ? num(p.z, 0) : 0;
    const nx = this._nextIdx;
    const rate = Math.min(1, 3.2 * h);
    for (let i = 0; i < this.gates.length; i++) {
      const g = this.gates[i];
      const dx = g.x - px, dz = g.z - pz;
      g.dist = Math.sqrt(dx * dx + dz * dz);
      g.angle = wrapPi(Math.atan2(dx, dz) - this._riverAngle(pz));
      const want = g.resolved ? 0 : (i === nx ? 1 : (i === nx + 1 ? 0.42 : 0));
      g.emph += (want - g.emph) * rate;
    }

    if (!this.enabled) return;
    this._floats(h, this.t);
    this._writeInstances(this.t);
  }

  dispose() {
    if (this.scene && this.group.parent === this.scene) this.scene.remove(this.group);
    this.group.clear();
    for (const g of this._geos) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._mats) { try { m.dispose(); } catch (e) { /* noop */ } }
    if (this.buoyMesh) this.buoyMesh.dispose();
    if (this.flagMesh) this.flagMesh.dispose();
    if (this.lampMesh) this.lampMesh.dispose();
    this._geos.length = 0;
    this._mats.length = 0;
    this.buoyMesh = this.flagMesh = this.lampMesh = null;
    this.gates.length = 0;
    this.buoys.length = 0;
    this.enabled = false;
    if (this.ctx && this.ctx.gates === this) this.ctx.gates = null;
  }
}

export default Gates;
