// POROROCA RUSH — every tunable in one place.
// Modules read from here; nobody hard-codes a magic number that belongs here.

export const CONFIG = {
  seed: 20260801,

  render: {
    width: 1672,
    height: 941,
    fov: 58,
    fovSpeedGain: 14,        // extra degrees at top speed
    near: 0.25,
    far: 4200,
    exposure: 1.05,
    shadowMapSize: 2048,
    maxPixelRatio: 2,
  },

  // ---------------------------------------------------------------- wave ---
  wave: {
    boreSpeed: 8.6,          // m/s the bore front travels upriver (+Z)
    faceLen: 26.0,           // metres from crest (d=0) down to flat water
    amplitude: 3.1,          // crest height above still-water datum, metres
    amplitudeVar: 0.9,       // lateral variation of crest height
    crestBow: 34.0,          // how far the crest line bows across the channel
    crestWander: 11.0,       // slow lateral meander of the crest line
    faceSteepness: 1.55,     // shaping exponent of the face profile
    lipOverhang: 2.2,        // metres the lip throws forward when barrelling
    trailAmp: 1.15,          // secondary swell train behind the front
    trailLen: 21.0,          // wavelength of the trailing rollers
    trailCount: 5,
    chopAmp: 0.22,
    chopScale: 0.55,
    barrelThreshold: 0.5,    // barrel() above this counts as a rideable tube
    barrelCellSize: 90.0,    // lateral size of a barrelling section
    whitewaterDepth: 34.0,   // metres of foam behind the crest
  },

  // ------------------------------------------------------------- physics ---
  physics: {
    fixedStep: 1 / 120,
    gravity: 9.81,
    maxSpeed: 24.0,          // m/s (~86 km/h)
    cruiseSpeed: 17.0,
    minWaveSpeed: 4.0,
    dragQuad: 0.0125,
    dragLin: 0.16,
    turnRate: 2.15,          // rad/s at cruise
    turnRateLowSpeed: 3.1,
    turnScrub: 0.34,         // speed lost per rad/s of turn
    grip: 7.5,               // how fast velocity aligns to heading
    gripSlipLoss: 0.55,
    pumpGain: 6.2,           // m/s² while pumping in phase
    pumpWindow: 0.42,        // seconds of the good part of the pump cycle
    brakeDecel: 9.0,
    leanRate: 4.4,
    faceGravityScale: 1.25,  // arcade boost on down-face acceleration
    flowCarry: 0.62,         // how much of the water's velocity you inherit
    loseBehind: 7.0,         // d below -this → dropped over the back
    loseAhead: 9.0,          // d beyond faceLen + this → outran the wave
    launchSpeedMin: 11.0,    // m/s needed to boost off the lip
    launchGain: 0.72,
    airDrag: 0.045,
    airSteer: 1.8,
    landAngleTolerance: 0.72, // radians of pitch error before a landing fails
    wipeoutTime: 2.4,
    recoverTime: 1.1,
  },

  // -------------------------------------------------------------- tricks ---
  tricks: {
    snapD: 4.5,              // within this many metres of the lip counts as a snap
    cutbackAngle: 2.09,      // 120°
    cutbackMinSpeed: 9.0,
    floaterMinTime: 0.4,
    slideAngle: 0.42,        // slip angle for a tail slide
    tubePointsPerSec: 900,
    tubeExitBonus: 4500,
    airBase: 1200,
    airPerSecond: 900,
    rot360: 2600,
    rot540: 5200,
    rot720: 9000,
    grabMult: 1.45,
    cutbackPoints: 1400,
    snapPoints: 1100,
    floaterPoints: 1600,
    slidePoints: 700,
    cleanLandingMult: 1.0,
    sketchyLandingMult: 0.45,
  },

  // ------------------------------------------------------------- scoring ---
  scoring: {
    comboWindow: 4.2,        // seconds before the multiplier starts dropping
    comboMax: 20,
    comboStep: 1,
    decayRate: 1.0,          // multiplier lost per second once the window expires
  },

  // ---------------------------------------------------------------- race ---
  race: {
    checkpoints: 12,
    // Read off the concept art: 7/12 at 1,2 KM and 9/12 at 1,4 KM imply ~12
    // checkpoints every ~167 m over a ~2 km course. At boreSpeed that is a ~3.9 min
    // run — and a capture at t≈140 s lands on "7 / 12 · 1,2 KM", matching the art.
    courseLength: 2000,      // metres, start to finish
    name: 'POROROCA DO ARARI',
    objective: 'SURFE ATÉ A CHEGADA',
  },

  // --------------------------------------------------------------- world ---
  world: {
    riverWidth: 340,         // metres bank to bank
    riverWidthVar: 70,
    riverMeander: 210,       // lateral meander amplitude of the channel
    riverMeanderLen: 1500,
    streamAhead: 900,        // metres of world kept ahead of the player
    cullBehind: 260,
    bankHeight: 7.0,
    treeCount: 2600,
    houseCount: 46,
    boatCount: 54,
    logCount: 90,
    obstacleDensity: 0.055,  // obstacles per metre of river
  },

  // ------------------------------------------------------------- camera ---
  camera: {
    // --- de tras (a familia principal: e de onde se surfa) ---
    pov:      { dist: 0.15, height: 1.58, lookAhead: 15.0, side: 0.0, pitch: 0.01 },
    tail:     { dist: 3.1,  height: 0.72, lookAhead: 12.0, side: 0.0, pitch: 0.03 },
    chaseLow: { dist: 4.7,  height: 1.35, lookAhead: 10.5, side: 0.0, pitch: -0.02 },
    chase:    { dist: 6.4,  height: 2.35, lookAhead: 9.0, side: 0.0,  pitch: -0.06 },
    chaseFar: { dist: 13.5, height: 5.4,  lookAhead: 7.0, side: 0.0,  pitch: -0.15 },
    // --- outros angulos ---
    front:  { dist: 9.5, height: 2.05, lookAhead: -6.0, side: 0.0, pitch: -0.02 },
    side:   { dist: 17.0, height: 4.2, lookAhead: 4.0, side: 15.0, pitch: -0.10 },
    aerial: { dist: 42.0, height: 68.0, lookAhead: 40.0, side: 0.0, pitch: -0.78 },
    smooth: 6.5,
    shakeSpeed: 0.35,
    shakeImpact: 1.6,
    tubeTighten: 0.55,
  },

  // ---------------------------------------------------------------- look ---
  // Colours sampled from the concept art. Linear-space sRGB hex.
  look: {
    sunColor: 0xffd9a0,
    // GLARE BUDGET — the chase camera stares down the sun's azimuth over water,
    // and the wave body is a MeshStandardMaterial at roughness 0.35. At grazing
    // incidence its specular lobe covers most of the frame, so `sunIntensity` is
    // the single biggest lever on into-sun legibility: hiding the wave mesh took
    // the clipped-pixel count from 4.2% to 0.3%. It came down from 4.4, and the
    // brightness lost is paid back through `ambientIntensity` below, which is
    // directionless and therefore lifts the away-from-sun views without feeding
    // that lobe at all.
    sunIntensity: 1.9,
    sunElevation: 0.055,     // radians above the horizon
    sunAzimuth: 0.0,         // 0 = straight down the river (+Z)
    skyTop: 0x2e3646,
    skyHorizon: 0xffa64a,
    ambientSky: 0xffbe7a,
    ambientGround: 0x2a1c10,
    ambientIntensity: 1.60,  // pays back the sun cut without adding to its lobe
    fogColor: 0xd08a45,
    fogNear: 90,
    fogFar: 2400,
    fogDensity: 0.0016,
    waterDeep: 0x4a2c12,
    waterShallow: 0x9c6a30,
    waterTint: 0xc08a45,
    foamColor: 0xe8d6b4,
    foamDeep: 0xc9ab7e,
    jungleDark: 0x101a10,
    jungleLit: 0x3c4a22,
    // -- glare budget (measured with tools/glare.mjs; see src/gfx/post.js) ----
    // The dome is now BRIGHTER than it started (1.0 → 1.5) and the frame is far
    // darker than it started. That is the whole point: the sky was never what
    // blinded the player. Lifting the dome while the water came down is what
    // buys the jungle its silhouette and the frame its dynamic range — chase
    // p95 went 152 → 170 on this knob alone with p05 and p50 unmoved.
    skyGain: 1.50,           // diffuse dome radiance multiplier
    sunGlare: 2.20,          // solar disc — kept hot on purpose, it IS the sun
    sunHalo: 1.20,           // wide forward-scatter halo + horizon hot band
    exposure: 1.12,          // look trim on top of CONFIG.render.exposure
    blackPoint: 0.020,       // linear black subtracted before the tone map
    saturation: 1.14,        // the frame is amber; saturation is what keeps it
    contrast: 1.03,          // from reading as "washed out" rather than "bright"
    // radius is a mip crossfade, NOT a size: 0.72 weighted the 1/16 and 1/32
    // mips hardest and smeared the sun over the whole frame as a flat veil —
    // that veil alone was ~60/255 of lift on every pixel of the frame.
    // threshold is LINEAR HDR luminance, and the diffuse sky lives near
    // 0.6..1.4 there, so only the disc and the specular glitter clear 2.4.
    bloomStrength: 0.60,
    bloomRadius: 0.22,
    bloomThreshold: 2.4,
    vignette: 0.40,
    grainAmount: 0.022,
    chromaticAberration: 0.0016,
  },
};

// Derived helpers used across modules.
export const KMH = 3.6;
export const TAU = Math.PI * 2;
