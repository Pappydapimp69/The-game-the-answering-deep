// reduce(state, command) is the ONLY thing that mutates authoritative state.
// It returns an array of events for the presentation layer to consume; the
// renderer reads state and never writes it.
//
// Contract notes (permanent):
// - Commands target entities by stable id, never by position or index.
// - Dodge i-frames are the RENDERER withholding ENEMY_STRIKE for the window —
//   there is no "invulnerable" flag in authoritative state.
// - Enemy ATTACK is still its own command (ENEMY_STRIKE), issued by the
//   presentation layer on proximity+cooldown, so the sim stays a pure
//   reducer for that discrete event. Enemy/car MOVEMENT is different: it is
//   decided INSIDE this file's TICK case (src/sim/ai.js), never computed by
//   the presentation layer and shipped as a command — see ai.js's header for
//   why (replay validity: the golden test only re-executes reduce() over a
//   recorded command array, and AI logic must stay inside the one file the
//   determinism guard actually scans).
// - Quests are offered, never pushed: TALK emits offers for every quest whose
//   giver/prereqs match; only ACCEPT_QUEST activates one. Declining costs
//   nothing and the offer(s) stay available.

import { nextInt } from './rng.js';
import { isNight } from './daynight.js';
import { decideEnemyAction, decideCarStep } from './ai.js';
import { echoDistanceMap, revealSet, heardAt } from './sound.js';
import { recomputeLight, lightAt } from './light.js';
import { igniteAt, stepFire, isWater, FIRE_BURN_DMG_BASE, FIRE_BURN_DMG_ROLL } from './fire.js';

const MELEE_RANGE = 1;
const BLAST_RANGE = 3;
const BLAST_COST = 3;
const XP_PER_LEVEL = 5;
// Echo/sight tuning. The deep is dark: a tile the player can act on must be
// currently LIT (revealed by a recent pulse). A pulse's reach and the noise it
// makes both scale with the kind of ping.
const REVEAL_TTL = 6;            // ticks a lit tile stays drawable after a pulse
const QUIET_PING_REACH = 4;      // base reveal radius of the free "listen" ping
const QUIET_PING_NOISE = 3;      // how far the quiet ping carries to enemy ears
const LOUD_PING_REACH = 8;       // aura-powered pulse: sees much farther…
const LOUD_PING_NOISE = 8;       // …but shouts your position across the reach
const LOUD_PING_COST = 2;        // aura spent on a loud pulse
// Quest-unlocked enemies don't materialize the instant a quest is accepted —
// they sit in state.pendingSpawns for a fixed number of ticks first (an
// honest, sim-enforced telegraph: the entity genuinely isn't in state.enemies
// yet, so it can't act or be struck, unlike a cosmetic fade-in that would
// leave it fully live under a still-fading sprite). Fixed, not rng-drawn —
// the point is predictable telegraphing, not unpredictability.
const ENEMY_SPAWN_DELAY_TICKS = 3;

const CHARGE_RAMP_STEP = 4;
const CHARGE_RAMP_CAP = 8;
const CHARGE_TOP_PCT = 80;

// Fire/molotov hazard tuning (src/sim/fire.js owns the fire field itself).
const BOTTLE_LIGHT_RADIUS = 2;
const BOTTLE_LIGHT_STRENGTH = 40;
const BURN_STATUS_TICKS = 4;   // residual burning duration after leaving flame
const RESIDUAL_BURN_DMG = 1;
const CHARGE_LIGHT_TTL = 2;    // world-ticks of no CHARGE command before the charge-light is cleaned up

export function reduce(state, command) {
  const events = reduceCore(state, command);
  arcObserve(state, events);
  return events;
}

function reduceCore(state, command) {
  switch (command.type) {
    case 'TICK': {
      state.tick += 1;
      const events = [];
      // Prune lit tiles whose reveal window has elapsed — keeps state.echo.lit
      // bounded and deterministic (it only ever holds recently-pinged tiles).
      for (const key of Object.keys(state.echo.lit)) {
        if (state.tick - state.echo.lit[key] >= REVEAL_TTL) delete state.echo.lit[key];
      }
      // Drain any enemy whose telegraph delay has elapsed BEFORE this tick's
      // AI decisions run, so a freshly-materialized enemy doesn't act on its
      // own spawn tick — one more free beat for the player. Fixed sorted-id
      // order keeps this deterministic regardless of pendingSpawns' insertion
      // order (which itself only ever depends on prior commands, not
      // iteration happenstance, but sorting here costs nothing and removes
      // any doubt).
      const due = state.pendingSpawns.filter((p) => state.tick >= p.readyTick).sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const p of due) {
        state.enemies[p.id] = { ...p.tmpl };
        events.push({ type: 'enemy_appeared', target: p.id, kind: p.tmpl.kind });
      }
      if (due.length) {
        const dueIds = new Set(due.map((p) => p.id));
        state.pendingSpawns = state.pendingSpawns.filter((p) => !dueIds.has(p.id));
      }
      // Fixed sorted-id order + a shared `claimed` occupancy snapshot is what
      // keeps same-tick multi-entity movement deterministic regardless of
      // iteration happenstance — see src/sim/ai.js header.
      const claimed = new Set([`${state.player.x},${state.player.y}`]);
      for (const id of Object.keys(state.enemies).sort()) {
        if (state.enemies[id].alive) claimed.add(`${state.enemies[id].x},${state.enemies[id].y}`);
      }
      for (const id of Object.keys(state.cars).sort()) {
        claimed.add(`${state.cars[id].x},${state.cars[id].y}`);
      }
      for (const id of Object.keys(state.enemies).sort()) {
        if (state.enemies[id].alive) decideEnemyAction(state, id, claimed);
      }
      for (const id of Object.keys(state.cars).sort()) {
        decideCarStep(state, id, claimed);
      }

      // --- hazards: charge-light staleness, bottle flight, fire, burn -------
      // Charge-light staleness: no CHARGE command in a while, drop the glow.
      if (state.light.sources['player-charge'] && state.tick - state.player.lastChargeTick > CHARGE_LIGHT_TTL) {
        delete state.light.sources['player-charge'];
      }

      // Bottle advance: land (ignite target + fire an event) or update its
      // in-flight light position. A bottle created earlier THIS tick by
      // ai.js has elapsed=0, so it gets a light source immediately — no
      // special-casing needed for brand-new throws.
      for (const bid of Object.keys(state.hazards.bottles).sort()) {
        const b = state.hazards.bottles[bid];
        const elapsed = state.tick - b.startTick;
        if (elapsed >= b.travelTicks) {
          delete state.hazards.bottles[bid];
          delete state.light.sources[`bottle:${bid}`];
          igniteAt(state, b.x1, b.y1);
          const targetKey = `${b.x1},${b.y1}`;
          const ignited = !isWater(state, b.x1, b.y1)
            && !Object.prototype.hasOwnProperty.call(state.region.blocked, targetKey);
          events.push({ type: 'bottle_landed', x: b.x1, y: b.y1, ignited });
        } else {
          const t = elapsed / b.travelTicks;
          const bx = Math.round(b.x0 + (b.x1 - b.x0) * t);
          const by = Math.round(b.y0 + (b.y1 - b.y0) * t);
          state.light.sources[`bottle:${bid}`] = { x: bx, y: by, radius: BOTTLE_LIGHT_RADIUS, strength: BOTTLE_LIGHT_STRENGTH };
        }
      }

      // Fire step: fuel decay + spread (src/sim/fire.js), fixed sorted-key
      // snapshot order — see that file's header for the determinism story.
      stepFire(state);

      // Player burn: standing IN fire refreshes the burn timer and deals the
      // full roll; a residual burn (walked off the tile but still smoldering)
      // deals a flat smaller tick until it expires; standing on water/current
      // extinguishes immediately, no damage that tick.
      const onFireKey = `${state.player.x},${state.player.y}`;
      const standingInFire = Object.prototype.hasOwnProperty.call(state.hazards.fire, onFireKey);
      if (standingInFire) {
        state.player.onFireTicks = BURN_STATUS_TICKS;
        const dmg = FIRE_BURN_DMG_BASE + nextInt(state.rng, FIRE_BURN_DMG_ROLL);
        state.player.hp = Math.max(0, state.player.hp - dmg);
        events.push({ type: 'player_hit', by: 'fire', dmg, hp: state.player.hp });
        if (state.player.hp === 0) events.push({ type: 'player_defeated' });
      } else if (state.player.onFireTicks > 0) {
        if (isWater(state, state.player.x, state.player.y)) {
          state.player.onFireTicks = 0;
        } else {
          state.player.onFireTicks -= 1;
          const dmg = RESIDUAL_BURN_DMG;
          state.player.hp = Math.max(0, state.player.hp - dmg);
          events.push({ type: 'player_hit', by: 'fire', dmg, hp: state.player.hp });
          if (state.player.hp === 0) events.push({ type: 'player_defeated' });
        }
      }
      // The fire-on-the-player light source follows them every tick they're
      // still burning — rewritten from the CURRENT position each TICK, not a
      // fixed point, so it moves with the player exactly like the feature
      // asks ("the fire on the player acts as a light source").
      if (state.player.onFireTicks > 0) {
        state.light.sources['player-burning'] = { x: state.player.x, y: state.player.y, radius: 1, strength: 35 };
      } else {
        delete state.light.sources['player-burning'];
      }

      // One recompute covering every light-source mutation this tick: bottle
      // positions, fire tiles, player-burning, and any charge-light cleanup.
      recomputeLight(state);

      return events;
    }

    case 'MOVE': {
      const { dx, dy } = command;
      if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error('MOVE: dx/dy must be integers');
      const nx = clamp(state.player.x + clamp(dx, -1, 1), 0, state.region.w - 1);
      const ny = clamp(state.player.y + clamp(dy, -1, 1), 0, state.region.h - 1);
      // Collision is existence-based, not magnitude-based: any entry in
      // `blocked` blocks movement regardless of its opacity value.
      if (Object.prototype.hasOwnProperty.call(state.region.blocked, `${nx},${ny}`)) {
        return [{ type: 'blocked', x: nx, y: ny }];
      }
      state.player.x = nx;
      state.player.y = ny;
      const events = [{ type: 'moved', x: nx, y: ny }];
      questProgress(state, events, 'reach', null);
      const gate = state.region.zones['the-ascent'];
      if (gate && Math.max(Math.abs(nx - gate.x), Math.abs(ny - gate.y)) <= gate.r) {
        if (state.arc.complete && !state.flags.ended) {
          state.flags.ended = 1;
          events.push({ type: 'chapter_complete' });
        } else if (!state.arc.complete) {
          events.push({ type: 'exit_locked' });
        }
      }
      return events;
    }

    case 'TALK': {
      const npc = state.npcs[command.npcId];
      if (!npc) throw new Error(`TALK: no npc ${command.npcId}`);
      if (dist(state.player, npc) > 1) return [{ type: 'too_far', target: command.npcId }];
      const events = [{ type: 'talked', npc: command.npcId }];
      const offerable = Object.entries(state.quests.defs)
        .filter(([qid, def]) => def.giver === command.npcId)
        .filter(([qid]) => !state.quests.active[qid] && !state.quests.completed[qid])
        .filter(([qid, def]) => (def.requires || []).every((r) => state.quests.completed[r]))
        // requiresAny: an OR prereq (a branch point — either path unlocks the
        // next quest), distinct from `requires`' AND semantics above. Both
        // can be present; a quest with only requiresAny has no `requires`.
        .filter(([qid, def]) => !def.requiresAny || def.requiresAny.some((r) => state.quests.completed[r]))
        .map(([qid]) => qid)
        .sort();
      if (offerable.length) {
        for (const qid of offerable) state.quests.offered[qid] = 1;
        events.push({ type: 'quests_offered', quests: offerable });
      }
      return events;
    }

    case 'ACCEPT_QUEST': {
      const q = command.questId;
      if (!state.quests.offered[q]) throw new Error(`ACCEPT_QUEST: ${q} not offered`);
      const def = state.quests.defs[q];
      for (const oid of Object.keys(state.quests.offered)) {
        if (state.quests.defs[oid].giver === def.giver) delete state.quests.offered[oid];
      }
      state.quests.active[q] = { progress: def.objectives.map(() => 0) };
      const events = [{ type: 'quest_accepted', quest: q }];
      if (def.unlocks) {
        // Enemies telegraph, not instant-spawn: queued here, actually placed
        // into state.enemies a few TICKs later (see the TICK case above) —
        // an 'enemy_incoming' event fires now (nothing to inspect on it but
        // kind/target yet, same tolerance the 'enemy_appeared' handler
        // already has), and the real 'enemy_appeared' fires once it's live.
        for (const [id, tmpl] of Object.entries(def.unlocks.enemies || {})) {
          state.pendingSpawns.push({ id, tmpl, readyTick: state.tick + ENEMY_SPAWN_DELAY_TICKS });
          events.push({ type: 'enemy_incoming', target: id, kind: tmpl.kind });
        }
        // Pickups have no attackability stakes, so they stay instant.
        for (const [id, tmpl] of Object.entries(def.unlocks.pickups || {})) {
          state.pickups[id] = { ...tmpl };
          events.push({ type: 'pickup_appeared', target: id, item: tmpl.item });
        }
      }
      return events;
    }

    case 'INTERACT': {
      const p = state.pickups[command.pickupId];
      if (!p) throw new Error(`INTERACT: no pickup ${command.pickupId}`);
      if (p.taken) return [{ type: 'nothing_there', target: command.pickupId }];
      if (dist(state.player, p) > 1) return [{ type: 'too_far', target: command.pickupId }];
      p.taken = 1;
      state.player.inventory.push(p.item);
      const events = [{ type: 'picked_up', item: p.item }];
      questProgress(state, events, 'collect', p.item);
      return events;
    }

    case 'LIGHT_TORCH': {
      const t = state.torches[command.torchId];
      if (!t) throw new Error(`LIGHT_TORCH: no torch ${command.torchId}`);
      if (t.lit) return [{ type: 'nothing_there', target: command.torchId }];
      if (dist(state.player, t) > 1) return [{ type: 'too_far', target: command.torchId }];
      t.lit = 1;
      state.light.sources[`torch:${command.torchId}`] = { x: t.x, y: t.y, radius: t.radius, strength: t.strength };
      recomputeLight(state);
      // Striking a torch to life is loud and bright, same as a pulse — it
      // reveals the area around it (echo.lit) and alerts anything within
      // earshot, which is exactly what makes lighting one a real, weighable
      // decision for a hunt rather than a free, silent switch-flip.
      const events = [{ type: 'torch_lit', target: command.torchId }];
      events.push(...applyPing(state, t.x, t.y, true));
      return events;
    }

    case 'BREAK': {
      const d = state.destructibles[command.destructibleId];
      if (!d) throw new Error(`BREAK: no destructible ${command.destructibleId}`);
      if (d.broken) return [{ type: 'nothing_there', target: command.destructibleId }];
      if (dist(state.player, d) > 1) return [{ type: 'too_far', target: command.destructibleId }];
      d.broken = 1;
      state.player.coins += d.coins;
      return [{ type: 'broke', target: command.destructibleId, coins: d.coins }];
    }

    case 'MELEE': {
      const e = livingEnemy(state, command.enemyId, 'MELEE');
      if (typeof e === 'object' && e.type) return [e];
      if (dist(state.player, e) > MELEE_RANGE) return [{ type: 'too_far', target: command.enemyId }];
      if (e.immune === 'melee') return [{ type: 'no_effect', target: command.enemyId, kind: 'melee' }];
      const dmg = state.player.skills.melee.lvl + 1 + nextInt(state.rng, 4);
      const events = hitEnemy(state, command.enemyId, e, dmg, 'melee');
      gainXp(state, events, 'melee');
      return events;
    }

    case 'CHARGE': {
      const p = state.player;
      if (command.start) p.chargeHold = 0;
      const hold = p.chargeHold;
      const pct = p.maxAura > 0 ? Math.floor((p.aura * 100) / p.maxAura) : 100;

      let gain;
      if (pct >= CHARGE_TOP_PCT) {
        gain = hold % 2 === 0 ? 1 : 0;
      } else {
        gain = 1 + Math.floor(Math.min(hold, CHARGE_RAMP_CAP) / CHARGE_RAMP_STEP);
        if (pct <= 0) gain += 1;
      }

      p.aura = Math.min(p.maxAura, p.aura + gain);
      p.chargeHold = hold + 1;
      // Charging emits light scaling with how full the aura is right now —
      // the "aura could emit light relative to charge level" request. Radius/
      // strength both clamp so a maxed-out charge stays a modest glow, not a
      // room-filling flood (echo pulses remain the primary way to see far).
      const chargePct = p.maxAura > 0 ? Math.floor((p.aura * 100) / p.maxAura) : 100;
      state.light.sources['player-charge'] = {
        x: p.x, y: p.y,
        radius: Math.min(3, 1 + Math.floor(chargePct / 34)),
        strength: Math.min(70, 20 + Math.floor(chargePct / 2)),
      };
      p.lastChargeTick = state.tick;
      recomputeLight(state);
      return [{ type: 'charged', aura: p.aura, gain }];
    }

    case 'AURA_BLAST': {
      const e = livingEnemy(state, command.enemyId, 'AURA_BLAST');
      if (typeof e === 'object' && e.type) return [e];
      if (dist(state.player, e) > BLAST_RANGE) return [{ type: 'too_far', target: command.enemyId }];
      // You can't aim a blast at something you haven't echo-located: the
      // target must be currently lit (a recent pulse touched its tile).
      // (Melee is exempt — it's range 1, you can strike what's against you.)
      if (!isLit(state, e.x, e.y)) return [{ type: 'unlit', target: command.enemyId }];
      if (state.player.aura < BLAST_COST) return [{ type: 'no_aura', need: BLAST_COST }];
      state.player.aura -= BLAST_COST;
      if (e.immune === 'aura') return [{ type: 'no_effect', target: command.enemyId, kind: 'aura' }];
      const dmg = state.player.skills.aura.lvl + 2 + nextInt(state.rng, 6);
      const events = hitEnemy(state, command.enemyId, e, dmg, 'aura');
      gainXp(state, events, 'aura');
      return events;
    }

    case 'PING': {
      // The signature verb: flood sound outward, light what it touches, and
      // tell every enemy in earshot where the sound came from. A quiet listen
      // is free but short; a loud pulse spends aura to see (and be heard) far.
      const loud = !!command.loud;
      if (loud && state.player.aura < LOUD_PING_COST) return [{ type: 'no_aura', need: LOUD_PING_COST }];
      if (loud) state.player.aura -= LOUD_PING_COST;
      state.player.hasPinged = 1; // one-way: the ambient sight radius gate opens for good
      return applyPing(state, state.player.x, state.player.y, loud);
    }

    case 'CHOOSE_FATE': {
      if (!state.arc.bossDefeated || state.arc.complete) return [{ type: 'not_now' }];
      if (command.fate !== 'silence' && command.fate !== 'answer') {
        throw new Error(`CHOOSE_FATE: bad fate ${command.fate}`);
      }
      state.arc.choice = command.fate;
      state.arc.complete = 1;
      const events = [{ type: 'arc_complete', choice: command.fate }];
      // Both fates carry real mechanical teeth so neither is cosmetic (guards
      // the "extension must reward variance" lesson). Silence: you master the
      // killing pulse (+aura). Answer: you learn the deep's true voice
      // (+perception, and the `deep-voice` technique exported to the finale).
      if (command.fate === 'silence') {
        state.player.skills.aura.lvl += 1;
        events.push({ type: 'power_claimed', skill: 'aura', lvl: state.player.skills.aura.lvl });
      } else {
        state.player.skills.perception.lvl += 1;
        events.push({ type: 'power_claimed', skill: 'perception', lvl: state.player.skills.perception.lvl });
      }
      return events;
    }

    case 'ENEMY_STRIKE': {
      const e = livingEnemy(state, command.enemyId, 'ENEMY_STRIKE');
      if (typeof e === 'object' && e.type) return [e];
      if (dist(state.player, e) > MELEE_RANGE) return [{ type: 'too_far', target: command.enemyId }];
      const dmg = e.power + nextInt(state.rng, 3)
        + (state.settings.difficulty === 'harsh' ? 1 : 0)
        + (isNight(state.tick) ? 1 : 0);
      state.player.hp = Math.max(0, state.player.hp - dmg);
      const events = [{ type: 'player_hit', by: command.enemyId, dmg, hp: state.player.hp }];
      if (state.player.hp === 0) events.push({ type: 'player_defeated' });
      gainIntel(state, e.kind);
      return events;
    }

    case 'BUY': {
      const item = state.items[command.itemId];
      if (!item) throw new Error(`BUY: no item ${command.itemId}`);
      if (item.price === undefined) return [{ type: 'not_for_sale', item: command.itemId }];
      if (state.player.coins < item.price) return [{ type: 'cant_afford', item: command.itemId }];
      state.player.coins -= item.price;
      state.player.inventory.push(command.itemId);
      return [{ type: 'bought', item: command.itemId, coins: state.player.coins }];
    }

    case 'USE_ITEM': {
      const idx = state.player.inventory.indexOf(command.itemId);
      if (idx === -1) return [{ type: 'no_item', item: command.itemId }];
      const item = state.items[command.itemId];
      if (!item || !item.heal) return [{ type: 'cant_use', item: command.itemId }];
      state.player.inventory.splice(idx, 1);
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + item.heal);
      return [{ type: 'healed', hp: state.player.hp }];
    }

    default:
      throw new Error(`reduce: unknown command ${command.type}`);
  }
}

export function replay(state, commands) {
  const events = [];
  for (const c of commands) events.push(...reduce(state, c));
  return events;
}

// --- internals -------------------------------------------------------------

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

// A tile is "lit" (drawable / targetable) if a pulse touched it within the
// reveal window OR a persistent light source currently reaches it — two
// modalities, either one sufficient. state.echo.lit only ever holds
// recently-pinged tiles (the TICK case prunes the rest); state.light.tiles is
// always current (recomputeLight runs whenever a source changes), so a
// bioluminescent vent satisfies the reveal-gate exactly like a ping does.
function isLit(state, x, y) {
  const key = `${x},${y}`;
  if (Object.prototype.hasOwnProperty.call(state.echo.lit, key)) return true;
  return lightAt(state, x, y) > 0;
}

// Emit a pulse from (ox,oy): light every tile it reaches (perception scales
// reach), and flip every enemy in earshot to a 'search' alert homing on the
// ORIGIN tile (a last-known-position — it arrives a beat late where the sound
// WAS). Returns a single 'ping' event carrying the alerted ids for toasts.
// Pure over state + content tuning — no time, no Math transcendentals.
function applyPing(state, ox, oy, loud) {
  const per = state.player.skills.perception.lvl;
  const reach = loud ? LOUD_PING_REACH + per : QUIET_PING_REACH + Math.floor(per / 2);
  const noise = loud ? LOUD_PING_NOISE : QUIET_PING_NOISE;
  const distMap = echoDistanceMap(state, ox, oy, Math.max(reach, noise));
  const lit = revealSet(state, distMap, reach);
  for (const key of lit) state.echo.lit[key] = state.tick;
  state.echo.lastPingTick = state.tick;
  state.echo.lastPingX = ox;
  state.echo.lastPingY = oy;

  const alerted = [];
  for (const id of Object.keys(state.enemies).sort()) {
    const e = state.enemies[id];
    if (!e.alive) continue;
    if (heardAt(distMap, e.x, e.y, Math.min(noise, e.hearing))) {
      e.heardX = ox; e.heardY = oy;
      if (e.aiState !== 'chase' && e.aiState !== 'attack') {
        if (e.aiState !== 'search') e.stateTicks = 0;
        e.aiState = 'search';
      }
      alerted.push(id);
    }
  }
  return [{ type: 'ping', loud, reach, alerted }];
}

function livingEnemy(state, id, cmd) {
  const e = state.enemies[id];
  if (!e) throw new Error(`${cmd}: no enemy ${id}`);
  if (!e.alive) return { type: 'already_down', target: id };
  return e;
}

function hitEnemy(state, id, e, dmg, kind) {
  e.hp = Math.max(0, e.hp - dmg);
  const events = [{ type: 'enemy_hit', target: id, kind, dmg, hp: e.hp }];
  if (e.hp === 0) {
    e.alive = 0;
    state.player.coins += 2;
    events.push({ type: 'enemy_defeated', target: id, kind: e.kind });
    questProgress(state, events, 'kill', e.kind);
    gainIntel(state, e.kind);
  }
  return events;
}

// A win against a kind adds to the player's encounter confidence for that
// kind, same as a loss (see ENEMY_STRIKE) — exposure, not skill, is what's
// being counted (see content.js's confidenceGated doc comment).
function gainIntel(state, kind) {
  state.player.intel[kind] = (state.player.intel[kind] || 0) + 1;
}

function gainXp(state, events, skillName) {
  const s = state.player.skills[skillName];
  s.xp += 1;
  if (s.xp >= s.lvl * XP_PER_LEVEL) {
    s.xp = 0;
    s.lvl += 1;
    events.push({ type: 'skill_up', skill: skillName, lvl: s.lvl });
  }
}

function arcObserve(state, events) {
  const arc = state.arc;
  if (!arc || state.flags.ended) return;

  for (const e of events) {
    if (e.type === 'enemy_defeated' && e.target === arc.bossDef.id) arc.bossDefeated = 1;
  }

  if (!arc.bossSpawned && state.quests.completed['sound-the-deep']) {
    const edge = state.region.zones['the-hollow'];
    const atEdge = edge && Math.max(Math.abs(state.player.x - edge.x), Math.abs(state.player.y - edge.y)) <= edge.r;
    if (atEdge && !state.enemies[arc.bossDef.id]) {
      const b = arc.bossDef;
      state.enemies[b.id] = {
        x: b.x, y: b.y, kind: b.kind,
        hp: b.hp, maxHp: b.hp, power: b.power, alive: 1,
        immune: b.immune || '',
        aiState: 'patrol', homeX: b.x, homeY: b.y, stateTicks: 0,
        // The Answerer hears across the whole hollow — it reliably picks up
        // every ping and homes on where the sound came from, which is exactly
        // "it answers your call" expressed through the search-homing FSM.
        hearing: b.hearing || 12,
        heardX: -1, heardY: -1,
      };
      arc.bossSpawned = 1;
      events.push({ type: 'boss_appeared', boss: b.id });
    }
  }

  if (arc.bossSpawned && !arc.bossTaunted) {
    const boss = state.enemies[arc.bossDef.id];
    if (boss && boss.alive && boss.hp <= Math.floor(boss.maxHp / 2)) {
      arc.bossTaunted = 1;
      boss.power += 1;
      events.push({ type: 'boss_taunted' });
    }
  }
}

function questProgress(state, events, type, target) {
  for (const qId of Object.keys(state.quests.active).sort()) {
    const def = state.quests.defs[qId];
    const st = state.quests.active[qId];
    let done = true;
    def.objectives.forEach((obj, i) => {
      if (obj.type === type) {
        const need = obj.n || 1;
        let match = false;
        if (obj.type === 'kill') match = obj.target === target;
        else if (obj.type === 'collect') match = obj.item === target;
        else if (obj.type === 'reach') {
          const z = state.region.zones[obj.zone];
          match = !!z && Math.max(Math.abs(state.player.x - z.x), Math.abs(state.player.y - z.y)) <= z.r;
        }
        if (match && st.progress[i] < need) {
          st.progress[i] += 1;
          events.push({ type: 'objective_progress', quest: qId, objective: i, at: st.progress[i], of: need });
        }
      }
      if (st.progress[i] < (obj.n || 1)) done = false;
    });
    if (done) {
      delete state.quests.active[qId];
      state.quests.completed[qId] = 1;
      state.player.coins += def.reward.coins || 0;
      events.push({ type: 'quest_completed', quest: qId, reward: def.reward });
    }
  }
}
