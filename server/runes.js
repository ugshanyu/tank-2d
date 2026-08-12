// Which two powers a rune wave carries.
//
// Pure and side-effect free so it can be tested directly — the distribution IS
// the balance, and a weighted roll that quietly favours the wrong power is not
// something you can see by playing a few matches.
import { RUNE_WEIGHTS } from '../client/shared/protocol.js';

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
