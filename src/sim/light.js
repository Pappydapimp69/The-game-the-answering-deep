// Deterministic light-field computation for The Answering Deep. Persistent
// light sources (unlike echo's momentary pulse-then-decay) — recomputed
// fresh from the CURRENT source list whenever a source is added, removed, or
// moved, never aged out tile-by-tile the way state.echo.lit is.
//
// A source is blocked by walls exactly like sound is (a shadow is just an
// echo you can't see) — reuses sound.js's integer BFS open-tile distance
// field rather than duplicating it, so both systems agree on what "the light/
// sound reaches this tile" means.
//
// Multiple overlapping sources ADD (clamped to 100), so two dim lights make
// a brighter patch than either alone — the same "more exposure = more
// visible" logic the echo mechanic already uses, just continuous instead of
// momentary.

import { echoDistanceMap } from './sound.js';

// Recompute state.light.tiles ("x,y" -> integer intensity 0-100) from
// state.light.sources (id -> {x,y,radius,strength}). Pure over state +
// content; no time, no Math transcendentals, no ambient anything.
export function recomputeLight(state) {
  const tiles = {};
  for (const src of Object.values(state.light.sources)) {
    if (src.radius <= 0 || src.strength <= 0) continue;
    const dist = echoDistanceMap(state, src.x, src.y, src.radius);
    const falloffPerStep = Math.ceil(src.strength / src.radius);
    for (const [key, d] of dist) {
      const intensity = Math.max(0, src.strength - d * falloffPerStep);
      if (intensity <= 0) continue;
      tiles[key] = Math.min(100, (tiles[key] || 0) + intensity);
    }
  }
  state.light.tiles = tiles;
}

// The light level (0-100) the sim/renderer agree a tile currently has from
// light sources alone — does NOT include the echo pulse or the player's
// always-on ambient-sight radius, which are separate modalities layered on
// top by the caller (reduce.js's isLit / renderer.js's tileLight).
export function lightAt(state, x, y) {
  return state.light.tiles[`${x},${y}`] || 0;
}
