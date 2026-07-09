// Deterministic fire/hazard field for The Answering Deep. Mirrors light.js's
// structure: a small set of authoritative tiles in state.hazards.fire ("x,y"
// -> {fuel}), stepped once per TICK by a fixed-order cellular automaton, with
// every fire tile ALSO registered as a light.js source (`fire:${x},${y}`) so
// "the fire lights the room" falls out of the existing light system for free
// instead of duplicating illumination logic here.
//
// Water is not a new concept: state.region.roads ("current lanes", see
// content.js) already models where the drift/current runs, so it doubles as
// the extinguishing mechanic — fire can never ignite or spread onto a road
// tile, and reduce.js uses isWater() to douse a burning player standing on
// one. One existing set, two meanings, no new content vocabulary.
//
// Spread is a per-open-neighbor coin flip every tick, exactly one roll per
// neighbor regardless of outcome (same determinism discipline as ai.js's
// patrol rolls) — so replay stays bit-exact independent of how many neighbors
// happened to be open.

import { nextInt } from './rng.js';

export const FIRE_FUEL_TICKS = 6;
export const FIRE_SPREAD_DENOM = 3; // 1-in-3 chance per open neighbor per tick
export const FIRE_LIGHT_RADIUS = 2;
export const FIRE_LIGHT_STRENGTH = 50;
export const FIRE_BURN_DMG_BASE = 2;
export const FIRE_BURN_DMG_ROLL = 2; // damage = BASE + nextInt(rng, ROLL)
// Gameplay bound, not a coverage cap: keeps a worst-case spread from ever
// turning into an unbounded per-tick cost or an unreadable screen full of
// flame. Fuel decay still runs on every existing fire tile past this count —
// only NEW spread rolls are skipped.
export const MAX_FIRE_TILES = 60;

const SPREAD_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N, E, S, W — fixed order

export function isWater(state, x, y) {
  return Object.prototype.hasOwnProperty.call(state.region.roads, `${x},${y}`);
}

function isBlocked(state, x, y) {
  return Object.prototype.hasOwnProperty.call(state.region.blocked, `${x},${y}`);
}

function inBounds(state, x, y) {
  return x >= 0 && y >= 0 && x < state.region.w && y < state.region.h;
}

// Pure mutation: ignite (or refresh) one tile. Fizzles silently on water or a
// solid tile — no such thing as fire on a current or inside solid reef rock.
export function igniteAt(state, x, y) {
  if (isWater(state, x, y) || isBlocked(state, x, y)) return;
  state.hazards.fire[`${x},${y}`] = { fuel: FIRE_FUEL_TICKS };
}

// Called once per TICK, after any bottle-landing ignitions for this tick have
// already run. Decays fuel on every existing fire tile and rolls spread from
// a SORTED SNAPSHOT of tiles taken at the start of the call, so spread
// decisions this tick never see a tile that only just caught fire within this
// same call — deterministic and independent of object key iteration order.
export function stepFire(state) {
  const snapshotKeys = Object.keys(state.hazards.fire).sort();
  const snapshotSet = new Set(snapshotKeys);
  const ignitedThisStep = new Set();

  for (const key of snapshotKeys) {
    const tile = state.hazards.fire[key];
    if (!tile) continue; // already removed by an earlier iteration this loop (shouldn't happen, but stay safe)
    tile.fuel -= 1;
    if (tile.fuel <= 0) {
      delete state.hazards.fire[key];
      continue; // a dying ember doesn't spread
    }
    if (Object.keys(state.hazards.fire).length >= MAX_FIRE_TILES) continue; // safety valve — decay only, no new spread
    const [x, y] = key.split(',').map(Number);
    for (const [dx, dy] of SPREAD_DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(state, nx, ny)) continue;
      const nKey = `${nx},${ny}`;
      if (isBlocked(state, nx, ny) || isWater(state, nx, ny)) continue;
      if (snapshotSet.has(nKey) || ignitedThisStep.has(nKey)) continue;
      // Always roll, every open neighbor, every tick, regardless of outcome —
      // same fixed-roll-count discipline as ai.js's patrol branch.
      const catches = nextInt(state.rng, FIRE_SPREAD_DENOM) === 0;
      if (catches) {
        igniteAt(state, nx, ny);
        ignitedThisStep.add(nKey);
      }
    }
  }

  // Rebuild fire light sources from the current fire tile set.
  for (const id of Object.keys(state.light.sources)) {
    if (id.startsWith('fire:') && !Object.prototype.hasOwnProperty.call(state.hazards.fire, id.slice(5))) {
      delete state.light.sources[id];
    }
  }
  for (const key of Object.keys(state.hazards.fire)) {
    const [x, y] = key.split(',').map(Number);
    state.light.sources[`fire:${key}`] = { x, y, radius: FIRE_LIGHT_RADIUS, strength: FIRE_LIGHT_STRENGTH };
  }
  // No recomputeLight() here — the caller (reduce.js's TICK case) recomputes
  // once at the end of the tick, after bottle/player-burning lights are also
  // updated, so it's one recompute per tick, not several.
}
