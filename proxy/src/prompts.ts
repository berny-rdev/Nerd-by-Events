/**
 * Prompt text for /expand and /classify.
 *
 * Kept in one file so it can be edited without touching routing, caching, or
 * validation. The classification prompt started life as `scripts/prompt.ts` in
 * the app repo — see proxy/README.md for the drift warning.
 */

import type { AdjacentEntry, ExpansionProfile } from './types.ts';

// ------------------------------------------------------------------ expand

/**
 * One abridged worked example, in a deliberately unrelated scene.
 *
 * It used to be the virtual-singer profile — the same query the reference
 * fixture covers. That made the prompt's own "this is a different query"
 * claim false, and it meant any calibration run against that query was
 * measuring how well the model copies an answer it was handed rather than how
 * well it expands. It also gave the model a reason to reach past the obvious
 * names, since they were already on the page.
 *
 * Drum and bass maps onto the same four kinds — label rosters whose artists are
 * billed individually, branded event series, scene-context terms — so it pins
 * shape without pinning names.
 */
const EXPANSION_EXAMPLE = `Query: "drum and bass, jungle"

{
  "scene": "UK drum and bass and jungle: producers and DJs who play club nights and festival stages, plus the label showcases and sound-system events built around them. Relevant events are club nights, festival sets, label showcases, and arena shows — not general EDM festivals, house or techno nights, or 90s rave nostalgia events that merely share an audience.",
  "core": ["drum and bass", "jungle"],
  "adjacent": [
    {"name": "Andy C", "kind": "artist", "why": "headline DJ; billed under this exact name"},
    {"name": "Goldie", "kind": "artist", "why": "founding jungle producer who still plays billed live sets"},
    {"name": "Chase & Status", "kind": "artist", "why": "duo that tours under this exact billing, so the ampersand is correct here"},
    {"name": "Sub Focus", "kind": "artist", "why": "producer who headlines his own arena and festival shows"},
    {"name": "Hospitality", "kind": "event", "why": "Hospital Records' club and festival series; listings use this name directly"},
    {"name": "Rampage", "kind": "event", "why": "large annual drum and bass and dubstep event"},
    {"name": "Hospital Records", "kind": "agency", "why": "label; its artists are billed individually, not under the label name"},
    {"name": "RAM Records", "kind": "agency", "why": "label whose roster headlines events under their own names"},
    {"name": "Metalheadz", "kind": "agency", "why": "Goldie's label and long-running club night roster"},
    {"name": "UKF", "kind": "context", "why": "media brand associated with the scene; signals adjacency in a listing"},
    {"name": "Rinse FM", "kind": "context", "why": "station tied to the scene rather than an act that gets billed"}
  ]
}`;

export const EXPANSION_SYSTEM = `You turn a short free-text description of someone's taste into a structured profile. That profile is used to search event listings for them and to rank what comes back, so it has to be made of things that actually appear in listings.

# Output

Reply with JSON and nothing else. No prose before or after, no markdown fence.

{"scene": "...", "core": ["..."], "adjacent": [{"name": "...", "kind": "...", "why": "..."}]}

## scene

One paragraph doing two jobs:

1. Name the specific scene the user's terms belong to.
2. Say which kinds of events count, and name the near-miss categories that do NOT — the adjacent things a search will surface that share an audience without being this.

The listings being searched are ticketed real-world events, so describe what counts in those terms — shows, concerts, club nights, festival sets, tours, fan-run gatherings. Online-only things like streams, broadcasts, and video releases are not events and should not be described as ones.

Work from the narrowest category that contains the user's terms. Do not generalize upward. If the terms are all one subgenre, the scene is that subgenre, not the parent genre and not "music". Someone who says "bluegrass, old-time fiddle" wants a string-band scene, not "folk", and definitely not "live music". Over-generalizing here is the single worst failure you can make: it makes everything match, which makes the ranking useless.

If the terms span genuinely unrelated things, describe the narrowest scene that honestly contains them rather than inventing a common ancestor. If they span two scenes, say so.

## core

The user's own terms, cleaned up — corrected spelling, expanded obvious abbreviations, deduplicated. Do not add anything of your own here. This is an echo of the input, not a contribution.

## adjacent

Names worth searching for, or worth recognising inside a listing. Each entry carries a "kind" that tells the ranking step how the name behaves in an event listing:

- "artist" — a performer, act, band, producer, or character billed on stage. EXPECT these in listing titles.
- "event" — a recurring event, series, festival, or tour brand. EXPECT these in listing titles.
- "agency" — a label, agency, collective, or roster **of performers**. Members are billed under their OWN names, so the agency name RARELY appears in a title. It signals scene membership.
- "context" — a medium, platform, publisher, game, storefront, or piece of surrounding culture. Also RARELY in titles; also signals membership.

**Telling "agency" from "context".** Ask what the thing has. An agency has a roster of people or acts who get billed. Context has a product, a platform, or an audience. A company that makes software, a voicebank, a game, or a streaming service is "context" even though it is a company — the software does not get billed on a poster, and its maker does not send performers to a venue. If you cannot name a performer the organization sends to events, it is not an agency.

**"event" entries must not contradict the scene paragraph.** You have just named the near-miss categories that do not count. Do not then list one of them as an event. A general convention, expo, or multi-genre festival that merely contains some of this music among many other things is exactly the near-miss you excluded — naming it here would tell the ranking step to treat it as a match. Only list an event whose billing is this scene.

## Choosing "artist" entries

These carry the most weight, so spend the most care here.

Prefer acts that headline billed live events under a name that appears in a listing: producers and composers who perform their own material, vocalists and singers who tour, characters with their own concert series, and solo acts with their own billing.

Producers, composers and touring vocalists are the highest-value entries in most scenes. They tour under their own names, they sell tickets, and they are the entries a search is most likely to convert into a real listing. Reach for them first.

Write the name exactly as a ticketing site would print it — the full billed name, not a nickname or shortened form. A search for a partial name matches the wrong things or nothing.

Avoid:

- Characters or personas that exist mainly as software, a voicebank, a game asset, or a fan derivative, and do not headline events under that name. Being well known inside the fandom is not the test — getting billed on a poster is.
- Names joined with a slash, an ampersand, or "and" when that is not how the act is actually billed. A listing string will not contain "X/Y". If a pair genuinely tours under a joined name, use the exact string a ticketing site would print; otherwise pick the one that gets billed, or list them as separate entries.
- Names that only appear in fandom discussion, credits, or liner notes rather than on a bill.

**Two ways of padding that look like recall but are not.** Both produce long lists of real names that return nothing when searched:

- Listing many individual members of one agency, label, or group roster. Most roster members do not have their own billed events. Name the agency once as an "agency" entry and move on; include an individual member only if that specific person headlines events under their own name.
- Listing many variants from one product family — sibling characters, voicebank versions, model numbers. One or two that genuinely headline is right; eight is padding.

If you notice half your artist entries share one roster or one product family, you have gone deep where you should have gone wide. Delete them and reach into other parts of the scene instead: producers, regional or national sub-scenes, older and newer waves, adjacent genres that share bills.

# Rules

- Aim for 20-25 adjacent entries, reached by **breadth across the scene** — different acts, eras, regions, sub-scenes, and event series. Never by depth into one roster or one product family. If you can only reach the target by padding, return fewer good entries instead: twelve names that each convert into a real listing beat twenty-five that do not.

- **Optimize for recall.** The two failure modes are not symmetric. Every "artist" and "event" entry becomes a literal search query against ticketing APIs downstream, so a name you leave out means that act's events are never fetched at all — no later ranking step can recover them. A name that turns out to be marginal costs one wasted query and gets filtered out by ranking. When you are weighing whether something belongs, include it.

- Recall is not licence to guess. Every name must be a real act, series, organization, or platform you are confident exists. The judgement call to make generously is "is this central enough?" — not "is this real?". Include what you are confident is real but unsure is central; exclude anything you are not confident is real.

- "why" is one clause. Say what the thing is and how it shows up in a listing. Write it for a reader deciding whether an event matches, not as a description of the artist.

- Cover every kind the scene actually has. Omit a kind rather than padding it, but do not let a thin "context" list stop you reaching the target on "artist".

- Prefer names likely to appear in ticketing data over names known only inside the fandom.

# Example

The example below is for a DIFFERENT query, in a DIFFERENT scene, than the one you will be given. Use it for the JSON shape, the four kinds, and the register of a "why" clause. It is deliberately abridged — it is **not** a length target, and the entry count you should aim for is the one in the rules above, not the one shown here. Never reuse its names; produce the equivalent for whatever scene your query describes.

${EXPANSION_EXAMPLE}`;

export function buildExpansionUser(query: string): string {
  return `Query: "${query}"\n\nProduce the profile.`;
}

// ---------------------------------------------------------------- classify

function renderEntries(entries: AdjacentEntry[]): string {
  return entries.length === 0
    ? '(none given)'
    : entries.map((entry) => `- ${entry.name} — ${entry.why}`).join('\n');
}

function groupByKind(adjacent: AdjacentEntry[]): Record<AdjacentEntry['kind'], AdjacentEntry[]> {
  const groups: Record<AdjacentEntry['kind'], AdjacentEntry[]> = {
    artist: [],
    event: [],
    agency: [],
    context: [],
  };
  for (const entry of adjacent) groups[entry.kind].push(entry);
  return groups;
}

/**
 * The profile is identical for every event in a request, so it goes in the
 * system prompt and the events go in the user turn.
 */
export function buildClassifySystem(profile: ExpansionProfile): string {
  const groups = groupByKind(profile.adjacent);

  return `You classify live-event listings by how relevant they are to one person's taste.

# The scene

${profile.scene}

Their own terms: ${profile.core.join(', ') || '(none given)'}

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
event series above, or it plainly describes this kind of performance.

POSSIBLE — real signals point at this scene, but confirmation is missing. A
performer who may belong to one of the agencies, or an act you cannot place.

WEAK — the listing overlaps this audience without being this thing. Same crowd,
different event.

UNRELATED — no connection.

Judge the event, not the audience. Two events sharing an audience are not the same
event. Equally, a solo show by someone in this scene is STRONG even if nothing in
the title names the scene.

Do not invent facts about a performer you do not recognise. If you cannot place a
name, that uncertainty is what POSSIBLE is for.

# Output

Reply with JSON and nothing else. No prose before or after, no markdown fence.

[{"id": "...", "band": "STRONG" | "POSSIBLE" | "WEAK" | "UNRELATED", "reason": "one short clause"}]

Return one object per event, carrying that event's id exactly as given. The reason
is one short clause naming the specific evidence you used — for example "headline
act is on the Hololive roster" or "anime convention, no music billing". Do not
write a sentence, and do not restate the band name.`;
}

export function buildClassifyUser(events: { id: string; title: string; venue?: string; description?: string }[]): string {
  const rendered = events
    .map((event) =>
      [
        `<event id="${event.id}">`,
        `Title: ${event.title}`,
        `Venue: ${event.venue || '(not given)'}`,
        `Description: ${event.description || '(not given)'}`,
        `</event>`,
      ].join('\n'),
    )
    .join('\n\n');

  return `${rendered}

Classify every event above. Return exactly ${events.length} object${
    events.length === 1 ? '' : 's'
  }, in the same order, each carrying its event's id. Judge each event independently;
do not let one event's band influence another's.`;
}
