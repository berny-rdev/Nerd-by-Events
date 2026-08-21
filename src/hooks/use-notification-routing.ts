import * as Notifications from 'expo-notifications';
import { useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { eventIdFromResponse } from '@/lib/notifications';

/**
 * Opens the event a reminder refers to when its notification is tapped.
 *
 * Two entry points, not one — this is the part that usually gets missed:
 *
 *  - **Warm**: the app is already running, `addNotificationResponseReceivedListener`
 *    fires.
 *  - **Cold**: the tap *launched* the app. No listener existed at that moment,
 *    so nothing ever fires; the response has to be pulled with
 *    `getLastNotificationResponseAsync`.
 *
 * Both paths funnel through one handler so they can't drift, and both are
 * deduped on the notification identifier — on a cold start the listener can
 * also fire for the same response, and without the guard the user gets the
 * event screen pushed twice and has to press back twice.
 */
export function useNotificationRouting() {
  const router = useRouter();

  /**
   * Navigating before the root navigator has mounted is a no-op that fails
   * silently. On a cold start the response resolves in milliseconds, well
   * before the tree is ready, so this gate is what makes that path work at all.
   */
  const navigationState = useRootNavigationState();
  const isNavigationReady = Boolean(navigationState?.key);

  const handled = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!isNavigationReady) return;

    handled.current ??= new Set<string>();
    const seen = handled.current;
    let active = true;

    const open = (response: Notifications.NotificationResponse | null) => {
      if (!active || !response) return;

      const identifier = response.notification.request.identifier;
      if (seen.has(identifier)) return;

      const eventId = eventIdFromResponse(response);
      // A reminder with no usable payload shouldn't hijack navigation — leave
      // the user wherever they were.
      if (!eventId) return;

      seen.add(identifier);
      router.push({ pathname: '/event/[id]', params: { id: eventId } });
    };

    // Cold start: the tap that launched the app.
    Notifications.getLastNotificationResponseAsync()
      .then(open)
      .catch(() => {
        // No launch response, or the platform has none to give. Not an error.
      });

    // Warm: taps while the app is running or backgrounded.
    const subscription = Notifications.addNotificationResponseReceivedListener(open);

    return () => {
      active = false;
      subscription.remove();
    };
  }, [isNavigationReady, router]);
}
