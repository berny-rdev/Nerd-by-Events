/**
 * Curated supplements merged into expansion output.
 *
 * Prompt tuning cannot summon names a model does not have. Where a scene is
 * real, well documented, and measurably absent from model recall, the names are
 * supplied here instead.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — read before adding a third seed
 *
 * This is NOT a curated database, and the system must not be described as one.
 * Two seeds exist because two specific gaps were measured on the query
 * "vocaloid, vsinger, hololive":
 *
 *   chinese-virtual-singers    Neither Haiku 4.5 nor Sonnet 5 returned a single
 *                              entry from the Chinese ecosystem — not the
 *                              Vsinger roster, not VirtuaReal, not A-SOUL.
 *   japanese-utaite-producers  Sonnet reached the instrumental producers
 *                              (livetune, Giga, Mitchie M) but none of the
 *                              singers who came up through Niconico.
 *
 * Every other query gets pure generated output. The bar for adding a seed is a
 * measured recall failure against a reviewed reference — not "these names would
 * be nice to have". Curating by hand does not scale across scenes, and a seed
 * list that grows by taste becomes a stale, half-maintained directory that
 * quietly overrides a model which may since have improved.
 *
 * ---------------------------------------------------------------------------
 * EDITING
 *
 * This file is data. Adding a seed needs no change to prompts, routes, or
 * caching. To add one:
 *
 *   1. Append a Seed with a stable `id`.
 *   2. List `triggers` — lowercased substrings. If any appears in the user's
 *      query OR in the generated scene paragraph, the seed applies.
 *   3. Write entries to the same bar as the prompt asks of the model: real
 *      names, billed as a listing would print them, one clause of `why`.
 *
 * Seeds are applied on every response, *after* the cache read — so an edit here
 * takes effect immediately and does not require invalidating cached expansions.
 * ---------------------------------------------------------------------------
 */

import type { AdjacentEntry, ExpansionProfile } from './types.ts';

export type Seed = {
  id: string;
  /** For whoever edits this file. Never sent to a model. */
  description: string;
  /**
   * Lowercased substrings. Any hit in the query or the generated scene applies
   * the seed. Keep them specific — a trigger that fires too broadly attaches an
   * unrelated scene to somebody's profile.
   */
  triggers: string[];
  entries: AdjacentEntry[];
};

export const SEEDS: Seed[] = [
  {
    id: 'chinese-virtual-singers',
    description:
      'Chinese Vocaloid / virtual-singer scene. Absent from both Haiku and Sonnet output as of the last calibration run.',
    triggers: [
      'vocaloid',
      'vsinger',
      'v-singer',
      'virtual singer',
      'virtual idol',
      'vtuber',
      'virtual youtuber',
      'hololive',
      'nijisanji',
      'utaite',
      'voice synthesis',
      'synthesizer v',
      'bilibili',
      'luo tianyi',
    ],
    entries: [
      {
        name: 'Luo Tianyi',
        kind: 'artist',
        why: 'the central Chinese Vocaloid; headlines her own concerts under this name',
      },
      {
        name: 'Yuezheng Ling',
        kind: 'artist',
        why: 'Chinese Vocaloid billed on Vsinger concert lineups',
      },
      {
        name: 'Yuezheng Longya',
        kind: 'artist',
        why: 'Chinese Vocaloid from the same roster, appears on shared concert bills',
      },
      {
        name: 'Yanhe',
        kind: 'artist',
        why: 'Chinese Vocaloid billed on Vsinger concert lineups',
      },
      {
        name: 'Xingchen',
        kind: 'artist',
        why: 'Chinese virtual singer appearing in concert programmes for this scene',
      },
      {
        name: 'Hanser',
        kind: 'artist',
        why: 'Chinese virtual singer with an independent following; performs under this name',
      },
      {
        name: 'Vsinger Live',
        kind: 'event',
        why: 'concert series for the Vsinger roster; listings use this name directly',
      },
      {
        name: 'Bilibili Macro Link',
        kind: 'event',
        why: 'annual Bilibili live event with virtual-singer and virtual-idol stages',
      },
      {
        name: 'Vsinger',
        kind: 'agency',
        why: 'brand behind the Chinese Vocaloid roster; its characters are billed individually',
      },
      {
        name: 'VirtuaReal',
        kind: 'agency',
        why: 'Chinese VTuber collective; members perform under their own names',
      },
      {
        name: 'A-SOUL',
        kind: 'agency',
        why: 'Chinese virtual idol group whose members are billed individually',
      },
      {
        name: 'Bilibili',
        kind: 'context',
        why: 'platform this scene is built on; signals adjacency rather than naming an act',
      },
    ],
  },
  {
    id: 'japanese-utaite-producers',
    description:
      'Japanese utaite and the producers who tour as vocalists. Sonnet reaches the instrumental producers (livetune, Giga, Mitchie M) but not the singers who came up through Niconico.',
    triggers: [
      'vocaloid',
      'vsinger',
      'v-singer',
      'virtual singer',
      'utaite',
      'hololive',
      'nijisanji',
      'vtuber',
      'virtual youtuber',
      'niconico',
      'nico nico',
      'hatsune miku',
      'voice synthesis',
      'synthesizer v',
      'project sekai',
    ],
    entries: [
      {
        name: 'Ado',
        kind: 'artist',
        why: 'came up as an utaite singing Vocaloid-producer material; headlines arena tours under this name',
      },
      {
        name: 'Eve',
        kind: 'artist',
        why: 'Vocaloid-scene producer and vocalist who headlines his own live shows',
      },
      {
        name: 'Soraru',
        kind: 'artist',
        why: 'utaite known for Vocaloid cover arrangements; performs billed live shows',
      },
      {
        name: 'Mafumafu',
        kind: 'artist',
        why: 'utaite bridging Vocaloid production and live vocal performance; has headlined major venues',
      },
      {
        name: 'Neru',
        kind: 'artist',
        why: 'Vocaloid producer whose material appears at producer-led lives and showcases',
      },
      {
        name: 'Kasane Teto',
        kind: 'artist',
        why: 'UTAU-origin virtual singer with a large independent following; appears on concert bills',
      },
      {
        name: 'Project SEKAI',
        kind: 'context',
        why: 'rhythm game built on Vocaloid music; signals scene adjacency in a listing',
      },
      {
        name: 'Piapro',
        kind: 'context',
        why: 'community platform where much of this music originates; not an act that gets billed',
      },
    ],
  },
];

/** Same normalization the deduper uses, so "DECO*27" and "deco27" collide. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export type SeedResult = {
  profile: ExpansionProfile;
  /** Ids of the seeds that fired, for the response header. */
  applied: string[];
  /** Entries actually added after deduping against generated ones. */
  added: number;
};

/**
 * Merges any seed whose triggers match into the profile.
 *
 * Two rules:
 *  - A seed only applies when the query or the generated scene plausibly covers
 *    it. Merging unconditionally would staple a Chinese virtual-singer roster
 *    onto somebody's bluegrass profile.
 *  - Generated entries win on collision. The model's `why` is written for the
 *    scene it actually described; a seed's is generic by construction.
 */
export function applySeeds(
  profile: ExpansionProfile,
  query: string,
  maxEntries: number,
  seeds: Seed[] = SEEDS,
): SeedResult {
  const haystack = `${query} ${profile.scene}`.toLowerCase();
  const seen = new Set(profile.adjacent.map((entry) => normalizeName(entry.name)));

  const adjacent = [...profile.adjacent];
  const applied: string[] = [];
  let added = 0;

  for (const seed of seeds) {
    if (!seed.triggers.some((trigger) => haystack.includes(trigger))) continue;
    applied.push(seed.id);

    for (const entry of seed.entries) {
      if (adjacent.length >= maxEntries) break;
      const key = normalizeName(entry.name);
      if (seen.has(key)) continue;
      seen.add(key);
      adjacent.push(entry);
      added += 1;
    }
  }

  return { profile: { ...profile, adjacent }, applied, added };
}
