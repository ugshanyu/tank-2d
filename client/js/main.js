// Boot + game loop. Fixed-tick accumulator (30 Hz) drives input/prediction;
// rendering runs every animation frame with interpolation.

import { serverUrl, roomId } from './config.js';
import { DT } from '../shared/protocol.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { Renderer, colorFor } from './render.js';

const canvas = document.getElementById('game');
const $ = (id) => document.getElementById(id);

const renderer = new Renderer(canvas);
const input = new Input(canvas);
let net = null;
let game = null;

// ---- start overlay ----
const nameEl = $('name');
nameEl.value = localStorage.getItem('tank_name') || '';

$('play').addEventListener('click', async () => {
  const name = (nameEl.value.trim() || 'tank-' + Math.floor(Math.random() * 99));
  localStorage.setItem('tank_name', name);

  // must happen inside the tap gesture (iOS)
  const tilt = await input.requestTilt();
  if (tilt === 'granted') {
    $('calibrate').style.display = 'block';
    toast('Tilt enabled — hold your phone level, then tilt to drive');
  } else if (tilt === 'denied') {
    toast('Motion access denied — using touch joystick');
  }

  try { await document.documentElement.requestFullscreen?.(); } catch { /* iOS Safari: no fullscreen API */ }
  try { await navigator.wakeLock?.request('screen'); } catch { /* optional */ }

  $('start').style.display = 'none';
  start(name);
});

$('calibrate').addEventListener('click', () => { input.calibrate(); toast('Tilt re-centered'); });

let toastTimer = 0;
function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = 0; }, ms);
}

// ---- connection + loop ----
function start(name) {
  game = new Game(null); // net assigned below (Net calls back immediately)
  net = new Net(serverUrl(), {
    name,
    room: roomId(),
    onSnapshot: (s) => game.onSnapshot(s),
    onEvent: (m) => {
      game.onEvent(m);
      if (m.t === 'welcome') toast(`Joined arena "${m.room}" — ${m.players.length} tank(s)`, 1800);
      if (m.t === 'join' && m.id !== game.myId) toast(`${m.name} joined`, 1400);
      if (m.t === 'death' && m.victim !== game.myId && m.killer === game.myId) toast('Kill! +1', 1200);
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

    // my predicted bullets extrapolate within the local tick; confirmed ones within the remote tick
    const bullets = [];
    const remFrac = game.remoteSimTimeMs === null ? 0 : (renderMs - game.remoteSimTimeMs) / 1000;
    for (const b of game.bullets.values()) bullets.push({ x: b.x + b.vx * remFrac, y: b.y + b.vy * remFrac, vx: b.vx, vy: b.vy });
    for (const b of game.predicted.values()) bullets.push({ x: b.x + b.vx * acc, y: b.y + b.vy * acc, vx: b.vx, vy: b.vy });

    renderer.draw({
      me: game.meServer,
      meId: game.myId,
      meName: game.names.get(game.myId) || '',
      mePos: game.me ? { x: game.me.x + game.errX + game.me.vx * acc, y: game.me.y + game.errY + game.me.vy * acc, hull: game.me.hull } : null,
      aimAngle,
      others: game.remoteStates(renderMs),
      bullets,
      effects: game.effects,
    });

    updateHud();
  }
  requestAnimationFrame(loop);

  setInterval(() => {
    const el = $('pingv');
    if (el && net) el.textContent = `${net.rtt} ms · ${roomId()}`;
  }, 500);
}

function updateHud() {
  // scoreboard (throttled by string compare)
  const rows = game.scoreboard();
  const html = rows.map((r) =>
    `<div class="${r.me ? 'me' : ''}" style="color:${r.me ? '' : colorFor(r.id)}">${esc(r.name)} — ${r.score}</div>`
  ).join('');
  const el = $('scores');
  if (el.__last !== html) { el.innerHTML = html; el.__last = html; }

  // respawn overlay
  const dead = game.meServer && !game.meServer.alive;
  $('respawn').style.display = dead ? 'flex' : 'none';
  if (dead) {
    const s = Math.max(0, (game.respawnCountdown - performance.now()) / 1000);
    $('respawnIn').textContent = s > 0 ? `respawning in ${s.toFixed(1)}s` : 'respawning…';
  }
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
