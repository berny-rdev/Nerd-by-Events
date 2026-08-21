/**
 * Stable, dependency-free hashing for cache keys.
 *
 * Deliberately not `crypto.subtle`: Hermes doesn't provide it, so using it
 * would mean pulling in expo-crypto and making the ranking cache async-init.
 * A cache key needs stability and low collision odds, not cryptographic
 * strength.
 */

/** JSON.stringify with object keys sorted recursively. Arrays keep their order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

/** FNV-1a, 32 bits, seeded so two passes give independent halves. */
function fnv1a(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // The classic FNV prime multiply, written as shifts to stay in int32.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 64-bit hex digest of any JSON-serializable value.
 *
 * Two independently-seeded 32-bit passes rather than one: a single 32-bit hash
 * has roughly a one-in-ten-million collision chance across a few dozen cached
 * profiles, and a collision here would serve one profile's verdicts under
 * another's key — wrong answers rather than a miss. 64 bits makes that
 * vanishingly unlikely for the cost of a second pass.
 */
export function stableHash(value: unknown): string {
  const text = stableStringify(value);
  const high = fnv1a(text, 0x811c9dc5);
  const low = fnv1a(text, 0x01000193);
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
