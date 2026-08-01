// Procedural SFX + haptics. No audio assets — everything is synthesised from
// oscillators and a shared noise buffer, so the whole sound design costs zero
// bytes of payload and zero network requests.
//
// Browsers only allow an AudioContext to start from a user gesture, so this is
// unlocked from the same first touch that requests motion permission.

const MASTER_GAIN = 0.5;
const MIN_GAP_MS = 28;        // per-kind rate limit; bounces can arrive in bursts

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.muted = false;
    this.duck = 1;
    this._last = new Map();
    try { this.muted = localStorage.getItem('tank.muted') === '1'; } catch { /* private mode */ }
  }

  // Must be called from inside a user gesture.
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      this.master.connect(this.ctx.destination);

      // one second of white noise, reused by every noise-based voice
      const n = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    } catch { this.ctx = null; }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : MASTER_GAIN;
    try { localStorage.setItem('tank.muted', m ? '1' : '0'); } catch { /* ignore */ }
  }

  _gate(kind) {
    const now = performance.now();
    const last = this._last.get(kind) || -1e9;
    if (now - last < MIN_GAP_MS) return false;
    this._last.set(kind, now);
    return true;
  }

  // pan: -1 (left) .. 1 (right), derived from world x by the caller
  _out(pan) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      p.connect(this.master);
      return p;
    }
    return this.master;
  }

  _tone({ type = 'sine', f0, f1, dur, gain, pan = 0, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * this.duck), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this._out(pan));
    o.start(t); o.stop(t + dur + 0.02);
  }

  _noise({ dur, gain, pan = 0, type = 'lowpass', freq = 1200, q = 1, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = type; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, gain * this.duck), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(this._out(pan));
    src.start(t); src.stop(t + dur + 0.02);
  }

  play(kind, pan = 0) {
    if (!this.ctx || this.muted) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this._gate(kind)) return;
    switch (kind) {
      case 'fire':
        this._tone({ type: 'sawtooth', f0: 220, f1: 80, dur: 0.15, gain: 0.30, pan });
        this._noise({ dur: 0.05, gain: 0.22, pan, type: 'highpass', freq: 900 });
        break;
      case 'hit':                                   // my shell hit someone
        this._noise({ dur: 0.09, gain: 0.42, pan, freq: 1200 });
        this._tone({ type: 'square', f0: 320, f1: 140, dur: 0.08, gain: 0.16, pan });
        break;
      case 'hurt':                                  // I took damage
        this._noise({ dur: 0.14, gain: 0.5, pan: 0, freq: 700 });
        this._tone({ type: 'sine', f0: 180, f1: 70, dur: 0.18, gain: 0.3 });
        break;
      case 'bounce':
        this._noise({ dur: 0.04, gain: 0.10, pan, type: 'bandpass', freq: 700 + Math.random() * 400, q: 4 });
        break;
      case 'towerhit':
        this._tone({ type: 'sine', f0: 70, f1: 42, dur: 0.24, gain: 0.5, pan });
        this._noise({ dur: 0.10, gain: 0.25, pan, freq: 600 });
        break;
      case 'kill':
        this._tone({ type: 'sine', f0: 880, dur: 0.06, gain: 0.28 });
        this._tone({ type: 'sine', f0: 1320, dur: 0.09, gain: 0.26, delay: 0.06 });
        break;
      case 'death':
        this._noise({ dur: 0.55, gain: 0.6, freq: 420 });
        this._tone({ type: 'sine', f0: 130, f1: 40, dur: 0.6, gain: 0.5 });
        break;
      case 'spawn':
        this._tone({ type: 'triangle', f0: 300, f1: 900, dur: 0.18, gain: 0.22 });
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) =>
          this._tone({ type: 'triangle', f0: f, dur: 0.28, gain: 0.28, delay: i * 0.09 }));
        break;
      case 'lose':
        [440, 370, 294, 220].forEach((f, i) =>
          this._tone({ type: 'triangle', f0: f, dur: 0.3, gain: 0.26, delay: i * 0.1 }));
        break;
    }
  }
}

// Haptics. iOS Safari ignores navigator.vibrate entirely — the audio above is the
// substitute there — but it lands on Android and in several WebViews.
const HAPTIC = {
  fire: 12, hit: 18, hurt: 35, kill: [0, 18, 40, 18],
  death: 90, towerhit: 20, win: [0, 60, 50, 120], lose: 140,
};
let lastBuzz = -1e9;
export function haptic(kind) {
  const pattern = HAPTIC[kind];
  if (!pattern || !navigator.vibrate) return;
  const now = performance.now();
  if (now - lastBuzz < 60) return;
  lastBuzz = now;
  try { navigator.vibrate(pattern); } catch { /* blocked by policy */ }
}
