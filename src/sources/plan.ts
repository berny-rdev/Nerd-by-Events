/**
 * Turning one user search into a set of per-source queries.
 *
 * The expansion gives us 20-ish names worth searching. Every source could take
 * the raw query alone; only some can take the whole list.
 */

import type { SourceId } from './types';

/**
 * Queries a single source may receive per user search, raw query included.
 *
 * These are quota decisions, not performance ones:
 *
 *  - Ticketmaster: 5,000/day. The full fan-out is nothing to it.
 *  - SeatGeek: generous but undocumented; 15 leaves headroom.
 *  - SerpAPI: ~100 searches/month on the free tier. At 3 per user search that
 *    is only ~33 searches a month for the whole app, so it gets the raw query
 *    plus the two highest-value names and nothing more. Raising this is the
 *    fastest way to exhaust the quota — see proxy/README.md.
 */
export const QUERY_BUDGET: Record<SourceId, number> = {
  ticketmaster: 25,
  seatgeek: 15,
  serpapi: 3,
};

export function budgetFor(source: SourceId): number {
  return QUERY_BUDGET[source] ?? 1;
}

/**
 * Per-query result cap. The raw query gets the full page because it is the
 * result set the user sees first; each expanded name gets less, because 25
 * names at 20 results each is 500 records to merge for one search.
 */
export const RAW_QUERY_LIMIT = 20;
export const NAME_QUERY_LIMIT = 10;

export type PlannedQuery = {
  keyword: string;
  limit: number;
  /** False for the raw user text — used to label failures and count budgets. */
  fromExpansion: boolean;
};

/**
 * Builds the query list for one source.
 *
 * The raw query is always first and always included, even when it is empty: an
 * empty keyword with a city set is a legitimate "what's on near me" search, and
 * it is what produces results before any expansion arrives.
 *
 * Names keep the order the expansion returned them in. The prompt asks the
 * model to reach for the highest-value acts first, so "the first N names" is
 * the best available proxy for "the N most valuable" — there is no separate
 * ranking signal to sort on yet.
 */
export function buildQueries(rawQuery: string, names: string[], budget: number): PlannedQuery[] {
  const queries: PlannedQuery[] = [
    { keyword: rawQuery, limit: RAW_QUERY_LIMIT, fromExpansion: false },
  ];

  const seen = new Set([rawQuery.trim().toLowerCase()]);

  for (const name of names) {
    if (queries.length >= budget) break;

    const key = name.trim().toLowerCase();
    // A name identical to what the user typed would just repeat the raw query.
    if (!key || seen.has(key)) continue;
    seen.add(key);

    queries.push({ keyword: name, limit: NAME_QUERY_LIMIT, fromExpansion: true });
  }

  return queries;
}

/**
 * How many of the expanded names reach at least one source.
 *
 * Budgets are per source, so the widest one decides. With 30 searchable names
 * and Ticketmaster's budget of 25, names 25-30 are searched by nothing at all —
 * the UI should say "24 of 30", not imply the whole list was used.
 */
export function namesSearched(nameCount: number): number {
  const widest = Math.max(...Object.values(QUERY_BUDGET));
  // Minus one: every budget spends its first slot on the raw query.
  return Math.min(nameCount, Math.max(0, widest - 1));
}
