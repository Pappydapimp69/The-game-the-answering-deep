// Unified input: keyboard, touch, and gamepad all translate into one small
// intent vocabulary — everything downstream is device-agnostic. Gamepads are
// POLLED every frame (the connect event only fires after a button press).
// Action intents are edge-triggered here so one press = one action, no matter
// which device fired it or how many systems read the frame.
//
// The 8 gameplay actions (attack/blast/charge/interact/inventory/dodge/ping/
// pulse) are player-rebindable. Movement and the confirm/cancel menu
// meta-keys are fixed on purpose — see FIXED_KEYMAP/FIXED_PAD below.
// Bindings are a MODULE-LEVEL singleton, not per-makeInput()-instance: the
// title screen and the live game are separate makeInput() calls on the same
// page, and a rebind made from either screen's UI must apply everywhere
// immediately (and survive the makeInput() call that follows it).

import { loadBindings, saveBindings } from './save.js';

const ACTIONS = ['attack', 'blast', 'charge', 'interact', 'inventory', 'dodge', 'ping', 'pulse', 'confirm', 'cancel', 'alt'];

export const REBINDABLE_ACTIONS = ['attack', 'blast', 'charge', 'interact', 'inventory', 'dodge', 'ping', 'pulse'];
export const ACTION_LABELS = {
  attack: 'Attack', blast: 'Blast', charge: 'Charge', interact: 'Interact',
  inventory: 'Inventory', dodge: 'Dodge', ping: 'Ping', pulse: 'Pulse',
};

// Movement + menu meta-keys: never rebindable, and a gameplay action can
// never be bound onto one of these codes (would shadow movement/menu nav).
const FIXED_KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Enter: 'confirm', Escape: 'cancel',
};
const RESERVED_CODES = new Set(Object.keys(FIXED_KEYMAP));

// Defaults match the previous hardcoded KEYMAP exactly — an unmodified save
// (or first run, before bindings.js ever wrote a key) plays identically.
const DEFAULT_KEYS = {
  attack: 'KeyJ', blast: 'KeyK', charge: 'KeyL', interact: 'KeyE', inventory: 'KeyI',
  // The signature verbs of The Answering Deep: Q = a free quiet listen,
  // F = a loud aura pulse (sees/heard far). Both are edge-triggered actions.
  ping: 'KeyQ', pulse: 'KeyF', dodge: 'Space',
};

// Standard-mapping gamepad buttons (defaults, also match the previous PAD).
const DEFAULT_PAD = { attack: 0, dodge: 1, blast: 2, charge: 3, interact: 5, inventory: 9, ping: 4, pulse: 7 };
const FIXED_PAD = { confirm: 0, cancel: 1 }; // menu meta-buttons, not rebindable

// Drops anything invalid (reserved code, duplicate within the gameplay set,
// stale/foreign JSON) back to the matching default — a corrupt or old-shape
// bindings blob degrades to "play like nothing was ever rebound," never to
// a crash or a silently broken control.
function sanitizeBindings(raw) {
  const keys = {}, pad = {};
  const usedKeys = new Set(), usedPad = new Set();
  for (const a of REBINDABLE_ACTIONS) {
    const k = raw && raw.keys && raw.keys[a];
    keys[a] = (typeof k === 'string' && !RESERVED_CODES.has(k) && !usedKeys.has(k)) ? k : DEFAULT_KEYS[a];
    usedKeys.add(keys[a]);
    const p = raw && raw.pad && raw.pad[a];
    pad[a] = (Number.isInteger(p) && p >= 0 && !usedPad.has(p)) ? p : DEFAULT_PAD[a];
    usedPad.add(pad[a]);
  }
  return { keys, pad };
}

let bindings = sanitizeBindings(loadBindings());
let keyMap = buildKeyMap();

function buildKeyMap() {
  const map = { ...FIXED_KEYMAP };
  for (const a of REBINDABLE_ACTIONS) map[bindings.keys[a]] = a;
  return map;
}
function persist() { saveBindings(bindings); }

// Fresh copies out — callers (bindings UI, device-labels) must never mutate
// the live tables directly, only through setBinding/setPadBinding below.
export function getBindings() {
  return { keys: { ...bindings.keys }, pad: { ...bindings.pad } };
}

export function setBinding(action, code) {
  if (!REBINDABLE_ACTIONS.includes(action)) return { ok: false, error: 'not rebindable' };
  if (RESERVED_CODES.has(code)) return { ok: false, error: 'reserved for movement/menu' };
  for (const a of REBINDABLE_ACTIONS) {
    if (a !== action && bindings.keys[a] === code) return { ok: false, error: `already bound to ${ACTION_LABELS[a]}` };
  }
  bindings.keys[action] = code;
  keyMap = buildKeyMap();
  persist();
  return { ok: true };
}

export function setPadBinding(action, index) {
  if (!REBINDABLE_ACTIONS.includes(action)) return { ok: false, error: 'not rebindable' };
  if (!Number.isInteger(index) || index < 0) return { ok: false, error: 'invalid button' };
  for (const a of REBINDABLE_ACTIONS) {
    if (a !== action && bindings.pad[a] === index) return { ok: false, error: `already bound to ${ACTION_LABELS[a]}` };
  }
  bindings.pad[action] = index;
  persist();
  return { ok: true };
}

export function resetBindings() {
  bindings = sanitizeBindings(null);
  keyMap = buildKeyMap();
  persist();
}

export function makeInput(canvas) {
  const held = {};          // logical name -> bool (keyboard)
  const touches = new Map(); // touch id -> {x,y}
  let device = 'keyboard';   // last ACTIVE device: keyboard | touch | gamepad
  const prev = {};           // action -> was down last frame (for edges)
  let pending = {};          // presses CAPTURED at event time — a tap shorter
                             // than one frame must never be lost to sampling
  let touchZones = [];       // set each frame by the renderer (screen-space)

  window.addEventListener('keydown', (e) => {
    const name = keyMap[e.code];
    if (!name) return;
    e.preventDefault();
    held[name] = true;
    if (!e.repeat) pending[name] = true;
    device = 'keyboard';
  });
  window.addEventListener('keyup', (e) => {
    const name = keyMap[e.code];
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
      for (const a of Object.keys(FIXED_PAD)) {
        if (gp.buttons[FIXED_PAD[a]]?.pressed) { down[a] = true; any = true; }
      }
      for (const a of REBINDABLE_ACTIONS) {
        if (gp.buttons[bindings.pad[a]]?.pressed) { down[a] = true; any = true; }
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
