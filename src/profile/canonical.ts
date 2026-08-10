/**
 * Query canonicalization.
 *
 * ⚠️ This must stay byte-identical in behaviour to `canonicalQuery` in
 * `proxy/src/lib/hash.ts`. The Worker keys its 30-day expansion cache on its
 * version; the app keys its AsyncStorage cache on this one. If they ever
 * disagree, the app misses locally and pays a network round trip for something
 * the Worker already has — or worse, stores two entries for one query.
 *
 * There are tests on both sides covering the same cases.
 */

/** Case, surrounding whitespace, repeated spaces, and comma spacing. */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalized, then comma-separated terms deduped and sorted, so
 * "vocaloid, hololive" and "hololive, vocaloid" are one query.
 *
 * Splitting is on commas only. Sorting individual words would destroy
 * multi-word terms — "drum and bass" would become "and bass drum" — so a query
 * written without commas keeps the order it was typed in.
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
