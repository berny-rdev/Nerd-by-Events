/**
 * The three upstream event-search APIs.
 *
 * Every route here forwards an allowlist of parameters and nothing else. Passing
 * the client's query string through wholesale would let anyone with the Worker
 * URL run arbitrary paid queries on your accounts — the reason the SerpAPI route
 * was written this way originally, now applied uniformly.
 *
 * Each returns the upstream envelope the app's adapters already parse, trimmed
 * to the array they read. That keeps the app-side change in Phase 2 to a URL
 * swap rather than a rewrite of every `toEvent`.
 */

import { CACHE_TTL, cacheKey, cacheableJson } from '../lib/cache.ts';
import { HttpError, json } from '../lib/http.ts';
import type { Deps, Env } from '../types.ts';

const MAX_LIMIT = 50;
const MAX_TERM = 120;

function term(url: URL, name: string): string {
  return (url.searchParams.get(name) ?? '').trim().slice(0, MAX_TERM);
}

function limitOf(url: URL): number {
  const raw = Number(url.searchParams.get('limit') ?? '20');
  if (!Number.isFinite(raw)) return 20;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}

/** Shared cache-then-fetch wrapper. `build` returns the upstream URL. */
async function proxied(
  request: Request,
  deps: Deps,
  options: {
    namespace: string;
    identity: string;
    ttl: number;
    upstream: string;
    /** Reduces the upstream payload to the envelope the app parses. */
    trim: (data: unknown) => unknown;
  },
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const key = cacheKey(origin, options.namespace, options.identity);

  const cached = await deps.cache.match(key);
  if (cached) {
    return new Response(await cached.text(), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
    });
  }

  const response = await deps.upstreamFetch(options.upstream, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new HttpError(502, 'Upstream error', {
      status: response.status,
      detail: detail.slice(0, 500),
    });
  }

  const trimmed = options.trim(await response.json());

  deps.waitUntil(deps.cache.put(key, cacheableJson(trimmed, options.ttl)));

  return json(trimmed, 200, { 'X-Cache': 'MISS' });
}

// ------------------------------------------------------------- ticketmaster

export function ticketmaster(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!env.TICKETMASTER_API_KEY) {
    throw new HttpError(500, 'Worker is missing TICKETMASTER_API_KEY');
  }

  const url = new URL(request.url);
  const keyword = term(url, 'keyword');
  const city = term(url, 'city');
  const limit = limitOf(url);

  const upstream = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
  upstream.searchParams.set('apikey', env.TICKETMASTER_API_KEY);
  if (keyword) upstream.searchParams.set('keyword', keyword);
  if (city) upstream.searchParams.set('city', city);
  upstream.searchParams.set('size', String(limit));
  upstream.searchParams.set('sort', 'date,asc');

  return proxied(request, deps, {
    namespace: 'ticketmaster',
    identity: `${keyword}|${city}|${limit}`,
    ttl: CACHE_TTL.events,
    upstream: upstream.toString(),
    trim: (data) => {
      const events = (data as { _embedded?: { events?: unknown[] } })?._embedded?.events;
      // Ticketmaster signals "no results" with a missing _embedded, not an empty
      // array — preserve that so the adapter's existing handling still works.
      return Array.isArray(events) ? { _embedded: { events } } : {};
    },
  });
}

// ----------------------------------------------------------------- seatgeek

export function seatgeek(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!env.SEATGEEK_CLIENT_ID) {
    throw new HttpError(500, 'Worker is missing SEATGEEK_CLIENT_ID');
  }

  const url = new URL(request.url);
  const keyword = term(url, 'keyword');
  const city = term(url, 'city');
  const limit = limitOf(url);

  const upstream = new URL('https://api.seatgeek.com/2/events');
  upstream.searchParams.set('client_id', env.SEATGEEK_CLIENT_ID);
  if (keyword) upstream.searchParams.set('q', keyword);
  if (city) upstream.searchParams.set('venue.city', city);
  upstream.searchParams.set('per_page', String(limit));
  upstream.searchParams.set('sort', 'datetime_local.asc');
  upstream.searchParams.set('datetime_utc.gte', new Date(deps.now()).toISOString().slice(0, 19));

  return proxied(request, deps, {
    namespace: 'seatgeek',
    // The `gte` timestamp is deliberately not in the cache identity — including
    // it would make every request a unique key and cache nothing.
    identity: `${keyword}|${city}|${limit}`,
    ttl: CACHE_TTL.events,
    upstream: upstream.toString(),
    trim: (data) => {
      const events = (data as { events?: unknown[] })?.events;
      return { events: Array.isArray(events) ? events : [] };
    },
  });
}

// ------------------------------------------------------------------ serpapi

export function serpapi(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!env.SERPAPI_API_KEY) {
    throw new HttpError(500, 'Worker is missing SERPAPI_API_KEY');
  }

  const url = new URL(request.url);
  const q = term(url, 'q');
  if (!q) throw new HttpError(400, 'Missing q');

  const upstream = new URL('https://serpapi.com/search.json');
  upstream.searchParams.set('engine', 'google_events');
  upstream.searchParams.set('q', q);
  upstream.searchParams.set('hl', 'en');
  upstream.searchParams.set('api_key', env.SERPAPI_API_KEY);

  return proxied(request, deps, {
    namespace: 'serpapi',
    identity: q,
    ttl: CACHE_TTL.serpapi,
    upstream: upstream.toString(),
    // SerpAPI's full payload carries search metadata and your remaining account
    // credit. Return only what the app consumes.
    trim: (data) => {
      const results = (data as { events_results?: unknown[] })?.events_results;
      return { events_results: Array.isArray(results) ? results : [] };
    },
  });
}
