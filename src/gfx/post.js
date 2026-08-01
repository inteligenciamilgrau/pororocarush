// POROROCA RUSH — post-processing stack.
//
// `render()` is the ONLY draw call site in the whole game: `main.js` calls
// `post.render()` and nothing else. Every code path in here therefore ends in a
// visible frame — if any part of the composer misbehaves we drop straight back
// to `renderer.render(scene, camera)`. A black frame kills the screenshot review
// loop, so robustness beats fidelity here, always.
//
// ---------------------------------------------------------------------------
// Colour pipeline (the classic EffectComposer trap is double gamma — read this
// before touching anything):
//
//   * `main.js` sets `renderer.outputColorSpace = SRGBColorSpace` and
//     `renderer.toneMapping = ACESFilmicToneMapping`. three.js only applies
//     either of those when rendering to the DEFAULT framebuffer. Rendering into
//     a render target (which is all EffectComposer ever does) gives raw LINEAR
//     values with no tone map — verified in WebGLPrograms.getParameters().
//   * So the composer buffers are linear HDR (HalfFloat) from RenderPass all the
//     way to the last pass. Bloom works in that linear HDR space, which is the
//     only place it looks right.
//   * The final grade pass renders to screen with a plain ShaderMaterial. three
//     injects NOTHING into a custom ShaderMaterial — no <tonemapping_fragment>,
//     no <colorspace_fragment> — so the grade pass applies exposure, ACES and
//     the sRGB transfer exactly once, by hand, mirroring three's own formulas
//     bit for bit. That keeps the fallback path (`renderer.render`) and the post
//     path looking like the same game.
//   * We therefore never add an OutputPass: it would tone map a second time.
//
// Pass chain (3 passes — deliberately short; the capture harness runs on
// software GL and every full-screen pass costs real seconds there):
//
//   RenderPass  →  UnrealBloomPass  →  GradePass (to screen)
//
// The grade pass folds chromatic aberration, cheap radial motion blur, colour
// grading, vignette, black point, tone map, sRGB encode and film grain into one
// shader.
//
// ---------------------------------------------------------------------------
// GLARE BUDGET — read this before raising bloom again.
//
// The chase camera looks straight down the sun's azimuth, so the sun is the
// single most important legibility problem in the game: if the frame washes out
// there, the player cannot see the logs they are supposed to dodge. Measured
// with `tools/glare.mjs` at t=30 s, the original stack produced mean luminance
// 190/255, 19.7% of pixels clipped to white and a 5th percentile of 86 — i.e.
// the *darkest* twentieth of the frame was still brighter than the concept
// art's median. There was no black anywhere in the image.
//
// `tools/glaresweep.mjs` fingered bloom, and a per-knob sweep showed why it was
// not a threshold problem:
//
//   threshold 0.72 (original) → 19.7% clipped
//   threshold 8.0  (only the solar disc survives the high pass) → still 6.3%
//   strength 0                                                  → 1.3%
//
// Raising the threshold barely helped because UnrealBloomPass' `radius` is not a
// blur radius — it is the crossfade between the five mip levels of the chain
// (`lerpBloomFactor` in its composite shader). At radius 0.72 the weights are
// dominated by the 1/16 and 1/32 mips, so *any* highlight, however small, is
// smeared over the whole frame as a flat veil. A pinpoint sun was enough to lift
// the entire image by ~60/255. The fix is a small radius (tight glow that stays
// around the disc and the specular glitter) plus a threshold high enough that
// the diffuse sky never enters the high pass at all.
//
// Two matching caveats about that sweep, since they read as pipeline bugs and
// are not:
//   * "toneMappingExposure had no effect" — the sweep pokes the renderer and
//     then calls `post.render()` directly. Exposure reaches the grade pass only
//     through `_syncColorPipeline()`, which runs from `step()`. It was never
//     resampled. Exposure does work.
//   * "scene.fog = null had no effect" — three keys USE_FOG as a shader define.
//     Clearing scene.fog without `material.needsUpdate = true` leaves every
//     material still compiled with fog, reading stale uniforms. Fog does work.
// ---------------------------------------------------------------------------
//
// [FASE 2] hooks, all deliberately OFF and unimported so they cost nothing:
//
//   DOF        — `BokehPass` from three/addons/postprocessing/BokehPass.js,
//                inserted between bloom and grade. Needs a depth texture on the
//                composer's render target (`new THREE.DepthTexture(w, h)`), and
//                the focus distance driven from `state.player` → camera range.
//                Expect it to roughly double software-GL frame cost.
//   SSR        — `SSRPass`. Only worth it for the wet-board and water sheen;
//                the water shader already fakes reflection cheaply.
//   God rays   — screen-space radial blur from the sun's projected position.
//                80% of it is already available: pass the sun's NDC position as
//                `uBlurCenter` with a bright-pass mask instead of the frame.
//   TAA        — `TAARenderPass` in place of RenderPass, `sampleLevel` 2..3.
//                Deterministic, so it is safe with the capture harness, but it
//                multiplies scene draw cost by 2^sampleLevel.
//   AA         — going through a composer bypasses the canvas' MSAA, so edges
//                are currently unfiltered. Two fixes, both Phase 2:
//                (a) `SCENE_SAMPLES = 4` below — but EffectComposer clones the
//                    target for its ping-pong buffers, so every pass would go
//                    multisampled too, which is pure waste;
//                (b) an `FXAAPass` appended AFTER the grade pass (FXAA needs
//                    sRGB input, and the grade pass is what produces it).
//                (b) is the cheap one and the right one.
//   Depth pre-pass / SSAO / motion vectors: skip. Not worth the software-GL bill.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CONFIG } from '../config.js';

// --------------------------------------------------------------------- tuning

// The bloom mip chain runs at this fraction of the frame. Bloom is a blur, so
// nobody can tell — but it is the single most expensive thing in the stack on
// software GL, and this cuts it by ~3x. Kept identical in interactive and
// capture builds so screenshots match what a player sees.
const BLOOM_SCALE = 0.55;

// MSAA on the scene target. 0 for now — see the AA note in the header: raising
// it multisamples every ping-pong buffer, not just the scene pass.
const SCENE_SAMPLES = 0;

// Radial blur taps beyond the centre sample. 4 → 4 extra texture fetches, and
// only when the player is actually moving fast.
const BLUR_TAPS = 4;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

// Frame-rate independent approach: returns the lerp factor for rate `k`.
const approach = (k, dt) => 1 - Math.exp(-k * dt);

// ------------------------------------------------------------- grade shader --

const GradeShader = {
  name: 'PororocaGradeShader',

  uniforms: {
    tDiffuse:     { value: null },
    uResolution:  { value: new THREE.Vector2(1672, 941) },
    uAspect:      { value: 1672 / 941 },
    uTime:        { value: 0 },

    uExposure:    { value: 1.0 },
    uToneMap:     { value: 1 },   // 1 = ACES, 0 = none (mirrors the renderer)
    uEncodeSRGB:  { value: 1 },   // 1 = sRGB OETF on output
    uBlack:       { value: 0.0 }, // linear black point — ACES' toe alone is soft

    uVignette:    { value: 0.34 },
    uGrain:       { value: 0.022 },
    uChroma:      { value: 0.0016 },

    uBlur:        { value: 0.0 },                        // 0..1 radial blur
    uBlurCenter:  { value: new THREE.Vector2(0.5, 0.5) },

    uSaturation:  { value: 1.06 },
    uContrast:    { value: 1.03 },
    uShadowTint:  { value: new THREE.Vector3(1.10, 0.95, 0.80) }, // warm brown
    uHighTint:    { value: new THREE.Vector3(1.00, 0.84, 0.58) }, // amber
    uShadowAmt:   { value: 0.55 },
    uHighAmt:     { value: 0.40 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uAspect;
    uniform float uTime;

    uniform float uExposure;
    uniform float uToneMap;
    uniform float uEncodeSRGB;
    uniform float uBlack;

    uniform float uVignette;
    uniform float uGrain;
    uniform float uChroma;

    uniform float uBlur;
    uniform vec2  uBlurCenter;

    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3  uShadowTint;
    uniform vec3  uHighTint;
    uniform float uShadowAmt;
    uniform float uHighAmt;

    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

    // --- three.js ACESFilmicToneMapping, copied verbatim so the composer path
    // --- and the renderer.render() fallback path grade identically.
    vec3 rrtAndOdtFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }

    vec3 acesFilmic(vec3 color) {
      const mat3 ACESInputMat = mat3(
        vec3(0.59719, 0.07600, 0.02840),
        vec3(0.35458, 0.90834, 0.13383),
        vec3(0.04823, 0.01566, 0.83777)
      );
      const mat3 ACESOutputMat = mat3(
        vec3( 1.60475, -0.10208, -0.00327),
        vec3(-0.53108,  1.10813, -0.07276),
        vec3(-0.07367, -0.00605,  1.07602)
      );
      color /= 0.6;
      color = ACESInputMat * color;
      color = rrtAndOdtFit(color);
      color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }

    // three.js sRGBTransferOETF.
    vec3 encodeSRGB(vec3 c) {
      return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055),
                 c * 12.92,
                 vec3(lessThanEqual(c, vec3(0.0031308))));
    }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;

      // Radial vector used by both the aberration and the speed blur. It points
      // away from the focus point (screen centre normally, the sun during a
      // Phase-2 god-ray pass).
      vec2 rad = uv - uBlurCenter;
      float r = length(rad);
      float edge = smoothstep(0.18, 0.82, r);

      // --- chromatic aberration: minimal, edges only, grows a little with speed
      float ca = uChroma * (0.30 + edge) * (1.0 + 1.6 * uBlur) * 3.0;
      vec2  off = rad * ca;
      vec3 col = vec3(
        texture2D(tDiffuse, uv + off).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - off).b
      );

      // --- cheap radial motion blur, driven by speed + camera shake
      // Kept restrained on purpose: a screenshot is how this game gets judged,
      // and smeared corners read as "low resolution", not as "fast".
      if (uBlur > 0.002) {
        float amt = uBlur * 0.048 * edge;
        vec3 acc = col;
        float wsum = 1.0;
        for (int i = 1; i <= ${BLUR_TAPS}; i++) {
          float f = float(i) / float(${BLUR_TAPS});
          float w = 1.0 - 0.60 * f;
          acc += texture2D(tDiffuse, uv - rad * (amt * f)).rgb * w;
          wsum += w;
        }
        col = acc / wsum;
      }

      col = max(col, vec3(0.0));

      // --- creative grade, in linear ------------------------------------------
      float luma = dot(col, LUMA);

      // shadows drift to warm silt-brown
      float sh = 1.0 - smoothstep(0.0, 0.30, luma);
      col = mix(col, col * uShadowTint, uShadowAmt * sh);

      // highlights compress toward amber instead of clipping to white
      float hi = smoothstep(0.55, 2.40, luma);
      col = mix(col, mix(col, uHighTint * luma, 0.55), uHighAmt * hi);

      // saturation + a touch of contrast around linear mid grey
      luma = dot(col, LUMA);
      col = mix(vec3(luma), col, uSaturation);
      col = max(vec3(0.0), (col - 0.18) * uContrast + 0.18);

      // --- vignette as an exposure falloff (pre tone map = filmic rolloff) ----
      vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
      float rv = length(q) / max(0.0001, length(vec2(uAspect, 1.0) * 0.5));
      col *= 1.0 - uVignette * smoothstep(0.42, 1.06, rv);

      // --- black point: give ACES' toe something to land on -------------------
      // The concept frames sit at p05 = 6..9/255; ACES on its own never quite
      // gets there because the ambient/IBL floor is a constant lift across the
      // whole frame. Subtracting it in linear and renormalising costs no
      // highlight range and is what puts actual black back in the shadows.
      if (uBlack > 0.0) col = max(col - uBlack, vec3(0.0)) / max(1e-3, 1.0 - uBlack);

      // --- exposure + tone map + transfer function ---------------------------
      col *= uExposure;
      if (uToneMap > 0.5) col = acesFilmic(col);
      else col = clamp(col, 0.0, 1.0);

      if (uEncodeSRGB > 0.5) col = encodeSRGB(col);
      col = clamp(col, 0.0, 1.0);

      // --- grain, in display space, heavier in the shadows -------------------
      if (uGrain > 0.0001) {
        float g = hash12(uv * uResolution + vec2(uTime * 137.0, uTime * 61.0)) - 0.5;
        float lo = 1.0 - dot(col, LUMA);
        col += g * uGrain * (0.35 + 0.85 * lo * lo);
        col = clamp(col, 0.0, 1.0);
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// =============================================================================

export class Post {
  /** @param {{THREE:*, scene:*, renderer:*, camera:*, state:*, bus:*, bore:*, config:*}} ctx */
  constructor(ctx = {}) {
    const T = ctx.THREE || THREE;
    this.THREE = T;
    this.ctx = ctx;
    this.renderer = ctx.renderer || null;
    this.scene = ctx.scene || null;
    this.camera = ctx.camera || null;
    this.state = ctx.state || null;
    this.config = ctx.config || CONFIG;

    const L = (this.config && this.config.look) || CONFIG.look;
    this.look = L;

    /** Master switch — the integrator can flip this to compare with/without. */
    this.enabled = true;
    /** True once the composer is built and has not thrown. */
    this.ok = false;
    /** Consecutive render failures; post gives up permanently after 3. */
    this._failures = 0;
    this._reported = false;

    this.composer = null;
    this.renderPass = null;
    this.bloom = null;
    this.grade = null;

    // Smoothed drivers so blur/shake do not strobe between frames.
    this._blur = 0;
    this._shake = 0;

    this._w = 1672;
    this._h = 941;

    if (!this.renderer || !this.scene || !this.camera) {
      console.warn('[post] missing renderer/scene/camera in ctx — post disabled, ' +
                   'the game will still draw via the fallback path.');
      return;
    }

    try {
      this._build();
      this.ok = true;
    } catch (err) {
      console.warn('[post] composer setup failed, falling back to direct render:', err);
      this._teardown();
      this.ok = false;
    }
  }

  // ------------------------------------------------------------------- build

  _build() {
    const T = this.THREE;
    const renderer = this.renderer;
    const L = this.look;

    const size = renderer.getSize(new T.Vector2());
    this._w = Math.max(1, Math.round(size.x) || 1672);
    this._h = Math.max(1, Math.round(size.y) || 941);
    const pr = Math.max(0.5, renderer.getPixelRatio() || 1);

    // HalfFloat targets: bloom needs headroom above 1.0 to bloom the sun at all.
    const rt = new T.WebGLRenderTarget(
      Math.max(1, Math.round(this._w * pr)),
      Math.max(1, Math.round(this._h * pr)),
      {
        type: T.HalfFloatType,
        format: T.RGBAFormat,
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        samples: SCENE_SAMPLES,
      },
    );
    rt.texture.name = 'Post.rt';
    // NoColorSpace: these buffers hold linear HDR. Tagging them sRGB here is the
    // other half of the double-gamma trap.
    rt.texture.colorSpace = T.NoColorSpace;
    rt.texture.generateMipmaps = false;

    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this._w, this._h);

    // 1 — scene
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // 2 — bloom: the warm halo around the sun and the glitter on the water.
    // `threshold` is a LINEAR HDR luminance, not an sRGB one — the composer
    // buffers never went through a transfer function. The diffuse sky lands
    // around 0.4..0.9 there, so anything below ~1.5 puts the sky itself into the
    // high pass and the frame turns to milk. `radius` is a mip crossfade, not a
    // size: see the glare budget note in the header before raising it.
    const strength = clamp(num(L && L.bloomStrength, 0.62), 0, 4);
    const radius = clamp(num(L && L.bloomRadius, 0.72), 0, 2);
    const threshold = clamp(num(L && L.bloomThreshold, 0.72), 0, 12);
    this.bloom = new UnrealBloomPass(
      new T.Vector2(Math.round(this._w * pr * BLOOM_SCALE), Math.round(this._h * pr * BLOOM_SCALE)),
      strength, radius, threshold,
    );
    // Downscale the mip chain. EffectComposer feeds full drawing-buffer pixels
    // to every pass; intercepting setSize is the least invasive way to keep the
    // most expensive pass off the critical path on software GL.
    const bloomSetSize = UnrealBloomPass.prototype.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSetSize(
      Math.max(4, Math.round(w * BLOOM_SCALE)),
      Math.max(4, Math.round(h * BLOOM_SCALE)),
    );
    this.composer.addPass(this.bloom);

    // 3 — the single grade pass. Last in the chain, so EffectComposer sets
    //     renderToScreen on it: this is what the player actually sees.
    this.grade = new ShaderPass(GradeShader);
    this.grade.material.toneMapped = false;  // belt and braces; see header note
    this.grade.material.depthTest = false;
    this.grade.material.depthWrite = false;
    this.composer.addPass(this.grade);

    // Seed the static uniforms from CONFIG.look.
    const u = this.grade.uniforms;
    u.uVignette.value = clamp(num(L && L.vignette, 0.34), 0, 1);
    u.uGrain.value = clamp(num(L && L.grainAmount, 0.022), 0, 0.25);
    u.uChroma.value = clamp(num(L && L.chromaticAberration, 0.0016), 0, 0.02);
    u.uBlack.value = clamp(num(L && L.blackPoint, 0.0), 0, 0.2);
    u.uSaturation.value = clamp(num(L && L.saturation, 1.06), 0, 3);
    u.uContrast.value = clamp(num(L && L.contrast, 1.03), 0.2, 3);

    this._syncColorPipeline();
    this._syncResolution();
  }

  /**
   * Mirror the renderer's tone map / colour space / exposure into the grade
   * pass. Called every frame — the integrator is free to change exposure at
   * runtime and the post path has to follow, or the two paths diverge.
   */
  _syncColorPipeline() {
    if (!this.grade) return;
    const T = this.THREE;
    const r = this.renderer;
    const u = this.grade.uniforms;

    const tm = r.toneMapping;
    // Anything other than NoToneMapping is treated as ACES: it is what main.js
    // sets, and a wrong-but-tonemapped image beats a blown-out one.
    u.uToneMap.value = (tm === T.NoToneMapping) ? 0 : 1;
    u.uEncodeSRGB.value = (r.outputColorSpace === T.SRGBColorSpace) ? 1 : 0;
    // CONFIG.look.exposure is a look-owned trim on top of the renderer's own
    // exposure (CONFIG.render.exposure, which the integrator owns). The direct
    // `renderer.render()` fallback cannot see the trim — that path is a
    // never-black safety net, not a second art direction, and it stays legible.
    const trim = clamp(num(this.look && this.look.exposure, 1), 0.05, 4);
    u.uExposure.value = clamp(num(r.toneMappingExposure, 1) * trim, 0.02, 8);
  }

  _syncResolution() {
    if (!this.grade) return;
    const T = this.THREE;
    const v = this.renderer.getDrawingBufferSize(new T.Vector2());
    const w = Math.max(1, v.x || this._w);
    const h = Math.max(1, v.y || this._h);
    this.grade.uniforms.uResolution.value.set(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  // -------------------------------------------------------------------- step

  /** Per-frame uniform update. Never draws. */
  step(dt) {
    if (!this.ok || !this.grade) return;
    const h = (Number.isFinite(dt) && dt > 0) ? Math.min(dt, 0.25) : 1 / 60;

    const st = this.state;
    const p = (st && st.player) || null;
    const cam = (st && st.camera) || null;
    const phys = (this.config && this.config.physics) || CONFIG.physics;

    const t = st && Number.isFinite(st.time) ? st.time : 0;
    // Wrapped so the grain hash keeps its precision deep into a long run, and
    // so the value stays identical for a given capture seek.
    this.grade.uniforms.uTime.value = t % 128;

    // --- speed → radial blur ------------------------------------------------
    const maxSpeed = Math.max(1, num(phys && phys.maxSpeed, 24));
    const speed = clamp(num(p && p.speed, 0), 0, maxSpeed * 1.5);
    // Nothing below ~55% of top speed; full effect just past the cap.
    const speedDrive = clamp((speed / maxSpeed - 0.55) / 0.5, 0, 1);

    const shakeRaw = clamp(num(cam && cam.shake, 0), 0, 3);
    this._shake += (shakeRaw - this._shake) * approach(12, h);

    const airDrive = (p && p.airborne) ? 0.12 : 0;
    const wipeDrive = (p && p.wipeout) ? 0.55 : 0;
    const target = clamp(
      speedDrive * 0.85 + this._shake * 0.45 + airDrive + wipeDrive,
      0, 1.2,
    );
    // Ramps up fast (impacts should hit), decays slower.
    const rate = target > this._blur ? 16 : 6;
    this._blur += (target - this._blur) * approach(rate, h);
    this.grade.uniforms.uBlur.value = clamp(this._blur, 0, 1.2);

    // Blur/aberration radiate from screen centre. [FASE 2] point this at the
    // sun's projected NDC position and this becomes a god-ray pass for free.
    this.grade.uniforms.uBlurCenter.value.set(0.5, 0.5);

    this._syncColorPipeline();
  }

  // ------------------------------------------------------------------ render

  /**
   * THE draw call of the game. Always leaves a frame on screen: if anything in
   * the composer throws, post is disabled and we fall back to a direct render
   * from here on.
   */
  render() {
    const renderer = this.renderer;
    if (!renderer || !this.scene || !this.camera) return;

    if (this.ok && this.enabled && this.composer) {
      try {
        // Keep the passes pointed at the live scene/camera objects. The camera
        // rig mutates the same instance, but a Phase-2 module could swap them.
        if (this.renderPass) {
          this.renderPass.scene = this.scene;
          this.renderPass.camera = this.camera;
        }
        renderer.setRenderTarget(null);
        this.composer.render();
        this._failures = 0;
        return;
      } catch (err) {
        this._failures++;
        if (!this._reported) {
          this._reported = true;
          console.warn('[post] render failed, using the direct fallback:', err);
        }
        if (this._failures >= 3) this.ok = false;
      }
    }

    this._fallback();
  }

  /** Plain forward render straight to the canvas. Never allowed to fail loudly. */
  _fallback() {
    try {
      const renderer = this.renderer;
      renderer.setRenderTarget(null);
      renderer.render(this.scene, this.camera);
    } catch (err) {
      // Last line of defence: a console warning beats an exception escaping into
      // main.js' frame loop and stopping the game entirely.
      if (!this._fbReported) {
        this._fbReported = true;
        console.error('[post] direct render failed too:', err);
      }
    }
  }

  // ----------------------------------------------------------------- resize

  /** @param {number} w CSS pixels @param {number} h CSS pixels */
  setSize(w, h) {
    const W = Math.max(1, Math.round(num(w, this._w)));
    const H = Math.max(1, Math.round(num(h, this._h)));
    this._w = W; this._h = H;
    if (!this.ok || !this.composer) return;
    try {
      const pr = Math.max(0.5, this.renderer.getPixelRatio() || 1);
      // setPixelRatio() re-runs setSize internally; call it first so the passes
      // are only resized once with the final effective resolution.
      if (this.composer._pixelRatio !== pr) this.composer.setPixelRatio(pr);
      this.composer.setSize(W, H);
      this._syncResolution();
    } catch (err) {
      console.warn('[post] setSize failed, disabling post:', err);
      this.ok = false;
    }
  }

  // --------------------------------------------------------------- teardown

  _teardown() {
    try {
      if (this.composer) {
        for (const pass of (this.composer.passes || [])) {
          if (pass && typeof pass.dispose === 'function') pass.dispose();
        }
        this.composer.passes = [];
        if (this.composer.renderTarget1) this.composer.renderTarget1.dispose();
        if (this.composer.renderTarget2) this.composer.renderTarget2.dispose();
        if (this.composer.copyPass && this.composer.copyPass.dispose) this.composer.copyPass.dispose();
      }
    } catch (err) {
      console.warn('[post] teardown hiccup:', err);
    }
    this.composer = null;
    this.renderPass = null;
    this.bloom = null;
    this.grade = null;
  }

  dispose() {
    this.ok = false;
    this.enabled = false;
    this._teardown();
  }

  // ------------------------------------------------------- diagnostics / API

  /** Live tweaking hook for Phase 2 and the browser console: `PR.post.set({...})`. */
  set(values = {}) {
    if (!this.grade) return this;
    const u = this.grade.uniforms;
    const scalar = ['uVignette', 'uGrain', 'uChroma', 'uSaturation', 'uContrast',
                    'uShadowAmt', 'uHighAmt', 'uExposure', 'uBlack'];
    for (const k of scalar) {
      if (k in values && Number.isFinite(+values[k])) u[k].value = +values[k];
    }
    if (Number.isFinite(+values.bloomStrength) && this.bloom) this.bloom.strength = +values.bloomStrength;
    if (Number.isFinite(+values.bloomRadius) && this.bloom) this.bloom.radius = +values.bloomRadius;
    if (Number.isFinite(+values.bloomThreshold) && this.bloom) this.bloom.threshold = +values.bloomThreshold;
    if (Array.isArray(values.shadowTint)) u.uShadowTint.value.fromArray(values.shadowTint);
    if (Array.isArray(values.highTint)) u.uHighTint.value.fromArray(values.highTint);
    return this;
  }

  info() {
    return {
      ok: this.ok,
      enabled: this.enabled,
      failures: this._failures,
      passes: this.composer ? this.composer.passes.length : 0,
      size: [this._w, this._h],
      bloom: this.bloom
        ? { strength: this.bloom.strength, radius: this.bloom.radius, threshold: this.bloom.threshold }
        : null,
      blur: this._blur,
    };
  }
}

export default Post;
