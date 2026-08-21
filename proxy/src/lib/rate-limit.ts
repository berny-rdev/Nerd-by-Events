import type { RateLimiter, RateLimitRule } from '../types.ts';

/**
 * Sliding-window limiter held in isolate memory.
 *
 * ⚠️ Best-effort, and deliberately so. Cloudflare runs many isolates per
 * datacenter and many datacenters, so a determined caller spread across them
 * gets more than `limit`. What this reliably stops is the thing that actually
 * happens: one buggy client, one runaway retry loop, or one person hammering
 * the URL they found in a bundle.
 *
 * For a hard guarantee use Cloudflare's Rate Limiting rules (in front of the
 * Worker, so abuse never costs an invocation) or a Durable Object (exact, but
 * adds a round trip per request). Both are account-side configuration, which is
 * why this ships as the default — see proxy/README.md.
 */
export function memoryRateLimiter(maxKeys = 10_000): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string, rule: RateLimitRule, now: number) {
      const cutoff = now - rule.windowMs;
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);

      if (recent.length >= rule.limit) {
        const oldest = recent[0];
        const retryAfterMs = Math.max(0, oldest + rule.windowMs - now);
        // Don't record the rejected attempt — otherwise a client that keeps
        // retrying pushes its own window forward and locks itself out forever.
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) || 1 };
      }

      recent.push(now);
      hits.set(key, recent);

      // Crude bound on memory. An isolate is short-lived, so this rarely fires.
      if (hits.size > maxKeys) {
        for (const [existing, timestamps] of hits) {
          if (timestamps.every((at) => at <= cutoff)) hits.delete(existing);
          if (hits.size <= maxKeys) break;
        }
      }

      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

/**
 * What one app search costs each event route.
 *
 * ⚠️ This mirrors `QUERY_BUDGET` in the app's `src/sources/plan.ts`. The app
 * fans out over the names an expansion produced — roughly 30 searchable names
 * for a rich query — and each source takes as many as its upstream quota
 * allows. If those budgets change, change these, or the limits below stop
 * meaning what they say.
 *
 * A search used to be ONE request per route. It is now up to 25. Any limit here
 * has to be read as `limit ÷ requests-per-search = searches per minute` — that
 * multiplier is the thing that made the old flat 120 look generous while
 * actually allowing under five searches a minute.
 */
const REQUESTS_PER_SEARCH: Record<string, number> = {
  '/ticketmaster/events': 25,
  '/seatgeek/events': 15,
  '/serpapi/events': 3,
};

/**
 * Searches per minute a single client may make.
 *
 * The requirement is 10. This is 12 to leave margin: the app retries a failed
 * search once, and a retried search costs its full request count again — so 12
 * covers ten clean searches, or six that all had to retry.
 */
const TARGET_SEARCHES_PER_MINUTE = 12;

function eventRouteLimit(pathname: string): RateLimitRule {
  return {
    limit: REQUESTS_PER_SEARCH[pathname] * TARGET_SEARCHES_PER_MINUTE,
    windowMs: 60_000,
  };
}

/**
 * Per-route budgets. Buckets are keyed per path (see `ruleFor` / the router),
 * so these do not share a pool — each route is limited independently.
 *
 * The model routes are counted in *calls*, not searches: one search triggers at
 * most one `/expand` and one `/classify`, so their numbers are already
 * searches-per-minute and need no multiplier.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  // 300/min — 12 searches at 25 requests each.
  '/ticketmaster/events': eventRouteLimit('/ticketmaster/events'),
  // 180/min — 12 searches at 15 requests each.
  '/seatgeek/events': eventRouteLimit('/seatgeek/events'),
  // 36/min — 12 searches at 3 requests each. Note this cap protects nothing
  // that matters for SerpAPI: its real constraint is ~100 searches per MONTH,
  // which a per-minute limit cannot express. The app-side budget of 3 is what
  // actually rations that quota.
  '/serpapi/events': eventRouteLimit('/serpapi/events'),

  '/expand': { limit: 15, windowMs: 60_000 },
  '/classify': { limit: 20, windowMs: 60_000 },

  // Anything unrouted. Deliberately tight — a new route should get its own
  // entry above rather than silently inherit a search-sized allowance.
  default: { limit: 60, windowMs: 60_000 },
};

export function ruleFor(pathname: string): RateLimitRule {
  return RATE_LIMITS[pathname] ?? RATE_LIMITS.default;
}

/** Cloudflare always sets CF-Connecting-IP; the fallback keeps local dev working. */
export function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
