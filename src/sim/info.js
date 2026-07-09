// Skill-gated information: what the player can PERCEIVE is a progression
// reward. Two tiers: `senseReq` (exact hp/power) and `aiSenseReq` (always >=
// senseReq — you learn to read a fight before you learn to read a mind),
// which reveals the enemy's live AI state. Pure read helpers; the renderer
// consumes these, the sim never depends on them.
//
// What the two thresholds are compared AGAINST depends on the enemy kind's
// `confidenceGated` flag (see content.js's doc comment on enemyKinds):
// - Regular guard kinds (confidenceGated: true): against `player.intel[kind]`
//   — a per-kind counter built from real encounters with THAT kind, win or
//   loss (reduce.js's hitEnemy/ENEMY_STRIKE). "The enemies got smart" becomes
//   "you got a read on them," and the read is earned per-kind, not granted by
//   a global stat.
// - The Warden (no flag): against the flat `player.skills.perception.lvl`,
//   same mechanism the trilogy has always used. A deliberate exception, not
//   a leftover — it's fought exactly once, so there's nothing to accumulate
//   across encounters; forcing the confidence framing onto a one-shot fight
//   would just rename the existing boss-taunt event, not read anything the
//   player actually did differently.

import { CONTENT } from './content.js';

function readLevel(player, kind, enemyKind) {
  return kind.confidenceGated ? (player.intel[enemyKind] || 0) : player.skills.perception.lvl;
}

export function canSense(player, enemyKind) {
  const kind = CONTENT.enemyKinds[enemyKind];
  if (!kind) return false;
  return readLevel(player, kind, enemyKind) >= kind.senseReq;
}

export function canReadIntent(player, enemyKind) {
  const kind = CONTENT.enemyKinds[enemyKind];
  if (!kind) return false;
  return readLevel(player, kind, enemyKind) >= kind.aiSenseReq;
}

// What the player sees above an enemy's head.
export function enemyReadout(player, enemy) {
  const kind = CONTENT.enemyKinds[enemy.kind];
  if (!enemy.alive) return '';
  if (!canSense(player, enemy.kind)) {
    // Honest, non-blame framing for a confidence-gated kind with zero
    // encounters yet — "no read yet" is a fact about exposure, not a
    // judgment on the player. A flat-gated kind (the Warden) keeps the
    // plain "???" it's always had.
    return kind.confidenceGated ? 'Not enough encounters yet' : '???';
  }
  const base = `${kind.name} ${enemy.hp}/${enemy.maxHp} · pw ${enemy.power}`;
  if (!canReadIntent(player, enemy.kind)) return base;
  return `${base} · ${AI_LABELS[enemy.aiState] || enemy.aiState}`;
}

const AI_LABELS = {
  patrol: 'unaware',
  search: 'heard you',
  chase: 'closing in',
  attack: 'engaged',
  return: 'losing you',
  flee: 'breaking off',
};
