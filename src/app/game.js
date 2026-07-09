// The presentation-layer orchestrator: owns the ONLY mutable reference to the
// world, translates device-agnostic intents into sim commands, plays sound,
// and manages modals. Modals pause the overworld but never the loop itself;
// every dismissal funnels through one closeModal() so no stale flags survive.
// Enemy/car MOVEMENT lives entirely in the sim (src/sim/ai.js, driven by
// TICK) — this file only ever issues the discrete ENEMY_STRIKE attack
// command on proximity+cooldown, exactly like the two earlier games.
//
// Modal navigation (uniform across every modal): options are a navigable list
// with NO default selection — a stray press can't accidentally confirm
// anything. A modal with exactly one option instead requires a deliberate
// PRESS-AND-HOLD on blast/X (a button distinct from confirm/attack) so combat
// mashing can never eat a story beat. Mouse/touch always select-and-confirm
// directly by tapping the option's zone, no navigation required.

import { makeWorld } from '../sim/world.js';
import { reduce } from '../sim/reduce.js';
import { CONTENT } from '../sim/content.js';
import { exportSaga } from '../sim/saga.js';
import { readonly } from './readonly.js';
import { makeInput, REBINDABLE_ACTIONS } from './input.js';
import { render, COLORS } from './renderer.js';
import { saveGame, clearSave } from './save.js';
import { nightAmount } from './daynight-tint.js';
import { flashOpacity } from './flash-decay.js';
import { wrenDialogFor } from './quest-dialog.js';
import { makeAudio } from './audio.js';
import { makeBindingsUI } from './bindings-ui.js';

const MOVE_REPEAT_MS = 140;
const TICK_MS = 500;
const DODGE_MS = 400;
const ENEMY_CD_MS = 900;
const MAX_FRAME_MS = 100;
const HOLD_DISMISS_MS = 1200;
const WALK_FRAME_MS = 220;

const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export function startGame(canvas, seed, options = {}, initialWorld = null) {
  const ctx = canvas.getContext('2d');
  const input = makeInput(canvas);
  const audio = makeAudio();
  const bindingsUI = makeBindingsUI();
  let bindingsOpen = false; // full-screen overlay, drawn/handled outside the modal system

  let world = initialWorld || makeWorld(seed, options);
  let ro = readonly(world);
  let respawn = JSON.stringify(world);

  // The AudioContext is created on the player's very first real input —
  // always a genuine gesture, so the browser autoplay gate never blocks it
  // (creating it gesturelessly at boot, even for a resumed save, risks a
  // silently-suspended context that never gets a real .resume() call).
  const primeAudio = () => {
    audio.prime();
    window.removeEventListener('keydown', primeAudio);
    window.removeEventListener('pointerdown', primeAudio);
  };
  window.addEventListener('keydown', primeAudio);
  window.addEventListener('pointerdown', primeAudio);

  const view = {
    px: world.player.x, py: world.player.y,
    toasts: [], modal: null, dodging: false, device: 'keyboard',
    guide: '', shakeX: 0, shakeY: 0, punch: {}, playerPunch: 0, night: 0,
    facing: 'down', walkFrame: 0, charging: false,
    projectiles: [],
    // Echo ring visual (renderer.js): pingAt is a wall-clock ms stamp of the
    // last player ping so the ring can expand over real time; the actual
    // reveal (which tiles are lit) is authoritative in state.echo.lit.
    pingAt: -99999, pingX: 0, pingY: 0, pingLoud: false,
    // Charge-release aura flame fade (renderer.js): active while the flame
    // eases out after the player stops charging, duration set per the
    // aura-% held at release (see handleWorld's charge-transition below).
    auraFadeActive: false, auraFadeStart: 0, auraFadeDuration: 0,
    // Flashbang whiteout (renderer.js): one authoritative discrete event
    // (`flash_detonated`, carrying intensity) stamped here as a wall-clock
    // start; the actual opacity-over-time is computed fresh every frame by
    // flash-decay.js, never advanced/ticked in state here.
    flashActive: false, flashStart: 0, flashIntensity: 0,
  };
  if (!initialWorld) {
    view.modal = mkDialog('THE ANSWERING DEEP', CONTENT.arc.intro, 'continue');
  }
  let nextMoveAt = 0, nextTickAt = 0, dodgeUntil = 0;
  let nextChargeAt = 0, wasCharging = false;
  const CHARGE_TICK_MS = 100;
  const enemyCd = {};
  let last = 0, frameNow = 0, lastModalDy = 0, nextWalkFrameAt = 0;

  let hitStopUntil = 0, shakeUntil = 0, shakeStart = 0, shakeMag = 0;
  const PUNCH_MS = 160, PLAYER_PUNCH_MS = 120;
  const punchUntil = {};
  let playerPunchUntil = 0;
  function hitStop(ms) { hitStopUntil = Math.max(hitStopUntil, frameNow + ms); }
  function shake(mag, ms) { if (frameNow + ms >= shakeUntil) { shakeStart = frameNow; shakeUntil = frameNow + ms; } shakeMag = Math.max(shakeMag, mag); }
  function punch(id) { punchUntil[id] = frameNow + PUNCH_MS; }
  function playerPunch() { playerPunchUntil = frameNow + PLAYER_PUNCH_MS; }

  function dispatch(cmd) {
    const events = reduce(world, cmd);
    for (const e of events) onEvent(e);
    // `respawn` is the defeat handler's "rise where you began" checkpoint —
    // it must track the most recent alive, non-ended state (same gate as the
    // save below), not stay frozen at whatever `world` was when this
    // startGame() call began. Left as a one-time snapshot, a whole play
    // session's progress (quests, coins, position) would be discarded on
    // every death, AND immediately overwritten onto the persisted save —
    // silently destroying real progress, not just resetting position.
    if (!world.flags.ended && world.player.hp > 0) { saveGame(world); respawn = JSON.stringify(world); }
    return events;
  }

  function toast(text) { view.toasts.unshift({ text, ttl: 2600 }); if (view.toasts.length > 4) view.toasts.pop(); }
  function closeModal() { view.modal = null; }

  function mkModal(kind, title, lines, options) {
    return { kind, title, lines, options, sel: null, holdStart: null, holdProgress: 0 };
  }
  function mkDialog(title, lines, optionId, label) {
    return mkModal('dialog', title, lines, [{ id: optionId, label: label || 'Continue' }]);
  }

  function shopLines(dialogLines, itemId) {
    const item = world.items[itemId];
    return [...dialogLines, `${item.name} — heals ${item.heal} HP — ${item.price} coins. You have ${world.player.coins}.`];
  }

  function inventoryItems() {
    const counts = {};
    for (const id of world.player.inventory) counts[id] = (counts[id] || 0) + 1;
    return Object.keys(counts).sort().map((id) => ({
      id, name: (world.items[id] && world.items[id].name) || id,
      count: counts[id], usable: !!(world.items[id] && world.items[id].heal),
    }));
  }
  function openInventory() {
    const items = inventoryItems();
    const options = items.map((it) => ({ id: `use:${it.id}`, label: `${it.name}${it.count > 1 ? ` x${it.count}` : ''}`, usable: it.usable }));
    options.push({ id: 'close', label: 'Close' });
    view.modal = mkModal('inventory', 'Satchel', [], options);
  }

  // --- sim event -> presentation --------------------------------------------
  function onEvent(e) {
    switch (e.type) {
      case 'talked': {
        const npc = world.npcs[e.npc];
        // Wren's lines are state-aware (see quest-dialog.js) — every other
        // NPC keeps a flat, always-the-same array (Marrow is a shop keeper
        // giving the same lesson regardless of quest progress; that's fine).
        const lines = e.npc === 'wren' ? wrenDialogFor(world) : (CONTENT.regions[world.region.id].npcs[e.npc]?.dialog || []);
        if (npc.shop && npc.shop.length) {
          const itemId = npc.shop[0];
          view.modal = mkModal('shop', npc.name, shopLines(lines, itemId),
            [
              { id: 'buy', label: `Buy ${world.items[itemId].name}` },
              { id: 'drink', label: `Drink ${world.items[itemId].name}` },
              { id: 'leave', label: 'Leave' },
            ]);
          view.modal.itemId = itemId;
          view.modal.dialogLines = lines;
        } else if (!view.modal) {
          view.modal = mkDialog(npc.name, lines, 'close', 'Close');
        }
        break;
      }
      case 'quests_offered': {
        // Wren is the only quest giver (see content.js's quest-design note),
        // so her state-aware lines (quest-dialog.js) always apply here too —
        // this event fires in the SAME 'talked' TALK dispatch and previously
        // just silently overwrote view.modal with an empty-lines offer
        // modal, so the freshly-computed dialog text was set one line above
        // and immediately discarded without ever being shown. Folding the
        // lines into the offer modal itself is the fix — the offer becomes
        // "what Wren just said" plus the actual choices, not two competing
        // modals where only the last write wins.
        const options = e.quests.map((qid) => ({ id: qid, label: world.quests.defs[qid].name }));
        options.push({ id: 'notnow', label: 'Not now' });
        view.modal = mkModal('offer', 'Wren', wrenDialogFor(world), options);
        break;
      }
      case 'enemy_incoming': toast(`Something ${kindName(e.kind)}-shaped stirs in the dark.`); audio.play('quest'); break;
      case 'enemy_appeared': toast(`A ${kindName(world.enemies[e.target]?.kind || e.kind)} is down here with you now.`); break;
      case 'pickup_appeared': toast('Your pulse catches something solid nearby.'); break;
      case 'picked_up': toast(`Picked up ${prettify(e.item)}`); audio.play('pickup'); break;
      case 'broke': toast(`Broken — +${e.coins} coins`); punch(e.target); shake(2, 90); audio.play('break'); break;
      case 'enemy_hit':
        toast(`Hit for ${e.dmg}`); punch(e.target);
        if (e.kind === 'melee' || e.kind === 'aura') { playerPunch(); audio.play(e.kind); }
        hitStop(e.kind === 'aura' ? 70 : 45);
        shake(Math.min(6, 2 + e.dmg * 0.6), 120);
        break;
      case 'no_effect': toast('No effect — try the other way.'); punch(e.target); audio.play('no_effect'); break;
      case 'enemy_defeated':
        toast(`${kindName(e.kind)} defeated!`); hitStop(90); shake(5, 160); audio.play('defeat');
        if (e.target === world.arc.bossDef.id) {
          view.modal = mkModal('fate', 'The Answerer falls silent',
            ['It stops, mid-echo. The voice it stole is yours to end — or to make real.',
             'Silence it, and the reach goes quiet again, the way it always should have been. Answer it, and something down here can be spoken to from now on — by you, or by whatever comes after you.',
             'Do you silence it, or answer it?'],
            [{ id: 'silence', label: 'Silence it' }, { id: 'answer', label: 'Answer it' }]);
        }
        break;
      case 'player_hit': toast(`Took ${e.dmg} damage`); hitStop(60); shake(Math.min(8, 3 + e.dmg * 0.7), 180); audio.play('hurt'); break;
      case 'flash_detonated':
        view.flashActive = true; view.flashStart = frameNow; view.flashIntensity = e.intensity;
        if (e.intensity > 0) { toast('A flash of white blinds you'); shake(Math.min(6, 2 + e.intensity * 0.04), 200); audio.play('boss'); }
        break;
      case 'skill_up': toast(`${cap(e.skill)} rose to ${e.lvl}!`); break;
      case 'power_claimed': toast(`Something settles in you — ${cap(e.skill)} ${e.lvl}`); break;
      case 'objective_progress': toast(`${e.at}/${e.of}`); audio.play('quest'); break;
      case 'quest_completed': toast(`Quest complete! +${e.reward.coins} coins`); audio.play('quest'); break;
      case 'healed': toast(`Recovered — HP ${e.hp}`); audio.play('heal'); break;
      case 'bought': toast(`Bought — ${e.coins} coins left`); break;
      case 'torch_lit':
        if (e.auto) toast('Marrow strikes the old post-torch to life. "There — small mercy, but it stays."');
        else toast('Torch lit — the dark opens up around it.');
        audio.play('quest');
        break;
      case 'no_aura': toast('Not enough aura — Charge first'); break;
      case 'too_far': toast('Too far away'); break;
      case 'unlit': toast('You can’t place it — pulse to see it first'); break;
      case 'ping':
        if (e.alerted && e.alerted.length) toast('Something out there turns toward you');
        break;
      case 'cant_afford': toast('Not enough coins'); break;
      case 'no_item': toast('Nothing to drink'); break;
      case 'nothing_there': break;
      case 'player_defeated':
        view.modal = mkDialog('The dark takes you...', ['The reach goes quiet, and answers no more.'], 'rise', 'Rise Again');
        view.modal.kind = 'defeat';
        break;
      case 'exit_locked': toast('The ascent won’t open. Something down here isn’t finished.'); break;
      case 'boss_appeared':
        shake(10, 450); hitStop(150); audio.play('boss');
        view.modal = mkDialog('The Answerer', CONTENT.arc.bossAppeared, 'stand', 'Stand');
        break;
      case 'boss_taunted':
        shake(8, 300); hitStop(120); audio.play('boss');
        view.modal = mkDialog('It stops testing you', CONTENT.arc.bossTaunted, 'endure', 'Endure');
        break;
      case 'chapter_complete': {
        clearSave();
        audio.play('chapter');
        const code = exportSaga(world);
        view.modal = mkDialog('THE ASCENT OPENS', [...CONTENT.arc.finale, '', CONTENT.arc.exportHint, code], 'copy', 'Copy code');
        view.modal.kind = 'finale';
        view.modal.code = code;
        break;
      }
    }
  }

  function nearest(map, range, ok = () => true) {
    let best = null, bestD = range + 1;
    for (const id of Object.keys(map).sort()) {
      const el = map[id];
      if (!ok(el)) continue;
      const d = dist(world.player, el);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  function runOption(m, opt) {
    switch (m.kind) {
      case 'pause':
        if (opt.id === 'bindings') { closeModal(); bindingsOpen = true; }
        else closeModal();
        break;
      case 'dialog': case 'defeat': case 'finale':
        if (m.kind === 'defeat') {
          // Keep the checkpoint's PROGRESS (quests/coins/inventory/skills —
          // see `respawn`'s own comment) but rise at the region's actual
          // spawn point, full HP, fire out — never at the exact tile/moment
          // you died. A checkpoint that restores your literal death position
          // can drop you right back next to whatever just killed you, which
          // (with its own real-time attack cooldown already elapsed by the
          // time the hold-to-confirm finishes) can chain-kill immediately.
          // "You rise where you began" is the toast text for a reason.
          const revived = JSON.parse(respawn);
          const spawn = CONTENT.regions[revived.region.id].spawn;
          revived.player.x = spawn.x;
          revived.player.y = spawn.y;
          revived.player.hp = revived.player.maxHp;
          revived.player.onFireTicks = 0;
          world = revived; ro = readonly(world); saveGame(world); closeModal(); toast('You rise where you began.');
        }
        else if (m.kind === 'finale') { if (navigator.clipboard?.writeText) navigator.clipboard.writeText(m.code).catch(() => {}); toast('Code copied. See you at the next crossing.'); closeModal(); }
        else closeModal();
        break;
      case 'offer':
        if (opt.id === 'notnow') { closeModal(); toast('The offer stands.'); }
        else { dispatch({ type: 'ACCEPT_QUEST', questId: opt.id }); closeModal(); toast('Accepted.'); }
        break;
      case 'shop':
        if (opt.id === 'buy') { dispatch({ type: 'BUY', itemId: m.itemId }); m.lines = shopLines(m.dialogLines, m.itemId); }
        else if (opt.id === 'drink') { dispatch({ type: 'USE_ITEM', itemId: m.itemId }); m.lines = shopLines(m.dialogLines, m.itemId); }
        else closeModal();
        break;
      case 'fate':
        dispatch({ type: 'CHOOSE_FATE', fate: opt.id });
        closeModal();
        toast(opt.id === 'silence' ? 'You end the stolen voice. The reach goes truly quiet.' : 'You give it a voice of its own. Something down here can be spoken to now.');
        break;
      case 'inventory':
        if (opt.id === 'close') { closeModal(); break; }
        if (!opt.usable) { toast('A key item — nothing to use it on yet.'); break; }
        dispatch({ type: 'USE_ITEM', itemId: opt.id.slice(4) });
        {
          const items = inventoryItems();
          const options = items.map((it) => ({ id: `use:${it.id}`, label: `${it.name}${it.count > 1 ? ` x${it.count}` : ''}`, usable: it.usable }));
          options.push({ id: 'close', label: 'Close' });
          view.modal.options = options;
          view.modal.sel = view.modal.sel != null ? Math.min(view.modal.sel, options.length - 1) : null;
        }
        break;
    }
  }

  function handleModal(now, presses, move, blastHeld) {
    const m = view.modal;
    const opts = m.options;

    if (opts.length === 1) {
      if (blastHeld) {
        if (m.holdStart == null) m.holdStart = now;
        m.holdProgress = Math.min(1, (now - m.holdStart) / HOLD_DISMISS_MS);
        if (now - m.holdStart >= HOLD_DISMISS_MS) { runOption(m, opts[0]); }
      } else {
        m.holdStart = null;
        m.holdProgress = 0;
      }
      if (presses[opts[0].id]) runOption(m, opts[0]);
      return;
    }

    if (move.dy > 0 && lastModalDy <= 0) m.sel = m.sel == null ? 0 : (m.sel + 1) % opts.length;
    if (move.dy < 0 && lastModalDy >= 0) m.sel = m.sel == null ? opts.length - 1 : (m.sel - 1 + opts.length) % opts.length;
    if (presses.confirm && m.sel != null) { runOption(m, opts[m.sel]); return; }
    for (const opt of opts) { if (presses[opt.id]) { runOption(m, opt); return; } }
    if (presses.cancel && m.kind !== 'fate' && m.kind !== 'defeat') closeModal();
  }

  function openPause() {
    view.modal = mkModal('pause', 'Paused', [], [{ id: 'resume', label: 'Resume' }, { id: 'bindings', label: 'Bindings' }]);
  }

  function handleWorld(now, move, presses, chargeHeld) {
    if (presses.cancel) { openPause(); return; }
    if (presses.inventory) { openInventory(); return; }
    if (presses.dodge) { dodgeUntil = now + DODGE_MS; toast('Dodge!'); }

    // The signature verbs. A ping/pulse also seeds the expanding-ring visual
    // (view.pingAt is wall-clock; the sim's echo reveal is authoritative and
    // read straight from state.echo.lit by the renderer).
    if (presses.ping || presses.pulse) {
      const loud = !!presses.pulse;
      const before = world.player.aura;
      dispatch({ type: 'PING', loud });
      if (loud && world.player.aura === before) toast('Not enough aura to pulse');
      else { view.pingAt = now; view.pingX = world.player.x; view.pingY = world.player.y; view.pingLoud = loud; audio.play(loud ? 'pulse' : 'ping'); }
    }

    if (move.dx || move.dy) {
      view.facing = move.dy > 0 ? 'down' : move.dy < 0 ? 'up' : move.dx > 0 ? 'right' : 'left';
      if (now >= nextWalkFrameAt) { view.walkFrame = 1 - view.walkFrame; nextWalkFrameAt = now + WALK_FRAME_MS; }
      if (now >= nextMoveAt) { dispatch({ type: 'MOVE', dx: move.dx, dy: move.dy }); nextMoveAt = now + MOVE_REPEAT_MS; }
    } else { nextMoveAt = 0; view.walkFrame = 0; }

    if (presses.attack) {
      const id = nearest(world.enemies, 1, (en) => en.alive);
      if (id) dispatch({ type: 'MELEE', enemyId: id }); else toast('No enemy in reach');
    }
    if (presses.blast) {
      const id = nearest(world.enemies, 3, (en) => en.alive);
      if (id) {
        const target = world.enemies[id];
        const x0 = world.player.x, y0 = world.player.y;
        dispatch({ type: 'AURA_BLAST', enemyId: id });
        view.projectiles.push({ x0, y0, x1: target.x, y1: target.y, start: now, duration: 180 });
      } else toast('No enemy in range');
    }
    view.charging = chargeHeld;
    if (chargeHeld) {
      if (!wasCharging || now >= nextChargeAt) { dispatch({ type: 'CHARGE', start: !wasCharging }); nextChargeAt = now + CHARGE_TICK_MS; }
    } else if (wasCharging) {
      // Fade duration scales with the aura% held at release: below 80% a
      // snappy 100ms; 80-100% eases from 200ms up to 500ms.
      const pct = world.player.maxAura > 0 ? (world.player.aura * 100) / world.player.maxAura : 100;
      view.auraFadeDuration = pct < 80 ? 100 : 200 + ((Math.min(pct, 100) - 80) / 20) * 300;
      view.auraFadeStart = now;
      view.auraFadeActive = true;
    }
    wasCharging = chargeHeld;
    if (presses.interact) {
      const npcId = nearest(world.npcs, 1);
      const pickId = nearest(world.pickups, 1, (p) => !p.taken);
      const crateId = nearest(world.destructibles, 1, (d) => !d.broken);
      const torchId = nearest(world.torches, 1, (t) => !t.lit);
      if (npcId) dispatch({ type: 'TALK', npcId });
      else if (pickId) dispatch({ type: 'INTERACT', pickupId: pickId });
      else if (crateId) dispatch({ type: 'BREAK', destructibleId: crateId });
      else if (torchId) dispatch({ type: 'LIGHT_TORCH', torchId });
      else toast('Nothing here');
    }

    const dodging = now < dodgeUntil;
    if (!dodging) {
      for (const id of Object.keys(world.enemies).sort()) {
        const en = world.enemies[id];
        if (!en.alive || dist(world.player, en) > 1) continue;
        if (CONTENT.enemyKinds[en.kind].harmless) continue; // never strikes back, even cornered
        if (now >= (enemyCd[id] || 0)) { dispatch({ type: 'ENEMY_STRIKE', enemyId: id }); enemyCd[id] = now + ENEMY_CD_MS; }
      }
    }

    if (now >= nextTickAt) { dispatch({ type: 'TICK' }); nextTickAt = now + TICK_MS; }
  }

  function computeGuide() {
    if (world.flags.ended) return '';
    const g = CONTENT.arc.guide;
    if (!(world.quests.offered['into-the-dark'] || world.quests.active['into-the-dark'] || world.quests.completed['into-the-dark'])) return g.talk;
    if (world.quests.offered['into-the-dark']) return g.talk;
    if (world.quests.active['into-the-dark']) return g.training;
    if (world.arc.bossDefeated && !world.arc.complete) return g.choice;
    if (world.arc.complete) return g.gate;
    if (world.arc.bossSpawned) return g.boss;
    if (world.quests.completed['sound-the-deep']) return g.arena;
    if (world.quests.active['sound-the-deep']) return g.hunt3;
    if (world.quests.completed['the-sounding-line']) return g.finale;
    if (world.quests.active['the-sounding-line']) return g.ledger;
    if (world.quests.completed['the-fleeing-kind']) return g.ledger;
    if (world.quests.active['the-fleeing-kind']) return g.hunt2;
    if (world.quests.completed['learn-to-listen']) return g.hunt2;
    if (world.quests.active['learn-to-listen']) return g.hunt1;
    return g.hunt1;
  }

  // Drawn over whatever the last real frame left in the canvas (the world is
  // fully paused, so redrawing it would be wasted work) — same translucent
  // full-screen treatment as drawModal in renderer.js.
  function drawBindingsOverlay() {
    const W = canvas.width, H = canvas.height;
    const u = Math.max(0.8, Math.min(3, H / 540));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(3,5,12,0.9)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLORS.text; ctx.font = `bold ${17 * u}px system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('Bindings', W / 2, 56 * u);
    ctx.textAlign = 'left';
    const listX = W / 2 - 150 * u, listY = 96 * u, rowH = 28 * u;
    const zones = bindingsUI.draw(ctx, listX, listY, 300 * u, rowH, u);
    const backY = listY + REBINDABLE_ACTIONS.length * rowH + 56 * u;
    const back = { id: 'bindings-back', x: W / 2 - 65 * u, y: backY, w: 130 * u, h: 30 * u };
    ctx.fillStyle = 'rgba(136,146,176,0.16)'; ctx.strokeStyle = 'rgba(136,146,176,0.6)';
    ctx.fillRect(back.x, back.y, back.w, back.h); ctx.strokeRect(back.x, back.y, back.w, back.h);
    ctx.fillStyle = COLORS.text; ctx.font = `bold ${13 * u}px system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('Back', back.x + back.w / 2, back.y + back.h / 2 + 5 * u);
    ctx.textAlign = 'left';
    zones.push(back);
    return zones;
  }

  function frame(now) {
    const dt = Math.min(now - last || 16, MAX_FRAME_MS);
    last = now; frameNow = now;

    const { move, presses, device, chargeHeld, blastHeld } = input.poll();
    view.device = input.hasTouch && device === 'keyboard' ? 'touch' : device;

    // Bindings overlay fully pauses the world (no handleWorld/handleModal
    // call at all) — a rebind capture must never race a live enemy strike.
    if (bindingsOpen) {
      const wasCapturing = bindingsUI.capturing;
      bindingsUI.step(move, presses, lastModalDy);
      lastModalDy = move.dy;
      if (!wasCapturing && !bindingsUI.capturing && presses.cancel) bindingsOpen = false;
      const zones = drawBindingsOverlay();
      for (const z of zones) {
        if (!presses[z.id]) continue;
        if (z.id === 'bindings-back') bindingsOpen = false;
        else bindingsUI.handleZone(z.id);
      }
      input.setZones(zones);
      requestAnimationFrame(frame);
      return;
    }

    const frozen = now < hitStopUntil;
    if (!frozen) {
      if (view.modal) handleModal(now, presses, move, blastHeld);
      else handleWorld(now, move, presses, chargeHeld);
    }
    lastModalDy = move.dy;

    view.guide = computeGuide();

    const k = Math.min(1, dt * 0.02);
    view.px += (world.player.x - view.px) * k;
    view.py += (world.player.y - view.py) * k;
    view.dodging = now < dodgeUntil;
    for (const t of view.toasts) t.ttl -= dt;
    view.toasts = view.toasts.filter((t) => t.ttl > 0);
    view.projectiles = view.projectiles.filter((p) => now - p.start < p.duration);

    if (now < shakeUntil) {
      const span = Math.max(1, shakeUntil - shakeStart);
      const decay = Math.max(0, (shakeUntil - now) / span);
      view.shakeX = (Math.random() * 2 - 1) * shakeMag * decay;
      view.shakeY = (Math.random() * 2 - 1) * shakeMag * decay;
    } else { view.shakeX = 0; view.shakeY = 0; shakeMag = 0; }
    for (const id of Object.keys(punchUntil)) {
      const remain = punchUntil[id] - now;
      if (remain <= 0) { delete punchUntil[id]; delete view.punch[id]; }
      else view.punch[id] = Math.max(0, Math.min(1, remain / PUNCH_MS));
    }
    view.playerPunch = Math.max(0, Math.min(1, (playerPunchUntil - now) / PLAYER_PUNCH_MS));
    view.night = nightAmount(world.tick);
    if (view.auraFadeActive && now - view.auraFadeStart >= view.auraFadeDuration) view.auraFadeActive = false;
    if (view.flashActive && flashOpacity(view.flashIntensity, now - view.flashStart) <= 0) view.flashActive = false;

    input.setZones(render(ctx, ro, view, now));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { world: () => ro, dispatch, view };
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function prettify(s) { return String(s).replace(/-/g, ' '); }
function kindName(kind) { return (CONTENT.enemyKinds[kind] && CONTENT.enemyKinds[kind].name) || kind; }
