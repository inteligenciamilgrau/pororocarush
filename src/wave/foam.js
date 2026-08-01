// POROROCA RUSH — foam, spray and mist.
//
// Everything airborne and white-ish in the frame lives here. The wave *surface*
// foam (the silt-cream sheet painted onto the water) belongs to waveMesh.js and
// is authored from `bore.whitewater()`; this module adds the three-dimensional
// stuff that sits above the surface and sells the violence of the bore:
//
//   1. rail spray   — the jet off the board, driven by `state.player.spraySlip`.
//                     This is the signature of surfing; if it reads wrong the
//                     whole ride reads wrong.
//   2. crest curtain— the continuous ragged line of thrown foam that crosses the
//                     entire river wherever `bore.breakIntensity(x, t)` is high.
//   3. mist         — fine suspended haze above the wave, additive and warm so
//                     the low sun backlights it. This is what sells the scale.
//   4. impacts      — bursts on landings, wipeouts and collisions (bus-driven).
//   5. wake         — the dissipating trail of foam the board leaves behind.
//
// Implementation notes:
//   * Every system is a fixed-size, ring-allocated pool. Nothing allocates after
//     construction, so there is no GC hitch mid-run and memory is bounded.
//   * Zero Math.random(). Each pool owns a seeded stream from core/rng.js, and
//     spawning is driven by dt accumulators, so a capture `seek(t)` reproduces
//     the same particles every time.
//   * Rendering is instanced billboard quads, not Points. Point sprites get
//     clipped the moment their centre leaves the frustum — fatal for the big
//     mist puffs that are supposed to hug the camera — and the point-size cap
//     varies by driver. Quads cost 4 vertices each and behave everywhere.
//   * Two ShaderMaterials share one program (identical source, no defines), so
//     five batches cost five draw calls and one shader compile.
//   * Colour comes from CONFIG.look.foamColor / foamDeep. Never pure white: the
//     Amazon is loaded with silt and the concept art foam is warm cream.
//
// [FASE 2] hooks, deliberately not built yet:
//   * lit foam — sample bore.normal() at spawn and store a per-particle light
//     term so the curtain has a shaded side instead of flat albedo.
//   * soft particles — needs the depth texture from post.js; would kill the hard
//     intersection line where spray meets the water.
//   * sun-angle scattering per particle for the mist, instead of the single
//     camera-facing scalar used here.
//   * a second, finer "atomised" pool for the spray tips with motion streaks.

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { rng, fbm2 } from '../core/rng.js';

// ------------------------------------------------------------------ helpers --

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

const TAU = Math.PI * 2;

// Pool capacities. Total ≈ 5 000 particles / 5 draw calls.
const CAP = {
  spray: 1000,
  crest: 2000,
  mist: 380,
  impact: 800,
  wake: 700,
};

// Lateral emitter columns for the crest curtain. 72 columns over ~350 m is one
// every ~4.9 m — dense enough to read as a continuous line from the drone shot.
const CREST_COLS = 72;
const MIST_COLS = 20;

// ---------------------------------------------------------------- textures --

/**
 * Bubbly foam sprite: soft disc, eroded by value noise so no two overlap
 * identically. R channel carries the detail, A the coverage.
 */
function makeFoamTexture(seed) {
  if (typeof document === 'undefined') return null;
  const S = 128;
  let cv;
  try {
    cv = document.createElement('canvas');
  } catch (e) { return null; }
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (!g) return null;

  const img = g.createImageData(S, S);
  const px = img.data;
  const inv = 1 / S;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) * inv, v = (y + 0.5) * inv;
      const dx = u * 2 - 1, dy = v * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);

      // Two noise octaves: big lumps + fine bubble grain.
      const lump = fbm2(u * 3.4, v * 3.4, 3, seed);
      const grain = fbm2(u * 11.0, v * 11.0, 2, seed + 977);

      // Soft disc, edge chewed away by the lumps so silhouettes stay ragged.
      let a = 1 - smoothstep(0.10, 0.94 + 0.16 * (lump - 0.5), r);
      a *= 0.42 + 0.92 * lump;
      a *= 0.78 + 0.34 * grain;
      a = clamp01(a);
      a *= a * (3 - 2 * a); // firm up the core, feather the rim

      const detail = clamp01(0.55 + 0.62 * grain + 0.26 * (lump - 0.5));
      const c = Math.round(detail * 255);
      const i = (y * S + x) * 4;
      px[i] = c; px[i + 1] = c; px[i + 2] = c;
      px[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.name = 'foam.sprite';
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Mist puff: a plain, very soft gaussian. Nothing to see, everything to feel. */
function makeMistTexture() {
  if (typeof document === 'undefined') return null;
  const S = 64;
  let cv;
  try {
    cv = document.createElement('canvas');
  } catch (e) { return null; }
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (!g) return null;

  const img = g.createImageData(S, S);
  const px = img.data;
  const inv = 1 / S;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) * inv * 2 - 1, dy = (y + 0.5) * inv * 2 - 1;
      const r2 = dx * dx + dy * dy;
      const a = clamp01(Math.exp(-r2 * 3.1) - 0.045) * 1.05;
      const i = (y * S + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 255;
      px[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.name = 'foam.mist';
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ shaders --

// One source, two materials (normal-blend foam and additive mist). Same program.
// Fog is handled by hand rather than through three's fog chunks: additive sprites
// must fade to BLACK with distance, normal ones to the fog colour, and a single
// `uFogTint` uniform covers both with one `mix()`.

const SPRITE_VERT = /* glsl */`
  attribute vec3 iPos;
  attribute vec4 iParam;   // x = size (m), y = rotation, z = alpha, w = tint

  varying vec2  vUv;
  varying float vAlpha;
  varying float vTint;
  varying float vDepth;

  void main() {
    vUv = uv;
    vAlpha = iParam.z;
    vTint = iParam.w;

    float s = iParam.x;
    float ca = cos(iParam.y);
    float sa = sin(iParam.y);
    vec2 q = vec2(position.x * ca - position.y * sa,
                  position.x * sa + position.y * ca) * s;

    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    mv.xy += q;                 // billboard: expand in view space
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPRITE_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3  uLight;      // bright silt-cream
  uniform vec3  uDeep;       // shaded, wetter foam
  uniform float uOpacity;
  uniform vec3  uFogTint;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec2  vUv;
  varying float vAlpha;
  varying float vTint;
  varying float vDepth;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float rr = dot(p, p);

    // Analytic disc, so the sprite still works if the canvas texture could not
    // be generated (no DOM, blocked 2d context…).
    float mask = 1.0 - smoothstep(0.16, 1.0, rr);
    float detail = 1.0;
    if (uHasMap > 0.5) {
      vec4 tx = texture2D(uMap, vUv);
      mask *= tx.a;
      detail = tx.r;
    }

    float a = mask * vAlpha * uOpacity;
    if (a < 0.003) discard;

    vec3 c = mix(uDeep, uLight, vTint) * (0.72 + 0.62 * detail);

    float f = clamp((vDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
    f = f * f * (3.0 - 2.0 * f);
    c = mix(c, uFogTint, f);

    gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
  }
`;

// ------------------------------------------------------------ sprite batch --

/**
 * A fixed-capacity batch of camera-facing quads. One draw call. The caller
 * writes `count` instances per frame via `write()`; unused slots are simply not
 * drawn (instanceCount shrinks), so an idle pool costs nothing.
 */
class SpriteBatch {
  constructor(cap, material, name) {
    this.cap = cap;
    this.count = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.pos = new Float32Array(cap * 3);
    this.param = new Float32Array(cap * 4);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3);
    this.aParam = new THREE.InstancedBufferAttribute(this.param, 4);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aParam.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iParam', this.aParam);
    geo.instanceCount = 0;

    // The particles live in world space and move every frame; culling them by a
    // static bounding volume would be wrong, so it is switched off outright.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 3;
    this.mesh.updateMatrix();
  }

  begin() { this.count = 0; }

  push(x, y, z, size, rot, alpha, tint) {
    const i = this.count;
    if (i >= this.cap) return;
    const p3 = i * 3, p4 = i * 4;
    this.pos[p3] = x; this.pos[p3 + 1] = y; this.pos[p3 + 2] = z;
    this.param[p4] = size;
    this.param[p4 + 1] = rot;
    this.param[p4 + 2] = alpha;
    this.param[p4 + 3] = tint;
    this.count = i + 1;
  }

  end() {
    this.geometry.instanceCount = this.count;
    if (this.count > 0) {
      // Whole-buffer upload. The biggest pool is 2 000 × 7 floats = 56 KB, and a
      // single bufferSubData beats juggling update ranges every frame.
      this.aPos.needsUpdate = true;
      this.aParam.needsUpdate = true;
    }
  }

  dispose() {
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (this.geometry) this.geometry.dispose();
    this.mesh = null;
    this.geometry = null;
  }
}

// -------------------------------------------------------------------- pool --

/**
 * Structure-of-arrays particle pool. Ring allocation: when it is full the oldest
 * slot is recycled, which degrades gracefully (the crest thins out) instead of
 * dropping the newest, most visible particles.
 */
class Pool {
  constructor(cap, seed) {
    this.cap = cap;
    this.head = 0;
    this.live = 0;
    this.rand = rng(seed >>> 0 || 1);

    const f = () => new Float32Array(cap);
    this.x = f(); this.y = f(); this.z = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.r0 = f(); this.r1 = f();
    this.rot = f(); this.rotV = f();
    this.tint = f(); this.amp = f();
    this.drag = f(); this.grav = f();
    this.floor = f();                  // y below which the particle has landed
    this.alive = new Uint8Array(cap);
    this.flat = new Uint8Array(cap);   // 1 = glued to the water surface
  }

  /** 0..1 */
  r() { return this.rand(); }
  /** a..b */
  rr(a, b) { return a + (b - a) * this.rand(); }

  alloc() {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (!this.alive[i]) this.live++;
    this.alive[i] = 1;
    this.age[i] = 0;
    this.flat[i] = 0;
    this.floor[i] = -1e9;
    return i;
  }

  /** Ballistic integration. `surf` (optional) is an (x,z) => waterY callback. */
  update(dt, surf) {
    const { x, y, z, vx, vy, vz, age, life, drag, grav, rot, rotV, alive, floor } = this;
    for (let i = 0; i < this.cap; i++) {
      if (!alive[i]) continue;
      const a = age[i] + dt;
      if (a >= life[i]) { alive[i] = 0; this.live--; continue; }
      age[i] = a;

      vy[i] += grav[i] * dt;
      // Implicit drag: unconditionally stable, so the coarse 0.2 s steps the
      // capture harness uses while fast-forwarding cannot blow the pool up.
      const k = 1 / (1 + drag[i] * dt);
      vx[i] *= k; vy[i] *= k; vz[i] *= k;

      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      z[i] += vz[i] * dt;
      rot[i] += rotV[i] * dt;

      if (this.flat[i] && surf) {
        const s = surf(x[i], z[i]);
        if (Number.isFinite(s)) { y[i] = s + 0.07; vy[i] = 0; }
      } else if (y[i] < floor[i]) {
        // Thrown foam falls back into the churn instead of sinking through the
        // world. It lands, spreads, and fades out where it lies — which is what
        // the concept art shows behind the lip.
        y[i] = floor[i];
        vy[i] = 0;
        vx[i] *= 0.72; vz[i] *= 0.72;
      }
    }
  }

  clear() {
    this.alive.fill(0);
    this.live = 0;
    this.head = 0;
  }
}

// =============================================================================

export class Foam {
  /** @param {{THREE:*, scene:*, renderer:*, camera:*, state:*, bus:*, bore:*, config:*}} ctx */
  constructor(ctx = {}) {
    const T = ctx.THREE || THREE;
    this.THREE = T;
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.camera = ctx.camera || null;
    this.state = ctx.state || null;
    this.bus = ctx.bus || null;
    this.bore = ctx.bore || null;
    this.config = ctx.config || CONFIG;
    this.ok = false;

    const L = (this.config && this.config.look) || CONFIG.look;
    const W = (this.config && this.config.wave) || CONFIG.wave;
    this.look = L;
    this.waveCfg = W;

    this.seed = (num(this.config && this.config.seed, CONFIG.seed) | 0) >>> 0;

    // What the neighbour actually gives us. Probed once so the frame path never
    // pays for a typeof and never explodes if bore.js changes shape.
    const b = this.bore || {};
    this.can = {
      crest: typeof b.crest === 'function',
      amplitude: typeof b.amplitude === 'function',
      breakIntensity: typeof b.breakIntensity === 'function',
      heightBase: typeof b.heightBase === 'function',
      height: typeof b.height === 'function',
    };
    this.boreSpeed = num(b.boreSpeed, num(W && W.boreSpeed, 8.6));
    this.halfWidth = num(b.halfWidth, 170);
    this.faceLen = num(b.faceLen, num(W && W.faceLen, 26));
    this.amp0 = num(W && W.amplitude, 3.1);

    // Pools ---------------------------------------------------------------
    this.pSpray = new Pool(CAP.spray, this.seed ^ 0x5a17);
    this.pCrest = new Pool(CAP.crest, this.seed ^ 0x1c3e);
    this.pMist = new Pool(CAP.mist, this.seed ^ 0x77b1);
    this.pImpact = new Pool(CAP.impact, this.seed ^ 0x2d90);
    this.pWake = new Pool(CAP.wake, this.seed ^ 0x0f42);

    // Emission accumulators (fractional particles carried across frames so the
    // rate is exact and dt-independent).
    this._accSpray = 0;
    this._accWake = 0;
    this._accCrest = new Float32Array(CREST_COLS);
    this._accMist = new Float32Array(MIST_COLS);

    // Queued impact bursts. Bus events fire during simulation, which the capture
    // harness runs up to 24x more often than the view step — spawning straight
    // from the handler would flood the pool during a fast-forward. Instead the
    // handler accumulates strength and step() converts it into particles once.
    this._burst = 0;
    this._offs = [];
    this._emitWarned = false;
    this._lastFog = null;

    this._surfFn = (x, z) => this._surfaceAt(x, z);
    this._time = 0;

    // Global density knobs — the two dials the Phase-2 look pass will reach for.
    this.foamGain = 1.0;
    this.mistGain = 1.0;

    this._tmpV3 = new T.Vector3();

    try {
      this._build();
      this._wireBus();
      this.ok = true;
    } catch (err) {
      console.warn('[foam] setup failed — the game runs without spray:', err);
      this._teardown();
      this.ok = false;
    }
  }

  // ------------------------------------------------------------------ build

  _build() {
    const T = this.THREE;
    const L = this.look;

    const col = (hex, fb) => new T.Color(Number.isFinite(hex) ? hex : fb);
    this.texFoam = makeFoamTexture(this.seed ^ 0x600d);
    this.texMist = makeMistTexture();

    const fog = (this.scene && this.scene.fog) || null;
    const fogNear = num(L && L.fogNear, 90);
    const fogFar = num(L && L.fogFar, 2400);

    const baseUniforms = () => ({
      uMap: { value: null },
      uHasMap: { value: 0 },
      uLight: { value: col(L && L.foamColor, 0xe8d6b4) },
      uDeep: { value: col(L && L.foamDeep, 0xc9ab7e) },
      uOpacity: { value: 1 },
      uFogTint: { value: col(L && L.fogColor, 0xd08a45) },
      uFogNear: { value: fogNear },
      uFogFar: { value: fogFar },
    });

    // Dense foam: spray, crest, impacts, wake. Normal alpha, no depth write so
    // the sprites never occlude each other in the depth buffer.
    this.matFoam = new T.ShaderMaterial({
      name: 'foam.dense',
      uniforms: baseUniforms(),
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: T.NormalBlending,
      side: T.DoubleSide,
      toneMapped: false,   // we render into the linear HDR buffer; post tone maps
    });
    if (this.texFoam) {
      this.matFoam.uniforms.uMap.value = this.texFoam;
      this.matFoam.uniforms.uHasMap.value = 1;
    }

    // Mist: additive and warm, so the low sun blows through it. Fog tint is
    // black here — additive light has to fade to nothing, not to fog colour.
    this.matMist = new T.ShaderMaterial({
      name: 'foam.mist',
      uniforms: baseUniforms(),
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
      toneMapped: false,
    });
    if (this.texMist) {
      this.matMist.uniforms.uMap.value = this.texMist;
      this.matMist.uniforms.uHasMap.value = 1;
    }
    this.matMist.uniforms.uFogTint.value.setRGB(0, 0, 0);
    // Warm the mist toward the sun colour — it is lit, not shaded.
    this.matMist.uniforms.uLight.value = col(L && L.sunColor, 0xffd9a0);
    this.matMist.uniforms.uDeep.value = col(L && L.fogColor, 0xd08a45);
    this.matMist.uniforms.uOpacity.value = 1;

    if (fog) this._syncFog(fog);

    // Batches ---------------------------------------------------------------
    this.bSpray = new SpriteBatch(CAP.spray, this.matFoam, 'foam.spray');
    this.bCrest = new SpriteBatch(CAP.crest, this.matFoam, 'foam.crest');
    this.bImpact = new SpriteBatch(CAP.impact, this.matFoam, 'foam.impact');
    this.bWake = new SpriteBatch(CAP.wake, this.matFoam, 'foam.wake');
    this.bMist = new SpriteBatch(CAP.mist, this.matMist, 'foam.mist');

    this.bWake.mesh.renderOrder = 2;    // under everything else, it is on the water
    this.bMist.mesh.renderOrder = 5;    // haze sits in front of the wet stuff

    this.group = new T.Group();
    this.group.name = 'foam';
    this.group.matrixAutoUpdate = false;
    this.group.add(this.bWake.mesh, this.bCrest.mesh, this.bSpray.mesh,
                   this.bImpact.mesh, this.bMist.mesh);
    if (this.scene) this.scene.add(this.group);

    // Sun direction, for the cheap mist backlight term.
    const el = num(L && L.sunElevation, 0.055);
    const az = num(L && L.sunAzimuth, 0);
    this.sunDir = new T.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    ).normalize();
  }

  _syncFog(fog) {
    if (!fog) return;
    const setPair = (m, near, far) => {
      m.uniforms.uFogNear.value = near;
      m.uniforms.uFogFar.value = far;
    };
    if (fog.isFog) {
      setPair(this.matFoam, num(fog.near, 90), num(fog.far, 2400));
      setPair(this.matMist, num(fog.near, 90), num(fog.far, 2400));
      if (fog.color) {
        this.matFoam.uniforms.uFogTint.value.copy(fog.color);
      }
    } else if (fog.isFogExp2) {
      // Map exponential fog onto the linear pair so the sprites stay in the same
      // haze as the rest of the scene without a second shader path.
      const d = Math.max(1e-6, num(fog.density, 0.0016));
      setPair(this.matFoam, 0.35 / d * 0.06, 2.6 / d);
      setPair(this.matMist, 0.35 / d * 0.06, 2.6 / d);
      if (fog.color) this.matFoam.uniforms.uFogTint.value.copy(fog.color);
    }
  }

  _wireBus() {
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._offs = [];
    const on = (evt, fn) => {
      try {
        const off = this.bus.on(evt, fn);
        if (typeof off === 'function') this._offs.push(off);
      } catch (e) { /* bus not ready — foam is cosmetic, carry on */ }
    };

    const add = (amount) => {
      this._burst = Math.min(this._burst + amount, 6);
    };

    on('player:wipeout', () => add(3.0));
    on('physics:wipeout', () => add(3.0));
    on('race:wipeout', () => add(2.0));
    on('obstacle:hit', (p) => add(1.4 + 1.8 * clamp01(num(p && p.severity, 0.5))));
    on('player:graze', (p) => add(0.5 + 0.9 * clamp01(num(p && p.severity, 0.4))));
    on('trick:land', (p) => add(p && p.clean === false ? 1.9 : 1.2));
    on('player:land', (p) => add(0.8 + 1.6 * clamp01(num(p && p.impact, 0.4))));
    on('player:launch', () => add(0.7));
    on('player:impact', (p) => add(0.5 * clamp01(num(p && p.strength, 0.5))));
    on('tube:exit', (p) => add(p && p.clean ? 1.1 : 0.4));
    on('player:reset', () => { this._burst = 0; this._resetPools(); });
    on('race:start', () => { this._burst = 0; this._resetPools(); });
  }

  _resetPools() {
    for (const p of [this.pSpray, this.pCrest, this.pMist, this.pImpact, this.pWake]) {
      if (p) p.clear();
    }
    this._accSpray = 0;
    this._accWake = 0;
    this._accCrest.fill(0);
    this._accMist.fill(0);
  }

  // -------------------------------------------------------------- neighbours

  _crestAt(x, t) {
    if (!this.can.crest) return this.boreSpeed * t;
    const v = this.bore.crest(x, t);
    return Number.isFinite(v) ? v : this.boreSpeed * t;
  }

  _ampAt(x, t) {
    if (!this.can.amplitude) return this.amp0;
    const v = this.bore.amplitude(x, t);
    return Number.isFinite(v) ? v : this.amp0;
  }

  _breakAt(x, t) {
    if (!this.can.breakIntensity) return 0.6;
    const v = this.bore.breakIntensity(x, t);
    return Number.isFinite(v) ? clamp01(v) : 0.6;
  }

  _surfaceAt(x, z) {
    const t = this._time;
    try {
      if (this.can.heightBase) {
        const v = this.bore.heightBase(x, z, t);
        if (Number.isFinite(v)) return v;
      } else if (this.can.height) {
        const v = this.bore.height(x, z, t);
        if (Number.isFinite(v)) return v;
      }
    } catch (e) { /* degrade to the datum */ }
    return 0;
  }

  // --------------------------------------------------------------- emitters

  /** Rail spray — the jet off the board. */
  _emitSpray(dt, p) {
    const pool = this.pSpray;
    const speed = clamp(num(p.speed, 0), 0, 40);
    const slip = clamp01(num(p.spraySlip, 0));
    const lean = clamp(num(p.lean, 0), -1, 1);
    const heading = num(p.heading, 0);

    const speedK = clamp01(speed / 13);
    // A board always throws a little water; slipping the rail throws a lot.
    const rate = (45 + 520 * slip * slip) * speedK;
    this._accSpray += rate * dt;
    let n = Math.floor(this._accSpray);
    if (n <= 0) return;
    this._accSpray -= n;
    n = Math.min(n, 90);   // one frame can never flood the pool

    const sh = Math.sin(heading), ch = Math.cos(heading);
    // forward = (sin ψ, 0, cos ψ); right = (cos ψ, 0, -sin ψ)
    const fx = sh, fz = ch;
    const rx = ch, rz = -sh;

    const px = num(p.x, 0), py = num(p.y, 0), pz = num(p.z, 0);
    const surfY = num(p.surfaceY, py);
    const side = lean >= 0 ? 1 : -1;
    const lat = 0.9 + 2.6 * Math.abs(lean) + 2.4 * slip;

    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      // Spawn along the rail: behind the fins, a hand's width off the stringer.
      const along = pool.rr(-0.95, 0.15);
      const across = side * pool.rr(0.02, 0.30);
      pool.x[i] = px + fx * along + rx * across;
      pool.y[i] = py + pool.rr(-0.04, 0.12);
      pool.z[i] = pz + fz * along + rz * across;

      const back = 0.16 * speed + pool.rr(0.4, 2.2);
      const up = 1.6 + 5.4 * slip * pool.r() + 1.2 * pool.r();
      const out = side * lat * pool.rr(0.35, 1.25);
      const scatter = pool.rr(-1.1, 1.1);

      pool.vx[i] = -fx * back + rx * out + scatter * 0.5;
      pool.vy[i] = up;
      pool.vz[i] = -fz * back + rz * out + scatter * 0.5;

      pool.life[i] = pool.rr(0.34, 0.92) + 0.35 * slip;
      pool.r0[i] = pool.rr(0.08, 0.19);
      pool.r1[i] = pool.rr(0.38, 0.80);
      pool.rot[i] = pool.rr(0, TAU);
      pool.rotV[i] = pool.rr(-3.2, 3.2);
      pool.tint[i] = pool.rr(0.62, 1.0);
      pool.amp[i] = 0.55 + 0.45 * slip;
      pool.drag[i] = pool.rr(1.4, 2.6);
      pool.grav[i] = -9.4;
      // The face falls away ahead of the board, so allow a little sink before
      // the droplets settle back onto the water.
      pool.floor[i] = surfY - 0.55;
    }
  }

  /** Wake — the flat, dissipating trail on the water behind the board. */
  _emitWake(dt, p) {
    const pool = this.pWake;
    const speed = clamp(num(p.speed, 0), 0, 40);
    if (speed < 2.5) { this._accWake = 0; return; }

    const slip = clamp01(num(p.spraySlip, 0));
    this._accWake += (10 + 26 * clamp01(speed / 16) + 22 * slip) * dt;
    let n = Math.floor(this._accWake);
    if (n <= 0) return;
    this._accWake -= n;
    n = Math.min(n, 24);

    const heading = num(p.heading, 0);
    const sh = Math.sin(heading), ch = Math.cos(heading);
    const px = num(p.x, 0), pz = num(p.z, 0);
    const py = num(p.surfaceY, num(p.y, 0));

    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      const along = pool.rr(-1.5, -0.2);
      const across = pool.rr(-0.55, 0.55) * (1 + 1.6 * slip);
      pool.x[i] = px + sh * along + ch * across;
      pool.y[i] = py + 0.05;
      pool.z[i] = pz + ch * along - sh * across;

      pool.vx[i] = pool.rr(-0.5, 0.5) - sh * 0.4;
      pool.vy[i] = 0;
      pool.vz[i] = pool.rr(-0.5, 0.5) - ch * 0.4 + this.boreSpeed * 0.25;

      pool.life[i] = pool.rr(1.5, 3.1);
      pool.r0[i] = pool.rr(0.35, 0.8);
      pool.r1[i] = pool.rr(2.0, 4.2);
      pool.rot[i] = pool.rr(0, TAU);
      pool.rotV[i] = pool.rr(-0.5, 0.5);
      pool.tint[i] = pool.rr(0.18, 0.62);
      pool.amp[i] = pool.rr(0.22, 0.44) * (0.6 + 0.7 * slip);
      pool.drag[i] = 1.1;
      pool.grav[i] = 0;
      pool.flat[i] = 1;
    }
  }

  /**
   * Crest curtain — the bright line that crosses the whole river. Emitter
   * columns are fixed in world X so the curtain does not slide with the player.
   */
  _emitCrest(dt, t, p) {
    const pool = this.pCrest;
    const span = this.halfWidth + 8;
    const stepX = (2 * span) / (CREST_COLS - 1);
    const px = num(p.x, 0);

    for (let c = 0; c < CREST_COLS; c++) {
      const x = -span + c * stepX;
      const bi = this._breakAt(x, t);
      if (bi < 0.06) { this._accCrest[c] = 0; continue; }

      // Thin out the far half of the river: it is 300 m away and a metre of
      // foam there is a pixel. Keeps the pool spent where the camera looks.
      const near = 1 - 0.55 * smoothstep(70, 260, Math.abs(x - px));
      const rate = 44.0 * bi * bi * near;

      this._accCrest[c] += rate * dt;
      let n = Math.floor(this._accCrest[c]);
      if (n <= 0) continue;
      this._accCrest[c] -= n;
      n = Math.min(n, 8);

      const crestZ = this._crestAt(x, t);
      const amp = this._ampAt(x, t);
      // Behind the lip the river sits on the elevated tidal step (bore.js:
      // SHAPE.stepRatio ≈ 0.58 of the crest height). Thrown foam lands there,
      // not at the y = 0 datum.
      const floorY = amp * 0.44;

      for (let k = 0; k < n; k++) {
        const i = pool.alloc();
        pool.x[i] = x + pool.rr(-0.55, 0.55) * stepX;
        // Just behind the lip, where the water is already aerated.
        pool.z[i] = crestZ + pool.rr(-4.2, 1.4);
        pool.y[i] = amp * pool.rr(0.48, 1.02);

        // Thrown forward with the bore and up out of the lip.
        pool.vx[i] = pool.rr(-1.7, 1.7);
        pool.vy[i] = (1.1 + 4.6 * bi) * pool.rr(0.45, 1.25);
        pool.vz[i] = this.boreSpeed * pool.rr(0.35, 0.85) + pool.rr(-0.8, 2.4);

        pool.life[i] = pool.rr(1.0, 2.0);
        // Generous radii on purpose: the curtain has to read as one continuous
        // line across 340 m of river, not as a string of separate blobs.
        pool.r0[i] = pool.rr(0.60, 1.35);
        pool.r1[i] = pool.rr(2.2, 4.3);
        pool.rot[i] = pool.rr(0, TAU);
        pool.rotV[i] = pool.rr(-1.1, 1.1);
        pool.tint[i] = pool.rr(0.45, 1.0);
        pool.amp[i] = (0.42 + 0.46 * bi) * pool.rr(0.7, 1.15);
        pool.drag[i] = pool.rr(0.55, 1.05);
        pool.grav[i] = -7.2;
        pool.floor[i] = floorY;
      }
    }
  }

  /** Suspended mist above the wave. Few, huge, faint, additive. */
  _emitMist(dt, t, p) {
    const pool = this.pMist;
    const span = this.halfWidth + 4;
    const stepX = (2 * span) / (MIST_COLS - 1);
    const px = num(p.x, 0);

    for (let c = 0; c < MIST_COLS; c++) {
      const x = -span + c * stepX;
      const bi = this._breakAt(x, t);
      const near = 1 - 0.6 * smoothstep(60, 240, Math.abs(x - px));
      this._accMist[c] += (4.0 * bi + 0.65) * near * dt;
      let n = Math.floor(this._accMist[c]);
      if (n <= 0) continue;
      this._accMist[c] -= n;
      n = Math.min(n, 2);

      const crestZ = this._crestAt(x, t);
      const amp = this._ampAt(x, t);

      for (let k = 0; k < n; k++) {
        const i = pool.alloc();
        pool.x[i] = x + pool.rr(-0.7, 0.7) * stepX;
        pool.z[i] = crestZ + pool.rr(-26, 8);
        pool.y[i] = amp * pool.rr(0.6, 1.5) + pool.rr(0.5, 7.0);

        pool.vx[i] = pool.rr(-0.5, 0.5);
        pool.vy[i] = pool.rr(0.10, 0.55);
        pool.vz[i] = this.boreSpeed * pool.rr(0.5, 0.9);

        pool.life[i] = pool.rr(4.5, 8.5);
        pool.r0[i] = pool.rr(7, 14);
        pool.r1[i] = pool.rr(20, 34);
        pool.rot[i] = pool.rr(0, TAU);
        pool.rotV[i] = pool.rr(-0.18, 0.18);
        pool.tint[i] = pool.rr(0.35, 1.0);
        // Deliberately faint: mist reads through accumulation, not through any
        // single puff. Dozens overlap, and it is additive — one visible puff is
        // a bug, a hundred invisible ones are the haze.
        pool.amp[i] = pool.rr(0.011, 0.034) * (0.5 + 0.9 * bi);
        pool.drag[i] = 0.22;
        pool.grav[i] = 0.05;   // faint lift: warm air off the wave
      }
    }
  }

  /** One queued burst → a radial explosion at the surfer. */
  _spawnBurst(power, p) {
    const pool = this.pImpact;
    const n = Math.min(pool.cap, Math.round(26 + 74 * clamp(power, 0, 4) / 3));
    const px = num(p.x, 0);
    const pz = num(p.z, 0);
    const py = num(p.surfaceY, num(p.y, 0));
    const speed = clamp(num(p.speed, 0), 0, 40);
    const heading = num(p.heading, 0);
    const sh = Math.sin(heading), ch = Math.cos(heading);
    const boost = 1 + 0.35 * clamp(power, 0, 4);

    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      const a = pool.rr(0, TAU);
      const rr = pool.rr(0.05, 0.9);
      pool.x[i] = px + Math.cos(a) * rr;
      pool.y[i] = py + pool.rr(0.0, 0.55);
      pool.z[i] = pz + Math.sin(a) * rr;

      const out = (2.4 + 5.4 * pool.r()) * boost;
      pool.vx[i] = Math.cos(a) * out + sh * speed * 0.12;
      pool.vy[i] = (2.6 + 7.0 * pool.r()) * boost;
      pool.vz[i] = Math.sin(a) * out + ch * speed * 0.12;

      pool.life[i] = pool.rr(0.55, 1.5);
      pool.r0[i] = pool.rr(0.14, 0.4);
      pool.r1[i] = pool.rr(0.9, 2.2);
      pool.rot[i] = pool.rr(0, TAU);
      pool.rotV[i] = pool.rr(-3.5, 3.5);
      pool.tint[i] = pool.rr(0.55, 1.0);
      pool.amp[i] = pool.rr(0.55, 0.95);
      pool.drag[i] = pool.rr(0.9, 1.9);
      pool.grav[i] = -9.6;
      pool.floor[i] = py - 0.4;
    }
  }

  // ------------------------------------------------------------------- step

  step(dt) {
    if (!this.ok) return;
    const h = (Number.isFinite(dt) && dt > 0) ? Math.min(dt, 0.25) : 1 / 60;

    const st = this.state;
    const t = (st && Number.isFinite(st.time)) ? st.time : this._time + h;
    this._time = t;

    const p = (st && st.player) || {};
    const wipeout = !!p.wipeout;
    const airborne = !!p.airborne;
    const onWave = p.onWave !== false;

    // --- emit -------------------------------------------------------------
    try {
      if (!airborne && !wipeout && onWave) {
        this._emitSpray(h, p);
        this._emitWake(h, p);
      } else {
        this._accSpray = 0;
        this._accWake = 0;
      }
      this._emitCrest(h, t, p);
      this._emitMist(h, t, p);

      if (this._burst > 0.01) {
        this._spawnBurst(this._burst, p);
        this._burst = 0;
      }
    } catch (err) {
      if (!this._emitWarned) {
        this._emitWarned = true;
        console.warn('[foam] emitter error — spray suppressed this frame:', err);
      }
    }

    // --- integrate ---------------------------------------------------------
    this.pSpray.update(h, null);
    this.pCrest.update(h, null);
    this.pImpact.update(h, null);
    this.pMist.update(h, null);
    this.pWake.update(h, this._surfFn);

    // --- upload ------------------------------------------------------------
    this._fill(this.pSpray, this.bSpray);
    this._fill(this.pCrest, this.bCrest);
    this._fill(this.pImpact, this.bImpact);
    this._fill(this.pWake, this.bWake);
    this._fill(this.pMist, this.bMist);

    // --- fog + mist backlight ---------------------------------------------
    const fog = this.scene && this.scene.fog;
    if (fog && fog !== this._lastFog) { this._syncFog(fog); this._lastFog = fog; }

    this.matMist.uniforms.uOpacity.value =
      this.mistGain * (0.45 + 0.65 * this._backlight());
    this.matFoam.uniforms.uOpacity.value = this.foamGain;
  }

  /**
   * How much the camera is staring into the sun, 0..1. One dot product a frame
   * buys the "backlit haze" read from the concept art without any per-particle
   * lighting maths.
   */
  _backlight() {
    const cam = this.camera;
    if (!cam || !cam.getWorldDirection || !this.sunDir) return 0.35;
    try {
      const v = cam.getWorldDirection(this._tmpV3);
      // Sun is low and down the river; looking along +sunDir means looking at it.
      return clamp01(v.dot(this.sunDir) * 0.5 + 0.5);
    } catch (e) {
      return 0.35;
    }
  }

  /** Pack the live particles of a pool into its batch. */
  _fill(pool, batch) {
    if (!pool || !batch) return;
    batch.begin();
    const { x, y, z, age, life, r0, r1, rot, tint, amp, alive } = pool;
    const cap = pool.cap;
    for (let i = 0; i < cap; i++) {
      if (!alive[i]) continue;
      const lf = life[i];
      const u = lf > 0 ? age[i] / lf : 1;
      if (u >= 1) continue;

      // Sprites grow as they age and fade with a fast attack / slow release —
      // foam appears instantly and lingers, it does not ramp in.
      const size = r0[i] + (r1[i] - r0[i]) * (u * (2 - u));
      const fadeIn = u < 0.08 ? u / 0.08 : 1;
      const fadeOut = 1 - u;
      const a = amp[i] * fadeIn * fadeOut * fadeOut;
      if (a <= 0.002) continue;

      batch.push(x[i], y[i], z[i], size, rot[i], a, tint[i]);
    }
    batch.end();
  }

  // --------------------------------------------------------------- teardown

  _teardown() {
    for (const off of (this._offs || [])) {
      try { off(); } catch (e) { /* already gone */ }
    }
    this._offs = [];

    for (const b of [this.bSpray, this.bCrest, this.bImpact, this.bWake, this.bMist]) {
      if (b) b.dispose();
    }
    this.bSpray = this.bCrest = this.bImpact = this.bWake = this.bMist = null;

    if (this.group) {
      if (this.group.parent) this.group.parent.remove(this.group);
      this.group = null;
    }
    if (this.matFoam) { this.matFoam.dispose(); this.matFoam = null; }
    if (this.matMist) { this.matMist.dispose(); this.matMist = null; }
    if (this.texFoam) { this.texFoam.dispose(); this.texFoam = null; }
    if (this.texMist) { this.texMist.dispose(); this.texMist = null; }
  }

  dispose() {
    this.ok = false;
    this._teardown();
  }

  // ----------------------------------------------------------- diagnostics

  /** Console / Phase-2 hook: `PR.ctx.foam.set({ foamGain: 1.3, mistGain: 0.6 })`. */
  set(values = {}) {
    if (Number.isFinite(+values.foamGain)) this.foamGain = clamp(+values.foamGain, 0, 3);
    if (Number.isFinite(+values.mistGain)) this.mistGain = clamp(+values.mistGain, 0, 3);
    if (this.matFoam) {
      if (Number.isFinite(+values.foamColor)) this.matFoam.uniforms.uLight.value.setHex(+values.foamColor);
      if (Number.isFinite(+values.foamDeep)) this.matFoam.uniforms.uDeep.value.setHex(+values.foamDeep);
    }
    return this;
  }

  info() {
    return {
      ok: this.ok,
      drawCalls: 5,
      live: {
        spray: this.pSpray ? this.pSpray.live : 0,
        crest: this.pCrest ? this.pCrest.live : 0,
        mist: this.pMist ? this.pMist.live : 0,
        impact: this.pImpact ? this.pImpact.live : 0,
        wake: this.pWake ? this.pWake.live : 0,
      },
      caps: { ...CAP },
      textures: { foam: !!this.texFoam, mist: !!this.texMist },
    };
  }
}

export default Foam;
