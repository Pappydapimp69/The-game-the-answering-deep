// Unified input: keyboard, touch, and gamepad all translate into one small
// intent vocabulary — everything downstream is device-agnostic. Gamepads are
// POLLED every frame (the connect event only fires after a button press).
// Action intents are edge-triggered here so one press = one action, no matter
// which device fired it or how many systems read the frame.

const ACTIONS = ['attack', 'blast', 'charge', 'interact', 'inventory', 'dodge', 'confirm', 'cancel', 'alt'];

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  KeyJ: 'attack', KeyK: 'blast', KeyL: 'charge', KeyE: 'interact', KeyI: 'inventory',
  Space: 'dodge', Enter: 'confirm', Escape: 'cancel',
};

// Standard-mapping gamepad buttons.
const PAD = { attack: 0, dodge: 1, blast: 2, charge: 3, interact: 5, inventory: 9, confirm: 0, cancel: 1 };

export function makeInput(canvas) {
  const held = {};          // logical name -> bool (keyboard)
  const touches = new Map(); // touch id -> {x,y}
  let device = 'keyboard';   // last ACTIVE device: keyboard | touch | gamepad
  const prev = {};           // action -> was down last frame (for edges)
  let pending = {};          // presses CAPTURED at event time — a tap shorter
                             // than one frame must never be lost to sampling
  let touchZones = [];       // set each frame by the renderer (screen-space)

  window.addEventListener('keydown', (e) => {
    const name = KEYMAP[e.code];
    if (!name) return;
    e.preventDefault();
    held[name] = true;
    if (!e.repeat) pending[name] = true;
    device = 'keyboard';
  });
  window.addEventListener('keyup', (e) => {
    const name = KEYMAP[e.code];
    if (name) held[name] = false;
  });

  const point = (t) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (t.clientX - r.left) * (canvas.width / r.width),
      y: (t.clientY - r.top) * (canvas.height / r.height),
    };
  };
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    device = 'touch';
    for (const t of e.changedTouches) {
      const p = point(t);
      touches.set(t.identifier, p);
      const z = zoneAt(p);
      if (z) pending[z.id] = true; // capture the tap even if it ends mid-frame
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) touches.set(t.identifier, point(t));
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) touches.delete(t.identifier);
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);
  // Mouse clicks reuse the touch zones so modal buttons work on desktop too.
  canvas.addEventListener('mousedown', (e) => {
    const z = zoneAt(point(e));
    if (z) pending[z.id] = true;
  });

  function zoneAt(p) {
    for (const z of touchZones) {
      if (p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h) return z;
    }
    return null;
  }

  // Returns { move: {dx,dy}, presses: {action: true on edge}, device }
  function poll() {
    const down = { up: !!held.up, down: !!held.down, left: !!held.left, right: !!held.right };
    for (const a of ACTIONS) down[a] = !!held[a];

    // Touch: resolve every active (held) touch against this frame's zones.
    for (const p of touches.values()) {
      const z = zoneAt(p);
      if (z) { down[z.id] = true; device = 'touch'; }
    }
    // Event-time captures: count as down this frame even if already released.
    const firedPending = Object.keys(pending);
    for (const name of firedPending) down[name] = true;
    pending = {};

    // Gamepad: poll — never trust the connect event.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      let any = false;
      if (ax < -0.4 || gp.buttons[14]?.pressed) { down.left = true; any = true; }
      if (ax > 0.4 || gp.buttons[15]?.pressed) { down.right = true; any = true; }
      if (ay < -0.4 || gp.buttons[12]?.pressed) { down.up = true; any = true; }
      if (ay > 0.4 || gp.buttons[13]?.pressed) { down.down = true; any = true; }
      for (const a of Object.keys(PAD)) {
        if (gp.buttons[PAD[a]]?.pressed) { down[a] = true; any = true; }
      }
      if (any) device = 'gamepad';
    }

    const presses = {};
    for (const a of ACTIONS) {
      if (down[a] && !prev[a]) presses[a] = true;
      prev[a] = down[a];
    }
    // Zone ids outside the fixed action vocabulary (title-screen buttons,
    // archetype cards, …) are one-shot by construction — they only ever
    // enter `pending` at click/tap event time, never held-sampled — so any
    // such id firing this frame is a press with no edge-tracking needed.
    for (const name of firedPending) {
      if (!ACTIONS.includes(name)) presses[name] = true;
    }
    const move = {
      dx: (down.right ? 1 : 0) - (down.left ? 1 : 0),
      dy: (down.down ? 1 : 0) - (down.up ? 1 : 0),
    };
    // Charge is press-and-hold, not a one-shot action — expose the raw held
    // state (already continuous across keyboard/touch/gamepad in `down`)
    // alongside the edge-triggered `presses`. blastHeld is exposed the same
    // way so single-button dialogs can require a deliberate hold-to-dismiss
    // on blast/X — a button distinct from confirm/attack, which is what was
    // causing accidental dismissal via combat mashing in the first place.
    return { move, presses, device, chargeHeld: !!down.charge, blastHeld: !!down.blast };
  }

  return {
    poll,
    setZones(zones) { touchZones = zones; },
    get device() { return device; },
    // 'ontouchstart' in window alone false-negatives on real touch hardware —
    // notably iPadOS Safari in its default desktop-site mode, which drops
    // ontouchstart entirely despite the device being fully touch-capable.
    // navigator.maxTouchPoints is the more reliable modern signal; check both.
    hasTouch: 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0,
  };
}
