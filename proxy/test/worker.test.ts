/**
 * Worker tests.
 *
 * `proxy/` had no test setup, so this uses Node's built-in runner — no vitest,
 * no @cloudflare/vitest-pool-workers, no new dependencies. That's possible only
 * because `handleRequest` takes its cache, clock, network, and model through
 * `Deps`: the tests pass stubs and can assert things the real runtime would
 * hide, like "this cache hit did not call the model".
 *
 *   cd proxy && npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryCache } from '../src/lib/cache.ts';
import { memoryRateLimiter, ruleFor } from '../src/lib/rate-limit.ts';
import { MODELS } from '../src/model.ts';
import { handleRequest } from '../src/router.ts';
import type { Deps, Env, ModelRequest, ModelResult } from '../src/types.ts';

// ------------------------------------------------------------------ harness

const GOOD_PROFILE = {
  scene: 'Virtual-singer music. Concerts and DJ sets count; anime conventions do not.',
  core: ['Vocaloid', 'Hololive'],
  adjacent: [
    { name: 'Hatsune Miku', kind: 'artist', why: 'headlines under her own name' },
    { name: 'Miku Expo', kind: 'event', why: 'concert series, appears in titles' },
    { name: 'Hololive', kind: 'agency', why: 'members billed under their own names' },
    { name: 'Project SEKAI', kind: 'context', why: 'rhythm game built on this music' },
  ],
};

const EVENTS = [
  { id: 'e1', title: 'Miku Expo 2026' },
  { id: 'e2', title: 'Anime Expo 2026' },
  { id: 'e3', title: 'NY Philharmonic' },
];

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: 'test-anthropic',
    SERPAPI_API_KEY: 'test-serpapi',
    TICKETMASTER_API_KEY: 'test-tm',
    SEATGEEK_CLIENT_ID: 'test-sg',
    ...overrides,
  };
}

type Harness = {
  deps: Deps;
  /** Every model request the route made, in order. */
  modelCalls: ModelRequest[];
  upstreamCalls: string[];
  /** Backoff durations the route asked for, in order. Never actually waited. */
  sleeps: number[];
  setModel: (fn: (request: ModelRequest) => ModelResult | Promise<ModelResult>) => void;
  setUpstream: (fn: (url: string) => Response | Promise<Response>) => void;
  advance: (ms: number) => void;
  /** Awaits queued waitUntil work so cache writes land before the next assert. */
  flush: () => Promise<void>;
};

function makeHarness(): Harness {
  const modelCalls: ModelRequest[] = [];
  const upstreamCalls: string[] = [];
  const sleeps: number[] = [];
  const pending: Promise<unknown>[] = [];
  let clock = 1_700_000_000_000;

  let model: (request: ModelRequest) => ModelResult | Promise<ModelResult> = () => ({
    text: '{}',
    stopReason: 'end_turn',
  });

  let upstream: (url: string) => Response | Promise<Response> = () =>
    new Response('{}', { status: 200 });

  const deps: Deps = {
    cache: memoryCache(),
    now: () => clock,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    callModel: async (_env, request) => {
      modelCalls.push(request);
      return model(request);
    },
    upstreamFetch: async (input) => {
      const url = String(input);
      upstreamCalls.push(url);
      return upstream(url);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    rateLimiter: memoryRateLimiter(),
  };

  return {
    deps,
    modelCalls,
    upstreamCalls,
    sleeps,
    setModel: (fn) => {
      model = fn;
    },
    setUpstream: (fn) => {
      upstream = fn;
    },
    advance: (ms) => {
      clock += ms;
    },
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

function get(path: string, ip = '1.2.3.4'): Request {
  return new Request(`https://proxy.test${path}`, {
    method: 'GET',
    headers: { 'CF-Connecting-IP': ip },
  });
}

function post(path: string, body: unknown, ip = '1.2.3.4'): Request {
  return new Request(`https://proxy.test${path}`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Node's undici types give Response.json() an `unknown` return, while workerd's
 * give it `any`. One helper keeps the assertions readable instead of casting at
 * every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (response: Response): Promise<any> => response.json() as Promise<any>;

const modelText = (value: unknown): ModelResult => ({
  text: JSON.stringify(value),
  stopReason: 'end_turn',
});

// ------------------------------------------------------------------- /expand

test('/expand returns a validated profile', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  // Deliberately a query no seed triggers on, so this stays a test of
  // validation rather than of seed merging.
  const response = await handleRequest(post('/expand', { query: 'bluegrass' }), makeEnv(), h.deps);
  assert.equal(response.status, 200);

  const body = await bodyOf(response);
  assert.equal(body.scene, GOOD_PROFILE.scene);
  assert.equal(body.adjacent.length, 4);
  assert.equal(response.headers.get('X-Seeds-Applied'), 'none');
});

test('/expand uses Sonnet and /classify uses Haiku', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));
  await handleRequest(post('/expand', { query: 'bluegrass' }), makeEnv(), h.deps);

  h.setModel(() => modelText(goodVerdicts));
  await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  assert.equal(h.modelCalls[0].model, MODELS.expand);
  assert.match(h.modelCalls[0].model, /sonnet/);
  assert.equal(h.modelCalls[1].model, MODELS.classify);
  assert.match(h.modelCalls[1].model, /haiku/);
});

test('/expand disables thinking; /classify leaves the model default', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));
  await handleRequest(post('/expand', { query: 'bluegrass' }), makeEnv(), h.deps);

  h.setModel(() => modelText(goodVerdicts));
  await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  // Measured decision, not a default — see proxy/README.md. Sonnet 5 thinks
  // whenever `thinking` is omitted, so dropping this line silently triples the
  // latency of every cache miss.
  assert.equal(h.modelCalls[0].thinking, 'disabled');
  // Haiku 4.5 has thinking off already; saying so explicitly would be noise.
  assert.equal(h.modelCalls[1].thinking, undefined);
});

test('/expand cache key ignores term order', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  await handleRequest(post('/expand', { query: 'vocaloid, vsinger, hololive' }), makeEnv(), h.deps);
  await h.flush();

  const reordered = await handleRequest(
    post('/expand', { query: 'vocaloid, hololive, vsinger' }),
    makeEnv(),
    h.deps,
  );

  assert.equal(h.modelCalls.length, 1, 'reordering terms must not buy a second expansion');
  assert.equal(reordered.headers.get('X-Cache'), 'HIT');
});

test('/expand merges the curated seeds when the query matches', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  const response = await handleRequest(
    post('/expand', { query: 'vocaloid, vsinger' }),
    makeEnv(),
    h.deps,
  );

  const body = await bodyOf(response);
  const names = body.adjacent.map((e: { name: string }) => e.name);

  assert.equal(
    response.headers.get('X-Seeds-Applied'),
    'chinese-virtual-singers,japanese-utaite-producers',
  );

  // Chinese scene
  assert.ok(names.includes('Luo Tianyi'));
  assert.ok(names.includes('VirtuaReal'));
  assert.ok(names.includes('A-SOUL'));

  // Japanese utaite / producers
  assert.ok(names.includes('Ado'));
  assert.ok(names.includes('Soraru'));
  assert.ok(names.includes('Kasane Teto'));
  assert.ok(names.includes('Project SEKAI'));

  // Generated entries survive alongside the seeded ones.
  assert.ok(names.includes('Hatsune Miku'));
});

test('a seeded entry keeps the kind its seed declares', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  const body = await bodyOf(
    await handleRequest(post('/expand', { query: 'utaite' }), makeEnv(), h.deps),
  );
  const kindOf = (name: string) =>
    body.adjacent.find((e: { name: string }) => e.name === name)?.kind;

  // Piapro and Project SEKAI are scene signals, not acts that get billed —
  // filing either as an artist would turn it into a wasted search query.
  assert.equal(kindOf('Project SEKAI'), 'context');
  assert.equal(kindOf('Piapro'), 'context');
  assert.equal(kindOf('Ado'), 'artist');
});

test('/expand does not merge a seed into an unrelated scene', async () => {
  const h = makeHarness();
  h.setModel(() =>
    modelText({
      scene: 'Appalachian string band music. Festivals and barn dances count.',
      core: ['bluegrass', 'old-time'],
      adjacent: [{ name: 'Billy Strings', kind: 'artist', why: 'headlines under this name' }],
    }),
  );

  const response = await handleRequest(
    post('/expand', { query: 'bluegrass, old-time fiddle' }),
    makeEnv(),
    h.deps,
  );

  const body = await bodyOf(response);
  assert.equal(body.adjacent.length, 1, 'an unrelated profile must not gain a seeded roster');
  assert.equal(response.headers.get('X-Seeds-Applied'), 'none');
});

test('/expand seeds do not duplicate generated entries', async () => {
  const h = makeHarness();
  h.setModel(() =>
    modelText({
      ...GOOD_PROFILE,
      adjacent: [
        ...GOOD_PROFILE.adjacent,
        { name: 'luo  tianyi', kind: 'artist', why: 'model already found her' },
      ],
    }),
  );

  const response = await handleRequest(
    post('/expand', { query: 'vocaloid' }),
    makeEnv(),
    h.deps,
  );

  const names = (await bodyOf(response)).adjacent.map((e: { name: string }) =>
    e.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );
  assert.equal(
    names.filter((n: string) => n === 'luotianyi').length,
    1,
    'differently-spelled duplicate must collapse',
  );
});

test('/expand applies seeds on a cache hit too', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  await handleRequest(post('/expand', { query: 'vocaloid' }), makeEnv(), h.deps);
  await h.flush();

  const second = await handleRequest(post('/expand', { query: 'vocaloid' }), makeEnv(), h.deps);

  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal(h.modelCalls.length, 1);
  // Seeds are merged after the cache read, so editing seeds.ts takes effect
  // without waiting out the 30-day TTL on every cached query.
  const names = (await bodyOf(second)).adjacent.map((e: { name: string }) => e.name);
  assert.ok(names.includes('Luo Tianyi'));
});

test('/expand drops malformed adjacent entries instead of passing them through', async () => {
  const h = makeHarness();
  h.setModel(() =>
    modelText({
      ...GOOD_PROFILE,
      adjacent: [
        { name: 'Hatsune Miku', kind: 'artist', why: 'real entry' },
        { name: 'Bad Kind', kind: 'venue', why: 'kind is not in the enum' },
        { name: 'No Why', kind: 'artist' },
        { kind: 'artist', why: 'no name' },
        'not an object',
        null,
      ],
    }),
  );

  const response = await handleRequest(post('/expand', { query: 'q' }), makeEnv(), h.deps);
  const body = await bodyOf(response);

  assert.equal(body.adjacent.length, 1);
  assert.equal(body.adjacent[0].name, 'Hatsune Miku');
  assert.equal(response.headers.get('X-Dropped-Entries'), '5');
});

test('/expand degrades to 502 when the model returns unparseable text', async () => {
  const h = makeHarness();
  h.setModel(() => ({ text: 'Sure! Here is your profile:', stopReason: 'end_turn' }));

  const response = await handleRequest(post('/expand', { query: 'q' }), makeEnv(), h.deps);

  assert.equal(response.status, 502);
  assert.match((await bodyOf(response)).error, /Expansion failed/);
});

test('/expand degrades to 502 when the model omits required fields', async () => {
  const h = makeHarness();
  h.setModel(() => modelText({ core: ['x'], adjacent: [] }));

  const response = await handleRequest(post('/expand', { query: 'q' }), makeEnv(), h.deps);
  assert.equal(response.status, 502);
});

test('/expand degrades to 502 on a truncated response', async () => {
  const h = makeHarness();
  h.setModel(() => ({ text: '{"scene":"cut off', stopReason: 'max_tokens' }));

  const response = await handleRequest(post('/expand', { query: 'q' }), makeEnv(), h.deps);
  assert.equal(response.status, 502);
  assert.match((await bodyOf(response)).error, /truncated/);
});

test('/expand cache hit does not call the model', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  await handleRequest(post('/expand', { query: 'vocaloid, hololive' }), makeEnv(), h.deps);
  await h.flush();
  assert.equal(h.modelCalls.length, 1);

  const second = await handleRequest(
    post('/expand', { query: 'vocaloid, hololive' }),
    makeEnv(),
    h.deps,
  );

  assert.equal(h.modelCalls.length, 1, 'second identical query must not re-expand');
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal((await bodyOf(second)).scene, GOOD_PROFILE.scene);
});

test('/expand normalizes the query before caching', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  await handleRequest(post('/expand', { query: 'Vocaloid,  Hololive' }), makeEnv(), h.deps);
  await h.flush();
  await handleRequest(post('/expand', { query: '  vocaloid, hololive  ' }), makeEnv(), h.deps);

  assert.equal(h.modelCalls.length, 1, 'case and spacing must share one cache entry');
});

test('/expand rejects an over-long query', async () => {
  const h = makeHarness();
  const response = await handleRequest(
    post('/expand', { query: 'x'.repeat(201) }),
    makeEnv(),
    h.deps,
  );
  assert.equal(response.status, 400);
  assert.equal(h.modelCalls.length, 0);
});

test('/expand rejects a missing query', async () => {
  const h = makeHarness();
  const response = await handleRequest(post('/expand', {}), makeEnv(), h.deps);
  assert.equal(response.status, 400);
});

// ----------------------------------------------------------------- /classify

const goodVerdicts = [
  { id: 'e1', band: 'STRONG', reason: 'names Miku Expo' },
  { id: 'e2', band: 'WEAK', reason: 'anime convention' },
  { id: 'e3', band: 'UNRELATED', reason: 'orchestral programme' },
];

test('/classify returns one verdict per submitted event', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(goodVerdicts));

  const response = await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(
    body.map((v: { id: string }) => v.id),
    ['e1', 'e2', 'e3'],
  );
  assert.equal(body[0].band, 'STRONG');
});

test('/classify fills a missing event with UNRELATED rather than dropping it', async () => {
  const h = makeHarness();
  h.setModel(() => modelText([goodVerdicts[0], goodVerdicts[2]])); // e2 omitted

  const response = await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  const body = await bodyOf(response);
  assert.equal(body.length, 3);
  const e2 = body.find((v: { id: string }) => v.id === 'e2');
  assert.equal(e2.band, 'UNRELATED');
  assert.match(e2.reason, /no verdict returned/);
});

test('/classify degrades to all-UNRELATED on unparseable model output', async () => {
  const h = makeHarness();
  h.setModel(() => ({ text: 'I cannot do that', stopReason: 'end_turn' }));

  const response = await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  assert.equal(response.status, 200, 'classification must not fail the request');
  const body = await bodyOf(response);
  assert.equal(body.length, 3);
  assert.ok(body.every((v: { band: string }) => v.band === 'UNRELATED'));
});

test('/classify degrades when the model call throws', async () => {
  const h = makeHarness();
  h.setModel(() => {
    throw new Error('upstream exploded');
  });

  const response = await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.length, 3);
  assert.match(body[0].reason, /classification unavailable/);
});

test('/classify cache hit does not call the model', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(goodVerdicts));

  await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );
  await h.flush();
  assert.equal(h.modelCalls.length, 1);

  const second = await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  assert.equal(h.modelCalls.length, 1);
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.equal(second.headers.get('X-Classified'), '0');
});

test('/classify only sends uncached events to the model', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(goodVerdicts));

  await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );
  await h.flush();

  h.setModel(() => modelText([{ id: 'e4', band: 'POSSIBLE', reason: 'new one' }]));

  const second = await handleRequest(
    post('/classify', {
      profile: GOOD_PROFILE,
      events: [...EVENTS, { id: 'e4', title: 'Kasane Teto Birthday Live' }],
    }),
    makeEnv(),
    h.deps,
  );

  assert.equal(h.modelCalls.length, 2);
  assert.match(h.modelCalls[1].user, /e4/);
  assert.doesNotMatch(h.modelCalls[1].user, /Anime Expo/, 'cached events must not be re-sent');
  assert.equal(second.headers.get('X-Classified'), '1');

  const body = await bodyOf(second);
  assert.equal(body.length, 4);
});

test('/classify does not cache placeholder verdicts', async () => {
  const h = makeHarness();
  h.setModel(() => modelText([goodVerdicts[0], goodVerdicts[2]])); // e2 never resolved

  await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );
  await h.flush();

  h.setModel(() => modelText([{ id: 'e2', band: 'WEAK', reason: 'resolved this time' }]));

  const second = await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  // e1 and e3 came from cache; e2 must be asked again rather than remembered
  // as UNRELATED forever.
  assert.equal(h.modelCalls.length, 2);
  assert.match(h.modelCalls[1].user, /Anime Expo/);
  const e2 = (await bodyOf(second)).find((v: { id: string }) => v.id === 'e2');
  assert.equal(e2.band, 'WEAK');
});

test('/classify keys the cache on the profile, not just the event', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(goodVerdicts));

  await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events: EVENTS }),
    makeEnv(),
    h.deps,
  );
  await h.flush();

  const otherProfile = { ...GOOD_PROFILE, scene: 'A completely different scene.' };
  await handleRequest(
    post('/classify', { profile: otherProfile, events: EVENTS }),
    makeEnv(),
    h.deps,
  );

  assert.equal(h.modelCalls.length, 2, 'a different profile must re-classify');
});

test('/classify caps events per request', async () => {
  const h = makeHarness();
  const events = Array.from({ length: 51 }, (_, i) => ({ id: `e${i}`, title: `Event ${i}` }));

  const response = await handleRequest(
    post('/classify', { profile: GOOD_PROFILE, events }),
    makeEnv(),
    h.deps,
  );

  assert.equal(response.status, 400);
  assert.equal(h.modelCalls.length, 0);
});

test('/classify rejects a malformed profile', async () => {
  const h = makeHarness();
  const response = await handleRequest(
    post('/classify', { profile: { scene: 'x' }, events: EVENTS }),
    makeEnv(),
    h.deps,
  );
  assert.equal(response.status, 400);
});

test('/classify rejects duplicate event ids', async () => {
  const h = makeHarness();
  const response = await handleRequest(
    post('/classify', {
      profile: GOOD_PROFILE,
      events: [{ id: 'e1', title: 'One' }, { id: 'e1', title: 'Two' }],
    }),
    makeEnv(),
    h.deps,
  );
  assert.equal(response.status, 400);
});

// -------------------------------------------------------------- rate limits

test('rate limiting triggers and reports Retry-After', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  // /expand allows 15 per minute.
  for (let i = 0; i < 15; i++) {
    const ok = await handleRequest(post('/expand', { query: `q${i}` }), makeEnv(), h.deps);
    assert.equal(ok.status, 200, `request ${i} should be allowed`);
    await h.flush();
  }

  const blocked = await handleRequest(post('/expand', { query: 'q16' }), makeEnv(), h.deps);

  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal(h.modelCalls.length, 15, 'a rate-limited request must not reach the model');
});

test('event routes allow at least ten full fan-out searches per minute', async () => {
  // Regression guard for the sizing, not the mechanism. A search is ~25
  // requests to Ticketmaster now; a flat limit sized for one-request searches
  // caps a user at under five searches a minute.
  const perSearch = { '/ticketmaster/events': 25, '/seatgeek/events': 15, '/serpapi/events': 3 };

  for (const [path, cost] of Object.entries(perSearch)) {
    const searches = ruleFor(path).limit / cost;
    assert.ok(
      searches >= 10,
      `${path} allows only ${searches} searches/min at ${cost} requests each`,
    );
  }
});

test('event routes are limited independently, not from one shared pool', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('{"events":[]}', { status: 200 }));

  // Exhausting one route must not lock a user out of the others — otherwise a
  // Ticketmaster-heavy fan-out would starve SeatGeek mid-search.
  const tmLimit = ruleFor('/ticketmaster/events').limit;
  for (let i = 0; i < tmLimit; i++) {
    await handleRequest(get(`/ticketmaster/events?keyword=k${i}`), makeEnv(), h.deps);
  }

  const blocked = await handleRequest(get('/ticketmaster/events?keyword=x'), makeEnv(), h.deps);
  const other = await handleRequest(get('/seatgeek/events?keyword=x'), makeEnv(), h.deps);

  assert.equal(blocked.status, 429);
  assert.equal(other.status, 200);
});

test('rate limit windows are per client', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  for (let i = 0; i < 15; i++) {
    await handleRequest(post('/expand', { query: `q${i}` }, '1.1.1.1'), makeEnv(), h.deps);
    await h.flush();
  }

  const blocked = await handleRequest(post('/expand', { query: 'x' }, '1.1.1.1'), makeEnv(), h.deps);
  const other = await handleRequest(post('/expand', { query: 'x' }, '2.2.2.2'), makeEnv(), h.deps);

  assert.equal(blocked.status, 429);
  assert.equal(other.status, 200);
});

test('rate limit window expires', async () => {
  const h = makeHarness();
  h.setModel(() => modelText(GOOD_PROFILE));

  for (let i = 0; i < 15; i++) {
    await handleRequest(post('/expand', { query: `q${i}` }), makeEnv(), h.deps);
    await h.flush();
  }
  assert.equal((await handleRequest(post('/expand', { query: 'x' }), makeEnv(), h.deps)).status, 429);

  h.advance(61_000);

  const after = await handleRequest(post('/expand', { query: 'x' }), makeEnv(), h.deps);
  assert.equal(after.status, 200);
});

// ------------------------------------------------------------- event routes

test('/ticketmaster/events proxies, trims, and never echoes the key', async () => {
  const h = makeHarness();
  h.setUpstream(
    () =>
      new Response(
        JSON.stringify({
          _embedded: { events: [{ id: 'tm1', name: 'Show' }] },
          page: { totalElements: 1 },
        }),
        { status: 200 },
      ),
  );

  const response = await handleRequest(
    get('/ticketmaster/events?keyword=miku&city=NYC&limit=5'),
    makeEnv(),
    h.deps,
  );

  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.doesNotMatch(raw, /test-tm/, 'the API key must never reach the client');
  assert.equal(JSON.parse(raw)._embedded.events.length, 1);
  assert.equal(JSON.parse(raw).page, undefined, 'upstream envelope should be trimmed');

  assert.match(h.upstreamCalls[0], /apikey=test-tm/);
  assert.match(h.upstreamCalls[0], /keyword=miku/);
  assert.match(h.upstreamCalls[0], /size=5/);
});

test('event routes forward only allowlisted params', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('{"events":[]}', { status: 200 }));

  await handleRequest(
    get('/seatgeek/events?keyword=miku&client_id=attacker&per_page=9999'),
    makeEnv(),
    h.deps,
  );

  assert.doesNotMatch(h.upstreamCalls[0], /attacker/);
  assert.doesNotMatch(h.upstreamCalls[0], /9999/);
  assert.match(h.upstreamCalls[0], /client_id=test-sg/);
});

test('event route cache hit does not call upstream', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('{"events":[{"id":1}]}', { status: 200 }));

  await handleRequest(get('/seatgeek/events?keyword=miku'), makeEnv(), h.deps);
  await h.flush();
  assert.equal(h.upstreamCalls.length, 1);

  const second = await handleRequest(get('/seatgeek/events?keyword=miku'), makeEnv(), h.deps);

  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(second.headers.get('X-Cache'), 'HIT');
});

test('upstream failure becomes a 502, not a crash', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('nope', { status: 503 }));

  const response = await handleRequest(get('/serpapi/events?q=miku'), makeEnv(), h.deps);

  assert.equal(response.status, 502);
  assert.equal((await bodyOf(response)).status, 503);
});

test('/serpapi/events still requires q', async () => {
  const h = makeHarness();
  const response = await handleRequest(get('/serpapi/events'), makeEnv(), h.deps);
  assert.equal(response.status, 400);
});

test('a missing secret is reported, not leaked', async () => {
  const h = makeHarness();
  const response = await handleRequest(
    get('/ticketmaster/events?keyword=x'),
    makeEnv({ TICKETMASTER_API_KEY: '' }),
    h.deps,
  );
  assert.equal(response.status, 500);
  assert.match((await bodyOf(response)).error, /TICKETMASTER_API_KEY/);
});

// --------------------------------------------------------------- transport

test('/health reports which secrets are set without revealing them', async () => {
  const h = makeHarness();
  const response = await handleRequest(
    get('/health'),
    makeEnv({ SEATGEEK_CLIENT_ID: '' }),
    h.deps,
  );

  const raw = await response.text();
  assert.doesNotMatch(raw, /test-/);
  const body = JSON.parse(raw);
  assert.equal(body.secrets.anthropic, true);
  assert.equal(body.secrets.seatgeek, false);
});

test('wrong method returns 405 and unknown path returns 404', async () => {
  const h = makeHarness();
  assert.equal((await handleRequest(get('/expand'), makeEnv(), h.deps)).status, 405);
  assert.equal((await handleRequest(get('/nope'), makeEnv(), h.deps)).status, 404);
});

test('CORS headers are present on every response, including errors', async () => {
  const h = makeHarness();

  const preflight = await handleRequest(
    new Request('https://proxy.test/expand', { method: 'OPTIONS' }),
    makeEnv(),
    h.deps,
  );
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('Access-Control-Allow-Origin'));

  const notFound = await handleRequest(get('/nope'), makeEnv(), h.deps);
  assert.ok(notFound.headers.get('Access-Control-Allow-Origin'));

  h.setModel(() => ({ text: 'garbage', stopReason: 'end_turn' }));
  const failed = await handleRequest(post('/expand', { query: 'q' }), makeEnv(), h.deps);
  assert.equal(failed.status, 502);
  assert.ok(failed.headers.get('Access-Control-Allow-Origin'));
});

test('oversized bodies are rejected before parsing', async () => {
  const h = makeHarness();
  const huge = 'x'.repeat(200 * 1024);
  const response = await handleRequest(
    new Request('https://proxy.test/expand', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ query: huge }),
    }),
    makeEnv(),
    h.deps,
  );

  assert.equal(response.status, 413);
  assert.equal(h.modelCalls.length, 0);
});

// ----------------------------------------------------- upstream spike arrest

test('retries a 429 and succeeds without surfacing a failure', async () => {
  const h = makeHarness();
  let calls = 0;
  // Ticketmaster enforces 5 requests/second and a fan-out sends it 25, so a
  // few 429s per search are expected rather than exceptional.
  h.setUpstream(() => {
    calls += 1;
    return calls === 1
      ? new Response('{"fault":{"faultstring":"Spike arrest violation"}}', { status: 429 })
      : new Response(JSON.stringify({ _embedded: { events: [{ id: 'tm1' }] } }), { status: 200 });
  });

  const response = await handleRequest(get('/ticketmaster/events?keyword=x'), makeEnv(), h.deps);

  assert.equal(response.status, 200);
  assert.equal(calls, 2, 'should have retried exactly once');
  assert.equal((await bodyOf(response))._embedded.events.length, 1);
});

test('backs off between attempts with jitter, not a fixed delay', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('rate limited', { status: 429 }));

  await handleRequest(get('/ticketmaster/events?keyword=x'), makeEnv(), h.deps);

  // A fan-out is ~25 near-simultaneous invocations; identical backoffs would
  // retry in lockstep and trip the same per-second limit again.
  assert.equal(h.sleeps.length, 2, 'two backoffs across three attempts');
  assert.ok(h.sleeps[0] >= 250 && h.sleeps[0] < 500, `first backoff ${h.sleeps[0]}`);
  assert.ok(h.sleeps[1] >= 700 && h.sleeps[1] < 1400, `second backoff ${h.sleeps[1]}`);
});

test('gives up after the attempt cap and reports the query that failed', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('still rate limited', { status: 429 }));

  const response = await handleRequest(
    get('/ticketmaster/events?keyword=DECO*27&city=Los+Angeles&limit=10'),
    makeEnv(),
    h.deps,
  );

  assert.equal(response.status, 502);
  const body = await bodyOf(response);
  assert.equal(body.status, 429);
  // The failing query is reported rather than left to be guessed at.
  assert.equal(body.query, 'DECO*27|Los Angeles|10');
  assert.equal(h.upstreamCalls.length, 3);
});

test('does not retry a status that will not change', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('bad request', { status: 400 }));

  const response = await handleRequest(get('/ticketmaster/events?keyword=x'), makeEnv(), h.deps);

  assert.equal(response.status, 502);
  // Retrying a 400 just burns quota — only transient statuses are retried.
  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(h.sleeps.length, 0);
});

test('special characters survive the app -> worker -> upstream hop intact', async () => {
  const h = makeHarness();
  h.setUpstream(() => new Response('{"_embedded":{"events":[]}}', { status: 200 }));

  // Verified against the live API: these all return results. The 502s were
  // spike arrest, never encoding.
  for (const keyword of ['DECO*27', 'AC/DC', 'Simon & Garfunkel', 'P!nk', "Rockin'on Japan"]) {
    h.upstreamCalls.length = 0;
    await handleRequest(
      new Request(`https://proxy.test/ticketmaster/events?keyword=${encodeURIComponent(keyword)}`, {
        headers: { 'CF-Connecting-IP': '9.9.9.9' },
      }),
      makeEnv(),
      h.deps,
    );

    const sent = new URL(h.upstreamCalls[0]).searchParams.get('keyword');
    assert.equal(sent, keyword, `keyword mangled: ${keyword} -> ${sent}`);
  }
});
