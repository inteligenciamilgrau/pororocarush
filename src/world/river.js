// POROROCA RUSH — src/world/river.js
//
// The Amazon channel. Three responsibilities:
//
//   1. COURSE MATHS — an analytic, deterministic description of the river:
//      `centerX(z)`, `widthAt(z)`, `bankY(x, z)`, `tangent(z)`. Pure functions of
//      world coordinates, no stored spline, identical forever for a given seed.
//      `scenery.js` and `obstacles.js` read these to place their content.
//
//   2. THE WATER SHEET — one muddy surface running from ~2.2 km behind the bore
//      out to the horizon ahead. It is authored in *wave-relative* space (rows at
//      fixed `d = z - crest(x,t)`) and displaced with `bore.height()`, so it joins
//      `waveMesh.js` without a seam by construction. Inside the band that
//      `waveMesh` owns it is pushed a few decimetres down so the detailed wave
//      always wins the depth test — no z-fighting, no poke-through.
//      It also carries the sun glitter path, the loudest element of the concept art.
//
//   3. THE BANKS — streamed slabs of mud bluff / silt beach terrain in three LOD
//      tiers, recycled on a fixed world lattice (so recycling never pops and is
//      independent of how the simulation got to time t).
//
// Phase 1 scope: correct silhouette, scale and colour. Texture/detail hooks for
// phase 2 are marked `PHASE2:`.

import * as THREE_NS from 'three';
import { CONFIG, TAU } from '../config.js';
import { fbm2 } from '../core/rng.js';

// ---------------------------------------------------------------- small maths
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

// Shape constants that belong to this module (not gameplay tunables).
const SHAPE = {
  bedDepth: 6.6,          // metres below datum at the thalweg
  beachRun: 44,           // horizontal run to reach bankHeight on a silt beach
  bluffRun: 10,           // ... on a cut mud bluff
  inlandRise: 460,        // metres over which the ground keeps climbing inland
  corridorHalf: 80,       // guaranteed-navigable half corridor around x = 0
  bankWobble: 8,          // organic in/out wander of each waterline, metres
};

// Water sheet layout (wave-relative).
const WATER = {
  band: 72,               // |d| covered at fine, uniform row spacing
  bandStep: 8,
  behindEnd: -2200,
  aheadEnd: 3300,
  behindStep0: 7.0, behindGrow: 1.22,
  aheadStep0: 6.5, aheadGrow: 1.165,
  colInner: 260, colOuter: 470, colsInner: 19, colsWing: 7,
  sampleD: 700,           // beyond this |d| the bore contribution is frozen
                          // (700 m is well past any swell train the bore can carry;
                          //  the frozen band is also fully fogged out)
  sinkDepth: 0.5,         // how far the sheet ducks under waveMesh's band
};

// Bank LOD tiers. `start` is relative to the bore reference Z.
const TIERS = [
  { key: 'near',   slabLen: 96,  count: 14, rows: 12, cols: 22, inner: 70, outer: 1050, start: -576,  shadow: true },
  { key: 'ahead',  slabLen: 288, count: 10, rows: 8,  cols: 15, inner: 80, outer: 1700, start: 768,   shadow: false },
  { key: 'behind', slabLen: 288, count: 6,  rows: 8,  cols: 15, inner: 80, outer: 1700, start: -2304, shadow: false },
];

// --------------------------------------------------------------- shared GLSL
const GLSL_NOISE = /* glsl */`
float pr_h21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float pr_vnz(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pr_h21(i), pr_h21(i + vec2(1.0, 0.0)), u.x),
             mix(pr_h21(i + vec2(0.0, 1.0)), pr_h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// ============================================================================
export class River {
  constructor(ctx = {}) {
    const THREE = ctx.THREE || THREE_NS;
    this.THREE = THREE;
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.state = ctx.state || null;
    this.bore = ctx.bore || null;
    this.config = ctx.config || CONFIG;

    const W = (this.config.world) || CONFIG.world;
    const look = (this.config.look) || CONFIG.look;
    this.W = W;
    this.look = look;
    this.seed = (this.config.seed | 0) || 1;
    this.bankHeight = W.bankHeight;

    // ------------------------------------------------------------ course maths
    // Meander: three harmonics, analytic so `tangent()` is exact.
    //
    // NOTE (reported to the integrator): CONFIG.world.riverMeander = 210 m with a
    // 1500 m wavelength would swing the channel axis further sideways than half the
    // river is wide, which would beach the surfer (physics keeps the player near
    // x = 0, it has no notion of the channel). The amplitude is therefore capped so
    // that the corridor |x| <= SHAPE.corridorHalf is *always* open water.
    const halfMin = (W.riverWidth - W.riverWidthVar) * 0.5;
    this.corridorHalf = SHAPE.corridorHalf;
    this.meanderAmp = Math.min(
      W.riverMeander,
      Math.max(0, halfMin - SHAPE.corridorHalf - SHAPE.bankWobble - 5),
    );
    const kM = TAU / Math.max(120, W.riverMeanderLen);
    this.mA = [0.58 * this.meanderAmp, 0.27 * this.meanderAmp, 0.15 * this.meanderAmp];
    this.mK = [0.50 * kM, 1.00 * kM, 1.93 * kM];
    this.mP = [0.0, 2.31, 4.77];

    // Width: two slow harmonics, kept analytic so the water shader can mirror it.
    this.widthBase = W.riverWidth;
    this.wA = [0.62 * W.riverWidthVar * 0.5, 0.38 * W.riverWidthVar * 0.5];
    this.wK = [TAU / 980, TAU / 2350];
    this.wP = [1.13, 3.87];

    // ------------------------------------------------------------ bore probing
    this._boreOK = false;
    try {
      const b = this.bore;
      if (b && typeof b.height === 'function' && typeof b.crest === 'function') {
        const h = b.height(0, 0, 0), c = b.crest(0, 0);
        if (Number.isFinite(h) && Number.isFinite(c)) this._boreOK = true;
      }
    } catch (e) { this._boreOK = false; }

    // ------------------------------------------------------------------ scene
    this.group = new THREE.Group();
    this.group.name = 'river';
    this.group.matrixAutoUpdate = false;
    if (this.scene) this.scene.add(this.group);

    this._fogKey = -1;
    this._sunDir = this._computeSunDir(THREE, look);

    this._buildWaterMaterial(THREE, look);
    this._buildWater(THREE);
    this._buildBankMaterial(THREE, look);
    this._buildBanks(THREE);

    // Publish for scenery.js / obstacles.js.
    ctx.river = this;

    // First fill so the very first rendered frame is already correct.
    this.step(0);
  }

  // ==========================================================================
  // COURSE GEOMETRY — pure, deterministic, allocation free.
  // ==========================================================================

  /** Lateral offset of the river axis at world z. */
  centerX(z) {
    const A = this.mA, K = this.mK, P = this.mP;
    return A[0] * Math.sin(K[0] * z + P[0])
         + A[1] * Math.sin(K[1] * z + P[1])
         + A[2] * Math.sin(K[2] * z + P[2]);
  }

  /** d(centerX)/dz — exact. */
  centerSlope(z) {
    const A = this.mA, K = this.mK, P = this.mP;
    return A[0] * K[0] * Math.cos(K[0] * z + P[0])
         + A[1] * K[1] * Math.cos(K[1] * z + P[1])
         + A[2] * K[2] * Math.cos(K[2] * z + P[2]);
  }

  /** Bank-to-bank width of the channel at world z, metres. */
  widthAt(z) {
    const A = this.wA, K = this.wK, P = this.wP;
    return this.widthBase
         + A[0] * Math.sin(K[0] * z + P[0])
         + A[1] * Math.sin(K[1] * z + P[1]);
  }

  halfWidth(z) { return this.widthAt(z) * 0.5; }

  /**
   * Unit tangent of the river axis at z.
   * Returns `{ x, y, z, angle }` where `y === z` (the along-river component), so
   * it reads correctly whether the caller expects a Vector2-ish or a Vector3-ish.
   * Pass `out` (Vector2 / Vector3 / plain object) to avoid the allocation.
   */
  tangent(z, out) {
    const m = this.centerSlope(z);
    const inv = 1 / Math.sqrt(m * m + 1);
    const tx = m * inv, tz = inv;
    if (out) {
      out.x = tx;
      if (out.isVector3) { out.y = 0; out.z = tz; }
      else { out.y = tz; if ('z' in out) out.z = tz; }
      return out;
    }
    return { x: tx, y: tz, z: tz, angle: Math.atan2(tx, tz) };
  }

  /** Organic in/out wander of one waterline (side = -1 left, +1 right). */
  bankWobble(z, side) {
    return (fbm2(z * 0.0032, side * 9.1 + 3.3, 3, this.seed + 5) - 0.5) * 2 * SHAPE.bankWobble;
  }

  /** 0 = flat silt beach, 1 = steep cut mud bluff. */
  bankSteepness(z, side) {
    return smoothstep(0.40, 0.70, fbm2(z * 0.0026, side * 17.7 + 41.2, 3, this.seed + 23));
  }

  /** World x of the waterline on `side` (-1 left, +1 right) at z. */
  bankX(z, side) {
    const s = side < 0 ? -1 : 1;
    return this.centerX(z) + s * (this.halfWidth(z) + this.bankWobble(z, s));
  }

  /**
   * Terrain height at world (x, z). Negative under the channel (river bed),
   * 0 exactly at the waterline, climbing to `CONFIG.world.bankHeight` and beyond
   * inland. Continuous everywhere.
   */
  bankY(x, z) {
    const c = this.centerX(z);
    const dx = x - c;
    const side = dx >= 0 ? 1 : -1;
    const hw = this.halfWidth(z) + this.bankWobble(z, side);
    const s = dx < 0 ? -dx : dx;

    if (s < hw) {
      // Submerged: soft channel with a slow, drifting bed. The profile is linear
      // in (1 - u^2) at the edge so the bed slope stays finite at the waterline —
      // no infinitely steep lip where the terrain meets the water.
      const u = s / hw;
      const shelf = 1 - u * u;
      return -SHAPE.bedDepth * shelf * (0.42 + 0.58 * shelf)
           + (fbm2(x * 0.011, z * 0.011, 2, this.seed + 3) - 0.5) * 1.6 * shelf * shelf;
    }

    const t = s - hw;                       // metres inland from the waterline
    const steep = this.bankSteepness(z, side);
    const run = lerp(SHAPE.beachRun, SHAPE.bluffRun, steep);
    const p = clamp(t / run, 0, 1);
    const sm = p * p * (3 - 2 * p);

    let y = this.bankHeight * Math.pow(sm, lerp(1.15, 0.5, steep));
    // The land keeps rising gently — gives the jungle a silhouette to sit on.
    y += this.bankHeight * 0.85 * smoothstep(0, SHAPE.inlandRise, t);
    // Rolling ground.
    y += (fbm2(x * 0.0062, z * 0.0062, 4, this.seed + 91) - 0.5) * 5.4 * smoothstep(0, 34, t);
    // Cut-bank gnarl: undercut mud and exposed roots right above the water.
    // PHASE2: replace with real root/overhang geometry + a mud normal map.
    y += (fbm2(x * 0.085, z * 0.055, 2, this.seed + 41) - 0.5) * 0.9
       * steep * Math.exp(-t / 16) * smoothstep(0, 5, t);
    return y;
  }

  /** True when (x, z) is inside the channel (i.e. over water). */
  isWater(x, z) {
    const dx = x - this.centerX(z);
    const side = dx >= 0 ? 1 : -1;
    return Math.abs(dx) < this.halfWidth(z) + this.bankWobble(z, side);
  }

  /** Still-water depth at (x, z), 0 on land. */
  depthAt(x, z) {
    const y = this.bankY(x, z);
    return y < 0 ? -y : 0;
  }

  /** Water surface height — bore-aware, falls back to the datum. */
  waterY(x, z, t) {
    if (!this._boreOK) return 0;
    try {
      const y = this.bore.height(x, z, t === undefined ? (this.state ? this.state.time : 0) : t);
      return Number.isFinite(y) ? y : 0;
    } catch (e) { this._boreOK = false; return 0; }
  }

  /** Helper for neighbours that want to keep something inside the channel. */
  clampToChannel(x, z, margin = 6) {
    const c = this.centerX(z);
    const hw = Math.max(4, this.halfWidth(z) - margin);
    const dx = clamp(x - c, -hw, hw);
    return c + dx;
  }

  // ==========================================================================
  // WATER SHEET
  // ==========================================================================

  _computeSunDir(THREE, look) {
    const el = look.sunElevation || 0.05;
    const az = look.sunAzimuth || 0;
    return new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    ).normalize();
  }

  _buildWaterMaterial(THREE, look) {
    const C = (hex) => new THREE.Color(hex);

    const own = {
      uTime:    { value: 0 },
      uCrestZ:  { value: 0 },
      uSunDir:  { value: this._sunDir.clone() },
      uSunCol:  { value: C(look.sunColor) },
      uDeep:    { value: C(look.waterDeep) },
      uShallow: { value: C(look.waterShallow) },
      uTint:    { value: C(look.waterTint) },
      uHaze:    { value: C(look.fogColor) },
      uGloss:   { value: 950.0 },
      uSpec:    { value: 5.0 },
      uRipple:  { value: 1.05 },
      uMeanA:   { value: new THREE.Vector3(this.mA[0], this.mA[1], this.mA[2]) },
      uMeanK:   { value: new THREE.Vector3(this.mK[0], this.mK[1], this.mK[2]) },
      uMeanP:   { value: new THREE.Vector3(this.mP[0], this.mP[1], this.mP[2]) },
      uWidA:    { value: new THREE.Vector3(this.wA[0], this.wA[1], this.widthBase) },
      uWidK:    { value: new THREE.Vector3(this.wK[0], this.wK[1], 0) },
      uWidP:    { value: new THREE.Vector3(this.wP[0], this.wP[1], 0) },
    };

    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]);
    Object.assign(uniforms, own);

    const vert = /* glsl */`
      varying vec3 vWorld;
      varying vec3 vNrm;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vWorld = wp.xyz;
        vNrm = normalize( mat3( modelMatrix ) * normal );
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `;

    const frag = /* glsl */`
      uniform float uTime;
      uniform float uCrestZ;
      uniform vec3  uSunDir;
      uniform vec3  uSunCol;
      uniform vec3  uDeep;
      uniform vec3  uShallow;
      uniform vec3  uTint;
      uniform vec3  uHaze;
      uniform float uGloss;
      uniform float uSpec;
      uniform float uRipple;
      uniform vec3  uMeanA, uMeanK, uMeanP;
      uniform vec3  uWidA, uWidK, uWidP;
      varying vec3 vWorld;
      varying vec3 vNrm;
      #include <common>
      #include <fog_pars_fragment>
      // NOTE: tonemapping_pars_fragment / colorspace_pars_fragment are already
      // emitted by WebGLProgram's prefix — including them here would redefine
      // toneMapping()/*TransferOETF() and fail to compile.
      ${GLSL_NOISE}

      float rvCenter( float z ) {
        return uMeanA.x * sin( uMeanK.x * z + uMeanP.x )
             + uMeanA.y * sin( uMeanK.y * z + uMeanP.y )
             + uMeanA.z * sin( uMeanK.z * z + uMeanP.z );
      }
      float rvHalf( float z ) {
        return 0.5 * ( uWidA.z + uWidA.x * sin( uWidK.x * z + uWidP.x )
                              + uWidA.y * sin( uWidK.y * z + uWidP.y ) );
      }

      // Per-layer band limit: kill any wavelet finer than the on-screen footprint,
      // otherwise the glitter turns into crawling moiré at grazing angles.
      float rvAtt( float f, float foot ) {
        float q = foot * f;
        return 1.0 / ( 1.0 + q * q * 2.6 );
      }

      // Multi-scale ripple gradient. A slow noise domain-warp decorrelates the
      // wavelets so they never read as corduroy.
      vec2 rvRipple( vec2 p, float t, float foot ) {
        float w1 = pr_vnz( p * 0.013 + vec2( 0.0, t * 0.017 ) );
        float w2 = pr_vnz( p * 0.047 + vec2( t * 0.021, 0.0 ) );
        float warp = ( w1 - 0.5 ) * 9.0 + ( w2 - 0.5 ) * 3.4;
        vec2 g = vec2( 0.0 );
        vec2 d; float f, a;
        d = vec2( 0.87,  0.49 ); f = 0.41; a = 0.052;  g += a * f * rvAtt( f, foot ) * cos( dot( p, d ) * f + warp * 0.9 + t * 1.05 ) * d;
        d = vec2(-0.34,  0.94 ); f = 0.79; a = 0.040;  g += a * f * rvAtt( f, foot ) * cos( dot( p, d ) * f - warp * 1.3 - t * 1.55 ) * d;
        d = vec2( 0.99, -0.14 ); f = 1.47; a = 0.030;  g += a * f * rvAtt( f, foot ) * cos( dot( p, d ) * f + warp * 1.8 + t * 2.10 ) * d;
        d = vec2(-0.79, -0.61 ); f = 2.63; a = 0.021;  g += a * f * rvAtt( f, foot ) * cos( dot( p, d ) * f - warp * 2.6 + t * 2.85 ) * d;
        d = vec2( 0.51, -0.86 ); f = 4.90; a = 0.014;  g += a * f * rvAtt( f, foot ) * cos( dot( p, d ) * f + warp * 3.9 - t * 3.80 ) * d;
        d = vec2(-0.10,  0.99 ); f = 9.30; a = 0.0072; g += a * f * rvAtt( f, foot ) * cos( dot( p, d ) * f - warp * 6.1 + t * 5.20 ) * d;
        return g;
      }

      void main() {
        vec3  toCam = cameraPosition - vWorld;
        float dist  = length( toCam );
        vec3  V     = toCam / max( dist, 1e-4 );
        vec3  L     = uSunDir;

        // World-space size of one pixel on this surface. Grows without bound at
        // grazing angles — which is exactly where naive ripple normals fall apart.
        float graze = max( dot( vNrm, V ), 0.025 );
        float foot  = dist * 0.0017 / graze;
        float keep  = 1.0 / ( 1.0 + foot * 0.5 );   // 1 = ripples resolved, 0 = mirror

        vec2 g = rvRipple( vWorld.xz, uTime, foot ) * uRipple;
        vec3 n = normalize( vNrm + vec3( -g.x, 0.0, -g.y ) );

        // --- body: opaque silt. Lighter over the shallow shelves near the banks.
        float u = clamp( abs( vWorld.x - rvCenter( vWorld.z ) ) / max( rvHalf( vWorld.z ), 1.0 ), 0.0, 1.6 );
        vec3 base = mix( uDeep, uShallow, smoothstep( 0.34, 1.04, u ) );
        // Silt streaks dragged along the channel.
        float streak = pr_vnz( vec2( vWorld.x * 0.035, vWorld.z * 0.0055 ) + vec2( 0.0, uTime * 0.02 ) );
        base *= 0.86 + 0.30 * streak;
        // The water behind the front carries stirred-up sediment.
        float behind = 1.0 - smoothstep( uCrestZ - 90.0, uCrestZ + 6.0, vWorld.z );
        base = mix( base, uTint, behind * 0.35 );

        // --- shading: mostly ambient bounce plus a warm low-sun wash.
        float ndl = max( dot( n, L ), 0.0 );
        vec3 col = base * ( 0.34 + 1.55 * ndl );

        // Broad brightening when looking up-sun (cheap stand-in for the sky reflection).
        vec3  Vh    = normalize( vec3( -V.x, 0.0, -V.z ) + vec3( 1e-5 ) );
        float align = max( dot( Vh, normalize( vec3( L.x, 0.0, L.z ) + vec3( 1e-5 ) ) ), 0.0 );
        col += uHaze * pow( align, 4.0 ) * 0.20;

        // Grazing haze reflection: the far water melts into the sunset.
        float fres = pow( 1.0 - clamp( dot( n, V ), 0.0, 1.0 ), 4.0 );
        col = mix( col, uHaze * 1.25, clamp( fres * 0.9, 0.0, 0.82 ) );

        // ---------------------------------------------------- SUN GLITTER PATH
        // As the ripple detail is filtered away by distance the lobe is widened by
        // the same amount, so the sun road keeps its energy all the way to the
        // horizon instead of dissolving into a flat mirror.
        vec3  H  = normalize( L + V );
        float nh = 1.0 - clamp( dot( n, H ), 0.0, 1.0 );
        float glossE = mix( uGloss * 0.012, uGloss, keep );
        float sharp  = exp( -nh * glossE );             // shattered gold sparkles
        float road   = exp( -nh * uGloss * 0.030 );     // the broad sun road
        float sfreq  = mix( 0.10, 0.9, keep );
        float sparkle = mix( 1.0, 0.45 + 0.95 * pr_vnz( vWorld.xz * sfreq + vec2( uTime * 0.31, -uTime * 0.19 ) ), keep );
        col += uSunCol * ( sharp * sparkle * uSpec + road * uSpec * 0.20 );

        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `;

    this.waterMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      fog: true,
      lights: false,
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
      // Belt and braces against co-planar fighting with waveMesh.
      polygonOffset: true,
      polygonOffsetFactor: 1.0,
      polygonOffsetUnits: 1.0,
    });
    this.waterMat.name = 'riverWater';
  }

  _waterColumns() {
    const out = [];
    const { colInner, colOuter, colsInner, colsWing } = WATER;
    for (let i = -colsInner; i <= colsInner; i++) out.push((i * colInner) / colsInner);
    for (let i = 1; i <= colsWing; i++) {
      const q = i / colsWing;
      const s = colInner + (colOuter - colInner) * q * q;
      out.push(s); out.push(-s);
    }
    out.sort((a, b) => a - b);
    return Float64Array.from(out);
  }

  _waterRows() {
    const rows = [];
    const B = WATER.band;
    for (let d = -B; d <= B + 1e-6; d += WATER.bandStep) rows.push(d);
    let d = -B, s = WATER.behindStep0;
    while (d > WATER.behindEnd) { d -= s; s *= WATER.behindGrow; rows.push(d); }
    d = B; s = WATER.aheadStep0;
    while (d < WATER.aheadEnd) { d += s; s *= WATER.aheadGrow; rows.push(d); }
    rows.sort((a, b) => a - b);
    return Float64Array.from(rows);
  }

  _buildWater(THREE) {
    this.wCols = this._waterColumns();
    this.wRows = this._waterRows();
    const nc = this.wCols.length, nr = this.wRows.length;
    const n = nc * nr;

    this.wPos = new Float32Array(n * 3);
    this.wNrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.wNrm[i * 3 + 1] = 1;

    const idx = new Uint32Array((nr - 1) * (nc - 1) * 6);
    let o = 0;
    for (let r = 0; r < nr - 1; r++) {
      for (let c = 0; c < nc - 1; c++) {
        const a = r * nc + c, b = (r + 1) * nc + c, cc = r * nc + c + 1, dd = (r + 1) * nc + c + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = cc;
        idx[o++] = b; idx[o++] = dd; idx[o++] = cc;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.wPos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.wNrm, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.waterGeo = geo;
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.name = 'riverWater';
    this.water.frustumCulled = false;   // it is always around the camera
    this.water.renderOrder = -1;        // draw before the wave: cheap early-z
    this.water.matrixAutoUpdate = false;
    this.water.updateMatrix();
    this.group.add(this.water);

    // Scratch buffers reused every frame (no per-frame allocation).
    this._crestZ = new Float64Array(nc);
    this._farAhead = new Float64Array(nc);
    this._farBehind = new Float64Array(nc);
  }

  _crestAt(x, t) {
    if (!this._boreOK) return this.state ? this.state.bore.z : 0;
    const c = this.bore.crest(x, t);
    return Number.isFinite(c) ? c : (this.state ? this.state.bore.z : 0);
  }

  _sampleBore(x, z, t) {
    const y = this.bore.height(x, z, t);
    return Number.isFinite(y) ? y : 0;
  }

  /**
   * How far to duck below the true surface. Only non-zero inside the band that
   * waveMesh draws, so the open water ahead and behind stays exact.
   */
  _sink(d) {
    const wv = (this.config.wave) || CONFIG.wave;
    const face = wv.faceLen, ww = wv.whitewaterDepth;
    const m = d >= 0
      ? 1 - smoothstep(face * 0.78, face * 1.18, d)
      : 1 - smoothstep(ww * 0.85, ww * 1.28, -d);
    return -WATER.sinkDepth * m;
  }

  _updateWater(t, refZ) {
    const cols = this.wCols, rows = this.wRows;
    const nc = cols.length, nr = rows.length;
    const pos = this.wPos, nrm = this.wNrm;
    const crestZ = this._crestZ, farA = this._farAhead, farB = this._farBehind;
    const useBore = this._boreOK;
    const axis0 = this.centerX(refZ);

    try {
      const cxA = this.centerX(refZ + WATER.sampleD);
      const cxB = this.centerX(refZ - WATER.sampleD);
      for (let j = 0; j < nc; j++) {
        const x = axis0 + cols[j];
        crestZ[j] = useBore ? this._crestAt(x, t) : refZ;
        if (useBore) {
          farA[j] = this._sampleBore(cxA + cols[j], crestZ[j] + WATER.sampleD, t);
          farB[j] = this._sampleBore(cxB + cols[j], crestZ[j] - WATER.sampleD, t);
        } else { farA[j] = 0; farB[j] = 0; }
      }

      const SD = WATER.sampleD;
      for (let r = 0; r < nr; r++) {
        const d = rows[r];
        const near = d <= SD && d >= -SD;
        const sink = this._sink(d);
        const cx = this.centerX(refZ + d);
        const base = r * nc * 3;
        for (let j = 0; j < nc; j++) {
          const x = cx + cols[j];
          const z = crestZ[j] + d;
          let y;
          if (!useBore) y = 0;
          else if (near) y = this._sampleBore(x, z, t);
          else y = d > 0 ? farA[j] : farB[j];
          const o = base + j * 3;
          pos[o] = x; pos[o + 1] = y + sink; pos[o + 2] = z;
        }
      }
    } catch (e) {
      // A neighbour blew up mid-frame: fall back to a flat datum sheet forever.
      this._boreOK = false;
      for (let r = 0; r < nr; r++) {
        const d = rows[r];
        const cx = this.centerX(refZ + d);
        const base = r * nc * 3;
        for (let j = 0; j < nc; j++) {
          const o = base + j * 3;
          pos[o] = cx + cols[j]; pos[o + 1] = 0; pos[o + 2] = refZ + d;
        }
      }
    }

    // Normals straight off the grid — no extra field evaluations.
    for (let r = 0; r < nr; r++) {
      const rm = r > 0 ? r - 1 : r, rp = r < nr - 1 ? r + 1 : r;
      for (let j = 0; j < nc; j++) {
        const jm = j > 0 ? j - 1 : j, jp = j < nc - 1 ? j + 1 : j;
        const a = (r * nc + jm) * 3, b = (r * nc + jp) * 3;
        const c = (rm * nc + j) * 3, e = (rp * nc + j) * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[e] - pos[c], vy = pos[e + 1] - pos[c + 1], vz = pos[e + 2] - pos[c + 2];
        let nx = vy * uz - vz * uy;
        let ny = vz * ux - vx * uz;
        let nz = vx * uy - vy * ux;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const o = (r * nc + j) * 3;
        if (len > 1e-6) { nrm[o] = nx / len; nrm[o + 1] = ny / len; nrm[o + 2] = nz / len; }
        else { nrm[o] = 0; nrm[o + 1] = 1; nrm[o + 2] = 0; }
      }
    }

    this.waterGeo.attributes.position.needsUpdate = true;
    this.waterGeo.attributes.normal.needsUpdate = true;
  }

  // ==========================================================================
  // BANKS
  // ==========================================================================

  _buildBankMaterial(THREE, look) {
    const C = (hex) => new THREE.Color(hex);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.97,
      metalness: 0.0,
      flatShading: false,
      fog: true,
      dithering: true,
    });
    mat.name = 'riverBank';

    this.bankUniforms = {
      uCrestZ:  { value: 0 },
      uSurge:   { value: 1.7 },   // how much higher the bank is wetted behind the bore
      uWetMud:  { value: C(0x2e1c0d) },
      uSilt:    { value: C(0xa9793f) },
      uFloor:   { value: C(0x243018) },
      uJungle:  { value: C(look.jungleDark) },
    };

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.bankUniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRiverWP;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vRiverWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vRiverWP;
          uniform float uCrestZ;
          uniform float uSurge;
          uniform vec3 uWetMud;
          uniform vec3 uSilt;
          uniform vec3 uFloor;
          uniform vec3 uJungle;
          ${GLSL_NOISE}
        `)
        .replace('#include <map_fragment>', `
          // Wet line: the bore leaves the bank soaked behind the front.
          float rvBehind = 1.0 - smoothstep( uCrestZ - 34.0, uCrestZ + 4.0, vRiverWP.z );
          float rvH  = vRiverWP.y - uSurge * rvBehind;
          float rvWet = 1.0 - smoothstep( -0.15, 1.35, rvH );
          float rvUp  = smoothstep( 1.2, 6.0, vRiverWP.y );
          float rvMot = pr_vnz( vRiverWP.xz * 0.17 ) * 0.55 + pr_vnz( vRiverWP.xz * 0.031 ) * 0.45;
          vec3 rvCol = mix( uSilt, uWetMud, rvWet );
          rvCol = mix( rvCol, mix( uFloor, uJungle, rvUp ), rvUp );
          rvCol *= 0.78 + 0.44 * rvMot;
          // Bright silt rim right on the waterline.
          rvCol += uSilt * 0.22 * exp( -abs( rvH - 0.2 ) * 2.2 ) * ( 1.0 - rvUp );
          diffuseColor.rgb = rvCol;
          // PHASE2: mud/root/leaf-litter detail maps and a triplanar normal go here.
        `);
    };
    // Distinct cache key so the injected variant never collides with a plain
    // MeshStandardMaterial compiled elsewhere.
    mat.customProgramCacheKey = () => 'river-bank-v1';

    this.bankMat = mat;
  }

  _bankColumns(n, inner, outer) {
    const out = [];
    const nIn = Math.max(3, Math.round(n * 0.28));
    for (let i = 0; i < nIn; i++) {
      const q = i / nIn;
      out.push(-inner * Math.pow(1 - q, 2.0));
    }
    out.push(0);
    const nOut = n - nIn - 1;
    for (let i = 1; i <= nOut; i++) out.push(outer * Math.pow(i / nOut, 2.6));
    return Float64Array.from(out);
  }

  _buildBanks(THREE) {
    this.tiers = [];
    for (const T of TIERS) {
      const cols = this._bankColumns(T.cols, T.inner, T.outer);
      const nc = cols.length, nr = T.rows + 1;
      const tier = { def: T, cols, nc, nr, span: T.slabLen * T.count, slabs: [] };

      // One index buffer per winding (left bank mirrors the winding).
      const mkIndex = (flip) => {
        const idx = new Uint32Array(T.rows * (nc - 1) * 6);
        let o = 0;
        for (let r = 0; r < T.rows; r++) {
          for (let c = 0; c < nc - 1; c++) {
            const a = r * nc + c, b = (r + 1) * nc + c, cc = r * nc + c + 1, dd = (r + 1) * nc + c + 1;
            if (flip) { idx[o++] = a; idx[o++] = cc; idx[o++] = b; idx[o++] = b; idx[o++] = cc; idx[o++] = dd; }
            else { idx[o++] = a; idx[o++] = b; idx[o++] = cc; idx[o++] = b; idx[o++] = dd; idx[o++] = cc; }
          }
        }
        return idx;
      };
      const idxR = mkIndex(false), idxL = mkIndex(true);

      for (const side of [-1, 1]) {
        for (let i = 0; i < T.count; i++) {
          const pos = new Float32Array(nc * nr * 3);
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nc * nr * 3), 3));
          geo.setIndex(new THREE.BufferAttribute(side < 0 ? idxL.slice() : idxR.slice(), 1));
          const mesh = new THREE.Mesh(geo, this.bankMat);
          mesh.name = `bank_${T.key}_${side < 0 ? 'L' : 'R'}_${i}`;
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          mesh.receiveShadow = !!T.shadow;
          mesh.castShadow = false;    // PHASE2: long sunset shadows off the bluffs
          this.group.add(mesh);
          tier.slabs.push({ side, z0: T.start + i * T.slabLen, mesh, geo, pos, dirty: true });
        }
      }
      this.tiers.push(tier);
    }
  }

  _fillSlab(tier, slab) {
    const T = tier.def;
    const cols = tier.cols, nc = tier.nc, nr = tier.nr;
    const pos = slab.pos;
    const side = slab.side;
    const step = T.slabLen / T.rows;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let r = 0; r < nr; r++) {
      const z = slab.z0 + r * step;
      const cx = this.centerX(z);
      const hw = this.halfWidth(z) + this.bankWobble(z, side);
      const base = r * nc * 3;
      for (let c = 0; c < nc; c++) {
        const x = cx + side * (hw + cols[c]);
        const y = this.bankY(x, z);
        const o = base + c * 3;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }

    slab.geo.attributes.position.needsUpdate = true;
    slab.geo.computeVertexNormals();
    // Cheap, generous bounding sphere so frustum culling still works.
    const cxm = (minX + maxX) * 0.5, cym = (minY + maxY) * 0.5, czm = slab.z0 + T.slabLen * 0.5;
    const rad = 0.5 * Math.sqrt(
      (maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY) + T.slabLen * T.slabLen,
    ) + 1;
    if (!slab.geo.boundingSphere) slab.geo.boundingSphere = new this.THREE.Sphere();
    slab.geo.boundingSphere.center.set(cxm, cym, czm);
    slab.geo.boundingSphere.radius = rad;
    slab.dirty = false;
  }

  _updateBanks(refZ) {
    for (const tier of this.tiers) {
      const base = refZ + tier.def.start;
      const span = tier.span;
      for (const slab of tier.slabs) {
        // Snap onto the fixed world lattice — history independent, so a capture
        // seek lands on exactly the same tiling as a continuous run.
        const n = Math.ceil((base - slab.z0) / span - 1e-9);
        if (n !== 0) { slab.z0 += n * span; slab.dirty = true; }
        if (slab.dirty) this._fillSlab(tier, slab);
      }
    }
  }

  // ==========================================================================
  // FRAME
  // ==========================================================================

  _refZ() {
    const st = this.state;
    if (!st) return 0;
    const bz = Number.isFinite(st.bore && st.bore.z) ? st.bore.z : 0;
    const pz = Number.isFinite(st.player && st.player.z) ? st.player.z : bz;
    return Math.max(bz, pz);
  }

  _syncFog() {
    const f = this.scene ? this.scene.fog : null;
    const key = !f ? 0 : (f.isFogExp2 ? 2 : 1);
    if (key !== this._fogKey) {
      this._fogKey = key;
      this.waterMat.needsUpdate = true;
      this.bankMat.needsUpdate = true;
    }
  }

  step(dt) {
    const st = this.state;
    const t = st && Number.isFinite(st.time) ? st.time : 0;
    const refZ = this._refZ();

    this._syncFog();

    const crestZ = this._crestAt(this.centerX(refZ), t);
    this.waterMat.uniforms.uTime.value = t;
    this.waterMat.uniforms.uCrestZ.value = crestZ;
    this.bankUniforms.uCrestZ.value = crestZ;

    this._updateWater(t, refZ);
    this._updateBanks(refZ);
  }

  dispose() {
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    if (this.waterGeo) this.waterGeo.dispose();
    if (this.waterMat) this.waterMat.dispose();
    for (const tier of this.tiers || []) {
      for (const slab of tier.slabs) slab.geo.dispose();
      tier.slabs.length = 0;
    }
    if (this.bankMat) this.bankMat.dispose();
    this.tiers = [];
    if (this.ctx && this.ctx.river === this) this.ctx.river = null;
  }
}

export default River;
