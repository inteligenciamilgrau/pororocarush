// POROROCA RUSH — floating obstacles: troncos, canoas, barcos regionais, detritos.
//
// Everything here is deterministic: content is a pure function of the spawn-cell
// index and CONFIG.seed, and every dynamic quantity is integrated with `dt`.
// No Math.random(), ever.
//
// Layout: obstacles are authored in a scrolling frame along +Z. Cells of CELL
// metres are materialised `world.streamAhead` metres in front of the player and
// released once they fall `world.cullBehind` metres behind. Each obstacle floats
// on `bore.height()`, is tilted by `bore.normal()`, drifts with `bore.flow()` and
// is lifted, spun and hurled forward as the bore surges underneath it.
//
// Collision is a 2D capsule test in XZ (segment of half-length `halfLen`, radius
// `rad`) resolved through a 1D z-bucket broadphase. `query()` allocates nothing.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2, fbm2 } from '../core/rng.js';

// ---------------------------------------------------------------- constants --

const TAU = Math.PI * 2;

const T_LOG_BIG = 0;
const T_LOG_SMALL = 1;
const T_CANOE = 2;
const T_BOAT = 3;
const T_DEBRIS = 4;
const N_TYPES = 5;

const TYPE_NAME = ['logBig', 'logSmall', 'canoe', 'boat', 'debris'];
const TYPE_KIND = ['wipeout', 'graze', 'wipeout', 'wipeout', 'cosmetic'];
const TYPE_SEVERITY = [1.0, 0.42, 0.92, 1.0, 0.05];
const TYPE_CAP = [128, 128, 56, 24, 160]; // instanced draw capacity per type

// Below this an obstacle can never block the surfer, so `query()` hides it: a
// naive `if (hit) wipeout()` in physics must not trip over floating salad.
const SOLID_MIN_SEVERITY = 0.2;

// Saturated hull paints seen on the canoes in the concept art.
const PAINTS = [0xe8dcc4, 0x2f6f7c, 0x9c3b26, 0xd39a35, 0x35507a];

const CELL = 24;          // metres of Z per deterministic spawn cell
const BUCKET = 16;        // metres of Z per broadphase bucket
const NBUCKET = 176;      // ring size; 176 * 16 = 2816 m > streamAhead + cullBehind
const MAX_OBSTACLES = 360;
const MAX_HALF_LEN = 9.0; // broadphase padding (largest half-length + radius)
const MAX_PADDLERS = 32;

const G = 9.81;
const SUB_CLAMP = 0.95;   // metres of submersion that still add buoyant force
const WATER_DAMP_Y = 5.5;
const AIR_DAMP_Y = 0.03;
const VY_MIN = -16, VY_MAX = 14;
const TOSS_UP = 38.0;     // extra upward accel from the breaking lip (m/s^2)
const TOSS_SPIN = 7.5;
const CAPSIZE_W = 1.1;    // roll rate that rolls a canoe right over
const CAPSIZE_VY = 2.6;
const PLAYER_R = 0.9;     // board + surfer radius used for the bus event
const HIT_COOLDOWN = 1.1; // seconds before the same obstacle re-fires an event

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const finite = (v, f) => (v > -1e6 && v < 1e6 ? v : f);

// ----------------------------------------------------------------- geometry --

/** Bake a per-vertex colour so one material can render several painted parts. */
function paint(geo, fn) {
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
function normalise(geo) {
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.color) paint(geo, () => {});
  return geo;
}

function mergeAll(parts) {
  if (parts.length === 1) return normalise(parts[0]);
  const merged = mergeGeometries(parts.map(normalise), false);
  if (!merged) return parts[0];
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * A weathered trunk. The long axis is local +X, so a Y-yaw aims it across the
 * river and a local-X roll makes it barrel-roll in the surge.
 */
function makeLog(len, rad, seed, branches) {
  const trunk = new THREE.CylinderGeometry(rad * 0.88, rad, len, 11, 6, false);
  trunk.rotateZ(-Math.PI / 2); // +Y -> +X

  const pos = trunk.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const rr = Math.hypot(y, z);
    let ny = y, nz = z;
    if (rr > 1e-4) {
      const ang = Math.atan2(z, y);
      const n = fbm2(x * 1.9 + 11.3, ang * 2.3 + 5.7, 3, seed);
      const k = 1 + (n - 0.5) * 0.32;
      ny = y * k; nz = z * k;
    }
    // banana bend so it never reads as a perfect pipe
    const u = x / Math.max(len, 1e-3);
    ny += rad * 0.55 * (1 - 4 * u * u);
    pos.setXYZ(i, x, ny, nz);
  }
  pos.needsUpdate = true;
  trunk.computeVertexNormals();

  const half = len * 0.5;
  paint(trunk, (c, x, y, z) => {
    const grain = fbm2(x * 2.4 + 3.1, Math.atan2(z, y) * 1.7, 2, seed + 9);
    if (Math.abs(x) > half * 0.96) c.setHex(0x7a5731).multiplyScalar(0.85 + grain * 0.35);
    else c.setHex(0x3d2a19).multiplyScalar(0.72 + grain * 0.62);
  });

  if (!branches) return normalise(trunk);

  const parts = [trunk];
  for (let b = 0; b < 3; b++) {
    const h = hash2(seed, b * 31 + 5, 771);
    const h2 = hash2(seed, b * 31 + 6, 771);
    const bl = len * (0.28 + h * 0.3);
    const br = rad * 0.34;
    const g = new THREE.CylinderGeometry(br * 0.35, br, bl, 6, 1, false);
    g.translate(0, bl * 0.5, 0);
    g.rotateX((h2 - 0.5) * 2.2);
    g.rotateZ(-0.55 - h * 0.85);
    g.translate((h - 0.5) * len * 0.7, 0, 0);
    paint(g, (c) => c.setHex(0x33241a).multiplyScalar(0.8 + h2 * 0.5));
    parts.push(g);
  }
  return mergeAll(parts);
}

/**
 * Boat / canoe hull shell. X = length (bow at -X), Y = up (0 = gunwale line),
 * Z = lateral. Outer shell + inner shell + gunwale rim, so it is a closed hollow
 * solid rather than a paper sheet you can see through.
 */
function makeHull(o) {
  const len = o.len, beam = o.beam, depth = o.depth;
  const sheer = o.sheer ?? 0.2;
  const bowSharp = o.bowSharp ?? 0.6;
  const fullness = o.fullness ?? 0.55;
  const nu = o.nu ?? 16, nv = o.nv ?? 7;
  const cols = nv * 2 + 1;

  const verts = [];
  const uvs = [];

  function shell(sb, sd, sl, yOff) {
    const base = verts.length / 3;
    for (let iu = 0; iu <= nu; iu++) {
      const u = iu / nu;
      const s = Math.sin(Math.PI * u);
      const b = beam * Math.pow(s, bowSharp) * sb;
      const dp = depth * (0.42 + 0.58 * Math.pow(s, 0.5)) * sd;
      const yTop = sheer * Math.pow(1 - s, 1.4);
      for (let jv = 0; jv < cols; jv++) {
        const k = jv - nv;
        const v = Math.abs(k) / nv;
        const w = b * Math.pow(1 - Math.pow(1 - v, 2.0), fullness);
        verts.push((u - 0.5) * len * sl, yTop - dp * (1 - v) + yOff, (k < 0 ? -1 : 1) * w);
        uvs.push(u, jv / (cols - 1));
      }
    }
    return base;
  }

  const outer = shell(1, 1, 1, 0);
  const inner = shell(0.85, 0.86, 0.955, -0.045);

  const idx = [];
  for (let iu = 0; iu < nu; iu++) {
    for (let jv = 0; jv < cols - 1; jv++) {
      const a = outer + iu * cols + jv;
      idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      const e = inner + iu * cols + jv;
      idx.push(e, e + 1, e + cols, e + 1, e + cols + 1, e + cols);
    }
  }
  // gunwale rim: port edge (jv = 0) and starboard edge (jv = cols - 1)
  for (let iu = 0; iu < nu; iu++) {
    const op = outer + iu * cols, ip = inner + iu * cols;
    idx.push(op, ip, op + cols, op + cols, ip, ip + cols);
    const os = outer + iu * cols + cols - 1, is = inner + iu * cols + cols - 1;
    idx.push(os, os + cols, is, os + cols, is + cols, is);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeCanoe(seed) {
  const len = 6.4, beam = 0.62, depth = 0.54;
  const hull = makeHull({ len, beam, depth, sheer: 0.22, bowSharp: 0.55, fullness: 0.5, nu: 18, nv: 7 });
  paint(hull, (c, x, y) => {
    const grain = fbm2(x * 1.6 + 2.2, y * 5.0, 2, seed);
    if (y > -0.12) c.setHex(0xb9ad99).multiplyScalar(0.82 + grain * 0.36); // painted strake
    else c.setHex(0x4a3220).multiplyScalar(0.70 + grain * 0.60);           // wet wood
  });

  const parts = [hull];
  for (let i = 0; i < 3; i++) {
    const u = 0.3 + i * 0.2;
    const w = beam * Math.pow(Math.sin(Math.PI * u), 0.55) * 2.0;
    const t = new THREE.BoxGeometry(0.16, 0.06, w);
    t.translate((u - 0.5) * len, -0.06, 0);
    paint(t, (c) => c.setHex(0x6b4c2e));
    parts.push(t);
  }
  return mergeAll(parts);
}

function makeBoat(seed) {
  const len = 13.0, beam = 1.75, depth = 1.3;
  const hull = makeHull({ len, beam, depth, sheer: 0.3, bowSharp: 0.5, fullness: 0.72, nu: 18, nv: 7 });
  paint(hull, (c, x, y) => {
    const grain = fbm2(x * 0.9 + 5.4, y * 3.0, 2, seed);
    if (y < -0.62) c.setHex(0x6e2a1e).multiplyScalar(0.80 + grain * 0.40); // antifouling
    else c.setHex(0xcfc0a4).multiplyScalar(0.78 + grain * 0.38);           // cream topsides
  });

  const parts = [hull];
  const add = (g, hex, mul) => { paint(g, (c) => c.setHex(hex).multiplyScalar(mul ?? 1)); parts.push(g); };

  const deck = new THREE.BoxGeometry(len * 0.78, 0.09, beam * 1.62);
  deck.translate(len * 0.02, -0.14, 0);
  add(deck, 0x7a5a39);

  const cabin = new THREE.BoxGeometry(len * 0.24, 0.92, beam * 1.44);
  cabin.translate(len * 0.24, 0.40, 0);
  add(cabin, 0x2c6a72);

  const roof = new THREE.BoxGeometry(len * 0.66, 0.10, beam * 2.05);
  roof.translate(0, 0.98, 0);
  add(roof, 0xa8462a);

  const roof2 = new THREE.BoxGeometry(len * 0.26, 0.10, beam * 1.60);
  roof2.translate(len * 0.24, 0.94, 0);
  add(roof2, 0x8e3a24);

  for (let i = 0; i < 6; i++) {
    const post = new THREE.BoxGeometry(0.09, 1.1, 0.09);
    post.translate((-0.28 + (i % 3) * 0.28) * len, 0.44, (i < 3 ? -1 : 1) * beam * 0.92);
    add(post, 0x6a4c2e, 0.9 + hash2(seed, i, 41) * 0.3);
  }
  return mergeAll(parts);
}

function makeDebris(seed) {
  // Icosahedra are non-indexed, so everything in this clump is non-indexed too.
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const h = hash2(seed, i * 7 + 1, 313);
    const h2 = hash2(seed, i * 7 + 2, 313);
    const h3 = hash2(seed, i * 7 + 3, 313);
    const g = new THREE.IcosahedronGeometry(0.28 + h * 0.34, 1);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const n = fbm2(p.getX(v) * 4 + i, p.getZ(v) * 4, 2, seed + i);
      p.setXYZ(v, p.getX(v) * (0.7 + n * 0.9), p.getY(v) * 0.34, p.getZ(v) * (0.7 + n * 0.9));
    }
    g.computeVertexNormals();
    g.translate((h2 - 0.5) * 1.2, (h3 - 0.5) * 0.08, (h3 - 0.5) * 1.1);
    paint(g, (c) => c.setHex(0x2b3a1a).multiplyScalar(0.65 + h2 * 0.8));
    parts.push(g);
  }
  for (let i = 0; i < 3; i++) {
    const h = hash2(seed, i * 11 + 4, 517);
    const src = new THREE.CylinderGeometry(0.03, 0.04, 0.9 + h * 0.9, 5, 1);
    src.rotateZ(Math.PI / 2 + (h - 0.5) * 0.5);
    src.rotateY(h * TAU);
    src.translate((h - 0.5) * 0.9, 0.02, (hash2(seed, i, 9) - 0.5) * 0.9);
    const g = src.toNonIndexed();
    src.dispose();
    paint(g, (c) => c.setHex(0x3a2a1a).multiplyScalar(0.8 + h * 0.5));
    parts.push(g);
  }
  return mergeAll(parts);
}

function makePaddler() {
  const parts = [];
  const torso = new THREE.CapsuleGeometry(0.16, 0.34, 3, 7);
  torso.rotateX(0.18);
  torso.translate(0, 0.30, 0);
  paint(torso, (c) => c.setHex(0x2a2018));
  parts.push(torso);

  const head = new THREE.SphereGeometry(0.11, 8, 6);
  head.translate(0.02, 0.62, 0);
  paint(head, (c) => c.setHex(0x33261b));
  parts.push(head);

  const shaft = new THREE.BoxGeometry(0.05, 1.5, 0.05);
  shaft.rotateZ(0.5);
  shaft.rotateX(0.35);
  shaft.translate(0.12, 0.36, 0.24);
  paint(shaft, (c) => c.setHex(0x7a5a34));
  parts.push(shaft);

  const blade = new THREE.BoxGeometry(0.04, 0.42, 0.16);
  blade.rotateZ(0.5);
  blade.rotateX(0.35);
  blade.translate(0.50, -0.26, 0.50);
  paint(blade, (c) => c.setHex(0x8a6a40));
  parts.push(blade);

  return mergeAll(parts);
}

function makeRecord(slot) {
  return {
    slot, id: -1, alive: 0, type: 0, cell: 0,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, roll: 0, tilt: 0,
    ax: 1, az: 0,                 // cached long-axis direction in XZ
    wYaw: 0, wRoll: 0, wTilt: 0,
    rollTarget: 0, capsized: 0,
    sx: 1, sy: 1, sz: 1,
    halfLen: 1, rad: 0.5, top: 0.5, bottom: -0.5,
    buoy: 40, float0: 0, floatBias: 0, hdrag: 2, toss: 1, rolls: 0, alignRoll: 0,
    tiltK: 5, severity: 1, paddler: 0,
    spinBias: 0, phase: 0, hitAt: -99,
    cr: 1, cg: 1, cb: 1,
  };
}

// ------------------------------------------------------------------- module --

export class Obstacles {
  /**
   * @param {object} ctx { THREE, scene, renderer, camera, state, bus, bore, config }
   * Also tolerates the legacy positional form `(scene, state, bore, config)`.
   */
  constructor(a, b, c, d) {
    const ctx = (a && a.isObject3D) ? { scene: a, state: b, bore: c, config: d } : (a || {});
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.state = ctx.state || null;
    this.bus = ctx.bus || null;
    this.bore = ctx.bore || null;

    const cfg = ctx.config || {};
    this.config = cfg;
    this.world = cfg.world || cfg || {};
    this.wave = cfg.wave || {};
    this.seed = (cfg.seed | 0) || 20260801;

    this.boreSpeed = finite(this.wave.boreSpeed, 8.6);
    this.streamAhead = clamp(finite(this.world.streamAhead, 900), 120, 2200);
    this.cullBehind = clamp(finite(this.world.cullBehind, 260), 60, 500);
    this.density = clamp(finite(this.world.obstacleDensity, 0.055), 0.002, 0.5);
    this.riverWidth = clamp(finite(this.world.riverWidth, 340), 60, 2000);
    this.meander = clamp(finite(this.world.riverMeander, 210), 0, 800);
    this.meanderLen = Math.max(80, finite(this.world.riverMeanderLen, 1500));
    // Half-width of the lane obstacles may occupy, leaving a margin off the banks.
    this.laneHalf = this.riverWidth * 0.38;

    this.t = 0;
    this.enabled = true;
    this._boreFails = 0;
    this._hitCooldown = 0;

    // --- bore capability probe (bore.js is authored by another agent) --------
    const B = this.bore;
    this.hasHeight = !!(B && typeof B.height === 'function');
    this.hasCrest = !!(B && typeof B.crest === 'function');
    this.hasNormal = !!(B && typeof B.normal === 'function');
    this.hasFlow = !!(B && typeof B.flow === 'function');
    this.hasBreak = !!(B && typeof B.breakIntensity === 'function');

    // --- scratch (never allocate in step/query) -----------------------------
    this._n = new THREE.Vector3(0, 1, 0);
    this._f = new THREE.Vector2(0, 0);
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._m = new THREE.Matrix4();
    this._m2 = new THREE.Matrix4();
    this._col = new THREE.Color();

    this._hit = {
      type: 'logBig', severity: 1, kind: 'wipeout', wipeout: true,
      nx: 0, nz: 1, dist: 0, overlap: 0,
      x: 0, y: 0, z: 0, radius: 0, id: -1, vx: 0, vz: 0,
    };

    // --- pool ---------------------------------------------------------------
    this.pool = new Array(MAX_OBSTACLES);
    this.free = new Array(MAX_OBSTACLES);
    this.active = [];
    for (let i = 0; i < MAX_OBSTACLES; i++) {
      this.pool[i] = makeRecord(i);
      this.free[i] = MAX_OBSTACLES - 1 - i;
    }

    this.buckets = new Array(NBUCKET);
    for (let i = 0; i < NBUCKET; i++) this.buckets[i] = [];

    this.cellLo = 0;
    this.cellHi = -1;
    this._nextId = 1;

    this.group = new THREE.Group();
    this.group.name = 'obstacles';
    this.meshes = new Array(N_TYPES).fill(null);
    this.paddlerMesh = null;
    this._geos = [];
    this._mats = [];

    try {
      this._build();
    } catch (err) {
      this.enabled = false;
      console.warn('[obstacles] build failed, running headless:', err && err.message);
    }

    if (this.scene && this.group.children.length) this.scene.add(this.group);

    // Seed the world so frame 0 already has content in it.
    this._stream();
    this._rebuildBuckets();
    this._writeInstances();
  }

  // ------------------------------------------------------------------ build --

  _build() {
    const geos = [
      makeLog(7.5, 0.45, this.seed + 11, false),
      makeLog(3.2, 0.22, this.seed + 23, true),
      makeCanoe(this.seed + 37),
      makeBoat(this.seed + 53),
      makeDebris(this.seed + 71),
    ];

    for (let t = 0; t < N_TYPES; t++) {
      const geo = normalise(geos[t]);
      geo.computeBoundingSphere();
      const twoSided = (t === T_CANOE || t === T_BOAT);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: t === T_DEBRIS ? 0.92 : 0.66,
        metalness: 0.0,
        side: twoSided ? THREE.DoubleSide : THREE.FrontSide,
        flatShading: t === T_DEBRIS,
      });
      mat.name = `obstacle-${TYPE_NAME[t]}`;
      const mesh = new THREE.InstancedMesh(geo, mat, TYPE_CAP[t]);
      mesh.name = `obstacles:${TYPE_NAME[t]}`;
      mesh.frustumCulled = false;          // instances span ~1 km of river
      mesh.castShadow = (t === T_LOG_BIG || t === T_CANOE || t === T_BOAT);
      mesh.receiveShadow = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this._col.setRGB(1, 1, 1));
      if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.meshes[t] = mesh;
      this._geos.push(geo);
      this._mats.push(mat);
      this.group.add(mesh);
    }

    const pg = normalise(makePaddler());
    pg.computeBoundingSphere();
    const pm = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0,
    });
    pm.name = 'obstacle-paddler';
    const pmesh = new THREE.InstancedMesh(pg, pm, MAX_PADDLERS);
    pmesh.name = 'obstacles:paddler';
    pmesh.frustumCulled = false;
    pmesh.castShadow = true;
    pmesh.count = 0;
    pmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.paddlerMesh = pmesh;
    this._geos.push(pg);
    this._mats.push(pm);
    this.group.add(pmesh);
  }

  // ---------------------------------------------------------- bore wrappers --
  // bore.js is authored in parallel: every call is guarded and NaN-clamped so a
  // half-finished neighbour degrades to flat water instead of exploding.

  _baseZ() {
    const s = this.state;
    return (s && s.bore && finite(s.bore.z, 0)) || 0;
  }

  _crest(x, t) {
    if (this.hasCrest && this._boreFails < 3) {
      try { return finite(this.bore.crest(x, t), this._baseZ()); }
      catch (e) { this._boreFails++; }
    }
    return this._baseZ();
  }

  _height(x, z, t) {
    if (this.hasHeight && this._boreFails < 3) {
      try { return finite(this.bore.height(x, z, t), 0); }
      catch (e) { this._boreFails++; }
    }
    return 0;
  }

  _normal(x, z, t) {
    const n = this._n;
    if (this.hasNormal && this._boreFails < 3) {
      try {
        const r = this.bore.normal(x, z, t, n) || n;
        const ny = finite(r.y, 1);
        if (ny > 1e-3) { n.set(finite(r.x, 0), ny, finite(r.z, 0)); return n; }
      } catch (e) { this._boreFails++; }
    }
    n.set(0, 1, 0);
    return n;
  }

  _flow(x, z, t) {
    const f = this._f;
    if (this.hasFlow && this._boreFails < 3) {
      try {
        const r = this.bore.flow(x, z, t, f) || f;
        // The contract says Vector2 over XZ; tolerate a Vector3 by mistake.
        const fz = r.isVector3 ? r.z : r.y;
        f.set(clamp(finite(r.x, 0), -30, 30), clamp(finite(fz, 0), -30, 30));
        return f;
      } catch (e) { this._boreFails++; }
    }
    f.set(0, 0);
    return f;
  }

  _break(x, t) {
    if (this.hasBreak && this._boreFails < 3) {
      try { return clamp(finite(this.bore.breakIntensity(x, t), 0.8), 0, 1); }
      catch (e) { this._boreFails++; }
    }
    return 0.8;
  }

  // -------------------------------------------------------------- authoring --

  /**
   * Lateral centre of the obstacle lane at z. river.js owns the real channel and
   * exposes no centreline, so the lane only *hints* at the CONFIG meander: it
   * drifts by a quarter of it, which keeps the shape of the channel readable
   * from the air while guaranteeing that the surfer's corridor around x = 0
   * always has hazards in it. `_laneClamp` then keeps everything inside a
   * 340 m-wide river even if river.js never meanders at all.
   */
  _laneCenter(z) {
    return 0.25 * this.meander * Math.sin(z / this.meanderLen * TAU);
  }

  _laneHalf() {
    return this.laneHalf;
  }

  _laneClamp(x) {
    const lim = this.riverWidth * 0.46;
    return x < -lim ? -lim : x > lim ? lim : x;
  }

  _stream() {
    const s = this.state;
    const pz = (s && s.player && finite(s.player.z, 0)) || 0;
    const front = Math.max(pz, this._baseZ());
    const zMin = front - this.cullBehind;
    const zMax = front + this.streamAhead;

    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].z < zMin - 40) this._release(i);
    }

    const loWant = Math.floor(zMin / CELL);
    const hiWant = Math.floor(zMax / CELL);
    if (this.cellHi < this.cellLo) { this.cellLo = loWant; this.cellHi = loWant - 1; }
    if (loWant > this.cellLo) this.cellLo = loWant;

    // Fill the whole window on the first pass, then amortise a few cells a step.
    let budget = (this.t === 0) ? 1e9 : 24;
    while (this.cellHi < hiWant && budget-- > 0) {
      this.cellHi++;
      this._spawnCell(this.cellHi);
    }
  }

  _spawnCell(ci) {
    const S = this.seed;
    const zBase = ci * CELL;
    const perCell = this.density * CELL;

    const h0 = hash2(ci, 101, S);
    const h1 = hash2(ci, 211, S);
    const h2 = hash2(ci, 307, S);

    // --- log raft: a bundle of trunks lashed side by side, straight from the art
    if (h0 < 0.05) {
      const cx = this._laneClamp(this._laneCenter(zBase) + (hash2(ci, 409, S) * 2 - 1) * this._laneHalf() * 0.85);
      const cz = zBase + hash2(ci, 419, S) * CELL;
      const yaw = hash2(ci, 421, S) * TAU;
      const n = 4 + Math.floor(hash2(ci, 431, S) * 3);
      const px = -Math.sin(yaw), pz = -Math.cos(yaw); // perpendicular to the axis
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) * 0.5) * 1.05;
        this._spawn(T_LOG_BIG, ci, k + 60, cx + px * off, cz + pz * off, yaw, 0.92);
      }
      return;
    }

    // --- hazards -----------------------------------------------------------
    let count = Math.floor(perCell);
    if (h1 < perCell - count) count++;
    if (h1 > 0.94) count++;
    for (let j = 0; j < count; j++) this._spawnOne(ci, j, zBase, false);

    // --- cosmetic vegetation / debris --------------------------------------
    let dcount = 1;
    if (h2 < 0.55) dcount++;
    if (h2 > 0.86) dcount++;
    for (let j = 0; j < dcount; j++) this._spawnOne(ci, j + 32, zBase, true);
  }

  _spawnOne(ci, j, zBase, cosmetic) {
    const S = this.seed;
    const ha = hash2(ci, j * 13 + 1, S);
    const hb = hash2(ci, j * 13 + 2, S);
    const hc = hash2(ci, j * 13 + 3, S);
    const hd = hash2(ci, j * 13 + 4, S);

    const z = zBase + ha * CELL;
    const half = this._laneHalf();
    const lat = (hb * 2 - 1) * half;
    const x = this._laneClamp(this._laneCenter(z) + lat);
    const yaw = hc * TAU;

    let type;
    if (cosmetic) type = T_DEBRIS;
    else if (hd < 0.36) type = T_LOG_BIG;
    else if (hd < 0.66) type = T_LOG_SMALL;
    else if (hd < 0.82) type = T_CANOE;
    // riverboats prefer the flanks, like the moored fleet in the concept art
    else if (hd < 0.875) type = (Math.abs(lat) > half * 0.45) ? T_BOAT : T_CANOE;
    else type = T_DEBRIS;

    this._spawn(type, ci, j, x, z, yaw, 1);
  }

  _spawn(type, ci, j, x, z, yaw, sizeBias) {
    if (this.free.length === 0) return null;
    const S = this.seed;
    const r1 = hash2(ci, j * 17 + 7, S + 1);
    const r2 = hash2(ci, j * 17 + 8, S + 2);
    const r3 = hash2(ci, j * 17 + 9, S + 3);
    const r4 = hash2(ci, j * 17 + 10, S + 4);

    const o = this.pool[this.free.pop()];
    o.alive = 1;
    o.id = this._nextId++;
    o.type = type;
    o.cell = ci;
    o.x = x; o.z = z;
    o.yaw = yaw;
    o.ax = Math.cos(yaw); o.az = -Math.sin(yaw);
    o.roll = r1 * TAU;
    o.tilt = 0;
    o.vx = 0; o.vy = 0; o.vz = 0;
    o.wRoll = 0; o.wTilt = 0; o.wYaw = (r2 - 0.5) * 0.18;
    o.capsized = 0; o.rollTarget = 0;
    o.hitAt = -99;
    o.spinBias = r3 * 2 - 1;
    o.phase = r4 * TAU;

    let sx = 1, sy = 1;
    switch (type) {
      case T_LOG_BIG:
        sx = (0.80 + r1 * 0.42) * sizeBias;   // ~6.0 – 9.2 m
        sy = (0.78 + r2 * 0.46) * sizeBias;
        o.halfLen = 7.5 * sx * 0.5 - 0.45 * sy * 0.55;
        o.rad = 0.45 * sy * 1.28;
        o.top = 0.45 * sy * 1.35; o.bottom = -0.45 * sy;
        o.buoy = 44; o.float0 = -0.06; o.hdrag = 2.2; o.toss = 1.0;
        o.rolls = 1; o.alignRoll = 0; o.tiltK = 6.0;
        break;
      case T_LOG_SMALL:
        sx = 0.70 + r1 * 0.70;                // ~2.2 – 4.5 m
        sy = 0.72 + r2 * 0.62;
        o.halfLen = 3.2 * sx * 0.5 - 0.22 * sy * 0.4;
        o.rad = 0.22 * sy * 1.9;              // the galhada widens the footprint
        o.top = 0.50 * sy; o.bottom = -0.28 * sy;
        o.buoy = 50; o.float0 = -0.03; o.hdrag = 2.6; o.toss = 1.05;
        o.rolls = 1; o.alignRoll = 0; o.tiltK = 7.0;
        break;
      case T_CANOE:
        sx = 0.86 + r1 * 0.34; sy = sx;
        o.halfLen = 6.4 * sx * 0.42;
        o.rad = 0.78 * sx;
        o.top = 0.30 * sx; o.bottom = -0.56 * sx;
        o.buoy = 32; o.float0 = 0.33 * sx; o.hdrag = 1.35; o.toss = 0.60;
        o.rolls = 0; o.alignRoll = 1; o.tiltK = 4.0;
        break;
      case T_BOAT:
        sx = 0.82 + r1 * 0.42; sy = sx;
        o.halfLen = 13.0 * sx * 0.44;
        o.rad = 1.95 * sx;
        o.top = 2.40 * sx; o.bottom = -1.40 * sx;
        o.buoy = 22; o.float0 = 0.78 * sx; o.hdrag = 0.60; o.toss = 0.18;
        o.rolls = 0; o.alignRoll = 1; o.tiltK = 2.6;
        break;
      default:
        sx = 0.60 + r1 * 0.95; sy = sx;
        o.halfLen = 0.45 * sx;
        o.rad = 0.72 * sx;
        o.top = 0.24 * sx; o.bottom = -0.20 * sx;
        o.buoy = 58; o.float0 = -0.04; o.hdrag = 3.4; o.toss = 1.05;
        o.rolls = 0; o.alignRoll = 0; o.tiltK = 8.0;
        break;
    }
    o.sx = sx; o.sy = sy; o.sz = sy;
    o.floatBias = o.float0 + G / o.buoy;
    o.severity = TYPE_SEVERITY[type];
    if (type === T_LOG_SMALL) o.severity *= 0.72 + sx * 0.5;  // a big galhada hurts more
    o.y = this._height(x, z, this.t) + o.float0;
    o.paddler = (type === T_CANOE && r4 < 0.38) ? 1 : 0;

    // per-instance tint (multiplies the baked vertex colours)
    let tr = 0.86 + r3 * 0.30, tg = 0.86 + r3 * 0.28, tb = 0.86 + r3 * 0.24;
    if (type === T_CANOE && r2 < 0.40) {
      const hex = PAINTS[Math.floor(r3 * PAINTS.length) % PAINTS.length];
      this._col.setHex(hex);
      tr = 0.55 + this._col.r * 0.85;
      tg = 0.55 + this._col.g * 0.85;
      tb = 0.55 + this._col.b * 0.85;
    } else if (type === T_LOG_BIG || type === T_LOG_SMALL) {
      const wet = 0.72 + r4 * 0.50;           // freshly soaked trunks read darker
      tr *= wet; tg *= wet * 0.98; tb *= wet * 0.92;
    }
    o.cr = tr; o.cg = tg; o.cb = tb;

    this.active.push(o);
    return o;
  }

  _release(activeIndex) {
    const o = this.active[activeIndex];
    o.alive = 0;
    const last = this.active.length - 1;
    if (activeIndex !== last) this.active[activeIndex] = this.active[last];
    this.active.pop();
    this.free.push(o.slot);
  }

  // ------------------------------------------------------------------- step --

  step(dt) {
    if (!(dt > 0)) dt = 1 / 120;
    if (dt > 0.05) dt = 0.05;

    const s = this.state;
    this.t = (s && Number.isFinite(s.time)) ? s.time : this.t + dt;

    this._stream();
    this._integrate(dt, this.t);
    this._rebuildBuckets();

    if (this._hitCooldown > 0) this._hitCooldown -= dt;
    this._playerCollide(this.t);

    this._writeInstances();
  }

  _integrate(dt, t) {
    const list = this.active;
    const surgeGain = this.hasFlow ? 0.42 : 0.95;
    const p = this.state && this.state.player;
    const plx = p ? finite(p.x, 0) : 0;
    const plz = p ? finite(p.z, 0) : 0;

    for (let i = 0; i < list.length; i++) {
      const o = list[i];

      const wy = this._height(o.x, o.z, t);
      const d = o.z - this._crest(o.x, t);

      // Cheap path for anything far from the front and far from the surfer: out
      // there the river is flat, so bobbing on the surface is all it needs.
      const rx = o.x - plx, rz = o.z - plz;
      const near = (d > -70 && d < 90) || (rx * rx + rz * rz < 9000);

      // --- how hard the front is going off right under this obstacle ---------
      // Plateau across the churn right at the lip, tapering into clean water
      // ahead and into the whitewater behind.
      let kick = 0;
      if (near && d > -9 && d < 13) {
        const w = d < -3 ? (d + 9) / 6 : d > 7 ? (13 - d) / 6 : 1;
        kick = this._break(o.x, t) * w;
        if (kick < 0) kick = 0;
      }

      // --- vertical: buoyancy, gravity, water damping, and the heave of the
      //     bore itself. Aerated whitewater grips far less than still water, so
      //     the toss survives long enough to actually launch the thing.
      const sub = (wy + o.floatBias) - o.y;
      const submerged = sub > 0;
      if (submerged) {
        o.vy += (sub < SUB_CLAMP ? sub : SUB_CLAMP) * o.buoy * dt;
        o.vy -= o.vy * WATER_DAMP_Y * (1 - 0.62 * kick) * dt;
        o.vy -= G * dt;
        o.vy += kick * TOSS_UP * o.toss * dt;
      } else {
        o.vy -= G * dt;
        o.vy -= o.vy * AIR_DAMP_Y * dt;
      }
      if (kick > 0) {
        o.wRoll += (o.spinBias + Math.sin(t * 1.7 + o.phase) * 0.6) * kick * TOSS_SPIN * o.toss * dt;
        o.wTilt += Math.sin(t * 2.3 + o.phase * 1.7) * kick * TOSS_SPIN * 0.5 * o.toss * dt;
        o.wYaw += o.spinBias * 0.5 * kick * 1.6 * o.toss * dt;
      }

      if (o.vy < VY_MIN) o.vy = VY_MIN; else if (o.vy > VY_MAX) o.vy = VY_MAX;
      o.y += o.vy * dt;

      // --- horizontal: relax toward the water it is sitting in ---------------
      let fx = 0, fz = 0;
      if (near) { const f = this._flow(o.x, o.z, t); fx = f.x; fz = f.y; }
      fz += this.boreSpeed * surgeGain * kick;
      const hk = Math.min(1, (submerged ? o.hdrag : 0.22) * dt);
      o.vx += (fx - o.vx) * hk;
      o.vz += (fz - o.vz) * hk;
      o.x += o.vx * dt;
      o.z += o.vz * dt;

      // --- orientation --------------------------------------------------------
      const ax = o.ax, az = o.az;                          // long axis in XZ
      const lx = Math.sin(o.yaw), lz = Math.cos(o.yaw);    // lateral axis in XZ

      if (near) {
        const n = this._normal(o.x, o.z, t);
        const gx = -n.x / n.y, gz = -n.z / n.y;            // water height gradient
        const slopeAxis = clamp(gx * ax + gz * az, -1.6, 1.6);
        o.tilt += (Math.atan(slopeAxis) - o.tilt) * Math.min(1, o.tiltK * dt);
        if (o.alignRoll) {
          const slopeLat = clamp(gx * lx + gz * lz, -1.6, 1.6);
          o.rollTarget = o.capsized ? Math.PI : -Math.atan(slopeLat);
        }
      } else {
        o.tilt += (0 - o.tilt) * Math.min(1, 2.0 * dt);
        if (o.alignRoll) o.rollTarget = o.capsized ? Math.PI : 0;
      }

      const angDamp = submerged ? 2.0 : 0.25;

      if (o.rolls) {
        // A trunk barrel-rolls on the water shear across its own axis.
        const relx = fx - o.vx, relz = fz - o.vz;
        const cross = relx * -az + relz * ax;
        const targetW = -cross / Math.max(o.rad, 0.12) * 0.4;
        o.wRoll += (targetW - o.wRoll) * Math.min(1, 1.4 * dt);
        o.roll += o.wRoll * dt;
      } else if (o.alignRoll) {
        o.roll += o.wRoll * dt;
        let dr = o.rollTarget - o.roll;
        if (dr > Math.PI) dr -= TAU; else if (dr < -Math.PI) dr += TAU;
        o.roll += dr * Math.min(1, (o.capsized ? 1.6 : 3.2) * dt);
        // Enough tumbling energy and a tippy canoe goes over — and stays over.
        if (!o.capsized && o.type === T_CANOE && Math.abs(o.spinBias) > 0.4 &&
            (Math.abs(o.wRoll) > CAPSIZE_W || o.vy > CAPSIZE_VY)) {
          o.capsized = 1;
          o.float0 += 0.14;                    // an upturned hull rides higher
          o.floatBias = o.float0 + G / o.buoy;
          o.paddler = 0;
        }
      } else {
        o.roll += o.wRoll * dt;
      }

      o.tilt += o.wTilt * dt;
      o.yaw += o.wYaw * dt;
      o.wRoll -= o.wRoll * angDamp * dt;
      o.wTilt -= o.wTilt * (angDamp + 1.4) * dt;
      o.wYaw -= o.wYaw * (angDamp * 0.4 + 0.12) * dt;

      if (o.tilt > 1.35) o.tilt = 1.35; else if (o.tilt < -1.35) o.tilt = -1.35;
      if (o.roll > TAU) o.roll -= TAU; else if (o.roll < -TAU) o.roll += TAU;
      if (o.yaw > TAU) o.yaw -= TAU; else if (o.yaw < 0) o.yaw += TAU;
      o.ax = Math.cos(o.yaw); o.az = -Math.sin(o.yaw);

      // --- numerical hygiene: never let a bad neighbour poison the pool -------
      if (!(o.y > -400 && o.y < 400)) { o.y = wy + o.float0; o.vy = 0; }
      if (!(o.x > -6000 && o.x < 6000)) { o.x = this._laneCenter(o.z); o.vx = 0; }
      if (!(o.z > -1e7 && o.z < 1e7)) { o.z = plz; o.vz = 0; }
    }
  }

  _rebuildBuckets() {
    const b = this.buckets;
    for (let i = 0; i < NBUCKET; i++) if (b[i].length) b[i].length = 0;
    const list = this.active;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      let k = Math.floor(o.z / BUCKET) % NBUCKET;
      if (k < 0) k += NBUCKET;
      b[k].push(o);
    }
  }

  // -------------------------------------------------------------- collision --

  /**
   * Cheap XZ capsule lookup, called by physics every step. Allocates nothing:
   * the same result object is refilled and returned, so read it immediately.
   *
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} [r=0.85] query radius (board half-width-ish)
   * @param {number} [y] optional world Y — lets an air clear a floating log
   * @returns {{type:string, severity:number, kind:string, wipeout:boolean,
   *            nx:number, nz:number, dist:number, overlap:number,
   *            x:number, y:number, z:number, radius:number, id:number,
   *            vx:number, vz:number} | null}
   *   `severity` is 0..1 (>= 0.7 means wipeout, `kind` says it in words),
   *   `nx,nz` is the unit push-out direction, `dist` the signed distance to the
   *   obstacle surface (negative while overlapping) and `overlap` the depth.
   *   Cosmetic debris is never reported here — it cannot block the surfer.
   */
  query(x, z, r, y) {
    return this._scan(x, z, r, y, false) ? this._hit : null;
  }

  _scan(x, z, r, y, cosmetic) {
    if (!(x === x) || !(z === z)) return null;
    const R = (r > 0 && r < 60) ? r : 0.85;
    const pad = R + MAX_HALF_LEN + 2.4;
    const b0 = Math.floor((z - pad) / BUCKET);
    const b1 = Math.floor((z + pad) / BUCKET);
    const hasY = (typeof y === 'number') && (y === y);

    let best = null, bestScore = 0, bestPen = 0, bestD2 = 0, bestX = 0, bestZ = 0;

    for (let bi = b0; bi <= b1; bi++) {
      let k = bi % NBUCKET; if (k < 0) k += NBUCKET;
      const list = this.buckets[k];
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (!o.alive) continue;
        if (!cosmetic && o.severity < SOLID_MIN_SEVERITY) continue;
        const rz = z - o.z;
        if (rz > pad || rz < -pad) continue;
        const rx = x - o.x;
        const reach = R + o.rad + o.halfLen;
        if (rx > reach || rx < -reach) continue;
        if (hasY && y - 0.4 > o.y + o.top + 0.2) continue;   // flying clean over it

        let tp = rx * o.ax + rz * o.az;
        if (tp > o.halfLen) tp = o.halfLen; else if (tp < -o.halfLen) tp = -o.halfLen;
        const ddx = rx - o.ax * tp, ddz = rz - o.az * tp;
        const d2 = ddx * ddx + ddz * ddz;
        const rr = R + o.rad;
        if (d2 >= rr * rr) continue;

        const pen = rr - Math.sqrt(d2);
        const score = pen + o.severity * 1.5;   // a trunk outranks a leaf raft
        if (best === null || score > bestScore) {
          best = o; bestScore = score; bestPen = pen; bestD2 = d2; bestX = ddx; bestZ = ddz;
        }
      }
    }
    if (!best) return null;

    const h = this._hit;
    const dist = Math.sqrt(bestD2);
    let nx = bestX, nz = bestZ;
    if (dist > 1e-5) { nx /= dist; nz /= dist; }
    else { nx = -Math.sin(best.yaw); nz = -Math.cos(best.yaw); }

    h.type = TYPE_NAME[best.type];
    h.severity = best.severity;
    h.kind = TYPE_KIND[best.type];
    h.wipeout = best.severity >= 0.7;
    h.nx = nx; h.nz = nz;
    h.dist = dist - best.rad;
    h.overlap = bestPen;
    h.x = best.x; h.y = best.y; h.z = best.z;
    h.radius = best.rad;
    h.id = best.id;
    h.vx = best.vx; h.vz = best.vz;
    return best;
  }

  _playerCollide(t) {
    const s = this.state;
    const p = s && s.player;
    if (!p) return;
    if (p.wipeout || s.phase === 'wipeout' || s.phase === 'recover') return;

    const px = finite(p.x, 0), pz = finite(p.z, 0), py = finite(p.y, 0);
    const o = this._scan(px, pz, PLAYER_R, p.airborne ? py : undefined, true);
    if (!o) return;
    if (t - o.hitAt < HIT_COOLDOWN) return;
    o.hitAt = t;

    const h = this._hit;
    const speed = clamp(finite(p.speed, 0), 0, 40);

    // Knock the obstacle: a struck trunk spins away, a canoe takes the hit.
    const push = clamp(speed * 0.28, 0.6, 7) * (1.4 - o.severity * 0.6);
    o.vx -= h.nx * push;
    o.vz -= h.nz * push;
    o.vy += Math.min(2.6, speed * 0.13);
    o.wRoll += clamp((h.nx * o.ax + h.nz * o.az) * speed * 0.22, -5, 5);
    o.wYaw += clamp(o.spinBias * speed * 0.06, -2, 2);

    if (this.bus && (this._hitCooldown <= 0 || h.severity >= 0.7)) {
      this._hitCooldown = 0.15;
      this.bus.emit('obstacle:hit', {
        type: h.type,
        severity: h.severity,
        kind: h.kind,
        wipeout: h.wipeout,
        x: o.x, y: o.y, z: o.z,
        nx: h.nx, nz: h.nz,
        speed,
      });
    }
  }

  // ----------------------------------------------------------------- render --

  _writeInstances() {
    if (!this.enabled) return;
    const meshes = this.meshes;
    for (let t = 0; t < N_TYPES; t++) if (meshes[t]) meshes[t].count = 0;
    const pmesh = this.paddlerMesh;
    let pcount = 0;

    const list = this.active;
    const m = this._m, m2 = this._m2, p = this._p, q = this._q, e = this._e, sc = this._s;

    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const mesh = meshes[o.type];
      if (!mesh) continue;
      const slot = mesh.count;
      if (slot >= TYPE_CAP[o.type]) continue;

      e.set(o.roll, o.yaw, o.tilt);
      q.setFromEuler(e);
      p.set(o.x, o.y, o.z);
      sc.set(o.sx, o.sy, o.sz);
      m.compose(p, q, sc);
      mesh.setMatrixAt(slot, m);

      const ca = mesh.instanceColor;
      if (ca) {
        const arr = ca.array, k = slot * 3;
        arr[k] = o.cr; arr[k + 1] = o.cg; arr[k + 2] = o.cb;
      }
      mesh.count = slot + 1;

      if (o.paddler && pmesh && pcount < MAX_PADDLERS) {
        m2.makeTranslation(0.9, 0.02, 0);
        m2.premultiply(m);
        pmesh.setMatrixAt(pcount, m2);
        pcount++;
      }
    }

    for (let t = 0; t < N_TYPES; t++) {
      const mesh = meshes[t];
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (pmesh) {
      pmesh.count = pcount;
      pmesh.instanceMatrix.needsUpdate = true;
    }
  }

  // --------------------------------------------------------------- teardown --

  dispose() {
    if (this.scene && this.group.parent === this.scene) this.scene.remove(this.group);
    this.group.clear();
    for (const g of this._geos) g.dispose();
    for (const mt of this._mats) mt.dispose();
    for (const mesh of this.meshes) if (mesh) mesh.dispose();
    if (this.paddlerMesh) this.paddlerMesh.dispose();
    this._geos.length = 0;
    this._mats.length = 0;
    this.meshes.length = 0;
    this.paddlerMesh = null;
    this.active.length = 0;
    for (let i = 0; i < NBUCKET; i++) this.buckets[i].length = 0;
    this.enabled = false;
  }
}

export default Obstacles;
