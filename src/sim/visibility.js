// Pure, deterministic line-of-sight over `state.region.blocked` opacity
// (0-100 per tile). Lives in src/sim because opacity is authoritative content
// and this is read by enemy AI detection — but it is a READ, not a reducer:
// it never mutates state (same pattern as src/sim/info.js).
//
// Integer-only by construction: a Bresenham line is walked in pure integer
// steps; any 100-opacity occluder strictly between the two ends blocks sight
// entirely. No floats, no trig — safe for the determinism guard.

// Integer Bresenham line from (x0,y0) to (x1,y1), inclusive of both ends.
export function bresenhamLine(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0, y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}

// True if nothing fully-opaque (opacity 100) sits strictly between the two
// endpoints. Used by enemy AI to decide whether a target is actually visible
// (radius alone would see through buildings — an X-ray guard reads as buggy,
// not smart).
export function hasLineOfSight(state, x0, y0, x1, y1) {
  const blocked = state.region.blocked;
  const line = bresenhamLine(x0, y0, x1, y1);
  for (let i = 1; i < line.length - 1; i++) {
    const [lx, ly] = line[i];
    if (blocked[`${lx},${ly}`] >= 100) return false;
  }
  return true;
}

// Returns a Map of "x,y" -> clarity (0-100 integer; 100 = fully lit/visible,
// 0 = fully shadowed) for every tile within `radius` Chebyshev tiles of
// (originX, originY). The origin tile itself is always fully clear. Not
// currently consumed by the renderer (this city has no darkness facet), but
// kept as the general-purpose partial-occluder version of the LOS check
// above, for any future content that wants graded visibility.
export function computeVisibility(state, originX, originY, radius) {
  const clarity = new Map();
  const blocked = state.region.blocked;
  const w = state.region.w, h = state.region.h;
  const minX = Math.max(0, originX - radius), maxX = Math.min(w - 1, originX + radius);
  const minY = Math.max(0, originY - radius), maxY = Math.min(h - 1, originY + radius);

  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (Math.max(Math.abs(tx - originX), Math.abs(ty - originY)) > radius) continue;
      const key = `${tx},${ty}`;
      if (tx === originX && ty === originY) { clarity.set(key, 100); continue; }
      const line = bresenhamLine(originX, originY, tx, ty);
      let c = 100;
      for (let i = 1; i < line.length - 1; i++) {
        const [lx, ly] = line[i];
        const op = blocked[`${lx},${ly}`];
        if (op) c = Math.floor((c * (100 - op)) / 100);
        if (c <= 0) break;
      }
      clarity.set(key, Math.max(0, c));
    }
  }
  return clarity;
}
