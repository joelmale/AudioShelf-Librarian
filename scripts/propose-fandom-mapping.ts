/**
 * Propose the `series -> Fandom wiki` mapping R4 needs, for a human to confirm.
 *
 * R4 (docs/enrichment-sources-review.md §3) is the only recommendation that
 * targets the ~69% of this library with no grounded entities, and the only one
 * the review doc refuses to let run automatically: `book_entities` is an
 * allowlist, so a wrong wiki authorizes another fandom's character names for
 * every book in the series. The doc requires the mapping be "confirmed once by
 * a human" before use.
 *
 * This script produces that review table and stops. It writes no mapping,
 * touches no database, and fetches no character names. Its output is a CSV you
 * edit — set `confirmed` to `yes` on the rows you vouch for — plus a console
 * summary. R4 proper should read only confirmed rows.
 *
 * Usage:
 *   npm run propose:fandom -- --base-url https://audioshelf.home.reach-back.net
 *   npm run propose:fandom -- --base-url https://... --out mapping.csv --min-books 3
 *   npm run propose:fandom -- --series "Discworld,The Expanse"   # spot-check, no DB
 *
 * The series list comes from the curator API (`GET /api/books`), not from the
 * database directly, so this needs no filesystem access to the live volume.
 */
import { writeFileSync } from 'node:fs';

import {
  buildMappingReport,
  proposeForSeries,
  seriesCounts,
  type SeriesCount,
  type SeriesMappingProposal,
} from '../apps/backend/src/modules/curator/core/enrichment/fandomMapping.js';

interface Args {
  baseUrl: string | null;
  out: string;
  minBooks: number;
  limit: number;
  series: string[] | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { baseUrl: null, out: 'fandom-mapping-candidates.csv', minBooks: 2, limit: 4, series: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--base-url') { args.baseUrl = value; i += 1; }
    else if (flag === '--out') { args.out = value; i += 1; }
    else if (flag === '--min-books') { args.minBooks = Number(value); i += 1; }
    else if (flag === '--limit') { args.limit = Number(value); i += 1; }
    else if (flag === '--series') { args.series = value.split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (flag === '--json') { args.json = true; }
  }
  return args;
}

async function fetchSeries(baseUrl: string, minBooks: number): Promise<SeriesCount[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/books?limit=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const books = Array.isArray(body)
    ? body
    : ((body as { books?: unknown[]; results?: unknown[] }).books ??
       (body as { results?: unknown[] }).results ??
       []);
  return seriesCounts(books as Array<{ series?: string | null }>, minBooks);
}

/** RFC4180-ish quoting: the description field routinely contains commas. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(proposals: SeriesMappingProposal[]): string {
  const header = ['confirmed', 'series', 'books', 'rank', 'confidence', 'subdomain', 'wiki_name', 'url', 'why', 'error'];
  const rows: string[] = [header.join(',')];
  for (const proposal of proposals) {
    if (proposal.candidates.length === 0) {
      rows.push([
        'no', csvCell(proposal.series), proposal.books, '', proposal.error ? 'error' : 'none',
        '', '', '', proposal.error ? 'lookup failed - not evidence that no wiki exists' : 'every guessed subdomain 404d',
        csvCell(proposal.error ?? null),
      ].join(','));
      continue;
    }
    proposal.candidates.forEach((candidate, index) => {
      rows.push([
        'no', csvCell(proposal.series), proposal.books, index + 1, candidate.confidence,
        csvCell(candidate.subdomain), csvCell(candidate.name), csvCell(candidate.url),
        csvCell(candidate.reason), '',
      ].join(','));
    });
  }
  return rows.join('\n') + '\n';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let targets: SeriesCount[];
  if (args.series) {
    targets = args.series.map((series) => ({ series, books: 0 }));
  } else if (args.baseUrl) {
    targets = await fetchSeries(args.baseUrl, args.minBooks);
  } else {
    console.error('Need --base-url <curator origin> (or --series "A,B" to spot-check).');
    process.exitCode = 1;
    return;
  }

  if (targets.length === 0) {
    console.error(`No series with at least ${args.minBooks} books. Nothing to propose.`);
    return;
  }

  console.error(`Probing wikis for ${targets.length} series (up to ${args.limit} guesses each, ~1s apart)...`);
  const proposals: SeriesMappingProposal[] = [];
  for (const target of targets) {
    try {
      proposals.push(await proposeForSeries(target.series, target.books, { fetchImpl: fetch, limit: args.limit }));
    } catch (err) {
      // A throttle is rethrown by design: stop rather than record the rest as
      // "no wiki found", which would be a lie that survives into the CSV.
      console.error(`\nStopped at "${target.series}": ${err instanceof Error ? err.message : String(err)}`);
      console.error('Re-run later; already-proposed series are written below.');
      break;
    }
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  const report = buildMappingReport(proposals);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  writeFileSync(args.out, toCsv(proposals), 'utf8');
  const { exact, strong, weak, none, errored } = report.summary;
  console.log('');
  console.log(`series proposed : ${report.generatedFor}`);
  console.log(`  exact match   : ${exact}   <- still needs your eyes, just fewer of them`);
  console.log(`  strong        : ${strong}`);
  console.log(`  weak          : ${weak}   <- assume wrong until checked`);
  console.log(`  no candidates : ${none}`);
  console.log(`  lookup failed : ${errored}`);
  console.log('');
  console.log(`Wrote ${args.out}`);
  console.log('');
  console.log('NOTHING IS CONFIRMED. Open the CSV, check each wiki actually covers');
  console.log('that series, and set `confirmed` to yes on the rows you vouch for.');
  console.log('A wrong mapping authorizes another fandom\'s characters for every');
  console.log('book in the series, so an unchecked "exact" is still a guess.');
}

void main();
