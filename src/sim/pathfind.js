// Deterministic integer BFS over the tile grid. Every open tile costs 1 to
// enter (no cost gradient in this content), so BFS is exactly as good as
// Dijkstra here and needs no heuristic/heap — the whole reachable set on a
// map this size fits in memory and explores in microseconds.
//
// Determinism-critical: a HARDCODED neighbor-scan order (never derived from
// object/Set iteration), a plain FIFO frontier (no re-sorting), and
// first-write-wins on the visited map. Two runs on identical state expand
// nodes in identical order and pick the identical equal-cost path, regardless
// of any JS engine's own iteration behavior.

// N, NE, E, SE, S, SW, W, NW — fixed forever.
const NEIGHBORS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function isOpen(state, x, y, occupied) {
  if (x < 0 || y < 0 || x >= state.region.w || y >= state.region.h) return false;
  const key = `${x},${y}`;
  if (Object.prototype.hasOwnProperty.call(state.region.blocked, key)) return false;
  if (occupied && occupied.has(key)) return false;
  return true;
}

// Returns the next {x,y} step from (fromX,fromY) toward (toX,toY), or null if
// already there or no path exists. `occupied` (optional Set of "x,y" strings)
// lets a mover treat other actors' CURRENT tiles as temporarily solid without
// polluting the static `region.blocked` map.
export function bfsNextStep(state, fromX, fromY, toX, toY, occupied) {
  if (fromX === toX && fromY === toY) return null;
  const startKey = `${fromX},${fromY}`;
  const targetKey = `${toX},${toY}`;
  const cameFrom = new Map([[startKey, null]]);
  const queue = [[fromX, fromY]];
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    const curKey = `${cx},${cy}`;
    if (curKey === targetKey) break;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx, ny = cy + dy;
      const nKey = `${nx},${ny}`;
      if (cameFrom.has(nKey)) continue; // first-write-wins
      // The destination tile is always a valid step target even if it's
      // "occupied" by the thing we're chasing (the player) — only the PATH
      // through other tiles respects dynamic occupancy.
      const passable = nKey === targetKey ? isOpen(state, nx, ny, null) : isOpen(state, nx, ny, occupied);
      if (!passable) continue;
      cameFrom.set(nKey, curKey);
      queue.push([nx, ny]);
    }
  }
  if (!cameFrom.has(targetKey)) return null;
  // Walk the chain back from target to start to find the first step.
  let cur = targetKey;
  let prev = cameFrom.get(cur);
  if (prev === null) return null; // target is unreachable in one step context
  while (prev !== startKey) {
    cur = prev;
    prev = cameFrom.get(cur);
    if (prev === undefined) return null;
  }
  const [sx, sy] = cur.split(',').map(Number);
  return { x: sx, y: sy };
}

// Greedy "move away" step: among the 8 fixed-order neighbors, pick the open,
// unoccupied one that maximizes Chebyshev distance from (awayX,awayY); ties
// break by the fixed neighbor order. Used for flee behavior — full BFS is
// unneeded machinery for "get away," and a fixed tie-break keeps it
// deterministic without a search.
export function stepAwayFrom(state, fromX, fromY, awayX, awayY, occupied) {
  let best = null, bestDist = -1;
  for (const [dx, dy] of NEIGHBORS) {
    const nx = fromX + dx, ny = fromY + dy;
    if (!isOpen(state, nx, ny, occupied)) continue;
    const d = Math.max(Math.abs(nx - awayX), Math.abs(ny - awayY));
    if (d > bestDist) { bestDist = d; best = { x: nx, y: ny }; }
  }
  return best;
}
