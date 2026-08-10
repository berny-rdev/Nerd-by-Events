import { CACHE_TTL, cacheKey, cacheableJson } from '../lib/cache.ts';
import { canonicalQuery } from '../lib/hash.ts';
import { HttpError, json, readJsonBody } from '../lib/http.ts';
import { MODELS, parseJsonText } from '../model.ts';
import { EXPANSION_SYSTEM, buildExpansionUser } from '../prompts.ts';
import { MAX_ADJACENT, parseExpansion } from '../schema.ts';
import { applySeeds } from '../seeds.ts';
import type { Deps, Env, ExpansionProfile } from '../types.ts';

const MAX_QUERY_LENGTH = 200;

/**
 * Generous headroom, kept deliberately.
 *
 * With thinking disabled a full profile costs ~1.5k output tokens, so this is
 * far more than needed — but `max_tokens` is a cap, not a reservation, and
 * unused budget is not billed. The headroom is what stops this route breaking
 * if thinking is ever turned back on: Sonnet 5 runs adaptive thinking whenever
 * `thinking` is omitted, `max_tokens` caps thinking *plus* response text, and
 * the 4096 that was ample on Haiku produced `stop_reason: max_tokens` failures
 * the moment Sonnet's reasoning took its share.
 *
 * 16k also stays comfortably inside the SDK's non-streaming HTTP timeout.
 */
const MAX_TOKENS = 16_000;

/**
 * POST /expand  { query } -> { scene, core, adjacent[] }
 *
 * Cached on the canonical query — normalized and comma-term-sorted — effectively
 * permanently. Expanding the same description twice is pure waste, and this is
 * the most expensive call the Worker makes.
 *
 * Curated seeds are merged *after* the cache read rather than before the write,
 * so editing `seeds.ts` takes effect immediately instead of waiting out a
 * 30-day TTL on every previously cached query.
 */
export async function expand(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'Worker is missing ANTHROPIC_API_KEY');
  }

  const body = await readJsonBody(request);
  const rawQuery = (body as { query?: unknown })?.query;

  if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
    throw new HttpError(400, 'Body must be {"query": "<non-empty string>"}');
  }
  if (rawQuery.length > MAX_QUERY_LENGTH) {
    throw new HttpError(400, `Query must be ${MAX_QUERY_LENGTH} characters or fewer`, {
      length: rawQuery.length,
    });
  }

  const query = canonicalQuery(rawQuery);
  const origin = new URL(request.url).origin;
  const key = cacheKey(origin, 'expand', query);

  const cached = await deps.cache.match(key);
  if (cached) {
    const profile = JSON.parse(await cached.text()) as ExpansionProfile;
    return respond(profile, query, 'HIT', 0);
  }

  const result = await deps.callModel(env, {
    model: MODELS.expand,
    system: EXPANSION_SYSTEM,
    user: buildExpansionUser(query),
    maxTokens: MAX_TOKENS,
    // Measured, not assumed — see proxy/README.md. Thinking made this route
    // 2.6x slower without improving coverage, and made it less reproducible,
    // which matters more than usual for a result cached ~30 days.
    thinking: 'disabled',
  });

  if (result.stopReason === 'max_tokens') {
    throw new HttpError(502, 'Expansion was truncated before it finished');
  }
  if (result.stopReason === 'refusal') {
    throw new HttpError(502, 'Model declined to expand this query');
  }

  const parsed = parseExpansion(parseJsonText(result.text));
  if (!parsed.ok) {
    // Nothing partial worth returning — an unusable profile would poison every
    // search and every ranking downstream.
    throw new HttpError(502, `Expansion failed: ${parsed.error}`);
  }

  // Cache what the model produced, unseeded.
  deps.waitUntil(deps.cache.put(key, cacheableJson(parsed.profile, CACHE_TTL.expand)));

  return respond(parsed.profile, query, 'MISS', parsed.droppedEntries);
}

function respond(
  profile: ExpansionProfile,
  query: string,
  cacheState: 'HIT' | 'MISS',
  dropped: number,
): Response {
  const seeded = applySeeds(profile, query, MAX_ADJACENT);

  return json(seeded.profile, 200, {
    'X-Cache': cacheState,
    // Surfaced rather than logged: a model steadily inventing kinds is a prompt
    // problem, and this is the only place you'd see it.
    'X-Dropped-Entries': String(dropped),
    'X-Seeds-Applied': seeded.applied.join(',') || 'none',
    'X-Seed-Entries-Added': String(seeded.added),
  });
}
