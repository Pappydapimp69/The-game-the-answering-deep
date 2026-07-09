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
// reduce.js) / return (to post) / flee (one kind only, hysteresis-gated).
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
import { bfsNextStep, stepAwayFrom } from './pathfind.js';
import { nextInt } from './rng.js';

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

  // Projectile-armed kinds (e.g. igniter) throw a molotov at range instead of
  // closing to melee. Bottle travel/landing is NOT decided here — it's
  // TICK-level bookkeeping in reduce.js, so every bottle (including one just
  // created this tick) is processed by one piece of uniform code, never
  // duplicated between "just thrown" and "already in flight".
  if (kind.throwRange) {
    if (e.throwCooldown > 0) e.throwCooldown -= 1;
    if (next === 'chase' && distToPlayer > 1 && distToPlayer <= kind.throwRange && e.throwCooldown === 0) {
      const bottleId = `bottle_${id}_${state.tick}`;
      const travelTicks = Math.max(1, Math.ceil(distToPlayer / 2));
      state.hazards.bottles[bottleId] = {
        x0: e.x, y0: e.y, x1: player.x, y1: player.y,
        startTick: state.tick, travelTicks,
      };
      e.throwCooldown = kind.throwCooldownTicks;
      return; // stands still to throw — skips the movement step below entirely
    }
  }

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
