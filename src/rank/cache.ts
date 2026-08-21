/**
 * Verdict cache, keyed on (profile hash, event id).
 *
 * The Worker caches the same pair for ~7 days, so this is not about saving it
 * work — it's about the round trip. Re-running yesterday's search should not
 * re-classify anything.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { stableHash } from '@/lib/hash';
import type { ExpansionProfile } from '@/profile/types';
import { isBand, type Band } from './types';

const STORAGE_KEY = 'nearby-events:verdicts:v1';

/**
 * Bigger than the expansion cache because the unit is an event, not a search —
 * one fan-out can produce a hundred. Still bounded: the whole map is read and
 * rewritten per access.
 */
const MAX_ENTRIES = 600;

export type CachedVerdict = { band: Band; reason: string };

type Entry = CachedVerdict & { cachedAt: number };
type CacheMap = Record<string, Entry>;

/** Stable across key ordering, so a re-serialized profile still hits. */
export function profileHash(profile: ExpansionProfile): string {
  return stableHash(profile);
}

export function verdictKey(hash: string, eventId: string): string {
  return `${hash}:${eventId}`;
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    isBand(entry.band) && typeof entry.reason === 'string' && typeof entry.cachedAt === 'number'
  );
}

async function readMap(): Promise<CacheMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const clean: CacheMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Per entry, not wholesale — one bad row shouldn't cost every verdict.
      if (isEntry(value)) clean[key] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

/** Looks up many at once; the map is read exactly once. */
export async function readCachedVerdicts(
  hash: string,
  eventIds: string[],
): Promise<Map<string, CachedVerdict>> {
  const found = new Map<string, CachedVerdict>();
  if (eventIds.length === 0) return found;

  const map = await readMap();
  for (const id of eventIds) {
    const entry = map[verdictKey(hash, id)];
    if (entry) found.set(id, { band: entry.band, reason: entry.reason });
  }
  return found;
}

export async function writeCachedVerdicts(
  hash: string,
  verdicts: { id: string; band: Band; reason: string }[],
): Promise<void> {
  if (verdicts.length === 0) return;

  const map = await readMap();
  const now = Date.now();
  for (const verdict of verdicts) {
    map[verdictKey(hash, verdict.id)] = { band: verdict.band, reason: verdict.reason, cachedAt: now };
  }

  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    const oldestFirst = keys.sort((a, b) => map[a].cachedAt - map[b].cachedAt);
    for (const stale of oldestFirst.slice(0, keys.length - MAX_ENTRIES)) delete map[stale];
  }

  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // A failed write just means the next search re-classifies. Not worth surfacing.
  }
}

export async function clearVerdictCache(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
