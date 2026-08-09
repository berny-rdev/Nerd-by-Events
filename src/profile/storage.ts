/**
 * Taste profile persistence.
 *
 * Same AsyncStorage conventions as `src/lib/saved.ts` — one versioned key, the
 * whole blob read and written at once — plus the stance `src/sources` takes
 * toward data it didn't produce: trust the value, not the type annotation.
 *
 * Three things can be sitting under this key: nothing at all, a string that
 * isn't JSON, or JSON that parses into the wrong shape. A profile screen that
 * throws on any of them is a screen the user can never get back into, so all
 * three fall back to an empty profile.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeTags } from './tags';
import { emptyProfile, type AdjacentInterest, type TasteProfile } from './types';

const STORAGE_KEY = 'nearby-events:profile:v1';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isAdjacentInterest(value: unknown): value is AdjacentInterest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === 'string' && typeof candidate.why === 'string';
}

/**
 * Full structural check, exported because the tests assert on it directly and
 * because the expansion step will want it when it writes back.
 *
 * Validation is all-or-nothing on purpose: a half-valid profile is a profile
 * whose tags might be real and whose `adjacent` entries might be garbage, and
 * there's no honest way to show that to a user. Cheaper to start clean.
 */
export function isTasteProfile(value: unknown): value is TasteProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;

  if (!isStringArray(candidate.tags)) return false;
  if (candidate.scene !== null && typeof candidate.scene !== 'string') return false;
  if (!Array.isArray(candidate.adjacent) || !candidate.adjacent.every(isAdjacentInterest)) {
    return false;
  }
  // NaN and Infinity survive JSON round-trips as null, but a hand-edited or
  // future-version blob could still carry something unusable here.
  if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) {
    return false;
  }

  return true;
}

export async function loadProfile(): Promise<TasteProfile> {
  let raw: string | null;

  try {
    raw = await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    // The storage layer itself failing is rare but not impossible.
    return emptyProfile();
  }

  if (!raw) return emptyProfile();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyProfile();
  }

  if (!isTasteProfile(parsed)) return emptyProfile();

  return {
    ...parsed,
    // Nothing guarantees what's on disk went through `addTag` — a previous
    // version, a hand-edit, or a future import could all put junk here.
    tags: normalizeTags(parsed.tags),
  };
}

/**
 * Writes the profile, stamping `updatedAt`. Returns what was actually stored
 * so callers don't have to guess the timestamp.
 *
 * Write failures propagate, matching `src/lib/saved.ts`: a save that silently
 * did nothing is worse than one that surfaces.
 */
export async function saveProfile(profile: TasteProfile): Promise<TasteProfile> {
  const next: TasteProfile = { ...profile, updatedAt: Date.now() };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export async function clearProfile(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
