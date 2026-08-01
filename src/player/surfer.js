// POROROCA RUSH — o surfista e a prancha.
//
// Builds the board + rider procedurally (no external assets) and animates the
// whole rig from `state.player` alone. Nothing here owns gameplay state: every
// pose is a smoothed function of speed / lean / crouch / airborne / wipeout.
//
// Frames used inside this file:
//   root      — world placement, rotation.y = heading (0 = +Z)
//   deck      — board attitude: pitch/roll from the water normal + rail roll
//   board*    — board space: +Z nose, +X starboard rail, y = 0 is the board bottom
//   riderRoot — copies `deck` while riding, decouples into a ragdoll on wipeout
//   rider     — the human faces its own +Z; its LEFT side is +X (three convention)

import * as THREE from 'three';
import { fbm2 } from '../core/rng.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
// Frame-rate independent exponential approach.
const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * Math.max(dt, 0)));
const fin = (v, fb = 0) => (Number.isFinite(v) ? v : fb);

// ---------------------------------------------------------------- board shape

const BOARD = {
  length: 1.92,
  halfWidth: 0.255,
  thickness: 0.074,
  deckShare: 0.60,        // fraction of thickness above the rail line
  rockerNose: 0.150,
  rockerTail: 0.050,
  sections: 46,
  radial: 20,
  railExp: 2 / 3,         // superellipse exponent — 2/3 ≈ boxy rail, flat bottom
};

// Plan-view outline, normalised half width against s ∈ [-1 (tail) .. +1 (nose)].
const HW_CTRL = [
  [-1.00, 0.30], [-0.85, 0.42], [-0.69, 0.55], [-0.40, 0.80],
  [-0.10, 0.98], [0.03, 1.00], [0.30, 0.90], [0.69, 0.55],
  [0.86, 0.34], [1.00, 0.055],
];

// Cubic Hermite through the control points (centred-difference tangents) so the
// rail line is smooth instead of the lumpy smoothstep-between-knots look.
function hwNorm(s) {
  s = clamp(s, -1, 1);
  const P = HW_CTRL, n = P.length;
  let i = 0;
  while (i < n - 2 && s > P[i + 1][0]) i++;
  const x0 = P[i][0], y0 = P[i][1], x1 = P[i + 1][0], y1 = P[i + 1][1];
  const h = x1 - x0 || 1e-6;
  const pm = P[i - 1] || P[i], pp = P[i + 2] || P[i + 1];
  const m0 = (y1 - pm[1]) / ((x1 - pm[0]) || 1e-6) * h;
  const m1 = (pp[1] - y0) / ((pp[0] - x0) || 1e-6) * h;
  const t = clamp((s - x0) / h, 0, 1), t2 = t * t, t3 = t2 * t;
  const v = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0
          + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
  return clamp(v, 0.03, 1.06);
}

const boardHalfW = (s) => BOARD.halfWidth * hwNorm(s);
const boardTh = (s) => BOARD.thickness * (1 - 0.62 * Math.pow(Math.abs(s), 2.4));
const boardRocker = (s) =>
  BOARD.rockerNose * Math.pow(Math.max(0, s), 2.9) +
  BOARD.rockerTail * Math.pow(Math.max(0, -s), 2.6);

// Deck (top) and bottom surface heights above the board-space y = 0 datum.
const deckTopAtS = (s) => boardRocker(s) + boardTh(s);
const sOfZ = (z) => clamp((z / (BOARD.length * 0.5)), -1, 1);

/** Lofted board hull with vertex-coloured deck / bottom / rail + traction pad. */
function buildBoardGeometry() {
  const N = BOARD.sections, M = BOARD.radial;
  const e = BOARD.railExp;
  const pos = [], col = [], idx = [];
  const cDeck = new THREE.Color(0xefe7d4);
  const cBottom = new THREE.Color(0xd6c5a2);
  const cRail = new THREE.Color(0x2e6a4a);
  const cPad = new THREE.Color(0x24251f);
  const tmp = new THREE.Color();

  const sAt = (i) => -Math.cos(Math.PI * (i / (N - 1)));   // Chebyshev: dense at the tips

  for (let i = 0; i < N; i++) {
    const s = sAt(i);
    const z = s * BOARD.length * 0.5;
    const w = boardHalfW(s);
    const th = boardTh(s);
    const thTop = th * BOARD.deckShare, thBot = th * (1 - BOARD.deckShare);
    const cy = boardRocker(s) + thBot;                      // rail-line height
    const padW = smoothstep(-0.30, -0.50, s);              // traction pad astern

    for (let k = 0; k < M; k++) {
      const a = (k / M) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = w * Math.sign(ca) * Math.pow(Math.abs(ca), e);
      const yr = (sa >= 0 ? thTop : thBot) * Math.sign(sa) * Math.pow(Math.abs(sa), e);
      pos.push(x, cy + yr, z);

      const deckW = smoothstep(0.28, 0.62, sa);
      const botW = smoothstep(0.28, 0.62, -sa);
      tmp.copy(cRail).lerp(cBottom, botW).lerp(cDeck, deckW).lerp(cPad, deckW * padW);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let k = 0; k < M; k++) {
      const a = i * M + k, b = i * M + ((k + 1) % M);
      const c = (i + 1) * M + k, d = (i + 1) * M + ((k + 1) % M);
      idx.push(a, c, b, b, c, d);
    }
  }
  // Tip caps.
  const capAt = (i, flip) => {
    const s = sAt(i), z = s * BOARD.length * 0.5;
    const cy = boardRocker(s) + boardTh(s) * (1 - BOARD.deckShare) * 0.5 + boardTh(s) * 0.12;
    const ci = pos.length / 3;
    pos.push(0, cy, z);
    tmp.copy(cBottom).lerp(cDeck, 0.5);
    col.push(tmp.r, tmp.g, tmp.b);
    for (let k = 0; k < M; k++) {
      const a = i * M + k, b = i * M + ((k + 1) % M);
      if (flip) idx.push(ci, a, b); else idx.push(ci, b, a);
    }
  };
  capAt(0, true);
  capAt(N - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Thin centre stripe ribbon hugging the deck. */
function buildStripeGeometry() {
  const N = 34, w = 0.024, lift = 0.0022;
  const pos = [], idx = [];
  for (let i = 0; i < N; i++) {
    const s = lerp(-0.72, 0.86, i / (N - 1));
    const z = s * BOARD.length * 0.5;
    const y = deckTopAtS(s) + lift;
    const k = w * (0.55 + 0.45 * Math.cos(s * 1.4));
    pos.push(-k, y, z, k, y, z);
    if (i < N - 1) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** One thruster fin: profile in the (z,y) plane, thickness along x. */
function buildFinGeometry() {
  const sh = new THREE.Shape();
  // x = along the board (z), y = up (later mapped to -y so it hangs down)
  sh.moveTo(-0.055, 0);
  sh.quadraticCurveTo(-0.052, 0.055, -0.018, 0.092);
  sh.quadraticCurveTo(0.004, 0.115, 0.030, 0.118);
  sh.quadraticCurveTo(0.020, 0.086, 0.038, 0.052);
  sh.quadraticCurveTo(0.056, 0.020, 0.062, 0);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: 0.009, bevelEnabled: true, bevelSize: 0.0035, bevelThickness: 0.003,
    bevelSegments: 2, curveSegments: 8,
  });
  g.translate(0, 0, -0.006);
  // shape(x,y,z) -> board(z, -y, x):  nose axis = shape x, fin hangs down, thickness across
  const m = new THREE.Matrix4().set(
    0, 0, 1, 0,
    0, -1, 0, 0,
    1, 0, 0, 0,
    0, 0, 0, 1,
  );
  g.applyMatrix4(m);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ rider bits

/** Tapered, round-capped limb: top joint at y = 0, tip at y = -len. */
function limbGeometry(rTop, rBot, len, seg = 8, bulge = 1.06) {
  const p = [], CAP = 3;
  p.push(new THREE.Vector2(0, -len - rBot));
  for (let k = 1; k <= CAP; k++) {
    const a = -HALF_PI + HALF_PI * (k / CAP);
    p.push(new THREE.Vector2(rBot * Math.cos(a), -len + rBot * Math.sin(a)));
  }
  p.push(new THREE.Vector2(lerp(rBot, rTop, 0.55) * bulge, -len * 0.45));
  p.push(new THREE.Vector2(rTop, 0));
  for (let k = 1; k <= CAP; k++) {
    const a = HALF_PI * (k / CAP);
    p.push(new THREE.Vector2(rTop * Math.cos(a), rTop * Math.sin(a)));
  }
  const g = new THREE.LatheGeometry(p, seg);
  g.computeVertexNormals();
  return g;
}

function blobGeometry(sx, sy, sz, ox = 0, oy = 0, oz = 0, seg = 10) {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 2));
  g.scale(sx, sy, sz);
  g.translate(ox, oy, oz);
  return g;
}

/** Small procedural camo texture — dark blotches, used on shirt and boardshorts. */
function makeCamoTexture(seed) {
  try {
    const S = 96;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx2 = cv.getContext('2d');
    if (!ctx2) return null;
    const img = ctx2.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = fbm2(x * 0.075, y * 0.075, 3, seed);
        const m = fbm2(x * 0.021 + 31.7, y * 0.021 - 12.3, 2, seed + 977);
        let v = 0.42 + 0.58 * smoothstep(0.42, 0.58, n * 0.65 + m * 0.35);
        v *= 0.82 + 0.18 * fbm2(x * 0.5, y * 0.5, 2, seed + 13);
        const i = (y * S + x) * 4;
        img.data[i] = 255 * v;
        img.data[i + 1] = 255 * v * (0.95 + 0.05 * m);
        img.data[i + 2] = 255 * v * 0.88;
        img.data[i + 3] = 255;
      }
    }
    ctx2.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    tex.anisotropy = 4;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------- scratch objects

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _pt = new THREE.Vector3(), _pole = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qC = new THREE.Quaternion();
// dedicated saves — twoBoneIK clobbers _q1.._q3 internally
const _qFkS = new THREE.Quaternion(), _qFkE = new THREE.Quaternion(), _qIk = new THREE.Quaternion();
const _pA = new THREE.Vector3();
const _e1 = new THREE.Euler();
const _nrm = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Analytic two-bone IK. `target` and the returned rotations live in
 * rootJoint.parent space. Rest direction of both bones is -Y.
 * Returns the accumulated rotation of the second bone (for the end effector).
 */
function twoBoneIK(rootJoint, midJoint, l1, l2, target, pole, outQ) {
  const o = rootJoint.position;
  _v1.copy(target).sub(o);
  let dist = _v1.length();
  if (!(dist > 1e-5)) { _v1.set(0, -1, 0); dist = 1e-5; }
  const maxD = (l1 + l2) * 0.998;
  const minD = Math.abs(l1 - l2) * 1.02 + 1e-3;
  const dc = clamp(dist, minD, maxD);
  const dir = _v2.copy(_v1).multiplyScalar(1 / dist);
  const cosA = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
  const a = Math.acos(cosA);

  _v3.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (_v3.lengthSq() < 1e-8) {
    _v3.set(0, 0, 1).addScaledVector(dir, -dir.z);
    if (_v3.lengthSq() < 1e-8) _v3.set(1, 0, 0);
  }
  _v3.normalize();

  const b1 = _v4.copy(dir).multiplyScalar(Math.cos(a)).addScaledVector(_v3, Math.sin(a)).normalize();
  _q1.setFromUnitVectors(DOWN, b1);
  rootJoint.quaternion.copy(_q1);

  _v5.copy(o).addScaledVector(b1, l1);
  _v6.copy(target).sub(_v5);
  if (_v6.lengthSq() < 1e-8) _v6.copy(b1); else _v6.normalize();
  _q2.setFromUnitVectors(DOWN, _v6);
  midJoint.quaternion.copy(_q3.copy(_q1).invert().multiply(_q2));
  if (outQ) outQ.copy(_q2);
  return _q2;
}

// --------------------------------------------------------------------- class

export class Surfer {
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.state = ctx.state || null;
    this.bore = ctx.bore || null;
    const cfg = ctx.config || {};
    this.cfg = cfg;
    this.maxSpeed = fin(cfg.physics && cfg.physics.maxSpeed, 24);
    this.seed = (fin(cfg.seed, 20260801) | 0) ^ 0x5f37;

    this._disposed = false;
    this._geos = new Set();
    this._mats = new Set();
    this._texs = new Set();

    // ---- smoothed animation state (never gameplay state)
    this.a = {
      lean: 0, speed: 0, crouch: 0, air: 0, grab: 0, tube: 0, wipe: 0,
      slip: 0, pitch: 0, roll: 0, hipY: 0.72, gforce: 1, reachL: 0, reachR: 0,
      pump: 0, land: 0,
    };
    this._t = 0;
    this._spinExtra = 0;
    this._headAcc = 0;         // unwrapped heading travelled since take-off
    this._prevHeading = 0;
    this._prevAir = false;
    this._prevWipe = false;
    this._wipeT = 0;
    this._wipeSpin = 0;
    this._wipeSide = 1;
    this._landPulse = 0;

    this._buildMaterials();
    this._buildBoard();
    this._buildRider();

    if (this.scene && this.root) this.scene.add(this.root);

    // Put the rig somewhere sane before the first physics step lands.
    try { this.step(0); } catch (e) { /* boot must survive a half-built neighbour */ }
  }

  // ------------------------------------------------------------- construction

  _reg(o) {
    if (!o) return o;
    if (o.isBufferGeometry) this._geos.add(o);
    else if (o.isMaterial) this._mats.add(o);
    else if (o.isTexture) this._texs.add(o);
    return o;
  }

  _mesh(geo, mat, parent, cast = true) {
    const m = new THREE.Mesh(this._reg(geo), mat);
    m.castShadow = cast;
    m.receiveShadow = false;
    m.matrixAutoUpdate = true;
    if (parent) parent.add(m);
    return m;
  }

  _buildMaterials() {
    const camo = makeCamoTexture(this.seed);
    if (camo) this._reg(camo);
    this.tex = { camo };

    const M = (o) => this._reg(new THREE.MeshStandardMaterial(o));
    this.mat = {
      board: M({ vertexColors: true, roughness: 0.24, metalness: 0.02 }),
      stripe: M({ color: 0x2e6a4a, roughness: 0.3, metalness: 0.02 }),
      fin: M({ color: 0x1f2320, roughness: 0.32, metalness: 0.04 }),
      skin: M({ color: 0xa8703f, roughness: 0.62, metalness: 0.0 }),
      shirt: M({ color: 0x3a3b30, map: camo || null, roughness: 0.86, metalness: 0.0 }),
      shorts: M({ color: 0x24261f, map: camo || null, roughness: 0.9, metalness: 0.0 }),
      hair: M({ color: 0x140f0c, roughness: 0.46, metalness: 0.0 }),
      band: M({ color: 0x8a2f18, roughness: 0.7, metalness: 0.0 }),
    };
  }

  _buildBoard() {
    this.root = new THREE.Object3D();
    this.root.name = 'surfer';
    this.root.matrixAutoUpdate = true;

    this.deck = new THREE.Object3D();
    this.root.add(this.deck);

    this.boardWipe = new THREE.Object3D();
    this.deck.add(this.boardWipe);

    this.board = new THREE.Object3D();
    this.boardWipe.add(this.board);

    // The deck takes the rider's shadow — cheap and it sells the contact.
    this._mesh(buildBoardGeometry(), this.mat.board, this.board).receiveShadow = true;
    this._mesh(buildStripeGeometry(), this.mat.stripe, this.board);

    const finGeo = this._reg(buildFinGeometry());
    const place = (x, z, cant, toe, scale) => {
      const f = new THREE.Mesh(finGeo, this.mat.fin);
      f.castShadow = true;
      f.position.set(x, boardRocker(sOfZ(z)) + 0.004, z);
      f.rotation.set(0, toe, cant);
      f.scale.setScalar(scale);
      this.board.add(f);
      return f;
    };
    place(0.125, -0.60, -0.16, -0.05, 0.95);
    place(-0.125, -0.60, 0.16, 0.05, 0.95);
    place(0, -0.76, 0, 0, 0.82);
  }

  _buildRider() {
    const S = this.stance = {
      thigh: 0.44, shin: 0.43, ankleH: 0.062,
      upperArm: 0.30, forearm: 0.27,
      hipX: 0.095, shoulderX: 0.185, shoulderY: 0.115,
      frontFootZ: 0.30, backFootZ: -0.38,
      yaw: -1.02,                    // regular stance: left foot toward the nose
    };

    this.riderRoot = new THREE.Object3D();
    this.root.add(this.riderRoot);

    this.hipsTilt = new THREE.Object3D();
    this.riderRoot.add(this.hipsTilt);

    this.hips = new THREE.Object3D();
    this.hipsTilt.add(this.hips);

    this.spine = new THREE.Object3D();
    this.spine.position.set(0, 0.11, 0);
    this.hips.add(this.spine);

    this.chest = new THREE.Object3D();
    this.chest.position.set(0, 0.20, 0);
    this.spine.add(this.chest);

    this.neck = new THREE.Object3D();
    this.neck.position.set(0, 0.20, 0);
    this.chest.add(this.neck);

    this.head = new THREE.Object3D();
    this.head.position.set(0, 0.075, 0);
    this.neck.add(this.head);

    // torso / shorts -----------------------------------------------------
    const torso = this._mesh(limbGeometry(0.168, 0.142, 0.30, 12, 1.0), this.mat.shirt, this.spine);
    torso.position.y = 0.305;
    torso.scale.set(1.0, 1.0, 0.74);

    const shorts = this._mesh(limbGeometry(0.163, 0.150, 0.26, 12, 1.05), this.mat.shorts, this.hips);
    shorts.position.y = 0.075;
    shorts.scale.set(1.0, 1.0, 0.82);

    // head ---------------------------------------------------------------
    this._mesh(limbGeometry(0.052, 0.058, 0.055, 8), this.mat.skin, this.neck).position.y = 0.06;
    const skull = this._mesh(blobGeometry(0.098, 0.113, 0.104, 0, 0.085, 0.004, 12), this.mat.skin, this.head);
    skull.name = 'head';
    const hairCap = new THREE.SphereGeometry(1, 14, 10, 0, TAU, 0, 0.66 * Math.PI);
    hairCap.scale(0.106, 0.122, 0.113);
    hairCap.translate(0, 0.078, -0.008);
    const hair = this._mesh(hairCap, this.mat.hair, this.head);
    hair.rotation.x = -0.30;

    this.hairStrands = [];
    const strandGeo = this._reg(limbGeometry(0.026, 0.010, 0.15, 6, 1.0));
    for (let i = 0; i < 6; i++) {
      const n = new THREE.Object3D();
      const a = -0.9 + (i / 5) * 1.8;
      n.position.set(Math.sin(a) * 0.075, 0.115, -0.045 - Math.cos(a) * 0.03);
      this.head.add(n);
      const m = new THREE.Mesh(strandGeo, this.mat.hair);
      m.castShadow = true;
      n.add(m);
      this.hairStrands.push({ node: n, base: n.rotation.clone(), phase: i * 1.37 });
    }

    // legs ----------------------------------------------------------------
    this.legs = [];
    for (const side of [1, -1]) {   // +1 = left (+X), -1 = right
      const hip = new THREE.Object3D();
      hip.position.set(side * S.hipX, -0.02, 0);
      this.hips.add(hip);
      const knee = new THREE.Object3D();
      knee.position.set(0, -S.thigh, 0);
      hip.add(knee);
      const ankle = new THREE.Object3D();
      ankle.position.set(0, -S.shin, 0);
      knee.add(ankle);

      this._mesh(limbGeometry(0.098, 0.070, S.thigh, 8), this.mat.skin, hip);
      this._mesh(limbGeometry(0.117, 0.100, 0.20, 10, 1.02), this.mat.shorts, hip).position.y = 0.01;
      this._mesh(limbGeometry(0.072, 0.045, S.shin, 8), this.mat.skin, knee);
      this._mesh(blobGeometry(0.047, 0.032, 0.104, 0, -0.030, 0.026, 10), this.mat.skin, ankle);

      this.legs.push({ side, hip, knee, ankle });
    }

    // arms ----------------------------------------------------------------
    this.arms = [];
    for (const side of [1, -1]) {
      const sh = new THREE.Object3D();
      sh.position.set(side * S.shoulderX, S.shoulderY, 0);
      this.chest.add(sh);
      const el = new THREE.Object3D();
      el.position.set(0, -S.upperArm, 0);
      sh.add(el);
      const wr = new THREE.Object3D();
      wr.position.set(0, -S.forearm, 0);
      el.add(wr);

      this._mesh(limbGeometry(0.062, 0.046, S.upperArm, 8), this.mat.skin, sh);
      this._mesh(limbGeometry(0.078, 0.068, 0.135, 9, 1.02), this.mat.shirt, sh).position.y = 0.028;
      this._mesh(limbGeometry(0.047, 0.036, S.forearm, 8), this.mat.skin, el);
      this._mesh(blobGeometry(0.044, 0.082, 0.021, 0, -0.078, 0.004, 8), this.mat.skin, wr);
      if (side < 0) this._mesh(blobGeometry(0.040, 0.014, 0.040, 0, -0.012, 0, 8), this.mat.band, wr);

      this.arms.push({
        side, sh, el, wr,
        fk: { raise: 0.85, swing: -0.2, bend: 0.55, twist: 0 },
      });
    }
  }

  // ------------------------------------------------------------------ helpers

  _noise(freq, chan) {
    return fbm2(this._t * freq, chan * 7.31, 2, this.seed + chan * 101) * 2 - 1;
  }

  /** Water normal under (x,z) with graceful fallbacks. */
  _waterNormal(x, z, t, out) {
    const b = this.bore;
    if (b && typeof b.normal === 'function') {
      try {
        const n = b.normal(x, z, t, out);
        const v = n && n.isVector3 ? n : out;
        if (Number.isFinite(v.x) && Number.isFinite(v.y) && v.y > 0.05) {
          return out.copy(v).normalize();
        }
      } catch (e) { /* fall through */ }
    }
    if (b && typeof b.height === 'function') {
      try {
        const h = 0.7, inv = 1 / (2 * h);
        const gx = clamp((b.height(x + h, z, t) - b.height(x - h, z, t)) * inv, -1.4, 1.4);
        const gz = clamp((b.height(x, z + h, t) - b.height(x, z - h, t)) * inv, -1.4, 1.4);
        if (Number.isFinite(gx) && Number.isFinite(gz)) return out.set(-gx, 1, -gz).normalize();
      } catch (e) { /* fall through */ }
    }
    return out.set(0, 1, 0);
  }

  _waterHeight(x, z, t) {
    const b = this.bore;
    if (b && typeof b.height === 'function') {
      try {
        const h = b.height(x, z, t);
        if (Number.isFinite(h)) return h;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  // --------------------------------------------------------------------- step

  step(dt) {
    if (this._disposed || !this.root) return;
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    const st = this.state;
    const p = (st && st.player) || {};
    const tr = (st && st.trick) || {};
    const t = fin(st && st.time, this._t);
    this._t = t;

    const a = this.a;

    // ---- drivers ------------------------------------------------------
    const speed01 = clamp(fin(p.speed, 0) / (this.maxSpeed || 24), 0, 1);
    const leanRaw = clamp(fin(p.lean, 0), -1, 1);
    const airborne = !!p.airborne;
    const wiping = !!p.wipeout || (st && st.phase === 'wipeout');
    const grabbing = !!(tr.grab || (st && st.input && st.input.grab)) && airborne;
    const tubeRaw = p.inTube ? 1 : 0;
    const crouchRaw = clamp(fin(p.crouch, 0), 0, 1);

    a.speed = damp(a.speed, speed01, 4.5, dt);
    a.lean = damp(a.lean, leanRaw, 7.5, dt);
    a.crouch = damp(a.crouch, clamp(crouchRaw + tubeRaw * 0.45, 0, 1), 6.0, dt);
    a.tube = damp(a.tube, tubeRaw, 3.4, dt);
    a.air = damp(a.air, airborne ? 1 : 0, airborne ? 9.0 : 6.5, dt);
    a.grab = damp(a.grab, grabbing ? 1 : 0, 8.5, dt);
    a.slip = damp(a.slip, clamp(fin(p.spraySlip, 0), 0, 1), 6.0, dt);
    a.gforce = damp(a.gforce, clamp(fin(p.gForce, 1), 0, 4), 5.0, dt);
    a.pump = fin(p.pumpPhase, a.pump);

    // landing pulse (compression on touchdown)
    if (this._prevAir && !airborne) this._landPulse = 1;
    this._landPulse = damp(this._landPulse, 0, 5.2, dt);

    // ---- wipeout bookkeeping -----------------------------------------
    if (wiping && !this._prevWipe) {
      this._wipeT = 0; this._wipeSpin = 0;
      this._wipeSide = (fbm2(t * 3.1, 4.2, 2, this.seed) > 0.5) ? 1 : -1;
    }
    if (wiping) {
      this._wipeT += dt;
      this._wipeSpin += dt * 7.5 * Math.exp(-this._wipeT * 1.1);
    } else if (this._wipeT > 0) {
      this._wipeT = Math.max(0, this._wipeT - dt * 1.6);
    }
    a.wipe = damp(a.wipe, wiping ? 1 : 0, wiping ? 7.0 : 3.2, dt);
    const W = a.wipe;

    // ---- world placement ---------------------------------------------
    const px = fin(p.x, 0), pz = fin(p.z, 0);
    const waterY = this._waterHeight(px, pz, t);
    let py = fin(p.y, NaN);
    if (!Number.isFinite(py)) py = waterY !== null ? waterY : fin(p.surfaceY, 0);
    // Safety net: if physics never wrote y (or drifted absurdly) ride the surface.
    if (waterY !== null && !airborne && Math.abs(py - waterY) > 2.5) py = waterY;

    const sink = airborne ? 0 : lerp(0.045, 0.012, a.speed) + W * 0.06;
    this.root.position.set(px, py - sink, pz);

    // heading + spin ----------------------------------------------------
    const heading = fin(p.heading, 0);
    let dHead = (heading - this._prevHeading) % TAU;
    if (dHead > Math.PI) dHead -= TAU; else if (dHead < -Math.PI) dHead += TAU;
    this._prevHeading = heading;

    if (airborne && !this._prevAir) this._headAcc = 0;
    if (airborne) this._headAcc += dHead;
    // If physics already spins `heading` during the air, trick.rotation is
    // redundant — only apply whatever it has NOT accounted for.
    const trickRot = fin(tr.rotation, 0);
    const residual = airborne ? (trickRot - this._headAcc) : 0;
    this._spinExtra = damp(this._spinExtra, airborne ? residual : 0, airborne ? 14 : 5, dt);

    const slipYaw = -a.slip * 0.34 * Math.sign(a.lean || 1);
    this.root.rotation.set(0, heading + this._spinExtra + slipYaw, 0);

    // ---- board attitude ------------------------------------------------
    this._waterNormal(px, pz, t, _nrm);
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const rx = Math.cos(heading), rz = -Math.sin(heading);
    const ny = Math.max(_nrm.y, 0.15);
    const gF = clamp(-(_nrm.x * fx + _nrm.z * fz) / ny, -1.1, 1.1);  // d(height)/d(forward)
    const gR = clamp(-(_nrm.x * rx + _nrm.z * rz) / ny, -1.1, 1.1);

    let pitchT = -Math.atan(gF);
    let rollT = Math.atan(gR);
    if (airborne) { pitchT *= 0.15; rollT *= 0.15; }
    // planing trim: nose lifts with speed, drops when braking into the face
    pitchT += -0.035 - a.speed * 0.05 + this._landPulse * 0.10;
    // rail engagement: the inside (+X when lean > 0) rail digs in
    rollT += -a.lean * (0.38 + 0.20 * a.speed) * (1 - a.air * 0.75);
    rollT += this._noise(0.9, 3) * 0.012;
    pitchT += this._noise(1.1, 4) * 0.010;

    a.pitch = damp(a.pitch, pitchT, 9.0, dt);
    a.roll = damp(a.roll, rollT, 8.0, dt);
    this.deck.rotation.set(a.pitch, 0, a.roll);

    this._poseBoardWipe(dt, W);
    this._poseRider(dt, p, W);

    this._prevAir = airborne;
    this._prevWipe = wiping;
  }

  /** Board tearing loose and floating away during a wipeout. */
  _poseBoardWipe(dt, W) {
    const n = this.boardWipe;
    if (W < 1e-3) {
      n.position.set(0, 0, 0);
      n.rotation.set(0, 0, 0);
      return;
    }
    const e = clamp(this._wipeT / 1.4, 0, 1);
    const s = this._wipeSide;
    const bob = Math.sin(this._t * 1.9 + s) * 0.05 + Math.sin(this._t * 3.3) * 0.02;
    n.position.set(
      W * s * (0.55 + 1.5 * e),
      W * (0.35 * Math.exp(-this._wipeT * 1.6) + bob * e),
      W * (-0.25 - 0.9 * e),
    );
    n.rotation.set(
      W * (this._wipeSpin * 0.9 + 0.20 * Math.sin(this._t * 1.4)),
      W * (this._wipeSpin * 0.6 * s),
      W * (this._wipeSpin * 1.1 * s + 0.28 * Math.sin(this._t * 1.7)),
    );
  }

  // ------------------------------------------------------------------ posing

  _poseRider(dt, p, W) {
    const a = this.a, S = this.stance;

    // ---- rider frame vs. the deck --------------------------------------
    if (W < 1e-3) {
      this.riderRoot.quaternion.copy(this.deck.quaternion);
      this.riderRoot.position.set(0, 0, 0);
    } else {
      const e = clamp(this._wipeT / 1.1, 0, 1);
      _e1.set(
        lerp(0, 1.35, e) + 0.32 * Math.sin(this._wipeSpin * 1.7),
        this._wipeSpin * 0.85 * this._wipeSide,
        (lerp(0, 0.85, e) + 0.26 * Math.sin(this._wipeSpin * 2.3)) * -this._wipeSide,
      );
      _qA.setFromEuler(_e1);
      _qB.copy(this.deck.quaternion).multiply(_qA);
      this.riderRoot.quaternion.copy(this.deck.quaternion).slerp(_qB, W);
      this.riderRoot.position.set(
        W * this._wipeSide * -0.28 * e,
        W * (0.14 - 0.42 * e),
        W * (0.22 * e),
      );
    }

    // ---- hips -----------------------------------------------------------
    const micro = this._noise(0.62, 1) * 0.012 + this._noise(1.9, 2) * 0.005;
    const pumpBob = Math.sin(a.pump) * 0.028 * a.speed * (1 - a.air);

    let legExt = 0.72 - a.crouch * 0.27 - a.speed * 0.035 - a.air * 0.15
               - a.grab * 0.34                       // tuck so the hand can find the rail
               - this._landPulse * 0.13 + pumpBob + micro
               + (a.gforce - 1) * -0.02;
    legExt = clamp(legExt, 0.28, 0.83);

    const frontZ = S.frontFootZ, backZ = S.backFootZ;
    const midZ = (frontZ + backZ) * 0.5;
    const deckMid = deckTopAtS(sOfZ(midZ));

    const hy = S.yaw + a.lean * 0.26 - a.crouch * 0.10;
    // Board +X (the inside rail of a lean > 0 carve) maps to the rider's own +X
    // (their LEFT) because cos(stanceYaw) stays positive over the stance range —
    // so a positive lean drops the left arm, a negative lean the right one.
    const dropL = clamp(a.lean, 0, 1);
    const dropR = clamp(-a.lean, 0, 1);

    this.hipsTilt.position.set(
      a.lean * 0.075 + this._noise(0.5, 5) * 0.008,
      deckMid + S.ankleH + legExt,
      midZ + a.speed * 0.045 + a.crouch * 0.03 - a.grab * 0.05
        + this._noise(0.44, 6) * 0.008,
    );
    // Body leans into the carve (fore/aft projection is handled by the spine).
    this.hipsTilt.rotation.set(0, 0, -a.lean * (0.30 + 0.14 * a.speed) * (1 - W * 0.6));
    this.hips.rotation.set(0, hy, 0);

    // ---- spine / chest / head -------------------------------------------
    const fold = 0.20 + a.speed * 0.16 + a.crouch * 0.62 + a.air * 0.22
               + a.grab * 0.95 + this._landPulse * 0.18 + this._noise(0.8, 7) * 0.02;
    const twist = a.lean * 0.30 + a.slip * 0.12;
    const side = -a.lean * 0.12;

    this.spine.rotation.set(fold * 0.55 * (1 - W * 0.9) + W * -0.45, twist * 0.4, side * 0.5);
    this.chest.rotation.set(fold * 0.45 * (1 - W * 0.9) + W * -0.30, twist * 0.6, side * 0.5);
    this.neck.rotation.set(-fold * 0.42 + W * 0.55, 0, 0);
    this.head.rotation.set(
      -fold * 0.16 - a.crouch * 0.10 + this._noise(0.7, 8) * 0.05,
      a.lean * 0.42 + this._noise(0.55, 9) * 0.07,
      -a.lean * 0.10,
    );

    // ---- hair ------------------------------------------------------------
    // Wind in rider space: opposite the board's forward axis, rotated by -hy.
    const wx = -Math.sin(-hy), wz = -Math.cos(-hy);
    const amp = 0.42 + a.speed * 0.95 + a.air * 0.18;
    for (let i = 0; i < this.hairStrands.length; i++) {
      const h = this.hairStrands[i];
      const n = this._noise(1.7, 20 + i) * (0.10 + a.speed * 0.16);
      h.node.rotation.set(
        -wz * amp + n + 0.25 + W * 0.5,
        n * 0.5,
        wx * amp * 0.85 + n * 0.6,
      );
    }

    // ---- legs (IK onto the deck) -----------------------------------------
    _qA.copy(this.hipsTilt.quaternion).multiply(this.hips.quaternion);
    _qB.copy(_qA).invert();
    const hipsPos = this.hipsTilt.position;

    const ragged = W > 1e-3;
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      const front = leg.side > 0;                      // regular: left foot forward
      const fz = front ? frontZ : backZ;
      const fs = sOfZ(fz);

      // Foot plant in board space.
      let tx = (front ? -0.018 : 0.020) + a.lean * (front ? -0.02 : 0.02);
      let ty = deckTopAtS(fs) + S.ankleH;
      let tz = fz + a.crouch * (front ? 0.02 : -0.02);

      if (ragged) {
        const n1 = this._noise(1.3, 30 + i * 3), n2 = this._noise(1.7, 31 + i * 3);
        const rx2 = leg.side * (0.34 + 0.16 * n1);
        const ry2 = deckMid + 0.30 + 0.22 * n2 + S.ankleH;
        const rz2 = midZ + (front ? 0.26 : -0.20) + 0.18 * n1;
        tx = lerp(tx, rx2, W); ty = lerp(ty, ry2, W); tz = lerp(tz, rz2, W);
      }

      _pt.set(tx, ty, tz).sub(hipsPos).applyQuaternion(_qB);
      _pole.set(leg.side * (0.30 + a.crouch * 0.35), 0.18, 1).normalize();
      const qShin = twoBoneIK(leg.hip, leg.knee, S.thigh, S.shin, _pt, _pole, _q3);

      // Sole flat on the deck: desired foot orientation in board space, then
      // pulled back through the accumulated shin rotation.
      const footYaw = hy + (front ? 0.0 : -0.30);
      _e1.set(0, footYaw, 0);
      _qC.setFromEuler(_e1);
      _qC.premultiply(_qB);                                  // -> hips space
      leg.ankle.quaternion.copy(qShin).invert().multiply(_qC);
      if (ragged) {
        _qA.setFromEuler(_e1.set(-0.5 * W, 0, 0));
        leg.ankle.quaternion.multiply(_qA);
      }
    }

    // ---- arms -------------------------------------------------------------
    this._poseArms(dt, p, W, dropL, dropR);
  }

  _poseArms(dt, p, W, dropL, dropR) {
    const a = this.a, S = this.stance;

    a.reachL = damp(a.reachL, dropL, 6.5, dt);
    a.reachR = damp(a.reachR, dropR, 6.5, dt);

    // Accumulated chest transform in board space (for the IK targets).
    _qA.copy(this.hipsTilt.quaternion).multiply(this.hips.quaternion);
    _pA.copy(this.hipsTilt.position);
    _pA.add(_v1.copy(this.spine.position).applyQuaternion(_qA));
    _qA.multiply(this.spine.quaternion);
    _pA.add(_v1.copy(this.chest.position).applyQuaternion(_qA));
    _qA.multiply(this.chest.quaternion);
    _qB.copy(_qA).invert();

    const tubeReach = clamp(a.tube * 0.8 + a.crouch * 0.35, 0, 1);

    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      const left = arm.side > 0;
      const drop = left ? a.reachL : a.reachR;
      const lift = left ? a.reachR : a.reachL;

      // FK targets. `raise`: 0 = arm hanging down, ~1.5 = straight out sideways.
      // The inside arm drops and straightens toward the water, the outside arm
      // swings up and back to counterweight — the classic carve shape.
      let raise = 0.78 - drop * 0.46 + lift * 0.58 + a.air * 0.55 + a.crouch * 0.06;
      let swing = -0.20 + drop * 0.30 - lift * 0.34 - a.air * 0.12 + a.crouch * 0.22;
      let bend = 0.58 - drop * 0.44 + lift * 0.16 + a.air * 0.35 - a.crouch * 0.14;

      if (W > 1e-3) {
        const n1 = this._noise(1.9, 40 + i * 4), n2 = this._noise(2.4, 41 + i * 4);
        raise = lerp(raise, 1.45 + 0.35 * n1, W);
        swing = lerp(swing, -0.45 + 0.55 * n2, W);
        bend = lerp(bend, 0.75 + 0.45 * n1, W);
      }
      raise += this._noise(1.25, 50 + i) * (0.03 + a.speed * 0.05);
      swing += this._noise(1.05, 52 + i) * (0.03 + a.speed * 0.04);

      arm.fk.raise = damp(arm.fk.raise, raise, 8.0, dt);
      arm.fk.swing = damp(arm.fk.swing, swing, 8.0, dt);
      arm.fk.bend = damp(arm.fk.bend, clamp(bend, 0.04, 1.9), 8.0, dt);

      arm.sh.rotation.set(arm.fk.swing, 0, arm.side * arm.fk.raise);
      arm.el.rotation.set(-arm.fk.bend, 0, 0);
      arm.wr.rotation.set(0, 0, 0);

      // IK overrides: grab the rail (back hand) / touch the wall (front hand)
      let w = 0, ok = false;
      if (!left && a.grab > 0.01 && W < 0.5) {
        // back hand onto the toe-side rail, level with the back foot
        const z = -0.26, s = sOfZ(z);
        _pt.set(-boardHalfW(s) * 0.94, deckTopAtS(s) * 0.80, z);
        w = a.grab * (1 - W); ok = true;
      } else if (left && tubeReach > 0.05 && W < 0.4 && !p.airborne) {
        // front hand out toward the wave wall (world -Z, expressed board-side)
        const psi = fin(p.heading, 0);
        const wallX = Math.sin(psi), wallZ = -Math.cos(psi);
        const r = 0.58 + tubeReach * 0.40;
        _pt.set(wallX * r + 0.10, deckTopAtS(0) + 0.46 - tubeReach * 0.22, wallZ * r + 0.10);
        w = tubeReach * 0.85; ok = true;
      }

      if (ok && w > 0.01) {
        _pt.sub(_pA).applyQuaternion(_qB);                    // board -> chest space
        _qFkS.copy(arm.sh.quaternion);
        _qFkE.copy(arm.el.quaternion);
        _pole.set(arm.side * 0.55, -0.30, -1).normalize();
        twoBoneIK(arm.sh, arm.el, S.upperArm, S.forearm, _pt, _pole, null);
        const wc = clamp(w, 0, 1);
        _qIk.copy(arm.sh.quaternion);
        arm.sh.quaternion.slerpQuaternions(_qFkS, _qIk, wc);
        _qIk.copy(arm.el.quaternion);
        arm.el.quaternion.slerpQuaternions(_qFkE, _qIk, wc);
      }
    }
  }

  // ------------------------------------------------------------------ cleanup

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
    for (const g of this._geos) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._mats) { try { m.dispose(); } catch (e) { /* noop */ } }
    for (const x of this._texs) { try { x.dispose(); } catch (e) { /* noop */ } }
    this._geos.clear(); this._mats.clear(); this._texs.clear();
    this.root = null;
  }
}

export default Surfer;
