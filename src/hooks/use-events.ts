import { useQuery, useQueryClient } from '@tanstack/react-query';

import { searchEvents, type SearchResult } from '@/sources';
import type { Event } from '@/sources/types';

export const eventsQueryKey = (keyword: string, city: string) =>
  ['events', keyword.trim().toLowerCase(), city.trim().toLowerCase()] as const;

/**
 * One hook for the whole multi-source search.
 *
 * TanStack Query gives us the `signal` for free — it aborts the in-flight
 * fetches when the query key changes, which is what stops a fast typist from
 * having six overlapping searches race to render.
 */
export function useEvents(keyword: string, city: string) {
  return useQuery({
    queryKey: eventsQueryKey(keyword, city),
    queryFn: ({ signal }) => searchEvents({ keyword, city, signal }),
    // A search with no city and no keyword would just return "events near
    // nowhere" from three providers.
    enabled: keyword.trim().length > 0 || city.trim().length > 0,
    // Event listings don't change minute to minute; this keeps tab switches
    // and back-navigation off the network entirely.
    staleTime: 5 * 60 * 1000,
    retry: 1,
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
