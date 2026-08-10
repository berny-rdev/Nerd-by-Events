import { corsHeaders } from './lib/cors.ts';
import { HttpError, json } from './lib/http.ts';
import { clientKey, ruleFor } from './lib/rate-limit.ts';
import { classify } from './routes/classify.ts';
import { seatgeek, serpapi, ticketmaster } from './routes/events.ts';
import { expand } from './routes/expand.ts';
import type { Deps, Env } from './types.ts';

type Handler = (request: Request, env: Env, deps: Deps) => Promise<Response>;

const ROUTES: Record<string, { method: 'GET' | 'POST'; handler: Handler }> = {
  '/serpapi/events': { method: 'GET', handler: serpapi },
  '/ticketmaster/events': { method: 'GET', handler: ticketmaster },
  '/seatgeek/events': { method: 'GET', handler: seatgeek },
  '/expand': { method: 'POST', handler: expand },
  '/classify': { method: 'POST', handler: classify },
};

/**
 * The whole Worker, as a pure function of (request, env, deps).
 *
 * `index.ts` is the only thing that knows about the real cache, clock, and
 * network — which is what lets the tests drive every path below without a
 * workerd harness or a live API key.
 */
export async function handleRequest(request: Request, env: Env, deps: Deps): Promise<Response> {
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);

  // Health is deliberately outside the rate limiter — it's what an uptime check
  // hits, and locking that out during a traffic spike hides the outage.
  if (url.pathname === '/health') {
    return json(
      {
        ok: true,
        secrets: {
          anthropic: Boolean(env.ANTHROPIC_API_KEY),
          serpapi: Boolean(env.SERPAPI_API_KEY),
          ticketmaster: Boolean(env.TICKETMASTER_API_KEY),
          seatgeek: Boolean(env.SEATGEEK_CLIENT_ID),
        },
      },
      200,
      cors,
    );
  }

  const route = ROUTES[url.pathname];
  if (!route) return json({ error: 'Not found' }, 404, cors);
  if (request.method !== route.method) {
    return json({ error: `Use ${route.method} for ${url.pathname}` }, 405, cors);
  }

  const rule = ruleFor(url.pathname);
  const verdict = deps.rateLimiter.check(
    `${clientKey(request)}:${url.pathname}`,
    rule,
    deps.now(),
  );

  if (!verdict.allowed) {
    return json({ error: 'Rate limit exceeded', retry_after: verdict.retryAfterSeconds }, 429, {
      ...cors,
      'Retry-After': String(verdict.retryAfterSeconds),
    });
  }

  try {
    const response = await route.handler(request, env, deps);
    // Handlers build their own bodies and headers; CORS is layered on here so
    // no route can forget it.
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message, ...error.extra }, error.status, cors);
    }
    // Genuinely unexpected — don't leak internals to the caller.
    console.error('unhandled worker error', error);
    return json({ error: 'Internal error' }, 500, cors);
  }
}
