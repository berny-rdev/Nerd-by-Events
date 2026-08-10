/**
 * Expansion client — `POST /expand` on the Worker.
 */

import { config, hasProxy } from '@/lib/config';
import { fetchJson } from '@/lib/http';

import { canonicalQuery } from './canonical';
import { readCachedExpansion, writeCachedExpansion } from './cache';
import { isExpansionProfile, type ExpansionProfile } from './types';

/**
 * Expansion runs a large model and takes ~20 seconds on a Worker cache miss —
 * the default 10s timeout would abort every cold request. Nothing waits on this
 * call, so a long ceiling costs the user nothing.
 */
const TIMEOUT_MS = 45_000;

export class ExpansionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpansionUnavailable';
  }
}

/**
 * Cache first, network second.
 *
 * The Worker caches expansions for ~30 days too, so a miss here is often still
 * fast — but only the local hit avoids the round trip entirely.
 */
export async function expandQuery(
  query: string,
  signal?: AbortSignal,
): Promise<ExpansionProfile> {
  const canonical = canonicalQuery(query);
  if (!canonical) throw new ExpansionUnavailable('Nothing to expand');
  if (!hasProxy()) throw new ExpansionUnavailable('No proxy URL configured');

  const cached = await readCachedExpansion(canonical);
  if (cached) return cached;

  const profile = await fetchJson<unknown>(`${config.eventsProxyUrl}/expand`, {
    method: 'POST',
    json: { query: canonical },
    signal,
    timeoutMs: TIMEOUT_MS,
  });

  // The Worker validates its own model output, but this still crossed a
  // network boundary — a deploy mid-flight or a proxy error page would
  // otherwise reach the render path as a profile.
  if (!isExpansionProfile(profile)) {
    throw new ExpansionUnavailable('Expansion response was not a profile');
  }

  await writeCachedExpansion(canonical, profile);
  return profile;
}
