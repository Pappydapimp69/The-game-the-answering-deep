// Seeded RNG for the authoritative sim. sfc32: 32-bit integer ops only, so it
// is bit-identical on every JS engine. The full state {a,b,c,d} lives INSIDE
// the saved world state and restores in O(1) — never replay a roll count.
// Ambient random/clock calls are banned in src/sim (enforced by smoke).

// splitmix32: expands one 32-bit seed into well-mixed state words.
function splitmix32(h) {
  h = (h + 0x9e3779b9) | 0;
  let z = h;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return { h, z: (z ^ (z >>> 15)) | 0 };
}

export function makeRng(seed) {
  let s = seed >>> 0;
  const words = [];
  for (let i = 0; i < 4; i++) {
    const r = splitmix32(s);
    s = r.h;
    words.push(r.z);
  }
  const rng = { a: words[0], b: words[1], c: words[2], d: words[3] };
  // Warm up: flush any seeding bias.
  for (let i = 0; i < 8; i++) nextU32(rng);
  return rng;
}

// Advances the state in place, returns a uint32.
export function nextU32(rng) {
  rng.a |= 0; rng.b |= 0; rng.c |= 0; rng.d |= 0;
  const t = (rng.a + rng.b) | 0;
  rng.a = rng.b ^ (rng.b >>> 9);
  rng.b = (rng.c + (rng.c << 3)) | 0;
  rng.c = ((rng.c << 21) | (rng.c >>> 11)) | 0;
  rng.d = (rng.d + 1) | 0;
  const out = (t + rng.d) | 0;
  rng.c = (rng.c + out) | 0;
  return out >>> 0;
}

// Integer in [0, n). Rejection sampling: unbiased, still integer-only.
export function nextInt(rng, n) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`nextInt: bad n ${n}`);
  const limit = 4294967296 - (4294967296 % n);
  let v = nextU32(rng);
  while (v >= limit) v = nextU32(rng);
  return v % n;
}
