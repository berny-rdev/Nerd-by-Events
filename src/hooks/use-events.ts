import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';

import { searchEvents, type SearchResult } from '@/sources';
import type { Event } from '@/sources/types';

export const eventsQueryKey = (keyword: string, city: string, names: string[]) =>
  [
    'events',
    keyword.trim().toLowerCase(),
    city.trim().toLowerCase(),
    // Names are part of the identity of the search: the same keyword before and
    // after expansion are different searches returning different result sets.
    names.map((name) => name.toLowerCase()).join('|'),
  ] as const;

/**
 * One hook for the whole multi-source, multi-name search.
 *
 * `names` arrives empty and fills in when expansion lands ~20s later. That
 * changes the query key, so this refetches — and `keepPreviousData` is what
 * makes that an enhancement rather than an interruption: the keyword results
 * stay on screen while the wider fan-out runs behind them.
 *
 * TanStack gives us the `signal` for free, which aborts every in-flight request
 * in the fan-out when the key changes — the difference between one search and
 * forty orphaned ones when someone keeps typing.
 */
export function useEvents(keyword: string, city: string, names: string[] = []) {
  return useQuery({
    queryKey: eventsQueryKey(keyword, city, names),
    queryFn: ({ signal }) => searchEvents({ keyword, city, names, signal }),
    // A search with no city and no keyword would just return "events near
    // nowhere" from three providers.
    enabled: keyword.trim().length > 0 || city.trim().length > 0,
    // Event listings don't change minute to minute; this keeps tab switches
    // and back-navigation off the network entirely.
    staleTime: 5 * 60 * 1000,
    retry: 1,
    // Without this the list empties the moment expansion lands, which reads as
    // the app losing the results it had just shown.
    placeholderData: keepPreviousData,
  });
}

/**
 * Finds a single event by id without another network call.
 *
 * Detail screens receive only an id as a route param (ids are the right thing
 * to put in a URL — small, serializable, shareable). We resolve it against
 * whatever search results are already cached. Google's source has no
 * fetch-by-id endpoint, so a cache lookup is not just an optimization here.
 */
export function useCachedEvent(id: string | undefined): Event | undefined {
  const queryClient = useQueryClient();
  if (!id) return undefined;

  const caches = queryClient.getQueriesData<SearchResult>({ queryKey: ['events'] });

  for (const [, result] of caches) {
    const match = result?.events.find((event) => event.id === id);
    if (match) return match;
  }

  return undefined;
}
