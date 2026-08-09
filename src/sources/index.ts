/**
 * The aggregator: fan out to every configured source, survive the ones that
 * fail, dedupe what comes back.
 *
 * `Promise.allSettled` rather than `Promise.all` is the whole design. If
 * SeatGeek is down or the SerpAPI quota is spent, the user still gets
 * Ticketmaster results plus a note about what's missing — one bad provider
 * degrades the screen instead of emptying it.
 */

import { HttpError } from '@/lib/http';
import { dedupeEvents } from './dedupe';
import { seatgeek } from './seatgeek';
import { serpapi } from './serpapi';
import { ticketmaster } from './ticketmaster';
import type { Event, EventSource, SearchQuery, SourceId } from './types';

export const sources: EventSource[] = [ticketmaster, seatgeek, serpapi];

export type SourceFailure = {
  source: SourceId;
  label: string;
  message: string;
  /** True when the fix is a key/config change rather than a retry. */
  isAuthError: boolean;
};

export type SearchResult = {
  events: Event[];
  /** Sources that were asked and threw. */
  failures: SourceFailure[];
  /** Sources with no key configured — never called. */
  skipped: { source: SourceId; label: string }[];
  /** Pre-dedupe count, so the UI can say "12 of 19 were duplicates". */
  rawCount: number;
};

function describe(error: unknown): { message: string; isAuthError: boolean } {
  if (error instanceof HttpError) {
    return {
      message: error.isAuthError
        ? 'Rejected the API key'
        : `Returned ${error.status}`,
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

export async function searchEvents(query: SearchQuery): Promise<SearchResult> {
  const configured = sources.filter((source) => source.isConfigured());
  const skipped = sources
    .filter((source) => !source.isConfigured())
    .map((source) => ({ source: source.id, label: source.label }));

  const settled = await Promise.allSettled(
    configured.map((source) => source.search(query)),
  );

  const events: Event[] = [];
  const failures: SourceFailure[] = [];

  settled.forEach((result, index) => {
    const source = configured[index];
    if (result.status === 'fulfilled') {
      events.push(...result.value);
    } else {
      const { message, isAuthError } = describe(result.reason);
      failures.push({ source: source.id, label: source.label, message, isAuthError });
    }
  });

  return {
    events: dedupeEvents(events),
    failures,
    skipped,
    rawCount: events.length,
  };
}

export * from './types';
