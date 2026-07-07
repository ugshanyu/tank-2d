// Connection + wire handling. Binary hot path (input up / snapshot+pong down),
// JSON for events. Auto-reconnects with backoff. Estimates server time from
// snapshot ticks (EMA) so interpolation has a stable clock without pong math.

import { MSG, DT, decodeSnapshot, decodePong, encodeInput, encodePing } from '../shared/protocol.js';

export class Net {
  constructor(url, { name, room, onSnapshot, onEvent, onStatus }) {
    this.url = url;
    this.name = name;
    this.room = room;
    this.onSnapshot = onSnapshot;
    this.onEvent = onEvent;       // (jsonMsg) => void
    this.onStatus = onStatus;     // ('connecting'|'connected'|'reconnecting') => void
    this.ws = null;
    this.connected = false;
    this.rtt = 0;
    this.closedByUs = false;
    this.backoff = 500;
    // server-clock estimate: serverNowMs ≈ performance.now() + clockOffset
    this.clockOffset = 0;
    this._clockInit = false;
    this._pingTimer = null;
    this.connect();
  }

  connect() {
    this.onStatus(this._clockInit ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      // re-anchor the server-clock estimate on every (re)connection: a
      // restarted server's tick time can be far BELOW the old estimate, and
      // the EMA only corrects downward slowly
      this._clockInit = false;
      ws.send(JSON.stringify({ t: 'hello', name: this.name, room: this.room }));
      this._pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(encodePing(performance.now()));
      }, 2000);
      ws.send(encodePing(performance.now()));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'welcome') { this.connected = true; this.onStatus('connected'); }
        this.onEvent(msg);
        return;
      }
      const v = new DataView(ev.data);
      const type = v.getUint8(0);
      if (type === MSG.SNAPSHOT) {
        const snap = decodeSnapshot(v);
        this._updateClock(snap.tick);
        this.onSnapshot(snap);
      } else if (type === MSG.PONG) {
        const { clientTimeMs } = decodePong(v);
        this.rtt = Math.round(performance.now() - clientTimeMs);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      if (this.closedByUs) return;
      this.onStatus('reconnecting');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(5000, this.backoff * 1.7);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  // EMA of (snapshot server-time − local arrival time). Snapshot cadence is one
  // per tick, so jitter is small; EMA converges fast and stays smooth.
  _updateClock(tick) {
    const serverMs = tick * DT * 1000;
    const off = serverMs - performance.now();
    if (!this._clockInit) { this.clockOffset = off; this._clockInit = true; return; }
    // never let the estimate drift ahead of a real observation's upper bound;
    // track the max offset seen recently (offset is bounded above by true offset)
    this.clockOffset += (off - this.clockOffset) * 0.05;
    if (off > this.clockOffset) this.clockOffset = off; // fast-correct when late estimate
  }

  serverNowMs() {
    return performance.now() + this.clockOffset;
  }

  sendInput(seq, moveX, moveY, firing, aim, fireNonce) {
    if (this.ws && this.ws.readyState === 1 && this.connected) {
      this.ws.send(encodeInput(seq, moveX, moveY, firing, aim, fireNonce));
    }
  }

  close() {
    this.closedByUs = true;
    clearInterval(this._pingTimer);
    if (this.ws) this.ws.close();
  }
}
