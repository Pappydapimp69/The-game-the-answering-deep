// Canonical serialization for fingerprinting. JSON.stringify key order follows
// insertion order (integer-like keys silently reorder first), so the same
// logical state can stringify differently. This serializer sorts object keys
// and fails loud on anything that can't round-trip through JSON (NaN,
// Infinity, undefined, functions, BigInt) — one NaN silently poisons
// everything downstream of shared state.

export function stableStringify(value) {
  return write(value, '$');
}

function write(v, path) {
  const t = typeof v;
  if (v === null) return 'null';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`non-finite number at ${path}`);
    if (Object.is(v, -0)) return '0';
    return JSON.stringify(v);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (t === 'object') {
    if (Array.isArray(v)) {
      return '[' + v.map((x, i) => write(x, `${path}[${i}]`)).join(',') + ']';
    }
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + write(v[k], `${path}.${k}`));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(`unserializable ${t} at ${path}`);
}
