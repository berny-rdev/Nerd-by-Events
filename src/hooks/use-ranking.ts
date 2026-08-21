import { useEffect, useMemo, useState } from 'react';

import { profileHash } from '@/rank/cache';
import { rankEvents } from '@/rank/score';
import { LOWEST_BAND, type Band, type RankFailure, type RankedEvent } from '@/rank/types';
import type { ExpansionProfile } from '@/profile/types';
import type { Event } from '@/sources/types';

type Verdict = { band: Band; reason: string };

type RunState = {
  /** Which (events, profile) pair this state belongs to. */
  signature: string;
  verdicts: Map<string, Verdict>;
  /** True once the run settled, however it settled. */
  finished: boolean;
  isRanked: boolean;
  failures: RankFailure[];
};

function emptyRun(signature: string): RunState {
  return { signature, verdicts: new Map(), finished: false, isRanked: false, failures: [] };
}

/**
 * Ranking, delivered progressively.
 *
 * Deliberately not a `useQuery`. TanStack resolves once, which would flip the
 * list from wholly unranked to wholly ranked in a single frame; the requirement
 * is that bands fill in as classify calls return. So this owns a verdict map
 * and updates it from `rankEvents`' progress callback.
 *
 * Nothing here gates rendering. The caller already has its events and merges
 * whatever verdicts exist so far — an empty map just means everything shows as
 * unranked, which is a perfectly renderable state.
 */
export function useRanking(events: Event[], profile: ExpansionProfile | undefined) {
  const signature = useMemo(() => {
    const ids = events.map((event) => event.id).join('|');
    return `${profile ? profileHash(profile) : 'no-profile'}::${ids}`;
  }, [events, profile]);

  const [state, setState] = useState<RunState>(() => emptyRun(signature));

  useEffect(() => {
    if (events.length === 0 || !profile) return;

    const controller = new AbortController();
    let live = true;

    /**
     * State for a new run is established by the first async update rather than
     * by resetting synchronously here — a synchronous setState in an effect
     * body triggers a cascading render, and the stale-run guard below makes it
     * unnecessary.
     */
    const update = (change: (run: RunState) => RunState) => {
      if (!live) return;
      setState((previous) =>
        change(previous.signature === signature ? previous : emptyRun(signature)),
      );
    };

    rankEvents({
      events,
      profile,
      signal: controller.signal,
      onVerdicts: (batch) =>
        update((run) => {
          const verdicts = new Map(run.verdicts);
          for (const verdict of batch) {
            verdicts.set(verdict.id, { band: verdict.band, reason: verdict.reason });
          }
          return { ...run, verdicts };
        }),
    })
      .then((result) =>
        update((run) => ({
          ...run,
          finished: true,
          isRanked: result.isRanked,
          failures: result.failures,
        })),
      )
      // rankEvents doesn't throw, but a rejected promise must never leave the
      // banner spinning forever.
      .catch(() => update((run) => ({ ...run, finished: true })));

    return () => {
      live = false;
      controller.abort();
    };
  }, [events, profile, signature]);

  // State from a previous search is treated as absent rather than cleared, so
  // switching searches never renders one search's verdicts against another's
  // events.
  const run = state.signature === signature ? state : emptyRun(signature);

  /**
   * Every fetched event, carrying whatever verdict has arrived. An event with
   * none yet gets the lowest band and `isRanked: false` — the same shape it
   * would have after a failure, so the list never distinguishes "not yet" from
   * "never".
   */
  const ranked: RankedEvent[] = useMemo(
    () =>
      events.map((event) => {
        const verdict = run.verdicts.get(event.id);
        return verdict
          ? { ...event, band: verdict.band, reason: verdict.reason, isRanked: true }
          : { ...event, band: LOWEST_BAND, reason: '', isRanked: false };
      }),
    [events, run.verdicts],
  );

  return {
    events: ranked,
    /** Derived, not stored — true from the moment a run is possible until it settles. */
    isRanking: Boolean(profile) && events.length > 0 && !run.finished,
    /** True once any real verdict exists — drives sorting and the break. */
    hasVerdicts: run.verdicts.size > 0,
    /** False after a settled run in which nothing could be classified. */
    isRanked: run.isRanked,
    failures: run.failures,
  };
}
