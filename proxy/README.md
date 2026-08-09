# SerpAPI proxy

A ~120-line Cloudflare Worker that sits between the app and SerpAPI's
`google_events` engine.

## Why it exists

SerpAPI bills per search. Expo inlines `EXPO_PUBLIC_*` variables into the JS
bundle, and a bundle can be pulled out of an `.ipa`/`.apk` and read with
`strings`. So a metered key cannot ship in the app — it lives here as a Worker
secret, and the app only ever knows a URL.

It also does two things that save money:

- **Caches** upstream responses for 10 minutes, keyed on the normalized query.
  Retyping the same search doesn't cost another credit.
- **Forwards only `q`.** Passing the client's query string through wholesale
  would let anyone who found the URL run arbitrary paid SerpAPI engines on your
  account.

The response is trimmed to `events_results` before being returned — SerpAPI's
full payload includes search metadata and your remaining account credit, and
there's no reason to hand either to a client.

## Deploy

```bash
cd proxy
npm install
npx wrangler login
npx wrangler secret put SERPAPI_API_KEY    # paste the key when prompted
npx wrangler deploy
```

Wrangler prints a URL like `https://nearby-events-proxy.<you>.workers.dev`.
Put it in the app's `.env`:

```
EXPO_PUBLIC_EVENTS_PROXY_URL=https://nearby-events-proxy.<you>.workers.dev
```

Then restart the Expo dev server — `EXPO_PUBLIC_*` values are inlined at bundle
time, so an edit to `.env` does nothing until Metro restarts.

## Local development

```bash
npx wrangler dev
```

Point the app at `http://localhost:8787`. On a physical device that has to be
your machine's LAN IP, not `localhost` — the phone's localhost is the phone.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /serpapi/events?q=<query>` | Proxied Google Events search |
| `GET /health` | Liveness + whether the secret is set (never returns the key) |

## Not included

No per-IP rate limiting. A public URL backed by a metered key should have some
before it's genuinely public — Cloudflare's Rate Limiting rules or a
Durable Object counter are the two obvious routes. For a portfolio deployment
with a free-tier key, the 10-minute cache and the `q`-only allowlist are the
meaningful protections.
