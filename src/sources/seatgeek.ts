/**
 * SeatGeek Platform API adapter.
 * Docs: https://platform.seatgeek.com/
 *
 * Deliberately overlaps Ticketmaster's catalog — that overlap is what makes
 * `dedupe.ts` a real problem instead of a decorative one. Note the different
 * conventions: `datetime_utc` has no timezone suffix, prices come as stats
 * rather than a range object, and the image lives on the performer.
 */

import { config } from '@/lib/config';
import { buildUrl, fetchJson } from '@/lib/http';
import type { Event, EventSource, SearchQuery } from './types';

const BASE = 'https://api.seatgeek.com/2/events';

type SgEvent = {
  id: number;
  title: string;
  short_title?: string;
  url: string;
  /** e.g. "2026-08-08T23:00:00" — UTC, but written without the Z. */
  datetime_utc?: string;
  datetime_local?: string;
  venue?: {
    name?: string;
    city?: string;
    location?: { lat?: number; lon?: number };
  };
  performers?: { image?: string; images?: { huge?: string; large?: string } }[];
  stats?: { lowest_price?: number | null; highest_price?: number | null };
};

type SgResponse = { events?: SgEvent[] };

function toEvent(raw: SgEvent): Event | null {
  if (raw.id === undefined || !raw.title) return null;

  // SeatGeek omits the Z on a value it documents as UTC. Appending it is the
  // difference between correct times and a silent 4-5 hour drift.
  const startsAt = raw.datetime_utc ? new Date(`${raw.datetime_utc}Z`).toISOString() : null;

  const performer = raw.performers?.[0];
  const low = raw.stats?.lowest_price ?? undefined;
  const high = raw.stats?.highest_price ?? undefined;

  return {
    id: `seatgeek:${raw.id}`,
    sourceId: String(raw.id),
    source: 'seatgeek',
    title: raw.short_title || raw.title,
    startsAt,
    startsAtLabel: startsAt ? undefined : (raw.datetime_local ?? 'Date TBA'),
    venue: {
      name: raw.venue?.name ?? 'Venue TBA',
      city: raw.venue?.city ?? '',
      lat: raw.venue?.location?.lat,
      lon: raw.venue?.location?.lon,
    },
    imageUrl: performer?.images?.huge ?? performer?.images?.large ?? performer?.image,
    price:
      low !== undefined
        ? { min: low, max: high ?? low, currency: 'USD' }
        : undefined,
    url: raw.url,
  };
}

export const seatgeek: EventSource = {
  id: 'seatgeek',
  label: 'SeatGeek',

  isConfigured: () => config.seatgeekClientId.length > 0,

  async search({ keyword, city, limit = 20, signal }: SearchQuery) {
    const url = buildUrl(BASE, {
      client_id: config.seatgeekClientId,
      q: keyword,
      'venue.city': city,
      per_page: limit,
      sort: 'datetime_local.asc',
      // Past events are still in the index; without this every search leads
      // with last year's games.
      'datetime_utc.gte': new Date().toISOString().slice(0, 19),
    });

    const data = await fetchJson<SgResponse>(url, { signal });

    return (data.events ?? []).map(toEvent).filter((e): e is Event => e !== null);
  },
};
