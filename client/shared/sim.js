// Shared deterministic simulation: the SAME code steps tanks and bullets on the
// server (authoritative) and on the client (prediction + bullet replay).
// Everything here must stay pure and identical on both sides — that is what makes
// client-side prediction land exactly on the server result.

import {
  ARENA_W, ARENA_H, TANK_RADIUS, TANK_MAX_SPEED, TANK_ACCEL, TANK_BRAKE, HULL_TURN_RATE,
  BULLET_RADIUS, BULLET_TTL, BULLET_MAX_BOUNCES, TOWER_RADIUS, MAG_SIZE, wrapAngle,
  POWER, SPEED_MULT,
} from './protocol.js';

// ---- Map: axis-aligned obstacle rects ----
// THREE shapes, and that is the whole map: a block in the middle, and one bar of
// cover in front of each tower. It reads in one glance from across a phone
// screen, which the previous ten-rect layout did not — four corner walls and two
// wall nubs added collisions nobody could see coming and lanes nobody could
// name. Everything that layout was for is still here: the middle is contested
// (the block), a tower has cover to fight from (the bars), and both side lanes
// run the full height for long-range duels.
//
// Point-symmetric through the arena centre — every rect maps onto another under
// (x,y) -> (ARENA_W-x, ARENA_H-y). That is not decoration: the two teams see the
// same map from opposite ends, and the rune picker mirrors a spot through the
// centre to place RED's twin (server/runes.js), which is only fair on a map with
// this symmetry. Keep it if you edit these.
//
// Lane widths, since they are what makes or breaks driving: the bars span
// x 210-510 and the block x 260-460, so each side lane gives a 26px-radius tank
// a ~158px window for its centre — wide enough to take at speed without
// clipping corners.
export const OBSTACLES = [
  // centre block — the one feature in the middle
  { x: 260, y: 580, w: 200, h: 120 },
  // one bar of cover in front of each tower
  { x: 210, y: 370, w: 300, h: 50 },
  { x: 210, y: 860, w: 300, h: 50 },
];

// ---- Towers: one per team, the match objective ----
// Geometry only (position is fixed and identical on both sides); HP is
// authoritative server state carried in the snapshot header. Team 0 defends the
// bottom of the arena, team 1 the top.
export const TOWERS = [
  { team: 0, x: ARENA_W / 2, y: ARENA_H - 130 },
  { team: 1, x: ARENA_W / 2, y: 130 },
];

// Spawns are per team — you always appear on your own half, near your tower.
export const TEAM_SPAWNS = [
  // team 0 — bottom
  [{ x: 170, y: 1030 }, { x: 550, y: 1030 }, { x: 360, y: 950 }],
  // team 1 — top
  [{ x: 170, y: 250 }, { x: 550, y: 250 }, { x: 360, y: 330 }],
];

// Flat list kept for callers that just want "somewhere valid" (and for tests).
export const SPAWN_POINTS = [...TEAM_SPAWNS[0], ...TEAM_SPAWNS[1]];

// Push a circle out of an AABB along the axis of least penetration.
// Returns null if no overlap, else {nx, ny} the outward normal used.
function resolveCircleRect(c, r, rect) {
  const cx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
  const cy = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
  const dx = c.x - cx;
  const dy = c.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 1e-9) {
    // center outside rect: push along contact normal
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;
    c.x = cx + nx * r;
    c.y = cy + ny * r;
    return { nx, ny };
  }
  // center inside rect: push out along smallest side distance
  const left = c.x - rect.x, right = rect.x + rect.w - c.x;
  const top = c.y - rect.y, bottom = rect.y + rect.h - c.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) { c.x = rect.x - r; return { nx: -1, ny: 0 }; }
  if (m === right) { c.x = rect.x + rect.w + r; return { nx: 1, ny: 0 }; }
  if (m === top) { c.y = rect.y - r; return { nx: 0, ny: -1 }; }
  c.y = rect.y + rect.h + r; return { nx: 0, ny: 1 };
}

// Advance one tank by one fixed tick. Mutates {x,y,vx,vy,hull}. input: {moveX,moveY}.
export function stepTank(t, input, dt) {
  let mx = input.moveX, my = input.moveY;
  const mag = Math.hypot(mx, my);
  let idle = false;
  if (mag < 0.12) { mx = 0; my = 0; idle = true; }
  else if (mag > 1) { mx /= mag; my /= mag; }
  else {
    // Rescale past the deadzone instead of cliffing at it, so the first degree of
    // tilt/stick past neutral gives fine control rather than a jump to 12% speed.
    const s = (mag - 0.12) / 0.88;
    const shaped = (s * s * 0.6 + s * 0.4) / mag;
    mx *= shaped; my *= shaped;
  }
  // OVERDRIVE lives in the SHARED sim so the client's prediction and the server's
  // authority boost the exact same ticks — putting it anywhere else would make
  // every boosted tick a correction. Acceleration scales with the top speed too,
  // or a higher ceiling would just mean a longer ramp and read as sluggish.
  const boost = t.power === POWER.SPEED ? SPEED_MULT : 1;
  const tvx = mx * TANK_MAX_SPEED * boost;
  const tvy = my * TANK_MAX_SPEED * boost;
  // Asymmetric: releasing the stick brakes far harder than accelerating, which is
  // what makes stopping feel deliberate instead of like sliding on ice.
  const maxDv = (idle ? TANK_BRAKE : TANK_ACCEL * boost) * dt;
  const dvx = Math.max(-maxDv, Math.min(maxDv, tvx - t.vx));
  const dvy = Math.max(-maxDv, Math.min(maxDv, tvy - t.vy));
  t.vx += dvx;
  t.vy += dvy;
  t.x += t.vx * dt;
  t.y += t.vy * dt;

  // arena bounds
  if (t.x < TANK_RADIUS) { t.x = TANK_RADIUS; t.vx = 0; }
  if (t.x > ARENA_W - TANK_RADIUS) { t.x = ARENA_W - TANK_RADIUS; t.vx = 0; }
  if (t.y < TANK_RADIUS) { t.y = TANK_RADIUS; t.vy = 0; }
  if (t.y > ARENA_H - TANK_RADIUS) { t.y = ARENA_H - TANK_RADIUS; t.vy = 0; }

  // obstacles
  for (const rect of OBSTACLES) {
    const n = resolveCircleRect(t, TANK_RADIUS, rect);
    if (n) {
      // kill velocity into the wall
      const vn = t.vx * n.nx + t.vy * n.ny;
      if (vn < 0) { t.vx -= vn * n.nx; t.vy -= vn * n.ny; }
    }
  }

  // towers are solid to tanks (both teams — you cannot hide inside your own)
  for (const tw of TOWERS) {
    const dx = t.x - tw.x, dy = t.y - tw.y;
    const minD = TOWER_RADIUS + TANK_RADIUS;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minD * minD) continue;
    // dead-centre overlap can't happen (tanks never spawn on a tower), but a
    // zero-length normal would produce NaN — push straight up in that case
    const d = Math.sqrt(d2);
    const nx = d > 1e-9 ? dx / d : 0;
    const ny = d > 1e-9 ? dy / d : -1;
    t.x = tw.x + nx * minD;
    t.y = tw.y + ny * minD;
    const vn = t.vx * nx + t.vy * ny;
    if (vn < 0) { t.vx -= vn * nx; t.vy -= vn * ny; }
  }

  // Hull turns toward velocity (cosmetic but simulated identically everywhere).
  // Tanks reverse: pick whichever of forward/backward is the shorter rotation, so
  // flipping direction on a small arena doesn't spin the hull 180 degrees while
  // the tank visibly slides the other way. The low speed gate lets the hull finish
  // its turn as you slow instead of freezing at a wrong angle.
  const speed = Math.hypot(t.vx, t.vy);
  if (speed > 6) {
    const target = Math.atan2(t.vy, t.vx);
    const fwd = wrapAngle(target - t.hull);
    const rev = wrapAngle(target + Math.PI - t.hull);
    const diff = Math.abs(fwd) <= Math.abs(rev) ? fwd : rev;
    const maxTurn = HULL_TURN_RATE * dt;
    t.hull = wrapAngle(t.hull + Math.max(-maxTurn, Math.min(maxTurn, diff)));
  }
}

// Advance one bullet by one fixed tick. Mutates {x,y,vx,vy,age,bounces}.
// Returns false when the bullet expired (ttl or too many bounces).
// Movement is substepped (≤8px per substep) so fast bullets can't clip
// through wall corners between discrete collision checks.
export function stepBullet(b, dt) {
  b.age += dt;
  if (b.age > BULLET_TTL) return false;

  const r = BULLET_RADIUS;
  const speed = Math.hypot(b.vx, b.vy);
  const steps = Math.max(1, Math.ceil((speed * dt) / 8));
  const h = dt / steps;

  for (let i = 0; i < steps; i++) {
    b.x += b.vx * h;
    b.y += b.vy * h;

    // If this contact would exceed the bounce budget the shell dies AT the
    // surface: clamp rather than reflect, so the impact burst lands on the wall
    // instead of a few px back inside the arena (and, with bounces disabled
    // entirely, the shell never briefly travels backwards on its last frame).
    const terminal = b.bounces >= BULLET_MAX_BOUNCES;
    let bounced = false;
    if (b.x < r) {
      if (terminal) { b.x = r; return false; }
      b.x = r + (r - b.x); b.vx = -b.vx; bounced = true;
    }
    if (b.x > ARENA_W - r) {
      if (terminal) { b.x = ARENA_W - r; return false; }
      b.x = (ARENA_W - r) - (b.x - (ARENA_W - r)); b.vx = -b.vx; bounced = true;
    }
    if (b.y < r) {
      if (terminal) { b.y = r; return false; }
      b.y = r + (r - b.y); b.vy = -b.vy; bounced = true;
    }
    if (b.y > ARENA_H - r) {
      if (terminal) { b.y = ARENA_H - r; return false; }
      b.y = (ARENA_H - r) - (b.y - (ARENA_H - r)); b.vy = -b.vy; bounced = true;
    }

    for (const rect of OBSTACLES) {
      const n = resolveCircleRect(b, r, rect);
      if (n) {
        if (terminal) return false;   // resolveCircleRect already put us on the face
        const vn = b.vx * n.nx + b.vy * n.ny;
        if (vn < 0) { b.vx -= 2 * vn * n.nx; b.vy -= 2 * vn * n.ny; }
        bounced = true;
      }
    }

    // Shells DETONATE on a tower rather than bouncing off it — that is how a
    // tower takes damage. Geometry is shared, so client and server agree on
    // exactly which substep the shell dies; the server separately runs the
    // authoritative swept test to apply the damage.
    for (const tw of TOWERS) {
      const dx = b.x - tw.x, dy = b.y - tw.y;
      const rr = TOWER_RADIUS + r;
      if (dx * dx + dy * dy < rr * rr) return false;
    }

    if (bounced) {
      b.bounces += 1;
      if (b.bounces > BULLET_MAX_BOUNCES) return false;
    }
  }
  return true;
}

export function makeTank(id, x, y, team = 0) {
  return { id, x, y, vx: 0, vy: 0, hull: 0, turret: 0, hp: 100, alive: true, score: 0, team, ammo: MAG_SIZE, power: 0 };
}
