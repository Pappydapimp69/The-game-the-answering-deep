// A fixed scripted playthrough shared by the smoke suite (Node) and the boot
// page (browser). Both environments must produce the identical fingerprint.
// The script exercises every verb — including the new PING — and completes the
// whole chapter. Over-issued attacks past a kill are safe (`already_down`,
// never a throw), so combat loops carry generous margins and stay robust.
//
// Deliberately sparing with TICK: enemy/drifter movement only happens on TICK
// (src/sim/reduce.js), so a script that rarely ticks keeps every entity parked
// at its spawn/home between scripted actions. Because `state.echo.lit` is only
// pruned on TICK, a single PING lights its targets and they STAY lit through
// the (tickless) combat that follows — which is exactly what the reveal-gate
// on AURA_BLAST needs (you can't blast what you haven't echo-located). The
// AI/pathfinding/sound systems get dedicated focused smoke tests instead of
// being exercised incidentally here.
//
// Movement routes via the main current (y=10, open its full width) as a safe
// "gap row" — every waypoint sits on a column open outside y=10 too, so the
// L-path never clips a structure.

export const DEMO_SEED = 0xdee9; // "deep"

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

export function demoCommands() {
  const cmds = [];
  const cur = { x: 1, y: 10 }; // spawn
  const M = (dx, dy) => cmds.push({ type: 'MOVE', dx, dy });
  const walkToRaw = (tx, ty) => {
    while (cur.x !== tx || cur.y !== ty) {
      const dx = sign(tx - cur.x), dy = sign(ty - cur.y);
      M(dx, dy);
      cur.x += dx; cur.y += dy;
    }
  };
  const walkTo = (tx, ty) => {
    walkToRaw(cur.x, 10);
    walkToRaw(tx, 10);
    walkToRaw(tx, ty);
  };
  const charge = (n) => { cmds.push({ type: 'CHARGE', start: true }); for (let i = 1; i < n; i++) cmds.push({ type: 'CHARGE' }); };
  const ping = (loud) => cmds.push({ type: 'PING', loud: !!loud });

  cmds.push({ type: 'TICK' });
  ping(false); // a first listen into the dark — nothing near, pure coverage

  // --- Quest 1: Into the Dark --------------------------------------------
  walkTo(3, 10);
  cmds.push({ type: 'TALK', npcId: 'wren' }); // offers 'into-the-dark'
  cmds.push({ type: 'ACCEPT_QUEST', questId: 'into-the-dark' });
  walkTo(20, 10); // the-shallows zone, at Marrow's post — completes quest 1

  // --- Quest 2: Learn to Listen (catch an Igniter — no immunity, melee) ---
  // Tickless combat (see the header note) keeps it parked at its spawn the
  // whole time, same as any other kind — MELEE has no light-gate and the
  // light-averse AI only ever reacts to a TICK, and there isn't one between
  // arriving and finishing it off.
  walkTo(3, 10);
  cmds.push({ type: 'TALK', npcId: 'wren' }); // offers 'learn-to-listen'
  cmds.push({ type: 'ACCEPT_QUEST', questId: 'learn-to-listen' });
  cmds.push({ type: 'TICK' }, { type: 'TICK' }, { type: 'TICK' }); // spawn telegraph
  walkTo(13, 19);
  for (let i = 0; i < 6; i++) cmds.push({ type: 'MELEE', enemyId: 'igniter1' });

  // --- Quest 3: The Fleeing Kind (catch a second Igniter) -----------------
  // This TALK actually offers TWO quests now (the-fleeing-kind AND its
  // branch-mate the-burning-kind — see content.js), since 'the-sounding-line'
  // only needs ONE of them done (requiresAny). This replay takes the
  // fleeing-kind path; the-burning-kind gets its own dedicated smoke
  // coverage instead of incidental exercise here.
  walkTo(3, 10);
  cmds.push({ type: 'TALK', npcId: 'wren' }); // offers 'the-fleeing-kind' + 'the-burning-kind'
  cmds.push({ type: 'ACCEPT_QUEST', questId: 'the-fleeing-kind' });
  cmds.push({ type: 'TICK' }, { type: 'TICK' }, { type: 'TICK' });
  walkTo(21, 15);
  for (let i = 0; i < 6; i++) cmds.push({ type: 'MELEE', enemyId: 'igniter2' });

  // --- Quest 4: The Sounding Line (collect it) ----------------------------
  walkTo(3, 10);
  cmds.push({ type: 'TALK', npcId: 'wren' }); // offers 'the-sounding-line'
  cmds.push({ type: 'ACCEPT_QUEST', questId: 'the-sounding-line' });
  walkTo(6, 3);
  cmds.push({ type: 'INTERACT', pickupId: 'soundingline1' });

  // --- Quest 5: Sound the Deep (finale) -----------------------------------
  walkTo(3, 10);
  cmds.push({ type: 'TALK', npcId: 'wren' }); // offers 'sound-the-deep'
  cmds.push({ type: 'ACCEPT_QUEST', questId: 'sound-the-deep' });
  cmds.push({ type: 'TICK' }, { type: 'TICK' }, { type: 'TICK' });

  walkTo(21, 14);
  for (let i = 0; i < 6; i++) cmds.push({ type: 'MELEE', enemyId: 'igniter-elite1' });

  walkTo(30, 15);
  cmds.push({ type: 'INTERACT', pickupId: 'chorusshard1' });

  // Reach the hollow — the last objective. The Answerer rises.
  walkTo(29, 10);

  // Face the Answerer. Ping to keep it lit, then strike.
  for (let cyc = 0; cyc < 8; cyc++) {
    ping(false);
    charge(6);
    cmds.push({ type: 'AURA_BLAST', enemyId: 'answerer1' });
    cmds.push({ type: 'AURA_BLAST', enemyId: 'answerer1' });
    cmds.push({ type: 'MELEE', enemyId: 'answerer1' });
    cmds.push({ type: 'MELEE', enemyId: 'answerer1' });
    if (cyc === 1) cmds.push({ type: 'ENEMY_STRIKE', enemyId: 'answerer1' });
  }

  cmds.push({ type: 'CHOOSE_FATE', fate: 'answer' });
  walkTo(31, 10);
  cmds.push({ type: 'TICK' });
  cmds.push({ type: 'TICK' });

  return cmds;
}
