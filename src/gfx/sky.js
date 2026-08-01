// POROROCA RUSH — src/gfx/sky.js
//
// The Amazonian sunset. This module owns *everything that is not geometry* about
// the sky: the atmospheric dome, the sun disc and its glare, the stratified cloud
// bands, the distant birds, and — importantly for every other module — the scene
// fog.
//
// Three responsibilities:
//
//   1. THE DOME — one BackSide sphere pinned to the camera, shaded by a single
//      analytic-scattering shader parameterised by CONFIG.look.sunElevation /
//      sunAzimuth. It is drawn first with depthTest off (renderOrder -10000) so it
//      can never fight the far banks for depth, whatever their range.
//
//   2. THE FOG — `scene.fog` is set here from CONFIG.look.fog*. `world/river.js`
//      and `world/scenery.js` both build fog-enabled materials and river.js watches
//      `scene.fog` and recompiles when its *kind* changes, so the fog must exist
//      before their first frame. main.js builds Sky first; that is the contract.
//      The shader deliberately converges to CONFIG.look.fogColor at the horizon so
//      fully-fogged geometry melts into the sky with no visible seam.
//
//   3. THE SUN, PUBLISHED — `sky.sunDirection` / `sky.sunColor`, mirrored on
//      `scene.userData.sunDirection` / `.sunColor`, so lighting.js, post.js and the
//      water shaders can agree on where the sun is without importing this file.
//
// Determinism: nothing here reads a clock. Cloud drift and bird flight are pure
// functions of `state.time`, which the capture harness controls. No Math.random().
//
// Phase 2 hooks are marked `PHASE2:`.

import * as THREE_NS from 'three';
import { CONFIG } from '../config.js';
import { rng } from '../core/rng.js';

// --------------------------------------------------------------------- shape
const SKY = {
  domeRadius: 1000,       // must sit between camera.near and camera.far
  domeSegW: 48,
  domeSegH: 30,

  sunAngularRadius: 0.0125,   // ~2.7x the true disc — the concept art's sun is big
  sunGlare: 1.0,
  cloudCover: 0.52,

  // GLARE BUDGET (see the header of post.js for the measured numbers).
  // The dome used to be the brightest thing in the frame by a wide margin: the
  // amber horizon sat around 0.9 in linear radiance, which ACES maps to ~226/255
  // *before* any bloom. Facing the sun that left nothing darker than mid-grey on
  // screen, so the obstacles had no silhouette to read against. These three
  // multipliers split the dome into the parts that must come down (the diffuse
  // atmosphere and the wide forward-scatter halo) and the one part that must
  // stay hot (the disc itself, which is what bloom is supposed to catch).
  skyGain: 1.0,               // overridden by CONFIG.look.skyGain
  sunHalo: 1.0,               // overridden by CONFIG.look.sunHalo


  birdCount: 22,
  birdSpanMin: 2.2, birdSpanMax: 4.8,
  birdXHalf: 430,
  birdZMin: 90, birdZMax: 820,
  birdYMin: 24, birdYMax: 104,
  birdSpeedMin: 4.5, birdSpeedMax: 10.5,
  birdFlapMin: 2.1, birdFlapMax: 4.4,
};

const finite = (v, fb) => (Number.isFinite(v) ? v : fb);

// ---------------------------------------------------------------- sky shader
const SKY_VERT = /* glsl */`
  varying vec3 vSkyDir;
  void main() {
    // The dome is an untransformed sphere centred on the camera, so the object
    // space position *is* the view direction. Keeping it object space means the
    // same material works for the PMREM bake (camera at the origin).
    vSkyDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const SKY_FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uSkyTop;
  uniform vec3  uSkyHorizon;
  uniform vec3  uFogColor;
  uniform float uSunAngle;
  uniform float uGlare;
  uniform float uHalo;
  uniform float uSkyGain;
  uniform float uCover;

  varying vec3 vSkyDir;

  // NOTE (same trap river.js hit): tonemapping_pars_fragment and
  // colorspace_pars_fragment are already emitted by WebGLProgram's prefix.
  // Including them here redefines toneMapping()/*ToOutputTexel and fails to link.
  // Nothing below needs <common>, so it is deliberately left out.

  float sk_h21( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float sk_vnz( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( sk_h21( i ),                sk_h21( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( sk_h21( i + vec2( 0.0, 1.0 ) ), sk_h21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
  float sk_fbm( vec2 p ) {
    // Rotate between octaves so the lattice never shows as a grid.
    mat2 R = mat2( 0.8600, 0.5100, -0.5100, 0.8600 );
    float s = 0.0, a = 0.5;
    for ( int i = 0; i < 4; i++ ) { s += a * sk_vnz( p ); p = R * p * 2.03; a *= 0.5; }
    return s / 0.9375;
  }

  // A cloud deck is a plane at height H. Projecting the view ray onto it is what
  // compresses the bands as they approach the horizon — the single cue that makes
  // stratified cloud read as *distance* rather than as wallpaper.
  float sk_deck( vec3 dir, float H, float sx, float sz, float drift, float thr, float soft ) {
    float y = max( dir.y, 0.0125 );
    vec2 p = dir.xz * ( H / y );
    // Bands run roughly across the channel, tilted a little so they are not
    // suspiciously parallel to the river.
    vec2 q = vec2( p.x * 0.9781 - p.y * 0.2079, p.x * 0.2079 + p.y * 0.9781 );
    q = vec2( q.x * sx, q.y * sz ) + vec2( uTime * drift, uTime * drift * 0.31 );
    float n = sk_fbm( q );
    n = n * 0.72 + 0.28 * sk_vnz( q * vec2( 0.42, 2.10 ) + 11.7 );
    float c = smoothstep( thr, thr + soft, n );
    // Dissolve the deck where the projection explodes — that band is the haze, and
    // it is also where the noise would otherwise alias into infinite frequency.
    // Scaled by H so every deck dies at the same *elevation*, not the same radius.
    float fade = 1.0 - smoothstep( H * 16.0, H * 45.0, length( p ) );
    return c * fade;
  }

  void main() {
    vec3  dir  = normalize( vSkyDir );
    float y    = dir.y;
    float cosT = clamp( dot( dir, uSunDir ), -1.0, 1.0 );
    float ang  = acos( cosT );

    vec3 hSun = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) + vec3( 1e-5 ) );
    vec3 hDir = normalize( vec3( dir.x,     0.0, dir.z     ) + vec3( 1e-5 ) );
    float azAlign = max( dot( hDir, hSun ), 0.0 );

    // ------------------------------------------------ base vertical gradient
    // Three stops: hot amber on the horizon, an ochre mid band, warm slate above.
    // CONFIG's skyTop is a cool slate; the concept frames read warmer up there, so
    // it is pulled a third of the way toward the haze rather than re-tuned in
    // config (which river.js and post.js also read).
    vec3 cTop = mix( uSkyTop, uFogColor * 0.45, 0.32 );
    vec3 cMid = mix( uSkyHorizon * 0.90, cTop, 0.55 );
    float gA = smoothstep( -0.010, 0.135, y );
    float gB = smoothstep(  0.095, 0.640, y );
    vec3 col = mix( uSkyHorizon, cMid, gA );
    col = mix( col, cTop, gB );

    // Aerosol forward scattering — the whole quadrant around the sun warms up.
    // Kept lean: this term is a wash over most of the frame, and too much of it
    // bleaches the sky to cream and buries the cloud bands.
    float mieN = pow( max( cosT, 0.0 ), 7.0 );
    float mieW = pow( max( cosT, 0.0 ), 2.0 );
    col += uSunColor * ( mieN * 0.42 + mieW * 0.065 );

    // ---------------------------------------------------------- cloud decks
    // Skipped entirely below the horizon: this shader runs on every pixel of the
    // frame (the dome is drawn first, depth-test off), so the early-out matters.
    if ( y > 0.004 ) {
      float lit  = pow( max( cosT, 0.0 ), 1.7 );
      // Underlit deck: we sit below it, so the belly catches the low sun while the
      // cores stay a bruised warm grey — the exact read of the concept frames.
      vec3 dark  = mix( uSkyTop * 0.62, uFogColor * 0.30, 0.42 );
      vec3 hot   = mix( uSkyHorizon * 1.05, uSunColor * 1.70, pow( max( cosT, 0.0 ), 2.4 ) );

      // High thin deck first, main deck over it. Low frequencies on purpose: the
      // art has a handful of fat ribbons, not a scratchy corduroy.
      float hi = sk_deck( dir, 3000.0, 0.000130, 0.000520, 0.030, 0.545 - uCover * 0.22, 0.24 );
      float lo = sk_deck( dir, 1400.0, 0.000210, 0.000920, 0.062, 0.490 - uCover * 0.26, 0.26 );

      float horizonFade = smoothstep( 0.008, 0.075, y );
      vec3 cHi = mix( dark, hot, 0.26 + 0.74 * lit ) * ( 1.0 - 0.16 * hi );
      vec3 cLo = mix( dark, hot, 0.20 + 0.80 * lit ) * ( 1.0 - 0.24 * lo );

      col = mix( col, cHi, hi * 0.58 * horizonFade );
      col = mix( col, cLo, lo * 0.82 * horizonFade );
    }

    // ------------------------------------------------- atmosphere radiance
    // Everything above this line is the *diffuse* sky: gradient, forward
    // scatter, cloud decks. It is a wash covering most of the frame, so its
    // radiance sets the frame's median — and therefore how much silhouette the
    // banks and the obstacles have. Scaled here and not by dimming uSkyHorizon
    // in config, because the haze/fog colour below has to stay exactly equal to
    // scene.fog's colour or the far banks get a visible edge against the sky.
    col *= uSkyGain;

    // -------------------------------------------------------------- the haze
    // The lowest ~6 degrees collapse onto the fog colour, so distant geometry
    // (which scene.fog has already taken to exactly this colour) has no edge
    // against the sky. Kept to a narrow band: widen it and the whole frame
    // bleaches to cream and the cloud bands disappear.
    float hz = 1.0 - smoothstep( -0.025, 0.105, y );
    vec3 hazeCol = uFogColor * ( 0.86 + 0.85 * pow( azAlign, 3.0 ) );
    col = mix( col, hazeCol, hz * 0.90 );
    // Below the horizon line: hazy ground bounce, normally hidden by the banks.
    col = mix( col, uFogColor * 0.36, smoothstep( 0.0, -0.16, y ) );

    // Away from the sun's azimuth there is no forward scatter left, so the sky
    // desaturates and cools. None of the four capture angles look this way, but
    // without it a 180-degree camera whip shows the same blazing amber behind you.
    float anti = pow( 1.0 - azAlign, 2.0 );
    float luma = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    col = mix( col, vec3( luma ) * vec3( 0.88, 0.90, 1.04 ), anti * 0.30 );

    // ------------------------------------------------------- sun and glare
    // Added *after* the haze so the sun burns through it, like the concept art.
    // uHalo scales the two *wide* terms only. They are what used to lift the
    // whole into-sun quadrant off the floor: the third lobe alone (exp(-ang*1.9))
    // still carries ~0.08 of sun colour a full radian away from the disc, i.e.
    // across the entire frame. The disc term below keeps its own multiplier so
    // the sun can stay a hard, bloom-worthy highlight while the wash comes down.
    float halo = exp( -ang * 16.0 ) * 1.05
               + exp( -ang *  4.6 ) * 0.42
               + exp( -ang *  1.90 ) * 0.10;
    col += uSunColor * halo * uHalo;

    // The horizon immediately around the sun blows out to near white. That hot
    // streak under the treeline is the loudest thing in all four concept frames.
    float hotBand = exp( -max( y, 0.0 ) * 22.0 ) * pow( azAlign, 6.0 );
    col += uSunColor * hotBand * 0.50 * uHalo;

    float disc = 1.0 - smoothstep( uSunAngle * 0.80, uSunAngle * 1.32, ang );
    float limb = sqrt( max( 0.0, 1.0 - clamp( ang / max( uSunAngle, 1e-4 ), 0.0, 1.0 ) * 0.94 ) );
    col += mix( uSunColor, vec3( 1.0, 0.975, 0.925 ), 0.60 ) * disc * ( 3.4 + 7.2 * limb ) * uGlare;

    // PHASE2: crepuscular rays / god rays are a screen-space pass in post.js —
    // it can read scene.userData.sunDirection to place the radial blur origin.
    // PHASE2: cloud shadows on the water, driven by the same sk_deck() field.

    gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // The gradient spans most of the frame over a very small colour range, which
    // is textbook 8-bit banding. A sub-LSB dither in display space kills it and
    // costs one hash. Deterministic: it is a function of gl_FragCoord only.
    gl_FragColor.rgb += ( sk_h21( gl_FragCoord.xy ) - 0.5 ) * ( 1.6 / 255.0 );
  }
`;

// ---------------------------------------------------------------------------
// Distant bird: a shallow V (two triangles) with a stub tail, unit wingspan.
// Flapping is baked into the instance matrix as a Y scale, which opens and closes
// the V — plenty at 200–800 m.
function makeBirdGeometry(THREE) {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    -0.50, 0.17, 0.00, 0.00, 0.00, 0.00, -0.09, -0.01, -0.15,
    0.50, 0.17, 0.00, 0.00, 0.00, 0.00, 0.09, -0.01, -0.15,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  // No normals: the material is unlit MeshBasic. No UVs either.
  return g;
}

// ===========================================================================
export class Sky {
  constructor(ctx = {}) {
    const THREE = ctx.THREE || THREE_NS;
    this.THREE = THREE;
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.camera = ctx.camera || null;
    this.state = ctx.state || null;
    this.config = ctx.config || CONFIG;

    const look = (this.config && this.config.look) || CONFIG.look;
    this.look = look;

    this._t = 0;            // fallback clock if state.time is unavailable
    this._disposed = false;
    this._geoms = [];
    this._mats = [];

    // ------------------------------------------------------------------ sun
    this.sunElevation = finite(look.sunElevation, 0.055);
    this.sunAzimuth = finite(look.sunAzimuth, 0.0);
    this.sunDirection = new THREE.Vector3();
    this.sunColor = new THREE.Color(look.sunColor !== undefined ? look.sunColor : 0xffd9a0);
    this.version = 0;       // bumped whenever the sun moves — lighting.js watches it
    this._writeSunDirection();

    // ------------------------------------------------------------- uniforms
    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: this.sunDirection },          // shared by reference
      uSunColor: { value: this.sunColor },            // shared by reference
      uSkyTop: { value: new THREE.Color(look.skyTop !== undefined ? look.skyTop : 0x2e3646) },
      uSkyHorizon: { value: new THREE.Color(look.skyHorizon !== undefined ? look.skyHorizon : 0xffa64a) },
      uFogColor: { value: new THREE.Color(look.fogColor !== undefined ? look.fogColor : 0xd08a45) },
      uSunAngle: { value: SKY.sunAngularRadius },
      uGlare: { value: Math.max(0, finite(look.sunGlare, SKY.sunGlare)) },
      uHalo: { value: Math.max(0, finite(look.sunHalo, SKY.sunHalo)) },
      uSkyGain: { value: Math.max(0, finite(look.skyGain, SKY.skyGain)) },
      uCover: { value: SKY.cloudCover },
    };

    // --------------------------------------------------------------- scene
    this.group = new THREE.Group();
    this.group.name = 'sky';
    this.group.matrixAutoUpdate = true;   // it tracks the camera every frame
    if (this.scene) this.scene.add(this.group);

    this._buildDome();
    this._buildBirds();
    this._installFog();
    this._publish();

    // Put the dome under the camera immediately so the very first compiled frame
    // is already correct (main.js renders one warm-up frame before the loop).
    this.step(0);
  }

  // ========================================================================
  // SUN
  // ========================================================================

  _writeSunDirection() {
    const el = this.sunElevation;
    const az = this.sunAzimuth;
    // Same convention as world/river.js: unit vector pointing *at* the sun.
    // az = 0 puts it straight down the river (+Z), which is the vanishing point
    // every one of the four concept frames is composed around.
    this.sunDirection.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    );
    if (this.sunDirection.lengthSq() < 1e-9) this.sunDirection.set(0, 0.055, 0.998);
    this.sunDirection.normalize();
  }

  /**
   * Move the sun. Bumps `version` so lighting.js knows to re-bake the IBL.
   * Phase 1 never calls this; it exists so a time-of-day pass costs nothing later.
   */
  setSun(elevation, azimuth) {
    this.sunElevation = finite(elevation, this.sunElevation);
    this.sunAzimuth = finite(azimuth, this.sunAzimuth);
    this._writeSunDirection();
    this.version++;
    return this;
  }

  _publish() {
    if (!this.scene) return;
    const ud = this.scene.userData || (this.scene.userData = {});
    ud.sunDirection = this.sunDirection;   // live reference — never reassigned
    ud.sunColor = this.sunColor;
    ud.sunElevation = this.sunElevation;
    ud.sunAzimuth = this.sunAzimuth;
    ud.sky = this;
    if (this.ctx) this.ctx.sky = this;
  }

  // ========================================================================
  // DOME
  // ========================================================================

  _makeSkyMaterial() {
    const THREE = this.THREE;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,          // shared by reference across variants
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,                 // drawn first; everything else paints over
      fog: false,
      lights: false,
      toneMapped: true,                 // banding is handled by an explicit dither
    });
    mat.name = 'skyDome';
    this._mats.push(mat);
    return mat;
  }

  _buildDome() {
    const THREE = this.THREE;
    const geo = new THREE.SphereGeometry(SKY.domeRadius, SKY.domeSegW, SKY.domeSegH);
    this._geoms.push(geo);
    this.domeGeo = geo;
    this.domeMat = this._makeSkyMaterial();

    const mesh = new THREE.Mesh(geo, this.domeMat);
    mesh.name = 'sky:dome';
    mesh.frustumCulled = false;
    mesh.renderOrder = -10000;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.dome = mesh;
    this.group.add(mesh);
  }

  /**
   * A throwaway scene holding nothing but the sky, suitable for
   * `PMREMGenerator.fromScene()`. lighting.js calls this to build the IBL.
   * The returned scene owns its geometry; call `disposeEnvironmentScene()` — or
   * just dispose the returned geometry — when the bake is done. The *material*
   * is shared with the live dome and must not be disposed by the caller.
   */
  makeEnvironmentScene(radius = 10) {
    const THREE = this.THREE;
    const s = new THREE.Scene();
    const geo = new THREE.SphereGeometry(radius, 32, 20);
    const mesh = new THREE.Mesh(geo, this.domeMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10000;
    s.add(mesh);
    s.userData.disposable = [geo];
    return s;
  }

  // ========================================================================
  // BIRDS
  // ========================================================================

  _buildBirds() {
    const THREE = this.THREE;
    const n = SKY.birdCount | 0;
    if (n <= 0) return;

    const r = rng(((this.config && this.config.seed) | 0) ^ 0x5b17d);
    const R = (a, b) => a + (b - a) * r();

    this.birds = new Array(n);
    for (let i = 0; i < n; i++) {
      // Loosely clustered ahead of and above the camera, the way the flocks read
      // in `pororoca_rush_capa.png` — small, high, drifting across the sun.
      this.birds[i] = {
        x0: R(-SKY.birdXHalf, SKY.birdXHalf),
        z0: R(SKY.birdZMin, SKY.birdZMax),
        y: R(SKY.birdYMin, SKY.birdYMax),
        dir: R(-Math.PI, Math.PI),
        spd: R(SKY.birdSpeedMin, SKY.birdSpeedMax),
        span: R(SKY.birdSpanMin, SKY.birdSpanMax),
        flap: R(SKY.birdFlapMin, SKY.birdFlapMax),
        phase: R(0, Math.PI * 2),
        bank: R(-0.22, 0.22),
      };
    }

    this.birdGeo = makeBirdGeometry(THREE);
    this._geoms.push(this.birdGeo);

    this.birdMat = new THREE.MeshBasicMaterial({
      color: 0x2a1e14,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      // depthTest stays ON: the dome writes no depth so the birds always clear it,
      // while the canopy and the far bank still occlude them correctly.
      depthTest: true,
      fog: false,
      toneMapped: true,
    });
    this.birdMat.name = 'skyBirds';
    this._mats.push(this.birdMat);

    this.birdMesh = new THREE.InstancedMesh(this.birdGeo, this.birdMat, n);
    this.birdMesh.name = 'sky:birds';
    this.birdMesh.frustumCulled = false;
    this.birdMesh.renderOrder = 2;
    this.birdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.birdMesh.castShadow = false;
    this.birdMesh.receiveShadow = false;
    this.group.add(this.birdMesh);

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qBank = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._sc = new THREE.Vector3();
    this._axisY = new THREE.Vector3(0, 1, 0);
    this._axisZ = new THREE.Vector3(0, 0, 1);
  }

  _updateBirds(t) {
    const mesh = this.birdMesh;
    if (!mesh || !this.birds) return;
    const spanX = SKY.birdXHalf * 2;
    const spanZ = SKY.birdZMax - SKY.birdZMin;

    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      const cx = Math.sin(b.dir), cz = Math.cos(b.dir);

      // Pure function of t — no accumulation, so a sparse capture seek lands on
      // exactly the same flock as a real-time playthrough.
      let px = b.x0 + cx * b.spd * t + SKY.birdXHalf;
      px = px - Math.floor(px / spanX) * spanX - SKY.birdXHalf;
      let pz = b.z0 + cz * b.spd * t - SKY.birdZMin;
      pz = pz - Math.floor(pz / spanZ) * spanZ + SKY.birdZMin;

      const flap = 0.34 + 0.92 * Math.abs(Math.sin(t * b.flap + b.phase));
      const s = b.span;

      this._v.set(px, b.y + Math.sin(t * 0.37 + b.phase) * 1.6, pz);
      // yaw to the flight heading, then a little roll so the flock is not a
      // perfectly flat cut-out sheet.
      this._q.setFromAxisAngle(this._axisY, b.dir);
      this._qBank.setFromAxisAngle(this._axisZ, b.bank);
      this._q.multiply(this._qBank);
      this._sc.set(s, s * flap, s);
      this._m4.compose(this._v, this._q, this._sc);
      mesh.setMatrixAt(i, this._m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ========================================================================
  // FOG
  // ========================================================================

  _installFog() {
    if (!this.scene) return;
    const THREE = this.THREE;
    const look = this.look;
    const near = finite(look.fogNear, 90);
    const far = Math.max(near + 10, finite(look.fogFar, 2400));
    // Linear fog, not exp2: it hits exactly 100% at `fogFar`, which is what lets
    // the shader's horizon band and the far banks meet on the same colour. The
    // exp2 density stays in CONFIG for the phase-2 volumetric pass.
    this.fog = new THREE.Fog(new THREE.Color(finite(look.fogColor, 0xd08a45)), near, far);
    this.scene.fog = this.fog;
    // Fallback clear colour: if the dome ever fails to draw, the frame is warm
    // haze rather than black.
    this.scene.background = new THREE.Color(finite(look.fogColor, 0xd08a45));
    // PHASE2: height fog + sun-direction-tinted aerial perspective wants a custom
    // fog chunk; river.js already recompiles when scene.fog changes kind.
  }

  // ========================================================================
  // FRAME
  // ========================================================================

  step(dt) {
    if (this._disposed) return;

    const st = this.state;
    const d = Number.isFinite(dt) ? dt : 0;
    this._t += d;
    // state.time is the deterministic clock; the accumulator is only a fallback.
    const t = st && Number.isFinite(st.time) ? st.time : this._t;

    if (this.uniforms) this.uniforms.uTime.value = t;

    const cam = this.camera;
    if (cam && cam.position && Number.isFinite(cam.position.x)) {
      this.group.position.set(cam.position.x, cam.position.y, cam.position.z);
    }

    this._updateBirds(t);
  }

  dispose() {
    this._disposed = true;
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    for (const g of this._geoms) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._mats) { try { m.dispose(); } catch (e) { /* noop */ } }
    this._geoms.length = 0;
    this._mats.length = 0;
    if (this.birdMesh && this.birdMesh.dispose) { try { this.birdMesh.dispose(); } catch (e) { /* noop */ } }
    if (this.scene) {
      if (this.scene.fog === this.fog) this.scene.fog = null;
      const ud = this.scene.userData;
      if (ud && ud.sky === this) {
        delete ud.sky;
        delete ud.sunDirection;
        delete ud.sunColor;
        delete ud.sunElevation;
        delete ud.sunAzimuth;
      }
    }
    if (this.ctx && this.ctx.sky === this) this.ctx.sky = null;
  }
}

export default Sky;
