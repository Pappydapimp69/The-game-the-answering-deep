// A single browser-local save slot. Plain JSON round-trip — the same
// mechanism the smoke suite already proves is bit-exact for mid-run
// save/load. Never throws on bad/foreign data; a corrupt slot just reads as
// "no save," which routes the player to New Game instead of a crash.

import { WORLD_VERSION } from '../sim/world.js';

const KEY = 'waiting-city-save-v1';
// Separate key: control bindings are a device/browser preference, not run
// state — never conflate with the world save above (different lifetime,
// different clear semantics: New Game wipes KEY, never this one).
const BINDINGS_KEY = 'answering-deep-bindings-v1';

export function hasSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    return data?.version === WORLD_VERSION;
  } catch {
    return false;
  }
}

export function saveGame(world) {
  try { localStorage.setItem(KEY, JSON.stringify(world)); } catch { /* storage full/unavailable: play on, just unsaved */ }
}

export function loadGame() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.version !== WORLD_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

// Bindings: raw { keys: {action: KeyboardEvent.code}, pad: {action: buttonIndex} }
// or null (no/unavailable/corrupt storage — caller falls back to defaults).
export function loadBindings() {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveBindings(bindings) {
  try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings)); } catch { /* storage full/unavailable: play on, unsaved */ }
}
