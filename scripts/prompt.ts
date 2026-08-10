/**
 * Classification prompt for the taste-profile relevance scorer.
 *
 * This file is the thing you iterate on. `score.ts` is the harness and should
 * not need to change while you tune wording here.
 *
 * Dev tooling only — nothing in `scripts/` is imported by the app, so none of
 * this ever reaches a bundle.
 */

/** Shape of scripts/fixtures/profile.json — expansion output, not a stored TasteProfile. */
export type ExpansionProfile = {
  scene: string;
  /** Echo of the user's input tags. Not a profile field. */
  core: string[];
  adjacent: AdjacentEntry[];
};

export type AdjacentEntry = {
  name: string;
  kind: 'artist' | 'event' | 'agency' | 'context';
  why: string;
};

/** Shape of scripts/fixtures/events.json. */
export type FixtureEvent = {
  id: string;
  title: string;
  venue?: string;
  description?: string;
};

export const BANDS = ['STRONG', 'POSSIBLE', 'WEAK', 'UNRELATED'] as const;
export type Band = (typeof BANDS)[number];

/**
 * Groups the adjacent list by kind so the prompt can say something different
 * about each group. Lumping them together is what produces the classic failure:
 * the model looks for "Hololive" in a title, doesn't find it, and calls a
 * Hololive member's solo concert unrelated.
 */
function groupByKind(adjacent: AdjacentEntry[]): Record<AdjacentEntry['kind'], AdjacentEntry[]> {
  const groups: Record<AdjacentEntry['kind'], AdjacentEntry[]> = {
    artist: [],
    event: [],
    agency: [],
    context: [],
  };
  for (const entry of adjacent) groups[entry.kind]?.push(entry);
  return groups;
}

function renderEntries(entries: AdjacentEntry[]): string {
  return entries.map((entry) => `- ${entry.name} — ${entry.why}`).join('\n');
}

/**
 * The profile is identical for every event in a run, so it lives in the system
 * prompt: stable prefix first, per-event content in the user turn. That's also
 * the shape prompt caching wants if this ever runs at volume.
 */
export function buildSystemPrompt(profile: ExpansionProfile): string {
  const groups = groupByKind(profile.adjacent);

  return `You classify live-event listings by how relevant they are to one person's music taste.

# The scene

${profile.scene}

# Names that signal this scene

The four groups below behave differently in event listings. Read them differently.

## Artists — expect these to appear in listing titles
An event titled with one of these names, or billing one of them, is about this scene.

${renderEntries(groups.artist)}

## Event series — expect these to appear in listing titles
These are recurring branded events. Listings use the name directly.

${renderEntries(groups.event)}

## Agencies — these indicate scene membership but rarely appear in titles
An act can belong to one of these without the agency's name appearing anywhere in
the listing. Members perform and are billed under their own individual names. Do
not require the agency name to be present. If a listing names a performer you
recognise as belonging to one of these, that counts.

${renderEntries(groups.agency)}

## Context terms — these indicate scene membership but rarely appear in titles
These describe the medium, the platform, or the surrounding culture rather than
naming a performer. Treat them as evidence a listing belongs to the scene, not as
things to match against the title.

${renderEntries(groups.context)}

# Bands

STRONG — the listing is unmistakably an event in this scene. It names an artist or
event series above, or it plainly describes a virtual-singer / Vocaloid / VTuber
music performance.

POSSIBLE — real signals point at this scene, but confirmation is missing. A
performer who may be an agency member, a producer or utaite you cannot place, a
doujin or synth-music night with no named acts.

WEAK — the listing overlaps this audience without being this music. A general anime
convention that happens to have a music track, a J-pop or city-pop night, an
idol event outside the virtual-singer world.

UNRELATED — no connection.

Judge the event, not the audience. An anime convention is not a virtual-singer
concert just because the same people attend both. Equally, a solo concert by a
VTuber musician is STRONG even if nothing in the title says "VTuber".

Do not invent facts about a performer you do not recognise. If you cannot place a
name, that uncertainty is what POSSIBLE is for.

# Output

Reply with JSON and nothing else. No prose before or after, no markdown fence.

{"band": "STRONG" | "POSSIBLE" | "WEAK" | "UNRELATED", "reason": "one short clause"}

The reason is one short clause naming the specific evidence you used — for example
"headline act is a Hololive member" or "anime convention, no music billing". Do not
write a sentence, and do not restate the band name.`;
}

/** One event, as the user turn. */
export function buildEventPrompt(event: FixtureEvent): string {
  return [
    `Title: ${event.title}`,
    `Venue: ${event.venue ?? '(not given)'}`,
    `Description: ${event.description ?? '(not given)'}`,
    '',
    'Classify this event.',
  ].join('\n');
}

/**
 * Batch mode: every event in one call.
 *
 * Deliberately the same system prompt and the same band definitions as single
 * mode — the only difference is the envelope. Otherwise a disagreement between
 * the two modes tells you nothing about which prompt is better.
 */
export function buildBatchPrompt(events: FixtureEvent[]): string {
  const rendered = events
    .map((event) =>
      [
        `<event id="${event.id}">`,
        `Title: ${event.title}`,
        `Venue: ${event.venue ?? '(not given)'}`,
        `Description: ${event.description ?? '(not given)'}`,
        `</event>`,
      ].join('\n'),
    )
    .join('\n\n');

  return `${rendered}

Classify every event above. Reply with JSON and nothing else — a single array, one
object per event, in the same order, each carrying the event's id:

[{"id": "...", "band": "...", "reason": "..."}]

Return exactly ${events.length} object${events.length === 1 ? '' : 's'}. Judge each
event independently; do not let one event's band influence another's.`;
}
