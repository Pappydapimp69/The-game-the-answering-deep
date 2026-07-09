// Canvas renderer. Receives the world through the read-only proxy — it can look
// at everything and touch nothing. Continuous cosmetic detail (smooth sprite
// positions, camera, toast fades, day/night tint) lives HERE, never in
// authoritative state. Returns this frame's touch/click zones so input
// hit-tests what was drawn.
//
// THE WAITING CITY's visual signature: buildings taller than the player,
// drawn extending upward from their footprint. When the player's tile sits
// north of a building (and within its width), the building fades to partial
// alpha instead of just occluding — walking "behind" a building reveals it,
// the classic top-down tall-object trick, applied to real architecture for
// the first time in this saga. This is pure presentation (globalAlpha on an
// ordinary fillRect) — no offscreen-buffer compositing needed here, unlike
// Wrong Sky's grayscale/kaleidoscope reveal: alpha is cheap per call. The one
// ctx.filter use in this file (a one-line NPC recolor, reusing the player
// sprite for city folk) runs on a literal handful of draws per frame, not the
// hundreds-of-tiles hot loop that made per-call filtering expensive in Wrong
// Sky — that lesson applies to loops over the map/entities, not a couple of
// named NPCs.
//
// The camera follows the player and clamps to the region so the world fills
// the viewport at any resolution. HUD/text is anchored in screen space with
// its OWN scale — world scale and text scale are separate on purpose.

import { canSense, enemyReadout } from '../sim/info.js';
import { withHint, keyHint } from './device-labels.js';
import { describeObjective } from './objective-text.js';
import { drawPixelSprite } from './pixelart.js';
import { PLAYER_SPRITES, BLAST_SPRITE, ENEMY_SPRITES, CAR_SPRITE, TILE_SPRITES } from './sprites.js';

export const TILE = 24;

export const COLORS = {
  bg: '#05070f', ground: '#141a2e', grid: '#1b2340',
  player: '#ffb74d', aura: '#7ec8ff', npc: '#6de0c2', enemy: '#e05a5a',
  dead: '#3a3f52', crate: '#a1745b', pickup: '#ffd75e', text: '#e6ebf7',
  dim: '#98a3c0', hp: '#e05a5a', bar: '#1a2140', good: '#8ff0a6',
  rival: '#caa23a',
};

const BUILDING_COLORS = {
  depot: '#4a4438', tenement: '#3c3a44', hall: '#5c4e28', barracks: '#3a3232',
};
const BUILDING_FADE_ALPHA = 0.35;

// Charge-only DBZ-style flame overlay (ported from Wrong Sky, where it
// replaced an always-on aura ring). Full opacity while charging; on release
// it fades over a duration set by game.js from the aura-% held at release
// (below 80% -> 100ms; 80-100% -> scales 200ms to 500ms).
function auraFlameAlpha(view, now) {
  if (view.charging) return 1;
  if (view.auraFadeActive) {
    const elapsed = now - view.auraFadeStart;
    if (elapsed < view.auraFadeDuration) return Math.max(0, 1 - elapsed / view.auraFadeDuration);
  }
  return 0;
}
function drawAuraFlame(ctx, cx, topY, alpha, now) {
  const t = now * 0.006;
  const flicker = Math.sin(t) * 2;
  const flicker2 = Math.sin(t * 1.7 + 1) * 1.5;
  ctx.save();
  ctx.globalAlpha = alpha;
  const grad = ctx.createLinearGradient(0, topY, 0, topY - TILE * 0.9);
  grad.addColorStop(0, 'rgba(126,200,255,0.9)');
  grad.addColorStop(1, 'rgba(126,200,255,0)');
  ctx.fillStyle = grad;
  drawLick(ctx, cx - 4 + flicker * 0.4, topY, TILE * 0.22, TILE * 0.55);
  drawLick(ctx, cx + flicker, topY, TILE * 0.28, TILE * 0.75);
  drawLick(ctx, cx + 4 + flicker2 * 0.4, topY, TILE * 0.2, TILE * 0.5);
  ctx.restore();
}
function drawLick(ctx, x, baseY, width, height) {
  ctx.beginPath();
  ctx.moveTo(x - width / 2, baseY);
  ctx.quadraticCurveTo(x - width * 0.6, baseY - height * 0.5, x, baseY - height);
  ctx.quadraticCurveTo(x + width * 0.6, baseY - height * 0.5, x + width / 2, baseY);
  ctx.closePath();
  ctx.fill();
}

export function render(ctx, w, view, now = 0) {
  const { canvas } = ctx;
  const W = canvas.width, H = canvas.height;
  const zones = [];
  const C = COLORS;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // --- camera + world scale ------------------------------------------------
  // Fit 16 tiles along the SHORTER screen dimension, not always H. A fixed
  // H-only fit assumes landscape (W > H, so H is the constraining axis) —
  // on a mobile portrait screen H is the LARGER raw-pixel dimension (often
  // taller than any desktop window), so locking 16 tiles to it blew the
  // scale up and left only a sliver of width on screen. min(W, H) keeps
  // desktop/landscape behavior identical (H was already the smaller side
  // there) while giving portrait screens the same tile size and a sane,
  // wider-than-tall field of view instead of an over-zoomed crop.
  const scale = Math.min(W, H) / (16 * TILE);
  const regionWpx = w.region.w * TILE, regionHpx = w.region.h * TILE;
  const viewWpx = W / scale, viewHpx = H / scale;
  const centerX = view.px * TILE + TILE / 2, centerY = view.py * TILE + TILE / 2;
  const camX = clampCam(centerX - viewWpx / 2, regionWpx, viewWpx);
  const camY = clampCam(centerY - viewHpx / 2, regionHpx, viewHpx);
  ctx.setTransform(scale, 0, 0, scale, -camX * scale + (view.shakeX || 0), -camY * scale + (view.shakeY || 0));

  const pad = 1;
  const minTX = Math.max(0, Math.floor(camX / TILE) - pad);
  const maxTX = Math.min(w.region.w - 1, Math.floor((camX + viewWpx) / TILE) + pad);
  const minTY = Math.max(0, Math.floor(camY / TILE) - pad);
  const maxTY = Math.min(w.region.h - 1, Math.floor((camY + viewHpx) / TILE) + pad);
  const onScreen = (x, y) => x >= minTX - pad && x <= maxTX + pad && y >= minTY - pad && y <= maxTY + pad;

  // --- ground: sidewalk vs road (culled) -----------------------------------
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const isRoad = Object.prototype.hasOwnProperty.call(w.region.roads, `${tx},${ty}`);
      const even = (tx + ty) % 2 === 0;
      const def = isRoad ? (even ? TILE_SPRITES.roadA : TILE_SPRITES.roadB) : (even ? TILE_SPRITES.groundA : TILE_SPRITES.groundB);
      drawPixelSprite(ctx, def, tx * TILE, ty * TILE, TILE);
    }
  }

  // --- build the drawable list (ground-level entities, Y-sorted) ----------
  const drawables = [];
  const add = (x, y, fn) => { if (onScreen(x, y)) drawables.push({ x, y, fn }); };

  for (const id of Object.keys(w.destructibles)) {
    const d = w.destructibles[id];
    add(d.x, d.y, () => {
      const [x, y] = tile(d.x, d.y);
      if (d.broken) { ctx.strokeStyle = C.crate; ctx.strokeRect(x + 6, y + 6, TILE - 12, TILE - 12); }
      else { ctx.fillStyle = C.crate; fillSquashed(ctx, x + 4, y + 4, TILE - 8, TILE - 8, view.punch[id] || 0); }
    });
  }
  for (const id of Object.keys(w.pickups)) {
    const p = w.pickups[id];
    if (p.taken) continue;
    add(p.x, p.y, () => {
      const [x, y] = tile(p.x, p.y);
      ctx.fillStyle = C.pickup;
      ctx.beginPath();
      ctx.moveTo(x + TILE / 2, y + 5); ctx.lineTo(x + TILE - 5, y + TILE / 2);
      ctx.lineTo(x + TILE / 2, y + TILE - 5); ctx.lineTo(x + 5, y + TILE / 2);
      ctx.closePath(); ctx.fill();
    });
  }
  for (const id of Object.keys(w.npcs)) {
    const n = w.npcs[id];
    add(n.x, n.y, () => {
      const [x, y] = tile(n.x, n.y);
      drawPixelSprite(ctx, PLAYER_SPRITES['down-0'], x + 2, y + 2, TILE - 4, 'grayscale(0.6) brightness(0.85) hue-rotate(140deg)');
      ctx.fillStyle = C.dim;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(n.name, x + TILE / 2, y - 3);
      ctx.textAlign = 'left';
    });
  }
  for (const id of Object.keys(w.enemies)) {
    const e = w.enemies[id];
    const isBoss = id === w.arc.bossDef.id;
    add(e.x, e.y, () => {
      const [x, y] = tile(e.x, e.y);
      const big = isBoss ? 5 : 0;
      const def = ENEMY_SPRITES[e.kind];
      if (def) {
        const f = e.alive ? 'none' : 'grayscale(1) brightness(0.4)';
        drawPixelSprite(ctx, def, x + 2 - big, y + 2 - big, TILE - 4 + big * 2, f);
      } else {
        ctx.fillStyle = !e.alive ? C.dead : (isBoss ? C.rival : C.enemy);
        fillSquashed(ctx, x + 5 - big, y + 5 - big, TILE - 10 + big * 2, TILE - 10 + big * 2, view.punch[id] || 0);
      }
      if (e.alive) {
        if (canSense(w.player, e.kind)) {
          ctx.fillStyle = C.bar; ctx.fillRect(x + 3, y - 6, TILE - 6, 3);
          ctx.fillStyle = C.hp; ctx.fillRect(x + 3, y - 6, (TILE - 6) * (e.hp / e.maxHp), 3);
        }
        ctx.fillStyle = C.dim; ctx.font = '8px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(enemyReadout(w.player, e), x + TILE / 2, y - 9); ctx.textAlign = 'left';
      }
    });
  }
  for (const id of Object.keys(w.cars)) {
    const cr = w.cars[id];
    add(cr.x, cr.y, () => {
      const [x, y] = tile(cr.x, cr.y);
      const rot = { N: 0, E: 90, S: 180, W: 270 }[cr.dir] || 0;
      ctx.save();
      ctx.translate(x + TILE / 2, y + TILE / 2);
      ctx.rotate((rot * Math.PI) / 180);
      drawPixelSprite(ctx, CAR_SPRITE, -TILE / 2, -TILE / 2, TILE);
      ctx.restore();
    });
  }
  const ppx = view.px * TILE, ppy = view.py * TILE;
  add(view.px, view.py, () => {
    if (view.dodging) ctx.globalAlpha = 0.45;
    const key = view.charging ? 'charge' : `${view.facing === 'left' || view.facing === 'right' ? 'side' : view.facing}-${view.walkFrame}`;
    const def = PLAYER_SPRITES[key] || PLAYER_SPRITES['down-0'];
    if (view.facing === 'right') {
      ctx.save();
      ctx.translate(ppx + TILE, ppy);
      ctx.scale(-1, 1);
      drawPixelSprite(ctx, def, 0, 0, TILE);
      ctx.restore();
    } else {
      drawPixelSprite(ctx, def, ppx, ppy, TILE);
    }
    const auraAlpha = auraFlameAlpha(view, now);
    if (auraAlpha > 0) drawAuraFlame(ctx, ppx + TILE / 2, ppy + TILE * 0.2, auraAlpha, now);
    ctx.globalAlpha = 1;
  });

  // Depth: Y-sort + ground shadows (cheap always-on depth cue; this game has
  // no separate "light restored" facet gating it).
  drawables.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const d of drawables) {
    const [x, y] = tile(d.x, d.y);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.ellipse(x + TILE / 2, y + TILE - 3, TILE * 0.34, TILE * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  }
  for (const d of drawables) d.fn();

  // Blast projectiles: presentation-only, lerped between cast and target.
  for (const p of view.projectiles) {
    const t = Math.max(0, Math.min(1, (now - p.start) / p.duration));
    const px = (p.x0 + (p.x1 - p.x0) * t) * TILE + TILE / 2;
    const py = (p.y0 + (p.y1 - p.y0) * t) * TILE + TILE / 2;
    drawPixelSprite(ctx, BLAST_SPRITE, px - TILE * 0.3, py - TILE * 0.3, TILE * 0.6);
  }

  // --- buildings: drawn LAST among world-space content, so they occlude the
  // ground-level layer below them, but fade when the player stands north of
  // (behind) their footprint — the signature "walk behind a tall building"
  // reveal. Cheap: plain fillRect + globalAlpha, no filter, no offscreen
  // buffer needed.
  for (const [bid, b] of Object.entries(w.region.buildings)) {
    if (!onScreen(b.x, b.y) && !onScreen(b.x + b.w - 1, b.y + b.h - 1)) continue;
    const bx = b.x * TILE, by = b.y * TILE;
    const width = b.w * TILE, footHeight = b.h * TILE;
    const riseHeight = b.floors * TILE;
    const topY = by - riseHeight;
    const behind = view.py < b.y && view.px >= b.x - 1 && view.px <= b.x + b.w;
    ctx.globalAlpha = behind ? BUILDING_FADE_ALPHA : 1;
    ctx.fillStyle = BUILDING_COLORS[bid] || '#4a4a52';
    ctx.fillRect(bx, topY, width, footHeight + riseHeight);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let floor = 0; floor < b.floors + 1; floor++) {
      ctx.fillRect(bx, topY + floor * TILE, width, 2);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let wx = bx + TILE * 0.6; wx < bx + width; wx += TILE) {
      ctx.strokeRect(wx, topY + TILE * 0.4, TILE * 0.35, TILE * 0.5);
    }
    ctx.globalAlpha = 1;
  }

  // --- HUD (screen space, its own scale) -----------------------------------
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (view.night > 0.05) {
    ctx.fillStyle = `rgba(8,12,34,${(view.night * 0.3).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  const u = clamp(H / 540, 0.85, 3);
  ctx.textAlign = 'left';
  const pad2 = 12 * u;

  bar(ctx, pad2, pad2, 150 * u, 12 * u, w.player.hp / w.player.maxHp, COLORS.hp, `HP ${w.player.hp}/${w.player.maxHp}`, u);
  bar(ctx, pad2, pad2 + 18 * u, 150 * u, 12 * u, w.player.aura / w.player.maxAura, COLORS.aura, `Aura ${w.player.aura}/${w.player.maxAura}`, u);
  ctx.fillStyle = COLORS.pickup; ctx.font = `${12 * u}px system-ui, sans-serif`;
  ctx.fillText(`⛁ ${w.player.coins}`, pad2 + 162 * u, pad2 + 10 * u);
  ctx.fillStyle = COLORS.dim;
  const sk = w.player.skills;
  ctx.fillText(`Melee ${sk.melee.lvl} · Aura ${sk.aura.lvl} · Per ${sk.perception.lvl}`, pad2 + 162 * u, pad2 + 28 * u);

  const activeIds = Object.keys(w.quests.active).sort();
  if (activeIds.length) {
    ctx.textAlign = 'right';
    let qy = pad2 + 4 * u;
    for (const qId of activeIds) {
      ctx.fillStyle = COLORS.text; ctx.font = `${12 * u}px system-ui, sans-serif`;
      ctx.fillText(w.quests.defs[qId].name, W - pad2, qy); qy += 15 * u;
      const def = w.quests.defs[qId], st = w.quests.active[qId];
      ctx.fillStyle = COLORS.dim; ctx.font = `${11 * u}px system-ui, sans-serif`;
      def.objectives.forEach((o, i) => {
        const done = st.progress[i] >= (o.n || 1);
        ctx.fillStyle = done ? COLORS.good : COLORS.dim;
        ctx.fillText(`${done ? '✓' : '•'} ${describeObjective(o)} ${st.progress[i]}/${o.n || 1}`, W - pad2, qy);
        qy += 14 * u;
      });
    }
    ctx.textAlign = 'left';
  }

  if (view.guide) {
    ctx.fillStyle = COLORS.pickup; ctx.font = `italic ${13 * u}px system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(view.guide, W / 2, pad2 + 6 * u); ctx.textAlign = 'left';
  }

  ctx.font = `${12 * u}px system-ui, sans-serif`;
  view.toasts.forEach((t, i) => {
    ctx.globalAlpha = Math.max(0, Math.min(1, t.ttl / 600));
    ctx.fillStyle = COLORS.good;
    ctx.fillText(t.text, pad2, H - 40 * u - i * 16 * u);
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = COLORS.dim; ctx.font = `${11 * u}px system-ui, sans-serif`;
  const legends = {
    keyboard: 'Move WASD · Attack J · Blast K · Charge L · Interact E · Items I · Dodge Space',
    gamepad: 'Move Stick/D-Pad · Attack A · Blast X · Charge Y · Interact RB · Items Start · Dodge B',
    touch: 'On-screen pad and buttons',
  };
  ctx.fillText(legends[view.device] || legends.keyboard, pad2, H - 10 * u);

  if (view.device === 'touch') {
    const dz = 42 * u, cx = 70 * u, cy = H - 92 * u;
    const dirs = [
      { id: 'up', x: cx - dz / 2, y: cy - dz * 1.5, label: '▲' },
      { id: 'down', x: cx - dz / 2, y: cy + dz / 2, label: '▼' },
      { id: 'left', x: cx - dz * 1.5, y: cy - dz / 2, label: '◀' },
      { id: 'right', x: cx + dz / 2, y: cy - dz / 2, label: '▶' },
    ];
    for (const d of dirs) zones.push(touchBtn(ctx, { ...d, w: dz, h: dz }, u));
    const acts = [
      { id: 'attack', label: 'ATK' }, { id: 'blast', label: 'BLAST' }, { id: 'charge', label: 'CHG' },
      { id: 'interact', label: 'USE' }, { id: 'inventory', label: 'BAG' }, { id: 'dodge', label: 'DODGE' },
    ];
    acts.forEach((a, i) => {
      zones.push(touchBtn(ctx, { ...a, w: 64 * u, h: 34 * u, x: W - 74 * u, y: H - 52 * u - i * 40 * u }, u));
    });
  }

  if (view.modal) zones.push(...drawModal(ctx, W, H, u, view));

  return zones;

  function tile(x, y) { return [x * TILE, y * TILE]; }
}

// --- modal ------------------------------------------------------------------
function drawModal(ctx, W, H, u, view) {
  const zones = [];
  const m = view.modal;
  ctx.fillStyle = 'rgba(3,5,12,0.85)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';

  ctx.fillStyle = COLORS.text; ctx.font = `bold ${17 * u}px system-ui, sans-serif`;
  const lines = m.lines || [];
  const startY = Math.max(60 * u, H / 2 - (lines.length * 20 * u + 80 * u) / 2);
  ctx.fillText(m.title, W / 2, startY);
  let ly = startY + 30 * u;
  for (const line of lines) {
    if (line.length > 56) { ctx.font = `${11 * u}px ui-monospace, monospace`; ctx.fillStyle = COLORS.good; }
    else { ctx.font = `${14 * u}px system-ui, sans-serif`; ctx.fillStyle = COLORS.dim; }
    ctx.fillText(line, W / 2, ly, W - 48 * u);
    ly += 20 * u;
  }
  ly += 12 * u;

  const opts = m.options;
  if (opts.length === 1) {
    const bw = 220 * u, bh = 38 * u, x = W / 2 - bw / 2, y = ly;
    ctx.fillStyle = 'rgba(136,146,176,0.16)';
    ctx.strokeStyle = 'rgba(136,146,176,0.6)';
    ctx.fillRect(x, y, bw, bh); ctx.strokeRect(x, y, bw, bh);
    if (m.holdProgress > 0) {
      ctx.fillStyle = 'rgba(143,240,166,0.35)';
      ctx.fillRect(x, y, bw * m.holdProgress, bh);
    }
    ctx.fillStyle = COLORS.text; ctx.font = `bold ${13 * u}px system-ui, sans-serif`;
    const label = view.device === 'touch'
      ? `Tap to ${opts[0].label}`
      : withHint(view.device, 'blast', `Hold to ${opts[0].label}`);
    ctx.fillText(label, x + bw / 2, y + bh / 2 + 5 * u);
    zones.push({ id: opts[0].id, x, y, w: bw, h: bh });
  } else {
    opts.forEach((opt, i) => {
      const bw = 260 * u, bh = 34 * u, x = W / 2 - bw / 2, y = ly + i * (bh + 8 * u);
      const on = m.sel === i;
      ctx.fillStyle = 'rgba(136,146,176,0.16)';
      ctx.strokeStyle = on ? COLORS.pickup : 'rgba(136,146,176,0.5)';
      ctx.lineWidth = on ? 2 : 1;
      ctx.fillRect(x, y, bw, bh); ctx.strokeRect(x, y, bw, bh); ctx.lineWidth = 1;
      ctx.fillStyle = COLORS.text; ctx.font = `${13 * u}px system-ui, sans-serif`;
      ctx.fillText(opt.usable === false ? `${opt.label} (key item)` : opt.label, x + bw / 2, y + bh / 2 + 4 * u);
      zones.push({ id: opt.id, x, y, w: bw, h: bh });
    });
    if (view.device !== 'touch') {
      const upDown = keyHint(view.device, 'up') === keyHint(view.device, 'down')
        ? keyHint(view.device, 'up')
        : `${keyHint(view.device, 'up')}/${keyHint(view.device, 'down')}`;
      ctx.fillStyle = COLORS.dim; ctx.font = `${11 * u}px system-ui, sans-serif`;
      ctx.fillText(
        `${upDown} choose · ${keyHint(view.device, 'confirm')} select · ${keyHint(view.device, 'cancel')} back out`,
        W / 2, ly + opts.length * (34 * u + 8 * u) + 16 * u,
      );
    }
  }
  ctx.textAlign = 'left';
  return zones;
}

// --- helpers ----------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clampCam(v, worldSize, viewSize) {
  if (worldSize <= viewSize) return (worldSize - viewSize) / 2;
  return clamp(v, 0, worldSize - viewSize);
}

function fillSquashed(ctx, x, y, w, h, strength, stretch = false) {
  if (!strength) { ctx.fillRect(x, y, w, h); return; }
  const amt = 0.35 * strength;
  const sx = stretch ? 1 - amt * 0.6 : 1 + amt;
  const sy = stretch ? 1 + amt * 0.6 : 1 - amt;
  const cx = x + w / 2, cy = y + h / 2, nw = w * sx, nh = h * sy;
  ctx.fillRect(cx - nw / 2, cy - nh / 2, nw, nh);
}

function bar(ctx, x, y, w, h, frac, color, label, u) {
  ctx.fillStyle = COLORS.bar; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
  ctx.fillStyle = COLORS.text; ctx.font = `${9 * u}px system-ui, sans-serif`;
  ctx.fillText(label, x + 4 * u, y + h - 2.5 * u);
}

function touchBtn(ctx, z, u = 1) {
  ctx.fillStyle = 'rgba(136,146,176,0.18)';
  ctx.strokeStyle = 'rgba(136,146,176,0.6)';
  ctx.fillRect(z.x, z.y, z.w, z.h); ctx.strokeRect(z.x, z.y, z.w, z.h);
  ctx.fillStyle = COLORS.text; ctx.font = `bold ${12 * u}px system-ui, sans-serif`; ctx.textAlign = 'center';
  ctx.fillText(z.label, z.x + z.w / 2, z.y + z.h / 2 + 4 * u); ctx.textAlign = 'left';
  return z;
}
