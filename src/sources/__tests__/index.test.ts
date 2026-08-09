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

function makeEvent(overrides: Partial<Event> & { source: SourceId; title: string }): Event {
  return {
    id: `${overrides.source}:${overrides.title}`,
    sourceId: overrides.title,
    startsAt: '2026-09-01T23:00:00.000Z',
    venue: { name: 'Madison Square Garden', city: 'New York' },
    url: 'https://example.com',
    ...overrides,
  };
}

beforeEach(() => {
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
      expect(mocked(source).search).toHaveBeenCalledWith(query);
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
