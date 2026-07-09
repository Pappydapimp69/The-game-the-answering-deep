// makeWorld is the ONLY constructor of authoritative state. New Game, tests,
// and save-schema defaults all go through here.
//
// The world is BUILT FROM CONTENT (src/sim/content.js) — definitions are
// copied into state at construction so a running save never shifts under a
// content edit. Authoritative fields are integers only.

import { makeRng } from './rng.js';
import { CONTENT } from './content.js';
import { recomputeLight } from './light.js';

// Bumped per game so an incompatible old save routes cleanly to New Game
// (save.js's version check) instead of crashing on a missing/renamed field.
// .1: added state.light (persistent light sources) — an old save lacking it
// would throw the first time anything reads state.light.tiles.
export const WORLD_VERSION = 'answeringdeep4.1';

export function makeWorld(seed, options = {}) {
  if (!Number.isInteger(seed)) throw new Error('makeWorld: seed must be an integer');
  const archId = options.archetype || CONTENT.defaultArchetype;
  const arch = CONTENT.archetypes[archId];
  if (!arch) throw new Error(`makeWorld: unknown archetype ${archId}`);
  const difficulty = options.difficulty || 'gentle';
  if (!['gentle', 'harsh'].includes(difficulty)) throw new Error(`makeWorld: bad difficulty ${difficulty}`);

  const regionDef = CONTENT.regions[CONTENT.startRegion];

  const carrySkills = (options.saga && options.saga.skills) || {};
  const skills = {};
  for (const s of ['melee', 'aura', 'perception']) {
    const base = arch.skills[s] || 1;
    const carried = Number.isInteger(carrySkills[s]) ? carrySkills[s] : 0;
    skills[s] = { lvl: Math.max(base, carried), xp: 0 };
  }

  // Quest-gated ENEMIES/PICKUPS don't exist until their quest is accepted
  // (anti-softlock: a "kill this kind" objective must get a fresh, guaranteed
  // instance rather than possibly requiring a kill of something a free-roam
  // fight already ended) — objectives stay agnostic of prior actions.
  const gatedEnemyIds = new Set(Object.values(CONTENT.quests).flatMap((q) => q.unlocks?.enemies || []));
  const gatedPickupIds = new Set(Object.values(CONTENT.quests).flatMap((q) => q.unlocks?.pickups || []));

  const enemies = {};
  for (const [id, e] of Object.entries(regionDef.enemies)) {
    if (gatedEnemyIds.has(id)) continue;
    enemies[id] = makeEnemy(id, e);
  }
  const npcs = {};
  for (const [id, n] of Object.entries(regionDef.npcs)) {
    npcs[id] = { x: n.x, y: n.y, name: n.name };
    if (n.offers) npcs[id].offers = n.offers;
    if (n.shop) npcs[id].shop = [...n.shop];
  }
  const destructibles = {};
  for (const [id, d] of Object.entries(regionDef.destructibles)) {
    destructibles[id] = { x: d.x, y: d.y, broken: 0, coins: d.coins || 0 };
  }
  const pickups = {};
  for (const [id, p] of Object.entries(regionDef.pickups)) {
    if (gatedPickupIds.has(id)) continue;
    pickups[id] = { x: p.x, y: p.y, item: p.item, taken: 0 };
  }
  const cars = {};
  for (const [id, c] of Object.entries(regionDef.cars || {})) {
    cars[id] = { x: c.x, y: c.y, dir: c.dir };
  }
  const blocked = { ...regionDef.blocked };

  const questDefs = {};
  for (const [qid, q] of Object.entries(CONTENT.quests)) {
    const def = JSON.parse(JSON.stringify(q));
    if (q.unlocks) {
      def.unlocks = { enemies: {}, pickups: {} };
      for (const id of q.unlocks.enemies || []) {
        def.unlocks.enemies[id] = makeEnemy(id, regionDef.enemies[id]);
      }
      for (const id of q.unlocks.pickups || []) {
        const p = regionDef.pickups[id];
        def.unlocks.pickups[id] = { x: p.x, y: p.y, item: p.item, taken: 0 };
      }
    }
    questDefs[qid] = def;
  }
  const items = JSON.parse(JSON.stringify(CONTENT.items));

  const state = {
    version: WORLD_VERSION,
    seed: seed >>> 0,
    tick: 0,
    rng: makeRng(seed >>> 0),
    settings: { difficulty, archetype: archId },
    player: {
      x: regionDef.spawn.x, y: regionDef.spawn.y,
      hp: arch.hp, maxHp: arch.hp,
      aura: 0, maxAura: arch.aura,
      chargeHold: 0,
      coins: 0,
      skills,
      inventory: [],
      // Per-enemy-kind encounter confidence (see content.js's confidenceGated
      // doc comment): both winning AND losing against a kind add to its
      // count — exposure to the kind is what's being measured, not the
      // player's skill against it.
      intel: {},
    },
    region: {
      id: CONTENT.startRegion,
      w: regionDef.w, h: regionDef.h,
      blocked,
      roads: { ...(regionDef.roads || {}) },
      buildings: JSON.parse(JSON.stringify(regionDef.buildings || {})),
      zones: JSON.parse(JSON.stringify(regionDef.zones || {})),
    },
    npcs,
    enemies,
    // Quest-unlocked enemies queued to appear a few ticks after ACCEPT_QUEST
    // (see reduce.js's ACCEPT_QUEST/TICK cases) — a sim-enforced spawn
    // telegraph, not a cosmetic one: the entity genuinely isn't in `enemies`
    // yet, so it can't act on or be struck by anything until it's due.
    pendingSpawns: [],
    cars,
    destructibles,
    pickups,
    items,
    // Echo/sight state (src/sim/sound.js). The deep is dark: a tile is only
    // "lit" (drawable in full) for a short window after an echo pulse touches
    // it. `lit` maps "x,y" -> the tick it was last revealed; the reducer's
    // PING case fills it and the TICK case prunes anything older than the
    // reveal window, so it stays bounded and fully deterministic (integers
    // only, fingerprinted). The renderer reads it; it never writes it.
    echo: { lit: {}, lastPingTick: -99, lastPingX: -1, lastPingY: -1 },
    // Persistent light sources (src/sim/light.js) — unlike echo.lit (a pulse
    // that decays over ticks), a light source stays on the whole time it
    // exists; `tiles` is the CURRENT computed field, recomputed whenever a
    // source is added/removed/moved (right below, once, for this region's
    // fixed ambient sources; reduce.js's PING/TICK cases recompute it again
    // whenever a dynamic source — e.g. a lit thrown bottle — changes).
    light: { sources: {}, tiles: {} },
    quests: { defs: questDefs, offered: {}, active: {}, completed: {} },
    arc: {
      bossDef: {
        ...regionDef.boss,
        hp: CONTENT.enemyKinds[regionDef.boss.kind].hp,
        power: CONTENT.enemyKinds[regionDef.boss.kind].power,
        immune: CONTENT.enemyKinds[regionDef.boss.kind].immune || '',
        hearing: CONTENT.enemyKinds[regionDef.boss.kind].hearing || 12,
      },
      bossSpawned: 0, bossTaunted: 0, bossDefeated: 0,
      choice: '', // '', 'spare', 'depose'
      complete: 0,
    },
    flags: {
      ended: 0,
      // Pure pass-through from the saga chain — this game's own systems never
      // branch on these, but the NEXT game's saga.v4 re-export carries them so
      // the whole chain of choices accumulates to the finale.
      ravagerFate: (options.saga && options.saga.choices && options.saga.choices.ravagerFate) || '',
      riftChoice: (options.saga && options.saga.choices && options.saga.choices.riftChoice) || '',
      wardenFate: (options.saga && options.saga.choices && options.saga.choices.wardenFate) || '',
    },
  };

  // Seed this region's fixed ambient light sources (bioluminescent vents —
  // content-authored, never move) and compute the initial field once. Any
  // FUTURE dynamic source (a lit thrown bottle, a burning tile, the player's
  // own charged aura) is added/removed by reduce.js, which recomputes the
  // field the same way — this is just construction time's version of that.
  for (const [id, ls] of Object.entries(regionDef.lightSources || {})) {
    state.light.sources[id] = { x: ls.x, y: ls.y, radius: ls.radius, strength: ls.strength };
  }
  recomputeLight(state);

  return state;
}

function makeEnemy(id, e) {
  const kind = CONTENT.enemyKinds[e.kind];
  return {
    x: e.x, y: e.y, kind: e.kind, hp: kind.hp, maxHp: kind.hp, power: kind.power, alive: 1,
    immune: kind.immune || '',
    // AI fields — see src/sim/ai.js. homeX/homeY anchor patrol/return-to-post;
    // aiState drives both behavior (reduce.js TICK) and the perception-gated
    // legibility readout (src/sim/info.js); stateTicks is a hysteresis
    // counter so states don't flicker on a boundary crossing.
    aiState: 'patrol',
    homeX: e.x, homeY: e.y,
    stateTicks: 0,
    // Hearing/echo fields (src/sim/sound.js, ai.js). `hearing` is the BFS
    // earshot radius in tiles: a PING whose flood reaches within `hearing` of
    // this enemy flips it to the 'search' alert state, homing on `heardAt`
    // (the tile the sound came FROM — a last-known-position, so it arrives a
    // beat late where the sound WAS, not where the player now is). heardX/Y
    // are -1 when nothing has been heard.
    hearing: kind.hearing || 5,
    heardX: -1, heardY: -1,
  };
}
