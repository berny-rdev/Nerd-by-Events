import { dedupeEvents, normalizeTitle } from '../dedupe';
import type { Event, SourceId } from '../types';

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
    const result = dedupeEvents([
      makeEvent({ source: 'ticketmaster', title: 'Radiohead', startsAt: '2026-09-01T23:00:00.000Z' }),
      makeEvent({ source: 'ticketmaster', title: 'Radiohead', startsAt: '2026-09-02T23:00:00.000Z' }),
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

  it('sorts by start time and pushes undated events to the end', () => {
    const result = dedupeEvents([
      makeEvent({ source: 'serpapi', title: 'Undated Show', startsAt: null }),
      makeEvent({ source: 'ticketmaster', title: 'Later', startsAt: '2026-09-05T23:00:00.000Z' }),
      makeEvent({ source: 'ticketmaster', title: 'Sooner', startsAt: '2026-09-01T23:00:00.000Z' }),
    ]);

    expect(result.map((event) => event.title)).toEqual(['Sooner', 'Later', 'Undated Show']);
  });
});
