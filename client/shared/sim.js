// Shared deterministic simulation: the SAME code steps tanks and bullets on the
// server (authoritative) and on the client (prediction + bullet replay).
// Everything here must stay pure and identical on both sides — that is what makes
// client-side prediction land exactly on the server result.

import {
  ARENA_W, ARENA_H, TANK_RADIUS, TANK_MAX_SPEED, TANK_ACCEL, HULL_TURN_RATE,
  BULLET_RADIUS, BULLET_TTL, BULLET_MAX_BOUNCES, wrapAngle,
} from './protocol.js';

// ---- Map: axis-aligned obstacle rects, mirrored layout ----
export const OBSTACLES = [
  // center cross
  { x: 1100, y: 700, w: 200, h: 200 },
  // four corner bunkers
  { x: 360, y: 280, w: 260, h: 70 },
  { x: 1780, y: 280, w: 260, h: 70 },
  { x: 360, y: 1250, w: 260, h: 70 },
  { x: 1780, y: 1250, w: 260, h: 70 },
  // mid-lane walls
  { x: 700, y: 620, w: 70, h: 360 },
  { x: 1630, y: 620, w: 70, h: 360 },
  { x: 1010, y: 260, w: 380, h: 60 },
  { x: 1010, y: 1280, w: 380, h: 60 },
];

export const SPAWN_POINTS = [
  { x: 180, y: 180 }, { x: ARENA_W - 180, y: 180 },
  { x: 180, y: ARENA_H - 180 }, { x: ARENA_W - 180, y: ARENA_H - 180 },
  { x: ARENA_W / 2, y: 140 }, { x: ARENA_W / 2, y: ARENA_H - 140 },
  { x: 160, y: ARENA_H / 2 }, { x: ARENA_W - 160, y: ARENA_H / 2 },
];

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
  if (mag < 0.12) { mx = 0; my = 0; }            // deadzone
  else if (mag > 1) { mx /= mag; my /= mag; }
  const tvx = mx * TANK_MAX_SPEED;
  const tvy = my * TANK_MAX_SPEED;
  const maxDv = TANK_ACCEL * dt;
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

  // hull turns toward velocity (cosmetic but simulated identically everywhere)
  const speed = Math.hypot(t.vx, t.vy);
  if (speed > 20) {
    const target = Math.atan2(t.vy, t.vx);
    const diff = wrapAngle(target - t.hull);
    const maxTurn = HULL_TURN_RATE * dt;
    t.hull = wrapAngle(t.hull + Math.max(-maxTurn, Math.min(maxTurn, diff)));
  }
}

// Advance one bullet by one fixed tick. Mutates {x,y,vx,vy,age,bounces}.
// Returns false when the bullet expired (ttl or too many bounces).
export function stepBullet(b, dt) {
  b.age += dt;
  if (b.age > BULLET_TTL) return false;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  const r = BULLET_RADIUS;
  let bounced = false;
  if (b.x < r) { b.x = r + (r - b.x); b.vx = -b.vx; bounced = true; }
  if (b.x > ARENA_W - r) { b.x = (ARENA_W - r) - (b.x - (ARENA_W - r)); b.vx = -b.vx; bounced = true; }
  if (b.y < r) { b.y = r + (r - b.y); b.vy = -b.vy; bounced = true; }
  if (b.y > ARENA_H - r) { b.y = (ARENA_H - r) - (b.y - (ARENA_H - r)); b.vy = -b.vy; bounced = true; }

  for (const rect of OBSTACLES) {
    const n = resolveCircleRect(b, r, rect);
    if (n) {
      const vn = b.vx * n.nx + b.vy * n.ny;
      if (vn < 0) { b.vx -= 2 * vn * n.nx; b.vy -= 2 * vn * n.ny; }
      bounced = true;
    }
  }

  if (bounced) {
    b.bounces += 1;
    if (b.bounces > BULLET_MAX_BOUNCES) return false;
  }
  return true;
}

export function makeTank(id, x, y) {
  return { id, x, y, vx: 0, vy: 0, hull: 0, turret: 0, hp: 100, alive: true, score: 0 };
}
