import type * as Notifications from 'expo-notifications';

import { eventIdFromResponse } from '../notifications';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  SchedulableTriggerInputTypes: { DATE: 'date' },
  AndroidImportance: { DEFAULT: 3 },
}));

/**
 * The payload the OS hands back. Built loosely on purpose — it was serialized
 * when the reminder was scheduled, possibly by an older build, and comes back
 * as plain data rather than a typed object.
 */
function response(data: unknown): Notifications.NotificationResponse {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      request: {
        identifier: 'notif-1',
        content: { data },
      },
    },
  } as unknown as Notifications.NotificationResponse;
}

describe('eventIdFromResponse', () => {
  it('reads the event id a reminder carries', () => {
    expect(eventIdFromResponse(response({ eventId: 'ticketmaster:abc' }))).toBe(
      'ticketmaster:abc',
    );
  });

  it('ignores extra keys alongside it', () => {
    expect(eventIdFromResponse(response({ eventId: 'seatgeek:1', scheduledBy: 'v1' }))).toBe(
      'seatgeek:1',
    );
  });

  it('returns null when there is no response at all', () => {
    // The cold-start path resolves to null when the app wasn't launched by a tap.
    expect(eventIdFromResponse(null)).toBeNull();
    expect(eventIdFromResponse(undefined)).toBeNull();
  });

  const MALFORMED: [string, unknown][] = [
    ['no data', undefined],
    ['null data', null],
    ['data that is a string', 'ticketmaster:abc'],
    ['data with no eventId', { title: 'something' }],
    ['a numeric eventId', { eventId: 42 }],
    ['an empty eventId', { eventId: '' }],
    ['a null eventId', { eventId: null }],
  ];

  for (const [label, data] of MALFORMED) {
    it(`returns null for ${label}`, () => {
      // A malformed payload must not hijack navigation — the caller leaves the
      // user wherever they were rather than pushing a broken route.
      expect(eventIdFromResponse(response(data))).toBeNull();
    });
  }

  it('survives a response missing the nested request entirely', () => {
    expect(
      eventIdFromResponse({ notification: {} } as unknown as Notifications.NotificationResponse),
    ).toBeNull();
  });
});
