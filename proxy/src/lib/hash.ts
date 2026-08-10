/**
 * Stable hashing for cache keys.
 *
 * The /classify cache is keyed on (profile, event id), so two structurally
 * identical profiles must hash the same regardless of key order — otherwise a
 * re-serialized profile from the app silently misses every cached verdict.
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

/** Web Crypto is present in both workerd and Node 22, so this works in tests too. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Short digest — plenty for a cache key, keeps URLs readable. */
export async function shortHash(value: unknown): Promise<string> {
  return (await sha256Hex(stableStringify(value))).slice(0, 32);
}

/**
 * Normalizes a free-text query so trivially different spellings share one cache
 * entry: case, surrounding whitespace, repeated spaces, and comma spacing.
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical form of a query: normalized, then split on commas, deduplicated,
 * sorted, and rejoined — so "vocaloid, hololive, vsinger" and
 * "vocaloid, vsinger, hololive" are the same thing.
 *
 * Term order carries no meaning in a taste description, and an expansion is the
 * most expensive call the Worker makes, so ordering must never buy a second one.
 *
 * Splitting is on commas only. Sorting the individual *words* would destroy
 * multi-word terms — "drum and bass" would become "and bass drum" — so a query
 * written without commas is left in the order the user typed it.
 *
 * This is also what gets sent to the model, not just what keys the cache: the
 * cached profile should be the one the prompt actually produced, and a fixed
 * input ordering makes the whole route deterministic.
 */
export function canonicalQuery(query: string): string {
  const normalized = normalizeQuery(query);
  if (!normalized.includes(',')) return normalized;

  const terms = [
    ...new Set(
      normalized
        .split(',')
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ].sort();

  return terms.join(', ');
}
