// Client game state — the zero-lag core:
//  * PREDICTION: my tank is simulated locally every fixed tick with the shared sim,
//    inputs are seq-numbered and buffered.
//  * RECONCILIATION: each snapshot acks a seq; predicted state is reset to the
//    authoritative state and unacked inputs replayed. Residual error (normally
//    ~0 thanks to the shared sim) is smoothed visually, never snapped.
//  * INTERPOLATION: remote tanks render ~100 ms in the past between two known
//    snapshots — smooth regardless of network jitter.
//  * SHELLS: exactly ONE object per shot, on ONE clock (real frame time). Mine is
//    created the moment I pull the trigger; the server's `fire` echo only re-keys
//    that same object to the authoritative id. Nothing is ever spawned twice.
//  * AUTHORITY: the client renders CONTACT instantly with full weight — impact
//    sound, sparks, shake, shell retirement — because a graze produces those too,
//    so they never need undoing. Only the server declares CONSEQUENCE: health,
//    explosions, deaths, kill credit, score. The one exception is static geometry
//    (walls, towers): those verdicts depend on nothing that moves, so the client
//    owns them outright. This split is what makes a kill IMPOSSIBLE to un-happen:
//    nothing on screen ever asserts a fact the server might contradict.

import {
  DT, FIRE_COOLDOWN, MUZZLE_OFFSET, BULLET_SPEED, MAX_HP, TOWER_HP,
  RESPAWN_DELAY, BULLET_DAMAGE, MAG_SIZE, RELOAD_TIME, TOWER_OWNER_BASE,
  TANK_RADIUS, BULLET_RADIUS, TOWER_RADIUS,
  POWER, POWER_DURATION, DOUBLE_SPREAD,
  wrapAngle, encAngle16, decAngle16,
} from '../shared/protocol.js';
import { stepTank, stepBullet, TOWERS } from '../shared/sim.js';

const BUFFER_MS = 1200;          // how much snapshot history to keep per tank
const MAX_EXTRAP_MS = 160;       // extrapolation velocity eases to zero across this
const UNCONFIRMED_MS = 1000;     // drop a shell the server never acknowledged
const LINGER_MS = 1200;          // keep a spent shell this long, to swallow its echo
const SELF_FEEDBACK_MS = 700;    // one hurt beat per hit: contact stamp mutes echoes
const HP_SMOOTH_S = 0.12;        // s — displayed health eases to authoritative hp
const ERR_HALFLIFE = 0.09;       // s — visual correction time constant (framerate independent)
const MAX_ERR = 40;              // px — corrections are clamped here, never zeroed
const ERR_MAX_RATE = 320;        // px/s — hard ceiling on visible correction speed
const HIT_RADIUS = TANK_RADIUS + BULLET_RADIUS;
const TOWER_HIT_RADIUS = TOWER_RADIUS + BULLET_RADIUS + 4;

// closest distance from segment (x1,y1)-(x2,y2) to a point — the same swept test
// the server runs, so the local verdict and the authoritative one agree
function segPointDist(x1, y1, x2, y2, cx, cy) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / len2)) : 0;
  return Math.hypot(cx - (x1 + t * dx), cy - (y1 + t * dy));
}

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
    this._localAmmo = MAG_SIZE;
    this._localAmmoAt = -1e9;
    this._reloadUntil = 0;
    this.lastFireAt = -1e9;
    this.killedBy = '';
    this.errX = 0; this.errY = 0; // visual smoothing offset after corrections

    // interpolation
    this.remotes = new Map();     // id -> [{tMs, x,y,vx,vy,hull,turret,hp,alive,score}, ...]

    // Shells. ONE map, ONE clock. Key is the server's bullet id once known, and
    // `n<nonce>` for one of my shots still waiting for its echo. A spent shell is
    // marked dead and kept briefly so its echo can be matched and swallowed.
    this.shells = new Map();      // key -> {x,y,prevX,prevY,vx,vy,age,bounces,owner,mine,dead,...}

    this.effects = [];            // {kind,x,y,born,dur,r}
    this.aim = 0;
    this.respawnCountdown = 0;

    // power rune on the field (authoritative, straight from the snapshot byte)
    this.runes = [];              // [{kind, x, y}] — one per occupied spot
    this.myPowerUntil = 0;        // local clock estimate for the HUD countdown ring

    // pooled per-frame output (this path runs every frame for every tank)
    this._remoteOut = [];
    this._remotePool = new Map();  // id -> reusable render state + its err offset
    this._shellOut = [];           // pooled shell list handed to the renderer

    // Feedback dedup, NOT outcome prediction: the moment a shell visibly touches
    // US we play the hurt beat once, and this stamp mutes the server echoes for
    // the same hit (`bx` and the snapshot hp drop arrive ~1 RTT later).
    this._selfFeedbackAt = -1e9;
    this._meHist = [];             // our own recent rendered positions, see meAt()
    this.pendingAward = null;      // match result awaiting XP award

    // impulses the renderer/audio layer drains each frame
    this.shake = 0;               // screen-shake magnitude request, px
    this.hitstopMs = 0;           // freeze the sim this long for impact weight
    this.lastHp = MAX_HP;
    this.events = [];             // {kind, x, y} feedback queue for audio/haptics
    this.feed = [];               // kill feed rows — a 2v2 had no readable narrative
    this.towerState = [{ aim: undefined, firedAt: -1e9 }, { aim: undefined, firedAt: -1e9 }];
    this.matchDeaths = 0;
    this.matchTowerDamage = 0;
    this.killBannerAt = -1e9;
    this.killBannerName = '';
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
    this.net.sendInput(
      inp.seq, inp.moveX, inp.moveY, inp.firing, inp.aim, inp.fireNonce,
      this.net.viewLagTicks(),
    );
  }

  // Wall clock, not seq counting. `dSeq * DT` coupled the fire rate to the frame
  // rate: any frame that skipped a tick stretched the cooldown in real time.
  _cooldownReady() {
    if (this.ammo <= 0 || this.reloading()) return false;
    return performance.now() >= this._nextFireAtMs;
  }

  // Rounds left — authoritative from the snapshot, predicted locally between
  // snapshots so the pips drop on the frame you pull the trigger.
  get ammo() {
    const server = this.meServer ? this.meServer.ammo : MAG_SIZE;
    if (performance.now() - this._localAmmoAt < 400) return Math.min(server, this._localAmmo);
    return server;
  }

  reloading() { return this._reloadUntil > performance.now(); }

  // A respawn or a new match hands you a full magazine server-side; without this
  // a stale local reload can lock a freshly spawned tank out of firing.
  _resetMagazine() {
    this._reloadUntil = 0;
    this._localAmmo = MAG_SIZE;
    this._localAmmoAt = -1e9;
    this._nextFireAtMs = 0;
  }

  // ---------- shells ----------
  // INSTANT RESOLUTION. The server is still the authority on damage, but waiting
  // for its `bx` echo meant the impact — flash, sound, shake — landed a full round
  // trip after the shell visibly connected on YOUR screen. The server rewinds to
  // exactly the view we test against here (lag compensation), so the local verdict
  // and the authoritative one agree on all but grazing shots: play it now and let
  // the echo confirm. A shell resolves exactly once, and the object survives its
  // own death long enough to swallow that echo.

  _spawnShell(key, x, y, a, owner, confirmed) {
    const s = {
      key, x, y, prevX: x, prevY: y,
      vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
      age: 0, bounces: 0, owner, mine: owner === this.myId,
      bornAt: performance.now(), confirmed,
      // Cosmetic-only offset between where the shell IS (physics, must match the
      // server) and where it is DRAWN (the barrel, which includes the correction
      // offset). Decays over flight; see _spawnPredicted.
      drawOffX: 0, drawOffY: 0,
      dead: false, deadAt: 0, hitId: 0, hitTower: -1,
    };
    this.shells.set(key, s);
    return s;
  }

  // A shell is spent. CONTACT feedback only: sparks, sound, shake — the things a
  // graze also produces, so nothing here ever needs to be undone. Health bars,
  // deaths, kill credit all wait for the server (`bx`/`death`/snapshot). The one
  // exception is static geometry — walls and towers don't move, so the client's
  // verdict on them is the server's verdict, and it plays with full confidence.
  // The dead shell stays in the map so the echo lands on it and stays silent.
  _endShell(s, victimId, shielded = false) {
    if (s.dead) return;
    s.dead = true;
    s.deadAt = performance.now();
    s.hitId = victimId || 0;
    s.blocked = shielded;
    s.hitTower = victimId ? -1 : nearestTower(s.x, s.y);

    if (victimId) {
      if (shielded) {
        // the bubble ate it: deflection flash + clang, no hurt, no damage story
        this.effects.push({ kind: 'deflect', x: s.x, y: s.y, born: s.deadAt, dur: 300 });
        this.events.push({ kind: 'bounce', key: s.key, x: s.x });
        return;
      }
      this.effects.push({ kind: 'hit', x: s.x, y: s.y, born: s.deadAt, dur: 450 });
      const mine = victimId === this.myId;
      if (mine) this._selfFeedbackAt = s.deadAt;
      this.shake = Math.max(this.shake, mine ? 7 : 3);
      this.events.push({ kind: mine ? 'hurt' : 'hit', key: victimId, x: s.x });
      return;
    }
    if (s.hitTower >= 0) {
      // Static geometry — but only when unambiguous: if a tank is close enough to
      // the impact that the server might score a TANK hit instead, retire quietly
      // and let the echo speak, so tower feedback never has to be walked back.
      if (this._tankNearImpact(s)) { s.hitTower = -2; return; }
      if (s.mine && s.hitTower !== this.myTeam) { this.matchTowerDamage += BULLET_DAMAGE; s.counted = true; }
      this.effects.push({ kind: 'hit', x: s.x, y: s.y, born: s.deadAt, dur: 450 });
      this.shake = Math.max(this.shake, 5);
      this.events.push({ kind: 'towerhit', key: s.hitTower, x: s.x });
      return;
    }
    this.effects.push({ kind: 'poof', x: s.x, y: s.y, born: s.deadAt, dur: 250 });
    this.events.push({ kind: 'bounce', key: s.key, x: s.x });
  }

  // Is any living tank near this spent shell's final segment? Used to demote a
  // tower/wall verdict to "wait for the server" when the server might disagree.
  _tankNearImpact(s) {
    const r = 2 * HIT_RADIUS;
    for (const buf of this.remotes.values()) {
      const last = buf.length ? buf[buf.length - 1] : null;
      if (last && last.alive && segPointDist(s.prevX, s.prevY, s.x, s.y, last.x, last.y) < r) return true;
    }
    if (this.me && this.meServer && this.meServer.alive
        && segPointDist(s.prevX, s.prevY, s.x, s.y, this.me.x, this.me.y) < r) return true;
    return false;
  }

  // Resolve every live shell against exactly the tanks being DRAWN this frame, so
  // an impact lands the instant it connects on screen. Swept (previous->current),
  // so a 1750 px/s shell cannot skip a target between frames. Incoming fire is
  // tested against where WE were on the same interpolated timeline the shell is
  // drawn on, not against our predicted present — two different clocks used to
  // produce phantom hits and miss real ones.
  resolveHits(others, renderMs) {
    for (const s of this.shells.values()) {
      if (s.dead) continue;
      let hitId = 0, shielded = false;
      for (const t of others) {
        if (!t.alive || t.id === s.owner) continue;
        // RAW interpolated position, not the smoothed one: the server rewinds to
        // raw history, and testing against x+errX disagreed with it by up to
        // MAX_ERR px during exactly the corrections that matter.
        if (segPointDist(s.prevX, s.prevY, s.x, s.y, t.rawX ?? t.x, t.rawY ?? t.y) < HIT_RADIUS) {
          hitId = t.id; shielded = t.power === POWER.SHIELD; break;
        }
      }
      if (!hitId && !s.mine && this.meServer && this.meServer.alive) {
        const past = this.meAt(renderMs);
        if (past && segPointDist(s.prevX, s.prevY, s.x, s.y, past.x, past.y) < HIT_RADIUS) {
          hitId = this.myId;
          shielded = this.meServer.power === POWER.SHIELD;
        }
      }
      if (hitId) this._endShell(s, hitId, shielded);
    }
  }

  // Wipe every shell: a respawn, a match reset or a reconnect invalidates all of
  // them at once.
  _clearShells() {
    this.shells.clear();
    this._selfFeedbackAt = -1e9;
  }

  // Pooled shell list for the renderer — this runs every frame.
  renderShells() {
    const out = this._shellOut;
    out.length = 0;
    for (const s of this.shells.values()) if (!s.dead) out.push(s);
    return out;
  }

  // Where OUR tank was on the interpolated timeline. Incoming shells are rendered
  // ~INTERP_DELAY behind, so testing them against our predicted present position
  // compared two different clocks — at 205 px/s that is ~31px of disagreement,
  // more than a tank radius, which produced phantom hits and missed real ones.
  meAt(renderMs) {
    const h = this._meHist;
    if (!h.length) return null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= renderMs) {
        const b = h[Math.min(i + 1, h.length - 1)];
        const span = b.t - h[i].t;
        const f = span > 0 ? Math.min(1, (renderMs - h[i].t) / span) : 0;
        return { x: h[i].x + (b.x - h[i].x) * f, y: h[i].y + (b.y - h[i].y) * f };
      }
    }
    return h[0];
  }

  recordSelf(serverMs, x, y) {
    const h = this._meHist;
    h.push({ t: serverMs, x, y });
    while (h.length > 2 && h[0].t < serverMs - 500) h.shift();
  }

  // Ids are recycled aggressively (lowest free 1..4, and a bot refills a vacated
  // seat the next tick), so pooled smoothing state MUST die with its owner —
  // otherwise the new occupant glides in from the previous player's last position.
  _forgetRemote(id) {
    this.remotes.delete(id);
    this._remotePool.delete(id);
  }

  // A respawn/reset teleports the tank. The buffer is cleared so nothing
  // interpolates across it; the pooled offset has to be told too, or the teleport
  // gets folded into errX and smoothed — exactly what clearing the buffer prevents.
  _breakSmoothing(id) {
    const st = this._remotePool.get(id);
    if (st) { st.hasPrev = false; st.errX = 0; st.errY = 0; st.dispHp = undefined; }
  }

  // 0..1 for the reload arc drawn around your own tank
  // 0..1 progress of whatever gate is currently blocking the trigger
  reloadFraction() {
    const now = performance.now();
    if (this._reloadUntil > now) {
      return Math.max(0, 1 - (this._reloadUntil - now) / (RELOAD_TIME * 1000));
    }
    const left = this._nextFireAtMs - now;
    if (left <= 0) return 1;
    return Math.max(0, 1 - left / (FIRE_COOLDOWN * 1000));
  }

  _spawnPredicted(nonce, a) {
    const now = performance.now();
    this._nextFireAtMs = now + FIRE_COOLDOWN * 1000;
    this._localAmmo = Math.max(0, this.ammo - 1);
    this._localAmmoAt = now;
    if (this._localAmmo === 0) {
      this._reloadUntil = now + RELOAD_TIME * 1000;
      this.events.push({ kind: 'reload' });
    }
    // PHYSICS spawns from the true predicted position — the same origin the
    // server uses — otherwise any active correction (errX) laterally offset the
    // whole trajectory by up to MAX_ERR px and the server scored different hits
    // than the player watched. The muzzle flash and the first frames of the
    // tracer still DRAW from the barrel: the offset rides on the shell as a
    // cosmetic delta and eases out in flight.
    // Powers change what leaves the barrel, and the client KNOWS its own power
    // (authoritative flag bits) — so prediction fires the same pattern the
    // server will: two fanned shells on DOUBLE, one heavy shell on POWERSHOT.
    const myPower = this.meServer ? this.meServer.power : POWER.NONE;
    const angles = myPower === POWER.DOUBLE
      ? [a - DOUBLE_SPREAD / 2, a + DOUBLE_SPREAD / 2]
      : [a];
    const isPower = myPower === POWER.POWERSHOT;
    this.shake = Math.max(this.shake, isPower ? 5 : 2.5);
    this.lastFireAt = performance.now();
    angles.forEach((aa, sub) => {
      const x = this.me.x + Math.cos(aa) * MUZZLE_OFFSET;
      const y = this.me.y + Math.sin(aa) * MUZZLE_OFFSET;
      if (sub === 0) this.events.push({ kind: 'fire', key: this.myId, x: x + this.errX });
      const s = this._spawnShell(sub ? `n${nonce}s1` : `n${nonce}`, x, y, aa, this.myId, false);
      s.drawOffX = this.errX; s.drawOffY = this.errY;
      s.isPower = isPower;
      this.effects.push({
        kind: 'muzzle', x: x + this.errX, y: y + this.errY, a: aa,
        born: performance.now(), dur: 90,
      });
    });
  }

  // ---------- snapshots ----------
  onSnapshot(snap) {
    if (!this.myId) return;
    // Drop stale/duplicate snapshots. TCP never reorders, but the netsim test
    // relay does (UDP-style, on purpose) — and an out-of-order OLD snapshot
    // appended after a newer one briefly resurrected dead tanks and rewound
    // health bars. One monotonicity check closes the whole class.
    if (this._lastSnapTick !== undefined && snap.tick <= this._lastSnapTick) return;
    this._lastSnapTick = snap.tick;
    if (snap.towerHp) this.towerHp = snap.towerHp;
    this.runes = snap.runes ?? [];
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
      if (this.remotes.get(id).seen !== snap.tick) this._forgetRemote(id);
    }
  }

  _reconcile(server, ackSeq) {
    const wasAlive = this.meServer ? this.meServer.alive : true;
    // Taking damage used to produce literally nothing — you died without ever
    // knowing you were being shot. Surface it as shake + a feedback event — but
    // exactly ONCE per hit: the contact beat usually already played when the shell
    // visibly touched us (see _endShell), and this snapshot arrives ~1 RTT later.
    // Without the stamp, sustained fire thumped twice per shell.
    if (server.alive && server.hp < this.lastHp
        && performance.now() - this._selfFeedbackAt > SELF_FEEDBACK_MS) {
      this._selfFeedbackAt = performance.now();
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
      // Dead — and the SERVER said so; our own death is never asserted locally.
      // Camera stays where we died.
      this.pending.length = 0;
      this.me.vx = 0; this.me.vy = 0;
      if (wasAlive) {
        this.effects.push({ kind: 'explosion', x: this.me.x, y: this.me.y, born: performance.now(), dur: 600, team: this.myTeam });
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
        // Joining DURING a result screen used to render "undefined destroyed the
        // tower", show DEFEAT unconditionally (winner -1 === myTeam 0 is false),
        // and award a loss for a match this player never took part in.
        this.winner = -1;
        this.matchOverAt = performance.now();
        this.matchDeaths = 0;
        this.matchTowerDamage = 0;
        this.pendingAward = null;
        // reconnect hygiene: drop state from the previous connection. Bullet ids
        // restart at 1 when a room is recreated, so a stale shell under the same
        // key would silently swallow the first impact of the new session.
        this.remotes.clear();
        this.pending.length = 0;
        this._clearShells();
        this._resetMagazine();
        this._lastSnapTick = undefined;  // a restarted server's tick starts lower
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
        this._forgetRemote(msg.id);
        break;
      case 'matchover':
        this.phase = 'over';
        this.winner = msg.winner;
        this.wins = msg.wins || this.wins;
        this.matchOverAt = performance.now();
        this.shake = Math.max(this.shake, 20);
        this.hitstopMs = 90;
        this.events.push({ kind: msg.winner === this.myTeam ? 'win' : 'lose' });
        // Snapshot the result HERE. Awarding from the render loop lost the whole
        // match whenever the app was backgrounded across the match end — rAF is
        // suspended, the server resets after 6s, and the overlay never flipped.
        this.pendingAward = {
          won: msg.winner === this.myTeam,
          kills: this.meServer ? this.meServer.score : 0,
          deaths: this.matchDeaths,
          towerDamage: this.matchTowerDamage,
        };
        // the arena is frozen server-side; drop shells so none linger on screen
        this._clearShells();
        break;
      case 'matchstart':
        this.phase = 'playing';
        this.winner = -1;
        this.wins = msg.wins || this.wins;
        this.towerHp = [TOWER_HP, TOWER_HP];
        this._clearShells();
        this.pending.length = 0;
        this.errX = 0; this.errY = 0;
        this._resetMagazine();
        this.matchDeaths = 0;
        this.matchTowerDamage = 0;
        for (const id of this.remotes.keys()) {
          this.remotes.get(id).length = 0;  // don't interpolate across the reset
          this._breakSmoothing(id);
        }
        break;
      case 'fire': {
        // MY shot: the shell already exists. Re-key it to the server's id — never
        // spawn a second one. This is the whole fix for "two shells per trigger
        // pull": the old code only adopted a shell that was still ALIVE, so any
        // shot that had already hit a wall got re-created at the muzzle and flew
        // the entire path again.
        // `sub` distinguishes the two shells of a DOUBLE (0 = first, 1 = second)
        const mineKey = msg.sub ? `n${msg.nonce}s1` : `n${msg.nonce}`;
        if (msg.id === this.myId && this.shells.has(mineKey)) {
          const s = this.shells.get(mineKey);
          this.shells.delete(mineKey);
          s.key = msg.bid;
          s.confirmed = true;
          s.isPower = !!msg.power;
          this.shells.set(msg.bid, s);
          break;
        }
        if (msg.id === this.myId) break;   // my shot, already spent and purged
        // (or a power desync around expiry: the bx fallback still shows its impact)

        // Remote shot. It was fired `age` ago on the render timeline, so catch it
        // up to now in one go rather than parking it on a per-bullet cursor.
        const s = this._spawnShell(msg.bid, msg.x, msg.y, msg.a, msg.id, true);
        s.isPower = !!msg.power;
        const ageMs = this.net.serverNowMs() - this.net.interpDelayMs() - msg.tick * DT * 1000;
        if (ageMs > 0 && !this._advance(s, Math.min(ageMs, 400) / 1000)) this._endShell(s, 0);
        this.effects.push({ kind: 'muzzle', x: msg.x, y: msg.y, a: msg.a, born: performance.now(), dur: 90 });
        this.events.push({ kind: 'fire', key: msg.id, x: msg.x });
        // Tower shots drive the tower barrel's aim and recoil.
        if (msg.id >= TOWER_OWNER_BASE) {
          const t = this.towerState[msg.id - TOWER_OWNER_BASE];
          if (t) { t.aim = msg.a; t.firedAt = performance.now(); }
        }
        break;
      }
      case 'bx': {
        // THE CONSEQUENCE CHANNEL. Everything that asserts a fact — damage dealt,
        // tower credit, the confirm beat — happens here and only here.
        const s = this.shells.get(msg.bid);
        // a bullet retired because its owner left carries no `tower` field
        const tower = msg.tower ?? -1;
        this.shells.delete(msg.bid);
        const now = performance.now();
        // Burst where OUR copy of the shell is: the client copy deliberately runs
        // ~1 RTT ahead of the server's authoritative position, so msg.x/msg.y put
        // the explosion ~34px behind the shell at 80ms one-way.
        const ex = s ? s.x : msg.x;
        const ey = s ? s.y : msg.y;
        const mine = !!(s && s.mine);

        // Confirm beat: the server ruled MY shell hit an enemy. This is the moment
        // damage became real, so the hitmarker and damage number live here.
        // A SHIELDED hit dealt nothing — no marker, no number; the deflect below
        // tells that story instead.
        if (mine && msg.hit && msg.hit !== this.myId && !msg.blocked) {
          this.effects.push({
            kind: 'confirm', x: ex, y: ey, born: now, dur: 400,
            dmg: msg.power ? 'KILL' : BULLET_DAMAGE,
          });
          this.events.push({ kind: 'confirm', key: msg.hit, x: ex });
        }
        // Tower damage credit — authoritative; skip if already tallied at contact.
        if (tower >= 0 && mine && !s.counted && tower !== this.myTeam) {
          this.matchTowerDamage += BULLET_DAMAGE;
        }

        // Contact feedback: skip only if the local contact already played AND told
        // the same story. hitTower === -2 means we retired silently near a tank
        // (ambiguous) — contact never played, so the echo speaks in full.
        const played = !!(s && s.dead && s.hitTower !== -2);
        if (played && msg.hit === s.hitId && tower === s.hitTower
            && !!msg.blocked === !!s.blocked) break;
        if (msg.blocked) {
          // shield deflection: the shell died on the bubble, nobody got hurt
          this.effects.push({ kind: 'deflect', x: ex, y: ey, born: now, dur: 300 });
          this.events.push({ kind: 'bounce', key: msg.bid, x: ex });
          break;
        }
        this.effects.push({
          kind: msg.hit ? 'hit' : 'poof',
          x: ex, y: ey, born: now, dur: msg.hit ? 450 : 250,
        });
        if (tower >= 0) {
          this.shake = Math.max(this.shake, 5);
          this.events.push({ kind: 'towerhit', key: tower, x: ex });
        } else if (msg.hit === this.myId) {
          // one hurt beat per hit — the contact path may have covered it already
          if (now - this._selfFeedbackAt > SELF_FEEDBACK_MS) {
            this._selfFeedbackAt = now;
            this.shake = Math.max(this.shake, 7);
            this.events.push({ kind: 'hurt', key: msg.hit, x: ex });
          }
        } else if (msg.hit) {
          this.events.push({ kind: 'hit', key: msg.hit, x: ex });
        } else {
          this.events.push({ kind: 'bounce', key: msg.bid, x: ex });
        }
        break;
      }
      case 'death': {
        // ALWAYS authoritative, never suppressed: the only path that can explode a
        // tank, so a kill can never be shown and then taken back.
        const enemy = (this.teams.get(msg.victim) ?? 0) !== this.myTeam || msg.victim === this.myId;
        if (msg.victim === this.myId) {
          this.matchDeaths += 1;
          this.respawnCountdown = performance.now() + RESPAWN_DELAY * 1000;
          this.killedBy = this.names.get(msg.killer) || (msg.killer >= 200 ? 'a tower' : '');
        } else if (msg.killer === this.myId && enemy) {
          // A kill is the emotional peak of the match. (Teamkills get the feed row
          // below but no banner and no sting — the server refuses the point too.)
          this.shake = Math.max(this.shake, 10);
          this.hitstopMs = Math.max(this.hitstopMs, 30);
          this.killBannerAt = performance.now();
          this.killBannerName = this.names.get(msg.victim) || '';
          this.events.push({ kind: 'kill' });
        }
        if (msg.victim !== this.myId) {
          // Explode at the position the victim is DRAWN this frame — the latest
          // snapshot is ~interp-delay ahead of the rendered tank, so using it put
          // the explosion visibly in front of the sprite.
          const pool = this._remotePool.get(msg.victim);
          const buf = this.remotes.get(msg.victim);
          const last = buf && buf.length ? buf[buf.length - 1] : null;
          const px = pool && pool.hasPrev ? pool.rawX + pool.errX : (last ? last.x : msg.x ?? null);
          const py = pool && pool.hasPrev ? pool.rawY + pool.errY : (last ? last.y : msg.y ?? null);
          if (px !== null && px !== undefined) {
            this.effects.push({
              kind: 'explosion', x: px, y: py,
              born: performance.now(), dur: 600,
              team: this.teams.get(msg.victim) ?? (last ? last.team : 0),
            });
            this.shake = Math.max(this.shake, 6);
          }
        }
        this.feed.push({
          killer: this.names.get(msg.killer) || (msg.killer >= 200 ? 'Tower' : '?'),
          killerTeam: msg.killer >= 200 ? (this.teams.get(msg.victim) ^ 1) : (this.teams.get(msg.killer) ?? 0),
          victim: this.names.get(msg.victim) || '?',
          victimTeam: this.teams.get(msg.victim) ?? 0,
          at: performance.now(),
        });
        if (this.feed.length > 3) this.feed.shift();
        break;
      }
      case 'spawn': {
        const buf = this.remotes.get(msg.id);
        if (buf) buf.length = 0; // don't interpolate across a teleport
        this._breakSmoothing(msg.id);
        if (msg.id === this.myId) { this._resetMagazine(); this._selfFeedbackAt = -1e9; }
        this.effects.push({ kind: 'spawn', x: msg.x, y: msg.y, born: performance.now(), dur: 500 });
        break;
      }
      case 'rune':
        // somebody claimed the rune: flash + sound for everyone, countdown for me
        this.effects.push({ kind: 'powerup', x: msg.x, y: msg.y, born: performance.now(), dur: 600 });
        this.events.push({ kind: 'powerup', key: msg.taker, x: msg.x });
        if (msg.taker === this.myId) this.myPowerUntil = performance.now() + POWER_DURATION * 1000;
        break;
    }
  }

  // Push a shell forward by `secs` of flight, in fixed sim steps so wall contact
  // is found at the same place the server finds it. Returns false if it expired.
  _advance(s, secs) {
    let left = secs;
    while (left > 1e-6) {
      const h = Math.min(DT, left);
      left -= h;
      if (!stepBullet(s, h)) return false;
    }
    return true;
  }

  // ---------- per-render-frame ----------
  frame(dtSec = 1 / 60) {
    const renderMs = this.net.serverNowMs() - this.net.interpDelayMs();
    const now = performance.now();
    const kOff = Math.exp(-dtSec / ERR_HALFLIFE);

    // Every shell, live or spent, on one clock: real elapsed frame time. No
    // per-bullet cursor, no dormancy, no second timeline to disagree with.
    for (const [key, s] of this.shells) {
      if (s.dead) {
        if (now - s.deadAt > LINGER_MS) this.shells.delete(key);
        continue;
      }
      if (!s.confirmed && now - s.bornAt > UNCONFIRMED_MS) { this.shells.delete(key); continue; }
      // Keep the whole frame's travel for the swept hit test: sweeping from the
      // post-step position only covers one tick (29px at 1750 px/s), so on a
      // 30 fps phone half the shell's motion went untested.
      s.prevX = s.x; s.prevY = s.y;
      // the cosmetic barrel offset eases out over the first frames of flight
      s.drawOffX *= kOff; s.drawOffY *= kOff;
      if (!this._advance(s, Math.min(dtSec, 0.1))) this._endShell(s, 0);
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
        // Ease the extrapolated VELOCITY to zero by integrating it — scaling the
        // displacement instead makes the curve peak and come back to zero, which
        // literally drove the tank backwards at ~185 px/s when a stream stalled.
        // disp(s) = s - s^3/(3T^2) is monotonic and plateaus at 2T/3.
        const T = MAX_EXTRAP_MS / 1000;
        const s = Math.min((renderMs - b.tMs) / 1000, T);
        const disp = s - (s * s * s) / (3 * T * T);
        x = b.x + b.vx * disp;
        y = b.y + b.vy * disp;
        hull = b.hull; turret = b.turret;
      } else {
        // clamp: right after spawn/join every buffered entry can be newer than
        // renderMs — hold at the first snapshot instead of extrapolating backwards
        const f = Math.min(1, Math.max(0, (renderMs - a.tMs) / Math.max(1, b.tMs - a.tMs)));
        x = lerp(a.x, b.x, f); y = lerp(a.y, b.y, f);
        hull = lerpAngle(a.hull, b.hull, f);
        turret = lerpAngle(a.turret, b.turret, f);
      }

      // Fold only a genuine DISCONTINUITY into the offset. Comparing raw frame
      // displacement against a fixed 1.5px threshold treated ordinary motion as a
      // jump: at 205 px/s every frame moves 3.4px, so the offset accumulated
      // continuously and drew every moving enemy up to 17px behind — and switched
      // on and off as speed crossed the threshold. Compare against expected motion.
      if (st.hasPrev) {
        const expect = Math.hypot(b.vx, b.vy) * dtSec + 2;
        const jump = Math.hypot(x - st.rawX, y - st.rawY);
        if (jump > expect && jump < 200) { st.errX += st.rawX - x; st.errY += st.rawY - y; }
      }
      st.rawX = x; st.rawY = y; st.hasPrev = true;
      const m = Math.hypot(st.errX, st.errY);
      if (m > MAX_ERR) { const s = MAX_ERR / m; st.errX *= s; st.errY *= s; }
      st.errX *= k; st.errY *= k;

      st.id = id;
      st.x = x + st.errX; st.y = y + st.errY;
      st.vx = b.vx; st.vy = b.vy;
      st.hull = hull; st.turret = turret;
      // Authoritative hp/alive, always — the server is the only thing that can
      // kill a tank, so a kill can never be shown and then taken back. The BAR
      // eases toward the authoritative value so a confirmed hit reads as a drop,
      // not a step (display only; nothing reads dispHp back).
      st.hp = b.hp;
      if (st.dispHp === undefined || !b.alive) st.dispHp = b.hp;
      else st.dispHp += (b.hp - st.dispHp) * (1 - Math.exp(-dtSec / HP_SMOOTH_S));
      st.alive = b.alive;
      st.power = b.power ?? 0;
      st.score = b.score; st.team = b.team;
      st.name = this.names.get(id) || '?';
      out.push(st);
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

// Which tower did this shell detonate on, if any? The shared sim kills a shell
// that reaches a tower, so proximity at death is the whole classification.
function nearestTower(x, y) {
  for (let i = 0; i < TOWERS.length; i++) {
    const t = TOWERS[i];
    if (Math.hypot(x - t.x, y - t.y) <= TOWER_HIT_RADIUS) return i;
  }
  return -1;
}

const lerp = (a, b, f) => a + (b - a) * f;
const lerpAngle = (a, b, f) => a + wrapAngle(b - a) * f;
// seq a <= b with u16 wraparound
const seqLte = (a, b) => ((b - a + 65536) % 65536) < 32768;
