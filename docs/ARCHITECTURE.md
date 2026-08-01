# POROROCA RUSH — Architecture Contract

**Read this fully before writing any code.** Every module boundary below is a hard
contract. Other agents implement the modules on the other side of your boundary in
parallel — if you change a signature, the build breaks.

Engine: **three.js r180**, ES modules, no bundler. Served from `/` by `tools/serve.mjs`.
Import map in `index.html` maps `three` and `three/addons/`.

---

## 0. The game in one paragraph

You surf the **pororoca** — the Amazon tidal bore, a continuous wall of water that
travels *upriver* for kilometres. Unlike ocean surf the wave never closes out: the
ride is limited only by your ability to hold the face. You carve the muddy brown
face at sunset, thread barrels where the lip pitches, boost airs off the lip, and
dodge floating logs, canoes, riverboats and stilt-house pilings. Checkpoints tick
by (7/12, 9/12 …) as distance accumulates. Tricks and tube time build a combo
multiplier that decays if you stop performing.

---

## 1. Coordinate system (non-negotiable)

- **+X** = lateral, across the river (left bank negative, right bank positive).
- **+Y** = up. `y = 0` is the still-water datum.
- **+Z** = along the river, **the direction the bore travels** (upriver).
- The bore crest is a curved line across the river: `zc = crest(x, t)`.
- **Face coordinate `d = z - zc(x, t)`**:
  - `d = 0` → exactly on the crest / lip.
  - `d > 0` → **ahead** of the crest, on the unbroken face sloping down to flat
    water. This is the surfable pocket. The face runs `d ∈ [0, FACE_LEN]`.
  - `d < 0` → **behind** the crest: the broken, elevated, turbulent whitewater.
    Falling back here means losing the wave.
- **Normalised face param `faceT = clamp(d / FACE_LEN, 0, 1)`**: `0` = lip,
  `1` = trough / flat water ahead.
- **Heading `ψ`**: radians, `0` = facing +Z (same way the bore travels),
  `+ψ` rotates toward +X. Standard `atan2(vx, vz)`.

Because the bore advances at `BORE_SPEED` forever, all world content is authored in
a **scrolling frame**: `world/` streams banks, props and obstacles as `z` advances,
and recycles anything more than `CULL_BEHIND` metres behind the player.

---

## 2. Module map — one owner per file

| File | Owns |
|---|---|
| `src/config.js` | All tunables. **Already written — read it, do not restructure it.** |
| `src/core/state.js` | The GameState object + factory. **Already written.** |
| `src/core/bus.js` | Tiny event emitter. **Already written.** |
| `src/core/input.js` | Keyboard + gamepad → `state.input`. |
| `src/wave/bore.js` | Wave field maths. CPU + matching GLSL. **The single source of truth for wave geometry.** |
| `src/wave/waveMesh.js` | Wave surface mesh + shader, whitewater, lip, tube geometry. |
| `src/wave/foam.js` | Foam/spray/mist particle systems driven by wave + player. |
| `src/world/river.js` | River channel, banks geometry, flat-water plane ahead of the bore. |
| `src/world/scenery.js` | Jungle, palafitas (stilt houses), moored boats, streaming + instancing. |
| `src/world/obstacles.js` | Floating logs, canoes, riverboats, debris. Spawn, stream, collide. |
| `src/player/physics.js` | Surf physics solver. |
| `src/player/tricks.js` | Trick/manobra state machine + scoring hooks. |
| `src/player/surfer.js` | Surfer + board mesh, pose/animation driven by physics state. |
| `src/game/camera.js` | Camera rig: chase / front / side / aerial + shake, FOV, look-ahead. |
| `src/game/scoring.js` | Points, combo, multiplier, decay. |
| `src/game/race.js` | Checkpoints, distance, run start/finish, wipeout & recovery flow. |
| `src/hud/hud.js` + `src/hud/hud.css` | DOM HUD matching the concept art exactly. |
| `src/gfx/sky.js` | Sky dome, sun, clouds, atmosphere, fog. |
| `src/gfx/lighting.js` | Sun/ambient/IBL rig, shadows, colour grading inputs. |
| `src/gfx/post.js` | Post stack: bloom, tonemap, DOF, motion blur, grade, vignette. |
| `src/main.js` | Bootstrap + game loop. **Owned by the integrator — do not edit.** |
| `src/capture.js` | Deterministic screenshot API. **Owned by the integrator — do not edit.** |

**Rule: only write the file(s) you were assigned.** If you need something from a
neighbour, use the documented interface. If the interface is missing something,
say so in your report — do not reach into another module's internals.

---

## 3. Interfaces

### 3.1 `src/wave/bore.js` — `class BoreWave`

The wave field. Every other system asks *this* where the water is.

```js
new BoreWave(config)            // config = CONFIG.wave

// --- geometry ---
crest(x, t)          -> number   // world Z of the crest line at lateral x
height(x, z, t)      -> number   // water surface Y at world (x,z)
normal(x, z, t, out) -> Vector3  // unit surface normal (fills `out` if given)
faceParam(x, z, t)   -> { d, faceT, slope, downhill:Vector2 }
                                 // slope = radians of the face at that point,
                                 // downhill = unit XZ direction of steepest descent
amplitude(x, t)      -> number   // crest height above datum at lateral x
barrel(x, t)         -> 0..1     // how hard the lip is pitching here (tube-ness)
tubePocket(x, t)     -> { inner:number, outer:number, roof:number } | null
                                 // d-range of the barrel throat and its roof height
flow(x, z, t, out)   -> Vector2  // surface water velocity (m/s) in XZ
breakIntensity(x,t)  -> 0..1     // how violently the lip is breaking (whitewater)

// --- shader parity ---
BoreWave.GLSL        -> string   // GLSL source implementing the SAME functions:
                                 //   float pr_crest(float x, float t);
                                 //   float pr_height(float x, float z, float t);
                                 //   vec3  pr_normal(float x, float z, float t);
                                 //   float pr_barrel(float x, float t);
                                 //   float pr_breakIntensity(float x, float t);
                                 // and the uniforms it needs, declared in
                                 // BoreWave.GLSL_UNIFORMS (a plain object usable
                                 // as three.js `uniforms`).
uniforms(t)          -> void     // refresh the shared uniform objects for time t
```

**CPU and GPU must agree.** Author the field maths once, mirror it in GLSL, and keep
the constants in `CONFIG.wave` so both read the same numbers. Any drift shows up
instantly as the surfer floating above or sinking into the mesh — that is the single
most visible failure mode in this whole project.

Shape guidance: the crest is not a straight line — it bows and wanders across the
channel (see `imagens_conceito/pororoca_rush_cima.png`). The face is steepest near
`d = 0` and eases into flat water. Superimpose 3–5 travelling sine/gerstner
harmonics for the secondary swell train behind the bore (the concept art shows
repeating rollers behind the main front), plus fBm detail for chop.

### 3.2 `src/player/physics.js` — `class SurfPhysics`

```js
new SurfPhysics(state, bore, config)   // config = CONFIG.physics
step(dt)        -> void   // integrate one fixed step, mutate state.player
launch(power)   -> void   // called by tricks.js to start an air
land()          -> void   // called by tricks.js on landing
wipeout(reason) -> void   // force a wipeout ('log' | 'overTheFalls' | 'lostWave' | 'nose')
reset(opts)     -> void   // place the surfer back in the pocket
```

Model (arcade-realistic; feel beats simulation fidelity):

1. **Face gravity.** The face is a slope. `a_g = G * sin(slope)` along `downhill`.
   Riding toward the lip (`-d`) costs speed; dropping down the face gains it.
2. **Rail carve.** Velocity is redirected toward `heading` at a rate proportional
   to `gripFactor(speed, lean)`. Lateral slip is damped hard — this is what makes
   a board feel like a board and not a boat. Slip that survives becomes spray.
3. **Pump.** Holding accelerate while crossing the face converts vertical travel
   into speed (the real mechanic surfers use). Reward rhythm, not mashing.
4. **Wave carry.** `bore.flow()` adds the water's own velocity, so sitting in the
   pocket keeps you moving with the bore even at low board speed.
5. **Drag.** Quadratic in speed, plus a turn-rate penalty so hard carving scrubs
   speed and trimming is fast.
6. **Loss conditions.**
   - `d < -LOSE_BEHIND` → dropped over the back into the whitewater → `lostWave`.
   - `d > FACE_LEN + LOSE_AHEAD` → outran the wave onto flat water → `lostWave`.
   - Nose-dive at high `faceT` with steep downward pitch → `nose` (pearl).
   - Landing an air on the flat with too much rotation error → wipeout.
7. **Air.** While `airborne`, integrate ballistically in Y; land when
   `y <= bore.height(x, z, t)`. Landing angle vs. surface normal decides clean
   vs. wipeout.

Write `state.player.{x,z,y,vx,vy,vz,heading,speed,lean,d,faceT,slope,onWave,airborne,inTube,tubeTime,crouch,pumpPhase,wipeout,wipeoutTimer,gForce,spraySlip}`.

Feel targets: cruising ≈ 14–20 m/s (the HUD reads km/h, so 50–75 km/h — matching
the concept art's 68 and 72). Full carve lock-to-lock ≈ 0.9 s. Airs hang 0.8–1.6 s.

### 3.3 `src/player/tricks.js` — `class TrickSystem`

```js
new TrickSystem(state, bore, physics, bus, config)
step(dt) -> void
```

Detects and scores, emitting on the bus:

| Manobra | Trigger | Feel |
|---|---|---|
| **Tubo (barrel)** | inside `bore.tubePocket()` with `barrel > 0.5` | continuous points while inside; huge exit bonus |
| **Aéreo** | leaves the lip upward above a speed threshold | scored on rotation + grab + clean landing |
| **Rotação (360/540/720)** | accumulated yaw while airborne | 360 → 540 → 720 tiers |
| **Grab** | grab input held in air | multiplies the air score |
| **Cutback** | ≥120° direction reversal on the face without losing speed | classic; chains combos |
| **Rasgada / snap** | hard turn within `SNAP_D` of the lip | short, sharp, high value |
| **Floater** | riding *on top* of the broken lip for ≥0.4 s | risky, keeps combo alive |
| **Tail slide** | slip angle over threshold while carving | style points |

Bus events: `trick:start`, `trick:land {name, points, rotation, clean}`,
`trick:fail {name}`, `tube:enter`, `tube:exit {duration, points}`, `combo:up`.

### 3.4 `src/game/scoring.js` — `class Scoring`
```js
new Scoring(state, bus, config)
step(dt) -> void
```
Points, `combo` (integer multiplier shown as `x7`), `comboTimer` (fills the vertical
gradient meter in the HUD), `bestCombo`. Combo decays over `COMBO_WINDOW` seconds
with no scoring action, and resets to 1 on wipeout.

### 3.5 `src/game/race.js` — `class Race`
```js
new Race(state, bus, config)
step(dt) -> void
```
12 checkpoints, `distance` in km, `distanceToNext`, run start/finish, wipeout →
recovery (brief slow-mo + reset into the pocket, combo lost, no hard game-over).
Emits `race:checkpoint {index,total}`, `race:finish`, `player:wipeout {reason}`.

### 3.6 `src/game/camera.js` — `class CameraRig`
```js
new CameraRig(camera, state, bore, config)
setMode(mode)  // 'chase' | 'front' | 'side' | 'aerial' | 'free'
step(dt) -> void
```
Four modes matching the four concept images — see §5. Speed-driven FOV, impact and
wave shake, look-ahead into turns, tube framing (pulls tight and low when
`inTube`), and a hard rule: **never clip through the water surface**.

### 3.7 `src/world/obstacles.js` — `class Obstacles`
```js
new Obstacles(scene, state, bore, config)
step(dt) -> void
query(x, z, r) -> hit | null    // used by physics for collision
```
Streaming logs / canoes / riverboats / debris that float on `bore.height()`.
Collision → `physics.wipeout('log')` or a speed-scrubbing graze.

### 3.8 `src/hud/hud.js` — `class HUD`
```js
new HUD(root, state, bus)
step(dt) -> void
```
DOM overlay. Must reproduce the concept art layout **exactly** — see §5.

### 3.9 Renderer-side modules

`sky.js`, `lighting.js`, `post.js`, `waveMesh.js`, `foam.js`, `river.js`,
`scenery.js`, `surfer.js` each export a class with the same shape:

```js
new Thing(ctx)      // ctx = { scene, renderer, camera, state, bore, config, assets }
step(dt) -> void    // per-frame update
dispose() -> void
```

so `main.js` can drive them uniformly.

---

## 4. Determinism & the capture API

`src/capture.js` exposes `window.PR_CAPTURE`:

```js
{ ready:boolean, seek(t, {cam, hud}), setCam(mode), state }
```

`seek(t)` fast-forwards the simulation in **fixed 1/120 s steps** from t=0 to t,
then renders. Every system must therefore be:

- **Deterministic** — no `Math.random()` at simulation time. Use the seeded RNG in
  `src/core/rng.js` (`rng(seed)` → function returning 0..1). Authoring-time
  randomness (scattering trees at load) must also be seeded.
- **Frame-rate independent** — integrate with `dt`, never per-frame constants.

This is what makes v1/v2/v3 screenshots comparable. Breaking determinism makes the
whole review loop meaningless.

---

## 5. Visual target — read the concept art

`imagens_conceito/` holds four frames. They are the spec, not inspiration:

- `pororoca_rush_capa.png` — **chase**: over the surfer's shoulder, board bottom-left,
  wave face filling the left third, village on the right bank.
- `pororoca_rush_frente.png` — **front**: reverse-angle, surfer coming at camera,
  the whole bore front breaking behind them, sun dead centre.
- `pororoca_rush_lado.png` — **side**: profile of the ride, logs in the foreground,
  both banks visible, wave shoulder unbroken to the right.
- `pororoca_rush_cima.png` — **aerial**: high drone shot, the bore crossing the
  entire channel as one curved white line, boats scattered, village both banks.

Shared palette and mood — hit these:

- Golden hour, sun low and **centred on the river's vanishing point**, heavy
  atmospheric haze, visible god rays through the canopy.
- Water is **opaque muddy ochre-brown** (`#8a5a28`–`#c08a45`), not blue, not
  transparent. Sun glitter path is the brightest thing on the water.
- Foam is **warm tan/cream** (`#d9c09a`–`#f0e2c8`), never white — it is silt-laden.
- Banks: near-black jungle silhouettes with rim light on the canopy edge.
- **Palafitas** (stilt houses) with corrugated metal roofs, weathered wood, and
  saturated paint — teal, red, ochre — on both banks.
- Wooden canoes and riverboats moored and drifting; floating logs everywhere.
- Sky: banded orange→amber→slate cloud, birds, warm bloom around the sun.

HUD layout (all four frames share it exactly):

- **Top-left**: `POROROCA RUSH` logo — white brush-script `POROROCA` over orange
  italic `RUSH` with speed streaks.
- **Left**: `PONTUAÇÃO` + big number + `PTS`; below, `MELHOR COMBO` + number.
- **Lower-left**: `COMBO` + big `x7`, and a vertical segmented meter that runs
  yellow → orange → red.
- **Top-centre**: compass tape (`SE · S · SW`) with a diamond marker.
- **Centre**: `CHECKPOINT` pill, `7 / 12`, distance `1,2 KM` in amber.
- **Top-right**: `VELOCIDADE`, huge `68`, `KM/H`, and an arc gauge under it.
- **Right**: `POROROCA DO ARARI` in amber, `SURFE ATÉ A CHEGADA` with a diamond.
- **Bottom-right**: circular minimap — river spline, player arrow, checkpoint pins.
- **Bottom-left**: control hints `Ⓛ DIREÇÃO · RT ACELERAR · LT FREAR · Ⓑ SAIR`.

Type is condensed, italic, uppercase, with hard drop shadows. Portuguese only.

---

## 6. Quality bar

- 1664×936 at 60 fps on a mid GPU; the capture harness runs on software GL, so
  keep an eye on draw calls (target < 400) and use instancing for scenery.
- No visible seams, z-fighting, popping LODs, or geometry poking through water.
- Everything AAA is in the *transitions*: foam that builds where the lip breaks,
  spray that follows the rail, light that changes as you enter the barrel.
