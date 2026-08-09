// TANK — authoritative realtime server.
// Fixed 60 Hz simulation. Clients send binary INPUT packets (seq-numbered); the
// server simulates every tank with the shared sim code, acks the last processed
// seq in each binary SNAPSHOT, and emits infrequent events (fire/death/join) as JSON.
// Latency hygiene: TCP_NODELAY on, permessage-deflate off, snapshots every tick.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  MSG, DT, TICK_RATE, MAX_HP, TANK_RADIUS, BULLET_RADIUS, BULLET_SPEED,
  BULLET_DAMAGE, FIRE_COOLDOWN, OWNER_GRACE, MUZZLE_OFFSET, RESPAWN_DELAY,
  MAX_PLAYERS_PER_ROOM, TEAM_COUNT, TOWER_RADIUS, TOWER_HP, TOWER_RANGE,
  TOWER_FIRE_COOLDOWN, TOWER_MUZZLE_OFFSET, TOWER_OWNER_BASE, MATCH_RESET_DELAY,
  MAX_LAG_TICKS, MAG_SIZE, RELOAD_TIME, decodeInput, encodeSnapshot, encodePong,
  POWER, RUNE_PERIOD, RUNE_CYCLE, POWER_DURATION, RUNE_RADIUS, RUNE_SPOTS,
  POWER_SHOTS, SHIELD_BLOCKS, POWERSHOT_TOWER_DAMAGE, DOUBLE_SPREAD,
} from '../client/shared/protocol.js';
import { stepTank, stepBullet, makeTank, TEAM_SPAWNS, TOWERS, OBSTACLES } from '../client/shared/sim.js';
import { botInput, BOT_PROFILES } from './bot.js';
import { validateAccessToken } from './auth.js';
import { PORT, JWKS_URL, SERVICE_ID, ALLOWED_ORIGINS, BOTS_ENABLED } from './config.js';

const MAX_CONNS = 128;
const MAX_ROOMS = 32;
const INPUT_QUEUE_CAP = 6;      // jitter buffer cap; beyond this old inputs are dropped
const INPUTS_PER_TICK = 2;      // catch-up bound (limits burst speed-up)
const IDLE_TIMEOUT_MS = 15000;  // kick silent connections (clients ping every 2 s)
const HELLO_TIMEOUT_MS = 5000;
const LOBBY_MAX_WAIT = 120;     // s a waiting room will sit before starting itself
const HIST_TICKS = 32;          // position history ring for lag compensation
                                // (> MAX_LAG_TICKS so a rewind never wraps onto itself)

// ---------- rooms ----------
const rooms = new Map(); // roomId -> Room

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map(); // playerId -> Player
    this.bullets = [];
    this.nextBulletId = 1;
    this.towers = TOWERS.map((t) => ({ team: t.team, x: t.x, y: t.y, hp: TOWER_HP, nextFireAt: -10 }));
    // 'lobby'   — an INVITE room waiting for friends. No bots, no simulation.
    // 'playing' — live. 'over' — result screen.
    // World/random rooms are born playing (the platform's world rooms are too);
    // only invite rooms wait, because only they have someone to wait for.
    this.phase = 'playing';
    this.winner = -1;         // team that won the last match
    this.resetAt = 0;         // tick at which a finished match restarts
    this.wins = [0, 0];       // matches won, per team, for the life of the room
    // power runes: one per mirrored spot, spawned as a same-kind PAIR each wave
    this.runes = [0, 0];      // kind at RUNE_SPOTS[i], 0 = empty
    this.runeAt = 0;          // tick the next wave appears (0 = schedule on first step)
    this.runeCycle = 0;       // index into RUNE_CYCLE (deterministic rotation)
    this.isInvite = false;    // set once, by whoever creates the room
    this.hostId = 0;          // lowest-id human; only they may START
    this.ready = new Set();   // player ids that tapped ready
    this.lobbyUntil = 0;      // backstop tick: nobody waits forever on a silent host
  }

  // Roster for the waiting room. Sent on every change, never per-tick.
  lobbyState() {
    return {
      t: 'lobby', hostId: this.hostId, phase: this.phase,
      players: [...this.players.values()].filter((p) => !p.isBot).map((p) => ({
        id: p.id, name: p.name, team: p.tank.team, ready: this.ready.has(p.id),
      })),
    };
  }

  // The host is simply the lowest-numbered human present, so it survives the
  // host leaving with no election protocol.
  refreshHost() {
    let best = 0;
    for (const p of this.players.values()) if (!p.isBot && (!best || p.id < best)) best = p.id;
    const changed = best !== this.hostId;
    this.hostId = best;
    return changed;
  }
  runeByte() { return (this.runes[0] & 0x0f) | ((this.runes[1] & 0x0f) << 4); }
  freeId() {
    for (let i = 1; i <= MAX_PLAYERS_PER_ROOM; i++) if (!this.players.has(i)) return i;
    return 0;
  }
  // Auto-balance: every joiner goes to the smaller team, so 1v1, 2v1 and 2v2 are
  // all playable and a solo player never waits for a lobby to fill.
  pickTeam() {
    const counts = new Array(TEAM_COUNT).fill(0);
    for (const p of this.players.values()) counts[p.tank.team]++;
    let best = 0;
    for (let t = 1; t < TEAM_COUNT; t++) if (counts[t] < counts[best]) best = t;
    return best;
  }
  towerHp() { return this.towers.map((t) => Math.max(0, t.hp)); }
  humans() { let n = 0; for (const p of this.players.values()) if (!p.isBot) n++; return n; }
  broadcastJson(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

// ---------- bots ----------
// Empty seats are filled with bots so a solo launch is a real 2v2, and freed the
// instant a human wants one. A room with no humans left keeps no bots — otherwise
// abandoned rooms would simulate forever.
function addBot(room) {
  const id = room.freeId();
  if (!id) return false;
  const team = room.pickTeam();
  // Roles are picked PER TEAM, not per room. Room-wide picking meant a solo
  // player's first bot (the sieger) landed on the enemy side and their own
  // teammate got whatever was left — one team pushed the objective and the other
  // never did. Each side now starts from 'rush', so both towers take pressure.
  const used = new Set();
  for (const p of room.players.values()) if (p.isBot && p.tank.team === team) used.add(p.profile.key);
  const profile = BOT_PROFILES.find((b) => !used.has(b.key)) || BOT_PROFILES[0];
  const s = pickSpawn(room, team);
  const bot = {
    id, userId: `bot:${room.id}:${id}`, name: profile.name, ws: null,
    isBot: true, profile,
    tank: makeTank(id, s.x, s.y, team),
    inputQueue: [], lastAckSeq: 0, turret: 0, pendingAim: null,
    nextFireAt: -10, respawnAt: 0, reloadAt: 0, powerUntil: 0, powerShots: 0, shieldBlocks: 0,
    hist: new Float32Array(HIST_TICKS * 2), histFilled: false,
    ai: { stuckTicks: 0, evadeUntil: 0, evadeDir: 1, strafeDir: 1 },
  };
  room.players.set(id, bot);
  room.broadcastJson({ t: 'join', id, name: bot.name, team, bot: true });
  return true;
}

function dropBot(room) {
  // drop from the largest team so removing a bot leaves the sides balanced
  const counts = new Array(TEAM_COUNT).fill(0);
  for (const p of room.players.values()) counts[p.tank.team]++;
  let victim = null;
  for (const p of room.players.values()) {
    if (!p.isBot) continue;
    if (!victim || counts[p.tank.team] > counts[victim.tank.team]) victim = p;
  }
  if (!victim) return false;
  room.players.delete(victim.id);
  room.bullets = room.bullets.filter((b) => b.owner !== victim.id);
  room.broadcastJson({ t: 'leave', id: victim.id });
  return true;
}

function ensureBots(room) {
  // A LOBBY IS NEVER BOT-FILLED. The platform's own direct-mode notes record
  // this exact failure: "a bot filled the lone waiting player's room, the round
  // auto-started, and the invited opponent arrived into a live round as a
  // spectator." Bots arrive at START, not while we are waiting for friends.
  if (room.phase === 'lobby') return;
  if (!BOTS_ENABLED || room.humans() === 0) {
    for (const p of [...room.players.values()]) if (p.isBot) room.players.delete(p.id);
    return;
  }
  while (room.players.size < MAX_PLAYERS_PER_ROOM && addBot(room)) { /* fill */ }
}

// `invite` only takes effect when the room is CREATED — a later joiner cannot
// flip a live room back into a lobby, so a wrong or hostile claim can never
// strand players who are already playing.
function getRoom(id, invite = false) {
  let room = rooms.get(id);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = new Room(id);
    if (invite) {
      room.isInvite = true;
      room.phase = 'lobby';
      room.lobbyUntil = tick + Math.round(LOBBY_MAX_WAIT * TICK_RATE);
    }
    rooms.set(id, room);
  }
  return room;
}

function pickSpawn(room, team) {
  // your own half's spawn point that is farthest from any living ENEMY
  const points = TEAM_SPAWNS[team] || TEAM_SPAWNS[0];
  let best = points[0], bestD = -1;
  for (const s of points) {
    let d = Infinity;
    for (const p of room.players.values()) {
      if (!p.tank.alive || p.tank.team === team) continue;
      d = Math.min(d, Math.hypot(p.tank.x - s.x, p.tank.y - s.y));
    }
    if (d > bestD) { bestD = d; best = s; }
  }
  return best;
}

// ---------- per-tick simulation ----------
let tick = 0;

function stepRoom(room) {
  // Waiting room: nothing simulates, but snapshots MUST keep flowing. A direct
  // server that goes silent while a room idles gets its connections culled by
  // the proxy edge (Railway included) after ~60s, and the waiting clients then
  // reconnect-loop forever re-minting access tokens.
  if (room.phase === 'lobby') {
    // Start by ourselves when the room fills, or when the backstop expires so a
    // silent host can never strand the people who did show up.
    if (room.humans() >= MAX_PLAYERS_PER_ROOM || tick >= room.lobbyUntil) startMatch(room);
    sendSnapshots(room);
    return;
  }
  // Match over: the arena is frozen on the result screen. Snapshots keep
  // flowing so clients still render the final state, then the match restarts.
  if (room.phase === 'over') {
    if (tick >= room.resetAt) startMatch(room);
    sendSnapshots(room);
    return;
  }

  // 1. apply queued inputs (each input == one client tick of movement)
  for (const p of room.players.values()) {
    // Bots synthesise their input instead of receiving it, then run through the
    // exact same movement + firing path as a human packet.
    if (p.isBot) {
      const inp = botInput(room, p, tick);
      p.turret = inp.aim;
      p.tank.turret = inp.aim;
      if (p.tank.alive) {
        stepTank(p.tank, inp, DT);
        if (inp.firing) tryFire(room, p, inp);
      }
      continue;
    }
    p.turret = p.pendingAim ?? p.turret;
    let n = 0;
    while (p.inputQueue.length > 0 && n < INPUTS_PER_TICK) {
      // process extras only when backlogged, else exactly one
      if (n === 1 && p.inputQueue.length < 3) break;
      const inp = p.inputQueue.shift();
      n++;
      p.lastAckSeq = inp.seq;
      p.turret = inp.aim;
      if (p.tank.alive) {
        stepTank(p.tank, inp, DT);
        if (inp.firing) tryFire(room, p, inp);
      }
    }
    p.tank.turret = p.turret;
  }

  // 1b. record every tank's position for this tick, so shots can be tested
  // against where a target actually was on the shooter's screen
  for (const p of room.players.values()) {
    const i = (tick % HIST_TICKS) * 2;
    p.hist[i] = p.tank.x;
    p.hist[i + 1] = p.tank.y;
    if (!p.histFilled && (p.histCount = (p.histCount || 0) + 1) >= HIST_TICKS) p.histFilled = true;
  }

  // 2. bullets — swept hit test (pre-step → post-step segment vs tank circle),
  // so point-blank shots and fast bullets can't skip over a target between ticks
  const survivors = [];
  for (const b of room.bullets) {
    const px = b.x, py = b.y;
    const alive = stepBullet(b, DT);
    // LAG COMPENSATION. The shooter aimed at what their screen showed, which is
    // `b.lag` ticks behind the server. Evaluating the shell against present-day
    // positions meant a shot centred on the sprite missed outright — at 205 px/s
    // and 150 ms of view lag the target has moved ~31 px, more than a tank radius.
    // The whole projectile lives in the shooter's timeline, so we test it against
    // history[tick - lag] for its entire flight, which stays self-consistent.
    let hit = null;
    const hi = b.lag > 0 ? (((tick - b.lag) % HIST_TICKS) + HIST_TICKS) % HIST_TICKS * 2 : -1;
    for (const p of room.players.values()) {
      const t = p.tank;
      if (!t.alive) continue;
      if (p.id === b.owner && b.age < OWNER_GRACE) continue;
      let tx = t.x, ty = t.y;
      if (hi >= 0 && p.histFilled) { tx = p.hist[hi]; ty = p.hist[hi + 1]; }
      if (segCircleDist(px, py, b.x, b.y, tx, ty) < TANK_RADIUS + BULLET_RADIUS) { hit = p; break; }
    }
    // A shell that reached a tower is already dead (shared sim detonates it);
    // the authoritative swept test decides whether it counts as tower damage.
    let towerHit = -1;
    if (!hit) {
      for (let i = 0; i < room.towers.length; i++) {
        const tw = room.towers[i];
        if (tw.hp <= 0) continue;
        if (segCircleDist(px, py, b.x, b.y, tw.x, tw.y) < TOWER_RADIUS + BULLET_RADIUS) { towerHit = i; break; }
      }
    }
    if (alive && !hit && towerHit < 0) { survivors.push(b); continue; }
    // SHIELD: the shell detonates on the shielded tank but deals nothing. The
    // bx says so (blocked) so the shooter's client can draw a deflection
    // instead of a hit, and no hurt/confirm feedback lies about damage.
    // SHIELD spends a charge per shot it eats and pops when they run out, so it
    // is a finite resource under fire rather than 7s of guaranteed immunity.
    const blocked = hit && hit.tank.power === POWER.SHIELD;
    if (blocked && --hit.shieldBlocks <= 0) {
      hit.tank.power = POWER.NONE;
      hit.shieldBlocks = 0;
    }
    room.broadcastJson({
      t: 'bx', bid: b.id, x: Math.round(b.x), y: Math.round(b.y),
      hit: hit ? hit.id : 0, tower: towerHit,
      ...(blocked ? { blocked: 1 } : null), ...(b.power ? { power: 1 } : null),
    });
    if (hit && !blocked) applyDamage(room, hit, b.owner, b.power);
    else if (towerHit >= 0) damageTower(room, towerHit, b.power);
    if (room.phase === 'over') break; // tower fell: stop resolving this tick's shells
  }
  room.bullets = room.phase === 'over' ? [] : survivors;

  // 3. respawns
  for (const p of room.players.values()) {
    if (!p.tank.alive && p.respawnAt !== 0 && tick >= p.respawnAt) {
      const s = pickSpawn(room, p.tank.team);
      const t = p.tank;
      t.x = s.x; t.y = s.y; t.vx = 0; t.vy = 0; t.hp = MAX_HP; t.alive = true; t.ammo = MAG_SIZE;
      t.power = POWER.NONE;
      p.respawnAt = 0; p.reloadAt = 0; p.powerUntil = 0; p.powerShots = 0; p.shieldBlocks = 0;
      resetHistory(p, s.x, s.y);
      p.inputQueue.length = 0; // stale pre-death inputs must not move the fresh tank
      room.broadcastJson({ t: 'spawn', id: p.id, x: s.x, y: s.y });
    }
  }

  // 3b. reloads
  {
    const now = tick * DT;
    for (const p of room.players.values()) {
      if (p.reloadAt !== 0 && now >= p.reloadAt) {
        p.tank.ammo = MAG_SIZE;
        p.reloadAt = 0;
      }
    }
  }

  // 4. tower auto-turrets
  stepTowers(room);

  // 4b. power runes
  stepRune(room);

  // 5. snapshots (binary, per-client ack header)
  sendSnapshots(room);
}

// ---------- power runes ----------
// Spawn, pickup and expiry — all server-side. The client renders the rune from
// the snapshot byte and the powers from the tank flag bits; events exist only
// for one-shot feedback (pickup flash/sound).
function stepRune(room) {
  if (room.runeAt === 0) room.runeAt = tick + Math.round(RUNE_PERIOD * TICK_RATE);

  // expire powers
  for (const p of room.players.values()) {
    if (p.tank.power && tick >= p.powerUntil) {
      p.tank.power = POWER.NONE;
      p.powerShots = 0;
      p.shieldBlocks = 0;
    }
  }

  // Each wave fills BOTH spots with the same kind — one gate per team's side of
  // the middle, at the same moment, so neither team owns the spawn. A stale
  // unclaimed rune is overwritten by the next wave. Fixed cadence: the next
  // wave lands RUNE_PERIOD after this one regardless of pickups.
  if (tick >= room.runeAt) {
    const kind = RUNE_CYCLE[room.runeCycle % RUNE_CYCLE.length];
    room.runeCycle += 1;
    room.runes[0] = kind;
    room.runes[1] = kind;
    room.runeAt = tick + Math.round(RUNE_PERIOD * TICK_RATE);
  }

  // pickup, per spot: first living tank to touch one — full heal + power, 7 s
  for (let i = 0; i < 2; i++) {
    if (!room.runes[i]) continue;
    const spot = RUNE_SPOTS[i];
    for (const p of room.players.values()) {
      const t = p.tank;
      if (!t.alive) continue;
      if (Math.hypot(t.x - spot.x, t.y - spot.y) > TANK_RADIUS + RUNE_RADIUS) continue;
      t.hp = MAX_HP;
      t.power = room.runes[i];
      p.powerUntil = tick + Math.round(POWER_DURATION * TICK_RATE);
      p.powerShots = room.runes[i] === POWER.POWERSHOT ? POWER_SHOTS : 0;
      p.shieldBlocks = room.runes[i] === POWER.SHIELD ? SHIELD_BLOCKS : 0;
      room.broadcastJson({ t: 'rune', taker: p.id, kind: room.runes[i], x: spot.x, y: spot.y });
      room.runes[i] = 0;
      break;
    }
  }
}

function sendSnapshots(room) {
  const tanks = [];
  for (const p of room.players.values()) tanks.push(p.tank);
  const towerHp = room.towerHp();
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    if (p.ws.bufferedAmount > 64 * 1024) continue; // don't pile onto a choked socket
    p.ws.send(encodeSnapshot(tick, p.lastAckSeq, p.id, tanks, towerHp, room.runeByte()));
  }
}

// Towers acquire the nearest living ENEMY tank in range and fire. Purely
// server-side: the shot goes out as a normal 'fire' event, so clients replay it
// through the existing deterministic bullet path and never predict tower AI.
function stepTowers(room) {
  const now = tick * DT;
  for (let i = 0; i < room.towers.length; i++) {
    const tw = room.towers[i];
    if (tw.hp <= 0 || now < tw.nextFireAt) continue;

    let target = null, bestD = TOWER_RANGE;
    for (const p of room.players.values()) {
      const t = p.tank;
      if (!t.alive || t.team === tw.team) continue;
      const d = Math.hypot(t.x - tw.x, t.y - tw.y);
      // strict < plus an id tie-break keeps target choice deterministic
      if (d < bestD || (d === bestD && target && p.id < target.id)) { bestD = d; target = p; }
    }
    if (!target) continue;

    tw.nextFireAt = now + TOWER_FIRE_COOLDOWN;
    const a = Math.atan2(target.tank.y - tw.y, target.tank.x - tw.x);
    const x = tw.x + Math.cos(a) * TOWER_MUZZLE_OFFSET;
    const y = tw.y + Math.sin(a) * TOWER_MUZZLE_OFFSET;
    const b = {
      id: room.nextBulletId++, owner: TOWER_OWNER_BASE + i, x, y,
      vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
      age: 0, bounces: 0,
      lag: 0,   // the tower shoots in the server's own present; nothing to rewind
    };
    room.bullets.push(b);
    room.broadcastJson({
      t: 'fire', id: b.owner, bid: b.id, nonce: 0,
      x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
      a: Math.round(a * 1000) / 1000, tick,
    });
  }
}

// A respawn teleports the tank, so the position ring still holds where it died.
// Flood it with the spawn point or a rewound shot could hit a ghost at the corpse.
function resetHistory(p, x, y) {
  for (let i = 0; i < HIST_TICKS; i++) { p.hist[i * 2] = x; p.hist[i * 2 + 1] = y; }
  p.histFilled = true;
  p.histCount = HIST_TICKS;
}

function damageTower(room, idx, power = false) {
  const tw = room.towers[idx];
  if (tw.hp <= 0) return;
  tw.hp -= power ? POWERSHOT_TOWER_DAMAGE : BULLET_DAMAGE;
  if (tw.hp > 0) return;               // HP rides in the snapshot header; no event needed
  tw.hp = 0;
  endMatch(room, 1 - tw.team);         // whoever did NOT own this tower wins
}

function endMatch(room, winner) {
  room.phase = 'over';
  room.winner = winner;
  room.wins[winner] += 1;
  room.bullets.length = 0;
  room.resetAt = tick + Math.round(MATCH_RESET_DELAY * TICK_RATE);
  room.broadcastJson({ t: 'matchover', winner, wins: room.wins, resetIn: MATCH_RESET_DELAY });
}

function startMatch(room) {
  const wasLobby = room.phase === 'lobby';
  room.phase = 'playing';
  room.winner = -1;
  room.bullets.length = 0;
  for (const tw of room.towers) { tw.hp = TOWER_HP; tw.nextFireAt = -10; }
  // fresh rune schedule; the kind cycle restarts so every match opens the same way
  room.runes = [0, 0];
  room.runeAt = 0;
  room.runeCycle = 0;
  // clear the board first so pickSpawn never treats a stale position as an enemy
  for (const p of room.players.values()) p.tank.alive = false;
  for (const p of room.players.values()) {
    const s = pickSpawn(room, p.tank.team);
    const t = p.tank;
    t.x = s.x; t.y = s.y; t.vx = 0; t.vy = 0; t.hp = MAX_HP; t.alive = true; t.score = 0; t.ammo = MAG_SIZE;
    t.power = POWER.NONE;
    p.respawnAt = 0; p.nextFireAt = -10; p.reloadAt = 0; p.powerUntil = 0; p.powerShots = 0; p.shieldBlocks = 0;
    resetHistory(p, s.x, s.y);
    p.inputQueue.length = 0;
  }
  room.broadcastJson({ t: 'matchstart', wins: room.wins });
  // Only NOW do bots arrive: the empty seats of a room that has stopped waiting.
  if (wasLobby) { room.ready.clear(); ensureBots(room); }
}

function tryFire(room, p, inp) {
  // Leaky-bucket cooldown on processing time: the jitter-buffer catch-up can
  // process a legitimately spaced shot "early", so allow a burst of 2 while
  // capping the sustained rate at exactly 1/FIRE_COOLDOWN (anti-cheat bound).
  const now = tick * DT;
  if (now < p.nextFireAt - 1e-6) return;
  // Magazine. Empty starts a reload; nothing fires until it completes.
  if (p.tank.ammo <= 0) {
    if (p.reloadAt === 0) p.reloadAt = now + RELOAD_TIME;
    return;
  }
  p.tank.ammo -= 1;
  if (p.tank.ammo === 0) p.reloadAt = now + RELOAD_TIME;
  p.nextFireAt = Math.max(p.nextFireAt, now - FIRE_COOLDOWN) + FIRE_COOLDOWN;
  // The client reports its view lag at SEND time; the ticks this input then sat
  // in the jitter buffer are additional lag it could not know about (up to 6
  // ticks ≈ 20px at tank speed). -1 because arrival lands mid-interval — without
  // it the common 1-tick delta double-counts ~8ms. Re-clamp the SUM so the
  // rewind can never wrap the 32-tick history ring.
  const queueTicks = inp.arrivalTick === undefined ? 0 : Math.max(0, tick - inp.arrivalTick - 1);
  const lag = Math.max(0, Math.min(MAX_LAG_TICKS, (inp.lagTicks | 0) + queueTicks));

  // Powers. DOUBLE fires two shells fanned around the aim; POWERSHOT fires one
  // devastating shell and burns one of its three charges (the power ends with
  // the last charge, not the clock).
  const isPower = p.tank.power === POWER.POWERSHOT && p.powerShots > 0;
  const angles = p.tank.power === POWER.DOUBLE
    ? [inp.aim - DOUBLE_SPREAD / 2, inp.aim + DOUBLE_SPREAD / 2]
    : [inp.aim];
  if (isPower && (p.powerShots -= 1) === 0) p.tank.power = POWER.NONE;

  angles.forEach((a, sub) => {
    const x = p.tank.x + Math.cos(a) * MUZZLE_OFFSET;
    const y = p.tank.y + Math.sin(a) * MUZZLE_OFFSET;
    const b = {
      id: room.nextBulletId++, owner: p.id, x, y,
      vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
      age: 0, bounces: 0, lag, power: isPower,
    };
    room.bullets.push(b);
    room.broadcastJson({
      t: 'fire', id: p.id, bid: b.id, nonce: inp.fireNonce, sub,
      x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
      a: Math.round(a * 1000) / 1000, tick, power: isPower ? 1 : 0,
    });
  });
}

// closest distance from segment (x1,y1)-(x2,y2) to point (cx,cy)
function segCircleDist(x1, y1, x2, y2, cx, cy) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / len2)) : 0;
  return Math.hypot(cx - (x1 + t * dx), cy - (y1 + t * dy));
}

function applyDamage(room, victim, killerId, power = false) {
  const t = victim.tank;
  t.hp -= power ? t.hp : BULLET_DAMAGE;   // a power shot is an instant kill
  if (t.hp > 0) return;
  t.hp = 0;
  t.alive = false;
  t.power = POWER.NONE;                   // no power survives the grave
  victim.powerShots = 0;
  victim.shieldBlocks = 0;
  victim.respawnAt = tick + Math.round(RESPAWN_DELAY * TICK_RATE);
  const killer = room.players.get(killerId); // undefined for tower kills — no score
  // friendly fire is on, but a teamkill must not be worth a point
  if (killer && killer !== victim && killer.tank.team !== t.team) {
    killer.tank.score = Math.min(255, killer.tank.score + 1);
  }
  // x,y: fallback explosion position for a client that has no interpolation
  // state for the victim yet (just joined / victim never entered a snapshot).
  // Clients with state prefer the position they are DRAWING the victim at.
  room.broadcastJson({
    t: 'death', victim: victim.id, killer: killerId,
    x: Math.round(t.x), y: Math.round(t.y),
  });
}

// drift-corrected global tick loop
const TICK_MS = 1000 / TICK_RATE;
let nextTickAt = Date.now() + TICK_MS;
function loop() {
  const now = Date.now();
  let steps = 0;
  while (now >= nextTickAt && steps < 5) { // bounded catch-up after event-loop stalls
    tick++;
    for (const room of rooms.values()) if (room.players.size > 0) stepRoom(room);
    nextTickAt += TICK_MS;
    steps++;
  }
  if (steps === 5 && now >= nextTickAt) nextTickAt = now + TICK_MS; // give up catching up
  setTimeout(loop, Math.max(0, nextTickAt - Date.now()));
}
loop();

// ---------- networking ----------
// Also serves the client statically (no-store, so dev never fights browser cache).
// In production the client lives on Vercel; this is a convenience for dev + a fallback.
const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'client');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  const path = normalize((req.url || '/').split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  const file = join(CLIENT_DIR, path === '/' || path === '\\' ? 'index.html' : path);
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 2048 });

wss.on('connection', (ws, req) => {
  if (wss.clients.size > MAX_CONNS) { ws.close(1013, 'server full'); return; }
  const origin = req.headers.origin;
  // Browser clients send an Origin; non-browser clients (tests) send none and
  // are always allowed. Unset ALLOWED_ORIGINS = allow all.
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) { ws.close(4003, 'origin not allowed'); return; }
  req.socket.setNoDelay(true);

  let player = null;
  let room = null;
  let auth = null;                 // validated token claims: {sub, room_id, session_id, name}
  let lastMsgAt = Date.now();
  const preAuthBuffer = [];        // frames that arrive before token validation resolves

  // Every direct-mode connection must present a platform-minted access token in
  // the query string (?token=). Validate it BEFORE trusting any frame. The
  // token binds the connection to a user (sub) and a room (room_id) — the
  // client cannot pick either, which is what makes this cheating-resistant.
  let token = '';
  try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch { /* keep '' */ }

  ws.on('message', (data, isBinary) => {
    if (!auth) {
      // Buffer a couple of frames (the client sends `hello` immediately on open,
      // which can beat async token validation). Drop the rest to bound memory.
      if (preAuthBuffer.length < 4) preAuthBuffer.push([data, isBinary]);
      return;
    }
    try { handleMessage(data, isBinary); } catch { /* a bad frame must never take the server down */ }
  });

  validateAccessToken(token, { jwksUrl: JWKS_URL, serviceId: SERVICE_ID })
    .then((claims) => {
      if (ws.readyState !== 1) return;             // client gave up during validation
      auth = claims;
      // Flush anything that arrived while we were verifying, in order.
      const buffered = preAuthBuffer.splice(0);
      for (const [d, b] of buffered) { try { handleMessage(d, b); } catch { /* ignore */ } }
    })
    .catch(() => { try { ws.close(4002, 'invalid token'); } catch { /* already closed */ } });

  const helloTimer = setTimeout(() => { if (!player) ws.close(4000, 'hello timeout'); }, HELLO_TIMEOUT_MS);

  function handleMessage(data, isBinary) {
    lastMsgAt = Date.now();

    if (!isBinary) {
      // JSON control messages
      let msg;
      try { msg = JSON.parse(data.toString().slice(0, 512)); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return; // JSON.parse('null') etc.
      // Only the host starts, only from a lobby. Everything else is ignored
      // rather than answered — a stray frame must never move the room.
      if (msg.t === 'start' && player && room && room.phase === 'lobby'
          && player.id === room.hostId) {
        startMatch(room);
        return;
      }
      if (msg.t === 'ready' && player && room && room.phase === 'lobby') {
        if (msg.v) room.ready.add(player.id); else room.ready.delete(player.id);
        room.broadcastJson(room.lobbyState());
        return;
      }
      if (msg.t === 'hello' && !player) {
        // Room + identity come from the TOKEN, never the client. The display
        // name is the only client-supplied field (cosmetic) — sanitized, and it
        // falls back to the token's name claim / user id.
        const roomId = auth.room_id;
        const name = String(msg.name || auth.name || 'tank').replace(/[<>&"']/g, '').trim().slice(0, 16) || 'tank';
        // The client tells us how it was launched. A false claim is harmless by
        // construction: it can only change the type of YOUR OWN token-bound room
        // at creation time, never let you reach anybody else's.
        const r = getRoom(roomId, msg.invite === true);
        if (!r) { ws.send(JSON.stringify({ t: 'error', reason: 'server full' })); ws.close(1013); return; }
        // A user reconnecting (new socket, same token identity) must not occupy
        // two slots — retire any prior tank they hold in this room first.
        for (const [pid, existing] of [...r.players]) {
          if (existing.isBot) continue;
          if (existing.userId === auth.sub) {
            // The evicted socket's 'close' fires an event-loop turn LATER, by which
            // point freeId() has handed its id to the reconnecting player. Without
            // this flag that close handler deletes the freshly joined player,
            // broadcasts their leave, and hands the seat to a bot — the client stays
            // connected, sends inputs forever and never gets a tank. Every token
            // refresh or cellular blip hit this.
            existing.replaced = true;
            r.players.delete(pid);
            try { existing.ws.close(4008, 'replaced by newer session'); } catch { /* already gone */ }
          }
        }
        // a human always outranks a bot for a seat
        if (!r.freeId()) dropBot(r);
        const id = r.freeId();
        if (!id) { ws.send(JSON.stringify({ t: 'error', reason: 'room full' })); ws.close(4001); return; }
        clearTimeout(helloTimer);
        room = r;
        const team = room.pickTeam();
        const s = pickSpawn(room, team);
        player = {
          id, userId: auth.sub, name, ws,
          tank: makeTank(id, s.x, s.y, team),
          inputQueue: [], lastAckSeq: 0, turret: 0, pendingAim: null,
          nextFireAt: -10, respawnAt: 0, reloadAt: 0, powerUntil: 0, powerShots: 0, shieldBlocks: 0,
          hist: new Float32Array(HIST_TICKS * 2), histFilled: false,
        };
        room.players.set(id, player);
        room.refreshHost();   // BEFORE the welcome, or the first player — who IS
                              // the host — is told hostId 0 and never sees START
        ws.send(JSON.stringify({
          t: 'welcome', id, team, room: roomId, tick, tickRate: TICK_RATE,
          wins: room.wins, phase: room.phase, hostId: room.hostId,
          players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.tank.team, bot: !!p.isBot })),
        }));
        room.broadcastJson({ t: 'join', id, name, team });
        ensureBots(room);            // no-op while a lobby waits
        if (room.phase === 'lobby') room.broadcastJson(room.lobbyState());
      }
      return;
    }

    // binary hot path
    if (!player) return;
    const buf = data; // Buffer
    if (buf.length < 1) return;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
    const type = v.getUint8(0);
    if (type === MSG.INPUT && buf.length >= 11) {
      const inp = decodeInput(v);
      // Stamp arrival: the jitter buffer can hold an input for several ticks
      // before it is processed, and that wait is view lag the client cannot
      // measure — tryFire folds it into the rewind.
      inp.arrivalTick = tick;
      if (player.inputQueue.length >= INPUT_QUEUE_CAP) player.inputQueue.shift();
      player.inputQueue.push(inp);
    } else if (type === MSG.PING && buf.length >= 9) {
      ws.send(encodePong(v.getFloat64(1, true), Date.now()));
    }
  }

  ws.on('close', () => {
    clearTimeout(helloTimer);
    // `=== player` is the load-bearing check: if this session was replaced, the id
    // now belongs to somebody else and must not be torn down here.
    if (player && room && !player.replaced && room.players.get(player.id) === player) {
      room.players.delete(player.id);
      // retire the leaver's in-flight bullets so a rejoining id can't inherit
      // kill credit (and clients get a clean despawn event)
      const orphaned = room.bullets.filter((b) => b.owner === player.id);
      room.bullets = room.bullets.filter((b) => b.owner !== player.id);
      for (const b of orphaned) room.broadcastJson({ t: 'bx', bid: b.id, x: Math.round(b.x), y: Math.round(b.y), hit: 0 });
      room.broadcastJson({ t: 'leave', id: player.id });
      room.ready.delete(player.id);
      room.refreshHost();            // lowest remaining human inherits START
      // refill for whoever is left — and if that was the last human, ensureBots
      // clears the bots so the abandoned room can be reclaimed below
      ensureBots(room);
      if (room.phase === 'lobby') room.broadcastJson(room.lobbyState());
      if (room.players.size === 0) { rooms.delete(room.id); }
    }
  });
  ws.on('error', () => {});

  const idleTimer = setInterval(() => {
    if (Date.now() - lastMsgAt > IDLE_TIMEOUT_MS) { ws.terminate(); clearInterval(idleTimer); }
  }, 5000);
  ws.on('close', () => clearInterval(idleTimer));
});

server.listen(PORT, () => {
  console.log(`TANK server on :${PORT} — tick ${TICK_RATE} Hz, ${OBSTACLES.length} obstacles`);
});
