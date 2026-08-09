/**
 * Saved events, persisted with AsyncStorage.
 *
 * AsyncStorage is a single string->string map. No schema, no migrations, no
 * queries — if you want "all saved events" you read one key and parse the
 * whole blob. That's fine at this scale and would not be fine at 10k records.
 *
 * The versioned key (`:v1`) is the cheap insurance: when the shape changes,
 * bump to v2 rather than crashing on last week's JSON.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOURCE_PRIORITY, type Event, type Money } from '@/sources/types';

const STORAGE_KEY = 'nearby-events:saved:v1';

export type SavedEvent = Event & {
  savedAt: string;
  /** expo-notifications id, so we can cancel the reminder on unsave. */
  reminderId?: string;
};

const VALID_SOURCES = new Set<string>(SOURCE_PRIORITY);

function isVenue(value: unknown): value is Event['venue'] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // formatVenue destructures both, so a missing `venue` throws before anything
  // renders — this nested check is the one that actually matters.
  return typeof candidate.name === 'string' && typeof candidate.city === 'string';
}

function isMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.min === 'number' &&
    Number.isFinite(candidate.min) &&
    typeof candidate.max === 'number' &&
    Number.isFinite(candidate.max) &&
    // Not just "a string": formatPrice hands this to Intl.NumberFormat, which
    // throws RangeError on anything that isn't a plausible ISO 4217 code.
    typeof candidate.currency === 'string' &&
    /^[A-Za-z]{3}$/.test(candidate.currency)
  );
}

/**
 * Structural check for one stored row.
 *
 * Scoped to what the render and notification paths actually dereference —
 * `sourceId` and `savedAt` are stored but never read, so a row missing them is
 * still perfectly displayable and we don't throw it away over a field nobody
 * looks at. Optional fields are checked only when present.
 */
export function isSavedEvent(value: unknown): value is SavedEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;

  // id is a FlatList key and a route param; empty would break both.
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false;
  if (typeof candidate.title !== 'string') return false;
  // url goes straight to Link/openBrowserAsync.
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return false;

  if (typeof candidate.source !== 'string' || !VALID_SOURCES.has(candidate.source)) return false;

  // formatEventDate copes with a null, but not with a number or an object.
  if (candidate.startsAt !== null && typeof candidate.startsAt !== 'string') return false;

  if (!isVenue(candidate.venue)) return false;

  if (candidate.startsAtLabel !== undefined && typeof candidate.startsAtLabel !== 'string') {
    return false;
  }
  if (candidate.imageUrl !== undefined && typeof candidate.imageUrl !== 'string') return false;
  if (candidate.price !== undefined && !isMoney(candidate.price)) return false;
  if (candidate.reminderId !== undefined && typeof candidate.reminderId !== 'string') return false;

  if (candidate.mergedFrom !== undefined) {
    if (!Array.isArray(candidate.mergedFrom)) return false;
    if (!candidate.mergedFrom.every((s) => typeof s === 'string' && VALID_SOURCES.has(s))) {
      return false;
    }
  }

  return true;
}

/**
 * We store the whole event, not just its id. The saved tab has to work with
 * no network and with an expired API key, and Google's source has no
 * fetch-by-id endpoint to re-resolve from anyway.
 */
export async function getSavedEvents(): Promise<SavedEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Per row, not wholesale. Checking only `Array.isArray` and casting let a
    // malformed entry reach EventCard, where formatVenue destructures
    // `venue.name` and throws — and because this is persisted, the Saved tab
    // stayed broken across restarts. Dropping just the bad row means one lost
    // event instead of a dead tab or an emptied library.
    return parsed.filter(isSavedEvent);
  } catch {
    // Corrupt JSON shouldn't take down the tab. Start clean.
    return [];
  }
}

async function write(events: SavedEvent[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}

export async function saveEvent(event: Event, reminderId?: string): Promise<SavedEvent[]> {
  const current = await getSavedEvents();
  if (current.some((saved) => saved.id === event.id)) return current;

  const next = [{ ...event, savedAt: new Date().toISOString(), reminderId }, ...current];
  await write(next);
  return next;
}

export async function removeEvent(id: string): Promise<SavedEvent[]> {
  const current = await getSavedEvents();
  const next = current.filter((saved) => saved.id !== id);
  await write(next);
  return next;
}

export async function setReminderId(id: string, reminderId?: string): Promise<SavedEvent[]> {
  const current = await getSavedEvents();
  const next = current.map((saved) => (saved.id === id ? { ...saved, reminderId } : saved));
  await write(next);
  return next;
}

export async function clearSavedEvents(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
