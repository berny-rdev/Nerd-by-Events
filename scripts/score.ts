/**
 * Scratch harness for iterating on the event-classification prompt.
 *
 *   node scripts/score.ts            one API call per event, 4 at a time
 *   node scripts/score.ts --batch    all events in a single call
 *
 * Dev tooling. Nothing here is imported by the app, so it never reaches a
 * bundle — which is why it can hold a real Anthropic key.
 *
 * Runs directly on Node 22 (native TypeScript type stripping). No ts-node, no
 * tsx, no build step — which is also why imports below carry an explicit `.ts`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BANDS,
  buildBatchPrompt,
  buildEventPrompt,
  buildSystemPrompt,
  type Band,
  type ExpansionProfile,
  type FixtureEvent,
} from './prompt.ts';

const MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 4;
const TITLE_WIDTH = 44;

// `__dirname` does not exist in ES modules — derive it from import.meta.url so
// the script works regardless of the directory it's invoked from.
const HERE = dirname(fileURLToPath(import.meta.url));

type Row = {
  id: string;
  title: string;
  /** 'ERROR' is a harness outcome, not something the model can return. */
  band: Band | 'ERROR';
  reason: string;
};

/** Ordering for the printed table. Errors sort last so they don't hide. */
const BAND_ORDER: Record<Row['band'], number> = {
  STRONG: 0,
  POSSIBLE: 1,
  WEAK: 2,
  UNRELATED: 3,
  ERROR: 4,
};

// ---------------------------------------------------------------- fixtures

function readJson<T>(relativePath: string): T {
  const path = join(HERE, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    fail(`Could not read ${relativePath}: ${(error as Error).message}`);
  }
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------ client

function makeClient(): Anthropic {
  // The app's env loading is Expo/Metro-specific (EXPO_PUBLIC_* values are
  // inlined into the bundle by babel at build time), so there is nothing to
  // reuse in a plain Node process. Node's own .env loader is the equivalent.
  try {
    process.loadEnvFile(join(HERE, '..', '.env'));
  } catch {
    // No .env is fine as long as the key is exported some other way.
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    fail(
      'ANTHROPIC_API_KEY is not set.\n' +
        '  Add it to .env at the repo root:\n\n' +
        '      ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        '  Note the missing EXPO_PUBLIC_ prefix — that is deliberate. Expo inlines\n' +
        '  every EXPO_PUBLIC_* value into the app bundle, so a key with that prefix\n' +
        '  would ship to every device that installs the app.',
    );
  }

  return new Anthropic({ apiKey });
}

// ------------------------------------------------------------------ parsing

/** Pulls the text out of a response, ignoring any non-text blocks. */
function responseText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * The prompt asks for bare JSON, but models sometimes wrap it in a markdown
 * fence anyway. Stripping one is cheap; treating it as a parse failure would
 * make the harness noisier than the prompt actually is.
 */
function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return fenced ? fenced[1].trim() : text.trim();
}

function isBand(value: unknown): value is Band {
  return typeof value === 'string' && (BANDS as readonly string[]).includes(value);
}

type Verdict = { band: Band; reason: string };

function parseVerdict(value: unknown): Verdict | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isBand(candidate.band)) return null;
  const reason = typeof candidate.reason === 'string' ? candidate.reason.trim() : '';
  return { band: candidate.band, reason: reason || '(no reason given)' };
}

/** Turns any thrown value into a one-line row message. */
function describeError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return 'rate limited';
  if (error instanceof Anthropic.AuthenticationError) return 'API key rejected';
  if (error instanceof Anthropic.APIConnectionError) return 'connection failed';
  if (error instanceof Anthropic.APIError) return `API error ${error.status}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Non-`end_turn` stops that mean the body isn't the JSON we asked for. */
function stopProblem(message: Anthropic.Message): string | null {
  if (message.stop_reason === 'max_tokens') return 'response truncated (max_tokens)';
  if (message.stop_reason === 'refusal') return 'model declined to answer';
  return null;
}

// -------------------------------------------------------------- classifying

async function classifyOne(
  client: Anthropic,
  system: string,
  event: FixtureEvent,
): Promise<Row> {
  const base = { id: event.id, title: event.title };

  try {
    const message = await client.messages.create({
      model: MODEL,
      // A band plus one clause. Small on purpose — a cap this tight turns a
      // rambling answer into a visible truncation instead of a silent cost.
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: buildEventPrompt(event) }],
    });

    const problem = stopProblem(message);
    if (problem) return { ...base, band: 'ERROR', reason: problem };

    const raw = stripFence(responseText(message));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...base, band: 'ERROR', reason: `unparseable: ${truncate(raw, 60)}` };
    }

    const verdict = parseVerdict(parsed);
    if (!verdict) {
      return { ...base, band: 'ERROR', reason: `bad shape: ${truncate(raw, 60)}` };
    }

    return { ...base, ...verdict };
  } catch (error) {
    // One event failing must not take down the run — same reason the source
    // aggregator uses allSettled.
    return { ...base, band: 'ERROR', reason: describeError(error) };
  }
}

async function classifyBatch(
  client: Anthropic,
  system: string,
  events: FixtureEvent[],
): Promise<Row[]> {
  const errorRows = (reason: string): Row[] =>
    events.map((event) => ({ id: event.id, title: event.title, band: 'ERROR', reason }));

  try {
    const message = await client.messages.create({
      model: MODEL,
      // Scales with the event count; Haiku 4.5 caps at 64K output.
      max_tokens: Math.min(64_000, 512 + events.length * 160),
      system,
      messages: [{ role: 'user', content: buildBatchPrompt(events) }],
    });

    const problem = stopProblem(message);
    if (problem) return errorRows(problem);

    const raw = stripFence(responseText(message));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return errorRows(`unparseable batch: ${truncate(raw, 60)}`);
    }

    if (!Array.isArray(parsed)) return errorRows('batch response was not an array');

    // Match on id rather than position — a model that drops or reorders one
    // event would otherwise shift every later verdict onto the wrong event,
    // which is exactly the kind of silent wrongness you'd never spot in a table.
    const byId = new Map<string, unknown>();
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null) {
        const id = (entry as Record<string, unknown>).id;
        if (typeof id === 'string') byId.set(id, entry);
      }
    }

    return events.map((event) => {
      const entry = byId.get(event.id);
      if (entry === undefined) {
        return {
          id: event.id,
          title: event.title,
          band: 'ERROR' as const,
          reason: 'missing from batch response',
        };
      }
      const verdict = parseVerdict(entry);
      return verdict
        ? { id: event.id, title: event.title, ...verdict }
        : { id: event.id, title: event.title, band: 'ERROR' as const, reason: 'bad shape in batch' };
    });
  } catch (error) {
    return errorRows(describeError(error));
  }
}

// ------------------------------------------------------------- concurrency

/**
 * Fixed pool of `limit` workers pulling from a shared cursor. `task` is
 * expected never to throw — classifyOne already converts failures into rows.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ------------------------------------------------------------------ output

function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function printTable(rows: Row[]): void {
  const sorted = [...rows].sort(
    (a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || a.title.localeCompare(b.title),
  );

  const titles = sorted.map((row) => truncate(row.title, TITLE_WIDTH));
  const titleWidth = Math.max(5, ...titles.map((t) => t.length));
  const bandWidth = Math.max(4, ...sorted.map((row) => row.band.length));

  const line = (title: string, band: string, reason: string) =>
    `${title.padEnd(titleWidth)}  ${band.padEnd(bandWidth)}  ${reason}`;

  console.log('');
  console.log(line('EVENT', 'BAND', 'REASON'));
  console.log('─'.repeat(titleWidth + bandWidth + 4 + 40));
  sorted.forEach((row, index) => {
    console.log(line(titles[index], row.band, truncate(row.reason, 80)));
  });
}

function printSummary(rows: Row[], mode: string, elapsedMs: number): void {
  const counts = new Map<Row['band'], number>();
  for (const row of rows) counts.set(row.band, (counts.get(row.band) ?? 0) + 1);

  const parts = (['STRONG', 'POSSIBLE', 'WEAK', 'UNRELATED', 'ERROR'] as const)
    .filter((band) => counts.has(band))
    .map((band) => `${band} ${counts.get(band)}`);

  console.log('');
  console.log(`${mode} · ${rows.length} events · ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(parts.join('  ·  '));
  console.log('');
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  node scripts/score.ts            one call per event, ${CONCURRENCY} at a time
  node scripts/score.ts --batch    all events in a single call

  Edit the prompt in scripts/prompt.ts.
  Fixtures: scripts/fixtures/profile.json, scripts/fixtures/events.json
`);
    return;
  }

  const batch = args.includes('--batch');

  const profile = readJson<ExpansionProfile>('fixtures/profile.json');
  const events = readJson<FixtureEvent[]>('fixtures/events.json');

  if (!Array.isArray(events)) fail('fixtures/events.json must contain an array.');

  if (events.length === 0) {
    console.log(`
  scripts/fixtures/events.json is empty — nothing to score.

  Populate it with objects shaped like:

      [
        {
          "id": "tm-1",
          "title": "Hatsune Miku Expo 2026",
          "venue": "Radio City Music Hall",
          "description": "..."
        }
      ]

  Only "id" and "title" are required.
`);
    return;
  }

  const withoutId = events.filter((event) => typeof event?.id !== 'string' || !event.id);
  if (withoutId.length > 0) {
    fail(`${withoutId.length} event(s) in events.json have no "id". Ids key the batch response.`);
  }

  const client = makeClient();
  const system = buildSystemPrompt(profile);

  const startedAt = Date.now();
  const rows = batch
    ? await classifyBatch(client, system, events)
    : await mapWithConcurrency(events, CONCURRENCY, (event) => classifyOne(client, system, event));
  const elapsed = Date.now() - startedAt;

  printTable(rows);
  printSummary(rows, batch ? `batch (1 call)` : `per-event (${events.length} calls)`, elapsed);
}

main().catch((error) => {
  // Anything reaching here is a harness bug, not a classification failure.
  console.error(error);
  process.exit(1);
});
