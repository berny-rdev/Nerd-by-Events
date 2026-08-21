import { dedupeEvents, dedupeExactIds, normalizeTitle } from '../dedupe';
import type { Event, SourceId } from '../types';

/**
 * Ids must not be derived from the title.
 *
 * They used to be (`${source}:${title}`), which made two records with the same
 * title share an id. That is not how upstream data behaves — two nights of one
 * tour are two distinct Ticketmaster ids — and once `dedupeExactIds` landed it
 * meant a fixture could collapse for a reason the test wasn't claiming. A
 * counter keeps identity independent of every other field, so a test that wants
 * two records to share an id has to say so explicitly.
 */
let nextId = 0;
beforeEach(() => {
  nextId = 0;
});

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

describe('dedupeExactIds', () => {
  it('keeps the first occurrence of each id and preserves order', () => {
    const a = makeEvent({ source: 'ticketmaster', title: 'A', id: 'ticketmaster:a' });
    const b = makeEvent({ source: 'seatgeek', title: 'B', id: 'seatgeek:b' });

    expect(dedupeExactIds([a, b, { ...a }, { ...b }])).toEqual([a, b]);
  });

  it('never merges ids that differ', () => {
    // Ids are namespaced by source, so the same upstream id from two providers
    // is two records and must stay two.
    const tm = makeEvent({ source: 'ticketmaster', title: 'A', id: 'ticketmaster:123' });
    const sg = makeEvent({ source: 'seatgeek', title: 'A', id: 'seatgeek:123' });

    expect(dedupeExactIds([tm, sg])).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(dedupeExactIds([])).toEqual([]);
  });
});

describe('normalizeTitle', () => {
  it('ignores word order so matchups match either way round', () => {
    expect(normalizeTitle('New York Knicks vs. Boston Celtics')).toBe(
      normalizeTitle('Boston Celtics at New York Knicks'),
    );
  });

  it('strips parentheticals and punctuation', () => {
    expect(normalizeTitle('Radiohead (Rescheduled)')).toBe(normalizeTitle('Radiohead!'));
  });

  it('keeps genuinely different acts apart', () => {
    expect(normalizeTitle('Radiohead')).not.toBe(normalizeTitle('Thom Yorke'));
  });
});

describe('dedupeEvents', () => {
  it('merges the same show from two providers', () => {
    const result = dedupeEvents([
      makeEvent({ source: 'ticketmaster', title: 'Knicks vs. Celtics' }),
      makeEvent({ source: 'seatgeek', title: 'Celtics at Knicks', imageUrl: 'https://img' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('ticketmaster'); // higher priority wins the base
    expect(result[0].mergedFrom).toEqual(['ticketmaster', 'seatgeek']);
  });

  it('backfills fields the winning source was missing', () => {
    const result = dedupeEvents([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
      makeEvent({
        source: 'seatgeek',
        title: 'Radiohead',
        imageUrl: 'https://img',
        price: { min: 50, max: 200, currency: 'USD' },
      }),
    ]);

    expect(result[0].imageUrl).toBe('https://img');
    expect(result[0].price?.min).toBe(50);
  });

  it('tolerates providers disagreeing on the start time by an hour', () => {
    const result = dedupeEvents([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead', startsAt: '2026-09-01T23:00:00.000Z' }),
      makeEvent({ source: 'seatgeek', title: 'Radiohead', startsAt: '2026-09-02T00:00:00.000Z' }),
    ]);

    expect(result).toHaveLength(1);
  });

  it('keeps a two-night run as two events', () => {
    // Distinct ids matter here: two nights of the same tour are two records
    // upstream, and the fixture has to reflect that or the exact-id pass would
    // collapse them for the wrong reason.
    const result = dedupeEvents([
      makeEvent({
        source: 'ticketmaster',
        title: 'Radiohead',
        id: 'ticketmaster:night-1',
        startsAt: '2026-09-01T23:00:00.000Z',
      }),
      makeEvent({
        source: 'ticketmaster',
        title: 'Radiohead',
        id: 'ticketmaster:night-2',
        startsAt: '2026-09-02T23:00:00.000Z',
      }),
    ]);

    expect(result).toHaveLength(2);
  });

  it('does not merge same-name events in different cities', () => {
    const result = dedupeEvents([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
      makeEvent({
        source: 'seatgeek',
        title: 'Radiohead',
        venue: { name: 'The Forum', city: 'Los Angeles' },
      }),
    ]);

    expect(result).toHaveLength(2);
  });

  it('refuses to merge when a source gave no start time', () => {
    // Google listings often have no parseable time; without one we can't tell
    // a duplicate from a second night, so we leave both.
    const result = dedupeEvents([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead' }),
      makeEvent({ source: 'serpapi', title: 'Radiohead', startsAt: null }),
    ]);

    expect(result).toHaveLength(2);
  });

  it('collapses the same event returned by two different queries', () => {
    // The fan-out case: searching "Hatsune Miku" and "Hatsune Miku Expo" both
    // return this one Ticketmaster record. Same source, same id, two queries.
    const fromFirstQuery = makeEvent({
      source: 'ticketmaster',
      title: 'Hatsune Miku Expo 2026',
      id: 'ticketmaster:G5vYZ9',
    });
    const fromSecondQuery = { ...fromFirstQuery };

    const result = dedupeEvents([fromFirstQuery, fromSecondQuery]);

    expect(result).toHaveLength(1);
  });

  it('collapses a same-source duplicate even when the payloads differ slightly', () => {
    // Two queries can return the same record with different optional fields
    // populated. Identity is the id, not the payload.
    const base = makeEvent({
      source: 'ticketmaster',
      title: 'Hatsune Miku Expo 2026',
      id: 'ticketmaster:G5vYZ9',
    });

    const result = dedupeEvents([
      base,
      { ...base, imageUrl: 'https://img/other.jpg', price: { min: 50, max: 90, currency: 'USD' } },
    ]);

    expect(result).toHaveLength(1);
    // First occurrence wins outright — no field-level merging between records
    // that are the same record.
    expect(result[0].imageUrl).toBeUndefined();
  });

  it('does not label a same-source collapse as a cross-source merge', () => {
    const base = makeEvent({ source: 'ticketmaster', title: 'Radiohead', id: 'ticketmaster:x' });

    const [merged] = dedupeEvents([base, { ...base }]);

    // mergedFrom drives the source badges. One source contributing twice is
    // not a merge worth showing.
    expect(merged.mergedFrom).toBeUndefined();
  });

  it('still merges across sources after collapsing within one', () => {
    const tmOnce = makeEvent({
      source: 'ticketmaster',
      title: 'Knicks vs. Celtics',
      id: 'ticketmaster:game-1',
    });

    const result = dedupeEvents([
      tmOnce,
      { ...tmOnce }, // same TM record, second query
      makeEvent({ source: 'seatgeek', title: 'Celtics at Knicks', id: 'seatgeek:game-1' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].mergedFrom).toEqual(['ticketmaster', 'seatgeek']);
  });

  it('keeps genuinely different events that share an id prefix', () => {
    const result = dedupeEvents([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead', id: 'ticketmaster:1' }),
      makeEvent({
        source: 'ticketmaster',
        title: 'Phoebe Bridgers',
        id: 'ticketmaster:2',
        startsAt: '2026-09-05T23:00:00.000Z',
      }),
    ]);

    expect(result).toHaveLength(2);
  });

  it('sorts by start time and pushes undated events to the end', () => {
    const result = dedupeEvents([
      makeEvent({ source: 'serpapi', title: 'Undated Show', startsAt: null }),
      makeEvent({ source: 'ticketmaster', title: 'Later', startsAt: '2026-09-05T23:00:00.000Z' }),
      makeEvent({ source: 'ticketmaster', title: 'Sooner', startsAt: '2026-09-01T23:00:00.000Z' }),
    ]);

    expect(result.map((event) => event.title)).toEqual(['Sooner', 'Later', 'Undated Show']);
  });
});
