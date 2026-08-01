// POROROCA RUSH — src/gfx/lighting.js
//
// The light rig. Four pieces, in order of how much they matter to the concept art:
//
//   1. THE SUN — a DirectionalLight aimed along `scene.userData.sunDirection`
//      (published by gfx/sky.js, which main.js constructs first). At ~3 degrees of
//      elevation almost nothing is lit face-on: horizontal surfaces sit at the
//      terminator and vertical ones facing +Z blaze. That contrast *is* the look —
//      colour and direction do more for the sunset than any amount of post.
//
//   2. THE IBL — a PMREM of the sky dome itself dropped into `scene.environment`.
//      Every MeshStandardMaterial in the project (wave body, banks, obstacles,
//      surfer) then reflects the actual sky instead of nothing, which is the
//      difference between "wet river" and "plastic". Baked once; re-baked only if
//      Sky reports the sun moved.
//
//   3. THE HEMISPHERE — warm sky over dark silt ground, from CONFIG.look.ambient*.
//
//   4. A COOL FILL from the anti-sun side at low intensity, so shadowed faces read
//      as shadow rather than as black holes.
//
// Shadows: the shadow camera is a slab that follows `state.player` and is snapped
// to the shadow-map texel grid, otherwise a camera moving at 17 m/s makes the
// shadow edges crawl. Everything else here is constant.
//
// Deterministic: the only per-frame input is state.player, which the simulation
// already guarantees is deterministic. No clock, no Math.random().
//
// Phase 2 hooks are marked `PHASE2:`.

import * as THREE_NS from 'three';
import { CONFIG } from '../config.js';

const finite = (v, fb) => (Number.isFinite(v) ? v : fb);

const SHADOW = {
  // The slab is wide (it has to reach both banks, riverWidth = 340 m) but short
  // vertically — trees top out around 30 m, so spending map resolution on 180 m of
  // empty sky would be wasteful.
  halfX: 180,
  halfY: 74,
  distance: 460,     // how far up the sun ray the light is parked
  depthBack: 470,    // how far behind the anchor casters still register
  depthFront: 330,   // ... and how far in front
  bias: -0.00042,
  normalBias: 0.22,
  aheadBias: 24,     // centre the slab a little ahead of the surfer
  anchorY: 5.0,
};

const ENV = {
  size: 128,         // PMREM cube-uv size — the sky is smooth, this is plenty
  sigma: 0.04,       // slight extra blur so cloud detail does not alias into gloss
  near: 0.1,
  far: 120,
  // The IBL is a PMREM of the dome, so it inherits CONFIG.look.skyGain. This
  // number therefore has to move the *opposite* way whenever skyGain does, or
  // brightening the sky for contrast silently brightens every water pixel too
  // (the wave body is at grazing incidence for the chase camera, where the
  // Fresnel term is near 1 and the environment reflection is most of its shade).
  // Effective env radiance = dome(skyGain) * intensity; keep that product where
  // tools/glare.mjs left it. Was 0.8 back when skyGain was implicitly 1.0.
  intensity: 0.92,
};

const FILL = {
  color: 0x7286ae,   // slate blue, the anti-sun half of the sky
  intensity: 0.38,
  elevation: 0.62,   // radians
  distance: 300,
};

// Minimal stand-in dome, used only if Sky is missing or failed to build. Keeps the
// IBL (and therefore the PBR materials) sane instead of leaving them unlit.
const FALLBACK_VERT = /* glsl */`
  varying vec3 vD;
  void main() {
    vD = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;
const FALLBACK_FRAG = /* glsl */`
  uniform vec3 uTop, uHorizon, uFog, uSunCol, uSunDir;
  varying vec3 vD;
  void main() {
    vec3 d = normalize( vD );
    float g = smoothstep( -0.02, 0.55, d.y );
    vec3 c = mix( mix( uFog, uHorizon, smoothstep( -0.02, 0.16, d.y ) ), uTop, g );
    c += uSunCol * pow( max( dot( d, uSunDir ), 0.0 ), 6.0 ) * 0.7;
    gl_FragColor = vec4( c, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ===========================================================================
export class Lighting {
  constructor(ctx = {}) {
    const THREE = ctx.THREE || THREE_NS;
    this.THREE = THREE;
    this.ctx = ctx;
    this.scene = ctx.scene || null;
    this.renderer = ctx.renderer || null;
    this.state = ctx.state || null;
    this.config = ctx.config || CONFIG;

    const look = (this.config && this.config.look) || CONFIG.look;
    const render = (this.config && this.config.render) || CONFIG.render;
    this.look = look;

    this._disposed = false;
    this._envRT = null;
    this._envVersion = -1;

    // ---------------------------------------------------------- sun direction
    this.sunDirection = new THREE.Vector3();
    this._readSunDirection();

    // ------------------------------------------------------------- the lights
    this.sun = new THREE.DirectionalLight(
      new THREE.Color(finite(look.sunColor, 0xffd9a0)),
      finite(look.sunIntensity, 4.4),
    );
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.name = 'sun:target';
    this.sun.target = this.sunTarget;

    const mapSize = Math.max(256, finite(render.shadowMapSize, 2048) | 0);
    this.shadowMapSize = mapSize;
    const sh = this.sun.shadow;
    sh.mapSize.set(mapSize, mapSize);
    sh.bias = SHADOW.bias;
    sh.normalBias = SHADOW.normalBias;
    // PCFSoftShadowMap (main.js) gives the wide, soft sunset penumbra for free.
    if (sh.radius !== undefined) sh.radius = 2.2;
    const sc = sh.camera;
    sc.left = -SHADOW.halfX; sc.right = SHADOW.halfX;
    sc.top = SHADOW.halfY; sc.bottom = -SHADOW.halfY;
    sc.near = Math.max(0.5, SHADOW.distance - SHADOW.depthFront);
    sc.far = SHADOW.distance + SHADOW.depthBack;
    sc.updateProjectionMatrix();

    this.hemi = new THREE.HemisphereLight(
      new THREE.Color(finite(look.ambientSky, 0xffbe7a)),
      new THREE.Color(finite(look.ambientGround, 0x2a1c10)),
      finite(look.ambientIntensity, 0.85),
    );
    this.hemi.name = 'ambient';

    this.fill = new THREE.DirectionalLight(new THREE.Color(FILL.color), FILL.intensity);
    this.fill.name = 'fill';
    this.fill.castShadow = false;
    this.fillTarget = new THREE.Object3D();
    this.fillTarget.name = 'fill:target';
    this.fill.target = this.fillTarget;

    // Direction of the fill: opposite azimuth to the sun, lifted well up, so the
    // faces turned away from the sunset (everything the chase camera sees) keep
    // some shape instead of crushing to black.
    this.fillDirection = new THREE.Vector3();
    this._computeFillDirection();

    if (this.scene) {
      this.scene.add(this.sun, this.sunTarget, this.hemi, this.fill, this.fillTarget);
    }

    // ------------------------------------------------------------------- misc
    this._anchor = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._computeLightBasis();

    this._bakeEnvironment();
    this._publish();

    // Place everything before the first compiled frame.
    this.step(0);
  }

  // ========================================================================
  // SUN DIRECTION
  // ========================================================================

  _readSunDirection() {
    const ud = (this.scene && this.scene.userData) || null;
    const sd = ud && ud.sunDirection;
    if (sd && Number.isFinite(sd.x) && Number.isFinite(sd.y) && Number.isFinite(sd.z)
        && (sd.x * sd.x + sd.y * sd.y + sd.z * sd.z) > 1e-6) {
      this.sunDirection.set(sd.x, sd.y, sd.z).normalize();
      return;
    }
    // Sky is built before Lighting in main.js, so this branch is a safety net for
    // a broken/absent Sky. Same convention as sky.js and world/river.js.
    const look = this.look || CONFIG.look;
    const el = finite(look.sunElevation, 0.055);
    const az = finite(look.sunAzimuth, 0.0);
    this.sunDirection.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    );
    if (this.sunDirection.lengthSq() < 1e-9) this.sunDirection.set(0, 0.055, 0.998);
    this.sunDirection.normalize();
  }

  _computeFillDirection() {
    const s = this.sunDirection;
    let hx = -s.x, hz = -s.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-5) { hx = 0; hz = -1; } else { hx /= hl; hz /= hl; }
    const c = Math.cos(FILL.elevation), sy = Math.sin(FILL.elevation);
    this.fillDirection.set(hx * c, sy, hz * c).normalize();
  }

  // Orthonormal basis of the shadow slab: forward is the light's travel
  // direction, right/up span the map. Used for texel snapping.
  _computeLightBasis() {
    const f = this._forward.copy(this.sunDirection).multiplyScalar(-1).normalize();
    const worldUp = Math.abs(f.y) > 0.999 ? this._tmp.set(0, 0, 1) : this._tmp.set(0, 1, 0);
    this._right.crossVectors(worldUp, f).normalize();
    this._up.crossVectors(f, this._right).normalize();
  }

  // ========================================================================
  // IBL
  // ========================================================================

  _fallbackEnvScene() {
    const THREE = this.THREE;
    const look = this.look || CONFIG.look;
    const s = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 24, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(finite(look.skyTop, 0x2e3646)) },
        uHorizon: { value: new THREE.Color(finite(look.skyHorizon, 0xffa64a)) },
        uFog: { value: new THREE.Color(finite(look.fogColor, 0xd08a45)) },
        uSunCol: { value: new THREE.Color(finite(look.sunColor, 0xffd9a0)) },
        uSunDir: { value: this.sunDirection.clone() },
      },
      vertexShader: FALLBACK_VERT,
      fragmentShader: FALLBACK_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      lights: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    s.add(mesh);
    s.userData.disposable = [geo, mat];
    return s;
  }

  _disposeEnvScene(s) {
    if (!s) return;
    const list = (s.userData && s.userData.disposable) || [];
    for (const o of list) { try { o.dispose(); } catch (e) { /* noop */ } }
    while (s.children.length) s.remove(s.children[0]);
  }

  _bakeEnvironment() {
    const THREE = this.THREE;
    if (!this.renderer || !this.scene) return;

    const sky = (this.ctx && this.ctx.sky)
      || (this.scene.userData && this.scene.userData.sky)
      || null;

    let envScene = null;
    let pmrem = null;
    try {
      envScene = (sky && typeof sky.makeEnvironmentScene === 'function')
        ? sky.makeEnvironmentScene(10)
        : this._fallbackEnvScene();
      if (!envScene) return;

      pmrem = new THREE.PMREMGenerator(this.renderer);
      const rt = pmrem.fromScene(envScene, ENV.sigma, ENV.near, ENV.far, { size: ENV.size });
      if (this._envRT) this._envRT.dispose();
      this._envRT = rt;
      this.scene.environment = rt.texture;
      // Note (verified against three r180): scene.environment is only applied to
      // MeshStandardMaterial, so scenery.js' Basic/Lambert silhouettes are safe.
      if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = ENV.intensity;
      this._envVersion = sky && Number.isFinite(sky.version) ? sky.version : 0;
    } catch (err) {
      // Software GL can refuse the half-float targets PMREM needs. Losing the IBL
      // costs realism, not the frame — the sun and hemisphere still carry it.
      console.warn('[lighting] IBL bake skipped:', (err && err.message) || err);
      this._envVersion = sky && Number.isFinite(sky.version) ? sky.version : 0;
    } finally {
      if (pmrem) { try { pmrem.dispose(); } catch (e) { /* noop */ } }
      this._disposeEnvScene(envScene);
    }
  }

  _publish() {
    if (!this.scene) return;
    const ud = this.scene.userData || (this.scene.userData = {});
    ud.sunLight = this.sun;
    ud.hemiLight = this.hemi;
    ud.fillLight = this.fill;
    ud.lighting = this;
    if (this.ctx) this.ctx.lighting = this;
  }

  // ========================================================================
  // FRAME
  // ========================================================================

  _anchorFromPlayer() {
    const p = this.state && this.state.player;
    let x = 0, z = 0;
    if (p) {
      if (Number.isFinite(p.x)) x = p.x;
      if (Number.isFinite(p.z)) z = p.z;
    }
    // Bias the slab downriver: that is where the camera is looking and where the
    // next few seconds of geometry will be.
    this._anchor.set(x, SHADOW.anchorY, z + SHADOW.aheadBias);
    return this._anchor;
  }

  // Snap the slab centre to whole shadow-map texels along the light basis.
  // Without this the shadow edges shimmer every frame the camera moves.
  _snapAnchor() {
    const a = this._anchor;
    const texelX = (SHADOW.halfX * 2) / this.shadowMapSize;
    const texelY = (SHADOW.halfY * 2) / this.shadowMapSize;
    const r = a.dot(this._right);
    const u = a.dot(this._up);
    const f = a.dot(this._forward);
    const rs = Math.round(r / texelX) * texelX;
    const us = Math.round(u / texelY) * texelY;
    a.set(0, 0, 0)
      .addScaledVector(this._right, rs)
      .addScaledVector(this._up, us)
      .addScaledVector(this._forward, f);
  }

  step(dt) {
    if (this._disposed) return;
    void dt;

    // Sky may have moved the sun (phase 2 time-of-day). Cheap to check.
    const sky = (this.ctx && this.ctx.sky) || (this.scene && this.scene.userData && this.scene.userData.sky);
    if (sky && Number.isFinite(sky.version) && sky.version !== this._envVersion) {
      this._readSunDirection();
      this._computeFillDirection();
      this._computeLightBasis();
      this._bakeEnvironment();
    }

    this._anchorFromPlayer();
    this._snapAnchor();
    const a = this._anchor;

    this.sunTarget.position.copy(a);
    this.sun.position.copy(a).addScaledVector(this.sunDirection, SHADOW.distance);

    this.fillTarget.position.copy(a);
    this.fill.position.copy(a).addScaledVector(this.fillDirection, FILL.distance);

    // Targets are scene children, so the renderer refreshes their matrices before
    // the shadow pass — but the shadow camera is derived during that same pass and
    // reads the *current* matrixWorld, so update them now to avoid a frame of lag.
    this.sunTarget.updateMatrixWorld();
    this.fillTarget.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.fill.updateMatrixWorld();

    // PHASE2: volumetric shafts through the canopy want the sun's view-projection
    // matrix; it is available as this.sun.shadow.matrix after the shadow pass.
  }

  dispose() {
    this._disposed = true;
    const scene = this.scene;
    if (scene) {
      for (const o of [this.sun, this.sunTarget, this.hemi, this.fill, this.fillTarget]) {
        if (o && o.parent === scene) scene.remove(o);
      }
      if (this._envRT && scene.environment === this._envRT.texture) scene.environment = null;
      const ud = scene.userData;
      if (ud && ud.lighting === this) {
        delete ud.lighting;
        delete ud.sunLight;
        delete ud.hemiLight;
        delete ud.fillLight;
      }
    }
    if (this.sun && this.sun.shadow && this.sun.shadow.map) {
      try { this.sun.shadow.map.dispose(); } catch (e) { /* noop */ }
    }
    for (const l of [this.sun, this.hemi, this.fill]) {
      if (l && l.dispose) { try { l.dispose(); } catch (e) { /* noop */ } }
    }
    if (this._envRT) { try { this._envRT.dispose(); } catch (e) { /* noop */ } this._envRT = null; }
    if (this.ctx && this.ctx.lighting === this) this.ctx.lighting = null;
  }
}

export default Lighting;
