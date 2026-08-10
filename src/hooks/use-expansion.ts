import { useQuery } from '@tanstack/react-query';

import { canonicalQuery } from '@/profile/canonical';
import { expandQuery } from '@/profile/client';
import { isUsable, searchableNames, type ExpansionProfile } from '@/profile/types';

/**
 * Expansion for a submitted search.
 *
 * Deliberately decoupled from the event search. Nothing on the results path
 * reads this hook's loading state — keyword results render immediately and
 * expansion enhances them when (and if) it lands. A cold expansion takes ~20
 * seconds; gating anything on it would make the app feel broken.
 *
 * Pass the *submitted* text, not the debounced input. Expansion runs a large
 * model, so firing one per keystroke would be slow and expensive.
 */
export function useExpansion(submittedQuery: string) {
  const canonical = canonicalQuery(submittedQuery);

  const query = useQuery({
    // Keyed on the canonical form, so re-submitting the same terms in a
    // different order reuses the in-memory result too.
    queryKey: ['expansion', canonical],
    queryFn: ({ signal }) => expandQuery(canonical, signal),
    enabled: canonical.length > 0,
    // An expansion for a given query never changes; the client layer persists
    // it and the Worker caches it for ~30 days.
    staleTime: Infinity,
    gcTime: Infinity,
    // No retry: an attempt costs ~20s, and the common failures (no proxy
    // configured, model declined) repeat. A second wait buys nothing.
    retry: false,
  });

  const profile: ExpansionProfile | undefined = query.data;

  return {
    /** Only set once there is something worth showing. */
    profile: isUsable(profile) ? profile : undefined,
    names: isUsable(profile) ? searchableNames(profile) : [],
    isPending: query.isFetching,
    /** True when the attempt finished but produced nothing usable. */
    isEmpty: query.isSuccess && !isUsable(profile),
    isError: query.isError,
    /** False before anything has been submitted. */
    isActive: canonical.length > 0,
  };
}
