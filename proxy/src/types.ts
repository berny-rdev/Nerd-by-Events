/**
 * Shared types for the Worker.
 *
 * `Deps` is the seam that makes this testable. Everything the Worker touches
 * that isn't pure — the cache, the clock, the network, the model — arrives
 * through it. `index.ts` wires the real implementations; the tests pass stubs
 * and can therefore assert things like "a cache hit did not call the model"
 * without a workerd test harness.
 */

export interface Env {
  /** Anthropic key — metered, powers /expand and /classify. */
  ANTHROPIC_API_KEY: string;
  /** SerpAPI key — metered per search. */
  SERPAPI_API_KEY: string;
  /** Ticketmaster Consumer Key. */
  TICKETMASTER_API_KEY: string;
  /** SeatGeek Client ID. */
  SEATGEEK_CLIENT_ID: string;
  /** Comma-separated origins allowed to call this. Empty = allow all. */
  ALLOWED_ORIGINS?: string;
}

/**
 * Cache keyed by absolute URL string rather than Request.
 *
 * The string key is the point: it keeps route code readable and lets tests use
 * a plain Map. `index.ts` adapts it onto the real Cache API.
 */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export type ModelRequest = {
  /** Chosen per route — see MODELS in model.ts. */
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /**
   * Omit to take the model's own default — adaptive on Sonnet 5, off on
   * Haiku 4.5. `'disabled'` turns it off explicitly.
   */
  thinking?: 'disabled';
};

export type ModelResult = {
  text: string;
  /** Needed to tell a truncated answer apart from a badly-shaped one. */
  stopReason: string | null;
};

export type RateLimitRule = { limit: number; windowMs: number };

export interface RateLimiter {
  check(
    key: string,
    rule: RateLimitRule,
    now: number,
  ): { allowed: boolean; retryAfterSeconds: number };
}

export type Deps = {
  cache: CacheLike;
  now: () => number;
  waitUntil: (promise: Promise<unknown>) => void;
  callModel: (env: Env, request: ModelRequest) => Promise<ModelResult>;
  /** Used for the three upstream event APIs. Injected so tests never hit the network. */
  upstreamFetch: typeof fetch;
  /** Injected so retry backoff is instant under test instead of real seconds. */
  sleep: (ms: number) => Promise<void>;
  rateLimiter: RateLimiter;
};

// ---------------------------------------------------------------- domain

export const KINDS = ['artist', 'event', 'agency', 'context'] as const;
export type Kind = (typeof KINDS)[number];

export type AdjacentEntry = {
  name: string;
  kind: Kind;
  why: string;
};

export type ExpansionProfile = {
  scene: string;
  /** The user's own terms, normalized — not the model's additions. */
  core: string[];
  adjacent: AdjacentEntry[];
};

export const BANDS = ['STRONG', 'POSSIBLE', 'WEAK', 'UNRELATED'] as const;
export type Band = (typeof BANDS)[number];

export type ClassifyEvent = {
  id: string;
  title: string;
  venue?: string;
  description?: string;
};

export type Verdict = {
  id: string;
  band: Band;
  reason: string;
};
