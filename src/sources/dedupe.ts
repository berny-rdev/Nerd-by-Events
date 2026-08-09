/**
 * Cross-source deduplication.
 *
 * Ticketmaster and SeatGeek both sell the same arena shows, so a search for
 * "knicks" returns the same game twice with different ids, different title
 * conventions ("New York Knicks vs. Boston Celtics" vs "Celtics at Knicks")
 * and start times that can disagree by an hour or two.
 *
 * The heuristic here is deliberately conservative — it would rather show a
 * duplicate than collapse two genuinely different events into one, because a
 * user who books the wrong night has a much worse day than one who scrolls
 * past a repeat.
 */

import { SOURCE_PRIORITY, type Event, type SourceId } from './types';

/** Words that carry no identity — they differ between providers for the same show. */
const NOISE = new Set([
  'the', 'a', 'an', 'at', 'in', 'of', 'and', 'vs', 'versus', 'v',
  'feat', 'featuring', 'with', 'presents', 'presented', 'by',
  'tour', 'live', 'concert', 'tickets', 'ticket', 'show',
]);

/**
 * Reduces a title to a sorted bag of significant words.
 *
 * Sorting is the trick that makes "Knicks vs. Celtics" and "Celtics at Knicks"
 * produce the same key — for matchups, word order is meaningless.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // "(Rescheduled)", "[SOLD OUT]"
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !NOISE.has(word))
    .sort()
    .join(' ');
}

/** Two events can only be the same show if they're in the same city. */
function groupKey(event: Event): string {
  return `${normalizeTitle(event.title)}|${event.venue.city.trim().toLowerCase()}`;
}

/** Providers disagree on exact door/start time; 3 hours absorbs that. */
const TIME_TOLERANCE_MS = 3 * 60 * 60 * 1000;

function sameOccurrence(a: Event, b: Event): boolean {
  // A band can play the same venue two nights running — without timestamps on
  // both sides we can't tell those apart, so we don't merge.
  if (!a.startsAt || !b.startsAt) return false;
  const delta = Math.abs(new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return delta <= TIME_TOLERANCE_MS;
}

/**
 * Combines duplicates into one record: keep the highest-priority source as the
 * base (it has the most trustworthy timestamp and a real ticket URL), then
 * backfill anything it was missing from the others. Google often has an image
 * for a small show that Ticketmaster doesn't carry at all.
 */
function merge(cluster: Event[]): Event {
  const ordered = [...cluster].sort(
    (a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source),
  );

  const base = { ...ordered[0] };

  for (const other of ordered.slice(1)) {
    base.imageUrl ??= other.imageUrl;
    base.price ??= other.price;
    base.startsAt ??= other.startsAt;
    base.venue = {
      ...base.venue,
      name: base.venue.name === 'Venue TBA' ? other.venue.name : base.venue.name,
      lat: base.venue.lat ?? other.venue.lat,
      lon: base.venue.lon ?? other.venue.lon,
    };
  }

  if (ordered.length > 1) {
    base.mergedFrom = [...new Set(ordered.map((event) => event.source))] as SourceId[];
  }

  return base;
}

/** Undated events sort to the bottom rather than to 1970. */
function byStartTime(a: Event, b: Event): number {
  if (!a.startsAt && !b.startsAt) return a.title.localeCompare(b.title);
  if (!a.startsAt) return 1;
  if (!b.startsAt) return -1;
  return a.startsAt.localeCompare(b.startsAt);
}

export function dedupeEvents(events: Event[]): Event[] {
  const groups = new Map<string, Event[]>();

  for (const event of events) {
    const key = groupKey(event);
    const existing = groups.get(key);
    if (existing) existing.push(event);
    else groups.set(key, [event]);
  }

  const merged: Event[] = [];

  for (const group of groups.values()) {
    // Same title + city, but possibly several different nights. Cluster those
    // out before merging, or a two-night run collapses into one event.
    const clusters: Event[][] = [];

    for (const event of group) {
      const match = clusters.find((cluster) => cluster.some((other) => sameOccurrence(other, event)));
      if (match) match.push(event);
      else clusters.push([event]);
    }

    for (const cluster of clusters) merged.push(merge(cluster));
  }

  return merged.sort(byStartTime);
}
