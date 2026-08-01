// Minimal synchronous event bus.

export class Bus {
  constructor() { this._h = new Map(); }

  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }

  once(evt, fn) {
    const off = this.on(evt, (...a) => { off(); fn(...a); });
    return off;
  }

  off(evt, fn) { this._h.get(evt)?.delete(fn); }

  emit(evt, payload) {
    const set = this._h.get(evt);
    if (set) for (const fn of set) fn(payload);
    const all = this._h.get('*');
    if (all) for (const fn of all) fn(evt, payload);
  }

  clear() { this._h.clear(); }
}
