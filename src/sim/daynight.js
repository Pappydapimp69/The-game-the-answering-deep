// Day/night as a WORLD-CLOCK decision, not a lighting effect: night raises
// enemy aggression, so the clock converts "one more fight" into a real
// risk/reward call. Driven entirely by state.tick (deterministic, no
// ambient clock reads) so it round-trips through save/load and replay.
// Integer-only — cosmetic smoothing (any transcendental easing) belongs in
// the presentation layer, never here (src/sim bans engine-varying Math).

export const DAY_CYCLE_TICKS = 120; // ~60s of real ticks at TICK_MS=500

export function isNight(tick) {
  return (tick % DAY_CYCLE_TICKS) >= DAY_CYCLE_TICKS / 2;
}
