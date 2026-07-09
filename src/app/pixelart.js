// Procedural pixel-art blitter. A "definition" is a small grid of characters
// (row strings) plus a palette mapping each character to a color; '.' is
// always transparent. Each unique definition is rendered ONCE onto a cached
// offscreen canvas at native pixel size, then blitted scaled-up with
// smoothing disabled — the standard "hand-author pixel art as data" technique,
// no image assets or build step required.

const cache = new Map();

function build(rows, palette) {
  const h = rows.length, w = rows[0].length;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch === '.' || ch === undefined) continue;
      const hex = palette[ch];
      if (!hex) continue;
      const n = parseInt(hex.slice(1), 16);
      const i = (y * w + x) * 4;
      img.data[i] = (n >> 16) & 255;
      img.data[i + 1] = (n >> 8) & 255;
      img.data[i + 2] = n & 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return off;
}

// def: { key: 'unique-cache-key', rows: [...strings], palette: {char: '#hex'} }
function getCanvas(def) {
  let c = cache.get(def.key);
  if (!c) { c = build(def.rows, def.palette); cache.set(def.key, c); }
  return c;
}

// Draws `def` into the destination rect [x,y,size,size] on `ctx`. `filter` is
// an optional canvas 2D filter string applied only for this draw call.
export function drawPixelSprite(ctx, def, x, y, size, filter) {
  const canvas = getCanvas(def);
  const prevSmoothing = ctx.imageSmoothingEnabled;
  const prevFilter = ctx.filter;
  ctx.imageSmoothingEnabled = false;
  if (filter) ctx.filter = filter;
  ctx.drawImage(canvas, x, y, size, size);
  ctx.filter = prevFilter;
  ctx.imageSmoothingEnabled = prevSmoothing;
}
