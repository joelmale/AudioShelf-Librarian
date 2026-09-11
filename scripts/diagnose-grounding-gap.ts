/**
 * Why are 653 books ungrounded when 539 of them have a cached 'ok' provider
 * row? Read-only, offline, one pass over a curator.db snapshot.
 *
 * `rederiveFromCache` answered 0 rows changed, which rules out the cheap
 * explanation: the cached rows are already fully mined under today's
 * extraction rules. That leaves two very different worlds, and they call for
 * opposite work:
 *
 *  A. The cached Open Library docs DO carry `person`/`place` headings and the
 *     book is still ungrounded. Then this is an extraction defect, the fix is
 *     a rule change in `openLibrary.ts`, and `POST /enrichment/rederive`
 *     applies it to every cached row for free — no network, no quota.
 *
 *  B. The docs mostly carry neither field. Then Open Library is exhausted for
 *     these books, no amount of re-deriving will help, and the only levers
 *     left cost real requests: widen Wikidata (an entity source currently
 *     covering ~14% of the library) or pilot a new entity-capable provider.
 *
 * Google Books is deliberately reported but never counted as entity support:
 * its `rederive` returns `entities: []` by construction, so its 766 cached
 * rows cannot ground a single book no matter how many there are. Counting it
 * as "has resolved metadata" is exactly what made the 539 figure misleading.
 *
 * Usage:
 *   curl -o snapshot.db "$HOST/api/database/snapshot"
 *   npx tsx scripts/diagnose-grounding-gap.ts snapshot.db
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

/** Providers whose payloads can contribute a person/place entity at all. */
const ENTITY_CAPABLE = new Set(['openlibrary', 'wikidata']);

interface Row {
  book_id: string;
  provider: string;
  payload: string | null;
}

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: tsx scripts/diagnose-grounding-gap.ts <curator-snapshot.db>');
    process.exit(1);
  }

  // A wrong URL, an auth redirect or the SPA fallback all download happily and
  // then fail deep inside better-sqlite3 as "file is not a database". Check the
  // magic header first and show what actually arrived.
  const head = readFileSync(dbPath).subarray(0, 16);
  if (head.toString('utf8', 0, 15) !== 'SQLite format 3') {
    console.error(`${dbPath} is not a SQLite database. It starts with:\n`);
    console.error(readFileSync(dbPath).subarray(0, 300).toString('utf8'));
    console.error('\nThe snapshot lives at /api/database/snapshot (the admin router mounts at the');
    console.error('curator root, not under /admin). If AUTH_ENABLED=true, pass your token:');
    console.error('  curl -o snapshot.db -H "authorization: Bearer $TOKEN" "$HOST/api/database/snapshot"');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  const totalBooks = (db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n;
  const grounded = new Set(
    (db.prepare('SELECT DISTINCT book_id FROM book_entities').all() as Array<{ book_id: string }>).map(
      (r) => r.book_id
    )
  );

  const rows = db
    .prepare("SELECT book_id, provider, payload FROM external_metadata WHERE status = 'ok'")
    .all() as Row[];

  // Per ungrounded book: what did each entity-capable provider actually hold?
  const withHeadings = new Set<string>();
  const withoutHeadings = new Set<string>();
  const byProvider = new Map<string, { rows: number; withHeadings: number; parseFailed: number }>();
  const examples: Array<{ bookId: string; provider: string; person: number; place: number }> = [];
  let noEntityCapableRow = 0;
  const sawEntityCapable = new Set<string>();

  for (const row of rows) {
    if (grounded.has(row.book_id)) continue;
    if (!ENTITY_CAPABLE.has(row.provider)) continue;
    sawEntityCapable.add(row.book_id);

    const stats = byProvider.get(row.provider) ?? { rows: 0, withHeadings: 0, parseFailed: 0 };
    stats.rows += 1;

    let raw: { person?: unknown; place?: unknown } | null = null;
    try {
      const parsed = JSON.parse(row.payload ?? 'null') as { raw?: unknown } | null;
      raw = (parsed?.raw ?? null) as typeof raw;
    } catch {
      stats.parseFailed += 1;
      byProvider.set(row.provider, stats);
      continue;
    }

    const person = Array.isArray(raw?.person) ? raw.person.length : 0;
    const place = Array.isArray(raw?.place) ? raw.place.length : 0;

    if (person + place > 0) {
      // The smoking gun for world A: headings are on disk, entities are not.
      stats.withHeadings += 1;
      withHeadings.add(row.book_id);
      if (examples.length < 15) examples.push({ bookId: row.book_id, provider: row.provider, person, place });
    } else {
      withoutHeadings.add(row.book_id);
    }
    byProvider.set(row.provider, stats);
  }

  // Books with a cached 'ok' row from SOME provider, but none that could ever
  // ground them — the population the 539 figure silently included.
  const anyOkBook = new Set(rows.map((r) => r.book_id));
  for (const bookId of anyOkBook) {
    if (!grounded.has(bookId) && !sawEntityCapable.has(bookId)) noEntityCapableRow += 1;
  }

  const ungrounded = totalBooks - grounded.size;
  const pct = (n: number) => `${((n / totalBooks) * 100).toFixed(1)}%`;

  console.log(`\nLibrary: ${totalBooks} books, ${grounded.size} grounded (${pct(grounded.size)}), ${ungrounded} not\n`);

  console.log('Ungrounded books, by what their cached rows actually contain:');
  console.log(`  person/place headings present, entity missing : ${withHeadings.size}  <- extraction defect`);
  console.log(`  entity-capable row, no headings in it         : ${withoutHeadings.size}  <- provider exhausted`);
  console.log(`  cached rows, none from an entity source       : ${noEntityCapableRow}  <- never asked`);

  console.log('\nBy provider (ungrounded books only):');
  for (const [provider, stats] of [...byProvider].sort()) {
    console.log(
      `  ${provider.padEnd(12)} rows=${String(stats.rows).padStart(4)}  with headings=${String(stats.withHeadings).padStart(4)}  unparseable=${stats.parseFailed}`
    );
  }

  if (examples.length > 0) {
    console.log('\nHeadings on disk that produced no entity (first 15):');
    for (const ex of examples) {
      console.log(`  ${ex.bookId}  ${ex.provider}  person=${ex.person} place=${ex.place}`);
    }
    console.log('\n=> World A. Fix the extraction rule, then POST /enrichment/rederive to apply it for free.');
  } else {
    console.log('\n=> World B. The cached rows hold nothing to extract; re-deriving cannot help.');
    console.log('   The levers left cost requests: widen Wikidata, or pilot a new entity-capable provider.');
  }

  db.close();
}

main();
