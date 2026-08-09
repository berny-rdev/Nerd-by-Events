/**
 * SerpAPI proxy — a Cloudflare Worker.
 *
 * Why this exists at all: SerpAPI bills per search, and anything in an Expo
 * bundle can be pulled out of the .ipa/.apk with `strings`. A key that costs
 * money cannot ship in a mobile app. So the app knows a URL, and the worker
 * knows the key.
 *
 * The Ticketmaster and SeatGeek keys stay in the app on purpose — they're
 * read-only, rate-limited and revocable, so the tradeoff runs the other way.
 *
 * Deploy:
 *   cd proxy
 *   npm install
 *   npx wrangler secret put SERPAPI_API_KEY
 *   npx wrangler deploy
 *
 * Then set EXPO_PUBLIC_EVENTS_PROXY_URL in the app's .env to the deployed URL.
 */

export interface Env {
  SERPAPI_API_KEY: string;
  /** Comma-separated origins allowed to call this. Empty = allow all. */
  ALLOWED_ORIGINS?: string;
}

const SERPAPI_URL = 'https://serpapi.com/search.json';

/** Cache upstream responses so a retyped search doesn't cost another credit. */
const CACHE_SECONDS = 600;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  // Native apps send no Origin header at all — CORS only matters for the web
  // build and for anyone poking at this from a browser.
  const allowOrigin = allowed.length === 0 || allowed.includes(origin) ? (origin || '*') : 'null';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, hasKey: Boolean(env.SERPAPI_API_KEY) }, 200, cors);
    }

    if (url.pathname !== '/serpapi/events') {
      return json({ error: 'Not found' }, 404, cors);
    }

    if (!env.SERPAPI_API_KEY) {
      return json({ error: 'Proxy is missing SERPAPI_API_KEY' }, 500, cors);
    }

    // Only `q` is forwarded. Never pass the client's params through wholesale —
    // that would let anyone with the proxy URL run arbitrary paid SerpAPI
    // engines on your account.
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 120);
    if (!q) {
      return json({ error: 'Missing q' }, 400, cors);
    }

    const cache = caches.default;
    // Cache key is the normalized query, not the raw request — so `?q=jazz` and
    // `?q=jazz&foo=1` share one cached upstream response.
    const cacheKey = new Request(`${url.origin}/serpapi/events?q=${encodeURIComponent(q)}`, {
      method: 'GET',
    });

    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...cors },
      });
    }

    const upstream = new URL(SERPAPI_URL);
    upstream.searchParams.set('engine', 'google_events');
    upstream.searchParams.set('q', q);
    upstream.searchParams.set('hl', 'en');
    upstream.searchParams.set('api_key', env.SERPAPI_API_KEY);

    const response = await fetch(upstream.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return json(
        { error: 'Upstream error', status: response.status, detail: detail.slice(0, 500) },
        502,
        cors,
      );
    }

    const data = (await response.json()) as { events_results?: unknown[] };

    // Return only what the app consumes. SerpAPI's full payload includes search
    // metadata and your account's remaining credit — no reason to leak either.
    const trimmed = JSON.stringify({ events_results: data.events_results ?? [] });

    const cacheable = new Response(trimmed, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      },
    });

    // waitUntil so the cache write doesn't delay the response.
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));

    return new Response(trimmed, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...cors },
    });
  },
};
