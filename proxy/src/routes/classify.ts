import { CACHE_TTL, cacheKey, cacheableJson } from '../lib/cache.ts';
import { shortHash } from '../lib/hash.ts';
import { HttpError, cleanString, json, readJsonBody } from '../lib/http.ts';
import { MODELS, parseJsonText } from '../model.ts';
import { buildClassifySystem, buildClassifyUser } from '../prompts.ts';
import { allUnresolved, parseProfileInput, parseVerdicts } from '../schema.ts';
import type { ClassifyEvent, Deps, Env, Verdict } from '../types.ts';

const MAX_EVENTS = 50;
const MAX_TITLE = 200;
const MAX_VENUE = 120;
const MAX_DESCRIPTION = 500;

/** Roughly a band plus a clause per event, with headroom. Haiku 4.5 caps at 64K. */
function maxTokensFor(count: number): number {
  return Math.min(64_000, 512 + count * 160);
}

function parseEvents(value: unknown): ClassifyEvent[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'Body must include an "events" array');
  }
  if (value.length === 0) {
    throw new HttpError(400, '"events" must not be empty');
  }
  if (value.length > MAX_EVENTS) {
    throw new HttpError(400, `At most ${MAX_EVENTS} events per request`, {
      received: value.length,
    });
  }

  const events: ClassifyEvent[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      throw new HttpError(400, 'Every event must be an object');
    }
    const entry = raw as Record<string, unknown>;

    const id = cleanString(entry.id, 120);
    const title = cleanString(entry.title, MAX_TITLE);
    if (!id) throw new HttpError(400, 'Every event needs a non-empty "id"');
    if (!title) throw new HttpError(400, `Event "${id}" needs a non-empty "title"`);
    // Ids key both the cache and the response mapping; duplicates would make
    // both ambiguous.
    if (seen.has(id)) throw new HttpError(400, `Duplicate event id "${id}"`);
    seen.add(id);

    events.push({
      id,
      title,
      venue: cleanString(entry.venue, MAX_VENUE) || undefined,
      description: cleanString(entry.description, MAX_DESCRIPTION) || undefined,
    });
  }

  return events;
}

/**
 * POST /classify  { profile, events[] } -> { id, band, reason }[]
 *
 * Caches per (profile hash, event id) rather than per request, so a search that
 * returns twenty events of which eighteen were seen before sends only the two
 * new ones to the model.
 *
 * This route never fails on model trouble. The app submits N events and always
 * gets N verdicts back; anything that couldn't be judged comes back UNRELATED.
 */
export async function classify(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'Worker is missing ANTHROPIC_API_KEY');
  }

  const body = await readJsonBody(request);
  const profile = parseProfileInput((body as { profile?: unknown })?.profile);
  if (!profile) {
    throw new HttpError(400, 'Body must include a valid "profile" (the /expand output)');
  }

  const events = parseEvents((body as { events?: unknown })?.events);

  const origin = new URL(request.url).origin;
  const profileHash = await shortHash(profile);
  const keyFor = (eventId: string) =>
    cacheKey(origin, 'classify', `${profileHash}:${eventId}`);

  // ---- cache pass -------------------------------------------------------

  const cachedVerdicts = new Map<string, Verdict>();
  await Promise.all(
    events.map(async (event) => {
      const hit = await deps.cache.match(keyFor(event.id));
      if (!hit) return;
      try {
        cachedVerdicts.set(event.id, JSON.parse(await hit.text()) as Verdict);
      } catch {
        // A corrupt cache entry is just a miss.
      }
    }),
  );

  const pending = events.filter((event) => !cachedVerdicts.has(event.id));

  // Everything already known — no model call at all.
  if (pending.length === 0) {
    return json(
      events.map((event) => cachedVerdicts.get(event.id)!),
      200,
      { 'X-Cache': 'HIT', 'X-Classified': '0' },
    );
  }

  // ---- model pass -------------------------------------------------------

  let fresh: Verdict[];
  let resolved = new Set<string>();

  try {
    const result = await deps.callModel(env, {
      model: MODELS.classify,
      system: buildClassifySystem(profile),
      user: buildClassifyUser(pending),
      maxTokens: maxTokensFor(pending.length),
    });

    if (result.stopReason === 'max_tokens') {
      fresh = allUnresolved(pending, 'classification response was truncated');
    } else if (result.stopReason === 'refusal') {
      fresh = allUnresolved(pending, 'model declined to classify');
    } else {
      const parsed = parseVerdicts(parseJsonText(result.text), pending);
      fresh = parsed.verdicts;
      resolved = parsed.resolved;
    }
  } catch (error) {
    // A failed call must not cost the caller the verdicts it already had.
    fresh = allUnresolved(pending, `classification unavailable: ${describe(error)}`);
  }

  // Only real judgments are cached — see UNRESOLVED_REASON in schema.ts.
  for (const verdict of fresh) {
    if (!resolved.has(verdict.id)) continue;
    deps.waitUntil(
      deps.cache.put(keyFor(verdict.id), cacheableJson(verdict, CACHE_TTL.classify)),
    );
  }

  const freshById = new Map(fresh.map((verdict) => [verdict.id, verdict]));

  // Response order matches submission order, not cache/model partitioning.
  const verdicts = events.map(
    (event) => cachedVerdicts.get(event.id) ?? freshById.get(event.id)!,
  );

  return json(verdicts, 200, {
    'X-Cache': cachedVerdicts.size > 0 ? 'PARTIAL' : 'MISS',
    'X-Classified': String(pending.length),
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
