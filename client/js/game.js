// Client game state — the zero-lag core:
//  * PREDICTION: my tank is simulated locally every fixed tick with the shared sim,
//    inputs are seq-numbered and buffered.
//  * RECONCILIATION: each snapshot acks a seq; predicted state is reset to the
//    authoritative state and unacked inputs replayed. Residual error (normally
//    ~0 thanks to the shared sim) is smoothed visually, never snapped.
//  * INTERPOLATION: remote tanks render ~100 ms in the past between two known
//    snapshots — smooth regardless of network jitter.
//  * BULLETS are events, not state: one 'fire' event, then both sides run the
//    same deterministic sim. My own shots also spawn instantly as predicted
//    bullets, reconciled to the server's when the echo arrives.

import {
  DT, INTERP_DELAY_MS, FIRE_COOLDOWN, MUZZLE_OFFSET, BULLET_SPEED, MAX_HP, wrapAngle,
} from '../shared/protocol.js';
import { stepTank, stepBullet } from '../shared/sim.js';

const BUFFER_MS = 1200;          // how much snapshot history to keep per tank
const MAX_EXTRAP_MS = 120;       // beyond this remote tanks freeze instead of guessing
const PREDICT_CONFIRM_MS = 1000; // drop unconfirmed predicted bullets after this

export class Game {
  constructor(net) {
    this.net = net;
    this.myId = 0;
    this.names = new Map();       // id -> name

    // prediction
    this.me = null;               // predicted local tank {x,y,vx,vy,hull,...}
    this.meServer = null;         // last authoritative state (hp/alive/score come from here)
    this.pending = [];            // unacked inputs [{seq, moveX, moveY, firing, aim, fireNonce}]
    this.seq = 0;
    this.fireNonce = 0;
    this.lastFireSeq = -1000;
    this.errX = 0; this.errY = 0; // visual smoothing offset after corrections

    // interpolation
    this.remotes = new Map();     // id -> [{tMs, x,y,vx,vy,hull,turret,hp,alive,score}, ...]

    // bullets: confirmed (from fire events) + predicted (mine, awaiting echo)
    this.bullets = new Map();     // bid -> bullet {x,y,px,py,vx,vy,age,bounces,owner}
    this.predicted = new Map();   // nonce -> bullet (+ .bornAt wall-clock)
    this.remoteSimTimeMs = null;  // how far confirmed bullets have been simulated

    this.effects = [];            // {kind,x,y,born,dur,r}
    this.aim = 0;
    this.respawnCountdown = 0;
  }

  // ---------- fixed 30 Hz tick: sample input, predict, send ----------
  tick(input, aimAngle) {
    this.aim = aimAngle;
    if (!this.me) return;
    this.seq = (this.seq + 1) & 0xffff;

    let firing = false;
    let nonce = 0;
    const aliveNow = this.meServer ? this.meServer.alive : true;
    if (input.firing && aliveNow && this._cooldownReady()) {
      firing = true;
      this.fireNonce = (this.fireNonce + 1) & 0xffff;
      nonce = this.fireNonce;
      this.lastFireSeq = this.seq;
      this._spawnPredicted(nonce, aimAngle);
    }

    const inp = { seq: this.seq, moveX: input.moveX, moveY: input.moveY, firing, aim: aimAngle, fireNonce: nonce };
    this.pending.push(inp);
    if (this.pending.length > 120) this.pending.shift(); // runaway guard when disconnected

    if (aliveNow) stepTank(this.me, inp, DT);
    this.net.sendInput(inp.seq, inp.moveX, inp.moveY, inp.firing, inp.aim, inp.fireNonce);

    // advance my predicted bullets on the same fixed timeline
    for (const [nonceKey, b] of this.predicted) {
      b.px = b.x; b.py = b.y;
      if (!stepBullet(b, DT)) this.predicted.delete(nonceKey);
    }
  }

  _cooldownReady() {
    const dSeq = (this.seq - this.lastFireSeq + 65536) % 65536;
    return dSeq * DT >= FIRE_COOLDOWN;
  }

  _spawnPredicted(nonce, a) {
    const x = this.me.x + Math.cos(a) * MUZZLE_OFFSET;
    const y = this.me.y + Math.sin(a) * MUZZLE_OFFSET;
    this.predicted.set(nonce, {
      x, y, px: x, py: y,
      vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
      age: 0, bounces: 0, owner: this.myId, bornAt: performance.now(),
    });
    this.effects.push({ kind: 'muzzle', x, y, a, born: performance.now(), dur: 90 });
  }

  // ---------- snapshots ----------
  onSnapshot(snap) {
    if (!this.myId) return;
    const tMs = snap.tick * DT * 1000;

    for (const t of snap.tanks) {
      if (t.id === this.myId) {
        this._reconcile(t, snap.lastAckSeq);
        continue;
      }
      let buf = this.remotes.get(t.id);
      if (!buf) { buf = []; this.remotes.set(t.id, buf); }
      buf.push({ tMs, ...t });
      const cutoff = tMs - BUFFER_MS;
      while (buf.length > 2 && buf[0].tMs < cutoff) buf.shift();
    }
    // drop remotes that vanished from snapshots (left the room)
    const present = new Set(snap.tanks.map((t) => t.id));
    for (const id of this.remotes.keys()) if (!present.has(id)) this.remotes.delete(id);
  }

  _reconcile(server, ackSeq) {
    const wasAlive = this.meServer ? this.meServer.alive : true;
    this.meServer = server;
    if (!this.me) {
      this.me = { x: server.x, y: server.y, vx: server.vx, vy: server.vy, hull: server.hull };
      return;
    }
    if (!server.alive) {
      // dead: no prediction; camera stays where we died
      this.pending.length = 0;
      this.me.vx = 0; this.me.vy = 0;
      if (wasAlive) this.effects.push({ kind: 'explosion', x: this.me.x, y: this.me.y, born: performance.now(), dur: 600, big: true });
      return;
    }
    if (!wasAlive) {
      // respawned: adopt server state wholesale, clear stale prediction
      this.me = { x: server.x, y: server.y, vx: server.vx, vy: server.vy, hull: server.hull };
      this.pending.length = 0;
      this.errX = 0; this.errY = 0;
      return;
    }

    // drop acked inputs, replay the rest from the authoritative state
    while (this.pending.length && seqLte(this.pending[0].seq, ackSeq)) this.pending.shift();
    const oldX = this.me.x, oldY = this.me.y;
    this.me.x = server.x; this.me.y = server.y;
    this.me.vx = server.vx; this.me.vy = server.vy;
    this.me.hull = server.hull;
    for (const inp of this.pending) stepTank(this.me, inp, DT);
    // absorb correction into a decaying visual offset (no visible snapping)
    this.errX += oldX - this.me.x;
    this.errY += oldY - this.me.y;
    const m = Math.hypot(this.errX, this.errY);
    if (m > 120) { this.errX = 0; this.errY = 0; } // too wrong: hard snap
  }

  // ---------- events ----------
  onEvent(msg) {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        this.names.clear();
        for (const p of msg.players) this.names.set(p.id, p.name);
        break;
      case 'join': this.names.set(msg.id, msg.name); break;
      case 'leave': this.names.delete(msg.id); this.remotes.delete(msg.id); break;
      case 'fire': {
        if (msg.id === this.myId && this.predicted.has(msg.nonce)) {
          // my predicted bullet confirmed: hand it to the confirmed set under the
          // server's id, keeping its predicted position (continuity, no re-sim)
          const b = this.predicted.get(msg.nonce);
          this.predicted.delete(msg.nonce);
          this.bullets.set(msg.bid, b);
          break;
        }
        // remote shot: spawn at event tick, fast-forward to the remote timeline
        const b = {
          x: msg.x, y: msg.y, px: msg.x, py: msg.y,
          vx: Math.cos(msg.a) * BULLET_SPEED, vy: Math.sin(msg.a) * BULLET_SPEED,
          age: 0, bounces: 0, owner: msg.id,
        };
        const bornMs = msg.tick * DT * 1000;
        const target = this.remoteSimTimeMs ?? bornMs;
        let alive = true;
        for (let t = bornMs; t < target && alive; t += DT * 1000) alive = stepBullet(b, DT);
        if (alive) this.bullets.set(msg.bid, b);
        if (msg.id !== this.myId) this.effects.push({ kind: 'muzzle', x: msg.x, y: msg.y, a: msg.a, born: performance.now(), dur: 90 });
        break;
      }
      case 'bx': {
        this.bullets.delete(msg.bid);
        this.effects.push({
          kind: msg.hit ? 'hit' : 'poof',
          x: msg.x, y: msg.y, born: performance.now(), dur: msg.hit ? 450 : 250,
        });
        break;
      }
      case 'death':
        if (msg.victim === this.myId) this.respawnCountdown = performance.now() + 2500;
        break;
      case 'spawn': {
        const buf = this.remotes.get(msg.id);
        if (buf) buf.length = 0; // don't interpolate across a teleport
        this.effects.push({ kind: 'spawn', x: msg.x, y: msg.y, born: performance.now(), dur: 500 });
        break;
      }
    }
  }

  // ---------- per-render-frame: advance confirmed bullets on the remote timeline ----------
  frame() {
    const renderMs = this.net.serverNowMs() - INTERP_DELAY_MS;
    if (this.remoteSimTimeMs === null) this.remoteSimTimeMs = renderMs;
    let guard = 0;
    while (this.remoteSimTimeMs + DT * 1000 <= renderMs && guard < 30) {
      for (const [bid, b] of this.bullets) {
        b.px = b.x; b.py = b.y;
        if (!stepBullet(b, DT)) this.bullets.delete(bid); // server 'bx' is authoritative; this is cosmetic cleanup
      }
      this.remoteSimTimeMs += DT * 1000;
      guard++;
    }
    if (guard >= 30) this.remoteSimTimeMs = renderMs; // tab was backgrounded; jump

    // decay correction offset
    this.errX *= 0.86;
    this.errY *= 0.86;

    // prune stale predicted bullets (server never confirmed the shot)
    const now = performance.now();
    for (const [nonce, b] of this.predicted) {
      if (now - b.bornAt > PREDICT_CONFIRM_MS) this.predicted.delete(nonce);
    }
    this.effects = this.effects.filter((e) => now - e.born < e.dur);
    return renderMs;
  }

  // interpolated remote tanks at renderMs
  remoteStates(renderMs) {
    const out = [];
    for (const [id, buf] of this.remotes) {
      if (buf.length === 0) continue;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].tMs <= renderMs) { a = buf[i]; b = buf[Math.min(i + 1, buf.length - 1)]; break; }
      }
      let st;
      if (b.tMs <= renderMs) {
        // newest snapshot is older than render time: extrapolate briefly, then hold
        const dtMs = Math.min(renderMs - b.tMs, MAX_EXTRAP_MS);
        st = { ...b, x: b.x + b.vx * dtMs / 1000, y: b.y + b.vy * dtMs / 1000 };
      } else {
        const f = (renderMs - a.tMs) / Math.max(1, b.tMs - a.tMs);
        st = {
          ...b,
          x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f),
          hull: lerpAngle(a.hull, b.hull, f), turret: lerpAngle(a.turret, b.turret, f),
        };
      }
      st.id = id;
      st.name = this.names.get(id) || '?';
      out.push(st);
    }
    return out;
  }

  scoreboard() {
    const rows = [];
    if (this.meServer) rows.push({ id: this.myId, name: this.names.get(this.myId) || 'you', score: this.meServer.score, me: true });
    for (const [id, buf] of this.remotes) {
      if (!buf.length) continue;
      rows.push({ id, name: this.names.get(id) || '?', score: buf[buf.length - 1].score, me: false });
    }
    rows.sort((x, y) => y.score - x.score);
    return rows;
  }
}

const lerp = (a, b, f) => a + (b - a) * f;
const lerpAngle = (a, b, f) => a + wrapAngle(b - a) * f;
// seq a <= b with u16 wraparound
const seqLte = (a, b) => ((b - a + 65536) % 65536) < 32768;
