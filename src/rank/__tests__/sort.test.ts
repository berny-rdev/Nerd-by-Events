import { BREAK_AFTER, buildRows, sortRanked } from '../sort';
import type { Band, RankedEvent } from '../types';

let nextId = 0;
function ranked(band: Band, startsAt: string | null, title = `Event ${band}`): RankedEvent {
  nextId += 1;
  return {
    id: `ticketmaster:${nextId}`,
    sourceId: String(nextId),
    source: 'ticketmaster',
    title,
    startsAt,
    venue: { name: 'Venue', city: 'New York' },
    url: 'https://example.com',
    band,
    reason: 'because',
    isRanked: true,
  };
}

beforeEach(() => {
  nextId = 0;
});

describe('sortRanked', () => {
  it('orders by band first', () => {
    const events = [
      ranked('UNRELATED', '2026-01-01T00:00:00.000Z'),
      ranked('POSSIBLE', '2026-01-01T00:00:00.000Z'),
      ranked('WEAK', '2026-01-01T00:00:00.000Z'),
      ranked('STRONG', '2026-01-01T00:00:00.000Z'),
    ];

    expect(sortRanked(events).map((e) => e.band)).toEqual([
      'STRONG',
      'POSSIBLE',
      'WEAK',
      'UNRELATED',
    ]);
  });

  it('orders by date within a band, soonest first', () => {
    const late = ranked('STRONG', '2026-12-01T00:00:00.000Z', 'Late');
    const soon = ranked('STRONG', '2026-02-01T00:00:00.000Z', 'Soon');

    expect(sortRanked([late, soon]).map((e) => e.title)).toEqual(['Soon', 'Late']);
  });

  it('never lets date beat band', () => {
    // A weak match tomorrow still sits below a strong match next year.
    const weakTomorrow = ranked('WEAK', '2026-01-02T00:00:00.000Z', 'Weak tomorrow');
    const strongLater = ranked('STRONG', '2027-01-01T00:00:00.000Z', 'Strong later');

    expect(sortRanked([weakTomorrow, strongLater]).map((e) => e.title)).toEqual([
      'Strong later',
      'Weak tomorrow',
    ]);
  });

  it('pushes undated events to the bottom of their own band', () => {
    const undated = ranked('STRONG', null, 'Undated');
    const dated = ranked('STRONG', '2026-05-01T00:00:00.000Z', 'Dated');
    const weak = ranked('WEAK', '2026-01-01T00:00:00.000Z', 'Weak');

    expect(sortRanked([undated, weak, dated]).map((e) => e.title)).toEqual([
      'Dated',
      'Undated',
      'Weak',
    ]);
  });

  it('does not mutate the input', () => {
    const events = [ranked('WEAK', null), ranked('STRONG', null)];
    const before = events.map((e) => e.id);

    sortRanked(events);

    expect(events.map((e) => e.id)).toEqual(before);
  });
});

describe('buildRows', () => {
  const eventRows = (rows: ReturnType<typeof buildRows>) =>
    rows.filter((r) => r.type === 'event');

  it('puts the break below POSSIBLE, never above it', () => {
    const rows = buildRows(
      [ranked('STRONG', null), ranked('POSSIBLE', null), ranked('WEAK', null)],
      true,
    );

    const dividerAt = rows.findIndex((r) => r.type === 'divider');
    const bandsBefore = rows
      .slice(0, dividerAt)
      .flatMap((r) => (r.type === 'event' ? [r.event.band] : []));

    // POSSIBLE is the tier worth scanning for surprises — burying it under a
    // "less relevant" heading is the failure this guards against.
    expect(bandsBefore).toEqual(['STRONG', 'POSSIBLE']);
    expect(BREAK_AFTER).toBe('POSSIBLE');
  });

  it('counts what sits below the break', () => {
    const rows = buildRows(
      [ranked('STRONG', null), ranked('WEAK', null), ranked('UNRELATED', null)],
      true,
    );

    const divider = rows.find((r) => r.type === 'divider');
    expect(divider).toEqual({ type: 'divider', below: 2 });
  });

  it('keeps everything below the break in the list', () => {
    const events = [
      ranked('STRONG', null),
      ranked('WEAK', null),
      ranked('UNRELATED', null),
      ranked('UNRELATED', null),
    ];

    const rows = buildRows(events, true);

    // A signpost, not a cut.
    expect(eventRows(rows)).toHaveLength(4);
  });

  it('omits the break when everything is above it', () => {
    const rows = buildRows([ranked('STRONG', null), ranked('POSSIBLE', null)], true);

    expect(rows.some((r) => r.type === 'divider')).toBe(false);
  });

  it('omits the break when everything is below it', () => {
    // A divider as the very first row would mark a fall-off that never happened.
    const rows = buildRows([ranked('WEAK', null), ranked('UNRELATED', null)], true);

    expect(rows.some((r) => r.type === 'divider')).toBe(false);
  });

  it('leaves source order alone and adds no break when unranked', () => {
    const events = [ranked('UNRELATED', null, 'First'), ranked('UNRELATED', null, 'Second')];

    const rows = buildRows(events, false);

    expect(rows.some((r) => r.type === 'divider')).toBe(false);
    expect(eventRows(rows).map((r) => r.event.title)).toEqual(['First', 'Second']);
  });

  it('handles an empty list', () => {
    expect(buildRows([], true)).toEqual([]);
  });
});
