// The validation ladder for CONTENT. Data-driven content opts out of
// compile-time safety — a typo'd id ships an uncompletable quest with no
// error — so validation must fail the BUILD, not the player.
//
// Rungs (JSON-Schema-style shape checks alone can't see across collections,
// which is exactly where content bugs live):
//   1. schema        — required fields, types, value ranges
//   2. references    — every id points at something that exists
//   3. completability — every quest objective is achievable in its world
// Rung 4 is the headless demo playthrough in the smoke suite.

export function validateContent(c) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const isInt = Number.isInteger;

  // --- rung 1: schema -------------------------------------------------------
  if (!isInt(c.version)) err('content.version must be an integer');
  if (!c.archetypes || !Object.keys(c.archetypes).length) err('no archetypes');
  for (const [id, a] of Object.entries(c.archetypes || {})) {
    if (!a.name) err(`archetype ${id}: missing name`);
    if (!isInt(a.hp) || a.hp <= 0) err(`archetype ${id}: bad hp`);
    if (!isInt(a.aura) || a.aura <= 0) err(`archetype ${id}: bad aura`);
    for (const [s, lvl] of Object.entries(a.skills || {})) {
      if (!['melee', 'aura', 'perception'].includes(s)) err(`archetype ${id}: unknown skill ${s}`);
      if (!isInt(lvl) || lvl < 1) err(`archetype ${id}: bad ${s} level`);
    }
  }
  for (const [id, k] of Object.entries(c.enemyKinds || {})) {
    if (!isInt(k.hp) || k.hp <= 0) err(`enemyKind ${id}: bad hp`);
    if (!isInt(k.power) || k.power < 1) err(`enemyKind ${id}: bad power`);
    if (!isInt(k.senseReq) || k.senseReq < 1) err(`enemyKind ${id}: bad senseReq`);
    if (!isInt(k.aiSenseReq) || k.aiSenseReq < k.senseReq) err(`enemyKind ${id}: aiSenseReq must be an int >= senseReq`);
    if (!isInt(k.aggro) || k.aggro < 1) err(`enemyKind ${id}: bad aggro radius`);
    if (!isInt(k.hearing) || k.hearing < 1) err(`enemyKind ${id}: bad hearing radius`);
    if (!isInt(k.leash) || k.leash < 1) err(`enemyKind ${id}: bad leash`);
    if (!isInt(k.patrolRadius) || k.patrolRadius < 0) err(`enemyKind ${id}: bad patrolRadius`);
    if (k.confidenceGated !== undefined && typeof k.confidenceGated !== 'boolean') err(`enemyKind ${id}: confidenceGated must be a boolean if present`);
    if (k.immune !== undefined && k.immune !== 'melee' && k.immune !== 'aura') {
      err(`enemyKind ${id}: bad immune ${k.immune} (must be 'melee' or 'aura' if present)`);
    }
    if (k.fleeAt !== undefined) {
      if (!isInt(k.fleeAt) || k.fleeAt < 0 || k.fleeAt > 100) err(`enemyKind ${id}: bad fleeAt`);
      if (!isInt(k.resumeAt) || k.resumeAt <= k.fleeAt || k.resumeAt > 100) err(`enemyKind ${id}: resumeAt must be an int > fleeAt and <= 100`);
    }
  }
  for (const [id, it] of Object.entries(c.items || {})) {
    if (it.price !== undefined && (!isInt(it.price) || it.price < 0)) err(`item ${id}: bad price`);
    if (it.heal !== undefined && (!isInt(it.heal) || it.heal <= 0)) err(`item ${id}: bad heal`);
  }
  for (const [rid, r] of Object.entries(c.regions || {})) {
    if (!isInt(r.w) || !isInt(r.h) || r.w < 4 || r.h < 4) err(`region ${rid}: bad size`);
    const inBounds = (x, y) => isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < r.w && y < r.h;
    if (!r.spawn || !inBounds(r.spawn.x, r.spawn.y)) err(`region ${rid}: spawn out of bounds`);
    for (const [b, op] of Object.entries(r.blocked || {})) {
      const [x, y] = String(b).split(',').map(Number);
      if (!inBounds(x, y)) err(`region ${rid}: blocked tile ${b} out of bounds`);
      if (!isInt(op) || op < 0 || op > 100) err(`region ${rid}: blocked tile ${b} bad opacity ${op} (must be 0-100)`);
    }
    for (const [b] of Object.entries(r.roads || {})) {
      const [x, y] = String(b).split(',').map(Number);
      if (!inBounds(x, y)) err(`region ${rid}: road tile ${b} out of bounds`);
      if (Object.prototype.hasOwnProperty.call(r.blocked || {}, b)) err(`region ${rid}: road tile ${b} overlaps a blocked (building) tile`);
    }
    const blockedSet = new Set(Object.keys(r.blocked || {}));
    for (const [bid, b] of Object.entries(r.buildings || {})) {
      if (!isInt(b.x) || !isInt(b.y) || !isInt(b.w) || !isInt(b.h) || b.w < 1 || b.h < 1) err(`region ${rid}: building ${bid} bad footprint`);
      if (!isInt(b.floors) || b.floors < 1) err(`region ${rid}: building ${bid} bad floors`);
      for (let dx = 0; dx < (b.w || 0); dx++) {
        for (let dy = 0; dy < (b.h || 0); dy++) {
          const key = `${b.x + dx},${b.y + dy}`;
          if (!blockedSet.has(key)) err(`region ${rid}: building ${bid} footprint tile ${key} is not in blocked`);
        }
      }
    }
    const placed = (kind, id, e) => {
      if (!inBounds(e.x, e.y)) err(`region ${rid}: ${kind} ${id} out of bounds`);
      else if (blockedSet.has(`${e.x},${e.y}`)) err(`region ${rid}: ${kind} ${id} on a blocked tile`);
    };
    for (const [id, e] of Object.entries(r.npcs || {})) placed('npc', id, e);
    for (const [id, e] of Object.entries(r.enemies || {})) placed('enemy', id, e);
    for (const [id, e] of Object.entries(r.destructibles || {})) placed('destructible', id, e);
    for (const [id, e] of Object.entries(r.pickups || {})) placed('pickup', id, e);
    for (const [id, z] of Object.entries(r.zones || {})) {
      if (!inBounds(z.x, z.y)) err(`region ${rid}: zone ${id} out of bounds`);
      if (!isInt(z.r) || z.r < 0) err(`region ${rid}: zone ${id} bad radius`);
    }
    for (const [id, cr] of Object.entries(r.cars || {})) {
      if (!inBounds(cr.x, cr.y)) err(`region ${rid}: car ${id} out of bounds`);
      else if (!Object.prototype.hasOwnProperty.call(r.roads || {}, `${cr.x},${cr.y}`)) err(`region ${rid}: car ${id} does not start on a road tile`);
      if (!['N', 'E', 'S', 'W'].includes(cr.dir)) err(`region ${rid}: car ${id} bad dir ${cr.dir}`);
    }
    for (const [id, ls] of Object.entries(r.lightSources || {})) {
      if (!inBounds(ls.x, ls.y)) err(`region ${rid}: lightSource ${id} out of bounds`);
      else if (blockedSet.has(`${ls.x},${ls.y}`)) err(`region ${rid}: lightSource ${id} on a blocked tile`);
      if (!isInt(ls.radius) || ls.radius < 1) err(`region ${rid}: lightSource ${id} bad radius`);
      if (!isInt(ls.strength) || ls.strength < 1 || ls.strength > 100) err(`region ${rid}: lightSource ${id} bad strength (must be 1-100)`);
    }
    if (blockedSet.has(`${r.spawn?.x},${r.spawn?.y}`)) err(`region ${rid}: spawn on blocked tile`);
  }
  for (const [qid, q] of Object.entries(c.quests || {})) {
    if (!Array.isArray(q.objectives) || !q.objectives.length) err(`quest ${qid}: no objectives`);
    for (const [i, o] of (q.objectives || []).entries()) {
      if (!['kill', 'collect', 'reach'].includes(o.type)) err(`quest ${qid}#${i}: unknown objective type ${o.type}`);
      if (o.n !== undefined && (!isInt(o.n) || o.n < 1)) err(`quest ${qid}#${i}: bad n`);
    }
    if (!q.reward || !isInt(q.reward.coins) || q.reward.coins < 0) err(`quest ${qid}: bad reward`);
    for (const req of q.requires || []) {
      if (!c.quests?.[req]) err(`quest ${qid}: requires unknown quest ${req}`);
    }
  }

  for (const [rid, r] of Object.entries(c.regions || {})) {
    if (rid !== c.startRegion) continue;
    if (!r.boss) { err(`region ${rid}: no boss for the finale`); continue; }
    if (!c.enemyKinds?.[r.boss.kind]) err(`region ${rid}: boss kind ${r.boss.kind} unknown`);
    if (r.enemies?.[r.boss.id]) err(`region ${rid}: boss id ${r.boss.id} collides with a normal enemy`);
    const inB = (x, y) => isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < r.w && y < r.h;
    if (!inB(r.boss.x, r.boss.y)) err(`region ${rid}: boss out of bounds`);
    if (r.blocked && Object.prototype.hasOwnProperty.call(r.blocked, `${r.boss.x},${r.boss.y}`)) err(`region ${rid}: boss on blocked tile`);
    if (!r.zones?.['the-hollow']) err(`region ${rid}: missing the-hollow (boss arena) zone`);
    if (!r.zones?.['the-ascent']) err(`region ${rid}: missing the-ascent exit zone`);
  }
  const ARC_STEPS = ['talk', 'training', 'hunt1', 'hunt2', 'ledger', 'finale', 'hunt3', 'arena', 'boss', 'choice', 'gate'];
  for (const step of ARC_STEPS) {
    if (!c.arc?.guide?.[step]) err(`arc: missing guide text for step ${step}`);
  }
  for (const block of ['intro', 'bossAppeared', 'bossTaunted', 'finale']) {
    if (!Array.isArray(c.arc?.[block]) || !c.arc[block].length) err(`arc: missing ${block} text`);
  }

  // --- rung 2: referential integrity ---------------------------------------
  if (c.archetypes && !c.archetypes[c.defaultArchetype]) err(`defaultArchetype ${c.defaultArchetype} does not exist`);
  if (c.regions && !c.regions[c.startRegion]) err(`startRegion ${c.startRegion} does not exist`);
  const allNpcs = {};
  for (const [rid, r] of Object.entries(c.regions || {})) {
    for (const [id, n] of Object.entries(r.npcs || {})) {
      allNpcs[id] = { ...n, region: rid };
      for (const it of n.shop || []) {
        if (!c.items?.[it]) err(`npc ${id}: shop sells unknown item ${it}`);
        else if (c.items[it].price === undefined) err(`npc ${id}: shop item ${it} has no price`);
      }
    }
    for (const [id, e] of Object.entries(r.enemies || {})) {
      if (!c.enemyKinds?.[e.kind]) err(`enemy ${id}: unknown kind ${e.kind}`);
    }
    for (const [id, p] of Object.entries(r.pickups || {})) {
      if (!c.items?.[p.item]) err(`pickup ${id}: unknown item ${p.item}`);
    }
  }
  const allEnemyIds = new Set(), allPickupIds = new Set();
  for (const r of Object.values(c.regions || {})) {
    for (const id of Object.keys(r.enemies || {})) allEnemyIds.add(id);
    for (const id of Object.keys(r.pickups || {})) allPickupIds.add(id);
  }
  for (const [qid, q] of Object.entries(c.quests || {})) {
    if (!allNpcs[q.giver]) err(`quest ${qid}: giver ${q.giver} does not exist`);
    for (const id of q.unlocks?.enemies || []) {
      if (!allEnemyIds.has(id)) err(`quest ${qid}: unlocks unknown enemy ${id}`);
    }
    for (const id of q.unlocks?.pickups || []) {
      if (!allPickupIds.has(id)) err(`quest ${qid}: unlocks unknown pickup ${id}`);
    }
  }

  // --- rung 3: completability ----------------------------------------------
  for (const [qid, q] of Object.entries(c.quests || {})) {
    for (const [i, o] of (q.objectives || []).entries()) {
      if (o.type === 'kill') {
        let count = 0;
        for (const r of Object.values(c.regions || {})) {
          for (const e of Object.values(r.enemies || {})) if (e.kind === o.target) count++;
        }
        if (count < (o.n || 1)) err(`quest ${qid}#${i}: needs ${o.n || 1} ${o.target} kills but only ${count} spawn`);
      }
      if (o.type === 'collect') {
        let obtainable = false;
        for (const r of Object.values(c.regions || {})) {
          for (const p of Object.values(r.pickups || {})) if (p.item === o.item) obtainable = true;
          for (const n of Object.values(r.npcs || {})) if ((n.shop || []).includes(o.item)) obtainable = true;
        }
        if (!obtainable) err(`quest ${qid}#${i}: item ${o.item} is unobtainable`);
      }
      if (o.type === 'reach') {
        let exists = false;
        for (const r of Object.values(c.regions || {})) {
          if (r.zones?.[o.zone]) exists = true;
        }
        if (!exists) err(`quest ${qid}#${i}: zone ${o.zone} does not exist`);
      }
    }
  }
  // A quest chain must actually be reachable: every `requires` edge (ALL of
  // them, not just the first) must bottom out at quests with no prereqs — no
  // cycles, nothing permanently locked.
  for (const qid of Object.keys(c.quests || {})) {
    const path = new Set();
    let cycle = false;
    const visit = (cur, depth) => {
      if (cycle || depth > 50) return;
      if (path.has(cur)) { err(`quest ${qid}: requires-chain cycle detected at ${cur}`); cycle = true; return; }
      path.add(cur);
      for (const req of c.quests[cur]?.requires || []) visit(req, depth + 1);
      path.delete(cur);
    };
    visit(qid, 0);
  }

  return errors;
}
