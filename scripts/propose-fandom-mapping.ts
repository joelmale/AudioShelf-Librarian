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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  buildMappingReport,
  proposeForSeries,
  seriesCounts,
  verifySuppliedSubdomain,
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
  const args: Args = { baseUrl: null, out: 'fandom-mapping-candidates.csv', minBooks: 2, limit: 6, series: null, json: false };
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

/** `GET /api/books` clamps its limit to `[1, 500]` (db.ts#queryBooks), so there
 *  is no "give me everything" value — `limit=0` reads as ONE book, not all of
 *  them. Page explicitly until a short page comes back. */
const BOOKS_PAGE_SIZE = 500;

async function fetchSeries(baseUrl: string, minBooks: number): Promise<SeriesCount[]> {
  const origin = baseUrl.replace(/\/+$/, '');
  const all: Array<{ series?: string | null }> = [];
  for (let offset = 0; ; offset += BOOKS_PAGE_SIZE) {
    const url = `${origin}/api/books?limit=${BOOKS_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const page = (
      Array.isArray(body)
        ? body
        : ((body as { books?: unknown[]; results?: unknown[] }).books ??
           (body as { results?: unknown[] }).results ??
           [])
    ) as Array<{ series?: string | null }>;
    all.push(...page);
    if (page.length < BOOKS_PAGE_SIZE) break;
  }
  console.error(`Read ${all.length} books from ${origin}`);
  return seriesCounts(all, minBooks);
}

/**
 * The `confirmed` column is a TRI-state, not a boolean:
 *
 *   yes     - you checked this wiki and vouch for it. R4 may use it.
 *   no      - you checked and it is WRONG. Never propose it again.
 *   (blank) - nobody has looked yet. The default.
 *
 * "Not reviewed" and "rejected" have to be different values, because a re-run
 * carries your decisions forward and needs to know which rows you have already
 * ruled on. A blank is an open question; a `no` is an answered one.
 */
type Decision = 'yes' | 'no' | '';

/** Split one CSV line, honouring quoted cells. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/**
 * Read decisions already recorded in `path`, keyed on (series, subdomain).
 *
 * Without this a re-run silently discards every yes and no in the file, which
 * is the entire point of the review. Keying on the subdomain rather than the
 * row number means decisions survive candidates being re-ranked, added or
 * dropped between runs.
 */
interface PriorRow {
  series: string;
  subdomain: string;
  decision: Decision;
}

/** Every decided row in the file, so a hand-entered subdomain can be revived. */
function readPriorRows(path: string): PriorRow[] {
  if (!existsSync(path)) return [];
  const rows: PriorRow[] = [];
  const lines = readFileSync(path, 'utf8')
    .split(String.fromCharCode(10))
    .map((line) => line.replace(String.fromCharCode(13), ''))
    .filter((line) => line.trim() !== '');
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const verdict = (cells[0] ?? '').trim().toLowerCase();
    if (verdict !== 'yes' && verdict !== 'no') continue;
    rows.push({ series: cells[1] ?? '', subdomain: (cells[5] ?? '').trim(), decision: verdict });
  }
  return rows;
}

function readPriorDecisions(path: string): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  if (!existsSync(path)) return decisions;
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const verdict = (cells[0] ?? '').trim().toLowerCase();
    if (verdict !== 'yes' && verdict !== 'no') continue;
    decisions.set(`${cells[1] ?? ''}|${cells[5] ?? ''}`, verdict);
  }
  return decisions;
}

/** RFC4180-ish quoting: the description field routinely contains commas. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(proposals: SeriesMappingProposal[], prior: Map<string, Decision>): string {
  const header = ['confirmed', 'series', 'books', 'rank', 'confidence', 'subdomain', 'wiki_name', 'url', 'why', 'error'];
  const rows: string[] = [header.join(',')];
  for (const proposal of proposals) {
    if (proposal.candidates.length === 0) {
      rows.push([
        prior.get(`${proposal.series}|`) ?? '', csvCell(proposal.series), proposal.books, '', proposal.error ? 'error' : 'none',
        '', '', '', proposal.error ? 'lookup failed - not evidence that no wiki exists' : 'every guessed subdomain 404d',
        csvCell(proposal.error ?? null),
      ].join(','));
      continue;
    }
    proposal.candidates.forEach((candidate, index) => {
      rows.push([
        prior.get(`${proposal.series}|${candidate.subdomain ?? ''}`) ?? '',
        csvCell(proposal.series), proposal.books, index + 1, candidate.confidence,
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

  // Read decisions BEFORE overwriting the file - reviewing is the expensive
  // part of this workflow and a re-run must never discard it.
  const prior = readPriorDecisions(args.out);

  // Revive rows where a human typed a subdomain this generator cannot derive.
  // Without this, correcting a wrong guess by hand survives exactly until the
  // next run, which would make the review pointless.
  const byName = new Map(proposals.map((p) => [p.series, p]));
  for (const row of readPriorRows(args.out)) {
    const proposal = byName.get(row.series);
    if (!proposal || !row.subdomain) continue;
    if (proposal.candidates.some((c) => c.subdomain === row.subdomain)) continue;
    const { candidate, error } = await verifySuppliedSubdomain(row.series, row.subdomain, {
      fetchImpl: fetch,
    });
    if (candidate) {
      proposal.candidates.unshift(candidate);
      console.error(`kept your entry for "${row.series}": ${candidate.subdomain} (${candidate.name})`);
    } else {
      console.error(`WARNING your entry for "${row.series}" (${row.subdomain}) did not verify: ${error}`);
    }
  }
  writeFileSync(args.out, toCsv(proposals, prior), 'utf8');
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
  if (prior.size > 0) {
    const yes = [...prior.values()].filter((v) => v === 'yes').length;
    console.log(`Carried forward ${prior.size} earlier decision(s): ${yes} yes, ${prior.size - yes} no.`);
    console.log('');
  }
  console.log('The `confirmed` column is a tri-state:');
  console.log('   yes     - checked, and you vouch for it; R4 may use it');
  console.log('   no      - checked, and it is WRONG; never propose it again');
  console.log('   (blank) - nobody has looked yet');
  console.log('');
  console.log('Blank is the default, so an unreviewed row is never mistaken for a');
  console.log('rejected one, and re-running preserves every yes and no you set.');
  console.log("A wrong mapping authorizes another fandom's characters for every");
  console.log('book in the series, so an unchecked "exact" is still a guess.');
}

void main();
