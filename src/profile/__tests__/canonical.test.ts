import { canonicalQuery, normalizeQuery } from '../canonical';

/**
 * These cases are duplicated in `proxy/test/worker.test.ts`. That is deliberate:
 * the app keys its local cache on this function and the Worker keys its 30-day
 * cache on its own copy, so the two drifting apart would silently cost a network
 * round trip per search — or store the same query twice.
 */

describe('normalizeQuery', () => {
  it('lowercases and trims', () => {
    expect(normalizeQuery('  Vocaloid  ')).toBe('vocaloid');
  });

  it('collapses repeated whitespace and comma spacing', () => {
    expect(normalizeQuery('vocaloid,vsinger')).toBe('vocaloid, vsinger');
    expect(normalizeQuery('vocaloid ,   vsinger')).toBe('vocaloid, vsinger');
    expect(normalizeQuery('drum   and    bass')).toBe('drum and bass');
  });
});

describe('canonicalQuery', () => {
  it('sorts comma-separated terms so order does not matter', () => {
    expect(canonicalQuery('vocaloid, vsinger, hololive')).toBe(
      canonicalQuery('vocaloid, hololive, vsinger'),
    );
    expect(canonicalQuery('vocaloid, hololive')).toBe('hololive, vocaloid');
  });

  it('absorbs case and spacing differences too', () => {
    expect(canonicalQuery('Vocaloid,  VSinger,   Hololive ')).toBe(
      canonicalQuery('vocaloid, vsinger, hololive'),
    );
  });

  it('deduplicates repeated terms', () => {
    expect(canonicalQuery('vocaloid, vocaloid, hololive')).toBe('hololive, vocaloid');
  });

  it('leaves a comma-less query in the order it was typed', () => {
    // Sorting words would turn this into "and bass drum".
    expect(canonicalQuery('drum and bass')).toBe('drum and bass');
  });

  it('drops empty terms from trailing or doubled commas', () => {
    expect(canonicalQuery('vocaloid, , hololive,')).toBe('hololive, vocaloid');
  });

  it('returns an empty string for nothing usable', () => {
    expect(canonicalQuery('')).toBe('');
    expect(canonicalQuery('   ')).toBe('');
    expect(canonicalQuery(' , , ')).toBe('');
  });
});
