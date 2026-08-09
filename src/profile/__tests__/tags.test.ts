import { addTag, isSameTag, MAX_TAG_LENGTH, normalizeTag, normalizeTags, removeTag } from '../tags';

describe('normalizeTag', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeTag('  phoebe bridgers  ')).toBe('phoebe bridgers');
  });

  it('collapses internal runs of whitespace', () => {
    expect(normalizeTag('phoebe   bridgers')).toBe('phoebe bridgers');
    expect(normalizeTag('the\t\tmountain\ngoats')).toBe('the mountain goats');
  });

  it('preserves the case the user typed', () => {
    // Casing only matters for comparison, never for storage — "Hip-Hop" is
    // what belongs on the chip.
    expect(normalizeTag('Hip-Hop')).toBe('Hip-Hop');
  });

  it('rejects anything with no content', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('\n\t')).toBeNull();
  });

  it('caps a pasted wall of text without leaving a trailing space', () => {
    const long = `${'a'.repeat(MAX_TAG_LENGTH - 1)} tail`;
    const result = normalizeTag(long);

    expect(result).toHaveLength(MAX_TAG_LENGTH - 1);
    expect(result).not.toMatch(/\s$/);
  });
});

describe('isSameTag', () => {
  it('ignores case', () => {
    expect(isSameTag('Radiohead', 'radiohead')).toBe(true);
    expect(isSameTag('RADIOHEAD', 'radiohead')).toBe(true);
  });

  it('does not treat different tags as equal', () => {
    expect(isSameTag('Radiohead', 'Thom Yorke')).toBe(false);
  });
});

describe('addTag', () => {
  it('appends a normalized tag', () => {
    expect(addTag([], '  Phoebe   Bridgers ')).toEqual(['Phoebe Bridgers']);
  });

  it('keeps insertion order', () => {
    const tags = addTag(addTag(['Radiohead'], 'Big Thief'), 'Wednesday');
    expect(tags).toEqual(['Radiohead', 'Big Thief', 'Wednesday']);
  });

  it('dedupes case-insensitively, keeping the form entered first', () => {
    expect(addTag(['Radiohead'], 'radiohead')).toEqual(['Radiohead']);
    expect(addTag(['Radiohead'], 'RADIOHEAD')).toEqual(['Radiohead']);
  });

  it('dedupes across whitespace differences too', () => {
    expect(addTag(['big thief'], '  BIG   THIEF ')).toEqual(['big thief']);
  });

  it('ignores an empty submit', () => {
    expect(addTag(['Radiohead'], '   ')).toEqual(['Radiohead']);
  });

  it('returns the original array reference when nothing changed', () => {
    // This identity is what the mutation hook checks to skip a pointless
    // write, so it's behaviour and not an implementation detail.
    const tags = ['Radiohead'];

    expect(addTag(tags, 'radiohead')).toBe(tags);
    expect(addTag(tags, '  ')).toBe(tags);
    expect(addTag(tags, 'Big Thief')).not.toBe(tags);
  });
});

describe('removeTag', () => {
  it('removes regardless of case', () => {
    expect(removeTag(['Radiohead', 'Big Thief'], 'RADIOHEAD')).toEqual(['Big Thief']);
  });

  it('leaves the list alone when the tag is absent', () => {
    expect(removeTag(['Radiohead'], 'Wednesday')).toEqual(['Radiohead']);
  });
});

describe('normalizeTags', () => {
  it('cleans and dedupes a whole list read back from storage', () => {
    expect(normalizeTags([' Radiohead ', 'radiohead', 'Big   Thief', '', '   '])).toEqual([
      'Radiohead',
      'Big Thief',
    ]);
  });

  it('is idempotent', () => {
    const once = normalizeTags([' Radiohead ', 'RADIOHEAD', 'Big  Thief']);
    expect(normalizeTags(once)).toEqual(once);
  });
});
