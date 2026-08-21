/**
 * Ordering and the relevance break.
 *
 * Kept out of the screen so both are testable without rendering anything.
 */

import { BAND_ORDER, type Band, type RankedEvent } from './types';

/** Undated events sort to the bottom of their band rather than to 1970. */
function byDate(a: RankedEvent, b: RankedEvent): number {
  if (!a.startsAt && !b.startsAt) return a.title.localeCompare(b.title);
  if (!a.startsAt) return 1;
  if (!b.startsAt) return -1;
  return a.startsAt.localeCompare(b.startsAt);
}

/** Band first, then soonest within the band. */
export function sortRanked(events: RankedEvent[]): RankedEvent[] {
  return [...events].sort(
    (a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || byDate(a, b),
  );
}

/**
 * The band the break sits *below*.
 *
 * Below POSSIBLE, not above it. POSSIBLE is the tier worth scanning — it is
 * where an act you didn't know about but might like shows up — so burying it
 * under a "less relevant" heading would hide the most interesting results.
 */
export const BREAK_AFTER: Band = 'POSSIBLE';

export type ListRow =
  | { type: 'event'; event: RankedEvent }
  | { type: 'divider'; below: number };

/**
 * Flattens sorted events into rows, inserting the relevance break.
 *
 * The break is omitted when it would sit at either end — a list that is all
 * strong matches, or all weak ones, has no fall-off to mark, and a divider
 * against nothing reads as a bug.
 *
 * Nothing is removed. Everything below the break stays in the same scrollable
 * list; the divider is a signpost, not a cut.
 */
export function buildRows(events: RankedEvent[], isRanked: boolean): ListRow[] {
  // Unranked: source order, no break — there is no relevance to fall off from.
  if (!isRanked) return events.map((event) => ({ type: 'event' as const, event }));

  const sorted = sortRanked(events);
  const breakAt = sorted.findIndex((event) => BAND_ORDER[event.band] > BAND_ORDER[BREAK_AFTER]);

  const rows: ListRow[] = [];
  sorted.forEach((event, index) => {
    if (index === breakAt && breakAt > 0) {
      rows.push({ type: 'divider', below: sorted.length - breakAt });
    }
    rows.push({ type: 'event', event });
  });

  return rows;
}
