/**
 * Taste expansion — the Worker's `POST /expand` output.
 *
 * This module used to hold a *stored* taste profile the user curated by hand.
 * That concept is gone: the search box is the input now, and a profile is
 * derived per query rather than owned by the user. What's left is the shape the
 * Worker returns, plus the canonicalization and cache that keep the app and the
 * Worker agreeing about what counts as "the same query".
 */

export const KINDS = ['artist', 'event', 'agency', 'context'] as const;
export type Kind = (typeof KINDS)[number];

export type AdjacentEntry = {
  name: string;
  /**
   * How the name behaves in a listing. `artist` and `event` names appear in
   * listing titles and are what the next phase will fan out over; `agency` and
   * `context` indicate scene membership and rarely appear in a title, so
   * searching for them would mostly waste a query.
   */
  kind: Kind;
  why: string;
};

export type ExpansionProfile = {
  scene: string;
  /** The user's own terms, normalized by the Worker. */
  core: string[];
  adjacent: AdjacentEntry[];
};

function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

/**
 * Structural check for a profile that arrived over the network or came back out
 * of AsyncStorage.
 *
 * Same stance as the event adapters: a value that crossed a runtime boundary is
 * data, not a type. A malformed cache entry or a Worker mid-deploy shouldn't be
 * able to crash the search screen.
 */
export function isExpansionProfile(value: unknown): value is ExpansionProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.scene !== 'string' || candidate.scene.length === 0) return false;
  if (!Array.isArray(candidate.core)) return false;
  if (!candidate.core.every((entry) => typeof entry === 'string')) return false;
  if (!Array.isArray(candidate.adjacent)) return false;

  return candidate.adjacent.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.name === 'string' && typeof item.why === 'string' && isKind(item.kind);
  });
}

/**
 * The names worth searching for. `agency` and `context` entries are scene
 * signals, not billing strings — the next phase fans out over these only.
 */
export function searchableNames(profile: ExpansionProfile): string[] {
  return profile.adjacent
    .filter((entry) => entry.kind === 'artist' || entry.kind === 'event')
    .map((entry) => entry.name);
}

/** True when there is anything worth showing or searching. */
export function isUsable(profile: ExpansionProfile | undefined): profile is ExpansionProfile {
  return Boolean(profile && searchableNames(profile).length > 0);
}
