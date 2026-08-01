// POROROCA RUSH — src/world/scenery.js
// Jungle walls, palafitas (stilt houses), moored boats and the small details that
// sell an Amazon river at golden hour. Everything is instanced, procedurally
// generated and streamed along +Z with a pure-function recycling scheme.
//
// Streaming model (important): an item's world position is a *pure function* of
// the current player Z — `z = z0 + k * WRAP` with `k = ceil((zMin - z0) / WRAP)`.
// Nothing accumulates, so the scenery is identical for the same simulation time
// no matter what dt the view was stepped with (the capture harness steps the view
// at a coarser rate than the sim). All randomness comes from `hash2(i, k, seed)`
// so recycled content never repeats even though the slots do.
//
// Contract: new Scenery(ctx) / step(dt) / dispose().
//   ctx = { THREE, scene, renderer, camera, state, bus, bore, config, river? }

import * as THREE_NS from 'three';
import { CONFIG, TAU } from '../config.js';
import { rng, hash2, fbm2 } from '../core/rng.js';

// ---------------------------------------------------------------- small utils

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Deterministic hash stream: item index, streaming generation, salt.
const SEED = (CONFIG.seed | 0) || 1;
const H = (i, k, salt) => hash2(i | 0, k | 0, (SEED + salt * 7919) | 0);
const Hr = (i, k, salt, a, b) => a + (b - a) * H(i, k, salt);

// Recycling generation for a slot whose authored local Z is z0.
const wrapK = (z0, zMin, wrap) => Math.ceil((zMin - z0) / wrap);

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d') };
}

function texFrom(T, canvas, repeatU = 1, repeatV = 1) {
  const t = new T.CanvasTexture(canvas);
  t.wrapS = T.RepeatWrapping;
  t.wrapT = T.RepeatWrapping;
  t.colorSpace = T.SRGBColorSpace;
  t.repeat.set(repeatU, repeatV);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const hex = (n) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

// ---------------------------------------------------------- canvas texturing

// A lumpy blob outline. `ks` is a precomputed radius-jitter table so the same
// shape can be drawn twice (rim pass + dark pass) without drifting.
function blobPath(g, x, y, rx, ry, ks) {
  const n = ks.length - 1;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const k = ks[i];
    const px = x + Math.cos(a) * rx * k;
    const py = y + Math.sin(a) * ry * k;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
}

function jitterTable(r, n, amount) {
  const ks = new Array(n + 1);
  for (let i = 0; i < n; i++) ks[i] = 1 + (r() - 0.5) * amount;
  ks[n] = ks[0];
  return ks;
}

// Crown with a warm rim on its upper edge (sun is behind the canopy).
function crown(g, r, x, y, rx, ry, dark, rim) {
  const ks = jitterTable(r, 13, 0.42);
  g.fillStyle = rim;  blobPath(g, x, y - 1.6, rx * 1.03, ry * 1.03, ks); g.fill();
  g.fillStyle = dark; blobPath(g, x, y + 1.4, rx, ry, ks); g.fill();
}

// One palm silhouette: slim trunk + fan of drooping fronds.
function palmSilhouette(g, r, x, yBase, h, dark, rim) {
  const lean = (r() - 0.5) * 0.34;
  const topX = x + lean * h;
  const topY = yBase - h;
  g.strokeStyle = dark;
  g.lineWidth = Math.max(1.4, h * 0.032);
  g.beginPath();
  g.moveTo(x, yBase);
  g.quadraticCurveTo(x + lean * h * 0.35, yBase - h * 0.55, topX, topY);
  g.stroke();

  const n = 6 + Math.floor(r() * 3);
  const span = h * (0.42 + r() * 0.22);
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI;   // sweep across the top
    const ax = Math.cos(a), ay = Math.sin(a) * 0.75;
    const ex = topX + ax * span;
    const ey = topY + ay * span * 0.55 + span * 0.42;
    const mx = topX + ax * span * 0.55;
    const my = topY + ay * span * 0.5 - span * 0.14;
    g.strokeStyle = rim;
    g.lineWidth = Math.max(1.1, span * 0.052);
    g.beginPath(); g.moveTo(topX, topY - 1.6); g.quadraticCurveTo(mx, my - 2.2, ex, ey - 2.2); g.stroke();
    g.strokeStyle = dark;
    g.lineWidth = Math.max(1.4, span * 0.07);
    g.beginPath(); g.moveTo(topX, topY); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
  }
}

// Jungle wall / skirt sheet. Tiles horizontally. Dense mass at v=0 (canvas
// bottom), ragged treetops at v=1 (canvas top) — matches texture flipY.
function makeCanopyTex(T, look) {
  if (!HAS_DOM) return null;
  const W = 512, Hh = 256;
  const { c, g } = canvas2d(W, Hh);
  const r = rng(SEED ^ 0x5c31);
  const dark = hex(look.jungleDark || 0x101a10);
  const darker = '#070c06';
  const mid = '#16220f';
  const rim = '#c8873a';
  const rim2 = '#e8ae5e';

  g.clearRect(0, 0, W, Hh);
  const baseTop = Hh * 0.52;
  g.fillStyle = darker;
  g.fillRect(0, baseTop, W, Hh - baseTop);

  // Subtle internal structure so the mass is not a flat block.
  for (let i = 0; i < 70; i++) {
    const x = r() * W, y = baseTop + r() * (Hh - baseTop) * 0.9;
    const rx = 12 + r() * 34, ry = 8 + r() * 20;
    g.fillStyle = r() < 0.5 ? dark : mid;
    g.globalAlpha = 0.35;
    const ks = jitterTable(r, 11, 0.4);
    for (const dx of [-W, 0, W]) { blobPath(g, x + dx, y, rx, ry, ks); g.fill(); }
  }
  g.globalAlpha = 1;

  // Ragged treetop line.
  for (let i = 0; i < 120; i++) {
    const x = (i / 120) * W + (r() - 0.5) * 8;
    const rx = 14 + r() * 30;
    const ry = 9 + r() * 20;
    const y = baseTop - r() * r() * 62 + 6;
    const cDark = r() < 0.35 ? dark : darker;
    const cRim = r() < 0.4 ? rim2 : rim;
    for (const dx of [-W, 0, W]) crown(g, rng(SEED ^ (i * 2654435761)), x + dx, y, rx, ry, cDark, cRim);
  }

  // Emergent trees + palms poking out of the canopy.
  for (let i = 0; i < 16; i++) {
    const x = r() * W;
    const h = 42 + r() * 66;
    for (const dx of [-W, 0, W]) palmSilhouette(g, rng(SEED ^ (i * 40503 + 11)), x + dx, baseTop + 4, h, darker, rim);
  }
  for (let i = 0; i < 10; i++) {
    const x = r() * W;
    const y = baseTop - 40 - r() * 46;
    const rx = 16 + r() * 18, ry = 12 + r() * 12;
    g.strokeStyle = darker; g.lineWidth = 3;
    for (const dx of [-W, 0, W]) {
      g.beginPath(); g.moveTo(x + dx, baseTop); g.lineTo(x + dx, y); g.stroke();
      crown(g, rng(SEED ^ (i * 7717 + 3)), x + dx, y, rx, ry, darker, rim2);
    }
  }

  return texFrom(T, c);
}

// Single tree silhouette for crossed billboards.
function makeTreeTex(T, look) {
  if (!HAS_DOM) return null;
  const S = 256;
  const { c, g } = canvas2d(S, S);
  const r = rng(SEED ^ 0x1a77);
  g.clearRect(0, 0, S, S);

  // trunk (canvas bottom = base of the tree)
  g.strokeStyle = '#0a0d07';
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(S * 0.5, S);
  g.quadraticCurveTo(S * 0.52, S * 0.72, S * 0.5, S * 0.5);
  g.stroke();
  g.lineWidth = 5;
  for (let i = 0; i < 3; i++) {
    const a = -0.9 + i * 0.9;
    g.beginPath();
    g.moveTo(S * 0.5, S * 0.58);
    g.lineTo(S * 0.5 + Math.sin(a) * S * 0.22, S * 0.42 - Math.cos(a) * S * 0.08);
    g.stroke();
  }

  // crown: cluster of blobs, warm rim on top
  for (let i = 0; i < 26; i++) {
    const a = r() * TAU, rad = Math.pow(r(), 0.6);
    const x = S * 0.5 + Math.cos(a) * rad * S * 0.42;
    const y = S * 0.33 + Math.sin(a) * rad * S * 0.25;
    crown(g, rng(SEED ^ (i * 2246822519)), x, y, 18 + r() * 26, 13 + r() * 18,
      r() < 0.4 ? '#111a0d' : '#080d06', r() < 0.45 ? '#d99551' : '#a86c2e');
  }
  return texFrom(T, c);
}

// Bushy undergrowth cluster.
function makeFoliageTex(T) {
  if (!HAS_DOM) return null;
  const S = 256;
  const { c, g } = canvas2d(S, S);
  const r = rng(SEED ^ 0x3f0d);
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 150; i++) {
    const a = r() * TAU, rad = Math.pow(r(), 0.5);
    const x = S * 0.5 + Math.cos(a) * rad * S * 0.46;
    const y = S * 0.62 + Math.sin(a) * rad * S * 0.36;
    const l = 12 + r() * 26, w = 4 + r() * 8;
    const rot = (r() - 0.5) * 2.6;
    g.save();
    g.translate(x, y); g.rotate(rot);
    const up = y < S * 0.45;
    g.fillStyle = up ? (r() < 0.4 ? '#3d5220' : '#1a2610') : (r() < 0.3 ? '#16200e' : '#0a1007');
    g.beginPath(); g.ellipse(0, 0, l, w, 0, 0, TAU); g.fill();
    g.restore();
  }
  return texFrom(T, c);
}

// Palm frond: base at v=0 (canvas bottom), tip at v=1 (canvas top).
function makeFrondTex(T) {
  if (!HAS_DOM) return null;
  const W = 128, Hh = 256;
  const { c, g } = canvas2d(W, Hh);
  const r = rng(SEED ^ 0x77c1);
  g.clearRect(0, 0, W, Hh);
  g.strokeStyle = '#141d0c';
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(W * 0.5, Hh); g.lineTo(W * 0.5, 6); g.stroke();
  for (let i = 0; i < 32; i++) {
    const t = i / 31;
    const y = Hh - 8 - t * (Hh - 22);
    const span = Math.sin(Math.PI * Math.pow(t, 0.55)) * W * 0.46;
    for (const s of [-1, 1]) {
      g.strokeStyle = t > 0.6 ? '#2c4018' : '#0f180a';
      g.lineWidth = 3.2 - t * 1.4;
      g.beginPath();
      g.moveTo(W * 0.5, y);
      g.quadraticCurveTo(W * 0.5 + s * span * 0.6, y + 5, W * 0.5 + s * span, y + 15 + t * 10);
      g.stroke();
      if (r() < 0.25) {
        g.strokeStyle = '#b7813c';
        g.lineWidth = 1.1;
        g.beginPath();
        g.moveTo(W * 0.5, y - 1.5);
        g.quadraticCurveTo(W * 0.5 + s * span * 0.6, y + 3, W * 0.5 + s * span, y + 13 + t * 10);
        g.stroke();
      }
    }
  }
  return texFrom(T, c);
}

// Weathered planks — deliberately bright and low-saturation so the per-instance
// paint tint survives the multiply (a dark map would crush every colour).
function makePlankTex(T) {
  if (!HAS_DOM) return null;
  const S = 256;
  const { c, g } = canvas2d(S, S);
  const r = rng(SEED ^ 0x2b41);
  g.fillStyle = '#cdb28d';
  g.fillRect(0, 0, S, S);
  const boards = 7;
  const bh = S / boards;
  for (let b = 0; b < boards; b++) {
    const y = b * bh;
    const v = 0.8 + r() * 0.36;
    g.fillStyle = `rgb(${Math.min(255, (211 * v) | 0)},${Math.min(255, (181 * v) | 0)},${Math.min(255, (142 * v) | 0)})`;
    g.fillRect(0, y + 1, S, bh - 2);
    // grain
    for (let i = 0; i < 26; i++) {
      const gy = y + 2 + r() * (bh - 4);
      g.strokeStyle = `rgba(60,40,24,${0.06 + r() * 0.13})`;
      g.lineWidth = 0.6 + r() * 1.4;
      g.beginPath();
      g.moveTo(0, gy);
      g.bezierCurveTo(S * 0.3, gy + (r() - 0.5) * 5, S * 0.7, gy + (r() - 0.5) * 5, S, gy + (r() - 0.5) * 4);
      g.stroke();
    }
    // seam
    g.fillStyle = 'rgba(28,18,10,0.85)';
    g.fillRect(0, y, S, 2);
    // nails
    g.fillStyle = 'rgba(30,22,14,0.5)';
    for (let i = 0; i < 3; i++) g.fillRect(((r() * S) | 0), y + bh * 0.5, 2, 2);
  }
  // weather blotches
  for (let i = 0; i < 40; i++) {
    const x = r() * S, y = r() * S, rad = 6 + r() * 30;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(52,36,20,${0.05 + r() * 0.14})`);
    grd.addColorStop(1, 'rgba(52,36,20,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return texFrom(T, c);
}

// Corrugated zinc, corrugations varying along U (they run down the slope).
function makeZincTex(T) {
  if (!HAS_DOM) return null;
  const W = 256, Hh = 128;
  const { c, g } = canvas2d(W, Hh);
  const r = rng(SEED ^ 0x9d17);
  for (let x = 0; x < W; x++) {
    const s = 0.5 + 0.5 * Math.sin((x / W) * Math.PI * 26);
    const v = 0.42 + 0.58 * Math.pow(s, 0.7);
    g.fillStyle = `rgb(${(186 * v) | 0},${(178 * v) | 0},${(163 * v) | 0})`;
    g.fillRect(x, 0, 1, Hh);
  }
  // rust
  for (let i = 0; i < 46; i++) {
    const x = r() * W, y = r() * Hh, rad = 5 + r() * 26;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.15 + r() * 0.45;
    grd.addColorStop(0, `rgba(${120 + (r() * 40) | 0},${52 + (r() * 24) | 0},22,${a})`);
    grd.addColorStop(1, 'rgba(120,52,22,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // streaks down the slope
  for (let i = 0; i < 60; i++) {
    const x = r() * W;
    g.strokeStyle = `rgba(86,44,20,${0.05 + r() * 0.16})`;
    g.lineWidth = 0.8 + r() * 2.6;
    g.beginPath(); g.moveTo(x, r() * Hh * 0.4); g.lineTo(x + (r() - 0.5) * 4, Hh); g.stroke();
  }
  return texFrom(T, c);
}

function makeBarkTex(T) {
  if (!HAS_DOM) return null;
  const W = 64, Hh = 256;
  const { c, g } = canvas2d(W, Hh);
  const r = rng(SEED ^ 0x61b3);
  g.fillStyle = '#4a3826';
  g.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 90; i++) {
    const x = r() * W;
    g.strokeStyle = r() < 0.5 ? `rgba(24,16,10,${0.2 + r() * 0.5})` : `rgba(122,98,68,${0.1 + r() * 0.3})`;
    g.lineWidth = 0.7 + r() * 2.6;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (r() - 0.5) * 8, Hh * 0.33, x + (r() - 0.5) * 8, Hh * 0.66, x + (r() - 0.5) * 6, Hh);
    g.stroke();
  }
  return texFrom(T, c);
}

// Reflection smear: opaque at v=0 (under the object), fading along v.
function makeSmearTex(T) {
  if (!HAS_DOM) return null;
  const W = 64, Hh = 128;
  const { c, g } = canvas2d(W, Hh);
  const r = rng(SEED ^ 0x4411);
  const img = g.createImageData(W, Hh);
  for (let y = 0; y < Hh; y++) {
    // canvas y=0 is v=1 after flipY, so fade from the bottom of the canvas up.
    const v = 1 - y / (Hh - 1);
    const along = Math.pow(1 - v, 1.6);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const edge = Math.sin(Math.PI * u);
      const ripple = 0.55 + 0.45 * Math.sin(v * 34 + Math.sin(u * 6) * 1.5);
      const a = clamp(along * edge * ripple, 0, 1);
      const i = (y * W + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 232; img.data[i + 2] = 200;
      img.data[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  // break it up a little
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 40; i++) {
    const x = r() * W, y = r() * Hh, rad = 2 + r() * 9;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(0,0,0,${0.25 + r() * 0.5})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.globalCompositeOperation = 'source-over';
  const t = texFrom(T, c);
  t.wrapS = T.ClampToEdgeWrapping;
  t.wrapT = T.ClampToEdgeWrapping;
  return t;
}

// Thin cooking smoke: base at v=0, dissipating upward.
function makeSmokeTex(T) {
  if (!HAS_DOM) return null;
  const W = 64, Hh = 128;
  const { c, g } = canvas2d(W, Hh);
  const r = rng(SEED ^ 0x7a09);
  g.clearRect(0, 0, W, Hh);
  for (let i = 0; i < 90; i++) {
    const v = Math.pow(r(), 0.7);         // 0 = base
    const y = Hh - 2 - v * (Hh - 6);
    const wob = Math.sin(v * 6.5) * W * 0.16 + (r() - 0.5) * W * 0.1;
    const x = W * 0.5 + wob;
    const rad = 4 + v * 22 + r() * 6;
    const a = (1 - v) * 0.30 * (0.4 + r() * 0.6);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(232,214,186,${a})`);
    grd.addColorStop(1, 'rgba(232,214,186,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const t = texFrom(T, c);
  t.wrapS = T.ClampToEdgeWrapping;
  t.wrapT = T.ClampToEdgeWrapping;
  return t;
}

// ------------------------------------------------------------ geometry parts

// Tapered trunk, base at y=0, unit height, unit base radius.
function makeTrunkGeo(T, taper, seg) {
  const g = new T.CylinderGeometry(taper, 1, 1, seg, 1, true);
  g.translate(0, 0.5, 0);
  return g;
}

// Low-poly canopy blob with baked occlusion in vertex colours.
function makeBlobGeo(T) {
  const g = new T.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Jitter by direction so shared corners of the non-indexed mesh stay welded.
    const kx = Math.round(x * 512), ky = Math.round(y * 512), kz = Math.round(z * 512);
    const j = 0.78 + 0.44 * hash2(kx + kz * 31, ky, SEED ^ 0x2211);
    x *= j; y *= j * 0.86; z *= j;
    pos.setXYZ(i, x, y, z);
    // dark underside, warm-lifted top edge
    const up = clamp(y * 0.5 + 0.5, 0, 1);
    const t = Math.pow(up, 2.2);
    col[i * 3 + 0] = lerp(0.30, 1.35, t);
    col[i * 3 + 1] = lerp(0.34, 1.20, t);
    col[i * 3 + 2] = lerp(0.30, 0.72, t);
  }
  pos.needsUpdate = true;
  g.setAttribute('color', new T.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// Two crossed quads, base at y=0, unit height, unit width.
function makeCrossGeo(T) {
  const pos = [], nor = [], uv = [], idx = [];
  const planes = [
    { ax: [1, 0, 0], n: [0, 0, 1] },
    { ax: [0, 0, 1], n: [1, 0, 0] },
  ];
  planes.forEach((p, pi) => {
    const [axX, , axZ] = p.ax;
    const base = pi * 4;
    const nx = p.n[0] * 0.55, nz = p.n[2] * 0.55, ny = 0.83;
    const inv = 1 / Math.hypot(nx, ny, nz);
    const corners = [
      [-0.5, 0, 0, 0], [0.5, 0, 1, 0], [0.5, 1, 1, 1], [-0.5, 1, 0, 1],
    ];
    for (const [a, y, u, v] of corners) {
      pos.push(axX * a, y, axZ * a);
      nor.push(nx * inv, ny * inv, nz * inv);
      uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Palm crown: fronds radiating from the origin, arcing out and drooping.
function makeFrondCrownGeo(T, count = 7, segs = 3) {
  const pos = [], nor = [], uv = [], idx = [];
  let v = 0;
  for (let f = 0; f < count; f++) {
    const phi = (f / count) * TAU + hash2(f, 17, SEED) * 0.6;
    const ca = Math.cos(phi), sa = Math.sin(phi);
    const pitch = 0.34 + hash2(f, 29, SEED) * 0.42;
    const droop = 0.85 + hash2(f, 41, SEED) * 0.75;
    const len = 0.82 + hash2(f, 53, SEED) * 0.36;
    // side direction (horizontal, perpendicular to the frond's radial axis)
    const sx = -sa, sz = ca;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const rr = t * len;
      const y = Math.sin(pitch) * rr - droop * rr * rr;
      const px = ca * Math.cos(pitch) * rr;
      const pz = sa * Math.cos(pitch) * rr;
      const hw = 0.155 * Math.sin(Math.PI * Math.pow(clamp(t, 0.001, 0.999), 0.55)) * (len / 0.9);
      pos.push(px - sx * hw, y, pz - sz * hw);
      pos.push(px + sx * hw, y, pz + sz * hw);
      nor.push(0, 1, 0, 0, 1, 0);
      uv.push(0, t, 1, t);
      if (s < segs) {
        const a = v + s * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    v += (segs + 1) * 2;
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Boat hull from station profiles. Unit length along Z (+Z = bow), origin at the
// waterline. Open topped — the material is DoubleSide so you see inside.
function makeHullGeo(T, beam, sheer, keel, deck) {
  const S = beam.length - 1;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const z = (t - 0.5);
    const hb = beam[i] * 0.5;
    const gy = 0.16 + 0.20 * sheer[i];
    const ky = -0.34 * keel[i];
    const cy = lerp(ky, gy, 0.32);
    const cb = hb * 0.86;
    const ring = [
      [-hb, gy], [-cb, cy], [0, ky], [cb, cy], [hb, gy],
    ];
    for (let r = 0; r < 5; r++) {
      pos.push(ring[r][0], ring[r][1], z);
      uv.push(r / 4, t * 2.2);
    }
  }
  for (let i = 0; i < S; i++) {
    for (let r = 0; r < 4; r++) {
      const a = i * 5 + r, b = a + 5;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  if (deck) {
    // Flat deck plate across the aft two thirds so the boat is not hollow.
    const base = pos.length / 3;
    const zA = -0.48, zB = 0.30;
    const wA = beam[1] * 0.46, wB = beam[Math.max(1, Math.round(S * 0.78))] * 0.46;
    const y = 0.30;
    pos.push(-wA, y, zA, wA, y, zA, wB, y, zB, -wB, y, zB);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Corrugated gable roof. Footprint x∈[-.5,.5] (ridge direction), z∈[-.5,.5],
// eaves at y=0, ridge at y=1. Corrugations tile along U (down-slope sheets).
function makeRoofGeo(T) {
  const pos = [], uv = [], idx = [];
  const push = (a, b, c, d, uvs) => {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uv.push(...uvs);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // front slope
  push([-0.5, 1, 0], [0.5, 1, 0], [0.5, 0, 0.55], [-0.5, 0, 0.55], [0, 0, 8, 0, 8, 1, 0, 1]);
  // back slope
  push([0.5, 1, 0], [-0.5, 1, 0], [-0.5, 0, -0.55], [0.5, 0, -0.55], [0, 0, 8, 0, 8, 1, 0, 1]);
  // gable ends (triangles as degenerate quads)
  push([-0.5, 0, -0.55], [-0.5, 0, 0.55], [-0.5, 1, 0], [-0.5, 1, 0], [0, 0, 2, 0, 1, 1, 1, 1]);
  push([0.5, 0, 0.55], [0.5, 0, -0.55], [0.5, 1, 0], [0.5, 1, 0], [0, 0, 2, 0, 1, 1, 1, 1]);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeBoxGeo(T, ur = 2, vr = 2) {
  const g = new T.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ur, uv.getY(i) * vr);
  uv.needsUpdate = true;
  return g;
}

// Flat quad in XZ spanning x∈[-.5,.5], z∈[0,1], normal +Y. Used for reflections.
function makeSmearGeo(T) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1], 3));
  g.setAttribute('normal', new T.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// Vertical billboard quad, base at y=0, unit size, facing +Z.
function makeUprightQuadGeo(T) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setAttribute('normal', new T.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// Distant bird: a shallow V of two triangles, unit wingspan.
function makeBirdGeo(T) {
  const p = [
    0, 0, 0, -0.5, 0.20, -0.10, -0.45, 0.0, 0.08,
    0, 0, 0, 0.45, 0.0, 0.08, 0.5, 0.20, -0.10,
  ];
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------- palette

const WOOD_TINTS = [0xb08a5e, 0x9a7047, 0x86603c, 0xbf9a6c, 0x7d5a38];
const PAINT_TINTS = [
  0x3aa39a, // teal
  0xd24a33, // vermelho
  0xe0a63a, // ocre
  0x3c78c0, // azul
  0xe8d8b0, // creme
  0x59a04e, // verde
  0xb85a9c, // rosa desbotado
];
const ROOF_TINTS = [0x9a8f80, 0x8a6a4e, 0xa0745a, 0x7e7266, 0xb08a63];
const CLOTH_TINTS = [0xe8e0d0, 0xd9534f, 0x4a90d9, 0xf0c24a, 0x59b07a];

// =============================================================================

export class Scenery {
  constructor(ctx) {
    ctx = ctx || {};
    const T = this.T = ctx.THREE || THREE_NS;
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.camera = ctx.camera || null;
    this.state = ctx.state || null;
    this.bore = ctx.bore || null;
    const cfgRoot = ctx.config || CONFIG;
    this.cfg = cfgRoot.world || CONFIG.world;
    this.look = cfgRoot.look || CONFIG.look;

    this.enabled = true;
    this._failed = false;
    this._disposed = false;

    // Streaming window -------------------------------------------------------
    this.cullBehind = this.cfg.cullBehind ?? 260;
    this.streamAhead = this.cfg.streamAhead ?? 900;
    this.wrap = this.cullBehind + this.streamAhead + 60;   // 1220 m by default

    // River boundary resolution ---------------------------------------------
    this._rvCenter = null;
    this._rvHalf = null;
    this._rvGround = null;
    this._riverResolved = false;
    this._riverRetry = 0;
    this._resolveRiver();

    this._boreOk = this._probeBore();

    // Temporaries ------------------------------------------------------------
    this._m = new T.Matrix4();
    this._v = new T.Vector3();
    this._v2 = new T.Vector3();
    this._q = new T.Quaternion();
    this._q2 = new T.Quaternion();
    this._s = new T.Vector3(1, 1, 1);
    this._e = new T.Euler();
    this._c = new T.Color();
    this._origin = new T.Vector3();
    this._oq = new T.Quaternion();
    this._UP = new T.Vector3(0, 1, 0);
    this._AXZ = new T.Vector3(0, 0, 1);
    this._AXX = new T.Vector3(1, 0, 0);
    this._camPos = new T.Vector3();
    this._hidden = new T.Matrix4().makeScale(0, 0, 0);

    this.group = new T.Group();
    this.group.name = 'scenery';

    this._textures = [];
    this._geoms = [];
    this._mats = [];
    this._meshes = [];

    try {
      this._buildTextures();
      this._buildMaterials();
      this._buildRibbons();
      this._buildTrees();
      this._buildStructures();
      this._buildBoats();
      this._buildDetails();
    } catch (err) {
      this._failed = true;
      this.enabled = false;
      // Boot must survive a broken scenery build.
      if (typeof console !== 'undefined') console.warn('[scenery] build failed, disabled:', err);
    }

    if (this.scene) this.scene.add(this.group);
    if (ctx && !ctx.scenery) ctx.scenery = this;

    this.info = {
      trees: this._treeTotal || 0,
      houseSlots: this.houseSlots || 0,
      boats: (this.canoeCount || 0) + (this.shipCount || 0),
      drawCalls: this._meshes.length + (this.ribbons ? this.ribbons.length : 0),
    };

    // First layout so the very first rendered frame is already populated.
    if (this.enabled) { try { this.step(0); } catch (e) { /* handled in step */ } }
  }

  // ------------------------------------------------------------- neighbours

  _probeBore() {
    const b = this.bore;
    if (!b || typeof b.height !== 'function') return false;
    try { return isNum(b.height(0, 0, 0)); } catch (e) { return false; }
  }

  // Wrap a neighbour function so the first bad result permanently falls back.
  _safe1(fn, fallback) {
    let ok = true;
    return (a) => {
      if (ok) {
        try { const v = fn(a); if (isNum(v)) return v; } catch (e) { /* fall through */ }
        ok = false;
      }
      return fallback(a);
    };
  }

  _safe2(fn, fallback) {
    let ok = true;
    return (a, b) => {
      if (ok) {
        try { const v = fn(a, b); if (isNum(v)) return v; } catch (e) { /* fall through */ }
        ok = false;
      }
      return fallback(a, b);
    };
  }

  // Discover river.js's bank API. River is constructed before Scenery in main.js,
  // but we re-probe for a few seconds in case it publishes late.
  _resolveRiver() {
    const r = this.ctx.river || (this.ctx.ctx && this.ctx.ctx.river) || null;
    if (!r) return false;

    const fbCenter = (z) => this._fbCenterX(z);
    const fbHalf = (z) => this._fbHalfWidth(z);
    const probe1 = (fn) => { try { return isNum(fn(0)) && isNum(fn(431.7)); } catch (e) { return false; } };

    let center = null, half = null;

    for (const n of ['centerX', 'centreX', 'channelCenterX', 'center']) {
      const f = r[n];
      if (typeof f === 'function') {
        const g = (z) => f.call(r, z);
        if (probe1(g)) { center = g; break; }
      }
    }
    for (const n of ['halfWidth', 'halfWidthAt', 'channelHalfWidth']) {
      const f = r[n];
      if (typeof f === 'function') {
        const g = (z) => f.call(r, z);
        if (probe1(g)) { half = g; break; }
      }
    }
    if (!half) {
      for (const n of ['width', 'widthAt', 'channelWidth']) {
        const f = r[n];
        if (typeof f === 'function') {
          const g = (z) => f.call(r, z) * 0.5;
          if (probe1(g)) { half = g; break; }
        } else if (typeof f === 'number' && f > 4) {
          const w = f * 0.5; half = () => w; break;
        }
      }
    }
    if ((!center || !half) && typeof r.bankX === 'function') {
      try {
        const a = r.bankX(0, -1), b = r.bankX(0, 1);
        if (isNum(a) && isNum(b) && Math.abs(b - a) > 8) {
          if (!center) center = (z) => (r.bankX(z, -1) + r.bankX(z, 1)) * 0.5;
          if (!half) half = (z) => Math.abs(r.bankX(z, 1) - r.bankX(z, -1)) * 0.5;
        }
      } catch (e) { /* ignore */ }
    }

    if (center) this._rvCenter = this._safe1(center, fbCenter);
    if (half) this._rvHalf = this._safe1(half, fbHalf);

    for (const n of ['groundY', 'bankY', 'terrainY', 'heightAt', 'groundHeight']) {
      const f = r[n];
      if (typeof f === 'function') {
        const g = (x, z) => f.call(r, x, z);
        try {
          if (isNum(g(0, 0)) && isNum(g(400, 200))) {
            this._rvGround = this._safe2(g, (x, z) => this._fbGroundY(x, z));
            break;
          }
        } catch (e) { /* ignore */ }
      }
    }

    this._riverResolved = !!(this._rvCenter && this._rvHalf);
    return this._riverResolved;
  }

  // Fallback channel maths, mirroring the shape implied by CONFIG.world.
  _fbCenterX(z) {
    const m = this.cfg.riverMeander ?? 210;
    const L = this.cfg.riverMeanderLen ?? 1500;
    return m * Math.sin((TAU * z) / L) + m * 0.32 * Math.sin((TAU * z) / (L * 0.37) + 1.7);
  }

  _fbHalfWidth(z) {
    const w = this.cfg.riverWidth ?? 340;
    const v = this.cfg.riverWidthVar ?? 70;
    const L = this.cfg.riverMeanderLen ?? 1500;
    return 0.5 * (w + v * Math.sin((TAU * z) / (L * 0.61) + 0.9));
  }

  _fbGroundY(x, z, cx, hw) {
    if (cx === undefined) { cx = this.centerX(z); hw = this.halfWidth(z); }
    const e = Math.abs(x - cx) - hw;              // >0 = inland from the bank edge
    const bh = this.cfg.bankHeight ?? 7;
    const n = (fbm2(x * 0.011, z * 0.011, 3, 917) - 0.5) * 2.4;
    if (e <= 0) return Math.max(-4.5, e * 0.16) + n * 0.3;
    return bh * smooth01(e / 32) + n;
  }

  centerX(z) { return this._rvCenter ? this._rvCenter(z) : this._fbCenterX(z); }
  halfWidth(z) { return this._rvHalf ? this._rvHalf(z) : this._fbHalfWidth(z); }
  groundY(x, z, cx, hw) {
    if (this._rvGround) return this._rvGround(x, z);
    return this._fbGroundY(x, z, cx, hw);
  }

  waterY(x, z) {
    if (!this._boreOk) return 0;
    const h = this.bore.height(x, z, this.state ? this.state.time : 0);
    return isNum(h) ? h : 0;
  }

  crestZ(x) {
    if (this._boreOk && typeof this.bore.crest === 'function') {
      try {
        const v = this.bore.crest(x, this.state ? this.state.time : 0);
        if (isNum(v)) return v;
      } catch (e) { /* ignore */ }
    }
    return this.state && this.state.bore ? this.state.bore.z : 0;
  }

  // ------------------------------------------------------------------ build

  _buildTextures() {
    const T = this.T;
    const keep = (t) => { if (t) this._textures.push(t); return t; };
    this.texCanopy = keep(makeCanopyTex(T, this.look));
    this.texTree = keep(makeTreeTex(T, this.look));
    this.texFoliage = keep(makeFoliageTex(T));
    this.texFrond = keep(makeFrondTex(T));
    this.texPlank = keep(makePlankTex(T));
    this.texZinc = keep(makeZincTex(T));
    this.texBark = keep(makeBarkTex(T));
    this.texSmear = keep(makeSmearTex(T));
    this.texSmoke = keep(makeSmokeTex(T));
  }

  _buildMaterials() {
    const T = this.T;
    const keep = (m) => { this._mats.push(m); return m; };
    const ambHex = this.look.ambientGround || 0x2a1c10;
    const amb = () => new T.Color(ambHex).multiplyScalar(0.5);

    // Unlit, fully baked — the banks read as silhouettes by art direction and
    // this keeps them stable whatever lighting.js does.
    this.matCanopy = keep(new T.MeshBasicMaterial({
      map: this.texCanopy, alphaTest: 0.45, side: T.DoubleSide,
      vertexColors: true, fog: true, transparent: false,
    }));
    this.matBillboard = keep(new T.MeshBasicMaterial({
      map: this.texTree, alphaTest: 0.5, side: T.DoubleSide, fog: true,
    }));
    this.matUnder = keep(new T.MeshLambertMaterial({
      map: this.texFoliage, alphaTest: 0.5, side: T.DoubleSide, fog: true,
      emissive: amb(), emissiveIntensity: 0.35,
    }));
    this.matBark = keep(new T.MeshLambertMaterial({
      map: this.texBark, fog: true, emissive: amb(), emissiveIntensity: 0.3,
    }));
    this.matLeaf = keep(new T.MeshLambertMaterial({
      color: 0xffffff, vertexColors: true, fog: true,
      emissive: amb(), emissiveIntensity: 0.3,
    }));
    this.matFrond = keep(new T.MeshLambertMaterial({
      map: this.texFrond, alphaTest: 0.45, side: T.DoubleSide, fog: true,
      emissive: amb(), emissiveIntensity: 0.3,
    }));
    this.matWood = keep(new T.MeshLambertMaterial({
      map: this.texPlank, fog: true, emissive: amb(), emissiveIntensity: 0.28,
    }));
    this.matPaint = keep(new T.MeshLambertMaterial({
      map: this.texPlank, fog: true, emissive: amb(), emissiveIntensity: 0.28,
    }));
    // Hulls are open-topped shells, so they need both faces.
    this.matHull = keep(new T.MeshLambertMaterial({
      map: this.texPlank, fog: true, side: T.DoubleSide,
      emissive: amb(), emissiveIntensity: 0.26,
    }));
    this.matZinc = keep(new T.MeshLambertMaterial({
      map: this.texZinc, fog: true, emissive: amb(), emissiveIntensity: 0.3,
    }));
    this.matSmear = keep(new T.MeshBasicMaterial({
      map: this.texSmear, transparent: true, opacity: 0.5, depthWrite: false,
      blending: T.AdditiveBlending, side: T.DoubleSide, fog: false,
    }));
    this.matSmoke = keep(new T.MeshBasicMaterial({
      map: this.texSmoke, transparent: true, opacity: 0.42, depthWrite: false,
      side: T.DoubleSide, fog: true, color: 0xd8c2a0,
    }));
    this.matBird = keep(new T.MeshBasicMaterial({
      color: 0x1b1409, side: T.DoubleSide, fog: true, transparent: true, opacity: 0.85,
    }));
  }

  _mkInstanced(geo, mat, count, opts = {}) {
    const T = this.T;
    const m = new T.InstancedMesh(geo, mat, Math.max(1, count));
    m.instanceMatrix.setUsage(T.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = !!opts.cast;
    m.receiveShadow = false;
    if (opts.renderOrder) m.renderOrder = opts.renderOrder;
    // Hide everything until the first layout writes real matrices.
    this._c.setHex(0xffffff);
    for (let i = 0; i < m.count; i++) { m.setMatrixAt(i, this._hidden); m.setColorAt(i, this._c); }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this._geoms.push(geo);
    this._meshes.push(m);
    this.group.add(m);
    return m;
  }

  // ------------------------------------------------------------- bank ribbons

  _buildRibbons() {
    const T = this.T;
    this.ribStep = 7;
    this.ribTile = this.ribStep * 4;          // metres per texture tile along z
    // Cover the whole streaming window plus a tile of slack at each end so the
    // ribbon never runs out when zStart snaps back to a tile boundary.
    this.ribCols = Math.ceil((this.wrap + this.ribTile * 3) / this.ribStep) + 1;

    // 3 rows: bottom, top-inner, top-outer(inland canopy shelf)
    this.ribbons = [
      // far wall — tall, darkest, sits well back
      this._makeRibbon(3, 78, 26, 12, 30, 0.34, 0.6, 1.0),
      // mid wall — the main jungle face
      this._makeRibbon(3, 30, 20, 10, 24, 0.42, 0.75, 1.0),
      // waterline skirt — hides the base of everything, robust to ground drift
      this._makeRibbon(2, -2.5, 5.4, 2.6, 0, 0.55, 0.9, 0.72),
    ];
  }

  // rows: 2 or 3. inset: metres inland of the bank edge. h: base height.
  // hVar: fbm height variation. shelf: inland depth of the canopy shelf.
  _makeRibbon(rows, inset, h, hVar, shelf, cBot, cTop, vMax) {
    const T = this.T;
    const cols = this.ribCols;
    const verts = cols * rows * 2;             // both banks
    const pos = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    const col = new Float32Array(verts * 3);
    const idx = [];
    for (let s = 0; s < 2; s++) {
      const base = s * cols * rows;
      for (let j = 0; j < cols - 1; j++) {
        for (let r = 0; r < rows - 1; r++) {
          const a = base + j * rows + r;
          const b = a + rows;
          idx.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    }
    // Static UVs: zStart is snapped to ribTile so u never needs rewriting.
    for (let s = 0; s < 2; s++) {
      for (let j = 0; j < cols; j++) {
        const u = (j * this.ribStep) / this.ribTile;
        for (let r = 0; r < rows; r++) {
          const i = (s * cols * rows + j * rows + r) * 2;
          uvs[i] = u;
          uvs[i + 1] = rows === 3
            ? (r === 0 ? 0 : r === 1 ? vMax : vMax * 0.42)
            : (r === 0 ? 0 : vMax);
        }
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.BufferAttribute(uvs, 2));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    const mesh = new T.Mesh(g, this.matCanopy);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this._geoms.push(g);
    return { mesh, g, pos, col, rows, cols, inset, h, hVar, shelf, cBot, cTop, zStart: NaN };
  }

  _updateRibbons(zMin) {
    const tile = this.ribTile;
    const zStart = Math.floor(zMin / tile) * tile - tile;
    for (const rb of this.ribbons) {
      if (rb.zStart === zStart) continue;
      rb.zStart = zStart;
      this._fillRibbon(rb, zStart);
    }
  }

  _fillRibbon(rb, zStart) {
    const { pos, col, rows, cols, inset, h, hVar, shelf, cBot, cTop } = rb;
    const step = this.ribStep;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      for (let j = 0; j < cols; j++) {
        const z = zStart + j * step;
        const cx = this.centerX(z);
        const hw = this.halfWidth(z);
        const wob = (fbm2(z * 0.0055, side * 3.7, 3, 4211) - 0.5) * 16;
        const xIn = cx + side * (hw + inset + wob);
        const hh = h + (fbm2(z * 0.009, side * 11.3, 4, 5501) - 0.5) * 2 * hVar;
        const gy = Math.min(this.groundY(xIn, z, cx, hw), h > 8 ? 6 : 1.2);
        // Bury the foot well below the terrain so a mismatch with river.js's
        // bank profile can never open a gap at the waterline.
        const yBot = gy - 6.0;
        const base = (s * cols * rows + j * rows) * 3;
        // row 0 — bottom
        pos[base + 0] = xIn; pos[base + 1] = yBot; pos[base + 2] = z;
        col[base + 0] = cBot * 0.9; col[base + 1] = cBot; col[base + 2] = cBot * 0.78;
        // row 1 — top of the vertical face
        const yTop = gy + Math.max(2, hh);
        pos[base + 3] = xIn; pos[base + 4] = yTop; pos[base + 5] = z;
        col[base + 3] = cTop; col[base + 4] = cTop * 0.97; col[base + 5] = cTop * 0.8;
        if (rows === 3) {
          // row 2 — canopy shelf receding inland (reads as a mass from above)
          pos[base + 6] = xIn + side * shelf;
          pos[base + 7] = yTop * 0.9 + gy * 0.1 - 1.5;
          pos[base + 8] = z;
          const c2 = cBot * 1.15;
          col[base + 6] = c2; col[base + 7] = c2 * 1.02; col[base + 8] = c2 * 0.72;
        }
      }
    }
    rb.g.attributes.position.needsUpdate = true;
    rb.g.attributes.color.needsUpdate = true;
  }

  // ------------------------------------------------------------------- trees

  _buildTrees() {
    const T = this.T;
    const total = this.cfg.treeCount ?? 2600;
    // Real geometry near the water, crossed billboards further back.
    const nBroad = Math.round(total * 0.16);
    const nPalm = Math.round(total * 0.185);
    const nBill = Math.round(total * 0.345);
    const nUnder = Math.max(0, total - nBroad - nPalm - nBill);
    this._treeTotal = nBroad + nPalm + nBill + nUnder;

    this.geoTrunk = makeTrunkGeo(T, 0.52, 6);
    this.geoPalmTrunk = makeTrunkGeo(T, 0.62, 5);
    this.geoBlob = makeBlobGeo(T);
    this.geoCrown = makeFrondCrownGeo(T, 7, 3);
    this.geoCross = makeCrossGeo(T);

    this.mTrunk = this._mkInstanced(this.geoTrunk, this.matBark, nBroad);
    this.mBlob = this._mkInstanced(this.geoBlob, this.matLeaf, nBroad);
    this.mPalmTrunk = this._mkInstanced(this.geoPalmTrunk, this.matBark, nPalm);
    this.mCrown = this._mkInstanced(this.geoCrown, this.matFrond, nPalm);
    this.mBill = this._mkInstanced(this.geoCross, this.matBillboard, nBill);
    this.mUnder = this._mkInstanced(this.geoCross, this.matUnder, nUnder);

    this.nBroad = nBroad; this.nPalm = nPalm; this.nBill = nBill; this.nUnder = nUnder;
    this._genBroad = new Int32Array(nBroad).fill(0x7fffffff);
    this._genPalm = new Int32Array(nPalm).fill(0x7fffffff);
    this._genBill = new Int32Array(nBill).fill(0x7fffffff);
    this._genUnder = new Int32Array(nUnder).fill(0x7fffffff);
  }

  _updateTrees(zMin) {
    const wrap = this.wrap;
    let d1 = false, d2 = false, d3 = false, d4 = false;

    // --- emergent broadleaf: trunk + canopy blob, right at the water's edge ---
    for (let i = 0; i < this.nBroad; i++) {
      const z0 = ((i + 0.37) * wrap) / this.nBroad;
      const k = wrapK(z0, zMin, wrap);
      if (this._genBroad[i] === k) continue;
      this._genBroad[i] = k; d1 = true;
      const z = z0 + k * wrap + (H(i, k, 1) - 0.5) * (wrap / this.nBroad);
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      const inland = 1.5 + Math.pow(H(i, k, 2), 1.35) * 22;
      const x = cx + side * (hw + inland);
      const y = this.groundY(x, z, cx, hw) - 0.9;
      const hgt = 13 + H(i, k, 3) * 17;
      const rad = hgt * (0.026 + H(i, k, 4) * 0.016);
      const yaw = H(i, k, 5) * TAU;
      const tiltA = H(i, k, 6) * TAU;
      const tilt = 0.02 + H(i, k, 7) * 0.11;
      this._v2.set(Math.cos(tiltA), 0, Math.sin(tiltA));
      this._q.setFromAxisAngle(this._v2, tilt);
      this._q2.setFromAxisAngle(this._UP, yaw);
      this._q.multiply(this._q2);

      this._v.set(x, y, z);
      this._s.set(rad, hgt, rad);
      this._m.compose(this._v, this._q, this._s);
      this.mTrunk.setMatrixAt(i, this._m);
      const bt = 0.42 + H(i, k, 8) * 0.5;
      this.mTrunk.setColorAt(i, this._c.setRGB(bt, bt * 0.9, bt * 0.78));

      // canopy sits on the trunk top, following the tilt
      this._v2.set(0, hgt * 0.9, 0).applyQuaternion(this._q).add(this._v);
      const cr = hgt * (0.30 + H(i, k, 9) * 0.16);
      this._s.set(cr * (0.9 + H(i, k, 10) * 0.5), cr * (0.6 + H(i, k, 11) * 0.4), cr * (0.9 + H(i, k, 12) * 0.5));
      this._m.compose(this._v2, this._q, this._s);
      this.mBlob.setMatrixAt(i, this._m);
      const lt = 0.20 + H(i, k, 13) * 0.26;
      this.mBlob.setColorAt(i, this._c.setRGB(lt * 0.86, lt, lt * 0.62));
    }

    // ------------------------------- palms: açaí / buriti, leaning over water --
    for (let i = 0; i < this.nPalm; i++) {
      const z0 = ((i + 0.63) * wrap) / this.nPalm;
      const k = wrapK(z0, zMin, wrap);
      if (this._genPalm[i] === k) continue;
      this._genPalm[i] = k; d2 = true;
      const z = z0 + k * wrap + (H(i, k, 21) - 0.5) * (wrap / this.nPalm);
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      const inland = 0.5 + Math.pow(H(i, k, 22), 1.25) * 40;
      const x = cx + side * (hw + inland);
      const y = this.groundY(x, z, cx, hw) - 0.8;
      const hgt = 11 + H(i, k, 23) * 16;
      const rad = 0.16 + H(i, k, 24) * 0.16;
      const yaw = H(i, k, 25) * TAU;
      // lean out over the river
      const tilt = (0.03 + Math.pow(H(i, k, 26), 1.6) * 0.30) * side;
      this._q.setFromAxisAngle(this._AXZ, tilt);
      this._q2.setFromAxisAngle(this._UP, yaw);
      this._q.multiply(this._q2);

      this._v.set(x, y, z);
      this._s.set(rad, hgt, rad);
      this._m.compose(this._v, this._q, this._s);
      this.mPalmTrunk.setMatrixAt(i, this._m);
      const bt = 0.36 + H(i, k, 27) * 0.42;
      this.mPalmTrunk.setColorAt(i, this._c.setRGB(bt, bt * 0.92, bt * 0.8));

      this._v2.set(0, hgt * 0.985, 0).applyQuaternion(this._q).add(this._v);
      const cr = 2.6 + H(i, k, 28) * 3.4;
      this._s.set(cr, cr * (0.8 + H(i, k, 29) * 0.5), cr);
      this._m.compose(this._v2, this._q, this._s);
      this.mCrown.setMatrixAt(i, this._m);
      const lt = 0.34 + H(i, k, 30) * 0.5;
      this.mCrown.setColorAt(i, this._c.setRGB(lt * 0.9, lt, lt * 0.7));
    }

    // ------------------------------ billboard trees filling the bank in depth --
    for (let i = 0; i < this.nBill; i++) {
      const z0 = ((i + 0.19) * wrap) / this.nBill;
      const k = wrapK(z0, zMin, wrap);
      if (this._genBill[i] === k) continue;
      this._genBill[i] = k; d3 = true;
      const z = z0 + k * wrap + (H(i, k, 41) - 0.5) * (wrap / this.nBill) * 1.4;
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      const t = Math.pow(H(i, k, 42), 1.15);
      const inland = 8 + t * 88;
      const x = cx + side * (hw + inland);
      const y = this.groundY(x, z, cx, hw) - 1.4;
      const hgt = 9 + H(i, k, 43) * 15 + t * 6;
      const wid = hgt * (0.62 + H(i, k, 44) * 0.4);
      this._q.setFromAxisAngle(this._UP, H(i, k, 45) * TAU);
      this._v.set(x, y, z);
      this._s.set(wid, hgt, wid);
      this._m.compose(this._v, this._q, this._s);
      this.mBill.setMatrixAt(i, this._m);
      // Bake the depth occlusion: deeper into the bank = darker.
      const dk = lerp(0.95, 0.42, t) * (0.8 + H(i, k, 46) * 0.35);
      this.mBill.setColorAt(i, this._c.setRGB(dk * 0.96, dk, dk * 0.86));
    }

    // ------------------------------------------ undergrowth along the waterline --
    for (let i = 0; i < this.nUnder; i++) {
      const z0 = ((i + 0.81) * wrap) / this.nUnder;
      const k = wrapK(z0, zMin, wrap);
      if (this._genUnder[i] === k) continue;
      this._genUnder[i] = k; d4 = true;
      const z = z0 + k * wrap + (H(i, k, 61) - 0.5) * (wrap / this.nUnder) * 1.5;
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      const inland = -3 + Math.pow(H(i, k, 62), 0.8) * 30;
      const x = cx + side * (hw + inland);
      const y = this.groundY(x, z, cx, hw) - 0.7;
      const hgt = 1.8 + H(i, k, 63) * 4.4;
      const wid = hgt * (1.1 + H(i, k, 64) * 0.9);
      this._q.setFromAxisAngle(this._UP, H(i, k, 65) * TAU);
      this._v.set(x, y, z);
      this._s.set(wid, hgt, wid);
      this._m.compose(this._v, this._q, this._s);
      this.mUnder.setMatrixAt(i, this._m);
      const dk = 0.5 + H(i, k, 66) * 0.55;
      this.mUnder.setColorAt(i, this._c.setRGB(dk * 0.92, dk, dk * 0.7));
    }

    if (d1) { this.mTrunk.instanceMatrix.needsUpdate = true; this.mBlob.instanceMatrix.needsUpdate = true;
      if (this.mTrunk.instanceColor) this.mTrunk.instanceColor.needsUpdate = true;
      if (this.mBlob.instanceColor) this.mBlob.instanceColor.needsUpdate = true; }
    if (d2) { this.mPalmTrunk.instanceMatrix.needsUpdate = true; this.mCrown.instanceMatrix.needsUpdate = true;
      if (this.mPalmTrunk.instanceColor) this.mPalmTrunk.instanceColor.needsUpdate = true;
      if (this.mCrown.instanceColor) this.mCrown.instanceColor.needsUpdate = true; }
    if (d3) { this.mBill.instanceMatrix.needsUpdate = true;
      if (this.mBill.instanceColor) this.mBill.instanceColor.needsUpdate = true; }
    if (d4) { this.mUnder.instanceMatrix.needsUpdate = true;
      if (this.mUnder.instanceColor) this.mUnder.instanceColor.needsUpdate = true; }
  }

  // -------------------------------------------------- palafitas + shared pools

  _buildStructures() {
    const T = this.T;
    // Houses come in villages, not spread evenly (see the aerial concept art).
    // Slot budget is oversized because villages are randomly skipped and sized;
    // the live count averages out near CONFIG.world.houseCount.
    const houseCount = this.cfg.houseCount ?? 46;
    this.HPV = 6;                                        // houses per village slot
    this.NV = Math.max(4, Math.round(houseCount / 4));
    this.houseSlots = this.NV * this.HPV;

    const boatCount = this.cfg.boatCount ?? 54;
    this.canoeCount = Math.max(1, Math.round(boatCount * 0.78));
    this.shipCount = Math.max(1, boatCount - this.canoeCount);

    // Per-house budget: 8 stilts + 2 laundry posts + 1 line + 1 mooring post.
    this.POLES_PER_HOUSE = 12;
    this.WOOD_PER_HOUSE = 4;     // deck, walkway, stairs, porch deck
    this.PAINT_PER_HOUSE = 4;    // walls, window band, 2 clothes
    this.ROOF_PER_HOUSE = 2;     // main gable, porch shed

    this.poleBase = this.houseSlots * this.POLES_PER_HOUSE;
    this.woodBase = this.houseSlots * this.WOOD_PER_HOUSE;
    this.paintBase = this.houseSlots * this.PAINT_PER_HOUSE;
    this.roofBase = this.houseSlots * this.ROOF_PER_HOUSE;

    // Boats borrow from the same pools: 1 mooring pole per canoe, and for each
    // riverboat 2 masts + 1 deck + 2 cabins + 1 awning.
    const poleCount = this.poleBase + this.canoeCount + this.shipCount * 2;
    const woodCount = this.woodBase + this.shipCount;
    const paintCount = this.paintBase + this.shipCount * 2;
    const roofCount = this.roofBase + this.shipCount;

    this.geoPole = new T.CylinderGeometry(1, 1, 1, 5, 1, false);
    this.geoPole.translate(0, 0.5, 0);
    this.geoBox = makeBoxGeo(T, 2, 2);
    this.geoRoof = makeRoofGeo(T);

    this.mPole = this._mkInstanced(this.geoPole, this.matWood, poleCount, { cast: true });
    this.mWood = this._mkInstanced(this.geoBox, this.matWood, woodCount, { cast: true });
    this.mPaint = this._mkInstanced(this.geoBox, this.matPaint, paintCount, { cast: true });
    this.mRoof = this._mkInstanced(this.geoRoof, this.matZinc, roofCount, { cast: true });

    this._villGen = new Int32Array(this.NV).fill(0x7fffffff);
    this._houseInfo = new Float32Array(this.houseSlots * 5); // x, z, deckY, width, colour
    this._houseLive = new Uint8Array(this.houseSlots);
    this._houseColor = new Int32Array(this.houseSlots);
  }

  _place(mesh, idx, lx, ly, lz, sx, sy, sz, localQ) {
    this._v.set(lx, ly, lz).applyQuaternion(this._oq).add(this._origin);
    this._q.copy(this._oq);
    if (localQ) this._q.multiply(localQ);
    this._s.set(sx, sy, sz);
    this._m.compose(this._v, this._q, this._s);
    mesh.setMatrixAt(idx, this._m);
  }

  _hide(mesh, idx) { mesh.setMatrixAt(idx, this._hidden); }

  _updateHouses(zMin) {
    const wrap = this.wrap, NV = this.NV;
    let dirty = false;
    for (let j = 0; j < NV; j++) {
      const z0 = ((j + 0.5) * wrap) / NV;
      const k = wrapK(z0, zMin, wrap);
      if (this._villGen[j] === k) continue;
      this._villGen[j] = k;
      this._layoutVillage(j, k, z0 + k * wrap);
      dirty = true;
    }
    return dirty;
  }

  _layoutVillage(j, k, zCentre) {
    const HPV = this.HPV;
    const spread = this.wrap / this.NV;
    const zc = zCentre + (H(j, k, 101) - 0.5) * spread * 0.5;
    const occupied = H(j, k, 102) > 0.20;
    const side = H(j, k, 103) < 0.5 ? -1 : 1;
    const n = occupied ? 3 + Math.floor(H(j, k, 104) * (HPV - 2.001)) : 0;
    const spacing = 11 + H(j, k, 105) * 7;

    for (let m = 0; m < HPV; m++) {
      const h = j * HPV + m;
      if (m >= n) { this._hideHouse(h); continue; }
      const zh = zc + (m - (n - 1) * 0.5) * spacing + (H(h, k, 106) - 0.5) * 4.5;
      this._layoutHouse(h, k, zh, side);
    }
  }

  _hideHouse(h) {
    this._houseLive[h] = 0;
    for (let p = 0; p < this.POLES_PER_HOUSE; p++) this._hide(this.mPole, h * this.POLES_PER_HOUSE + p);
    for (let p = 0; p < this.WOOD_PER_HOUSE; p++) this._hide(this.mWood, h * this.WOOD_PER_HOUSE + p);
    for (let p = 0; p < this.PAINT_PER_HOUSE; p++) this._hide(this.mPaint, h * this.PAINT_PER_HOUSE + p);
    for (let p = 0; p < this.ROOF_PER_HOUSE; p++) this._hide(this.mRoof, h * this.ROOF_PER_HOUSE + p);
  }

  // A palafita: deck on stilts, plank walls with saturated peeling paint, rusty
  // corrugated roof, porch, walkway inland, stairs down to the water, washing line.
  _layoutHouse(h, k, z, side) {
    const T = this.T;
    const cx = this.centerX(z), hw = this.halfWidth(z);
    const off = -7 + H(h, k, 110) * 11;              // negative = stilts in the water
    const x = cx + side * (hw + off);
    const ground = this.groundY(x, z, cx, hw);

    const W = 4.8 + H(h, k, 111) * 3.8;              // along the shore (local X)
    const D = 4.0 + H(h, k, 112) * 2.8;              // toward the river (local Z)
    const wallH = 2.3 + H(h, k, 113) * 1.2;
    // Deck height is anchored to the still-water datum, not to the terrain: the
    // house stands in the water and river.js's ground query may legitimately
    // report the full bank height right at the edge.
    const deckY = 2.8 + H(h, k, 114) * 1.7 + Math.max(0, Math.min(ground, 2.5)) * 0.35;
    const yaw = -side * Math.PI * 0.5 + (H(h, k, 115) - 0.5) * 0.5;

    this._origin.set(x, 0, z);
    this._oq.setFromAxisAngle(this._UP, yaw);

    const woodTint = WOOD_TINTS[(H(h, k, 116) * WOOD_TINTS.length) | 0];
    const paintHex = PAINT_TINTS[(H(h, k, 117) * PAINT_TINTS.length) | 0];
    const roofTint = ROOF_TINTS[(H(h, k, 118) * ROOF_TINTS.length) | 0];
    const weather = 0.62 + H(h, k, 119) * 0.36;

    this._houseLive[h] = 1;
    this._houseColor[h] = paintHex;
    const hi = h * 5;
    this._houseInfo[hi] = x; this._houseInfo[hi + 1] = z;
    this._houseInfo[hi + 2] = deckY; this._houseInfo[hi + 3] = W;
    this._houseInfo[hi + 4] = side;

    // ---- stilts (3x3 grid minus the centre) -------------------------------
    const pb = h * this.POLES_PER_HOUSE;
    const halfW = (W + 1.4) * 0.5 * 0.88, halfD = (D + 1.2) * 0.5 * 0.88;
    let p = 0;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        if (a === 0 && b === 0) continue;
        const lx = a * halfW, lz = b * halfD;
        const wx = x + Math.cos(yaw) * lx + Math.sin(yaw) * lz;
        const wz = z - Math.sin(yaw) * lx + Math.cos(yaw) * lz;
        const gy = Math.min(this.groundY(wx, z + lz, cx, hw), -0.4);
        const bottom = gy - 1.4;
        const r = 0.13 + H(h * 31 + p, k, 120) * 0.07;
        this._place(this.mPole, pb + p, lx, bottom, lz, r, deckY - bottom + 0.2, r);
        this.mPole.setColorAt(pb + p, this._c.setHex(woodTint).multiplyScalar(weather * 0.8));
        p++;
      }
    }

    // ---- washing line: two posts + the line itself ------------------------
    const lineY = deckY + 0.2 + 2.1;
    for (const s2 of [-1, 1]) {
      this._place(this.mPole, pb + p, s2 * W * 0.42, deckY + 0.16, D * 0.5 + 0.9, 0.06, 2.2, 0.06);
      this.mPole.setColorAt(pb + p, this._c.setHex(woodTint).multiplyScalar(weather * 0.9));
      p++;
    }
    // The pole geometry runs +Y from its base; rotating +90° about Z lays it
    // along -X, so anchor it at +W*0.42 to span the gap between the two posts.
    this._q2.setFromAxisAngle(this._AXZ, Math.PI * 0.5);
    this._place(this.mPole, pb + p, W * 0.42, lineY, D * 0.5 + 0.9, 0.02, W * 0.84, 0.02, this._q2);
    this.mPole.setColorAt(pb + p, this._c.setHex(0x2a2018));
    p++;

    // ---- mooring post out in front ----------------------------------------
    this._place(this.mPole, pb + p, W * 0.62, -2.2, D * 0.5 + 3.4, 0.12, 4.0, 0.12);
    this.mPole.setColorAt(pb + p, this._c.setHex(woodTint).multiplyScalar(weather * 0.7));
    p++;
    while (p < this.POLES_PER_HOUSE) { this._hide(this.mPole, pb + p); p++; }

    // ---- decks / walkway / stairs (wood pool) ------------------------------
    const wb = h * this.WOOD_PER_HOUSE;
    const woodCol = this._c.setHex(woodTint).multiplyScalar(weather);
    this._place(this.mWood, wb + 0, 0, deckY + 0.14, 0, W + 1.4, 0.28, D + 1.2);
    this.mWood.setColorAt(wb + 0, woodCol);
    // porch deck on the river side
    this._place(this.mWood, wb + 1, 0, deckY + 0.16, D * 0.5 + 1.0, W * 0.84, 0.22, 2.1);
    this.mWood.setColorAt(wb + 1, this._c.setHex(woodTint).multiplyScalar(weather * 0.92));
    // walkway inland (slopes up toward the bank)
    this._q2.setFromAxisAngle(this._AXX, 0.16);
    this._place(this.mWood, wb + 2, (H(h, k, 121) - 0.5) * W * 0.4, deckY - 0.35, -(D * 0.5 + 3.6),
      1.5, 0.2, 7.6, this._q2);
    this.mWood.setColorAt(wb + 2, this._c.setHex(woodTint).multiplyScalar(weather * 0.85));
    // stairs down to the water
    this._q2.setFromAxisAngle(this._AXX, -0.95);
    this._place(this.mWood, wb + 3, W * 0.3, deckY * 0.45, D * 0.5 + 2.3,
      1.1, 0.16, deckY * 1.7, this._q2);
    this.mWood.setColorAt(wb + 3, this._c.setHex(woodTint).multiplyScalar(weather * 0.78));

    // ---- painted walls + window band + laundry (paint pool) ----------------
    const ab = h * this.PAINT_PER_HOUSE;
    this._place(this.mPaint, ab + 0, 0, deckY + 0.28 + wallH * 0.5, 0, W, wallH, D);
    this.mPaint.setColorAt(ab + 0, this._c.setHex(paintHex).multiplyScalar(weather));
    this._place(this.mPaint, ab + 1, 0, deckY + 0.28 + wallH * 0.62, D * 0.5 + 0.04, W * 0.82, wallH * 0.34, 0.08);
    this.mPaint.setColorAt(ab + 1, this._c.setHex(0x20180f));
    for (let q = 0; q < 2; q++) {
      const cl = CLOTH_TINTS[(H(h, k, 122 + q) * CLOTH_TINTS.length) | 0];
      this._place(this.mPaint, ab + 2 + q, (q ? 0.22 : -0.22) * W, lineY - 0.42, D * 0.5 + 0.9,
        0.5 + H(h, k, 124 + q) * 0.3, 0.8, 0.05);
      this.mPaint.setColorAt(ab + 2 + q, this._c.setHex(cl).multiplyScalar(0.85));
    }

    // ---- roofs ------------------------------------------------------------
    const rb = h * this.ROOF_PER_HOUSE;
    const roofH = 0.9 + H(h, k, 125) * 0.8;
    this._place(this.mRoof, rb + 0, 0, deckY + 0.28 + wallH, 0, W + 1.1, roofH, D + 1.3);
    this.mRoof.setColorAt(rb + 0, this._c.setHex(roofTint).multiplyScalar(0.75 + H(h, k, 126) * 0.4));
    this._q2.setFromAxisAngle(this._AXX, 0.22);
    this._place(this.mRoof, rb + 1, 0, deckY + 0.28 + wallH * 0.88, D * 0.5 + 1.0, W * 0.9, 0.42, 2.5, this._q2);
    this.mRoof.setColorAt(rb + 1, this._c.setHex(roofTint).multiplyScalar(0.65 + H(h, k, 127) * 0.4));
  }

  // ------------------------------------------------------------------- boats

  _buildBoats() {
    const T = this.T;
    this.geoCanoe = makeHullGeo(T,
      [0.04, 0.34, 0.62, 0.84, 0.92, 0.86, 0.66, 0.38, 0.06],
      [1.0, 0.72, 0.55, 0.48, 0.46, 0.50, 0.60, 0.80, 1.0],
      [0.12, 0.52, 0.84, 0.98, 1.0, 0.96, 0.84, 0.52, 0.12], false);
    this.geoShip = makeHullGeo(T,
      [0.66, 0.86, 0.96, 1.0, 1.0, 0.97, 0.86, 0.58, 0.14],
      [0.62, 0.5, 0.44, 0.42, 0.42, 0.45, 0.52, 0.68, 0.95],
      [0.55, 0.9, 1.0, 1.0, 1.0, 0.98, 0.9, 0.62, 0.18], true);

    this.mCanoe = this._mkInstanced(this.geoCanoe, this.matHull, this.canoeCount, { cast: true });
    this.mShip = this._mkInstanced(this.geoShip, this.matHull, this.shipCount, { cast: true });
  }

  _updateBoats(zMin, playerZ) {
    const wrap = this.wrap;
    const NC = this.canoeCount, NS = this.shipCount;
    const t = this.state ? this.state.time : 0;

    for (let i = 0; i < NC; i++) {
      const z0 = ((i + 0.29) * wrap) / NC;
      const k = wrapK(z0, zMin, wrap);
      const z = z0 + k * wrap + (H(i, k, 201) - 0.5) * (wrap / NC);
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      // Moored in the shallows: keep the surfable middle of the channel clear.
      const off = 3 + Math.pow(H(i, k, 202), 1.3) * 30;
      const x = cx + side * (hw - off);
      const len = 4.2 + H(i, k, 203) * 5.4;
      const beam = len * (0.16 + H(i, k, 204) * 0.07);
      const yaw = (H(i, k, 205) - 0.5) * 0.9 + (H(i, k, 206) < 0.5 ? 0 : Math.PI);
      const near = Math.abs(z - playerZ) < 300;
      this._floatAt(this.mCanoe, i, x, z, yaw, len, beam, len * 0.30, near, i, k, 207);
      const wt = WOOD_TINTS[(H(i, k, 208) * WOOD_TINTS.length) | 0];
      this.mCanoe.setColorAt(i, this._c.setHex(wt).multiplyScalar(0.55 + H(i, k, 209) * 0.5));

      // mooring post beside it
      const pIdx = this.poleBase + i;
      this._origin.set(x, 0, z); this._oq.identity();
      const py = Math.min(this.waterY(x + side * beam * 1.6, z) - 1.8, -1.0);
      this._place(this.mPole, pIdx, side * beam * 1.9, py, 0, 0.11, 3.2, 0.11);
      this.mPole.setColorAt(pIdx, this._c.setHex(0x6d5236));
    }

    for (let i = 0; i < NS; i++) {
      const z0 = ((i + 0.71) * wrap) / NS;
      const k = wrapK(z0, zMin, wrap);
      const z = z0 + k * wrap + (H(i, k, 221) - 0.5) * (wrap / NS);
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      const off = 10 + Math.pow(H(i, k, 222), 1.2) * 32;
      const x = cx + side * (hw - off);
      const len = 12 + H(i, k, 223) * 9;
      const beam = len * (0.24 + H(i, k, 224) * 0.06);
      const yaw = (H(i, k, 225) - 0.5) * 0.7 + (H(i, k, 226) < 0.5 ? 0 : Math.PI);
      const hgt = beam * 0.9;
      const near = Math.abs(z - playerZ) < 400;
      this._floatAt(this.mShip, i, x, z, yaw, len, beam, hgt, near, i, k, 227);
      const wt = WOOD_TINTS[(H(i, k, 228) * WOOD_TINTS.length) | 0];
      this.mShip.setColorAt(i, this._c.setHex(wt).multiplyScalar(0.6 + H(i, k, 229) * 0.45));

      // Superstructure rides the hull frame: origin/quaternion already set by
      // _floatAt, so local coordinates are hull-relative.
      const cabW = beam * 0.82, cabL = len * 0.42, cabH = 1.9 + H(i, k, 230) * 0.7;
      const deckY = hgt * 0.30;
      const wb = this.woodBase + i;
      this._place(this.mWood, wb, 0, deckY + 0.06, -len * 0.06, beam * 0.95, 0.14, len * 0.86);
      this.mWood.setColorAt(wb, this._c.setHex(0x9c7c54).multiplyScalar(0.8));

      const ab = this.paintBase + i * 2;
      const hull = H(i, k, 231) < 0.5 ? 0xe6dcc6 : 0x4f86bf;
      this._place(this.mPaint, ab + 0, 0, deckY + 0.13 + cabH * 0.5, -len * 0.08, cabW, cabH, cabL);
      this.mPaint.setColorAt(ab + 0, this._c.setHex(hull).multiplyScalar(0.82));
      this._place(this.mPaint, ab + 1, 0, deckY + 0.13 + cabH + cabH * 0.42, -len * 0.10,
        cabW * 0.86, cabH * 0.84, cabL * 0.8);
      this.mPaint.setColorAt(ab + 1, this._c.setHex(hull).multiplyScalar(0.72));

      const rb = this.roofBase + i;
      this._place(this.mRoof, rb, 0, deckY + 0.13 + cabH * 2.28, -len * 0.10, cabW * 1.05, 0.45, cabL * 0.95);
      this.mRoof.setColorAt(rb, this._c.setHex(0xb9b0a2).multiplyScalar(0.8));

      const pb = this.poleBase + this.canoeCount + i * 2;
      this._place(this.mPole, pb + 0, 0, deckY + 0.13, len * 0.36, 0.08, 3.4 + H(i, k, 232) * 1.6, 0.08);
      this.mPole.setColorAt(pb + 0, this._c.setHex(0x8a6f4c));
      this._place(this.mPole, pb + 1, 0, deckY + 0.13 + cabH * 2.4, -len * 0.10, 0.07, 1.8, 0.07);
      this.mPole.setColorAt(pb + 1, this._c.setHex(0x8a6f4c));
    }

    this.mCanoe.instanceMatrix.needsUpdate = true;
    this.mShip.instanceMatrix.needsUpdate = true;
    if (this.mCanoe.instanceColor) this.mCanoe.instanceColor.needsUpdate = true;
    if (this.mShip.instanceColor) this.mShip.instanceColor.needsUpdate = true;
  }

  // Float a hull on the bore surface; leaves _origin/_oq set to the hull frame.
  _floatAt(mesh, idx, x, z, yaw, len, beam, hgt, near, i, k, salt) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const y = this.waterY(x, z);
    let pitch = 0, roll = 0;
    if (near) {
      const L = len * 0.42, B = beam * 0.6;
      const hF = this.waterY(x + sy * L, z + cy * L);
      const hB = this.waterY(x - sy * L, z - cy * L);
      const hR = this.waterY(x + cy * B, z - sy * B);
      const hL = this.waterY(x - cy * B, z + sy * B);
      pitch = -Math.atan2(hF - hB, 2 * L);
      roll = Math.atan2(hR - hL, 2 * B);
      pitch = clamp(pitch, -0.7, 0.7);
      roll = clamp(roll, -0.7, 0.7);
    }
    const t = this.state ? this.state.time : 0;
    const ph = H(i, k, salt) * TAU;
    roll += Math.sin(t * 1.1 + ph) * 0.035;
    pitch += Math.sin(t * 0.83 + ph * 1.7) * 0.025;

    this._e.set(pitch, yaw, roll, 'YXZ');
    this._oq.setFromEuler(this._e);
    this._origin.set(x, y - hgt * 0.16, z);
    this._s.set(beam, hgt, len);
    this._m.compose(this._origin, this._oq, this._s);
    mesh.setMatrixAt(idx, this._m);
    return y;
  }

  // ------------------------------------------------------- reflections & fx

  _buildDetails() {
    const T = this.T;
    this.geoSmear = makeSmearGeo(T);
    this.geoQuad = makeUprightQuadGeo(T);
    this.geoBird = makeBirdGeo(T);

    this.reflectCount = this.houseSlots + this.canoeCount + this.shipCount;
    this.mSmear = this._mkInstanced(this.geoSmear, this.matSmear, this.reflectCount, { renderOrder: 4 });
    this.smokeCount = Math.min(20, this.NV * 2);
    this.mSmoke = this._mkInstanced(this.geoQuad, this.matSmoke, this.smokeCount, { renderOrder: 5 });
    this.birdCount = 26;
    this.mBird = this._mkInstanced(this.geoBird, this.matBird, this.birdCount, { renderOrder: 3 });
  }

  // Cheap stand-in for a real reflection: a warm, ripple-broken smear on the
  // still water beside each structure. Phase 2 replaces this with the real thing.
  _updateReflections(playerZ) {
    let n = 0;
    const camZ = this._camPos.z;

    const put = (x, z, width, len, colHex, mul) => {
      if (n >= this.reflectCount) return;
      const idx = n++;
      const d = z - this.crestZ(x);
      // Only on the glassy water ahead of the bore.
      const fade = smooth01((d - 10) / 26);
      if (fade <= 0.02 || Math.abs(z - playerZ) > 520) { this._hide(this.mSmear, idx); return; }
      const y = this.waterY(x, z) + 0.14;   // clear of surface chop
      const toward = z > camZ ? -1 : 1;               // smear toward the viewer
      const dirX = (x > this.centerX(z) ? -1 : 1) * 0.55;
      const dirZ = toward * 0.85;
      const yaw = Math.atan2(dirX, dirZ);
      this._q.setFromAxisAngle(this._UP, yaw);
      this._v.set(x, y, z);
      this._s.set(width, 1, len * fade);
      this._m.compose(this._v, this._q, this._s);
      this.mSmear.setMatrixAt(idx, this._m);
      this.mSmear.setColorAt(idx, this._c.setHex(colHex).multiplyScalar(mul * fade));
    };

    for (let h = 0; h < this.houseSlots; h++) {
      if (!this._houseLive[h]) { if (n < this.reflectCount) this._hide(this.mSmear, n++); continue; }
      const hi = h * 5;
      put(this._houseInfo[hi], this._houseInfo[hi + 1] + 2,
        this._houseInfo[hi + 3] * 1.15, this._houseInfo[hi + 2] * 4.2,
        this._houseColor[h], 0.5);
    }
    const wrap = this.wrap;
    const zMin = playerZ - this.cullBehind;
    for (let i = 0; i < this.canoeCount; i++) {
      const z0 = ((i + 0.29) * wrap) / this.canoeCount;
      const k = wrapK(z0, zMin, wrap);
      const z = z0 + k * wrap + (H(i, k, 201) - 0.5) * (wrap / this.canoeCount);
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      const off = 3 + Math.pow(H(i, k, 202), 1.3) * 30;
      put(cx + side * (hw - off), z, 3.0, 7.0, 0x6b4f31, 0.55);
    }
    for (let i = 0; i < this.shipCount; i++) {
      const z0 = ((i + 0.71) * wrap) / this.shipCount;
      const k = wrapK(z0, zMin, wrap);
      const z = z0 + k * wrap + (H(i, k, 221) - 0.5) * (wrap / this.shipCount);
      const side = (i & 1) ? 1 : -1;
      const cx = this.centerX(z), hw = this.halfWidth(z);
      const off = 10 + Math.pow(H(i, k, 222), 1.2) * 32;
      put(cx + side * (hw - off), z, 6.5, 15.0, 0xd8cfb8, 0.5);
    }
    while (n < this.reflectCount) this._hide(this.mSmear, n++);
    this.mSmear.instanceMatrix.needsUpdate = true;
    if (this.mSmear.instanceColor) this.mSmear.instanceColor.needsUpdate = true;
  }

  _updateSmoke() {
    const t = this.state ? this.state.time : 0;
    // Face the camera around Y.
    for (let i = 0; i < this.smokeCount; i++) {
      const h = (i * 3 + 1) % this.houseSlots;
      if (!this._houseLive[h] || H(h, 0, 300) > 0.55) { this._hide(this.mSmoke, i); continue; }
      const hi = h * 5;
      const x = this._houseInfo[hi] + this._houseInfo[hi + 4] * 2.5;
      const z = this._houseInfo[hi + 1] - 2.5;
      const y = this._houseInfo[hi + 2] + 1.4;
      const dx = x - this._camPos.x, dz = z - this._camPos.z;
      const yaw = Math.atan2(dx, dz);
      const sway = Math.sin(t * 0.31 + i * 1.7) * 1.6;
      this._q.setFromAxisAngle(this._UP, yaw);
      this._v.set(x + sway, y, z);
      const hh = 13 + ((i * 37) % 11);
      this._s.set(4.5 + (i % 3) * 1.4, hh, 1);
      this._m.compose(this._v, this._q, this._s);
      this.mSmoke.setMatrixAt(i, this._m);
    }
    this.mSmoke.instanceMatrix.needsUpdate = true;
  }

  _updateBirds(playerZ) {
    const t = this.state ? this.state.time : 0;
    for (let i = 0; i < this.birdCount; i++) {
      const a = hash2(i, 3, SEED ^ 0x5151);
      const b = hash2(i, 7, SEED ^ 0x5151);
      const c = hash2(i, 11, SEED ^ 0x5151);
      const span = 640;
      const z = playerZ + 150 + (((i * 71.3 + a * span + t * (3 + b * 4)) % span) + span) % span;
      const cx = this.centerX(z);
      const x = cx + Math.sin(t * (0.06 + c * 0.05) + i * 1.31) * (60 + b * 120) + (a - 0.5) * 120;
      const y = 40 + c * 74 + Math.sin(t * 0.5 + i) * 2.2;
      const flap = 0.35 + 0.65 * Math.abs(Math.sin(t * (5.5 + b * 3) + i * 1.9));
      const sc = 1.1 + b * 0.9;
      this._q.setFromAxisAngle(this._UP, Math.atan2(Math.cos(t * 0.06 + i), 1) + Math.PI * 0.5);
      this._v.set(x, y, z);
      this._s.set(sc, sc * flap, sc);
      this._m.compose(this._v, this._q, this._s);
      this.mBird.setMatrixAt(i, this._m);
    }
    this.mBird.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------------------- step

  step(dt) {
    if (!this.enabled || this._failed || this._disposed) return;
    try {
      // Late-binding river: rebuild everything once it shows up.
      if (!this._riverResolved && this._riverRetry < 240) {
        this._riverRetry++;
        if (this._riverRetry % 20 === 1 && this._resolveRiver()) this._invalidate();
      }

      const st = this.state;
      let playerZ = st && st.player && isNum(st.player.z) ? st.player.z : null;
      if (playerZ === null) playerZ = st && st.bore && isNum(st.bore.z) ? st.bore.z : 0;
      const zMin = playerZ - this.cullBehind;

      if (this.camera && this.camera.getWorldPosition) {
        this.camera.getWorldPosition(this._camPos);
      } else {
        this._camPos.set(0, 3, playerZ - 8);
      }

      this._updateRibbons(zMin);
      this._updateTrees(zMin);

      this._updateHouses(zMin);
      this._updateBoats(zMin, playerZ);
      // Houses share these pools with the boats, and boats bob every frame, so
      // the pools are re-uploaded unconditionally (a few hundred instances).
      for (const m of [this.mPole, this.mWood, this.mPaint, this.mRoof]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }

      this._updateReflections(playerZ);
      this._updateSmoke();
      this._updateBirds(playerZ);
    } catch (err) {
      this._failed = true;
      this.enabled = false;
      if (typeof console !== 'undefined') console.warn('[scenery] step failed, disabled:', err);
    }
  }

  // Force a full re-layout on the next step (used when river.js binds late).
  _invalidate() {
    if (this._genBroad) this._genBroad.fill(0x7fffffff);
    if (this._genPalm) this._genPalm.fill(0x7fffffff);
    if (this._genBill) this._genBill.fill(0x7fffffff);
    if (this._genUnder) this._genUnder.fill(0x7fffffff);
    if (this._villGen) this._villGen.fill(0x7fffffff);
    if (this.ribbons) for (const rb of this.ribbons) rb.zStart = NaN;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.enabled = false;
    if (this.scene && this.group) this.scene.remove(this.group);
    if (this.group) this.group.clear();
    const seen = new Set();
    for (const g of this._geoms) { if (g && !seen.has(g)) { seen.add(g); g.dispose(); } }
    for (const m of this._mats) { if (m && !seen.has(m)) { seen.add(m); m.dispose(); } }
    for (const t of this._textures) { if (t && !seen.has(t)) { seen.add(t); t.dispose(); } }
    for (const m of this._meshes) { if (m && m.dispose) m.dispose(); }
    this._geoms.length = 0;
    this._mats.length = 0;
    this._textures.length = 0;
    this._meshes.length = 0;
    if (this.ctx && this.ctx.scenery === this) this.ctx.scenery = null;
  }
}

export default Scenery;
