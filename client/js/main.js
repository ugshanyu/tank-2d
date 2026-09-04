// Boot + game loop. Runs inside the Usion host (identity + rooms + direct-mode
// access come from the SDK) and also standalone in a plain browser (dev token).
// Fixed-tick accumulator (60 Hz) drives input/prediction; rendering runs every
// animation frame with interpolation.

import { SERVICE_ID, devServerUrl, devRoomId } from './config.js';
import {
  DT, FIRE_COOLDOWN, MUZZLE_OFFSET, BULLET_SPEED, TEAM_NAMES, TOWER_HP, MATCH_RESET_DELAY,
  MAX_HP, MAG_SIZE, POWER_NAMES,
} from '../shared/protocol.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { Renderer, teamColor, setShakeScale, getShakeScale } from './render.js';
import { Sfx, haptic } from './audio.js';
import { awardMatch, load as loadProfile, levelFromXp } from './profile.js';
import { makeTank, stepTank, stepBullet, randomTowerSpawn } from '../shared/sim.js';

const canvas = document.getElementById('game');
const $ = (id) => document.getElementById(id);

// Cached once — these were being looked up ~10x per frame.
const EL = {};
for (const id of ['status', 'respawn', 'respawnIn', 'toast',
                  'match', 'matchWho', 'matchSub', 'matchTally', 'hurt', 'gear',
                  'sheet', 'sheetClose', 'optStick', 'optTilt', 'optSound', 'optHaptics',
                  'optHelp', 'intro', 'introGo', 'introDrive',
                  'offline', 'offlineSub', 'shake0', 'shake1', 'shake2',
                  'introAim', 'motion', 'motionGo', 'motionSkip', 'lobby', 'lobbyTitle', 'lobbyList', 'lobbyStart', 'lobbyInvite', 'lobbyHint', 'feed', 'killbanner', 'poseRow', 'poseUpright', 'poseAngled', 'poseFlat',
                  'matchCard', 'stKills', 'stDeaths', 'stTower', 'xpLevel', 'xpGain', 'xpFill']) {
  EL[id] = document.getElementById(id);
}
const sfx = new Sfx();

// Safe-area insets are 0 inside a nested browsing context. If we are framed, fall
// back to values that clear a notch/Dynamic Island and the home indicator.
if (window.self !== window.top) document.documentElement.classList.add('framed');

// Where can the settings button live without sitting on the playfield? Depends
// entirely on the letterbox band, which is 0 on a 16:9 screen or a short iframe.
function placeGear() {
  const band = (window.innerHeight - 1280 * Math.min(window.innerWidth / 720, window.innerHeight / 1280)) / 2;
  document.documentElement.classList.toggle('noband', band < 58);
}
placeGear();
window.addEventListener('resize', placeGear);

const renderer = new Renderer(canvas);
const input = new Input(canvas);

// resolved once the SDK (or its absence) settles
const me = { userId: null, userName: '', embedded: false, roomId: null, invite: false };
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
  // The sensor can wake up seconds after the permission prompt; when it does,
  // adopt tilt (if that is the preference) and tell the player.
  input.onTiltReady = () => {
    syncSheet();
    if (input.mode === 'tilt') toast('Tilt enabled — tilt your phone to drive', 2400);
  };
  armFirstGesture();
  wireUi();
  maybeAskMotion();
  connectAndPlay();
  maybeShowIntro();
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

    sfx.unlock();   // AudioContext can only start inside a gesture
    // Tilt is the phone default, so this tap is the user gesture iOS insists on
    // for motion access. A player on the joystick (sensor denied or absent, or
    // chose it in Settings) just gets an ordinary shot. Swallow the tap only when
    // it will genuinely open the modal: doing it unconditionally ate the first
    // shot on Android and in WebViews, where no prompt ever appears.
    if (input.prefersTilt) {
      input.suppressNextPointer = input.needsTiltPrompt();
      const tilt = await input.requestTilt();
      if (tilt === 'granted' && input.mode === 'tilt') {
        toast('Tilt to drive — settings has the pose presets', 2600);
      } else if (tilt === 'denied') {
        // iOS remembers a refusal per origin, and a WebView whose host app does not
        // implement the motion-permission delegate reports 'denied' with no prompt
        // at all — so point at the retry rather than implying it is permanent.
        toast('Motion blocked — first finger drives, second shoots. Retry in ⚙ Settings', 3400);
      } else if (tilt === 'unavailable') {
        toast('No motion sensor — first finger drives, second shoots', 3000);
      } else if (tilt === 'pending') {
        // The sensor has not reported yet. It still might; onTiltReady switches us
        // over if it does, so do not tell the player tilt is gone.
        toast('First finger drives, second finger shoots', 2600);
      }
      // The permission modal can swallow pointerup, leaving a phantom held touch.
      input.clearTouches();
    }

    // Cosmetic, best-effort — never block play on these.
    try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* iOS/iframe: no fullscreen */ }
    acquireWakeLock();
  };
  window.addEventListener('pointerdown', fire, true);
  window.addEventListener('click', fire, true);
}

// ASK ON OPEN. iOS 13+ refuses DeviceOrientation to any requestPermission() that
// is not inside a user gesture, so a page-load prompt is impossible — but waiting
// for the player to happen to touch the playfield meant tilt engaged whenever,
// and looked like the game had defaulted to the joystick. This puts one
// deliberate ask in front of them the moment the game opens.
//
// Shown ONLY when it would do something: a touch device that prefers tilt, where
// the iOS gate genuinely exists and tilt has not already engaged by itself.
// Players who chose the joystick never see it. The 600 ms grace keeps it off
// Android and every WebView without the gate — those attach at startup and are
// usually already steering by then.
function maybeAskMotion() {
  if (!input.isTouch || !input.prefersTilt) return;
  setTimeout(() => {
    if (input.tiltReady || !input.needsTiltPrompt()) return;
    // The first-run intro already puts a PLAY button in the way, and tapping it
    // is itself the gesture — don't stack two overlays.
    if (EL.intro.classList.contains('on')) return;
    EL.motion.classList.add('on');
  }, 600);
}

async function askMotion() {
  EL.motion.classList.remove('on');
  input.suppressNextPointer = false;      // this tap WAS the prompt, not a shot
  const verdict = await input.requestTilt();
  input.clearTouches();
  if (verdict === 'granted' || input.tiltReady) toast('Tilt to drive', 2000);
  else if (verdict === 'denied') toast('Motion blocked — first finger drives, second shoots. Retry in ⚙', 3400);
  syncSheet();
}

// wake locks release when the page hides — take it back on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && started) acquireWakeLock();
  // rAF is suspended while hidden, so a match that ended in the background never
  // reached showScorecard(). Settle the XP either way.
  if (game && game.pendingAward) drainAward();
});

// Queued, not single-slot. The old version cleared and overwrote, so on a solo
// launch the welcome message plus three bot joins all landed in one tick and the
// player only ever saw "Bulwark joined RED" — never their team or the objective.
const toastQ = [];
let toastBusy = false;
function toast(text, ms = 2200) {
  toastQ.push({ text, ms });
  if (toastQ.length > 3) toastQ.splice(0, toastQ.length - 3);
  pumpToast();
}
function pumpToast() {
  if (toastBusy || !toastQ.length) return;
  const el = EL.toast;
  if (!el) return;
  const { text, ms } = toastQ.shift();
  toastBusy = true;
  el.textContent = text;
  el.style.opacity = 1;
  setTimeout(() => {
    el.style.opacity = 0;
    setTimeout(() => { toastBusy = false; pumpToast(); }, 240);
  }, ms);
}

// ------------------------------------------------------------------ settings --
function openSheet(open) {
  EL.sheet.classList.toggle('on', open);
  syncSheet();
}
function syncSheet() {
  // Show the PREFERENCE, not the transient mode. `mode` is 'stick' until a real
  // sensor reading lands, so keying off it made the sheet report "Joystick" to
  // every player whose phone had simply not reported yet — the setting looked
  // changed when nothing had changed.
  EL.optStick.classList.toggle('sel', !input.prefersTilt);
  EL.optTilt.classList.toggle('sel', input.prefersTilt);
  EL.optTilt.disabled = !input.tiltSupported();
  EL.optSound.textContent = sfx.muted ? 'Off' : 'On';
  EL.optHaptics.textContent = hapticsOn ? 'On' : 'Off';
  const s = getShakeScale();
  EL.shake0.classList.toggle('sel', s === 0);
  EL.shake1.classList.toggle('sel', s > 0 && s < 0.8);
  EL.shake2.classList.toggle('sel', s >= 0.8);
  // posture presets are only meaningful while actually steering by tilt
  EL.poseRow.style.display = input.mode === 'tilt' ? '' : 'none';
  EL.poseUpright.classList.toggle('sel', input.tiltPreset === 'upright');
  EL.poseAngled.classList.toggle('sel', input.tiltPreset === 'angled');
  EL.poseFlat.classList.toggle('sel', input.tiltPreset === 'flat');
}
let hapticsOn = true;
try { hapticsOn = localStorage.getItem('tank.haptics') !== '0'; } catch { /* private mode */ }

function wireUi() {
  EL.gear.addEventListener('click', () => openSheet(true));
  EL.sheetClose.addEventListener('click', () => openSheet(false));
  EL.sheet.addEventListener('click', (e) => { if (e.target === EL.sheet) openSheet(false); });
  EL.optStick.addEventListener('click', () => { input.setMode('stick', { persist: true }); syncSheet(); });
  EL.optTilt.addEventListener('click', async () => {
    const verdict = input.tiltReady ? 'granted' : await input.requestTilt();
    // A sensor the OS refused, or a device without one, must not be remembered
    // as "tilt" — that would greet every launch with a prompt that cannot succeed.
    if (verdict === 'denied') { toast('Motion blocked by the OS — joystick stays on', 3000); syncSheet(); return; }
    if (verdict === 'unavailable') { toast('No motion sensor on this device', 2600); syncSheet(); return; }
    // 'granted' or 'pending': the preference is the player's and it sticks; the
    // mode follows the moment a reading lands (onTiltReady).
    if (!input.setMode('tilt', { persist: true })) toast('Waiting for the motion sensor — joystick until then', 2600);
    syncSheet();
  });
  EL.optSound.addEventListener('click', () => { sfx.unlock(); sfx.setMuted(!sfx.muted); syncSheet(); });
  EL.optHaptics.addEventListener('click', () => {
    hapticsOn = !hapticsOn;
    try { localStorage.setItem('tank.haptics', hapticsOn ? '1' : '0'); } catch { /* ignore */ }
    syncSheet();
  });
  EL.poseUpright.addEventListener('click', () => { input.applyTiltPreset('upright'); syncSheet(); });
  EL.poseAngled.addEventListener('click', () => { input.applyTiltPreset('angled'); syncSheet(); });
  EL.poseFlat.addEventListener('click', () => { input.applyTiltPreset('flat'); syncSheet(); });
  EL.shake0.addEventListener('click', () => { setShakeScale(0); syncSheet(); });
  EL.shake1.addEventListener('click', () => { setShakeScale(0.5); syncSheet(); });
  EL.shake2.addEventListener('click', () => { setShakeScale(1); syncSheet(); });
  EL.optHelp.addEventListener('click', () => { openSheet(false); showIntro(); });
  EL.lobbyStart.addEventListener('click', () => { if (net) net.sendJson({ t: 'start' }); });
  EL.lobbyInvite.addEventListener('click', async () => {
    // The platform's own friend/group picker — we never draw one.
    try { await window.Usion?.game?.invite?.({ maxPlayers: 4 }); }
    catch { toast('Invites are available inside the app', 2600); }
  });
  EL.motionGo.addEventListener('click', askMotion);
  EL.motionSkip.addEventListener('click', () => {
    EL.motion.classList.remove('on');
    input.setMode('stick', { persist: true });   // an explicit choice, and it sticks
    syncSheet();
  });
  EL.introGo.addEventListener('click', () => {
    EL.intro.classList.remove('on');
    input.clearTouches();
    try { localStorage.setItem('tank.seen', '1'); } catch { /* ignore */ }
  });
}

// Dropping a first-time player cold into a live match with no explanation was the
// single most disorienting thing about this game. Shown once, recallable from
// settings. The match runs underneath — this never blocks or pauses anyone else.
function showIntro() {
  // Desktop has always steered with WASD/arrows and aimed with the mouse, but the
  // intro only ever described the touch controls — so on web the game read as
  // "drag the left side", which does nothing with a mouse, and the keyboard went
  // undiscovered. Say what actually works on the device you are on.
  if (!input.isTouch) {
    EL.introDrive.textContent = 'WASD or the arrow keys to drive.';
    EL.introAim.textContent = 'Aim with the mouse. Click or press space to fire.';
  } else {
    // On a phone tilt is the default, but permission is not granted until the first
    // touch — so key the copy off the PREFERENCE, not the mode we're in right now.
    // Joystick mode is two-finger by design: the first finger IS the stick,
    // wherever it lands, so "touch to shoot" has to say "second finger".
    const tilt = input.mode === 'tilt' || input.prefersTilt;
    EL.introDrive.textContent = tilt
      ? 'Tilt your phone to drive.'
      : 'First finger: drag to drive — the joystick appears under it, left or right.';
    EL.introAim.textContent = tilt
      ? 'Touch anywhere to aim and shoot.'
      : 'Second finger: touch to aim and shoot.';
  }
  EL.intro.classList.add('on');
}
function maybeShowIntro() {
  let seen = false;
  try { seen = localStorage.getItem('tank.seen') === '1'; } catch { /* private mode */ }
  if (!seen) showIntro();
}

// ------------------------------------------------------------- mode selection --
// Was this opened from a chat game-invite, or solo? Trust the launch MODE the
// host declares — never infer from roomId, because a solo launch may still be
// handed an auto-created room for SDK plumbing.
function launchedFromInvite() {
  try {
    const U = window.Usion;
    const lp = (U && typeof U.getLaunchParams === 'function') ? (U.getLaunchParams() || {}) : {};
    if (lp.mode === 'multiplayer') return true;
    if (lp.mode === 'single') return false;
    if (U && U.game && typeof U.game.isMultiplayer === 'function') return U.game.isMultiplayer();
    const rid = String(me.roomId || '');
    return !!rid && !/^standalone[_-]/i.test(rid);
  } catch { return false; }
}

// A RANDOM launch asks the platform for a world: the one you are already in,
// else a backfill into a world with space, else a fresh one. That is exactly
// "join whoever is around, and start a new room once four are in" — decided
// atomically by the platform, so seats can never oversell and we never have to
// weaken the token→room binding to pool strangers ourselves.
async function findWorldRoom() {
  const U = window.Usion;
  if (!U || !U.game || typeof U.game.joinWorld !== 'function') return null;
  try {
    const { roomId } = await U.game.joinWorld({ serviceId: SERVICE_ID });
    return roomId || null;
  } catch (e) {
    // MATCH_TIMEOUT, or the service is not tagged `world` yet — fall back to a
    // private match with bots rather than stranding the player on an overlay.
    console.warn('[match] no world available, falling back to bots:', e && e.message);
    return null;
  }
}

async function connectAndPlay() {
  me.invite = launchedFromInvite();

  if (me.embedded && me.invite && me.roomId) {
    startNet(() => platformUrl(me.roomId));            // friends only — opens a lobby
    return;
  }
  if (me.embedded) {
    // random / solo launch: try to land in a shared world first
    const world = await findWorldRoom();
    if (world) { me.roomId = world; startNet(() => platformUrl(world)); return; }
    if (me.roomId) { startNet(() => platformUrl(me.roomId)); return; }
    startSoloPractice();                               // nothing to join yet
    toast('Practice mode — tap Share above to battle friends', 3400);
    return;
  }
  startNet(() => Promise.resolve(devUrl()));           // standalone / local dev
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
  me.invite = true;   // promotion only ever happens via an invite/Share
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
    invite: me.invite,
    onSnapshot: (s) => game.onSnapshot(s),
    onEvent: (m) => {
      game.onEvent(m);
      if (m.t === 'welcome') toast(`You are on ${TEAM_NAMES[m.team ?? 0]} — destroy the enemy tower`, 2600);
      if (m.t === 'join' && m.id !== game.myId) toast(`${m.name} joined ${TEAM_NAMES[m.team ?? 0]}`, 1400);
      // no "+1" for a teamkill — the server refuses the point (friendly fire hurts, but doesn't score)
      if (m.t === 'death' && m.victim !== game.myId && m.killer === game.myId
          && (game.teams.get(m.victim) ?? 0) !== game.myTeam) toast('Kill! +1', 1200);
      if (m.t === 'matchstart') toast('New match — go!', 1600);
      if (m.t === 'rune' && m.taker === game.myId) toast(`${POWER_NAMES[m.kind]}!`, 1800);
      if (m.t === 'welcome') { lobbyHostId = m.hostId || 0; showLobby(m.phase === 'lobby'); }
      if (m.t === 'lobby') renderLobby(m);
      if (m.t === 'matchstart') showLobby(false);
      if (m.t === 'error') toast(m.reason, 4000);
    },
    onStatus: (s, reason) => {
      if (s === 'stale') {
        // Deployed a new wire format under a page that is still running the old
        // one. Reload rather than decode snapshots wrongly.
        EL.offline.classList.add('on');
        EL.offline.classList.remove('fatal');
        EL.offline.firstElementChild.textContent = 'GAME UPDATED';
        EL.offlineSub.textContent = 'reloading…';
        setTimeout(() => location.reload(), 900);
        return;
      }
      EL.status.innerHTML = s === 'connected'
        ? `<span id="pingv"></span>`
        : `<span class="bad">${s === 'failed' ? 'offline' : s + '…'}</span>`;
      // A frozen arena that still renders as if live is indistinguishable from lag,
      // so the player keeps mashing a dead game. Make "frozen" legible.
      const off = s !== 'connected';
      EL.offline.classList.toggle('on', off);
      EL.offline.classList.toggle('fatal', s === 'failed');
      if (s === 'failed') {
        EL.offline.firstElementChild.textContent = 'CANNOT CONNECT';
        EL.offlineSub.textContent = reason || '';
      } else if (off) {
        EL.offline.firstElementChild.textContent = 'RECONNECTING';
        EL.offlineSub.textContent = s === 'connecting' ? 'joining the match…' : 'trying to get you back in…';
      }
    },
  });
  game.net = net;
  window.__tank = { game, net, input, renderer }; // dev-tools debugging handle

  let last = performance.now();
  let acc = 0;
  let hudAt = 0;
  let myDispHp = MAX_HP;   // displayed own hp — eases down toward authoritative
  // Pooled render state — this used to allocate ~55 objects every frame, which on
  // iOS Safari is a nursery collection (and a dropped frame) every couple of seconds.
  const mePos = { x: 0, y: 0, hull: 0 };
  const drawState = {
    me: null, meId: 0, meName: '', mePos: null, aimAngle: 0, myTeam: 0,
    towerHp: null, others: null, bullets: null, effects: null, joy: null, joyMax: 0,
    dt: 1 / 60, lastFireAt: -1e9, reload: 1,
  };

  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) { dt = 0; acc = 0; } // tab was backgrounded — don't fast-forward

    input.poll();

    // Hitstop: freeze the sim briefly on death / match end. The pause is what
    // gives an impact weight; rendering continues so it reads as a beat, not a hang.
    if (game.hitstopMs > 0) {
      game.hitstopMs -= dt * 1000;
      dt = 0;
    }

    // aim: from last touch/mouse point through the camera to world space
    let aimAngle = game.aim;
    if (input.hasAim && game.me) {
      const w = renderer.screenToWorld(input.aimScreen.x, input.aimScreen.y);
      aimAngle = Math.atan2(w.y - (game.me.y + game.errY), w.x - (game.me.x + game.errX));
    }

    acc += dt;
    // Clamp, don't reset — resetting to DT silently threw away up to 5 ticks of real
    // time on every hitch, starving the server's input queue and freezing the tank.
    if (acc > DT * 6) acc = DT * 6;
    while (acc >= DT) {
      acc -= DT;
      if (net.connected) game.tick(input, aimAngle);
    }

    // One call: every shell advances on real frame time, spent ones are reaped,
    // predicted damage ages out. Shells are drawn exactly where they are — no
    // second timeline to extrapolate onto.
    const renderMs = game.frame(dt || 1 / 60);
    drainFeedback();

    if (game.me) {
      mePos.x = game.me.x + game.errX + game.me.vx * acc;
      mePos.y = game.me.y + game.errY + game.me.vy * acc;
      mePos.hull = game.me.hull;
      // Record the RAW predicted position (no errX): incoming fire is judged by
      // the server against its authoritative view of us, which our raw prediction
      // tracks — the correction offset is purely how we're drawn.
      game.recordSelf(net.serverNowMs(), game.me.x + game.me.vx * acc, game.me.y + game.me.vy * acc);
    }
    if (game.shake > 0) { renderer.addShake(game.shake); game.shake = 0; }

    drawState.me = game.meServer;
    // Own bar: AUTHORITATIVE hp, eased so a confirmed hit reads as a drop rather
    // than a step. Snaps upward instantly (respawn/heal must not animate).
    const hpTarget = game.meServer ? game.meServer.hp : MAX_HP;
    myDispHp = hpTarget >= myDispHp ? hpTarget
      : myDispHp + (hpTarget - myDispHp) * (1 - Math.exp(-(dt || 1 / 60) / 0.12));
    drawState.myHp = myDispHp;
    drawState.meId = game.myId;
    drawState.meName = game.names.get(game.myId) || me.userName || '';
    drawState.mePos = game.me ? mePos : null;
    drawState.aimAngle = aimAngle;
    drawState.myTeam = game.myTeam;
    drawState.towerHp = game.towerHp;
    drawState.towers = game.towerState;
    drawState.runes = game.runes;
    drawState.myPower = game.meServer ? game.meServer.power : 0;
    drawState.myPowerFrac = drawState.myPower
      ? Math.max(0, Math.min(1, (game.myPowerUntil - performance.now()) / 7000)) : 0;
    drawState.others = game.remoteStates(renderMs, dt || 1 / 60);
    // Resolve every shell against exactly the tanks being drawn this frame, then
    // hand the survivors to the renderer. Impact lands the instant it connects on
    // screen instead of a round trip later — outgoing and incoming alike.
    game.resolveHits(drawState.others, renderMs);
    drawState.bullets = game.renderShells();
    drawState.effects = game.effects;
    drawState.joy = input.joy;
    drawState.joyMax = input.joyMax;
    drawState.dt = dt || 1 / 60;
    drawState.lastFireAt = game.lastFireAt;
    drawState.reload = game.reloadFraction();
    drawState.ammo = game.ammo;
    drawState.reloading = game.reloading();
    drawState.showAim = input.hasAim;
    renderer.draw(drawState);

    // The HUD does not need 60 Hz. It was rebuilding the scoreboard string, sorting
    // an array and writing style.display every single frame.
    if (now - hudAt > 100) { hudAt = now; updateHud(); }
  }
  requestAnimationFrame(loop);

  setInterval(() => {
    const el = $('pingv');
    // ping · adaptive interp buffer (how far in the past remotes render)
    if (el && net) el.textContent = `${net.rtt} ms · ${Math.round(net.interpDelayMs())}`;
  }, 500);
}

// Turn the game's feedback queue into sound, haptics and the damage vignette.
let hurtUntil = 0;
function drainFeedback() {
  const q = game.events;
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    const pan = e.x !== undefined ? Math.max(-1, Math.min(1, (e.x - 360) / 360)) : 0;
    sfx.play(e.kind, pan, e.key);
    if (hapticsOn) haptic(e.kind);
    if (e.kind === 'hurt') hurtUntil = performance.now() + 260;
  }
  q.length = 0;

  const hurtEl = EL.hurt;
  if (hurtEl) {
    const on = performance.now() < hurtUntil;
    if (hurtEl.__on !== on) { hurtEl.__on = on; hurtEl.classList.toggle('on', on); }
  }
}

// Post-match scorecard + XP. Awarded exactly once per match, when the result
// screen first appears — updateHud runs on a timer, so this must be idempotent.
function drainAward() {
  const a = game.pendingAward;
  if (!a) return null;
  game.pendingAward = null;
  return awardMatch(a);
}

function showScorecard() {
  const a = game.pendingAward;
  const res = drainAward();
  if (!res) return;                     // already awarded (e.g. while backgrounded)
  EL.stKills.textContent = a.kills;
  EL.stDeaths.textContent = a.deaths;
  EL.stTower.textContent = a.towerDamage;
  EL.xpLevel.textContent = res.levelledUp ? `LEVEL UP — LV ${res.level}` : `LV ${res.level}`;
  EL.xpGain.textContent = `+${res.gained} XP`;
  // Kill the transition for one frame, otherwise the bar animates from the
  // PREVIOUS match's fill: setting 0% only starts a 0.9s transition toward 0.
  EL.xpFill.style.transition = 'none';
  EL.xpFill.style.width = '0%';
  void EL.xpFill.offsetWidth;
  EL.xpFill.style.transition = '';
  EL.xpFill.style.width = `${Math.round((res.intoLevel / res.levelSpan) * 100)}%`;
  if (res.levelledUp) sfx.play('win');
  if (!res.saved) toast('Progress can only be saved outside private browsing', 3000);
  game.matchDeaths = 0;
  game.matchTowerDamage = 0;
}

function updateHud() {
  // No team header. Tower integrity is the win condition and each tower already
  // wears its own health bar on the field, where the fight actually is — a
  // duplicate percentage in the corner was one more thing to read and the
  // slowest way to learn it.

  // kill feed (4 s per row)
  const now = performance.now();
  while (game.feed.length && now - game.feed[0].at > 4000) game.feed.shift();
  const feedHtml = game.feed.map((f) =>
    `<div><span style="color:${teamColor(f.killerTeam)}">${esc(f.killer)}</span>`
    + ` <span style="color:#8b9dc0">▸</span> `
    + `<span style="color:${teamColor(f.victimTeam)}">${esc(f.victim)}</span></div>`).join('');
  if (EL.feed.__last !== feedHtml) { EL.feed.innerHTML = feedHtml; EL.feed.__last = feedHtml; }

  const banner = now - game.killBannerAt < 500;
  if (EL.killbanner.__on !== banner) {
    EL.killbanner.__on = banner;
    if (banner) EL.killbanner.textContent = `ELIMINATED ${game.killBannerName}`.trim();
    EL.killbanner.classList.toggle('on', banner);
  }

  // Match result overlay. Toggling a CSS class (not style.display) so it can
  // actually animate — `display` is not transitionable, so every overlay used to
  // appear as a hard cut.
  const over = game.phase === 'over' && game.winner >= 0;
  if (EL.match.__on !== over) {
    EL.match.__on = over;
    EL.match.classList.toggle('on', over);
    if (over) {
      EL.matchWho.textContent = game.winner === game.myTeam ? 'VICTORY' : 'DEFEAT';
      EL.matchWho.style.color = teamColor(game.winner);
      EL.matchTally.textContent = `${TEAM_NAMES[0]} ${game.wins[0]} — ${game.wins[1]} ${TEAM_NAMES[1]}`;
      showScorecard();
    }
  }
  if (over) {
    const left = Math.max(0, MATCH_RESET_DELAY - (performance.now() - game.matchOverAt) / 1000);
    const sub = `${TEAM_NAMES[game.winner]} destroyed the tower · next match in ${left.toFixed(0)}s`;
    if (EL.matchSub.__last !== sub) { EL.matchSub.__last = sub; EL.matchSub.textContent = sub; }
  }

  // respawn overlay (suppressed while the result screen is up)
  const dead = !over && game.meServer && !game.meServer.alive;
  if (EL.respawn.__on !== dead) {
    EL.respawn.__on = dead;
    EL.respawn.classList.toggle('on', dead);
  }
  if (dead) {
    const s = Math.max(0, (game.respawnCountdown - performance.now()) / 1000);
    const txt = (game.killedBy ? `killed by ${game.killedBy} · ` : '')
      + (s > 0 ? `respawning in ${s.toFixed(1)}s` : 'respawning…');
    if (EL.respawnIn.__last !== txt) { EL.respawnIn.__last = txt; EL.respawnIn.textContent = txt; }
  }
}

// ------------------------------------------------------------------- lobby --
// The waiting room for an INVITE match. It never creates or switches rooms and
// draws no share sheet of its own — the "+ Invite friends" button opens the
// PLATFORM's picker (Usion.game.invite), which owns invites.
let lobbyHostId = 0;

function showLobby(on) {
  EL.lobby.classList.toggle('on', on);
  if (!on) return;
  EL.lobbyStart.disabled = !game || game.myId !== lobbyHostId;
  EL.lobbyHint.textContent = (game && game.myId === lobbyHostId)
    ? 'Start when your friends are in. Empty seats fill with bots.'
    : 'Waiting for the host to start…';
}

function renderLobby(m) {
  lobbyHostId = m.hostId || 0;
  const rows = (m.players || []).map((p) => {
    const you = game && p.id === game.myId;
    const host = p.id === m.hostId;
    return `<div class="row"><b style="color:${teamColor(p.team)}">${esc(p.name)}</b>`
      + `${you ? ' <span class="tag">YOU</span>' : ''}`
      + `<span class="tag">${host ? 'HOST' : (p.ready ? 'READY' : '')}</span></div>`;
  }).join('');
  if (EL.lobbyList.__last !== rows) { EL.lobbyList.innerHTML = rows; EL.lobbyList.__last = rows; }
  EL.lobbyTitle.textContent = (m.players || []).length > 1
    ? `READY UP (${m.players.length}/4)` : 'WAITING FOR FRIENDS';
  showLobby(m.phase === 'lobby');
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
  $('status').innerHTML = '<span>practice</span>';

  const spawn = randomTowerSpawn(0);
  const tank = makeTank(1, spawn.x, spawn.y, 0);
  const bullets = [];
  const effects = [];
  let nextFireAt = -10;
  let lastSoloFire = -1e9;
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
    if (acc > DT * 6) acc = DT * 6;   // clamp, don't discard real time
    while (acc >= DT) {
      acc -= DT;
      stepTank(tank, { moveX: input.moveX, moveY: input.moveY }, DT);
      tank.turret = aim;
      const t = now / 1000;
      if (input.firing && t >= nextFireAt) {
        nextFireAt = t + FIRE_COOLDOWN;
        lastSoloFire = performance.now();
        const bx = tank.x + Math.cos(aim) * MUZZLE_OFFSET;
        const by = tank.y + Math.sin(aim) * MUZZLE_OFFSET;
        bullets.push({ x: bx, y: by, vx: Math.cos(aim) * BULLET_SPEED, vy: Math.sin(aim) * BULLET_SPEED, age: 0, bounces: 0 });
        effects.push({ kind: 'muzzle', x: bx, y: by, a: aim, born: performance.now(), dur: 90 });
        renderer.addShake(2.5);
        sfx.play('fire', (bx - 360) / 360);
        haptic('fire');
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
      bullets: bullets.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, mine: true })),
      effects,
      joy: input.joy,
      joyMax: input.joyMax,
      showAim: input.hasAim,
      ammo: MAG_SIZE,
      reloading: false,
      dt: dt || 1 / 60,
      lastFireAt: lastSoloFire,
      reload: Math.min(1, (now / 1000 - (nextFireAt - FIRE_COOLDOWN)) / FIRE_COOLDOWN),
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
