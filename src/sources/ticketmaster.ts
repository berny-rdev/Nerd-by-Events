/**
 * Ticketmaster Discovery API adapter.
 * Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
 *
 * Big-venue heavy: arena concerts, sports, touring theater. Rich data — real
 * start times with offsets, multiple image renditions, price ranges.
 */

import { config, hasProxy } from '@/lib/config';
import { buildUrl, fetchJson } from '@/lib/http';
import type { Event, EventSource, SearchQuery } from './types';

/**
 * The Worker route, not Ticketmaster directly — the Consumer Key lives there as
 * a secret. The Worker forwards an allowlist of params and returns the same
 * `_embedded.events` envelope, so everything below this line is unchanged.
 */
const path = () => `${config.eventsProxyUrl}/ticketmaster/events`;

type TmImage = { url: string; width: number; height: number; ratio?: string };

type TmEvent = {
  id: string;
  name: string;
  url: string;
  images?: TmImage[];
  dates?: {
    start?: { dateTime?: string; localDate?: string; localTime?: string; dateTBD?: boolean };
  };
  priceRanges?: { min?: number; max?: number; currency?: string }[];
  _embedded?: {
    venues?: {
      name?: string;
      city?: { name?: string };
      location?: { latitude?: string; longitude?: string };
    }[];
  };
};

type TmResponse = { _embedded?: { events?: TmEvent[] } };

/**
 * Ticketmaster returns the same photo at ~10 sizes. Prefer a wide-ish one
 * around card width; fall back to whatever is largest.
 */
function pickImage(images: TmImage[] = []): string | undefined {
  if (images.length === 0) return undefined;
  const wide = images
    .filter((image) => image.ratio === '16_9' && image.width >= 640)
    .sort((a, b) => a.width - b.width);
  if (wide.length > 0) return wide[0].url;
  return [...images].sort((a, b) => b.width - a.width)[0]?.url;
}

function toEvent(raw: TmEvent): Event | null {
  if (!raw.id || !raw.name) return null;

  const venue = raw._embedded?.venues?.[0];
  const price = raw.priceRanges?.[0];

  // `dateTime` is already UTC with a Z. `localDate` is a bare date used when
  // the start time hasn't been announced — treat that as "no real timestamp".
  const startsAt = raw.dates?.start?.dateTime ?? null;

  const lat = venue?.location?.latitude ? Number(venue.location.latitude) : undefined;
  const lon = venue?.location?.longitude ? Number(venue.location.longitude) : undefined;

  return {
    id: `ticketmaster:${raw.id}`,
    sourceId: raw.id,
    source: 'ticketmaster',
    title: raw.name,
    startsAt,
    startsAtLabel: startsAt ? undefined : (raw.dates?.start?.localDate ?? 'Date TBA'),
    venue: {
      name: venue?.name ?? 'Venue TBA',
      city: venue?.city?.name ?? '',
      lat: Number.isFinite(lat) ? lat : undefined,
      lon: Number.isFinite(lon) ? lon : undefined,
    },
    imageUrl: pickImage(raw.images),
    price:
      price?.min !== undefined && price?.max !== undefined
        ? { min: price.min, max: price.max, currency: price.currency ?? 'USD' }
        : undefined,
    url: raw.url,
  };
}

export const ticketmaster: EventSource = {
  id: 'ticketmaster',
  label: 'Ticketmaster',

  isConfigured: hasProxy,

  async search({ keyword, city, limit = 20, signal }: SearchQuery) {
    const url = buildUrl(path(), { keyword, city, limit });

    const data = await fetchJson<TmResponse>(url, { signal });

    // No results comes back as a missing `_embedded`, not an empty array.
    return (data._embedded?.events ?? []).map(toEvent).filter((e): e is Event => e !== null);
  },
};
