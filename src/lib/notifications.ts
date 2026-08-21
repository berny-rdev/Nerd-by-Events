/**
 * Local notification reminders.
 *
 * Everything here is *local* scheduling — the OS holds the notification and
 * fires it even if the app never runs again. No server, no push tokens.
 *
 * The interesting part of this file is not the happy path, it's the four ways
 * scheduling legitimately fails: the user denied permission, the event has no
 * real timestamp, the reminder time is already in the past, or the platform is
 * web. Each returns a distinct reason so the UI can say something true.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Event } from '@/sources/types';

/** How long before the event to fire the reminder. */
export const REMINDER_LEAD_MINUTES = 60;

/**
 * Controls what happens when a notification arrives while the app is open.
 * Without this, a foreground notification is delivered silently and it looks
 * like nothing happened. Call once, from the root layout.
 */
export function configureNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export type ScheduleResult =
  | { ok: true; reminderId: string; firesAt: Date }
  | {
      ok: false;
      reason: 'denied' | 'no-start-time' | 'too-soon' | 'unsupported';
      message: string;
    };

/**
 * Asks for permission, but only once — iOS silently no-ops the second prompt,
 * so we check the existing status first and let the caller send the user to
 * Settings if they've already said no.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;

  // `canAskAgain` is false once the user has denied at the OS prompt. Asking
  // again does nothing, so don't pretend we did.
  if (!existing.canAskAgain) return false;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function scheduleEventReminder(
  event: Event,
  leadMinutes = REMINDER_LEAD_MINUTES,
): Promise<ScheduleResult> {
  if (Platform.OS === 'web') {
    return { ok: false, reason: 'unsupported', message: 'Reminders need the iOS or Android app.' };
  }

  // Google-sourced events often have no defensible timestamp. Refusing here is
  // the point of keeping `startsAt` nullable instead of guessing a time.
  if (!event.startsAt) {
    return {
      ok: false,
      reason: 'no-start-time',
      message: "This listing doesn't have an exact start time, so we can't set a reminder.",
    };
  }

  const fireAt = new Date(new Date(event.startsAt).getTime() - leadMinutes * 60 * 1000);
  if (fireAt.getTime() <= Date.now()) {
    return {
      ok: false,
      reason: 'too-soon',
      message: 'This event starts too soon to schedule a reminder.',
    };
  }

  const granted = await ensureNotificationPermission();
  if (!granted) {
    return {
      ok: false,
      reason: 'denied',
      message: 'Notifications are turned off. Enable them in Settings to get reminders.',
    };
  }

  // Android needs a channel before anything will actually surface.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('event-reminders', {
      name: 'Event reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const reminderId = await Notifications.scheduleNotificationAsync({
    content: {
      title: `${event.title} starts in ${leadMinutes} minutes`,
      body: event.venue.name,
      // Carried through to the tap handler so we can deep-link to the event.
      data: { eventId: event.id },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fireAt,
      channelId: 'event-reminders',
    },
  });

  return { ok: true, reminderId, firesAt: fireAt };
}

export async function cancelReminder(reminderId?: string): Promise<void> {
  if (!reminderId || Platform.OS === 'web') return;
  // Cancelling an id the OS no longer knows about is a no-op, not an error,
  // so there's nothing to guard against here.
  await Notifications.cancelScheduledNotificationAsync(reminderId);
}

/**
 * Pulls the event id out of a notification response.
 *
 * Defensive because this payload crossed a process boundary: the OS serialized
 * it when the reminder was scheduled — possibly days ago, possibly by an older
 * build of the app — and handed it back. It is data, not a type.
 */
export function eventIdFromResponse(
  response: Notifications.NotificationResponse | null | undefined,
): string | null {
  const data = response?.notification?.request?.content?.data;
  if (typeof data !== 'object' || data === null) return null;

  const eventId = (data as Record<string, unknown>).eventId;
  return typeof eventId === 'string' && eventId.length > 0 ? eventId : null;
}
