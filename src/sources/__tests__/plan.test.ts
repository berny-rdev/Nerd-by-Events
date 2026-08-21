import {
  NAME_QUERY_LIMIT,
  QUERY_BUDGET,
  RAW_QUERY_LIMIT,
  budgetFor,
  buildQueries,
  namesSearched,
} from '../plan';

const NAMES = ['Hatsune Miku', 'Miku Expo', 'Luo Tianyi', 'Ado', 'Soraru'];

describe('buildQueries', () => {
  it('always puts the raw query first', () => {
    const [first] = buildQueries('vocaloid', NAMES, 10);

    expect(first).toEqual({ keyword: 'vocaloid', limit: RAW_QUERY_LIMIT, fromExpansion: false });
  });

  it('keeps the raw query even when it is empty', () => {
    // An empty keyword with a city set is a legitimate "what's on near me"
    // search, and it is what produces results before expansion arrives.
    const queries = buildQueries('', NAMES, 3);

    expect(queries[0].keyword).toBe('');
    expect(queries).toHaveLength(3);
  });

  it('adds expanded names in the order the expansion returned them', () => {
    const queries = buildQueries('vocaloid', NAMES, 4);

    expect(queries.map((q) => q.keyword)).toEqual([
      'vocaloid',
      'Hatsune Miku',
      'Miku Expo',
      'Luo Tianyi',
    ]);
  });

  it('gives expanded names a smaller result cap than the raw query', () => {
    const [raw, name] = buildQueries('vocaloid', NAMES, 4);

    // 25 names at a full page each is 500 records to merge for one search.
    expect(raw.limit).toBe(RAW_QUERY_LIMIT);
    expect(name.limit).toBe(NAME_QUERY_LIMIT);
    expect(NAME_QUERY_LIMIT).toBeLessThan(RAW_QUERY_LIMIT);
  });

  it('never exceeds the budget, counting the raw query', () => {
    expect(buildQueries('vocaloid', NAMES, 3)).toHaveLength(3);
    expect(buildQueries('vocaloid', NAMES, 1)).toHaveLength(1);
  });

  it('returns only the raw query when there are no names', () => {
    expect(buildQueries('vocaloid', [], 25)).toHaveLength(1);
  });

  it('does not repeat the raw query as an expanded name', () => {
    const queries = buildQueries('hatsune miku', ['Hatsune Miku', 'Miku Expo'], 10);

    expect(queries.map((q) => q.keyword)).toEqual(['hatsune miku', 'Miku Expo']);
  });

  it('deduplicates repeated names case-insensitively', () => {
    const queries = buildQueries('vocaloid', ['Ado', 'ADO', 'ado', 'Eve'], 10);

    expect(queries.map((q) => q.keyword)).toEqual(['vocaloid', 'Ado', 'Eve']);
  });

  it('skips blank names', () => {
    const queries = buildQueries('vocaloid', ['', '   ', 'Ado'], 10);

    expect(queries.map((q) => q.keyword)).toEqual(['vocaloid', 'Ado']);
  });
});

describe('budgets', () => {
  it('gives SerpAPI the tightest budget', () => {
    // ~100 searches/month on the free tier. At this budget the whole app gets
    // roughly 33 user searches a month before the quota is gone.
    expect(QUERY_BUDGET.serpapi).toBeLessThan(QUERY_BUDGET.seatgeek);
    expect(QUERY_BUDGET.serpapi).toBeLessThan(QUERY_BUDGET.ticketmaster);
    expect(QUERY_BUDGET.serpapi).toBeLessThanOrEqual(3);
  });

  it('lets Ticketmaster take the full fan-out', () => {
    // 5,000/day — the expansion caps out around 25 names.
    expect(QUERY_BUDGET.ticketmaster).toBeGreaterThanOrEqual(25);
  });

  it('falls back to a single query for an unknown source', () => {
    expect(budgetFor('nope' as never)).toBe(1);
  });
});

describe('namesSearched', () => {
  it('reports every name when the widest budget covers them all', () => {
    expect(namesSearched(5)).toBe(5);
  });

  it('caps at the widest budget minus the raw query slot', () => {
    // 30 searchable names against Ticketmaster's budget of 25: names 25-30
    // reach no source at all, so the UI must not claim they were searched.
    expect(namesSearched(30)).toBe(QUERY_BUDGET.ticketmaster - 1);
    expect(namesSearched(60)).toBe(QUERY_BUDGET.ticketmaster - 1);
  });

  it('handles no names', () => {
    expect(namesSearched(0)).toBe(0);
  });
});
