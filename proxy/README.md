# nearby-events-proxy

A Cloudflare Worker that holds every third-party key the app needs, proxies the
three event-search APIs, and runs the two model-backed routes that turn a
free-text taste description into a profile and rank events against it.

**Nothing ships in the app bundle.** The app knows this Worker's URL and nothing
else.

## Routes

| Route | | |
|---|---|---|
| `GET /health` | — | Reports which secrets are set. Never returns a value. |
| `GET /ticketmaster/events` | `keyword`, `city`, `limit` | Ticketmaster Discovery |
| `GET /seatgeek/events` | `keyword`, `city`, `limit` | SeatGeek Platform |
| `GET /serpapi/events` | `q` | Google Events via SerpAPI |
| `POST /expand` | `{ query }` | → `{ scene, core, adjacent[] }` |
| `POST /classify` | `{ profile, events[] }` | → `{ id, band, reason }[]` |

Every route forwards an **allowlist** of parameters to its upstream and nothing
else. Passing a caller's query string through wholesale would let anyone with
the Worker URL run arbitrary paid queries on your accounts.

The three event routes return the same envelope the upstream API does, trimmed
to the array the app parses (`_embedded.events`, `events`, `events_results`) —
so wiring the app to them is a URL change per adapter, not a rewrite.

### POST /expand

```jsonc
// →
{ "query": "vocaloid, vsinger, hololive" }

// ←
{
  "scene": "Japanese and Chinese virtual-singer music: … Relevant events are live shows, concerts, DJ sets … not general anime conventions, cosplay events, or Japanese cultural programming that merely overlaps the audience.",
  "core": ["Vocaloid", "V-Singer", "Hololive"],
  "adjacent": [
    { "name": "Hatsune Miku", "kind": "artist",  "why": "headlines concerts under her own name" },
    { "name": "Miku Expo",    "kind": "event",   "why": "concert series; listings use this name directly" },
    { "name": "Hololive",     "kind": "agency",  "why": "members perform under their own names, not the agency's" },
    { "name": "Project SEKAI","kind": "context", "why": "rhythm game built on this music" }
  ]
}
```

`kind` is always one of `artist` / `event` / `agency` / `context`, and it is
load-bearing: `/classify` tells the model that artist and event names appear in
listing titles while agency and context names indicate scene membership and
rarely do. An act belongs to an agency without the agency ever being named.

The prompt is instructed to work from the **narrowest** category containing the
user's terms and not generalize upward — over-generalizing makes everything
match, which makes ranking useless — and to include only names it is confident
exist rather than padding the list.

Model output is validated structurally before it is returned. An entry with an
unknown `kind`, a missing `name`, or a missing `why` is **dropped**, not passed
through; the count comes back in the `X-Dropped-Entries` header so a model that
keeps inventing kinds is visible rather than silent. A response with no usable
entries at all is a `502` — a broken profile would poison every downstream
search and ranking, so there is nothing partial worth returning.

Cap: 200 characters of query.

**Model: Claude Sonnet 5, with `thinking: { type: 'disabled' }`.**

`/expand` runs once per distinct description and its result is cached ~30 days,
so it is the cheapest place in the system to buy quality — and the most
valuable, since every `artist` and `event` entry becomes a literal search query
and a name omitted here is never recovered downstream. Measured on the same
prompt and the same query, Sonnet returned roughly double Haiku's coverage of
the hand-reviewed reference and named real touring producers rather than agency
roster members. `/classify` stays on Haiku, where the work is per-event and high
volume.

Thinking is **off**, which is not the tradeoff you would expect. Three runs each
against `scripts/fixtures/profile.json`, query `"vocaloid, vsinger, hololive"`,
everything else identical:

| Config | Latency (median) | Strict coverage | Tolerant | Output tokens |
|---|---|---|---|---|
| adaptive thinking (Sonnet default) | 54.4s | 18/21 (17, 18, 20) | 21/21 | 4,476 |
| `effort: 'medium'` | 31.1s | 17/21 (17, 17, 17) | 19/21 | 2,630 |
| **`thinking: 'disabled'`** | **21.0s** | **19/21 (19, 19, 19)** | 19/21 | **1,553** |

Disabling thinking is 2.6× faster, ~3× cheaper on output tokens, and scored
*higher* on strict coverage than leaving it on.

The reproducibility is the part that matters most here. Disabled returned
19/19/19 across three runs; adaptive swung 17→20. Because an expansion is cached
for ~30 days, whichever result lands first is the one a user lives with for a
month — an unlucky draw persists, and nothing in the product surfaces that they
got a worse profile than the next person. A tighter distribution is worth more
than a higher ceiling under those conditions.

Adaptive thinking does have the higher ceiling: it hit 21/21 tolerant twice. Its
advantage shows up almost entirely in the *tolerant* column, meaning it mostly
buys fuller name forms — `Hatsune Miku Expo` rather than `Miku Expo` — which are
better search strings. It just doesn't produce them consistently.

> ⚠️ **How far to trust this.** n=3 per config, on **one query**, against
> **one** hand-reviewed reference. The latency numbers are solid — spread within
> each config was under 4s. The coverage numbers are not: adaptive's 17–20 range
> at n=3 does not separate cleanly from disabled's 19.
>
> Critically, this was measured on a query inside the two seeded scenes, where
> part of the answer is supplied by `seeds.ts` regardless of model config. It has
> **not** been checked against scenes the model must handle unaided — which is
> exactly where reasoning would be most likely to help. Before treating "thinking
> off" as generally correct rather than correct-for-this-query, re-run it across
> several unseeded scenes at ~10 runs each.

### Curated seeds

> **This system is not curated.** Expansion is generated by the model for every
> query. `src/seeds.ts` patches exactly **two** scenes where recall was measured
> to be poor against a hand-reviewed reference. Any query outside those two gets
> pure generated output with nothing added.

| Seed | The measured gap |
|---|---|
| `chinese-virtual-singers` | Neither Haiku 4.5 nor Sonnet 5 returned a single entry from the Chinese ecosystem — not the Vsinger roster, not VirtuaReal, not A-SOUL. |
| `japanese-utaite-producers` | Sonnet reached the instrumental producers (livetune, Giga, Mitchie M) but none of the singers who came up through Niconico — Ado, Eve, Soraru, Mafumafu. |

The bar for a third seed is a **measured** recall failure against a reviewed
reference, not "these names would be nice to have". Hand-curation does not scale
across scenes, and a list that grows by taste becomes a stale directory quietly
overriding a model that may since have improved.

A seed carries `triggers` (lowercased substrings); if any appears in the query
**or in the generated scene paragraph**, its entries are merged. Merging is
conditional on purpose — an unconditional seed would staple a Chinese
virtual-singer roster onto somebody's bluegrass profile. Generated entries win
on collision, deduped on a normalized name so `DECO*27` and `deco27` collapse.

Seeds are merged **after the cache read**, not before the write, so editing
`seeds.ts` takes effect on the next request instead of waiting out a 30-day TTL
on every previously cached query. The response reports what fired:

```
X-Seeds-Applied: chinese-virtual-singers
X-Seed-Entries-Added: 12
```

The file is data — adding a scene needs no change to prompts, routes, or
caching.

### POST /classify

```jsonc
// →
{
  "profile": { /* the /expand output, unchanged */ },
  "events": [{ "id": "tm-1", "title": "…", "venue": "…", "description": "…" }]
}

// ←
[{ "id": "tm-1", "band": "STRONG", "reason": "headline act is on the Hololive roster" }]
```

`band` is `STRONG` / `POSSIBLE` / `WEAK` / `UNRELATED`.

**This route never fails on model trouble.** Submit N events, get N verdicts.
Anything the model omitted, mangled, or refused comes back `UNRELATED` rather
than being dropped, so the app never has to reconcile a short list. Verdicts are
matched back **by id, not by position** — a model that reorders its output would
otherwise shift every later verdict onto the wrong event.

Caps: 50 events per request, 200-char titles, 500-char descriptions, 128 KB body.

## Secrets

Set each with `npx wrangler secret put <NAME>`:

| Secret | Powers | Cost model |
|---|---|---|
| `ANTHROPIC_API_KEY` | `/expand`, `/classify` | metered per token |
| `SERPAPI_API_KEY` | `/serpapi/events` | metered per search |
| `TICKETMASTER_API_KEY` | `/ticketmaster/events` | free, rate-limited |
| `SEATGEEK_CLIENT_ID` | `/seatgeek/events` | free, rate-limited |

Ticketmaster and SeatGeek were previously `EXPO_PUBLIC_*` values in the app's
`.env`. They were the defensible exception — read-only and revocable — but once
the Worker had to exist for the metered keys anyway, leaving two keys on a
different footing was just an inconsistency to explain. Key handling is now
uniform: everything is a Worker secret.

Verify after deploying:

```bash
curl https://<your-worker>.workers.dev/health
# {"ok":true,"secrets":{"anthropic":true,"serpapi":true,"ticketmaster":true,"seatgeek":true}}
```

A `false` means that secret is missing. Values are never returned.

## Local development

```bash
cd proxy
npm install
npx wrangler dev        # http://localhost:8787
```

`wrangler dev` reads secrets from `proxy/.dev.vars` (gitignored, same
`KEY=value` format as `.env`) rather than from `wrangler secret`:

```
ANTHROPIC_API_KEY=sk-ant-...
SERPAPI_API_KEY=...
TICKETMASTER_API_KEY=...
SEATGEEK_CLIENT_ID=...
```

Point the app at it with `EXPO_PUBLIC_EVENTS_PROXY_URL=http://localhost:8787`.
On a physical device that has to be your machine's LAN IP — the phone's
`localhost` is the phone.

```bash
curl -X POST localhost:8787/expand \
  -H 'content-type: application/json' \
  -d '{"query":"vocaloid, vsinger, hololive"}'
```

## Deploy

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY      # repeat for the other three
npx wrangler deploy
```

## Tests

```bash
npm test        # 33 tests, no network, no API key
npm run typecheck
```

Node's built-in runner — no vitest, no `@cloudflare/vitest-pool-workers`, no
test dependencies at all. That works because `handleRequest(request, env, deps)`
is a pure function of its dependencies: the cache, clock, upstream `fetch`, and
model call all arrive through `Deps`, and `src/index.ts` is the only file that
knows the real ones. The tests inject stubs, which is what lets them assert
things the live runtime would hide — that a cache hit made **zero** model calls,
that a rate-limited request never reached the model, that a cached event was not
re-sent in the next batch.

Two constraints worth knowing if you extend them:

- Node's TypeScript support is **strip-only**. It erases types but cannot
  generate code, so constructor parameter properties (`constructor(readonly x:
  number)`), enums, and namespaces all fail at load. Write them out longhand.
- `test/` typechecks against a separate `tsconfig.test.json`, because
  `@types/node` and `@cloudflare/workers-types` both declare `fetch`, `Request`,
  and `Response`. `src/` is checked against workerd's globals only — which is
  what actually runs in production.

## Caching

| Route | Key | TTL |
|---|---|---|
| `/expand` | **canonical** query — lowercased, whitespace collapsed, comma-separated terms deduped and **sorted** | 30 days |
| `/classify` | `(sha256 of profile, event id)` — **per event**, not per request | 7 days |
| `/serpapi/events` | `q` | 10 minutes |
| `/ticketmaster`, `/seatgeek` | `keyword\|city\|limit` | 5 minutes |

The per-event classify key is the one that matters in practice: a search
returning twenty events of which eighteen were classified before sends only the
two new ones to the model.

Term order never buys a second expansion — `"vocaloid, hololive, vsinger"` and
`"vocaloid, vsinger, hololive"` are the same cache entry. Sorting is on commas
only; sorting individual words would turn `"drum and bass"` into `"and bass
drum"`, so a query written without commas keeps the order it was typed in. The
canonical form is what gets sent to the model too, not just what keys the cache,
so the cached profile is always the one the prompt actually produced.

Placeholder verdicts are **never** cached. If the model fails to return a band
for an event, that `UNRELATED` is a harness outcome, and caching it would freeze
a transient failure into a permanent judgment.

> ⚠️ **The Cache API is per-datacenter and evictable.** "The same query must
> never re-expand" holds in practice, not by guarantee — a colo that has not
> seen a query, or has evicted it, will re-expand. `CacheLike` in `src/types.ts`
> exists to make the swap cheap: bind a KV namespace and implement `match`/`put`
> against it for a durable, globally-consistent cache. That is the right upgrade
> the first time an expansion bill surprises you.
>
> **`wrangler dev` uses the real cache, and persists it across restarts.**
> Miniflare implements `caches.default` and writes it to
> `.wrangler/state/v3/cache`, so restarting the dev server does **not** give you
> a cold cache — a repeat of the same `/expand` query will still be a `HIT`.
> When you are iterating on a prompt and need a genuinely cold run:
>
> ```bash
> npx wrangler dev --persist-to /tmp/cold-$(date +%s)   # fresh state each time
> # or: rm -rf .wrangler/state/v3/cache
> ```
>
> Forgetting this is the easiest way to conclude a prompt change did nothing.

## Rate limiting

Per client IP (`CF-Connecting-IP`), sliding window:

| Route | Limit |
|---|---|
| `/expand` | 15 / minute |
| `/classify` | 20 / minute |
| everything else | 120 / minute |

Exceeding it returns `429` with a `Retry-After` header. `/health` is exempt —
locking out an uptime check during a traffic spike hides the outage.

> ⚠️ **Best-effort, by construction.** The window lives in isolate memory, and
> Cloudflare runs many isolates across many datacenters, so a caller spread
> across them gets more than the stated limit. What this reliably stops is what
> actually happens: one buggy client, one runaway retry loop, one person
> hammering a URL they found. For a hard ceiling use Cloudflare **Rate Limiting
> rules** (in front of the Worker, so abuse never costs an invocation) or a
> **Durable Object** (exact, at the cost of a round trip per request). Both are
> account-side configuration, which is why neither is the default here.

## Known gaps

- **The app has not been migrated yet.** This is the Worker half. Until the
  app's source adapters are pointed at these routes, Ticketmaster and SeatGeek
  will report as unconfigured in the UI — their keys are gone from `.env.example`
  but `src/sources/*.ts` still expects them.
- **The classification prompt exists twice** — here in `src/prompts.ts` and in
  the app repo's `scripts/prompt.ts`. They will drift. The fix is to point
  `scripts/score.ts` at a deployed `/classify` instead of holding its own copy.
- **Wrangler is on v3**; v4 is current. Unrelated to this change, but the CLI
  says so on every command.
