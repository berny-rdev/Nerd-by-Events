/**
 * Phase 2 contract: the adapters talk to the Worker, and the Worker's envelope
 * is still what `toEvent` expects.
 *
 * This is the seam that broke the app when the keys moved — both sources
 * reported as unconfigured and there were zero working sources. These tests pin
 * both halves of it: the URL the adapter builds, and the parsing of the payload
 * that comes back.
 *
 * The Ticketmaster payload below is trimmed from a real response through a
 * locally running Worker, so the field shapes are not guesses.
 */

import { seatgeek } from '../seatgeek';
import { ticketmaster } from '../ticketmaster';

jest.mock('@/lib/config', () => ({
  config: { eventsProxyUrl: 'https://proxy.test', defaultCity: 'New York' },
  hasProxy: () => true,
}));

const TICKETMASTER_PAYLOAD = {
  _embedded: {
    events: [
      {
        id: 'vvG10Z_G6dw5z0',
        name: 'Lil Rob & Friends',
        url: 'https://www.ticketmaster.com/event/vvG10Z_G6dw5z0',
        images: [
          { url: 'https://img/small.jpg', width: 100, height: 56, ratio: '16_9' },
          { url: 'https://img/large.jpg', width: 1024, height: 576, ratio: '16_9' },
        ],
        dates: { start: { dateTime: '2026-07-11T04:00:00Z', localDate: '2026-07-10' } },
        _embedded: {
          venues: [
            {
              name: 'The Regent Theater',
              city: { name: 'Los Angeles' },
              location: { latitude: '34.0447', longitude: '-118.2482' },
            },
          ],
        },
      },
    ],
  },
};

const SEATGEEK_PAYLOAD = {
  events: [
    {
      id: 6242891,
      title: 'New York Knicks at Boston Celtics',
      short_title: 'Knicks at Celtics',
      url: 'https://seatgeek.com/knicks-at-celtics',
      datetime_utc: '2026-09-01T23:00:00',
      datetime_local: '2026-09-01T19:00:00',
      venue: { name: 'TD Garden', city: 'Boston', location: { lat: 42.36, lon: -71.06 } },
      performers: [{ images: { huge: 'https://img/huge.jpg' } }],
      stats: { lowest_price: 45, highest_price: 320 },
    },
  ],
};

/** fetchJson only touches `.ok`, `.json()` and `.text()`. */
function stubFetch(payload: unknown) {
  const calls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  return calls;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('ticketmaster adapter via the Worker', () => {
  it('calls the proxy route, not Ticketmaster directly', async () => {
    const calls = stubFetch(TICKETMASTER_PAYLOAD);

    await ticketmaster.search({ keyword: 'miku', city: 'Los Angeles', limit: 5 });

    expect(calls[0]).toMatch(/^https:\/\/proxy\.test\/ticketmaster\/events\?/);
    expect(calls[0]).not.toMatch(/ticketmaster\.com/);
  });

  it('sends only the allowlisted params and no credential', async () => {
    const calls = stubFetch(TICKETMASTER_PAYLOAD);

    await ticketmaster.search({ keyword: 'miku', city: 'Los Angeles', limit: 5 });

    const params = new URL(calls[0]).searchParams;
    expect([...params.keys()].sort()).toEqual(['city', 'keyword', 'limit']);
    // The Consumer Key lives on the Worker now — the app must never send one.
    expect(params.get('apikey')).toBeNull();
  });

  it('still parses the Worker envelope into an Event', async () => {
    stubFetch(TICKETMASTER_PAYLOAD);

    const [event] = await ticketmaster.search({ keyword: 'miku' });

    expect(event.id).toBe('ticketmaster:vvG10Z_G6dw5z0');
    expect(event.title).toBe('Lil Rob & Friends');
    expect(event.startsAt).toBe('2026-07-11T04:00:00Z');
    expect(event.venue).toEqual({
      name: 'The Regent Theater',
      city: 'Los Angeles',
      lat: 34.0447,
      lon: -118.2482,
    });
    expect(event.imageUrl).toBe('https://img/large.jpg');
    expect(event.source).toBe('ticketmaster');
  });

  it('treats the Worker\'s empty envelope as no results', async () => {
    // The Worker returns `{}` rather than an empty array when Ticketmaster
    // reports nothing, preserving the upstream convention the adapter handles.
    stubFetch({});

    await expect(ticketmaster.search({ keyword: 'nothing' })).resolves.toEqual([]);
  });
});

describe('seatgeek adapter via the Worker', () => {
  it('calls the proxy route, not SeatGeek directly', async () => {
    const calls = stubFetch(SEATGEEK_PAYLOAD);

    await seatgeek.search({ keyword: 'knicks', city: 'Boston', limit: 5 });

    expect(calls[0]).toMatch(/^https:\/\/proxy\.test\/seatgeek\/events\?/);
    expect(calls[0]).not.toMatch(/api\.seatgeek\.com/);
  });

  it('sends only the allowlisted params, and no longer the date floor', async () => {
    const calls = stubFetch(SEATGEEK_PAYLOAD);

    await seatgeek.search({ keyword: 'knicks', city: 'Boston', limit: 5 });

    const params = new URL(calls[0]).searchParams;
    // The Worker owns `datetime_utc.gte` now — sending it from here would also
    // have made every request a unique cache key.
    expect([...params.keys()].sort()).toEqual(['city', 'keyword', 'limit']);
    expect(params.get('client_id')).toBeNull();
  });

  it('still parses the Worker envelope into an Event', async () => {
    stubFetch(SEATGEEK_PAYLOAD);

    const [event] = await seatgeek.search({ keyword: 'knicks' });

    expect(event.id).toBe('seatgeek:6242891');
    expect(event.title).toBe('Knicks at Celtics');
    // datetime_utc arrives without a Z; the adapter appends one.
    expect(event.startsAt).toBe('2026-09-01T23:00:00.000Z');
    expect(event.venue.city).toBe('Boston');
    expect(event.price).toEqual({ min: 45, max: 320, currency: 'USD' });
  });

  it('handles an empty result set', async () => {
    stubFetch({ events: [] });

    await expect(seatgeek.search({ keyword: 'nothing' })).resolves.toEqual([]);
  });
});

describe('source configuration', () => {
  it('every source is configured by the proxy URL alone', () => {
    // Previously each source needed its own EXPO_PUBLIC_* key. Now one URL
    // turns all of them on, which is why an unset URL means zero sources.
    expect(ticketmaster.isConfigured()).toBe(true);
    expect(seatgeek.isConfigured()).toBe(true);
  });
});
