import { HttpError } from '@/lib/http';
import { searchEvents } from '../index';
import { seatgeek } from '../seatgeek';
import { serpapi } from '../serpapi';
import { ticketmaster } from '../ticketmaster';
import type { Event, SourceId } from '../types';

/**
 * The provider modules are replaced wholesale, so nothing here touches a real
 * API. `sources` in ../index is built from these imports at module load, which
 * means the registry the aggregator fans out to *is* these mocks.
 *
 * The `label` values have to match the real adapters — the failure/skip
 * reporting surfaces them to the user, and these tests assert on them.
 */
jest.mock('../ticketmaster', () => ({
  ticketmaster: {
    id: 'ticketmaster',
    label: 'Ticketmaster',
    isConfigured: jest.fn(),
    search: jest.fn(),
  },
}));

jest.mock('../seatgeek', () => ({
  seatgeek: {
    id: 'seatgeek',
    label: 'SeatGeek',
    isConfigured: jest.fn(),
    search: jest.fn(),
  },
}));

jest.mock('../serpapi', () => ({
  serpapi: {
    id: 'serpapi',
    label: 'Google Events',
    isConfigured: jest.fn(),
    search: jest.fn(),
  },
}));

type MockedSource = { isConfigured: jest.Mock; search: jest.Mock };

/** The imports are typed as EventSource; at runtime they're the mocks above. */
const mocked = (source: unknown) => source as MockedSource;

const ALL_SOURCES = [ticketmaster, seatgeek, serpapi];

/**
 * Ids are counter-based, never derived from the title — see the note in
 * dedupe.test.ts. Two events that should share an id must be built by spreading
 * one record, not by giving two records the same title.
 */
let nextId = 0;

function makeEvent(overrides: Partial<Event> & { source: SourceId; title: string }): Event {
  nextId += 1;
  return {
    id: `${overrides.source}:${nextId}`,
    sourceId: String(nextId),
    startsAt: '2026-09-01T23:00:00.000Z',
    venue: { name: 'Madison Square Garden', city: 'New York' },
    url: 'https://example.com',
    ...overrides,
  };
}

beforeEach(() => {
  nextId = 0;
  jest.clearAllMocks();
  // Default: every provider is configured and returns nothing. Each test then
  // changes only the provider it cares about.
  for (const source of ALL_SOURCES) {
    mocked(source).isConfigured.mockReturnValue(true);
    mocked(source).search.mockResolvedValue([]);
  }
});

describe('searchEvents partial failure', () => {
  it('returns the survivors when one provider rejects', async () => {
    mocked(ticketmaster).search.mockResolvedValue([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
    ]);
    mocked(seatgeek).search.mockResolvedValue([
      makeEvent({
        source: 'seatgeek',
        title: 'Phoebe Bridgers',
        startsAt: '2026-09-02T23:00:00.000Z',
      }),
    ]);
    mocked(serpapi).search.mockRejectedValue(new Error('quota exceeded'));

    const result = await searchEvents({});

    expect(result.events.map((event) => event.title)).toEqual(['Radiohead', 'Phoebe Bridgers']);
    expect(result.rawCount).toBe(2);
    expect(result.failures).toEqual([
      {
        source: 'serpapi',
        label: 'Google Events',
        message: 'quota exceeded',
        isAuthError: false,
        failedQueries: 1,
        totalQueries: 1,
        sampleQueries: [''],
      },
    ]);
  });

  it('resolves with an empty list rather than throwing when every provider rejects', async () => {
    for (const source of ALL_SOURCES) {
      mocked(source).search.mockRejectedValue(new Error('down'));
    }

    // The whole point of allSettled: a total outage is still a resolved
    // promise the UI can render, not an exception the screen has to catch.
    await expect(searchEvents({})).resolves.toMatchObject({ events: [], rawCount: 0 });

    const result = await searchEvents({});
    expect(result.failures.map((failure) => failure.source)).toEqual([
      'ticketmaster',
      'seatgeek',
      'serpapi',
    ]);
  });

  it('still dedupes across the providers that did survive', async () => {
    mocked(ticketmaster).search.mockResolvedValue([
      makeEvent({ source: 'ticketmaster', title: 'Knicks vs. Celtics' }),
    ]);
    mocked(seatgeek).search.mockResolvedValue([
      makeEvent({ source: 'seatgeek', title: 'Celtics at Knicks' }),
    ]);
    mocked(serpapi).search.mockRejectedValue(new Error('down'));

    const result = await searchEvents({});

    expect(result.events).toHaveLength(1);
    expect(result.events[0].mergedFrom).toEqual(['ticketmaster', 'seatgeek']);
    // rawCount is pre-dedupe, which is what lets the UI say "merged 1 duplicate".
    expect(result.rawCount).toBe(2);
  });
});

describe('searchEvents fan-out over expanded names', () => {
  const NAMES = ['Hatsune Miku', 'Miku Expo', 'Luo Tianyi', 'Ado'];

  const keywordsFor = (source: unknown) =>
    mocked(source).search.mock.calls.map((call) => call[0].keyword);

  it('runs one query per name per source, plus the raw query', async () => {
    await searchEvents({ keyword: 'vocaloid', names: NAMES });

    // Ticketmaster's budget (25) covers the raw query and all four names.
    expect(keywordsFor(ticketmaster)).toEqual(['vocaloid', ...NAMES]);
    expect(keywordsFor(seatgeek)).toEqual(['vocaloid', ...NAMES]);
  });

  it('keeps searching the raw query even when names are present', async () => {
    await searchEvents({ keyword: 'vocaloid', names: NAMES });

    // The raw text occasionally hits something the expansion missed, and it is
    // what produced the results already on screen.
    expect(keywordsFor(ticketmaster)[0]).toBe('vocaloid');
  });

  it('caps SerpAPI at the raw query plus a couple of names', async () => {
    await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const serpapiKeywords = keywordsFor(serpapi);
    // ~100 searches/month on the free tier — it must not receive the full list.
    expect(serpapiKeywords.length).toBeLessThanOrEqual(3);
    expect(serpapiKeywords[0]).toBe('vocaloid');
    expect(serpapiKeywords.length).toBeLessThan(keywordsFor(ticketmaster).length);
  });

  it('searches only the raw query before expansion arrives', async () => {
    await searchEvents({ keyword: 'vocaloid' });

    for (const source of ALL_SOURCES) {
      expect(keywordsFor(source)).toEqual(['vocaloid']);
    }
  });

  it('gives expanded names a smaller result limit than the raw query', async () => {
    await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const calls = mocked(ticketmaster).search.mock.calls.map((call) => call[0]);
    expect(calls[0].limit).toBeGreaterThan(calls[1].limit);
  });

  it('forwards the city and abort signal to every query', async () => {
    const controller = new AbortController();
    await searchEvents({
      keyword: 'vocaloid',
      city: 'Austin',
      names: NAMES,
      signal: controller.signal,
    });

    for (const call of mocked(ticketmaster).search.mock.calls) {
      expect(call[0].city).toBe('Austin');
      expect(call[0].signal).toBe(controller.signal);
    }
  });

  it('reports how many requests it made', async () => {
    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const expected =
      keywordsFor(ticketmaster).length + keywordsFor(seatgeek).length + keywordsFor(serpapi).length;
    expect(result.queryCount).toBe(expected);
  });

  it('collapses the same event returned by two different queries', async () => {
    // The whole reason dedupe had to change: one Ticketmaster record matching
    // both "Hatsune Miku" and "Hatsune Miku Expo".
    const duplicate = makeEvent({ source: 'ticketmaster', title: 'Hatsune Miku Expo 2026' });
    mocked(ticketmaster).search.mockResolvedValue([duplicate]);
    mocked(seatgeek).search.mockResolvedValue([]);
    mocked(serpapi).search.mockResolvedValue([]);

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    expect(result.events).toHaveLength(1);
    // Fetched once per query, merged down to one.
    expect(result.rawCount).toBe(keywordsFor(ticketmaster).length);
    expect(result.events[0].mergedFrom).toBeUndefined();
  });

  it('aggregates failures per source rather than per query', async () => {
    mocked(ticketmaster).search.mockRejectedValue(new Error('down'));

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const ticketmasterFailures = result.failures.filter((f) => f.source === 'ticketmaster');
    // Five queries failed; the user should be told once.
    expect(ticketmasterFailures).toHaveLength(1);
    expect(ticketmasterFailures[0].failedQueries).toBe(5);
    expect(ticketmasterFailures[0].totalQueries).toBe(5);
  });

  it('distinguishes a partly-failing source from a dead one', async () => {
    let call = 0;
    mocked(ticketmaster).search.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('flaky');
      return [];
    });

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const failure = result.failures.find((f) => f.source === 'ticketmaster');
    expect(failure?.failedQueries).toBe(1);
    expect(failure?.totalQueries).toBe(5);
  });

  it('lets an auth error outrank a transient one in the aggregated message', async () => {
    let call = 0;
    mocked(seatgeek).search.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('socket hang up');
      throw new HttpError(401, 'https://proxy.test/seatgeek/events', 'nope');
    });

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const failure = result.failures.find((f) => f.source === 'seatgeek');
    // One rejected key explains every other failure for that source; "socket
    // hang up" would send someone debugging the network instead.
    expect(failure?.isAuthError).toBe(true);
    expect(failure?.message).toBe('Rejected the API key');
  });

  it('keeps a surviving source when another fails across every query', async () => {
    mocked(ticketmaster).search.mockRejectedValue(new Error('down'));
    mocked(seatgeek).search.mockResolvedValue([
      makeEvent({ source: 'seatgeek', title: 'Radiohead' }),
    ]);

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    expect(result.events).toHaveLength(1);
    expect(result.failures.map((f) => f.source)).toEqual(['ticketmaster']);
  });
});

describe('searchEvents with degenerate provider results', () => {
  it('drops an empty provider without losing the others', async () => {
    mocked(ticketmaster).search.mockResolvedValue([]);
    mocked(seatgeek).search.mockResolvedValue([
      makeEvent({ source: 'seatgeek', title: 'Radiohead' }),
      makeEvent({
        source: 'seatgeek',
        title: 'Phoebe Bridgers',
        startsAt: '2026-09-02T23:00:00.000Z',
      }),
    ]);
    mocked(serpapi).search.mockResolvedValue([]);

    const result = await searchEvents({});

    expect(result.events).toHaveLength(2);
    expect(result.failures).toEqual([]);
  });

  it('does not let a row with blank fields corrupt the merged list', async () => {
    mocked(ticketmaster).search.mockResolvedValue([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
    ]);
    // The shape a bad Google row takes: no title to normalize, no city to
    // group on, and no timestamp to sort by.
    mocked(seatgeek).search.mockResolvedValue([
      makeEvent({
        source: 'seatgeek',
        title: '',
        startsAt: null,
        venue: { name: '', city: '' },
      }),
    ]);

    const result = await searchEvents({});

    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.title)).toContain('Radiohead');
    // Undated rows sort last, so the good event stays at the top of the list.
    expect(result.events[0].title).toBe('Radiohead');
  });
});

describe('searchEvents with a provider that breaks its contract', () => {
  /**
   * Two healthy providers either side of SeatGeek, which fulfils with `value`.
   * Every case asserts the survivors' events still come back, so a contract
   * violation costs you one provider and not the whole search.
   */
  async function searchWithSeatGeekReturning(value: unknown) {
    mocked(ticketmaster).search.mockResolvedValue([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
    ]);
    mocked(seatgeek).search.mockResolvedValue(value);
    mocked(serpapi).search.mockResolvedValue([
      makeEvent({
        source: 'serpapi',
        title: 'Phoebe Bridgers',
        startsAt: '2026-09-02T23:00:00.000Z',
      }),
    ]);

    return searchEvents({});
  }

  it('treats a fulfilled undefined as that provider failing', async () => {
    const result = await searchWithSeatGeekReturning(undefined);

    expect(result.events.map((event) => event.title)).toEqual(['Radiohead', 'Phoebe Bridgers']);
    expect(result.failures).toEqual([
      {
        source: 'seatgeek',
        label: 'SeatGeek',
        message: 'Returned a non-array (undefined)',
        isAuthError: false,
        failedQueries: 1,
        totalQueries: 1,
        sampleQueries: [''],
      },
    ]);
  });

  it('treats a fulfilled null as that provider failing', async () => {
    const result = await searchWithSeatGeekReturning(null);

    expect(result.events.map((event) => event.title)).toEqual(['Radiohead', 'Phoebe Bridgers']);
    expect(result.failures).toEqual([
      {
        source: 'seatgeek',
        label: 'SeatGeek',
        message: 'Returned a non-array (null)',
        isAuthError: false,
        failedQueries: 1,
        totalQueries: 1,
        sampleQueries: [''],
      },
    ]);
  });

  it('treats a fulfilled string as that provider failing', async () => {
    // What a proxy returning an HTML error page would look like after a
    // response.json() that didn't throw.
    const result = await searchWithSeatGeekReturning('<html>502 Bad Gateway</html>');

    expect(result.events.map((event) => event.title)).toEqual(['Radiohead', 'Phoebe Bridgers']);
    expect(result.failures[0]).toMatchObject({
      source: 'seatgeek',
      message: 'Returned a non-array (string)',
    });
  });

  it('treats a fulfilled object as that provider failing', async () => {
    // The classic: returning the envelope instead of the array inside it.
    const result = await searchWithSeatGeekReturning({ events: [] });

    expect(result.events.map((event) => event.title)).toEqual(['Radiohead', 'Phoebe Bridgers']);
    expect(result.failures[0]).toMatchObject({
      source: 'seatgeek',
      message: 'Returned a non-array (object)',
    });
  });

  it('captures a provider that throws synchronously rather than rejecting', async () => {
    mocked(ticketmaster).search.mockResolvedValue([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
    ]);
    // A plain (non-async) search() that validates before returning a promise.
    // The throw happens inside searchEvents' .map(), so without the wrapper it
    // escapes allSettled and rejects the whole aggregate — this await is the
    // assertion.
    mocked(seatgeek).search.mockImplementation(() => {
      throw new Error('Missing SeatGeek client id');
    });

    const result = await searchEvents({});

    expect(result.events.map((event) => event.title)).toEqual(['Radiohead']);
    expect(result.failures).toEqual([
      {
        source: 'seatgeek',
        label: 'SeatGeek',
        message: 'Missing SeatGeek client id',
        isAuthError: false,
        failedQueries: 1,
        totalQueries: 1,
        sampleQueries: [''],
      },
    ]);
  });
});

describe('searchEvents source reporting', () => {
  it('names the unconfigured providers and never calls them', async () => {
    mocked(seatgeek).isConfigured.mockReturnValue(false);
    mocked(serpapi).isConfigured.mockReturnValue(false);

    const result = await searchEvents({});

    expect(result.skipped).toEqual([
      { source: 'seatgeek', label: 'SeatGeek' },
      { source: 'serpapi', label: 'Google Events' },
    ]);
    expect(mocked(seatgeek).search).not.toHaveBeenCalled();
    expect(mocked(serpapi).search).not.toHaveBeenCalled();
    expect(mocked(ticketmaster).search).toHaveBeenCalledTimes(1);
  });

  it('keeps skipped and failed providers separate', async () => {
    mocked(ticketmaster).search.mockResolvedValue([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
    ]);
    mocked(seatgeek).search.mockRejectedValue(new Error('down'));
    mocked(serpapi).isConfigured.mockReturnValue(false);

    const result = await searchEvents({});

    expect(result.failures.map((failure) => failure.source)).toEqual(['seatgeek']);
    expect(result.skipped.map((skip) => skip.source)).toEqual(['serpapi']);
    expect(result.events).toHaveLength(1);
  });

  it('reports nothing skipped or failed on a clean run', async () => {
    const result = await searchEvents({});

    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('attributes a failure to the provider that actually threw', async () => {
    // Guards the index-alignment between `configured` and the allSettled
    // results — filtering out an unconfigured source shifts every later index.
    mocked(ticketmaster).isConfigured.mockReturnValue(false);
    mocked(seatgeek).search.mockResolvedValue([
      makeEvent({ source: 'seatgeek', title: 'Radiohead' }),
    ]);
    mocked(serpapi).search.mockRejectedValue(new Error('down'));

    const result = await searchEvents({});

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].source).toBe('serpapi');
    expect(result.failures[0].label).toBe('Google Events');
  });

  it('forwards the query to every configured provider', async () => {
    const query = { keyword: 'jazz', city: 'Austin' };

    await searchEvents(query);

    for (const source of ALL_SOURCES) {
      expect(mocked(source).search).toHaveBeenCalledWith(expect.objectContaining(query));
    }
  });
});

describe('searchEvents failure messages', () => {
  it('flags a rejected key as an auth error', async () => {
    mocked(seatgeek).search.mockRejectedValue(
      new HttpError(401, 'https://api.seatgeek.com/2/events', 'unauthorized'),
    );

    const result = await searchEvents({});

    expect(result.failures[0]).toMatchObject({
      source: 'seatgeek',
      message: 'Rejected the API key',
      isAuthError: true,
    });
  });

  it('reports a server error as retryable rather than an auth problem', async () => {
    mocked(seatgeek).search.mockRejectedValue(
      new HttpError(503, 'https://api.seatgeek.com/2/events', 'unavailable'),
    );

    const result = await searchEvents({});

    expect(result.failures[0]).toMatchObject({ message: 'Returned 503', isAuthError: false });
  });

  it('translates an aborted fetch into a timeout', async () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    mocked(serpapi).search.mockRejectedValue(aborted);

    const result = await searchEvents({});

    expect(result.failures[0]).toMatchObject({ source: 'serpapi', message: 'Timed out' });
  });

  it('survives a provider rejecting with something that is not an Error', async () => {
    mocked(serpapi).search.mockRejectedValue('just a string');

    const result = await searchEvents({});

    expect(result.failures[0]).toMatchObject({ source: 'serpapi', message: 'Unknown error' });
  });
});

describe('searchEvents failure diagnosability', () => {
  const NAMES = ['Hatsune Miku', 'DECO*27', 'Luo Tianyi', 'Ado'];

  it('names the queries that failed, not just the count', async () => {
    // The bug this exists for: "3 of 25 queries failed" is undiagnosable, so
    // the cause gets guessed at instead of read off.
    mocked(ticketmaster).search.mockImplementation(async ({ keyword }) => {
      if (keyword === 'DECO*27' || keyword === 'Ado') throw new Error('boom');
      return [];
    });

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const failure = result.failures.find((f) => f.source === 'ticketmaster');
    expect(failure?.failedQueries).toBe(2);
    expect(failure?.sampleQueries).toEqual(['DECO*27', 'Ado']);
  });

  it('caps the sample so a fully-dead source does not list every query', async () => {
    mocked(seatgeek).search.mockRejectedValue(new Error('down'));

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    const failure = result.failures.find((f) => f.source === 'seatgeek');
    expect(failure?.failedQueries).toBe(5);
    expect(failure?.sampleQueries).toHaveLength(3);
  });
});

describe('searchEvents unconfigured sources', () => {
  const NAMES = ['Hatsune Miku', 'Ado'];

  /** What the Worker sends when a source's secret is missing. */
  const notConfigured = () =>
    new HttpError(
      503,
      'https://proxy.test/seatgeek/events',
      JSON.stringify({ error: 'Worker is missing SEATGEEK_CLIENT_ID', code: 'not_configured' }),
    );

  it('reports a source with no secret as skipped, not failed', async () => {
    mocked(seatgeek).search.mockRejectedValue(notConfigured());

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    // The pre-migration behaviour: unconfigured reads as unconfigured.
    expect(result.skipped.map((s) => s.source)).toContain('seatgeek');
    expect(result.failures.map((f) => f.source)).not.toContain('seatgeek');
  });

  it('keeps the label so the notice line still names it', async () => {
    mocked(serpapi).search.mockRejectedValue(notConfigured());

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    expect(result.skipped).toContainEqual({ source: 'serpapi', label: 'Google Events' });
  });

  it('still returns the sources that are configured', async () => {
    mocked(seatgeek).search.mockRejectedValue(notConfigured());
    mocked(serpapi).search.mockRejectedValue(notConfigured());
    mocked(ticketmaster).search.mockResolvedValue([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
    ]);

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    expect(result.events).toHaveLength(1);
    expect(result.skipped.map((s) => s.source).sort()).toEqual(['seatgeek', 'serpapi']);
    expect(result.failures).toEqual([]);
  });

  it('does not confuse a genuine upstream failure with an unconfigured source', async () => {
    mocked(seatgeek).search.mockRejectedValue(
      new HttpError(502, 'https://proxy.test/seatgeek/events', JSON.stringify({ status: 503 })),
    );

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    expect(result.failures.map((f) => f.source)).toContain('seatgeek');
    expect(result.skipped.map((s) => s.source)).not.toContain('seatgeek');
  });

  it('treats a partial not-configured count as a failure, not a skip', async () => {
    // Only explicable by a redeploy mid-search. Reporting it as "skipped" would
    // hide that most of the source's queries did run.
    let call = 0;
    mocked(seatgeek).search.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw notConfigured();
      return [];
    });

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    expect(result.skipped.map((s) => s.source)).not.toContain('seatgeek');
    const failure = result.failures.find((f) => f.source === 'seatgeek');
    expect(failure?.message).toBe('Not configured');
    expect(failure?.failedQueries).toBe(1);
  });

  it('ignores a body that merely looks like the code', async () => {
    mocked(seatgeek).search.mockRejectedValue(
      new HttpError(502, 'https://proxy.test/seatgeek/events', 'not_configured'),
    );

    const result = await searchEvents({ keyword: 'vocaloid', names: NAMES });

    // A bare string is not the structured signal — treating it as one would let
    // an upstream error page masquerade as a configuration state.
    expect(result.skipped.map((s) => s.source)).not.toContain('seatgeek');
    expect(result.failures.map((f) => f.source)).toContain('seatgeek');
  });
});
