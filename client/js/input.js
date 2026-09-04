// Input: tilt-to-move (device orientation) with touch-to-aim/shoot on phones.
// The virtual joystick is the FALLBACK — it drives whenever tilt is unavailable,
// denied, or not yet reporting — and a choice in Settings. In joystick mode the
// FIRST finger is the stick wherever it lands (left or right, whichever hand is
// free) and the second finger aims and shoots. WASD/arrows + mouse on desktop.
// Pointer Events throughout.

// Degrees of tilt for full speed — the sensitivity dial, and LOWER is more
// sensitive. At 14 you had to lay the phone over a long way to get everything
// out of the tank, which reads as a heavy, unresponsive vehicle; 9 puts full
// speed inside a comfortable wrist roll, so small corrections move you and the
// top end is actually reachable while sitting up. The 45ms smoothing below is
// what keeps this from turning sensor noise into twitch.
const TILT_RANGE_DEG = 9;
const JOY_MAX = 52;          // px of drag for full joystick deflection. 78 was
                             // most of a thumb's reach, so "touch and go" felt
                             // like winding up before anything happened.
const JOY_MIN = 3;           // px before the stick engages — just enough to not
                             // read a stationary thumb's jitter as input
const JOY_FLOOR = 0.4;       // the sim's curve parameter at JOY_MIN: the tank
                             // leaves at ~26% speed rather than from a standstill
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
    this.isTouch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
    // Tilt is the way to play on a phone: the whole arena is on screen and both
    // thumbs stay free to aim. The joystick is never shown unless it is needed —
    // it takes over when motion access is denied or the device has no sensor —
    // or unless the player picks it in Settings, and a choice sticks across
    // launches. Nothing about steering is written to storage until they choose.
    this.prefersTilt = this.isTouch;
    // A launch must never redefine neutral from the pose the player happened to
    // be holding. Use the same fixed, comfortable reference on every launch;
    // the other fixed posture presets remain explicit choices in Settings.
    this.tiltPreset = 'angled';
    this.suppressNextPointer = false;  // the permission-granting tap is not a shot
    try {
      // Only an EXPLICIT choice is remembered (setMode's `persist`). The legacy
      // `tank.tilt` key was auto-written whenever the sensor happened to engage,
      // so it says nothing about what the player wanted and is ignored.
      const steer = localStorage.getItem('tank.steer');
      if (steer === 'tilt') this.prefersTilt = true;
      else if (steer === 'stick') this.prefersTilt = false;
      const pose = localStorage.getItem('tank.tiltPose');
      // Old 'auto' and 'custom' values were pose-derived and therefore changed
      // the controls between launches. Migrate both to the fixed default.
      this.tiltPreset = TILT_PRESETS[pose] !== undefined ? pose : 'angled';
    } catch { /* private mode */ }
    this.moveX = 0;
    this.moveY = 0;
    this.firing = false;
    this.aimScreen = { x: 0, y: 0 };   // last aim point in CSS pixels
    this.hasAim = false;

    // tilt
    this._beta0 = null;                // fixed neutral from TILT_PRESETS
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
    // Listen for orientation from the very first frame, NOT from the first tap.
    // Attaching costs nothing and asks for nothing: on Android, in a WebView, and
    // anywhere without iOS's permission gate, readings start arriving at once and
    // tilt engages before the player touches the screen. It used to be attached
    // only inside requestTilt(), so every platform paid for iOS's restriction and
    // the game sat on the joystick until something was tapped.
    if (this.prefersTilt) this._attachOrientation();
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

  // Will the next gesture actually raise a permission modal? Only iOS 13+ gates
  // motion behind one. Everywhere else the first tap should be an ordinary shot
  // rather than being swallowed for a prompt that never appears.
  needsTiltPrompt() {
    return !this.tiltReady
      && typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  // Switching control scheme mid-match must cancel any stick the thumb is holding,
  // otherwise the tank keeps driving in the last joystick direction forever.
  //
  // `persist` is only true for a choice the PLAYER made (Settings, the motion
  // sheet). The automatic flip in _attachOrientation must not write anything:
  // "the sensor reported" is not a preference.
  setMode(mode, { persist = false } = {}) {
    this.prefersTilt = mode === 'tilt';
    if (persist) {
      try { localStorage.setItem('tank.steer', this.prefersTilt ? 'tilt' : 'stick'); } catch { /* ignore */ }
    }
    if (mode === 'tilt' && !this.tiltReady) {
      // Preference recorded; the sensor has not reported yet. The persistent
      // orientation listener switches us over the moment it does.
      this._attachOrientation();
      return false;
    }
    this.mode = mode;
    this.joy = null;
    this.moveX = 0; this.moveY = 0;
    // Re-apply the fixed posture, never sample the current phone pose.
    if (mode === 'tilt') this.applyTiltPreset(this.tiltPreset);
    return true;
  }

  clearTouches() {
    this._firePointers.clear();
    this.joy = null;
    this._mouseDown = false;
    this.hasAim = false;
    this.firing = false;
  }

  // Every posture is an absolute reference that survives launches and shifting
  // position. An unknown/legacy value always returns to the fixed default.
  applyTiltPreset(name) {
    const preset = TILT_PRESETS[name] === undefined ? 'angled' : name;
    const beta = TILT_PRESETS[preset];
    this.tiltPreset = preset;
    this._beta0 = beta;
    this._gamma0 = 0;
    try { localStorage.setItem('tank.tiltPose', preset); } catch { /* ignore */ }
    return true;
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
      // INSTANT off the mark. The shared sim drops anything under 0.12 and then
      // eases in quadratically (s*s*0.6 + s*0.4), so a small drag used to mean
      // thumb down, stick deflected, tank barely crawling. Map the drag onto the
      // sim's own curve parameter starting at JOY_FLOOR instead of 0, so the
      // first millimetre past the jitter threshold is already ~26% speed and it
      // climbs smoothly from there. (Solving the curve keeps the feel linear-ish
      // rather than re-introducing a ramp on top of the sim's.)
      const d = Math.hypot(this.joy.dx, this.joy.dy);
      if (d <= JOY_MIN) { this.moveX = 0; this.moveY = 0; }
      else {
        const f = Math.min(1, (d - JOY_MIN) / (JOY_MAX - JOY_MIN));
        const s = JOY_FLOOR + (1 - JOY_FLOOR) * f;   // sim curve parameter, 0..1
        const mag = 0.12 + 0.88 * s;                 // undo the sim's deadzone
        this.moveX = (this.joy.dx / d) * mag;
        this.moveY = (this.joy.dy / d) * mag;
      }
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
      // Joystick mode: the first finger down IS the stick, on either side of the
      // screen — no zone. A fixed left-hand zone assumed a right-handed player
      // and made a left thumb on the right half fire instead of drive. Every
      // later finger aims and shoots. (Tilt mode: every touch aims and shoots.)
      if (this.mode !== 'tilt' && e.pointerType !== 'mouse' && !this.joy) {
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

    // `code` is deliberately primary: it is the PHYSICAL key position, so WASD
    // stays under the same fingers on AZERTY/QWERTZ where `key` would report z/q.
    // But not every source populates it — synthetic events, some remote-desktop
    // and on-screen keyboards, and automation deliver `key` with `code` empty,
    // and then steering silently does nothing at all. Fall back rather than drop.
    const codeOf = (e) => {
      if (e.code) return e.code;
      const k = e.key;
      if (!k) return '';
      if (k === ' ' || k === 'Spacebar') return 'Space';
      return k.length === 1 ? `Key${k.toUpperCase()}` : k;
    };
    window.addEventListener('keydown', (e) => {
      const code = codeOf(e);
      if (code === 'Space') e.preventDefault();
      this._keys.add(code);
    });
    window.addEventListener('keyup', (e) => this._keys.delete(codeOf(e)));
    window.addEventListener('blur', () => { this._keys.clear(); this._mouseDown = false; this._firePointers.clear(); this.joy = null; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180;
