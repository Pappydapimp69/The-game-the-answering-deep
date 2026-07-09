// Cosmetic-only smoothing of the sim's integer day/night clock. Lives in the
// presentation layer specifically so it's free to use easing math the
// authoritative sim (src/sim) must avoid for determinism.
import { DAY_CYCLE_TICKS } from '../sim/daynight.js';

// 0 (high noon) .. 1 (deep night) .. 0
export function nightAmount(tick) {
  const phase = (tick % DAY_CYCLE_TICKS) / DAY_CYCLE_TICKS;
  return (Math.cos(phase * 2 * Math.PI - Math.PI) + 1) / 2;
}
