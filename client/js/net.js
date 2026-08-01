// Connection + wire handling. Binary hot path (input up / snapshot+pong down),
// JSON for events. Auto-reconnects with backoff. Estimates server time from
// snapshot ticks (EMA) so interpolation has a stable clock without pong math.

import { MSG, DT, decodeSnapshot, decodePong, encodeInput, encodePing } from '../shared/protocol.js';

export class Net {
  // `resolveUrl` is an async () => wsUrl-with-token, called on every (re)connect
  // so a fresh access token is minted each time — platform tokens are short
  // lived (~30 min) and a long match can reconnect after that.
  constructor(resolveUrl, { name, onSnapshot, onEvent, onStatus }) {
    this.resolveUrl = resolveUrl;
    this.name = name;
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
    // 2 s ring of raw offset observations (see _updateClock)
    this._offWindow = new Float64Array(120);
    this._offIdx = 0;
    this._offCount = 0;
    this._lastClockMs = 0;
    this._connecting = false;
    this._generation = 0;
    this.connect();
  }

  connect() {
    // A token fetch routinely outlives the 500 ms first backoff on cellular. Without
    // this guard a second connect() lands while the first resolveUrl() is still in
    // flight, we open two sockets, the server kicks one as a duplicate session, and
    // its onclose schedules yet another reconnect — a self-sustaining loop that also
    // orphans the first ping interval.
    if (this._connecting) return;
    this._connecting = true;
    const gen = ++this._generation;
    this.onStatus(this._clockInit ? 'reconnecting' : 'connecting');
    // Resolve a fresh tokenized URL, then open. A failed token fetch (backend
    // hiccup, expired session) is treated like a dropped socket: back off + retry.
    Promise.resolve()
      .then(() => this.resolveUrl())
      .then((url) => {
        this._connecting = false;
        if (this.closedByUs || gen !== this._generation) return; // superseded
        this._open(url);
      })
      .catch(() => { this._connecting = false; this._scheduleReconnect(); });
  }

  _open(url) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      // re-anchor the server-clock estimate on every (re)connection: a
      // restarted server's tick time can be far BELOW the old estimate, and
      // the EMA only corrects downward slowly
      this._clockInit = false;
      this._offCount = 0;
      this._offIdx = 0;
      ws.send(JSON.stringify({ t: 'hello', name: this.name }));
      clearInterval(this._pingTimer);
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
      this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _scheduleReconnect() {
    if (this.closedByUs) return;
    this.onStatus('reconnecting');
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(5000, this.backoff * 1.7);
  }

  // Server-clock estimate. `off = serverTickTime - localArrivalTime` understates
  // the true offset by exactly the transit delay, so the LARGEST recent sample is
  // the least-delayed one and the best estimate.
  //
  // The old code latched straight onto that max on every packet. Because a single
  // early-arriving snapshot carries the full jitter of one packet, the clock
  // ratcheted forward on every low-latency outlier and then slid back over ~300 ms
  // — several times a second on cellular. serverNowMs() feeds renderMs, which
  // drives BOTH remote interpolation and every shell's catch-up loop, so that
  // sawtooth was smeared over everything on screen that wasn't your own tank.
  // It was the single biggest source of "not smooth".
  //
  // Now: max over a 2 s window (robust to one outlier), approached by bounded
  // slew. A 2 % time-warp ceiling is imperceptible and guarantees serverNowMs()
  // stays monotonic, which the bullet timelines rely on.
  _updateClock(tick) {
    const serverMs = tick * DT * 1000;
    const now = performance.now();
    const off = serverMs - now;

    const w = this._offWindow;
    w[this._offIdx] = off;
    this._offIdx = (this._offIdx + 1) % w.length;
    if (this._offCount < w.length) this._offCount++;

    if (!this._clockInit) {
      this.clockOffset = off;
      this._clockInit = true;
      this._lastClockMs = now;
      return;
    }

    let target = -Infinity;
    for (let i = 0; i < this._offCount; i++) if (w[i] > target) target = w[i];

    const err = target - this.clockOffset;
    // a jump this large is a reconnect or a server restart, not jitter — step it
    if (Math.abs(err) > 250) {
      this.clockOffset = target;
      this._lastClockMs = now;
      return;
    }
    const dtMs = Math.min(200, Math.max(0, now - this._lastClockMs));
    this._lastClockMs = now;
    const maxStep = 0.02 * dtMs;
    this.clockOffset += Math.sign(err) * Math.min(Math.abs(err), maxStep);
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
