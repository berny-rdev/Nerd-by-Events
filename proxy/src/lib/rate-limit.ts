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
 * Per-route budgets. The model routes are tighter because each call costs money
 * upstream; the search routes are looser because a debounced search box makes
 * several in quick succession during normal use.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  '/expand': { limit: 15, windowMs: 60_000 },
  '/classify': { limit: 20, windowMs: 60_000 },
  default: { limit: 120, windowMs: 60_000 },
};

export function ruleFor(pathname: string): RateLimitRule {
  return RATE_LIMITS[pathname] ?? RATE_LIMITS.default;
}

/** Cloudflare always sets CF-Connecting-IP; the fallback keeps local dev working. */
export function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
