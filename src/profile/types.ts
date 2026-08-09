/**
 * The user's fandom taste profile.
 *
 * Only `tags` is user-entered. `scene` and `adjacent` are outputs of an
 * expansion step that doesn't exist yet — something that takes "phoebe
 * bridgers, big thief" and infers a scene plus a few adjacent acts worth
 * surfacing. Until that exists they are always the empty forms below, and
 * every consumer has to handle that: `scene` is nullable and `adjacent` is an
 * array that is currently always empty.
 *
 * They're modelled as *present but empty* rather than optional keys so the
 * stored shape doesn't change when expansion lands — only the values do.
 */

/** One act/scene the expansion step decided is near the user's tags. */
export type AdjacentInterest = {
  name: string;
  /** Human-readable justification, shown to the user. Never a raw score. */
  why: string;
};

export type TasteProfile = {
  /** Normalized on entry — see `./tags`. Order is the order they were added. */
  tags: string[];
  /** Broad scene label, e.g. "indie folk". Null until expansion runs. */
  scene: string | null;
  /** Empty until expansion runs. */
  adjacent: AdjacentInterest[];
  /** Epoch millis of the last write. 0 means "never saved". */
  updatedAt: number;
};

/**
 * A fresh profile. Also the fallback for every unreadable-storage case, so it
 * has to be safe to render and safe to save over.
 */
export function emptyProfile(): TasteProfile {
  return { tags: [], scene: null, adjacent: [], updatedAt: 0 };
}

/** True once the expansion step has actually produced something. */
export function hasExpansion(profile: TasteProfile): boolean {
  return profile.scene !== null || profile.adjacent.length > 0;
}
