// Canvas renderer: procedural vector art (no image assets), DPR-aware.
// The camera is FIXED at the arena centre and zoomed to fit the whole map on
// one screen — nothing scrolls, only the tanks move. World-space drawing only —
// HUD lives in the DOM (index.html).

import { ARENA_W, ARENA_H, TANK_RADIUS, BULLET_RADIUS, MAX_HP } from '../shared/protocol.js';
import { OBSTACLES } from '../shared/sim.js';

const COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ba68c8', '#ffd54f', '#f06292', '#4dd0e1', '#a1887f'];
export const colorFor = (id) => COLORS[(id - 1) % COLORS.length];

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

    // spawn/hit/explosion effects under tanks
    for (const e of state.effects) this._effect(e, now);

    // remote tanks
    for (const t of state.others) {
      if (!t.alive) continue;
      this._tank(t.x, t.y, t.hull, t.turret, colorFor(t.id), t.name, t.hp, false);
    }
    // my tank
    if (state.me && state.me.alive !== false && state.mePos) {
      this._tank(state.mePos.x, state.mePos.y, state.mePos.hull, state.aimAngle, colorFor(state.meId), state.meName, state.me.hp ?? MAX_HP, true);
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
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => clamp(Math.round(v * (1 + amt)), 0, 255);
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (f) => 1 - (1 - f) * (1 - f);
