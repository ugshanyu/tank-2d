// Shared protocol: constants + binary codec used by BOTH client and server.
// Hot-path messages (input up, snapshots down) are binary for minimal size/latency.
// Infrequent messages (join/leave/fire/death) are JSON text frames for clarity.

// ---- Simulation constants (must match on client & server) ----
export const TICK_RATE = 60;            // fixed simulation tick (Hz), client & server
export const DT = 1 / TICK_RATE;
// Single-screen portrait arena (9:16). The whole map is always visible on a
// phone — the camera never moves, only the tanks do. Speeds below are tuned to
// this size: the arena is ~3x narrower than a scrolling map, so the old px/s
// values would cross it in under a second and play like pinball.
export const ARENA_W = 720;
export const ARENA_H = 1280;

export const TANK_RADIUS = 26;
// Feel tuning. The old 130 px/s @ 700 px/s^2 took 186 ms to reach top speed and
// 186 ms to coast to a stop — that ramp on both ends is exactly the "driving on
// ice" complaint. 81 ms to full speed reads as instant without feeling twitchy,
// and a much harder brake means releasing the stick stops you in ~50 ms/5 px.
export const TANK_MAX_SPEED = 205;      // px/s (~3.5 s to cross the arena)
export const TANK_ACCEL = 2600;         // px/s^2 toward target velocity
export const TANK_BRAKE = 4200;         // px/s^2 when releasing input (asymmetric)
export const HULL_TURN_RATE = 16;       // rad/s hull visually turns toward velocity
export const MAX_HP = 100;

// At 420 px/s a shell was only 2x tank speed — below roughly 4x a projectile stops
// reading as a SHOT and starts reading as a slow object you steer around. 900 px/s
// crosses the arena in 1.4 s and lands like a gun. Damage drops so faster shells
// don't halve time-to-kill: 4 hits instead of 3.
export const BULLET_SPEED = 1750;       // px/s (~8.5x tank speed) — a shell should
                                        // read as a SHOT: near-instant to where you
                                        // pointed, not an object you steer around
export const BULLET_RADIUS = 5;
export const BULLET_TTL = 1.2;          // seconds (2100px of travel: a cross-arena
                                        // shot plus a bounce, with margin)
export const BULLET_MAX_BOUNCES = 1;    // dies on 2nd wall contact
export const BULLET_DAMAGE = 28;        // 4 shells to kill
export const OWNER_GRACE = 0.22;        // s a bullet cannot hit its owner (bounce-backs can)
export const FIRE_COOLDOWN = 0.16;      // s between shots inside a magazine (~6/s)
// Magazine: five fast shots, then a real reload. The pause is what gives the
// volley a shape — without it, held fire is an undifferentiated stream.
export const MAG_SIZE = 5;
export const RELOAD_TIME = 1.25;        // s to refill an empty magazine
// Ammo ships in 3 bits of the snapshot flags byte. Above 7 a full magazine would
// wrap to 0 and read as "permanently empty", locking the trigger.
if (MAG_SIZE > 7) throw new Error('MAG_SIZE must fit in 3 snapshot bits (<= 7)');
export const MUZZLE_OFFSET = 34;        // bullet spawn distance from tank center

export const RESPAWN_DELAY = 2.5;       // seconds
export const MAX_PLAYERS_PER_ROOM = 4;  // 2v2

// ---- Teams ----
export const TEAM_COUNT = 2;            // 0 = BLUE (bottom half), 1 = RED (top half)
export const TEAM_NAMES = ['BLUE', 'RED'];
export const FRIENDLY_FIRE = true;      // shells damage teammates and your own tower

// ---- Towers ----
// One per team. Destroying the enemy tower wins the match. Towers are also
// auto-turrets: they acquire the nearest living enemy tank in range and fire.
// Tower fire is server-authoritative and event-sourced exactly like tank fire —
// clients replay the 'fire' event, they never predict tower AI.
export const TOWER_RADIUS = 44;
export const TOWER_HP = 560;            // 20 shells. Once bots could actually path
                                        // to the objective, 320 HP produced 30 s
                                        // matches; measured pace puts this at ~60 s.
export const TOWER_RANGE = 330;         // px; enemies must commit to get in range
export const TOWER_FIRE_COOLDOWN = 1.1; // s between tower shots
export const TOWER_MUZZLE_OFFSET = 58;  // > TOWER_RADIUS + BULLET_RADIUS so a shell
                                        // never detonates on the tower that fired it
export const TOWER_OWNER_BASE = 200;    // bullet owner ids for towers (players are 1..4)
export const MATCH_RESET_DELAY = 6;     // s from win screen to the next match
export const INTERP_DELAY_MS = 100;     // remote entities rendered this far in the past.
                                        // 66 ms was arithmetic for a PERFECTLY paced
                                        // stream; real mobile arrival is bursty (2-3
                                        // snapshots in one turn, then a 40-90 ms gap),
                                        // so it lived in the extrapolation branch and
                                        // popped constantly. 100 ms buys 6 ticks of
                                        // slack and is still well under the 30 Hz
                                        // baseline this replaced.

// ---- Binary message type ids ----
export const MSG = {
  // client -> server
  INPUT: 1,
  PING: 2,
  // server -> client
  SNAPSHOT: 16,
  PONG: 17,
};

const ANGLE_SCALE = 10430;              // radians(-pi..pi) -> i16
const POS_SCALE = 16;                   // px -> u16 (1/16 px resolution)
const VEL_SCALE = 16;                   // px/s -> i16

export const wrapAngle = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
export const encAngle16 = (a) => Math.round(wrapAngle(a) * ANGLE_SCALE);
export const decAngle16 = (v) => v / ANGLE_SCALE;
export const encAngle8 = (a) => Math.round(((wrapAngle(a) + Math.PI) / (2 * Math.PI)) * 255) & 0xff;
export const decAngle8 = (v) => (v / 255) * 2 * Math.PI - Math.PI;

// ---- INPUT: c->s, 11 bytes ----
// [u8 type][u16 seq][i8 moveX][i8 moveY][u8 buttons][i16 aim][u16 fireNonce][u8 lag]
// The last byte is the client's own view lag in ticks (interpolation delay plus
// half its RTT) — what the server rewinds to for hit detection. It is self
// reported, so the server clamps it to MAX_LAG_TICKS; that bounds any exploit to
// the same rewind an honest high-ping player would get.
export const MAX_LAG_TICKS = 24;        // 400 ms of rewind, hard ceiling
export function encodeInput(seq, moveX, moveY, firing, aim, fireNonce, lagTicks = 0) {
  const buf = new ArrayBuffer(11);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  v.setUint16(1, seq & 0xffff, true);
  v.setInt8(3, Math.max(-127, Math.min(127, Math.round(moveX * 127))));
  v.setInt8(4, Math.max(-127, Math.min(127, Math.round(moveY * 127))));
  v.setUint8(5, firing ? 1 : 0);
  v.setInt16(6, encAngle16(aim), true);
  v.setUint16(8, fireNonce & 0xffff, true);
  v.setUint8(10, Math.max(0, Math.min(MAX_LAG_TICKS, Math.round(lagTicks))));
  return buf;
}
export function decodeInput(v /* DataView */) {
  return {
    seq: v.getUint16(1, true),
    moveX: v.getInt8(3) / 127,
    moveY: v.getInt8(4) / 127,
    firing: (v.getUint8(5) & 1) !== 0,
    aim: decAngle16(v.getInt16(6, true)),
    fireNonce: v.getUint16(8, true),
    lagTicks: Math.min(MAX_LAG_TICKS, v.getUint8(10)),
  };
}

// ---- PING/PONG ----
// PING: [u8 type][f64 clientTimeMs]  (9 bytes)
// PONG: [u8 type][f64 clientTimeMs][f64 serverTimeMs] (17 bytes)
export function encodePing(clientTimeMs) {
  const buf = new ArrayBuffer(9);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PING);
  v.setFloat64(1, clientTimeMs, true);
  return buf;
}
export function encodePong(clientTimeMs, serverTimeMs) {
  const buf = new ArrayBuffer(17);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PONG);
  v.setFloat64(1, clientTimeMs, true);
  v.setFloat64(9, serverTimeMs, true);
  return buf;
}
export function decodePong(v) {
  return { clientTimeMs: v.getFloat64(1, true), serverTimeMs: v.getFloat64(9, true) };
}

// ---- SNAPSHOT: s->c ----
// header: [u8 type][u32 tick][u16 lastAckSeq][u8 yourId][u8 count][u16 towerHp0][u16 towerHp1]
//         (13 bytes)
// per tank (14 bytes):
//   [u8 id][u16 x][u16 y][i16 vx][i16 vy][u8 hull][u8 turret][u8 hp][u8 flags][u8 score]
// flags: bit0 = alive, bit1 = team, bits2-4 = ammo (0..7). All three ride in the
// spare bits of one byte, so teams and ammo cost 0 extra bytes per tank on the
// 60 Hz hot path — and ammo stays authoritative rather than client-guessed.
const TANK_BYTES = 14;
const SNAP_HEADER = 13;
export function encodeSnapshot(tick, lastAckSeq, yourId, tanks, towerHp) {
  const buf = new ArrayBuffer(SNAP_HEADER + tanks.length * TANK_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, lastAckSeq & 0xffff, true);
  v.setUint8(7, yourId);
  v.setUint8(8, tanks.length);
  v.setUint16(9, Math.max(0, Math.min(65535, Math.round(towerHp[0] || 0))), true);
  v.setUint16(11, Math.max(0, Math.min(65535, Math.round(towerHp[1] || 0))), true);
  let o = SNAP_HEADER;
  for (const t of tanks) {
    v.setUint8(o, t.id);
    v.setUint16(o + 1, Math.max(0, Math.min(65535, Math.round(t.x * POS_SCALE))), true);
    v.setUint16(o + 3, Math.max(0, Math.min(65535, Math.round(t.y * POS_SCALE))), true);
    v.setInt16(o + 5, Math.max(-32767, Math.min(32767, Math.round(t.vx * VEL_SCALE))), true);
    v.setInt16(o + 7, Math.max(-32767, Math.min(32767, Math.round(t.vy * VEL_SCALE))), true);
    v.setUint8(o + 9, encAngle8(t.hull));
    v.setUint8(o + 10, encAngle8(t.turret));
    v.setUint8(o + 11, Math.max(0, Math.min(255, t.hp)));
    v.setUint8(o + 12, (t.alive ? 1 : 0) | ((t.team & 1) << 1) | ((Math.min(7, t.ammo ?? MAG_SIZE) & 7) << 2));
    v.setUint8(o + 13, Math.min(255, t.score));
    o += TANK_BYTES;
  }
  return buf;
}
export function decodeSnapshot(v /* DataView */) {
  const tick = v.getUint32(1, true);
  const lastAckSeq = v.getUint16(5, true);
  const yourId = v.getUint8(7);
  const count = v.getUint8(8);
  const towerHp = [v.getUint16(9, true), v.getUint16(11, true)];
  const tanks = [];
  let o = SNAP_HEADER;
  for (let i = 0; i < count; i++) {
    tanks.push({
      id: v.getUint8(o),
      x: v.getUint16(o + 1, true) / POS_SCALE,
      y: v.getUint16(o + 3, true) / POS_SCALE,
      vx: v.getInt16(o + 5, true) / VEL_SCALE,
      vy: v.getInt16(o + 7, true) / VEL_SCALE,
      hull: decAngle8(v.getUint8(o + 9)),
      turret: decAngle8(v.getUint8(o + 10)),
      hp: v.getUint8(o + 11),
      alive: (v.getUint8(o + 12) & 1) !== 0,
      team: (v.getUint8(o + 12) >> 1) & 1,
      ammo: (v.getUint8(o + 12) >> 2) & 7,
      score: v.getUint8(o + 13),
    });
    o += TANK_BYTES;
  }
  return { tick, lastAckSeq, yourId, tanks, towerHp };
}
