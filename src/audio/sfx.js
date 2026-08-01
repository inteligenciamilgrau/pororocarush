// Procedural one-shot effects and lightweight water ambience. Unlike the music,
// these sounds are short and event-driven, so Web Audio gives variety without a
// meaningful continuous CPU cost or a folder full of tiny files.

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number(v) || 0));

export class SoundEffects {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = ctx.state;
    this.bus = ctx.bus;
    this.enabled = true;
    this.volume = 0.78;
    this.paused = false;
    this.started = false;
    this.audio = null;
    this.master = null;
    this.noise = null;
    this.variant = 0xA51CE55;
    this.noiseCursor = 0;
    this.proximityTimer = 0;
    this.nextBoatSound = 0;
    this.nextWoodSound = 0;
    this.offs = [];
    this._bind();
  }

  set({ enabled, volume } = {}) {
    if (enabled !== undefined) this.enabled = enabled !== false;
    if (volume !== undefined) this.volume = clamp(volume);
    this._applyVolume();
  }

  start() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!this.audio) {
      this.audio = new AudioCtor({ latencyHint: 'interactive' });
      this._build();
    }
    this.started = true;
    this._applyVolume();
    if (this.audio.state === 'suspended') this.audio.resume().catch(() => {});
  }

  setPaused(paused) {
    const next = !!paused;
    if (next === this.paused) return;
    this.paused = next;
    this._applyVolume();
  }

  step(dt) {
    if (!this.audio || !this.started) return;
    const p = this.state.player || {};
    const speed = clamp((p.speed || 0) / 22);
    const crest = 1 - clamp(p.faceT ?? 0.5);
    const spray = clamp(Math.abs(p.spraySlip || 0) * 0.9 + Math.abs(p.lean || 0) * 0.18);
    const inTube = p.inTube ? 1 : 0;
    const grounded = p.airborne ? 0.2 : 1;
    const now = this.audio.currentTime;

    this.waterGain.gain.setTargetAtTime((0.015 + speed * 0.026) * grounded, now, 0.12);
    this.waveGain.gain.setTargetAtTime(0.018 + crest * 0.035 + inTube * 0.12, now, 0.14);
    this.sprayGain.gain.setTargetAtTime((0.004 + spray * 0.055 + speed * 0.008) * grounded, now, 0.07);
    this.waveFilter.frequency.setTargetAtTime(inTube ? 430 : 820 + speed * 520, now, 0.12);

    this.proximityTimer -= dt;
    if (this.proximityTimer <= 0) {
      this.proximityTimer = 0.45;
      this._nearbyProps(now, p);
    }
  }

  _bind() {
    if (!this.bus?.on) return;
    const on = (event, fn) => {
      const off = this.bus.on(event, (payload) => {
        if (!this.started || !this.enabled || this.paused) return;
        try { fn(payload || {}); } catch { /* sound must never interrupt gameplay */ }
      });
      if (typeof off === 'function') this.offs.push(off);
    };

    on('player:launch', (p) => this._jump(p));
    on('player:land', (p) => this._land(p));
    on('player:graze', (p) => this._scrape(p));
    on('player:impact', (p) => this._impact(p));
    on('player:wipeout', () => this._wipeout());
    on('player:reset', () => this._resetSplash());
    on('obstacle:hit', (p) => this._obstacle(p));
    on('tube:enter', () => this._tubeEnter());
    on('tube:exit', (p) => this._tubeExit(p));
    on('trick:start', (p) => {
      if (p.name === 'floater') this._boardScrape(0.35);
    });
    on('trick:land', (p) => this._trickLanded(p));
    on('trick:fail', () => this._fail());
    on('combo:up', (p) => {
      if ((p.chain || 0) >= 2) this._combo(p.chain);
    });
    on('gate:pass', (p) => this._gate(p, true));
    on('gate:miss', (p) => this._gate(p, false));
    on('race:finish', () => this._finish());
    on('race:recover', () => this._recover());
  }

  _build() {
    const ac = this.audio;
    this.master = ac.createGain();
    this.master.gain.value = 0;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 7;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.16;
    this.master.connect(limiter).connect(ac.destination);

    this.noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 0xB0A5A;
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 0xFFFFFFFF) * 2 - 1;
    }

    this.waterGain = this._ambientLayer('bandpass', 620, 0.75);
    this.waveGain = this._ambientLayer('lowpass', 900, 0.7);
    this.waveFilter = this.waveGain._filter;
    this.sprayGain = this._ambientLayer('highpass', 2600, 0.55);
    this._applyVolume();
  }

  _ambientLayer(type, frequency, q) {
    const source = this.audio.createBufferSource();
    const filter = this.audio.createBiquadFilter();
    const gain = this.audio.createGain();
    source.buffer = this.noise;
    source.loop = true;
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(this.master);
    source.start(0, this._rand() * 1.5);
    gain._filter = filter;
    return gain;
  }

  _applyVolume() {
    if (!this.master || !this.audio) return;
    const target = this.enabled && !this.paused ? 0.68 * (this.volume ** 1.2) : 0;
    this.master.gain.setTargetAtTime(target, this.audio.currentTime, 0.025);
  }

  _rand() {
    this.variant = (Math.imul(this.variant, 1664525) + 1013904223) >>> 0;
    return this.variant / 0xFFFFFFFF;
  }

  _pan(value) {
    if (!this.audio.createStereoPanner) return this.audio.createGain();
    const node = this.audio.createStereoPanner();
    node.pan.value = clamp(value, -1, 1);
    return node;
  }

  _tone(freq, endFreq, duration, gainAmount, type = 'sine', panValue = 0, delay = 0) {
    const ac = this.audio;
    const at = ac.currentTime + delay;
    const end = at + duration;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const pan = this._pan(panValue);
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), end);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainAmount), at + Math.min(0.008, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(pan).connect(this.master);
    osc.start(at);
    osc.stop(end + 0.015);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); pan.disconnect(); };
  }

  _noiseBurst(duration, amount, type = 'bandpass', frequency = 1200, endFrequency = frequency, panValue = 0, delay = 0) {
    const ac = this.audio;
    const at = ac.currentTime + delay;
    const end = at + duration;
    const source = ac.createBufferSource();
    const filter = ac.createBiquadFilter();
    const gain = ac.createGain();
    const pan = this._pan(panValue);
    source.buffer = this.noise;
    source.loop = true;
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end);
    filter.Q.value = 0.8;
    gain.gain.setValueAtTime(Math.max(0.0002, amount), at);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    source.connect(filter).connect(gain).connect(pan).connect(this.master);
    const offset = (this.noiseCursor++ * 0.173) % 1.7;
    source.start(at, offset);
    source.stop(end + 0.015);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); pan.disconnect(); };
  }

  _splash(amount = 0.5, duration = 0.34, pan = 0) {
    const a = clamp(amount);
    this._noiseBurst(duration, 0.16 + a * 0.42, 'bandpass', 2300, 420, pan);
    this._noiseBurst(duration * 0.7, 0.08 + a * 0.20, 'highpass', 3600, 1500, -pan * 0.6, 0.018);
  }

  _jump(p) {
    const power = clamp(p.power ?? 0.55);
    this._tone(115 + power * 70, 58, 0.16, 0.15 + power * 0.13, 'triangle', -0.12);
    this._noiseBurst(0.28, 0.16 + power * 0.17, 'bandpass', 480, 3300, 0.14);
  }

  _land(p) {
    const impact = clamp(p.impact ?? 0.45);
    this._tone(105 + impact * 45, 44, 0.20, 0.19 + impact * 0.25, 'sine');
    this._splash(0.35 + impact * 0.65, 0.28 + impact * 0.22);
  }

  _impact(p) {
    const strength = clamp((p.strength || 0.25) / 1.7);
    this._tone(92 + this._rand() * 28, 42, 0.10 + strength * 0.08, 0.07 + strength * 0.12, 'triangle');
  }

  _scrape(p) {
    const amount = clamp(p.severity ?? 0.4);
    this._noiseBurst(0.18 + amount * 0.22, 0.12 + amount * 0.20, 'bandpass', 3600, 900, this._rand() - 0.5);
  }

  _wipeout() {
    this._tone(150, 31, 0.52, 0.48, 'sine');
    this._noiseBurst(0.75, 0.56, 'lowpass', 2100, 240, -0.12);
    this._noiseBurst(0.48, 0.34, 'highpass', 5200, 1400, 0.18, 0.035);
  }

  _resetSplash() {
    this._splash(0.34, 0.25, 0.15);
    this._tone(280, 430, 0.16, 0.08, 'sine', -0.1);
  }

  _obstacle(p) {
    const severity = clamp(p.severity ?? 0.6);
    if (p.type === 'boat') {
      this._metal(severity);
      this._tone(92, 82, 0.42, 0.16 + severity * 0.12, 'sawtooth', 0.15, 0.03);
      this._splash(severity, 0.4, -0.18);
    } else if (p.type === 'canoe') {
      this._woodHit(severity, true);
      this._splash(severity * 0.8, 0.32, 0.2);
    } else if (p.type === 'logBig' || p.type === 'logSmall') {
      this._woodHit(severity, false);
    } else {
      this._splash(0.28 + severity * 0.5, 0.26, this._rand() - 0.5);
    }
  }

  _woodHit(amount, hollow) {
    const a = clamp(amount);
    const base = hollow ? 175 : 105;
    this._tone(base * (0.92 + this._rand() * 0.16), base * 0.58, 0.18, 0.18 + a * 0.28, 'triangle', -0.14);
    this._tone(base * 2.43, base * 1.8, 0.11, 0.08 + a * 0.12, 'square', 0.16, 0.008);
    this._noiseBurst(0.12, 0.12 + a * 0.18, 'bandpass', hollow ? 780 : 1250, 420, 0.05);
  }

  _metal(amount) {
    const a = clamp(amount);
    this._tone(138, 126, 0.45, 0.13 + a * 0.12, 'triangle', -0.15);
    this._tone(317, 290, 0.38, 0.09 + a * 0.10, 'sine', 0.18, 0.006);
    this._tone(511, 468, 0.31, 0.07 + a * 0.08, 'sine', -0.04, 0.012);
  }

  _tubeEnter() {
    this._noiseBurst(0.72, 0.25, 'bandpass', 280, 1450, -0.2);
    this._tone(180, 360, 0.34, 0.10, 'sine', 0.2);
  }

  _tubeExit(p) {
    this._noiseBurst(0.44, 0.22, 'bandpass', 520, 3100, 0.18);
    if (p.clean) this._chime([659, 831, 988], 0.09, 0.08);
    else this._tone(120, 52, 0.28, 0.19, 'triangle');
  }

  _boardScrape(amount) {
    this._noiseBurst(0.42, 0.12 + amount * 0.18, 'highpass', 1200, 4200, -0.18);
  }

  _trickLanded(p) {
    if (!p.clean) return;
    const base = 540 + Math.min(220, (p.points || 0) * 0.4);
    this._chime([base, base * 1.25], 0.07, 0.075);
  }

  _fail() {
    this._tone(185, 72, 0.24, 0.13, 'triangle');
  }

  _combo(chain) {
    const root = 520 + Math.min(240, chain * 34);
    this._chime([root, root * 1.25, root * 1.5], 0.065, 0.055);
  }

  _gate(p, passed) {
    if (passed) {
      const center = 1 - clamp(p.margem ?? 0.5);
      this._chime([740, 990 + center * 180], 0.09, 0.075);
    } else {
      this._tone(170, 68, 0.35, 0.17, 'square');
    }
  }

  _finish() {
    this._chime([523, 659, 784, 1047], 0.11, 0.11);
    this._noiseBurst(0.7, 0.16, 'highpass', 6200, 2300, 0.1);
  }

  _recover() {
    this._tone(220, 440, 0.24, 0.08, 'sine', -0.12);
    this._splash(0.2, 0.2, 0.14);
  }

  _chime(freqs, amount, spacing) {
    freqs.forEach((frequency, i) => {
      this._tone(frequency, frequency * 0.998, 0.30, amount, 'sine', (i - 1) * 0.12, i * spacing);
    });
  }

  _nearbyProps(now, p) {
    const active = this.ctx.obstacles?.active;
    if (!Array.isArray(active) || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    let boatDistance = Infinity;
    let woodDistance = Infinity;
    for (const o of active) {
      if (!o || !o.alive) continue;
      const distance = Math.hypot(o.x - p.x, o.z - p.z);
      if ((o.type === 2 || o.type === 3) && distance < boatDistance) boatDistance = distance;
      if ((o.type === 0 || o.type === 1) && distance < woodDistance) woodDistance = distance;
    }

    if (boatDistance < 34 && now >= this.nextBoatSound) {
      const near = 1 - boatDistance / 34;
      this._tone(78 + this._rand() * 15, 70, 0.34, 0.035 + near * 0.07, 'triangle', 0.3);
      this._noiseBurst(0.18, 0.025 + near * 0.055, 'bandpass', 520, 310, 0.25);
      this.nextBoatSound = now + 4.2 + this._rand() * 2.8;
    }
    if (woodDistance < 11 && now >= this.nextWoodSound) {
      const near = 1 - woodDistance / 11;
      this._tone(96 + this._rand() * 24, 72, 0.17, 0.025 + near * 0.05, 'triangle', -0.25);
      this.nextWoodSound = now + 2.8 + this._rand() * 2.2;
    }
  }
}
