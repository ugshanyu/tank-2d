// Server-side bot tanks. Bots fill empty slots so a solo launch is still a real
// 2v2 match, and they are evicted the moment a human needs the seat.
//
// Bots are NOT part of the deterministic shared sim: they only produce an input
// ({moveX, moveY, firing, aim}) each tick, which is then fed through exactly the
// same stepTank/tryFire path as a human's packet. That means clients need no bot
// code at all — a bot is just another tank in the snapshot and another 'fire'
// event on the wire. It also means bot decisions may use randomness freely;
// nothing downstream replays them.

import {
  ARENA_W, ARENA_H, TANK_RADIUS, TOWER_RADIUS, TOWER_RANGE, TICK_RATE,
  BULLET_SPEED, MAX_HP,
} from '../client/shared/protocol.js';
import { OBSTACLES, TOWERS } from '../client/shared/sim.js';

// The three archetypes. A solo player gets all three, so the match always has
// one of each: something pushing the objective, something hunting them, and
// something sitting on the tower they need to kill.
export const BOT_PROFILES = [
  {
    key: 'rush', name: 'Blitz',
    role: 'Drives at the enemy tower and sieges it, trading lives for damage.',
    aimError: 0.10, engageRange: 430, standoff: 300, strafe: 0.35, speed: 1,
  },
  {
    key: 'hunt', name: 'Stalker',
    role: 'Hunts the nearest enemy tank and duels it at mid range.',
    aimError: 0.055, engageRange: 540, standoff: 230, strafe: 0.8, speed: 1,
  },
  {
    key: 'guard', name: 'Bulwark',
    role: 'Orbits its own tower and intercepts anything that comes for it.',
    aimError: 0.13, engageRange: 460, standoff: 210, strafe: 0.45, speed: 0.88,
  },
];

const GUARD_LEASH = 330;       // how far Bulwark will stray from its tower
const STUCK_SPEED = 18;        // px/s below which we consider the tank wedged
const STUCK_TICKS = 22;
const EVADE_TICKS = 40;

// ---------------------------------------------------------------- geometry --

// Obstacle test inflated by the tank radius, i.e. "can a tank's CENTRE be here".
function blockedForTank(x, y) {
  if (x < TANK_RADIUS || x > ARENA_W - TANK_RADIUS) return true;
  if (y < TANK_RADIUS || y > ARENA_H - TANK_RADIUS) return true;
  for (const r of OBSTACLES) {
    if (x > r.x - TANK_RADIUS && x < r.x + r.w + TANK_RADIUS &&
        y > r.y - TANK_RADIUS && y < r.y + r.h + TANK_RADIUS) return true;
  }
  for (const t of TOWERS) {
    const dx = x - t.x, dy = y - t.y;
    const rr = TOWER_RADIUS + TANK_RADIUS;
    if (dx * dx + dy * dy < rr * rr) return true;
  }
  return false;
}

// Would a shell get through? skipTower is the tower we're deliberately shooting.
function shotBlocked(x, y, skipTower) {
  for (const r of OBSTACLES) {
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  for (let i = 0; i < TOWERS.length; i++) {
    if (i === skipTower) continue;
    const t = TOWERS[i];
    const dx = x - t.x, dy = y - t.y;
    if (dx * dx + dy * dy < TOWER_RADIUS * TOWER_RADIUS) return true;
  }
  return false;
}

function losClear(x1, y1, x2, y2, skipTower = -1) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(2, Math.ceil(d / 16));
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    if (shotBlocked(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, skipTower)) return false;
  }
  return true;
}

// Steer toward (tx,ty), fanning out from the direct heading until a probe point
// is walkable. Cheap, has no map graph to maintain, and the fan is wide enough
// (out to ±150°) that a tank can back out of the dead ends this map has.
function steer(tank, tx, ty, bias) {
  const base = Math.atan2(ty - tank.y, tx - tank.x);
  const probe = TANK_RADIUS + 38;
  const fan = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 1.95, -1.95, 2.6, -2.6];
  for (const off of fan) {
    const a = base + off * (bias || 1);
    if (blockedForTank(tank.x + Math.cos(a) * probe, tank.y + Math.sin(a) * probe)) continue;
    return { x: Math.cos(a), y: Math.sin(a) };
  }
  return { x: 0, y: 0 };
}

// Aim with travel-time lead, plus a per-profile error so bots miss like people.
function aimAt(from, target, profile) {
  const d = Math.hypot(target.x - from.x, target.y - from.y);
  const t = d / BULLET_SPEED;
  const px = target.x + (target.vx || 0) * t;
  const py = target.y + (target.vy || 0) * t;
  return Math.atan2(py - from.y, px - from.x) + (Math.random() - 0.5) * 2 * profile.aimError;
}

// ------------------------------------------------------------------- brain --

function enemiesOf(room, bot) {
  const out = [];
  for (const p of room.players.values()) {
    if (p.id === bot.id || !p.tank.alive || p.tank.team === bot.tank.team) continue;
    out.push(p);
  }
  return out;
}

function nearest(from, list) {
  let best = null, bestD = Infinity;
  for (const p of list) {
    const d = Math.hypot(p.tank.x - from.x, p.tank.y - from.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { player: best, dist: bestD } : null;
}

/**
 * Produce one tick of input for a bot. Returns {moveX, moveY, firing, aim, fireNonce}.
 */
export function botInput(room, bot, tick) {
  const me = bot.tank;
  const ai = bot.ai;
  const prof = bot.profile;
  const enemyTowerIdx = TOWERS.findIndex((t) => t.team !== me.team);
  const ownTowerIdx = TOWERS.findIndex((t) => t.team === me.team);
  const enemyTower = TOWERS[enemyTowerIdx];
  const ownTower = TOWERS[ownTowerIdx];
  const enemyTowerAlive = (room.towers[enemyTowerIdx]?.hp ?? 0) > 0;

  const foes = enemiesOf(room, bot);
  const near = nearest(me, foes);

  // ---- what am I shooting? ----
  let aim = me.turret;
  let firing = false;

  const canHitTank = near
    && near.dist < prof.engageRange
    && losClear(me.x, me.y, near.player.tank.x, near.player.tank.y);

  const towerDist = Math.hypot(enemyTower.x - me.x, enemyTower.y - me.y);
  const canHitTower = enemyTowerAlive
    && towerDist < 620
    && losClear(me.x, me.y, enemyTower.x, enemyTower.y, enemyTowerIdx);

  // Blitz prioritises the objective; the other two prioritise whoever is shooting at them.
  const towerFirst = prof.key === 'rush' && canHitTower && (!canHitTank || towerDist < near.dist);

  if (towerFirst) {
    aim = Math.atan2(enemyTower.y - me.y, enemyTower.x - me.x) + (Math.random() - 0.5) * prof.aimError;
    firing = true;
  } else if (canHitTank) {
    aim = aimAt(me, near.player.tank, prof);
    firing = true;
  } else if (canHitTower && prof.key !== 'guard') {
    aim = Math.atan2(enemyTower.y - me.y, enemyTower.x - me.x) + (Math.random() - 0.5) * prof.aimError;
    firing = true;
  }

  // Friendly fire is on — never pull the trigger through a teammate.
  if (firing) {
    for (const p of room.players.values()) {
      if (p.id === bot.id || !p.tank.alive || p.tank.team !== me.team) continue;
      const d = Math.hypot(p.tank.x - me.x, p.tank.y - me.y);
      if (d > 420) continue;
      const off = Math.abs(Math.atan2(p.tank.y - me.y, p.tank.x - me.x) - aim);
      const wrapped = Math.min(off, Math.abs(2 * Math.PI - off));
      if (wrapped < Math.atan2(TANK_RADIUS + 10, Math.max(1, d))) { firing = false; break; }
    }
  }

  // ---- where am I going? ----
  let goal;
  if (prof.key === 'guard') {
    // hold the tower; only break the leash for something already inside it
    const intruder = near && Math.hypot(near.player.tank.x - ownTower.x, near.player.tank.y - ownTower.y) < GUARD_LEASH
      ? near.player.tank : null;
    if (intruder) {
      goal = { x: intruder.x, y: intruder.y };
    } else {
      const a = (tick / TICK_RATE) * 0.45 + bot.id;
      goal = { x: ownTower.x + Math.cos(a) * 165, y: ownTower.y + Math.sin(a) * 165 };
    }
  } else if (prof.key === 'hunt') {
    goal = near ? { x: near.player.tank.x, y: near.player.tank.y }
                : { x: enemyTower.x, y: enemyTower.y };
  } else {
    // rush: the tower, unless something is right on top of us
    goal = (near && near.dist < 170) ? { x: near.player.tank.x, y: near.player.tank.y }
                                     : { x: enemyTower.x, y: enemyTower.y };
  }

  const goalDist = Math.hypot(goal.x - me.x, goal.y - me.y);
  const dir = steer(me, goal.x, goal.y, ai.evadeUntil > tick ? ai.evadeDir : 1);
  let mx = dir.x, my = dir.y;

  // Back off once we're at our preferred range, and strafe so we're not a
  // stationary target while trading shots.
  const standoffTarget = towerFirst ? Math.min(prof.standoff, TOWER_RANGE - 40) : prof.standoff;
  const engaged = firing && goalDist < standoffTarget;
  if (engaged) {
    const away = Math.atan2(me.y - goal.y, me.x - goal.x);
    const perp = away + Math.PI / 2 * (ai.strafeDir || 1);
    mx = Math.cos(away) * 0.45 + Math.cos(perp) * prof.strafe;
    my = Math.sin(away) * 0.45 + Math.sin(perp) * prof.strafe;
    // a probe so strafing doesn't walk us into a wall
    if (blockedForTank(me.x + mx * (TANK_RADIUS + 30), me.y + my * (TANK_RADIUS + 30))) {
      ai.strafeDir = -(ai.strafeDir || 1);
      mx = Math.cos(away); my = Math.sin(away);
    }
  }
  if (tick % 140 === bot.id % 140) ai.strafeDir = -(ai.strafeDir || 1);

  // ---- unwedging ----
  const speed = Math.hypot(me.vx, me.vy);
  if (speed < STUCK_SPEED && goalDist > 60) ai.stuckTicks++;
  else ai.stuckTicks = 0;
  if (ai.stuckTicks > STUCK_TICKS && ai.evadeUntil <= tick) {
    ai.evadeUntil = tick + EVADE_TICKS;
    ai.evadeDir = -(ai.evadeDir || 1);
    ai.stuckTicks = 0;
  }
  if (ai.evadeUntil > tick) {
    // shove sideways relative to the goal until the fan finds a way round
    const a = Math.atan2(goal.y - me.y, goal.x - me.x) + (Math.PI / 2) * ai.evadeDir;
    mx = Math.cos(a); my = Math.sin(a);
  }

  // Badly hurt: fall back toward our own tower instead of feeding a kill. Still
  // shoots on the way out, so a retreat is a fighting withdrawal, not a freebie.
  if (me.hp <= MAX_HP * 0.34 && ai.evadeUntil <= tick) {
    const back = steer(me, ownTower.x, ownTower.y, 1);
    if (back.x || back.y) { mx = back.x; my = back.y; }
  }

  const mag = Math.hypot(mx, my) || 1;
  const sp = prof.speed;
  // quantize to the wire's i8 precision so a bot moves exactly like a real packet
  const q = (v) => Math.max(-127, Math.min(127, Math.round(v * 127))) / 127;

  return {
    seq: 0,
    moveX: q((mx / mag) * sp),
    moveY: q((my / mag) * sp),
    firing,
    aim,
    fireNonce: 0,
  };
}
