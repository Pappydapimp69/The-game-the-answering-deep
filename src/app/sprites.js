// Pixel-sprite DATA: original characters (no copied names/art), authored as
// small character grids for src/app/pixelart.js. The player carries the same
// design across the saga (continuity, not a copy of any reference image) —
// a violet-haired aura-fighter in teal/amber.
//
// Buildings are NOT drawn through this system — a multi-tile rectangular
// facade doesn't fit pixelart's fixed square blit, so renderer.js draws them
// procedurally (fillRect + a window grid) instead. This file covers the
// player, NPCs, enemies, drifters, and 1-tile ground/current variants only.

const PLAYER_PALETTE = {
  H: '#3c2a5e', h: '#6b4fa0', // hair (dark / highlight violet)
  S: '#e8b98a', // skin
  O: '#1f5f5f', o: '#163f3f', // outfit teal (main / shadow)
  A: '#d98a2b', // sash accent
  B: '#241a1a', // boots
  E: '#14100c', // eyes
};

const HAIR = [
  '..H..hh..H..',
  '.HHHhhhhHHH.',
  'HHHhhhhhhHHH',
];
const FACE = [
  '.HSSSSSSSSH.',
  '.SSSESSESS..',
  '.SSSSSSSSS..',
  '..SSSSSSSS..',
];
const BACK_HEAD = [
  '.HHHHHHHHHH.',
  '.HHHHHHHHHH.',
  '.HHHHHHHHHH.',
  '..HHHHHHHH..',
];
const SHOULDERS = ['.OOOOOOOOOO.'];

const torso = (armL, armR) => [
  `${armL}OOOAAOOOOO${armR}`,
  `${armL}OOOOOOOOOO${armR}`,
  '.OOOOOOOOO..',
];
const LEGS_A = ['..BBB..BBB..', '..BBB..BBB..'];
const LEGS_B = ['.BBB...BBB..', '..BBB..BBB..'];

function sprite(key, rows) { return { key, rows, palette: PLAYER_PALETTE }; }

export const PLAYER_SPRITES = {
  'down-0': sprite('p-down-0', [...HAIR, ...FACE, ...SHOULDERS, ...torso('S', 'S'), ...LEGS_A]),
  'down-1': sprite('p-down-1', [...HAIR, ...FACE, ...SHOULDERS, ...torso('S', 'S'), ...LEGS_B]),
  'up-0': sprite('p-up-0', [...HAIR, ...BACK_HEAD, ...SHOULDERS, ...torso('O', 'O'), ...LEGS_A]),
  'up-1': sprite('p-up-1', [...HAIR, ...BACK_HEAD, ...SHOULDERS, ...torso('O', 'O'), ...LEGS_B]),
  'side-0': sprite('p-side-0', [...HAIR, ...FACE, ...SHOULDERS, ...torso('O', 'S'), ...LEGS_A]),
  'side-1': sprite('p-side-1', [...HAIR, ...FACE, ...SHOULDERS, ...torso('O', 'S'), ...LEGS_B]),
  'charge': sprite('p-charge', [...HAIR, ...FACE, ...SHOULDERS, ...torso('O', 'O'), ...LEGS_A]),
};

export const BLAST_SPRITE = {
  key: 'blast-orb',
  rows: [
    '..BBBB..',
    '.BbCCbB.',
    'BbCCCCbB',
    'BCCCCCCB',
    'BCCCCCCB',
    'BbCCCCbB',
    '.BbCCbB.',
    '..BBBB..',
  ],
  palette: { C: '#dff3ff', B: '#3fa9f5', b: '#1f6fae' },
};

// NPCs: each gets its OWN silhouette + palette, not a shared/recolored player
// sprite — Wren (a weathered survivor, coil of line at the hip) and Marrow
// (a stockier trader, satchel of goods) should be tellable apart at a glance,
// the same way the player is tellable from every enemy kind.
const WREN_PALETTE = {
  H: '#4a4238', h: '#6b6152', // hair (grey-brown, weathered)
  S: '#c9a374', // skin, sun/salt-worn
  O: '#2a3a42', o: '#1c282e', // coat (slate blue-grey)
  A: '#8a6a3a', // the sounding-line coil, hip-slung
  B: '#1a1614', E: '#14100c',
};
export const NPC_SPRITES = {
  wren: {
    key: 'npc-wren',
    palette: WREN_PALETTE,
    rows: [
      '..H..hh..H..',
      '.HHHhhhhHHH.',
      '.HSSSSSSSSH.',
      '.SSSESSESS..',
      '.SSSSSSSSS..',
      '.OOOOOOOOOO.',
      'OOOOOOOOOOOO',
      'OOOOOOAAOOOO',
      '.OOOAAAOOO..',
      '.BBB...BBB..',
      '.BBB...BBB..',
    ],
  },
  marrow: {
    key: 'npc-marrow',
    palette: {
      H: '#241a10', h: '#3a2a1a',
      S: '#a87858',
      O: '#5c3a24', o: '#3e2717', // coat (warm brown, trader)
      A: '#d9b23a', // satchel buckle / coin glint
      B: '#1a1410', E: '#0e0a08',
    },
    rows: [
      '.....HH.....',
      '..HHHhhHHH..',
      '.HSSSSSSSSH.',
      '.SSSESSESS..',
      '.SSSSSSSSS..',
      'OOOOOOOOOOOO',
      'OOOOOOOOOOOO',
      'OAOOOOOOOOAO',
      '.OOOOOOOOOO.',
      '.BBBB..BBBB.',
      '.BBBB..BBBB.',
    ],
  },
};

// One distinct silhouette per enemy kind, 10x10. The Drowned Reach's dangers
// read as things of the deep — never armored soldiers (that was the Waiting
// City's civic-guard reg). Only two kinds now: the boss, and the Igniter.
const ENEMY_PALETTE = {
  W: '#bfe8e0', V: '#6fd0c0', N: '#0a2a26', // the Answerer: pale bioluminescent
  f: '#ff8f3d', g: '#8a2e1a', h: '#241a14', // igniter: soot-hooded, ember-lit
};
function esprite(key, rows) { return { key, rows, palette: ENEMY_PALETTE }; }

export const ENEMY_SPRITES = {
  // The Answerer: pale, coral/bone-ridged, a glowing throat where a mouth
  // would be — the voice it stole is the one bright thing on it.
  answerer: esprite('e-answerer', [
    '..WWWWWW..',
    '.WVVVVVVW.',
    'WVVNNNNVVW',
    'WVVNVVNVVW',
    'NVVVWWVVVN',
    'NVVVVVVVVN',
    'NNVVVVVVNN',
    '.NNVVVVNN.',
    '.NNVVVVNN.',
    '..NN..NN..',
  ]),
  // Igniter: a soot-hooded silhouette with a flame crest and an ember-lit
  // body — reads as "the one that carries fire" on sight, distinct from
  // every echo-hunting kind since it's a ranged threat, not a chaser.
  igniter: esprite('e-igniter', [
    '..hfff....',
    '.hhfgfh...',
    '.hgEEgh...',
    '.hgggghh..',
    'hhggggghh.',
    'hhgggggh..',
    '.hg.hg....',
    '..h..h....',
    '..........',
    '..........',
  ]),
};

// One-tile drifter, seen from above — a simple boxy silhouette, direction-
// neutral (rotation isn't worth the extra sprite variants for an ambient
// prop). Kept as a machine/hull shape (a submerged relic still drifting the
// current), not a car — the Waiting City's cars just renamed 1:1 otherwise.
const DRIFTER_PALETTE = { c: '#4a5a68', d: '#2a343e', g: '#141a20', w: '#8fb8c8' };
export const CAR_SPRITE = {
  key: 'drifter-1',
  rows: [
    '.cccccc.',
    'cccccccc',
    'cwwwwwwc',
    'cwggggwc',
    'cwggggwc',
    'cwwwwwwc',
    'cccccccc',
    '.dddddd.',
  ],
  palette: DRIFTER_PALETTE,
};

// Ground tile variants: current-bed vs open floor. Buildings/structures are
// drawn procedurally, not through this system.
const TILE_PALETTE = {
  p: '#232838', q: '#2a3040', r: '#1c202c', // floor: base, variant, fleck
  a: '#16202a', b: '#1b2632', // current bed: base, flow-line hint
};
export const TILE_SPRITES = {
  groundA: { key: 't-groundA', rows: ['pppp', 'pqpp', 'pppr', 'pppp'], palette: TILE_PALETTE },
  groundB: { key: 't-groundB', rows: ['qppp', 'ppqp', 'ppqr', 'pppp'], palette: TILE_PALETTE },
  roadA: { key: 't-roadA', rows: ['aaaa', 'abaa', 'aaaa', 'aaba'], palette: TILE_PALETTE },
  roadB: { key: 't-roadB', rows: ['aaaa', 'aaab', 'aaaa', 'baaa'], palette: TILE_PALETTE },
};

// Torch fixture — a player-lightable permanent light source (src/sim/
// content.js's `torches`, LIGHT_TORCH in reduce.js). Unlit is just the
// wooden post; lit adds a flame that reuses the same warm palette family as
// the Igniter's own fire, since it's the same fictional substance.
const TORCH_PALETTE = { o: '#4a3826', g: '#ff8f3d', f: '#ffcf6b' };
export const TORCH_SPRITES = {
  unlit: {
    key: 'torch-unlit',
    rows: ['........', '..oo....', '..oo....', '.oooo...', '..oo....', '..oo....', '..oo....', '........'],
    palette: TORCH_PALETTE,
  },
  lit: {
    key: 'torch-lit',
    rows: ['..gg....', '.gffg...', '..oo....', '.oooo...', '..oo....', '..oo....', '..oo....', '........'],
    palette: TORCH_PALETTE,
  },
};
