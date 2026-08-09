import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { loadProfile, saveProfile } from '@/profile/storage';
import { addTag as addTagTo, removeTag as removeTagFrom } from '@/profile/tags';
import { emptyProfile, type TasteProfile } from '@/profile/types';

const PROFILE_KEY = ['taste-profile'] as const;

/**
 * The taste profile behind the same Query interface as everything else, so the
 * profile screen gets loading/error handling without special-casing the fact
 * that this one happens to be local.
 */
export function useTasteProfile() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: loadProfile,
    staleTime: Infinity, // Only this app writes it; invalidation is explicit.
  });

  const apply = useMutation({
    mutationFn: async (change: (profile: TasteProfile) => TasteProfile) => {
      // Re-read instead of editing the cached copy: the write has to be based
      // on what's actually on disk, not on what this screen last rendered.
      const current = await loadProfile();
      const next = change(current);

      // `addTag`/`removeTag` hand back the original array when nothing
      // changed, so a duplicate submit costs one read and no write at all.
      if (next.tags === current.tags) return current;

      return saveProfile(next);
    },
    onSuccess: (profile) => {
      // saveProfile returns exactly what was stored, including the stamped
      // updatedAt, so there's nothing to re-read.
      queryClient.setQueryData(PROFILE_KEY, profile);
    },
  });

  const addTag = useCallback(
    (raw: string) => apply.mutateAsync((profile) => ({ ...profile, tags: addTagTo(profile.tags, raw) })),
    [apply],
  );

  const removeTag = useCallback(
    (tag: string) => apply.mutateAsync((profile) => ({ ...profile, tags: removeTagFrom(profile.tags, tag) })),
    [apply],
  );

  return {
    // A missing profile renders identically to an empty one, so the screen
    // never has to branch on undefined.
    profile: query.data ?? emptyProfile(),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    addTag,
    removeTag,
    isSaving: apply.isPending,
  };
}
