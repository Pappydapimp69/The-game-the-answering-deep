// Deterministic sound propagation for The Answering Deep's echo mechanic.
//
// A PING floods sound outward from an origin tile. Sound travels through open
// space and bends around corners (that's just BFS), but does NOT pass through
// solid walls — a wall is revealed (the pulse hits its face and outlines it)
// but does not conduct the sound onward. Two things come out of one flood:
//   - the REVEAL set: which tiles the player briefly sees (open tiles the
//     pulse reached, plus the wall faces bounding them);
//   - EARSHOT: which enemies heard it (BFS-distance from the origin to the
//     enemy's tile is within that enemy's `hearing`).
//
// Determinism-critical, exactly like pathfind.js: a HARDCODED neighbor order,
// a plain FIFO frontier, first-write-wins on the distance map. No floating
// point, no Math.* transcendentals, no ambient time — a pure function of
// (region, origin, radius). The reducer calls this once at ping time and bakes
// the result into authoritative state; the renderer only ever reads that
// result, so what the player sees and what the sim guarantees never diverge.

const NEIGHBORS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function inBounds(state, x, y) {
  return x >= 0 && y >= 0 && x < state.region.w && y < state.region.h;
}
function isWall(state, x, y) {
  return Object.prototype.hasOwnProperty.call(state.region.blocked, `${x},${y}`);
}

// BFS the open-tile distance field out to `maxRadius` steps from the origin.
// Returns a Map "x,y" -> integer step distance (0 at the origin). Walls are
// never entered, so they never appear as keys — but see revealSet for how
// their faces get lit.
export function echoDistanceMap(state, originX, originY, maxRadius) {
  const dist = new Map();
  if (!inBounds(state, originX, originY)) return dist;
  const startKey = `${originX},${originY}`;
  dist.set(startKey, 0);
  const queue = [[originX, originY, 0]];
  let head = 0;
  while (head < queue.length) {
    const [cx, cy, d] = queue[head++];
    if (d >= maxRadius) continue;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(state, nx, ny)) continue;
      const nKey = `${nx},${ny}`;
      if (dist.has(nKey)) continue;       // first-write-wins
      if (isWall(state, nx, ny)) continue; // sound doesn't conduct through walls
      dist.set(nKey, d + 1);
      queue.push([nx, ny, d + 1]);
    }
  }
  return dist;
}

// The set of "x,y" keys the player briefly sees from one pulse of reach
// `radius`: every open tile within `radius`, PLUS the wall faces bounding those
// tiles (so the player sees the shape of the room the echo filled, not just its
// floor). Returns a Set of strings.
export function revealSet(state, distMap, radius) {
  const lit = new Set();
  for (const [key, d] of distMap) {
    if (d > radius) continue;
    lit.add(key);
    const [x, y] = key.split(',').map(Number);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (inBounds(state, nx, ny) && isWall(state, nx, ny)) lit.add(`${nx},${ny}`);
    }
  }
  return lit;
}

// Did an enemy at (ex,ey) with the given hearing radius hear a pulse whose
// distance field is `distMap`? True iff the sound actually reached the enemy's
// tile (it's in the field) within its earshot.
export function heardAt(distMap, ex, ey, hearing) {
  const d = distMap.get(`${ex},${ey}`);
  return d !== undefined && d <= hearing;
}
