import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearSavedEvents,
  getSavedEvents,
  isSavedEvent,
  removeEvent,
  saveEvent,
  type SavedEvent,
} from '../saved';
import type { Event } from '@/sources/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  // jest.mock factories are hoisted above the import block, so this can't
  // reference an ESM binding — require() is the only option available here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

/**
 * Hardcoded rather than imported: the key is a compatibility surface — change
 * it and every existing install silently loses its saved events — so a rename
 * should have to break a test and be deliberate.
 */
const STORAGE_KEY = 'nearby-events:saved:v1';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'ticketmaster:1',
    sourceId: '1',
    source: 'ticketmaster',
    title: 'Radiohead',
    startsAt: '2026-09-01T23:00:00.000Z',
    venue: { name: 'Madison Square Garden', city: 'New York' },
    url: 'https://example.com/1',
    ...overrides,
  };
}

function makeSaved(overrides: Partial<SavedEvent> = {}): SavedEvent {
  return { ...makeEvent(), savedAt: '2026-08-01T00:00:00.000Z', ...overrides };
}

/** Writes rows straight past saveEvent, to simulate what's already on disk. */
async function seed(value: unknown) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

async function seedRaw(raw: string) {
  await AsyncStorage.setItem(STORAGE_KEY, raw);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('getSavedEvents with valid storage', () => {
  it('round-trips a valid array unchanged', async () => {
    const rows = [
      makeSaved({ id: 'ticketmaster:1' }),
      makeSaved({ id: 'seatgeek:2', source: 'seatgeek', url: 'https://example.com/2' }),
    ];
    await seed(rows);

    await expect(getSavedEvents()).resolves.toEqual(rows);
  });

  it('keeps rows carrying every optional field', async () => {
    const row = makeSaved({
      startsAt: null,
      startsAtLabel: 'Fri, Aug 8, 7 – 10 PM',
      imageUrl: 'https://img.example.com/a.jpg',
      price: { min: 50, max: 200, currency: 'USD' },
      mergedFrom: ['ticketmaster', 'seatgeek'],
      reminderId: 'notif-1',
    });
    await seed([row]);

    await expect(getSavedEvents()).resolves.toEqual([row]);
  });

  it('returns an empty list when nothing has been stored yet', async () => {
    await expect(getSavedEvents()).resolves.toEqual([]);
  });
});

describe('getSavedEvents drops only the invalid rows', () => {
  it('keeps the good entries when one is malformed', async () => {
    const good = makeSaved({ id: 'ticketmaster:1' });
    const alsoGood = makeSaved({ id: 'seatgeek:3', source: 'seatgeek' });
    // The exact row that used to kill the tab: formatVenue destructures
    // `venue.name` and throws on it.
    const bad = { ...makeSaved({ id: 'seatgeek:2' }), venue: undefined };

    await seed([good, bad, alsoGood]);

    const result = await getSavedEvents();

    expect(result.map((event) => event.id)).toEqual(['ticketmaster:1', 'seatgeek:3']);
  });

  it('treats a row with a missing nested venue as invalid', async () => {
    const { venue: _venue, ...withoutVenue } = makeSaved();
    await seed([withoutVenue]);

    await expect(getSavedEvents()).resolves.toEqual([]);
  });

  it('treats a row with a venue missing name as invalid', async () => {
    await seed([makeSaved({ venue: { city: 'New York' } as Event['venue'] })]);

    await expect(getSavedEvents()).resolves.toEqual([]);
  });

  it('returns an empty list rather than throwing when every row is bad', async () => {
    await seed([null, 42, 'radiohead', {}, { id: 'x' }, []]);

    await expect(getSavedEvents()).resolves.toEqual([]);
  });

  it('preserves the order of the surviving rows', async () => {
    await seed([
      makeSaved({ id: 'a' }),
      { garbage: true },
      makeSaved({ id: 'b' }),
      null,
      makeSaved({ id: 'c' }),
    ]);

    const result = await getSavedEvents();

    expect(result.map((event) => event.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('getSavedEvents with unusable storage', () => {
  it('returns an empty list when the parsed value is not an array', async () => {
    await seed({ events: [makeSaved()] });

    await expect(getSavedEvents()).resolves.toEqual([]);
  });

  it('returns an empty list when the stored string is not JSON', async () => {
    await seedRaw('{not json at all');

    await expect(getSavedEvents()).resolves.toEqual([]);
  });
});

describe('isSavedEvent field checks', () => {
  it('accepts a minimal valid row', () => {
    expect(isSavedEvent(makeSaved())).toBe(true);
  });

  const INVALID: [string, unknown][] = [
    ['a null row', null],
    ['an array', []],
    ['a string', 'radiohead'],
    ['a missing id', { ...makeSaved(), id: undefined }],
    ['an empty id', { ...makeSaved(), id: '' }],
    ['a non-string title', { ...makeSaved(), title: 42 }],
    ['a missing url', { ...makeSaved(), url: undefined }],
    ['an empty url', { ...makeSaved(), url: '' }],
    ['an unknown source', { ...makeSaved(), source: 'craigslist' }],
    ['a numeric startsAt', { ...makeSaved(), startsAt: 1756767600000 }],
    ['a venue that is a string', { ...makeSaved(), venue: 'MSG' }],
    ['a non-string imageUrl', { ...makeSaved(), imageUrl: 12 }],
    ['a price missing currency', { ...makeSaved(), price: { min: 1, max: 2 } }],
    // formatPrice feeds this to Intl.NumberFormat, which throws RangeError on
    // a code it doesn't recognise — a plain typeof check wouldn't catch it.
    ['a price with a nonsense currency', { ...makeSaved(), price: { min: 1, max: 2, currency: 'dollars' } }],
    ['a price with a non-numeric min', { ...makeSaved(), price: { min: '1', max: 2, currency: 'USD' } }],
    ['mergedFrom containing an unknown source', { ...makeSaved(), mergedFrom: ['ticketmaster', 'bandsintown'] }],
    ['a non-string reminderId', { ...makeSaved(), reminderId: 7 }],
  ];

  for (const [label, value] of INVALID) {
    it(`rejects ${label}`, () => {
      expect(isSavedEvent(value)).toBe(false);
    });
  }

  it('accepts rows missing fields nothing reads', () => {
    // sourceId and savedAt are written but never dereferenced, so a row
    // without them still renders fine and shouldn't be discarded.
    const { sourceId: _sourceId, savedAt: _savedAt, ...rest } = makeSaved();

    expect(isSavedEvent(rest)).toBe(true);
  });

  it('accepts a null startsAt', () => {
    expect(isSavedEvent(makeSaved({ startsAt: null, startsAtLabel: 'Date TBA' }))).toBe(true);
  });
});

describe('writes go through the same filter', () => {
  it('prunes a corrupt row when the next save rewrites the list', async () => {
    await seed([{ garbage: true }, makeSaved({ id: 'ticketmaster:1' })]);

    await saveEvent(makeEvent({ id: 'seatgeek:2', source: 'seatgeek' }));

    const stored = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? '[]');
    expect(stored.map((event: SavedEvent) => event.id)).toEqual([
      'seatgeek:2',
      'ticketmaster:1',
    ]);
  });

  it('still removes and clears normally', async () => {
    await saveEvent(makeEvent({ id: 'ticketmaster:1' }));
    await saveEvent(makeEvent({ id: 'seatgeek:2', source: 'seatgeek' }));

    await expect(removeEvent('ticketmaster:1')).resolves.toHaveLength(1);

    await clearSavedEvents();
    await expect(getSavedEvents()).resolves.toEqual([]);
  });
});
