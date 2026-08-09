/**
 * The single shape every provider gets normalized into.
 *
 * This file is the contract. Ticketmaster, SeatGeek and Google (via SerpAPI)
 * all return wildly different JSON; nothing outside `src/sources/` should ever
 * see a provider-specific field.
 */

export type SourceId = 'ticketmaster' | 'seatgeek' | 'serpapi';

/** Source precedence when merging duplicates — earlier wins ties. */
export const SOURCE_PRIORITY: SourceId[] = ['ticketmaster', 'seatgeek', 'serpapi'];

export type Money = {
  min: number;
  max: number;
  /** ISO 4217, e.g. 'USD'. */
  currency: string;
};

export type Venue = {
  name: string;
  city: string;
  lat?: number;
  lon?: number;
};

export type Event = {
  /** Globally unique: `${source}:${sourceId}`. Safe as a FlatList key. */
  id: string;
  /** The provider's own id, kept so we can refetch or debug. */
  sourceId: string;
  source: SourceId;

  title: string;

  /**
   * ISO 8601 UTC, or null when the provider only gave us something fuzzy.
   *
   * Google's event panel frequently returns "Fri, Aug 8, 7 – 10 PM" with no
   * year and no timezone. Rather than invent a timestamp we can't defend, we
   * keep null and show `startsAtLabel` instead. Anything that needs a real
   * instant (sorting, notification scheduling) has to handle the null.
   */
  startsAt: string | null;
  /** Human-readable fallback, only set when `startsAt` is null. */
  startsAtLabel?: string;

  venue: Venue;
  imageUrl?: string;
  price?: Money;
  /** Where to actually buy/see the event. */
  url: string;

  /** Set by the deduper when the same event came back from several providers. */
  mergedFrom?: SourceId[];
};

export type SearchQuery = {
  keyword?: string;
  city?: string;
  /** Per-source cap. The aggregate result is deduped, so expect fewer. */
  limit?: number;
  signal?: AbortSignal;
};

/**
 * Every provider implements this and nothing else. Adding a fourth source
 * means writing one file and appending it to the registry in `./index.ts`.
 */
export interface EventSource {
  id: SourceId;
  label: string;
  /** False when its key/proxy URL is missing — the aggregator skips it. */
  isConfigured(): boolean;
  search(query: SearchQuery): Promise<Event[]>;
}
