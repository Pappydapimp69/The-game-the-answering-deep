// Device-adaptive control hints: never make the player translate — show the
// glyph of the device actually in their hands. A modal/title button's
// on-screen prompt must match whatever input device is currently active,
// re-derived every frame (so switching keyboard -> gamepad mid-modal updates
// the text live, not just at the moment the modal was created).
//
// Gameplay actions (REBINDABLE_ACTIONS) are player-rebindable, so their
// hint text is read live from input.js's bindings, never hardcoded — a
// rebind takes effect in every hint on screen the very next frame.

import { REBINDABLE_ACTIONS, getBindings } from './input.js';

// Menu meta-keys + movement are fixed (see input.js) so their hints are too.
// 'alt' has no dedicated physical input of its own — by convention it always
// mirrors 'blast', the dedicated hold-to-dismiss button.
const FIXED_KEYBOARD = { confirm: 'Enter', cancel: 'Esc', up: 'W', down: 'S', left: 'A', right: 'D' };
const FIXED_GAMEPAD = { confirm: 'A', cancel: 'B', up: 'D-Pad', down: 'D-Pad', left: 'D-Pad', right: 'D-Pad' };
const ALIAS = { alt: 'blast' };

const PAD_BUTTON_NAMES = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'Back', 9: 'Start', 10: 'LS', 11: 'RS', 12: 'D↑', 13: 'D↓', 14: 'D←', 15: 'D→',
};

// KeyboardEvent.code -> a short glyph for display ("KeyJ" -> "J").
export function codeLabel(code) {
  if (!code) return '?';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  return code;
}
export function padButtonLabel(index) {
  return index == null ? '?' : (PAD_BUTTON_NAMES[index] || `Btn ${index}`);
}

// action: 'confirm' | 'cancel' | 'alt' | any REBINDABLE_ACTIONS id (the same
// ids modal/title buttons and the world input vocabulary use — 'blast' is
// the dedicated press-and-hold-to-dismiss control for single-option modals,
// deliberately a different physical button than confirm/attack).
export function keyHint(device, action) {
  if (device === 'touch') return ''; // the button IS the input; no hint needed
  const a = ALIAS[action] || action;
  if (device === 'gamepad') {
    if (FIXED_GAMEPAD[a]) return FIXED_GAMEPAD[a];
    if (REBINDABLE_ACTIONS.includes(a)) return padButtonLabel(getBindings().pad[a]);
    return '';
  }
  if (FIXED_KEYBOARD[a]) return FIXED_KEYBOARD[a];
  if (REBINDABLE_ACTIONS.includes(a)) return codeLabel(getBindings().keys[a]);
  return '';
}

// Appends " (Hint)" to a base label, or nothing on touch.
export function withHint(device, action, baseLabel) {
  const hint = keyHint(device, action);
  return hint ? `${baseLabel} (${hint})` : baseLabel;
}
