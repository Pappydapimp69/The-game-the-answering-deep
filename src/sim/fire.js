// Deterministic fire/hazard field for The Answering Deep. Mirrors light.js's
// structure: a small set of authoritative tiles in state.hazards.fire ("x,y"
// -> {fuel, generation, spawnsLeft}), stepped once per TICK by a fixed-order
// cellular automaton, with every fire tile ALSO registered as a light.js
// source (`fire:${x},${y}`) so "the fire lights the room" falls out of the
// existing light system for free instead of duplicating illumination logic
// here.
//
// Deliberately small and short-lived: FIRE_FUEL_TICKS burns out in a couple
// real seconds, and GEN_MAX_CHILDREN hard-caps the TOTAL number of ignition
// events any one thrown bottle can ever cause — a brief, local hazard, not a
// persistent blaze.
//
// Why a generation-capped spawn BUDGET instead of a geometric spread radius:
// a radius check alone doesn't stop a fire from burning forever, because a
// burnt-out tile is just deleted with no memory of having burned — a still-
// lit NEIGHBOR sharing the same radius can then re-ignite it as if fresh,
// forever ping-ponging within the radius. A budget fixes this structurally:
// each fire tile is born with a fixed `spawnsLeft` (how many children IT is
// still allowed to ever ignite, determined once by its own generation) that
// only ever decreases and never refills, so the TOTAL number of ignition
// events any one root bottle can ever cause is a fixed finite number — root
// (up to GEN_MAX_CHILDREN[0]) + each of those (up to GEN_MAX_CHILDREN[1]) +
// nothing beyond that (gen2+ has no budget) — independent of how many times
// any individual tile happens to get relit along the way. Budgets are spent
// by the SPREADING (parent) tile, not the target, so re-igniting an
// already-burnt location still draws down a real, non-renewing allowance
// instead of resetting anything for free.
//
// Water is not a new concept: state.region.roads ("current lanes", see
// content.js) already models where the drift/current runs, so it doubles as
// the extinguishing mechanic — fire can never ignite or spread onto a road
// tile, and reduce.js uses isWater() to douse a burning player standing on
// one. One existing set, two meanings, no new content vocabulary.
//
// Spread is a per-open-neighbor coin flip every tick, exactly one roll per
// neighbor regardless of outcome or remaining budget (same determinism
// discipline as ai.js's patrol rolls) — so replay stays bit-exact
// independent of how many neighbors happened to be open or how much budget a
// tile has left; only the BUDGET gates whether a catch actually ignites.
// 8-directional (diagonals included) — fire alone; movement/AI keep their
// own separate 4-directional/BFS-neighbor sets, untouched by this.

import { nextInt } from './rng.js';

// 4 ticks x TICK_MS(500ms, game.js) = 2s — "burn out after a couple seconds".
export const FIRE_FUEL_TICKS = 4;
export const FIRE_SPREAD_DENOM = 3; // 1-in-3 chance per open neighbor per tick
// How many children a fire tile of a given generation may EVER ignite over
// its whole lifetime, indexed by generation (0 = the tile the bottle landed
// on). A generation past this array's length (2+) gets 0 via the `|| 0`
// fallback where it's read — "those last fire objects can't spawn any new
// fire objects." Total ignition events from one root bottle is therefore
// capped at 1 (the root itself) + 5 (gen1) + 5*2=10 (gen2) = 16, ever.
export const GEN_MAX_CHILDREN = [5, 2];
export const FIRE_LIGHT_RADIUS = 2;
export const FIRE_LIGHT_STRENGTH = 50;
export const FIRE_BURN_DMG_BASE = 2;
export const FIRE_BURN_DMG_ROLL = 2; // damage = BASE + nextInt(rng, ROLL)
// Gameplay bound, not a coverage cap: keeps a worst-case spread from ever
// turning into an unbounded per-tick cost or an unreadable screen full of
// flame. Fuel decay still runs on every existing fire tile past this count —
// only NEW spread rolls are skipped. GEN_MAX_CHILDREN above is what actually
// keeps a single fire small (and guaranteed-terminating) in practice; this
// is just a backstop.
export const MAX_FIRE_TILES = 60;

// N, E, S, W, NE, SE, SW, NW — fixed order, 8-directional (diagonals only for
// fire; see file header).
const SPREAD_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];

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
// `generation` defaults to 0 (a fresh, root ignition — a landed bottle, a
// test calling this directly); stepFire's own spread calls pass
// `parentGeneration + 1`. `spawnsLeft` is looked up fresh from
// GEN_MAX_CHILDREN by generation — it belongs to THIS tile (how many
// children IT may still ignite), never inherited from whatever ignited it.
export function igniteAt(state, x, y, generation = 0) {
  if (isWater(state, x, y) || isBlocked(state, x, y)) return;
  state.hazards.fire[`${x},${y}`] = { fuel: FIRE_FUEL_TICKS, generation, spawnsLeft: GEN_MAX_CHILDREN[generation] || 0 };
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
      // Always roll, every open neighbor, every tick, regardless of outcome
      // OR remaining budget — same fixed-roll-count discipline as ai.js's
      // patrol branch, so the roll COUNT only ever depends on deterministic
      // geometry. Only the BUDGET (spawnsLeft) gates whether a catch
      // actually ignites — a tile with none left still rolls, it just can
      // never turn a catch into a new fire.
      const catches = nextInt(state.rng, FIRE_SPREAD_DENOM) === 0;
      if (catches && tile.spawnsLeft > 0) {
        igniteAt(state, nx, ny, tile.generation + 1);
        ignitedThisStep.add(nKey);
        tile.spawnsLeft -= 1;
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
