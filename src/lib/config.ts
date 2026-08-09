/**
 * Runtime configuration.
 *
 * Expo inlines any `EXPO_PUBLIC_*` variable from `.env` at build time. That
 * means these values ship inside the JS bundle and are trivially extractable
 * from an .ipa/.apk — so only read-only, rate-limited, revocable keys belong
 * here.
 *
 * SerpAPI's key is billed per search and is NOT one of those, which is why it
 * lives on the worker in `proxy/` and the app only knows a URL.
 */

export const config = {
  ticketmasterApiKey: process.env.EXPO_PUBLIC_TICKETMASTER_API_KEY ?? '',
  seatgeekClientId: process.env.EXPO_PUBLIC_SEATGEEK_CLIENT_ID ?? '',
  /** Base URL of the worker in `proxy/`, e.g. https://events-proxy.you.workers.dev */
  eventsProxyUrl: (process.env.EXPO_PUBLIC_EVENTS_PROXY_URL ?? '').replace(/\/$/, ''),

  /** Used when the user hasn't typed a city yet. */
  defaultCity: process.env.EXPO_PUBLIC_DEFAULT_CITY ?? 'New York',
} as const;
