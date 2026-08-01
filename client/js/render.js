// Canvas renderer: procedural vector art (no image assets), DPR-aware.
// The camera is FIXED at the arena centre and zoomed to fit the whole map on
// one screen — nothing scrolls, only the tanks move. World-space drawing only —
// HUD lives in the DOM (index.html).

import {
  ARENA_W, ARENA_H, TANK_RADIUS, BULLET_RADIUS, MAX_HP,
  TOWER_RADIUS, TOWER_HP, TOWER_RANGE, MAG_SIZE,
} from '../shared/protocol.js';
import { OBSTACLES, TOWERS } from '../shared/sim.js';

// Identity is by TEAM, not by player — in a 2v2 objective match you need to read
// friend-vs-foe at a glance far more than you need to tell teammates apart.
const TEAM_COLORS = ['#4fc3f7', '#ff7a5e'];
export const teamColor = (team) => TEAM_COLORS[team & 1];

// Every fillStyle/strokeStyle assignment re-parses the CSS colour string, and
// shade()/rgba() were rebuilding those strings ~14 times a frame. There are
// exactly two teams — precompute the whole palette once at module load.
// Respect the OS reduced-motion setting; overridable from the settings sheet.
let shakeScale = 1;
try {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) shakeScale = 0;
  const stored = localStorage.getItem('tank.shake');
  if (stored !== null) shakeScale = Number(stored);
} catch { /* private mode */ }
export function setShakeScale(v) {
  shakeScale = v;
  try { localStorage.setItem('tank.shake', String(v)); } catch { /* ignore */ }
}
export function getShakeScale() { return shakeScale; }

const PALETTE = TEAM_COLORS.map((c) => ({
  base: c,
  hull: shade(c, -0.35),
  turret: shade(c, -0.15),
  towerFill: shade(c, -0.62),
  towerCore: shade(c, -0.3),
  towerRim: shade(c, 0.15),
  range: rgba(c, 0.15),
}));

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // alpha:false drops the unused RGBA backing store and its per-composite blend
    // (the first thing draw() does is an opaque full-canvas fill). desynchronized
    // can shave up to a frame of input-to-photon latency in a WebView.
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.cam = { x: ARENA_W / 2, y: ARENA_H / 2, zoom: 1 };
    this.vw = 0; this.vh = 0;
    this.shakeMag = 0;
    this.shakeAng = 0;
    this.bg = null;          // prerendered static arena
    this.rings = new Map();  // team -> prerendered dashed range ring
    this.resize();
    // iOS fires resize ~10x while the URL bar animates; each one would otherwise
    // reallocate a ~5 MB backing store and re-render the whole static layer.
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => this.resize(), 90);
    });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.round(vw * dpr);
    const h = Math.round(vh * dpr);
    if (w === this.canvas.width && h === this.canvas.height && this.bg) return;
    this.vw = vw;
    this.vh = vh;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = this.vw + 'px';
    this.canvas.style.height = this.vh + 'px';
    this.dpr = dpr;
    // Fit the ENTIRE arena on screen: the camera is fixed at the arena center
    // and never follows, so the whole map is one static screen and only the
    // tanks move. Letterboxing on aspect mismatch is intentional.
    this.cam.zoom = Math.min(this.vw / ARENA_W, this.vh / ARENA_H);
    this.cam.x = ARENA_W / 2;
    this.cam.y = ARENA_H / 2;
    this._buildStatic();
  }

  // Floor, grid, border and all 10 obstacles never change. Rasterise them once
  // into an offscreen layer and blit it — this replaced ~75 draw ops and ~50
  // colour-string assignments per frame, which was 3-5 ms on an iPhone 12.
  _buildStatic() {
    const w = this.canvas.width, h = this.canvas.height;
    if (!w || !h) return;
    const c = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = c.getContext('2d');
    const { zoom, x: cx, y: cy } = this.cam;

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#0b0e14';
    g.fillRect(0, 0, this.vw, this.vh);
    g.translate(this.vw / 2, this.vh / 2);
    g.scale(zoom, zoom);
    g.translate(-cx, -cy);

    g.fillStyle = '#12161f';
    g.fillRect(0, 0, ARENA_W, ARENA_H);
    g.strokeStyle = 'rgba(120,160,220,0.07)';
    g.lineWidth = 1 / zoom;
    g.beginPath();
    for (let x = 0; x <= ARENA_W; x += 80) { g.moveTo(x, 0); g.lineTo(x, ARENA_H); }
    for (let y = 0; y <= ARENA_H; y += 80) { g.moveTo(0, y); g.lineTo(ARENA_W, y); }
    g.stroke();
    g.strokeStyle = '#2e4a6b';
    g.lineWidth = 6;
    g.strokeRect(0, 0, ARENA_W, ARENA_H);
    for (const r of OBSTACLES) {
      g.fillStyle = '#1d2635';
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = '#3b5273';
      g.lineWidth = 2.5;
      g.strokeRect(r.x, r.y, r.w, r.h);
      g.fillStyle = 'rgba(90,130,190,0.10)';
      g.fillRect(r.x, r.y, r.w, 6);
    }
    this.bg = c;

    // Dashed range rings are the single most expensive call in the renderer on
    // iOS — CoreGraphics flattens a 330px-radius dashed circle into ~130 stroked
    // subpaths every frame. Bake each team's ring once.
    this.rings.clear();
    const rp = Math.ceil((TOWER_RANGE + 4) * zoom * this.dpr);
    for (let team = 0; team < PALETTE.length; team++) {
      const rc = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(rp * 2, rp * 2)
        : Object.assign(document.createElement('canvas'), { width: rp * 2, height: rp * 2 });
      const rg = rc.getContext('2d');
      rg.setTransform(1, 0, 0, 1, rp, rp);
      rg.strokeStyle = PALETTE[team].range;
      rg.lineWidth = 1.5 * this.dpr;
      rg.setLineDash([7 * zoom * this.dpr, 9 * zoom * this.dpr]);
      rg.beginPath();
      rg.arc(0, 0, TOWER_RANGE * zoom * this.dpr, 0, Math.PI * 2);
      rg.stroke();
      this.rings.set(team, { canvas: rc, r: rp });
    }
  }

  // Impulse the camera. Directional when an angle is given (recoil), random otherwise.
  // Scaled by the player's motion preference — 20px of rotating translation is a
  // real vestibular trigger and a routine accessibility complaint.
  addShake(mag, ang) {
    const m = mag * shakeScale;
    if (m <= this.shakeMag) return;
    this.shakeMag = m;
    this.shakeAng = ang === undefined ? Math.random() * Math.PI * 2 : ang;
  }

  screenToWorld(sx, sy) {
    return {
      x: this.cam.x + (sx - this.vw / 2) / this.cam.zoom,
      y: this.cam.y + (sy - this.vh / 2) / this.cam.zoom,
    };
  }

  // state: {me, mePos, others, bullets:[{x,y,vx,vy}], effects, aimAngle, joy, dt}
  draw(state) {
    const { ctx, cam } = this;
    const now = performance.now();
    const dt = state.dt || 1 / 60;

    // Screen shake, decayed on wall clock so it feels identical at 60 and 120 Hz.
    let sx = 0, sy = 0;
    if (this.shakeMag > 0.05) {
      sx = Math.cos(this.shakeAng) * this.shakeMag;
      sy = Math.sin(this.shakeAng) * this.shakeMag;
      this.shakeMag *= Math.exp(-dt / 0.075);
      this.shakeAng += 18 * dt;   // rotate so it reads as a rattle, not a slide
    } else this.shakeMag = 0;

    // No camera follow and no clamping: cam stays pinned to the arena center by
    // resize(), so the map is motionless and only the tanks move across it.
    // The static layer is stored at DEVICE resolution, so blit it under identity
    // transform. Clear first: a shaken blit leaves a few px uncovered at the edge.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.bg) ctx.drawImage(this.bg, sx * this.dpr, sy * this.dpr);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.vw / 2 + sx, this.vh / 2 + sy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // Enemy tower threat rings, blitted from the prerendered layer (drawn in
    // screen space under the world pass so the dash pattern never re-flattens).
    const towerHp = state.towerHp || [TOWER_HP, TOWER_HP];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < TOWERS.length; i++) {
      const tw = TOWERS[i];
      if (tw.team === state.myTeam || (towerHp[i] ?? 0) <= 0) continue;
      const ring = this.rings.get(tw.team & 1);
      if (!ring) continue;
      const px = ((tw.x - cam.x) * cam.zoom + this.vw / 2 + sx) * this.dpr;
      const py = ((tw.y - cam.y) * cam.zoom + this.vh / 2 + sy) * this.dpr;
      ctx.drawImage(ring.canvas, px - ring.r, py - ring.r);
    }
    ctx.restore();

    // towers (the objective) sit under everything that moves
    for (let i = 0; i < TOWERS.length; i++) this._tower(TOWERS[i], towerHp[i] ?? 0, state.myTeam);

    // spawn/hit/explosion effects under tanks
    for (const e of state.effects) this._effect(e, now);

    // remote tanks
    for (const t of state.others) {
      if (!t.alive) continue;
      this._tank(t.x, t.y, t.hull, t.turret, t.team, t.name, t.hp, false);
    }
    // Aim ray. Direct-touch aiming means a ~45px fingertip sits on top of a 31px
    // enemy sprite — you cannot see the thing you are shooting at. The ray shows
    // the line of fire clear of the thumb without changing the control scheme.
    if (state.me && state.me.alive !== false && state.mePos && state.showAim) {
      const a = state.aimAngle;
      const ox = state.mePos.x + Math.cos(a) * (TANK_RADIUS + 10);
      const oy = state.mePos.y + Math.sin(a) * (TANK_RADIUS + 10);
      const grad = ctx.createLinearGradient(ox, oy, ox + Math.cos(a) * 260, oy + Math.sin(a) * 260);
      grad.addColorStop(0, 'rgba(255,255,255,0.30)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2 / cam.zoom;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + Math.cos(a) * 260, oy + Math.sin(a) * 260);
      ctx.stroke();
    }

    // my tank — with barrel recoil and the reload arc
    if (state.me && state.me.alive !== false && state.mePos) {
      const sinceFire = now - (state.lastFireAt ?? -1e9);
      const recoil = sinceFire < 120 ? 7 * (1 - sinceFire / 120) : 0;
      this._tank(
        state.mePos.x, state.mePos.y, state.mePos.hull, state.aimAngle,
        state.myTeam, state.meName, state.me.hp ?? MAX_HP, true, recoil, state.reload ?? 1,
        state.ammo ?? MAG_SIZE, !!state.reloading,
      );
    }

    // Shells. At fit-to-arena zoom a shell was a 4px dot moving 218 screen px/s —
    // you could not see the thing that killed you. Bigger core, longer streak, and
    // incoming fire is tinted differently from your own so the read is instant.
    const shellR = Math.max(BULLET_RADIUS, 6 / cam.zoom);
    for (const b of state.bullets) {
      const mine = b.mine;
      const tx = b.x - b.vx * 0.045, ty = b.y - b.vy * 0.045;
      ctx.strokeStyle = mine ? 'rgba(255,230,150,0.45)' : 'rgba(255,150,110,0.45)';
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = mine ? '#ffe796' : '#ff9d6e';
      ctx.beginPath(); ctx.arc(b.x, b.y, shellR, 0, Math.PI * 2); ctx.fill();
    }

    // ---- screen-space overlay pass ----
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (state.joy) this._joystick(state.joy, state.joyMax || 78);
  }

  // The joystick had NO visual representation at all — the entire fallback control
  // scheme was an invisible surface with no affordance and no deflection feedback.
  _joystick(joy, max) {
    const { ctx } = this;
    const dx = clamp(joy.dx, -max, max);
    const dy = clamp(joy.dy, -max, max);
    const d = Math.hypot(dx, dy);
    const s = d > max ? max / d : 1;
    ctx.save();
    ctx.translate(joy.cx, joy.cy);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, max, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.beginPath(); ctx.arc(dx * s, dy * s, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(dx * s, dy * s, 26, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // The match objective. Enemy towers show their engagement radius so you can
  // see the line you're about to cross; a destroyed tower is left as rubble.
  _tower(tw, hp, myTeam) {
    const { ctx } = this;
    const R = TOWER_RADIUS;
    const pal = PALETTE[tw.team & 1];
    const color = pal.base;
    const dead = hp <= 0;
    const f = clamp(hp / TOWER_HP, 0, 1);

    ctx.save();
    ctx.translate(tw.x, tw.y);

    octagon(ctx, R);
    ctx.fillStyle = dead ? '#171b24' : pal.towerFill;
    ctx.fill();
    ctx.strokeStyle = dead ? '#2a3242' : color;
    ctx.lineWidth = 3;
    ctx.stroke();

    if (dead) {
      ctx.strokeStyle = '#2a3242';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-R * 0.5, -R * 0.3); ctx.lineTo(-R * 0.1, R * 0.35); ctx.lineTo(R * 0.45, -R * 0.15);
      ctx.moveTo(-R * 0.2, -R * 0.55); ctx.lineTo(R * 0.2, R * 0.5);
      ctx.stroke();
      ctx.restore();
      return;
    }

    octagon(ctx, R * 0.55);
    ctx.fillStyle = pal.towerCore;
    ctx.fill();
    ctx.strokeStyle = pal.towerRim;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.2, 0, Math.PI * 2); ctx.fill();

    // HP bar at constant screen size (same reasoning as the tank labels)
    const k = 1 / this.cam.zoom;
    ctx.save();
    ctx.scale(k, k);
    const top = -(R + 6) / k;
    const w = 54, h = 6;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(-w / 2, top - h, w, h);
    // Never draw a tower's health in its own team colour: RED's full-health bar
    // (#ff7a5e) was 6 ΔRGB from the critical warning (#ff6b5e), so a tower at 100%
    // and one at 10% looked identical — to trichromats, never mind deuteranopes.
    // A luminance-separated ramp plus quarter notches encodes health redundantly.
    ctx.fillStyle = f > 0.5 ? '#8ef5c0' : f > 0.25 ? '#ffd166' : '#ff4d4d';
    ctx.fillRect(-w / 2, top - h, w * f, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    for (let q = 1; q < 4; q++) {
      const qx = -w / 2 + (w * q) / 4;
      ctx.beginPath(); ctx.moveTo(qx, top - h); ctx.lineTo(qx, top); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.strokeRect(-w / 2, top - h, w, h);
    ctx.restore();

    ctx.restore();
  }

  _tank(x, y, hull, turret, teamIdx, name, hp, isMe, recoil = 0, reload = 1, ammo = MAG_SIZE, isReloading = false) {
    const { ctx } = this;
    const R = TANK_RADIUS;
    const color = PALETTE[teamIdx & 1].base;
    ctx.save();
    ctx.translate(x, y);

    const pal = PALETTE[teamIdx & 1];
    ctx.save();
    ctx.rotate(hull);
    // treads
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(-R, -R, R * 2, 9);
    ctx.fillRect(-R, R - 9, R * 2, 9);
    // hull — build the rounded path once, then fill AND stroke it
    ctx.fillStyle = pal.hull;
    roundRect(ctx, -R + 2, -R + 8, R * 2 - 4, R * 2 - 16, 6);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // turret + barrel, with a recoil kick that eases back over 120 ms
    ctx.save();
    ctx.rotate(turret);
    ctx.fillStyle = pal.turret;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fillRect(10 - recoil, -4.5, 30, 9);
    ctx.strokeRect(10 - recoil, -4.5, 30, 9);
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();

    if (isMe) {
      // Reload arc doubles as the "this is you" marker. The dashed ring it replaced
      // cost a full dash-flatten every frame on iOS and told the player nothing —
      // meanwhile 330 ms of cooldown was silently swallowing shots, which is
      // indistinguishable from lag.
      ctx.strokeStyle = 'rgba(255,255,255,0.20)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, R + 8, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = isReloading ? 'rgba(255,190,90,0.95)'
        : reload >= 1 ? 'rgba(255,255,255,0.95)' : 'rgba(139,233,253,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, R + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(reload, 0, 1));
      ctx.stroke();

      // Ammo pips around the ring — you need to know how many rounds are left
      // without doing arithmetic on an arc.
      const pipR = R + 15;
      for (let i = 0; i < MAG_SIZE; i++) {
        const a = -Math.PI / 2 + (i / MAG_SIZE) * Math.PI * 2;
        ctx.fillStyle = i < ammo ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.arc(Math.cos(a) * pipR, Math.sin(a) * pipR, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // name + hp — drawn at constant SCREEN size. The fit-to-arena zoom is ~0.54
    // on a phone, which would render a 13px world label at 7px and make it
    // unreadable; undoing the camera scale keeps labels crisp at any zoom.
    const k = 1 / this.cam.zoom;
    ctx.save();
    ctx.scale(k, k);
    const top = -(R + 4) / k;          // tank's top edge, expressed in screen-space units
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(255,255,255,0.75)';
    ctx.fillText(name || '', 0, top - 10);
    const w = 40, h = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(-w / 2, top - 7, w, h);
    ctx.fillStyle = hp > 55 ? '#7ed37e' : hp > 25 ? '#ffcf5e' : '#ff6b5e';
    ctx.fillRect(-w / 2, top - 7, w * (hp / MAX_HP), h);
    ctx.restore();

    ctx.restore();
  }

  _effect(e, now) {
    const { ctx } = this;
    const f = clamp((now - e.born) / e.dur, 0, 1);
    ctx.save();
    if (e.kind === 'muzzle') {
      ctx.translate(e.x, e.y);
      ctx.rotate(e.a);
      ctx.fillStyle = `rgba(255,220,130,${0.9 * (1 - f)})`;
      ctx.beginPath();
      ctx.moveTo(0, -5); ctx.lineTo(20 * (1 - f * 0.4), 0); ctx.lineTo(0, 5);
      ctx.closePath(); ctx.fill();
    } else if (e.kind === 'hit' || e.kind === 'explosion') {
      const R = (e.kind === 'explosion' ? 60 : 26) * ease(f);
      ctx.globalAlpha = 1 - f;
      ctx.fillStyle = '#ff9d5c';
      ctx.beginPath(); ctx.arc(e.x, e.y, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff1c9';
      ctx.beginPath(); ctx.arc(e.x, e.y, R * 0.55, 0, Math.PI * 2); ctx.fill();
    } else if (e.kind === 'poof') {
      ctx.globalAlpha = 0.6 * (1 - f);
      ctx.fillStyle = '#9fb4d0';
      ctx.beginPath(); ctx.arc(e.x, e.y, 6 + 10 * f, 0, Math.PI * 2); ctx.fill();
    } else if (e.kind === 'spawn') {
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = '#8be9fd';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, 20 + 40 * f, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function octagon(ctx, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => clamp(Math.round(v * (1 + amt)), 0, 255);
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
// Function declarations, not const arrows: PALETTE is built at module-evaluation
// time and calls shade() -> clamp(), so an arrow declared down here would still be
// in its temporal dead zone and throw before the game ever boots.
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function ease(f) { return 1 - (1 - f) * (1 - f); }
