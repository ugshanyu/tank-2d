// Canvas renderer: procedural vector art (no image assets), DPR-aware.
// The camera is FIXED at the arena centre and zoomed to fit the whole map on
// one screen — nothing scrolls, only the tanks move. World-space drawing only —
// HUD lives in the DOM (index.html).

import {
  ARENA_W, ARENA_H, TANK_RADIUS, BULLET_RADIUS, MAX_HP,
  TOWER_RADIUS, TOWER_HP, MAG_SIZE, BULLET_DAMAGE, POWER_COLORS,
} from '../shared/protocol.js';
import { OBSTACLES, TOWERS } from '../shared/sim.js';

// Identity is by TEAM, not by player — in a 2v2 objective match you need to read
// friend-vs-foe at a glance far more than you need to tell teammates apart.
// Darkening the surround buys contrast against the arena for free.
const SURROUND = '#04060f';
const EMPTY_TOWER_STATE = [];
// The listing icon's blue and red — saturated, glossy — rather than the old
// pastel cyan/salmon. Team colour is the single most-read signal in the game.
const TEAM_COLORS = ['#3d8bff', '#ff4d4d'];
export const teamColor = (team) => TEAM_COLORS[team & 1];

// Art. The sprites were generated from the listing icon (glossy bevelled
// blue-vs-red tanks on a neon tile floor) with the icon itself as the style
// reference, then keyed, cropped and shrunk to what a phone can show
// (arena zoom ~0.54 x DPR 3). Every draw keeps its procedural fallback: a
// sprite that fails to load never blanks the arena, that one element just
// reverts to vector art. Sizes are WORLD px; the collision radii are unchanged.
const ASSET_DIR = 'assets/';
const SPRITE_FILES = {
  hull: ['hull_blue.webp', 'hull_red.webp'],
  turret: ['turret_blue.webp', 'turret_red.webp'],
  tower: ['tower_blue.webp', 'tower_red.webp'],
  tile: ['tile_blue.webp', 'tile_red.webp'],
  crate: 'crate.webp',
};
const HULL_W = 58;                    // treads span; TANK_RADIUS is 26
// Turret pivot = centre of the octagonal body in image px (measured when the
// sprites were cut); the barrel runs +x. Scale puts the body at ~28 world px,
// which lands the muzzle a few px past MUZZLE_OFFSET so shells leave the tip.
const TURRET_PIVOT = [{ x: 35.2, y: 36.5 }, { x: 33.1, y: 33.4 }];
const TURRET_SCALE = [0.403, 0.426];
const TOWER_W = 92;                   // TOWER_RADIUS 44 → octagon 88 + rim
const CRATE_W = 46;                   // RUNE_RADIUS 22
const TILE_WORLD = 160;               // one tile image = 2x2 tiles of the 80px grid

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
    this._initParticles();
    // Hull gradients live in the tank's LOCAL space, so they are identical for
    // every tank of a team — building one per tank per frame was 240 gradient
    // objects a second for no visual difference.
    this._hullGrad = PALETTE.map((pal) => {
      const g = this.ctx.createLinearGradient(0, -TANK_RADIUS, 0, TANK_RADIUS);
      g.addColorStop(0, shade(pal.base, -0.10));
      g.addColorStop(1, shade(pal.base, -0.55));
      return g;
    });
    // Aim ray in a canonical space: built once, positioned by transform.
    this._aimGrad = this.ctx.createLinearGradient(0, 0, 260, 0);
    this._aimGrad.addColorStop(0, 'rgba(255,255,255,0.42)');
    this._aimGrad.addColorStop(1, 'rgba(255,255,255,0)');
    this.sprites = { hull: [null, null], turret: [null, null], tower: [null, null],
                     towerDead: [null, null], tile: [null, null], tilePat: [null, null], crate: null };
    this._loadSprites();
    this.resize();
    // iOS fires resize ~10x while the URL bar animates; each one would otherwise
    // reallocate a ~5 MB backing store and re-render the whole static layer.
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => this.resize(), 90);
    });
  }

  _loadSprites() {
    const load = (file, cb) => {
      const im = new Image();
      im.onload = () => cb(im);
      im.onerror = () => { /* keep the vector fallback for this element */ };
      im.src = ASSET_DIR + file;
    };
    for (const t of [0, 1]) {
      load(SPRITE_FILES.hull[t], (im) => { this.sprites.hull[t] = im; });
      load(SPRITE_FILES.turret[t], (im) => { this.sprites.turret[t] = im; });
      load(SPRITE_FILES.tower[t], (im) => {
        this.sprites.tower[t] = im;
        this.sprites.towerDead[t] = deadVariant(im);
      });
      load(SPRITE_FILES.tile[t], (im) => {
        this.sprites.tile[t] = im;
        // The floor lives in the prerendered static layer — rebuild it once
        // the tile is here (the pattern itself is built per static context).
        this._buildStatic();
      });
    }
    load(SPRITE_FILES.crate, (im) => { this.sprites.crate = im; });
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
    g.fillStyle = SURROUND;
    g.fillRect(0, 0, this.vw, this.vh);
    g.translate(this.vw / 2, this.vh / 2);
    g.scale(zoom, zoom);
    g.translate(-cx, -cy);

    // The floor was a flat #12161f against a #0b0e14 surround — 1.07:1, which is
    // the same colour to the eye. The whole screen read as one dark field with no
    // discernible playfield. A lit centre falling off to dark walls gives the
    // arena a shape before a single sprite is drawn.
    const tiles = this.sprites.tile;
    if (tiles[0] && tiles[1]) {
      // The icon's floor: glossy bevelled tiles, BLUE on the bottom half (team 0)
      // and RED on the top, so territory reads from the ground itself. One image
      // is 2x2 tiles of the 80px grid, so the seams land exactly on the grid
      // lines and the halfway line (y=640) is a tile edge.
      const half = ARENA_H / 2;
      for (const t of [0, 1]) {
        const pat = g.createPattern(tiles[t], 'repeat');
        if (!pat) continue;
        const k = TILE_WORLD / tiles[t].width;
        pat.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
        g.fillStyle = pat;
        g.fillRect(0, t === 0 ? half : 0, ARENA_W, half);
      }
      // A lit centre falling off toward the walls, like the icon's key light —
      // and it keeps the middle (where the runes drop) the brightest spot.
      const lit = g.createRadialGradient(ARENA_W / 2, ARENA_H / 2, 60, ARENA_W / 2, ARENA_H / 2, 820);
      lit.addColorStop(0, 'rgba(255,255,255,0.10)');
      lit.addColorStop(0.5, 'rgba(255,255,255,0.03)');
      lit.addColorStop(1, 'rgba(0,0,0,0.18)');
      g.fillStyle = lit;
      g.fillRect(0, 0, ARENA_W, ARENA_H);
    } else {
      // Vector fallback (also what the first frames show while the tiles load).
      const floor = g.createRadialGradient(ARENA_W / 2, ARENA_H / 2, 0, ARENA_W / 2, ARENA_H / 2, 780);
      floor.addColorStop(0, '#1d2a52');
      floor.addColorStop(0.55, '#121b3a');
      floor.addColorStop(1, '#0a1026');
      g.fillStyle = floor;
      g.fillRect(0, 0, ARENA_W, ARENA_H);
      g.strokeStyle = 'rgba(90,150,255,0.10)';
      g.lineWidth = 1.5 / zoom;
      g.beginPath();
      for (let x = 0; x <= ARENA_W; x += 80) { g.moveTo(x, 0); g.lineTo(x, ARENA_H); }
      for (let y = 0; y <= ARENA_H; y += 80) { g.moveTo(0, y); g.lineTo(ARENA_W, y); }
      g.stroke();
    }

    // Halfway line — the arena is territorial and never said so.
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 2 / zoom;
    g.setLineDash([14, 10]);
    g.beginPath(); g.moveTo(0, ARENA_H / 2); g.lineTo(ARENA_W, ARENA_H / 2); g.stroke();
    g.setLineDash([]);

    // No circles around the towers at all — not the range ring, not the 190px
    // territory decal. Both read as "the tower's radius" and neither is
    // information the player acts on; the halfway line already says whose half
    // this is, and the tower itself is unmistakable.

    for (const r of OBSTACLES) {
      // Bevelled gunmetal blocks (like the icon's turret caps) with a neon edge
      // in the colour of the half they stand in; the centre block is neutral.
      const cy = r.y + r.h / 2;
      const edge = cy < ARENA_H / 2 - 30 ? 'rgba(255,90,90,0.75)'
        : cy > ARENA_H / 2 + 30 ? 'rgba(90,170,255,0.75)' : 'rgba(200,220,255,0.7)';
      // drop shadow — lifts the block off the floor
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(r.x + 3, r.y + 5, r.w, r.h);
      const og = g.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
      og.addColorStop(0, '#5a6478');
      og.addColorStop(0.5, '#3a4356');
      og.addColorStop(1, '#232a3a');
      g.fillStyle = og;
      g.fillRect(r.x, r.y, r.w, r.h);
      // bevel: light top/left, dark bottom/right
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(r.x, r.y, r.w, 3);
      g.fillRect(r.x, r.y, 3, r.h);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(r.x, r.y + r.h - 3, r.w, 3);
      g.fillRect(r.x + r.w - 3, r.y, 3, r.h);
      g.strokeStyle = edge;
      g.lineWidth = 2;
      g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }

    // Vignette: pulls the eye to the middle and darkens the walls.
    const vig = g.createRadialGradient(ARENA_W / 2, ARENA_H / 2, 420, ARENA_W / 2, ARENA_H / 2, 900);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vig;
    g.fillRect(0, 0, ARENA_W, ARENA_H);

    // Border in three passes, tinted per half so territory reads instantly.
    g.strokeStyle = 'rgba(79,195,247,0.10)';
    g.lineWidth = 22;
    g.strokeRect(0, 0, ARENA_W, ARENA_H);
    g.strokeStyle = '#2b63d9';
    g.lineWidth = 5;
    g.strokeRect(0, 0, ARENA_W, ARENA_H);
    g.strokeStyle = 'rgba(190,225,255,0.5)';
    g.lineWidth = 1.5;
    g.strokeRect(3, 3, ARENA_W - 6, ARENA_H - 6);
    for (const tw of TOWERS) {
      const pal = PALETTE[tw.team & 1];
      const y0 = tw.team === 1 ? 0 : ARENA_H - 380;
      const eg = g.createLinearGradient(0, tw.team === 1 ? 0 : ARENA_H, 0, tw.team === 1 ? 380 : ARENA_H - 380);
      eg.addColorStop(0, rgba(pal.base, 0.42));
      eg.addColorStop(1, rgba(pal.base, 0));
      g.strokeStyle = eg;
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(2.5, y0); g.lineTo(2.5, y0 + 380);
      g.moveTo(ARENA_W - 2.5, y0); g.lineTo(ARENA_W - 2.5, y0 + 380);
      g.stroke();
      g.beginPath();
      const edge = tw.team === 1 ? 2.5 : ARENA_H - 2.5;
      g.strokeStyle = rgba(pal.base, 0.42);
      g.moveTo(0, edge); g.lineTo(ARENA_W, edge);
      g.stroke();
    }
    this.bg = c;
    // (The prerendered dashed range rings that used to be baked here are gone
    // with the rings themselves — they were the single most expensive call in
    // the renderer on iOS, so this is a straight win as well as a visual one.)
  }

  // ------------------------------------------------------------- particles --
  // Pooled and preallocated: this runs inside the frame budget, so no allocation.
  // A kill used to be one expanding orange circle and the tank simply vanished —
  // the emotional peak of the match had less presence than a UI toast.
  _initParticles() {
    this.parts = new Array(320);
    for (let i = 0; i < this.parts.length; i++) {
      this.parts[i] = { life: 0, max: 1, x: 0, y: 0, vx: 0, vy: 0, r: 1, drag: 0.9, kind: 0, col: '#fff' };
    }
    this.partHead = 0;
  }

  _spawnPart(x, y, vx, vy, r, life, kind, col, drag) {
    const p = this.parts[this.partHead];
    this.partHead = (this.partHead + 1) % this.parts.length;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.r = r;
    p.life = life; p.max = life; p.kind = kind; p.col = col; p.drag = drag;
  }

  // kind 0 = spark (additive line), 1 = debris (rect), 2 = smoke (soft disc)
  emitExplosion(x, y, color) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 320 + Math.random() * 620;
      this._spawnPart(x, y, Math.cos(a) * s, Math.sin(a) * s,
        1.6, 0.12 + Math.random() * 0.14, 0, '#ffd88a', 0.09);
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 120 + Math.random() * 300;
      this._spawnPart(x, y, Math.cos(a) * s, Math.sin(a) * s,
        2 + Math.random() * 3, 0.5 + Math.random() * 0.4, 1,
        Math.random() < 0.5 ? color : '#2a2f38', 0.22);
    }
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 18 + Math.random() * 34;
      this._spawnPart(x, y, Math.cos(a) * s, Math.sin(a) * s,
        9 + Math.random() * 12, 0.9 + Math.random() * 0.5, 2, 'rgba(70,74,84,', 0.6);
    }
  }

  emitSparks(x, y, ang, n = 9) {
    for (let i = 0; i < n; i++) {
      const a = ang + (Math.random() - 0.5) * 1.2;
      const s = 260 + Math.random() * 460;
      this._spawnPart(x, y, Math.cos(a) * s, Math.sin(a) * s,
        1.4, 0.07 + Math.random() * 0.1, 0, '#ffd88a', 0.08);
    }
  }

  _drawParticles(dt) {
    const { ctx } = this;
    ctx.save();
    for (const p of this.parts) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      const k = Math.exp(-dt / p.drag);
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const f = p.life / p.max;
      if (p.kind === 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = p.col;
        ctx.globalAlpha = f;
        ctx.lineWidth = p.r;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
      } else if (p.kind === 1) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(1, f * 2.2);
        ctx.fillStyle = p.col;
        ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `${p.col}${(0.3 * f).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (2 - f), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
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
    ctx.fillStyle = SURROUND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.bg) ctx.drawImage(this.bg, sx * this.dpr, sy * this.dpr);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.vw / 2 + sx, this.vh / 2 + sy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // No range rings. The dashed threat radius drew two huge circles across the
    // middle of a 720px arena — more ink than the arena itself, and the tower
    // already announces its reach by shooting at you.
    const towerHp = state.towerHp || [TOWER_HP, TOWER_HP];

    // towers (the objective) sit under everything that moves
    // Towers track whatever they last shot at, and kick when they fire.
    const tState = state.towers || EMPTY_TOWER_STATE;
    for (let i = 0; i < TOWERS.length; i++) {
      const ts = tState[i];
      const since = ts ? now - ts.firedAt : 1e9;
      this._tower(
        TOWERS[i], towerHp[i] ?? 0, state.myTeam,
        ts && ts.aim !== undefined ? ts.aim : null,
        since < 180 ? 10 * (1 - since / 180) : 0,
        now,
      );
    }

    // Emit particles once per effect, the frame it first appears.
    for (const e of state.effects) {
      if (e.emitted) continue;
      e.emitted = true;
      if (e.kind === 'explosion') this.emitExplosion(e.x, e.y, PALETTE[(e.team ?? 0) & 1].base);
      else if (e.kind === 'hit') this.emitSparks(e.x, e.y, e.a ?? Math.random() * Math.PI * 2);
      else if (e.kind === 'poof') this.emitSparks(e.x, e.y, e.a ?? Math.random() * Math.PI * 2, 5);
    }
    // spawn/hit/explosion effects under tanks
    for (const e of state.effects) this._effect(e, now);

    // Power runes — one per half, each in its power's own colour with its own
    // drawn icon. Rendered from the snapshot byte, so exactly as present as the
    // server says. Icons are PATHS, not glyphs: a font fallback that swapped ×2
    // for a tofu box would make two powers indistinguishable.
    for (const r of state.runes || []) {
      const pulse = 1 + 0.08 * Math.sin(now / 220);
      const col = POWER_COLORS[r.kind] || '#ffd76e';
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, 32 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      const crate = this.sprites.crate;
      if (crate) {
        // The crate's core is white so ONE sprite serves every power: tint it
        // additively, then the glyph on top says which power it is.
        const w = CRATE_W * pulse;
        ctx.drawImage(crate, -w / 2, -w / 2, w, w);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(0, 0, 11 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#06101f';
        ctx.strokeStyle = '#06101f';
        ctx.save(); ctx.scale(0.85, 0.85); this._powerIcon(r.kind, '#06101f'); ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(6,10,18,0.55)';
        ctx.beginPath(); ctx.arc(0, 0, 22 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(0, 0, 22 * pulse, 0, Math.PI * 2); ctx.stroke();
        this._powerIcon(r.kind, col);
      }
      ctx.restore();
    }

    // remote tanks — bar shows the eased display hp (authoritative underneath)
    for (const t of state.others) {
      if (!t.alive) continue;
      this._tank(t.x, t.y, t.hull, t.turret, t.team, t.name, t.dispHp ?? t.hp, false);
      if (t.power === 2) this._shield(t.x, t.y, now);
      else if (t.power === 4) this._boostTrail(t.x, t.y, t.vx, t.vy);
    }
    // Aim ray. Direct-touch aiming means a ~45px fingertip sits on top of a 31px
    // enemy sprite — you cannot see the thing you are shooting at. The ray shows
    // the line of fire clear of the thumb without changing the control scheme.
    if (state.me && state.me.alive !== false && state.mePos && state.showAim) {
      const a = state.aimAngle;
      const ox = state.mePos.x + Math.cos(a) * (TANK_RADIUS + 10);
      const oy = state.mePos.y + Math.sin(a) * (TANK_RADIUS + 10);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(a);
      ctx.strokeStyle = this._aimGrad;
      ctx.lineWidth = 2 / cam.zoom;
      ctx.setLineDash([10, 7]);
      ctx.lineDashOffset = -(now * 0.2) % 17;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(260, 0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // my tank — with barrel recoil and the reload arc
    if (state.me && state.me.alive !== false && state.mePos) {
      const sinceFire = now - (state.lastFireAt ?? -1e9);
      const recoil = sinceFire < 120 ? 7 * (1 - sinceFire / 120) : 0;
      this._tank(
        state.mePos.x, state.mePos.y, state.mePos.hull, state.aimAngle,
        state.myTeam, state.meName, state.myHp ?? state.me.hp ?? MAX_HP, true, recoil, state.reload ?? 1,
        state.ammo ?? MAG_SIZE, !!state.reloading,
      );
      if (state.myPower === 2) this._shield(state.mePos.x, state.mePos.y, now);
      else if (state.myPower === 4 && state.me) {
        this._boostTrail(state.mePos.x, state.mePos.y, state.me.vx, state.me.vy);
      }
      // power countdown: a golden bar draining under the tank — deliberately NOT
      // a ring; circles around the own tank read as a permanent aura.
      if (state.myPower > 0 && state.myPowerFrac > 0) {
        ctx.save();
        const w = 44;
        const bx = state.mePos.x - w / 2, by = state.mePos.y + TANK_RADIUS + 19;
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(bx, by, w, 3.5);
        ctx.fillStyle = POWER_COLORS[state.myPower] || '#ffd76e';
        ctx.fillRect(bx, by, w * state.myPowerFrac, 3.5);
        ctx.restore();
      }
    }

    // Shells. At fit-to-arena zoom a shell was a 4px dot moving 218 screen px/s —
    // you could not see the thing that killed you. Bigger core, longer streak, and
    // incoming fire is tinted differently from your own so the read is instant.
    const shellR = Math.max(BULLET_RADIUS, 6 / cam.zoom);
    for (const b of state.bullets) {
      const mine = b.mine;
      // drawOff: cosmetic delta between physics (matches the server) and the
      // drawn barrel during a correction; eases to zero over the first frames
      const bx = b.x + (b.drawOffX || 0), by = b.y + (b.drawOffY || 0);
      const tx = bx - b.vx * 0.045, ty = by - b.vy * 0.045;
      const R = b.isPower ? shellR * 1.9 : shellR;
      ctx.strokeStyle = b.isPower ? 'rgba(255,120,220,0.6)'
        : mine ? 'rgba(255,190,60,0.55)' : 'rgba(255,110,50,0.55)';
      ctx.lineWidth = b.isPower ? 6 : 3.5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillStyle = b.isPower ? '#ff9bf0' : mine ? '#fff3b0' : '#ffb070';
      ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI * 2); ctx.fill();
      if (b.isPower) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(bx, by, R * 0.45, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Particles render OVER the tanks: a 14-screen-px spark under a 28px sprite
    // is occluded by the very thing it is meant to be marking.
    this._drawParticles(Math.min(0.05, dt));

    // ---- screen-space overlay pass ----
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (state.joy) this._joystick(state.joy, state.joyMax || 78);
  }

  _joystick(joy, max) {
    const { ctx } = this;
    const dx = clamp(joy.dx, -max, max);
    const dy = clamp(joy.dy, -max, max);
    const d = Math.hypot(dx, dy);
    const s = d > max ? max / d : 1;
    ctx.save();
    ctx.translate(joy.cx, joy.cy);
    ctx.fillStyle = 'rgba(40,110,220,0.16)';
    ctx.beginPath(); ctx.arc(0, 0, max, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,190,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(160,215,255,0.5)';
    ctx.beginPath(); ctx.arc(dx * s, dy * s, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(210,238,255,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // The match objective. Enemy towers show their engagement radius so you can
  // see the line you're about to cross; a destroyed tower is left as rubble.
  _tower(tw, hp, myTeam, aimAt, recoil, now) {
    const { ctx } = this;
    const R = TOWER_RADIUS;
    const pal = PALETTE[tw.team & 1];
    const color = pal.base;
    const dead = hp <= 0;
    const f = clamp(hp / TOWER_HP, 0, 1);
    const spin = (now / 1000) * 0.35;

    ctx.save();
    ctx.translate(tw.x, tw.y);

    const tImg = dead ? this.sprites.towerDead[tw.team & 1] : this.sprites.tower[tw.team & 1];
    if (tImg) {
      const w = TOWER_W, h = TOWER_W * tImg.height / tImg.width;
      ctx.drawImage(tImg, -w / 2, -h / 2, w, h);
      if (dead) { ctx.restore(); return; }
      // Barrel: the sprite has none, and a tower that shoots you every 1.1 s
      // must visibly hold a weapon. Gunmetal with the team's edge light.
      if (aimAt !== null) {
        ctx.save();
        ctx.rotate(aimAt);
        ctx.fillStyle = '#2a3142';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.fillRect(R * 0.35 - recoil, -6, 38, 12);
        ctx.strokeRect(R * 0.35 - recoil, -6, 38, 12);
        ctx.fillStyle = '#5a6478';
        ctx.fillRect(R * 0.35 + 30 - recoil, -7, 8, 14);
        ctx.restore();
      }
      // The sprite's core already glows; pulse an additive halo over it, and
      // below a quarter health flash it red as the panic tell.
      const crit = f <= 0.25;
      const pulse = 1 + 0.12 * Math.sin(now / (crit ? 150 : 420));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = crit ? (Math.sin(now / 150) > 0 ? 0.9 : 0.3) : 0.45;
      ctx.fillStyle = crit ? '#ff3030' : color;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.22 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    } else {
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

      // Barrel. It is an auto-turret that shoots you every 1.1s and it had no
      // visible weapon at all — you were killed by a thing that never moved.
      if (aimAt !== null) {
        ctx.save();
        ctx.rotate(aimAt);
        ctx.fillStyle = shade(color, -0.45);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.fillRect(R * 0.4 - recoil, -5.5, 34, 11);
        ctx.strokeRect(R * 0.4 - recoil, -5.5, 34, 11);
        ctx.restore();
      }

      // Slowly rotating inner ring: a static win condition reads as scenery.
      ctx.save();
      ctx.rotate(spin);
      octagon(ctx, R * 0.55);
      ctx.fillStyle = pal.towerCore;
      ctx.fill();
      ctx.strokeStyle = pal.towerRim;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Core pulses; below a quarter health it flashes red as a panic tell.
      const crit = f <= 0.25;
      const pulse = 1 + 0.10 * Math.sin(now / (crit ? 150 : 420));
      ctx.fillStyle = crit ? (Math.sin(now / 150) > 0 ? '#ff4d4d' : color) : color;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.2 * pulse, 0, Math.PI * 2); ctx.fill();
    }

    // Damage states — smoke from the tower itself, so its condition is readable
    // from across the arena without reading the bar.
    if (f < 0.66 && Math.random() < (f < 0.33 ? 0.12 : 0.05)) {
      this._spawnPart(tw.x + (Math.random() - 0.5) * R, tw.y + (Math.random() - 0.5) * R,
        (Math.random() - 0.5) * 30, -20 - Math.random() * 30,
        8 + Math.random() * 10, 0.9 + Math.random() * 0.6, 2, 'rgba(70,74,84,', 0.6);
    }

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

    // Ground shadow — lifts the sprite off the floor and gives it weight.
    ctx.fillStyle = 'rgba(0,0,0,0.40)';
    ctx.beginPath();
    ctx.ellipse(3, 5, R * 1.02, R * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();

    const hImg = this.sprites.hull[teamIdx & 1], tImg = this.sprites.turret[teamIdx & 1];
    if (hImg && tImg) {
      ctx.save();
      ctx.rotate(hull);
      const hw = HULL_W, hh = HULL_W * hImg.height / hImg.width;
      ctx.drawImage(hImg, -hw / 2, -hh / 2, hw, hh);
      ctx.restore();
      // turret on its own pivot; the recoil kicks the whole turret back along
      // the barrel and eases out over 120 ms
      ctx.save();
      ctx.rotate(turret);
      const s = TURRET_SCALE[teamIdx & 1], pv = TURRET_PIVOT[teamIdx & 1];
      ctx.drawImage(tImg, -pv.x * s - recoil, -pv.y * s, tImg.width * s, tImg.height * s);
      ctx.restore();
    } else {
      ctx.save();
      ctx.rotate(hull);
      // Treads: inset along the hull axis and thinner. Spanning the full 52px width
      // made them the OUTERMOST element, so at 28 screen px every tank read as a
      // black slab with a coloured dot in it rather than as a vehicle.
      ctx.fillStyle = '#07090d';
      ctx.fillRect(-R + 5, -R + 1, R * 2 - 10, 7);
      ctx.fillRect(-R + 5, R - 8, R * 2 - 10, 7);
      // hull — build the rounded path once, then fill AND stroke it
      roundRect(ctx, -R + 2, -R + 8, R * 2 - 4, R * 2 - 16, 6);
      ctx.fillStyle = this._hullGrad[teamIdx & 1];
      ctx.fill();
      // dark keyline first, then the bright rim: the outline has to be the dominant
      // read at this size, and a 2.5px stroke resolves to 1.35 screen px.
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.6;
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
    }

    if (isMe) {
      // No ring around the player's own tank — the encircling reload arc + pips
      // read as a permanent "aura" and got removed by request. Ammo lives in a
      // small pip row UNDER the sprite instead; the row doubles as the reload
      // indicator (pips refill left-to-right in amber while reloading).
      const pipY = R + 12;
      const span = (MAG_SIZE - 1) * 9;
      for (let i = 0; i < MAG_SIZE; i++) {
        const filled = isReloading ? (i / MAG_SIZE) < clamp(reload, 0, 1) : i < ammo;
        ctx.fillStyle = isReloading
          ? (filled ? 'rgba(255,190,90,0.95)' : 'rgba(255,255,255,0.18)')
          : (filled ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.18)');
        ctx.beginPath();
        ctx.arc(-span / 2 + i * 9, pipY, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // name + hp — drawn at constant SCREEN size. The fit-to-arena zoom is ~0.54
    // on a phone, which would render a 13px world label at 7px and make it
    // unreadable; undoing the camera scale keeps labels crisp at any zoom.
    const k = 1 / this.cam.zoom;
    ctx.save();
    ctx.scale(k, k);
    const top = -(R + 6) / k;          // tank's top edge, expressed in screen-space units
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(255,255,255,0.78)';
    ctx.fillText(name || '', 0, top - 12);
    ctx.shadowBlur = 0;
    // Only show the bar once there's damage to report. Four permanent full bars
    // is four pieces of chrome saying nothing, stacked over 28px sprites.
    if (hp < MAX_HP) {
      const w = 32, h = 5;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(-w / 2 - 1, top - 9, w + 2, h + 2);
      // Segment to the actual TTK so a glance tells you how many shells are left.
      const segs = Math.ceil(MAX_HP / BULLET_DAMAGE);
      ctx.fillStyle = hp > 55 ? '#8ef5c0' : hp > 25 ? '#ffd166' : '#ff4d4d';
      ctx.fillRect(-w / 2, top - 8, w * (hp / MAX_HP), h);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 1;
      for (let s = 1; s < segs; s++) {
        const sx = -w / 2 + (w * s) / segs;
        ctx.beginPath(); ctx.moveTo(sx, top - 8); ctx.lineTo(sx, top - 3); ctx.stroke();
      }
    }
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
    } else if (e.kind === 'deflect') {
      // shell died on a shield: a cyan arc flash, pointedly NOT a damage effect
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = '#8be9fd';
      ctx.lineWidth = 4 * (1 - f) + 1;
      ctx.beginPath(); ctx.arc(e.x, e.y, 16 + 18 * ease(f), 0, Math.PI * 2); ctx.stroke();
    } else if (e.kind === 'powerup') {
      // rune claimed: a burst in that power's own colour
      const pc = POWER_COLORS[e.kind2] || '#ffd76e';
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = pc;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, 20 + 55 * ease(f), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.35 * (1 - f);
      ctx.fillStyle = pc;
      ctx.beginPath(); ctx.arc(e.x, e.y, 20 + 40 * ease(f), 0, Math.PI * 2); ctx.fill();
    } else if (e.kind === 'confirm') {
      // Server-confirmed hitmarker: four ticks + a floating damage number. The
      // ONE symbol in the game that only ever appears when damage really landed.
      const g = 1 - ease(f);
      const r0 = 10 + 6 * ease(f);
      ctx.translate(e.x, e.y);
      ctx.strokeStyle = `rgba(255,255,255,${0.95 * g})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * Math.PI / 2;
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * (r0 + 8), Math.sin(a) * (r0 + 8));
      }
      ctx.stroke();
      ctx.globalAlpha = Math.min(1, 2 * (1 - f));
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffe796';
      ctx.fillText(typeof e.dmg === 'string' ? e.dmg : `-${e.dmg ?? ''}`, 0, -22 - 16 * ease(f));
    }
    ctx.restore();
  }

  // Power icons, drawn at the current origin. Three silhouettes that stay
  // readable at ~12 screen px and can never be confused for each other:
  //   DOUBLE     two stacked shells with trails
  //   SHIELD     a shield outline
  //   POWERSHOT  a lightning bolt
  //   SPEED      a fast-forward double chevron
  _powerIcon(kind, col) {
    const { ctx } = this;
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    if (kind === 4) {
      for (const dx of [-9, 0]) {
        ctx.beginPath();
        ctx.moveTo(dx, -8);
        ctx.lineTo(dx + 9, 0);
        ctx.lineTo(dx, 8);
        ctx.closePath();
        ctx.fill();
      }
      return;
    }
    if (kind === 1) {
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      for (const dy of [-5, 5]) {
        ctx.beginPath(); ctx.moveTo(-9, dy); ctx.lineTo(2, dy); ctx.stroke();
        ctx.beginPath(); ctx.arc(6, dy, 3.1, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === 2) {
      ctx.beginPath();
      ctx.moveTo(0, -10);
      ctx.lineTo(8.5, -6);
      ctx.lineTo(8.5, 2);
      ctx.quadraticCurveTo(8.5, 8, 0, 11);
      ctx.quadraticCurveTo(-8.5, 8, -8.5, 2);
      ctx.lineTo(-8.5, -6);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(2.5, -11);
      ctx.lineTo(-7.5, 1.5);
      ctx.lineTo(-0.5, 1.5);
      ctx.lineTo(-2.5, 11);
      ctx.lineTo(7.5, -1.5);
      ctx.lineTo(0.5, -1.5);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Overdrive trail — chevrons streaming off the BACK of a boosted tank, so an
  // opponent can see it coming without a label. Drawn from velocity, so it
  // vanishes when the tank is standing still (which is the honest read: a
  // stationary tank is not outrunning anything).
  _boostTrail(x, y, vx, vy) {
    const { ctx } = this;
    const sp = Math.hypot(vx || 0, vy || 0);
    if (sp < 40) return;
    const a = Math.atan2(vy, vx);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.strokeStyle = '#6ef58f';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = (1 - i * 0.28) * Math.min(1, sp / 260) * 0.85;
      const d = -(TANK_RADIUS + 5 + i * 9);
      ctx.beginPath();
      ctx.moveTo(d + 6, -7);
      ctx.lineTo(d, 0);
      ctx.lineTo(d + 6, 7);
      ctx.stroke();
    }
    ctx.restore();
  }

  // The shield bubble — drawn on ANY tank whose snapshot power bit says so.
  _shield(x, y, now) {
    const { ctx } = this;
    const pulse = 1 + 0.05 * Math.sin(now / 130);
    ctx.save();
    ctx.strokeStyle = 'rgba(139,233,253,0.85)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, (TANK_RADIUS + 9) * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(139,233,253,0.10)';
    ctx.fill();
    ctx.restore();
  }
}

// A destroyed tower is the same sprite, drained: desaturate, then darken, with
// the original's alpha restored so the fills never bleed outside the octagon.
function deadVariant(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'saturation';
  g.fillStyle = '#808080';
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(0, 0, c.width, c.height);
  return c;
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
