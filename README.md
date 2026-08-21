# Nearby

An events app for iOS and Android that takes a free-text description of what
someone is into and finds live events for it.

```
"vocaloid, vsinger, hololive"
        │
        ├─ 1. EXPAND    LLM turns the description into a structured profile:
        │               a scene paragraph + ~30 named acts and event series,
        │               each tagged with how it behaves in a listing
        │
        ├─ 2. FAN OUT   Search every artist/event name against every provider,
        │               ~43 requests, deduped across sources *and* queries
        │
        ├─ 3. RANK      LLM scores each result against the profile:
        │               STRONG / POSSIBLE / WEAK / UNRELATED
        │
        └─ 4. RENDER    Sorted by band, then date. Nothing filtered out.
```

The interesting problem is not "call an events API". It is that a search for
`Eve` returns *Marilyn Maye's New Year's Eve Extravaganza*, and the only thing
that separates that from an actual Eve show is understanding what scene the
user meant.

**Stack:** Expo (SDK 57) · Expo Router · TanStack Query · AsyncStorage ·
Cloudflare Workers · Anthropic API.

**Tests:** 224 app · 51 Worker. No network in either suite.

> **Read this section if you read nothing else.** Several decisions below were
> made from measurements, and several were judgement calls. They are labelled
> **[measured]** and **[judgement]** throughout so you can tell which is which
> without taking my word for anything.

---

## 1. Expansion, and why entries carry a `kind`

`POST /expand` sends the user's description to Claude and gets back:

```jsonc
{
  "scene": "Japanese and Chinese virtual-singer music: … Relevant events are live
            shows, concerts, DJ sets … not general anime conventions, cosplay
            events, or Japanese cultural programming that merely overlaps the
            audience.",
  "core": ["Vocaloid", "V-Singer", "Hololive"],
  "adjacent": [
    { "name": "Hatsune Miku",  "kind": "artist",  "why": "headlines concerts under her own name" },
    { "name": "Miku Expo",     "kind": "event",   "why": "concert series; listings use this name directly" },
    { "name": "Hololive",      "kind": "agency",  "why": "members perform under their own names, not the agency's" },
    { "name": "Project SEKAI", "kind": "context", "why": "rhythm game built on this music" }
  ]
}
```

`kind` exists because the four categories have **different downstream uses**,
and conflating them breaks the system in two directions at once:

| kind | Appears in listing titles? | What it's used for |
|---|---|---|
| `artist` | yes | becomes a **literal search query** |
| `event` | yes | becomes a **literal search query** |
| `agency` | rarely | ranking signal only |
| `context` | rarely | ranking signal only |

A VTuber agency is the clearest case. Hololive's members perform and are billed
under their *own* names — no ticketing listing says "Hololive". Searching for it
returns noise. But a listing naming one of its members *is* in scene, and the
ranking prompt needs to know that. So `agency` entries are never searched and
always ranked against.

Get this wrong in either direction and you lose something: search the agency
names and you burn quota on nothing; drop them from the profile and a member's
solo concert ranks as UNRELATED.

The `why` clause is written for a reader deciding whether an event matches, not
as a description of the artist — it goes into the ranking prompt verbatim.

The `scene` paragraph does two jobs: name the scene, and **name the near-misses
that do not count**. That second half is what lets ranking reject an anime
convention that shares an audience with the scene but isn't it.

---

## 2. Ranking, not filtering

`POST /classify` assigns every fetched event one of `STRONG`, `POSSIBLE`,
`WEAK`, `UNRELATED`. **Nothing is ever removed from the list.**

Results sort by band, then by date within band. A visual divider sits **below
POSSIBLE** — not above it. **[judgement]** POSSIBLE is the tier worth scanning:
it's where an act you didn't know about but might like shows up. Burying it
under a "less relevant" heading would hide the most interesting results, which
is the opposite of the point. Everything below the divider stays in the same
scrollable list; the divider reports its own count (`"12 weaker matches below"`)
so it reads as a signpost rather than a cut.

Three properties the ranking layer guarantees, each with tests:

- **Every submitted event gets a verdict.** An unrecognised band, a missing
  entry, or a failed batch all produce the *lowest* tier with `isRanked: false`
  — never a dropped event.
- **Unrecognised bands are dropped, not coerced.** Rewriting `"MAYBE"` to
  `UNRELATED` in the client would invent a judgement the model never made — and
  worse, that invented band would then be cached as real.
- **Fallback bands are never cached.** An `UNRELATED` produced by a failed
  batch is a harness outcome, not a verdict; caching it would freeze a transient
  failure into a permanent judgement.

Total classification failure is a first-class state: the banner says ranking is
unavailable and the list stays in source order. Ranking is an enhancement, and
every failure path still renders every event that was fetched.

---

## 3. Model choice per route

| Route | Model | Why |
|---|---|---|
| `/expand` | `claude-sonnet-5`, thinking **disabled** | Once per distinct description, cached ~30 days |
| `/classify` | `claude-haiku-4-5-20251001` | Per event, high volume |

Expansion is the cheapest place in the system to buy quality and the most
valuable: every `artist`/`event` entry becomes a literal search query, so a name
omitted here is **never recoverable downstream**. On the same prompt and query,
Sonnet returned roughly double Haiku's coverage of a hand-reviewed reference and
named real touring producers rather than agency roster members.

### Why thinking is off **[measured]**

Three runs per config, same prompt, same query, cold cache each time:

| Config | Latency (median) | Strict coverage | Tolerant | Output tokens |
|---|---|---|---|---|
| adaptive thinking (Sonnet default) | 54.4s | 18/21 (17, 18, 20) | **21/21** | 4,476 |
| `effort: 'medium'` | 31.1s | 17/21 (17, 17, 17) | 19/21 | 2,630 |
| **`thinking: 'disabled'`** | **21.0s** | **19/21 (19, 19, 19)** | 19/21 | **1,553** |

Disabling thinking is 2.6× faster, ~3× cheaper on output, and scored *higher* on
strict coverage. That is not the tradeoff you would expect, which is why it's
worth stating as a measurement rather than a preference.

**Reproducibility decided it.** Disabled returned 19/19/19 across three runs;
adaptive swung 17→20. Because an expansion is cached for ~30 days, **whichever
result lands first is the one a user lives with for a month**. An unlucky draw
persists, and nothing in the product surfaces that they got a worse profile than
the next person. A tighter distribution is worth more than a higher ceiling
under those conditions.

Adaptive does have the higher ceiling — 21/21 tolerant, twice. Its advantage
shows up almost entirely in the *tolerant* column, meaning it mostly buys fuller
name forms (`Hatsune Miku Expo` over `Miku Expo`), which are better search
strings. It just doesn't produce them consistently.

**How far to trust this:** n=3 per config, one query, one reference. The latency
numbers are solid (<4s spread within each config). The coverage numbers are not
— adaptive's 17–20 range doesn't separate cleanly from disabled's 19. It was
also measured on a query *inside* the two seeded scenes, where part of the answer
comes from `seeds.ts` regardless of config. It has **not** been checked against
scenes the model must handle unaided, which is exactly where reasoning would be
most likely to help.

---

## 4. Seed files

`proxy/src/seeds.ts` supplies names for scenes the model demonstrably doesn't
know. **This is not a curated database** — expansion is generated for every
query, and any query outside these two scenes gets pure model output with
nothing added.

| Seed | Entries | The measured gap |
|---|---|---|
| `chinese-virtual-singers` | 12 | Neither Haiku nor Sonnet returned a *single* entry from the Chinese ecosystem — not the Vsinger roster, not VirtuaReal, not A-SOUL |
| `japanese-utaite-producers` | 8 | Sonnet reached the instrumental producers (livetune, Giga, Mitchie M) but none of the singers who came up through Niconico — Ado, Eve, Soraru, Mafumafu |

### Coverage progression **[measured]**

Against a hand-reviewed 21-entry reference for `"vocaloid, vsinger, hololive"`:

| Stage | Coverage |
|---|---|
| Haiku, no seeds | **3/21** |
| Sonnet, no seeds | **7/21** |
| Sonnet + Chinese seed | **12/21** |
| Sonnet + both seeds | **19/21** |

The two still scored as absent are naming variance, not misses — the model
returned `Hatsune Miku Expo` where the reference says `Miku Expo`, and
`hololive Production` where it says `Hololive`. Both are arguably better search
strings.

A seed fires only when its triggers match the query **or the generated scene
paragraph**, so a bluegrass profile can't acquire a Chinese VTuber roster.
Generated entries win on collision, deduped on a normalised name. Seeds merge
*after* the cache read, so editing the file takes effect on the next request
rather than waiting out a 30-day TTL.

### The bar for a third seed

A **measured** recall failure against a reviewed reference — not "these names
would be nice to have". Hand-curation doesn't scale across scenes, and a list
that grows by taste becomes a stale directory quietly overriding a model that
may since have improved.

---

## 5. The batching experiment **[measured]**

Classification batches 20 events per request. The obvious risk: 20 listings
share one context, so neighbours might drag verdicts. That was tested rather
than assumed.

**Methodology.** Every condition ran against a cold Worker cache (verdicts cache
per `(profileHash, eventId)` for 7 days, so a naive rerun replays rather than
re-classifies). Each condition ran **twice**, because a bare agreement rate can't
distinguish context drag from model variance — you need a noise floor first.

Real fan-out data: 20 Ticketmaster events, 8 genuine Miku Expo listings and 12
coincidences (Eve 6, *The Lady Eve*, *Much Ado About Nothing*).

| Comparison | Agreement |
|---|---|
| **Noise floor** — batch vs batch | 19/20 · 95% |
| **Noise floor** — singleton vs singleton | 20/20 · 100% |
| Batch vs singleton (4 pairings) | 18–19/20 · **90–95%** |

Two events ever disagreed. One was noise (it also accounts for the batch noise
floor). The other was **reproducible in both directions** — both batch runs said
`UNRELATED`, both singleton runs said `POSSIBLE`:

```
Jimi Lucid, id-sus, Fortress, Eve Claret   batch:[UNRELATED, UNRELATED]  single:[POSSIBLE, POSSIBLE]
```

So: **~5% of events shifted band reproducibly because of batching**, and the
direction was demotion of a marginal event. Plausibly, sitting beside eight
unmistakable Miku Expo rows makes a marginal indie bill look clearly out; alone,
it's genuinely ambiguous.

### Deliberate skew: null result

Two probes — one unambiguous (`Hatsune Miku - Miku Expo 2026 Europe`), one
marginal (the Eve Claret bill) — each classified alone, then batched with 19
clearly irrelevant events, then with 19 clearly in-scene events:

| Probe | Alone | + 19 irrelevant | + 19 in-scene | Drag |
|---|---|---|---|---|
| clear | STRONG | STRONG | STRONG | **none** |
| marginal | POSSIBLE | POSSIBLE | POSSIBLE | **none** |

Filler sanity check passed — all 19 irrelevant came back `UNRELATED`, all 19
in-scene came back `STRONG` — so the model genuinely discriminated and the null
result isn't an artifact of it ignoring the batch.

### Why batch size stayed at 20 **[judgement, informed by the above]**

90–95% agreement against a 95% batch noise floor means batching costs very
little beyond what the model varies by anyway, and extreme composition moved
nothing. Batch size is really a blast-radius decision: a failed batch costs
every verdict in it, and a longer response risks truncation losing the tail. The
Worker accepts 50; 20 keeps failures narrow and gives the concurrency pool
something to overlap.

The caveat worth stating: the ~5% that moves is exactly the population you'd
care about. `POSSIBLE` is the tier a user scans for surprises, and a demotion to
`UNRELATED` buries it.

---

## 6. Key handling

**Every third-party credential is a Cloudflare Worker secret. Nothing ships in
the app bundle.** The app knows one thing: the Worker's URL.

| Secret | Powers |
|---|---|
| `ANTHROPIC_API_KEY` | `/expand`, `/classify` |
| `SERPAPI_API_KEY` | `/serpapi/events` |
| `TICKETMASTER_API_KEY` | `/ticketmaster/events` |
| `SEATGEEK_CLIENT_ID` | `/seatgeek/events` |

Expo inlines any `EXPO_PUBLIC_*` variable into the JS bundle at build time,
where it can be recovered from a shipped `.ipa`/`.apk`. That's fatal for a
metered key. Ticketmaster and SeatGeek were initially the defensible exception —
read-only, rate-limited, revocable — but once a Worker had to exist for the
metered keys anyway, leaving two keys on a different footing was just an
inconsistency to explain.

Each route forwards an **allowlist** of parameters. Passing a caller's query
string through wholesale would let anyone with the Worker URL run arbitrary paid
queries on the account.

### The tradeoff this creates

Every source's `isConfigured()` is now the same `hasProxy()` check. **A Worker
outage takes down all three providers at once**, where previously an outage at
one provider degraded to the other two. Uniform key handling was bought with a
single point of failure.

It's a real regression in availability, accepted because the alternative was
shipping metered credentials to devices. The mitigation is that the Worker is
thin, stateless, and mostly cache reads — but the honest summary is that
resilience moved from "three independent providers" to "one Worker".

A related consequence: the app can no longer tell that a *particular* source
lacks its key. The Worker returns `503` with a machine-readable
`code: "not_configured"`, which the app maps to its *skipped* list rather than
reporting a provider that broke.

---

## 7. Ticketmaster spike arrest **[measured]**

A fan-out sends Ticketmaster 25 queries. Ticketmaster enforces **5 requests per
second**. Reproduced by running one fan-out's worth of traffic:

```
25-query burst → 23 × 200, 2 × 502
502 body: "Spike arrest violation. Allowed rate:
           MessageRate{messagesPerPeriod=5, periodInMicroseconds=1000000}"
```

The Worker was turning every non-OK upstream response into a 502, so a
transient, retryable rate limit became a hard failure. It looked
name-correlated — the initial hypothesis was that special characters like
`DECO*27` broke query encoding — but tested sequentially, `AC/DC`,
`Simon & Garfunkel`, `P!nk`, `a+b` and `x?y` all return results. Encoding was
correct end to end; the failures were random, hitting whichever queries happened
to land in the same second.

**Fix:** retry `429/500/502/503/504` up to 3 attempts with 250ms → 700ms backoff
**plus up to 100% jitter**. The jitter is load-bearing: a fan-out arrives as ~25
near-simultaneous Worker invocations, and identical backoffs would retry in
lockstep and trip the same per-second limit again.

```
After the fix: 25 × 200, 2 retries, 0 unrecovered failures (~1s added)
```

Failing queries are logged by keyword, and the app records up to three failing
keywords per source — `"3 of 25 queries failed"` alone is undiagnosable.

---

## 8. Repository layout

```
src/
  profile/        expansion client, canonicalisation, AsyncStorage cache
  sources/        three adapters + fan-out plan + aggregator + dedupe
  rank/           classify client, verdict cache, batching, sort + divider
  hooks/          use-expansion · use-events · use-ranking · use-near-me · …
  app/            Expo Router screens

proxy/            Cloudflare Worker — every secret, both LLM routes
  src/routes/     events (3 providers) · expand · classify
  src/prompts.ts  expansion + classification prompt text
  src/seeds.ts    the two curated scenes

scripts/          dev tooling; never bundled. Prompt-iteration harness.
```

### Notable per-layer decisions

**Dedupe runs in two passes.** An exact-`id` pass collapses the same record
returned by two different queries (searching `Hatsune Miku` and
`Hatsune Miku Expo` returns one Ticketmaster row twice); a fuzzy pass then
merges across providers. Doing identity first means the heuristic matcher never
had to be loosened for same-source duplicates, so its tuning for the genuinely
hard case is untouched.

**Per-source query budgets** — Ticketmaster 25, SeatGeek 15, SerpAPI 3 — are
quota decisions, not performance ones. One search is ~43 requests, capped at 6
concurrent.

**Caching is layered.** Expansions 30 days on a canonical (order-insensitive)
query; verdicts 7 days per `(profile, event)`; event searches 5–10 minutes. The
verdict cache is per *event*, so a search returning 20 events of which 18 were
seen before sends only 2 to the model.

**Progressive rendering.** Events render the moment the fan-out returns them,
unranked; bands fill in per classify batch. Row height is *reserved* rather than
grown, so bands landing never reflow rows under a scrolling thumb.

---

## 9. Setup

The app does not run without a deployed Worker — that's the tradeoff in §6.

```bash
# 1. Worker
cd proxy && npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY      # repeat for the other three
npx wrangler deploy
curl https://<your-worker>.workers.dev/health  # reports which secrets are set

# 2. App
npm install
cp .env.example .env      # set EXPO_PUBLIC_EVENTS_PROXY_URL to the Worker URL
npx expo start
```

Local Worker development uses `proxy/.dev.vars` (gitignored) and
`npx wrangler dev`.

```bash
npm test          # 224 app tests
npm run typecheck
cd proxy && npm test   # 51 Worker tests, Node's built-in runner, no deps
```

---

## 10. Known limits

Stated plainly, because most of them are unfixed by choice rather than
oversight.

**SerpAPI is effectively decorative.** The free tier is ~100 searches/month. At
3 queries per fan-out that's ~33 user searches *per month* for the entire app.
It works and it's wired correctly, but it cannot carry real traffic, and raising
its budget is the fastest way to exhaust the quota.

**The Worker's rate limiter is best-effort.** It's a sliding window in isolate
memory, and Cloudflare runs many isolates across many datacenters, so a caller
spread across them exceeds the stated limit. It reliably stops one buggy client
or a runaway retry loop. A hard ceiling needs Cloudflare Rate Limiting rules or
a Durable Object — both account-side configuration.

**The expansion cache holds in practice, not by guarantee.** "The same query
never re-expands" relies on the Cache API, which is per-datacenter and evictable.
A colo that hasn't seen a query, or has evicted it, re-expands. `CacheLike` is an
interface specifically so a KV namespace can be swapped in when that matters.

**Three contracts are duplicated across the app/Worker boundary and can drift:**

| Contract | Copies | Drift symptom |
|---|---|---|
| `canonicalQuery` | `src/profile/canonical.ts`, `proxy/src/lib/hash.ts` | Silent extra network round trip per search |
| `NOT_CONFIGURED` | `src/lib/http.ts`, `proxy/src/lib/http.ts` | Unconfigured sources report as broken again |
| classify response shape | `src/rank/client.ts` parses what `proxy/src/routes/classify.ts` emits | Verdicts silently dropped |

Each copy carries a comment pointing at the other, and both `canonicalQuery`
implementations have matching test cases — but comments are not a build step.
The classification prompt is duplicated between `proxy/src/prompts.ts` and
`scripts/prompt.ts` for the same reason; the fix is pointing the script at the
deployed route.

**The `/expand` first-run latency is ~21 seconds.** Cached afterwards, and
nothing in the UI waits on it — keyword results render immediately and expansion
widens the search when it lands — but a first-time search for a novel
description is a long wait for the enhanced results.

**Batching may demote marginal events ~5% of the time** (§5). Measured, small,
and confined to the `POSSIBLE` tier — which is also the tier that matters most.

---

## 11. Unverified

Two features are wired, typechecked, unit-tested, and have **never run on a
physical device**:

**Geolocation.** The permission state machine (`undetermined` / `granted` /
`denied` / `blocked`) and the coordinates→city step are unit-tested against a
mocked `expo-location`. What is untested: the real OS prompt, the
`Linking.openSettings()` round trip, and Android's reverse-geocode behaviour —
historically the flakier platform for a `null` city, which is the case the
fallback chain exists for.

**Notification deep-linking.** Payload parsing is tested against realistic
malformed inputs. What is untested: whether the navigation-ready gate fires
early enough on a real cold launch, and whether the response listener
double-fires on either platform (it's deduped on notification identifier, but
that guard has never been exercised for real). This is also the path where
`expo-notifications` behaviour differs between Expo Go and a development build,
so it needs a dev build rather than Expo Go.

Both were built to a spec rather than to observed behaviour. Treat them as
plausible, not proven.
