import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearExpansionCache, readCachedExpansion, writeCachedExpansion } from '../cache';
import { isExpansionProfile, isUsable, searchableNames, type ExpansionProfile } from '../types';

jest.mock('@react-native-async-storage/async-storage', () =>
  // jest.mock factories are hoisted above the import block, so this can't
  // reference an ESM binding — require() is the only option available here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const STORAGE_KEY = 'nearby-events:expansions:v1';

const PROFILE: ExpansionProfile = {
  scene: 'Virtual-singer music. Concerts count; anime conventions do not.',
  core: ['vocaloid', 'hololive'],
  adjacent: [
    { name: 'Hatsune Miku', kind: 'artist', why: 'headlines under her own name' },
    { name: 'Miku Expo', kind: 'event', why: 'concert series' },
    { name: 'Hololive', kind: 'agency', why: 'members billed individually' },
    { name: 'Bilibili', kind: 'context', why: 'platform, not an act' },
  ],
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('expansion cache', () => {
  it('round-trips a profile', async () => {
    await writeCachedExpansion('vocaloid, hololive', PROFILE);
    await expect(readCachedExpansion('vocaloid, hololive')).resolves.toEqual(PROFILE);
  });

  it('hits regardless of term order, case, or spacing', async () => {
    await writeCachedExpansion('vocaloid, vsinger, hololive', PROFILE);

    await expect(readCachedExpansion('vocaloid, hololive, vsinger')).resolves.toEqual(PROFILE);
    await expect(readCachedExpansion('Hololive,  VOCALOID ,vsinger')).resolves.toEqual(PROFILE);
  });

  it('misses for a genuinely different query', async () => {
    await writeCachedExpansion('vocaloid', PROFILE);
    await expect(readCachedExpansion('bluegrass')).resolves.toBeNull();
  });

  it('returns null when nothing has been cached', async () => {
    await expect(readCachedExpansion('vocaloid')).resolves.toBeNull();
  });

  it('survives a corrupt store rather than throwing', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, '{not json');
    await expect(readCachedExpansion('vocaloid')).resolves.toBeNull();
  });

  it('drops only the malformed entries, keeping the good ones', async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        vocaloid: { profile: PROFILE, cachedAt: 1 },
        broken: { profile: { scene: 'no adjacent array' }, cachedAt: 2 },
        alsobroken: 'not an entry',
      }),
    );

    await expect(readCachedExpansion('vocaloid')).resolves.toEqual(PROFILE);
    await expect(readCachedExpansion('broken')).resolves.toBeNull();
  });

  it('ignores an empty query on both read and write', async () => {
    await writeCachedExpansion('   ', PROFILE);
    await expect(readCachedExpansion('   ')).resolves.toBeNull();
    await expect(AsyncStorage.getItem(STORAGE_KEY)).resolves.toBeNull();
  });

  it('evicts the oldest entries past the cap', async () => {
    // Cap is 40; write 45 and confirm the earliest are gone and the latest stay.
    for (let i = 0; i < 45; i++) {
      await writeCachedExpansion(`query-${String(i).padStart(2, '0')}`, PROFILE);
    }

    const stored = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? '{}');
    expect(Object.keys(stored)).toHaveLength(40);
    await expect(readCachedExpansion('query-00')).resolves.toBeNull();
    await expect(readCachedExpansion('query-44')).resolves.toEqual(PROFILE);
  });

  it('forgets everything after clearExpansionCache', async () => {
    await writeCachedExpansion('vocaloid', PROFILE);
    await clearExpansionCache();
    await expect(readCachedExpansion('vocaloid')).resolves.toBeNull();
  });
});

describe('profile validation', () => {
  it('accepts the Worker shape', () => {
    expect(isExpansionProfile(PROFILE)).toBe(true);
  });

  const INVALID: [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a missing scene', { core: [], adjacent: [] }],
    ['an empty scene', { scene: '', core: [], adjacent: [] }],
    ['a missing adjacent array', { scene: 'x', core: [] }],
    ['non-string core entries', { scene: 'x', core: [7], adjacent: [] }],
    [
      'an unknown kind',
      { scene: 'x', core: [], adjacent: [{ name: 'a', kind: 'venue', why: 'b' }] },
    ],
    ['an entry missing why', { scene: 'x', core: [], adjacent: [{ name: 'a', kind: 'artist' }] }],
  ];

  for (const [label, value] of INVALID) {
    it(`rejects ${label}`, () => {
      expect(isExpansionProfile(value)).toBe(false);
    });
  }
});

describe('searchableNames', () => {
  it('returns only the kinds that appear in listing titles', () => {
    // agency and context entries are scene signals — searching for them would
    // mostly burn a query on nothing.
    expect(searchableNames(PROFILE)).toEqual(['Hatsune Miku', 'Miku Expo']);
  });

  it('treats a profile with no searchable names as unusable', () => {
    expect(isUsable(PROFILE)).toBe(true);
    expect(isUsable({ ...PROFILE, adjacent: [PROFILE.adjacent[2]] })).toBe(false);
    expect(isUsable(undefined)).toBe(false);
  });
});
