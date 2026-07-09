// Shared control-bindings editor: rebind a gameplay action's key or gamepad
// button. Used by both the title screen's Controls -> Bindings screen and
// the live game's pause modal — one implementation, two hosts, each of which
// owns its own frame loop and just calls step()/draw() into it.
//
// Capture flow: selecting a row's key/pad chip enters "capture" — the next
// real keydown (or newly-pressed gamepad button) is offered to
// setBinding/setPadBinding. An invalid capture (movement key, duplicate)
// shows a short-lived error and stays in capture so the player can retry;
// Escape/cancel exits capture without changing anything.

import { REBINDABLE_ACTIONS, ACTION_LABELS, getBindings, setBinding, setPadBinding, resetBindings } from './input.js';
import { codeLabel, padButtonLabel } from './device-labels.js';
import { COLORS } from './renderer.js';

const ERROR_MS = 1800;

export function makeBindingsUI() {
  let sel = 0;
  let capture = null; // { action, type: 'key' | 'pad' }
  let error = '';
  let errorUntil = 0;
  let keydownHandler = null;
  let padSeen = {}; // button index -> pressed last poll, during pad capture

  function endCapture() {
    if (keydownHandler) { window.removeEventListener('keydown', keydownHandler); keydownHandler = null; }
    capture = null;
  }
  function flashError(msg) { error = msg; errorUntil = Date.now() + ERROR_MS; }

  function startKeyCapture(action) {
    endCapture();
    capture = { action, type: 'key' };
    keydownHandler = (e) => {
      if (e.repeat) return;
      e.preventDefault();
      if (e.code === 'Escape') { endCapture(); return; }
      const res = setBinding(action, e.code);
      if (res.ok) endCapture(); else flashError(res.error);
    };
    window.addEventListener('keydown', keydownHandler);
  }
  function startPadCapture(action) {
    endCapture();
    capture = { action, type: 'pad' };
    padSeen = {};
  }

  function pollPadCapture() {
    if (!capture || capture.type !== 'pad' || !navigator.getGamepads) return;
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      gp.buttons.forEach((b, i) => {
        const was = !!padSeen[i];
        padSeen[i] = b.pressed;
        if (b.pressed && !was) {
          const res = setPadBinding(capture.action, i);
          if (res.ok) endCapture(); else flashError(res.error);
        }
      });
    }
  }

  // move/presses: this frame's input.poll() output. lastDy: previous frame's
  // move.dy (edge-detect up/down nav, same pattern as title.js/game.js).
  function step(move, presses, lastDy) {
    pollPadCapture();
    if (capture) {
      if (presses.cancel) endCapture();
      return;
    }
    if (move.dy > 0 && lastDy <= 0) sel = (sel + 1) % REBINDABLE_ACTIONS.length;
    if (move.dy < 0 && lastDy >= 0) sel = (sel - 1 + REBINDABLE_ACTIONS.length) % REBINDABLE_ACTIONS.length;
    if (presses.confirm) startKeyCapture(REBINDABLE_ACTIONS[sel]);
  }

  // Zone ids this component owns: key:<action>, pad:<action>, reset. Host
  // screens forward a press on any zone with one of those ids here.
  function handleZone(id) {
    if (id === 'reset') { resetBindings(); endCapture(); return; }
    if (id.startsWith('key:')) startKeyCapture(id.slice(4));
    else if (id.startsWith('pad:')) startPadCapture(id.slice(4));
  }

  // Draws the action list starting at (x, y), row height rowH, width w
  // (chips are laid out proportionally within it). Returns this frame's
  // zones (key/pad chips + reset), in canvas pixels, for the host to
  // register with input.setZones() and press-test afterward.
  function draw(ctx, x, y, w, rowH, u) {
    const zones = [];
    const b = getBindings();
    ctx.textAlign = 'left';
    REBINDABLE_ACTIONS.forEach((a, i) => {
      const ry = y + i * rowH;
      const on = !capture && sel === i;
      ctx.fillStyle = on ? COLORS.pickup : COLORS.text;
      ctx.font = `${13 * u}px system-ui, sans-serif`;
      ctx.fillText(`${on ? '> ' : '  '}${ACTION_LABELS[a]}`, x, ry);

      const keyZone = { id: `key:${a}`, x: x + w * 0.48, y: ry - 15 * u, w: 64 * u, h: 22 * u };
      const padZone = { id: `pad:${a}`, x: x + w * 0.74, y: ry - 15 * u, w: 78 * u, h: 22 * u };
      const capturingKey = capture && capture.action === a && capture.type === 'key';
      const capturingPad = capture && capture.action === a && capture.type === 'pad';
      chip(ctx, keyZone, capturingKey ? '…' : codeLabel(b.keys[a]), u, capturingKey);
      chip(ctx, padZone, capturingPad ? '…' : padButtonLabel(b.pad[a]), u, capturingPad);
      zones.push(keyZone, padZone);
    });

    const footY = y + REBINDABLE_ACTIONS.length * rowH + 14 * u;
    const resetZone = { id: 'reset', x, y: footY, w: 110 * u, h: 26 * u };
    chip(ctx, resetZone, 'Reset all', u, false);
    zones.push(resetZone);

    ctx.font = `${11 * u}px system-ui, sans-serif`;
    if (capture) {
      ctx.fillStyle = COLORS.pickup;
      const verb = capture.type === 'pad' ? 'Press a gamepad button' : 'Press a key';
      ctx.fillText(`${verb} for ${ACTION_LABELS[capture.action]}… (Esc cancels)`, x + 130 * u, footY + 18 * u);
    } else if (error && Date.now() < errorUntil) {
      ctx.fillStyle = COLORS.enemy;
      ctx.fillText(error, x + 130 * u, footY + 18 * u);
    }
    return zones;
  }

  return { step, draw, handleZone, cancel: endCapture, get capturing() { return !!capture; } };
}

function chip(ctx, z, text, u, active) {
  ctx.fillStyle = active ? 'rgba(255,215,94,0.18)' : 'rgba(136,146,176,0.16)';
  ctx.strokeStyle = active ? COLORS.pickup : 'rgba(136,146,176,0.6)';
  ctx.fillRect(z.x, z.y, z.w, z.h); ctx.strokeRect(z.x, z.y, z.w, z.h);
  ctx.fillStyle = COLORS.text; ctx.font = `${12 * u}px system-ui, sans-serif`; ctx.textAlign = 'center';
  ctx.fillText(text, z.x + z.w / 2, z.y + z.h / 2 + 4 * u);
  ctx.textAlign = 'left';
}
