// Headless protocol smoke test: boots the server, runs a scripted 2-player match
// over the real binary/JSON protocol, and asserts the full kill chain:
// join -> movement+input acks -> fire -> hit -> death -> score -> respawn.
// Run: npm test

import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { MSG, DT, encodeInput, decodeSnapshot, MAX_HP, BULLET_DAMAGE } from '../client/shared/protocol.js';

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
          if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(to); resolve(); }
          return;
        }
        const buf = Buffer.from(data);
        const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
        if (v.getUint8(0) === MSG.SNAPSHOT) this.snap = decodeSnapshot(v);
      });
      ws.on('error', reject);
    });
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
  close() { this.ws.close(); }
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
    check(a1.x - a0.x > 200, `A moved right by ${Math.round(a1.x - a0.x)}px (>200)`);
    check(Math.abs(a1.y - a0.y) < 2, 'A did not drift vertically');
    const ackGap = (A.seq - A.snap.lastAckSeq + 65536) % 65536;
    check(ackGap <= 3, `input ack tracks seq (gap ${ackGap})`);

    // ---- position for a clear horizontal shot along y≈180 ----
    // A: continue right until x≈1400; B: drive up right lane until y≈180
    while ((A.me().x) < 1400) await A.drive(10, 1, 0);
    await A.drive(12, 0, 0); // brake
    while ((B.me().y) > 190) await B.drive(10, 0, -1);
    await B.drive(12, 0, 0);
    await sleep(150);
    const aPos = A.me(), bPos = B.me();
    console.log(`  A at (${Math.round(aPos.x)},${Math.round(aPos.y)}) B at (${Math.round(bPos.x)},${Math.round(bPos.y)})`);
    const dist = Math.hypot(bPos.x - aPos.x, bPos.y - aPos.y);
    check(dist < 950, `A and B within bullet range (${Math.round(dist)}px)`);

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
