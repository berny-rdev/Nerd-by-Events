# Nearby

A local events browser for iOS and Android. Search events across three
providers, save the ones you want, get a reminder an hour before they start.

Built with Expo (SDK 57), Expo Router, TanStack Query, AsyncStorage and
expo-notifications.

---

## The interesting problem

Aggregating one events API is a fetch call. Aggregating three is a design
problem, and that's what most of this repo is about.

Ticketmaster, SeatGeek and Google's event panel all describe the same world
with incompatible vocabularies:

| | Ticketmaster | SeatGeek | Google (via SerpAPI) |
|---|---|---|---|
| Start time | `2026-09-01T23:00:00Z` | `2026-09-01T23:00:00` (UTC, no `Z`) | `"Fri, Aug 8, 7 – 10 PM"` |
| Price | `priceRanges[0].{min,max}` | `stats.{lowest,highest}_price` | absent |
| Image | 10 renditions, pick one | on the performer, not the event | one thumbnail |
| Stable id | yes | yes | **no** |

Three specific decisions came out of that:

**`startsAt` is nullable, and that's load-bearing.** Google gives no year and
no timezone. `src/sources/serpapi.ts` parses what it can and returns `null`
when it can't get to a defensible instant, instead of inventing one. That null
propagates: the UI shows Google's own words, and
`scheduleEventReminder` refuses to schedule rather than fire a notification on
the wrong day.

**Partial failure degrades, it doesn't cascade.** `searchEvents` fans out with
`Promise.allSettled`. If SeatGeek is down or the SerpAPI quota is spent, you
still get Ticketmaster results plus a line saying what's missing and why.

**The deduper is conservative on purpose.** Ticketmaster and SeatGeek sell the
same arena shows, so `dedupe.ts` matches on a sorted bag of significant title
words (so "Knicks vs. Celtics" and "Celtics at Knicks" collide), the same city,
and start times within three hours. It would rather show you a duplicate than
merge two different nights of a two-night run — a user who books the wrong date
has a much worse evening than one who scrolls past a repeat.

## Architecture

```
src/
  app/                      Expo Router — the file tree IS the route tree
    _layout.tsx             root Stack + QueryClientProvider
    (tabs)/
      _layout.tsx           bottom tabs; parens = group without a URL segment
      index.tsx             Browse: debounced search -> FlatList
      saved.tsx             Saved tab, reads AsyncStorage
    event/[id].tsx          detail screen, dynamic route param

  sources/                  ← the aggregation layer
    types.ts                the Event shape + EventSource interface
    ticketmaster.ts         }
    seatgeek.ts             } one file per provider, no shared knowledge
    serpapi.ts              }
    dedupe.ts               cross-source merge heuristic
    index.ts                fan-out, partial-failure handling, registry

  hooks/                    useEvents, useSavedEvents, useDebouncedValue
  lib/                      http, config, storage, notifications, formatting
  components/               EventCard, source badges, loading/error/empty

proxy/                      Cloudflare Worker holding the SerpAPI key
```

Adding a fourth provider means writing one file that implements `EventSource`
and appending it to the array in `src/sources/index.ts`. Nothing above
`sources/` knows a provider-specific field name.

## Key handling

Two different answers, deliberately:

- **Ticketmaster and SeatGeek keys ship in the bundle** as `EXPO_PUBLIC_*`.
  They're read-only, rate-limited and revocable, so the exposure is acceptable
  and the simplicity is worth it.
- **The SerpAPI key does not.** It's billed per search. Anything in an `.ipa`
  or `.apk` can be recovered with `strings`, so it lives as a secret on the
  worker in `proxy/`, and the app only knows a URL. The worker forwards only
  the `q` parameter — passing the client's params straight through would let
  anyone with the URL run arbitrary paid engines on the account.

## Setup

```bash
npm install
cp .env.example .env      # then fill in your keys
npx expo start            # scan the QR code with Expo Go
```

Keys take about two minutes each:

- Ticketmaster — <https://developer.ticketmaster.com/> (5,000 calls/day free)
- SeatGeek — <https://seatgeek.com/account/develop>
- SerpAPI — <https://serpapi.com/> (free tier is small; see `proxy/README.md`)

The app runs with **any subset** of these configured. Sources with no key are
skipped and reported in the UI rather than erroring — so you can start with
Ticketmaster alone and add the others later.

```bash
npm test           # unit tests for the deduper and the date parser
npm run typecheck
npm run lint
```

### Notifications

Local notification scheduling behaves differently in Expo Go than in a
development build, and Android in particular has moved around across SDKs. If
reminders don't fire in Expo Go, build a development client:

```bash
npx expo run:ios      # or run:android
```

Reminders are local-only — the OS holds them and fires them even if the app
never runs again. There's no push server.

## Notes on the data

- SerpAPI dates are parsed into the **device's** timezone, not the venue's.
  Correct for browsing your own city, off by hours for browsing another one.
  Fixing it properly needs a lat/lon → timezone lookup that this source
  doesn't provide. Documented rather than hidden.
- Google's panel exposes no stable event id, so `serpapi.ts` mints one by
  hashing title + date + venue. Same event on a later search gets the same id,
  which keeps FlatList keys and saved-event lookups stable.
- Saved events store the **whole event object**, not just an id. The Saved tab
  has to work offline and with an expired key, and Google has no fetch-by-id
  endpoint to re-resolve from.

## What this deliberately doesn't do

No Instagram or Google HTML scraping. Both are login-walled, JS-rendered and
explicitly against their terms; doing it would need a headless browser, would
break every few weeks, and would put legal exposure into a codebase. SerpAPI
is the licensed route to the same Google data, and the licensing is the point.
