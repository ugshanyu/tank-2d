// Headless protocol smoke test: boots the server, runs a scripted 2-player match
// over the real binary/JSON protocol, and asserts the full kill chain:
// join -> movement+input acks -> fire -> hit -> death -> score -> respawn.
// Run: npm test

import { spawn } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';
import {
  MSG, DT, encodeInput, decodeInput, encodePing, decodeSnapshot, MAX_HP, BULLET_DAMAGE,
  TOWER_HP, TOWER_OWNER_BASE, MATCH_RESET_DELAY, MAX_LAG_TICKS,
  FIRE_COOLDOWN, MAG_SIZE, RELOAD_TIME, RESPAWN_DELAY,
} from '../client/shared/protocol.js';

// How long a sustained siege actually takes, DERIVED rather than hard-coded — a
// fixed step budget silently becomes a timeout the moment the fire rate changes,
// which is exactly what happened when FIRE_COOLDOWN went from 0.16s to 1s.
// Per shell: the cooldown, plus the reload amortised across a magazine.
const SECONDS_PER_SHELL = FIRE_COOLDOWN + RELOAD_TIME / MAG_SIZE;
const shellSeconds = (shells) => shells * SECONDS_PER_SHELL;

const PORT = 8123;       // deterministic scripted match — bots disabled
const BOT_PORT = 8124;   // second instance with bots on
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`FAIL  ${label}`); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(port, extraEnv = {}) {
  const srv = spawn('node', ['server/server.js'], {
    env: {
      ...process.env, PORT: String(port),
      NODE_ENV: 'development', DEV_ALLOW_UNSIGNED: '1', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    srv.stdout.on('data', (d) => { if (String(d).includes('TANK server')) resolve(); });
    srv.on('exit', () => reject(new Error('server died')));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });
  return srv;
}

class Bot {
  constructor(name, port = PORT) {
    this.name = name;
    this.port = port;
    this.id = 0;
    this.seq = 0;
    this.nonce = 0;
    this.snap = null;        // latest decoded snapshot
    this.events = [];        // all JSON events
    this.ws = null;
  }
  connect(room = 'smoke') {
    return new Promise((resolve, reject) => {
      // Direct-mode auth: every socket presents a token. In the test the server
      // runs with DEV_ALLOW_UNSIGNED=1, which accepts `dev:<userId>:<roomId>`.
      // The room + identity are taken from the TOKEN server-side; the hello
      // frame now carries only the (cosmetic) display name.
      const userId = this.name.replace(/[^\w-]/g, '-');
      const token = `dev:${userId}:${room}`;
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('connect timeout')), 4000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: this.name })));
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const msg = JSON.parse(data.toString());
          this.events.push(msg);
          if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(to); this._keepAlive(); resolve(); }
          return;
        }
        const buf = Buffer.from(data);
        const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
        if (v.getUint8(0) === MSG.SNAPSHOT) this.snap = decodeSnapshot(v);
      });
      ws.on('error', reject);
    });
  }
  // The real client pings every 2 s; without it the server idle-kicks a bot that
  // sits still (e.g. the one parked while the other sieges a tower).
  _keepAlive() {
    this._ka = setInterval(() => {
      if (this.ws.readyState === 1) this.ws.send(encodePing(Date.now()));
    }, 2000);
  }
  me() { return this.snap?.tanks.find((t) => t.id === this.id); }
  tank(id) { return this.snap?.tanks.find((t) => t.id === id); }
  ev(type) { return this.events.filter((e) => e.t === type); }
  send(moveX, moveY, firing = false, aim = 0) {
    this.seq = (this.seq + 1) & 0xffff;
    if (firing) this.nonce = (this.nonce + 1) & 0xffff;
    this.ws.send(encodeInput(this.seq, moveX, moveY, firing, aim, firing ? this.nonce : 0));
  }
  // stream inputs at tick rate for `ticks` ticks
  async drive(ticks, moveX, moveY, firing = false, aim = 0) {
    for (let i = 0; i < ticks; i++) {
      this.send(moveX, moveY, firing, aim);
      await sleep(1000 * DT);
    }
  }
  close() { clearInterval(this._ka); this.ws.close(); }
}

// Drive to a waypoint, x first then y, with a hard tick budget. Axis-aligned so
// the tank tracks the lanes instead of cutting corners into walls, and bounded
// so a snag can never hang the test the way a bare `while (x < target)` would.
async function goTo(bot, tx, ty, maxTicks = 900) {
  let ticks = 0;
  for (const axis of ['x', 'y']) {
    while (ticks < maxTicks) {
      const m = bot.me();
      if (!m || !m.alive) return false;
      const d = (axis === 'x' ? tx - m.x : ty - m.y);
      if (Math.abs(d) < 14) break;
      await bot.drive(4, axis === 'x' ? Math.sign(d) : 0, axis === 'y' ? Math.sign(d) : 0);
      ticks += 4;
    }
    await bot.drive(8, 0, 0); // brake before switching axis
    ticks += 8;
  }
  return ticks < maxTicks;
}

// The lag-compensation field rides in the input packet's last byte and is self
// reported, so the clamp is a security boundary, not a nicety.
function checkProtocol() {
  const rt = (lag) => {
    const buf = encodeInput(1, 0, 0, false, 0, 0, lag);
    return decodeInput(new DataView(buf)).lagTicks;
  };
  check(rt(0) === 0, 'lagTicks round-trips 0');
  check(rt(9) === 9, 'lagTicks round-trips 9');
  check(rt(MAX_LAG_TICKS) === MAX_LAG_TICKS, `lagTicks round-trips ${MAX_LAG_TICKS}`);
  check(rt(9999) === MAX_LAG_TICKS, 'oversized lagTicks clamped (rewind exploit bounded)');
  check(rt(-5) === 0, 'negative lagTicks clamped');
}

// The authority contract: the client renders CONTACT instantly (sparks, sound,
// shake — things a graze also produces) but only the server declares CONSEQUENCE
// (health, explosions, kill credit). A kill must be IMPOSSIBLE to un-happen.
// game.js imports only pure modules, so it runs headless.
async function checkAuthorityContract() {
  const { Game } = await import('../client/js/game.js');
  const newGame = () => new Game({
    sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0,
    interpDelayMs: () => 100,
  });
  const g = newGame();
  g.myId = 1;

  // ---- contact: instant, once, and consequence-free ----
  const s = g._spawnShell('n7', 100, 100, 0, 1, false);
  s.vx = 0; s.vy = 0;
  g._endShell(s, 2);
  check(g.effects.filter((e) => e.kind === 'hit').length === 1, 'contact spark plays immediately');
  check(g.events.filter((e) => e.kind === 'hit').length === 1, 'contact sound fires immediately');
  check(!g.renderShells().includes(s), 'the spent shell stops being drawn at once');
  check(!g.effects.some((e) => e.kind === 'explosion' || e.kind === 'confirm'),
    'contact asserts NOTHING: no explosion, no confirm marker');
  g._endShell(s, 2);
  check(g.effects.filter((e) => e.kind === 'hit').length === 1, 'contact is idempotent across frames');

  // ---- the fire echo re-keys, never respawns (the two-shell bug) ----
  g.onEvent({ t: 'fire', id: 1, bid: 55, nonce: 7, x: 100, y: 100, a: 0, tick: 0 });
  check(g.shells.size === 1 && g.shells.get(55) === s,
    `one trigger pull is exactly one shell (${g.shells.size} in flight)`);
  check(g.renderShells().length === 0, 'a resolved shell is never resurrected on screen');

  // ---- bx = the consequence channel ----
  // Agreement: contact effects are swallowed, but the CONFIRM beat still plays —
  // it is the one symbol that only ever appears when damage really landed.
  const before = g.effects.filter((e) => e.kind === 'hit').length;
  g.onEvent({ t: 'bx', bid: 55, x: 100, y: 100, hit: 2, tower: -1 });
  check(g.effects.filter((e) => e.kind === 'hit').length === before,
    'agreeing echo does not double-flash the contact');
  check(g.effects.filter((e) => e.kind === 'confirm').length === 1,
    'server-confirmed damage draws exactly one hitmarker');
  check(g.events.filter((e) => e.kind === 'confirm').length === 1, 'and one confirm sound');
  check(!g.shells.has(55), 'shell gone after the echo');

  // a live shell of mine is re-keyed in place by the echo
  const live = g._spawnShell('n8', 300, 300, 0, 1, false);
  g.onEvent({ t: 'fire', id: 1, bid: 60, nonce: 8, x: 10, y: 10, a: 0, tick: 0 });
  check(g.shells.size === 1 && g.shells.get(60) === live && live.x === 300,
    'an in-flight shell is re-keyed in place, not respawned at the muzzle');

  // an impact the client never saw locally still plays in full from the server
  g._spawnShell(56, 5, 5, 0, 2, true);
  const fx56 = g.effects.filter((e) => e.kind === 'hit').length;
  g.onEvent({ t: 'bx', bid: 56, x: 5, y: 5, hit: 1, tower: -1 });
  check(g.effects.filter((e) => e.kind === 'hit').length === fx56 + 1, 'server-only impacts still play');

  // ---- health is authoritative, always ----
  const g2 = newGame();
  g2.myId = 1; g2.teams.set(2, 1);
  const shells = Math.ceil(MAX_HP / BULLET_DAMAGE);
  for (let i = 0; i < shells; i++) {
    const b = g2._spawnShell(`n${i}`, 0, 0, 0, 1, false);
    g2._endShell(b, 2);
  }
  check(!g2.effects.some((e) => e.kind === 'explosion'),
    'a full burst of local contacts NEVER invents a kill');
  // remoteStates must report the server's hp/alive verbatim
  g2.remotes.set(2, Object.assign(
    [{ tMs: 0, x: 0, y: 0, vx: 0, vy: 0, hull: 0, turret: 0, hp: MAX_HP, alive: true, score: 0, team: 1 }],
    { seen: 0 },
  ));
  const st = g2.remoteStates(0)[0];
  check(st.hp === MAX_HP && st.alive === true,
    'a tank the server says is alive at full hp is drawn exactly that way');

  // ---- death: only the server can explode a tank, and it always does ----
  const g7 = newGame();
  g7.myId = 1; g7.teams.set(2, 1); g7.names.set(2, 'victim');
  g7.remotes.set(2, Object.assign(
    [{ tMs: 0, x: 40, y: 40, vx: 0, vy: 0, hull: 0, turret: 0, hp: 10, alive: true, score: 0, team: 1 }],
    { seen: 0 },
  ));
  g7.onEvent({ t: 'death', victim: 2, killer: 1 });
  check(g7.effects.some((e) => e.kind === 'explosion'), 'the death event always explodes');
  check(g7.events.some((e) => e.kind === 'kill'), 'and credits the kill');
  check(g7.killBannerAt > 0, 'and shows the banner');
  check(g7.feed.length === 1, 'and records the feed row');

  // ---- a TEAMKILL gets the feed row but no banner, sting or +1 ----
  const g8 = newGame();
  g8.myId = 1; g8.myTeam = 0; g8.teams.set(3, 0); g8.names.set(3, 'buddy');
  g8.onEvent({ t: 'death', victim: 3, killer: 1 });
  check(!g8.events.some((e) => e.kind === 'kill') && g8.killBannerAt < 0,
    'a teamkill never plays the kill sting or banner');
  check(g8.feed.length === 1, 'but the feed still tells the truth');

  // ---- exactly one hurt beat per hit taken, whichever path sees it first ----
  const g3 = newGame();
  g3.myId = 1;
  g3.meServer = { hp: 100, alive: true, ammo: 5, team: 0, score: 0 };
  g3.lastHp = 100;
  g3.me = { x: 0, y: 0, vx: 0, vy: 0, hull: 0 };
  const incoming = g3._spawnShell(9, 0, 0, 0, 2, true);
  g3._endShell(incoming, 1);                   // shell visibly touches ME
  const hurtA = g3.events.filter((e) => e.kind === 'hurt').length;
  g3.onEvent({ t: 'bx', bid: 9, x: 0, y: 0, hit: 1, tower: -1 });
  g3._reconcile({ hp: 100 - BULLET_DAMAGE, alive: true, x: 0, y: 0, vx: 0, vy: 0, hull: 0 }, 0);
  const hurtB = g3.events.filter((e) => e.kind === 'hurt').length;
  check(hurtA === 1, 'contact-detected hit: hurt plays once, immediately');
  check(hurtB === 1, 'the bx echo and the snapshot do NOT replay it');
  // graze path: contact never fired, so the echo owns the beat — still exactly one
  const g3b = newGame();
  g3b.myId = 1;
  g3b.meServer = { hp: 100, alive: true, ammo: 5, team: 0, score: 0 };
  g3b.lastHp = 100;
  g3b.me = { x: 0, y: 0, vx: 0, vy: 0, hull: 0 };
  g3b.onEvent({ t: 'bx', bid: 12, x: 0, y: 0, hit: 1, tower: -1 });
  g3b._reconcile({ hp: 100 - BULLET_DAMAGE, alive: true, x: 0, y: 0, vx: 0, vy: 0, hull: 0 }, 0);
  check(g3b.events.filter((e) => e.kind === 'hurt').length === 1,
    'a graze (no local contact) still hurts exactly once');

  // ---- a wrong local verdict never swallows the truth ----
  const g4 = newGame();
  g4.myId = 1;
  const wrong = g4._spawnShell(70, 0, 0, 0, 1, true);
  g4._endShell(wrong, 2);                       // we thought it grazed tank 2
  const fx = g4.effects.length;
  g4.onEvent({ t: 'bx', bid: 70, x: 0, y: 0, hit: 0, tower: 1 });  // it hit a TOWER
  check(g4.effects.length > fx, 'a wrong local verdict still plays the real impact');
  check(g4.events.some((e) => e.kind === 'towerhit'), 'tower damage is never silent');

  // ---- ambiguous tower contact defers to the server ----
  const g9 = newGame();
  g9.myId = 1;
  // a living remote sits right next to the tower impact point
  g9.remotes.set(2, Object.assign(
    [{ tMs: 0, x: 360, y: 1108, vx: 0, vy: 0, hull: 0, turret: 0, hp: 50, alive: true, score: 0, team: 1 }],
    { seen: 0 },
  ));
  const amb = g9._spawnShell('n1', 360, 1105, 0, 1, false);
  amb.x = 360; amb.y = 1105; amb.prevX = 360; amb.prevY = 1060;  // at the BLUE tower rim
  g9._endShell(amb, 0);
  check(!g9.events.some((e) => e.kind === 'towerhit'),
    'tower feedback is withheld when a tank is close enough to dispute it');
  check(amb.dead, 'but the shell still retires');
}

// The duplicate-shell bug only appeared when the server's `fire` echo arrived
// AFTER the shell had already died — which never happens at 0 ms on loopback.
// So run a real client loop against the real server through the impairment relay,
// firing at a wall two tank-lengths away: flight time is well under the fire
// cooldown, so at no instant may more than ONE of my shells exist.
async function checkLiveShells(port) {
  const { Game } = await import('../client/js/game.js');
  const { startNetSim } = await import('./netsim.js');
  const sim = startNetSim({ listenPort: 8125, targetPort: port, latencyMs: 60, jitterMs: 15 });

  const ws = new WebSocket(`ws://127.0.0.1:8125/ws?token=${encodeURIComponent('dev:shellprobe:shellroom')}`);
  ws.binaryType = 'arraybuffer';
  let snapTick = 0, snapAt = Date.now();
  const game = new Game({
    sendInput: (seq, mx, my, f, aim, nonce, lag) => {
      if (ws.readyState === 1) ws.send(encodeInput(seq, mx, my, f, aim, nonce, lag));
    },
    serverNowMs: () => snapTick * DT * 1000 + (Date.now() - snapAt),
    rtt: 120,
    viewLagTicks: () => 10,
    interpDelayMs: () => 100,
  });

  let spawned = 0, fireEchoes = 0, maxLive = 0;
  const realSpawn = game._spawnShell.bind(game);
  game._spawnShell = (key, x, y, a, owner, confirmed) => {
    if (owner === game.myId) spawned++;
    return realSpawn(key, x, y, a, owner, confirmed);
  };

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('live client connect timeout')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'probe' })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        game.onEvent(msg);
        if (msg.t === 'fire' && msg.id === game.myId) fireEchoes++;
        if (msg.t === 'welcome') { clearTimeout(to); resolve(); }
        return;
      }
      const buf = Buffer.from(data);
      const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
      if (v.getUint8(0) === MSG.SNAPSHOT) {
        const snap = decodeSnapshot(v);
        snapTick = snap.tick; snapAt = Date.now();
        game.onSnapshot(snap);
      }
    });
    ws.on('error', reject);
  });

  const ka = setInterval(() => { if (ws.readyState === 1) ws.send(encodePing(Date.now())); }, 2000);
  const liveNow = () => {
    let n = 0;
    for (const s of game.shells.values()) if (!s.dead && s.owner === game.myId) n++;
    return n;
  };
  // Straight at the side wall a few tank-lengths away: each shell is spent long
  // before the next one leaves the barrel, and long before its own echo arrives.
  const aim = Math.PI;
  for (let i = 0; i < 150; i++) {            // ~2.5 s of held fire
    if (game.me) game.tick({ moveX: 0, moveY: 0, firing: true }, aim);
    maxLive = Math.max(maxLive, liveNow());  // sample with the fresh shell in hand
    game.frame(DT);
    maxLive = Math.max(maxLive, liveNow());
    await sleep(1000 * DT);
  }
  await sleep(400);                          // let the last echoes land

  check(spawned > 0 && fireEchoes > 0, `the live client actually fired (${spawned} shells, ${fireEchoes} echoes)`);
  check(maxLive <= 1, `never more than one of my shells on screen at once (peak ${maxLive})`);
  check(spawned === fireEchoes,
    `every server fire echo adopted a shell instead of spawning one (${spawned} spawned vs ${fireEchoes} echoed)`);

  clearInterval(ka);
  ws.close();
  await sim.close();
}

// THE REPORTED BUG, asserted at state level: a tank drawn dead must stay dead
// until a real respawn. A live Game client joins a bot room over a degraded link
// and watches remoteStates for the whole run: any dead->alive flip faster than a
// respawn means the client asserted a kill the server never confirmed.
async function checkNoRevives(port) {
  const { Game } = await import('../client/js/game.js');
  const { startNetSim } = await import('./netsim.js');
  const sim = startNetSim({ listenPort: 8126, targetPort: port, latencyMs: 60, jitterMs: 20 });

  const ws = new WebSocket(`ws://127.0.0.1:8126/ws?token=${encodeURIComponent('dev:reviveprobe:botroom2')}`);
  ws.binaryType = 'arraybuffer';
  let snapTick = 0, snapAt = Date.now();
  const game = new Game({
    sendInput: (seq, mx, my, f, aim, nonce, lag) => {
      if (ws.readyState === 1) ws.send(encodeInput(seq, mx, my, f, aim, nonce, lag));
    },
    serverNowMs: () => snapTick * DT * 1000 + (Date.now() - snapAt),
    rtt: 120, viewLagTicks: () => 10, interpDelayMs: () => 100,
  });

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('revive probe connect timeout')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'probe' })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        game.onEvent(msg);
        if (msg.t === 'welcome') { clearTimeout(to); resolve(); }
        return;
      }
      const buf = Buffer.from(data);
      const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
      if (v.getUint8(0) === MSG.SNAPSHOT) {
        const snap = decodeSnapshot(v);
        snapTick = snap.tick; snapAt = Date.now();
        game.onSnapshot(snap);
      }
    });
    ws.on('error', reject);
  });

  const ka = setInterval(() => { if (ws.readyState === 1) ws.send(encodePing(Date.now())); }, 2000);

  // THE CONTRACT, asserted directly: the client may never draw a tank dead that
  // the server has not declared dead. Watching for dead->alive flips instead was
  // measuring respawn bookkeeping (id recycling, match resets, the spawn event
  // landing an interp-delay before the rendered revival) and flaked on all three.
  // A server `death` event is the ONLY licence to draw a corpse.
  const deathEventAt = new Map();   // id -> when the server declared it dead
  const seenAlive = new Set();      // ids we have actually drawn alive at least once
  const drawnDead = new Set();      // ids currently drawn dead
  let invented = 0, deathsSeen = 0;
  const realOnEvent = game.onEvent.bind(game);
  game.onEvent = (m) => {
    if (m.t === 'death') deathEventAt.set(m.victim, Date.now());
    if (m.t === 'leave') { deathEventAt.delete(m.id); seenAlive.delete(m.id); drawnDead.delete(m.id); }
    return realOnEvent(m);
  };

  const runMs = 15000;           // bots fight (3-shell kills): deaths WILL happen
  const t0 = Date.now();
  while (Date.now() - t0 < runMs) {
    if (game.me) game.tick({ moveX: 0, moveY: 0, firing: false }, 0);
    const renderMs = game.frame(DT);
    for (const st of game.remoteStates(renderMs, DT)) {
      if (st.alive) { seenAlive.add(st.id); drawnDead.delete(st.id); continue; }
      if (!seenAlive.has(st.id) || drawnDead.has(st.id)) continue;
      drawnDead.add(st.id);
      deathsSeen++;
      // the death event precedes the RENDERED death by about the interp delay,
      // so a legitimate corpse always has a recent server declaration behind it
      const at = deathEventAt.get(st.id);
      if (at === undefined || Date.now() - at > 4000) invented++;
    }
    await sleep(1000 * DT);
  }
  check(deathsSeen > 0, `the probe watched real deaths happen (${deathsSeen} observed)`);
  check(invented === 0,
    `every corpse was declared by the SERVER first — zero invented deaths (${deathsSeen} deaths, ${invented} invented)`);

  clearInterval(ka);
  ws.close();
  await sim.close();
}

// Adaptive interpolation delay: pure math on the offset ring, tested by feeding
// _updateClock a synthetic 60Hz snapshot stream with controlled jitter.
async function checkAdaptiveInterp() {
  const { Net } = await import('../client/js/net.js');
  const mkNet = () => {
    // a resolveUrl that never resolves: full Net instance, no socket
    const n = new Net(() => new Promise(() => {}), { name: 't', onSnapshot() {}, onEvent() {}, onStatus() {} });
    n._clockInit = false; n._offCount = 0; n._offIdx = 0;
    return n;
  };
  const realNow = performance.now.bind(performance);
  const feed = (n, ticks, jitterFn) => {
    for (let i = 0; i < ticks; i++) {
      const arrival = i * DT * 1000 + 80 + jitterFn(i);
      performance.now = () => arrival;
      n._updateClock(i);
    }
    performance.now = realNow;
  };

  try {
    const clean = mkNet();
    feed(clean, 400, () => 0);                      // ~6.7s of perfectly paced snapshots
    check(clean.interpDelayMs() >= 50 && clean.interpDelayMs() <= 62,
      `clean link: interp shrinks to the floor (${Math.round(clean.interpDelayMs())}ms)`);
    check(clean.viewLagTicks() === Math.round(clean.interpDelayMs() / (DT * 1000)),
      'the server is told to rewind to the SAME adapted delay');

    const bursty = mkNet();
    feed(bursty, 400, (i) => (i % 3 === 0 ? 80 * Math.random() : 0));  // 40ms-avg bursts
    check(bursty.interpDelayMs() > clean.interpDelayMs() + 15,
      `bursty link keeps a bigger buffer (${Math.round(bursty.interpDelayMs())}ms vs ${Math.round(clean.interpDelayMs())}ms)`);
    check(bursty.interpDelayMs() <= 150, 'and never exceeds the ceiling');
    clean.close(); bursty.close();
  } finally {
    performance.now = realNow;
  }
}

// Power runes over the real protocol. Kinds cycle deterministically
// (double -> shield -> powershot), so a scripted match can meet each one.
// P picks every rune; W (P's teammate) supplies friendly-fire damage for the
// heal check; V (the enemy) shoots the shield and eats the power shot.
async function checkPowers() {
  const { POWER, RUNE_SPOTS, POWERSHOT_TOWER_DAMAGE, SPEED_MULT, TANK_MAX_SPEED } = await import('../client/shared/protocol.js');
  const P = new Bot('picker');
  const V = new Bot('victim');
  const W = new Bot('wingman');
  await P.connect('powers');   // team 0
  await V.connect('powers');   // team 1 (auto-balance)
  await W.connect('powers');   // team 0
  await sleep(300);

  // no rune on the field before the first period elapses
  check(!P.snap.runes || P.snap.runes.length === 0, 'no rune before the first period');

  // W wounds P (friendly fire) so the heal on pickup is observable — exactly ONE
  // shot: drive() paces on wall time, so a long firing burst lands three shells
  // and kills P outright, which cascades into every later assertion.
  await goTo(W, 300, 1030);
  await W.drive(4, 0, 0, true, Math.PI);
  await sleep(400);
  const wounded = P.me().hp;
  check(wounded < MAX_HP && P.me().alive, `P wounded by friendly fire before the rune (hp ${wounded})`);

  // ---- wave 1: DOUBLE SHOT at BOTH gates ----
  // The gates sit ON the halfway line, in the gaps flanking the centre box. Park
  // P in the left gate's lane but outside the pickup circle, so the pair is
  // observable in a snapshot before P claims one.
  await goTo(P, RUNE_SPOTS[0].x, 900);
  await goTo(P, RUNE_SPOTS[0].x, RUNE_SPOTS[0].y + 110);
  let guard = 0;
  while ((!P.snap.runes || P.snap.runes.length === 0) && guard++ < 80) await P.drive(12, 0, 0);
  check(P.snap.runes.length === 2
        && P.snap.runes[0].kind === POWER.DOUBLE && P.snap.runes[1].kind === POWER.DOUBLE,
    `a wave fills BOTH gates with the same kind (${JSON.stringify(P.snap.runes?.map((r) => r.kind))})`);

  await goTo(P, RUNE_SPOTS[0].x, RUNE_SPOTS[0].y);
  guard = 0;
  while (P.me().power !== POWER.DOUBLE && guard++ < 60) await P.drive(12, 0, 0);
  check(P.me().power === POWER.DOUBLE, `rune 1 grants DOUBLE (power ${P.me().power})`);
  check(P.me().hp === MAX_HP, 'pickup refills health instantly');
  check(P.ev('rune').some((e) => e.taker === P.id && e.kind === POWER.DOUBLE), 'rune pickup event broadcast');
  check(P.snap.runes.length === 1, 'claiming one gate leaves the other rune standing');

  // drive() paces on wall time so a "single" burst can span 2 trigger pulls —
  // assert the INVARIANT instead: every pull while doubled is exactly two fire
  // events sharing a nonce with subs {0,1}.
  const firesBefore = P.ev('fire').filter((e) => e.id === P.id).length;
  await P.drive(20, 0, 0, true, Math.PI);
  await sleep(300);
  const volley = P.ev('fire').filter((e) => e.id === P.id).slice(firesBefore);
  const byNonce = new Map();
  for (const e of volley) { if (!byNonce.has(e.nonce)) byNonce.set(e.nonce, []); byNonce.get(e.nonce).push(e.sub); }
  const pairs = [...byNonce.values()];
  check(volley.length >= 2 && pairs.every((subs) => subs.length === 2 && subs.includes(0) && subs.includes(1)),
    `DOUBLE fires exactly two shells per trigger pull (${pairs.length} pulls, subs ${JSON.stringify(pairs)})`);

  await sleep(7200);                                // let the power expire
  check(P.me().power === POWER.NONE, 'a power lapses after 7 seconds');

  // ---- wave 2: SHIELD (P camps the same gate — both fill every wave) ----
  // Enemy straight up the same lane from the gate: a clear line of fire with no
  // obstacle between (the crossbar spans x 260-460, this lane is x=220).
  await goTo(V, RUNE_SPOTS[0].x, RUNE_SPOTS[0].y - 240);
  guard = 0;
  while (P.me().power !== POWER.SHIELD && guard++ < 80) await P.drive(12, 0, 0);
  check(P.me().power === POWER.SHIELD, `rune 2 grants SHIELD (power ${P.me().power})`);
  const hpShielded = P.me().hp;
  const bxBefore = V.ev('bx').length;
  // aim at where P ACTUALLY is rather than a hard-coded angle
  const aimP = Math.atan2(P.me().y - V.me().y, P.me().x - V.me().x);
  await V.drive(80, 0, 0, true, aimP);             // two shots into the bubble
  await sleep(400);
  const blockedBx = V.ev('bx').slice(bxBefore).filter((e) => e.hit === P.id && e.blocked);
  check(blockedBx.length >= 1, `the shield blocks shots (${blockedBx.length} blocked bx)`);
  check(P.me().hp === hpShielded && P.me().alive, 'and the shielded tank takes zero damage');

  // ---- wave 3: OVERDRIVE ----
  // measure a clean straight-line run at base speed FIRST, as the control
  await goTo(P, RUNE_SPOTS[0].x, 760);
  const runFor = async (ticks) => {
    const a = P.me();
    await P.drive(ticks, 0, -1);
    const b = P.me();
    return Math.abs(b.y - a.y);
  };
  await P.drive(20, 0, 0);                          // settle to a standstill
  const baseRun = await runFor(30);
  await P.drive(20, 0, 0);

  guard = 0;
  while (P.me().power !== POWER.SPEED && guard++ < 200) await P.drive(12, 0, 0);
  check(P.me().power === POWER.SPEED, `a wave grants OVERDRIVE (power ${P.me().power})`);
  // P is standing ON the gate now; run the same 30 ticks boosted
  await P.drive(20, 0, 0);
  const boostRun = await runFor(30);
  const ratio = boostRun / baseRun;
  check(ratio > 1.25 && ratio < SPEED_MULT + 0.2,
    `OVERDRIVE really moves the tank faster (${baseRun.toFixed(0)}px -> ${boostRun.toFixed(0)}px, `
    + `${ratio.toFixed(2)}x vs ${SPEED_MULT}x nominal)`);
  await sleep(7200);
  check(P.me().power === POWER.NONE, 'and it lapses like every other power');

  // ---- wave 4: POWER SHOT ----
  // V is still parked straight up the gate's lane from the shield phase, so P
  // has an immediate clear shot without driving anywhere.
  await goTo(P, RUNE_SPOTS[0].x, RUNE_SPOTS[0].y);
  guard = 0;
  while (P.me().power !== POWER.POWERSHOT && guard++ < 200) await P.drive(12, 0, 0);
  check(P.me().power === POWER.POWERSHOT, `rune 3 grants POWER SHOT (power ${P.me().power})`);

  // charge 1: one shot, one kill, against a FULL-health tank
  const vHp = V.me().hp;
  const aimV = Math.atan2(V.me().y - P.me().y, V.me().x - P.me().x);
  await P.drive(24, 0, 0, true, aimV);
  await sleep(500);
  check(vHp === MAX_HP && !V.me().alive, `a power shot one-shots a full-health tank (was ${vHp}hp)`);
  check(P.ev('death').some((e) => e.victim === V.id && e.killer === P.id), 'and credits the kill');

  // charges 2 and 3: up the left lane into the RED tower. V is dead and its
  // team-1 respawns are all well clear of this firing line.
  // ONE pull per assertion: a long firing burst spans several cooldowns, and the
  // moment the charges run out the next pull is an ordinary 34-damage shell —
  // which silently turns "2 x 140" into "140 + 34 + 34".
  await goTo(P, RUNE_SPOTS[0].x, 480);
  const aimT = Math.atan2(135 - P.me().y, 330 - P.me().x);
  // Count what actually LANDED rather than how many times the trigger was
  // pulled: the server's leaky-bucket cooldown deliberately allows a burst of 2
  // after an idle, so "one pull" is not a thing a test can assume. Every bx
  // carries its own tower/power flags, which is exact.
  const bxBeforeTower = P.ev('bx').length;
  const towerBefore = P.snap.towerHp[1];
  await P.drive(70, 0, 0, true, aimT);
  await sleep(1200);
  const towerHits = P.ev('bx').slice(bxBeforeTower).filter((e) => e.tower === 1);
  const powerHits = towerHits.filter((e) => e.power).length;
  const normalHits = towerHits.length - powerHits;
  const dealt = towerBefore - P.snap.towerHp[1];
  check(powerHits >= 1, `power shells reached the tower (${powerHits})`);
  check(dealt === powerHits * POWERSHOT_TOWER_DAMAGE + normalHits * BULLET_DAMAGE,
    `each power shell takes ${POWERSHOT_TOWER_DAMAGE} off the tower `
    + `(${powerHits} power + ${normalHits} normal = ${dealt})`);
  check(P.me().power === POWER.NONE, 'the third charge spends the power');

  P.close(); V.close(); W.close();
}

// Progression is local-only, so its correctness is entirely in this module:
// a non-monotonic curve or a lossy save is invisible until a player loses a level.
async function checkProfile() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const { awardMatch, load, levelFromXp, xpForLevel } = await import('../client/js/profile.js');

  let monotonic = true, invertible = true;
  let prev = -1;
  for (let l = 1; l <= 30; l++) {
    const x = xpForLevel(l);
    if (x <= prev) monotonic = false;
    if (levelFromXp(x) !== l) invertible = false;
    prev = x;
  }
  check(monotonic, 'xp curve is strictly increasing (no level can ever be lost)');
  check(invertible, 'levelFromXp inverts xpForLevel exactly at every boundary');

  const win = awardMatch({ won: true, kills: 2, deaths: 1, towerDamage: 200 });
  const loss = awardMatch({ won: false, kills: 0, deaths: 3, towerDamage: 0 });
  check(loss.gained < win.gained, 'a win with contribution beats a loss without');
  const p = load();
  check(p.matches === 2 && p.wins === 1 && p.deaths === 4, 'lifetime stats accumulate');
  check(p.xp === win.gained + loss.gained, 'xp total is the sum of awards');

  store.set('tank.profile', '{{{not json');
  check(load().xp === 0, 'corrupt saved profile falls back to blank instead of throwing');

  // A tampered/overflowed save used to hang the tab forever at the result screen.
  store.set('tank.profile', '{"xp":1e309,"matches":"x","wins":-5}');
  const t0 = Date.now();
  const p2 = load();
  check(Date.now() - t0 < 500 && p2.xp === 0 && p2.wins === 0,
    'a non-finite/garbage saved profile cannot hang the level loop');
  check(levelFromXp(Infinity) < 500 && levelFromXp(NaN) === 1, 'levelFromXp is bounded for non-finite input');
}

// The match result must be captured on the EVENT and awarded exactly once, even
// if the app was backgrounded across the end of the match (rAF is suspended, and
// the server resets the match 6s later — the whole match used to vanish).
async function checkAward() {
  const { Game } = await import('../client/js/game.js');
  const g = new Game({ sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0, interpDelayMs: () => 100 });
  g.myId = 1; g.myTeam = 0;
  g.meServer = { hp: 100, alive: true, ammo: 5, team: 0, score: 4 };
  g.matchDeaths = 2;
  g.matchTowerDamage = 140;

  g.onEvent({ t: 'matchover', winner: 0, wins: [1, 0] });
  check(!!g.pendingAward, 'the match result is captured on the event, not on the next frame');
  check(g.pendingAward.won === true && g.pendingAward.kills === 4
        && g.pendingAward.deaths === 2 && g.pendingAward.towerDamage === 140,
    'the captured result carries the real per-match stats');

  // matchstart wipes the live counters; the pending award must survive it
  g.onEvent({ t: 'matchstart', wins: [1, 0] });
  check(!!g.pendingAward && g.pendingAward.kills === 4,
    'the pending award survives the match reset that follows it');

  // joining DURING a result screen must not render or award someone else's match
  const g2 = new Game({ sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0, interpDelayMs: () => 100 });
  g2.onEvent({ t: 'welcome', id: 1, team: 0, players: [], wins: [3, 2], phase: 'over' });
  check(g2.winner === -1 && !g2.pendingAward,
    'joining mid-result screen awards nothing and has no winner to render');
}

// THE PRODUCTION AUTH PATH. Every other test in this file runs with
// DEV_ALLOW_UNSIGNED=1, so the RS256/JWKS branch — the only one real users ever
// touch — had zero coverage. A claim-shape mismatch against what the backend
// actually mints is a total outage, and the client's symptom is an indefinite
// "reconnecting" spinner. This signs real tokens with a local keypair and serves
// a JWKS over a stub so the whole branch is exercised.
async function checkAuth() {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { validateAccessToken } = await import('./auth.js');

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => jwksServer.listen(8125, '127.0.0.1', r));
  const jwksUrl = 'http://127.0.0.1:8125/.well-known/jwks.json';
  const opts = { jwksUrl, serviceId: 'tank' };

  const sign = (claims, over = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(over.iss ?? 'usion-backend')
    .setAudience(over.aud ?? 'usion-game-service:tank')
    .setExpirationTime(over.exp ?? '30m')
    .sign(privateKey);

  const GOOD = { sub: 'user-42', room_id: 'r1', session_id: 's1', service_id: 'tank', permissions: ['play'] };

  try {
    const claims = await validateAccessToken(await sign(GOOD), opts);
    check(claims.sub === 'user-42' && claims.room_id === 'r1',
      `a correctly-minted RS256 token is accepted (sub=${claims.sub} room=${claims.room_id})`);
  } catch (e) {
    check(false, `a correctly-minted RS256 token is accepted — REJECTED: ${e.message}`);
  }

  const rejects = async (label, token) => {
    try { await validateAccessToken(token, opts); check(false, `rejects ${label}`); }
    catch { check(true, `rejects ${label}`); }
  };
  await rejects('a wrong issuer', await sign(GOOD, { iss: 'evil' }));
  await rejects('a wrong audience (another game service)', await sign(GOOD, { aud: 'usion-game-service:chess' }));
  await rejects('a mismatched service_id claim', await sign({ ...GOOD, service_id: 'chess' }));
  await rejects("a token without the 'play' permission", await sign({ ...GOOD, permissions: ['spectate'] }));
  await rejects('a token with no permissions array', await sign({ ...GOOD, permissions: undefined }));
  await rejects('a token missing room_id', await sign({ ...GOOD, room_id: undefined }));
  await rejects('a token missing session_id', await sign({ ...GOOD, session_id: undefined }));
  await rejects('an expired token', await sign(GOOD, { exp: Math.floor(Date.now() / 1000) - 120 }));
  await rejects('a dev token when the bypass is off', 'dev:someone:room');
  await rejects('garbage', 'not-a-jwt');

  // A token signed by a key the JWKS does not publish must never pass.
  const other = await generateKeyPair('RS256');
  const forged = await new SignJWT(GOOD)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt().setIssuer('usion-backend').setAudience('usion-game-service:tank')
    .setExpirationTime('30m').sign(other.privateKey);
  await rejects('a token signed by an unknown key', forged);

  await new Promise((r) => jwksServer.close(r));
}

// The client's SERVICE_ID, the game server's, and the id of the row in the Usion
// registry must all be the same string. When they drifted, the backend answered
// the direct-access request with "Room service mismatch", the client retried
// forever, and the ONLY symptom a player saw was an endless "reconnecting"
// spinner — no error, no log, nothing to debug from.
async function checkServiceId() {
  const client = await import('../client/js/config.js');
  const server = await import('./config.js');
  check(client.SERVICE_ID === server.SERVICE_ID,
    `client and server agree on SERVICE_ID (client=${client.SERVICE_ID} server=${server.SERVICE_ID})`);
  check(/^[a-z0-9-]+$/.test(client.SERVICE_ID), `SERVICE_ID is a clean slug (${client.SERVICE_ID})`);
  // The deployed URL the standalone/dev fallback points at must belong to the
  // same service, or a dev connect silently talks to somebody else's server.
  check(client.DEV_SERVER_URL.includes(client.SERVICE_ID),
    `dev fallback URL matches the service (${client.DEV_SERVER_URL})`);
}

// TILT IS THE HEADLINE CONTROL SCHEME and it silently never engaged: the sensor
// got a 1.2s deadline to produce its first reading, and a WKWebView routinely
// takes longer. Missing that window left tiltReady false forever, which ALSO
// disabled the Tilt option in settings — so there was no way back to it.
async function checkTilt() {
  const listeners = new Map();
  const el = () => ({ style: {}, tabIndex: 0, addEventListener() {}, focus() {} });
  globalThis.window = {
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener: (t, fn) => {
      const a = listeners.get(t) || [];
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    focus() {},
  };
  // Signal "phone" via the coarse-pointer query; globalThis.navigator is
  // read-only in modern Node and cannot be replaced.
  globalThis.matchMedia = (q) => ({ matches: q === '(pointer: coarse)', addEventListener() {} });
  globalThis.screen = { orientation: { angle: 0, addEventListener() {} } };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  // Android-WebView shape: the type exists, but there is no permission API.
  globalThis.DeviceOrientationEvent = function DeviceOrientationEvent() {};

  const { Input } = await import('../client/js/input.js');
  const input = new Input(el());
  const emit = (beta, gamma) => {
    for (const fn of listeners.get('deviceorientation') || []) fn({ beta, gamma });
  };

  check(input.tiltSupported(), 'tilt is offered whenever the device type exists');
  check(input.prefersTilt === true, 'tilt is the DEFAULT on a touch device');

  const verdict = await input.requestTilt();
  check(verdict === 'pending', 'a sensor that has not reported yet is "pending", not a hard failure');
  check(input.tiltSupported(), 'the settings toggle stays available while pending');

  // The whole point: a reading that arrives LATE must still turn tilt on.
  emit(30, 0);
  check(input.tiltReady === true, 'a late first reading still enables tilt');
  check(input.mode === 'tilt', 'and the game switches to tilt steering when that is the preference');

  // Held at the posture the player selected, the tank must sit still. (The
  // smoothing is time-based, so settle it before sampling.)
  // The reading is eased on WALL CLOCK, so real time has to pass between polls.
  const settle = async (beta) => {
    for (let i = 0; i < 5; i++) { emit(beta, 0); await sleep(60); input.poll(); }
  };
  // The default 'auto' posture refines its neutral from the smoothed pose ~700ms
  // after tilt engages, so read the LIVE neutral before each assertion instead
  // of caching it — the refinement is the feature, not drift.
  await settle(input._beta0);
  const idle = Math.abs(input.moveX) + Math.abs(input.moveY);
  check(idle < 0.05, `holding the current pose does not drive the tank (${idle.toFixed(3)})`);

  // ...and tilting past the range drives it at full speed.
  await settle(input._beta0 + 20);
  check(input.moveY > 0.9,
    `tilting past the range drives at full speed (moveY=${input.moveY.toFixed(2)})`);
  await settle(input._beta0 - 20);
  check(input.moveY < -0.9, `tilting the other way reverses it (moveY=${input.moveY.toFixed(2)})`);

  // ---- desktop: WASD/arrows must steer ----
  // The keyboard path had no coverage at all, and it is the ONLY way to drive on
  // web. Two things it has to survive: a physical-position `code` (the normal
  // case, and what keeps WASD under the same fingers on AZERTY), and an event
  // that carries only `key` with `code` empty — synthetic, remote-desktop and
  // on-screen keyboards do that, and steering used to silently do nothing.
  const kb = new Input(el());
  kb.setMode('stick');
  const press = (ev) => { for (const fn of listeners.get('keydown') || []) fn({ preventDefault() {}, ...ev }); };
  const release = (ev) => { for (const fn of listeners.get('keyup') || []) fn({ ...ev }); };
  const drive = (ev) => { press(ev); kb.poll(); const r = { x: kb.moveX, y: kb.moveY }; release(ev); kb.poll(); return r; };

  const d = drive({ code: 'KeyD', key: 'd' });
  check(d.x === 1 && d.y === 0, `D drives right (${d.x},${d.y})`);
  const w = drive({ code: 'KeyW', key: 'w' });
  check(w.y === -1, `W drives up (${w.x},${w.y})`);
  const a = drive({ code: 'KeyA', key: 'a' });
  check(a.x === -1, `A drives left (${a.x},${a.y})`);
  const arrow = drive({ code: 'ArrowDown', key: 'ArrowDown' });
  check(arrow.y === 1, `arrow keys work too (${arrow.x},${arrow.y})`);
  check(kb.moveX === 0 && kb.moveY === 0, 'releasing every key stops the tank');

  const noCode = drive({ code: '', key: 'd' });
  check(noCode.x === 1, `a keydown with no \`code\` still steers (${noCode.x},${noCode.y})`);
  press({ code: '', key: ' ' });
  check(kb._keys.has('Space'), 'and space still fires when it arrives without a code');
  release({ code: '', key: ' ' });
  check(!kb._keys.has('Space'), 'the matching keyup releases it (no stuck trigger)');

  delete globalThis.window; delete globalThis.matchMedia;
  delete globalThis.screen; delete globalThis.DeviceOrientationEvent;
}

// A shell must die on the first wall it touches, and the killing blow must play
// its death immediately rather than a round trip later.
async function checkCombatRules() {
  const { stepBullet } = await import('../client/shared/sim.js');
  const { BULLET_MAX_BOUNCES, ARENA_W, BULLET_SPEED } = await import('../client/shared/protocol.js');
  check(BULLET_MAX_BOUNCES === 0, 'shells do not ricochet');

  // fire straight at the right wall from mid-arena and step until it dies
  const b = { x: ARENA_W - 200, y: 640, vx: BULLET_SPEED, vy: 0, age: 0, bounces: 0 };
  let alive = true, steps = 0;
  while (alive && steps < 200) { alive = stepBullet(b, DT); steps++; }
  check(!alive && b.vx > 0, `a shell dies at the wall instead of coming back (vx stayed ${Math.sign(b.vx)})`);

  const { Game } = await import('../client/js/game.js');
  const g = new Game({
    sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0,
    interpDelayMs: () => 100,
  });
  g.myId = 1; g.myTeam = 0;
  g.teams.set(2, 1);
  g.names.set(2, 'victim');

  // The killing shell: local contact plays the spark, and the kill itself comes
  // from the server's death event — which under the authority contract arrives in
  // the SAME network batch as the bx echo, and is played exactly once, in full.
  const shell = g._spawnShell(1, 50, 50, 0, 1, true);
  g._endShell(shell, 2);
  check(g.effects.some((e) => e.kind === 'hit'), 'the killing contact sparks immediately');
  check(!g.effects.some((e) => e.kind === 'explosion'), 'but the explosion waits for the server');
  g.onEvent({ t: 'bx', bid: 1, x: 50, y: 50, hit: 2, tower: -1 });
  g.onEvent({ t: 'death', victim: 2, killer: 1, x: 50, y: 50 });
  check(g.effects.filter((e) => e.kind === 'explosion').length === 1, 'the death event explodes exactly once');
  check(g.killBannerAt > 0 && g.events.filter((e) => e.kind === 'kill').length === 1, 'the kill is credited exactly once');
  check(g.hitstopMs > 0, 'and it lands with hitstop');
  check(g.feed.length === 1, 'and the kill feed records it exactly once');
}

async function main() {
  checkProtocol();
  await checkServiceId();
  await checkTilt();
  await checkCombatRules();
  await checkAuthorityContract();
  await checkAdaptiveInterp();
  await checkProfile();
  await checkAuth();
  await checkAward();
  console.log('starting server…');
  // Bots off here: they would join the scripted match and wreck its assertions.
  const srv = await startServer(PORT, { BOTS: '0' });

  try {
    // ---- join ----
    const A = new Bot('alice');
    const B = new Bot('bob');
    await A.connect();
    check(A.id === 1, `A joined with id 1 (got ${A.id})`);
    await B.connect();
    check(B.id === 2, `B joined with id 2 (got ${B.id})`);
    await sleep(200);
    check(A.ev('join').some((e) => e.id === B.id), 'A received join event for B');

    const a0 = A.me();
    const b0 = B.me();
    check(!!a0 && !!b0, `both tanks in snapshots (A@${a0?.x},${a0?.y} B@${b0?.x},${b0?.y})`);
    check(a0.hp === MAX_HP && a0.alive, 'A alive at full hp');

    // ---- teams + towers present ----
    check(a0.team === 0, `A on team 0 / BLUE (got ${a0.team})`);
    check(b0.team === 1, `B auto-balanced onto team 1 / RED (got ${b0.team})`);
    check(
      A.snap.towerHp[0] === TOWER_HP && A.snap.towerHp[1] === TOWER_HP,
      `both towers at full hp (${A.snap.towerHp.join('/')})`,
    );

    // ---- malformed frames must not kill the server ----
    A.ws.send('null');                              // JSON.parse('null') → not an object
    A.ws.send('{"t":123}');                         // wrong type for t
    A.ws.send(Buffer.from([1, 2]));                 // truncated binary INPUT
    A.ws.send(Buffer.from([99, 0, 0, 0, 0, 0, 0])); // unknown binary type
    await sleep(300);
    const tickBefore = A.snap?.tick ?? 0;
    await sleep(300);
    check((A.snap?.tick ?? 0) > tickBefore, 'server still ticking after malformed frames');

    // ---- movement + acks ----
    await A.drive(Math.round(1.2 / DT), 1, 0); // ~1.2 s driving right (tick-rate agnostic)
    await sleep(120);
    const a1 = A.me();
    check(a1.x - a0.x > 100, `A moved right by ${Math.round(a1.x - a0.x)}px (>100)`);
    check(Math.abs(a1.y - a0.y) < 2, 'A did not drift vertically');
    const ackGap = (A.seq - A.snap.lastAckSeq + 65536) % 65536;
    check(ackGap <= 3, `input ack tracks seq (gap ${ackGap})`);

    // ---- position for a clear VERTICAL shot down the left lane (x≈200) ----
    // The centre line is blocked by the cross-bars, centre block and both
    // towers, but the lane between the wall nubs (x 160..240) runs clear from
    // y≈250 to y≈1030. A (BLUE) spawns bottom-left, B (RED) top-right; both
    // slide into the lane and close to ~290px, well inside the shell's range.
    check(await goTo(A, 200, 870), 'A reached the lane firing position');
    check(await goTo(B, 200, 580), 'B reached the lane firing position');
    await sleep(150);
    const aPos = A.me(), bPos = B.me();
    console.log(`  A at (${Math.round(aPos.x)},${Math.round(aPos.y)}) B at (${Math.round(bPos.x)},${Math.round(bPos.y)})`);
    const dist = Math.hypot(bPos.x - aPos.x, bPos.y - aPos.y);
    check(dist < 700, `A and B within bullet range (${Math.round(dist)}px)`);

    // ---- fire until B dies (3 hits needed) ----
    const aim = Math.atan2(bPos.y - aPos.y, bPos.x - aPos.x);
    const kills0 = A.me().score;
    // shells to kill, doubled for the ones that clip a wall on the way
    const killBudgetMs = shellSeconds(2 * Math.ceil(MAX_HP / BULLET_DAMAGE)) * 1000 + 4000;
    let waited = 0;
    while (B.me().alive && waited < killBudgetMs) {
      await A.drive(4, 0, 0, true, aim);
      waited += 4 * DT * 1000;
    }
    await sleep(200);
    check(A.ev('fire').some((e) => e.id === A.id), 'fire event broadcast for A');
    check(A.ev('bx').some((e) => e.hit === B.id), 'bullet hit event on B');
    check(!B.me().alive, 'B died after repeated hits');
    check(B.ev('death').some((e) => e.victim === B.id && e.killer === A.id), 'death event victim=B killer=A');
    check(A.me().score === kills0 + 1, `A score incremented (${A.me().score})`);
    const hpSeen = B.me().hp;
    check(hpSeen === 0, `dead tank hp is 0 (got ${hpSeen})`);

    // ---- respawn ---- (derived: a hard-coded wait silently becomes a failure
    // the moment RESPAWN_DELAY changes, which is exactly what happened at 8s)
    await sleep(RESPAWN_DELAY * 1000 + 700);
    check(B.me().alive && B.me().hp === MAX_HP, 'B respawned alive at full hp');
    check(B.ev('spawn').some((e) => e.id === B.id), 'spawn event broadcast');

    // ---- towers: return fire, damage, and the win condition ----
    // A (BLUE) climbs the left lane into RED tower range and sieges it. The
    // tower shoots back, so A trades lives for damage — the intended loop.
    // B stays parked at its top-right spawn, out of both towers' range.
    const RED = 1;
    // Every loop turn is 6 ticks. Budget the shells the tower actually costs, plus
    // the lane climb and a few deaths to the tower's return fire (the siege is
    // meant to trade lives for damage), then 50% margin.
    const siegeSeconds = shellSeconds(Math.ceil(TOWER_HP / BULLET_DAMAGE)) + 4 * RESPAWN_DELAY + 8;
    const siegeSteps = Math.ceil((siegeSeconds * 1.5) / (6 * DT));
    let guard = 0, sawTowerFire = false, sawDamage = false;
    while (A.snap.towerHp[RED] > 0 && guard++ < siegeSteps) {
      const a = A.me();
      if (!a || !a.alive) { await A.drive(6, 0, 0); continue; }   // wait out respawn
      if (Math.abs(a.x - 200) > 22) { await A.drive(6, Math.sign(200 - a.x), 0); continue; }
      if (a.y > 345) { await A.drive(6, 0, -1); continue; }       // up the lane into range
      await A.drive(6, 0, 0, true, Math.atan2(130 - a.y, 360 - a.x));
      if (A.snap.towerHp[RED] < TOWER_HP) sawDamage = true;
      if (!sawTowerFire) sawTowerFire = A.ev('fire').some((e) => e.id >= TOWER_OWNER_BASE);
    }
    check(sawDamage, 'shells damage the enemy tower');
    check(sawTowerFire, 'tower returned fire (auto-turret)');
    check(A.snap.towerHp[RED] === 0, `RED tower destroyed (hp ${A.snap.towerHp[RED]}, ${guard} steps)`);
    const over = A.ev('matchover');
    check(over.length === 1 && over[0].winner === 0, `matchover -> BLUE wins (${JSON.stringify(over[0] ?? null)})`);
    check(A.snap.towerHp[0] > 0, 'winning team keeps its own tower');

    // ---- match auto-restarts ----
    await sleep((MATCH_RESET_DELAY + 0.8) * 1000);
    check(A.ev('matchstart').length === 1, 'match restarted automatically');
    check(
      A.snap.towerHp[0] === TOWER_HP && A.snap.towerHp[1] === TOWER_HP,
      `towers restored on restart (${A.snap.towerHp.join('/')})`,
    );
    check(A.me().alive && A.me().hp === MAX_HP, 'A respawned at full hp for the new match');

    // ---- leave / rejoin ----
    A.close();
    await sleep(300);
    check(B.ev('leave').some((e) => e.id === A.id), 'B received leave event for A');
    const A2 = new Bot('alice2');
    await A2.connect();
    check(A2.id === 1, 'freed id reused on rejoin');
    A2.close();
    B.close();

    // ---- a real client loop, over a degraded link ----
    await checkLiveShells(PORT);

    // ---- power runes, end to end over the real protocol ----
    await checkPowers();
  } finally {
    srv.kill();
  }

  await botPhase();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// Second instance, bots ENABLED: a lone human must be topped up to a real 2v2
// with three distinct bots, the bots must actually play, and a bot must yield
// its seat the moment another human arrives.
async function botPhase() {
  console.log('\nstarting bot server…');
  const srv = await startServer(BOT_PORT);
  try {
    const solo = new Bot('solo', BOT_PORT);
    await solo.connect('botroom');
    await sleep(700);

    const tanks = solo.snap.tanks;
    check(tanks.length === 4, `lone player topped up to 2v2 (${tanks.length} tanks)`);

    const botJoins = solo.ev('join').filter((e) => e.bot);
    check(botJoins.length === 3, `3 bots joined (${botJoins.length})`);
    const names = botJoins.map((e) => e.name);
    check(new Set(names).size === 3, `3 DIFFERENT bots (${names.join(', ')})`);

    const myTeam = solo.ev('welcome')[0].team;
    const mine = tanks.filter((t) => t.team === myTeam).length;
    check(mine === 2 && tanks.length - mine === 2, `sides balanced 2v2 (${mine} v ${tanks.length - mine})`);

    // ---- do they actually play? ----
    const before = tanks.filter((t) => t.id !== solo.id).map((t) => ({ id: t.id, x: t.x, y: t.y }));
    await sleep(4000);
    const after = solo.snap.tanks;
    const moved = before.filter((b) => {
      const a = after.find((t) => t.id === b.id);
      return a && Math.hypot(a.x - b.x, a.y - b.y) > 40;
    }).length;
    check(moved >= 2, `bots are driving (${moved}/3 moved >40px)`);
    const botShots = solo.ev('fire').filter((e) => e.id !== solo.id && e.id < TOWER_OWNER_BASE);
    check(botShots.length > 0, `bots are shooting (${botShots.length} shots)`);

    // ---- a human outranks a bot for a seat ----
    const leavesBefore = solo.ev('leave').length;
    const second = new Bot('human2', BOT_PORT);
    await second.connect('botroom');
    await sleep(500);
    check(solo.ev('leave').length === leavesBefore + 1, 'a bot gave up its seat for the 2nd human');
    check(solo.snap.tanks.length === 4, `still exactly 4 tanks (${solo.snap.tanks.length})`);

    // ---- EVERY human gets a seat: joins 3 and 4 each kick a bot too ----
    const third = new Bot('human3', BOT_PORT);
    await third.connect('botroom');
    const fourth = new Bot('human4', BOT_PORT);
    await fourth.connect('botroom');
    await sleep(400);
    const roster = fourth.ev('welcome')[0].players;
    check(third.id > 0 && fourth.id > 0, `humans 3 and 4 both seated (ids ${third.id}, ${fourth.id})`);
    check(roster.filter((p) => p.bot).length === 0 && roster.length === 4,
      `a full human lobby has ZERO bots left (${JSON.stringify(roster.map((p) => p.bot ? 'bot' : 'human'))})`);
    check(solo.snap.tanks.length === 4, 'and never more than 4 tanks');
    third.close();
    fourth.close();
    await sleep(500);

    // ---- room drains when the humans leave (bots must not simulate forever) ----
    solo.close();
    second.close();
    await sleep(600);
    const revisit = new Bot('later', BOT_PORT);
    await revisit.connect('botroom');
    await sleep(700);
    check(revisit.id === 1, `abandoned room reclaimed, ids reset (got ${revisit.id})`);
    check(revisit.snap.tanks.length === 4, `refilled to 2v2 for the newcomer (${revisit.snap.tanks.length})`);
    revisit.close();

    // ---- the reported bug, end to end: no tank ever revives on screen ----
    await checkNoRevives(BOT_PORT);
  } finally {
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
