import type { CacheLike } from '../types.ts';

/** TTLs, in seconds. */
export const CACHE_TTL = {
  /**
   * Expansions are effectively permanent — the same query should never re-expand.
   * The Cache API is per-datacenter and evictable, so this is "as durable as the
   * edge cache gets" rather than a guarantee; see proxy/README.md for the KV
   * upgrade if you need a hard one.
   */
  expand: 60 * 60 * 24 * 30,
  /** A verdict for (profile, event) is stable as long as both are. */
  classify: 60 * 60 * 24 * 7,
  /** Matches the original SerpAPI behaviour. */
  serpapi: 600,
  /** Short — event listings move, and these APIs are the app's hot path. */
  events: 300,
} as const;

/** Cache keys are absolute URLs on the Worker's own origin, never a real route. */
export function cacheKey(origin: string, namespace: string, id: string): string {
  return `${origin}/__cache/${namespace}/${encodeURIComponent(id)}`;
}

export function cacheableJson(body: unknown, ttlSeconds: number): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttlSeconds}`,
    },
  });
}

/**
 * Wraps the real Cache API behind the string-keyed interface.
 *
 * `put` clones because the Cache API consumes the body it is handed, and the
 * caller still needs to return that response.
 */
export function workerCache(): CacheLike {
  return {
    async match(key) {
      return (await caches.default.match(new Request(key))) ?? undefined;
    },
    async put(key, response) {
      await caches.default.put(new Request(key), response.clone());
    },
  };
}

/** In-memory stand-in used by tests and by `wrangler dev`, where caches.default is a no-op. */
export function memoryCache(): CacheLike {
  const store = new Map<string, string>();
  return {
    async match(key) {
      const body = store.get(key);
      return body === undefined
        ? undefined
        : new Response(body, { headers: { 'Content-Type': 'application/json' } });
    },
    async put(key, response) {
      store.set(key, await response.clone().text());
    },
  };
}
