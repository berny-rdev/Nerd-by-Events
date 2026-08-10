/**
 * Structural validation of model output.
 *
 * Same stance the app's source adapters take: the model's response is data that
 * crossed a runtime boundary, so trust the value, never the shape you asked for.
 *
 * The two routes fail differently on purpose:
 *
 *   /expand   — a wrong top-level shape is a hard failure (there is nothing
 *               useful to return), but individual bad `adjacent` entries are
 *               dropped so one hallucinated `kind` doesn't cost the whole profile.
 *   /classify — never fails. Anything unparseable or missing becomes UNRELATED,
 *               because the app needs one verdict per event it submitted.
 */

import { cleanString } from './lib/http.ts';
import {
  BANDS,
  KINDS,
  type AdjacentEntry,
  type Band,
  type ClassifyEvent,
  type ExpansionProfile,
  type Kind,
  type Verdict,
} from './types.ts';

const MAX_SCENE = 2000;
const MAX_NAME = 120;
const MAX_WHY = 300;
const MAX_REASON = 200;
const MAX_CORE = 25;
/** Exported because seed merging has to respect the same ceiling. */
export const MAX_ADJACENT = 60;

function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function isBand(value: unknown): value is Band {
  return typeof value === 'string' && (BANDS as readonly string[]).includes(value);
}

export type ExpansionParse =
  | { ok: true; profile: ExpansionProfile; droppedEntries: number }
  | { ok: false; error: string };

/**
 * Validates a model-produced profile.
 *
 * `droppedEntries` is returned rather than logged so the route can surface it —
 * a model that keeps inventing kinds is a prompt problem you want to see.
 */
export function parseExpansion(value: unknown): ExpansionParse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'model did not return a JSON object' };
  }

  const candidate = value as Record<string, unknown>;

  const scene = cleanString(candidate.scene, MAX_SCENE);
  if (!scene) return { ok: false, error: 'model returned no scene' };

  if (!Array.isArray(candidate.adjacent)) {
    return { ok: false, error: 'model returned no adjacent array' };
  }

  const core = (Array.isArray(candidate.core) ? candidate.core : [])
    .map((entry) => cleanString(entry, MAX_NAME))
    .filter(Boolean)
    .slice(0, MAX_CORE);

  const adjacent: AdjacentEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const raw of candidate.adjacent) {
    if (typeof raw !== 'object' || raw === null) {
      dropped += 1;
      continue;
    }
    const entry = raw as Record<string, unknown>;

    const name = cleanString(entry.name, MAX_NAME);
    const why = cleanString(entry.why, MAX_WHY);

    // An unknown kind is the interesting failure: the ranking prompt branches on
    // it, so passing one through would silently mis-weight that entry.
    if (!name || !why || !isKind(entry.kind)) {
      dropped += 1;
      continue;
    }

    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) {
      dropped += 1;
      continue;
    }
    seen.add(dedupeKey);

    adjacent.push({ name, kind: entry.kind, why });
    if (adjacent.length >= MAX_ADJACENT) break;
  }

  if (adjacent.length === 0) {
    return { ok: false, error: 'model returned no usable adjacent entries' };
  }

  return { ok: true, profile: { scene, core, adjacent }, droppedEntries: dropped };
}

/** Validates a caller-supplied profile (the app posts one back to /classify). */
export function parseProfileInput(value: unknown): ExpansionProfile | null {
  const parsed = parseExpansion(value);
  return parsed.ok ? parsed.profile : null;
}

export const UNRESOLVED_REASON = 'no verdict returned for this event';

export type VerdictParse = {
  verdicts: Verdict[];
  /**
   * Ids the model actually returned a valid band for. Everything else got an
   * UNRELATED placeholder, and placeholders must never be cached — a transient
   * model failure would otherwise be remembered as a judgment forever.
   */
  resolved: Set<string>;
};

/**
 * Maps model output onto the events that were submitted.
 *
 * Matching is by id, never by position — a model that drops or reorders one
 * event would otherwise shift every later verdict onto the wrong event, which
 * is the kind of wrongness nobody notices until it has been shipped for a month.
 */
export function parseVerdicts(value: unknown, events: ClassifyEvent[]): VerdictParse {
  const byId = new Map<string, Record<string, unknown>>();

  if (Array.isArray(value)) {
    for (const raw of value) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (id) byId.set(id, entry);
    }
  }

  const resolved = new Set<string>();

  const verdicts = events.map((event) => {
    const entry = byId.get(event.id);
    if (!entry || !isBand(entry.band)) {
      return { id: event.id, band: 'UNRELATED' as const, reason: UNRESOLVED_REASON };
    }
    resolved.add(event.id);
    const reason = cleanString(entry.reason, MAX_REASON);
    return { id: event.id, band: entry.band, reason: reason || '(no reason given)' };
  });

  return { verdicts, resolved };
}

/** Every submitted event, all UNRELATED. Used when the model call fails outright. */
export function allUnresolved(events: ClassifyEvent[], reason: string): Verdict[] {
  return events.map((event) => ({ id: event.id, band: 'UNRELATED' as const, reason }));
}
