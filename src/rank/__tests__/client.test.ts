import { ClassifyUnavailable, classifyBatch } from '../client';
import type { Event } from '@/sources/types';
import type { ExpansionProfile } from '@/profile/types';

jest.mock('@/lib/config', () => ({
  config: { eventsProxyUrl: 'https://proxy.test', defaultCity: 'New York' },
  hasProxy: () => true,
}));

const PROFILE: ExpansionProfile = {
  scene: 'Virtual-singer music.',
  core: ['vocaloid'],
  adjacent: [{ name: 'Hatsune Miku', kind: 'artist', why: 'headlines' }],
};

const EVENT: Event = {
  id: 'ticketmaster:1',
  sourceId: '1',
  source: 'ticketmaster',
  title: 'Miku Expo 2026',
  startsAt: '2026-09-01T23:00:00.000Z',
  venue: { name: 'Radio City', city: 'New York' },
  url: 'https://example.com',
  imageUrl: 'https://img/x.jpg',
};

/** fetchJson only touches `.ok`, `.json()` and `.text()`. */
function stubFetch(payload: unknown, ok = true, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
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

describe('classifyBatch request', () => {
  it('posts to the Worker classify route', async () => {
    const calls = stubFetch([]);

    await classifyBatch(PROFILE, [EVENT]);

    expect(calls[0].url).toBe('https://proxy.test/classify');
    expect(calls[0].init.method).toBe('POST');
  });

  it('sends only the fields the Worker reads', async () => {
    const calls = stubFetch([]);

    await classifyBatch(PROFILE, [EVENT]);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.events).toEqual([
      { id: 'ticketmaster:1', title: 'Miku Expo 2026', venue: 'Radio City' },
    ]);
    // Sending the whole Event would ship an image URL and a price into a prompt.
    expect(body.events[0].imageUrl).toBeUndefined();
    expect(body.profile).toEqual(PROFILE);
  });

  it('makes no request for an empty batch', async () => {
    const calls = stubFetch([]);

    await expect(classifyBatch(PROFILE, [])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('classifyBatch defensive parsing', () => {
  it('rejects a response that is not an array', async () => {
    stubFetch({ error: 'nope' });

    await expect(classifyBatch(PROFILE, [EVENT])).rejects.toBeInstanceOf(ClassifyUnavailable);
  });

  it('drops an entry whose band is not recognised', async () => {
    stubFetch([
      { id: 'ticketmaster:1', band: 'MAYBE', reason: 'invented tier' },
      { id: 'ticketmaster:2', band: 'STRONG', reason: 'fine' },
    ]);

    const verdicts = await classifyBatch(PROFILE, [EVENT]);

    // Dropped rather than coerced: the caller then applies the same fallback it
    // would for a missing verdict, instead of a band the model never chose.
    expect(verdicts.map((v) => v.id)).toEqual(['ticketmaster:2']);
  });

  it('drops entries with no usable id', async () => {
    stubFetch([
      { band: 'STRONG', reason: 'no id' },
      { id: 42, band: 'STRONG', reason: 'numeric id' },
      { id: 'ticketmaster:1', band: 'WEAK', reason: 'ok' },
    ]);

    const verdicts = await classifyBatch(PROFILE, [EVENT]);

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].id).toBe('ticketmaster:1');
  });

  it('survives non-object rows', async () => {
    stubFetch(['nope', null, 7, { id: 'ticketmaster:1', band: 'STRONG', reason: 'ok' }]);

    await expect(classifyBatch(PROFILE, [EVENT])).resolves.toHaveLength(1);
  });

  it('tolerates a missing reason', async () => {
    stubFetch([{ id: 'ticketmaster:1', band: 'STRONG' }]);

    const [verdict] = await classifyBatch(PROFILE, [EVENT]);

    expect(verdict.band).toBe('STRONG');
    expect(verdict.reason).toBe('');
  });

  it('propagates an HTTP failure for the caller to aggregate', async () => {
    stubFetch({ error: 'boom' }, false, 502);

    await expect(classifyBatch(PROFILE, [EVENT])).rejects.toThrow();
  });
});
