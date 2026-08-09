import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { cancelReminder, scheduleEventReminder, type ScheduleResult } from '@/lib/notifications';
import {
  getSavedEvents,
  removeEvent,
  saveEvent,
  setReminderId,
  type SavedEvent,
} from '@/lib/saved';
import type { Event } from '@/sources/types';

const SAVED_KEY = ['saved-events'] as const;

/**
 * AsyncStorage behind the same useQuery interface as the network sources.
 *
 * It's local, but it's still async and still needs loading/error handling, so
 * letting Query own the cache means the Saved tab and the detail screen's
 * heart icon can never disagree about what's saved.
 */
export function useSavedEvents() {
  return useQuery({
    queryKey: SAVED_KEY,
    queryFn: getSavedEvents,
    staleTime: Infinity, // Only this app writes it; invalidation is explicit.
  });
}

export function useIsSaved(id: string | undefined) {
  const { data } = useSavedEvents();
  return Boolean(id && data?.some((saved) => saved.id === id));
}

export type ToggleSaveOutcome = {
  saved: boolean;
  /** Present when saving also tried to schedule a reminder. */
  reminder?: ScheduleResult;
};

/**
 * Save/unsave with the reminder lifecycle attached.
 *
 * Saving schedules the reminder; unsaving cancels it. Keeping those together
 * is what prevents the classic bug: unsave an event, forget it, and get a
 * notification an hour before a show you're not going to.
 */
export function useToggleSave() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (event: Event): Promise<ToggleSaveOutcome> => {
      const current = await getSavedEvents();
      const existing = current.find((saved) => saved.id === event.id);

      if (existing) {
        await cancelReminder(existing.reminderId);
        await removeEvent(event.id);
        return { saved: false };
      }

      // Save first, schedule second: a denied permission prompt shouldn't stop
      // the event from being saved.
      await saveEvent(event);
      const reminder = await scheduleEventReminder(event);
      if (reminder.ok) await setReminderId(event.id, reminder.reminderId);

      return { saved: true, reminder };
    },
    onSuccess: (_result, event) => {
      queryClient.invalidateQueries({ queryKey: SAVED_KEY });
      void event;
    },
  });

  const toggle = useCallback(
    (event: Event) => mutation.mutateAsync(event),
    [mutation],
  );

  return { toggle, isPending: mutation.isPending };
}

export type { SavedEvent };
