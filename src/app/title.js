// Title screen: Continue / New Game / Controls. New Game resolves to
// { action: 'new', archetype, difficulty, saga? } — the caller starts a real
// makeWorld() from that, never by reopening setup over stale state. Continue
// only appears with a compatible save. New Game can carry over a Wrong Sky
// (saga.v2) code. Layout is centered and scales with the viewport so it reads
// on any monitor (text uses its own scale, separate from any world scale).

import { makeInput } from './input.js';
import { COLORS } from './renderer.js';
import { CONTENT } from '../sim/content.js';
import { hasSave, loadGame, clearSave } from './save.js';
import { withHint } from './device-labels.js';
import { importSaga } from '../sim/saga.js';

function btn(ctx, z, device, u) {
  ctx.fillStyle = 'rgba(136,146,176,0.14)';
  ctx.strokeStyle = z.on ? COLORS.pickup : 'rgba(136,146,176,0.6)';
  ctx.lineWidth = z.on ? 2 : 1;
  ctx.fillRect(z.x, z.y, z.w, z.h); ctx.strokeRect(z.x, z.y, z.w, z.h);
  ctx.fillStyle = COLORS.text; ctx.font = `bold ${13 * u}px system-ui, sans-serif`; ctx.textAlign = 'center';
  const label = z.hintAction ? withHint(device, z.hintAction, z.label) : z.label;
  ctx.fillText(label, z.x + z.w / 2, z.y + z.h / 2 + 5 * u); ctx.textAlign = 'left'; ctx.lineWidth = 1;
  return z;
}

export function runTitle(canvas) {
  return new Promise((resolve) => {
    const ctx = canvas.getContext('2d');
    const input = makeInput(canvas);
    let screen = 'menu';
    let archIdx = 0;
    const archIds = Object.keys(CONTENT.archetypes);
    let difficulty = 'gentle';
    let selected = 0;
    let saga = null;      // imported saga.v2 carryover data, or null
    let sagaNote = '';

    function menuOptions() {
      const opts = [];
      if (hasSave()) opts.push('continue');
      opts.push('new', 'controls');
      return opts;
    }

    function pasteCode() {
      const raw = (typeof window !== 'undefined' && window.prompt) ? window.prompt('Paste your Wrong Sky code (SAGA2…):', '') : '';
      if (!raw) return;
      const res = importSaga(raw);
      if (!res.ok) { sagaNote = `Code rejected: ${res.error}`; saga = null; return; }
      saga = res.data;
      if (archIds.includes(saga.archetype)) archIdx = archIds.indexOf(saga.archetype);
      if (saga.difficulty === 'gentle' || saga.difficulty === 'harsh') difficulty = saga.difficulty;
      sagaNote = `Carryover loaded — ${cap(saga.archetype)}, aura ${saga.skills?.aura ?? '?'}, fate ${saga.choices?.riftChoice || '—'}`;
    }

    function handlePress(id) {
      if (screen === 'menu') {
        const opts = menuOptions();
        if (id === 'continue' && opts.includes('continue')) { const data = loadGame(); if (data) { resolve({ action: 'continue', world: data }); return; } }
        if (id === 'new') { if (hasSave()) { screen = 'confirm'; } else screen = 'setup'; }
        if (id === 'controls') screen = 'controls';
      } else if (screen === 'confirm') {
        if (id === 'yes') { clearSave(); screen = 'setup'; }
        if (id === 'no') screen = 'menu';
      } else if (screen === 'setup') {
        if (id === 'back') screen = 'menu';
        if (id === 'gentle') difficulty = 'gentle';
        if (id === 'harsh') difficulty = 'harsh';
        if (id === 'code') pasteCode();
        if (archIds.includes(id)) archIdx = archIds.indexOf(id);
        if (id === 'start') resolve({ action: 'new', archetype: archIds[archIdx], difficulty, saga });
      } else if (screen === 'controls') {
        if (id === 'back') screen = 'menu';
      }
    }

    function draw(device) {
      const W = canvas.width, H = canvas.height;
      const u = Math.max(0.8, Math.min(3, H / 540));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.pickup; ctx.font = `bold ${34 * u}px system-ui, sans-serif`;
      ctx.fillText('THE WAITING CITY', W / 2, H * 0.2);
      ctx.font = `${13 * u}px system-ui, sans-serif`; ctx.fillStyle = COLORS.dim;
      ctx.fillText('saga · part three — a tyrant’s city, and enemies that finally move', W / 2, H * 0.2 + 26 * u);

      const zones = [];
      const cx = W / 2;
      if (screen === 'menu') {
        const opts = menuOptions();
        const labels = { continue: 'Continue', new: 'New Game', controls: 'Controls' };
        opts.forEach((id, i) => {
          zones.push(btn(ctx, { id, label: labels[id], on: i === selected, x: cx - 100 * u, y: H * 0.4 + i * 52 * u, w: 200 * u, h: 40 * u }, device, u));
        });
      } else if (screen === 'confirm') {
        ctx.fillStyle = COLORS.text; ctx.font = `${14 * u}px system-ui, sans-serif`;
        ctx.fillText('A saved run exists. Starting new erases it.', cx, H * 0.4);
        zones.push(btn(ctx, { id: 'no', hintAction: 'cancel', label: 'Keep it', x: cx - 200 * u, y: H * 0.4 + 24 * u, w: 180 * u, h: 40 * u }, device, u));
        zones.push(btn(ctx, { id: 'yes', hintAction: 'confirm', label: 'Overwrite', x: cx + 20 * u, y: H * 0.4 + 24 * u, w: 180 * u, h: 40 * u }, device, u));
      } else if (screen === 'setup') {
        ctx.fillStyle = COLORS.text; ctx.font = `bold ${14 * u}px system-ui, sans-serif`;
        ctx.fillText('Choose your path', cx, H * 0.3);
        archIds.forEach((id, i) => {
          const a = CONTENT.archetypes[id];
          const x = cx - 330 * u + i * 220 * u;
          zones.push(btn(ctx, { id, label: a.name, on: i === archIdx, x, y: H * 0.3 + 16 * u, w: 200 * u, h: 36 * u }, device, u));
          ctx.fillStyle = COLORS.dim; ctx.font = `${11 * u}px system-ui, sans-serif`;
          ctx.fillText(a.blurb, x + 100 * u, H * 0.3 + 70 * u, 196 * u);
        });
        ctx.fillStyle = COLORS.text; ctx.font = `bold ${13 * u}px system-ui, sans-serif`;
        ctx.fillText('Tone', cx, H * 0.3 + 104 * u);
        zones.push(btn(ctx, { id: 'gentle', label: 'Gentle', on: difficulty === 'gentle', x: cx - 140 * u, y: H * 0.3 + 116 * u, w: 130 * u, h: 34 * u }, device, u));
        zones.push(btn(ctx, { id: 'harsh', label: 'Harsh', on: difficulty === 'harsh', x: cx + 10 * u, y: H * 0.3 + 116 * u, w: 130 * u, h: 34 * u }, device, u));
        zones.push(btn(ctx, { id: 'code', label: 'Paste Wrong Sky code', x: cx - 130 * u, y: H * 0.3 + 162 * u, w: 260 * u, h: 32 * u }, device, u));
        if (sagaNote) { ctx.fillStyle = saga ? COLORS.good : COLORS.enemy; ctx.font = `${11 * u}px system-ui, sans-serif`; ctx.fillText(sagaNote, cx, H * 0.3 + 208 * u, W - 40 * u); }
        zones.push(btn(ctx, { id: 'start', hintAction: 'confirm', label: 'Begin', x: cx - 100 * u, y: H * 0.3 + 224 * u, w: 200 * u, h: 40 * u }, device, u));
        zones.push(btn(ctx, { id: 'back', hintAction: 'cancel', label: 'Back', x: cx - 65 * u, y: H * 0.3 + 274 * u, w: 130 * u, h: 30 * u }, device, u));
      } else if (screen === 'controls') {
        ctx.fillStyle = COLORS.dim; ctx.font = `${13 * u}px system-ui, sans-serif`;
        const lines = [
          'Keyboard — Move WASD/Arrows · Attack J · Blast K · Charge L · Interact E · Items I · Dodge Space',
          'Gamepad — Move Stick/D-Pad · Attack A · Blast X · Charge Y · Interact RB · Items Start · Dodge B',
          'Touch — on-screen pad and buttons',
          'Raise your perception skill in a real fight — high enough, you’ll start reading a guard’s next move, not just their health.',
        ];
        lines.forEach((l, i) => ctx.fillText(l, cx, H * 0.4 + i * 24 * u, W - 40 * u));
        zones.push(btn(ctx, { id: 'back', hintAction: 'cancel', label: 'Back', x: cx - 65 * u, y: H * 0.4 + 120 * u, w: 130 * u, h: 30 * u }, device, u));
      }
      ctx.textAlign = 'left';
      input.setZones(zones);
      return zones;
    }

    let lastDy = 0, lastDx = 0;
    function frame() {
      const { move, presses, device } = input.poll();
      const dev = input.hasTouch && device === 'keyboard' ? 'touch' : device;
      const zones = draw(dev);

      if (screen === 'menu') {
        const opts = menuOptions();
        if (selected >= opts.length) selected = 0;
        if (move.dy > 0 && lastDy <= 0) selected = (selected + 1) % opts.length;
        if (move.dy < 0 && lastDy >= 0) selected = (selected - 1 + opts.length) % opts.length;
        if (presses.confirm) handlePress(opts[selected]);
      } else if (screen === 'setup') {
        if (move.dx > 0 && lastDx <= 0) archIdx = (archIdx + 1) % archIds.length;
        if (move.dx < 0 && lastDx >= 0) archIdx = (archIdx - 1 + archIds.length) % archIds.length;
        if (presses.confirm) handlePress('start');
        if (presses.cancel) handlePress('back');
      } else if (screen === 'confirm') {
        if (presses.confirm) handlePress('yes');
        if (presses.cancel) handlePress('no');
      } else if (screen === 'controls') {
        if (presses.cancel || presses.confirm) handlePress('back');
      }
      lastDy = move.dy; lastDx = move.dx;

      for (const z of zones) { if (presses[z.id]) handlePress(z.id); }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
