# scripts/ — dev tooling

Not part of the app. Nothing in `src/` imports anything here, and `scripts/` is
excluded from the app's `tsconfig.json`, so none of this can end up in a bundle.
That's what makes it safe to read a real Anthropic API key.

## score.ts — classification prompt harness

Scores fixture events against the taste profile and prints a table, so you can
iterate on the prompt and see what moved.

```bash
node scripts/score.ts            # one API call per event, 4 in flight
node scripts/score.ts --batch    # all events in a single call
node scripts/score.ts --help
```

Runs directly on Node 22 via native TypeScript type stripping — no `ts-node`,
no `tsx`, no build step. (That's also why the imports carry an explicit `.ts`
extension; Node requires it.)

**The prompt lives in `scripts/prompt.ts`.** Edit it there; `score.ts` is the
harness and shouldn't need to change while you tune wording.

### Setup

Add to `.env` at the repo root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

**No `EXPO_PUBLIC_` prefix.** Expo inlines every `EXPO_PUBLIC_*` variable into
the JS bundle at build time, so a key with that prefix would ship to every
device that installs the app. Without the prefix Metro never sees it, and only
Node scripts can read it.

The app's own env loading is a Metro/babel build-time transform, not a runtime
library, so there was nothing to reuse — the script uses Node's built-in
`process.loadEnvFile()` instead.

### Fixtures

`fixtures/profile.json` is **expansion output** — what a future expansion step
will produce from the user's tags. It is not a stored `TasteProfile` and will
not load as one (`core` is an echo of the input tags, not a profile field).

`fixtures/events.json` ships empty. Populate it with:

```json
[
  {
    "id": "tm-1",
    "title": "Hatsune Miku Expo 2026",
    "venue": "Radio City Music Hall",
    "description": "Optional. Passed to the model when present."
  }
]
```

Only `id` and `title` are required. **Ids matter in `--batch` mode** — the
response is matched back by id, not by position, so a model that drops or
reorders an event produces one "missing from batch response" row instead of
silently shifting every later verdict onto the wrong event.

### Reading the output

Rows are sorted STRONG → POSSIBLE → WEAK → UNRELATED, with `ERROR` last.

`ERROR` is a harness outcome, never something the model returned. It covers a
failed API call, a truncated response, a refusal, output that isn't JSON, or
JSON with the wrong shape. A failure on one event never aborts the run — same
degrade-don't-cascade stance as `src/sources/index.ts`.

### Comparing the two modes

Both modes use the **same** system prompt and the same band definitions; only
the envelope differs. That's deliberate — if they used different prompts, a
disagreement between them would tell you nothing about which prompt is better.

Batch is one call instead of N (cheaper, one shared context). Per-event is
independent judgments with no cross-contamination between listings. Run both on
the same fixtures and diff the bands.

## Notes

- Model is `claude-haiku-4-5-20251001`, pinned at the top of `score.ts`.
- Concurrency is capped at 4 (`CONCURRENCY` in `score.ts`).
- `max_tokens` is deliberately tight (512 per event). A rambling answer shows up
  as a visible `response truncated` row rather than a silent cost increase.
