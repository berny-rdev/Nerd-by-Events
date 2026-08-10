/**
 * Cloudflare Worker for the Nearby app.
 *
 * Every third-party key the app needs lives here as a secret. Nothing ships in
 * the app bundle — the app knows this Worker's URL and nothing else.
 *
 *   GET  /health
 *   GET  /ticketmaster/events?keyword=&city=&limit=
 *   GET  /seatgeek/events?keyword=&city=&limit=
 *   GET  /serpapi/events?q=
 *   POST /expand    { query }                -> { scene, core, adjacent[] }
 *   POST /classify  { profile, events[] }    -> { id, band, reason }[]
 *
 * Deploy and secrets: see proxy/README.md.
 */

import { memoryCache, workerCache } from './lib/cache.ts';
import { memoryRateLimiter } from './lib/rate-limit.ts';
import { callModel } from './model.ts';
import { handleRequest } from './router.ts';
import type { Deps, Env } from './types.ts';

/**
 * The limiter must outlive the request to mean anything, so it's module-scoped
 * — one bucket per isolate. See lib/rate-limit.ts for what that does and
 * doesn't buy you.
 */
const rateLimiter = memoryRateLimiter();

/**
 * Miniflare (what backs `wrangler dev`) does implement `caches.default`, and
 * persists it to `.wrangler/state/v3/cache` — so the real cache is used locally
 * and survives restarting the dev server. The in-memory fallback is only for a
 * runtime that has no Cache API at all.
 *
 * Practical consequence when iterating on a prompt: restarting `wrangler dev`
 * does NOT give you a cold cache. Use `--persist-to <fresh dir>` for that.
 */
function selectCache() {
  return typeof caches !== 'undefined' && caches.default ? workerCache() : memoryCache();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const deps: Deps = {
      cache: selectCache(),
      now: () => Date.now(),
      waitUntil: (promise) => ctx.waitUntil(promise),
      callModel,
      upstreamFetch: (input, init) => fetch(input, init),
      rateLimiter,
    };

    return handleRequest(request, env, deps);
  },
};
