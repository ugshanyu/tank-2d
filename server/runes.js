// Which two powers a rune wave carries.
//
// Pure and side-effect free so it can be tested directly — the distribution IS
// the balance, and a weighted roll that quietly favours the wrong power is not
// something you can see by playing a few matches.
import {
  RUNE_WEIGHTS, RUNE_SPOTS, RUNE_MARGIN, RUNE_CLEARANCE, RUNE_TOWER_GAP, ARENA_W, ARENA_H,
} from '../client/shared/protocol.js';
import { OBSTACLES, TOWERS } from '../client/shared/sim.js';

/**
 * Draw the pair for one wave: weighted by RUNE_WEIGHTS and WITHOUT replacement,
 * so the two gates always offer different powers and the wave is a choice
 * rather than a race for two copies of one thing.
 *
 * @param {number} wave  index of this wave (only consulted when `force` is set)
 * @param {number[][]} force  test-only fixed sequence of [gate0, gate1] pairs
 * @returns {number[]} [kindAtGate0, kindAtGate1]
 */
export function rollRunePair(wave = 0, force = []) {
  if (force && force.length) {
    const fixed = force[wave % force.length];
    if (fixed && fixed.length === 2) return fixed.slice();
  }
  const pool = RUNE_WEIGHTS.slice();
  const out = [];
  for (let n = 0; n < 2 && pool.length; n++) {
    let total = 0;
    for (const e of pool) total += e.weight;
    let r = Math.random() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= pool[i].weight;
      if (r <= 0) break;
    }
    out.push(pool[i].kind);
    pool.splice(i, 1);   // no replacement -> gate 1 can never repeat gate 0
  }
  return out;
}

/**
 * Is (x, y) a legal rune spot: clear of every obstacle by RUNE_CLEARANCE and
 * of every tower by RUNE_TOWER_GAP? Pure; the smoke suite asserts it directly.
 */
export function runeSpotClear(x, y) {
  for (const r of OBSTACLES) {
    if (x > r.x - RUNE_CLEARANCE && x < r.x + r.w + RUNE_CLEARANCE
        && y > r.y - RUNE_CLEARANCE && y < r.y + r.h + RUNE_CLEARANCE) return false;
  }
  for (const tw of TOWERS) {
    if (Math.hypot(x - tw.x, y - tw.y) < RUNE_TOWER_GAP) return false;
  }
  return true;
}

/**
 * Where this wave lands: a random legal spot in BLUE's half (bottom), and its
 * point-mirror through the arena centre for RED. The map is symmetric under
 * that mirror (every obstacle and tower has a twin), so one clearance check
 * covers both. Rejection-sampled; the legal area is most of the half, so the
 * fallback to the fixed gates is unreachable on this map.
 *
 * @param {() => number} rand   injectable for deterministic tests
 * @param {{x:number,y:number}[]|null} force  test-only pin (RUNE_SPOTS_FORCE)
 * @returns {{x:number,y:number}[]} [spotForTeam0, spotForTeam1]
 */
export function pickRuneSpots(rand = Math.random, force = null) {
  if (force && force.length === 2) return force.map((s) => ({ x: s.x, y: s.y }));
  const half = ARENA_H / 2;
  for (let attempt = 0; attempt < 64; attempt++) {
    const x = Math.round(RUNE_MARGIN + rand() * (ARENA_W - 2 * RUNE_MARGIN));
    const y = Math.round(half + RUNE_MARGIN + rand() * (half - 2 * RUNE_MARGIN));
    if (!runeSpotClear(x, y)) continue;
    return [{ x, y }, { x: ARENA_W - x, y: ARENA_H - y }];
  }
  return RUNE_SPOTS.map((s) => ({ x: s.x, y: s.y }));
}
