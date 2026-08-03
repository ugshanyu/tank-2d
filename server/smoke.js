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
} from '../client/shared/protocol.js';

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

// Client-side hit prediction: the impact must play the instant the shell connects
// on screen, and the server's echo must then be swallowed rather than replayed.
// game.js imports only pure modules, so it runs headless.
async function checkInstantHits() {
  const { Game } = await import('../client/js/game.js');
  const newGame = () => new Game({ sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0 });
  const g = newGame();
  g.myId = 1;

  // a shell of mine, fired but not yet acknowledged by the server
  const s = g._spawnShell('n7', 100, 100, 0, 1, false);
  s.vx = 0; s.vy = 0;
  g._endShell(s, 2, 100);
  check(g.effects.filter((e) => e.kind === 'hit').length === 1, 'impact plays immediately on a local hit');
  check(g.events.filter((e) => e.kind === 'hit').length === 1, 'hit sound/haptic fires immediately');
  check(!g.renderShells().includes(s), 'locally-resolved shell stops being drawn at once');

  // the same shot is idempotent if the frame runs twice
  g._endShell(s, 2, 100);
  check(g.effects.filter((e) => e.kind === 'hit').length === 1, 'local hit is not double-played');

  // THE TWO-SHELL BUG: the fire echo must adopt the shell I already have, never
  // spawn a second one — even though this one is already spent.
  g.onEvent({ t: 'fire', id: 1, bid: 55, nonce: 7, x: 100, y: 100, a: 0, tick: 0 });
  check(g.shells.size === 1 && g.shells.get(55) === s,
    `one trigger pull is exactly one shell (${g.shells.size} in flight)`);
  check(g.renderShells().length === 0, 'and a resolved shell is never resurrected on screen');

  // ...and the impact echo must be swallowed, not replayed
  const before = g.effects.length;
  const evBefore = g.events.length;
  g.onEvent({ t: 'bx', bid: 55, x: 100, y: 100, hit: 2, tower: -1 });
  check(g.effects.length === before, 'server bx echo does not double-flash the impact');
  check(g.events.length === evBefore, 'server bx echo does not double-play the sound');
  check(!g.shells.has(55), 'shell gone after the echo');

  // a live shell of mine that the echo arrives for keeps flying as ONE object
  const live = g._spawnShell('n8', 300, 300, 0, 1, false);
  g.onEvent({ t: 'fire', id: 1, bid: 60, nonce: 8, x: 10, y: 10, a: 0, tick: 0 });
  check(g.shells.size === 1 && g.shells.get(60) === live && live.x === 300,
    'an in-flight shell is re-keyed in place, not respawned at the muzzle');
  check(g.renderShells().length === 1, 'so only one shell is ever drawn per shot');

  // an UNPREDICTED hit still plays normally from the server
  g._spawnShell(56, 5, 5, 0, 2, true);
  const fx56 = g.effects.length;
  g.onEvent({ t: 'bx', bid: 56, x: 5, y: 5, hit: 1, tower: -1 });
  check(g.effects.length === fx56 + 1, 'server-only impacts still play');

  // ---- predicted damage: the health bar must move on impact ----
  const g2 = newGame();
  g2.myId = 1;
  check(g2.displayHp(2, 100) === 100, 'undamaged tank shows server hp');
  const s2 = g2._spawnShell('n1', 0, 0, 0, 1, false);
  g2._endShell(s2, 2, 100);
  check(g2.displayHp(2, 100) === 100 - BULLET_DAMAGE, 'health drops immediately on a predicted hit');
  // the echo releases the prediction; authoritative HP takes over cleanly
  g2.onEvent({ t: 'fire', id: 1, bid: 11, nonce: 1, x: 0, y: 0, a: 0, tick: 0 });
  g2.onEvent({ t: 'bx', bid: 11, x: 0, y: 0, hit: 2, tower: -1 });
  check(g2.displayHp(2, 100 - BULLET_DAMAGE) === 100 - BULLET_DAMAGE, 'server hp takes over when it lands');
  check(g2.displayHp(2, 100) === 100, 'prediction released once confirmed');

  // A BURST MOVES THE BAR BUT MUST NOT INVENT A KILL. Every local hit docks health
  // immediately — that is cheap and self-corrects. The DEATH does not fire off a
  // stack of unconfirmed hits: on a 200ms link the local verdict and the server's
  // rewound one disagree often enough that a tank would explode and then get back
  // up, which is far worse than a kill that lands a beat late.
  const g5 = newGame();
  g5.myId = 1; g5.teams.set(2, 1);
  const shells = Math.ceil(MAX_HP / BULLET_DAMAGE);
  for (let i = 0; i < shells; i++) {
    const b = g5._spawnShell(`n${i}`, 0, 0, 0, 1, false);
    g5._endShell(b, 2, MAX_HP);          // server still reports the target at full hp
  }
  check(g5.displayHp(2, MAX_HP) === 0, 'a full burst drops the bar to zero on the shell that lands');
  check(!g5.effects.some((e) => e.kind === 'explosion'),
    'but a kill is NEVER predicted from hits the server has not confirmed');

  // ...and once the server's own hp says the next shell is lethal, it IS instant
  const g7 = newGame();
  g7.myId = 1; g7.teams.set(2, 1);
  const last = g7._spawnShell('n1', 50, 50, 0, 1, false);
  g7._endShell(last, 2, BULLET_DAMAGE);  // authoritative hp: one shell from death
  check(g7.effects.some((e) => e.kind === 'explosion'),
    'the killing blow explodes on the frame it lands, not a round trip later');

  // a prediction the server never confirms must expire on its own
  const g6 = newGame();
  g6.myId = 1;
  const ghost = g6._spawnShell('n1', 0, 0, 0, 1, false);
  g6._endShell(ghost, 3, 100);
  check(g6.displayHp(3, 100) < 100, 'a graze docks health immediately');
  g6._pending[0].at -= 5000;                    // pretend the echo never came
  check(g6.displayHp(3, 100) === 100, 'an unconfirmed prediction expires instead of sticking');

  // ---- taking a hit must not double-fire the hurt feedback ----
  const g3 = newGame();
  g3.myId = 1;
  g3.meServer = { hp: 100, alive: true, ammo: 5, team: 0, score: 0 };
  g3.lastHp = 100;
  g3.me = { x: 0, y: 0, vx: 0, vy: 0, hull: 0 };
  const incoming = g3._spawnShell(9, 0, 0, 0, 2, true);
  g3._endShell(incoming, 1, 100);              // shell hits ME, resolved locally
  const hurtAfterPredict = g3.events.filter((e) => e.kind === 'hurt').length;
  g3.onEvent({ t: 'bx', bid: 9, x: 0, y: 0, hit: 1, tower: -1 });
  g3._reconcile({ hp: 100 - BULLET_DAMAGE, alive: true, x: 0, y: 0, vx: 0, vy: 0, hull: 0 }, 0);
  const hurtAfterServer = g3.events.filter((e) => e.kind === 'hurt').length;
  check(hurtAfterPredict === 1, 'taking a hit fires hurt feedback once, immediately');
  check(hurtAfterServer === 1, 'server confirmation does NOT replay the hurt feedback');

  // ---- a wrong-victim prediction must not swallow the real event ----
  const g4 = newGame();
  g4.myId = 1;
  const wrong = g4._spawnShell(70, 0, 0, 0, 1, true);
  g4._endShell(wrong, 2, 100);                  // we guessed it hit tank 2
  const fx = g4.effects.length;
  g4.onEvent({ t: 'bx', bid: 70, x: 0, y: 0, hit: 0, tower: 1 });  // it actually hit a TOWER
  check(g4.effects.length > fx, 'a mispredicted shell still plays the real impact');
  check(g4.events.some((e) => e.kind === 'towerhit'), 'tower damage is never silent after a misprediction');
  check(g4.displayHp(2, 100) === 100, 'and the phantom damage is released');
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
  const g = new Game({ sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0 });
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
  const g2 = new Game({ sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0 });
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
  const neutral = input._beta0;
  await settle(neutral);
  const idle = Math.abs(input.moveX) + Math.abs(input.moveY);
  check(idle < 0.05, `holding the chosen posture does not drive the tank (${idle.toFixed(3)})`);

  // ...and tilting past the range drives it at full speed.
  await settle(neutral + 20);
  check(input.moveY > 0.9,
    `tilting past the range drives at full speed (moveY=${input.moveY.toFixed(2)})`);
  await settle(neutral - 20);
  check(input.moveY < -0.9, `tilting the other way reverses it (moveY=${input.moveY.toFixed(2)})`);

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
  const g = new Game({ sendInput() {}, serverNowMs: () => 0, rtt: 0, viewLagTicks: () => 0 });
  g.myId = 1; g.myTeam = 0;
  g.teams.set(2, 1);
  g.names.set(2, 'victim');

  // last shell of four: the target is on BULLET_DAMAGE hp, so this kills.
  const shell = g._spawnShell(1, 50, 50, 0, 1, true);
  g._endShell(shell, 2, BULLET_DAMAGE);
  check(g.effects.some((e) => e.kind === 'explosion'), 'the killing hit explodes immediately, not a round trip later');
  check(g.killBannerAt > 0 && g.events.some((e) => e.kind === 'kill'), 'the kill is credited on the spot');
  check(g.hitstopMs > 0, 'and it lands with hitstop');

  // the server's own death event must then be swallowed, not replayed
  const fx = g.effects.length;
  const ev = g.events.length;
  g.onEvent({ t: 'death', victim: 2, killer: 1 });
  check(g.effects.length === fx, 'the server death event does not double-explode');
  check(g.events.filter((e) => e.kind === 'kill').length === 1, 'nor double-credit the kill');
  check(g.feed.length === 1, 'but the kill feed still records it exactly once');
}

async function main() {
  checkProtocol();
  await checkServiceId();
  await checkTilt();
  await checkCombatRules();
  await checkInstantHits();
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
    let waited = 0;
    while (B.me().alive && waited < 8000) {
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

    // ---- respawn ----
    await sleep(3000);
    check(B.me().alive && B.me().hp === MAX_HP, 'B respawned alive at full hp');
    check(B.ev('spawn').some((e) => e.id === B.id), 'spawn event broadcast');

    // ---- towers: return fire, damage, and the win condition ----
    // A (BLUE) climbs the left lane into RED tower range and sieges it. The
    // tower shoots back, so A trades lives for damage — the intended loop.
    // B stays parked at its top-right spawn, out of both towers' range.
    const RED = 1;
    let guard = 0, sawTowerFire = false, sawDamage = false;
    while (A.snap.towerHp[RED] > 0 && guard++ < 320) {
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
  } finally {
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
