// Single source of truth for turning a quest objective into player-facing
// prose. Duplicated logic here (once in the HUD tracker, once in the
// quest-offer modal) has already drifted apart twice in an earlier game —
// once each type.
import { CONTENT } from '../sim/content.js';

export function describeObjective(o) {
  if (o.type === 'kill') {
    const name = CONTENT.enemyKinds[o.target]?.name || o.target;
    return `Defeat ${o.n || 1} ${name}${(o.n || 1) > 1 ? 's' : ''}`;
  }
  if (o.type === 'collect') return `Find the ${o.item.replace(/-/g, ' ')}`;
  if (o.type === 'reach') return `Reach the ${o.zone.replace(/-/g, ' ')}`;
  if (o.type === 'light') {
    const label = o.torchId === 'torch1' ? 'the southern torch' : o.torchId === 'torch2' ? 'the northern torch' : `the ${o.torchId.replace(/-/g, ' ')}`;
    return `Light ${label}`;
  }
  throw new Error(`describeObjective: unknown objective type ${o.type}`);
}
