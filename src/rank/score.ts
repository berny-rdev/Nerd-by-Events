/**
 * Ranking: give every fetched event a band against the expansion profile.
 *
 * The fan-out returns whatever its queries matched, which includes a lot of
 * coincidence — searching "Eve" brings back "Marilyn Maye's New Year's Eve
 * Extravaganza". This is the step that separates those.
 *
 * Shaped like the source aggregator on purpose: it returns
 * `{ events, failures, skipped }` and never throws, so a caller renders the
 * result rather than catching around it. Ranking is an enhancement — every
 * failure path still hands back every event that was submitted.
 */

import { mapWithConcurrency } from '@/lib/concurrency';
import { HttpError } from '@/lib/http';
import type { ExpansionProfile } from '@/profile/types';
import type { Event } from '@/sources/types';

import { profileHash, readCachedVerdicts, writeCachedVerdicts } from './cache';
import { classifyBatch, type RawVerdict } from './client';
import { LOWEST_BAND, type RankFailure, type RankResult, type RankedEvent } from './types';

/**
 * Events per `/classify` call.
 *
 * The Worker accepts 50. Twenty is deliberate: a failed batch costs its whole
 * batch's verdicts, so smaller batches mean a narrower blast radius, and more
 * batches means the concurrency pool has something to overlap. Larger batches
 * would also push the model's response longer, and a truncated response loses
 * the tail of the batch.
 */
const BATCH_SIZE = 20;

/**
 * Concurrent classify calls.
 *
 * Lower than the event fan-out's 6 because each of these is a model call on the
 * Worker, not an HTTP GET — and /classify is rate-limited at 20/min, which a
 * wider pool would burn through on a single large search.
 */
const MAX_CONCURRENT_BATCHES = 3;

const UNRANKED_REASON = 'not classified';

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

function describeError(error: unknown): string {
  if (error instanceof HttpError) {
    return error.isAuthError ? 'Rejected the API key' : `Returned ${error.status}`;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Timed out';
    return error.message;
  }
  return 'Unknown error';
}

/** An event carrying the fallback band — used wherever a real verdict is absent. */
function unranked(event: Event, reason: string): RankedEvent {
  return { ...event, band: LOWEST_BAND, reason, isRanked: false };
}

function skippedResult(events: Event[], reason: string): RankResult {
  return {
    events: events.map((event) => unranked(event, reason)),
    failures: [],
    skipped: [{ reason }],
    isRanked: false,
  };
}

export type RankQuery = {
  events: Event[];
  profile: ExpansionProfile | undefined;
  signal?: AbortSignal;
  /**
   * Called as verdicts become available, before the whole run finishes.
   *
   * This is what makes the list fill in progressively rather than flipping from
   * wholly unranked to wholly ranked. It fires once for the cache hits (so those
   * land immediately) and once per classify batch as each returns.
   */
  onVerdicts?: (verdicts: RawVerdict[]) => void;
};

export async function rankEvents({
  events,
  profile,
  signal,
  onVerdicts,
}: RankQuery): Promise<RankResult> {
  if (events.length === 0) {
    return { events: [], failures: [], skipped: [], isRanked: false };
  }
  // No profile means no expansion landed — there is nothing to rank against.
  if (!profile) return skippedResult(events, 'no taste profile yet');

  const hash = profileHash(profile);

  // ---- cache pass -------------------------------------------------------

  const cached = await readCachedVerdicts(
    hash,
    events.map((event) => event.id),
  );
  const pending = events.filter((event) => !cached.has(event.id));

  if (cached.size > 0) {
    onVerdicts?.([...cached].map(([id, verdict]) => ({ id, ...verdict })));
  }

  // Everything already known — no network at all.
  if (pending.length === 0) {
    return {
      events: events.map((event) => {
        const hit = cached.get(event.id)!;
        return { ...event, band: hit.band, reason: hit.reason, isRanked: true };
      }),
      failures: [],
      skipped: [],
      isRanked: true,
    };
  }

  // ---- classify pass ----------------------------------------------------

  const batches = chunk(pending, BATCH_SIZE);

  const settled = await mapWithConcurrency(batches, MAX_CONCURRENT_BATCHES, (batch) =>
    classifyBatch(profile, batch, signal),
  );

  const fresh = new Map<string, RawVerdict>();
  const failures: RankFailure[] = [];

  settled.forEach((result, index) => {
    const batch = batches[index];

    if (result.status === 'rejected') {
      // One failed batch must not cost the others theirs.
      failures.push({
        eventCount: batch.length,
        message: describeError(result.reason),
        sampleIds: batch.slice(0, 3).map((event) => event.id),
      });
      return;
    }

    for (const verdict of result.value) fresh.set(verdict.id, verdict);
    if (result.value.length > 0) onVerdicts?.(result.value);
  });

  // Cache only real verdicts. A fallback band is a harness outcome, and storing
  // it would freeze a transient failure into a permanent judgement.
  await writeCachedVerdicts(hash, [...fresh.values()]);

  // ---- merge ------------------------------------------------------------

  // Submitted order is preserved throughout: the caller sorts, and the
  // total-failure case then falls out as "source order, lowest band".
  const ranked = events.map((event): RankedEvent => {
    const hit = cached.get(event.id);
    if (hit) return { ...event, band: hit.band, reason: hit.reason, isRanked: true };

    const verdict = fresh.get(event.id);
    // Covers three cases at once: the batch failed, the model omitted this
    // event, or its band didn't parse. All three mean "no judgement", and none
    // of them is a reason to drop a real event.
    if (!verdict) return unranked(event, UNRANKED_REASON);

    return { ...event, band: verdict.band, reason: verdict.reason, isRanked: true };
  });

  return {
    events: ranked,
    failures,
    skipped: [],
    isRanked: ranked.some((event) => event.isRanked),
  };
}
