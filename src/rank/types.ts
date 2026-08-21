/**
 * Ranking types.
 *
 * A band says how well an event matches the taste profile the fan-out was built
 * from. Searching "Eve" returns "Marilyn Maye's New Year's Eve Extravaganza";
 * ranking is what separates that from an actual Eve show.
 */

import type { Event } from '@/sources/types';

export const BANDS = ['STRONG', 'POSSIBLE', 'WEAK', 'UNRELATED'] as const;
export type Band = (typeof BANDS)[number];

/**
 * The tier anything unverdicted falls to.
 *
 * Never drop an event for lacking a verdict — an unclassifiable event is still
 * a real event someone might want, so it sinks rather than disappears.
 */
export const LOWEST_BAND: Band = 'UNRELATED';

/** Display/sort order. Lower sorts first. */
export const BAND_ORDER: Record<Band, number> = {
  STRONG: 0,
  POSSIBLE: 1,
  WEAK: 2,
  UNRELATED: 3,
};

/**
 * An Event with its verdict attached.
 *
 * Intersection rather than a wrapper so a RankedEvent is usable anywhere an
 * Event is — no unwrapping at every call site.
 */
export type RankedEvent = Event & {
  band: Band;
  /** One short clause of evidence, or why no verdict exists. */
  reason: string;
  /**
   * False when the band is a fallback rather than a real judgement — the model
   * omitted it, returned something unparseable, or classification failed.
   */
  isRanked: boolean;
};

export type RankFailure = {
  /** Events in the batch that failed, so partial failure is diagnosable. */
  eventCount: number;
  message: string;
  /** Up to three ids from the failed batch. */
  sampleIds: string[];
};

/**
 * Mirrors the `{ events, failures, skipped }` shape the source aggregator
 * returns, for the same reason: a caller should never have to catch to render.
 */
export type RankResult = {
  /**
   * Every submitted event, in submitted order, each carrying a band.
   *
   * Order is deliberately untouched — the caller sorts. That is what makes the
   * total-failure path fall out for free: everything keeps source order and
   * simply carries the lowest band.
   */
  events: RankedEvent[];
  failures: RankFailure[];
  /** Non-empty when ranking never ran at all (no proxy, no profile, nothing to rank). */
  skipped: { reason: string }[];
  /**
   * False when not one event received a real verdict. The UI shows the
   * "ranking unavailable" banner on this, not on `failures.length`, because a
   * partial failure still ranks most of the list.
   */
  isRanked: boolean;
};

export function isBand(value: unknown): value is Band {
  return typeof value === 'string' && (BANDS as readonly string[]).includes(value);
}
