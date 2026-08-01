// Boot + game loop. Runs inside the Usion host (identity + rooms + direct-mode
// access come from the SDK) and also standalone in a plain browser (dev token).
// Fixed-tick accumulator (60 Hz) drives input/prediction; rendering runs every
// animation frame with interpolation.

import { SERVICE_ID, devServerUrl, devRoomId } from './config.js';
import {
  DT, FIRE_COOLDOWN, MUZZLE_OFFSET, BULLET_SPEED, TEAM_NAMES, TOWER_HP, MATCH_RESET_DELAY,
} from '../shared/protocol.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { Renderer, teamColor } from './render.js';
import { makeTank, stepTank, stepBullet, TEAM_SPAWNS } from '../shared/sim.js';

const canvas = document.getElementById('game');
const $ = (id) => document.getElementById(id);

const renderer = new Renderer(canvas);
const input = new Input(canvas);

// resolved once the SDK (or its absence) settles
const me = { userId: null, userName: '', embedded: false, roomId: null };
let net = null;
let game = null;
let netStarted = false;
let started = false;              // game loop running

// ---------------------------------------------------------------- Usion boot --
function boot() {
  // No start screen to look at while the SDK settles — say something immediately.
  $('status').innerHTML = '<span>starting…</span>';
  const U = window.Usion;
  if (U && typeof U.init === 'function') {
    let done = false;
    const ready = (config) => {
      if (done) return; done = true;
      try {
        me.userId = (U.user && U.user.getId && U.user.getId()) || null;
        me.userName = (U.user && U.user.getName && U.user.getName()) || '';
        me.embedded = !!U._isEmbedded;
        me.roomId = (U.config && U.config.roomId) || (config && config.roomId) || null;
        // Solo → host promotion: a solo Explore launch becomes a live match when
        // the user taps the host's Share button. The SDK sets roomId/mode and we
        // connect for real. Register up front, even on a single launch.
        if (U.game && U.game.onRoomAssigned) {
          U.game.onRoomAssigned((info) => onRoomAssigned((info && info.roomId) || (U.config && U.config.roomId)));
        }
      } catch { /* fall through to whatever identity we have */ }
      onReady();
    };
    U.init(ready);
    // Guard: if init never fires (SDK script present but host silent), start
    // standalone rather than hang on the overlay forever.
    setTimeout(() => ready(null), 3000);
  } else {
    onReady(); // no SDK at all → pure standalone
  }
}

function onReady() {
  if (started) return;
  started = true;
  armFirstGesture();
  $('calibrate').addEventListener('click', () => { input.calibrate(); toast('Tilt re-centered'); });
  connectAndPlay();
}

// ------------------------------------------------------------- first gesture --
let wakeLock = null;
async function acquireWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}

// There is no PLAY button any more — the game starts on load. But iOS 13+ only
// hands out motion access (and fullscreen, and a wake lock) from inside a user
// gesture, so those are deferred to the player's FIRST touch instead of a
// dedicated tap-to-start screen. Until then the joystick fallback drives, so
// the game is playable from frame one either way.
function armFirstGesture() {
  let done = false;
  const fire = async () => {
    if (done) return;
    done = true;
    window.removeEventListener('pointerdown', fire, true);
    window.removeEventListener('click', fire, true);

    const tilt = await input.requestTilt();
    if (tilt === 'granted') {
      $('calibrate').style.display = 'block';
      toast('Tilt enabled — hold your phone level, then tilt to drive');
    } else if (tilt === 'denied') {
      toast('Motion access denied — using touch joystick');
    }

    // Cosmetic, best-effort — never block play on these.
    try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* iOS/iframe: no fullscreen */ }
    acquireWakeLock();
  };
  window.addEventListener('pointerdown', fire, true);
  window.addEventListener('click', fire, true);
}

// wake locks release when the page hides — take it back on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && started) acquireWakeLock();
});

let toastTimer = 0;
function toast(text, ms = 2200) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = 0; }, ms);
}

// ------------------------------------------------------------- mode selection --
function connectAndPlay() {
  if (me.embedded && me.roomId) {
    startNet(() => platformUrl(me.roomId));           // real multiplayer match
  } else if (me.embedded && !me.roomId) {
    startSoloPractice();                              // solo Explore launch
    toast('Practice mode — tap Share above to battle friends', 3400);
  } else {
    startNet(() => Promise.resolve(devUrl()));         // standalone / local dev
  }
}

// Fetch a fresh direct-mode access token from the platform and return the WS URL
// with the token attached. Called on every (re)connect (tokens are short-lived).
async function platformUrl(roomId) {
  const access = await window.Usion.game._fetchDirectAccess({
    roomId, serviceId: SERVICE_ID, protocolVersion: '2',
  });
  if (!access || !access.ws_url || !access.access_token) throw new Error('bad access payload');
  const sep = access.ws_url.indexOf('?') === -1 ? '?' : '&';
  return `${access.ws_url}${sep}token=${encodeURIComponent(access.access_token)}`;
}

function devUrl() {
  const room = devRoomId();
  const uid = String(me.userId || `guest-${Math.floor(Math.random() * 9999)}`).replace(/[^\w-]/g, '-');
  const token = `dev:${uid}:${room}`;
  const base = devServerUrl();
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

function onRoomAssigned(roomId) {
  if (!roomId || netStarted) return;
  me.roomId = roomId;
  stopSoloPractice();
  toast('Match starting…', 1600);
  startNet(() => platformUrl(roomId));
}

// -------------------------------------------------------- multiplayer session --
function startNet(resolveUrl) {
  if (netStarted) return;
  netStarted = true;
  stopSoloPractice();

  game = new Game(null); // net assigned below (Net calls back immediately)
  net = new Net(resolveUrl, {
    name: me.userName || 'tank',
    onSnapshot: (s) => game.onSnapshot(s),
    onEvent: (m) => {
      game.onEvent(m);
      if (m.t === 'welcome') toast(`You are on ${TEAM_NAMES[m.team ?? 0]} — destroy the enemy tower`, 2600);
      if (m.t === 'join' && m.id !== game.myId) toast(`${m.name} joined ${TEAM_NAMES[m.team ?? 0]}`, 1400);
      if (m.t === 'death' && m.victim !== game.myId && m.killer === game.myId) toast('Kill! +1', 1200);
      if (m.t === 'matchstart') toast('New match — go!', 1600);
      if (m.t === 'error') toast(m.reason, 4000);
    },
    onStatus: (s) => {
      $('status').innerHTML = s === 'connected'
        ? `<span id="pingv"></span>`
        : `<span class="bad">${s}…</span>`;
    },
  });
  game.net = net;
  window.__tank = { game, net, input, renderer }; // dev-tools debugging handle

  let last = performance.now();
  let acc = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) { dt = 0; acc = 0; } // tab was backgrounded — don't fast-forward

    input.poll();

    // aim: from last touch/mouse point through the camera to world space
    let aimAngle = game.aim;
    if (input.hasAim && game.me) {
      const w = renderer.screenToWorld(input.aimScreen.x, input.aimScreen.y);
      aimAngle = Math.atan2(w.y - (game.me.y + game.errY), w.x - (game.me.x + game.errX));
    }

    acc += dt;
    if (acc > DT * 6) acc = DT; // stall guard
    while (acc >= DT) {
      acc -= DT;
      if (net.connected) game.tick(input, aimAngle);
    }

    const renderMs = game.frame();

    // my predicted bullets extrapolate within the local tick; confirmed ones
    // within their own timeline cursor (dormant until born on the render timeline)
    const bullets = [];
    for (const b of game.bullets.values()) {
      if (b.bornMs > renderMs) continue; // fired "in the future" of the interpolated view
      const f = Math.min((renderMs - b.simMs) / 1000, DT);
      bullets.push({ x: b.x + b.vx * f, y: b.y + b.vy * f, vx: b.vx, vy: b.vy });
    }
    for (const b of game.predicted.values()) bullets.push({ x: b.x + b.vx * acc, y: b.y + b.vy * acc, vx: b.vx, vy: b.vy });

    renderer.draw({
      me: game.meServer,
      meId: game.myId,
      meName: game.names.get(game.myId) || me.userName || '',
      mePos: game.me ? { x: game.me.x + game.errX + game.me.vx * acc, y: game.me.y + game.errY + game.me.vy * acc, hull: game.me.hull } : null,
      aimAngle,
      myTeam: game.myTeam,
      towerHp: game.towerHp,
      others: game.remoteStates(renderMs),
      bullets,
      effects: game.effects,
    });

    updateHud();
  }
  requestAnimationFrame(loop);

  setInterval(() => {
    const el = $('pingv');
    if (el && net) el.textContent = `${net.rtt} ms`;
  }, 500);
}

function updateHud() {
  // team scoreboard: tower integrity is the win condition, kills are secondary
  const rows = game.scoreboard();
  const tHp = game.towerHp;
  let html = '';
  for (let team = 0; team < TEAM_NAMES.length; team++) {
    const pct = Math.round(Math.max(0, Math.min(1, (tHp[team] ?? 0) / TOWER_HP)) * 100);
    html += `<div class="hdr" style="color:${teamColor(team)}">`
      + `${TEAM_NAMES[team]}${team === game.myTeam ? ' (you)' : ''} · tower ${pct}%</div>`;
    for (const r of rows) {
      if (r.team !== team) continue;
      const tag = r.bot ? '<i>bot</i>' : '';
      html += `<div class="row ${r.me ? 'me' : ''}"><span>${esc(r.name)}${tag}</span><span>${r.score}</span></div>`;
    }
  }
  const el = $('scores');
  if (el.__last !== html) { el.innerHTML = html; el.__last = html; }

  // match result overlay
  const over = game.phase === 'over';
  $('match').style.display = over ? 'flex' : 'none';
  if (over) {
    const won = game.winner === game.myTeam;
    $('matchWho').textContent = won ? 'VICTORY' : 'DEFEAT';
    $('matchWho').style.color = teamColor(game.winner);
    const left = Math.max(0, MATCH_RESET_DELAY - (performance.now() - game.matchOverAt) / 1000);
    $('matchSub').textContent = `${TEAM_NAMES[game.winner]} destroyed the tower · next match in ${left.toFixed(0)}s`;
    $('matchTally').textContent = `${TEAM_NAMES[0]} ${game.wins[0]} — ${game.wins[1]} ${TEAM_NAMES[1]}`;
  }

  // respawn overlay (suppressed while the result screen is up)
  const dead = !over && game.meServer && !game.meServer.alive;
  $('respawn').style.display = dead ? 'flex' : 'none';
  if (dead) {
    const s = Math.max(0, (game.respawnCountdown - performance.now()) / 1000);
    $('respawnIn').textContent = s > 0 ? `respawning in ${s.toFixed(1)}s` : 'respawning…';
  }
}

// ------------------------------------------------------------- solo practice --
// No server: a single local tank driven by the same shared sim, so a solo
// Explore launch is instantly playable (feel the tilt + fire) while waiting to
// be promoted into a real match via the host's Share button (onRoomAssigned).
let soloActive = false;
let soloRAF = 0;
function startSoloPractice() {
  if (soloActive || netStarted) return;
  soloActive = true;
  $('scores').innerHTML = '';
  $('status').innerHTML = '<span>practice</span>';

  const spawn = TEAM_SPAWNS[0][0];
  const tank = makeTank(1, spawn.x, spawn.y, 0);
  const bullets = [];
  const effects = [];
  let nextFireAt = -10;
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    if (!soloActive) return;
    soloRAF = requestAnimationFrame(frame);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.25) { dt = 0; acc = 0; }

    input.poll();
    let aim = tank.turret;
    if (input.hasAim) {
      const w = renderer.screenToWorld(input.aimScreen.x, input.aimScreen.y);
      aim = Math.atan2(w.y - tank.y, w.x - tank.x);
    }

    acc += dt;
    if (acc > DT * 6) acc = DT;
    while (acc >= DT) {
      acc -= DT;
      stepTank(tank, { moveX: input.moveX, moveY: input.moveY }, DT);
      tank.turret = aim;
      const t = now / 1000;
      if (input.firing && t >= nextFireAt) {
        nextFireAt = t + FIRE_COOLDOWN;
        const bx = tank.x + Math.cos(aim) * MUZZLE_OFFSET;
        const by = tank.y + Math.sin(aim) * MUZZLE_OFFSET;
        bullets.push({ x: bx, y: by, vx: Math.cos(aim) * BULLET_SPEED, vy: Math.sin(aim) * BULLET_SPEED, age: 0, bounces: 0 });
        effects.push({ kind: 'muzzle', x: bx, y: by, a: aim, born: performance.now(), dur: 90 });
      }
      for (let i = bullets.length - 1; i >= 0; i--) if (!stepBullet(bullets[i], DT)) bullets.splice(i, 1);
    }

    const n = performance.now();
    for (let i = effects.length - 1; i >= 0; i--) if (n - effects[i].born > effects[i].dur) effects.splice(i, 1);

    renderer.draw({
      me: tank, meId: 1, meName: me.userName || 'you',
      mePos: { x: tank.x + tank.vx * acc, y: tank.y + tank.vy * acc, hull: tank.hull },
      aimAngle: aim,
      myTeam: 0,
      towerHp: [TOWER_HP, TOWER_HP],   // practice: both towers stand, neither shoots
      others: [],
      bullets: bullets.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy })),
      effects,
    });
  }
  soloRAF = requestAnimationFrame(frame);
}

function stopSoloPractice() {
  soloActive = false;
  if (soloRAF) cancelAnimationFrame(soloRAF);
  soloRAF = 0;
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

boot();
