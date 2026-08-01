// Local player profile: XP, level, and lifetime stats.
//
// The game had no persistence beyond four settings booleans — a match ended, six
// seconds passed, an identical match began, forever. Nothing accumulated, so
// there was no reason to open it a second time. This is the minimum honest
// version of a progression loop: it is entirely local (no account, no server
// column), so it survives a reload but not a new device. That is a deliberate
// scope choice, not an oversight — see README.

const KEY = 'tank.profile';

// Level curve: 100 XP for L2, then +60 each level. Reaching L10 is ~4300 XP,
// roughly 40 matches — enough to feel like progress without a grind wall.
export function xpForLevel(level) {
  return level <= 1 ? 0 : 100 * (level - 1) + 30 * (level - 1) * (level - 2);
}
export function levelFromXp(xp) {
  let l = 1;
  while (xp >= xpForLevel(l + 1)) l++;
  return l;
}

const BLANK = {
  xp: 0, matches: 0, wins: 0, kills: 0, deaths: 0, towerDamage: 0, bestKills: 0,
};

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...BLANK, ...raw };
  } catch { /* private mode or corrupt */ }
  return { ...BLANK };
}

function save(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// XP is weighted toward the objective, not toward kills: the win condition is
// the tower, and a scoreboard that only rewards kills teaches the wrong game.
export function awardMatch({ won, kills, deaths, towerDamage }) {
  const p = load();
  const before = { xp: p.xp, level: levelFromXp(p.xp) };
  const gained = (won ? 120 : 40)
    + kills * 25
    + Math.round(towerDamage / 10);
  p.xp += gained;
  p.matches += 1;
  if (won) p.wins += 1;
  p.kills += kills;
  p.deaths += deaths;
  p.towerDamage += towerDamage;
  if (kills > p.bestKills) p.bestKills = kills;
  save(p);
  const level = levelFromXp(p.xp);
  return {
    gained,
    xp: p.xp,
    level,
    levelledUp: level > before.level,
    intoLevel: p.xp - xpForLevel(level),
    levelSpan: xpForLevel(level + 1) - xpForLevel(level),
    profile: p,
  };
}
