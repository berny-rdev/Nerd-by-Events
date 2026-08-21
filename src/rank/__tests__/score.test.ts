import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearVerdictCache, profileHash, readCachedVerdicts } from '../cache';
import { classifyBatch } from '../client';
import { rankEvents } from '../score';
import type { Event } from '@/sources/types';
import type { ExpansionProfile } from '@/profile/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  // jest.mock factories are hoisted above the import block, so this can't
  // reference an ESM binding — require() is the only option available here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The client is the network boundary; the cache and orchestration are real.
jest.mock('../client', () => ({
  ...jest.requireActual('../client'),
  classifyBatch: jest.fn(),
}));

const mockedClassify = classifyBatch as jest.MockedFunction<typeof classifyBatch>;

const PROFILE: ExpansionProfile = {
  scene: 'Virtual-singer music. Concerts count; anime conventions do not.',
  core: ['vocaloid'],
  adjacent: [{ name: 'Hatsune Miku', kind: 'artist', why: 'headlines under her own name' }],
};

let nextId = 0;
function makeEvent(overrides: Partial<Event> = {}): Event {
  nextId += 1;
  return {
    id: `ticketmaster:${nextId}`,
    sourceId: String(nextId),
    source: 'ticketmaster',
    title: `Event ${nextId}`,
    startsAt: '2026-09-01T23:00:00.000Z',
    venue: { name: 'Madison Square Garden', city: 'New York' },
    url: 'https://example.com',
    ...overrides,
  };
}

const makeEvents = (count: number) => Array.from({ length: count }, () => makeEvent());

beforeEach(async () => {
  nextId = 0;
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockedClassify.mockReset();
});

describe('rankEvents happy path', () => {
  it('returns a band for every submitted event', async () => {
    const events = makeEvents(3);
    mockedClassify.mockResolvedValue([
      { id: events[0].id, band: 'STRONG', reason: 'names Hatsune Miku' },
      { id: events[1].id, band: 'WEAK', reason: 'anime convention' },
      { id: events[2].id, band: 'UNRELATED', reason: 'orchestral programme' },
    ]);

    const result = await rankEvents({ events, profile: PROFILE });

    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.band)).toEqual(['STRONG', 'WEAK', 'UNRELATED']);
    expect(result.events.every((e) => e.isRanked)).toBe(true);
    expect(result.isRanked).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('preserves submitted order rather than sorting', async () => {
    const events = makeEvents(3);
    mockedClassify.mockResolvedValue([
      { id: events[0].id, band: 'UNRELATED', reason: 'no' },
      { id: events[1].id, band: 'STRONG', reason: 'yes' },
      { id: events[2].id, band: 'WEAK', reason: 'maybe' },
    ]);

    const result = await rankEvents({ events, profile: PROFILE });

    // The caller sorts. Keeping source order here is what makes the
    // total-failure path "unranked in source order" for free.
    expect(result.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('keeps the event payload intact alongside the verdict', async () => {
    const [event] = makeEvents(1);
    mockedClassify.mockResolvedValue([{ id: event.id, band: 'STRONG', reason: 'why' }]);

    const [ranked] = (await rankEvents({ events: [event], profile: PROFILE })).events;

    expect(ranked.title).toBe(event.title);
    expect(ranked.venue).toEqual(event.venue);
    expect(ranked.url).toBe(event.url);
  });
});

describe('rankEvents defensive parsing', () => {
  it('gives a missing event the lowest band instead of dropping it', async () => {
    const events = makeEvents(3);
    // Model omitted the middle event entirely.
    mockedClassify.mockResolvedValue([
      { id: events[0].id, band: 'STRONG', reason: 'yes' },
      { id: events[2].id, band: 'WEAK', reason: 'maybe' },
    ]);

    const result = await rankEvents({ events, profile: PROFILE });

    expect(result.events).toHaveLength(3);
    const middle = result.events[1];
    expect(middle.band).toBe('UNRELATED');
    expect(middle.isRanked).toBe(false);
    // Still ranked overall — two of three got real verdicts.
    expect(result.isRanked).toBe(true);
  });

  it('treats an unparseable response as no verdicts, never as an error', async () => {
    const events = makeEvents(2);
    mockedClassify.mockRejectedValue(new Error('Classification response was not an array'));

    const result = await rankEvents({ events, profile: PROFILE });

    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.band === 'UNRELATED')).toBe(true);
    expect(result.events.every((e) => e.isRanked === false)).toBe(true);
    expect(result.isRanked).toBe(false);
  });

  it('does not invent a band for an id it never submitted', async () => {
    const events = makeEvents(2);
    mockedClassify.mockResolvedValue([
      { id: events[0].id, band: 'STRONG', reason: 'yes' },
      { id: 'ticketmaster:not-submitted', band: 'STRONG', reason: 'phantom' },
    ]);

    const result = await rankEvents({ events, profile: PROFILE });

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(result.events[1].isRanked).toBe(false);
  });
});

describe('rankEvents failure paths', () => {
  it('is unranked but never empty when classification fails entirely', async () => {
    const events = makeEvents(25);
    mockedClassify.mockRejectedValue(new Error('down'));

    const result = await rankEvents({ events, profile: PROFILE });

    // The whole point: the caller can still render every event, in source order.
    expect(result.events).toHaveLength(25);
    expect(result.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(result.isRanked).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].eventCount).toBe(20);
    expect(result.failures[0].sampleIds).toHaveLength(3);
  });

  it('keeps the verdicts from batches that did succeed', async () => {
    const events = makeEvents(25);
    mockedClassify.mockImplementation(async (_profile, batch) => {
      if (batch.length === 5) throw new Error('second batch down');
      return batch.map((event) => ({ id: event.id, band: 'STRONG' as const, reason: 'yes' }));
    });

    const result = await rankEvents({ events, profile: PROFILE });

    expect(result.events.filter((e) => e.isRanked)).toHaveLength(20);
    expect(result.events.filter((e) => !e.isRanked)).toHaveLength(5);
    expect(result.isRanked).toBe(true);
    expect(result.failures).toHaveLength(1);
  });

  it('skips ranking with no profile but still returns every event', async () => {
    const events = makeEvents(3);

    const result = await rankEvents({ events, profile: undefined });

    expect(result.events).toHaveLength(3);
    expect(result.isRanked).toBe(false);
    expect(result.skipped).toEqual([{ reason: 'no taste profile yet' }]);
    expect(mockedClassify).not.toHaveBeenCalled();
  });

  it('handles an empty event list without calling out', async () => {
    const result = await rankEvents({ events: [], profile: PROFILE });

    expect(result.events).toEqual([]);
    expect(mockedClassify).not.toHaveBeenCalled();
  });
});

describe('rankEvents batching and concurrency', () => {
  it('batches events rather than one call per event', async () => {
    const events = makeEvents(45);
    mockedClassify.mockImplementation(async (_p, batch) =>
      batch.map((event) => ({ id: event.id, band: 'WEAK' as const, reason: 'x' })),
    );

    await rankEvents({ events, profile: PROFILE });

    // 45 events at 20 per batch — three calls, not forty-five.
    expect(mockedClassify).toHaveBeenCalledTimes(3);
    const sizes = mockedClassify.mock.calls.map((call) => call[1].length);
    expect(sizes).toEqual([20, 20, 5]);
  });

  it('never exceeds the concurrent batch cap', async () => {
    const events = makeEvents(200);
    let inFlight = 0;
    let peak = 0;

    mockedClassify.mockImplementation(async (_p, batch) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return batch.map((event) => ({ id: event.id, band: 'WEAK' as const, reason: 'x' }));
    });

    await rankEvents({ events, profile: PROFILE });

    // /classify is rate-limited at 20/min on the Worker; a wider pool would
    // burn that on one large search.
    expect(mockedClassify).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('rankEvents caching', () => {
  it('a full cache hit makes no network call', async () => {
    const events = makeEvents(3);
    mockedClassify.mockImplementation(async (_p, batch) =>
      batch.map((event) => ({ id: event.id, band: 'STRONG' as const, reason: 'yes' })),
    );

    await rankEvents({ events, profile: PROFILE });
    expect(mockedClassify).toHaveBeenCalledTimes(1);

    mockedClassify.mockClear();
    const second = await rankEvents({ events, profile: PROFILE });

    expect(mockedClassify).not.toHaveBeenCalled();
    expect(second.events.every((e) => e.isRanked)).toBe(true);
    expect(second.events.map((e) => e.band)).toEqual(['STRONG', 'STRONG', 'STRONG']);
  });

  it('only classifies the events it has not seen', async () => {
    const first = makeEvents(3);
    mockedClassify.mockImplementation(async (_p, batch) =>
      batch.map((event) => ({ id: event.id, band: 'STRONG' as const, reason: 'yes' })),
    );

    await rankEvents({ events: first, profile: PROFILE });
    mockedClassify.mockClear();

    const extra = makeEvents(2);
    const result = await rankEvents({ events: [...first, ...extra], profile: PROFILE });

    expect(mockedClassify).toHaveBeenCalledTimes(1);
    expect(mockedClassify.mock.calls[0][1].map((e) => e.id)).toEqual(extra.map((e) => e.id));
    expect(result.events).toHaveLength(5);
  });

  it('keys on the profile, so a different profile re-classifies', async () => {
    const events = makeEvents(2);
    mockedClassify.mockImplementation(async (_p, batch) =>
      batch.map((event) => ({ id: event.id, band: 'STRONG' as const, reason: 'yes' })),
    );

    await rankEvents({ events, profile: PROFILE });
    mockedClassify.mockClear();

    await rankEvents({ events, profile: { ...PROFILE, scene: 'A different scene entirely.' } });

    expect(mockedClassify).toHaveBeenCalledTimes(1);
  });

  it('does not cache a fallback band', async () => {
    const events = makeEvents(2);
    // Second event never gets a verdict.
    mockedClassify.mockResolvedValue([{ id: events[0].id, band: 'STRONG', reason: 'yes' }]);

    await rankEvents({ events, profile: PROFILE });

    const stored = await readCachedVerdicts(profileHash(PROFILE), events.map((e) => e.id));
    // Caching "UNRELATED because we couldn't classify it" would freeze a
    // transient failure into a permanent judgement.
    expect(stored.has(events[0].id)).toBe(true);
    expect(stored.has(events[1].id)).toBe(false);
  });

  it('survives a corrupt cache rather than throwing', async () => {
    await AsyncStorage.setItem('nearby-events:verdicts:v1', '{not json');
    const events = makeEvents(1);
    mockedClassify.mockResolvedValue([{ id: events[0].id, band: 'STRONG', reason: 'yes' }]);

    const result = await rankEvents({ events, profile: PROFILE });

    expect(result.events[0].band).toBe('STRONG');
  });

  it('forgets everything after clearVerdictCache', async () => {
    const events = makeEvents(1);
    mockedClassify.mockResolvedValue([{ id: events[0].id, band: 'STRONG', reason: 'yes' }]);

    await rankEvents({ events, profile: PROFILE });
    await clearVerdictCache();
    mockedClassify.mockClear();
    mockedClassify.mockResolvedValue([{ id: events[0].id, band: 'WEAK', reason: 'changed' }]);

    const result = await rankEvents({ events, profile: PROFILE });

    expect(mockedClassify).toHaveBeenCalledTimes(1);
    expect(result.events[0].band).toBe('WEAK');
  });
});

describe('rankEvents progressive delivery', () => {
  it('publishes each batch as it lands, not only at the end', async () => {
    const events = makeEvents(45);
    mockedClassify.mockImplementation(async (_p, batch) =>
      batch.map((event) => ({ id: event.id, band: 'STRONG' as const, reason: 'yes' })),
    );

    const emissions: number[] = [];
    await rankEvents({
      events,
      profile: PROFILE,
      onVerdicts: (batch) => emissions.push(batch.length),
    });

    // Three batches -> three emissions. Without this the list would flip from
    // wholly unranked to wholly ranked in one frame.
    expect(emissions).toEqual([20, 20, 5]);
  });

  it('publishes cached verdicts immediately, before any network work', async () => {
    const events = makeEvents(3);
    mockedClassify.mockImplementation(async (_p, batch) =>
      batch.map((event) => ({ id: event.id, band: 'STRONG' as const, reason: 'yes' })),
    );
    await rankEvents({ events, profile: PROFILE });
    mockedClassify.mockClear();

    const emissions: string[][] = [];
    await rankEvents({
      events,
      profile: PROFILE,
      onVerdicts: (batch) => emissions.push(batch.map((v) => v.id)),
    });

    expect(mockedClassify).not.toHaveBeenCalled();
    // A fully cached search should paint ranked immediately rather than
    // showing every row as "Ranking…" until the promise settles.
    expect(emissions).toHaveLength(1);
    expect(emissions[0].sort()).toEqual(events.map((e) => e.id).sort());
  });

  it('emits nothing for a batch that failed', async () => {
    const events = makeEvents(25);
    mockedClassify.mockImplementation(async (_p, batch) => {
      if (batch.length === 5) throw new Error('down');
      return batch.map((event) => ({ id: event.id, band: 'WEAK' as const, reason: 'x' }));
    });

    const emissions: number[] = [];
    await rankEvents({
      events,
      profile: PROFILE,
      onVerdicts: (batch) => emissions.push(batch.length),
    });

    expect(emissions).toEqual([20]);
  });

  it('is optional — omitting it changes nothing', async () => {
    const events = makeEvents(2);
    mockedClassify.mockResolvedValue([
      { id: events[0].id, band: 'STRONG', reason: 'a' },
      { id: events[1].id, band: 'WEAK', reason: 'b' },
    ]);

    const result = await rankEvents({ events, profile: PROFILE });

    expect(result.events.map((e) => e.band)).toEqual(['STRONG', 'WEAK']);
  });
});
