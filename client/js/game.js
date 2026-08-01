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
  DT, INTERP_DELAY_MS, FIRE_COOLDOWN, MUZZLE_OFFSET, BULLET_SPEED, MAX_HP, TOWER_HP,
  RESPAWN_DELAY, wrapAngle, encAngle16, decAngle16,
} from '../shared/protocol.js';
import { stepTank, stepBullet } from '../shared/sim.js';

const BUFFER_MS = 1200;          // how much snapshot history to keep per tank
const MAX_EXTRAP_MS = 160;       // extrapolation velocity eases to zero across this
const PREDICT_CONFIRM_MS = 1000; // drop unconfirmed predicted bullets after this
const ERR_HALFLIFE = 0.09;       // s — visual correction time constant (framerate independent)
const MAX_ERR = 40;              // px — corrections are clamped here, never zeroed
const ERR_MAX_RATE = 320;        // px/s — hard ceiling on visible correction speed

export class Game {
  constructor(net) {
    this.net = net;
    this.myId = 0;
    this.myTeam = 0;
    this.names = new Map();       // id -> name
    this.teams = new Map();       // id -> team
    this.bots = new Set();        // ids that are server-run bots

    // match state (2v2 objective mode)
    this.towerHp = [TOWER_HP, TOWER_HP];
    this.phase = 'playing';       // 'playing' | 'over'
    this.winner = -1;
    this.wins = [0, 0];
    this.matchOverAt = 0;         // performance.now() when the result screen appeared

    // prediction
    this.me = null;               // predicted local tank {x,y,vx,vy,hull,...}
    this.meServer = null;         // last authoritative state (hp/alive/score come from here)
    this.pending = [];            // unacked inputs [{seq, moveX, moveY, firing, aim, fireNonce}]
    this.seq = 0;
    this.fireNonce = 0;
    this.lastFireSeq = -1000;
    this._nextFireAtMs = 0;
    this.lastFireAt = -1e9;
    this.killedBy = '';
    this.errX = 0; this.errY = 0; // visual smoothing offset after corrections

    // interpolation
    this.remotes = new Map();     // id -> [{tMs, x,y,vx,vy,hull,turret,hp,alive,score}, ...]

    // bullets: confirmed (from fire events) + predicted (mine, awaiting echo).
    // Each confirmed bullet carries its own timeline cursor (simMs): it is
    // stepped from its birth tick up to the render time, so a bullet can never
    // run ahead of the interpolated tanks nor depend on a pre-sync global clock.
    this.bullets = new Map();     // bid -> {x,y,vx,vy,age,bounces,owner,bornMs,simMs}
    this.predicted = new Map();   // nonce -> bullet (+ .bornAt wall-clock)

    this.effects = [];            // {kind,x,y,born,dur,r}
    this.aim = 0;
    this.respawnCountdown = 0;

    // pooled per-frame output (this path runs every frame for every tank)
    this._remoteOut = [];
    this._remotePool = new Map();  // id -> reusable render state + its err offset

    // impulses the renderer/audio layer drains each frame
    this.shake = 0;               // screen-shake magnitude request, px
    this.hitstopMs = 0;           // freeze the sim this long for impact weight
    this.lastHp = MAX_HP;
    this.events = [];             // {kind, x, y} feedback queue for audio/haptics
  }

  // ---------- fixed 30 Hz tick: sample input, predict, send ----------
  tick(input, aimAngle) {
    if (!this.me) return;
    this.seq = (this.seq + 1) & 0xffff;

    // quantize to wire precision FIRST so prediction, replay and the server
    // all simulate from byte-identical values (raw floats would drift at the
    // sim deadzone boundary and cause endless micro-corrections)
    const aim = decAngle16(encAngle16(aimAngle));
    const q = (v) => Math.max(-127, Math.min(127, Math.round(v * 127))) / 127;
    this.aim = aim;

    let firing = false;
    let nonce = 0;
    const aliveNow = this.meServer ? this.meServer.alive : true;
    if (input.firing && aliveNow && this._cooldownReady()) {
      firing = true;
      this.fireNonce = (this.fireNonce + 1) & 0xffff;
      nonce = this.fireNonce;
      this.lastFireSeq = this.seq;
    }

    const inp = { seq: this.seq, moveX: q(input.moveX), moveY: q(input.moveY), firing, aim, fireNonce: nonce };
    this.pending.push(inp);
    if (this.pending.length > 120) this.pending.shift(); // runaway guard when disconnected

    // move THEN fire — same order as the server, so the predicted muzzle
    // position matches the authoritative one exactly
    if (aliveNow) stepTank(this.me, inp, DT);
    if (firing) this._spawnPredicted(nonce, aim);
    this.net.sendInput(inp.seq, inp.moveX, inp.moveY, inp.firing, inp.aim, inp.fireNonce);

    // advance my predicted bullets on the same fixed timeline
    for (const [nonceKey, b] of this.predicted) {
      if (!stepBullet(b, DT)) this.predicted.delete(nonceKey);
    }
  }

  // Wall clock, not seq counting. `dSeq * DT` coupled the fire rate to the frame
  // rate: any frame that skipped a tick stretched the cooldown in real time.
  _cooldownReady() {
    return performance.now() >= this._nextFireAtMs;
  }

  // 0..1 for the reload arc drawn around your own tank
  reloadFraction() {
    const left = this._nextFireAtMs - performance.now();
    if (left <= 0) return 1;
    return Math.max(0, 1 - left / (FIRE_COOLDOWN * 1000));
  }

  _spawnPredicted(nonce, a) {
    this._nextFireAtMs = performance.now() + FIRE_COOLDOWN * 1000;
    // Spawn from where the barrel is DRAWN (err offset included), otherwise the
    // shell and muzzle flash detach from the tank during any correction.
    const x = this.me.x + this.errX + Math.cos(a) * MUZZLE_OFFSET;
    const y = this.me.y + this.errY + Math.sin(a) * MUZZLE_OFFSET;
    this.shake = Math.max(this.shake, 2.5);
    this.lastFireAt = performance.now();
    this.events.push({ kind: 'fire' });
    this.predicted.set(nonce, {
      x, y,
      vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
      age: 0, bounces: 0, owner: this.myId, bornAt: performance.now(),
    });
    this.effects.push({ kind: 'muzzle', x, y, a, born: performance.now(), dur: 90 });
  }

  // ---------- snapshots ----------
  onSnapshot(snap) {
    if (!this.myId) return;
    if (snap.towerHp) this.towerHp = snap.towerHp;
    const tMs = snap.tick * DT * 1000;

    for (const t of snap.tanks) {
      if (t.id === this.myId) {
        this._reconcile(t, snap.lastAckSeq);
        continue;
      }
      let buf = this.remotes.get(t.id);
      if (!buf) { buf = []; this.remotes.set(t.id, buf); }
      // Reuse the object decodeSnapshot already allocated instead of spreading it
      // into a second one — this is the 60 Hz path and the spread was pure garbage.
      t.tMs = tMs;
      buf.push(t);
      buf.seen = snap.tick;
      const cutoff = tMs - BUFFER_MS;
      while (buf.length > 2 && buf[0].tMs < cutoff) buf.shift();
    }
    // Drop remotes that vanished from snapshots (left the room). A presence stamp
    // replaces the Set+map that used to be allocated 60 times a second.
    for (const id of this.remotes.keys()) {
      if (this.remotes.get(id).seen !== snap.tick) this.remotes.delete(id);
    }
  }

  _reconcile(server, ackSeq) {
    const wasAlive = this.meServer ? this.meServer.alive : true;
    // Taking damage used to produce literally nothing — you died without ever
    // knowing you were being shot. Surface it as shake + a feedback event.
    if (server.alive && server.hp < this.lastHp) {
      this.shake = Math.max(this.shake, 7);
      this.events.push({ kind: 'hurt' });
    }
    this.lastHp = server.hp;
    this.meServer = server;
    if (!this.me) {
      this.me = { x: server.x, y: server.y, vx: server.vx, vy: server.vy, hull: server.hull };
      return;
    }
    if (!server.alive) {
      // dead: no prediction; camera stays where we died
      this.pending.length = 0;
      this.me.vx = 0; this.me.vy = 0;
      if (wasAlive) {
        this.effects.push({ kind: 'explosion', x: this.me.x, y: this.me.y, born: performance.now(), dur: 600, big: true });
        this.shake = Math.max(this.shake, 14);
        this.hitstopMs = 70;   // the freeze is what sells the impact
        this.events.push({ kind: 'death' });
      }
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
    // Absorb the correction into a decaying visual offset. The old code zeroed the
    // offset above 120px, which moved the tank the ENTIRE accumulated error in one
    // frame — 17% of the arena width, a teleport at exactly the moment smoothing
    // mattered most. Clamp instead and keep gliding; a fast ease always beats a pop.
    this.errX += oldX - this.me.x;
    this.errY += oldY - this.me.y;
    const m = Math.hypot(this.errX, this.errY);
    if (m > MAX_ERR) {
      const s = MAX_ERR / m;
      this.errX *= s;
      this.errY *= s;
    }
  }

  // ---------- events ----------
  onEvent(msg) {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        this.myTeam = msg.team ?? 0;
        this.names.clear();
        this.teams.clear();
        this.bots.clear();
        for (const p of msg.players) {
          this.names.set(p.id, p.name);
          this.teams.set(p.id, p.team ?? 0);
          if (p.bot) this.bots.add(p.id);
        }
        this.wins = msg.wins || [0, 0];
        this.phase = msg.phase || 'playing';
        // reconnect hygiene: drop state from the previous connection
        this.bullets.clear();
        this.predicted.clear();
        this.remotes.clear();
        this.pending.length = 0;
        break;
      case 'join':
        this.names.set(msg.id, msg.name);
        this.teams.set(msg.id, msg.team ?? 0);
        if (msg.bot) this.bots.add(msg.id); else this.bots.delete(msg.id);
        break;
      case 'leave':
        this.names.delete(msg.id);
        this.teams.delete(msg.id);
        this.bots.delete(msg.id);
        this.remotes.delete(msg.id);
        break;
      case 'matchover':
        this.phase = 'over';
        this.winner = msg.winner;
        this.wins = msg.wins || this.wins;
        this.matchOverAt = performance.now();
        this.shake = Math.max(this.shake, 20);
        this.hitstopMs = 90;
        this.events.push({ kind: msg.winner === this.myTeam ? 'win' : 'lose' });
        // the arena is frozen server-side; drop shells so none linger on screen
        this.bullets.clear();
        this.predicted.clear();
        break;
      case 'matchstart':
        this.phase = 'playing';
        this.winner = -1;
        this.wins = msg.wins || this.wins;
        this.towerHp = [TOWER_HP, TOWER_HP];
        this.bullets.clear();
        this.predicted.clear();
        this.pending.length = 0;
        this.errX = 0; this.errY = 0;
        for (const buf of this.remotes.values()) buf.length = 0; // don't interpolate across the reset
        break;
      case 'fire': {
        const bornMs = msg.tick * DT * 1000;
        if (msg.id === this.myId && this.predicted.has(msg.nonce)) {
          // my predicted bullet confirmed: hand it to the confirmed set under
          // the server's id, keeping its predicted position (continuity). Its
          // cursor starts at the current render time — it is already "ahead".
          const b = this.predicted.get(msg.nonce);
          this.predicted.delete(msg.nonce);
          b.bornMs = bornMs;
          b.simMs = this.net.serverNowMs() - INTERP_DELAY_MS;
          this.bullets.set(msg.bid, b);
          break;
        }
        // remote shot: dormant until the interpolated timeline reaches its
        // birth tick; frame() then steps it with its own cursor
        this.bullets.set(msg.bid, {
          x: msg.x, y: msg.y,
          vx: Math.cos(msg.a) * BULLET_SPEED, vy: Math.sin(msg.a) * BULLET_SPEED,
          age: 0, bounces: 0, owner: msg.id, bornMs, simMs: bornMs,
        });
        if (msg.id !== this.myId) this.effects.push({ kind: 'muzzle', x: msg.x, y: msg.y, a: msg.a, born: performance.now(), dur: 90 });
        break;
      }
      case 'bx': {
        // Spawn the burst where OUR copy of the shell actually is. The client copy
        // deliberately runs ~1 RTT ahead of the server's authoritative position, so
        // using msg.x/msg.y made your own shell fly visibly past the impact and the
        // explosion pop back behind it — ~34px of separation at 80ms one-way.
        const local = this.bullets.get(msg.bid);
        const ex = local ? local.x : msg.x;
        const ey = local ? local.y : msg.y;
        this.bullets.delete(msg.bid);
        this.effects.push({
          kind: msg.hit ? 'hit' : 'poof',
          x: ex, y: ey, born: performance.now(), dur: msg.hit ? 450 : 250,
        });
        if (msg.tower >= 0) {
          this.shake = Math.max(this.shake, 5);
          this.events.push({ kind: 'towerhit' });
        } else if (msg.hit) {
          this.events.push({ kind: msg.hit === this.myId ? 'hurt' : 'hit' });
        } else {
          this.events.push({ kind: 'bounce' });
        }
        break;
      }
      case 'death':
        if (msg.victim === this.myId) {
          this.respawnCountdown = performance.now() + RESPAWN_DELAY * 1000;
          this.killedBy = this.names.get(msg.killer) || (msg.killer >= 200 ? 'a tower' : '');
        } else if (msg.killer === this.myId) {
          this.shake = Math.max(this.shake, 4);
          this.events.push({ kind: 'kill' });
        }
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
  frame(dtSec = 1 / 60) {
    const renderMs = this.net.serverNowMs() - INTERP_DELAY_MS;
    const stepMs = DT * 1000;
    for (const [bid, b] of this.bullets) {
      // each bullet catches its own cursor up to render time; TTL bounds the
      // loop (~45 steps) even after long tab-background gaps. Removal here is
      // cosmetic cleanup — the server 'bx' event is authoritative.
      while (b.simMs + stepMs <= renderMs) {
        if (!stepBullet(b, DT)) { this.bullets.delete(bid); break; }
        b.simMs += stepMs;
      }
    }

    // Decay the correction offset on WALL CLOCK, not per frame. `*= 0.86` per frame
    // meant a 120 Hz iPhone corrected twice as hard as a 60 Hz one and a thermally
    // throttled phone rubber-banded — identical network, three different feels.
    // The rate cap keeps even a maxed-out correction from reading as a jerk.
    const k = Math.exp(-dtSec / ERR_HALFLIFE);
    const decayed = Math.hypot(this.errX, this.errY) * (1 - k);
    const cap = ERR_MAX_RATE * dtSec;
    const scale = decayed > cap && decayed > 1e-6 ? 1 - (cap / decayed) * (1 - k) : k;
    this.errX *= scale;
    this.errY *= scale;

    // prune stale predicted bullets (server never confirmed the shot)
    const now = performance.now();
    for (const [nonce, b] of this.predicted) {
      if (now - b.bornAt > PREDICT_CONFIRM_MS) this.predicted.delete(nonce);
    }
    this.effects = this.effects.filter((e) => now - e.born < e.dur);
    return renderMs;
  }

  // Interpolated remote tanks at renderMs.
  //
  // Two fixes over the naive version: (1) when extrapolating we ease the velocity
  // to zero across the window instead of truncating the position, so a stalled
  // stream reads as a tank coasting to a stop rather than freezing mid-stride and
  // then teleporting; (2) remotes get the same errX/errY visual smoothing the
  // local tank has, so the interp→extrap→resync transition is a glide, not a pop.
  // Output objects are pooled — this runs every frame for every tank.
  remoteStates(renderMs, dtSec = 1 / 60) {
    const out = this._remoteOut;
    out.length = 0;
    const k = Math.exp(-dtSec / ERR_HALFLIFE);

    for (const id of this.remotes.keys()) {
      const buf = this.remotes.get(id);
      if (buf.length === 0) continue;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].tMs <= renderMs) { a = buf[i]; b = buf[Math.min(i + 1, buf.length - 1)]; break; }
      }

      let st = this._remotePool.get(id);
      if (!st) { st = { errX: 0, errY: 0 }; this._remotePool.set(id, st); }

      let x, y, hull, turret;
      if (b.tMs <= renderMs) {
        const age = renderMs - b.tMs;
        const t = Math.min(1, age / MAX_EXTRAP_MS);
        const damp = 1 - t * t;                 // velocity fades out smoothly
        x = b.x + b.vx * damp * age / 1000;
        y = b.y + b.vy * damp * age / 1000;
        hull = b.hull; turret = b.turret;
      } else {
        // clamp: right after spawn/join every buffered entry can be newer than
        // renderMs — hold at the first snapshot instead of extrapolating backwards
        const f = Math.min(1, Math.max(0, (renderMs - a.tMs) / Math.max(1, b.tMs - a.tMs)));
        x = lerp(a.x, b.x, f); y = lerp(a.y, b.y, f);
        hull = lerpAngle(a.hull, b.hull, f);
        turret = lerpAngle(a.turret, b.turret, f);
      }

      // fold any discontinuity since last frame into a decaying offset
      if (st.hasPrev) {
        const jump = Math.hypot(x - st.rawX, y - st.rawY);
        if (jump > 1.5 && jump < 200) { st.errX += st.rawX - x; st.errY += st.rawY - y; }
      }
      st.rawX = x; st.rawY = y; st.hasPrev = true;
      const m = Math.hypot(st.errX, st.errY);
      if (m > MAX_ERR) { const s = MAX_ERR / m; st.errX *= s; st.errY *= s; }
      st.errX *= k; st.errY *= k;

      st.id = id;
      st.x = x + st.errX; st.y = y + st.errY;
      st.vx = b.vx; st.vy = b.vy;
      st.hull = hull; st.turret = turret;
      st.hp = b.hp; st.alive = b.alive; st.score = b.score; st.team = b.team;
      st.name = this.names.get(id) || '?';
      out.push(st);
    }

    // drop pooled state for tanks that are gone
    if (this._remotePool.size > this.remotes.size) {
      for (const id of this._remotePool.keys()) if (!this.remotes.has(id)) this._remotePool.delete(id);
    }
    return out;
  }

  scoreboard() {
    const rows = [];
    if (this.meServer) {
      rows.push({
        id: this.myId, name: this.names.get(this.myId) || 'you',
        score: this.meServer.score, team: this.meServer.team ?? this.myTeam, me: true, bot: false,
      });
    }
    for (const [id, buf] of this.remotes) {
      if (!buf.length) continue;
      const last = buf[buf.length - 1];
      rows.push({
        id, name: this.names.get(id) || '?', score: last.score,
        team: last.team ?? this.teams.get(id) ?? 0, me: false, bot: this.bots.has(id),
      });
    }
    rows.sort((x, y) => (x.team - y.team) || (y.score - x.score));
    return rows;
  }

  // total kills per team (the tower is the win condition; kills are just pressure)
  teamScores() {
    const s = [0, 0];
    for (const r of this.scoreboard()) s[r.team & 1] += r.score;
    return s;
  }
}

const lerp = (a, b, f) => a + (b - a) * f;
const lerpAngle = (a, b, f) => a + wrapAngle(b - a) * f;
// seq a <= b with u16 wraparound
const seqLte = (a, b) => ((b - a + 65536) % 65536) < 32768;
