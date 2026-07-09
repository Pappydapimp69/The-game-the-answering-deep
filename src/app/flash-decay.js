// Cosmetic-only decay curve for the flashbang's screen-whiteout (a role
// variant of the Igniter's thrown attack — see content.js/ai.js/reduce.js).
// The sim only ever emits ONE discrete event at detonation (`flash_detonated`,
// carrying a 0-100 `intensity` from proximity) — same authoritative-event +
// wall-clock-animated-cosmetic split as the existing aura-fade/ping-ring
// effects (src/app/game.js). Lives here, not in src/sim, specifically so it's
// free to use real elapsed-ms math the sim must avoid for determinism.
//
// The requested shape is the CHARGE ramp (reduce.js's CHARGE case) run in
// reverse: charging gains fast then eases off near its cap; this decays fast
// through the 20-100 band, then eases into a long, slow tail through 0-20 —
// a flash that's blinding for an instant, then lingers as a dim afterimage
// for a while before finally clearing.
const FAST_DECAY_PER_MS = 0.09; // 20..100 band
const SLOW_DECAY_PER_MS = 0.015; // 0..20 band
const BAND_SPLIT = 20;

// Whiteout opacity (0-100) at `elapsedMs` after a flash of starting
// `intensity` (0-100) went off.
export function flashOpacity(intensity, elapsedMs) {
  const start = Math.max(0, Math.min(100, intensity));
  if (elapsedMs <= 0) return start;
  if (start <= BAND_SPLIT) {
    return Math.max(0, start - elapsedMs * SLOW_DECAY_PER_MS);
  }
  const fastSpan = start - BAND_SPLIT;
  const fastDuration = fastSpan / FAST_DECAY_PER_MS;
  if (elapsedMs < fastDuration) return start - elapsedMs * FAST_DECAY_PER_MS;
  const slowElapsed = elapsedMs - fastDuration;
  return Math.max(0, BAND_SPLIT - slowElapsed * SLOW_DECAY_PER_MS);
}
