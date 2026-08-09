import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearProfile, isTasteProfile, loadProfile, saveProfile } from '../storage';
import { emptyProfile, type TasteProfile } from '../types';

jest.mock('@react-native-async-storage/async-storage', () =>
  // jest.mock factories are hoisted above the import block, so this can't
  // reference an ESM binding — require() is the only option available here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

/**
 * Hardcoded rather than imported: the key is a compatibility surface — change
 * it and every existing install silently loses its profile — so a rename
 * should have to break a test and be deliberate.
 */
const STORAGE_KEY = 'nearby-events:profile:v1';

/** Writes a raw string straight past the encoder, to simulate bad stored data. */
async function seed(raw: string) {
  await AsyncStorage.setItem(STORAGE_KEY, raw);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('saveProfile / loadProfile round-trip', () => {
  it('returns what was stored, including the fields expansion will fill', async () => {
    const profile: TasteProfile = {
      tags: ['Radiohead', 'Big Thief'],
      scene: 'indie rock',
      adjacent: [{ name: 'Wednesday', why: 'shares a label with Big Thief' }],
      updatedAt: 0,
    };

    const saved = await saveProfile(profile);

    await expect(loadProfile()).resolves.toEqual(saved);
  });

  it('stamps updatedAt on write rather than trusting the caller', async () => {
    const before = Date.now();

    const saved = await saveProfile({ ...emptyProfile(), tags: ['Radiohead'] });

    expect(saved.updatedAt).toBeGreaterThanOrEqual(before);
    expect((await loadProfile()).updatedAt).toBe(saved.updatedAt);
  });

  it('round-trips an empty profile', async () => {
    const saved = await saveProfile(emptyProfile());

    const loaded = await loadProfile();
    expect(loaded.tags).toEqual([]);
    expect(loaded.scene).toBeNull();
    expect(loaded.adjacent).toEqual([]);
    expect(loaded.updatedAt).toBe(saved.updatedAt);
  });

  it('forgets everything after clearProfile', async () => {
    await saveProfile({ ...emptyProfile(), tags: ['Radiohead'] });
    await clearProfile();

    await expect(loadProfile()).resolves.toEqual(emptyProfile());
  });
});

describe('loadProfile with unusable storage', () => {
  it('returns an empty profile when nothing has been stored yet', async () => {
    await expect(loadProfile()).resolves.toEqual(emptyProfile());
  });

  it('returns an empty profile when the stored string is not JSON', async () => {
    await seed('{not json at all');

    await expect(loadProfile()).resolves.toEqual(emptyProfile());
  });

  it('returns an empty profile when the storage layer itself fails', async () => {
    jest
      .spyOn(AsyncStorage, 'getItem')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(loadProfile()).resolves.toEqual(emptyProfile());
  });

  // Parses fine, but isn't a profile. Validation is all-or-nothing, so every
  // one of these starts clean rather than half-restoring.
  const MALFORMED: [string, unknown][] = [
    ['a bare array', []],
    ['a bare string', 'radiohead'],
    ['a number', 42],
    ['null', null],
    ['an object missing tags', { scene: null, adjacent: [], updatedAt: 0 }],
    ['tags containing a non-string', { tags: ['ok', 7], scene: null, adjacent: [], updatedAt: 0 }],
    ['tags that are not an array', { tags: 'Radiohead', scene: null, adjacent: [], updatedAt: 0 }],
    ['a scene of the wrong type', { tags: [], scene: 12, adjacent: [], updatedAt: 0 }],
    ['adjacent as an object', { tags: [], scene: null, adjacent: {}, updatedAt: 0 }],
    [
      'an adjacent entry missing why',
      { tags: [], scene: null, adjacent: [{ name: 'Wednesday' }], updatedAt: 0 },
    ],
    [
      'an adjacent entry that is null',
      { tags: [], scene: null, adjacent: [null], updatedAt: 0 },
    ],
    ['updatedAt as a string', { tags: [], scene: null, adjacent: [], updatedAt: '0' }],
    ['updatedAt missing', { tags: [], scene: null, adjacent: [] }],
  ];

  for (const [label, value] of MALFORMED) {
    it(`returns an empty profile for ${label}`, async () => {
      await seed(JSON.stringify(value));

      await expect(loadProfile()).resolves.toEqual(emptyProfile());
    });
  }
});

describe('loadProfile normalization', () => {
  it('cleans tags that were not written through addTag', async () => {
    // A hand-edit, an import, or an older version could all leave this.
    await seed(
      JSON.stringify({
        tags: ['  Radiohead ', 'RADIOHEAD', 'Big   Thief', '   '],
        scene: null,
        adjacent: [],
        updatedAt: 1,
      }),
    );

    await expect(loadProfile()).resolves.toEqual({
      tags: ['Radiohead', 'Big Thief'],
      scene: null,
      adjacent: [],
      updatedAt: 1,
    });
  });
});

describe('isTasteProfile', () => {
  it('accepts a valid profile', () => {
    expect(isTasteProfile(emptyProfile())).toBe(true);
    expect(
      isTasteProfile({
        tags: ['Radiohead'],
        scene: 'indie rock',
        adjacent: [{ name: 'Wednesday', why: 'label mates' }],
        updatedAt: 1,
      }),
    ).toBe(true);
  });

  it('rejects a non-finite updatedAt', () => {
    expect(isTasteProfile({ ...emptyProfile(), updatedAt: NaN })).toBe(false);
    expect(isTasteProfile({ ...emptyProfile(), updatedAt: Infinity })).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isTasteProfile(undefined)).toBe(false);
  });
});
