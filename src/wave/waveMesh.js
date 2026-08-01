// ============================================================================
// POROROCA RUSH — src/wave/waveMesh.js
//
// The pororoca surface: the unbroken face, the throwing lip / tube, and the
// whitewater tail behind the crest.
//
// ALL wave geometry is evaluated from `BoreWave.GLSL` (pr_crest / pr_height /
// pr_normal / pr_barrel / pr_breakIntensity). This module never re-derives the
// field maths — it only parametrises a mesh over it. If CPU and GPU disagree,
// the surfer floats or sinks, so there is exactly one source of truth.
//
// Two draw calls:
//   1. `body` — a crest-anchored heightfield over d ∈ [-BEHIND, +AHEAD].
//      Non-uniform in d: ~0.11 m rows at the lip, growing geometrically to
//      ~3 m far ahead. Uniform and wide in x, snapped to cell size so it can
//      follow the player laterally without popping.
//   2. `curl` — the overhanging lip. An arc swept along the crest wherever
//      pr_barrel() clears CONFIG.wave.barrelThreshold. Parametrised by an
//      angle that runs past 90°, so the lip genuinely projects forward and
//      roofs over the face: a real, enterable cavity, DoubleSide, visible
//      from inside. Collapses to zero area where there is no barrel.
//
// Budget: ~172k triangles, 2 draw calls.
// Phase 2 extension points are tagged `[FASE 2]`.
// ============================================================================

import { BoreWave } from './bore.js';

const DEG = Math.PI / 180;

// Arc that describes the throwing lip, in the (d, y) plane.
// phi is measured from the top of the curl circle: phi<0 is still on the crest
// side, phi=90° is the furthest-forward point, phi>90° is the curtain falling.
const CURL_PHI0 = -42 * DEG;
const CURL_PHI1 = 146 * DEG;

// --------------------------------------------------------------------------
// Fallback wave field. Used ONLY when BoreWave.GLSL is missing or malformed,
// so that a half-finished neighbour cannot stop the game from booting.
// It is intentionally a rough approximation — bore.js is the real thing.
// --------------------------------------------------------------------------
function fallbackBoreGLSL(W) {
  const n = (v, d) => (Number.isFinite(v) ? v : d).toFixed(6);
  return `
// [waveMesh] FALLBACK wave field (BoreWave.GLSL unavailable).
float prfb_hash(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.72); return fract(p.x * p.y); }
float prfb_noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(prfb_hash(i), prfb_hash(i + vec2(1.0, 0.0)), u.x),
             mix(prfb_hash(i + vec2(0.0, 1.0)), prfb_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float pr_crest(float x, float t) {
  float u = x / 165.0;
  float bow = ${n(W.crestBow, 34)} * (1.0 - exp(-u * u * 1.15));
  float wander = ${n(W.crestWander, 11)} * (0.62 * sin(x * 0.0091 + t * 0.19) + 0.38 * sin(x * 0.0027 - t * 0.11));
  return ${n(W.boreSpeed, 8.6)} * t - bow + wander;
}
float prfb_amp(float x, float t) {
  return ${n(W.amplitude, 3.1)} + ${n(W.amplitudeVar, 0.9)} * (0.6 * sin(x * 0.0074 + t * 0.16) + 0.4 * sin(x * 0.019 - t * 0.09));
}
float pr_barrel(float x, float t) {
  float c = (x + ${n(W.boreSpeed, 8.6)} * t * 0.12) / ${n(W.barrelCellSize, 90)};
  return clamp((0.5 + 0.5 * sin(c * 6.2831853)) * 1.28 - 0.14, 0.0, 1.0);
}
float pr_breakIntensity(float x, float t) {
  return clamp(0.55 + 0.36 * sin(x * 0.013 + t * 0.24) + 0.18 * sin(x * 0.041 - t * 0.5), 0.0, 1.0);
}
float pr_height(float x, float z, float t) {
  float d = z - pr_crest(x, t);
  float a = prfb_amp(x, t);
  float h;
  if (d >= 0.0) {
    float ft = clamp(d / ${n(W.faceLen, 26)}, 0.0, 1.0);
    h = a * pow(1.0 - ft, ${n(W.faceSteepness, 1.55)});
  } else {
    float b = -d;
    h = a * (0.62 + 0.38 * exp(-b * 0.045));
    h += ${n(W.trailAmp, 1.15)} * sin(b / ${n(W.trailLen, 21)} * 6.2831853 - t * 1.2) * exp(-b * 0.011);
  }
  h += ${n(W.chopAmp, 0.22)} * (prfb_noise(vec2(x, z) * ${n((W.chopScale || 0.55) * 0.22, 0.121)} + vec2(0.0, -t * 0.35)) - 0.5) * 2.0;
  return h;
}
`;
}

// Shims, appended (after PW_COMMON, so they may use our uniforms) whenever
// bore.js has not published a function we lean on. Ordered by dependency.
const SHIMS = [
  ['pr_barrel', `
float pr_barrel(float x, float t) { return 0.0; }
`],
  ['pr_breakIntensity', `
float pr_breakIntensity(float x, float t) { return 0.7; }
`],
  ['pr_normal', `
vec3 pr_normal(float x, float z, float t) {
  float e = 0.35;
  float hL = pr_height(x - e, z, t), hR = pr_height(x + e, z, t);
  float hB = pr_height(x, z - e, t), hF = pr_height(x, z + e, t);
  return normalize(vec3(-(hR - hL), 2.0 * e, -(hF - hB)));
}
`],
  // vec3(inner d, outer d, roof world-Y); all zero when the section is not tubing.
  ['pr_tubePocket', `
vec3 pr_tubePocket(float x, float t) {
  float b = pr_barrel(x, t);
  float bs = clamp((b - uPwBarrelThr) / max(1.0 - uPwBarrelThr, 0.05), 0.0, 1.0);
  if (bs <= 0.0) return vec3(0.0);
  float thrown = uPwLipOverhang * bs;
  return vec3(thrown * 0.22,
              thrown + 1.9 * (0.6 + 0.4 * bs),
              pr_height(x, pr_crest(x, t), t) * 0.97);
}
`],
  // Foam coverage 0..1 — bore.js owns this so waveMesh and foam.js agree.
  ['pr_whitewater', `
float pr_whitewater(float x, float z, float t) {
  float d = z - pr_crest(x, t);
  float bi = pr_breakIntensity(x, t);
  float cover = (d >= 0.0)
    ? bi * (1.0 - smoothstep(0.0, 6.0, d))
    : mix(bi, bi * 0.25, clamp(-d / max(uPwWWDepth, 1.0), 0.0, 1.0));
  return clamp(cover, 0.0, 1.0);
}
`],
];

// --------------------------------------------------------------------------
// waveMesh-private helpers. `pw_` prefix keeps them clear of bore's `pr_`
// namespace and of three.js' own chunk symbols.
// --------------------------------------------------------------------------
const PW_COMMON = `
uniform float uPwTime;
uniform float uPwAnchorX;
uniform float uPwFaceLen;
uniform float uPwWWDepth;
uniform float uPwAmp;
uniform float uPwBarrelThr;
uniform float uPwLipOverhang;
uniform float uPwCurlRadius;
uniform float uPwTubeClear;
uniform float uPwChurn;
uniform float uPwDetail;
uniform float uPwRoughWater;
uniform float uPwRoughFoam;
uniform vec3  uPwDeep;
uniform vec3  uPwShallow;
uniform vec3  uPwTint;
uniform vec3  uPwFoam;
uniform vec3  uPwFoamDeep;

varying vec3 vPwWorld;
varying vec4 vPwParams;   // x = d, y = breakIntensity, z = barrel, w = arc param
varying vec3 vPwHintN;    // analytic normal (curl only)

float pw_hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float pw_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pw_hash(i), pw_hash(i + vec2(1.0, 0.0)), u.x),
             mix(pw_hash(i + vec2(0.0, 1.0)), pw_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float pw_fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * pw_noise(p); p *= 2.07; a *= 0.5; }
  return s / 0.875;
}
`;

const PW_VERTEX_FN = `
// Body: pure heightfield, exactly pr_height(). Anything that would break CPU/GPU
// parity is confined to d < -8 (past CONFIG.physics.loseBehind), where the
// player has already lost the wave.
vec3 pw_bodySurface(vec3 p) {
  float t = uPwTime;
  float x = p.x + uPwAnchorX;
  float d = p.z;
  float zc = pr_crest(x, t);
  float z = zc + d;
  float y = pr_height(x, z, t);

  float churn = smoothstep(-8.0, -24.0, d) * uPwChurn;
  y += (pw_noise(vec2(x * 0.085, d * 0.105 - t * 0.55)) - 0.5) * 2.0 * churn;
  y += (pw_noise(vec2(x * 0.31, d * 0.27 + t * 0.9)) - 0.5) * churn * 0.5;

  vPwWorld = vec3(x, y, z);
  vPwParams = vec4(d, pr_breakIntensity(x, t), pr_barrel(x, t), 0.0);
  vPwHintN = vec3(0.0, 1.0, 0.0);
  return vPwWorld;
}

// One point on the throwing-lip arc, expressed in (d, y).
//
// The base shape is a circle anchored on the crest and parametrised by an angle
// that runs from -42° (welded to the crest) past 90° (furthest forward) to 146°
// (curtain falling) — an angle, not d, which is what lets the lip actually
// overhang instead of being a height field.
//
// Two corrections make the tube rideable no matter what face profile bore.js
// hands us:
//   * roof lift — the ceiling is raised until it clears both bore's own logical
//     roof (pr_tubePocket().z, what tricks.js scores against) and a minimum of
//     uPwTubeClear metres of air. On an already-steep face the lift is zero.
//   * curtain floor — the falling edge is landed just under the water instead
//     of hanging in space or stabbing metres through the face.
vec2 pw_curlPoint(float x, float zc, float yTop, float R, float roofY, float s, float t) {
  float phi = mix(${CURL_PHI0.toFixed(6)}, ${CURL_PHI1.toFixed(6)}, clamp(s, 0.0, 1.0));
  float dC = R * ${Math.sin(-CURL_PHI0).toFixed(6)};
  float yC = yTop - R * ${Math.cos(CURL_PHI0).toFixed(6)};
  float d = dC + R * sin(phi);
  float y = yC + R * cos(phi);

  float hFace = pr_height(x, zc + d, t);
  float need = max(uPwTubeClear, (roofY - hFace) + 0.40);

  // 0 at the crest weld, full across the roof, 0 again on the curtain.
  float w = smoothstep(0.0, 0.28, s) * (1.0 - smoothstep(0.40, 0.86, s));
  y += max(0.0, (hFace + need) - y) * w;
  y = max(y, hFace - 0.30);
  return vec2(d, y);
}

// Curl: the throwing lip, swept along the crest.
// Its forward reach is bore's own barrel throat (pr_tubePocket().y), so the
// tube the player sees is the tube physics and tricks.js are working with.
// At b = 0 (no barrel here) every ring collapses onto the crest line, so the
// strip is degenerate — zero pixels, no popping, no seam with the body mesh.
vec3 pw_curlSurface(vec3 p) {
  float t = uPwTime;
  float x = p.x + uPwAnchorX;
  float s = clamp(p.z, 0.0, 1.0);
  float zc = pr_crest(x, t);
  float yTop = pr_height(x, zc, t);

  float barrel = pr_barrel(x, t);
  float b = smoothstep(uPwBarrelThr, uPwBarrelThr + 0.22, barrel);

  vec3 pocket = pr_tubePocket(x, t);
  // The arc reaches furthest forward at phi = 90°, i.e. at (1 + sin42°) * R.
  float R = clamp((pocket.y > 0.05) ? pocket.y * ${(1 / (1 + Math.sin(-CURL_PHI0))).toFixed(6)} : uPwCurlRadius, 0.8, 6.0);
  float roofY = max(pocket.z, yTop * 0.9);

  vec2 P = pw_curlPoint(x, zc, yTop, R, roofY, s, t);

  // Normal by differencing along the arc, so the roof lift is accounted for.
  float h = 0.035;
  vec2 Pa = pw_curlPoint(x, zc, yTop, R, roofY, s - h, t);
  vec2 Pb = pw_curlPoint(x, zc, yTop, R, roofY, s + h, t);
  vec2 tang = Pb - Pa;
  tang /= max(length(tang), 1e-4);

  float d = mix(0.0, P.x, b);
  float y = mix(yTop, P.y, b);

  vPwWorld = vec3(x, y, zc + d);
  vPwParams = vec4(d, pr_breakIntensity(x, t), barrel, s);
  vPwHintN = normalize(vec3(0.0, tang.x, -tang.y));
  return vPwWorld;
}
`;

const PW_FRAGMENT_FN = `
// Shared between the colour pass and the normal pass — three.js evaluates
// <map_fragment> before <normal_fragment_begin>, so we compute once and stash.
vec3 gPwN = vec3(0.0, 1.0, 0.0);
float gPwFoam = 0.0;

// bore.js owns the foam coverage field (pr_whitewater) so that this mesh and
// foam.js' particles agree about where the whitewater is. On top of that shared
// base we add the shaping that only makes sense on a surface: the hot line on
// the lip, streaks dragged down the face, and noise breakup. Everything is
// authored in the CREST-RELATIVE frame (x, d) so it rides with the wave instead
// of sliding backwards through it.
// [FASE 2] replace the breakup with a persistent foam accumulation buffer fed
// by pr_flow(), plus a detailed foam albedo/normal set.
float pw_foamMask(float x, float z, float d, float brk, float t, out float breakup) {
  breakup = pw_fbm(vec2(x * 0.22, d * 0.22 + t * 0.35));

  float base = pr_whitewater(x, z, t);

  // Whitewater tail behind the crest — near-total coverage, easing out.
  float behind = smoothstep(1.4, -1.8, d);
  float tail = 1.0 - smoothstep(0.30, 1.10, clamp(-d, 0.0, 4000.0) / max(uPwWWDepth, 1.0));
  float foamBack = behind * mix(0.55, 1.0, brk) * (0.32 + 0.68 * tail);

  // The breaking line itself: a hot band right on the lip.
  float lip = exp(-d * d * 0.11) * mix(0.30, 1.0, brk);

  // Streaks dragged down the face from the lip.
  float fall = smoothstep(uPwFaceLen * 0.9, 0.0, max(d, 0.0));
  float sn = pw_fbm(vec2(x * 0.45, d * 0.030 - t * 0.16));
  float streaks = smoothstep(0.54, 0.88, sn) * fall * brk * 0.9;

  float m = clamp(max(base, foamBack) + lip + streaks, 0.0, 1.0);
  m = clamp(m * (0.45 + 0.90 * breakup) + m * m * 0.45, 0.0, 1.0);
  return smoothstep(0.10, 0.60, m);
}

vec3 pw_waterColour(vec3 P, vec3 N, float d) {
  float lift = clamp(P.y / max(uPwAmp, 0.5), -0.5, 1.4);
  float up = clamp(N.y, 0.0, 1.0);
  float shallowness = clamp(0.28 + 0.44 * lift + 0.30 * (1.0 - up), 0.0, 1.0);
  vec3 c = mix(uPwDeep, uPwShallow, shallowness);
  vec3 V = normalize(cameraPosition - P);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.5);
  // Opaque, silt-laden water: the tint warms it, it never turns blue or clear.
  // [FASE 2] SSS through the lip, caustics, screen-space reflection.
  return mix(c, uPwTint, 0.18 + 0.42 * fres);
}
`;

// --------------------------------------------------------------------------
// Non-uniform row table in d. Dense at the lip, geometric growth outward.
// --------------------------------------------------------------------------
function buildRows(behind, ahead) {
  const rows = [];
  {
    const tmp = [];
    let d = 0, h = 0.24;
    let guard = 0;
    while (d > -behind && guard++ < 4000) { d -= h; h *= 1.085; tmp.push(d); }
    if (tmp.length) tmp[tmp.length - 1] = -behind;
    tmp.reverse();
    for (let i = 0; i < tmp.length; i++) rows.push(tmp[i]);
  }
  rows.push(0);
  {
    let d = 0, h = 0.11;
    let guard = 0;
    while (d < ahead && guard++ < 4000) {
      d += h; h *= 1.031;
      rows.push(Math.min(d, ahead));
    }
  }
  // The clamp above can leave a sliver row at the far edge — fold it away.
  const n = rows.length;
  if (n > 3 && (rows[n - 1] - rows[n - 2]) < 0.45 * (rows[n - 2] - rows[n - 3])) {
    rows.splice(n - 2, 1);
  }
  return rows;
}

function looseHas(src, name) {
  return new RegExp('\\b' + name + '\\s*\\(').test(src);
}

// --------------------------------------------------------------------------

export class WaveMesh {
  constructor(ctx) {
    ctx = ctx || {};
    const THREE = ctx.THREE;
    this.ctx = ctx;
    this.THREE = THREE;
    this.scene = ctx.scene;
    this.state = ctx.state;
    this.bore = ctx.bore;
    this.config = ctx.config || {};
    this.ok = false;

    if (!THREE || !this.scene) return;   // nothing to hang a mesh on

    const W = this.config.wave || {};
    const L = this.config.look || {};
    const WD = this.config.world || {};
    this.W = W;

    // ---------------------------------------------------------------- sizing
    const riverW = Number.isFinite(WD.riverWidth) ? WD.riverWidth : 340;
    const riverVar = Number.isFinite(WD.riverWidthVar) ? WD.riverWidthVar : 70;
    this.halfW = Math.max(220, (riverW + riverVar) * 0.5 + 90);

    const faceLen = Number.isFinite(W.faceLen) ? W.faceLen : 26;
    const wwDepth = Number.isFinite(W.whitewaterDepth) ? W.whitewaterDepth : 34;
    const trailLen = Number.isFinite(W.trailLen) ? W.trailLen : 21;
    const trailCount = Number.isFinite(W.trailCount) ? W.trailCount : 5;

    // Reach far enough back that the whole trailing roller train lives on this
    // mesh and stays covered even from the aerial camera — the water behind the
    // bore is permanently raised, so any early cut-off shows as a cliff against
    // river.js' flat plane.
    this.behind = Math.max(200, wwDepth * 1.2 + trailLen * trailCount * 0.8);
    this.ahead = faceLen + 70;

    this.rows = buildRows(this.behind, this.ahead);
    this.cols = Math.max(64, Math.round((this.halfW * 2) / 1.3));
    this.colStep = (this.halfW * 2) / this.cols;

    this.curlRows = 34;
    this.curlRadiusBase = Math.max(1.4, (Number.isFinite(W.lipOverhang) ? W.lipOverhang : 2.2) * 1.45);
    this.curlRadius = this.curlRadiusBase;

    // ------------------------------------------------------------- uniforms
    const col = (hex, fb) => new THREE.Color(Number.isFinite(hex) ? hex : fb);
    this.u = {
      uPwTime:       { value: 0 },
      uPwAnchorX:    { value: 0 },
      uPwFaceLen:    { value: faceLen },
      uPwWWDepth:    { value: wwDepth },
      uPwAmp:        { value: Number.isFinite(W.amplitude) ? W.amplitude : 3.1 },
      uPwBarrelThr:  { value: Number.isFinite(W.barrelThreshold) ? W.barrelThreshold : 0.5 },
      uPwLipOverhang: { value: Number.isFinite(W.lipOverhang) ? W.lipOverhang : 2.2 },
      // Only used where bore.js reports no throat — the real size per column
      // comes from pr_tubePocket() in the vertex shader.
      uPwCurlRadius: { value: this.curlRadius },
      // Guaranteed headroom inside the throat. A crouched surfer needs ~1.6 m.
      uPwTubeClear:  { value: 2.45 },
      uPwChurn:      { value: 0.34 },
      uPwDetail:     { value: 0.55 },
      uPwRoughWater: { value: 0.30 },
      uPwRoughFoam:  { value: 0.93 },
      uPwDeep:       { value: col(L.waterDeep, 0x4a2c12) },
      uPwShallow:    { value: col(L.waterShallow, 0x9c6a30) },
      uPwTint:       { value: col(L.waterTint, 0xc08a45) },
      uPwFoam:       { value: col(L.foamColor, 0xe8d6b4) },
      uPwFoamDeep:   { value: col(L.foamDeep, 0xc9ab7e) },
    };

    // ------------------------------------------------- bore GLSL acquisition
    this._prepareBoreGLSL();

    // -------------------------------------------------------------- objects
    this.bodyMat = this._makeMaterial(false);
    this.curlMat = this._makeMaterial(true);
    this.bodyGeo = this._buildBodyGeometry();
    this.curlGeo = this._buildCurlGeometry();

    this.body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    this.curl = new THREE.Mesh(this.curlGeo, this.curlMat);
    for (const m of [this.body, this.curl]) {
      m.frustumCulled = false;       // displaced entirely in the vertex shader
      m.matrixAutoUpdate = false;    // identity model matrix — the shader is world-space
      m.updateMatrix();
      m.castShadow = false;
      m.receiveShadow = false;       // [FASE 2] shadow receive + custom depth material
      this.scene.add(m);
    }
    this.body.name = 'pororoca:waveBody';
    this.curl.name = 'pororoca:waveCurl';
    this.body.renderOrder = 0;
    this.curl.renderOrder = 1;

    this._dt = 1 / 60;
    this.ok = true;
  }

  // ------------------------------------------------------------------ GLSL

  _prepareBoreGLSL() {
    const B = (this.bore && this.bore.constructor && typeof this.bore.constructor.GLSL === 'string')
      ? this.bore.constructor
      : BoreWave;

    let src = (B && typeof B.GLSL === 'string') ? B.GLSL : '';
    let usingFallback = false;

    if (!src || !looseHas(src, 'pr_crest') || !looseHas(src, 'pr_height')) {
      src = fallbackBoreGLSL(this.W);
      usingFallback = true;
    }
    // Fill in whatever bore.js has not published, so a partial neighbour still
    // compiles instead of taking the whole scene down. Shims are emitted after
    // PW_COMMON because some of them read our uniforms.
    let shims = '';
    const shimmed = [];
    for (const [name, code] of SHIMS) {
      if (!looseHas(src, name)) { shims += code; shimmed.push(name); }
    }
    this.shims = shims;
    this.shimmed = shimmed;
    this.usingFallbackWave = usingFallback;

    this.boreGLSLVert = src;
    // Vertex attributes are meaningless in the fragment stage — neutralise any.
    this.boreGLSLFrag = src.replace(/^[ \t]*attribute[ \t][^\n]*$/gm, (m) => '// [waveMesh] ' + m.trim());

    const gu = (B && B.GLSL_UNIFORMS && typeof B.GLSL_UNIFORMS === 'object') ? B.GLSL_UNIFORMS : null;
    this.boreUniforms = (!usingFallback && gu) ? gu : {};
  }

  _header(stage) {
    return (stage === 'fragment' ? this.boreGLSLFrag : this.boreGLSLVert) +
      '\n' + PW_COMMON + '\n' + this.shims + '\n' +
      (stage === 'fragment' ? PW_FRAGMENT_FN : PW_VERTEX_FN) + '\n';
  }

  // -------------------------------------------------------------- material

  _makeMaterial(isCurl) {
    const THREE = this.THREE;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.35,
      metalness: 0.0,
      // A floor of self-lit colour so the water is never a black hole if
      // lighting.js is still mid-flight. Tiny — real light dominates.
      emissive: this.u.uPwDeep.value.clone().multiplyScalar(0.10),
      side: isCurl ? THREE.DoubleSide : THREE.FrontSide,
      // Keep river.js' flat plane from z-fighting where the two overlap.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      dithering: true,
    });
    mat.defines = mat.defines || {};
    if (isCurl) mat.defines.PW_CURL = '';

    const self = this;
    mat.customProgramCacheKey = () => (isCurl ? 'pw_wave_curl' : 'pw_wave_body');

    mat.onBeforeCompile = (shader) => {
      // Merge bore's uniform objects BY REFERENCE so bore.uniforms(t) lands here.
      for (const k in self.boreUniforms) {
        const uo = self.boreUniforms[k];
        if (uo && typeof uo === 'object' && 'value' in uo) shader.uniforms[k] = uo;
      }
      for (const k in self.u) shader.uniforms[k] = self.u[k];

      // ---------------------------------------------------------- vertex
      // Injected after <common> so bore's GLSL can lean on three's helpers.
      shader.vertexShader = injectHeader(shader.vertexShader, self._header('vertex'));
      shader.vertexShader = replaceOnce(
        shader.vertexShader,
        '#include <begin_vertex>',
        isCurl
          ? 'vec3 transformed = pw_curlSurface( position );'
          : 'vec3 transformed = pw_bodySurface( position );',
      );

      // -------------------------------------------------------- fragment
      shader.fragmentShader = injectHeader(shader.fragmentShader, self._header('fragment'));

      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        '#include <map_fragment>',
        `
        {
          float t = uPwTime;
          vec3 P = vPwWorld;
          float d = vPwParams.x;
          float brk = clamp(vPwParams.y, 0.0, 1.0);

          vec3 N = pr_normal(P.x, P.z, t);
          #ifdef PW_CURL
            N = normalize(mix(N, normalize(vPwHintN), smoothstep(0.02, 0.30, vPwParams.w)));
          #endif
          // Cheap micro-relief. [FASE 2] swap for a proper detail/flow normal map.
          float e = 0.75;
          float n0 = pw_noise(vec2(P.x * 0.55, d * 0.55 - t * 0.9));
          float nx = pw_noise(vec2((P.x + e) * 0.55, d * 0.55 - t * 0.9));
          float nz = pw_noise(vec2(P.x * 0.55, (d + e) * 0.55 - t * 0.9));
          N = normalize(N + vec3(-(nx - n0), 0.0, -(nz - n0)) * uPwDetail);
          gPwN = N;

          float breakup;
          float foam = pw_foamMask(P.x, P.z, d, brk, t, breakup);
          #ifdef PW_CURL
            // The curtain is mostly aerated water; the falling tip is pure spray.
            float arc = vPwParams.w;
            foam = clamp(foam + 0.30 + 0.70 * smoothstep(0.25, 0.95, arc)
                              + 0.25 * smoothstep(0.6, 1.0, breakup), 0.0, 1.0);
          #endif
          gPwFoam = foam;

          vec3 water = pw_waterColour(P, N, d);
          vec3 foamCol = mix(uPwFoamDeep, uPwFoam,
                             smoothstep(0.22, 0.92, breakup * 0.55 + foam * 0.65));
          diffuseColor.rgb *= mix(water, foamCol, foam);
        }
        `,
      );

      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = mix( uPwRoughWater, uPwRoughFoam, gPwFoam );',
      );

      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        '#include <normal_fragment_begin>',
        // pr_normal() in the fragment stage: the grid is far too sparse for
        // vertex normals to carry the face. `geometryNormal` is intentionally
        // NOT declared here — <lights_fragment_begin> owns that name.
        `
        float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
        vec3 normal = normalize( ( viewMatrix * vec4( gPwN, 0.0 ) ).xyz );
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
        #endif
        vec3 nonPerturbedNormal = normal;
        `,
      );

      mat.userData.shader = shader;
    };

    return mat;
  }

  // -------------------------------------------------------------- geometry

  _buildBodyGeometry() {
    const THREE = this.THREE;
    const rows = this.rows;
    const cols = this.cols;
    const nx = cols + 1, nz = rows.length;
    const pos = new Float32Array(nx * nz * 3);
    const nrm = new Float32Array(nx * nz * 3);

    let p = 0;
    for (let j = 0; j < nz; j++) {
      const d = rows[j];
      for (let i = 0; i < nx; i++) {
        pos[p] = -this.halfW + i * this.colStep;
        pos[p + 1] = 0;
        pos[p + 2] = d;
        nrm[p] = 0; nrm[p + 1] = 1; nrm[p + 2] = 0;
        p += 3;
      }
    }

    const idx = new Uint32Array(cols * (nz - 1) * 6);
    let k = 0;
    for (let j = 0; j < nz - 1; j++) {
      const r0 = j * nx, r1 = r0 + nx;
      for (let i = 0; i < cols; i++) {
        const a = r0 + i, b = a + 1, c = r1 + i, e = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;   // wound so +Y is the front face
        idx[k++] = b; idx[k++] = c; idx[k++] = e;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e7);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7),
    );
    return g;
  }

  _buildCurlGeometry() {
    const THREE = this.THREE;
    const cols = this.cols;
    const nx = cols + 1, ns = this.curlRows;
    const pos = new Float32Array(nx * ns * 3);
    const nrm = new Float32Array(nx * ns * 3);

    let p = 0;
    for (let j = 0; j < ns; j++) {
      const s = j / (ns - 1);
      for (let i = 0; i < nx; i++) {
        pos[p] = -this.halfW + i * this.colStep;
        pos[p + 1] = 0;
        pos[p + 2] = s;
        nrm[p] = 0; nrm[p + 1] = 1; nrm[p + 2] = 0;
        p += 3;
      }
    }

    const idx = new Uint32Array(cols * (ns - 1) * 6);
    let k = 0;
    for (let j = 0; j < ns - 1; j++) {
      const r0 = j * nx, r1 = r0 + nx;
      for (let i = 0; i < cols; i++) {
        const a = r0 + i, b = a + 1, c = r1 + i, e = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = e;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e7);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7),
    );
    return g;
  }

  // ------------------------------------------------------------------ loop

  step(dt) {
    if (!this.ok) return;
    const d = (Number.isFinite(dt) && dt > 0) ? Math.min(dt, 0.25) : 1 / 60;
    this._dt = d;

    const st = this.state;
    const t = (st && Number.isFinite(st.time)) ? st.time : 0;

    // Keep bore's own shared uniforms current. Idempotent — safe if another
    // renderer module already did it this frame.
    if (this.bore && typeof this.bore.uniforms === 'function') {
      try { this.bore.uniforms(t); } catch (e) { /* neighbour not ready */ }
    }

    this.u.uPwTime.value = t;

    // Follow the player laterally in whole cells: every vertex keeps landing on
    // the same world-x samples, so nothing shimmers or pops as the mesh slides.
    const px = (st && st.player && Number.isFinite(st.player.x)) ? st.player.x : 0;
    this.u.uPwAnchorX.value = Math.round(px / this.colStep) * this.colStep;
  }

  // --------------------------------------------------------------- teardown

  dispose() {
    if (!this.THREE) return;
    for (const m of [this.body, this.curl]) {
      if (!m) continue;
      if (m.parent) m.parent.remove(m);
    }
    if (this.bodyGeo) this.bodyGeo.dispose();
    if (this.curlGeo) this.curlGeo.dispose();
    if (this.bodyMat) { this.bodyMat.userData.shader = null; this.bodyMat.dispose(); }
    if (this.curlMat) { this.curlMat.userData.shader = null; this.curlMat.dispose(); }
    this.body = this.curl = null;
    this.bodyGeo = this.curlGeo = null;
    this.bodyMat = this.curlMat = null;
    this.ok = false;
  }

  // Diagnostics for the integrator / tools. Not used in the frame path.
  stats() {
    const bodyTris = this.cols * (this.rows.length - 1) * 2;
    const curlTris = this.cols * (this.curlRows - 1) * 2;
    return {
      drawCalls: 2,
      triangles: bodyTris + curlTris,
      bodyTris, curlTris,
      cols: this.cols, colStep: this.colStep,
      rows: this.rows.length, halfWidth: this.halfW,
      dRange: [-this.behind, this.ahead],
      usingFallbackWave: !!this.usingFallbackWave,
      shimmed: this.shimmed || [],
    };
  }
}

// Replace a three.js chunk token exactly once. If the token has moved in a
// future revision we leave the shader untouched rather than corrupt it.
function replaceOnce(src, token, code) {
  const at = src.indexOf(token);
  if (at < 0) return src;
  return src.slice(0, at) + code + src.slice(at + token.length);
}

// Drop our declarations straight after <common> so bore's GLSL can use three's
// helpers (PI, saturate, pow2...). Falls back to prepending.
function injectHeader(src, header) {
  const tok = '#include <common>';
  const at = src.indexOf(tok);
  if (at < 0) return header + '\n' + src;
  const end = at + tok.length;
  return src.slice(0, end) + '\n' + header + '\n' + src.slice(end);
}
