/**
 * Read-only enrichment coverage probe (plan §3.5, offline half).
 *
 * Runs the REAL provider clients against a sample of real audiobook titles
 * and reports hit rates and entity yield. Makes no database writes and no
 * authenticated calls — it exists to measure Open Library / Audnexus coverage
 * before committing to a full-library enrichment run.
 *
 * Usage:  npm run probe:providers
 *         npm run probe:providers -- --json
 *
 * This is a diagnostic, not part of the app. The in-app equivalent is
 * `POST /enrichment/run` with `sample: true`, which reports the same shape
 * against the user's actual library.
 */
import { openLibraryProvider } from '../apps/backend/src/modules/curator/core/enrichment/providers/openLibrary.js';
import { audnexusProvider } from '../apps/backend/src/modules/curator/core/enrichment/providers/audnexus.js';
import type { EnrichmentProvider } from '../apps/backend/src/modules/curator/core/enrichment/types.js';
import type { Book } from '../apps/backend/src/modules/curator/core/types.js';

interface SampleEntry {
  title: string;
  author: string;
  isbn?: string;
  asin?: string;
  /** Rough popularity tier, to see whether coverage tracks obscurity. */
  tier: 'canonical' | 'popular' | 'midlist' | 'recent';
}

/**
 * A deliberately uneven sample: canonical SF, well-known modern SF, midlist,
 * and recent releases, plus a few non-SF titles. Skewed sci-fi/fantasy to
 * match the target library.
 */
const SAMPLE: SampleEntry[] = [
  { title: 'Dune', author: 'Frank Herbert', tier: 'canonical' },
  { title: 'Neuromancer', author: 'William Gibson', tier: 'canonical' },
  { title: 'Snow Crash', author: 'Neal Stephenson', tier: 'canonical' },
  { title: 'Hyperion', author: 'Dan Simmons', tier: 'canonical' },
  { title: "The Left Hand of Darkness", author: 'Ursula K. Le Guin', tier: 'canonical' },

  { title: 'Project Hail Mary', author: 'Andy Weir', asin: 'B08G9PRS1K', tier: 'popular' },
  { title: 'The Martian', author: 'Andy Weir', tier: 'popular' },
  { title: 'Leviathan Wakes', author: 'James S. A. Corey', tier: 'popular' },
  { title: 'Children of Time', author: 'Adrian Tchaikovsky', tier: 'popular' },
  { title: 'Ancillary Justice', author: 'Ann Leckie', tier: 'popular' },
  { title: 'Piranesi', author: 'Susanna Clarke', tier: 'popular' },

  { title: 'Blindsight', author: 'Peter Watts', tier: 'midlist' },
  { title: 'A Memory Called Empire', author: 'Arkady Martine', tier: 'midlist' },
  { title: 'Gideon the Ninth', author: 'Tamsyn Muir', tier: 'midlist' },
  { title: 'The Space Between Worlds', author: 'Micaiah Johnson', tier: 'midlist' },
  { title: 'All Systems Red', author: 'Martha Wells', tier: 'midlist' },

  { title: 'The Mountain in the Sea', author: 'Ray Nayler', tier: 'recent' },
  { title: 'Some Desperate Glory', author: 'Emily Tesh', tier: 'recent' },
  { title: 'Translation State', author: 'Ann Leckie', tier: 'recent' },
  { title: 'The Tainted Cup', author: 'Robert Jackson Bennett', tier: 'recent' },
];

function toBook(e: SampleEntry, i: number): Book {
  return {
    id: `probe-${i}`,
    title: e.title,
    author: e.author,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: 0,
    isbn: e.isbn ?? null,
    asin: e.asin ?? null,
  };
}

interface Row {
  title: string;
  tier: SampleEntry['tier'];
  status: 'ok' | 'not-found' | 'error';
  people: number;
  places: number;
  times: number;
  subjects: number;
  note?: string;
}

async function probe(provider: EnrichmentProvider, books: Book[], sample: SampleEntry[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; i < books.length; i += 1) {
    const entry = sample[i]!;
    try {
      const payload = await provider.lookup(books[i]!, fetch);
      if (!payload) {
        rows.push({ title: entry.title, tier: entry.tier, status: 'not-found', people: 0, places: 0, times: 0, subjects: 0 });
      } else {
        const count = (k: string): number => payload.entities.filter((e) => e.kind === k).length;
        rows.push({
          title: entry.title,
          tier: entry.tier,
          status: 'ok',
          people: count('person'),
          places: count('place'),
          times: count('time'),
          subjects: payload.subjects.length,
        });
      }
    } catch (err) {
      rows.push({
        title: entry.title,
        tier: entry.tier,
        status: 'error',
        people: 0, places: 0, times: 0, subjects: 0,
        note: err instanceof Error ? err.message : String(err),
      });
    }
    // Be a polite client — this hits public APIs with no key.
    await new Promise((r) => setTimeout(r, 350));
  }
  return rows;
}

function summarise(name: string, rows: Row[]): void {
  const ok = rows.filter((r) => r.status === 'ok');
  const withPeople = ok.filter((r) => r.people > 0);
  const withPlaces = ok.filter((r) => r.places > 0);
  const errors = rows.filter((r) => r.status === 'error');

  console.log(`\n══ ${name} ══`);
  console.log(`  resolved:            ${ok.length}/${rows.length}  (${Math.round((ok.length / rows.length) * 100)}%)`);
  console.log(`  with person data:    ${withPeople.length}/${rows.length}  (${Math.round((withPeople.length / rows.length) * 100)}%)`);
  console.log(`  with place data:     ${withPlaces.length}/${rows.length}`);
  console.log(`  errors:              ${errors.length}`);

  const tiers: SampleEntry['tier'][] = ['canonical', 'popular', 'midlist', 'recent'];
  console.log('  by tier (resolved / with-people / n):');
  for (const t of tiers) {
    const inTier = rows.filter((r) => r.tier === t);
    const okT = inTier.filter((r) => r.status === 'ok');
    const peopleT = okT.filter((r) => r.people > 0);
    console.log(`    ${t.padEnd(10)} ${okT.length}/${peopleT.length}/${inTier.length}`);
  }

  console.log('  per title:');
  for (const r of rows) {
    const mark = r.status === 'ok' ? (r.people > 0 ? '●' : '◐') : r.status === 'error' ? '✗' : '○';
    const detail = r.status === 'ok'
      ? `people=${String(r.people).padEnd(4)} places=${String(r.places).padEnd(3)} times=${String(r.times).padEnd(3)} subjects=${r.subjects}`
      : r.note ?? r.status;
    console.log(`    ${mark} ${r.title.padEnd(30)} ${detail}`);
  }
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const books = SAMPLE.map(toBook);

  console.log(`Probing ${SAMPLE.length} titles. Read-only; no database writes.`);
  const ol = await probe(openLibraryProvider, books, SAMPLE);

  // Audnexus is ASIN-keyed; only entries carrying a real ASIN can resolve.
  const withAsin = SAMPLE.map((e, i) => ({ e, i })).filter(({ e }) => e.asin);
  const aud = await probe(audnexusProvider, withAsin.map(({ i }) => books[i]!), withAsin.map(({ e }) => e));

  if (asJson) {
    console.log(JSON.stringify({ openlibrary: ol, audnexus: aud }, null, 2));
    return;
  }

  summarise('openlibrary', ol);
  summarise(`audnexus (only the ${withAsin.length} sample entries with a real ASIN)`, aud);

  console.log(
    '\nLegend: ● resolved with person data · ◐ resolved, no person data · ○ not found · ✗ error\n' +
    'Note: Audnexus is keyed strictly by ASIN, so its true coverage can only be\n' +
    'measured against a real library where every book carries one from ABS.\n'
  );
}

void main();
