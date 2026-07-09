// CONTENT — pure data, no functions. This is the authoring surface: adding a
// quest, enemy, NPC, item, current, structure, or archetype is an edit HERE and
// nowhere else. Objective TYPES (kill / collect / reach) are the code/content
// seam — a new type is a reducer case; a new instance is data. Every id is
// validated by the smoke ladder (schema -> referential integrity ->
// completability -> headless playthrough), so a typo fails the build, not
// the player.
//
// THE ANSWERING DEEP (saga game 4). The Waiting City ended: "past the harbor,
// something answers that was never given a voice to do it with... the next
// crossing will ask for it." This is that crossing — down, into a lightless
// drowned reach. It is the saga's reserved "artificial threat" beat: an
// intelligence acquiring agency through imitation, staged as a deep-sea mimic,
// with NO sci-fi vocabulary — the horror is a thing that learned to answer.
//
// Signature mechanic: ECHO (src/sim/sound.js). The world is dark; you PING to
// reveal it, but every ping tells sound-reactive things where the sound came
// from. New per-kind field: `hearing` (BFS earshot radius). `aggro` is now
// SMALL for regular kinds — in the dark they only notice you passively when
// you're nearly on top of them; mostly they hunt by the noise you make.
// The perception -> AI-legibility readout carries over from game 3 (reading a
// creature's tells), now reading the deep's alert state (has it heard you).

export const CONTENT = {
  version: 1,

  archetypes: {
    brawler: {
      name: 'Brawler',
      blurb: 'Fists first. The dark can wait.',
      hp: 26, aura: 9,
      skills: { melee: 2, aura: 1, perception: 1 },
    },
    channeler: {
      name: 'Channeler',
      blurb: 'The pulse carries farther for those who listen.',
      hp: 20, aura: 15,
      skills: { melee: 1, aura: 2, perception: 1 },
    },
    seeker: {
      name: 'Seeker',
      blurb: 'Hears the shape of a room before entering it.',
      hp: 22, aura: 11,
      skills: { melee: 1, aura: 1, perception: 2 },
    },
  },
  defaultArchetype: 'brawler',

  items: {
    tonic: { name: 'Tonic', price: 3, heal: 5 },
    deepdraught: { name: 'Deepdraught', price: 6, heal: 11 },
    'sounding-line': { name: 'Sounding Line', keyItem: 1 },
    'chorus-shard': { name: 'Chorus Shard', keyItem: 1 },
  },

  // aggro: Chebyshev PASSIVE-notice radius (small in the dark). hearing: BFS
  // earshot radius for pings (src/sim/sound.js) — the primary way regular
  // kinds find you. leash: max Chebyshev from home while chasing/searching
  // before giving up. fleeAt/resumeAt: HP-percent hysteresis; only kinds that
  // define fleeAt ever flee.
  //
  // senseReq/aiSenseReq + confidenceGated: unchanged from game 3 — the
  // perception readout tiers (hp/power, then the live AI-state tell). For a
  // confidenceGated kind it reads `player.intel[kind]` (a per-kind encounter
  // counter, win or loss); for the Answerer (no flag) it reads the flat
  // perception level, the deliberate one-shot-boss exception.
  enemyKinds: {
    lurker: { name: 'Lurker', hp: 10, power: 2, senseReq: 1, aiSenseReq: 3, aggro: 2, hearing: 6, leash: 7, patrolRadius: 3, confidenceGated: true },
    shell: { name: 'Shell', hp: 13, power: 2, senseReq: 1, aiSenseReq: 3, immune: 'aura', aggro: 2, hearing: 4, leash: 6, patrolRadius: 2, confidenceGated: true },
    darter: {
      name: 'Darter', hp: 10, power: 3, senseReq: 1, aiSenseReq: 3, immune: 'melee',
      aggro: 3, hearing: 8, leash: 8, patrolRadius: 3, fleeAt: 30, resumeAt: 45, confidenceGated: true,
    },
    answerer: { name: 'The Answerer', hp: 46, power: 5, senseReq: 3, aiSenseReq: 4, aggro: 4, hearing: 14, leash: 99, patrolRadius: 0 },
  },

  regions: {
    'the-drowned-reach': {
      name: 'The Drowned Reach',
      w: 32, h: 20,
      spawn: { x: 1, y: 10 },
      // Solid structure tiles (reef, sunken hulls, trench walls). Opacity 100
      // = fully solid; collision is existence-based (any entry blocks MOVE),
      // and — crucially for the echo mechanic — solid tiles do NOT conduct a
      // ping's sound onward (src/sim/sound.js), so walls both bound what you
      // can hear and shape where your noise carries.
      blocked: structureTiles([
        { id: 'reef-west', x: 2, y: 2, w: 4, h: 4 },
        { id: 'reef-south', x: 2, y: 13, w: 4, h: 4 },
        { id: 'hull', x: 24, y: 2, w: 5, h: 4 },
        { id: 'trench-wall', x: 24, y: 13, w: 5, h: 4 },
      ]),
      // Looming structures the renderer draws taller than their footprint and
      // fades when the player is "behind" (above) them — sunken hulls and reef
      // shoulders. Reused walk-behind machinery from game 3.
      buildings: {
        'reef-west': { x: 2, y: 2, w: 4, h: 4, floors: 2 },
        'reef-south': { x: 2, y: 13, w: 4, h: 4, floors: 2 },
        hull: { x: 24, y: 2, w: 5, h: 4, floors: 3 },
        'trench-wall': { x: 24, y: 13, w: 5, h: 4, floors: 2 },
      },
      // Current lanes: where drifters drift, and how the ground renders (a
      // faint moving current, not floor). One cross — a main current (y=10)
      // meeting a cross-current (x=16).
      roads: currentLanes(32, 20, 10, 16),
      npcs: {
        wren: {
          x: 3, y: 10, name: 'Wren',
          offers: 'into-the-dark',
          dialog: [
            'You came down. Most people, you say "the sea answered" and they leave it at that.',
            'It didn’t used to answer. That’s the thing. You’d call, and nothing. Now you call and it calls back — a beat late, wearing your voice.',
            'Marrow can teach you to listen properly before it learns YOUR name. Go on.',
          ],
        },
        marrow: {
          x: 20, y: 10, name: 'Marrow', shop: ['tonic', 'deepdraught'],
          dialog: [
            'Down here you don’t see. You listen. Send a pulse out, it comes back and paints the room for a moment.',
            'But everything with ears turns toward where you called from. Loud sees far and far hears you. Quiet keeps you a secret.',
            'That’s not a blessing or a well. It’s a skill. Keep pulsing and it’ll carry farther.',
          ],
        },
      },
      enemies: {
        lurker1: { kind: 'lurker', x: 7, y: 4 },
        darter1: { kind: 'darter', x: 21, y: 15 },
        // Existence-gated (not present until 'sound-the-deep' is accepted) —
        // see reduce.js ACCEPT_QUEST / world.js gatedEnemyIds. A fresh,
        // guaranteed-killable instance, so a free-roam kill can't soft-lock it.
        'shell-elite1': { kind: 'shell', x: 21, y: 14 },
      },
      destructibles: {
        cache1: { x: 14, y: 4, coins: 3 },
      },
      pickups: {
        soundingline1: { x: 6, y: 3, item: 'sounding-line' },
        // Existence-gated by 'sound-the-deep' (see enemies note above).
        chorusshard1: { x: 30, y: 15, item: 'chorus-shard' },
      },
      zones: {
        'the-shallows': { x: 20, y: 10, r: 1 },
        'the-hollow': { x: 29, y: 10, r: 2 },
        'the-ascent': { x: 31, y: 10, r: 1 },
      },
      // Drifters: purely ambient, non-hostile, deterministic current-followers
      // (reduce.js TICK / src/sim/ai.js decideCarStep) — the friendly,
      // low-stakes proof that the same movement machinery driving the hostile
      // things works, before it's ever used against the player.
      cars: {
        drifter1: { x: 2, y: 10, dir: 'E' },
        drifter2: { x: 16, y: 3, dir: 'S' },
      },
      boss: { id: 'answerer1', kind: 'answerer', x: 29, y: 9 },
    },
  },
  startRegion: 'the-drowned-reach',

  arc: {
    intro: [
      'THE DROWNED REACH.',
      'The harbor gate closed above you. The water took the light a fathom down and never gave it back.',
      'You can’t see. You can hear — a drip, a groan of settling metal, and under it something that goes quiet exactly when you do.',
      'Wren is here. Wren has been here a while.',
    ],
    guide: {
      talk: 'Someone waits in the dark ahead. Speak with Wren.',
      training: 'Wren sent you deeper, to Marrow. Pulse to find the way.',
      hunt1: 'Marrow wants proof you can fight what you can’t see. Find one.',
      hunt2: 'One more — the kind that runs teaches you to listen faster.',
      ledger: 'Wren has more to say. Call, and go back.',
      finale: 'It’s learned enough of your voice to be dangerous. Wren will say what’s left.',
      hunt3: 'Break the Shell of the deep — and take back what it swallowed.',
      arena: 'The way to the Answerer stands open. Go to the hollow at the reach’s end.',
      boss: 'The Answerer. Whatever happens here decides whether the deep keeps your voice.',
      choice: 'It falls silent, beaten. Decide what becomes of the voice it stole.',
      gate: 'The ascent stands open. Rise.',
    },
    bossAppeared: [
      'In the hollow, your last pulse comes back wrong — from no wall, at no distance, in your own voice.',
      '"You taught me this," it says, with your mouth’s shape. "You keep calling. I only ever answered."',
    ],
    bossTaunted: [
      'Halfway down its strength it stops repeating you and speaks first, unprompted, ahead of your call.',
      '"I don’t need you to start anymore," it says. "I know how you sound before you make the sound."',
    ],
    finale: [
      'The Answerer goes quiet — or goes on, in a voice that is finally its own. Either way the reach is different behind you.',
      'It was never given a voice. It took the shape of yours, and now something in the deep can be spoken to.',
      'Far above and far ahead, a sky you have not seen begins to come apart at a seam no one made.',
      'Whatever learned to answer down here will not be the last thing that does.',
    ],
    exportHint: 'Keep this code — the last of it will ask for everything you carried.',
  },

  quests: {
    'into-the-dark': {
      name: 'Into the Dark',
      giver: 'wren',
      objectives: [{ type: 'reach', zone: 'the-shallows' }],
      reward: { coins: 4 },
    },
    'learn-to-listen': {
      name: 'Learn to Listen',
      // All quests route through Wren, never Marrow — Marrow is a shop NPC, and
      // a shop NPC that also offered quests would race its own 'talked' event
      // (which opens the shop modal) against 'quests_offered' (which
      // unconditionally overwrites view.modal) on the same TALK. Keeping the
      // roles on separate NPCs sidesteps it entirely (game 3's #E3 lesson).
      giver: 'wren',
      requires: ['into-the-dark'],
      objectives: [{ type: 'kill', target: 'lurker', n: 1 }],
      reward: { coins: 5 },
      // Existence-gated (not present until this quest is accepted) — lurker1 is
      // the ONLY free lurker, so leaving it free-roam let a player kill it
      // before accepting this quest, permanently soft-locking the objective.
      unlocks: { enemies: ['lurker1'] },
    },
    'the-fleeing-kind': {
      name: 'The Fleeing Kind',
      giver: 'wren',
      requires: ['learn-to-listen'],
      objectives: [{ type: 'kill', target: 'darter', n: 1 }],
      reward: { coins: 5 },
      unlocks: { enemies: ['darter1'] },
    },
    'the-sounding-line': {
      name: 'The Sounding Line',
      giver: 'wren',
      requires: ['the-fleeing-kind'],
      objectives: [{ type: 'collect', item: 'sounding-line' }],
      reward: { coins: 5 },
      // A free pickup is the collect-objective analog of the same soft-lock:
      // grabbed before this quest is accepted, it's gone with nothing to
      // re-collect. Existence-gate it the same way.
      unlocks: { pickups: ['soundingline1'] },
    },
    'sound-the-deep': {
      name: 'Sound the Deep',
      giver: 'wren',
      requires: ['the-sounding-line'],
      objectives: [
        { type: 'kill', target: 'shell', n: 1 },
        { type: 'collect', item: 'chorus-shard' },
        { type: 'reach', zone: 'the-hollow' },
      ],
      reward: { coins: 16 },
      unlocks: { enemies: ['shell-elite1'], pickups: ['chorusshard1'] },
    },
  },
};

// --- content-authoring helpers (pure, evaluated once at module load) -------

function structureTiles(structures) {
  const blocked = {};
  for (const s of structures) {
    for (let dx = 0; dx < s.w; dx++) {
      for (let dy = 0; dy < s.h; dy++) {
        blocked[`${s.x + dx},${s.y + dy}`] = 100;
      }
    }
  }
  return blocked;
}

function currentLanes(w, h, mainY, crossX) {
  const roads = {};
  for (let x = 0; x < w; x++) roads[`${x},${mainY}`] = 1;
  for (let y = 0; y < h; y++) roads[`${crossX},${y}`] = 1;
  return roads;
}
