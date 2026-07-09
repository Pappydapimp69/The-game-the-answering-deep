// Pixel-sprite DATA: original characters (no copied names/art), authored as
// small character grids for src/app/pixelart.js. The player carries the same
// design across the saga (continuity, not a copy of any reference image) —
// a violet-haired aura-fighter in teal/amber.
//
// Buildings are NOT drawn through this system — a multi-tile rectangular
// facade doesn't fit pixelart's fixed square blit, so renderer.js draws them
// procedurally (fillRect + a window grid) instead. This file covers the
// player, enemies, cars, and 1-tile ground/road variants only.

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

// One distinct silhouette per enemy kind, 10x10. City guards read as armored
// figures (helmet + cloak), not amorphous blobs — this is a civic force, not
// a monster roster.
const ENEMY_PALETTE = {
  t: '#8a97ab', u: '#5c6b82', k: '#39435a', // sentry: steel grey armor
  q: '#7a5a3a', j: '#4a3722', p: '#2b2013', // bulwark: bronze/leather bulk
  x: '#6a2f3f', y: '#3f1c26', // cutthroat: dark red cloak
  W: '#caa23a', V: '#8a6a1e', N: '#241a08', // Warden: gold/black regalia
};
function esprite(key, rows) { return { key, rows, palette: ENEMY_PALETTE }; }

export const ENEMY_SPRITES = {
  sentry: esprite('e-sentry', [
    '...tttt...',
    '..tuuuut..',
    '..tukkut..',
    '.ttuuuutt.',
    '.tkkkkkkt.',
    '.tkkkkkkt.',
    '..kkkkkk..',
    '..kk..kk..',
    '..kk..kk..',
    '..........',
  ]),
  bulwark: esprite('e-bulwark', [
    '..qqqqqq..',
    '.qjjjjjjq.',
    '.qjppppjq.',
    'qjppppppjq',
    'qjppppppjq',
    'qjppppppjq',
    '.qjppppjq.',
    '..qjppjq..',
    '..qj..jq..',
    '..........',
  ]),
  cutthroat: esprite('e-cutthroat', [
    '...xxxx...',
    '..xxxxxx..',
    '.xxyxxyxx.',
    '.xxxxxxxx.',
    '..xxxxxx..',
    '..xyxxyx..',
    '..xy..yx..',
    '...y..y...',
    '...y..y...',
    '..........',
  ]),
  warden: esprite('e-warden', [
    '..WWWWWW..',
    '.WVVVVVVW.',
    'WVNN..NNVW',
    'WVVVVVVVVW',
    'NVVVVVVVVN',
    'NNVVVVVVNN',
    '.NNVVVVNN.',
    '.NNVVVVNN.',
    '..NN..NN..',
    '..NN..NN..',
  ]),
};

// One-tile car, seen from above — a simple boxy silhouette, direction-neutral
// (rotation isn't worth the extra sprite variants for an ambient prop).
const CAR_PALETTE = { c: '#c9524a', d: '#7a2e28', g: '#20242c', w: '#dfe6f0' };
export const CAR_SPRITE = {
  key: 'car-1',
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
  palette: CAR_PALETTE,
};

// Ground tile variants: asphalt (road) vs sidewalk/pavement (everything else
// walkable). Buildings are drawn procedurally, not through this system.
const TILE_PALETTE = {
  p: '#3a3f4a', q: '#424855', r: '#333843', // sidewalk: base, variant, fleck
  a: '#26282e', b: '#2e3038', // asphalt: base, lane hint
};
export const TILE_SPRITES = {
  groundA: { key: 't-groundA', rows: ['pppp', 'pqpp', 'pppr', 'pppp'], palette: TILE_PALETTE },
  groundB: { key: 't-groundB', rows: ['qppp', 'ppqp', 'ppqr', 'pppp'], palette: TILE_PALETTE },
  roadA: { key: 't-roadA', rows: ['aaaa', 'abaa', 'aaaa', 'aaba'], palette: TILE_PALETTE },
  roadB: { key: 't-roadB', rows: ['aaaa', 'aaab', 'aaaa', 'baaa'], palette: TILE_PALETTE },
};
