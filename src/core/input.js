// Keyboard + gamepad → state.input. Deterministic under capture (scripted) mode.

const clampAngle = (v, lim) => (v < -lim ? -lim : v > lim ? lim : v);

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  Space: 'jump',
  ShiftLeft: 'crouch', ShiftRight: 'crouch',
  KeyQ: 'spinL', KeyE: 'spinR',
  KeyG: 'grab', KeyJ: 'grab',
  KeyC: 'cam',
  KeyP: 'pause',
  KeyR: 'reset',
};

export class Input {
  constructor(state, opts = {}) {
    this.state = state;
    this.scripted = !!opts.capture;
    this.opts = null;   // player preferences, set by the options menu
    this.keys = new Set();
    this.pressed = new Set();
    this._steer = 0;
    this._prevJump = false;

    if (!opts.headless) {
      this._onDown = (e) => {
        const k = KEYMAP[e.code];
        if (!k) return;
        if (!this.keys.has(k)) this.pressed.add(k);
        this.keys.add(k);
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      };
      this._onUp = (e) => { const k = KEYMAP[e.code]; if (k) this.keys.delete(k); };
      this._onBlur = () => this.keys.clear();
      window.addEventListener('keydown', this._onDown);
      window.addEventListener('keyup', this._onUp);
      window.addEventListener('blur', this._onBlur);
      this._initMouse();
    }
  }

  // ------------------------------------------------------------------- mouse
  // Drag to orbit, wheel to zoom. Writes state.camera.{lookYaw,lookPitch,zoom};
  // game/camera.js orbits the rig around its aim point, so the surfer can never
  // be lost off-frame no matter where the player points.
  //
  // Drag-to-look rather than always-on pointer lock: pointer lock hijacks the
  // cursor the moment you click, which is hostile on a page you might want to
  // leave. Players who prefer it can turn it on in the options menu.
  _initMouse() {
    const st = this.state;
    this.mouse = { dragging: false, lastX: 0, lastY: 0, idle: 0, locked: false };
    const canvas = document.getElementById('gl') || window;

    const sens = () => (this.opts?.mouseSensitivity ?? 1) * 0.0038;
    const invert = () => (this.opts?.invertMouseY ? -1 : 1);
    const enabled = () => this.opts?.mouseLook !== false;

    const applyDelta = (dx, dy) => {
      if (!enabled()) return;
      st.camera.lookYaw = clampAngle(st.camera.lookYaw + dx * sens(), Math.PI * 0.92);
      st.camera.lookPitch = clampAngle(st.camera.lookPitch - dy * sens() * invert(), 1.05);
      this.mouse.idle = 0;
    };

    this._onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (!enabled()) return;
      // Never grab the pointer while the options overlay is up — the player is
      // trying to click a control, not look around.
      if (this.state.paused) return;
      if (this.opts?.pointerLock !== false && canvas.requestPointerLock) {
        if (document.pointerLockElement !== canvas) {
          const r = canvas.requestPointerLock();
          if (r && typeof r.catch === 'function') r.catch(() => { /* user gesture rejected */ });
        }
        return;
      }
      this.mouse.dragging = true;
      this.mouse.lastX = e.clientX; this.mouse.lastY = e.clientY;
    };
    this._onMouseUp = () => { this.mouse.dragging = false; };
    this._onMouseMove = (e) => {
      if (this.mouse.locked) { applyDelta(e.movementX || 0, e.movementY || 0); return; }
      if (!this.mouse.dragging) return;
      applyDelta(e.clientX - this.mouse.lastX, e.clientY - this.mouse.lastY);
      this.mouse.lastX = e.clientX; this.mouse.lastY = e.clientY;
    };
    this._onWheel = (e) => {
      if (!enabled()) return;
      e.preventDefault();
      const z = st.camera.zoom * (1 + Math.sign(e.deltaY) * 0.11);
      st.camera.zoom = Math.min(2.6, Math.max(0.4, z));
      this.mouse.idle = 0;
    };
    this._onLockChange = () => {
      const was = this.mouse.locked;
      this.mouse.locked = document.pointerLockElement === canvas;
      if (!this.mouse.locked) {
        this.mouse.dragging = false;
        // The browser releases the pointer on ESC and fires this before our
        // keydown handler. Mark it so hud/menu.js can let that one ESC go by:
        // the player meant "give me my cursor back", not "open the menu".
        if (was) this._lockReleasedAt = performance.now();
      }
      this.state.camera.pointerLocked = this.mouse.locked;
    };
    this.wasLockReleasedJustNow = () => (performance.now() - (this._lockReleasedAt || -1e9)) < 250;
    // Middle click snaps the view back to the rig's default framing.
    this._onAux = (e) => { if (e.button === 1) { e.preventDefault(); this.recenterView(); } };

    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('auxclick', this._onAux);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  recenterView() {
    const c = this.state.camera;
    c.lookYaw = 0; c.lookPitch = 0; c.zoom = 1;
  }

  // Eases the view back to default after the player stops looking around, so a
  // stray drag does not leave the camera stuck at a useless angle forever.
  _stepMouse(dt) {
    const m = this.mouse;
    if (!m || m.dragging || m.locked) return;
    if (this.opts?.autoRecenter === false) return;
    const c = this.state.camera;
    if (!c.lookYaw && !c.lookPitch) return;
    m.idle += dt;
    if (m.idle < 1.6) return;
    const k = Math.min(1, dt * 1.7);
    c.lookYaw += (0 - c.lookYaw) * k;
    c.lookPitch += (0 - c.lookPitch) * k;
    if (Math.abs(c.lookYaw) < 1e-3) c.lookYaw = 0;
    if (Math.abs(c.lookPitch) < 1e-3) c.lookPitch = 0;
  }

  setScripted(on) { this.scripted = !!on; }

  step(dt) {
    if (this.scripted) { this.pressed.clear(); return; } // capture.js drives state.input
    this._stepMouse(dt);

    const i = this.state.input;
    const k = this.keys;
    const pad = this._gamepad();

    // Steering: smoothed so keyboard feels analogue.
    //
    // Sign note: +steer turns the board toward world +X (see the heading contract),
    // and because the camera looks down +Z in a right-handed frame, world +X lands
    // on the LEFT of the screen. So "press right, go right" needs the mapping
    // inverted here. Doing it at the input boundary keeps every downstream sign
    // (lean → board roll → rail spray → surfer pose) internally consistent, and
    // leaves the scripted capture path — which writes state.input directly — alone.
    let targetSteer = (k.has('left') ? 1 : 0) - (k.has('right') ? 1 : 0);
    if (pad) targetSteer = Math.abs(pad.axes[0]) > 0.14 ? -pad.axes[0] : targetSteer;
    // Player preferences from the options menu.
    const o = this.opts;
    if (o) {
      if (o.invertSteer) targetSteer = -targetSteer;
      if (o.steerSensitivity) targetSteer = Math.max(-1, Math.min(1, targetSteer * o.steerSensitivity));
    }
    const rate = 7.5;
    this._steer += (targetSteer - this._steer) * Math.min(1, rate * dt);
    i.steer = Math.abs(this._steer) < 0.004 ? 0 : this._steer;

    i.throttle = k.has('up') ? 1 : 0;
    i.brake = k.has('down') ? 1 : 0;
    if (pad) {
      i.throttle = Math.max(i.throttle, pad.buttons[7]?.value ?? 0); // RT
      i.brake = Math.max(i.brake, pad.buttons[6]?.value ?? 0);       // LT
    }

    const jump = k.has('jump') || !!pad?.buttons[0]?.pressed;
    i.jumpPressed = jump && !this._prevJump;
    i.jump = jump;
    this._prevJump = jump;

    i.crouch = k.has('crouch') || !!pad?.buttons[1]?.pressed;
    i.grab = k.has('grab') || !!pad?.buttons[2]?.pressed;
    // Same inversion as steering — spin feeds the same yaw term in physics.js,
    // so E must spin the way the player sees "clockwise".
    i.spin = (k.has('spinL') ? 1 : 0) - (k.has('spinR') ? 1 : 0);
    if (pad && Math.abs(pad.axes[2] ?? 0) > 0.2) i.spin = -pad.axes[2];

    i.camCycle = this.pressed.has('cam');
    i.resetPressed = this.pressed.has('reset');
    // P / ESC belong to hud/menu.js, which owns `state.paused` while the overlay
    // is up. Toggling it here too soft-locked the game: main.js skips the whole
    // sim (and therefore input.step) while paused, so the 'pause' press stayed
    // queued in `this.pressed` and fired the instant the menu released the pause,
    // re-pausing behind a closed overlay. One owner per key.

    this.pressed.clear();
  }

  _gamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('auxclick', this._onAux);
    window.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
