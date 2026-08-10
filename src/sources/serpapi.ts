/**
 * Google Events adapter, via SerpAPI's `google_events` engine.
 * Docs: https://serpapi.com/google-events-api
 *
 * This is the "scrape Google" idea done legitimately. SerpAPI runs the search
 * and hands back structured JSON; we never touch a SERP ourselves.
 *
 * Two things make this source the interesting one:
 *
 *  1. The key is billed per search, so it must never ship in the bundle. The
 *     app talks to the worker in `proxy/`, which holds the key as a secret.
 *     See `src/lib/config.ts`.
 *
 *  2. The data is genuinely bad. Google's event panel returns dates as human
 *     strings — "Fri, Aug 8, 7 – 10 PM" — with no year and no timezone. This
 *     adapter does a best-effort parse and returns `startsAt: null` whenever
 *     it can't get to a defensible instant, rather than guessing. That null is
 *     what stops us from scheduling a reminder for the wrong day.
 */

import { config, hasProxy } from '@/lib/config';
import { buildUrl, fetchJson } from '@/lib/http';
import type { Event, EventSource, SearchQuery } from './types';

type SerpEvent = {
  title?: string;
  date?: { start_date?: string; when?: string };
  address?: string[];
  link?: string;
  thumbnail?: string;
  image?: string;
  venue?: { name?: string };
  ticket_info?: { source?: string; link?: string; link_type?: string }[];
};

type SerpResponse = { events_results?: SerpEvent[] };

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Pulls a start time out of strings like:
 *   "7 – 10 PM"  ->  19:00      (start borrows PM from the end of the range)
 *   "7:30 PM"    ->  19:30
 *   "10 AM – 5 PM" -> 10:00
 * Returns null for all-day or unparseable values.
 */
export function parseTimeOfDay(when: string): { hour: number; minute: number } | null {
  // Normalize en/em dashes so one regex covers every range format.
  const text = when.replace(/[‒-―]/g, '-').toLowerCase();

  // Both patterns require an explicit am/pm somewhere. That requirement is
  // load-bearing: without it, the "8" in "Fri, Aug 8, 7 - 10 PM" matches as
  // the hour and every evening event lands at 8am.
  const range = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*-\s*\d{1,2}(?::\d{2})?\s*(am|pm)/.exec(text);
  const single = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/.exec(text);

  const hour12 = Number(range?.[1] ?? single?.[1]);
  const minute = Number(range?.[2] ?? single?.[2] ?? 0);
  // In a range the start may omit the meridiem ("7 - 10 PM") and borrow the
  // end's. That is wrong for "11 AM - 1 PM", but Google writes those out in
  // full, so the borrow only fires where it's safe.
  const meridiem = range ? (range[3] ?? range[4]) : single?.[3];

  if (!meridiem || !Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) return null;

  const hour = (hour12 % 12) + (meridiem === 'pm' ? 12 : 0);
  return { hour, minute: Number.isFinite(minute) ? minute : 0 };
}

/**
 * Google omits the year. We assume the next occurrence: if the month/day has
 * already passed by more than a week, it's next year.
 *
 * Known limitation, stated plainly: the resulting instant is built in the
 * *device's* timezone, not the venue's. For a user browsing their own city
 * that's right; for someone in NY browsing LA events it's off by three hours.
 * Fixing it properly needs a lat/lon -> timezone lookup, which this source
 * doesn't give us.
 */
export function parseFuzzyDate(date: SerpEvent['date'], now: Date): string | null {
  const startDate = date?.start_date;
  if (!startDate) return null;

  const match = /([a-z]{3})[a-z]*\s+(\d{1,2})/i.exec(startDate);
  if (!match) return null;

  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (month === undefined || !Number.isFinite(day)) return null;

  const time = date?.when ? parseTimeOfDay(date.when) : null;
  if (!time) return null; // No time of day -> not a schedulable instant.

  let year = now.getFullYear();
  let parsed = new Date(year, month, day, time.hour, time.minute);

  const weekMs = 7 * 24 * 60 * 60 * 1000;
  if (parsed.getTime() < now.getTime() - weekMs) {
    year += 1;
    parsed = new Date(year, month, day, time.hour, time.minute);
  }

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** address: ["1100 Congress Ave, Austin, TX", "Austin, TX"] -> "Austin" */
function parseCity(address: string[] = []): string {
  const locality = address[address.length - 1] ?? '';
  return locality.split(',')[0]?.trim() ?? '';
}

/**
 * SerpAPI has no stable per-event id, so we mint one from the fields that
 * identify the event. Same event on a later search -> same id, which keeps
 * FlatList keys and saved-event lookups stable across refetches.
 */
function makeId(raw: SerpEvent): string {
  const parts = [raw.title ?? '', raw.date?.start_date ?? '', raw.venue?.name ?? ''];
  return parts
    .join('|')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, '-')
    .slice(0, 120);
}

function toEvent(raw: SerpEvent, now: Date): Event | null {
  if (!raw.title) return null;

  const startsAt = parseFuzzyDate(raw.date, now);
  const link = raw.link ?? raw.ticket_info?.find((t) => t.link)?.link;
  if (!link) return null;

  return {
    id: `serpapi:${makeId(raw)}`,
    sourceId: makeId(raw),
    source: 'serpapi',
    title: raw.title,
    startsAt,
    // When the parse fails we show Google's own words rather than a guess.
    startsAtLabel: startsAt ? undefined : (raw.date?.when ?? raw.date?.start_date ?? 'Date TBA'),
    venue: {
      name: raw.venue?.name ?? raw.address?.[0] ?? 'Venue TBA',
      city: parseCity(raw.address),
    },
    imageUrl: raw.image ?? raw.thumbnail,
    // Google's panel doesn't expose prices.
    price: undefined,
    url: link,
  };
}

export const serpapi: EventSource = {
  id: 'serpapi',
  label: 'Google Events',

  isConfigured: hasProxy,

  async search({ keyword, city, limit = 20, signal }: SearchQuery) {
    // The engine takes one natural-language query, not separate fields.
    const q = [keyword?.trim() || 'events', city?.trim() ? `in ${city.trim()}` : '']
      .filter(Boolean)
      .join(' ');

    const url = buildUrl(`${config.eventsProxyUrl}/serpapi/events`, { q });

    const data = await fetchJson<SerpResponse>(url, { signal, timeoutMs: 15_000 });

    const now = new Date();
    return (data.events_results ?? [])
      .slice(0, limit)
      .map((raw) => toEvent(raw, now))
      .filter((e): e is Event => e !== null);
  },
};
