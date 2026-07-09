// Ordered-dither overlay sprites: fake graduated tile brightness inside a
// game whose `visible()` gate is otherwise strictly binary (src/app/renderer.js
// draws a tile or skips it entirely — see `tileLight()`/`visible()` there).
// This module only varies HOW DARK an already-visible tile reads, via a
// fixed stippled pixel pattern, never whether it's drawn at all.
//
// A soft alpha gradient would read as an out-of-place rendering technique
// next to this game's hand-authored blocky pixel art (see pixelart.js's
// build()/getCanvas(): nearest-neighbor scaling, no per-pixel alpha, small
// offscreen canvases cached by key). A dither pattern — solid on/off pixels
// whose density encodes darkness — is the same "grain" as everything else
// pixelart.js draws, so it belongs.

// Classic 4x4 Bayer ordered-dither matrix (values 0..15, a fixed threshold
// pattern, not randomized noise — that's what makes it read as deliberate
// pixel art rather than TV static). 4x4 was chosen to match TILE_SPRITES'
// own 4x4 native grid in sprites.js (groundA/groundB/roadA/roadB), so the
// dither's pixel grain is the same chunkiness as the ground tile it overlays.
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// Dark-but-not-pure-black overlay color, matching COLORS.bg in renderer.js
// (the game's own ambient-dark background). Duplicated as a literal rather
// than imported to avoid a circular import (renderer.js imports this
// module) — pixelart.js's `build()` bakes each character to a fully-opaque
// RGBA pixel (alpha is either 255 or skipped entirely, see its loop), so
// there's no per-pixel alpha to fade with; "semi-transparent" is faked by
// (a) using this near-black instead of true black, and (b) varying how many
// Bayer cells are "on" per bucket, not the color itself.
const DARK = '#05070f';

// Six darkness buckets: 0/20/40/60/80/100. Each maps to a fixed count of
// "on" cells out of the 16 in BAYER_4X4 (a pixel is on if its cell's value
// is below the bucket's threshold). The 100 bucket deliberately stops at
// 14/16, not 16/16 — a tile that's still passing `visible()` (intensity 1+)
// should read as "barely lit, but there", never fully swallowed. True black
// is reserved for tiles that fail the visibility gate and never get drawn
// at all — dithering only ever varies tiles that ARE being drawn.
const BUCKET_LEVELS = [0, 20, 40, 60, 80, 100];
const THRESHOLDS = { 0: 0, 20: 3, 40: 6, 60: 10, 80: 13, 100: 14 };

function buildDitherDef(level) {
  const threshold = THRESHOLDS[level];
  const rows = BAYER_4X4.map((row) => row.map((cell) => (cell < threshold ? 'D' : '.')).join(''));
  return { key: `dither-${level}`, rows, palette: { D: DARK } };
}

// Precomputed ONCE at module load (mirrors how PLAYER_SPRITES/ENEMY_SPRITES
// are module-level consts in sprites.js) — the per-frame ground-tile loop in
// renderer.js only ever looks these up by bucket, never rebuilds a `rows`
// array. drawPixelSprite's own cache (keyed by def.key) then makes repeated
// draws of the same bucket cheap on top of that.
export const DITHER_DEFS = Object.fromEntries(BUCKET_LEVELS.map((lv) => [lv, buildDitherDef(lv)]));

// Snaps a 0-100 darkness value to the nearest of the 6 defined buckets.
// Returns 0 for anything that rounds to no-overlay-needed.
export function ditherBucket(darkness) {
  const clamped = Math.max(0, Math.min(100, darkness));
  return Math.max(0, Math.min(100, Math.round(clamped / 20) * 20));
}
