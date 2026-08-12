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
  BULLET_SPEED, MAX_HP, POWER, RUNE_SPOTS, BULLET_DAMAGE, POWERSHOT_TOWER_DAMAGE,
  RESPAWN_DELAY, FIRE_COOLDOWN,
} from '../client/shared/protocol.js';
import { OBSTACLES, TOWERS } from '../client/shared/sim.js';

// The three archetypes, listed in the order they are handed out. Roles are
// assigned PER TEAM (see addBot), so every side with a bot gets a sieger first:
// each tower is under attack, and the extra bots add a hunter, then a guard.
// `reaction` is the seconds a bot hesitates before opening fire on a target it
// has just noticed (see the reaction gate in botInput). Stalker — the accurate
// duelist and the bot players actually complain about — pays the longest.
export const BOT_PROFILES = [
  {
    key: 'rush', name: 'Blitz',
    role: 'Drives at the enemy tower and sieges it, trading lives for damage.',
    aimError: 0.045, engageRange: 520, standoff: 300, strafe: 0.5, speed: 1, reaction: 0.9,
  },
  {
    key: 'hunt', name: 'Stalker',
    role: 'Hunts the nearest enemy tank and duels it at mid range.',
    aimError: 0.028, engageRange: 640, standoff: 240, strafe: 0.95, speed: 1, reaction: 1.1,
  },
  {
    key: 'guard', name: 'Bulwark',
    role: 'Orbits its own tower and intercepts anything that comes for it.',
    aimError: 0.06, engageRange: 560, standoff: 220, strafe: 0.6, speed: 0.94, reaction: 1.0,
  },
];

// A sighting older than this is forgotten: brief LOS breaks (driving past a
// pillar) keep a target warm, but real cover, a retreat, or a respawn (8 s)
// goes cold — and a cold target costs the bot a fresh reaction delay.
const REACTION_MEMORY_TICKS = Math.round(1.5 * TICK_RATE);
// ---- valuing a rune ----
// What each power is worth as a detour, in "arena lengths I would walk for it".
// POWER SHOT leads by a distance: it is a guaranteed kill AND 140 to a tower,
// i.e. four normal shells in one trigger pull, so it is worth crossing the map.
const POWER_VALUE = [];
POWER_VALUE[POWER.POWERSHOT] = 1.7;
POWER_VALUE[POWER.DOUBLE] = 1.0;
POWER_VALUE[POWER.SHIELD] = 0.9;
POWER_VALUE[POWER.SPEED] = 0.7;
// Every rune also heals to FULL, which for a hurt tank is worth more than the
// power itself — a 20hp bot detouring for a rune is choosing not to die.
const RUNE_HEAL_VALUE = 1.6;
// Travel cost: a rune this far away costs one full unit of value. Roughly half
// the arena, so a POWER SHOT is worth crossing it and OVERDRIVE is not.
const RUNE_REACH = 700;
// Don't chase what an enemy will plainly reach first — that just feeds a kill
// to a tank that arrives with a fresh power. Their lead has to be real, not a
// rounding error, or two bots would each stand off waiting for the other.
const RUNE_LEAD_MARGIN = 70;

const GUARD_LEASH = 330;       // how far Bulwark will stray from its tower
const SELF_DEFENCE_RANGE = 260; // a sieging bot only breaks off for tanks this close
const HUNT_CHASE_RANGE = 900;  // beyond this, Stalker pushes the objective instead
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

// Analytic segment-vs-AABB (slab method). The old version sampled the segment
// every 16px — ~876 geometric tests per bot per tick, ~200k/s per room, enough to
// push the 60 Hz tick loop past its deadline. This is O(1) per rect and strictly
// more accurate: 16px sampling could tunnel clean through a 40px wall at an
// oblique angle, so bots occasionally "saw" through walls and shot them instead.
function segAabb(x1, y1, x2, y2, rx, ry, rw, rh) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? dx : dy;
    const o = axis === 0 ? x1 : y1;
    const lo = axis === 0 ? rx : ry;
    const hi = axis === 0 ? rx + rw : ry + rh;
    if (Math.abs(p) < 1e-9) { if (o < lo || o > hi) return false; continue; }
    let a = (lo - o) / p, b = (hi - o) / p;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}

function segCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / len2)) : 0;
  const px = x1 + t * dx - cx, py = y1 + t * dy - cy;
  return px * px + py * py < r * r;
}

function losClear(x1, y1, x2, y2, skipTower = -1) {
  for (const r of OBSTACLES) if (segAabb(x1, y1, x2, y2, r.x, r.y, r.w, r.h)) return false;
  for (let i = 0; i < TOWERS.length; i++) {
    if (i === skipTower) continue;
    if (segCircle(x1, y1, x2, y2, TOWERS[i].x, TOWERS[i].y, TOWER_RADIUS)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- pathing --
// A steering fan alone cannot navigate this map: measured over a real match it
// left bots with line of sight to ANYTHING only 2.4% of ticks, and after ~6 s
// they wedged against geometry and stopped fighting altogether. The arena is
// small and static, so a fixed waypoint graph is both cheaper and far better
// behaved than any amount of local avoidance.
//
// Nodes sit in the two clear lanes, in the gaps between the cross-bars and the
// centre block, and on the approach to each tower.
const NODES = [
  { x: 200, y: 180 }, { x: 200, y: 430 }, { x: 200, y: 640 }, { x: 200, y: 850 }, { x: 200, y: 1100 },
  { x: 520, y: 180 }, { x: 520, y: 430 }, { x: 520, y: 640 }, { x: 520, y: 850 }, { x: 520, y: 1100 },
  { x: 360, y: 230 }, { x: 360, y: 500 }, { x: 360, y: 780 }, { x: 360, y: 1050 },
];

// Can a TANK travel this segment without clipping anything?
function laneClear(x1, y1, x2, y2) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(2, Math.ceil(d / 18));
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    if (blockedForTank(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f)) return false;
  }
  return true;
}

// Adjacency, built once at module load.
const ADJ = NODES.map((a, i) => {
  const out = [];
  for (let j = 0; j < NODES.length; j++) {
    if (i === j) continue;
    const b = NODES[j];
    if (Math.hypot(b.x - a.x, b.y - a.y) > 470) continue;
    if (laneClear(a.x, a.y, b.x, b.y)) out.push(j);
  }
  return out;
});

function nearestNode(x, y, mustSee) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < NODES.length; i++) {
    const d = Math.hypot(NODES[i].x - x, NODES[i].y - y);
    if (d >= bestD) continue;
    if (mustSee && !laneClear(x, y, NODES[i].x, NODES[i].y)) continue;
    bestD = d; best = i;
  }
  return best;
}

// Breadth-first hop from the node nearest us to the node nearest the goal.
// The graph is 14 nodes; this is trivial to run per bot per tick, but we only
// recompute when the goal moves meaningfully (see navigate()).
const _prev = new Int8Array(NODES.length);
function firstHop(from, to) {
  if (from < 0 || to < 0) return -1;
  if (from === to) return to;
  _prev.fill(-1);
  const q = [from];
  _prev[from] = from;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const nx of ADJ[cur]) {
      if (_prev[nx] !== -1) continue;
      _prev[nx] = cur;
      if (nx === to) {
        let n = to;
        while (_prev[n] !== from && _prev[n] !== n) n = _prev[n];
        return n;
      }
      q.push(nx);
    }
  }
  return -1;
}

// Where should this bot actually drive right now? Straight at the goal when it
// can, otherwise via the graph.
function navigate(me, goalX, goalY) {
  if (laneClear(me.x, me.y, goalX, goalY)) return { x: goalX, y: goalY };
  const from = nearestNode(me.x, me.y, true) >= 0 ? nearestNode(me.x, me.y, true) : nearestNode(me.x, me.y, false);
  const to = nearestNode(goalX, goalY, false);
  const hop = firstHop(from, to);
  if (hop < 0) return { x: goalX, y: goalY };
  return NODES[hop];
}

// Steer toward (tx,ty), fanning out from the direct heading until a probe point
// is walkable. Cheap, has no map graph to maintain, and the fan is wide enough
// (out to ±150°) that a tank can back out of the dead ends this map has.
const STEER_FAN = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 1.95, -1.95, 2.6, -2.6];
function steer(tank, tx, ty, bias) {
  const base = Math.atan2(ty - tank.y, tx - tank.x);
  const probe = TANK_RADIUS + 38;
  for (const off of STEER_FAN) {
    const a = base + off * (bias || 1);
    if (blockedForTank(tank.x + Math.cos(a) * probe, tank.y + Math.sin(a) * probe)) continue;
    return { x: Math.cos(a), y: Math.sin(a) };
  }
  // Never return "don't move". A bot that stops is a bot that never finds a fight
  // again; drive at the goal and let collision resolution slide us along the wall.
  return { x: Math.cos(base), y: Math.sin(base) };
}

// Aim with travel-time lead, plus a per-profile error so bots miss like people.
// The lead is solved iteratively: a single pass under-leads badly now that shells
// move at 1750 px/s and the intercept point is well ahead of the naive estimate.
function aimAt(from, target, profile) {
  let t = Math.hypot(target.x - from.x, target.y - from.y) / BULLET_SPEED;
  let px = target.x, py = target.y;
  for (let i = 0; i < 3; i++) {
    px = target.x + (target.vx || 0) * t;
    py = target.y + (target.vy || 0) * t;
    t = Math.hypot(px - from.x, py - from.y) / BULLET_SPEED;
  }
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

// Is a rune on the field worth walking to right now? Returns the best one, or
// null to carry on with the archetype's normal job. Bots used to have no rune
// logic at all — they only ever picked one up by driving over it — so a player
// could farm every wave uncontested.
export function runePlan(room, bot) {
  const me = bot.tank;
  const heal = ((MAX_HP - me.hp) / MAX_HP) * RUNE_HEAL_VALUE;
  let best = null;
  for (let i = 0; i < RUNE_SPOTS.length; i++) {
    const kind = room.runes[i];
    if (!kind) continue;                     // claimed, or none this wave
    const spot = RUNE_SPOTS[i];
    const d = Math.hypot(spot.x - me.x, spot.y - me.y);
    let enemyD = Infinity;
    for (const p of room.players.values()) {
      if (!p.tank.alive || p.tank.team === me.team) continue;
      enemyD = Math.min(enemyD, Math.hypot(spot.x - p.tank.x, spot.y - p.tank.y));
    }
    if (enemyD < d - RUNE_LEAD_MARGIN) continue;
    const score = (POWER_VALUE[kind] || 0.5) + heal - d / RUNE_REACH;
    if (score > 0 && (!best || score > best.score)) best = { x: spot.x, y: spot.y, score, kind };
  }
  return best;
}

// Shells needed to finish something. One shell a second, so this IS time — the
// only currency the bot can compare a tank against a tower in.
function shellsToKill(hp, dmg) { return Math.max(1, Math.ceil(hp / dmg)); }

/**
 * Tower, or the tank in front of me? Pure so the decision can be tested without
 * a map: what the bot can SEE is decided by the caller (LOS, range), this only
 * prices the options it was handed.
 *
 * A sieger used to ignore anything past SELF_DEFENCE_RANGE, which is how a bot
 * ended up plinking a 560hp tower while a 20hp player farmed it from 300px.
 *
 * @returns {'tower'|'tank'|null}
 */
export function chooseTarget({ profileKey, me, near, canHitTank, canHitTower, enemyTower, towerHp }) {
  const towerOk = canHitTower && profileKey !== 'guard';   // guards never siege
  if (!towerOk) return canHitTank ? 'tank' : null;
  if (!canHitTank) return 'tower';

  const powerShot = me.power === POWER.POWERSHOT;
  const towerShells = shellsToKill(towerHp, powerShot ? POWERSHOT_TOWER_DAMAGE : BULLET_DAMAGE);
  const tankShells = shellsToKill(near.player.tank.hp, powerShot ? MAX_HP : BULLET_DAMAGE);

  // A kill buys the siege RESPAWN_DELAY seconds of nobody shooting back — about
  // five shells at one a second. It only buys that if the tank was actually in
  // the way though: killing someone busy at the far end of the map buys nothing
  // and stops our own clock, which is the trap a naive "always shoot the
  // player" bot falls into.
  const KILL_BUYS = RESPAWN_DELAY / FIRE_COOLDOWN;
  const inTheWay =
    Math.hypot(near.player.tank.x - enemyTower.x, near.player.tank.y - enemyTower.y) < TOWER_RANGE + 120
    || near.dist < SELF_DEFENCE_RANGE;

  if (towerShells <= 2) return 'tower';                    // one volley from winning — finish it
  if (tankShells <= 1) return 'tank';                      // a kill for one shell is always worth it
  if (inTheWay && tankShells < KILL_BUYS) return 'tank';
  return profileKey === 'rush' ? 'tower' : 'tank';
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
  // Shells now reach far further than the old 620px gate, which was the main
  // reason bots stood around not shooting the objective.
  const canHitTower = enemyTowerAlive
    && towerDist < 900
    && losClear(me.x, me.y, enemyTower.x, enemyTower.y, enemyTowerIdx);

  // ---- tower, or the tank in front of me? ----
  const target = chooseTarget({
    profileKey: prof.key, me, near, canHitTank, canHitTower,
    enemyTower, towerHp: room.towers[enemyTowerIdx]?.hp ?? 0,
  });
  const towerFirst = target === 'tower';

  let targetKey = null;
  if (target === 'tower') {
    aim = Math.atan2(enemyTower.y - me.y, enemyTower.x - me.x) + (Math.random() - 0.5) * prof.aimError;
    firing = true;
    targetKey = 'tower';
  } else if (target === 'tank') {
    aim = aimAt(me, near.player.tank, prof);
    firing = true;
    targetKey = `tank:${near.player.id}`;
  }

  // Reaction time — the player's guaranteed first move. A bot that notices a
  // target swings its turret onto it immediately (readable intent, a dodge
  // window) but holds fire for about a second, like a human registering a
  // threat. Per-target sightings stay warm through momentary LOS breaks so a
  // pillar doesn't reset the clock mid-duel, and go cold via
  // REACTION_MEMORY_TICKS — so re-peeking from real cover, or either side
  // respawning, hands the player a fresh window.
  if (firing) {
    let s = ai.seen[targetKey];
    if (!s || tick - s.at > REACTION_MEMORY_TICKS) {
      s = ai.seen[targetKey] = {
        at: tick,
        readyAt: tick + Math.round(prof.reaction * (0.85 + Math.random() * 0.4) * TICK_RATE),
      };
    }
    s.at = tick;
    if (tick < s.readyAt) firing = false;
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
  // A rune outranks the archetype's normal job when it is worth the walk: it is
  // a full heal plus 7s of a power, and leaving it standing hands it to the
  // other side. runePlan prices that against the detour, so a bot crosses the
  // map for a POWER SHOT, grabs anything when it is hurt, and ignores an
  // OVERDRIVE on the far side of the arena.
  const rune = runePlan(room, bot);
  let goal;
  if (rune) {
    goal = { x: rune.x, y: rune.y };
  } else if (prof.key === 'guard') {
    // Hold the tower, but chase anything within the leash OR anything we can
    // already shoot. The old version only reacted to enemies near its own tower,
    // so it spent whole matches orbiting an empty base doing nothing.
    const intruder = near
      && (Math.hypot(near.player.tank.x - ownTower.x, near.player.tank.y - ownTower.y) < GUARD_LEASH
          || near.dist < prof.engageRange)
      ? near.player.tank : null;
    if (intruder) {
      goal = { x: intruder.x, y: intruder.y };
    } else {
      const a = (tick / TICK_RATE) * 0.45 + bot.id;
      goal = { x: ownTower.x + Math.cos(a) * 165, y: ownTower.y + Math.sin(a) * 165 };
    }
  } else if (prof.key === 'hunt') {
    // Chase, but not across the whole arena: an enemy sitting in its own corner
    // used to drag Stalker away for the entire match, so the tower never saw a
    // second attacker. Out of chase range it sieges instead.
    const chase = near && near.dist < HUNT_CHASE_RANGE;
    goal = chase ? { x: near.player.tank.x, y: near.player.tank.y }
                 : { x: enemyTower.x, y: enemyTower.y };
  } else {
    // rush: the tower, unless something is right on top of us
    goal = (near && near.dist < 170) ? { x: near.player.tank.x, y: near.player.tank.y }
                                     : { x: enemyTower.x, y: enemyTower.y };
  }

  const goalDist = Math.hypot(goal.x - me.x, goal.y - me.y);
  // Route around the map instead of grinding into it. The steering fan still
  // handles the last few metres and anything dynamic.
  const via = navigate(me, goal.x, goal.y);
  const dir = steer(me, via.x, via.y, ai.evadeUntil > tick ? ai.evadeDir : 1);
  let mx = dir.x, my = dir.y;

  // Back off once we're at our preferred range, and strafe so we're not a
  // stationary target while trading shots.
  // Sieging, hold station just OUTSIDE the tower's own range. Shells reach ~2100px,
  // so nothing is lost by standing off, and the bot stops trading its life to the
  // tower every few seconds — which is what kept it walking back from spawn
  // instead of shooting the objective.
  // Never stand off from a RUNE: the whole point is to drive onto it, and the
  // back-off below would otherwise park the bot just outside the pickup circle
  // shooting at something, which looks exactly like a bot that cannot reach it.
  const standoffTarget = towerFirst ? TOWER_RANGE + 45 : prof.standoff;
  const engaged = firing && !rune && goalDist < standoffTarget;
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
  // Only a live tank is worth retreating FROM: a bot plinking the tower from
  // outside its range is in no danger, and walking home from there just meant it
  // spent the next ten seconds not attacking anything.
  // ...unless there is a rune to run to. It heals to full, so a hurt bot going
  // for one is choosing the better retreat — and it comes back with a power
  // instead of just coming back.
  const threatened = near && near.dist < prof.engageRange;
  if (!rune && me.hp <= MAX_HP * 0.34 && threatened && ai.evadeUntil <= tick) {
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
