// Connection + wire handling. Binary hot path (input up / snapshot+pong down),
// JSON for events. Auto-reconnects with backoff. Estimates server time from
// snapshot ticks (EMA) so interpolation has a stable clock without pong math.

import {
  MSG, DT, INTERP_DELAY_MS, decodeSnapshot, decodePong, encodeInput, encodePing,
} from '../shared/protocol.js';

const MAX_ATTEMPTS = 6;
// Close codes the server actually sends (server.js) mapped to something a player
// can act on. 4002 in particular means the platform token was rejected — retrying
// will never help, and it is the single most likely production failure.
const FATAL = {
  4002: "Couldn't verify your session. Close and reopen the game from the app.",
  4001: 'That match is full.',
  4003: 'This game cannot be played from here.',
  4000: 'The server did not respond in time.',
  1013: 'Servers are busy right now. Try again in a moment.',
};

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
    this.attempts = 0;
    this.lastCloseCode = 0;
    this._tokenError = null;
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
      .catch((err) => {
        // A token-fetch rejection is the single most likely production failure
        // (service-id mismatch, unpublished service, expired session) and it used
        // to vanish into a generic "reconnecting" spinner. Keep the real reason.
        this._connecting = false;
        this._tokenError = (err && err.message) ? String(err.message).slice(0, 140) : 'access request failed';
        console.error('[net] could not get a game access token:', err);
        this._scheduleReconnect();
      });
  }

  _open(url) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.attempts = 0;
      this._tokenError = null;
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

    ws.onclose = (ev) => {
      this.connected = false;
      this.lastCloseCode = ev && ev.code ? ev.code : 0;
      // An auth rejection is terminal by definition — do not burn six retries.
      if (FATAL[this.lastCloseCode] && this.lastCloseCode !== 1013) this.attempts = MAX_ATTEMPTS;
      clearInterval(this._pingTimer);
      if (this.closedByUs) return;
      this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  // Retrying forever with one generic "reconnecting…" made a misconfigured token,
  // a full server and a subway tunnel indistinguishable — to the player AND to
  // whoever is on call. Give up eventually, and say WHY.
  _scheduleReconnect() {
    if (this.closedByUs) return;
    this.attempts += 1;
    if (this.attempts > MAX_ATTEMPTS) {
      const reason = FATAL[this.lastCloseCode]
        || (this._tokenError ? `Couldn't join the match: ${this._tokenError}` : null)
        || 'Lost connection. Check your network and reopen.';
      console.error(`[net] giving up after ${this.attempts} attempts (close ${this.lastCloseCode}): ${reason}`);
      this.onStatus('failed', reason);
      return;
    }
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

  sendInput(seq, moveX, moveY, firing, aim, fireNonce, lagTicks) {
    if (this.ws && this.ws.readyState === 1 && this.connected) {
      this.ws.send(encodeInput(seq, moveX, moveY, firing, aim, fireNonce, lagTicks));
    }
  }

  // How far behind the server our rendered view is, in ticks: the interpolation
  // delay plus one-way latency. This is what the server rewinds to when it tests
  // our shots, so what we shoot at is what we saw.
  viewLagTicks() {
    return Math.round((INTERP_DELAY_MS + this.rtt / 2) / (DT * 1000));
  }

  close() {
    this.closedByUs = true;
    clearInterval(this._pingTimer);
    if (this.ws) this.ws.close();
  }
}
