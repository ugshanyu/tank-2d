// Procedural SFX + haptics. No audio assets — everything is synthesised from
// oscillators and a shared noise buffer, so the whole sound design costs zero
// bytes of payload and zero network requests.
//
// Browsers only allow an AudioContext to start from a user gesture, so this is
// unlocked from the same first touch that requests motion permission.

import { RELOAD_TIME } from '../shared/protocol.js';

const MASTER_GAIN = 0.35;
const RELOAD_CLACK = Math.max(0.1, RELOAD_TIME - 0.12);   // magazine seats at the end
const MIN_GAP_MS = 28;        // rate limit per EMITTER, not per kind — see _gate

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.muted = false;
    this.duck = 1;                 // ducked while a result screen is up
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
      // Four tanks and two towers firing sum well past 1.0 and clip audibly on
      // the WebView mixer. Everything goes through a compressor before output.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);

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

  // Gate per EMITTER, not per kind. With four tanks on a 0.33 s cooldown the room
  // produces ~12 'fire' events/sec against a 28 ms floor, so a single per-kind gate
  // silently swallowed roughly a third of all shots — including your own, which
  // reads exactly like the game dropping your input.
  _gate(kind, key) {
    const id = key === undefined ? kind : `${kind}:${key}`;
    const now = performance.now();
    const last = this._last.get(id) || -1e9;
    if (now - last < MIN_GAP_MS) return false;
    this._last.set(id, now);
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

  // `attack` matters: impacts need <=3 ms to read as a transient, UI wants 15-30 ms.
  // A single hardcoded 8 ms attack made a cannon, a ricochet and a chime feel identical.
  _tone({ type = 'sine', f0, f1, dur, gain, pan = 0, delay = 0, attack = 0.003 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * this.duck), t + attack);
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

  // A phone speaker rolls off hard below ~150 Hz and a pure sine has no harmonics,
  // so a "sine 70->42 Hz" impact literally produces silence on device. Every body
  // tone here sits in the 110-400 Hz band and uses triangle/square so the upper
  // harmonics carry the perceived pitch through the speaker.
  play(kind, pan = 0, key) {
    if (!this.ctx || this.muted) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this._gate(kind, key)) return;
    const p = Math.max(-0.65, Math.min(0.65, pan));   // hard-panning is disorienting
    switch (kind) {
      case 'fire':
        this._noise({ dur: 0.012, gain: 0.5, pan: p, type: 'highpass', freq: 3000 }); // crack
        this._tone({ type: 'sawtooth', f0: 300, f1: 120, dur: 0.13, gain: 0.30, pan: p });
        this._noise({ dur: 0.26, gain: 0.26, pan: p, freq: 900 });                    // body/tail
        break;
      case 'hit':                                   // my shell hit someone
        this._noise({ dur: 0.09, gain: 0.42, pan: p, freq: 1600 });
        this._tone({ type: 'triangle', f0: 420, f1: 190, dur: 0.09, gain: 0.20, pan: p });
        break;
      case 'confirm':                               // server-confirmed damage: the "dink"
        this._tone({ type: 'triangle', f0: 1250, f1: 1050, dur: 0.06, gain: 0.30, pan: p, attack: 0.001 });
        this._noise({ dur: 0.03, gain: 0.14, pan: p, type: 'bandpass', freq: 3200, q: 14 });
        break;
      case 'hurt':                                  // I took damage
        this._noise({ dur: 0.16, gain: 0.5, freq: 900 });
        this._tone({ type: 'triangle', f0: 260, f1: 130, dur: 0.2, gain: 0.34 });
        this._tone({ type: 'square', f0: 175, f1: 95, dur: 0.18, gain: 0.12 });
        break;
      case 'bounce':
        this._noise({ dur: 0.05, gain: 0.12, pan: p, type: 'bandpass', freq: 2200 + Math.random() * 1600, q: 12 });
        break;
      case 'towerhit':
        this._tone({ type: 'triangle', f0: 200, f1: 110, dur: 0.26, gain: 0.5, pan: p });
        this._tone({ type: 'square', f0: 320, f1: 165, dur: 0.14, gain: 0.14, pan: p });
        this._noise({ dur: 0.18, gain: 0.3, pan: p, freq: 1100 });
        break;
      case 'kill':
        this._noise({ dur: 0.05, gain: 0.3, type: 'bandpass', freq: 2600, q: 10 });
        this._tone({ type: 'triangle', f0: 700, f1: 900, dur: 0.09, gain: 0.3, attack: 0.002 });
        this._tone({ type: 'triangle', f0: 1050, f1: 1400, dur: 0.13, gain: 0.26, delay: 0.07 });
        break;
      case 'death':
        this._noise({ dur: 0.7, gain: 0.62, freq: 700 });
        this._tone({ type: 'triangle', f0: 300, f1: 90, dur: 0.62, gain: 0.5 });
        this._tone({ type: 'square', f0: 190, f1: 70, dur: 0.5, gain: 0.16 });
        break;
      case 'reload':
        this._noise({ dur: 0.05, gain: 0.16, type: 'bandpass', freq: 1700, q: 8 });
        this._tone({ type: 'square', f0: 150, f1: 110, dur: 0.07, gain: 0.10, delay: 0.02 });
        this._noise({ dur: 0.06, gain: 0.2, type: 'bandpass', freq: 2400, q: 9, delay: RELOAD_CLACK });
        break;
      case 'spawn':
        this._tone({ type: 'triangle', f0: 300, f1: 900, dur: 0.18, gain: 0.22, attack: 0.02 });
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) =>
          this._tone({ type: 'triangle', f0: f, dur: 0.28, gain: 0.28, delay: i * 0.09, attack: 0.02 }));
        break;
      case 'lose':
        [440, 370, 294, 220].forEach((f, i) =>
          this._tone({ type: 'triangle', f0: f, dur: 0.3, gain: 0.26, delay: i * 0.1, attack: 0.02 }));
        break;
    }
  }
}

// Haptics. iOS Safari ignores navigator.vibrate entirely — the audio above is the
// substitute there — but it lands on Android and in several WebViews.
const HAPTIC = {
  fire: 12, hit: 18, confirm: 14, hurt: 35, kill: [0, 18, 40, 18],
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
