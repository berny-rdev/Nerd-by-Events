/**
 * Tag normalization.
 *
 * Users type the same thing five ways — " Phoebe  Bridgers ", "phoebe
 * bridgers", "PHOEBE BRIDGERS". Left alone those become five tags, and every
 * one of them is a separate query against the ranking step later.
 */

/** Longest tag we'll store. Long enough for "the mountain goats", short
 *  enough that a pasted paragraph doesn't become a tag. */
export const MAX_TAG_LENGTH = 40;

/**
 * Trims, collapses internal runs of whitespace, and enforces a length cap.
 *
 * Case is deliberately preserved: "Hip-Hop" reads better on a chip than
 * "hip-hop", and casing is only ignored when *comparing* (see `isSameTag`).
 *
 * Returns null for anything that isn't a usable tag, so callers have one
 * check to make instead of testing for empty strings.
 */
export function normalizeTag(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_TAG_LENGTH).trim();
}

/** Tags are equal when they differ only by case. */
export function isSameTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Appends a tag if it's usable and new.
 *
 * Returns the original array reference when nothing changed — that's what
 * lets React skip a re-render on a duplicate submit rather than replacing
 * state with an identical copy.
 */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw);
  if (tag === null) return tags;
  if (tags.some((existing) => isSameTag(existing, tag))) return tags;
  return [...tags, tag];
}

export function removeTag(tags: string[], target: string): string[] {
  return tags.filter((tag) => !isSameTag(tag, target));
}

/**
 * Normalizes a whole list, dropping unusable entries and later duplicates.
 * Used when reading tags back out of storage, where nothing guarantees the
 * stored array went through `addTag`.
 */
export function normalizeTags(raw: string[]): string[] {
  return raw.reduce<string[]>((tags, entry) => addTag(tags, entry), []);
}
