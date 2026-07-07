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
  MAX_PLAYERS_PER_ROOM, decodeInput, encodeSnapshot, encodePong,
} from '../client/shared/protocol.js';
import { stepTank, stepBullet, makeTank, SPAWN_POINTS, OBSTACLES } from '../client/shared/sim.js';

const PORT = process.env.PORT || 8080;
const MAX_CONNS = 128;
const MAX_ROOMS = 32;
const INPUT_QUEUE_CAP = 6;      // jitter buffer cap; beyond this old inputs are dropped
const INPUTS_PER_TICK = 2;      // catch-up bound (limits burst speed-up)
const IDLE_TIMEOUT_MS = 15000;  // kick silent connections (clients ping every 2 s)
const HELLO_TIMEOUT_MS = 5000;

// ---------- rooms ----------
const rooms = new Map(); // roomId -> Room

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map(); // playerId -> Player
    this.bullets = [];
    this.nextBulletId = 1;
  }
  freeId() {
    for (let i = 1; i <= MAX_PLAYERS_PER_ROOM; i++) if (!this.players.has(i)) return i;
    return 0;
  }
  broadcastJson(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
  }
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = new Room(id);
    rooms.set(id, room);
  }
  return room;
}

function pickSpawn(room) {
  // farthest spawn point from living enemies
  let best = SPAWN_POINTS[0], bestD = -1;
  for (const s of SPAWN_POINTS) {
    let d = Infinity;
    for (const p of room.players.values()) {
      if (!p.tank.alive) continue;
      d = Math.min(d, Math.hypot(p.tank.x - s.x, p.tank.y - s.y));
    }
    if (d > bestD) { bestD = d; best = s; }
  }
  return best;
}

// ---------- per-tick simulation ----------
let tick = 0;

function stepRoom(room) {
  // 1. apply queued inputs (each input == one client tick of movement)
  for (const p of room.players.values()) {
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

  // 2. bullets — swept hit test (pre-step → post-step segment vs tank circle),
  // so point-blank shots and fast bullets can't skip over a target between ticks
  const survivors = [];
  for (const b of room.bullets) {
    const px = b.x, py = b.y;
    const alive = stepBullet(b, DT);
    let hit = null;
    for (const p of room.players.values()) {
      const t = p.tank;
      if (!t.alive) continue;
      if (p.id === b.owner && b.age < OWNER_GRACE) continue;
      if (segCircleDist(px, py, b.x, b.y, t.x, t.y) < TANK_RADIUS + BULLET_RADIUS) { hit = p; break; }
    }
    if (alive && !hit) { survivors.push(b); continue; }
    room.broadcastJson({ t: 'bx', bid: b.id, x: Math.round(b.x), y: Math.round(b.y), hit: hit ? hit.id : 0 });
    if (hit) applyDamage(room, hit, b.owner);
  }
  room.bullets = survivors;

  // 3. respawns
  for (const p of room.players.values()) {
    if (!p.tank.alive && p.respawnAt !== 0 && tick >= p.respawnAt) {
      const s = pickSpawn(room);
      const t = p.tank;
      t.x = s.x; t.y = s.y; t.vx = 0; t.vy = 0; t.hp = MAX_HP; t.alive = true;
      p.respawnAt = 0;
      p.inputQueue.length = 0; // stale pre-death inputs must not move the fresh tank
      room.broadcastJson({ t: 'spawn', id: p.id, x: s.x, y: s.y });
    }
  }

  // 4. snapshots (binary, per-client ack header)
  const tanks = [];
  for (const p of room.players.values()) tanks.push(p.tank);
  for (const p of room.players.values()) {
    if (p.ws.readyState !== 1) continue;
    if (p.ws.bufferedAmount > 64 * 1024) continue; // don't pile onto a choked socket
    p.ws.send(encodeSnapshot(tick, p.lastAckSeq, p.id, tanks));
  }
}

function tryFire(room, p, inp) {
  // Leaky-bucket cooldown on processing time: the jitter-buffer catch-up can
  // process a legitimately spaced shot "early", so allow a burst of 2 while
  // capping the sustained rate at exactly 1/FIRE_COOLDOWN (anti-cheat bound).
  const now = tick * DT;
  if (now < p.nextFireAt - 1e-6) return;
  p.nextFireAt = Math.max(p.nextFireAt, now - FIRE_COOLDOWN) + FIRE_COOLDOWN;
  const a = inp.aim;
  const x = p.tank.x + Math.cos(a) * MUZZLE_OFFSET;
  const y = p.tank.y + Math.sin(a) * MUZZLE_OFFSET;
  const b = {
    id: room.nextBulletId++, owner: p.id, x, y,
    vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
    age: 0, bounces: 0,
  };
  room.bullets.push(b);
  room.broadcastJson({
    t: 'fire', id: p.id, bid: b.id, nonce: inp.fireNonce,
    x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
    a: Math.round(a * 1000) / 1000, tick,
  });
}

// closest distance from segment (x1,y1)-(x2,y2) to point (cx,cy)
function segCircleDist(x1, y1, x2, y2, cx, cy) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / len2)) : 0;
  return Math.hypot(cx - (x1 + t * dx), cy - (y1 + t * dy));
}

function applyDamage(room, victim, killerId) {
  const t = victim.tank;
  t.hp -= BULLET_DAMAGE;
  if (t.hp > 0) return;
  t.hp = 0;
  t.alive = false;
  victim.respawnAt = tick + Math.round(RESPAWN_DELAY * TICK_RATE);
  const killer = room.players.get(killerId);
  if (killer && killer !== victim) killer.tank.score = Math.min(255, killer.tank.score + 1);
  room.broadcastJson({ t: 'death', victim: victim.id, killer: killerId });
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

// Optional browser-origin allowlist (comma-separated). Unset = allow all —
// non-browser clients (bots, tests) send no Origin and are always allowed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

wss.on('connection', (ws, req) => {
  if (wss.clients.size > MAX_CONNS) { ws.close(1013, 'server full'); return; }
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) { ws.close(4003, 'origin not allowed'); return; }
  req.socket.setNoDelay(true);

  let player = null;
  let room = null;
  let lastMsgAt = Date.now();

  const helloTimer = setTimeout(() => { if (!player) ws.close(4000, 'hello timeout'); }, HELLO_TIMEOUT_MS);

  ws.on('message', (data, isBinary) => {
    try { handleMessage(data, isBinary); } catch { /* a bad frame must never take the server down */ }
  });

  function handleMessage(data, isBinary) {
    lastMsgAt = Date.now();

    if (!isBinary) {
      // JSON control messages
      let msg;
      try { msg = JSON.parse(data.toString().slice(0, 512)); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return; // JSON.parse('null') etc.
      if (msg.t === 'hello' && !player) {
        const roomId = String(msg.room || 'arena').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'arena';
        const name = String(msg.name || 'tank').replace(/[<>&"']/g, '').trim().slice(0, 12) || 'tank';
        const r = getRoom(roomId);
        if (!r) { ws.send(JSON.stringify({ t: 'error', reason: 'server full' })); ws.close(1013); return; }
        const id = r.freeId();
        if (!id) { ws.send(JSON.stringify({ t: 'error', reason: 'room full' })); ws.close(4001); return; }
        clearTimeout(helloTimer);
        room = r;
        const s = pickSpawn(room);
        player = {
          id, name, ws,
          tank: makeTank(id, s.x, s.y),
          inputQueue: [], lastAckSeq: 0, turret: 0, pendingAim: null,
          nextFireAt: -10, respawnAt: 0,
        };
        room.players.set(id, player);
        ws.send(JSON.stringify({
          t: 'welcome', id, room: roomId, tick, tickRate: TICK_RATE,
          players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name })),
        }));
        room.broadcastJson({ t: 'join', id, name });
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
      if (player.inputQueue.length >= INPUT_QUEUE_CAP) player.inputQueue.shift();
      player.inputQueue.push(inp);
    } else if (type === MSG.PING && buf.length >= 9) {
      ws.send(encodePong(v.getFloat64(1, true), Date.now()));
    }
  }

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (player && room) {
      room.players.delete(player.id);
      // retire the leaver's in-flight bullets so a rejoining id can't inherit
      // kill credit (and clients get a clean despawn event)
      const orphaned = room.bullets.filter((b) => b.owner === player.id);
      room.bullets = room.bullets.filter((b) => b.owner !== player.id);
      for (const b of orphaned) room.broadcastJson({ t: 'bx', bid: b.id, x: Math.round(b.x), y: Math.round(b.y), hit: 0 });
      room.broadcastJson({ t: 'leave', id: player.id });
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
