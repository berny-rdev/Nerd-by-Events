import { parseFuzzyDate, parseTimeOfDay } from '../serpapi';

describe('parseTimeOfDay', () => {
  it('borrows the meridiem from the end of a range', () => {
    expect(parseTimeOfDay('Fri, Aug 8, 7 – 10 PM')).toEqual({ hour: 19, minute: 0 });
  });

  it('does not mistake the day-of-month for the hour', () => {
    // The regression this whole function exists for: a naive number scan reads
    // the "8" in "Aug 8" and schedules every evening show for 8am.
    expect(parseTimeOfDay('Sat, Aug 8, 9 PM')).toEqual({ hour: 21, minute: 0 });
  });

  it('handles explicit minutes', () => {
    expect(parseTimeOfDay('Wed, Sep 3, 7:30 PM')).toEqual({ hour: 19, minute: 30 });
  });

  it('handles a morning range where both ends carry a meridiem', () => {
    expect(parseTimeOfDay('Sun, Aug 10, 10 AM – 5 PM')).toEqual({ hour: 10, minute: 0 });
  });

  it('normalizes midnight and noon', () => {
    expect(parseTimeOfDay('12 AM')).toEqual({ hour: 0, minute: 0 });
    expect(parseTimeOfDay('12 PM')).toEqual({ hour: 12, minute: 0 });
  });

  it('returns null for all-day listings', () => {
    expect(parseTimeOfDay('Sat, Aug 8')).toBeNull();
    expect(parseTimeOfDay('All day')).toBeNull();
  });
});

describe('parseFuzzyDate', () => {
  const now = new Date(2026, 7, 1, 12, 0); // 1 Aug 2026, local time

  it('infers the current year for an upcoming date', () => {
    const iso = parseFuzzyDate({ start_date: 'Aug 8', when: 'Fri, Aug 8, 7 – 10 PM' }, now);
    const parsed = new Date(iso!);

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(8);
    expect(parsed.getHours()).toBe(19);
  });

  it('rolls to next year when the date has clearly passed', () => {
    const iso = parseFuzzyDate({ start_date: 'Jan 5', when: 'Mon, Jan 5, 8 PM' }, now);
    expect(new Date(iso!).getFullYear()).toBe(2027);
  });

  it('returns null rather than guessing when there is no time of day', () => {
    // A null here is what stops us scheduling a reminder for the wrong hour.
    expect(parseFuzzyDate({ start_date: 'Aug 8', when: 'Fri, Aug 8' }, now)).toBeNull();
  });

  it('returns null for an unparseable date', () => {
    expect(parseFuzzyDate({ start_date: 'Next weekend', when: '7 PM' }, now)).toBeNull();
    expect(parseFuzzyDate(undefined, now)).toBeNull();
  });
});
