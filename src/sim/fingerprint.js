// Compact state fingerprint: FNV-1a 32-bit over the canonical serialization.
// Used by the golden replay test — any leaked nondeterminism (ambient
// randomness, time reads, unordered iteration) diverges the hash.

import { stableStringify } from './canonical.js';

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function fingerprint(state) {
  return fnv1a32(stableStringify(state));
}
