// Lightweight soundtrack player. The two rendered MP3s play in sequence,
// keeping synthesis work off the main game thread.

const TRACKS = [
  new URL('../../assets/audio/pororoca-01.mp3', import.meta.url).href,
  new URL('../../assets/audio/pororoca-02.mp3', import.meta.url).href,
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class PororocaMusic {
  constructor(ctx) {
    this.state = ctx.state;
    this.enabled = true;
    this.volume = 0.68;
    this.started = false;
    this.pausedByGame = false;
    this.index = 0;
    this.player = null;
    this.failed = new Set();
  }

  set({ enabled, volume } = {}) {
    if (enabled !== undefined) this.enabled = enabled !== false;
    if (volume !== undefined) this.volume = clamp(Number(volume) || 0, 0, 1);
    if (this.player) this.player.volume = this.volume;

    if (!this.enabled) this.player?.pause();
    else if (this.started && !this.pausedByGame) this._play();
  }

  start() {
    this._ensurePlayer();
    this.started = true;
    this.pausedByGame = false;
    if (this.enabled) this._play();
  }

  setPaused(paused) {
    const next = !!paused;
    if (next === this.pausedByGame) return;
    this.pausedByGame = next;
    if (next) this.player?.pause();
    else if (this.started && this.enabled) this._play();
  }

  // Kept as a view-system method so the music object follows the same subsystem
  // interface as the rest of the game. Playback itself is handled by <audio>.
  step() {}

  _ensurePlayer() {
    if (this.player) return;
    const player = new Audio();
    player.preload = 'metadata';
    player.volume = this.volume;
    player.addEventListener('ended', () => this._advance(false));
    player.addEventListener('error', () => {
      if (this.started) this._advance(true);
    });
    this.player = player;
    this._loadCurrent();
  }

  _loadCurrent() {
    if (!this.player) return;
    this.player.src = TRACKS[this.index];
    this.player.load();
  }

  _play() {
    if (!this.player || !this.enabled || this.pausedByGame) return;
    this.player.play().catch(() => {
      // Browsers may still refuse playback when there was no user gesture. The
      // next Jogar/menu click will call this again; gameplay remains unaffected.
    });
  }

  _advance(fromError) {
    if (fromError) this.failed.add(this.index);
    if (this.failed.size >= TRACKS.length) {
      this.player?.pause();
      return;
    }

    do {
      this.index = (this.index + 1) % TRACKS.length;
    } while (this.failed.has(this.index));

    this._loadCurrent();
    if (this.started && this.enabled && !this.pausedByGame) this._play();
  }
}
