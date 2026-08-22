/**
 * The 30-book synthetic fixture library (librarian engine plan §4).
 *
 * A deterministic, offline library used to test structured search, semantic
 * ranking, and the librarian agent loop without ever touching a real ABS
 * instance or an LLM. This is a *reusable production-source export* — Phase 4
 * (the agent loop) imports `FIXTURE_BOOKS`/`fixtureBook` directly — which is
 * why it lives under `src/` rather than being a test-local helper.
 *
 * Treat additions as additive only: later work orders assert ranked orderings
 * and exact ids (`fx-01` … `fx-30`) against this data, so existing ids,
 * tags, and entities must not change shape.
 *
 * ── Clusters ─────────────────────────────────────────────────────────────
 * - **M** (`fx-01`..`fx-03`) — "melancholic coastal autumn" vibe-regression
 *   target. `fx-01` "The Lighthouse at Bell Harbor" matches all three facets
 *   (melancholic + coastal-town + autumn) and must be the unambiguous
 *   strongest hit for that query. `fx-02` "Saltmarsh Elegy" is missing the
 *   `autumn` facet; `fx-03` "Autumn Tide" is missing the `melancholic` facet.
 * - **S** (`fx-10`..`fx-14`) — space opera / military SF negative set (tense,
 *   fast-paced, political — must NOT rank near the top of a melancholic-
 *   coastal query). `fx-13` "The Ember Armada" is the anchor book that also
 *   carries `structure: multi-pov` + `trope: ensemble-cast`, deliberately
 *   shared with `fx-20` below so an "acrossGenre" similarity test can anchor
 *   on `fx-13`, exclude its genre tags, and still find `fx-20` as a
 *   structural readalike. `fx-14` "Cold Vector" is the low-stakes-adjacent
 *   outlier of the cluster (lower confidences, a secondary `mood: hopeful`).
 * - **F** (`fx-20`..`fx-23`) — cozy fantasy (found-family, gentle pacing).
 *   `fx-20` "The Ember Court Assembly" is the structural readalike for
 *   `fx-13` described above.
 * - **H** (`fx-15`..`fx-18`) — horror / thriller (dread, relentless pacing).
 * - Remainder — mystery, romance, historical-fiction, and non-fiction
 *   standalones plus two series (`The Kestrel Line`, `fx-24`..`fx-26`;
 *   `Hearthglow`, `fx-27`..`fx-28`) so the library isn't just four blocks.
 *
 * ── Provenance pairing (trustedOnly filtering) ──────────────────────────────
 * Three books carry a tag whose only instance anywhere in the fixture is
 * `source: 'llm-open'`:
 *   - `fx-07` "The Recursion Clause" — `trope: time-travel` (llm-open only)
 *   - `fx-08` "The Unreliable Hour" — `trope: unreliable-narrator` (llm-open only)
 *   - `fx-09` "Low Tide Confessions" — `trope: anti-hero` (llm-open only)
 * `fx-11` "Chrono Vanguard" carries that same `trope: time-travel` tag with a
 * trusted `source: 'vocab'`. This is the exact pairing a test needs to prove
 * `excludeTags: [{ tag: 'time-travel' }], trustedOnly: true` drops `fx-11`
 * but keeps `fx-07`, while `trustedOnly: false` drops both.
 *
 * ── Shared entities ──────────────────────────────────────────────────────
 * The place entity "Bell Harbor" appears on four books: `fx-01`, `fx-02`,
 * `fx-03` (Cluster M, all set there) and `fx-25` "The Kestrel Line, Book Two:
 * The Bell Harbor Timetable" (a mystery, cross-cluster) — a non-trivial
 * multi-book entity-filter result.
 *
 * ── Determinism ──────────────────────────────────────────────────────────
 * `seedFixtureLibrary` defaults `now` to `FIXTURE_NOW`, a fixed constant
 * timestamp (never `Date.now()`), so `taggedAt`/`lastSyncedAt` are identical
 * across runs and machines.
 */
import type { CuratorDb } from '../../db.js';
import type { EntityKind } from '../../enrichment/types.js';
import type { TagCategory, TagSource } from '../../types.js';

/** Fixed seed timestamp — 2024-01-15T00:00:00.000Z. Never `Date.now()`. */
export const FIXTURE_NOW = Date.UTC(2024, 0, 15);

export interface FixtureTag {
  tag: string;
  category: TagCategory;
  confidence: number;
  source: TagSource;
}

export interface FixtureEntity {
  entity: string;
  kind: EntityKind;
  sources: string[];
}

export interface FixtureBook {
  id: string; // 'fx-01' … 'fx-30'
  title: string;
  author: string;
  series: string | null;
  seriesSequence: number | null;
  durationSeconds: number;
  publishedYear: number;
  genres: string[];
  description: string;
  tags: FixtureTag[];
  entities: FixtureEntity[];
}

/** 30 synthetic books with known tags and entities. Deterministic and stable —
 *  tests assert against these ids, so treat additions as additive only. */
export const FIXTURE_BOOKS: readonly FixtureBook[] = [
  // ── Cluster M: melancholic coastal autumn ────────────────────────────────
  {
    id: 'fx-01',
    title: 'The Lighthouse at Bell Harbor',
    author: 'Elena Marsh',
    series: null,
    seriesSequence: null,
    durationSeconds: 34200, // 9.5h
    publishedYear: 2016,
    genres: ['Literary Fiction'],
    description:
      `Every autumn, the fog rolls into Bell Harbor and swallows the lighthouse whole, and every ` +
      `autumn Marguerite climbs the spiral stairs to keep a vigil no one asked her to keep. Twenty ` +
      `years after her sister vanished into that same fog, she still measures the seasons by the ` +
      `particular melancholy of a Maine coastline in October — the wet slate light, the gulls gone ` +
      `quiet, the smell of woodsmoke over brine. A stranger's arrival unsettles the town's careful ` +
      `grief, and Marguerite must decide whether wistful remembering has become its own kind of hiding.`,
    tags: [
      { tag: 'literary-fiction', category: 'genre', confidence: 0.95, source: 'vocab' },
      { tag: 'melancholic', category: 'mood', confidence: 0.97, source: 'vocab' },
      { tag: 'wistful', category: 'mood', confidence: 0.85, source: 'llm-open' },
      { tag: 'coastal-town', category: 'setting', confidence: 0.9, source: 'vocab' },
      { tag: 'autumn', category: 'setting', confidence: 0.88, source: 'vocab' },
      { tag: 'slow-burn', category: 'pacing', confidence: 0.82, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'adult', category: 'audience', confidence: 0.9, source: 'vocab' },
    ],
    entities: [
      { entity: 'Bell Harbor', kind: 'place', sources: ['openlibrary', 'audnexus'] },
      { entity: 'Maine', kind: 'place', sources: ['openlibrary'] },
      { entity: 'Elena Ward', kind: 'person', sources: ['openlibrary'] },
      { entity: '1990s', kind: 'time', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-02',
    title: 'Saltmarsh Elegy',
    author: 'Miriam Cole',
    series: null,
    seriesSequence: null,
    durationSeconds: 28800, // 8h
    publishedYear: 2013,
    genres: ['Literary Fiction'],
    description:
      `The Cole family has fished the Bell Harbor saltmarsh for four generations, and Ruth is the ` +
      `last one left who remembers why. Her mother's death leaves her sorting decades of nets and ` +
      `letters in a house that keeps the melancholic hush of a working coast even in the height of ` +
      `summer visitors. Old friendships resurface — some tender, some hard to forgive — as Ruth ` +
      `learns that grief, like the tide, only ever seems to recede.`,
    tags: [
      { tag: 'literary-fiction', category: 'genre', confidence: 0.93, source: 'vocab' },
      { tag: 'melancholic', category: 'mood', confidence: 0.9, source: 'vocab' },
      { tag: 'coastal-town', category: 'setting', confidence: 0.87, source: 'vocab' },
      { tag: 'slow-burn', category: 'pacing', confidence: 0.78, source: 'llm-open' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'family-legacy', category: 'theme', confidence: 0.72, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Bell Harbor', kind: 'place', sources: ['openlibrary'] },
      { entity: 'New England', kind: 'place', sources: ['openlibrary'] },
      { entity: 'Ruth Cole', kind: 'person', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-03',
    title: 'Autumn Tide',
    author: 'Devon Hale',
    series: null,
    seriesSequence: null,
    durationSeconds: 25200, // 7h
    publishedYear: 2019,
    genres: ['Contemporary Fiction'],
    description:
      `When the leaves turn in Bell Harbor, so does everything else — the ferry schedule, the ` +
      `fishing quotas, and apparently Josie's plans to leave for good. What was meant to be one ` +
      `last autumn on the coast before her move to the city stretches into a wistful reckoning with ` +
      `the town, the sea, and the boy she never quite got over. Autumn Tide is a quiet, coastal ` +
      `coming-of-age story about staying exactly long enough to understand why you wanted to go.`,
    tags: [
      { tag: 'contemporary-fiction', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'wistful', category: 'mood', confidence: 0.88, source: 'vocab' },
      { tag: 'autumn', category: 'setting', confidence: 0.91, source: 'vocab' },
      { tag: 'coastal-town', category: 'setting', confidence: 0.86, source: 'vocab' },
      { tag: 'slow-burn', category: 'pacing', confidence: 0.75, source: 'llm-open' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'young-adult', category: 'audience', confidence: 0.8, source: 'vocab' },
    ],
    entities: [
      { entity: 'Bell Harbor', kind: 'place', sources: ['openlibrary'] },
      { entity: 'Josie Farrow', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Sam Whitfield', kind: 'person', sources: ['openlibrary'] },
    ],
  },

  // ── Remainder: standalone genre spread ───────────────────────────────────
  {
    id: 'fx-04',
    title: 'The Orchard at Merrow Hill',
    author: 'Beatrice Lund',
    series: null,
    seriesSequence: null,
    durationSeconds: 46800, // 13h
    publishedYear: 1994,
    genres: ['Historical Fiction'],
    description:
      `In the last summer before the war reaches their valley, three sisters inherit their ` +
      `grandmother's failing apple orchard and a debt they don't yet understand. The Orchard at ` +
      `Merrow Hill follows their scramble to save the harvest — and each other — as rationing, ` +
      `rumor, and an unexpected romance complicate a season that was supposed to be simple. Sweeping ` +
      `and warm despite its wartime backdrop, it is as much about sisterhood as survival.`,
    tags: [
      { tag: 'historical-fiction', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'hopeful', category: 'mood', confidence: 0.78, source: 'vocab' },
      { tag: 'moderate', category: 'pacing', confidence: 0.7, source: 'llm-open' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'classic', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'sisterhood', category: 'theme', confidence: 0.75, source: 'llm-open' },
      { tag: 'wartime', category: 'setting', confidence: 0.68, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Merrow Hill', kind: 'place', sources: ['openlibrary'] },
      { entity: 'World War II', kind: 'time', sources: ['openlibrary'] },
      { entity: 'Agnes Merrow', kind: 'person', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-05',
    title: 'Written in Longhand',
    author: 'Ines Callahan',
    series: null,
    seriesSequence: null,
    durationSeconds: 30600, // 8.5h
    publishedYear: 2022,
    genres: ['Romance'],
    description:
      `Two rival letter-shop owners on the same block have spent a year passing snippy notes under ` +
      `each other's doors instead of speaking face to face — until a citywide blackout strands them ` +
      `together with nothing but candlelight and a decade of unsent letters between them. Written in ` +
      `Longhand is a warm, banter-heavy romance about slow-burn attraction hiding behind years of ` +
      `stubborn pride.`,
    tags: [
      { tag: 'romance', category: 'genre', confidence: 0.92, source: 'vocab' },
      { tag: 'warm', category: 'mood', confidence: 0.82, source: 'vocab' },
      { tag: 'slow-burn', category: 'pacing', confidence: 0.77, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'enemies-to-lovers', category: 'trope', confidence: 0.8, source: 'vocab' },
      { tag: 'adult', category: 'audience', confidence: 0.85, source: 'vocab' },
    ],
    entities: [
      { entity: 'Wren Ashby', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Cal Ferreira', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Thistledown Row', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-06',
    title: 'The Quiet Discipline',
    author: 'Dr. Harold Ng',
    series: null,
    seriesSequence: null,
    durationSeconds: 18000, // 5h
    publishedYear: 2020,
    genres: ['Non-Fiction', 'Self-Help'],
    description:
      `Drawing on two decades of clinical research, Dr. Harold Ng argues that willpower is less a ` +
      `trait than a set of environmental defaults most people never examine. The Quiet Discipline ` +
      `lays out a practical, unglamorous framework for building habits that survive bad days, built ` +
      `from case studies rather than slogans. It is less interested in motivation than in making ` +
      `good choices boring and automatic.`,
    tags: [
      { tag: 'non-fiction', category: 'genre', confidence: 0.95, source: 'vocab' },
      { tag: 'pragmatic', category: 'mood', confidence: 0.7, source: 'llm-open' },
      { tag: 'moderate', category: 'pacing', confidence: 0.65, source: 'llm-open' },
      { tag: 'short', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'self-improvement', category: 'theme', confidence: 0.8, source: 'vocab' },
      { tag: 'adult', category: 'audience', confidence: 0.75, source: 'vocab' },
    ],
    entities: [
      { entity: 'Harold Ng', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Wendell Ostroff', kind: 'person', sources: ['openlibrary'] },
    ],
  },

  // ── Provenance trio: llm-open-only tags ──────────────────────────────────
  {
    id: 'fx-07',
    title: 'The Recursion Clause',
    author: 'Priya Nathan',
    series: null,
    seriesSequence: null,
    durationSeconds: 45000, // 12.5h
    publishedYear: 2021,
    genres: ['Science Fiction', 'Thriller'],
    description:
      `A patent attorney discovers a clause in a defense contract that describes a device that ` +
      `shouldn't exist for another forty years — and somehow already has a case history. As she ` +
      `chases the clause's origins through shell companies and altered court records, she starts ` +
      `finding her own signature on documents she has no memory of signing. The Recursion Clause is ` +
      `a paranoid, propulsive thriller about time travel as bureaucratic inevitability rather than ` +
      `adventure.`,
    tags: [
      { tag: 'thriller', category: 'genre', confidence: 0.88, source: 'vocab' },
      { tag: 'science-fiction', category: 'genre', confidence: 0.85, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.86, source: 'vocab' },
      { tag: 'fast-paced', category: 'pacing', confidence: 0.83, source: 'vocab' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      // Provenance pairing: llm-open-only instance of this tag (see fx-11 for the trusted pairing).
      { tag: 'time-travel', category: 'trope', confidence: 0.6, source: 'llm-open' },
      { tag: 'paranoia', category: 'theme', confidence: 0.68, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Nadia Okafor', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Washington D.C.', kind: 'place', sources: ['openlibrary'] },
      { entity: '2060s', kind: 'time', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-08',
    title: 'The Unreliable Hour',
    author: 'Colm Ashford',
    series: null,
    seriesSequence: null,
    durationSeconds: 36000, // 10h
    publishedYear: 2018,
    genres: ['Literary Fiction', 'Thriller'],
    description:
      `Every version of the night Simon's wife disappeared is a little different by the time he ` +
      `tells it again, and by the third retelling even he isn't sure which details are memory and ` +
      `which are the story he needs to survive. The Unreliable Hour circles a single missing-persons ` +
      `case through shifting testimony, contradictory timelines, and a narrator who may be ` +
      `protecting someone — possibly himself. It is a tense, literary puzzle box about how grief ` +
      `edits the truth.`,
    tags: [
      { tag: 'literary-fiction', category: 'genre', confidence: 0.82, source: 'vocab' },
      { tag: 'thriller', category: 'genre', confidence: 0.75, source: 'llm-open' },
      { tag: 'tense', category: 'mood', confidence: 0.79, source: 'vocab' },
      { tag: 'slow-burn', category: 'pacing', confidence: 0.7, source: 'llm-open' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      // Provenance pairing: llm-open-only instance of this tag anywhere in the fixture.
      { tag: 'unreliable-narrator', category: 'trope', confidence: 0.58, source: 'llm-open' },
      { tag: 'nonlinear', category: 'structure', confidence: 0.66, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Simon Whitcombe', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Nora Whitcombe', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Portland', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-09',
    title: 'Low Tide Confessions',
    author: 'Tobias Reyes',
    series: null,
    seriesSequence: null,
    durationSeconds: 32400, // 9h
    publishedYear: 2015,
    genres: ['Mystery'],
    description:
      `Frank Delgado lost his badge two years ago and hasn't found much reason to feel bad about ` +
      `it. When a dockworker's widow offers him twice his usual rate to find out who really killed ` +
      `her husband, Frank's willingness to bend every rule in town becomes the only thing standing ` +
      `between the truth and a very convenient verdict. Low Tide Confessions is a hard-edged noir ` +
      `about a man who stopped believing in clean hands a long time ago.`,
    tags: [
      { tag: 'mystery', category: 'genre', confidence: 0.84, source: 'vocab' },
      { tag: 'noir', category: 'genre', confidence: 0.7, source: 'llm-open' },
      { tag: 'dark', category: 'mood', confidence: 0.65, source: 'llm-open' },
      { tag: 'brisk', category: 'pacing', confidence: 0.72, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      // Provenance pairing: llm-open-only instance of this tag anywhere in the fixture.
      { tag: 'anti-hero', category: 'trope', confidence: 0.55, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Frank Delgado', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Corinne Ashby', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Gantry Docks', kind: 'place', sources: ['openlibrary'] },
    ],
  },

  // ── Cluster S: space opera / military SF ─────────────────────────────────
  {
    id: 'fx-10',
    title: 'The Fractured Fleet',
    author: 'Callum Reyes',
    series: null,
    seriesSequence: null,
    durationSeconds: 54000, // 15h
    publishedYear: 2023,
    genres: ['Science Fiction', 'Space Opera'],
    description:
      `When the Fractured Fleet's flagship goes dark mid-negotiation, Commodore Sable Iyer has six ` +
      `hours to determine whether it's mutiny, sabotage, or the opening move of a war three factions ` +
      `have been quietly preparing for. The Fractured Fleet is fast, tense space opera about ` +
      `brinkmanship, political maneuvering, and the cost of holding an alliance together by force of ` +
      `will alone.`,
    tags: [
      { tag: 'space-opera', category: 'genre', confidence: 0.93, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.88, source: 'vocab' },
      { tag: 'fast-paced', category: 'pacing', confidence: 0.85, source: 'vocab' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'political', category: 'theme', confidence: 0.82, source: 'vocab' },
      { tag: 'multi-pov', category: 'structure', confidence: 0.6, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Sable Iyer', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Halcyon', kind: 'place', sources: ['openlibrary'] },
      { entity: 'Third Compact War', kind: 'time', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-11',
    title: 'Chrono Vanguard',
    author: 'Dashiell Okoro',
    series: null,
    seriesSequence: null,
    durationSeconds: 57600, // 16h
    publishedYear: 2020,
    genres: ['Science Fiction', 'Military SF'],
    description:
      `Sergeant Priya Okonkwo's unit doesn't just fight the war — they fight it seventeen times, ` +
      `redeployed through a chronal rift each time the front collapses, remembering just enough of ` +
      `the last loop to make different mistakes. Chrono Vanguard is a tense, fast-moving military SF ` +
      `novel about soldiers who suspect that command knows more about the rift than it's telling ` +
      `them, and that this war might have no true ending.`,
    tags: [
      { tag: 'military-sf', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.86, source: 'vocab' },
      { tag: 'fast-paced', category: 'pacing', confidence: 0.83, source: 'vocab' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'political', category: 'theme', confidence: 0.7, source: 'vocab' },
      // Provenance pairing: trusted instance of the tag fx-07 carries as llm-open-only.
      { tag: 'time-travel', category: 'trope', confidence: 0.75, source: 'vocab' },
    ],
    entities: [
      { entity: 'Priya Okonkwo', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Chronal Rift', kind: 'place', sources: ['openlibrary'] },
      { entity: 'the Long War', kind: 'time', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-12',
    title: 'Siege of Kessendra',
    author: 'Marta Voskuijlen',
    series: null,
    seriesSequence: null,
    durationSeconds: 64800, // 18h
    publishedYear: 2017,
    genres: ['Military SF'],
    description:
      `The last free garrison on Kessendra has ninety days of food, half that in ammunition, and a ` +
      `commanding officer who has stopped pretending relief is coming. Siege of Kessendra is ` +
      `unrelentingly tense military science fiction told from inside the walls — a fast, brutal ` +
      `account of rationing, morale, and the political calculus back home that decided this world ` +
      `was expendable.`,
    tags: [
      { tag: 'military-sf', category: 'genre', confidence: 0.91, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.89, source: 'vocab' },
      { tag: 'fast-paced', category: 'pacing', confidence: 0.87, source: 'vocab' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'political', category: 'theme', confidence: 0.75, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Yusuf Adeyemi', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Kessendra', kind: 'place', sources: ['openlibrary'] },
      { entity: 'the Second Kessendra Campaign', kind: 'time', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-13',
    title: 'The Ember Armada',
    author: 'Renata Sokolova',
    series: null,
    seriesSequence: null,
    durationSeconds: 50400, // 14h
    publishedYear: 2019,
    genres: ['Space Opera'],
    description:
      `Five delegates from five dying colonies must forge the Ember Armada into a single fighting ` +
      `force before the Concord's deadline expires — and each of them is hiding a reason the ` +
      `alliance might be better off failing. Told across all five points of view, The Ember Armada ` +
      `is a fast-paced, tense space opera about the political theater of desperate diplomacy, and ` +
      `the fragile ensemble cast trying to hold it together from five different, mutually suspicious ` +
      `command tents.`,
    tags: [
      { tag: 'space-opera', category: 'genre', confidence: 0.92, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.85, source: 'vocab' },
      { tag: 'fast-paced', category: 'pacing', confidence: 0.86, source: 'vocab' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      // Anchor tags shared with fx-20's structural readalike test.
      { tag: 'political', category: 'theme', confidence: 0.88, source: 'vocab' },
      { tag: 'multi-pov', category: 'structure', confidence: 0.83, source: 'vocab' },
      { tag: 'ensemble-cast', category: 'trope', confidence: 0.8, source: 'vocab' },
    ],
    entities: [
      { entity: 'Osei Boadi', kind: 'person', sources: ['openlibrary'] },
      { entity: 'the Ember Armada', kind: 'place', sources: ['openlibrary'] },
      { entity: 'the Concord Deadline', kind: 'time', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-14',
    title: 'Cold Vector',
    author: 'Idris Whitfield',
    series: null,
    seriesSequence: null,
    durationSeconds: 39600, // 11h
    publishedYear: 2021,
    genres: ['Space Opera'],
    description:
      `Cold Vector follows a single supply-runner pilot threading a fragile ceasefire corridor ` +
      `between two fleets that could resume shooting at any moment. It's tense, fast-moving space ` +
      `opera on a much smaller stage than a fleet battle — one ship, one route, and a political ` +
      `truce so thin that a wrong radio call could end it. Beneath the tension is a quieter, almost ` +
      `hopeful thread: the pilot's stubborn belief that this ceasefire might actually hold.`,
    tags: [
      // Low-stakes-adjacent outlier of Cluster S: weaker confidences, secondary hopeful mood.
      { tag: 'space-opera', category: 'genre', confidence: 0.85, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.7, source: 'vocab' },
      { tag: 'hopeful', category: 'mood', confidence: 0.6, source: 'llm-open' },
      { tag: 'fast-paced', category: 'pacing', confidence: 0.65, source: 'llm-open' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'political', category: 'theme', confidence: 0.62, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Reya Sandoval', kind: 'person', sources: ['openlibrary'] },
      { entity: 'the Ceasefire Corridor', kind: 'place', sources: ['openlibrary'] },
    ],
  },

  // ── Cluster H: horror / thriller ─────────────────────────────────────────
  {
    id: 'fx-15',
    title: 'What the Cellar Keeps',
    author: 'Owen Blackwood',
    series: null,
    seriesSequence: null,
    durationSeconds: 32400, // 9h
    publishedYear: 2022,
    genres: ['Horror'],
    description:
      `The Whitlock house has a cellar door that was bricked shut two owners ago, and the family ` +
      `that just moved in can't explain why they keep finding it open again. What the Cellar Keeps ` +
      `is a relentless, dread-soaked haunted-house horror novel that never lets its family — or its ` +
      `reader — catch a full night's sleep before the next wrong noise starts.`,
    tags: [
      { tag: 'horror', category: 'genre', confidence: 0.94, source: 'vocab' },
      { tag: 'dread', category: 'mood', confidence: 0.9, source: 'vocab' },
      { tag: 'relentless', category: 'pacing', confidence: 0.85, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'haunted-house', category: 'setting', confidence: 0.78, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Dana Whitlock', kind: 'person', sources: ['openlibrary'] },
      { entity: 'the Whitlock House', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-16',
    title: 'Nine Missed Calls',
    author: 'Fiona Marsh',
    series: null,
    seriesSequence: null,
    durationSeconds: 28800, // 8h
    publishedYear: 2020,
    genres: ['Thriller', 'Horror'],
    description:
      `Every one of the nine missed calls on Ashley's phone came from her sister's number — and her ` +
      `sister has been dead for three years. Nine Missed Calls is a relentless, dread-laced thriller ` +
      `that keeps ratcheting the pressure as Ashley chases an impossible signal through a city that ` +
      `seems to be rearranging itself just for her.`,
    tags: [
      { tag: 'thriller', category: 'genre', confidence: 0.86, source: 'vocab' },
      { tag: 'horror', category: 'genre', confidence: 0.72, source: 'llm-open' },
      { tag: 'dread', category: 'mood', confidence: 0.85, source: 'vocab' },
      { tag: 'relentless', category: 'pacing', confidence: 0.82, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
    ],
    entities: [
      { entity: 'Ashley Renfrew', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Callie Renfrew', kind: 'person', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-17',
    title: 'The Long Corridor',
    author: 'Rasheed Okafor',
    series: null,
    seriesSequence: null,
    durationSeconds: 37800, // 10.5h
    publishedYear: 2016,
    genres: ['Horror'],
    description:
      `Night-shift security guard Marcus knows every hallway of the old hospital by heart, which is ` +
      `exactly why it's so unsettling when a corridor that shouldn't exist starts showing up on his ` +
      `rounds. The Long Corridor is dread-heavy horror that turns a routine job into a relentless, ` +
      `sleepless descent through a building that keeps rearranging its own geometry after dark.`,
    tags: [
      { tag: 'horror', category: 'genre', confidence: 0.88, source: 'vocab' },
      { tag: 'dread', category: 'mood', confidence: 0.83, source: 'vocab' },
      { tag: 'relentless', category: 'pacing', confidence: 0.79, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'liminal-space', category: 'setting', confidence: 0.6, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Marcus Odom', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Saint Adeline Hospital', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-18',
    title: 'Below the Waterline',
    author: 'Greta Vance',
    series: null,
    seriesSequence: null,
    durationSeconds: 43200, // 12h
    publishedYear: 2019,
    genres: ['Thriller'],
    description:
      `A deep-sea research vessel loses contact with three divers, and what surfaces forty minutes ` +
      `later isn't quite all three of them. Below the Waterline is relentless, claustrophobic ` +
      `horror-thriller, dread mounting with every meter of pressure as the surviving crew realizes ` +
      `the ocean gave something back.`,
    tags: [
      { tag: 'thriller', category: 'genre', confidence: 0.84, source: 'vocab' },
      { tag: 'horror', category: 'genre', confidence: 0.7, source: 'llm-open' },
      { tag: 'dread', category: 'mood', confidence: 0.87, source: 'vocab' },
      { tag: 'relentless', category: 'pacing', confidence: 0.81, source: 'vocab' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'deep-sea', category: 'setting', confidence: 0.65, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Dr. Alia Ferro', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Research Vessel Meridian', kind: 'place', sources: ['openlibrary'] },
    ],
  },

  // ── Remainder standalone ──────────────────────────────────────────────────
  {
    id: 'fx-19',
    title: 'The Uncharted Ledger',
    author: 'Professor Adaeze Umeh',
    series: null,
    seriesSequence: null,
    durationSeconds: 48600, // 13.5h
    publishedYear: 1988,
    genres: ['Non-Fiction', 'History'],
    description:
      `Long before satellite mapping, a handful of eighteenth-century merchant clerks quietly ` +
      `redrew the coastlines of three continents using nothing but tide tables, debt ledgers, and ` +
      `stubborn correspondence. The Uncharted Ledger reconstructs their work from surviving account ` +
      `books, arguing that the age of exploration owed as much to bookkeeping as to bravery. It is a ` +
      `patient, richly detailed work of narrative economic history.`,
    tags: [
      { tag: 'non-fiction', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'history', category: 'genre', confidence: 0.75, source: 'llm-open' },
      { tag: 'contemplative', category: 'mood', confidence: 0.68, source: 'llm-open' },
      { tag: 'moderate', category: 'pacing', confidence: 0.6, source: 'llm-open' },
      { tag: 'long', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'classic', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'adult', category: 'audience', confidence: 0.7, source: 'vocab' },
    ],
    entities: [
      { entity: 'Josiah Bellweather', kind: 'person', sources: ['openlibrary'] },
      { entity: 'the Spice Coast Ledgers Office', kind: 'place', sources: ['openlibrary'] },
    ],
  },

  // ── Cluster F: cozy fantasy ───────────────────────────────────────────────
  {
    id: 'fx-20',
    title: 'The Ember Court Assembly',
    author: 'Wilhelmina Frost',
    series: null,
    seriesSequence: null,
    durationSeconds: 36000, // 10h
    publishedYear: 2023,
    genres: ['Fantasy'],
    description:
      `Five bickering delegates from five squabbling hearth-clans must forge the Ember Court into a ` +
      `single governing council before the harvest treaty expires — and each of them would rather be ` +
      `home baking bread than doing politics. The Ember Court Assembly is cozy, gentle fantasy told ` +
      `across all five points of view, about a found-family ensemble cast who discover that ` +
      `diplomacy goes better with tea, patience, and the occasional bribery via pie.`,
    tags: [
      { tag: 'fantasy', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'cozy', category: 'mood', confidence: 0.88, source: 'vocab' },
      { tag: 'gentle', category: 'pacing', confidence: 0.84, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'found-family', category: 'theme', confidence: 0.86, source: 'vocab' },
      // Structural readalike tags shared with the fx-13 anchor (different genre entirely).
      { tag: 'political', category: 'theme', confidence: 0.65, source: 'vocab' },
      { tag: 'multi-pov', category: 'structure', confidence: 0.75, source: 'vocab' },
      { tag: 'ensemble-cast', category: 'trope', confidence: 0.78, source: 'vocab' },
    ],
    entities: [
      { entity: 'Tansy Hearthwick', kind: 'person', sources: ['openlibrary'] },
      { entity: 'the Ember Court', kind: 'place', sources: ['openlibrary'] },
      { entity: 'Hearthglen', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-21',
    title: 'Tea and Talismans',
    author: 'Josephine Lark',
    series: null,
    seriesSequence: null,
    durationSeconds: 27000, // 7.5h
    publishedYear: 2021,
    genres: ['Fantasy'],
    description:
      `Above a sleepy magic-shop in a town where every teapot is faintly enchanted, three orphaned ` +
      `siblings and the retired witch who took them in have built something that feels, at long ` +
      `last, like a family. Tea and Talismans is a gentle, cozy fantasy about small magic, smaller ` +
      `stakes, and the found-family warmth of a household that chooses each other every single ` +
      `morning over the breakfast pot.`,
    tags: [
      { tag: 'fantasy', category: 'genre', confidence: 0.91, source: 'vocab' },
      { tag: 'cozy', category: 'mood', confidence: 0.92, source: 'vocab' },
      { tag: 'gentle', category: 'pacing', confidence: 0.87, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'found-family', category: 'theme', confidence: 0.89, source: 'vocab' },
      { tag: 'small-town', category: 'setting', confidence: 0.7, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Nettle Ashgrove', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Wren Ashgrove', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Thimblewick', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-22',
    title: "The Hearthkeeper's Almanac",
    author: 'Bram Iversen',
    series: null,
    seriesSequence: null,
    durationSeconds: 32400, // 9h
    publishedYear: 2020,
    genres: ['Fantasy'],
    description:
      `Every entry in the Hearthkeeper's Almanac is a small spell for an ordinary problem — a charm ` +
      `for a stuck door, a blessing for a late harvest, a hex for houseguests who overstay their ` +
      `welcome. When young Osric inherits the almanac along with his grandmother's crumbling ` +
      `cottage, he discovers a found-family of neighbors more than willing to help him learn it. The ` +
      `Hearthkeeper's Almanac is gentle, cozy fantasy about small magic and smaller, kinder stakes.`,
    tags: [
      { tag: 'fantasy', category: 'genre', confidence: 0.89, source: 'vocab' },
      { tag: 'cozy', category: 'mood', confidence: 0.85, source: 'vocab' },
      { tag: 'gentle', category: 'pacing', confidence: 0.82, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'found-family', category: 'theme', confidence: 0.8, source: 'vocab' },
    ],
    entities: [
      { entity: 'Osric Thorne', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Bramblecot Cottage', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-23',
    title: 'Nine Doors to Wrenfield',
    author: 'Callista Moon',
    series: null,
    seriesSequence: null,
    durationSeconds: 28800, // 8h
    publishedYear: 2022,
    genres: ['Fantasy'],
    description:
      `Wrenfield's town hall has nine doors, and only the eldest Pruitt sibling can remember which ` +
      `one leads where on any given day — a talent that becomes very useful when the whole ` +
      `ramshackle, found-family household needs to hide a lost house-spirit from the tax assessor. ` +
      `Nine Doors to Wrenfield is gentle, cozy fantasy about a chaotic, loving household solving ` +
      `small magical problems with patience, tea, and a great deal of bickering.`,
    tags: [
      { tag: 'fantasy', category: 'genre', confidence: 0.87, source: 'vocab' },
      { tag: 'cozy', category: 'mood', confidence: 0.9, source: 'vocab' },
      { tag: 'gentle', category: 'pacing', confidence: 0.86, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'found-family', category: 'theme', confidence: 0.85, source: 'vocab' },
    ],
    entities: [
      { entity: 'Wren Pruitt', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Edda Pruitt', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Wrenfield Town Hall', kind: 'place', sources: ['openlibrary'] },
    ],
  },

  // ── Series A: The Kestrel Line (mystery) ─────────────────────────────────
  {
    id: 'fx-24',
    title: 'The Kestrel Line, Book One: Signal Loss',
    author: 'Nadia Petrov',
    series: 'The Kestrel Line',
    seriesSequence: 1,
    durationSeconds: 36000, // 10h
    publishedYear: 2018,
    genres: ['Mystery'],
    description:
      `Detective Mara Voss transfers to the coastal Kestrel rail line hoping for quiet work, and ` +
      `instead inherits a decade-old cold case the moment a retired signalman is found dead beside ` +
      `the tracks he used to walk. Signal Loss introduces a sharp, procedural mystery series built ` +
      `on small-town secrets and a detective who trusts train schedules more than people.`,
    tags: [
      { tag: 'mystery', category: 'genre', confidence: 0.92, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.65, source: 'llm-open' },
      { tag: 'moderate', category: 'pacing', confidence: 0.7, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'detective-protagonist', category: 'character', confidence: 0.75, source: 'vocab' },
    ],
    entities: [
      { entity: 'Mara Voss', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Kestrel Line Station', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-25',
    title: 'The Kestrel Line, Book Two: The Bell Harbor Timetable',
    author: 'Nadia Petrov',
    series: 'The Kestrel Line',
    seriesSequence: 2,
    durationSeconds: 37800, // 10.5h
    publishedYear: 2019,
    genres: ['Mystery'],
    description:
      `The Kestrel Line's coastal spur ends in Bell Harbor, and so, it turns out, did a passenger ` +
      `who never got off the last train of the season. Detective Mara Voss spends a fog-bound week ` +
      `working the harbor's close-knit fishing families, whose hospitality has a way of turning into ` +
      `stonewalling whenever her questions get too specific. The Bell Harbor Timetable is a moody, ` +
      `methodical mystery about a town that keeps its own schedule.`,
    tags: [
      { tag: 'mystery', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.68, source: 'llm-open' },
      { tag: 'coastal-town', category: 'setting', confidence: 0.72, source: 'vocab' },
      { tag: 'moderate', category: 'pacing', confidence: 0.7, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'detective-protagonist', category: 'character', confidence: 0.78, source: 'vocab' },
    ],
    entities: [
      { entity: 'Mara Voss', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Bell Harbor', kind: 'place', sources: ['openlibrary'] },
      { entity: 'Kestrel Line Station', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-26',
    title: 'The Kestrel Line, Book Three: The Last Conductor',
    author: 'Nadia Petrov',
    series: 'The Kestrel Line',
    seriesSequence: 3,
    durationSeconds: 39600, // 11h
    publishedYear: 2021,
    genres: ['Mystery'],
    description:
      `When the Kestrel Line's last steam conductor dies mid-shift with the emergency brake pulled ` +
      `and no one else in the cab, Detective Mara Voss has to decide whether she's looking at a ` +
      `heart attack, a murder, or a mechanical ghost story the rail workers have been telling for ` +
      `thirty years. The Last Conductor closes out the trilogy with the series' sharpest, most ` +
      `claustrophobic mystery yet.`,
    tags: [
      { tag: 'mystery', category: 'genre', confidence: 0.93, source: 'vocab' },
      { tag: 'tense', category: 'mood', confidence: 0.7, source: 'vocab' },
      { tag: 'moderate', category: 'pacing', confidence: 0.72, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'detective-protagonist', category: 'character', confidence: 0.8, source: 'vocab' },
    ],
    entities: [
      { entity: 'Mara Voss', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Otto Reinholt', kind: 'person', sources: ['openlibrary'] },
    ],
  },

  // ── Series B: Hearthglow (romance) ───────────────────────────────────────
  {
    id: 'fx-27',
    title: "Hearthglow, Book One: The Innkeeper's Wager",
    author: 'Sabrina Doyle',
    series: 'Hearthglow',
    seriesSequence: 1,
    durationSeconds: 28800, // 8h
    publishedYear: 2022,
    genres: ['Romance'],
    description:
      `Innkeeper Della Hearthglow bets her best regular that he can't last a whole ski season ` +
      `without falling for someone at the inn — mostly because she's fairly sure the someone will ` +
      `turn out to be her. The Innkeeper's Wager kicks off a warm, banter-forward romance series set ` +
      `around a family inn that seems to specialize in matchmaking nobody asked for.`,
    tags: [
      { tag: 'romance', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'warm', category: 'mood', confidence: 0.85, source: 'vocab' },
      { tag: 'slow-burn', category: 'pacing', confidence: 0.75, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'enemies-to-lovers', category: 'trope', confidence: 0.6, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Della Hearthglow', kind: 'person', sources: ['openlibrary'] },
      { entity: 'The Hearthglow Inn', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-28',
    title: 'Hearthglow, Book Two: A Recipe for Later',
    author: 'Sabrina Doyle',
    series: 'Hearthglow',
    seriesSequence: 2,
    durationSeconds: 30600, // 8.5h
    publishedYear: 2023,
    genres: ['Romance'],
    description:
      `The Hearthglow Inn's new pastry chef has exactly one rule about coworkers, and exactly one ` +
      `coworker who keeps making it very hard to keep. A Recipe for Later is a warm, slow-burn ` +
      `romance about learning to want something you'd planned to wait for indefinitely, set against ` +
      `a kitchen full of very opinionated regulars.`,
    tags: [
      { tag: 'romance', category: 'genre', confidence: 0.88, source: 'vocab' },
      { tag: 'warm', category: 'mood', confidence: 0.87, source: 'vocab' },
      { tag: 'slow-burn', category: 'pacing', confidence: 0.8, source: 'vocab' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'modern', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'self-discovery', category: 'theme', confidence: 0.6, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Wilhelmina Reyes', kind: 'person', sources: ['openlibrary'] },
      { entity: 'The Hearthglow Inn', kind: 'place', sources: ['openlibrary'] },
    ],
  },

  // ── Remainder standalone ──────────────────────────────────────────────────
  {
    id: 'fx-29',
    title: 'The Last Honest Ledger',
    author: 'Consuela Vasquez',
    series: null,
    seriesSequence: null,
    durationSeconds: 25200, // 7h
    publishedYear: 1975,
    genres: ['Non-Fiction', 'Business'],
    description:
      `In 1974, a mid-level auditor's decision to follow one strange invoice trail all the way to ` +
      `the top ended a decade of quiet fraud at one of the country's largest grain cooperatives. The ` +
      `Last Honest Ledger reconstructs the investigation from surviving memos and interview ` +
      `transcripts, telling a patient, procedural story about the unglamorous work of catching ` +
      `institutional lying one receipt at a time.`,
    tags: [
      { tag: 'non-fiction', category: 'genre', confidence: 0.88, source: 'vocab' },
      { tag: 'measured', category: 'mood', confidence: 0.6, source: 'llm-open' },
      { tag: 'moderate', category: 'pacing', confidence: 0.65, source: 'llm-open' },
      { tag: 'medium', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'new-wave', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'institutional-corruption', category: 'theme', confidence: 0.62, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Everett Kade', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Meridian Grain Cooperative', kind: 'place', sources: ['openlibrary'] },
    ],
  },
  {
    id: 'fx-30',
    title: "The Cartographer's Daughter",
    author: 'Helena Pryce',
    series: null,
    seriesSequence: null,
    durationSeconds: 86400, // 24h
    publishedYear: 1962,
    genres: ['Historical Fiction'],
    description:
      `In 1848, Isabelle inherits her late father's half-finished survey of the Carpathian frontier ` +
      `and, against every convention of the age, decides to finish it herself. The Cartographer's ` +
      `Daughter follows her three-year expedition through shifting borders and suspicious officials, ` +
      `a sweeping, patient historical novel about the unmapped cost of ambition in a world built to ` +
      `stop women from having any.`,
    tags: [
      { tag: 'historical-fiction', category: 'genre', confidence: 0.9, source: 'vocab' },
      { tag: 'determined', category: 'mood', confidence: 0.65, source: 'llm-open' },
      { tag: 'moderate', category: 'pacing', confidence: 0.68, source: 'vocab' },
      { tag: 'epic', category: 'length', confidence: 1, source: 'derived' },
      { tag: 'new-wave', category: 'era', confidence: 1, source: 'derived' },
      { tag: 'frontier', category: 'setting', confidence: 0.6, source: 'llm-open' },
    ],
    entities: [
      { entity: 'Isabelle Castellane', kind: 'person', sources: ['openlibrary'] },
      { entity: 'the Carpathian Frontier', kind: 'place', sources: ['openlibrary'] },
    ],
  },
];

const FIXTURE_BOOKS_BY_ID: ReadonlyMap<string, FixtureBook> = new Map(
  FIXTURE_BOOKS.map((book) => [book.id, book])
);

/** Look up one fixture book by id; throws if the id is unknown (so a typo in a
 *  test fails loudly instead of returning undefined). */
export function fixtureBook(id: string): FixtureBook {
  const book = FIXTURE_BOOKS_BY_ID.get(id);
  if (!book) throw new Error(`Unknown fixture book id: ${id}`);
  return book;
}

/** Seed every fixture book, its tags and its entities into `db`. Idempotent. */
export function seedFixtureLibrary(db: CuratorDb, now: number = FIXTURE_NOW): void {
  for (const book of FIXTURE_BOOKS) {
    db.upsertBook({
      id: book.id,
      title: book.title,
      author: book.author,
      series: book.series,
      seriesSequence: book.seriesSequence,
      durationSeconds: book.durationSeconds,
      publishedYear: book.publishedYear,
      genres: book.genres,
      description: book.description,
      coverPath: null,
      absAddedAt: now,
      lastSyncedAt: now,
    });
    db.replaceBookTags(book.id, book.tags, now);
    db.replaceBookEntities(book.id, book.entities);
  }
}
