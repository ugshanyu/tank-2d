// Input: tilt-to-move (device orientation) with touch-to-aim/shoot.
// Fallbacks: virtual joystick (left half of screen) when tilt is unavailable or
// denied, and WASD/arrows + mouse on desktop. Uses Pointer Events throughout.

const TILT_RANGE_DEG = 18;   // degrees of tilt for full speed
const JOY_MAX = 64;          // px of drag for full joystick deflection

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = 'stick';               // 'tilt' | 'stick' (stick also covers kbd)
    this.moveX = 0;
    this.moveY = 0;
    this.firing = false;
    this.aimScreen = { x: 0, y: 0 };   // last aim point in CSS pixels
    this.hasAim = false;

    // tilt
    this._beta0 = null;                // calibrated neutral
    this._gamma0 = null;
    this._beta = null;
    this._gamma = null;
    this.tiltReady = false;

    // joystick
    this.joy = null;                   // {pointerId, cx, cy, dx, dy}
    this._firePointers = new Map();    // pointerId -> {x,y}

    // keyboard
    this._keys = new Set();

    this._attach();
  }

  // Must be called from a user gesture (button tap). Returns 'granted' | 'denied' | 'unavailable'.
  async requestTilt() {
    if (typeof DeviceOrientationEvent === 'undefined') return 'unavailable';
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission(); // iOS 13+
        if (res !== 'granted') return 'denied';
      }
    } catch {
      return 'denied';
    }
    return await new Promise((resolve) => {
      let settled = false;
      const onFirst = (e) => {
        if (settled) return;
        if (e.beta === null || e.gamma === null) return; // desktop fires empty events
        settled = true;
        this.tiltReady = true;
        this.mode = 'tilt';
        this._beta = e.beta; this._gamma = e.gamma;
        this.calibrate();
        resolve('granted');
      };
      window.addEventListener('deviceorientation', onFirst);
      window.addEventListener('deviceorientation', (e) => {
        if (e.beta === null) return;
        this._beta = e.beta; this._gamma = e.gamma;
      });
      setTimeout(() => { if (!settled) { settled = true; resolve('unavailable'); } }, 1200);
    });
  }

  calibrate() {
    if (this._beta !== null) { this._beta0 = this._beta; this._gamma0 = this._gamma; }
  }

  _screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  // Recompute moveX/moveY once per frame from whichever source is live.
  poll() {
    // keyboard always contributes (desktop testing)
    let kx = 0, ky = 0;
    if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) kx -= 1;
    if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) kx += 1;
    if (this._keys.has('KeyW') || this._keys.has('ArrowUp')) ky -= 1;
    if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) ky += 1;

    if (this.mode === 'tilt' && this.tiltReady && this._beta0 !== null) {
      const db = (this._beta - this._beta0);
      const dg = (this._gamma - this._gamma0);
      // rotate device axes into screen axes
      const angle = this._screenAngle();
      let x, y;
      if (angle === 90) { x = db; y = -dg; }
      else if (angle === -90 || angle === 270) { x = -db; y = dg; }
      else if (angle === 180) { x = -dg; y = -db; }
      else { x = dg; y = db; }
      this.moveX = clamp(x / TILT_RANGE_DEG, -1, 1);
      this.moveY = clamp(y / TILT_RANGE_DEG, -1, 1);
    } else if (this.joy) {
      this.moveX = clamp(this.joy.dx / JOY_MAX, -1, 1);
      this.moveY = clamp(this.joy.dy / JOY_MAX, -1, 1);
    } else {
      this.moveX = kx;
      this.moveY = ky;
    }
    if (kx || ky) { this.moveX = kx; this.moveY = ky; } // keys override on desktop

    this.firing = this._firePointers.size > 0 || this._keys.has('Space') || this._mouseDown === true;
  }

  _attach() {
    const c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* pointer already gone (or synthetic) */ }
      const useStickZone = this.mode !== 'tilt';
      if (useStickZone && e.pointerType !== 'mouse' && !this.joy && e.clientX < window.innerWidth * 0.45) {
        this.joy = { pointerId: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0 };
        return;
      }
      if (e.pointerType === 'mouse') {
        this._mouseDown = true;
        this.aimScreen = { x: e.clientX, y: e.clientY };
        this.hasAim = true;
        return;
      }
      this._firePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.aimScreen = { x: e.clientX, y: e.clientY };
      this.hasAim = true;
    });

    c.addEventListener('pointermove', (e) => {
      if (this.joy && e.pointerId === this.joy.pointerId) {
        this.joy.dx = e.clientX - this.joy.cx;
        this.joy.dy = e.clientY - this.joy.cy;
        return;
      }
      if (e.pointerType === 'mouse') {
        this.aimScreen = { x: e.clientX, y: e.clientY };
        this.hasAim = true;
        return;
      }
      if (this._firePointers.has(e.pointerId)) {
        this._firePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.aimScreen = { x: e.clientX, y: e.clientY };
      }
    });

    const release = (e) => {
      if (this.joy && e.pointerId === this.joy.pointerId) { this.joy = null; return; }
      if (e.pointerType === 'mouse') this._mouseDown = false;
      this._firePointers.delete(e.pointerId);
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('lostpointercapture', release);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      this._keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => { this._keys.clear(); this._mouseDown = false; this._firePointers.clear(); this.joy = null; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
