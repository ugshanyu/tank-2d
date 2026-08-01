// Headless protocol smoke test: boots the server, runs a scripted 2-player match
// over the real binary/JSON protocol, and asserts the full kill chain:
// join -> movement+input acks -> fire -> hit -> death -> score -> respawn.
// Run: npm test

import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  MSG, DT, encodeInput, encodePing, decodeSnapshot, MAX_HP, BULLET_DAMAGE,
  TOWER_HP, TOWER_OWNER_BASE, MATCH_RESET_DELAY,
} from '../client/shared/protocol.js';

const PORT = 8123;
const URL = `ws://127.0.0.1:${PORT}`;
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`FAIL  ${label}`); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(name) {
    this.name = name;
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
      const ws = new WebSocket(`${URL}/ws?token=${encodeURIComponent(token)}`);
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

async function main() {
  console.log('starting server…');
  const srv = spawn('node', ['server/server.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DEV_ALLOW_UNSIGNED: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    srv.stdout.on('data', (d) => { if (String(d).includes('TANK server')) resolve(); });
    srv.on('exit', () => reject(new Error('server died')));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });

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
  } finally {
    srv.kill();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
