// Canvas renderer: procedural vector art (no image assets), DPR-aware.
// The camera is FIXED at the arena centre and zoomed to fit the whole map on
// one screen — nothing scrolls, only the tanks move. World-space drawing only —
// HUD lives in the DOM (index.html).

import {
  ARENA_W, ARENA_H, TANK_RADIUS, BULLET_RADIUS, MAX_HP,
  TOWER_RADIUS, TOWER_HP, TOWER_RANGE,
} from '../shared/protocol.js';
import { OBSTACLES, TOWERS } from '../shared/sim.js';

// Identity is by TEAM, not by player — in a 2v2 objective match you need to read
// friend-vs-foe at a glance far more than you need to tell teammates apart.
const TEAM_COLORS = ['#4fc3f7', '#ff7a5e'];
export const teamColor = (team) => TEAM_COLORS[team & 1];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: ARENA_W / 2, y: ARENA_H / 2, zoom: 1 };
    this.vw = 0; this.vh = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
    this.canvas.width = Math.round(this.vw * dpr);
    this.canvas.height = Math.round(this.vh * dpr);
    this.canvas.style.width = this.vw + 'px';
    this.canvas.style.height = this.vh + 'px';
    this.dpr = dpr;
    // Fit the ENTIRE arena on screen: the camera is fixed at the arena center
    // and never follows, so the whole map is one static screen and only the
    // tanks move. Letterboxing on aspect mismatch is intentional.
    this.cam.zoom = Math.min(this.vw / ARENA_W, this.vh / ARENA_H);
    this.cam.x = ARENA_W / 2;
    this.cam.y = ARENA_H / 2;
  }

  screenToWorld(sx, sy) {
    return {
      x: this.cam.x + (sx - this.vw / 2) / this.cam.zoom,
      y: this.cam.y + (sy - this.vh / 2) / this.cam.zoom,
    };
  }

  // state: {me, mePos, others, bullets:[{x,y,vx,vy}], effects, aimAngle}
  draw(state) {
    const { ctx, cam } = this;
    const now = performance.now();

    // No camera follow and no clamping: cam stays pinned to the arena center by
    // resize(), so the map is motionless and only the tanks move across it.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, this.vw, this.vh);
    ctx.translate(this.vw / 2, this.vh / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // arena floor + grid
    ctx.fillStyle = '#12161f';
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    ctx.strokeStyle = 'rgba(120,160,220,0.07)';
    ctx.lineWidth = 1 / cam.zoom;
    ctx.beginPath();
    for (let x = 0; x <= ARENA_W; x += 80) { ctx.moveTo(x, 0); ctx.lineTo(x, ARENA_H); }
    for (let y = 0; y <= ARENA_H; y += 80) { ctx.moveTo(0, y); ctx.lineTo(ARENA_W, y); }
    ctx.stroke();

    // border
    ctx.strokeStyle = '#2e4a6b';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, ARENA_W, ARENA_H);

    // obstacles
    for (const r of OBSTACLES) {
      ctx.fillStyle = '#1d2635';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#3b5273';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(90,130,190,0.10)';
      ctx.fillRect(r.x, r.y, r.w, 6);
    }

    // towers (the objective) sit under everything that moves
    const towerHp = state.towerHp || [TOWER_HP, TOWER_HP];
    for (let i = 0; i < TOWERS.length; i++) this._tower(TOWERS[i], towerHp[i] ?? 0, state.myTeam);

    // spawn/hit/explosion effects under tanks
    for (const e of state.effects) this._effect(e, now);

    // remote tanks
    for (const t of state.others) {
      if (!t.alive) continue;
      this._tank(t.x, t.y, t.hull, t.turret, teamColor(t.team), t.name, t.hp, false);
    }
    // my tank
    if (state.me && state.me.alive !== false && state.mePos) {
      this._tank(state.mePos.x, state.mePos.y, state.mePos.hull, state.aimAngle, teamColor(state.myTeam), state.meName, state.me.hp ?? MAX_HP, true);
    }

    // bullets (small glow + motion streak)
    for (const b of state.bullets) {
      const tx = b.x - b.vx * 0.03, ty = b.y - b.vy * 0.03;
      ctx.strokeStyle = 'rgba(255,230,150,0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = '#ffe796';
      // never let a shell shrink below ~4 screen px at the fit-to-arena zoom
      ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(BULLET_RADIUS, 4 / cam.zoom), 0, Math.PI * 2); ctx.fill();
    }
  }

  // The match objective. Enemy towers show their engagement radius so you can
  // see the line you're about to cross; a destroyed tower is left as rubble.
  _tower(tw, hp, myTeam) {
    const { ctx } = this;
    const R = TOWER_RADIUS;
    const color = teamColor(tw.team);
    const dead = hp <= 0;
    const f = clamp(hp / TOWER_HP, 0, 1);

    ctx.save();
    ctx.translate(tw.x, tw.y);

    if (!dead && tw.team !== myTeam) {
      ctx.strokeStyle = rgba(color, 0.15);
      ctx.lineWidth = 1.5 / this.cam.zoom;
      ctx.setLineDash([7, 9]);
      ctx.beginPath(); ctx.arc(0, 0, TOWER_RANGE, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }

    octagon(ctx, R);
    ctx.fillStyle = dead ? '#171b24' : shade(color, -0.62);
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
    ctx.fillStyle = shade(color, -0.3);
    ctx.fill();
    ctx.strokeStyle = shade(color, 0.15);
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
    ctx.fillStyle = f > 0.5 ? color : f > 0.22 ? '#ffcf5e' : '#ff6b5e';
    ctx.fillRect(-w / 2, top - h, w * f, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-w / 2, top - h, w, h);
    ctx.restore();

    ctx.restore();
  }

  _tank(x, y, hull, turret, color, name, hp, isMe) {
    const { ctx } = this;
    const R = TANK_RADIUS;
    ctx.save();
    ctx.translate(x, y);

    ctx.save();
    ctx.rotate(hull);
    // treads
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(-R, -R, R * 2, 9);
    ctx.fillRect(-R, R - 9, R * 2, 9);
    // hull
    ctx.fillStyle = shade(color, -0.35);
    roundRect(ctx, -R + 2, -R + 8, R * 2 - 4, R * 2 - 16, 6);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    roundRect(ctx, -R + 2, -R + 8, R * 2 - 4, R * 2 - 16, 6);
    ctx.stroke();
    ctx.restore();

    // turret + barrel
    ctx.save();
    ctx.rotate(turret);
    ctx.fillStyle = shade(color, -0.15);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fillRect(10, -4.5, 30, 9);
    ctx.strokeRect(10, -4.5, 30, 9);
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();

    if (isMe) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.arc(0, 0, R + 7, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
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
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (f) => 1 - (1 - f) * (1 - f);
