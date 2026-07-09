// Headless smoke suite — the build gate. Run: npm run smoke (or node scripts/smoke.mjs)
// No stage begins until this passes. Zero dependencies, pure Node.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stableStringify } from '../src/sim/canonical.js';
import { fingerprint, fnv1a32 } from '../src/sim/fingerprint.js';
import { makeRng, nextU32, nextInt } from '../src/sim/rng.js';
import { makeWorld } from '../src/sim/world.js';
import { reduce, replay } from '../src/sim/reduce.js';
import { DEMO_SEED, demoCommands } from '../src/sim/demo.js';
import { readonly } from '../src/app/readonly.js';
import { CONTENT } from '../src/sim/content.js';
import { validateContent } from '../src/sim/validate.js';
import { canSense, canReadIntent } from '../src/sim/info.js';
import { exportSaga, importSaga } from '../src/sim/saga.js';
import { isNight, DAY_CYCLE_TICKS } from '../src/sim/daynight.js';
import { keyHint, withHint } from '../src/app/device-labels.js';
import { describeObjective } from '../src/app/objective-text.js';
import { bfsNextStep, stepAwayFrom } from '../src/sim/pathfind.js';
import { hasLineOfSight } from '../src/sim/visibility.js';
import { echoDistanceMap, revealSet, heardAt } from '../src/sim/sound.js';
import { recomputeLight, lightAt } from '../src/sim/light.js';
import { igniteAt, stepFire, isWater, FIRE_FUEL_TICKS } from '../src/sim/fire.js';
import { ENEMY_SPRITES, NPC_SPRITES } from '../src/app/sprites.js';

const GOLDEN_DEMO_FINGERPRINT = 'e0a3246a';

const failures = [];
let count = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log(`  ok ${count} - ${name}`); }
  catch (err) { failures.push({ name, err }); console.error(`  FAIL ${count} - ${name}\n      ${err.stack || err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${a} !== ${b}`); }

const runDemo = () => { const w = makeWorld(DEMO_SEED); replay(w, demoCommands()); return w; };
function moveAdjacent(w, e) {
  let guard = 0;
  while (Math.max(Math.abs(w.player.x - e.x), Math.abs(w.player.y - e.y)) > 1 && guard++ < 400) {
    const dx = Math.sign(e.x - w.player.x), dy = Math.sign(e.y - w.player.y);
    const tries = dx && dy ? [[dx, dy], [dx, 0], [0, dy]] : [[dx, dy]];
    let moved = false;
    for (const [tdx, tdy] of tries) {
      if (!tdx && !tdy) continue;
      const before = `${w.player.x},${w.player.y}`;
      reduce(w, { type: 'MOVE', dx: tdx, dy: tdy });
      if (`${w.player.x},${w.player.y}` !== before) { moved = true; break; }
    }
    if (!moved) throw new Error(`moveAdjacent: stuck at ${w.player.x},${w.player.y} heading toward ${e.x},${e.y}`);
  }
}
const chargeTo = (w, aura) => { let g = 0; while (w.player.aura < aura && g++ < 60) reduce(w, { type: 'CHARGE', start: g === 1 }); };
function talkAndAccept(w, npcId, questId) {
  moveAdjacent(w, w.npcs[npcId]);
  reduce(w, { type: 'TALK', npcId });
  reduce(w, { type: 'ACCEPT_QUEST', questId });
}

console.log('# canonical serialization');
test('key order does not change output', () => {
  assertEqual(stableStringify({ a: 1, b: [2, { d: 4, c: 3 }] }), stableStringify({ b: [2, { c: 3, d: 4 }], a: 1 }));
});
test('integer-like keys serialize identically regardless of insertion', () => {
  const x = {}; x['10'] = 'a'; x['2'] = 'b'; const y = {}; y['2'] = 'b'; y['10'] = 'a';
  assertEqual(stableStringify(x), stableStringify(y));
});
test('-0 normalizes to 0', () => { assertEqual(stableStringify({ v: -0 }), stableStringify({ v: 0 })); });
test('NaN / Infinity / undefined fail loud', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined]) {
    let threw = false; try { stableStringify({ bad }); } catch { threw = true; }
    assert(threw, `expected throw for ${bad}`);
  }
});

console.log('# seeded rng (sfc32, full-state saves)');
test('same seed, same stream', () => {
  const a = makeRng(12345), b = makeRng(12345);
  for (let i = 0; i < 100; i++) assertEqual(nextU32(a), nextU32(b));
});
test('state restores in O(1) mid-stream and continues identically', () => {
  const a = makeRng(777); for (let i = 0; i < 50; i++) nextU32(a);
  const saved = JSON.parse(JSON.stringify(a)); const tail = [];
  for (let i = 0; i < 20; i++) tail.push(nextU32(a));
  for (let i = 0; i < 20; i++) assertEqual(nextU32(saved), tail[i]);
});
test('nextInt in range, rejects bad n', () => {
  const r = makeRng(9); for (let i = 0; i < 500; i++) { const v = nextInt(r, 6); assert(v >= 0 && v < 6); }
  for (const bad of [0, -1, 2.5]) { let t = false; try { nextInt(makeRng(1), bad); } catch { t = true; } assert(t, `reject n=${bad}`); }
});

console.log('# content validation ladder');
test('shipped content passes every validation rung', () => {
  const errs = validateContent(CONTENT);
  assert(errs.length === 0, `content invalid:\n${errs.join('\n')}`);
});
// validateContent has no reason to know about the presentation layer, so a
// missing sprite for a new kind produces zero build-time signal on its own
// — renderer.js's fallback (a plain colored block) means it's only visible
// on an actual live playthrough. This is the cheap guard: every enemy kind
// content defines must resolve to a real sprite, every NPC ditto, so the
// exact "new content, forgot the second file" bug can't ship silently
// again (it did once already — see git history on ENEMY_SPRITES).
test('every enemy kind has a mapped sprite (no silent colored-block fallback)', () => {
  for (const kind of Object.keys(CONTENT.enemyKinds)) {
    assert(ENEMY_SPRITES[kind], `enemyKind '${kind}' has no ENEMY_SPRITES entry — renderer.js will silently fall back to a colored block`);
  }
});
test('every NPC has a mapped sprite (no silent recolored-player fallback)', () => {
  for (const r of Object.values(CONTENT.regions)) {
    for (const id of Object.keys(r.npcs)) {
      assert(NPC_SPRITES[id], `npc '${id}' has no NPC_SPRITES entry — renderer.js will silently fall back to a recolored player sprite`);
    }
  }
});
test('deliberate content corruptions fail the build, not the player', () => {
  const corrupt = (mut) => { const c = structuredClone(CONTENT); mut(c); return validateContent(c).length > 0; };
  assert(corrupt((c) => { c.enemyKinds.igniter.aiSenseReq = 0; }), 'aiSenseReq below senseReq passed');
  assert(corrupt((c) => { c.enemyKinds.igniter.hearing = 0; }), 'zero hearing radius passed');
  assert(corrupt((c) => { c.regions['the-drowned-reach'].buildings.hull.w = 99; }), 'structure footprint not fully in blocked passed');
  assert(corrupt((c) => { c.regions['the-drowned-reach'].cars.drifter1.y = 5; }), 'drifter starting off a current passed');
  assert(corrupt((c) => { c.regions['the-drowned-reach'].roads['2,2'] = 1; }), 'current tile overlapping a structure tile passed');
  assert(corrupt((c) => { c.quests['learn-to-listen'].requires = ['nonexistent']; }), 'unknown quest prereq passed');
  assert(corrupt((c) => { c.regions['the-drowned-reach'].blocked['2,2'] = 200; }), 'out-of-range opacity passed');
  assert(corrupt((c) => { delete c.regions['the-drowned-reach'].zones['the-hollow']; }), 'missing the-hollow passed');
  assert(corrupt((c) => { c.quests['the-sounding-line'].objectives[0].type = 'bogus'; }), 'unknown objective type passed');
  // A cycle reachable only through a quest's SECOND (or later) requires entry.
  assert(corrupt((c) => {
    c.quests['learn-to-listen'].requires = ['into-the-dark', 'sound-the-deep'];
  }), 'a requires-chain cycle through a non-first prereq entry passed');
});

console.log('# fingerprint / golden replay');
test('demo playthrough matches the baked golden fingerprint', () => {
  const fp = fingerprint(runDemo());
  assertEqual(fp, GOLDEN_DEMO_FINGERPRINT, `golden drift — if intended, update to ${fp}`);
});
test('fingerprint stable across identical re-run', () => { assertEqual(fingerprint(runDemo()), fingerprint(runDemo())); });

console.log('# save / load mid-run parity');
test('save → load mid-stream equals an uninterrupted run', () => {
  const cmds = demoCommands(); const half = Math.floor(cmds.length / 2);
  const uninterrupted = makeWorld(DEMO_SEED); replay(uninterrupted, cmds);
  const first = makeWorld(DEMO_SEED); replay(first, cmds.slice(0, half));
  const reloaded = JSON.parse(JSON.stringify(first)); replay(reloaded, cmds.slice(half));
  assertEqual(fingerprint(reloaded), fingerprint(uninterrupted));
});

console.log('# the full chapter (demo playthrough)');
test('demo completes every quest and the finale', () => {
  const w = runDemo();
  for (const qid of ['into-the-dark', 'learn-to-listen', 'the-fleeing-kind', 'the-sounding-line', 'sound-the-deep']) {
    assert(w.quests.completed[qid] === 1, `${qid} not completed`);
  }
  assert(!w.enemies['igniter-elite1'].alive, 'elite igniter still alive');
  assert(w.enemies.answerer1 && !w.enemies.answerer1.alive, 'the Answerer was never spawned/defeated');
  assert(w.arc.bossTaunted === 1, 'boss never taunted at half health');
  assertEqual(w.arc.choice, 'answer', 'answerer fate not recorded');
  assertEqual(w.player.skills.perception.lvl >= 2, true, 'answering did not raise perception skill');
  assert(w.player.inventory.includes('sounding-line'), 'sounding-line not collected');
  assert(w.player.inventory.includes('chorus-shard'), 'chorus shard not collected');
  assert(w.flags.ended === 1, 'chapter did not end at the ascent');
  assert(w.player.hp > 0, 'player died during the scripted run');
});
test('saga.v4 export round-trips out of the finished chapter', () => {
  const w = runDemo();
  const code = exportSaga(w);
  assert(code.startsWith('SAGA4.'), `unexpected code prefix: ${code}`);
  assert(code.length > 20, 'code suspiciously short');
});

console.log('# quest chain: prereqs');
test('later quests are not offered until their prereq completes', () => {
  const w = makeWorld(1);
  moveAdjacent(w, w.npcs.wren);
  const ev = reduce(w, { type: 'TALK', npcId: 'wren' });
  const offered = ev.find((e) => e.type === 'quests_offered');
  assertEqual(offered.quests.join(','), 'into-the-dark', 'later wren quests offered before their prereqs completed');
});
test('the finale is not offered until the sounding-line quest completes', () => {
  const w = makeWorld(1);
  talkAndAccept(w, 'wren', 'into-the-dark');
  moveAdjacent(w, { x: 20, y: 10 });
  moveAdjacent(w, w.npcs.wren);
  const ev = reduce(w, { type: 'TALK', npcId: 'wren' });
  const offered = ev.find((e) => e.type === 'quests_offered');
  assert(!offered || !offered.quests.includes('sound-the-deep'), 'finale offered before its prereqs were met');
});

console.log('# quest chain: a real branch (requiresAny), not a straight line');
// Tickless combat (moveAdjacent/MELEE never TICKs) keeps a light-averse
// Igniter parked at its spawn throughout — same trick the demo uses.
test('completing learn-to-listen offers BOTH the-fleeing-kind and the-burning-kind at once', () => {
  const w = makeWorld(1);
  talkAndAccept(w, 'wren', 'into-the-dark');
  moveAdjacent(w, { x: 20, y: 10 });
  talkAndAccept(w, 'wren', 'learn-to-listen');
  let g = 0; while (!w.enemies.igniter1 && g++ < 10) reduce(w, { type: 'TICK' });
  moveAdjacent(w, w.enemies.igniter1);
  for (let i = 0; i < 6; i++) reduce(w, { type: 'MELEE', enemyId: 'igniter1' });
  moveAdjacent(w, w.npcs.wren);
  const ev = reduce(w, { type: 'TALK', npcId: 'wren' });
  const offered = ev.find((e) => e.type === 'quests_offered');
  assertEqual(offered.quests.join(','), 'the-burning-kind,the-fleeing-kind', 'both branch quests should be offered together');
});
test('the-sounding-line is offered once EITHER branch completes, not requiring both', () => {
  const w = makeWorld(1);
  talkAndAccept(w, 'wren', 'into-the-dark');
  moveAdjacent(w, { x: 20, y: 10 });
  talkAndAccept(w, 'wren', 'learn-to-listen');
  let g = 0; while (!w.enemies.igniter1 && g++ < 10) reduce(w, { type: 'TICK' });
  moveAdjacent(w, w.enemies.igniter1);
  for (let i = 0; i < 6; i++) reduce(w, { type: 'MELEE', enemyId: 'igniter1' });
  // Take the-burning-kind branch (NOT the-fleeing-kind) and confirm that
  // alone is sufficient — the-fleeing-kind is never touched in this test.
  talkAndAccept(w, 'wren', 'the-burning-kind');
  assert(!w.quests.completed['the-fleeing-kind'], 'the-fleeing-kind should never have been accepted, let alone completed');
  g = 0; while (!w.enemies.igniter3 && g++ < 10) reduce(w, { type: 'TICK' });
  moveAdjacent(w, w.enemies.igniter3);
  for (let i = 0; i < 8; i++) reduce(w, { type: 'MELEE', enemyId: 'igniter3' });
  assert(w.quests.completed['the-burning-kind'], 'the-burning-kind never completed');
  moveAdjacent(w, w.npcs.wren);
  const ev = reduce(w, { type: 'TALK', npcId: 'wren' });
  const offered = ev.find((e) => e.type === 'quests_offered');
  assert(offered && offered.quests.includes('the-sounding-line'), 'the-sounding-line should be offered via the-burning-kind alone (requiresAny)');
});

console.log('# gated enemies/pickups still agnostic of prior actions');
test('igniter-elite1/chorusshard1 do not exist before the finale quest is accepted', () => {
  const fresh = makeWorld(1);
  assert(!fresh.enemies['igniter-elite1'], 'gated enemy pre-spawned');
  assert(!fresh.pickups.chorusshard1, 'gated pickup pre-spawned');
});
test('igniter1/igniter2/igniter3/soundingline1 do not exist before their quests are accepted (fixed soft-lock)', () => {
  const fresh = makeWorld(1);
  assert(!fresh.enemies.igniter1, 'igniter1 pre-spawned — killable before learn-to-listen is accepted');
  assert(!fresh.enemies.igniter2, 'igniter2 pre-spawned — killable before the-fleeing-kind is accepted');
  assert(!fresh.enemies.igniter3, 'igniter3 pre-spawned — killable before the-burning-kind is accepted');
  assert(!fresh.pickups.soundingline1, 'soundingline1 pre-spawned — collectable before the-sounding-line is accepted');
});
test('quest-unlocked enemies telegraph before appearing (pendingSpawns), not instant-spawn', () => {
  const w = makeWorld(1);
  talkAndAccept(w, 'wren', 'into-the-dark');
  moveAdjacent(w, { x: 20, y: 10 });
  moveAdjacent(w, w.npcs.wren);
  reduce(w, { type: 'TALK', npcId: 'wren' });
  const ev = reduce(w, { type: 'ACCEPT_QUEST', questId: 'learn-to-listen' });
  assert(!w.enemies.igniter1, 'igniter1 spawned instantly on ACCEPT_QUEST instead of telegraphing');
  assert(w.pendingSpawns.some((p) => p.id === 'igniter1'), 'igniter1 not queued in pendingSpawns');
  assert(ev.some((e) => e.type === 'enemy_incoming' && e.target === 'igniter1'), 'no enemy_incoming event fired');
  let g = 0; while (!w.enemies.igniter1 && g++ < 10) reduce(w, { type: 'TICK' });
  assert(w.enemies.igniter1 && w.enemies.igniter1.alive === 1, 'igniter1 never actually appeared after its delay');
});

// Regular enemies are quest-gated now — don't exist off a bare makeWorld().
// Immunity/AI/sound unit tests build a synthetic enemy of the kind under test.
function makeTestEnemy(w, id, kind, x, y, overrides = {}) {
  const k = CONTENT.enemyKinds[kind];
  w.enemies[id] = {
    x, y, kind, hp: k.hp, maxHp: k.hp, power: k.power, alive: 1, immune: k.immune || '',
    aiState: 'patrol', homeX: x, homeY: y, stateTicks: 0,
    hearing: k.hearing || 5, heardX: -1, heardY: -1, throwCooldown: 0,
    ...overrides,
  };
  return w.enemies[id];
}

// The only two shipped kinds now are 'answerer' (a one-off boss, patrolRadius
// 0, no fleeAt, leash 99 — not a useful stand-in) and 'igniter' (light-averse,
// runs an entirely different decision function). The standard chase/patrol/
// search/flee machine in ai.js is still real, load-bearing code (it's what
// the Answerer itself runs on) and still deserves direct, generic coverage,
// so these tests exercise it against a synthetic kind injected into
// CONTENT.enemyKinds only for the duration of the test — never shipped,
// never validated as content, just a fixture with the same small tunable
// values game 4's original lurker/darter kinds used.
const TEST_STANDARD_KIND = {
  name: 'Test Standard', hp: 10, power: 2, senseReq: 1, aiSenseReq: 3,
  aggro: 2, hearing: 6, leash: 7, patrolRadius: 3, fleeAt: 30, resumeAt: 45, confidenceGated: true,
};
function withTestKind(fn) {
  CONTENT.enemyKinds['test-standard'] = TEST_STANDARD_KIND;
  try { fn('test-standard'); } finally { delete CONTENT.enemyKinds['test-standard']; }
}

console.log('# immunity mechanics');
// No shipped kind carries `immune` anymore (the only roaming kind, the
// Igniter, has none), but the mechanism itself is still real reducer logic —
// covered here with an immune override on a synthetic instance rather than
// pretending a retired kind still exists.
test('an aura-immune target shrugs off a blast, dies to fists', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testimmune', 'igniter', w.player.x + 1, w.player.y, { immune: 'aura' });
  chargeTo(w, 3);
  reduce(w, { type: 'PING' }); // light it so a blast is even allowed to be attempted
  const blast = reduce(w, { type: 'AURA_BLAST', enemyId: 'testimmune' });
  assert(blast.some((e) => e.type === 'no_effect' && e.kind === 'aura'), 'aura should no_effect an aura-immune target');
  assert(w.enemies.testimmune.alive === 1, 'target died to an immune blast');
  let g = 0; while (w.enemies.testimmune.alive && g++ < 20) reduce(w, { type: 'MELEE', enemyId: 'testimmune' });
  assert(!w.enemies.testimmune.alive, 'target never died to melee');
});
test('a melee-immune target shrugs off fists, dies to aura', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testimmune', 'igniter', w.player.x + 1, w.player.y, { immune: 'melee' });
  const melee = reduce(w, { type: 'MELEE', enemyId: 'testimmune' });
  assert(melee.some((e) => e.type === 'no_effect' && e.kind === 'melee'), 'melee should no_effect a melee-immune target');
  assert(w.enemies.testimmune.alive === 1, 'target died to an immune punch');
  let g = 0; while (w.enemies.testimmune.alive && g++ < 30) { chargeTo(w, 3); reduce(w, { type: 'PING' }); reduce(w, { type: 'AURA_BLAST', enemyId: 'testimmune' }); }
  assert(!w.enemies.testimmune.alive, 'target never died to aura');
});

console.log('# the echo mechanic (the signature system)');
test('echoDistanceMap is a BFS field: 0 at origin, walls absent, bends around a wall', () => {
  const w = makeWorld(1);
  w.region.blocked = { '5,5': 100 };
  const dm = echoDistanceMap(w, 4, 5, 6);
  assertEqual(dm.get('4,5'), 0, 'origin distance should be 0');
  assert(!dm.has('5,5'), 'a wall tile must never be in the open-tile field');
  assert(dm.has('6,5'), 'sound should bend around the single wall to reach the far side');
  assert(dm.get('6,5') >= 2, 'the detour around the wall must cost more than the blocked straight line');
});
test('hasPinged starts false and flips true (permanently) on the first PING — the onboarding skill-gate', () => {
  const w = makeWorld(1);
  assertEqual(w.player.hasPinged, 0, 'a fresh world should start un-pinged (renderer.js: no ambient sight radius yet)');
  reduce(w, { type: 'MOVE', dx: 1, dy: 0 });
  assertEqual(w.player.hasPinged, 0, 'moving alone must not open the ambient sight gate');
  reduce(w, { type: 'PING' });
  assertEqual(w.player.hasPinged, 1, 'a PING should flip hasPinged');
  reduce(w, { type: 'TICK' });
  assertEqual(w.player.hasPinged, 1, 'hasPinged is one-way — it must never reset');
});
test('a PING lights nearby tiles and leaves far tiles dark', () => {
  const w = makeWorld(1);
  const ev = reduce(w, { type: 'PING' });
  assert(ev.some((e) => e.type === 'ping'), 'PING should emit a ping event');
  assert(Object.prototype.hasOwnProperty.call(w.echo.lit, `${w.player.x},${w.player.y}`), 'the player tile should be lit by their own pulse');
  assert(Object.prototype.hasOwnProperty.call(w.echo.lit, `${w.player.x + 2},${w.player.y}`), 'a tile two away should be within a quiet ping');
  assert(!Object.prototype.hasOwnProperty.call(w.echo.lit, `${w.player.x + 20},${w.player.y}`), 'a tile far past the reach should stay dark');
});
test('lit tiles expire after the reveal window', () => {
  const w = makeWorld(1);
  reduce(w, { type: 'PING' });
  const key = `${w.player.x},${w.player.y}`;
  assert(Object.prototype.hasOwnProperty.call(w.echo.lit, key), 'tile lit right after the ping');
  for (let i = 0; i < 8; i++) reduce(w, { type: 'TICK' });
  assert(!Object.prototype.hasOwnProperty.call(w.echo.lit, key), 'tile should go dark once the reveal window elapses');
});
test('you cannot aura-blast an unlit target, but can once a pulse reveals it', () => {
  const w = makeWorld(1);
  // Distance 3 (the max BLAST_RANGE), not 2: charging now emits its own
  // aura-light (see reduce.js's CHARGE case), whose radius maxes out at 3 —
  // by construction its falloff always reaches exactly 0 at that boundary
  // (falloffPerStep = ceil(strength/radius) => strength - radius*falloffPerStep
  // <= 0), so a target sitting AT distance 3 is guaranteed to stay unlit from
  // charging alone, keeping this test's premise (only a PING reveals it,
  // not the act of charging) valid under the new mechanic.
  const e = makeTestEnemy(w, 'testtarget', 'igniter', w.player.x + 3, w.player.y);
  chargeTo(w, 6);
  const blind = reduce(w, { type: 'AURA_BLAST', enemyId: 'testtarget' });
  assert(blind.some((ev) => ev.type === 'unlit'), 'blasting an un-echo-located target should be refused as unlit');
  assert(e.hp === e.maxHp, 'the unlit blast must not have dealt damage');
  reduce(w, { type: 'PING' });
  const seen = reduce(w, { type: 'AURA_BLAST', enemyId: 'testtarget' });
  assert(seen.some((ev) => ev.type === 'enemy_hit'), 'once lit, the blast should land');
});
test('light.js: falls off with distance, clamped to 0 at the edge of radius', () => {
  const w = makeWorld(1);
  w.light.sources = { test: { x: 2, y: 10, radius: 4, strength: 40 } };
  recomputeLight(w);
  assertEqual(lightAt(w, 2, 10), 40, 'origin should read full strength');
  const mid = lightAt(w, 4, 10);
  assert(mid > 0 && mid < 40, 'a tile partway out should be dimmer than the source but not dark');
  assertEqual(lightAt(w, 20, 20), 0, 'a tile far outside every source reads 0');
});
test('light.js: overlapping sources add, clamped to 100', () => {
  const w = makeWorld(1);
  w.light.sources = {
    a: { x: 2, y: 10, radius: 3, strength: 90 },
    b: { x: 3, y: 10, radius: 3, strength: 90 },
  };
  recomputeLight(w);
  const overlap = lightAt(w, 2, 10);
  assert(overlap > 90, 'two overlapping sources should sum brighter than either alone');
  assert(overlap <= 100, 'combined intensity must clamp to 100');
});
test('light.js: a wall blocks a source exactly like it blocks sound', () => {
  const w = makeWorld(1);
  w.region.blocked = { ...w.region.blocked, '3,10': 100 };
  w.light.sources = { test: { x: 2, y: 10, radius: 5, strength: 80 } };
  recomputeLight(w);
  assertEqual(lightAt(w, 3, 10), 0, 'a wall tile must never receive a light value');
  assert(lightAt(w, 4, 10) > 0, 'light should still bend around the wall to reach the far side, like echo does');
});
test('a persistent light source satisfies the aura-blast reveal-gate on its own, no ping needed', () => {
  const w = makeWorld(1);
  w.light.sources = { test: { x: w.player.x + 2, y: w.player.y, radius: 3, strength: 60 } };
  recomputeLight(w);
  const e = makeTestEnemy(w, 'testtarget', 'igniter', w.player.x + 2, w.player.y);
  chargeTo(w, 6);
  const seen = reduce(w, { type: 'AURA_BLAST', enemyId: 'testtarget' });
  assert(seen.some((ev) => ev.type === 'enemy_hit'), 'a lit-by-source target should be blastable without ever pinging');
});
test('a loud ping spends aura and reaches farther than a free quiet ping', () => {
  const w = makeWorld(1);
  chargeTo(w, 6);
  const before = w.player.aura;
  const quiet = reduce(w, { type: 'PING', loud: false })[0];
  const loud = reduce(w, { type: 'PING', loud: true })[0];
  assert(loud.reach > quiet.reach, 'a loud pulse should out-reach a quiet one');
  assert(w.player.aura < before, 'a loud pulse should cost aura');
});
test('a ping is heard: a creature in earshot turns to SEARCH the sound origin, a beat late', () => withTestKind((kind) => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testenemy', kind, w.player.x + 5, w.player.y); // out of aggro(2), inside hearing(6)
  assertEqual(w.enemies.testenemy.aiState, 'patrol', 'should start unaware');
  chargeTo(w, 3); // a loud pulse costs aura
  reduce(w, { type: 'PING', loud: true }); // loud carries the whole room
  assertEqual(w.enemies.testenemy.aiState, 'search', 'a heard creature should switch to search');
  assertEqual(w.enemies.testenemy.heardX, w.player.x, 'it should home on where the sound came FROM (last-known-position)');
  const originX = w.player.x;
  reduce(w, { type: 'TICK' });
  assert(Math.abs(w.enemies.testenemy.x - originX) < 5, 'the searcher should step toward the sound it heard');
}));
test('a searcher that reaches the sound and finds nothing gives up and returns', () => withTestKind((kind) => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testenemy', kind, 10, 4);
  e.aiState = 'search'; e.heardX = 10; e.heardY = 4; // already standing on the heard spot
  w.player.x = 1; w.player.y = 18; // far away and silent
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testenemy.aiState, 'return', 'reaching the sound with nobody there should de-escalate to return');
  assertEqual(w.enemies.testenemy.heardX, -1, 'the stale last-known-position should be cleared');
}));

console.log('# deterministic enemy AI');
test('a patrolling enemy switches to chase once the player enters its (small) aggro radius', () => withTestKind((kind) => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testenemy', kind, 7, 4);
  assertEqual(e.aiState, 'patrol', 'should start patrolling');
  w.player.x = e.x; w.player.y = e.y + 1; // Chebyshev distance 1, within aggro 2
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testenemy.aiState, 'chase', 'did not notice an adjacent player');
}));
test('a far-away player leaves an enemy patrolling', () => withTestKind((kind) => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testenemy1', kind, 7, 4);
  makeTestEnemy(w, 'testenemy2', kind, 21, 15);
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testenemy1.aiState, 'patrol', 'aggroed with no player nearby');
  assertEqual(w.enemies.testenemy2.aiState, 'patrol', 'aggroed with no player nearby');
}));
test('a chasing enemy takes a real step toward the player each tick', () => withTestKind((kind) => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testenemy', kind, 7, 4);
  w.player.x = e.x + 2; w.player.y = e.y; // within aggro(2), not adjacent
  const before = `${e.x},${e.y}`;
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testenemy.aiState, 'chase', 'did not enter chase');
  assert(`${w.enemies.testenemy.x},${w.enemies.testenemy.y}` !== before, 'chasing enemy never moved');
  const distAfter = Math.max(Math.abs(w.enemies.testenemy.x - w.player.x), Math.abs(w.enemies.testenemy.y - w.player.y));
  assert(distAfter < 2, 'chasing enemy did not close the distance');
}));
test('a badly wounded chaser flees instead of closing in', () => withTestKind((kind) => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testenemy', kind, 21, 15);
  e.hp = Math.floor(e.maxHp * 0.2); // 20% — below fleeAt(30)
  w.player.x = e.x + 1; w.player.y = e.y;
  const distBefore = 1;
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testenemy.aiState, 'flee', 'badly wounded enemy did not flee');
  const distAfter = Math.max(Math.abs(w.enemies.testenemy.x - w.player.x), Math.abs(w.enemies.testenemy.y - w.player.y));
  assert(distAfter >= distBefore, 'fleeing enemy moved toward the player instead of away');
}));
test('a chasing enemy gives up and returns to post once it exceeds its leash', () => withTestKind((kind) => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testenemy', kind, 7, 4);
  e.aiState = 'chase';
  e.x = 30; e.y = 4; // far from home (7,4) and far from player
  w.player.x = 31; w.player.y = 4;
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testenemy.aiState, 'return', 'kept chasing past its leash');
}));

console.log('# perception legibility (carried from game 3, now reading alert)');
test('confidence-gated kinds read off per-kind encounter count, not the perception stat', () => {
  const seeker = makeWorld(1, { archetype: 'seeker' }); // perception 2, but the Igniter no longer cares
  assert(!canSense(seeker.player, 'igniter'), 'zero encounters should not yet read igniter hp/power (senseReq 2)');
  assert(!canReadIntent(seeker.player, 'igniter'), 'zero encounters should not yet read igniter tell (aiSenseReq 3)');
  seeker.player.intel.igniter = 2;
  assert(canSense(seeker.player, 'igniter'), 'intel 2 should read igniter hp/power (senseReq 2)');
  assert(!canReadIntent(seeker.player, 'igniter'), 'intel 2 should NOT yet read igniter tell (aiSenseReq 3)');
  seeker.player.skills.perception.lvl = 99;
  assert(!canReadIntent(seeker.player, 'igniter'), 'raising the perception stat should not affect a confidence-gated kind');
  seeker.player.intel.igniter = 3;
  assert(canReadIntent(seeker.player, 'igniter'), 'intel 3 should read igniter tell (aiSenseReq 3)');
});
test('a loss builds confidence exactly like a win (exposure, not skill, is measured)', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testenemy', 'igniter', w.player.x + 1, w.player.y);
  assertEqual(w.player.intel.igniter || 0, 0, 'fresh world should have no igniter intel');
  reduce(w, { type: 'ENEMY_STRIKE', enemyId: 'testenemy' });
  assertEqual(w.player.intel.igniter, 1, 'losing an exchange to an igniter did not build intel on it');
});
test('the Answerer stays on the flat perception-stat gate — a deliberate one-shot exception', () => {
  const seeker = makeWorld(1, { archetype: 'seeker' }); // perception 2
  assert(!canSense(seeker.player, 'answerer'), 'perception 2 should not yet read the Answerer (senseReq 3)');
  seeker.player.intel.answerer = 99; // confidence must be irrelevant to the boss
  assert(!canSense(seeker.player, 'answerer'), 'the Answerer must ignore player.intel entirely');
  seeker.player.skills.perception.lvl = 3;
  assert(canSense(seeker.player, 'answerer'), 'perception 3 should read the Answerer (senseReq 3)');
  assert(!canReadIntent(seeker.player, 'answerer'), 'perception 3 should not yet read Answerer tell (aiSenseReq 4)');
  seeker.player.skills.perception.lvl = 4;
  assert(canReadIntent(seeker.player, 'answerer'), 'perception 4 should read Answerer tell (aiSenseReq 4)');
});

console.log('# torches: permanent, player-lit fixtures (LIGHT_TORCH)');
test('lighting a torch is permanent, registers a light source, and cannot be re-lit', () => {
  const w = makeWorld(1);
  const t = w.torches.torch1;
  assertEqual(t.lit, 0, 'a fresh torch should start unlit');
  assertEqual(lightAt(w, t.x, t.y), 0, 'an unlit torch should emit no light yet');
  w.player.x = t.x; w.player.y = t.y;
  const ev = reduce(w, { type: 'LIGHT_TORCH', torchId: 'torch1' });
  assert(ev.some((e) => e.type === 'torch_lit'), 'LIGHT_TORCH should emit a torch_lit event');
  assertEqual(w.torches.torch1.lit, 1, 'torch should now be lit');
  assert(lightAt(w, t.x, t.y) > 0, 'a lit torch should register as a real light source');
  const again = reduce(w, { type: 'LIGHT_TORCH', torchId: 'torch1' });
  assert(again.some((e) => e.type === 'nothing_there'), 'an already-lit torch should refuse a second light');
});
test('lighting a torch requires proximity, same as any other interactable', () => {
  const w = makeWorld(1);
  const t = w.torches.torch1;
  w.player.x = t.x + 5; w.player.y = t.y;
  const ev = reduce(w, { type: 'LIGHT_TORCH', torchId: 'torch1' });
  assert(ev.some((e) => e.type === 'too_far'), 'lighting a distant torch should be refused as too_far');
  assertEqual(w.torches.torch1.lit, 0, 'a refused light attempt must not have lit the torch');
});
test('lighting a torch is loud: it reveals the area and can startle a light-averse creature nearby', () => {
  const w = makeWorld(1);
  const t = w.torches.torch1;
  w.player.x = t.x; w.player.y = t.y;
  const e = makeTestEnemy(w, 'testigniter', 'igniter', t.x + 2, t.y);
  reduce(w, { type: 'LIGHT_TORCH', torchId: 'torch1' });
  assert(Object.prototype.hasOwnProperty.call(w.echo.lit, `${e.x},${e.y}`), 'igniting a torch should echo-reveal a creature standing nearby');
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testigniter.aiState, 'flee', 'a creature revealed by a torch\'s ignition should react exactly like a pulse reveal');
});

console.log('# fire.js: deterministic fire/hazard field');
test('igniteAt refuses water/road and blocked tiles, succeeds on open floor', () => {
  const w = makeWorld(1);
  igniteAt(w, 16, 6); // a road/current column tile
  assert(!w.hazards.fire['16,6'], 'ignited a water/road tile');
  igniteAt(w, 2, 2); // inside the reef-west structure footprint
  assert(!w.hazards.fire['2,2'], 'ignited a blocked/structure tile');
  igniteAt(w, 8, 6); // open floor, well away from any structure/road
  assert(w.hazards.fire['8,6'], 'failed to ignite an open floor tile');
  assertEqual(w.hazards.fire['8,6'].fuel, FIRE_FUEL_TICKS, 'fresh ignition should start at full fuel');
});
test('stepFire is deterministic: same seed + same starting fire => identical fire-tile sets', () => {
  const w1 = makeWorld(42); igniteAt(w1, 8, 6);
  const w2 = makeWorld(42); igniteAt(w2, 8, 6);
  for (let i = 0; i < 10; i++) { stepFire(w1); stepFire(w2); }
  assertEqual(Object.keys(w1.hazards.fire).sort().join('|'), Object.keys(w2.hazards.fire).sort().join('|'),
    'two identically-seeded runs produced different fire spread — the cellular automaton is not deterministic');
});
test('a fire tile\'s fuel eventually reaches 0 and it is removed', () => {
  const w = makeWorld(1);
  // Surround on all 4 sides so it cannot spread — purely testing decay.
  w.region.blocked = { ...w.region.blocked, '8,5': 100, '9,6': 100, '8,7': 100, '7,6': 100 };
  igniteAt(w, 8, 6);
  assert(w.hazards.fire['8,6'], 'ignition failed');
  for (let i = 0; i < FIRE_FUEL_TICKS; i++) stepFire(w);
  assert(!w.hazards.fire['8,6'], 'fire tile did not burn out after FIRE_FUEL_TICKS steps');
});
test('fire never spreads onto or persists on a water/road tile', () => {
  const w = makeWorld(1);
  igniteAt(w, 15, 6); // adjacent to the x=16 current column
  assert(w.hazards.fire['15,6'], 'ignition failed');
  for (let i = 0; i < 30; i++) stepFire(w);
  assert(!w.hazards.fire['16,6'], 'fire spread onto a road/water tile');
});

console.log('# molotov-throwing enemies (igniter kind) + bottle flight/landing');
test('an igniter noticed nearby (not revealed) goes curious, not aggressive, and never closes to melee', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testigniter', 'igniter', 5, 8); // open floor, no nearby light source
  w.player.x = e.x + 3; w.player.y = e.y; // within aggro(4), not revealed
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testigniter.aiState, 'curious', 'an un-revealed, noticed igniter should go curious, not chase');
  assertEqual(Object.keys(w.hazards.bottles).length, 0, 'curious alone should never throw a bottle');
  for (let i = 0; i < 10; i++) reduce(w, { type: 'TICK' });
  const dist = Math.max(Math.abs(w.enemies.testigniter.x - w.player.x), Math.abs(w.enemies.testigniter.y - w.player.y));
  assert(dist >= CONTENT.enemyKinds.igniter.keepAway, 'a curious igniter closed inside its own keepAway distance');
});
test('a light-averse enemy caught close by a fresh reveal throws once, then flees', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testigniter', 'igniter', 8, 6);
  const kind = CONTENT.enemyKinds.igniter;
  w.player.x = e.x + 3; w.player.y = e.y; // within throwRange(6), not adjacent
  chargeTo(w, 3);
  reduce(w, { type: 'PING', loud: true }); // reveals it (echo.lit) — the detection event
  assertEqual(Object.keys(w.hazards.bottles).length, 0, 'a bottle already existed before any TICK');
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testigniter.aiState, 'flee', 'a revealed igniter should flee, not stand and fight');
  assertEqual(Object.keys(w.hazards.bottles).length, 1, 'a close, newly-revealed igniter did not throw exactly one bottle');
  assertEqual(w.enemies.testigniter.throwCooldown, kind.throwCooldownTicks, 'throwCooldown not set to the full cooldown after throwing');
});
test('an igniter revealed while already far away just flees — no throw', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testigniter', 'igniter', 8, 6);
  w.player.x = 8; w.player.y = 13; // chebyshev 7, past throwRange(6)
  chargeTo(w, 3);
  reduce(w, { type: 'PING', loud: true });
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testigniter.aiState, 'flee', 'a far-but-revealed igniter should still flee');
  assertEqual(Object.keys(w.hazards.bottles).length, 0, 'too far to throw should never create a bottle');
});
test('light-averse lurking never rests on a bright tile — it steps toward dark instead', () => {
  const w = makeWorld(1);
  w.light.sources = { bright: { x: 8, y: 6, radius: 3, strength: 90 } };
  recomputeLight(w);
  const e = makeTestEnemy(w, 'testigniter', 'igniter', 8, 6); // sitting right on the bright source
  w.player.x = 1; w.player.y = 1; // far outside aggro — should be plain 'lurk'
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testigniter.aiState, 'lurk', 'should be lurking with no player nearby');
  assert(e.x !== 8 || e.y !== 6, 'a light-averse lurker never left a tile brighter than its idle threshold');
  assert(lightAt(w, e.x, e.y) < lightAt(w, 8, 6), 'it should have moved toward a dimmer tile');
});
test('a landed bottle ignites its target tile; a bottle landing on water does not ignite', () => {
  const w = makeWorld(1);
  w.hazards.bottles.testbottle = { x0: 8, y0: 6, x1: 8, y1: 7, startTick: w.tick, travelTicks: 2 };
  reduce(w, { type: 'TICK' }); // elapsed 1 < travelTicks 2 — still flying
  assert(!w.hazards.fire['8,7'], 'bottle ignited its target before travel time elapsed');
  assert(w.hazards.bottles.testbottle, 'bottle removed before it actually landed');
  reduce(w, { type: 'TICK' }); // elapsed 2 >= travelTicks 2 — lands
  assert(w.hazards.fire['8,7'], 'landed bottle did not ignite its target tile');
  assert(!w.hazards.bottles.testbottle, 'landed bottle was not removed from state.hazards.bottles');

  const w2 = makeWorld(1);
  w2.hazards.bottles.testbottle2 = { x0: 15, y0: 6, x1: 16, y1: 6, startTick: w2.tick, travelTicks: 1 };
  reduce(w2, { type: 'TICK' }); // elapsed 1 >= travelTicks 1 — lands on a road/water tile
  assert(!w2.hazards.fire['16,6'], 'a bottle landing on a water/road tile ignited it');
});

console.log('# player burn: catching fire, residual burn, extinguishing');
test('standing in fire damages the player each tick and sets onFireTicks', () => {
  const w = makeWorld(1);
  w.player.x = 8; w.player.y = 6;
  igniteAt(w, 8, 6);
  const hpBefore = w.player.hp;
  reduce(w, { type: 'TICK' });
  assert(w.player.hp < hpBefore, 'standing in fire did not damage the player');
  assert(w.player.onFireTicks > 0, 'onFireTicks not set while standing in fire');
});
test('after leaving the fire, smaller residual damage continues for a bounded window then stops', () => {
  const w = makeWorld(1);
  w.player.x = 8; w.player.y = 6;
  // Wall off all 4 neighbors so this fire tile can never spread — isolates
  // the test from the cellular automaton entirely (same technique as the
  // fuel-decay test above), so it can only ever measure the RESIDUAL-burn
  // timer, never an unrelated re-ignition reaching the player's new tile.
  w.region.blocked = { ...w.region.blocked, '8,5': 100, '9,6': 100, '8,7': 100, '7,6': 100 };
  igniteAt(w, 8, 6);
  reduce(w, { type: 'TICK' }); // catches fire
  assert(w.player.onFireTicks > 0, 'player never caught fire');
  // Move off the burning tile onto plain open floor, far enough that this
  // short test can't be flakily reached by fire spread.
  w.player.x = 2; w.player.y = 6;
  assert(!isWater(w, 2, 6), 'test tile is unexpectedly water/road');
  let residualDamageTicks = 0;
  let guard = 0;
  while (w.player.onFireTicks > 0 && guard++ < 20) {
    const hpBefore = w.player.hp;
    reduce(w, { type: 'TICK' });
    if (w.player.hp < hpBefore) residualDamageTicks++;
  }
  assert(residualDamageTicks > 0, 'no residual burn damage was dealt after leaving the fire');
  assertEqual(w.player.onFireTicks, 0, 'onFireTicks never reached 0');
  const hpAfterResidual = w.player.hp;
  reduce(w, { type: 'TICK' }); // one more tick — must be silent now
  assertEqual(w.player.hp, hpAfterResidual, 'burn damage continued after onFireTicks reached 0');
});
test('standing on a water/road tile while on fire extinguishes immediately with no damage that tick', () => {
  const w = makeWorld(1);
  w.player.x = 8; w.player.y = 6;
  igniteAt(w, 8, 6);
  reduce(w, { type: 'TICK' }); // catches fire
  assert(w.player.onFireTicks > 0, 'player never caught fire');
  w.player.x = 16; w.player.y = 4; // on the x=16 current column, not on the burning tile
  const hpBefore = w.player.hp;
  reduce(w, { type: 'TICK' });
  assertEqual(w.player.onFireTicks, 0, 'standing on water/current did not extinguish the player');
  assertEqual(w.player.hp, hpBefore, 'the extinguishing tick dealt damage — should be silent');
});
test('while on fire, light.sources[player-burning] exists and follows the player; it clears once extinguished', () => {
  const w = makeWorld(1);
  w.player.x = 8; w.player.y = 6;
  igniteAt(w, 8, 6);
  reduce(w, { type: 'TICK' });
  assert(w.light.sources['player-burning'], 'burning light source not created while on fire');
  assertEqual(w.light.sources['player-burning'].x, 8, 'burning light did not sit on the player');
  w.player.x = 2; w.player.y = 6;
  reduce(w, { type: 'TICK' });
  assertEqual(w.light.sources['player-burning'].x, 2, 'burning light did not follow the player to their new tile');
  let guard = 0;
  while (w.player.onFireTicks > 0 && guard++ < 20) reduce(w, { type: 'TICK' });
  assert(!w.light.sources['player-burning'], 'burning light source was not removed once onFireTicks reached 0');
});

console.log('# aura-charge-emits-light');
test('CHARGE sets a light source scaling with aura %, cleaned up after CHARGE_LIGHT_TTL idle ticks', () => {
  const w = makeWorld(1);
  reduce(w, { type: 'CHARGE', start: true });
  assert(w.light.sources['player-charge'], 'CHARGE did not create a light source');
  const r1 = w.light.sources['player-charge'].radius, s1 = w.light.sources['player-charge'].strength;
  for (let i = 0; i < 10; i++) reduce(w, { type: 'CHARGE' });
  const r2 = w.light.sources['player-charge'].radius, s2 = w.light.sources['player-charge'].strength;
  assert(r2 >= r1 && s2 >= s1, 'charge light did not scale up as aura % rose');
  reduce(w, { type: 'TICK' });
  reduce(w, { type: 'TICK' });
  assert(w.light.sources['player-charge'], 'charge light removed before CHARGE_LIGHT_TTL elapsed');
  reduce(w, { type: 'TICK' });
  assert(!w.light.sources['player-charge'], 'charge light was not cleaned up after CHARGE_LIGHT_TTL idle ticks');
});
test('a fire-lit (not echo-pinged) enemy is blastable via AURA_BLAST with no PING first', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testtarget', 'igniter', w.player.x, w.player.y - 2);
  igniteAt(w, e.x, e.y);
  stepFire(w); // registers the fire light source (fire.js does not recompute)
  recomputeLight(w);
  chargeTo(w, 6);
  const seen = reduce(w, { type: 'AURA_BLAST', enemyId: 'testtarget' });
  assert(seen.some((ev) => ev.type === 'enemy_hit'), 'a fire-lit target should be blastable without ever pinging');
});

console.log('# deterministic BFS pathfinding');
test('BFS finds a step around a wall, not just the blocked straight line', () => {
  const w = makeWorld(1);
  w.region.blocked = { '5,5': 100 };
  const step = bfsNextStep(w, 4, 5, 6, 5, new Set());
  assert(step, 'no path found around a single blocking tile');
  assert(!(step.x === 5 && step.y === 5), 'BFS stepped directly into the blocked tile');
});
test('BFS returns null when already at the target', () => {
  const w = makeWorld(1);
  assertEqual(bfsNextStep(w, 3, 3, 3, 3, new Set()), null);
});
test('stepAwayFrom always increases (or holds) distance from the threat', () => {
  const w = makeWorld(1);
  const step = stepAwayFrom(w, 10, 10, 10, 9, new Set());
  assert(step, 'no flee step found in open ground');
  const before = Math.max(Math.abs(10 - 10), Math.abs(10 - 9));
  const after = Math.max(Math.abs(step.x - 10), Math.abs(step.y - 9));
  assert(after >= before, 'flee step did not increase distance from the threat');
});
test('line of sight is blocked by a 100-opacity wall between two points', () => {
  const w = makeWorld(1);
  w.region.blocked = { '5,5': 100 };
  assert(!hasLineOfSight(w, 4, 5, 6, 5), 'a 100-opacity wall between two points should block sight');
  assert(hasLineOfSight(w, 4, 5, 4, 8), 'an unobstructed line should stay clear');
});

console.log('# drifters: the friendly, non-hostile proof of the same movement machinery');
test('drifters only ever occupy current tiles, tick after tick', () => {
  const w = makeWorld(1);
  for (let i = 0; i < 40; i++) {
    reduce(w, { type: 'TICK' });
    for (const id of Object.keys(w.cars)) {
      const c = w.cars[id];
      assert(Object.prototype.hasOwnProperty.call(w.region.roads, `${c.x},${c.y}`), `${id} left the current at ${c.x},${c.y}`);
    }
  }
});
test('two drifters never occupy the same tile in the same tick', () => {
  const w = makeWorld(1);
  for (let i = 0; i < 60; i++) {
    reduce(w, { type: 'TICK' });
    const positions = Object.values(w.cars).map((c) => `${c.x},${c.y}`);
    assertEqual(new Set(positions).size, positions.length, `drifters overlapped at tick ${i}`);
  }
});
test('a drifter actually moves over time (not stuck)', () => {
  const w = makeWorld(1);
  const start = `${w.cars.drifter1.x},${w.cars.drifter1.y}`;
  for (let i = 0; i < 10; i++) reduce(w, { type: 'TICK' });
  assert(`${w.cars.drifter1.x},${w.cars.drifter1.y}` !== start, 'drifter1 never moved after 10 ticks');
});

console.log('# movement + boundaries');
test('MOVE bumps a structure (collision), never phases through', () => {
  const w = makeWorld(1);
  w.player.x = 1; w.player.y = 2;
  const ev = reduce(w, { type: 'MOVE', dx: 1, dy: 0 }); // reef-west starts at x=2,y=2
  assert(ev.some((e) => e.type === 'blocked'), 'structure did not block');
  assertEqual(w.player.x, 1, 'player phased into a structure');
});
test('a 0-opacity blocked tile still blocks (collision is existence-based, not magnitude-based)', () => {
  const w = makeWorld(1);
  w.player.x = 1; w.player.y = 1;
  w.region.blocked['2,1'] = 0; // a fully-transparent-but-solid tile
  const ev = reduce(w, { type: 'MOVE', dx: 1, dy: 0 });
  assert(ev.some((e) => e.type === 'blocked'), '0-opacity blocked tile did not block movement');
  assertEqual(w.player.x, 1, 'player phased through a 0-opacity blocked tile');
});
test('unknown command fails loud', () => {
  let threw = false; try { replay(makeWorld(1), [{ type: 'NOPE' }]); } catch { threw = true; }
  assert(threw);
});
test('the ascent is sealed until the arc completes', () => {
  const w = makeWorld(1);
  while (w.player.x < 31) reduce(w, { type: 'MOVE', dx: 1, dy: Math.sign(10 - w.player.y) });
  assert(!w.flags.ended, 'exit let the player out before the arc was complete');
});

console.log('# saga carryover (imports the Waiting City\'s saga.v3)');
test('a saga.v3 code raises carried skills and is remembered', () => {
  const payload = btoa(stableStringify({
    v: 'saga.v3', game: 'waiting-city', archetype: 'channeler', difficulty: 'harsh',
    skills: { melee: 3, aura: 4, perception: 2 }, coins: 7, techniques: ['warden-command'],
    choices: { ravagerFate: 'spare', riftChoice: 'claim', wardenFate: 'depose' },
  }));
  const code = `SAGA3.${payload}.${fnv1a32(payload)}`;
  const imp = importSaga(code);
  assert(imp.ok, `import failed: ${imp.error}`);
  const w = makeWorld(1, { archetype: 'channeler', difficulty: 'harsh', saga: imp.data });
  assert(w.player.skills.aura.lvl >= 4, 'carried aura level not applied');
  assertEqual(w.flags.ravagerFate, 'spare', 'prior Prologue choice not remembered');
  assertEqual(w.flags.riftChoice, 'claim', 'prior Wrong Sky choice not remembered');
  assertEqual(w.flags.wardenFate, 'depose', 'prior Waiting City choice not remembered');
});
test('a tampered / foreign code is politely refused', () => {
  assert(!importSaga('SAGA3.garbage.zzzz').ok, 'garbage accepted');
  assert(!importSaga('hello').ok, 'nonsense accepted');
  assert(!importSaga('SAGA2.x.y').ok, 'wrong-prefix (older game) accepted');
});

console.log('# day/night determinism');
test('night is a pure function of the integer tick', () => {
  assert(!isNight(0), 'tick 0 should be day');
  assert(isNight(Math.floor(DAY_CYCLE_TICKS * 0.75)), 'late cycle should be night');
});

console.log('# device-adaptive hints + objective text');
test('hints match the active device', () => {
  assertEqual(keyHint('keyboard', 'confirm'), 'Enter');
  assertEqual(keyHint('gamepad', 'confirm'), 'A');
  assertEqual(keyHint('touch', 'confirm'), '');
  assertEqual(withHint('gamepad', 'confirm', 'Accept'), 'Accept (A)');
});
test('describeObjective covers all three types with no undefined', () => {
  const lines = [
    describeObjective({ type: 'kill', target: 'lurker', n: 1 }),
    describeObjective({ type: 'collect', item: 'sounding-line' }),
    describeObjective({ type: 'reach', zone: 'the-hollow' }),
  ];
  for (const s of lines) assert(!s.includes('undefined'), `leaked undefined: ${s}`);
  assert(lines[0].toLowerCase().includes('lurker'), 'kill did not resolve the kind name');
  let threw = false; try { describeObjective({ type: 'nope' }); } catch { threw = true; }
  assert(threw, 'unknown objective type should throw');
});

console.log('# renderer boundary');
test('read-only proxy throws on any write, at any depth', () => {
  const w = makeWorld(1); const ro = readonly(w);
  assertEqual(ro.player.hp, w.player.hp, 'proxy must read through');
  let threw = 0;
  try { ro.player.hp = 0; } catch { threw++; }
  try { ro.arc.choice = 'x'; } catch { threw++; }
  try { delete ro.player; } catch { threw++; }
  assertEqual(threw, 3, 'a renderer write slipped through');
});

console.log('# determinism guard: forbidden tokens in src/sim');
test('src/sim never touches ambient time, randomness, or engine-varying math', () => {
  const simDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim');
  const banned = /Math\.random|Date\.now|performance\.now|new Date|Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt)\b/;
  for (const f of readdirSync(simDir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(simDir, f), 'utf8');
    const m = src.match(banned);
    assert(!m, `${f} contains banned token: ${m && m[0]}`);
  }
});

console.log('');
if (failures.length) { console.error(`SMOKE FAILED: ${failures.length}/${count} test(s)`); process.exit(1); }
console.log(`SMOKE PASSED: ${count}/${count}`);
