// The carryover contract between games of the saga. Versioned forever:
// SAGA<N>.<base64 canonical JSON>.<fnv1a32 checksum>. Every sequel accepts the
// PRIOR game's code OR a fresh start — the code is a courtesy, never a wall.
//
// The Answering Deep (game 4): IMPORTS the Waiting City's saga.v3 (SAGA3) code
// to carry a run forward, and EXPORTS a saga.v4 (SAGA4) code for the finale.
// The imported choices (the Ravager's fate, the rift choice, the Warden's fate)
// are remembered and re-exported alongside this game's own choice
// (answererFate), so the chain accumulates across the whole saga.

import { stableStringify } from './canonical.js';
import { fnv1a32 } from './fingerprint.js';

// What game 4 reads (the Waiting City's output).
const IMPORT_PREFIX = 'SAGA3';
const IMPORT_VERSION = 'saga.v3';
// What game 4 writes (the finale's input).
export const SAGA_VERSION = 'saga.v4';
const EXPORT_PREFIX = 'SAGA4';

export function exportSaga(state) {
  if (!state.flags.ended) throw new Error('exportSaga: the chapter is not finished');
  const data = {
    v: SAGA_VERSION,
    game: 'answering-deep',
    archetype: state.settings.archetype,
    difficulty: state.settings.difficulty,
    skills: {
      melee: state.player.skills.melee.lvl,
      aura: state.player.skills.aura.lvl,
      perception: state.player.skills.perception.lvl,
    },
    coins: state.player.coins,
    // Answering the deep — giving it a true voice instead of the stolen one —
    // is the one technique this game grants by name.
    techniques: state.arc.choice === 'answer' ? ['deep-voice'] : [],
    choices: {
      ravagerFate: state.flags.ravagerFate || '',   // carried from the Prologue
      riftChoice: state.flags.riftChoice || '',      // carried from Wrong Sky
      wardenFate: state.flags.wardenFate || '',      // carried from the Waiting City
      answererFate: state.arc.choice,                 // 'silence' | 'answer'
    },
  };
  const json = stableStringify(data);
  const payload = btoa(json);
  return `${EXPORT_PREFIX}.${payload}.${fnv1a32(payload)}`;
}

// Returns { ok: true, data } or { ok: false, error }. Never throws on user
// input — a mistyped code is a player mistake, not a crash.
export function importSaga(code) {
  if (typeof code !== 'string') return { ok: false, error: 'not a string' };
  const parts = code.trim().split('.');
  if (parts.length !== 3 || parts[0] !== IMPORT_PREFIX) return { ok: false, error: 'not a Waiting City (saga.v3) code' };
  const [, payload, check] = parts;
  if (fnv1a32(payload) !== check) return { ok: false, error: 'checksum mismatch — mistyped or altered' };
  let data;
  try { data = JSON.parse(atob(payload)); } catch { return { ok: false, error: 'corrupt payload' }; }
  if (data.v !== IMPORT_VERSION) return { ok: false, error: `unsupported version ${data.v}` };
  for (const field of ['archetype', 'skills', 'choices']) {
    if (!data[field]) return { ok: false, error: `missing field ${field}` };
  }
  return { ok: true, data };
}
