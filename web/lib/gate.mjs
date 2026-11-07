// Is this microphone frame someone speaking? Adapts to the room's noise floor; sustained quieter sounds
// (a sigh, a soft voice) count, short clicks don't.
export class InputGate {
  constructor({ min = 2, max = 6 } = {}) { this.since = null; this.floor = 0.7; this.min = min; this.max = max; }
  loud(rms, now) {
    if (rms < 1.8) this.floor = 0.98 * this.floor + 0.02 * rms;
    const threshold = Math.max(this.min, Math.min(this.max, this.floor * 3));
    if (rms > threshold) { this.since ??= now; return rms > this.max || now - this.since >= 100; }
    this.since = null; return false;
  }
}
