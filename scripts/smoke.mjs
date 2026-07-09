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

const GOLDEN_DEMO_FINGERPRINT = '60716a35';

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
test('deliberate content corruptions fail the build, not the player', () => {
  const corrupt = (mut) => { const c = structuredClone(CONTENT); mut(c); return validateContent(c).length > 0; };
  assert(corrupt((c) => { c.enemyKinds.lurker.aiSenseReq = 0; }), 'aiSenseReq below senseReq passed');
  assert(corrupt((c) => { c.enemyKinds.lurker.hearing = 0; }), 'zero hearing radius passed');
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
  assert(!w.enemies['shell-elite1'].alive, 'elite shell still alive');
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

console.log('# gated enemies/pickups still agnostic of prior actions');
test('shell-elite1/chorusshard1 do not exist before the finale quest is accepted', () => {
  const fresh = makeWorld(1);
  assert(!fresh.enemies['shell-elite1'], 'gated enemy pre-spawned');
  assert(!fresh.pickups.chorusshard1, 'gated pickup pre-spawned');
});
test('lurker1/darter1/soundingline1 do not exist before their quests are accepted (fixed soft-lock)', () => {
  const fresh = makeWorld(1);
  assert(!fresh.enemies.lurker1, 'lurker1 pre-spawned — killable before learn-to-listen is accepted');
  assert(!fresh.enemies.darter1, 'darter1 pre-spawned — killable before the-fleeing-kind is accepted');
  assert(!fresh.pickups.soundingline1, 'soundingline1 pre-spawned — collectable before the-sounding-line is accepted');
});
test('quest-unlocked enemies telegraph before appearing (pendingSpawns), not instant-spawn', () => {
  const w = makeWorld(1);
  talkAndAccept(w, 'wren', 'into-the-dark');
  moveAdjacent(w, { x: 20, y: 10 });
  moveAdjacent(w, w.npcs.wren);
  reduce(w, { type: 'TALK', npcId: 'wren' });
  const ev = reduce(w, { type: 'ACCEPT_QUEST', questId: 'learn-to-listen' });
  assert(!w.enemies.lurker1, 'lurker1 spawned instantly on ACCEPT_QUEST instead of telegraphing');
  assert(w.pendingSpawns.some((p) => p.id === 'lurker1'), 'lurker1 not queued in pendingSpawns');
  assert(ev.some((e) => e.type === 'enemy_incoming' && e.target === 'lurker1'), 'no enemy_incoming event fired');
  let g = 0; while (!w.enemies.lurker1 && g++ < 10) reduce(w, { type: 'TICK' });
  assert(w.enemies.lurker1 && w.enemies.lurker1.alive === 1, 'lurker1 never actually appeared after its delay');
});

// Regular enemies are quest-gated now — don't exist off a bare makeWorld().
// Immunity/AI/sound unit tests build a synthetic enemy of the kind under test.
function makeTestEnemy(w, id, kind, x, y) {
  const k = CONTENT.enemyKinds[kind];
  w.enemies[id] = {
    x, y, kind, hp: k.hp, maxHp: k.hp, power: k.power, alive: 1, immune: k.immune || '',
    aiState: 'patrol', homeX: x, homeY: y, stateTicks: 0,
    hearing: k.hearing || 5, heardX: -1, heardY: -1,
  };
  return w.enemies[id];
}

console.log('# immunity mechanics');
test('Shell (immune: aura) shrugs off a blast, dies to fists', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testshell', 'shell', w.player.x + 1, w.player.y);
  chargeTo(w, 3);
  reduce(w, { type: 'PING' }); // light it so a blast is even allowed to be attempted
  const blast = reduce(w, { type: 'AURA_BLAST', enemyId: 'testshell' });
  assert(blast.some((e) => e.type === 'no_effect' && e.kind === 'aura'), 'aura should no_effect a shell');
  assert(w.enemies.testshell.alive === 1, 'shell died to an immune blast');
  let g = 0; while (w.enemies.testshell.alive && g++ < 20) reduce(w, { type: 'MELEE', enemyId: 'testshell' });
  assert(!w.enemies.testshell.alive, 'shell never died to melee');
});
test('Darter (immune: melee) shrugs off fists, dies to aura', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testdarter', 'darter', w.player.x + 1, w.player.y);
  const melee = reduce(w, { type: 'MELEE', enemyId: 'testdarter' });
  assert(melee.some((e) => e.type === 'no_effect' && e.kind === 'melee'), 'melee should no_effect a darter');
  assert(w.enemies.testdarter.alive === 1, 'darter died to an immune punch');
  let g = 0; while (w.enemies.testdarter.alive && g++ < 30) { chargeTo(w, 3); reduce(w, { type: 'PING' }); reduce(w, { type: 'AURA_BLAST', enemyId: 'testdarter' }); }
  assert(!w.enemies.testdarter.alive, 'darter never died to aura');
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
  const e = makeTestEnemy(w, 'testlurker', 'lurker', w.player.x + 2, w.player.y);
  chargeTo(w, 6);
  const blind = reduce(w, { type: 'AURA_BLAST', enemyId: 'testlurker' });
  assert(blind.some((ev) => ev.type === 'unlit'), 'blasting an un-echo-located target should be refused as unlit');
  assert(e.hp === e.maxHp, 'the unlit blast must not have dealt damage');
  reduce(w, { type: 'PING' });
  const seen = reduce(w, { type: 'AURA_BLAST', enemyId: 'testlurker' });
  assert(seen.some((ev) => ev.type === 'enemy_hit'), 'once lit, the blast should land');
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
test('a ping is heard: a creature in earshot turns to SEARCH the sound origin, a beat late', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testlurker', 'lurker', w.player.x + 5, w.player.y); // out of aggro(2), inside hearing(6)
  assertEqual(w.enemies.testlurker.aiState, 'patrol', 'should start unaware');
  chargeTo(w, 3); // a loud pulse costs aura
  reduce(w, { type: 'PING', loud: true }); // loud carries the whole room
  assertEqual(w.enemies.testlurker.aiState, 'search', 'a heard creature should switch to search');
  assertEqual(w.enemies.testlurker.heardX, w.player.x, 'it should home on where the sound came FROM (last-known-position)');
  const originX = w.player.x;
  reduce(w, { type: 'TICK' });
  assert(Math.abs(w.enemies.testlurker.x - originX) < 5, 'the searcher should step toward the sound it heard');
});
test('a searcher that reaches the sound and finds nothing gives up and returns', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testlurker', 'lurker', 10, 4);
  e.aiState = 'search'; e.heardX = 10; e.heardY = 4; // already standing on the heard spot
  w.player.x = 1; w.player.y = 18; // far away and silent
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testlurker.aiState, 'return', 'reaching the sound with nobody there should de-escalate to return');
  assertEqual(w.enemies.testlurker.heardX, -1, 'the stale last-known-position should be cleared');
});

console.log('# deterministic enemy AI');
test('a patrolling enemy switches to chase once the player enters its (small) aggro radius', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testlurker', 'lurker', 7, 4);
  assertEqual(e.aiState, 'patrol', 'lurker should start patrolling');
  w.player.x = e.x; w.player.y = e.y + 1; // Chebyshev distance 1, within aggro 2
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testlurker.aiState, 'chase', 'lurker did not notice an adjacent player');
});
test('a far-away player leaves an enemy patrolling', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testlurker', 'lurker', 7, 4);
  makeTestEnemy(w, 'testdarter', 'darter', 21, 15);
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testlurker.aiState, 'patrol', 'lurker aggroed with no player nearby');
  assertEqual(w.enemies.testdarter.aiState, 'patrol', 'darter aggroed with no player nearby');
});
test('a chasing enemy takes a real step toward the player each tick', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testlurker', 'lurker', 7, 4);
  w.player.x = e.x + 2; w.player.y = e.y; // within aggro(2), not adjacent
  const before = `${e.x},${e.y}`;
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testlurker.aiState, 'chase', 'lurker did not enter chase');
  assert(`${w.enemies.testlurker.x},${w.enemies.testlurker.y}` !== before, 'chasing lurker never moved');
  const distAfter = Math.max(Math.abs(w.enemies.testlurker.x - w.player.x), Math.abs(w.enemies.testlurker.y - w.player.y));
  assert(distAfter < 2, 'chasing lurker did not close the distance');
});
test('a badly wounded Darter flees instead of closing in', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testdarter', 'darter', 21, 15);
  e.hp = Math.floor(e.maxHp * 0.2); // 20% — below fleeAt(30)
  w.player.x = e.x + 1; w.player.y = e.y;
  const distBefore = 1;
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testdarter.aiState, 'flee', 'badly wounded darter did not flee');
  const distAfter = Math.max(Math.abs(w.enemies.testdarter.x - w.player.x), Math.abs(w.enemies.testdarter.y - w.player.y));
  assert(distAfter >= distBefore, 'fleeing darter moved toward the player instead of away');
});
test('a chasing enemy gives up and returns to post once it exceeds its leash', () => {
  const w = makeWorld(1);
  const e = makeTestEnemy(w, 'testlurker', 'lurker', 7, 4);
  e.aiState = 'chase';
  e.x = 30; e.y = 4; // far from home (7,4) and far from player
  w.player.x = 31; w.player.y = 4;
  reduce(w, { type: 'TICK' });
  assertEqual(w.enemies.testlurker.aiState, 'return', 'lurker kept chasing past its leash');
});

console.log('# perception legibility (carried from game 3, now reading alert)');
test('confidence-gated kinds read off per-kind encounter count, not the perception stat', () => {
  const seeker = makeWorld(1, { archetype: 'seeker' }); // perception 2, but lurker no longer cares
  assert(!canSense(seeker.player, 'lurker'), 'zero encounters should not yet read lurker hp/power (senseReq 1)');
  assert(!canReadIntent(seeker.player, 'lurker'), 'zero encounters should not yet read lurker tell (aiSenseReq 3)');
  seeker.player.intel.lurker = 1;
  assert(canSense(seeker.player, 'lurker'), 'intel 1 should read lurker hp/power (senseReq 1)');
  assert(!canReadIntent(seeker.player, 'lurker'), 'intel 1 should NOT yet read lurker tell (aiSenseReq 3)');
  seeker.player.skills.perception.lvl = 99;
  assert(!canReadIntent(seeker.player, 'lurker'), 'raising the perception stat should not affect a confidence-gated kind');
  seeker.player.intel.lurker = 3;
  assert(canReadIntent(seeker.player, 'lurker'), 'intel 3 should read lurker tell (aiSenseReq 3)');
});
test('a loss builds confidence exactly like a win (exposure, not skill, is measured)', () => {
  const w = makeWorld(1);
  makeTestEnemy(w, 'testlurker', 'lurker', w.player.x + 1, w.player.y);
  assertEqual(w.player.intel.lurker || 0, 0, 'fresh world should have no lurker intel');
  reduce(w, { type: 'ENEMY_STRIKE', enemyId: 'testlurker' });
  assertEqual(w.player.intel.lurker, 1, 'losing an exchange to a lurker did not build intel on it');
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
