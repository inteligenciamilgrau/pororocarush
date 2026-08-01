// The single mutable GameState. Every system reads and writes this object.
// Keep it flat, plain and JSON-serialisable so the capture harness can diff runs.

import { CONFIG } from '../config.js';

export function createState() {
  return {
    time: 0,          // simulation seconds since the run started
    dt: 0,
    frame: 0,
    running: true,
    paused: false,
    phase: 'ride',    // 'intro' | 'ride' | 'wipeout' | 'recover' | 'finish'
    slowmo: 1,        // time scale applied by race.js during wipeouts

    bore: {
      z: 0,           // world Z of the crest reference (advances at boreSpeed)
      speed: CONFIG.wave.boreSpeed,
    },

    player: {
      // World transform. The run starts mid-ride — already up and trimming — not
      // from a dead stop at the origin: a surf game has no "start line", and a
      // zero-velocity spawn leaves the camera rig without a ride axis to orient
      // itself against, so it cannot know where "behind the surfer" is.
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: CONFIG.physics.cruiseSpeed * 0.72,
      heading: 0,     // radians, 0 = +Z — running with the bore, camera behind
      pitch: 0, roll: 0,
      speed: CONFIG.physics.cruiseSpeed * 0.72,
      lean: 0,        // -1..1 rail lean, drives board roll and spray
      crouch: 0,      // 0..1, tuck for the tube

      // wave-relative
      d: 8,           // z - crest(x, t)
      faceT: 0.3,     // 0 at the lip, 1 at flat water
      slope: 0,       // face slope in radians at the surfer
      surfaceY: 0,    // water height under the surfer

      onWave: true,
      airborne: false,
      airTime: 0,
      inTube: false,
      tubeTime: 0,
      deepTube: 0,    // 0..1 how deep in the throat

      pumpPhase: 0,
      spraySlip: 0,   // 0..1 lateral slip, drives the rail spray emitter
      gForce: 1,

      wipeout: false,
      wipeoutTimer: 0,
      wipeoutReason: null,
    },

    trick: {
      active: null,   // name of the manobra in progress
      rotation: 0,    // accumulated yaw this air, radians
      grab: false,
      airPeak: 0,
      lastLanded: null,
      lastPoints: 0,
      banner: null,   // { text, points, until } for the HUD
    },

    score: {
      points: 0,
      combo: 1,
      comboTimer: 0,  // 0..1 fill of the HUD meter
      bestCombo: 0,
      bestComboPoints: 0,
      lastGain: 0,
    },

    race: {
      checkpoint: 0,
      total: CONFIG.race.checkpoints,
      distance: 0,        // metres travelled
      distanceToNext: 0,  // metres
      finished: false,
      heading: 'S',       // compass label for the HUD tape
      bearing: 180,       // degrees
    },

    input: {
      steer: 0,       // -1..1
      throttle: 0,    // 0..1
      brake: 0,       // 0..1
      jump: false,
      jumpPressed: false,
      grab: false,
      crouch: false,
      spin: 0,        // -1..1 air spin
      camCycle: false,
    },

    camera: {
      mode: 'chase',
      shake: 0,
      fov: CONFIG.render.fov,
      // Player look, written by core/input.js and consumed by game/camera.js.
      // The rig orbits its position around the aim point, so the surfer stays
      // framed no matter where the player points.
      lookYaw: 0,     // radians, + orbits right
      lookPitch: 0,   // radians, + orbits up
      zoom: 1,        // multiplier on the standoff distance
    },

    debug: { physics: false, wireframe: false, freeze: false },
  };
}
