// Deterministic enemy/car decision-making, called once per entity per TICK
// from inside reduce.js (never from the presentation layer) — this is the
// architectural choice that keeps AI replay-safe: the golden-fingerprint test
// only ever re-executes reduce() over a recorded command array, so any
// "thinking" that happened in the presentation layer instead would never
// actually be exercised by that replay, and any future AI tuning would
// silently invalidate every existing golden fixture instead of being covered
// by it. It also means AI logic only ever sees `state` (+ `state.rng` for
// randomness) — there is no wall-clock parameter available to leak, so it's
// automatically covered by the ambient-time/randomness ban this file lives
// under.
//
// Enemies: a small per-kind state machine — patrol / chase / attack (display
// only; ENEMY_STRIKE stays a separate presentation-triggered command, see
// reduce.js) / return (to post) / flee (hysteresis-gated). Currently only
// the Answerer (the boss) uses this machine. Light-averse kinds (the
// Igniter) skip it entirely for a separate hide-and-seek machine —
// decideLightAverseAction, below — with its own lurk/curious/flee states.
// Movement is a small integer BFS (src/sim/pathfind.js), never a full
// behavior tree/GOAP — overkill at a handful of enemy kinds with ~4 states.
//
// Cars: the same movement machinery in miniature — no aggro/chase at all,
// just "follow the road, roll a direction at each junction" — the friendly,
// non-hostile proof that the tech works, before it's ever used adversarially.
//
// Same-tick multi-entity resolution: every mover is processed in a FIXED
// sorted-id order (reduce.js's TICK case), against a shared `claimed` Set of
// "x,y" tile strings snapshotted at tick start and updated live as each
// mover commits — so two movers can never both claim one tile in the same
// tick, independent of iteration happenstance.

import { CONTENT } from './content.js';
import { bfsNextStep, stepAwayFrom, stepAwayFromDark } from './pathfind.js';
import { nextInt } from './rng.js';
import { lightAt } from './light.js';

// A light-averse kind won't come to rest (end a tick not actively fleeing
// or approaching) on a tile lit brighter than this, out of light.js's 0-100
// graduated scale — but it crosses brighter ground than this without any
// hesitation while actually moving somewhere. Only resting cares.
const LIGHT_IDLE_THRESHOLD = 18;

function chebyshev(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

function isOpenTile(state, x, y, claimed) {
  if (x < 0 || y < 0 || x >= state.region.w || y >= state.region.h) return false;
  const key = `${x},${y}`;
  if (Object.prototype.hasOwnProperty.call(state.region.blocked, key)) return false;
  if (claimed.has(key)) return false;
  return true;
}

function commitMove(id, mover, step, claimed) {
  if (!step) return;
  const key = `${step.x},${step.y}`;
  if (claimed.has(key)) return; // lost a race with an earlier-processed mover this tick
  claimed.delete(`${mover.x},${mover.y}`);
  claimed.add(key);
  mover.x = step.x;
  mover.y = step.y;
}

export function decideEnemyAction(state, id, claimed) {
  const e = state.enemies[id];
  const kind = CONTENT.enemyKinds[e.kind];
  const player = state.player;
  const distToPlayer = chebyshev(e, player);
  const distFromHome = chebyshev(e, { x: e.homeX, y: e.homeY });

  // Light-averse kinds (the Igniter) run an entirely separate decision
  // function — hide-and-seek, not chase-and-attack. See
  // decideLightAverseAction's own header for the state shape.
  if (kind.lightAverse) { decideLightAverseAction(state, id, e, kind, player, distToPlayer, distFromHome, claimed); return; }

  const hpPct = e.maxHp > 0 ? Math.floor((e.hp * 100) / e.maxHp) : 100;

  let next = e.aiState;
  let fleeDecided = false;
  if (kind.fleeAt) {
    const wasFleeing = e.aiState === 'flee';
    if (wasFleeing ? hpPct < kind.resumeAt : hpPct <= kind.fleeAt) { next = 'flee'; fleeDecided = true; }
    else if (wasFleeing) { next = distToPlayer <= kind.aggro ? 'chase' : 'return'; fleeDecided = true; }
  }
  if (!fleeDecided) {
    const distToHeard = e.heardX >= 0 ? chebyshev(e, { x: e.heardX, y: e.heardY }) : Infinity;
    if (e.aiState === 'chase' || e.aiState === 'attack') {
      const stillEngaged = distToPlayer <= Math.floor((kind.aggro * 3) / 2) && distFromHome <= kind.leash;
      next = stillEngaged ? (distToPlayer <= 1 ? 'attack' : 'chase') : 'return';
    } else if (e.aiState === 'search') {
      // Homing on a heard sound (last-known-position). If the player is
      // actually close, the search becomes a real chase; if we reach the
      // spot the sound came from and nothing's there, give up and go home
      // (a beat late — the Yamabiko arrives where the sound WAS).
      if (distToPlayer <= kind.aggro) next = 'chase';
      else if (e.heardX < 0 || distToHeard === 0 || distFromHome > kind.leash) {
        next = 'return'; e.heardX = -1; e.heardY = -1;
      } else next = 'search';
    } else if (e.aiState === 'return') {
      next = distFromHome === 0 ? 'patrol' : (distToPlayer <= kind.aggro ? 'chase' : 'return');
    } else {
      next = distToPlayer <= kind.aggro ? 'chase' : 'patrol';
    }
  }

  if (next !== e.aiState) { e.aiState = next; e.stateTicks = 0; }
  else e.stateTicks += 1;

  let step = null;
  if (next === 'chase') {
    step = bfsNextStep(state, e.x, e.y, player.x, player.y, claimed);
  } else if (next === 'search') {
    step = bfsNextStep(state, e.x, e.y, e.heardX, e.heardY, claimed);
  } else if (next === 'return') {
    step = bfsNextStep(state, e.x, e.y, e.homeX, e.homeY, claimed);
  } else if (next === 'flee') {
    step = stepAwayFrom(state, e.x, e.y, player.x, player.y, claimed);
  } else if (next === 'patrol' && kind.patrolRadius > 0) {
    // Two rolls, ALWAYS consumed regardless of outcome, so the roll count per
    // decision is constant and a future content change can't retroactively
    // perturb other entities' rolls within the same tick.
    const moveRoll = nextInt(state.rng, 4);
    const dirRoll = nextInt(state.rng, 4);
    if (moveRoll > 0 && distFromHome < kind.patrolRadius) {
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const [dx, dy] = dirs[dirRoll];
      const nx = e.x + dx, ny = e.y + dy;
      if (isOpenTile(state, nx, ny, claimed)) step = { x: nx, y: ny };
    }
  }
  commitMove(id, e, step, claimed);
}

// Least-lit open neighbor, fixed N/E/S/W order for a deterministic tie-break
// (first-found-equal wins, never a random pick) — used both by lurk's own
// wander and the universal "don't idle in bright light" override below.
function pickDarkestOpenNeighbor(state, x, y, claimed) {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let best = null, bestLight = Infinity;
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy;
    if (!isOpenTile(state, nx, ny, claimed)) continue;
    const l = lightAt(state, nx, ny);
    if (l < bestLight) { bestLight = l; best = { x: nx, y: ny }; }
  }
  return best;
}

// Hide-and-seek state machine for light-averse kinds (the Igniter) — replaces
// patrol/chase/attack/return/search entirely for any kind flagged
// `lightAverse` in content.js. Two axes, kept deliberately separate:
//   - DETECTION is a discrete event: state.echo.lit (a fresh pulse touching
//     this tile) means "just seen", not "standing in ambient light" — that's
//     what decides curious/lurk -> flee (and a one-shot throw if it's close
//     when it happens). Persistent standing light (torches/vents/fire/charge,
//     src/sim/light.js) never triggers this by itself.
//   - COMFORT is continuous: `lightAt()` is read only to (a) refuse to let
//     the creature settle on a bright resting tile (LIGHT_IDLE_THRESHOLD) and
//     (b) break ties when fleeing (stepAwayFromDark) — it otherwise crosses
//     lit ground freely, moving or fleeing, without hesitation.
// States: 'lurk' (default, dark-preferring idle wander) / 'curious' (noticed
// the player, approaches slowly, never inside kind.keepAway) / 'flee'
// (revealed — runs from the player, biased toward dark, until it's put
// kind.leash tiles between itself and them).
function decideLightAverseAction(state, id, e, kind, player, distToPlayer, distFromHome, claimed) {
  // Always decrements regardless of outcome, same discipline as every other
  // per-tick counter in this file — keeps replay exact independent of how
  // many ticks happened to pass revealed vs not.
  if (e.throwCooldown > 0) e.throwCooldown -= 1;

  const revealed = Object.prototype.hasOwnProperty.call(state.echo.lit, `${e.x},${e.y}`);
  let next;
  if (revealed) {
    // Startled: caught close, newly revealed (not already mid-flee), and off
    // cooldown — one throw, then it runs, exactly like any other reveal.
    // `aiState !== 'flee'` alone already stops it throwing every tick of a
    // SINGLE flee episode (echo.lit stays true for the whole reveal window);
    // the cooldown additionally paces separate flee episodes close together.
    if (e.aiState !== 'flee' && distToPlayer > 1 && distToPlayer <= kind.throwRange && e.throwCooldown === 0) {
      const bottleId = `bottle_${id}_${state.tick}`;
      const travelTicks = Math.max(1, Math.ceil(distToPlayer / 2));
      // `role: 'flashbang'` (a per-INSTANCE field, see content.js) swaps what
      // lands: a flash bottle arms instead of igniting (reduce.js's TICK
      // case), same travel physics either way.
      state.hazards.bottles[bottleId] = {
        x0: e.x, y0: e.y, x1: player.x, y1: player.y,
        startTick: state.tick, travelTicks,
        kind: e.role === 'flashbang' ? 'flash' : 'molotov',
      };
      e.throwCooldown = kind.throwCooldownTicks;
    }
    next = 'flee';
  } else if (e.aiState === 'flee') {
    // `leash` repurposed here: not distance-from-home (there is no home
    // state for this kind) but distance-from-the-player it needs before
    // it's willing to calm back down.
    next = distToPlayer > kind.leash ? 'lurk' : 'flee';
  } else if (distToPlayer <= kind.aggro) {
    next = 'curious';
  } else {
    next = 'lurk';
  }

  if (next !== e.aiState) { e.aiState = next; e.stateTicks = 0; } else e.stateTicks += 1;

  let step = null;
  if (next === 'curious') {
    // Approaches, but never closer than keepAway — recomputed fresh every
    // tick from live distance, so it also naturally backs off/holds the
    // instant the player closes the gap themselves.
    if (distToPlayer > kind.keepAway) step = bfsNextStep(state, e.x, e.y, player.x, player.y, claimed);
  } else if (next === 'flee') {
    step = stepAwayFromDark(state, e.x, e.y, player.x, player.y, claimed);
  } else {
    // lurk: identical wander shape to the standard patrol roll (same fixed
    // roll count, same patrolRadius bound) — light doesn't steer this step,
    // only whether it's ALLOWED to stay put afterward (see below).
    const moveRoll = nextInt(state.rng, 4);
    const dirRoll = nextInt(state.rng, 4);
    if (moveRoll > 0 && distFromHome < kind.patrolRadius) {
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const [dx, dy] = dirs[dirRoll];
      const nx = e.x + dx, ny = e.y + dy;
      if (isOpenTile(state, nx, ny, claimed)) step = { x: nx, y: ny };
    }
  }
  // Universal "won't stand stationary in light" rule: whenever the state
  // logic above left it holding position (step is still null — only
  // possible from 'lurk's idle roll or 'curious' already within keepAway),
  // if its CURRENT tile is bright enough to be a problem, override with one
  // corrective step toward the darkest open neighbor instead of truly
  // idling there. An active 'flee' never reaches this (stepAwayFromDark
  // only returns null if fully boxed in).
  if (!step && lightAt(state, e.x, e.y) > LIGHT_IDLE_THRESHOLD) {
    step = pickDarkestOpenNeighbor(state, e.x, e.y, claimed);
  }
  commitMove(id, e, step, claimed);
}

const CAR_DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
const DIR_ORDER = ['N', 'E', 'S', 'W'];

export function decideCarStep(state, id, claimed) {
  const c = state.cars[id];
  const isRoad = (x, y) => Object.prototype.hasOwnProperty.call(state.region.roads, `${x},${y}`);

  const candidates = [];
  for (const d of DIR_ORDER) {
    if (d === OPPOSITE[c.dir]) continue; // never reverse unless it's the only way out
    const [dx, dy] = CAR_DIRS[d];
    const nx = c.x + dx, ny = c.y + dy;
    if (isRoad(nx, ny) && !claimed.has(`${nx},${ny}`)) candidates.push(d);
  }
  if (!candidates.length) {
    const rev = OPPOSITE[c.dir];
    const [dx, dy] = CAR_DIRS[rev];
    const nx = c.x + dx, ny = c.y + dy;
    if (isRoad(nx, ny) && !claimed.has(`${nx},${ny}`)) candidates.push(rev);
  }
  // Always roll (fixed count = 1) even with a single candidate, so replay
  // stays exact regardless of how many options happened to be open.
  const idx = nextInt(state.rng, Math.max(1, candidates.length));
  if (!candidates.length) return; // boxed in this tick — sits still, still rolled
  const dir = candidates[idx];
  const [dx, dy] = CAR_DIRS[dir];
  const step = { x: c.x + dx, y: c.y + dy };
  c.dir = dir;
  commitMove(id, c, step, claimed);
}
