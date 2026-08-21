/**
 * Classification client — `POST /classify` on the Worker.
 */

import { config, hasProxy } from '@/lib/config';
import { fetchJson } from '@/lib/http';
import type { ExpansionProfile } from '@/profile/types';
import type { Event } from '@/sources/types';

import { isBand, type Band } from './types';

/**
 * A batch of 20 runs a model over 20 listings. Comfortably slower than an event
 * search, nowhere near the ~20s an expansion takes.
 */
const TIMEOUT_MS = 30_000;

export type RawVerdict = { id: string; band: Band; reason: string };

export class ClassifyUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifyUnavailable';
  }
}

/** The Worker only reads these fields; sending the whole Event would be noise. */
function toPayload(event: Event) {
  return {
    id: event.id,
    title: event.title,
    venue: event.venue.name,
  };
}

/**
 * Classifies one batch.
 *
 * Returns only verdicts that parsed. Reconciling those against the events that
 * were submitted is the caller's job — it is the caller that knows what the
 * fallback should be.
 */
export async function classifyBatch(
  profile: ExpansionProfile,
  events: Event[],
  signal?: AbortSignal,
): Promise<RawVerdict[]> {
  if (!hasProxy()) throw new ClassifyUnavailable('No proxy URL configured');
  if (events.length === 0) return [];

  const body = await fetchJson<unknown>(`${config.eventsProxyUrl}/classify`, {
    method: 'POST',
    json: { profile, events: events.map(toPayload) },
    signal,
    timeoutMs: TIMEOUT_MS,
  });

  // The Worker promises one verdict per event and never fails on model trouble,
  // but this still crossed a network boundary — a proxy error page or a deploy
  // mid-flight would otherwise reach the merge step as a verdict list.
  if (!Array.isArray(body)) {
    throw new ClassifyUnavailable('Classification response was not an array');
  }

  const verdicts: RawVerdict[] = [];
  for (const raw of body) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    // An unrecognized band is dropped here rather than coerced, so the caller
    // treats it as "no verdict" and applies the same fallback it would for a
    // missing one. Silently rewriting it to a real band would invent a
    // judgement the model never made.
    if (typeof entry.id !== 'string' || !isBand(entry.band)) continue;

    verdicts.push({
      id: entry.id,
      band: entry.band,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    });
  }

  return verdicts;
}
