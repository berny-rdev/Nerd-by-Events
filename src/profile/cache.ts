/**
 * App-side expansion cache, keyed by canonical query.
 *
 * The Worker already caches expansions for ~30 days, so this is not about
 * saving the Worker work — it's about the ~20 second wait. A cache hit here
 * costs one AsyncStorage read instead of a network round trip, which is the
 * difference between "instant" and "noticeable" when someone re-runs a search
 * they ran yesterday.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { canonicalQuery } from './canonical';
import { isExpansionProfile, type ExpansionProfile } from './types';

const STORAGE_KEY = 'nearby-events:expansions:v1';

/**
 * Small on purpose. The whole map is read and rewritten on every access, so a
 * large cache would make the read that's supposed to be fast slow instead.
 */
const MAX_ENTRIES = 40;

type CacheEntry = {
  profile: ExpansionProfile;
  /** Epoch millis, used to evict the oldest when the cap is reached. */
  cachedAt: number;
};

type CacheMap = Record<string, CacheEntry>;

function isEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.cachedAt === 'number' && isExpansionProfile(entry.profile);
}

/** Reads the whole map, dropping anything that no longer parses. */
async function readMap(): Promise<CacheMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const clean: CacheMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Per entry, not wholesale — one bad row shouldn't cost every cached
      // expansion the user has built up.
      if (isEntry(value)) clean[key] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export async function readCachedExpansion(query: string): Promise<ExpansionProfile | null> {
  const key = canonicalQuery(query);
  if (!key) return null;

  const map = await readMap();
  return map[key]?.profile ?? null;
}

export async function writeCachedExpansion(
  query: string,
  profile: ExpansionProfile,
): Promise<void> {
  const key = canonicalQuery(query);
  if (!key) return;

  const map = await readMap();
  map[key] = { profile, cachedAt: Date.now() };

  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    const oldestFirst = keys.sort((a, b) => map[a].cachedAt - map[b].cachedAt);
    for (const stale of oldestFirst.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[stale];
    }
  }

  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A failed write just means the next search pays the network cost again.
    // Not worth surfacing to the user.
  }
}

export async function clearExpansionCache(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
