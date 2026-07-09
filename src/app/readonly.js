// Mechanical enforcement of the read-only boundary: the renderer and HUD get
// the world through this recursive Proxy, so a single stray `=` throws
// immediately instead of silently corrupting the save. (A "read-only"
// renderer over sim state is one character away from mutating it.)

const cache = new WeakMap();

export function readonly(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  let p = cache.get(obj);
  if (p) return p;
  p = new Proxy(obj, {
    get(target, key) { return readonly(target[key]); },
    set(target, key) { throw new Error(`renderer tried to write state key "${String(key)}"`); },
    deleteProperty(target, key) { throw new Error(`renderer tried to delete state key "${String(key)}"`); },
    defineProperty(target, key) { throw new Error(`renderer tried to define state key "${String(key)}"`); },
  });
  cache.set(obj, p);
  return p;
}
