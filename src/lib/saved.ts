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
import type { Event } from '@/sources/types';

const STORAGE_KEY = 'nearby-events:saved:v1';

export type SavedEvent = Event & {
  savedAt: string;
  /** expo-notifications id, so we can cancel the reminder on unsave. */
  reminderId?: string;
};

/**
 * We store the whole event, not just its id. The saved tab has to work with
 * no network and with an expired API key, and Google's source has no
 * fetch-by-id endpoint to re-resolve from anyway.
 */
export async function getSavedEvents(): Promise<SavedEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedEvent[]) : [];
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
