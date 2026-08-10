/**
 * Runtime configuration.
 *
 * There are no API keys here any more. Every third-party credential the app
 * needs — Ticketmaster, SeatGeek, SerpAPI, Anthropic — lives on the Cloudflare
 * Worker in `proxy/` as a secret, and the app knows only its URL.
 *
 * That matters because Expo inlines any `EXPO_PUBLIC_*` variable into the JS
 * bundle at build time, where it can be recovered from a shipped .ipa/.apk. A
 * URL is safe to publish; a metered key is not.
 */

export const config = {
  /**
   * Base URL of the worker in `proxy/`, e.g. https://events-proxy.you.workers.dev
   *
   * Every event source and the expansion route go through it, so an empty value
   * means the app has no working sources at all.
   */
  eventsProxyUrl: (process.env.EXPO_PUBLIC_EVENTS_PROXY_URL ?? '').replace(/\/$/, ''),

  /** Used when the user hasn't typed a city yet. */
  defaultCity: process.env.EXPO_PUBLIC_DEFAULT_CITY ?? 'New York',
} as const;

/** True when the Worker URL is set. Every source depends on it. */
export function hasProxy(): boolean {
  return config.eventsProxyUrl.length > 0;
}
