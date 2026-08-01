// Keyboard + gamepad → state.input. Deterministic under capture (scripted) mode.

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
    }
  }

  setScripted(on) { this.scripted = !!on; }

  step(dt) {
    if (this.scripted) { this.pressed.clear(); return; } // capture.js drives state.input

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
  }
}
