/**
 * The aggregator: fan out across sources *and* across expanded names, survive
 * whatever fails, dedupe what comes back.
 *
 * Two layers of fan-out now. Every configured source gets a list of queries —
 * the raw user text plus as many expanded artist/event names as its quota
 * allows — and every one of those runs independently. A single user search can
 * be ~40 requests, so failures are aggregated per source rather than reported
 * per query: nobody needs to be told twenty times that Ticketmaster is down.
 */

import { mapWithConcurrency } from '@/lib/concurrency';
import { HttpError } from '@/lib/http';
import { dedupeEvents } from './dedupe';
import { budgetFor, buildQueries } from './plan';
import { seatgeek } from './seatgeek';
import { serpapi } from './serpapi';
import { ticketmaster } from './ticketmaster';
import type { Event, EventSource, SourceId } from './types';

export const sources: EventSource[] = [ticketmaster, seatgeek, serpapi];

/**
 * Simultaneous in-flight requests across the whole fan-out. Sized for a phone
 * on cellular rather than for a datacenter — more parallelism here makes the
 * first results arrive later, not sooner.
 */
const MAX_CONCURRENT_REQUESTS = 6;

export type SourceFailure = {
  source: SourceId;
  label: string;
  message: string;
  /** True when the fix is a key/config change rather than a retry. */
  isAuthError: boolean;
  /** Queries for this source that failed. */
  failedQueries: number;
  /** Queries attempted for this source. Equal values mean the source is fully down. */
  totalQueries: number;
  /**
   * Up to three of the keywords that actually failed.
   *
   * Without this a partial fan-out failure is undiagnosable — you know three of
   * twenty-five queries broke but not which, so the cause has to be guessed at.
   */
  sampleQueries: string[];
};

export type SearchResult = {
  events: Event[];
  /** One entry per source that had at least one failing query — never one per query. */
  failures: SourceFailure[];
  /** Sources with no proxy configured — never called. */
  skipped: { source: SourceId; label: string }[];
  /** Pre-dedupe count, so the UI can say how much was duplicate. */
  rawCount: number;
  /** Total requests issued, for the "N queries" line and for sanity-checking quota. */
  queryCount: number;
};

export type AggregateQuery = {
  keyword?: string;
  city?: string;
  /**
   * Expanded artist/event names to fan out over. Agency and context entries are
   * deliberately excluded upstream (see `searchableNames`) — they describe
   * scene membership and searching them returns noise.
   */
  names?: string[];
  signal?: AbortSignal;
};

function describeError(error: unknown): { message: string; isAuthError: boolean } {
  if (error instanceof HttpError) {
    return {
      message: error.isAuthError ? 'Rejected the API key' : `Returned ${error.status}`,
      isAuthError: error.isAuthError,
    };
  }
  if (error instanceof Error) {
    // fetch aborts surface as a DOMException-ish error named AbortError.
    if (error.name === 'AbortError') return { message: 'Timed out', isAuthError: false };
    return { message: error.message, isAuthError: false };
  }
  return { message: 'Unknown error', isAuthError: false };
}

/** Names the shape a source wrongly returned, for the failure message. */
function describeShape(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

type Task = { source: EventSource; keyword: string; limit: number };

export async function searchEvents(query: AggregateQuery): Promise<SearchResult> {
  const { keyword = '', city, names = [], signal } = query;

  const configured = sources.filter((source) => source.isConfigured());
  const skipped = sources
    .filter((source) => !source.isConfigured())
    .map((source) => ({ source: source.id, label: source.label }));

  // Plan first, so the request count is knowable before anything is sent.
  const tasks: Task[] = [];
  const attempted = new Map<SourceId, number>();

  for (const source of configured) {
    const planned = buildQueries(keyword, names, budgetFor(source.id));
    attempted.set(source.id, planned.length);
    for (const item of planned) {
      tasks.push({ source, keyword: item.keyword, limit: item.limit });
    }
  }

  const settled = await mapWithConcurrency(tasks, MAX_CONCURRENT_REQUESTS, (task) =>
    task.source.search({ keyword: task.keyword, city, limit: task.limit, signal }),
  );

  const events: Event[] = [];
  /** Per source: how many queries failed, and the first error seen. */
  const failuresBySource = new Map<
    SourceId,
    { label: string; count: number; message: string; isAuthError: boolean; queries: string[] }
  >();

  const record = (
    source: EventSource,
    keyword: string,
    described: { message: string; isAuthError: boolean },
  ) => {
    const existing = failuresBySource.get(source.id);

    if (existing) {
      existing.count += 1;
      if (existing.queries.length < 3) existing.queries.push(keyword);
      // Keep the first message but let an auth error win — "rejected the API
      // key" is actionable, "timed out" is not, and one auth failure explains
      // every other failure for that source.
      if (described.isAuthError && !existing.isAuthError) {
        existing.message = described.message;
        existing.isAuthError = true;
      }
    } else {
      failuresBySource.set(source.id, {
        label: source.label,
        count: 1,
        message: described.message,
        isAuthError: described.isAuthError,
        queries: [keyword],
      });
    }
  };

  settled.forEach((result, index) => {
    const { source, keyword } = tasks[index];

    if (result.status === 'rejected') {
      record(source, keyword, describeError(result.reason));
      return;
    }

    // The signature promises Event[], but an adapter is code we don't control
    // and the annotation isn't enforced at runtime. Spreading a non-array here
    // throws a TypeError that would take down the whole fan-out — precisely the
    // failure this aggregator exists to prevent — so trust the value, not the
    // type.
    const value = result.value as unknown;

    if (!Array.isArray(value)) {
      record(source, keyword, {
        message: `Returned a non-array (${describeShape(value)})`,
        isAuthError: false,
      });
      return;
    }

    events.push(...(value as Event[]));
  });

  const failures: SourceFailure[] = [...failuresBySource].map(([source, entry]) => ({
    source,
    label: entry.label,
    message: entry.message,
    isAuthError: entry.isAuthError,
    failedQueries: entry.count,
    totalQueries: attempted.get(source) ?? entry.count,
    sampleQueries: entry.queries,
  }));

  return {
    events: dedupeEvents(events),
    failures,
    skipped,
    rawCount: events.length,
    queryCount: tasks.length,
  };
}

export * from './types';
