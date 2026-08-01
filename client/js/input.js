// Input: tilt-to-move (device orientation) with touch-to-aim/shoot.
// Fallbacks: virtual joystick (left half of screen) when tilt is unavailable or
// denied, and WASD/arrows + mouse on desktop. Uses Pointer Events throughout.

const TILT_RANGE_DEG = 14;   // degrees of tilt for full speed
const JOY_MAX = 78;          // px of drag for full joystick deflection (64 was
                             // twitchy under a thumb arc on a 375px screen)
const TILT_SMOOTH_TAU = 0.045;  // s — ease toward the sensor reading instead of
                                // consuming it raw; accelerometer noise otherwise
                                // makes the tank twitch when you hold still

// Neutral device pitch (deviceorientation `beta`) per posture. Beta is 0 with the
// phone flat on a table and 90 held upright. Nobody plays at either extreme, so
// the default neutral is tilted toward the face — the "Regular" of Tilt to Live,
// whose post-mortem is the reason these are PRESETS rather than auto-detected:
// sampling neutral from whatever pose the player happened to be in produces
// "the calibration is royally screwed up".
export const TILT_PRESETS = { upright: 55, angled: 32, flat: 6 };

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.joyMax = JOY_MAX;
    this.mode = 'stick';               // 'tilt' | 'stick' (stick also covers kbd)
    // Tilt is the intended way to play on a phone, so it is the DEFAULT on any
    // touch device — but it stays switchable, because being locked into tilt with
    // no way back is miserable on a bus or lying down.
    this.isTouch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
    this.prefersTilt = this.isTouch;
    this.tiltPreset = 'angled';   // the pose most people actually hold a phone in
    this.suppressNextPointer = false;  // the permission-granting tap is not a shot
    try {
      const stored = localStorage.getItem('tank.tilt');
      if (stored !== null) this.prefersTilt = stored === '1';
      const pose = localStorage.getItem('tank.tiltPose');
      // A stored 'custom' is only meaningful with the angle that went with it;
      // without one, applyTiltPreset would fail and we'd fall back to sampling.
      this._customBeta = Number(localStorage.getItem('tank.tiltBeta'));
      this.tiltPreset = (pose === 'custom' && Number.isFinite(this._customBeta)) ? 'custom'
        : (TILT_PRESETS[pose] !== undefined ? pose : 'angled');
    } catch { /* private mode */ }
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
    this._sBeta = null;                // smoothed sensor reading (see poll)
    this._sGamma = null;
    this._tiltAt = 0;
    this.tiltReady = false;

    // joystick
    this.joy = null;                   // {pointerId, cx, cy, dx, dy}
    this._firePointers = new Map();    // pointerId -> {x,y}

    // keyboard
    this._keys = new Set();

    this._attach();
  }

  // ONE persistent orientation listener, attached once and never torn down.
  //
  // This used to live inside requestTilt() behind a 1.2 s deadline: if the sensor
  // hadn't produced a reading by then we returned 'unavailable', tiltReady stayed
  // false FOREVER, and — because the settings sheet disables the Tilt button on
  // !tiltReady — the player had no way to turn it on afterwards. A WKWebView
  // routinely takes longer than 1.2 s to spin the sensor up, and some deliver a
  // null-valued event first, so the headline control scheme silently never
  // engaged. Now a reading is accepted whenever it arrives, however late.
  _attachOrientation() {
    if (this._orientationAttached) return;
    this._orientationAttached = true;
    window.addEventListener('deviceorientation', (e) => {
      if (e.beta === null || e.gamma === null) return;   // desktop fires empty events
      this._beta = e.beta;
      this._gamma = e.gamma;
      if (this._sBeta === null) { this._sBeta = e.beta; this._sGamma = e.gamma; }
      if (this.tiltReady) return;
      // First real reading, whenever it lands.
      this.tiltReady = true;
      this.applyTiltPreset(this.tiltPreset);
      if (this.prefersTilt) this.setMode('tilt');
      if (this.onTiltReady) this.onTiltReady();
    });
  }

  // Must be called from a user gesture (button tap).
  // Returns 'granted' | 'denied' | 'unavailable' | 'pending'.
  async requestTilt() {
    if (typeof DeviceOrientationEvent === 'undefined') return 'unavailable';
    // Attach BEFORE asking: on platforms with no permission API (Android WebView,
    // older iOS) events start flowing immediately and we must not miss them.
    this._attachOrientation();
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission(); // iOS 13+
        if (res !== 'granted') return 'denied';
      }
    } catch {
      return 'denied';
    }
    if (this.tiltReady) return 'granted';
    // Give the sensor a generous window, but 'pending' is NOT terminal — the
    // listener above stays live and will flip to tilt whenever data shows up.
    await new Promise((r) => setTimeout(r, 2500));
    return this.tiltReady ? 'granted' : 'pending';
  }

  // Can this device ever do tilt? Used to decide whether to offer the option at
  // all, rather than whether it has already succeeded.
  tiltSupported() {
    return typeof DeviceOrientationEvent !== 'undefined';
  }

  // Switching control scheme mid-match must cancel any stick the thumb is holding,
  // otherwise the tank keeps driving in the last joystick direction forever.
  setMode(mode) {
    if (mode === 'tilt' && !this.tiltReady) return false;
    this.mode = mode;
    this.prefersTilt = mode === 'tilt';
    this.joy = null;
    this.moveX = 0; this.moveY = 0;
    try { localStorage.setItem('tank.tilt', this.prefersTilt ? '1' : '0'); } catch { /* ignore */ }
    // Re-apply the chosen POSTURE, never re-sample the current pose. calibrate()
    // here was clobbering the preset the caller had just set — and on iOS the
    // sample was taken while the player was still tapping the permission dialog,
    // which is the precise failure this whole preset system exists to avoid.
    if (mode === 'tilt' && this.tiltPreset !== 'custom') this.applyTiltPreset(this.tiltPreset);
    return true;
  }

  clearTouches() {
    this._firePointers.clear();
    this.joy = null;
    this._mouseDown = false;
    this.hasAim = false;
    this.firing = false;
  }

  // One of three postures. Cheaper for the player than "hold still and tap" and
  // it survives them shifting position, which auto-calibration does not.
  applyTiltPreset(name) {
    if (name === 'custom' && Number.isFinite(this._customBeta)) {
      this.tiltPreset = 'custom';
      this._beta0 = this._customBeta;
      this._gamma0 = this._customGamma || 0;
      return true;
    }
    const beta = TILT_PRESETS[name];
    if (beta === undefined) return this.applyTiltPreset('angled');
    this.tiltPreset = name;
    this._beta0 = beta;
    this._gamma0 = 0;
    try { localStorage.setItem('tank.tiltPose', name); } catch { /* ignore */ }
    return true;
  }

  // Manual "Level now": whatever pose you are in right now becomes neutral.
  calibrate() {
    if (this._beta !== null) {
      this._beta0 = this._sBeta ?? this._beta;
      this._gamma0 = this._sGamma ?? this._gamma;
      this._customBeta = this._beta0;
      this._customGamma = this._gamma0;
      this.tiltPreset = 'custom';
      try {
        localStorage.setItem('tank.tiltPose', 'custom');
        localStorage.setItem('tank.tiltBeta', String(this._beta0));
      } catch { /* ignore */ }
    }
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
      // Ease toward the sensor reading rather than consuming it raw. Accelerometer
      // noise is a few tenths of a degree frame to frame, which is enough to make
      // a stationary tank jitter; a ~45ms time constant kills that without any
      // perceptible lag on a real wrist movement.
      const now = performance.now();
      const dtS = Math.min(0.1, Math.max(0, (now - (this._tiltAt || now)) / 1000));
      this._tiltAt = now;
      const k = 1 - Math.exp(-dtS / TILT_SMOOTH_TAU);
      if (this._sBeta === null || this._sBeta === undefined) { this._sBeta = this._beta; this._sGamma = this._gamma; }
      this._sBeta += wrapDeg(this._beta - this._sBeta) * k;
      this._sGamma += wrapDeg(this._gamma - this._sGamma) * k;

      // shortest-signed-angle deltas: beta/gamma wrap at ±180/±90, and a raw
      // subtraction across the wrap would slam movement to full speed backwards
      const db = wrapDeg(this._sBeta - this._beta0);
      const dg = wrapDeg(this._sGamma - this._gamma0);
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
    // Inside the Usion host the game runs in an iframe, and keydown only reaches
    // it once it holds focus — without this, WASD looks broken on desktop until
    // the player happens to click. Claim focus on load and on every press.
    c.tabIndex = 0;
    c.style.outline = 'none';
    try { window.focus(); c.focus({ preventScroll: true }); } catch { /* focus is best-effort */ }

    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { window.focus(); c.focus({ preventScroll: true }); } catch { /* ignore */ }
      // The very first tap is the one that opens the iOS motion-permission modal.
      // It used to ALSO register as fire, so the player's first interaction was an
      // unintended shot — and if the modal swallowed the pointerup, a stuck one.
      if (this.suppressNextPointer) { this.suppressNextPointer = false; return; }
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
      // hasAim was set true on first touch and never cleared, so after driving
      // across the arena the turret stayed locked at a stale SCREEN point with no
      // visible reason. Hold the last angle instead of a last coordinate.
      if (this._firePointers.size === 0 && e.pointerType !== 'mouse') this.hasAim = false;
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('lostpointercapture', release);

    // Only a CUSTOM neutral is pose-dependent; the presets are absolute, and
    // silently re-sampling neutral on a rotation is precisely the auto-calibration
    // that gets reported as "the calibration is royally screwed up".
    const onOrient = () => setTimeout(() => {
      if (this.tiltPreset === 'custom') this.calibrate();
    }, 700);
    if (screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener('change', onOrient);
    } else {
      window.addEventListener('orientationchange', onOrient);
    }

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
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180;
